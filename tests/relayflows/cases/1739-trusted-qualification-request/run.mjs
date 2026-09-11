import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CASE_ID = '1739-trusted-qualification-request';
const targetDir = requiredDirectory('RELAY_PR_PROOF_TARGET_DIR');
const harnessDir = requiredDirectory('RELAY_PR_PROOF_HARNESS_DIR');
const resultPath = requiredValue('RELAY_PR_PROOF_RESULT_PATH');
const arm = requiredValue('RELAY_PR_PROOF_ARM');
const expectedSha =
  arm === 'base' ? process.env.RELAY_PR_PROOF_BASE_SHA : process.env.RELAY_PR_PROOF_HEAD_SHA;
if (!['base', 'head'].includes(arm) || !expectedSha) throw new Error('Invalid RelayFlow arm identity.');
if (
  execFileSync('git', ['-C', targetDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== expectedSha
) {
  throw new Error('Target checkout is not bound to the declared RelayFlow arm SHA.');
}
if (!isWithin(harnessDir, fileURLToPath(import.meta.url))) {
  throw new Error('The RelayFlow runner must execute from the exact-head harness checkout.');
}

const validator = path.join(targetDir, 'scripts/verify-features/relay-cleanroom-qualification-request.mjs');
let outcome = 'bug';
let signature = 'trusted_qualification_request_validator_missing';
try {
  await access(validator);
  if (arm === 'base') throw new Error('base unexpectedly contains the qualification request validator');
  const module = await import(`${pathToFileURL(validator).href}?proof=${Date.now()}`);
  const validEvent = {
    repository: { full_name: 'AgentWorkforce/relay' },
    workflow_run: {
      id: 901,
      run_attempt: 1,
      name: 'Relay cleanroom qualification request',
      path: '.github/workflows/relay-cleanroom-qualification-request.yml',
      event: 'workflow_dispatch',
      status: 'completed',
      conclusion: 'success',
      head_branch: 'qualification/proof-candidate',
      head_sha: 'a'.repeat(40),
      head_repository: { full_name: 'AgentWorkforce/relay' },
      actor: { login: 'qualification-app[bot]' },
      triggering_actor: { login: 'qualification-app[bot]' },
    },
  };
  const context = module.validateQualificationRequestEvent(validEvent, '["qualification-app[bot]"]');
  if (context.headBranch !== 'qualification/proof-candidate' || context.headSha !== 'a'.repeat(40)) {
    throw new Error('validator did not preserve the exact trusted request identity');
  }
  const rejectionCases = [
    ['repository', (event) => (event.repository.full_name = 'evil/example')],
    ['workflow name', (event) => (event.workflow_run.name = 'other workflow')],
    ['workflow path', (event) => (event.workflow_run.path = '.github/workflows/other.yml')],
    ['event type', (event) => (event.workflow_run.event = 'repository_dispatch')],
    ['status', (event) => (event.workflow_run.status = 'in_progress')],
    ['conclusion', (event) => (event.workflow_run.conclusion = 'failure')],
    ['actor', (event) => (event.workflow_run.actor.login = 'unapproved[bot]')],
    ['triggering actor', (event) => (event.workflow_run.triggering_actor.login = 'unapproved[bot]')],
    ['branch', (event) => (event.workflow_run.head_branch = 'main')],
    ['head SHA', (event) => (event.workflow_run.head_sha = 'b'.repeat(39))],
    ['head repository', (event) => (event.workflow_run.head_repository.full_name = 'evil/example')],
  ];
  for (const [label, mutate] of rejectionCases) {
    const invalid = structuredClone(validEvent);
    mutate(invalid);
    assert.throws(
      () => module.validateQualificationRequestEvent(invalid, '["qualification-app[bot]"]'),
      undefined,
      `validator accepted a mismatched ${label}`
    );
  }
  outcome = 'fixed';
  signature = 'trusted_qualification_request_validated';
} catch (error) {
  if (arm === 'head') throw error;
}

await mkdir(path.dirname(resultPath), { recursive: true });
await writeFile(
  resultPath,
  `${JSON.stringify({
    version: 1,
    caseId: CASE_ID,
    arm,
    outcome,
    signature,
    details:
      arm === 'base'
        ? 'The base checkout has no trusted qualification request validator.'
        : 'The head validates the exact workflow, actor, branch, SHA, and source repository before credentialed qualification.',
  })}\n`,
  'utf8'
);

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
