import { execFileSync, spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
  // The executable checks below prove the helpers' behavior. Source inspection
  // is still required to prove that the workflow actually invokes those
  // helpers; running the full credential-bearing scheduler from this isolated,
  // credential-free proof sandbox would test a different security boundary.
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
  for (const channel of ['slack_primary', 'slack_followup', 'github_issue', 'draft_pr', 'posthog']) {
    const failedWrite = new RegExp(`write [^\\n]*["']?\\$ARTIFACTS["']? ${channel} failed(?:\\s|$)`);
    if (!failedWrite.test(workflowSource)) {
      throw new Error(`Head workflow does not record failed delivery for ${channel}.`);
    }
  }

  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'relay-pr1642-'));
  try {
    const { markRunArtifactsComplete, prepareRunArtifacts, pruneRunArtifacts } = await import(
      pathToFileURL(runArtifactsToolPath).href
    );
    const { prepareRunWorktree, removeRunWorktree } = await import(pathToFileURL(runWorktreeToolPath).href);
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
      'The exact head isolates overlapping artifact and git state, bounds completed evidence without pruning the current run, and its delivery audit exits non-zero while naming all five failed Slack, GitHub issue, draft PR, and PostHog contracts.';
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
