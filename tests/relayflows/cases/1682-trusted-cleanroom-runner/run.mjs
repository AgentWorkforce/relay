import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parse } from 'yaml';

const CASE_ID = '1682-trusted-cleanroom-runner';
const COMMAND_TIMEOUT_MS = 30_000;
const targetDir = requiredDirectory('RELAY_PR_PROOF_TARGET_DIR');
const harnessDir = requiredDirectory('RELAY_PR_PROOF_HARNESS_DIR');
const resultPath = path.resolve(requiredValue('RELAY_PR_PROOF_RESULT_PATH'));
const arm = requiredValue('RELAY_PR_PROOF_ARM');

if (arm !== 'base' && arm !== 'head') throw new Error('RELAY_PR_PROOF_ARM must be base or head.');
const expectedSha =
  arm === 'base' ? process.env.RELAY_PR_PROOF_BASE_SHA : process.env.RELAY_PR_PROOF_HEAD_SHA;
if (!expectedSha) throw new Error(`Missing expected ${arm} SHA.`);
const targetSha = execFileSync('git', ['-C', targetDir, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
  timeout: COMMAND_TIMEOUT_MS,
}).trim();
if (targetSha !== expectedSha) throw new Error(`Target checkout does not match exact ${arm} SHA.`);
if (!isWithin(harnessDir, fileURLToPath(import.meta.url))) {
  throw new Error('RelayFlow runner must execute from the exact-head harness checkout.');
}

