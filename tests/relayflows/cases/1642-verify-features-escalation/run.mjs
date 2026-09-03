import { execFileSync, spawnSync } from 'node:child_process';
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CASE_ID = '1642-verify-features-escalation';
const COMMAND_TIMEOUT_MS = 30_000;
const targetDir = requiredDirectory('RELAY_PR_PROOF_TARGET_DIR');
const harnessDir = requiredDirectory('RELAY_PR_PROOF_HARNESS_DIR');
const resultPath = path.resolve(requiredValue('RELAY_PR_PROOF_RESULT_PATH'));
const arm = requiredValue('RELAY_PR_PROOF_ARM');

if (arm !== 'base' && arm !== 'head') {
  throw new Error(`RELAY_PR_PROOF_ARM must be base or head, received ${JSON.stringify(arm)}.`);
}

const expectedSha =
  arm === 'base' ? process.env.RELAY_PR_PROOF_BASE_SHA : process.env.RELAY_PR_PROOF_HEAD_SHA;
if (!expectedSha) throw new Error(`Missing expected ${arm} SHA.`);
const targetSha = execFileSync('git', ['-C', targetDir, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
  timeout: COMMAND_TIMEOUT_MS,
}).trim();
if (targetSha !== expectedSha) {
  throw new Error(`Target checkout ${targetSha} does not match exact ${arm} SHA ${expectedSha}.`);
}

const runnerPath = fileURLToPath(import.meta.url);
if (!isWithin(harnessDir, runnerPath)) {
  throw new Error('The RelayFlow runner must execute from the exact-head harness checkout.');
}

const workflowPath = path.join(targetDir, 'workflows/verify-features.ts');
const statusToolPath = path.join(targetDir, 'scripts/verify-features/escalation-status.mjs');
const infraEscalationToolPath = path.join(targetDir, 'scripts/verify-features/escalate-infra.sh');
const slackAlertToolPath = path.join(targetDir, 'scripts/verify-features/slack-alert.sh');
const slackPostToolPath = path.join(targetDir, 'scripts/verify-features/slack-post.mjs');
const runArtifactsToolPath = path.join(targetDir, 'scripts/verify-features/run-artifacts.mjs');
const runWorktreeToolPath = path.join(targetDir, 'scripts/verify-features/run-worktree.mjs');
const workflowSource = await readFile(workflowPath, 'utf8');

let outcome;
let signature;
let details;

