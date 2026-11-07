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
      path: '.github/workflows/relay-package-qualification.yml',
      event: 'workflow_dispatch',
      status: 'completed',
      conclusion: 'success',
      head_branch: branch,
      head_sha: sourceSha,
      head_repository: { full_name: 'AgentWorkforce/relay' },
    },
  };
  const context = delivery.validateWorkflowRunEvent(validEvent);

  for (const [label, expectedMessage, mutate] of [
    ['default branch', /workflow_run\.head_branch/, (event) => (event.workflow_run.head_branch = 'main')],
    [
      'nested attacker branch',
      /workflow_run\.head_branch/,
      (event) => (event.workflow_run.head_branch = 'qualification/attacker/payload'),
    ],
    [
      'traversal branch',
      /workflow_run\.head_branch/,
      (event) => (event.workflow_run.head_branch = 'qualification/../main'),
    ],
    [
      'fork repository',
      /workflow_run\.head_repository\.full_name/,
      (event) => (event.workflow_run.head_repository.full_name = 'attacker/relay'),
    ],
    [
      'wrong workflow path',
      /workflow_run\.path/,
      (event) => (event.workflow_run.path = '.github/workflows/attacker.yml'),
    ],
    ['push event', /workflow_run\.event/, (event) => (event.workflow_run.event = 'push')],
    ['failed conclusion', /workflow_run\.conclusion/, (event) => (event.workflow_run.conclusion = 'failure')],
  ]) {
    const attack = structuredClone(validEvent);
    mutate(attack);
    assertThrows(() => delivery.validateWorkflowRunEvent(attack), label, expectedMessage);
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
      'request payload injection',
      /request artifact must exactly match trusted producer identity/
    );
  } finally {
    await rm(requestDirectory, { recursive: true, force: true });
  }

  const workflowSource = await readFile(workflowPath, 'utf8');
  validateTrustedWorkflow(workflowSource);
  for (const [label, expectedMessage, tampered] of [
    [
      'comment-only trusted checkout ref',
      /trusted checkout inputs mismatch/,
      replaceExactly(
        workflowSource,
        '          ref: ${{ github.workflow_sha }}',
        '          ref: refs/heads/attacker\n          # ref: ${{ github.workflow_sha }}'
      ),
    ],
    [
      'comment-only credential disablement',
      /trusted checkout inputs mismatch/,
      replaceExactly(
        workflowSource,
        '          persist-credentials: false',
        '          persist-credentials: true\n          # persist-credentials: false'
      ),
    ],
    [
      'comment-only Cloud permission',
      /Cloud-only token inputs mismatch/,
      replaceExactly(
        workflowSource,
        '          permission-contents: write',
        '          permission-contents: read\n          # permission-contents: write'
      ),
    ],
    [
      'comment-only Cloud dispatch command',
      /Trusted delivery command omits/,
      replaceExactly(
        workflowSource,
        '          gh api --method POST repos/AgentWorkforce/cloud/dispatches \\',
        '          # gh api --method POST repos/AgentWorkforce/cloud/dispatches \\'
      ),
    ],
    [
      'unnamed credentialed checkout step',
      /Every trusted workflow step must begin with an explicit name/,
      replaceExactly(
        workflowSource,
        '    steps:\n      - name: Mint a Cloud-only token from the trusted dispatcher',
        '    steps:\n      - uses: actions/checkout@attacker\n      - name: Mint a Cloud-only token from the trusted dispatcher'
      ),
    ],
  ]) {
    assertThrows(() => validateTrustedWorkflow(tampered), label, expectedMessage);
  }

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
    throw new Error(`Trusted validator rejected ${label} for the wrong reason: ${JSON.stringify(message)}.`);
  }
}

