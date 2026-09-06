import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CASE_ID = '1676-trusted-cloud-dispatch';
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

const scriptPath = path.join(targetDir, 'scripts/verify-features/relay-package-qualification-delivery.mjs');
const workflowPath = path.join(targetDir, '.github/workflows/relay-package-qualification-delivery.yml');
const scriptExists = await exists(scriptPath);
const workflowExists = await exists(workflowPath);

let outcome;
let signature;
let details;

if (!scriptExists && !workflowExists) {
  outcome = 'bug';
  signature = 'trusted_cloud_dispatcher_missing';
  details =
    'The exact base has no default-branch workflow_run consumer, so it cannot deliver a candidate pointer without putting Cloud credentials in candidate-controlled workflow code.';
} else if (!scriptExists || !workflowExists) {
  throw new Error('The target contains only part of the trusted Cloud dispatcher contract.');
} else {
  const delivery = await import(`${pathToFileURL(scriptPath).href}?sha=${targetSha}`);
  const sourceSha = 'a'.repeat(40);
  const branch = 'qualification/relay-11.10.4-cleanroom.20260906.1665.6';
  const validEvent = {
    repository: { full_name: 'AgentWorkforce/relay' },
    workflow_run: {
      id: 987654,
      run_attempt: 2,
      name: 'Relay package qualification',
      path: `.github/workflows/relay-package-qualification.yml@${branch}`,
      event: 'workflow_dispatch',
      status: 'completed',
      conclusion: 'success',
      head_branch: branch,
      head_sha: sourceSha,
      head_repository: { full_name: 'AgentWorkforce/relay' },
    },
  };
  const context = delivery.validateWorkflowRunEvent(validEvent);

  for (const [label, mutate] of [
    ['default branch', (event) => (event.workflow_run.head_branch = 'main')],
    [
      'nested attacker branch',
      (event) => (event.workflow_run.head_branch = 'qualification/attacker/payload'),
    ],
    ['traversal branch', (event) => (event.workflow_run.head_branch = 'qualification/../main')],
    ['fork repository', (event) => (event.workflow_run.head_repository.full_name = 'attacker/relay')],
    ['wrong workflow path', (event) => (event.workflow_run.path = '.github/workflows/attacker.yml')],
    ['push event', (event) => (event.workflow_run.event = 'push')],
    ['failed conclusion', (event) => (event.workflow_run.conclusion = 'failure')],
  ]) {
    const attack = structuredClone(validEvent);
    mutate(attack);
    assertThrows(() => delivery.validateWorkflowRunEvent(attack), label);
  }

  const requestDigest = `sha256:${'b'.repeat(64)}`;
  const attestationDigest = `sha256:${'c'.repeat(64)}`;
  const artifacts = [
    {
      total_count: 3,
      artifacts: [
        artifact(101, delivery.REQUEST_ARTIFACT_NAME, requestDigest, context.runId),
        artifact(102, delivery.ATTESTATION_ARTIFACT_NAME, attestationDigest, context.runId),
        artifact(103, 'relay-package-qualification', `sha256:${'d'.repeat(64)}`, context.runId),
      ],
    },
  ];
  const selection = delivery.selectQualificationArtifacts(context, artifacts);
  const expectedRequest = delivery.expectedCloudDispatch(context, selection);

  const requestDirectory = await mkdtemp(path.join(os.tmpdir(), 'relay-pr1676-request-'));
  try {
    await writeFile(
      path.join(requestDirectory, delivery.REQUEST_FILE_NAME),
      `${JSON.stringify(expectedRequest)}\n`
    );
    await delivery.validateRequestArtifactDirectory(requestDirectory, context, selection);

    const injected = structuredClone(expectedRequest);
    injected.client_payload.attacker = true;
    assertThrows(
      () => delivery.validateCloudDispatchRequest(injected, context, selection),
      'request payload injection'
    );
  } finally {
    await rm(requestDirectory, { recursive: true, force: true });
  }

  const workflowSource = await readFile(workflowPath, 'utf8');
  const deliveryJobOffset = workflowSource.indexOf('\n  deliver-request:');
  if (deliveryJobOffset < 0) throw new Error('Trusted workflow omits the delivery job.');
  const verifyJobSource = workflowSource.slice(0, deliveryJobOffset);
  const deliveryJobSource = workflowSource.slice(deliveryJobOffset);
  requirePattern(verifyJobSource, /workflow_run:/, 'workflow_run trigger');
  requirePattern(verifyJobSource, /ref:\s*\$\{\{ github\.workflow_sha \}\}/, 'trusted checkout SHA');
  requirePattern(verifyJobSource, /persist-credentials:\s*false/, 'credential-free trusted checkout');
  rejectPattern(verifyJobSource, /secrets\./, 'secret in verifier job');
  requirePattern(deliveryJobSource, /environment:\s*snapshot-qualification/, 'protected environment');
  requirePattern(deliveryJobSource, /permission-contents:\s*write/, 'Cloud-only contents permission');
  requirePattern(
    deliveryJobSource,
    /repos\/AgentWorkforce\/cloud\/dispatches/,
    'static Cloud repository dispatch endpoint'
  );
  rejectPattern(deliveryJobSource, /actions\/checkout/, 'checkout in credentialed job');
  rejectPattern(deliveryJobSource, /scripts\/verify-features/, 'repository script in credentialed job');

  outcome = 'fixed';
  signature = 'trusted_dispatch_rejects_attacker_refs';
  details =
    'The exact head accepted a source-bound request from the canonical producer, rejected attacker/fork/path/event/conclusion substitutions and payload injection, and kept Cloud credentials in a separate no-checkout default-branch job.';
}

await mkdir(path.dirname(resultPath), { recursive: true });
await writeFile(
  resultPath,
  `${JSON.stringify({ version: 1, caseId: CASE_ID, arm, outcome, signature, details })}\n`
);

function artifact(id, name, digest, runId) {
  return {
    id,
    name,
    expired: false,
    size_in_bytes: 2048,
    digest,
    workflow_run: { id: runId },
  };
}

function assertThrows(operation, label) {
  let threw = false;
  try {
    operation();
  } catch {
    threw = true;
  }
  if (!threw) throw new Error(`Trusted validator accepted ${label}.`);
}

function requirePattern(source, pattern, label) {
  if (!pattern.test(source)) throw new Error(`Trusted workflow omits ${label}.`);
}

function rejectPattern(source, pattern, label) {
  if (pattern.test(source)) throw new Error(`Trusted workflow contains ${label}.`);
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

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}