if (arm === 'base') {
  const silentMarkers = [
    'ISSUE_SKIPPED: gh is not authenticated',
    'PR_SKIPPED: gh unavailable or unauthenticated',
    'FOLLOWUP_SKIPPED: no issue or PR to report',
  ];
  const missingMarkers = silentMarkers.filter((marker) => !workflowSource.includes(marker));
  let statusToolExists = true;
  try {
    await access(statusToolPath);
  } catch {
    statusToolExists = false;
  }
  if (missingMarkers.length > 0 || statusToolExists) {
    throw new Error(
      `Base does not expose the expected silent-delivery behavior: missing=${JSON.stringify(
        missingMarkers
      )}, statusToolExists=${statusToolExists}.`
    );
  }
  outcome = 'bug';
  signature = 'silent_escalation_markers_without_audit';
  details =
    'The exact base workflow labels unauthenticated issue/PR delivery and a missing follow-up as SKIPPED while providing no escalation receipt audit executable.';
} else {
  // Source inspection is supporting evidence for isolation. The workflow graph
  // itself is planned below, and delivery-to-receipt behavior is executed
  // through the same production scripts the registered steps invoke.
  assertWorkflowPattern(
    workflowSource,
    /VERIFY_SLACK_CHANNEL\s*=\s*['"]C0AEKNLDNKW['"]/,
    'required Slack channel C0AEKNLDNKW'
  );
  assertWorkflowPattern(
    workflowSource,
    /\[\s*ESCALATION_STATUS_TOOL\s*,\s*['"]audit['"]\s*,\s*ARTIFACTS/,
    'post-run escalation audit invocation'
  );
  assertWorkflowPattern(
    workflowSource,
    /if\s*\(\s*escalationAudit\.status\s*!==\s*0\s*\)/,
    'non-zero escalation audit branch'
  );
  assertWorkflowPattern(
    workflowSource,
    /process\.exitCode\s*=\s*2/,
    'non-zero process exit after failed escalation audit'
  );
  assertWorkflowPattern(
    workflowSource,
    /wf\.run\s*\(\s*\{\s*dryRun\s*,\s*cwd\s*:\s*REPO_ROOT\s*\}\s*\)/,
    'source-checkout workflow execution'
  );
  for (const mutatingStep of ['attempt-fix', 'fix-integrity', 'open-pr']) {
    const stepSource = workflowStep(workflowSource, mutatingStep);
    if (!/cwd\s*:\s*RUN_WORKTREE/.test(stepSource)) {
      throw new Error(`Head workflow does not isolate mutating step ${mutatingStep}.`);
    }
  }
  for (const channel of ['slack_followup', 'github_issue', 'draft_pr', 'posthog']) {
    const failedWrite = new RegExp(`write [^\\n]*["']?\\$ARTIFACTS["']? ${channel} failed(?:\\s|$)`);
    if (!failedWrite.test(workflowSource)) {
      throw new Error(`Head workflow does not record failed delivery for ${channel}.`);
    }
  }

  const graphPlan = spawnSync(process.execPath, ['--experimental-strip-types', workflowPath], {
    cwd: targetDir,
    encoding: 'utf8',
    env: { ...process.env, DRY_RUN: '1' },
    timeout: COMMAND_TIMEOUT_MS,
  });
  assertCompleted(graphPlan, 'verify-features executable graph plan', 0);
  for (const step of [
    'emit-posthog',
    'escalate-infra',
    'file-issue',
    'slack-alert',
    'open-pr',
    'slack-followup',
    'enforce-infra-delivery',
    'enforce-posthog-delivery',
    'enforce-github-issue-delivery',
    'enforce-draft-pr-delivery',
    'enforce-slack-primary-delivery',
    'enforce-slack-followup-delivery',
    'enforce-escalations',
    'enforce-verdict',
  ]) {
    if (!graphPlan.stdout.includes(step)) {
      throw new Error(`Executable workflow graph omitted ${step}.`);
    }
  }

  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'relay-pr1642-'));
  try {
    const { markRunArtifactsComplete, prepareRunArtifacts, pruneRunArtifacts } = await import(
      pathToFileURL(runArtifactsToolPath).href
    );
    const { prepareRunWorktree, removeRunWorktree } = await import(pathToFileURL(runWorktreeToolPath).href);

    for (const executable of [infraEscalationToolPath, slackAlertToolPath, slackPostToolPath]) {
      await access(executable);
    }
    const artifactsRoot = path.join(temporaryRoot, 'artifacts');
    const runA = prepareRunArtifacts(artifactsRoot, 'verify-proof-a', 'proof-a');
    await writeFile(path.join(runA, 'verdict.json'), '{"runId":"proof-a"}\n');
    const runB = prepareRunArtifacts(artifactsRoot, 'verify-proof-b', 'proof-b');
    await writeFile(path.join(runB, 'checks.jsonl'), '{"run":"proof-b"}\n');
    if ((await readFile(path.join(runA, 'verdict.json'), 'utf8')) !== '{"runId":"proof-a"}\n') {
      throw new Error('Head workflow run A evidence was overwritten by run B.');
    }
    try {
      await readFile(path.join(artifactsRoot, 'verdict.json'), 'utf8');
      throw new Error('Head workflow exposed run A verdict after run B became current.');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }

    const retentionRoot = path.join(temporaryRoot, 'retention');
    for (let index = 0; index < 6; index += 1) {
      const runId = `verify-retained-${index}`;
      const run = prepareRunArtifacts(retentionRoot, runId, `retained-${index}`);
      markRunArtifactsComplete(run, runId);
    }
    prepareRunArtifacts(retentionRoot, 'verify-retention-active', 'retention-active');
    pruneRunArtifacts(retentionRoot, {
      currentRunId: 'verify-retention-active',
      keepCompleted: 2,
    });
    const retainedRuns = await readdir(path.join(retentionRoot, 'runs'));
    if (retainedRuns.filter((name) => name.startsWith('verify-retained-')).length !== 2) {
      throw new Error(`Head retention did not bound completed history: ${retainedRuns.join(',')}`);
    }
    if (!retainedRuns.includes('verify-retention-active')) {
      throw new Error('Head retention removed the current incomplete run.');
    }

    const gitRepo = path.join(temporaryRoot, 'git-repo');
    await mkdir(gitRepo);
    execFileSync('git', ['-C', gitRepo, 'init'], {
      stdio: 'ignore',
      timeout: COMMAND_TIMEOUT_MS,
    });
    await writeFile(path.join(gitRepo, 'fixture.txt'), 'base\n');
    execFileSync('git', ['-C', gitRepo, 'add', 'fixture.txt'], {
      timeout: COMMAND_TIMEOUT_MS,
    });
    execFileSync(
      'git',
      [
        '-C',
        gitRepo,
        '-c',
        'user.name=Relay Proof',
        '-c',
        'user.email=relay-proof@example.invalid',
        'commit',
        '-m',
        'fixture',
      ],
      { stdio: 'ignore', timeout: COMMAND_TIMEOUT_MS }
    );
    const worktreeRoot = path.join(temporaryRoot, 'git-worktrees');
    const worktreeA = await prepareRunWorktree(gitRepo, worktreeRoot, 'verify-worktree-a');
    const worktreeB = await prepareRunWorktree(gitRepo, worktreeRoot, 'verify-worktree-b');
    await writeFile(path.join(worktreeA, 'fixture.txt'), 'worktree-a\n');
    await writeFile(path.join(worktreeB, 'fixture.txt'), 'worktree-b\n');
    if ((await readFile(path.join(gitRepo, 'fixture.txt'), 'utf8')) !== 'base\n') {
      throw new Error('Head verifier worktree changed the source checkout.');
    }
    if ((await readFile(path.join(worktreeA, 'fixture.txt'), 'utf8')) !== 'worktree-a\n') {
      throw new Error('Head verifier worktree A lost its private git state.');
    }
    if ((await readFile(path.join(worktreeB, 'fixture.txt'), 'utf8')) !== 'worktree-b\n') {
      throw new Error('Head verifier worktree B lost its private git state.');
    }
    await removeRunWorktree(gitRepo, worktreeA);
    await removeRunWorktree(gitRepo, worktreeB);

    // Execute byte-for-byte copies of the production step scripts in a
    // disposable module tree. The target checkout remains read-only evidence;
    // only the transport boundary is stubbed to deterministically throw.
    const executableRoot = path.join(temporaryRoot, 'step-executables');
    const executableScriptRoot = path.join(executableRoot, 'scripts', 'verify-features');
    await mkdir(executableScriptRoot, { recursive: true });
    const executableStatusToolPath = path.join(executableScriptRoot, 'escalation-status.mjs');
    const executableInfraToolPath = path.join(executableScriptRoot, 'escalate-infra.sh');
    const executableSlackAlertPath = path.join(executableScriptRoot, 'slack-alert.sh');
    const executableSlackPostPath = path.join(executableScriptRoot, 'slack-post.mjs');
    await Promise.all([
      copyFile(statusToolPath, executableStatusToolPath),
      copyFile(infraEscalationToolPath, executableInfraToolPath),
      copyFile(slackAlertToolPath, executableSlackAlertPath),
      copyFile(slackPostToolPath, executableSlackPostPath),
    ]);
    const resolvedExecutableStatusToolPath = await realpath(executableStatusToolPath);
    const resolvedExecutableInfraToolPath = await realpath(executableInfraToolPath);
    const resolvedExecutableSlackAlertPath = await realpath(executableSlackAlertPath);

    const slackPrimitiveRoot = path.join(executableRoot, 'node_modules', '@relayflows', 'slack-primitive');
    await mkdir(slackPrimitiveRoot, { recursive: true });
    await writeFile(
      path.join(slackPrimitiveRoot, 'package.json'),
      '{"name":"@relayflows/slack-primitive","type":"module","exports":"./index.js"}\n'
    );
    await writeFile(
      path.join(slackPrimitiveRoot, 'index.js'),
      "export class SlackClient { async postMessage() { const error = new Error('missing Cloud token'); error.code = 'auth_token_missing'; throw error; } }\n"
    );

    const executableArtifacts = path.join(temporaryRoot, 'executable-escalations');
    await mkdir(executableArtifacts, { recursive: true });
    await writeFile(
      path.join(executableArtifacts, 'verdict.json'),
      `${JSON.stringify({
        runId: 'verify-executable-proof',
        verdict: 'FAIL',
        provenance: {
          VERIFY_CLI_VERSION: 'proof',
          VERIFY_REPO_VERSION: 'proof',
          VERIFY_GIT_SHA: targetSha,
        },
        totals: { pass: 0, fail: 1, skip: 0 },
        tiers: {
          tier1: {
            pass: 0,
            fail: 1,
            skip: 0,
            failures: [{ check: 'proof failure', reason: 'exercise the real Slack step' }],
          },
        },
        tiersNotRun: [],
      })}\n`
    );
    await writeFile(path.join(executableArtifacts, 'provenance.env'), 'VERIFY_CLI_VERSION=proof\n');
    await writeFile(path.join(executableArtifacts, 'caps.env'), 'provider_any=0\n');

    const fakeBin = path.join(executableRoot, 'bin');
    const capturedInfraBody = path.join(executableArtifacts, 'infra-body.json');
    await mkdir(fakeBin, { recursive: true });
    await writeFile(
      path.join(fakeBin, 'curl'),
      `#!/bin/sh
status=0
while [ "$#" -gt 0 ]; do
  case "$1" in -*f*) status=22 ;; esac
  if [ "$1" = "-d" ]; then shift; printf '%s' "$1" > "$INFRA_CAPTURE"; fi
  shift
done
exit "$status"
`,
      { mode: 0o755 }
    );

    const executableEnvironment = {
      ...process.env,
      VERIFY_ARTIFACTS: executableArtifacts,
      VERIFY_RUN_ID: 'verify-executable-proof',
      VERIFY_SLACK_CHANNEL: 'C0AEKNLDNKW',
      CLOUD_API_URL: 'https://cloud.invalid',
      CLOUD_API_TOKEN: '',
      RELAY_CLOUD_API_TOKEN: '',
      CLOUD_API_ACCESS_TOKEN: '',
      NIGHTCTO_EVIDENCE_URL: 'https://nightcto.invalid/evidence',
      NIGHTCTO_EVIDENCE_TOKEN: '',
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      INFRA_CAPTURE: capturedInfraBody,
    };

    const slackAlert = spawnSync('bash', [resolvedExecutableSlackAlertPath], {
      encoding: 'utf8',
      env: executableEnvironment,
      timeout: COMMAND_TIMEOUT_MS,
    });
    assertCompleted(slackAlert, 'primary Slack alert executable', 0);
    let slackReceipt;
    try {
      slackReceipt = JSON.parse(
        await readFile(path.join(executableArtifacts, 'escalation-slack-primary.json'), 'utf8')
      );
    } catch (error) {
      throw new Error(
        `Real Slack step produced no valid receipt: ${error?.message ?? error}; stdout=${JSON.stringify(
          slackAlert.stdout
        )}; stderr=${JSON.stringify(slackAlert.stderr)}`
      );
    }
    if (slackReceipt.state !== 'failed') {
      throw new Error(
        `Real failed Slack delivery was recorded as ${JSON.stringify(slackReceipt.state)}, not failed.`
      );
    }
    const slackEvidence = `${slackAlert.stdout ?? ''}\n${slackAlert.stderr ?? ''}`;
    if (!slackEvidence.includes('SLACK_UNDELIVERED to C0AEKNLDNKW')) {
      throw new Error('Real failed Slack delivery did not emit its undelivered marker.');
    }
    runStatusTool(
      resolvedExecutableStatusToolPath,
      ['audit-channel', executableArtifacts, 'slack_primary', '1', '0'],
      1
    );

    const infraEscalation = spawnSync('bash', [resolvedExecutableInfraToolPath], {
      encoding: 'utf8',
      env: executableEnvironment,
      timeout: COMMAND_TIMEOUT_MS,
    });
    assertCompleted(infraEscalation, 'NightCTO infra escalation executable', 0);
    const infraReceipt = JSON.parse(
      await readFile(path.join(executableArtifacts, 'escalation-infra.json'), 'utf8')
    );
    if (infraReceipt.state !== 'failed' || !infraReceipt.detail.includes('no_provider_cli')) {
      throw new Error(
        `Missing NightCTO configuration did not produce the expected failed infra receipt: ${JSON.stringify(
          infraReceipt
        )}`
      );
    }
    const infraBody = JSON.parse(await readFile(capturedInfraBody, 'utf8'));
    if (infraBody.errorCode !== 'no_provider_cli' || infraBody.requestId !== 'verify-executable-proof') {
      throw new Error(
        `Production NightCTO script emitted an invalid JSON payload: ${JSON.stringify(infraBody)}`
      );
    }
    runStatusTool(
      resolvedExecutableStatusToolPath,
      ['audit-channel', executableArtifacts, 'infra', '1', '1'],
      1
    );

    const failedChannels = [
      ['slack_primary', 'auth_token_missing'],
      ['slack_followup', 'auth_token_missing'],
      ['github_issue', 'gh is not authenticated'],
      ['draft_pr', 'gh is not authenticated'],
      ['posthog', '13 events dropped'],
    ];
    for (const [channel, reason] of failedChannels) {
      runStatusTool(statusToolPath, ['write', temporaryRoot, channel, 'failed', reason], 0);
    }
    runStatusTool(
      statusToolPath,
      ['write', temporaryRoot, 'infra', 'not_applicable', 'no harness failure'],
      0
    );

    const audit = spawnSync(process.execPath, [statusToolPath, 'audit', temporaryRoot, '1'], {
      encoding: 'utf8',
      timeout: COMMAND_TIMEOUT_MS,
    });
    if (audit.error) throw new Error(`Escalation audit could not start: ${audit.error.message}`);
    if (audit.status === 0 || audit.status === null) {
      throw new Error(
        `Escalation audit must exit non-zero for five failed delivery channels, received ${audit.status}.`
      );
    }
    const evidence = `${audit.stdout ?? ''}\n${audit.stderr ?? ''}`;
    for (const label of [
      'Slack primary alert failed',
      'Slack escalation follow-up failed',
      'GitHub issue failed',
      'Draft fix PR failed',
      'PostHog failed',
    ]) {
      if (!evidence.includes(label)) throw new Error(`Escalation audit omitted ${label}.`);
    }

    outcome = 'fixed';
    signature = 'escalation_delivery_failures_exit_nonzero';
    details =
      'The exact head plans the real workflow graph, executes failed Slack and HTTP-error NightCTO delivery through the production step executables, observes failed receipts and red leaf audits, isolates overlapping artifact and git state, and audits the remaining delivery contracts.';
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

await mkdir(path.dirname(resultPath), { recursive: true });
await writeFile(
  resultPath,
  `${JSON.stringify({ version: 1, caseId: CASE_ID, arm, outcome, signature, details })}\n`,
  'utf8'
);

function runStatusTool(statusTool, args, expectedStatus) {
  const completed = spawnSync(process.execPath, [statusTool, ...args], {
    encoding: 'utf8',
    timeout: COMMAND_TIMEOUT_MS,
  });
  if (completed.error) throw new Error(`Status tool could not start: ${completed.error.message}`);
  if (completed.status !== expectedStatus) {
    throw new Error(
      `Status tool ${args[0]} exited ${completed.status}; stdout=${JSON.stringify(
        completed.stdout
      )}; stderr=${JSON.stringify(completed.stderr)}.`
    );
  }
}

function assertCompleted(completed, label, expectedStatus) {
  if (completed.error) throw new Error(`${label} could not start: ${completed.error.message}`);
  if (completed.status !== expectedStatus) {
    throw new Error(
      `${label} exited ${completed.status}; stdout=${JSON.stringify(
        completed.stdout
      )}; stderr=${JSON.stringify(completed.stderr)}.`
    );
  }
}

function assertWorkflowPattern(source, pattern, label) {
  if (!pattern.test(source)) throw new Error(`Head workflow does not wire ${label}.`);
}

function workflowStep(source, name) {
  const startPattern = new RegExp(`wf\\.step\\s*\\(\\s*(['"])${name}\\1\\s*,\\s*\\{`, 'm');
  const match = startPattern.exec(source);
  if (!match) throw new Error(`Head workflow does not define mutating step ${name}.`);
  const remainder = source.slice(match.index + match[0].length);
  const next = /\n\s*wf\.step\s*\(/.exec(remainder);
  return source.slice(match.index, next ? match.index + match[0].length + next.index : source.length);
}

function requiredValue(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}.`);
  return value;
}

function requiredDirectory(name) {
  return path.resolve(requiredValue(name));
}

function isWithin(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}