function validateTrustedWorkflow(source) {
  const lines = source.split(/\r?\n/);
  if (lines.some((line) => line.includes('\t'))) {
    throw new Error('Trusted workflow must not contain YAML tab indentation.');
  }

  const trigger = yamlBlock(lines, 'on', 0);
  const workflowRun = yamlBlock(lines, 'workflow_run', 2, trigger);
  expectSequence(lines, yamlBlock(lines, 'workflows', 4, workflowRun), 6, ['Relay package qualification']);
  expectSequence(lines, yamlBlock(lines, 'types', 4, workflowRun), 6, ['completed']);
  expectScalar(lines, null, 0, 'permissions', '{}');

  const jobs = yamlBlock(lines, 'jobs', 0);
  const jobNames = directMappingKeys(lines, jobs, 2);
  expectJsonEqual(jobNames, ['verify-request', 'deliver-request'], 'trusted workflow jobs');
  const verifyJob = yamlBlock(lines, 'verify-request', 2, jobs);
  const deliveryJob = yamlBlock(lines, 'deliver-request', 2, jobs);

  expectScalar(lines, verifyJob, 4, 'if', "${{ github.event.workflow_run.conclusion == 'success' }}");
  const verifyPermissions = yamlBlock(lines, 'permissions', 4, verifyJob);
  expectJsonEqual(
    directScalarMapping(lines, verifyPermissions, 6),
    { actions: 'read', contents: 'read' },
    'verifier permissions'
  );
  const verifySteps = yamlSteps(lines, verifyJob);
  const checkout = exactStep(verifySteps, 'Check out only the trusted dispatcher source');
  expectScalar(
    checkout.lines,
    checkout.block,
    8,
    'uses',
    'actions/checkout@11d5960a326750d5838078e36cf38b85af677262'
  );
  expectJsonEqual(
    directScalarMapping(checkout.lines, yamlBlock(checkout.lines, 'with', 8, checkout.block), 10),
    { ref: '${{ github.workflow_sha }}', 'persist-credentials': 'false' },
    'trusted checkout inputs'
  );
  if (blockSource(lines, verifyJob).includes('secrets.')) {
    throw new Error('Trusted verifier job must not reference secrets.');
  }

  expectScalar(lines, deliveryJob, 4, 'needs', 'verify-request');
  expectScalar(lines, deliveryJob, 4, 'permissions', '{}');
  expectScalar(lines, deliveryJob, 4, 'environment', 'snapshot-qualification');
  const deliverySteps = yamlSteps(lines, deliveryJob);
  expectJsonEqual(
    deliverySteps.map((step) => step.name),
    ['Mint a Cloud-only token from the trusted dispatcher', 'Deliver the verified immutable pointer'],
    'credentialed delivery steps'
  );

  const mint = exactStep(deliverySteps, 'Mint a Cloud-only token from the trusted dispatcher');
  expectScalar(
    mint.lines,
    mint.block,
    8,
    'uses',
    'actions/create-github-app-token@a8d616148505b5069dccd32f177bb87d7f39123b'
  );
  expectJsonEqual(
    directScalarMapping(mint.lines, yamlBlock(mint.lines, 'with', 8, mint.block), 10),
    {
      'app-id': '${{ secrets.GH_APP_PUSHER_ID }}',
      'private-key': '${{ secrets.GH_APP_PUSHER_PRIVATE_KEY }}',
      owner: 'AgentWorkforce',
      repositories: 'cloud',
      'permission-contents': 'write',
    },
    'Cloud-only token inputs'
  );

  const deliver = exactStep(deliverySteps, 'Deliver the verified immutable pointer');
  expectJsonEqual(
    directScalarMapping(deliver.lines, yamlBlock(deliver.lines, 'env', 8, deliver.block), 10),
    {
      GH_TOKEN: '${{ steps.cloud-token.outputs.token }}',
      RUN_ID: '${{ needs.verify-request.outputs.run_id }}',
      RUN_ATTEMPT: '${{ needs.verify-request.outputs.run_attempt }}',
      SOURCE_GIT_SHA: '${{ needs.verify-request.outputs.source_git_sha }}',
      ATTESTATION_ARTIFACT_DIGEST: '${{ needs.verify-request.outputs.attestation_artifact_digest }}',
    },
    'verified delivery environment'
  );
  const run = blockScalar(deliver.lines, deliver.block, 8, 'run');
  for (const commandLine of [
    'gh api --method POST repos/AgentWorkforce/cloud/dispatches \\',
    '  --input "${RUNNER_TEMP}/cloud-request.json"',
  ]) {
    if (!run.split('\n').includes(commandLine)) {
      throw new Error(`Trusted delivery command omits ${JSON.stringify(commandLine)}.`);
    }
  }
  if (
    deliverySteps.some((step) =>
      scalarValue(step.lines, step.block, 8, 'uses')?.startsWith('actions/checkout')
    )
  ) {
    throw new Error('Credentialed delivery job must not check out repository code.');
  }
  if (deliverySteps.some((step) => blockSource(step.lines, step.block).includes('scripts/verify-features'))) {
    throw new Error('Credentialed delivery job must not execute repository scripts.');
  }
}

function yamlBlock(lines, key, indent, parent = { start: -1, end: lines.length }) {
  const prefix = `${' '.repeat(indent)}${key}:`;
  const matches = [];
  for (let index = parent.start + 1; index < parent.end; index += 1) {
    if (lines[index] === prefix) matches.push(index);
  }
  if (matches.length !== 1) {
    throw new Error(`Trusted workflow must contain exactly one structural ${key} block.`);
  }
  const start = matches[0];
  let end = parent.end;
  for (let index = start + 1; index < parent.end; index += 1) {
    if (isIgnorableYamlLine(lines[index])) continue;
    if (leadingSpaces(lines[index]) <= indent) {
      end = index;
      break;
    }
  }
  return { start, end };
}