const scriptPath = path.join(targetDir, 'scripts/verify-features/relay-cleanroom-qualification-request.mjs');
const requestWorkflowPath = path.join(
  targetDir,
  '.github/workflows/relay-cleanroom-qualification-request.yml'
);
const consumerWorkflowPath = path.join(
  targetDir,
  '.github/workflows/relay-cleanroom-qualification-consumer.yml'
);
const present = await Promise.all(
  [scriptPath, requestWorkflowPath, consumerWorkflowPath].map(async (file) => {
    try {
      await readFile(file);
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
  })
);

let outcome;
let signature;
let details;
if (present.every((value) => !value)) {
  outcome = 'bug';
  signature = 'trusted_cleanroom_runner_missing';
  details = 'The base has no no-secret request plus trusted workflow_run cleanroom consumer.';
} else if (present.some((value) => !value)) {
  throw new Error('Target contains only part of the trusted cleanroom qualification contract.');
} else {
  const validator = await import(`${pathToFileURL(scriptPath).href}?sha=${targetSha}`);
  const relaySha = 'a'.repeat(40);
  const validEvent = {
    repository: { full_name: 'AgentWorkforce/relay' },
    workflow_run: {
      id: 901,
      run_attempt: 2,
      name: validator.REQUEST_WORKFLOW_NAME,
      path: validator.REQUEST_WORKFLOW_PATH,
      event: 'workflow_dispatch',
      status: 'completed',
      conclusion: 'success',
      head_branch: 'qualification/malicious-ref',
      head_sha: relaySha,
      head_repository: { full_name: 'AgentWorkforce/relay' },
      actor: { login: 'approved-operator' },
      triggering_actor: { login: 'approved-operator' },
    },
  };
  const context = validator.validateQualificationRequestEvent(validEvent, '["approved-operator"]');
  if (context.headBranch !== 'qualification/malicious-ref' || context.headSha !== relaySha) {
    throw new Error('Trusted validator did not bind the candidate ref as immutable data.');
  }
  for (const [label, message, mutate] of [
    [
      'unapproved actor',
      /actor.login is not approved/,
      (event) => (event.workflow_run.actor.login = 'attacker'),
    ],
    [
      'unapproved rerunner',
      /triggering_actor.login is not approved/,
      (event) => (event.workflow_run.triggering_actor.login = 'attacker'),
    ],
    [
      'fork repository',
      /head_repository/,
      (event) => (event.workflow_run.head_repository.full_name = 'attacker/relay'),
    ],
    [
      'wrong workflow',
      /workflow_run.path/,
      (event) => (event.workflow_run.path = '.github/workflows/attacker.yml'),
    ],
    [
      'nested branch',
      /head_branch/,
      (event) => (event.workflow_run.head_branch = 'qualification/attacker/nested'),
    ],
  ]) {
    const changed = structuredClone(validEvent);
    mutate(changed);
    assertThrows(
      () => validator.validateQualificationRequestEvent(changed, '["approved-operator"]'),
      label,
      message
    );
  }

  const artifact = {
    id: 77,
    name: validator.REQUEST_ARTIFACT_NAME,
    expired: false,
    size_in_bytes: 4096,
    digest: `sha256:${'7'.repeat(64)}`,
    workflow_run: { id: context.runId },
  };
  validator.selectQualificationRequestArtifact(context, [{ total_count: 1, artifacts: [artifact] }]);
  assertThrows(
    () =>
      validator.selectQualificationRequestArtifact(context, [
        { total_count: 1, artifacts: [{ ...artifact, workflow_run: { id: 902 } }] },
      ]),
    'wrong-run artifact',
    /triggering run/
  );

  const requestSource = await readFile(requestWorkflowPath, 'utf8');
  const consumerSource = await readFile(consumerWorkflowPath, 'utf8');
  const requestWorkflow = parse(requestSource);
  const consumer = parse(consumerSource);
  assertDeepEqual(
    Object.keys(requestWorkflow.on),
    ['repository_dispatch', 'workflow_dispatch'],
    'request triggers'
  );
  assertDeepEqual(requestWorkflow.permissions, {}, 'request permissions');
  if (requestSource.includes('secrets.') || requestSource.includes('actions/checkout')) {
    throw new Error('Untrusted request workflow gained secret or checkout access.');
  }
  assertDeepEqual(Object.keys(consumer.on), ['workflow_run'], 'consumer triggers');
  assertDeepEqual(
    consumer.on.workflow_run,
    {
      workflows: [validator.REQUEST_WORKFLOW_NAME],
      types: ['completed'],
    },
    'consumer workflow_run identity'
  );
  assertDeepEqual(
    Object.keys(consumer.jobs),
    ['verify-request', 'qualification', 'qualification_cleanup'],
    'consumer jobs'
  );
  const verify = consumer.jobs['verify-request'];
  assertDeepEqual(verify.permissions, { actions: 'read', contents: 'read' }, 'verify permissions');
  if (JSON.stringify(verify).includes('secrets.') || verify.environment !== undefined) {
    throw new Error('Pre-secret request verifier gained secrets or an environment.');
  }
  const qualification = consumer.jobs.qualification;
  assertDeepEqual(
    qualification.env,
    { CLOUD_API_URL: 'https://agentrelay.com/cloud' },
    'qualification job environment'
  );
  const fleetStep = qualification.steps.find((step) => step.name === 'Run exact candidate Fleet Relayflow');
  if (
    fleetStep?.env?.OPENAI_API_KEY !== '${{ secrets.OPENAI_API_KEY }}' ||
    fleetStep?.env?.ANTHROPIC_API_KEY !== '${{ secrets.ANTHROPIC_API_KEY }}'
  ) {
    throw new Error('Agent provider secrets are not scoped to the Fleet execution step.');
  }
  for (const step of qualification.steps.filter((step) => step !== fleetStep)) {
    if (step.env?.OPENAI_API_KEY !== undefined || step.env?.ANTHROPIC_API_KEY !== undefined) {
      throw new Error('Agent provider secrets leaked into a non-Fleet qualification step.');
    }
  }
  const checkouts = [
    ...verify.steps,
    ...qualification.steps,
    ...consumer.jobs.qualification_cleanup.steps,
  ].filter((step) => String(step.uses ?? '').startsWith('actions/checkout@'));
  if (checkouts.length !== 3) throw new Error('Trusted consumer checkout count changed.');
  for (const checkout of checkouts) {
    assertDeepEqual(
      checkout.with,
      {
        path: checkout.with.path,
        ref: '${{ github.workflow_sha }}',
        'persist-credentials': false,
      },
      'trusted checkout inputs'
    );
  }
  const cleanupSource = JSON.stringify(consumer.jobs.qualification_cleanup);
  assertDeepEqual(
    consumer.jobs.qualification_cleanup.permissions,
    { contents: 'read' },
    'cleanup permissions'
  );
  if (
    !cleanupSource.includes('relay-cleanup/packages/cli/dist/cli/index.js') ||
    cleanupSource.includes('relay-candidate-install.mjs hydrate')
  ) {
    throw new Error('Fallback cleanup is not bound to the trusted default-branch CLI.');
  }
  if (
    consumerSource.includes('ref: ${{ github.sha }}') ||
    /ref:\s*\$\{\{ steps\.manifest/.test(consumerSource)
  ) {
    throw new Error('Candidate-controlled source can still become executable workflow code.');
  }
  outcome = 'fixed';
  signature = 'trusted_cleanroom_rejects_unapproved_ref_execution';
  details =
    'An approved malicious candidate ref is accepted only as bound data; actor, rerunner, fork, workflow, nested-ref, and wrong-run artifact substitutions fail, and all executable code is pinned to github.workflow_sha.';
}

await mkdir(path.dirname(resultPath), { recursive: true });
await writeFile(
  resultPath,
  `${JSON.stringify({ version: 1, caseId: CASE_ID, arm, outcome, signature, details })}\n`
);

function requiredValue(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function requiredDirectory(name) {
  return path.resolve(requiredValue(name));
}

function isWithin(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertThrows(operation, label, expectedMessage) {
  let rejection;
  try {
    operation();
  } catch (error) {
    rejection = error;
  }
  if (!rejection) throw new Error(`Trusted validator accepted ${label}.`);
  const message = rejection instanceof Error ? rejection.message : String(rejection);
  if (!expectedMessage.test(message)) {
    throw new Error(`Trusted validator rejected ${label} for the wrong reason: ${message}.`);
  }
}

function assertDeepEqual(actual, expected, label) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${label} mismatch: ${left} !== ${right}.`);
}
