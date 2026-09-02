import { execFileSync, spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  if (!workflowSource.includes('C0AEKNLDNKW')) {
    throw new Error('Head workflow does not target the required Slack channel C0AEKNLDNKW.');
  }
  for (const integrationMarker of [
    "[ESCALATION_STATUS_TOOL, 'audit', ARTIFACTS",
    'if (escalationAudit.status !== 0)',
    'ESCALATION DELIVERY FAILED independently of the workflow DAG',
    'process.exitCode = 2',
  ]) {
    if (!workflowSource.includes(integrationMarker)) {
      throw new Error(`Head workflow does not wire fail-loud escalation audit: ${integrationMarker}`);
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
      'The exact head delivery audit exited non-zero and named all five failed Slack, GitHub issue, draft PR, and PostHog contracts; the workflow wires that audit to a non-zero process exit and carries the required Slack channel.';
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
