import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This case deliberately performs no fake Relaycast/Cloud control-plane work.
// The base arm proves the current CLI contract locally. The head arm requires
// explicit candidate credentials and independently rereads Daytona, Fleet, and
// the exact agent identity before it can report a fixed observation.
const CASE_ID = '1665-immutable-fleet-snapshot';
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const CLI_TIMEOUT_MS = 120_000;
// Cloud's SANDBOX_ID is the provider's raw Daytona UUID. It is a trusted
// per-step input, not the Relay logical `sbx_...` workspace identifier.
const DAYTONA_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const targetDir = requiredDirectory('RELAY_PR_PROOF_TARGET_DIR');
const harnessDir = requiredDirectory('RELAY_PR_PROOF_HARNESS_DIR');
const resultPath = requiredValue('RELAY_PR_PROOF_RESULT_PATH');
const arm = requiredValue('RELAY_PR_PROOF_ARM');

if (arm !== 'base' && arm !== 'head') {
  throw new Error(`RELAY_PR_PROOF_ARM must be base or head, received ${JSON.stringify(arm)}.`);
}

const expectedSha =
  arm === 'base' ? process.env.RELAY_PR_PROOF_BASE_SHA : process.env.RELAY_PR_PROOF_HEAD_SHA;
if (!expectedSha) throw new Error(`Missing expected ${arm} SHA.`);
const targetSha = execFileSync('git', ['-C', targetDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (targetSha !== expectedSha) {
  throw new Error(`Target checkout ${targetSha} does not match exact ${arm} SHA ${expectedSha}.`);
}
const runnerPath = fileURLToPath(import.meta.url);
if (!isWithin(harnessDir, runnerPath)) {
  throw new Error('The RelayFlow runner must execute from the exact-head harness checkout.');
}

const cliPath = path.join(targetDir, 'packages/cli/dist/cli/index.js');
if (!(await exists(cliPath))) {
  run('npm', ['ci', '--ignore-scripts'], targetDir, 'workspace dependency installation', buildEnvironment());
  run('npm', ['run', 'build:core'], targetDir, 'production CLI build', buildEnvironment());
}

const help = runNode(
  [cliPath, 'fleet', 'spawn', 'codex', '--help'],
  targetDir,
  buildEnvironment(),
  CLI_TIMEOUT_MS
);
if (help.status !== 0) {
  throw new Error(`current Fleet CLI help failed: ${tail(help.stderr || help.stdout)}`);
}
const helpText = `${help.stdout}\n${help.stderr}`;
for (const option of ['--sandbox', '--sandbox-provider', '--sandbox-id', '--workspace-id']) {
  if (!helpText.includes(option)) throw new Error(`current Fleet CLI help is missing ${option}`);
}
for (const removed of ['--sandbox-snapshot', '--sandbox-snapshot-manifest-sha256']) {
  if (helpText.includes(removed)) throw new Error(`removed Fleet CLI option returned: ${removed}`);
}

if (arm === 'base') {
  await writeObservation(
    'absent',
    'legacy_snapshot_argv_absent',
    'The exact target CLI exposes explicit workspace/sandbox identity controls and no removed snapshot argv flags.'
  );
} else {
  await runIndependentCandidateRereads();
}

async function runIndependentCandidateRereads() {
  // SANDBOX_ID is injected by the Cloud executor for this exact step. Do not
  // accept a case-specific override: that would let the proof attest a
  // different sandbox than the one that actually ran it.
  const sandboxId = requiredValue('SANDBOX_ID');
  if (!DAYTONA_ID.test(sandboxId)) throw new Error('SANDBOX_ID is not a Daytona UUID.');
  if (!process.env.RELAY_WORKSPACE_KEY?.trim() || !process.env.RELAY_AGENT_TOKEN?.trim()) {
    throw new Error(
      'head identity rereads require candidate-bound RELAY_WORKSPACE_KEY and RELAY_AGENT_TOKEN.'
    );
  }

  const daytona = run(
    'daytona',
    ['sandbox', 'info', sandboxId, '--format', 'json'],
    targetDir,
    'Daytona sandbox reread',
    buildEnvironment()
  );
  if (daytona.status !== 0) throw new Error(`Daytona sandbox reread failed: ${tail(daytona.stderr)}`);
  const fleetNodes = runNode(
    [cliPath, 'fleet', 'nodes', '--all'],
    targetDir,
    buildEnvironment(),
    CLI_TIMEOUT_MS
  );
  const provider = parseJson(daytona.stdout, 'Daytona sandbox info');
  const nodes = parseJson(fleetNodes.stdout, 'Fleet nodes');
  if (!providerIdentityMatches(provider, sandboxId)) {
    throw new Error('Daytona reread did not independently prove the expected sandbox/provider identity.');
  }
  const nodeMatches = findNodesForSandbox(nodes, sandboxId);
  if (nodeMatches.length !== 1) {
    throw new Error(
      `Fleet node reread found ${nodeMatches.length} exact Daytona node matches; refusing ambiguity.`
    );
  }
  const node = nodeMatches[0];
  const nodeName = node.name ?? node.nodeName;
  if (!nodeName) throw new Error('Fleet node reread has no stable node name.');

  const fleetAgents = runNode(
    [cliPath, 'fleet', 'agent', 'list', '--all', '--node', nodeName, '--json'],
    targetDir,
    buildEnvironment(),
    CLI_TIMEOUT_MS
  );
  if (fleetAgents.status !== 0) {
    throw new Error(`Fleet agent reread failed: ${tail(fleetAgents.stderr || fleetAgents.stdout)}`);
  }
  const agents = parseJson(fleetAgents.stdout, 'Fleet agents');
  const agentMatches = findAgentsForNode(agents, nodeName, sandboxId);
  const requestedAgent = process.env.RELAY_AGENT_NAME?.trim();
  const agent = requestedAgent
    ? agentMatches.filter((candidate) => agentIdentityMatches(candidate, requestedAgent, nodeName, sandboxId))
    : agentMatches;
  if (agent.length !== 1) {
    throw new Error(`Fleet agent reread found ${agent.length} exact node/agent matches; refusing ambiguity.`);
  }
  const agentIdentity = agent[0];
  const agentName = agentIdentity.name ?? agentIdentity.agentName ?? agentIdentity.id;

  const raw = [
    rawDigest('daytona-sandbox-info', daytona.stdout),
    rawDigest('fleet-nodes', fleetNodes.stdout),
    rawDigest('fleet-agents', fleetAgents.stdout),
  ];
  await writeObservation(
    'fixed',
    'fleet_identity_attestation_reread',
    `Independent provider/node/agent rereads matched Daytona sandbox=${sandboxId}, node=${nodeName}, agent=${agentName}; raw output hashes=${JSON.stringify(raw)}.`
  );
}

function providerIdentityMatches(value, sandboxId) {
  const object = findIdentity(value, sandboxId, ['id', 'sandboxId']);
  return Boolean(
    object &&
    (object.providerId === 'daytona' || object.provider === 'daytona' || object.provider?.id === 'daytona')
  );
}

function findNodesForSandbox(value, sandboxId, matches = []) {
  if (Array.isArray(value)) {
    for (const entry of value) findNodesForSandbox(entry, sandboxId, matches);
    return dedupeIdentityMatches(matches);
  }
  if (!value || typeof value !== 'object') return dedupeIdentityMatches(matches);
  const name = value.name ?? value.nodeName;
  const text = JSON.stringify(value);
  if (typeof name === 'string' && name && text.includes(sandboxId) && /daytona/i.test(text)) {
    matches.push(value);
  }
  for (const child of Object.values(value)) findNodesForSandbox(child, sandboxId, matches);
  return dedupeIdentityMatches(matches);
}

function findAgentsForNode(value, nodeName, sandboxId, matches = []) {
  if (Array.isArray(value)) {
    for (const entry of value) findAgentsForNode(entry, nodeName, sandboxId, matches);
    return dedupeIdentityMatches(matches);
  }
  if (!value || typeof value !== 'object') return dedupeIdentityMatches(matches);
  const name = value.name ?? value.agentName ?? value.id;
  const text = JSON.stringify(value);
  const declaredSandbox = [value.sandboxId, value.sandbox_id, value.sandbox].find(
    (candidate) => typeof candidate === 'string'
  );
  if (
    typeof name === 'string' &&
    name &&
    text.includes(nodeName) &&
    (!declaredSandbox || declaredSandbox === sandboxId)
  ) {
    matches.push(value);
  }
  for (const child of Object.values(value)) findAgentsForNode(child, nodeName, sandboxId, matches);
  return dedupeIdentityMatches(matches);
}

function dedupeIdentityMatches(matches) {
  const seen = new Set();
  return matches.filter((entry) => {
    const identity = entry.name ?? entry.nodeName ?? entry.agentName ?? entry.id;
    if (typeof identity !== 'string' || seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function agentIdentityMatches(agent, agentName, nodeName, sandboxId) {
  const text = JSON.stringify(agent);
  const declaredSandbox = [agent.sandboxId, agent.sandbox_id, agent.sandbox]?.find(
    (value) => typeof value === 'string'
  );
  return (
    (agent.name === agentName || agent.agentName === agentName || agent.id === agentName) &&
    text.includes(nodeName) &&
    (!declaredSandbox || declaredSandbox === sandboxId)
  );
}

function findIdentity(value, expected, fields) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findIdentity(entry, expected, fields);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  if (fields.some((field) => value[field] === expected)) return value;
  for (const child of Object.values(value)) {
    const found = findIdentity(child, expected, fields);
    if (found) return found;
  }
  return null;
}

function parseJson(text, label) {
  try {
    return JSON.parse(String(text).trim());
  } catch (error) {
    throw new Error(`${label} did not return raw JSON: ${error.message}`);
  }
}

function rawDigest(label, text) {
  const bytes = Buffer.from(String(text));
  return { label, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

async function writeObservation(outcome, signature, details) {
  const observation = {
    version: 1,
    caseId: CASE_ID,
    arm,
    outcome,
    signature,
    details: details.slice(0, 4_000),
  };
  await writeFile(resultPath, `${JSON.stringify(observation)}\n`, { mode: 0o600 });
}

function run(command, args, cwd, label, env, timeout = COMMAND_TIMEOUT_MS) {
  const completed = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout });
  if (completed.error) throw new Error(`${label} could not start: ${completed.error.message}`);
  return {
    ...completed,
    status: completed.status ?? 1,
    stdout: completed.stdout ?? '',
    stderr: completed.stderr ?? '',
  };
}

function runNode(args, cwd, env, timeout) {
  return run(process.execPath, args, cwd, 'CLI invocation', env, timeout);
}

function buildEnvironment() {
  return Object.fromEntries(
    [
      'PATH',
      'HOME',
      'USER',
      'LOGNAME',
      'SHELL',
      'TMPDIR',
      'LANG',
      'LC_ALL',
      'CI',
      'RELAY_BASE_URL',
      'RELAY_WORKSPACE_KEY',
      'RELAY_AGENT_TOKEN',
      'RELAY_AGENT_NAME',
    ]
      .filter((key) => process.env[key])
      .map((key) => [key, process.env[key]])
  );
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
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

function tail(text) {
  return String(text ?? '').slice(-2_000);
}