function yamlSteps(lines, job) {
  const steps = yamlBlock(lines, 'steps', 4, job);
  const starts = [];
  for (let index = steps.start + 1; index < steps.end; index += 1) {
    const item = /^ {6}- (\S.*)$/.exec(lines[index]);
    if (!item) continue;
    const match = /^name: (\S.*)$/.exec(item[1]);
    if (!match) throw new Error('Every trusted workflow step must begin with an explicit name.');
    starts.push({ index, name: match[1] });
  }
  return starts.map(({ index, name }, offset) => ({
    name,
    lines,
    block: { start: index, end: starts[offset + 1]?.index ?? steps.end },
  }));
}

function exactStep(steps, name) {
  const matches = steps.filter((step) => step.name === name);
  if (matches.length !== 1) throw new Error(`Trusted workflow must contain exactly one ${name} step.`);
  return matches[0];
}

function directMappingKeys(lines, block, indent) {
  const matcher = new RegExp(`^ {${indent}}([A-Za-z0-9_-]+):(?: .*)?$`);
  return lines
    .slice(block.start + 1, block.end)
    .map((line) => matcher.exec(line)?.[1])
    .filter(Boolean);
}

function directScalarMapping(lines, block, indent) {
  const entry = new RegExp(`^ {${indent}}([A-Za-z0-9_-]+):(.*)$`);
  const result = {};
  for (const line of lines.slice(block.start + 1, block.end)) {
    const match = entry.exec(line);
    if (!match) continue;
    if (match[1] in result) throw new Error(`Trusted workflow duplicates ${match[1]}.`);
    const value = stripYamlComment(match[2].trimStart());
    if (!value) throw new Error(`Trusted workflow ${match[1]} must be a direct scalar.`);
    result[match[1]] = value;
  }
  return result;
}

function expectSequence(lines, block, indent, expected) {
  const matcher = new RegExp(`^ {${indent}}- (\\S.*)$`);
  const actual = lines
    .slice(block.start + 1, block.end)
    .map((line) => {
      const value = matcher.exec(line)?.[1];
      return value === undefined ? undefined : stripYamlComment(value);
    })
    .filter(Boolean);
  expectJsonEqual(actual, expected, 'trusted workflow sequence');
}

function expectScalar(lines, parent, indent, key, expected) {
  const actual = scalarValue(lines, parent, indent, key);
  if (actual !== expected) {
    throw new Error(`Trusted workflow ${key} must be ${JSON.stringify(expected)}.`);
  }
}

function scalarValue(lines, parent, indent, key) {
  const bounds = parent ?? { start: -1, end: lines.length };
  const matcher = new RegExp(`^ {${indent}}${escapeRegExp(key)}: (\\S.*)$`);
  const matches = lines
    .slice(bounds.start + 1, bounds.end)
    .map((line) => matcher.exec(line)?.[1])
    .filter(Boolean);
  if (matches.length > 1) throw new Error(`Trusted workflow duplicates scalar ${key}.`);
  return matches[0] === undefined ? undefined : stripYamlComment(matches[0]);
}

function blockScalar(lines, parent, indent, key) {
  const marker = scalarValue(lines, parent, indent, key);
  if (marker !== '|') throw new Error(`Trusted workflow ${key} must be a literal block scalar.`);
  const start = lines.findIndex(
    (line, index) => index > parent.start && index < parent.end && line === `${' '.repeat(indent)}${key}: |`
  );
  const content = [];
  for (let index = start + 1; index < parent.end; index += 1) {
    if (lines[index] && leadingSpaces(lines[index]) <= indent) break;
    content.push(lines[index].startsWith(' '.repeat(indent + 2)) ? lines[index].slice(indent + 2) : '');
  }
  return content.join('\n');
}

function blockSource(lines, block) {
  return lines.slice(block.start, block.end).join('\n');
}

function leadingSpaces(line) {
  return /^ */.exec(line)[0].length;
}

function isIgnorableYamlLine(line) {
  return /^\s*(?:#.*)?$/.test(line);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripYamlComment(value) {
  return value.replace(/\s+#.*$/, '').trimEnd();
}

function expectJsonEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${label} mismatch: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`
    );
  }
}

function replaceExactly(source, before, after) {
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`Trusted workflow mutation requires exactly one ${JSON.stringify(before)}.`);
  }
  return `${source.slice(0, first)}${after}${source.slice(first + before.length)}`;
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
