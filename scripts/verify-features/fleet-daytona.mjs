#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateCandidateInstallAttestation } from './relay-candidate-install.mjs';
import { inventorySha256, validateFleetCliInventory } from './fleet-cli-inventory.mjs';
import { readRegularFileNoFollow } from './safe-file.mjs';

const CONTRACT_VERSION = 1;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MATRIX = path.resolve(SCRIPT_DIR, '../../tests/relayflows/cleanroom/fleet-daytona.matrix.json');
const DEFAULT_CLI = path.resolve('packages/cli/dist/cli/index.js');
const MOUNT_SCOPE_MARKER = 'tests/relayflows/cleanroom/relayfile-scope-marker.txt';
const MOUNT_ROOT_ONLY_MARKER = 'tests/relayflows/relayfile-root-marker.txt';
const MAX_CAPTURE_BYTES = 16 * 1024;
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_SNAPSHOT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const SAFE_SNAPSHOT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const APP_WORKSPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RELAY_WORKSPACE_ID = /^rw_[a-z0-9]{8}$/;
const OPERATION_STATUSES = new Set(['pass', 'fail', 'blocked', 'safety-skipped']);
const OWNED_AGENT_STATES = new Set(['created-by-run', 'ambiguous-after-checkpointed-absence']);
const EXPECTATIONS = new Set(['success', 'expected-failure', 'sentinel', 'sentinel-and-exit', 'stream']);
const CANDIDATE_SURFACES = new Set([
  'operator-candidate',
  'daytona-candidate',
  'operator-and-daytona-candidate',
]);
const SECRET_OPTION_NAMES = new Set(['--api-key', '--join-ticket', '--token', '--wk', '--workspace-key']);
const KNOWN_SECRET_ENV = [
  'RELAY_AGENT_TOKEN',
  'RELAY_BROKER_API_KEY',
  'RELAY_NODE_TOKEN',
  'RELAY_WORKSPACE_KEY',
  'AGENT_RELAY_WORKSPACE_KEY',
  'RELAY_API_KEY',
  'RELAYCAST_API_KEY',
  'DAYTONA_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'CLOUD_API_ACCESS_TOKEN',
  'CLOUD_API_REFRESH_TOKEN',
];

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected positional argument: ${token}`);
    const key = token.slice(2);
    const next = rest[index + 1];
    if (next === undefined || next.startsWith('--')) options[key] = true;
    else {
      options[key] = next;
      index += 1;
    }
  }
  return { command, options };
}

export async function loadWorkspaceCredentialFile() {
  const configured = process.env.VERIFY_FLEET_WORKSPACE_KEY_FILE?.trim();
  if (!configured) return;
  const target = path.resolve(configured);
  const { bytes } = await readRegularFileNoFollow(target, {
    label: 'VERIFY_FLEET_WORKSPACE_KEY_FILE',
    maxBytes: 64 * 1024,
    privateMode: true,
    currentUserOwned: true,
  });
  if (bytes.length === 0) {
    throw new Error('VERIFY_FLEET_WORKSPACE_KEY_FILE must be a non-empty private regular file');
  }
  const value = JSON.parse(bytes.toString('utf8'));
  const relay = value?.relay;
  const cloud = value?.cloud;
  const workspaceId = typeof value?.workspaceId === 'string' ? value.workspaceId.trim() : '';
  const relayWorkspaceId = typeof value?.relayWorkspaceId === 'string' ? value.relayWorkspaceId.trim() : '';
  const workspaceExpiresAt = typeof value?.expiresAt === 'string' ? value.expiresAt.trim() : '';
  const workspaceKey = typeof relay?.workspaceKey === 'string' ? relay.workspaceKey.trim() : '';
  const baseUrl = typeof relay?.baseUrl === 'string' ? relay.baseUrl.trim() : '';
  const cloudApiUrl = typeof cloud?.apiUrl === 'string' ? cloud.apiUrl.trim() : '';
  const cloudAccessToken = typeof cloud?.accessToken === 'string' ? cloud.accessToken.trim() : '';
  const cloudRefreshToken = typeof cloud?.refreshToken === 'string' ? cloud.refreshToken.trim() : '';
  const cloudAccessTokenExpiresAt =
    typeof cloud?.accessTokenExpiresAt === 'string' ? cloud.accessTokenExpiresAt.trim() : '';
  const cloudRefreshTokenExpiresAt =
    typeof cloud?.refreshTokenExpiresAt === 'string' ? cloud.refreshTokenExpiresAt.trim() : '';
  try {
    const cloudUrl = new URL(cloudApiUrl);
    const relayUrl = new URL(baseUrl);
    if (
      cloudUrl.protocol !== 'https:' ||
      cloudUrl.username ||
      cloudUrl.password ||
      relayUrl.protocol !== 'https:' ||
      relayUrl.username ||
      relayUrl.password
    ) {
      throw new Error('workspace credential endpoints must be credential-free HTTPS URLs');
    }
  } catch {
    throw new Error('workspace credential file contains an invalid API URL');
  }
  if (
    value?.version !== 1 ||
    !APP_WORKSPACE_ID.test(workspaceId) ||
    !RELAY_WORKSPACE_ID.test(relayWorkspaceId) ||
    !Number.isFinite(Date.parse(workspaceExpiresAt)) ||
    !workspaceKey ||
    !baseUrl ||
    !cloudAccessToken ||
    !cloudRefreshToken ||
    !Number.isFinite(Date.parse(cloudAccessTokenExpiresAt)) ||
    !Number.isFinite(Date.parse(cloudRefreshTokenExpiresAt))
  ) {
    throw new Error('workspace credential file does not match the strict nested v1 schema');
  }
  const minimumLifetime = Number(process.env.VERIFY_FLEET_MIN_CREDENTIAL_LIFETIME_SECONDS ?? '0');
  if (!Number.isSafeInteger(minimumLifetime) || minimumLifetime < 0 || minimumLifetime > 86_400) {
    throw new Error('VERIFY_FLEET_MIN_CREDENTIAL_LIFETIME_SECONDS must be 0-86400');
  }
  if (minimumLifetime > 0) {
    const deadline = Date.now() + minimumLifetime * 1_000;
    if (Date.parse(workspaceExpiresAt) < deadline || Date.parse(cloudRefreshTokenExpiresAt) < deadline) {
      throw new Error('workspace credential lifetime is too short for a complete Fleet attempt');
    }
  }
  const expectedWorkspaceId = process.env.VERIFY_FLEET_EXPECTED_WORKSPACE_ID?.trim();
  if (expectedWorkspaceId && expectedWorkspaceId !== workspaceId) {
    throw new Error('workspace credential file does not match VERIFY_FLEET_EXPECTED_WORKSPACE_ID');
  }
  process.env.RELAY_WORKSPACE_KEY = workspaceKey;
  process.env.RELAY_BASE_URL = baseUrl;
  process.env.CLOUD_API_URL = cloudApiUrl;
  process.env.CLOUD_API_ACCESS_TOKEN = cloudAccessToken;
  process.env.CLOUD_API_REFRESH_TOKEN = cloudRefreshToken;
  process.env.CLOUD_API_ACCESS_TOKEN_EXPIRES_AT = cloudAccessTokenExpiresAt;
  process.env.CLOUD_API_REFRESH_TOKEN_EXPIRES_AT = cloudRefreshTokenExpiresAt;
  process.env.VERIFY_FLEET_EXPECTED_WORKSPACE_ID = workspaceId;
  process.env.VERIFY_FLEET_EXPECTED_RELAY_WORKSPACE_ID = relayWorkspaceId;
}

export function buildDirectNodeSpawnPlan(provider, agentName, sentinel, extra = {}) {
  const targetChannel = extra.channel ?? 'general';
  const cwdInstruction = extra.cwd
    ? `First verify your process cwd is exactly ${extra.cwd}; if it is not, post nothing.`
    : '';
  const expectedModel =
    extra.model ??
    (provider === 'codex' ? (process.env.VERIFY_FLEET_CODEX_MODEL ?? 'gpt-5.6-luna') : undefined);
  const commandName = extra.commandName ?? 'spawn';
  return {
    commandName,
    expectedModel,
    args: [
      'node',
      'agent',
      commandName,
      provider,
      '--name',
      agentName,
      ...(extra.channels ? ['--channels', ...extra.channels] : []),
      '--task',
      `${cwdInstruction} Use Agent Relay MCP to post the exact text ${sentinel} to channel ${targetChannel}, then remain idle.`.trim(),
      ...(extra.mode ? ['--mode', extra.mode] : []),
      ...(extra.runtime ? ['--runtime', extra.runtime] : []),
      ...(extra.spawnMode ? ['--spawn-mode', extra.spawnMode] : []),
      ...(extra.exitAfterTask ? ['--exit-after-task'] : []),
      ...(extra.cwd ? ['--cwd', extra.cwd] : []),
      ...(expectedModel ? ['--model', expectedModel] : []),
    ],
  };
}

export function buildFleetSpawnArgs(options, qualification = {}) {
  return [
    'fleet',
    'spawn',
    options.provider,
    '--name',
    options.agentName,
    '--task',
    options.task,
    ...(options.node ? [options.nodeFlag ?? '--node', options.node] : []),
    ...(options.sandbox ? ['--sandbox', '--sandbox-provider', 'daytona'] : []),
    ...(options.sandbox && qualification.releaseQualificationRequested
      ? [
          '--sandbox-snapshot',
          qualification.expectedSnapshotId,
          '--sandbox-snapshot-manifest-sha256',
          qualification.expectedSnapshotManifestSha256,
        ]
      : []),
    ...(options.sandboxName ? ['--sandbox-name', options.sandboxName] : []),
    ...(options.noMount ? ['--no-sandbox-relayfile'] : []),
    ...(options.mountPaths ? ['--sandbox-relayfile-path', ...options.mountPaths] : []),
    ...(options.model ? ['--model', options.model] : []),
    ...(options.channel ? ['--channel', options.channel] : []),
    ...(options.cwd ? ['--cwd', options.cwd] : []),
    ...(options.persona ? ['--persona', options.persona] : []),
    ...(options.organization ? ['--organization', options.organization] : []),
    ...(options.project ? ['--project', options.project] : []),
    ...(options.workstream ? ['--workstream', options.workstream] : []),
    ...(options.role ? ['--role', options.role] : []),
    ...(options.objective ? ['--objective', options.objective] : []),
    ...(options.sessionRef ? ['--session-ref', options.sessionRef] : []),
    ...(options.noConfirm ? ['--no-confirm'] : []),
    '--confirm-timeout',
    String(options.confirmTimeoutMs ?? 60_000),
  ];
}

function requiredOption(options, name) {
  const value = options[name];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`--${name} is required`);
  return value.trim();
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function assertSafeId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new Error(`${label} must match ${SAFE_ID}`);
  }
  return value;
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function matchesSandboxFileInspection(inspection, expected) {
  if (inspection?.exitCode !== 0 || typeof expected?.exists !== 'boolean') return false;
  if (!expected.exists) return inspection.payload?.exists === false;
  return (
    inspection.payload?.exists === true &&
    inspection.payload?.sha256 === expected.sha256 &&
    inspection.payload?.bytes === expected.bytes
  );
}

async function writePrivateAtomic(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}-${process.pid}-${randomBytes(6).toString('hex')}.tmp`
  );
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(value);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, target);
}

async function writePrivateAtomicExclusive(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  const reservation = await open(target, 'wx', 0o600);
  try {
    await reservation.writeFile(
      `${JSON.stringify({ version: CONTRACT_VERSION, kind: 'atomic-write-reservation' })}\n`
    );
    await reservation.sync();
  } finally {
    await reservation.close();
  }
  try {
    await writePrivateAtomic(target, value);
  } catch (error) {
    await unlink(target).catch(() => undefined);
    throw error;
  }
}

export function validateFleetMatrix(matrix) {
  assertObject(matrix, 'matrix');
  if (matrix.version !== CONTRACT_VERSION) throw new Error(`matrix.version must be ${CONTRACT_VERSION}`);
  if (matrix.product !== 'relay') throw new Error('matrix.product must be relay');
  if (matrix.provider !== 'daytona') throw new Error('matrix.provider must be daytona');
  if (!Number.isSafeInteger(matrix.minimumBoardNodes) || matrix.minimumBoardNodes < 2) {
    throw new Error('matrix.minimumBoardNodes must be at least 2');
  }
  if (
    !Number.isSafeInteger(matrix.minimumCriticalLifecycleTrials) ||
    matrix.minimumCriticalLifecycleTrials < 5 ||
    matrix.minimumCriticalLifecycleTrials > 20
  ) {
    throw new Error('matrix.minimumCriticalLifecycleTrials must be between 5 and 20');
  }
  if (
    typeof matrix.requiredSnapshotRelayVersion !== 'string' ||
    !matrix.requiredSnapshotRelayVersion.trim()
  ) {
    throw new Error('matrix.requiredSnapshotRelayVersion is required');
  }
  if (!Array.isArray(matrix.operations) || matrix.operations.length === 0) {
    throw new Error('matrix.operations must be a non-empty array');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.json$/.test(matrix.inventoryFile ?? '')) {
    throw new Error('matrix.inventoryFile is invalid');
  }
  if (!SHA256.test(matrix.inventorySha256 ?? '')) throw new Error('matrix.inventorySha256 is invalid');
  const ids = new Set();
  for (const [index, operation] of matrix.operations.entries()) {
    assertObject(operation, `matrix.operations[${index}]`);
    assertSafeId(operation.id, `matrix.operations[${index}].id`);
    if (ids.has(operation.id)) throw new Error(`duplicate operation id: ${operation.id}`);
    ids.add(operation.id);
    assertSafeId(operation.group, `operation ${operation.id}.group`);
    if (!EXPECTATIONS.has(operation.expect)) {
      throw new Error(`operation ${operation.id}.expect is invalid`);
    }
    if (
      operation.destructiveScope !== undefined &&
      !['workspace-policy', 'sandbox-processes'].includes(operation.destructiveScope)
    ) {
      throw new Error(`operation ${operation.id}.destructiveScope is invalid`);
    }
    if (operation.mustContain !== undefined && typeof operation.mustContain !== 'string') {
      throw new Error(`operation ${operation.id}.mustContain must be a string`);
    }
    if (operation.allowTimeout !== undefined && typeof operation.allowTimeout !== 'boolean') {
      throw new Error(`operation ${operation.id}.allowTimeout must be boolean`);
    }
    if (
      operation.argvMustContain !== undefined &&
      (!Array.isArray(operation.argvMustContain) ||
        operation.argvMustContain.length === 0 ||
        operation.argvMustContain.some((token) => typeof token !== 'string' || !token || token.length > 200))
    ) {
      throw new Error(`operation ${operation.id}.argvMustContain must be non-empty string tokens`);
    }
  }
  if (matrix.operations.length !== 94)
    throw new Error('matrix.operations must contain exactly 94 operations');
  validateFleetAcceptance(matrix);
  assertObject(matrix.commandSurface, 'matrix.commandSurface');
  const commandOperationIds = new Set();
  for (const [leaf, operationIds] of Object.entries(matrix.commandSurface)) {
    if (!/^(?:fleet|node)(?: [a-z][a-z-]*)+$/.test(leaf)) {
      throw new Error(`matrix.commandSurface has invalid command leaf ${leaf}`);
    }
    if (!Array.isArray(operationIds) || operationIds.length === 0) {
      throw new Error(`matrix.commandSurface.${leaf} must reference at least one operation`);
    }
    for (const operationId of operationIds) {
      if (!ids.has(operationId)) {
        throw new Error(`matrix.commandSurface.${leaf} references missing operation ${operationId}`);
      }
      if (commandOperationIds.has(operationId)) {
        throw new Error(`matrix operation ${operationId} is mapped to more than one command leaf`);
      }
      commandOperationIds.add(operationId);
    }
  }
  for (const required of [
    'provision-node-a',
    'provision-node-b',
    'prove-distinct-fresh-daytona-nodes',
    'fleet-nodes-default',
    'fleet-agent-list-json',
    'fleet-spawn-node',
    'fleet-release',
    'fleet-config',
    'fleet-enable',
    'fleet-disable',
    'fleet-inherit',
    'fleet-status',
    'node-agent-spawn-codex-auto-a',
    'node-agent-spawn-codex-auto-b',
    'node-agent-release',
    'owned-sandbox-cleanup',
  ]) {
    if (!ids.has(required)) throw new Error(`matrix is missing required operation ${required}`);
  }
  const fleetProviders = ['claude', 'codex', 'gemini', 'aider', 'goose', 'grok', 'opencode'];
  const nodeProviders = [
    'claude',
    'gemini',
    'droid',
    'aider',
    'goose',
    'grok',
    'opencode',
    'cursor',
    'pi-native',
    'deepagents-native',
  ];
  for (const provider of fleetProviders) {
    if (!ids.has(`fleet-spawn-provider-${provider}`)) {
      throw new Error(`matrix is missing fleet provider ${provider}`);
    }
  }
  for (const provider of nodeProviders) {
    if (!ids.has(`node-agent-spawn-provider-${provider}`)) {
      throw new Error(`matrix is missing node agent provider ${provider}`);
    }
  }
  return matrix;
}

export function validateFleetAcceptance(matrix) {
  const acceptance = assertObject(matrix.acceptance, 'matrix.acceptance');
  if (acceptance.version !== CONTRACT_VERSION) {
    throw new Error(`matrix.acceptance.version must be ${CONTRACT_VERSION}`);
  }
  const profiles = assertObject(acceptance.profiles, 'matrix.acceptance.profiles');
  const operationProfiles = assertObject(acceptance.operationProfiles, 'matrix.acceptance.operationProfiles');
  for (const [name, profileValue] of Object.entries(profiles)) {
    assertSafeId(name, `acceptance profile ${name}`);
    const profile = assertObject(profileValue, `acceptance profile ${name}`);
    if (!CANDIDATE_SURFACES.has(profile.candidateSurface)) {
      throw new Error(`acceptance profile ${name}.candidateSurface is invalid`);
    }
    if (typeof profile.executionScope !== 'string' || !profile.executionScope.trim()) {
      throw new Error(`acceptance profile ${name}.executionScope is required`);
    }
    for (const key of ['effectAssertions', 'negativeAssertions']) {
      if (
        !Array.isArray(profile[key]) ||
        profile[key].length === 0 ||
        profile[key].some((entry) => typeof entry !== 'string' || !entry.trim())
      ) {
        throw new Error(`acceptance profile ${name}.${key} must contain non-empty assertions`);
      }
    }
    for (const key of ['lifecycleAssertion', 'teardownAssertion', 'retryAssertion']) {
      if (typeof profile[key] !== 'string' || !profile[key].trim()) {
        throw new Error(`acceptance profile ${name}.${key} is required`);
      }
    }
  }
  const expectedIds = matrix.operations.map(({ id }) => id).sort();
  const mappedIds = Object.keys(operationProfiles).sort();
  if (expectedIds.length !== mappedIds.length || expectedIds.some((id, index) => id !== mappedIds[index])) {
    throw new Error('matrix.acceptance.operationProfiles must exactly map all 94 operations');
  }
  for (const [operationId, profile] of Object.entries(operationProfiles)) {
    if (typeof profile !== 'string' || !Object.prototype.hasOwnProperty.call(profiles, profile)) {
      throw new Error(`operation ${operationId} references unknown acceptance profile ${String(profile)}`);
    }
  }
  return acceptance;
}

export function validateFleetCommandCoverage(matrix, inventory) {
  validateFleetMatrix(matrix);
  validateFleetCliInventory(inventory);
  if (inventorySha256(inventory) !== matrix.inventorySha256) {
    throw new Error('matrix Fleet CLI inventory digest does not match');
  }
  const leaves = inventory.commands
    .filter((command) => command.leaf)
    .map((command) => command.path)
    .sort();
  const deferredSurface = matrix.deferredCommandSurface ?? [];
  if (
    !Array.isArray(deferredSurface) ||
    deferredSurface.some((commandPath) => typeof commandPath !== 'string' || !commandPath)
  ) {
    throw new Error('matrix.deferredCommandSurface must contain non-empty command paths');
  }
  const deferred = new Set(deferredSurface);
  for (const commandPath of deferred) {
    if (!leaves.includes(commandPath)) {
      throw new Error(`matrix deferredCommandSurface references missing CLI command ${commandPath}`);
    }
    if (Object.prototype.hasOwnProperty.call(matrix.commandSurface, commandPath)) {
      throw new Error(`matrix deferred command ${commandPath} must not map to an operation`);
    }
  }
  const coveredLeaves = leaves.filter((commandPath) => !deferred.has(commandPath));
  const mapped = Object.keys(matrix.commandSurface).sort();
  if (coveredLeaves.join('\0') !== mapped.join('\0')) {
    throw new Error('matrix commandSurface must exactly cover every candidate Fleet/node command leaf');
  }
  if (
    inventory.commands.find((command) => command.path === 'fleet serve')?.hidden !== true ||
    JSON.stringify(matrix.commandSurface['fleet serve']) !== JSON.stringify(['fleet-serve-migration'])
  ) {
    throw new Error('hidden fleet serve migration surface is not exactly covered');
  }
  return matrix;
}

function commandLeafForOperation(matrix, operationId) {
  for (const [leaf, operationIds] of Object.entries(matrix.commandSurface)) {
    if (operationIds.includes(operationId)) return leaf;
  }
  return null;
}

function argvContainsCommandInvocation(argv, leaf) {
  const tokens = leaf.split(' ');
  for (let index = 1; index <= argv.length - tokens.length; index += 1) {
    if (!tokens.every((token, offset) => argv[index + offset] === token)) continue;
    const launcher = path.basename(String(argv[index - 1]));
    if (launcher === 'agent-relay' || launcher === 'index.js') return true;
  }
  return false;
}

export function validateOperationArgvContract(operation, definition, matrix) {
  if (!Array.isArray(operation.argv)) {
    throw new Error(`operation ${operation.id} has no sanitized argv`);
  }
  const leaf = commandLeafForOperation(matrix, operation.id);
  if (!leaf) return operation;
  if (!argvContainsCommandInvocation(operation.argv, leaf)) {
    throw new Error(`operation ${operation.id} argv does not invoke command leaf ${leaf}`);
  }
  for (const token of definition.argvMustContain ?? []) {
    if (!operation.argv.includes(token)) {
      throw new Error(`operation ${operation.id} argv is missing required token ${token}`);
    }
  }
  return operation;
}

export async function loadFleetMatrix(matrixPath = DEFAULT_MATRIX) {
  const target = path.resolve(matrixPath);
  const matrix = validateFleetMatrix(JSON.parse(await readFile(target, 'utf8')));
  const inventory = JSON.parse(await readFile(path.join(path.dirname(target), matrix.inventoryFile), 'utf8'));
  return validateFleetCommandCoverage(matrix, inventory);
}

function expectedOwnedAgentNames(matrix, nonce) {
  const short = nonce.slice(0, 16);
  return new Set([
    `relay-fleetboard-controller-${short}`,
    `relay-fleetboard-a-initial-${short}`,
    `relay-fleetboard-b-initial-${short}`,
    `critical-lifecycle-a-${short}`,
    `critical-lifecycle-b-${short}`,
    ...matrix.operations.map(({ id }) => `${id}-${short}`),
  ]);
}

function expectedOwnedSandboxNames(nonce) {
  const short = nonce.slice(0, 16);
  return new Set(['a', 'b', 'root', 'scoped', 'nomount'].map((role) => `relay-fleetboard-${role}-${short}`));
}

export function validateRecoveryEvidence(evidence, matrix, nonce) {
  assertObject(evidence, 'recovery evidence');
  if (
    evidence.version !== CONTRACT_VERSION ||
    evidence.kind !== 'fleet-daytona-board' ||
    evidence.product !== 'relay' ||
    evidence.provider !== 'daytona' ||
    evidence.nonce !== nonce
  ) {
    throw new Error('recovery evidence identity is invalid');
  }
  const baseline = assertObject(evidence.baseline, 'recovery evidence.baseline');
  for (const key of ['sandboxIdHashes', 'sandboxNameHashes', 'agentNameHashes', 'fleetNodeNameHashes']) {
    if (!Array.isArray(baseline[key]) || baseline[key].some((value) => !/^[0-9a-f]{64}$/.test(value))) {
      throw new Error(`recovery evidence.baseline.${key} is invalid`);
    }
  }
  if (!Array.isArray(evidence.resources) || !Array.isArray(evidence.ownershipIntents)) {
    throw new Error('recovery evidence resources and ownership intents must be arrays');
  }
  const intents = new Set(
    evidence.ownershipIntents.map((intent) => `${intent?.type ?? ''}:${intent?.name ?? ''}`)
  );
  const expectedAgents = expectedOwnedAgentNames(matrix, nonce);
  const expectedSandboxes = expectedOwnedSandboxNames(nonce);
  const seen = new Set();
  for (const resource of evidence.resources) {
    assertObject(resource, 'recovery resource');
    const resourceKey = `${resource.type}:${resource.id}`;
    if (seen.has(resourceKey)) throw new Error(`duplicate recovery resource ${resourceKey}`);
    seen.add(resourceKey);
    if (resource.type === 'relay-agent') {
      if (
        !expectedAgents.has(resource.id) ||
        !OWNED_AGENT_STATES.has(resource.ownership) ||
        baseline.agentNameHashes.includes(sha256(resource.id)) ||
        !intents.has(`relay-agent:${resource.id}`)
      ) {
        throw new Error(`Relay agent ${resource.id ?? '(missing)'} is not authorized for recovery cleanup`);
      }
    } else if (resource.type === 'daytona-sandbox') {
      if (
        !UUID.test(resource.id ?? '') ||
        !expectedSandboxes.has(resource.nodeName) ||
        resource.provider !== 'daytona' ||
        !['created-by-run', 'reconciled-absent-baseline'].includes(resource.ownership) ||
        baseline.sandboxIdHashes.includes(sha256(resource.id)) ||
        baseline.sandboxNameHashes.includes(sha256(resource.nodeName)) ||
        !intents.has(`daytona-sandbox:${resource.nodeName}`)
      ) {
        throw new Error(
          `Daytona sandbox ${resource.id ?? '(missing)'} is not authorized for recovery cleanup`
        );
      }
    } else {
      throw new Error(`unsupported recovery resource type: ${resource.type ?? '(missing)'}`);
    }
  }
  return evidence;
}

function secretValues(extra = []) {
  return [
    ...KNOWN_SECRET_ENV.map((name) => process.env[name]).filter(
      (value) => typeof value === 'string' && value.length >= 8
    ),
    ...extra.filter((value) => typeof value === 'string' && value.length >= 8),
  ];
}

export function redactFleetEvidence(value, extraSecrets = []) {
  let text = String(value ?? '');
  for (const secret of secretValues(extraSecrets)) text = text.split(secret).join('[REDACTED_SECRET]');
  text = text
    .replace(/\b(?:at|nt|rk|wk)_[A-Za-z0-9._~+/=-]{8,}\b/g, '[REDACTED_TOKEN]')
    .replace(/\b(?:gh[opurs]|sk-proj|sk-ant)-[A-Za-z0-9._~+/=-]{8,}\b/g, '[REDACTED_TOKEN]')
    .replace(
      /((?:authorization|api[_-]?key|join[_-]?ticket|token|workspace[_-]?key)\s*[:=]\s*)(?:bearer\s+)?[^\s,;"']+/gi,
      '$1[REDACTED]'
    )
    .replace(
      /("(?:api[_-]?key|join[_-]?ticket|token|workspace[_-]?key)"\s*:\s*")([^"]+)(")/gi,
      '$1[REDACTED]$3'
    );
  return text;
}

export function sanitizeFleetArgv(argv) {
  if (!Array.isArray(argv)) throw new Error('argv must be an array');
  const sanitized = [];
  for (let index = 0; index < argv.length; index += 1) {
    const raw = String(argv[index]);
    const equals = raw.indexOf('=');
    const optionName = equals >= 0 ? raw.slice(0, equals) : raw;
    if (SECRET_OPTION_NAMES.has(optionName)) {
      sanitized.push(equals >= 0 ? `${optionName}=[REDACTED]` : optionName);
      if (equals < 0 && index + 1 < argv.length) {
        sanitized.push('[REDACTED]');
        index += 1;
      }
      continue;
    }
    sanitized.push(redactFleetEvidence(raw));
  }
  return sanitized;
}

function boundedAppend(current, chunk, limit) {
  const combined = current + String(chunk);
  const bytes = Buffer.from(combined);
  return bytes.byteLength <= limit ? combined : bytes.subarray(bytes.byteLength - limit).toString('utf8');
}

function childEnvironment(overrides = {}) {
  const allowedExact = new Set([
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'TMPDIR',
    'TERM',
    'LANG',
    'CI',
    'NO_COLOR',
    'NODE_OPTIONS',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'AGENT_RELAY_HOME',
    'AGENT_RELAY_DATA_DIR',
    'AGENT_RELAY_WORKSPACE_KEY',
    'RELAY_BASE_URL',
    'RELAY_WORKSPACE_KEY',
    'RELAY_AGENT_TOKEN',
    'RELAY_API_KEY',
    'RELAYCAST_API_KEY',
    'DAYTONA_API_KEY',
    'CLOUD_API_URL',
    'CLOUD_API_ACCESS_TOKEN',
    'CLOUD_API_REFRESH_TOKEN',
    'CLOUD_API_ACCESS_TOKEN_EXPIRES_AT',
    'CLOUD_API_REFRESH_TOKEN_EXPIRES_AT',
    'RELAY_AGENT_NAME',
  ]);
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      (allowedExact.has(key) || key.startsWith('LC_') || key.startsWith('VERIFY_FLEET_'))
    ) {
      env[key] = value;
    }
  }
  return { ...env, NO_COLOR: '1', AGENT_RELAY_TELEMETRY_DISABLED: '1', ...overrides };
}

async function execute(argv, options = {}) {
  const startedAt = new Date().toISOString();
  const monotonicStartNs = process.hrtime.bigint();
  const timeoutMs = options.timeoutMs ?? 30_000;
  const env = childEnvironment(options.env);
  const captureLimit = options.maxCaptureBytes ?? MAX_CAPTURE_BYTES;
  let stdout = '';
  let stderr = '';
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stdoutTruncated = false;
  let stderrTruncated = false;
  let stdoutCaptureTruncated = false;
  let stderrCaptureTruncated = false;
  let timedOut = false;
  let signal = null;
  let exitCode = null;
  let spawnError;
  let stdinWriteError;
  const stdinTimers = [];
  const stdinChunks =
    options.stdin === undefined
      ? undefined
      : Array.isArray(options.stdin)
        ? options.stdin.map((entry, index, entries) => ({
            bytes: Buffer.from(entry.data),
            delayMs: entry.delayMs ?? 0,
            end: entry.end ?? index === entries.length - 1,
          }))
        : [{ bytes: Buffer.from(options.stdin), delayMs: options.stdinDelayMs ?? 0, end: true }];

  await new Promise((resolve) => {
    let child;
    let killTimer;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd: options.cwd ?? process.cwd(),
        env,
        detached: process.platform !== 'win32',
        stdio: [stdinChunks === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      spawnError = error;
      resolve();
      return;
    }
    if (stdinChunks !== undefined && child.stdin) {
      child.stdin.on('error', (error) => {
        stdinWriteError = error;
      });
      for (const entry of stdinChunks) {
        const writeInput = () => {
          if (!child.stdin || child.stdin.destroyed) return;
          if (entry.end) child.stdin.end(entry.bytes);
          else child.stdin.write(entry.bytes);
        };
        if (entry.delayMs > 0) stdinTimers.push(setTimeout(writeInput, entry.delayMs));
        else writeInput();
      }
    }
    child.stdout.on('data', (chunk) => {
      stdoutBytes += Buffer.byteLength(chunk);
      stdoutTruncated ||= stdoutBytes > Math.min(captureLimit, MAX_CAPTURE_BYTES);
      stdoutCaptureTruncated ||= stdoutBytes > captureLimit;
      stdout = boundedAppend(stdout, chunk, captureLimit);
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += Buffer.byteLength(chunk);
      stderrTruncated ||= stderrBytes > Math.min(captureLimit, MAX_CAPTURE_BYTES);
      stderrCaptureTruncated ||= stderrBytes > captureLimit;
      stderr = boundedAppend(stderr, chunk, captureLimit);
    });
    child.on('error', (error) => {
      spawnError = error;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
        else child.kill('SIGTERM');
      } catch {
        // The child may have exited between the timeout and the signal.
      }
      killTimer = setTimeout(() => {
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {
          // Already gone.
        }
      }, 1_500).unref();
    }, timeoutMs);
    timer.unref();
    child.on('close', (code, closeSignal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      for (const stdinTimer of stdinTimers) clearTimeout(stdinTimer);
      exitCode = code;
      signal = closeSignal;
      resolve();
    });
  });

  const monotonicEndNs = process.hrtime.bigint();
  return {
    argv: sanitizeFleetArgv(argv),
    startedAt,
    finishedAt: new Date().toISOString(),
    monotonicStartNs: monotonicStartNs.toString(),
    monotonicEndNs: monotonicEndNs.toString(),
    durationMs: Number(monotonicEndNs - monotonicStartNs) / 1_000_000,
    exitCode,
    signal,
    timedOut,
    stdoutBytes,
    stderrBytes,
    stdoutTruncated,
    stderrTruncated,
    stdoutCaptureTruncated,
    stderrCaptureTruncated,
    stdout: redactFleetEvidence(boundedAppend('', stdout, MAX_CAPTURE_BYTES), options.extraSecrets),
    stderr: redactFleetEvidence(boundedAppend('', stderr, MAX_CAPTURE_BYTES), options.extraSecrets),
    ...(stdinChunks === undefined
      ? {}
      : { stdinBytes: stdinChunks.reduce((total, entry) => total + entry.bytes.length, 0) }),
    ...(stdinWriteError
      ? { stdinWriteError: redactFleetEvidence(stdinWriteError.message ?? String(stdinWriteError)) }
      : {}),
    ...(spawnError ? { spawnError: redactFleetEvidence(spawnError.message ?? String(spawnError)) } : {}),
    _rawStdout: stdout,
    _rawStderr: stderr,
  };
}

export { execute as executeFleetCommand };

function stripPrivateExecution(result) {
  const { _rawStdout: _ignoredStdout, _rawStderr: _ignoredStderr, ...publicResult } = result;
  return publicResult;
}

export function tryParseJson(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    for (let index = 0; index < trimmed.length; index += 1) {
      if (trimmed[index] !== '{' && trimmed[index] !== '[') continue;
      const stack = [];
      let inString = false;
      let escaped = false;
      for (let cursor = index; cursor < trimmed.length; cursor += 1) {
        const character = trimmed[cursor];
        if (inString) {
          if (escaped) escaped = false;
          else if (character === '\\') escaped = true;
          else if (character === '"') inString = false;
          continue;
        }
        if (character === '"') {
          inString = true;
          continue;
        }
        if (character === '{' || character === '[') stack.push(character);
        else if (character === '}' || character === ']') {
          const opening = stack.pop();
          if ((opening === '{' && character !== '}') || (opening === '[' && character !== ']')) break;
          if (stack.length === 0) {
            try {
              return JSON.parse(trimmed.slice(index, cursor + 1));
            } catch {
              break;
            }
          }
        }
      }
    }
  }
  return undefined;
}

function findStringDeep(value, keys) {
  if (!value || typeof value !== 'object') return undefined;
  for (const key of keys) {
    if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim();
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const found = findStringDeep(child, keys);
    if (found) return found;
  }
  return undefined;
}

export function findFleetAgent(payload, agentName) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.perNode)) return undefined;
  return payload.perNode.find((entry) => entry && typeof entry === 'object' && entry.name === agentName);
}

export function findFleetAgentNode(payload, agentName) {
  const row = findFleetAgent(payload, agentName);
  return row && typeof row.node === 'string' ? row.node : undefined;
}

export function findExactSentinelMessage(payload, sentinel, from) {
  if (!Array.isArray(payload)) return undefined;
  return payload.find(
    (message) =>
      message?.text === sentinel &&
      (!from || message?.agentName === from) &&
      typeof message?.id === 'string' &&
      message.id.length > 0
  );
}

export function operationStatus(definition, result) {
  const expect = definition.expect;
  if (result.blockedReason) return 'blocked';
  if (result.safetyReason) return 'safety-skipped';
  if (result.stdoutTruncated === true || result.stderrTruncated === true) return 'fail';
  const cleanExit = result.exitCode === 0 && !result.timedOut && !result.spawnError;
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}\n${result.summary ?? ''}`;
  if (expect === 'success') return cleanExit ? 'pass' : 'fail';
  if (expect === 'expected-failure') {
    const expectedExit =
      Number.isInteger(result.exitCode) && result.exitCode !== 0 && !result.timedOut && !result.spawnError;
    const expectedDiagnostic =
      !definition.mustContain || output.toLowerCase().includes(definition.mustContain.toLowerCase());
    return expectedExit && expectedDiagnostic ? 'pass' : 'fail';
  }
  if (expect === 'stream') {
    const executionOkay =
      cleanExit || (definition.allowTimeout && result.timedOut === true && !result.spawnError);
    return executionOkay && (result.observedStream === true || result.observedSentinel === true)
      ? 'pass'
      : 'fail';
  }
  if (expect === 'sentinel') {
    const executionOkay =
      cleanExit || (definition.allowTimeout && result.timedOut === true && !result.spawnError);
    return executionOkay && result.observedSentinel === true ? 'pass' : 'fail';
  }
  if (expect === 'sentinel-and-exit') {
    return cleanExit && result.observedSentinel === true && result.observedExit === true ? 'pass' : 'fail';
  }
  return 'fail';
}

function noPartialCreationProofPass(proof, targetName) {
  if (!proof || typeof proof !== 'object' || proof.targetName !== targetName) return false;
  const before = proof.before;
  const after = proof.after;
  if (!before || !after) return false;
  const snapshotKeys = ['agentNames', 'fleetNodeKeys', 'sandboxIds', 'sandboxKeys', 'workerProcesses'];
  if (snapshotKeys.some((key) => !Array.isArray(before[key]) || !Array.isArray(after[key]))) return false;
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const processNames = (snapshot) =>
    snapshot.workerProcesses
      .flatMap((entry) => (Array.isArray(entry?.names) ? entry.names : []))
      .filter(Boolean)
      .sort();
  return (
    !before.agentNames.includes(targetName) &&
    !after.agentNames.includes(targetName) &&
    !processNames(before).includes(targetName) &&
    !processNames(after).includes(targetName) &&
    !before.fleetNodeKeys.some((key) => key.endsWith(`:${targetName}`)) &&
    !after.fleetNodeKeys.some((key) => key.endsWith(`:${targetName}`)) &&
    !before.sandboxKeys.some((key) => key.endsWith(`:${targetName}`)) &&
    !after.sandboxKeys.some((key) => key.endsWith(`:${targetName}`)) &&
    same(before.agentNames, after.agentNames) &&
    same(before.fleetNodeKeys, after.fleetNodeKeys) &&
    same(before.sandboxIds, after.sandboxIds) &&
    same(before.sandboxKeys, after.sandboxKeys) &&
    same(before.workerProcesses, after.workerProcesses)
  );
}

export function bindInspectedSnapshotManifest(inspected, inspectionError) {
  return inspected?.manifest
    ? { ...inspected.manifest, sha256: inspected.sha256 }
    : { sha256: null, inspectionError };
}

export function validateSandboxRuntimeAttestation(runtime, expected) {
  assertObject(runtime, 'sandbox runtime attestation');
  assertObject(expected, 'expected sandbox runtime');
  for (const key of ['cliSha256', 'brokerSha256']) {
    if (!SHA256.test(runtime[key] ?? '') || runtime[key] !== expected[key]) {
      throw new Error(`sandbox runtime ${key} does not match the clean-installed candidate`);
    }
  }
  if (runtime.cliVersion !== expected.cliVersion) {
    throw new Error('sandbox runtime CLI version does not match the clean-installed candidate');
  }
  if (runtime.brokerVersion !== `agent-relay-broker ${expected.packageVersion}`) {
    throw new Error('sandbox runtime broker version does not match the clean-installed candidate');
  }
  if (
    runtime.platform !== expected.platform ||
    runtime.arch !== expected.arch ||
    runtime.brokerMode !== '755' ||
    !Number.isSafeInteger(runtime.brokerBytes) ||
    runtime.brokerBytes !== expected.brokerBytes
  ) {
    throw new Error('sandbox runtime platform broker identity is invalid');
  }
  if (
    typeof runtime.cliPath !== 'string' ||
    !path.posix.isAbsolute(runtime.cliPath) ||
    typeof runtime.brokerPath !== 'string' ||
    !path.posix.isAbsolute(runtime.brokerPath)
  ) {
    throw new Error('sandbox runtime executable paths are not absolute');
  }
  const expectedCliSuffix = '/node_modules/agent-relay/dist/cli/index.js';
  const expectedBrokerSuffix =
    `/node_modules/@agent-relay/broker-${expected.platform}-${expected.arch}/bin/` +
    (expected.platform === 'win32' ? 'agent-relay-broker.exe' : 'agent-relay-broker');
  if (!runtime.cliPath.endsWith(expectedCliSuffix) || !runtime.brokerPath.endsWith(expectedBrokerSuffix)) {
    throw new Error('sandbox runtime executable paths do not identify the installed candidate packages');
  }
  return runtime;
}

export function deriveFleetVerdict(operations, cleanup, criticalLifecycle) {
  if (operations.some((operation) => operation.group !== 'cleanup' && operation.status === 'fail')) {
    return 'RED';
  }
  if (criticalLifecycle?.status === 'fail') return 'RED';
  if (cleanup?.status !== 'pass') return 'INFRA_BLOCKED';
  if (
    criticalLifecycle?.status === 'blocked' ||
    operations.some((operation) => ['blocked', 'safety-skipped'].includes(operation.status))
  ) {
    return 'YELLOW';
  }
  return 'GREEN';
}

export function validateCriticalLifecycleEvidence(value, matrix, boardNodes, nonce) {
  const critical = assertObject(value, 'evidence.criticalLifecycle');
  if (!['pass', 'fail', 'blocked'].includes(critical.status)) {
    throw new Error('evidence.criticalLifecycle.status is invalid');
  }
  if (!Array.isArray(critical.trials)) {
    throw new Error('evidence.criticalLifecycle.trials must be an array');
  }
  if (critical.status !== 'blocked' && critical.trials.length !== matrix.minimumCriticalLifecycleTrials) {
    throw new Error(
      `critical lifecycle must contain exactly ${matrix.minimumCriticalLifecycleTrials} trials`
    );
  }
  const boardByName = new Map(boardNodes.map((node) => [node.nodeName, node]));
  const observedNodes = new Set();
  for (const [index, trialValue] of critical.trials.entries()) {
    const trial = assertObject(trialValue, `critical lifecycle trial ${index + 1}`);
    if (trial.index !== index + 1 || !['pass', 'fail'].includes(trial.status)) {
      throw new Error(`critical lifecycle trial ${index + 1} identity is invalid`);
    }
    const node = boardByName.get(trial.nodeName);
    if (!node || node.nodeId !== trial.nodeId) {
      throw new Error(`critical lifecycle trial ${index + 1} is not bound to an owned board node`);
    }
    observedNodes.add(trial.nodeName);
    const expectedAgent = `critical-lifecycle-${index % 2 === 0 ? 'a' : 'b'}-${nonce.slice(0, 16)}`;
    if (
      trial.agentName !== expectedAgent ||
      typeof trial.preSpawnAgentAbsent !== 'boolean' ||
      typeof trial.monotonicStartNs !== 'string' ||
      !/^\d+$/.test(trial.monotonicStartNs) ||
      typeof trial.monotonicEndNs !== 'string' ||
      !/^\d+$/.test(trial.monotonicEndNs) ||
      BigInt(trial.monotonicEndNs) < BigInt(trial.monotonicStartNs) ||
      typeof trial.durationMs !== 'number' ||
      trial.durationMs < 0
    ) {
      throw new Error(`critical lifecycle trial ${index + 1} timing or agent identity is invalid`);
    }
    const measuredDurationMs =
      Number(BigInt(trial.monotonicEndNs) - BigInt(trial.monotonicStartNs)) / 1_000_000;
    if (Math.abs(measuredDurationMs - trial.durationMs) > Math.max(1, measuredDurationMs * 0.001)) {
      throw new Error(`critical lifecycle trial ${index + 1} duration is inconsistent`);
    }
    if (
      !Array.isArray(trial.spawnArgv) ||
      !argvContainsCommandInvocation(trial.spawnArgv, 'fleet spawn') ||
      !trial.spawnArgv.includes('--node') ||
      !trial.spawnArgv.includes(trial.nodeName)
    ) {
      throw new Error(`critical lifecycle trial ${index + 1} did not invoke targeted fleet spawn`);
    }
    const agentOriginatedAckProof =
      SHA256.test(trial.initialAckMessageIdHash ?? '') &&
      trial.initialAckAgentName === trial.agentName &&
      trial.initialAckChannelName === 'general' &&
      SHA256.test(trial.injectionMessageIdHash ?? '') &&
      SHA256.test(trial.postReadyAckMessageIdHash ?? '') &&
      trial.postReadyAckAgentName === trial.agentName &&
      trial.postReadyAckChannelName === 'general' &&
      trial.initialAckMessageIdHash !== trial.postReadyAckMessageIdHash;
    const expectedStatus =
      trial.preSpawnAgentAbsent === true &&
      trial.spawned === true &&
      trial.placementConfirmed === true &&
      trial.initialSentinelObserved === true &&
      trial.postReadyInjectionAccepted === true &&
      trial.postReadySentinelObserved === true &&
      trial.postReadyReaderConfirmed === true &&
      trial.releasedAndAbsent === true &&
      trial.spawnOutputTruncated === false &&
      agentOriginatedAckProof
        ? 'pass'
        : 'fail';
    if (trial.status !== expectedStatus) {
      throw new Error(`critical lifecycle trial ${index + 1} status is inconsistent`);
    }
  }
  if (critical.status === 'pass') {
    if (
      critical.trials.some(({ status }) => status !== 'pass') ||
      observedNodes.size !== matrix.minimumBoardNodes
    ) {
      throw new Error('passing critical lifecycle must pass on both distinct board nodes');
    }
    const reusedNames = new Set(critical.trials.map(({ agentName }) => agentName));
    if (reusedNames.size >= critical.trials.length) {
      throw new Error('passing critical lifecycle did not prove same-name reuse');
    }
  }
  if (critical.status === 'fail' && critical.trials.every(({ status }) => status === 'pass')) {
    throw new Error('failed critical lifecycle has no failed trial');
  }
  return critical;
}

export function validateFleetEvidence(evidence, matrix) {
  assertObject(evidence, 'evidence');
  if (evidence.version !== CONTRACT_VERSION) throw new Error('evidence.version is invalid');
  if (
    evidence.kind !== 'fleet-daytona-board' ||
    evidence.product !== 'relay' ||
    evidence.provider !== 'daytona'
  ) {
    throw new Error('evidence identity is invalid');
  }
  assertSafeId(evidence.nonce, 'evidence.nonce');
  const runStart = Date.parse(evidence.startedAt);
  const runFinish = Date.parse(evidence.finishedAt);
  if (!Number.isFinite(runStart) || !Number.isFinite(runFinish) || runFinish < runStart) {
    throw new Error('evidence run timestamps are invalid');
  }
  const provenance = assertObject(evidence.provenance, 'evidence.provenance');
  if (!/^[0-9a-f]{40}$/.test(provenance.sourceCommit ?? '')) {
    throw new Error('evidence source commit is invalid');
  }
  if (provenance.sourceDirty !== false) {
    throw new Error('Fleet qualification requires a clean source tree');
  }
  for (const key of ['cliSha256', 'runnerSha256', 'matrixSha256', 'inventorySha256']) {
    if (!/^[0-9a-f]{64}$/.test(provenance[key] ?? '')) throw new Error(`evidence ${key} is invalid`);
  }
  if (provenance.matrixSha256 !== sha256(JSON.stringify(matrix))) {
    throw new Error('evidence matrix digest does not match the active matrix');
  }
  if (provenance.inventorySha256 !== matrix.inventorySha256) {
    throw new Error('evidence Fleet CLI inventory digest does not match the active matrix');
  }
  for (const key of ['cliVersion', 'daytonaVersion']) {
    if (typeof provenance[key] !== 'string' || !provenance[key]) {
      throw new Error(`evidence ${key} is missing`);
    }
  }
  const environment = assertObject(evidence.environment, 'evidence.environment');
  for (const key of ['policyMutationRequested', 'policyMutationAuthorized', 'policyMutationPerformed']) {
    if (typeof environment[key] !== 'boolean') throw new Error(`evidence environment.${key} is invalid`);
  }
  if (environment.controlPlaneClean !== true) {
    throw new Error('evidence did not start from a clean, explicitly disposable Relay workspace');
  }
  if (environment.releaseQualificationRequested === true) {
    if (!SAFE_SNAPSHOT_ID.test(environment.expectedSnapshotId ?? '')) {
      throw new Error('release qualification has no safe immutable snapshot id');
    }
    if (!SAFE_SNAPSHOT.test(environment.expectedSnapshotName ?? '')) {
      throw new Error('release qualification has no safe expected snapshot name');
    }
    if (!SHA256.test(environment.expectedSnapshotManifestSha256 ?? '')) {
      throw new Error('release qualification has no expected snapshot manifest digest');
    }
    if (typeof environment.expectedRelayVersion !== 'string' || !environment.expectedRelayVersion) {
      throw new Error('release qualification has no expected Relay version');
    }
    if (
      provenance.candidateCleanInstall !== true ||
      !SHA256.test(provenance.candidateInstallAttestationSha256 ?? '') ||
      provenance.candidateInstallSourceSha !== provenance.sourceCommit ||
      provenance.candidateInstallVersion !== provenance.cliVersion.replace(/^agent-relay v/, '') ||
      provenance.candidateInstallVersion !== environment.expectedRelayVersion ||
      provenance.candidateInstallPlatform !== 'linux' ||
      !['arm64', 'x64'].includes(provenance.candidateInstallArch) ||
      !SHA256.test(provenance.candidateInstallBrokerSha256 ?? '') ||
      !Number.isSafeInteger(provenance.candidateInstallBrokerBytes) ||
      provenance.candidateInstallBrokerBytes < 1
    ) {
      throw new Error('release qualification did not run a source-bound clean-installed Relay candidate');
    }
  }
  const baseline = assertObject(evidence.baseline, 'evidence.baseline');
  for (const key of ['sandboxIdHashes', 'sandboxNameHashes', 'agentNameHashes', 'fleetNodeNameHashes']) {
    if (!Array.isArray(baseline[key]) || baseline[key].some((value) => !/^[0-9a-f]{64}$/.test(value))) {
      throw new Error(`evidence baseline.${key} is invalid`);
    }
  }
  for (const key of ['agentCount', 'onlineAgentCount', 'fleetNodeCount', 'liveFleetNodeCount']) {
    if (baseline[key] !== 0) {
      throw new Error(`evidence baseline.${key} must be zero in a clean disposable workspace`);
    }
  }
  if (baseline.agentNameHashes.length !== 0 || baseline.fleetNodeNameHashes.length !== 0) {
    throw new Error('evidence baseline contains ambient Relay agent or Fleet node identities');
  }
  if (!Array.isArray(evidence.operations)) throw new Error('evidence.operations must be an array');
  const expectedIds = matrix.operations.map(({ id }) => id);
  const actualIds = evidence.operations.map(({ id }) => id);
  if (new Set(actualIds).size !== actualIds.length) throw new Error('evidence has duplicate operations');
  if (actualIds.length !== expectedIds.length || actualIds.some((id) => !expectedIds.includes(id))) {
    throw new Error('evidence operation set does not exactly match the matrix');
  }
  for (const id of expectedIds) {
    if (!actualIds.includes(id)) throw new Error(`evidence is missing operation ${id}`);
  }
  for (const operation of evidence.operations) {
    assertSafeId(operation.id, 'operation.id');
    if (!OPERATION_STATUSES.has(operation.status)) {
      throw new Error(`operation ${operation.id} has invalid status`);
    }
    const definition = matrix.operations.find(({ id }) => id === operation.id);
    if (!definition || operation.group !== definition.group || operation.expect !== definition.expect) {
      throw new Error(`operation ${operation.id} does not match its matrix definition`);
    }
    const acceptanceProfile = matrix.acceptance.operationProfiles[operation.id];
    if (operation.acceptanceProfile !== acceptanceProfile) {
      throw new Error(`operation ${operation.id} is not bound to acceptance profile ${acceptanceProfile}`);
    }
    if (operation.status !== operationStatus(definition, operation)) {
      throw new Error(`operation ${operation.id} status is inconsistent with its evidence`);
    }
    validateOperationArgvContract(operation, definition, matrix);
    const argvText = operation.argv.join(' ');
    if (/--(?:api-key|join-ticket|token|wk|workspace-key)(?:=|\s+)(?!\[REDACTED\])\S+/i.test(argvText)) {
      throw new Error(`operation ${operation.id} contains an unredacted credential argument`);
    }
    for (const key of ['monotonicStartNs', 'monotonicEndNs']) {
      if (typeof operation[key] !== 'string' || !/^\d+$/.test(operation[key])) {
        throw new Error(`operation ${operation.id}.${key} is invalid`);
      }
    }
    if (BigInt(operation.monotonicEndNs) < BigInt(operation.monotonicStartNs)) {
      throw new Error(`operation ${operation.id} has non-monotonic timing`);
    }
    if (typeof operation.durationMs !== 'number' || operation.durationMs < 0) {
      throw new Error(`operation ${operation.id}.durationMs is invalid`);
    }
    const monotonicDurationMs =
      Number(BigInt(operation.monotonicEndNs) - BigInt(operation.monotonicStartNs)) / 1_000_000;
    if (Math.abs(monotonicDurationMs - operation.durationMs) > Math.max(1, monotonicDurationMs * 0.001)) {
      throw new Error(`operation ${operation.id}.durationMs does not match monotonic timing`);
    }
    if (
      (operation.stdout?.length ?? 0) > MAX_CAPTURE_BYTES ||
      (operation.stderr?.length ?? 0) > MAX_CAPTURE_BYTES
    ) {
      throw new Error(`operation ${operation.id} output exceeds the evidence bound`);
    }
    if (operation.stdoutTruncated === true || operation.stderrTruncated === true) {
      throw new Error(`operation ${operation.id} has truncated command output`);
    }
    for (const key of ['stdoutTruncated', 'stderrTruncated']) {
      if (typeof operation[key] !== 'boolean') {
        throw new Error(`operation ${operation.id}.${key} is missing`);
      }
    }
    for (const key of ['stdoutBytes', 'stderrBytes']) {
      if (!Number.isInteger(operation[key]) || operation[key] < 0) {
        throw new Error(`operation ${operation.id}.${key} is invalid`);
      }
    }
    const serialized = JSON.stringify(operation);
    if (/\b(?:at|nt|rk|wk)_[A-Za-z0-9._~+/=-]{8,}\b/.test(serialized)) {
      throw new Error(`operation ${operation.id} contains an unredacted token`);
    }
    if (operation.id.startsWith('initial-task-sentinel-')) {
      if (
        operation.derivedObservation !== true ||
        operation.executionKind !== 'derived-observation' ||
        typeof operation.derivedFrom !== 'string' ||
        !operation.derivedFrom.startsWith('provision-node-')
      ) {
        throw new Error(
          `operation ${operation.id} must be marked as a derived observation, not a command execution`
        );
      }
    }

    if (operation.id === 'fleet-spawn-reject-droid' && operation.status === 'pass') {
      const targetName = `fleet-spawn-provider-droid-${evidence.nonce.slice(0, 16)}`;
      if (!noPartialCreationProofPass(operation.partialCreationProof, targetName)) {
        throw new Error(
          'fleet-spawn-reject-droid did not prove no agent, worker process, Cloud record, or Daytona sandbox was created'
        );
      }
    }
    if (
      (operation.group === 'fleet-provider' ||
        operation.group === 'fleet-spawn' ||
        operation.group === 'fleet-sandbox' ||
        operation.group === 'node-agent-provider' ||
        operation.group === 'node-agent-spawn') &&
      (operation.group !== 'node-agent-spawn' || operation.expect !== 'sentinel-and-exit') &&
      operation.id !== 'fleet-spawn-reject-droid'
    ) {
      const expectedProvider =
        operation.id.match(
          /^(?:fleet-spawn-provider|node-agent-spawn-provider)-(claude|codex|gemini|aider|goose|grok|opencode|droid|cursor|pi|deepagents)(?:-native)?$/
        )?.[1] ?? 'codex';
      const expectedRuntime =
        (operation.group === 'node-agent-provider' || operation.group === 'node-agent-spawn') &&
        operation.id.endsWith('-native')
          ? 'native'
          : 'pty';
      if (
        operation.status === 'pass' &&
        (operation.observedIdentitySource !== 'node-agent-list' ||
          operation.observedAgentName !== `${operation.id}-${evidence.nonce.slice(0, 16)}` ||
          operation.observedProvider !== expectedProvider ||
          operation.observedRuntime !== expectedRuntime)
      ) {
        throw new Error(
          `operation ${operation.id} did not prove the actual spawned agent provider/runtime identity`
        );
      }
    }
  }

  if (!Array.isArray(evidence.resources)) throw new Error('evidence.resources must be an array');
  if (!Array.isArray(evidence.ownershipIntents))
    throw new Error('evidence.ownershipIntents must be an array');
  validateRecoveryEvidence(evidence, matrix, evidence.nonce);
  const intentKeys = new Set(evidence.ownershipIntents.map((intent) => `${intent.type}:${intent.name}`));
  const sandboxResources = evidence.resources.filter(({ type }) => type === 'daytona-sandbox');
  const boardNodes = sandboxResources.filter(({ role }) => role === 'board-node');
  const topologySucceeded = ['provision-node-a', 'provision-node-b'].every(
    (id) => evidence.operations.find((operation) => operation.id === id)?.status === 'pass'
  );
  if (topologySucceeded && boardNodes.length < matrix.minimumBoardNodes) {
    throw new Error(
      `successful topology evidence requires at least ${matrix.minimumBoardNodes} board sandboxes`
    );
  }
  if (new Set(boardNodes.map(({ id }) => id)).size !== boardNodes.length) {
    throw new Error('board sandbox ids are not unique');
  }
  if (
    topologySucceeded &&
    (boardNodes.some(({ nodeId }) => typeof nodeId !== 'string' || !nodeId) ||
      new Set(boardNodes.map(({ nodeId }) => nodeId)).size !== boardNodes.length)
  ) {
    throw new Error('board node ids are not unique');
  }
  for (const resource of sandboxResources) {
    if (!UUID.test(resource.id)) throw new Error(`invalid Daytona sandbox id: ${resource.id}`);
    if (resource.provider !== 'daytona') throw new Error(`sandbox ${resource.id} is not Daytona`);
    if (!['created-by-run', 'reconciled-absent-baseline'].includes(resource.ownership)) {
      throw new Error(`sandbox ${resource.id} has no safe ownership proof`);
    }
    if (baseline.sandboxIdHashes.includes(sha256(resource.id))) {
      throw new Error(`sandbox ${resource.id} existed at baseline`);
    }
    if (!intentKeys.has(`daytona-sandbox:${resource.nodeName}`)) {
      throw new Error(`sandbox ${resource.id} has no ownership intent`);
    }
    if (evidence.cleanup?.status === 'pass' && !['deleted', 'absent'].includes(resource.cleanupState)) {
      throw new Error(`sandbox ${resource.id} was not cleaned up`);
    }
    if (environment.releaseQualificationRequested === true) {
      if (!RELAY_WORKSPACE_ID.test(environment.expectedRelayWorkspaceId ?? '')) {
        throw new Error('release qualification has no expected Relay workspace id');
      }
      if (resource.relayWorkspaceId !== environment.expectedRelayWorkspaceId) {
        throw new Error(`sandbox ${resource.id} was provisioned for a different Relay workspace`);
      }
      if (resource.observedSnapshotId !== environment.expectedSnapshotId) {
        throw new Error(`sandbox ${resource.id} did not prove the requested immutable snapshot id`);
      }
      if (resource.snapshot !== environment.expectedSnapshotName) {
        throw new Error(`sandbox ${resource.id} did not report the expected snapshot name`);
      }
      if (resource.snapshotManifest?.sha256 !== environment.expectedSnapshotManifestSha256) {
        throw new Error(`sandbox ${resource.id} manifest digest does not match the release contract`);
      }
      if (resource.snapshotManifest?.snapshot?.name !== environment.expectedSnapshotName) {
        throw new Error(`sandbox ${resource.id} manifest names a different snapshot`);
      }
      if (resource.snapshotManifest?.snapshot?.mode !== 'candidate') {
        throw new Error(`sandbox ${resource.id} was not built as a non-promoting candidate`);
      }
      const promotion = resource.snapshotManifest?.promotion;
      if (
        !promotion ||
        promotion.ssmWrite !== false ||
        promotion.selectorWrite !== false ||
        promotion.deploy !== false
      ) {
        throw new Error(`sandbox ${resource.id} manifest permits promotion side effects`);
      }
      if (resource.snapshotManifest?.packages?.['@agent-relay/sdk'] !== environment.expectedRelayVersion) {
        throw new Error(`sandbox ${resource.id} manifest has the wrong Relay SDK version`);
      }
      validateSandboxRuntimeAttestation(resource.runtimeAttestation, {
        cliSha256: provenance.cliSha256,
        cliVersion: provenance.cliVersion,
        brokerSha256: provenance.candidateInstallBrokerSha256,
        brokerBytes: provenance.candidateInstallBrokerBytes,
        packageVersion: provenance.candidateInstallVersion,
        platform: provenance.candidateInstallPlatform,
        arch: provenance.candidateInstallArch,
      });
    }
  }
  for (const resource of evidence.resources.filter(({ type }) => type === 'relay-agent')) {
    if (
      !OWNED_AGENT_STATES.has(resource.ownership) ||
      baseline.agentNameHashes.includes(sha256(resource.id))
    ) {
      throw new Error(`Relay agent ${resource.id} has no safe ownership proof`);
    }
    if (!intentKeys.has(`relay-agent:${resource.id}`)) {
      throw new Error(`Relay agent ${resource.id} has no ownership intent`);
    }
    if (evidence.cleanup?.status === 'pass' && resource.cleanupState !== 'absent') {
      throw new Error(`Relay agent ${resource.id} was not cleaned up`);
    }
    if (resource.sandboxId !== undefined) {
      const sandbox = sandboxResources.find(({ id }) => id === resource.sandboxId);
      if (
        !sandbox ||
        resource.sandboxNodeId !== sandbox.nodeId ||
        resource.sandboxNodeName !== sandbox.nodeName ||
        resource.cloudWorkspaceId !== sandbox.cloudWorkspaceId ||
        resource.ownership !== 'created-by-run'
      ) {
        throw new Error(`Relay agent ${resource.id} is not bound to the exact owned sandbox identity`);
      }
    }
  }
  const sandboxRelease = evidence.operations.find(({ id }) => id === 'fleet-release-reclaims-owned-sandbox');
  if (sandboxRelease?.status === 'pass') {
    const proof = sandboxRelease.sandboxReleaseProof;
    const sandbox = sandboxResources.find(({ id }) => id === proof?.sandboxId);
    const worker = evidence.resources.find(
      ({ type, id }) => type === 'relay-agent' && id === proof?.workerName
    );
    const intent = evidence.ownershipIntents.find(
      ({ type, name }) => type === 'daytona-sandbox' && name === proof?.sandboxName
    );
    if (
      !proof ||
      !sandbox ||
      !worker ||
      !intent ||
      proof.sandboxName !== sandbox.nodeName ||
      proof.cloudWorkspaceId !== sandbox.cloudWorkspaceId ||
      proof.relayWorkspaceId !== sandbox.relayWorkspaceId ||
      proof.nodeId !== sandbox.nodeId ||
      proof.workerName !== `${'fleet-spawn-sandbox-scoped-mount'}-${evidence.nonce.slice(0, 16)}` ||
      worker.sandboxId !== sandbox.id ||
      worker.sandboxNodeId !== sandbox.nodeId ||
      intent.nonce !== evidence.nonce ||
      proof.ownership !== 'created-by-run' ||
      proof.ownershipNonce !== evidence.nonce ||
      proof.workerProcessAbsent !== true ||
      proof.workerIdentityAbsent !== true ||
      proof.sandboxAbsent !== true
    ) {
      throw new Error(
        'fleet release sandbox evidence is not bound to the exact owned sandbox, worker, and absence checks'
      );
    }
  }
  if (!['pass', 'fail'].includes(evidence.cleanup?.status)) {
    throw new Error('evidence cleanup status is invalid');
  }
  const mutationOperations = evidence.operations.filter(({ id }) =>
    ['fleet-enable', 'fleet-disable', 'fleet-inherit'].includes(id)
  );
  if (mutationOperations.some(({ status }) => status !== 'safety-skipped')) {
    if (
      environment.policyMutationAuthorized !== true ||
      environment.policyMutationPerformed !== true ||
      !environment.expectedWorkspaceId ||
      provenance.resolvedWorkspaceId !== environment.expectedWorkspaceId
    ) {
      throw new Error('workspace policy mutation was not bound to the explicitly expected workspace');
    }
    if (environment.policyRestoration?.status !== 'pass') {
      throw new Error('workspace policy mutation was not restored to its exact initial override');
    }
  }
  validateCriticalLifecycleEvidence(evidence.criticalLifecycle, matrix, boardNodes, evidence.nonce);
  const derived = deriveFleetVerdict(evidence.operations, evidence.cleanup, evidence.criticalLifecycle);
  if (evidence.verdict !== derived) throw new Error(`evidence verdict must be ${derived}`);
  return evidence;
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}

export function summarizeFleetCampaign(attempts, matrix) {
  if (!Array.isArray(attempts) || attempts.length < 2) {
    throw new Error('a Fleet reliability campaign requires at least two attempts');
  }
  const seenNonces = new Set();
  const seenSandboxIds = new Set();
  const seenWorkspaceIds = new Set();
  let referenceProvenance;
  const controlledKeys = [
    'sourceCommit',
    'sourceDirty',
    'cliSha256',
    'runnerSha256',
    'matrixSha256',
    'cliVersion',
    'daytonaVersion',
    'requestedSnapshotId',
    'requestedSnapshotName',
    'requestedSnapshotManifestSha256',
    'expectedRelayVersion',
    'candidateCleanInstall',
    'candidateInstallAttestationSha256',
    'candidateInstallSourceSha',
    'candidateInstallVersion',
    'candidateInstallPlatform',
    'candidateInstallArch',
    'candidateInstallBrokerSha256',
    'candidateInstallBrokerBytes',
  ];
  for (const attempt of attempts) {
    assertSafeId(attempt.nonce, 'campaign attempt nonce');
    if (seenNonces.has(attempt.nonce)) throw new Error(`duplicate campaign nonce: ${attempt.nonce}`);
    seenNonces.add(attempt.nonce);
    validateFleetEvidence(attempt.evidence, matrix);
    const provenance = attempt.evidence.provenance;
    if (provenance.sourceDirty !== false) {
      throw new Error(`campaign attempt ${attempt.nonce} did not use a clean source tree`);
    }
    if (
      typeof provenance.resolvedWorkspaceId !== 'string' ||
      !provenance.resolvedWorkspaceId ||
      attempt.evidence.environment?.expectedWorkspaceId !== provenance.resolvedWorkspaceId ||
      attempt.evidence.environment?.controlPlaneClean !== true
    ) {
      throw new Error(`campaign attempt ${attempt.nonce} has no exact clean workspace identity`);
    }
    if (seenWorkspaceIds.has(provenance.resolvedWorkspaceId)) {
      throw new Error(`Relay workspace ${provenance.resolvedWorkspaceId} was reused across attempts`);
    }
    seenWorkspaceIds.add(provenance.resolvedWorkspaceId);
    if (!referenceProvenance) referenceProvenance = provenance;
    else {
      for (const key of controlledKeys) {
        if (provenance[key] !== referenceProvenance[key]) {
          throw new Error(`campaign attempts used different ${key}`);
        }
      }
    }
    for (const { id } of attempt.evidence.resources.filter(({ type }) => type === 'daytona-sandbox')) {
      if (seenSandboxIds.has(id)) throw new Error(`Daytona sandbox ${id} was reused across attempts`);
      seenSandboxIds.add(id);
    }
  }
  const operations = matrix.operations.map(({ id, group }) => {
    const records = attempts.map(({ nonce, evidence }) => {
      const operation = evidence.operations.find((candidate) => candidate.id === id);
      return {
        nonce,
        status: operation.status,
        durationMs: operation.durationMs,
        executionKind: operation.executionKind ?? 'command',
        derivedObservation: operation.derivedObservation === true,
      };
    });
    const statuses = [...new Set(records.map(({ status }) => status))];
    const classification =
      statuses.length === 1 && statuses[0] === 'pass'
        ? 'stable-pass'
        : statuses.length === 1 && statuses[0] === 'fail'
          ? 'stable-fail'
          : statuses.length === 1 && statuses[0] === 'blocked'
            ? 'blocked'
            : statuses.length === 1 && statuses[0] === 'safety-skipped'
              ? 'safety-skipped'
              : statuses.every((status) => status === 'pass' || status === 'fail')
                ? 'flaky'
                : 'inconclusive';
    const durations = records.map(({ durationMs }) => durationMs);
    return {
      id,
      group,
      classification,
      statuses,
      attempts: records,
      timingMs: {
        min: Math.min(...durations),
        p50: percentile(durations, 0.5),
        p95: percentile(durations, 0.95),
        max: Math.max(...durations),
      },
    };
  });
  const derivedObservationIds = new Set(
    operations
      .filter(({ attempts: records }) => records.every(({ derivedObservation }) => derivedObservation))
      .map(({ id }) => id)
  );
  const derivedObservations = operations.filter(({ id }) => derivedObservationIds.has(id));
  const commandExecutions = operations.filter(({ id }) => !derivedObservationIds.has(id));
  const hasProductFailure =
    attempts.some(({ evidence }) => evidence.criticalLifecycle?.status === 'fail') ||
    operations.some(
      ({ classification, group }) => group !== 'cleanup' && ['stable-fail', 'flaky'].includes(classification)
    );
  const hasIncomplete =
    attempts.some(({ evidence }) => evidence.criticalLifecycle?.status !== 'pass') ||
    operations.some(({ classification }) =>
      ['blocked', 'safety-skipped', 'inconclusive'].includes(classification)
    );
  const cleanupStatus = attempts.every(({ evidence }) => evidence.cleanup.status === 'pass')
    ? 'pass'
    : 'fail';
  return {
    version: CONTRACT_VERSION,
    kind: 'fleet-daytona-reliability-campaign',
    product: 'relay',
    provider: 'daytona',
    attemptCount: attempts.length,
    controlledProvenance: Object.fromEntries(
      controlledKeys.map((key) => [key, referenceProvenance?.[key] ?? null])
    ),
    workspaceIds: attempts.map(({ evidence }) => evidence.provenance.resolvedWorkspaceId),
    attempts: attempts.map(({ nonce, evidence, evidenceSha256 }) => ({
      nonce,
      verdict: evidence.verdict,
      cleanupStatus: evidence.cleanup.status,
      evidenceSha256,
      runnerSha256: evidence.provenance.runnerSha256,
      sandboxIds: evidence.resources.filter(({ type }) => type === 'daytona-sandbox').map(({ id }) => id),
    })),
    criticalLifecycle: {
      requiredTrialsPerAttempt: matrix.minimumCriticalLifecycleTrials,
      attempts: attempts.map(({ nonce, evidence }) => ({
        nonce,
        status: evidence.criticalLifecycle.status,
        trialCount: evidence.criticalLifecycle.trials.length,
        passCount: evidence.criticalLifecycle.trials.filter(({ status }) => status === 'pass').length,
        failCount: evidence.criticalLifecycle.trials.filter(({ status }) => status === 'fail').length,
        nodeNames: [...new Set(evidence.criticalLifecycle.trials.map(({ nodeName }) => nodeName))],
        totalDurationMs: evidence.criticalLifecycle.trials.reduce(
          (total, { durationMs }) => total + durationMs,
          0
        ),
      })),
    },
    operations,
    operationTotals: {
      matrixOperationCount: operations.length,
      independentCommandExecutionCount: commandExecutions.length,
      derivedObservationCount: derivedObservations.length,
      derivedObservationIds: [...derivedObservationIds].filter((id) =>
        operations.some((operation) => operation.id === id)
      ),
    },
    cleanupStatus,
    productVerdict: hasProductFailure ? 'RED' : hasIncomplete ? 'YELLOW' : 'GREEN',
    infrastructureStatus: cleanupStatus === 'pass' ? 'PASS' : 'FAIL',
    verdict: hasProductFailure
      ? 'RED'
      : cleanupStatus !== 'pass'
        ? 'INFRA_BLOCKED'
        : hasIncomplete
          ? 'YELLOW'
          : 'GREEN',
    createdAt: new Date().toISOString(),
  };
}

class FleetBoard {
  constructor(matrix, nonce, artifactDir) {
    this.matrix = matrix;
    this.nonce = nonce;
    this.short = nonce.slice(0, 16);
    this.artifactDir = artifactDir;
    this.cli = process.env.VERIFY_FLEET_CLI ? path.resolve(process.env.VERIFY_FLEET_CLI) : DEFAULT_CLI;
    this.operationsById = new Map(matrix.operations.map((operation) => [operation.id, operation]));
    this.evidence = {
      version: CONTRACT_VERSION,
      kind: 'fleet-daytona-board',
      nonce,
      product: 'relay',
      provider: 'daytona',
      sourceCommit: process.env.GITHUB_SHA ?? null,
      startedAt: new Date().toISOString(),
      cliEntrypoint: this.cli,
      operations: [],
      criticalLifecycle: { status: 'pending', trials: [] },
      resources: [],
      ownershipIntents: [],
      environment: {
        policyMutationRequested: process.env.VERIFY_FLEET_DISPOSABLE_WORKSPACE === '1',
        expectedWorkspaceId: process.env.VERIFY_FLEET_EXPECTED_WORKSPACE_ID?.trim() || null,
        expectedRelayWorkspaceId: process.env.VERIFY_FLEET_EXPECTED_RELAY_WORKSPACE_ID?.trim() || null,
        policyMutationAuthorized: false,
        policyMutationPerformed: false,
        controlPlaneClean: false,
        releaseQualificationRequested: process.env.VERIFY_FLEET_RELEASE_QUALIFICATION === '1',
        expectedSnapshotId: process.env.VERIFY_FLEET_SNAPSHOT_ID?.trim() || null,
        expectedSnapshotName: process.env.VERIFY_FLEET_SNAPSHOT_NAME?.trim() || null,
        expectedSnapshotManifestSha256: process.env.VERIFY_FLEET_SNAPSHOT_MANIFEST_SHA256?.trim() || null,
        expectedRelayVersion:
          process.env.VERIFY_FLEET_EXPECTED_RELAY_VERSION?.trim() ||
          (process.env.VERIFY_FLEET_RELEASE_QUALIFICATION === '1'
            ? null
            : matrix.requiredSnapshotRelayVersion),
      },
      cleanup: { status: 'pending', attempts: [] },
      verdict: 'INFRA_BLOCKED',
    };
    this.nodeA = null;
    this.nodeB = null;
    this.controller = null;
    this.agentNames = new Set();
    this.baseline = null;
    this.baselineSandboxIds = new Set();
    this.baselineSandboxNames = new Set();
    this.baselineAgentNames = new Set();
    this.steerReceipts = [];
    this.taintedNodeIds = new Set();
    if (this.evidence.environment.releaseQualificationRequested) {
      if (!SAFE_SNAPSHOT_ID.test(this.evidence.environment.expectedSnapshotId ?? '')) {
        throw new Error('VERIFY_FLEET_SNAPSHOT_ID is required and must be a safe immutable provider id');
      }
      if (!SAFE_SNAPSHOT.test(this.evidence.environment.expectedSnapshotName ?? '')) {
        throw new Error('VERIFY_FLEET_SNAPSHOT_NAME is required and must be a safe snapshot name');
      }
      if (!SHA256.test(this.evidence.environment.expectedSnapshotManifestSha256 ?? '')) {
        throw new Error('VERIFY_FLEET_SNAPSHOT_MANIFEST_SHA256 must be 64 lowercase hex characters');
      }
      if (!this.evidence.environment.expectedRelayVersion) {
        throw new Error('VERIFY_FLEET_EXPECTED_RELAY_VERSION is required');
      }
    }
  }

  async checkpoint() {
    const sanitized = redactFleetEvidence(JSON.stringify(this.evidence, null, 2));
    const target = path.join(this.artifactDir, 'evidence.json');
    await writePrivateAtomic(target, `${sanitized}\n`);
  }

  async creationIntent(type, name) {
    if (type === 'daytona-sandbox' && this.baselineSandboxNames.has(name)) {
      throw new Error(`Refusing to provision over baseline Daytona sandbox name ${name}`);
    }
    if (type === 'relay-agent' && this.baselineAgentNames.has(name)) {
      throw new Error(`Refusing to spawn over baseline Relay agent name ${name}`);
    }
    if (type === 'relay-agent' && (await this.exactAgentExists(name))) {
      throw new Error(`Refusing to spawn over existing Relay agent name ${name}`);
    }
    if (this.evidence.ownershipIntents.some((intent) => intent.type === type && intent.name === name)) return;
    this.evidence.ownershipIntents.push({
      type,
      name,
      nonce: this.nonce,
      assertedAbsentAtBaseline: true,
      checkpointedAt: new Date().toISOString(),
    });
    await this.checkpoint();
  }

  isOwnedAgent(name) {
    return this.evidence.resources.some(
      (entry) => entry.type === 'relay-agent' && entry.id === name && OWNED_AGENT_STATES.has(entry.ownership)
    );
  }

  claimAgent(name, role, ownership = 'created-by-run') {
    if (this.baselineAgentNames.has(name)) throw new Error(`Cannot claim baseline Relay agent ${name}`);
    this.agentNames.add(name);
    const resource = this.resource('relay-agent', name, { role, ownership });
    resource.cleanupState = 'owned';
    return resource;
  }

  async reconcileFailedSpawnIdentity(name, role) {
    const exists = await this.exactAgentExists(name).catch(() => null);
    if (exists === true) this.claimAgent(name, role);
    if (exists === null) this.claimAgent(name, role, 'ambiguous-after-checkpointed-absence');
    return exists;
  }

  async captureProvenance() {
    const [head, status, version, daytonaVersion, workspace] = await Promise.all([
      execute(['git', 'rev-parse', 'HEAD'], { timeoutMs: 15_000 }),
      execute(['git', 'status', '--porcelain'], { timeoutMs: 30_000, maxCaptureBytes: 4 * 1024 * 1024 }),
      execute(this.cliArgv('version'), { timeoutMs: 30_000 }),
      execute(this.daytonaArgv('version'), { timeoutMs: 30_000 }),
      execute(this.cliArgv('workspace', 'active', '--json'), {
        timeoutMs: 30_000,
        maxCaptureBytes: 1024 * 1024,
      }),
    ]);
    if (head.exitCode !== 0 || version.exitCode !== 0 || daytonaVersion.exitCode !== 0) {
      throw new Error('Could not bind the board to source, Relay CLI, and Daytona versions');
    }
    const [cliBytes, runnerBytes] = await Promise.all([
      readRegularFileNoFollow(this.cli, { label: 'Fleet candidate CLI entrypoint' }).then(
        (result) => result.bytes
      ),
      readRegularFileNoFollow(fileURLToPath(import.meta.url), {
        label: 'Fleet qualification runner',
      }).then((result) => result.bytes),
    ]);
    const cliSha256 = createHash('sha256').update(cliBytes).digest('hex');
    const candidateAttestationPath = process.env.VERIFY_FLEET_CANDIDATE_ATTESTATION?.trim();
    if (this.evidence.environment.releaseQualificationRequested && !candidateAttestationPath) {
      throw new Error('VERIFY_FLEET_CANDIDATE_ATTESTATION is required for release qualification');
    }
    let candidateAttestation = null;
    let candidateInstallAttestationSha256 = null;
    if (candidateAttestationPath) {
      const { bytes } = await readRegularFileNoFollow(path.resolve(candidateAttestationPath), {
        label: 'Fleet candidate install attestation',
        privateMode: true,
        currentUserOwned: true,
      });
      candidateInstallAttestationSha256 = createHash('sha256').update(bytes).digest('hex');
      candidateAttestation = validateCandidateInstallAttestation(JSON.parse(bytes.toString('utf8')), {
        sourceSha: head._rawStdout.trim(),
        cliEntrypoint: this.cli,
        cliSha256,
      });
    }
    const workspacePayload = tryParseJson(workspace._rawStdout);
    const resolvedWorkspaceId = findStringDeep(workspacePayload, ['cloudWorkspaceId', 'workspaceId', 'id']);
    this.evidence.provenance = {
      sourceCommit: head._rawStdout.trim(),
      sourceDirty: status.exitCode === 0 ? status._rawStdout.trim().length > 0 : null,
      sourceStatusExitCode: status.exitCode,
      cliSha256,
      cliVersion: version.stdout.trim(),
      runnerSha256: createHash('sha256').update(runnerBytes).digest('hex'),
      matrixSha256: sha256(JSON.stringify(this.matrix)),
      inventorySha256: this.matrix.inventorySha256,
      daytonaVersion: daytonaVersion.stdout.trim(),
      workspaceActiveExitCode: workspace.exitCode,
      resolvedWorkspaceId: resolvedWorkspaceId ?? null,
      requestedSnapshotId: this.evidence.environment.expectedSnapshotId,
      requestedSnapshotName: this.evidence.environment.expectedSnapshotName,
      requestedSnapshotManifestSha256: this.evidence.environment.expectedSnapshotManifestSha256,
      expectedRelayVersion: this.evidence.environment.expectedRelayVersion,
      candidateCleanInstall: candidateAttestation !== null,
      candidateInstallAttestationSha256,
      candidateInstallSourceSha: candidateAttestation?.sourceSha ?? null,
      candidateInstallVersion: candidateAttestation?.packageVersion ?? null,
      candidateInstallPlatform: candidateAttestation?.platform ?? null,
      candidateInstallArch: candidateAttestation?.arch ?? null,
      candidateInstallBrokerSha256: candidateAttestation?.brokerSha256 ?? null,
      candidateInstallBrokerBytes: candidateAttestation?.brokerBytes ?? null,
      capturedAt: new Date().toISOString(),
    };
    this.evidence.sourceCommit = this.evidence.provenance.sourceCommit;
    await this.checkpoint();
  }

  cliArgv(...args) {
    return [process.execPath, this.cli, ...args];
  }

  daytonaArgv(...args) {
    return ['daytona', ...args];
  }

  inside(sandboxId, ...args) {
    return this.daytonaArgv('sandbox', 'exec', sandboxId, '--timeout', '180', '--', 'agent-relay', ...args);
  }

  async inspectSandboxFile(sandboxId, remotePath) {
    const result = await execute(
      this.daytonaArgv(
        'sandbox',
        'exec',
        sandboxId,
        '--timeout',
        '30',
        '--',
        'node',
        '-e',
        "const f=require('node:fs'),c=require('node:crypto'),p=process.argv[1];try{const b=f.readFileSync(p);process.stdout.write(JSON.stringify({exists:true,bytes:b.length,sha256:c.createHash('sha256').update(b).digest('hex')}))}catch(e){if(e&&e.code==='ENOENT')process.stdout.write(JSON.stringify({exists:false}));else throw e}",
        remotePath
      ),
      { timeoutMs: 45_000 }
    );
    return {
      exitCode: result.exitCode,
      payload: result.exitCode === 0 ? tryParseJson(result._rawStdout) : undefined,
    };
  }

  operationDefinition(id) {
    const definition = this.operationsById.get(id);
    if (!definition) throw new Error(`unknown operation ${id}`);
    return definition;
  }

  async record(id, work) {
    if (this.evidence.operations.some((operation) => operation.id === id)) {
      throw new Error(`operation ${id} already recorded`);
    }
    const definition = this.operationDefinition(id);
    const startedAt = new Date().toISOString();
    const monotonicStartNs = process.hrtime.bigint();
    let result;
    try {
      result = await work();
    } catch (error) {
      result = {
        argv: [],
        exitCode: null,
        timedOut: false,
        stderr: redactFleetEvidence(error instanceof Error ? error.stack : String(error)),
        stdout: '',
      };
    }
    const monotonicEndNs = process.hrtime.bigint();
    const operation = {
      id,
      group: definition.group,
      expect: definition.expect,
      acceptanceProfile: this.matrix.acceptance.operationProfiles[id],
      status: operationStatus(definition, result),
      startedAt: result.startedAt ?? startedAt,
      finishedAt: result.finishedAt ?? new Date().toISOString(),
      monotonicStartNs: result.monotonicStartNs ?? monotonicStartNs.toString(),
      monotonicEndNs: result.monotonicEndNs ?? monotonicEndNs.toString(),
      durationMs: result.durationMs ?? Number(monotonicEndNs - monotonicStartNs) / 1_000_000,
      argv: result.argv ?? [],
      exitCode: result.exitCode ?? null,
      timedOut: result.timedOut === true,
      stdoutBytes: Number.isInteger(result.stdoutBytes)
        ? result.stdoutBytes
        : Buffer.byteLength(result.stdout ?? ''),
      stderrBytes: Number.isInteger(result.stderrBytes)
        ? result.stderrBytes
        : Buffer.byteLength(result.stderr ?? ''),
      stdoutTruncated: result.stdoutTruncated === true,
      stderrTruncated: result.stderrTruncated === true,
      executionKind: result.derivedObservation === true ? 'derived-observation' : 'command',
      ...(result.derivedObservation === true ? { derivedObservation: true } : {}),
      ...(result.derivedFrom ? { derivedFrom: result.derivedFrom } : {}),
      ...(result.signal ? { signal: result.signal } : {}),
      ...(result.stdout ? { stdout: redactFleetEvidence(result.stdout) } : {}),
      ...(result.stderr ? { stderr: redactFleetEvidence(result.stderr) } : {}),
      ...(result.summary ? { summary: redactFleetEvidence(result.summary) } : {}),
      ...(result.observedSentinel !== undefined
        ? { observedSentinel: result.observedSentinel === true }
        : {}),
      ...(result.observedExit !== undefined ? { observedExit: result.observedExit === true } : {}),
      ...(result.observedStream !== undefined ? { observedStream: result.observedStream === true } : {}),
      ...(result.observedAgentName !== undefined ? { observedAgentName: result.observedAgentName } : {}),
      ...(result.observedProvider !== undefined ? { observedProvider: result.observedProvider } : {}),
      ...(result.observedRuntime !== undefined ? { observedRuntime: result.observedRuntime } : {}),
      ...(result.observedModel !== undefined ? { observedModel: result.observedModel } : {}),
      ...(result.observedIdentitySource !== undefined
        ? { observedIdentitySource: result.observedIdentitySource }
        : {}),
      ...(result.partialCreationProof !== undefined
        ? { partialCreationProof: result.partialCreationProof }
        : {}),
      ...(result.sandboxReleaseProof !== undefined
        ? { sandboxReleaseProof: result.sandboxReleaseProof }
        : {}),
      ...(result.blockedReason ? { blockedReason: redactFleetEvidence(result.blockedReason) } : {}),
      ...(result.safetyReason ? { safetyReason: redactFleetEvidence(result.safetyReason) } : {}),
    };
    this.evidence.operations.push(operation);
    await this.checkpoint();
    process.stdout.write(
      `FLEET_BOARD_OPERATION id=${id} status=${operation.status} ms=${Math.round(operation.durationMs)}\n`
    );
    return operation;
  }

  async command(id, argv, options = {}) {
    return this.record(id, async () => stripPrivateExecution(await execute(argv, options)));
  }

  async assertedCommand(id, argv, assertion, options = {}) {
    return this.record(id, async () => {
      const result = await execute(argv, options);
      let assertionResult = { pass: false, summary: 'assertion did not run' };
      if (result.exitCode === 0) {
        try {
          assertionResult = await assertion(result);
        } catch (error) {
          assertionResult = {
            pass: false,
            summary: error instanceof Error ? error.message : String(error),
          };
        }
      }
      return {
        ...stripPrivateExecution(result),
        exitCode: result.exitCode === 0 && assertionResult.pass ? 0 : 1,
        summary: assertionResult.summary,
      };
    });
  }

  async derived(id, input) {
    return this.record(id, async () => ({
      argv: input.argv ?? [],
      exitCode: input.exitCode ?? 0,
      timedOut: false,
      stdout: input.stdout ?? '',
      stderr: input.stderr ?? '',
      summary: input.summary,
      observedSentinel: input.observedSentinel,
      observedExit: input.observedExit,
      observedStream: input.observedStream,
      blockedReason: input.blockedReason,
      safetyReason: input.safetyReason,
      derivedObservation: true,
      derivedFrom: input.derivedFrom,
    }));
  }

  resource(type, id, fields = {}) {
    let resource = this.evidence.resources.find((entry) => entry.type === type && entry.id === id);
    if (!resource) {
      resource = { type, id, cleanupState: 'owned', ...fields };
      this.evidence.resources.push(resource);
    } else Object.assign(resource, fields);
    return resource;
  }

  async listDaytona() {
    const items = [];
    let cursor;
    for (let page = 0; page < 100; page += 1) {
      const argv = this.daytonaArgv('sandbox', 'list', '--format', 'json', '--limit', '100');
      if (cursor) argv.push('--cursor', cursor);
      const result = await execute(argv, { timeoutMs: 30_000, maxCaptureBytes: 4 * 1024 * 1024 });
      if (result.exitCode !== 0) throw new Error(result._rawStderr || 'daytona sandbox list failed');
      if (result.stdoutCaptureTruncated) {
        throw new Error('Daytona list JSON exceeded the capture bound');
      }
      const payload = tryParseJson(result._rawStdout);
      if (!payload || !Array.isArray(payload.items)) throw new Error('Daytona list returned invalid JSON');
      items.push(...payload.items);
      cursor = typeof payload.nextCursor === 'string' && payload.nextCursor ? payload.nextCursor : undefined;
      if (!cursor) return items;
    }
    throw new Error('Daytona pagination exceeded 100 pages');
  }

  async listWorkspaceAgentNames(status) {
    const args = ['agent', 'list'];
    if (status) args.push('--status', status);
    const result = await execute(this.cliArgv(...args), {
      timeoutMs: 60_000,
      maxCaptureBytes: 16 * 1024 * 1024,
    });
    if (result.exitCode !== 0) throw new Error(result._rawStderr || 'agent list failed');
    if (result.stdoutCaptureTruncated) throw new Error('agent list JSON exceeded the capture bound');
    const payload = tryParseJson(result._rawStdout);
    if (!Array.isArray(payload)) throw new Error('agent list returned invalid JSON');
    const names = new Set();
    const visit = (value) => {
      if (!value || typeof value !== 'object') return;
      if (typeof value.name === 'string' && value.name) names.add(value.name);
      for (const child of Array.isArray(value) ? value : Object.values(value)) visit(child);
    };
    visit(payload);
    return names;
  }

  async listAllWorkspaceAgentNames() {
    return this.listWorkspaceAgentNames();
  }

  async listOnlineWorkspaceAgentNames() {
    return this.listWorkspaceAgentNames('online');
  }

  async listAllFleetNodes() {
    const result = await execute(this.cliArgv('fleet', 'nodes', '--all'), {
      timeoutMs: 60_000,
      maxCaptureBytes: 16 * 1024 * 1024,
    });
    if (result.exitCode !== 0) throw new Error(result._rawStderr || 'fleet nodes --all failed');
    if (result.stdoutCaptureTruncated || result.stderrCaptureTruncated) {
      throw new Error('fleet nodes --all JSON exceeded the capture bound');
    }
    const payload = tryParseJson(result._rawStdout);
    if (!payload || !Array.isArray(payload.nodes)) {
      throw new Error('fleet nodes --all returned invalid JSON');
    }
    return payload.nodes;
  }

  async listNodeAgents(node) {
    if (!node?.id) throw new Error('node identity is required to inspect worker processes');
    const result = await execute(this.inside(node.id, 'node', 'agent', 'list'), {
      timeoutMs: 30_000,
      maxCaptureBytes: 4 * 1024 * 1024,
    });
    if (result.exitCode !== 0 || result.stdoutCaptureTruncated || result.stderrCaptureTruncated) {
      throw new Error(result._rawStderr || 'node agent list failed');
    }
    const payload = tryParseJson(result._rawStdout);
    const agents = Array.isArray(payload) ? payload : Array.isArray(payload?.agents) ? payload.agents : null;
    if (!agents) throw new Error('node agent list returned invalid JSON');
    return agents;
  }

  async waitForFleetAgentIdentity(node, name, expectedProvider, expectedRuntime = 'pty', expectedModel) {
    const deadline = Date.now() + 60_000;
    let last;
    while (Date.now() < deadline) {
      try {
        const agents = await this.listNodeAgents(node);
        const exact = agents.find((agent) => agent?.name === name);
        last = exact;
        const actualProvider = exact?.cli ?? exact?.provider;
        const pass =
          Boolean(exact) &&
          actualProvider === expectedProvider &&
          exact.runtime_kind === expectedRuntime &&
          (expectedModel === undefined || exact.model === expectedModel);
        if (pass) {
          return {
            pass: true,
            agent: exact,
            provider: actualProvider,
            runtime: exact.runtime_kind,
            model: exact.model,
          };
        }
      } catch {
        // Keep polling until the bounded identity deadline; an unreadable
        // inventory is not proof that the worker launched correctly.
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    return {
      pass: false,
      agent: last,
      provider: last?.cli ?? last?.provider,
      runtime: last?.runtime_kind,
      model: last?.model,
    };
  }

  async waitForSandboxAbsentId(sandboxId, timeoutMs = 45_000) {
    if (!UUID.test(sandboxId ?? '')) return false;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const present = (await this.listDaytona()).some(({ id }) => id === sandboxId);
      if (!present) return true;
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
    return false;
  }

  async captureNoPartialCreationProof(name) {
    const [agentNames, fleetNodes, sandboxes] = await Promise.all([
      this.listAllWorkspaceAgentNames(),
      this.listAllFleetNodes(),
      this.listDaytona(),
    ]);
    const workerProcesses = [];
    for (const node of this.availableBoardNodes()) {
      const agents = await this.listNodeAgents(node);
      workerProcesses.push({
        nodeId: node.nodeId,
        nodeName: node.nodeName,
        names: agents
          .map(({ name }) => name)
          .filter(Boolean)
          .sort(),
      });
    }
    return {
      targetName: name,
      agentNames: [...agentNames].sort(),
      fleetNodeKeys: fleetNodes.map(({ id, name }) => `${id ?? ''}:${name ?? ''}`).sort(),
      sandboxIds: sandboxes
        .map(({ id }) => id)
        .filter(Boolean)
        .sort(),
      sandboxKeys: sandboxes.map(({ id, name }) => `${id ?? ''}:${name ?? ''}`).sort(),
      workerProcesses,
    };
  }

  async exactAgentExists(name) {
    const result = await execute(this.cliArgv('agent', 'get', name), {
      timeoutMs: 20_000,
      maxCaptureBytes: 1024 * 1024,
    });
    if (result.stdoutCaptureTruncated || result.stderrCaptureTruncated) {
      throw new Error(`exact agent lookup for ${name} exceeded the capture bound`);
    }
    if (result.exitCode === 0) {
      const payload = tryParseJson(result._rawStdout);
      if (!payload || typeof payload !== 'object' || payload.name !== name) {
        throw new Error(`exact agent lookup for ${name} returned invalid JSON`);
      }
      return true;
    }
    if (result._rawStderr.includes(`Agent ${JSON.stringify(name)} was not found.`)) return false;
    throw new Error(result._rawStderr || `exact agent lookup for ${name} failed`);
  }

  async findExistingAgents(names) {
    const existing = [];
    const pending = [...new Set(names)];
    for (let offset = 0; offset < pending.length; offset += 8) {
      const chunk = pending.slice(offset, offset + 8);
      const results = await Promise.all(chunk.map(async (name) => [name, await this.exactAgentExists(name)]));
      for (const [name, exists] of results) if (exists) existing.push(name);
    }
    return existing;
  }

  async findSandboxByName(name) {
    return (await this.listDaytona()).find((sandbox) => sandbox.name === name);
  }

  addSandboxFromPayload(sandbox, role) {
    if (!sandbox || sandbox.outcome !== 'provisioned' || !UUID.test(sandbox.sandboxId ?? '')) return null;
    if (
      !this.evidence.ownershipIntents.some(
        (intent) => intent.type === 'daytona-sandbox' && intent.name === sandbox.nodeName
      )
    ) {
      throw new Error(`Cloud returned sandbox without a checkpointed ownership intent: ${sandbox.nodeName}`);
    }
    if (this.baselineSandboxIds.has(sandbox.sandboxId)) {
      throw new Error(`Cloud returned baseline Daytona sandbox ${sandbox.sandboxId}`);
    }
    const resource = this.resource('daytona-sandbox', sandbox.sandboxId, {
      role,
      provider: sandbox.providerId,
      nodeId: sandbox.nodeId,
      nodeName: sandbox.nodeName,
      cloudWorkspaceId: sandbox.cloudWorkspaceId,
      relayWorkspaceId: sandbox.relayWorkspaceId,
      relayfileMounted: sandbox.relayfileMounted,
      relayfileMountPath: sandbox.relayfileMountPath ?? null,
      observedSnapshotId: sandbox.snapshotId ?? null,
      ownership: 'created-by-run',
    });
    return resource;
  }

  async registerController() {
    const name = `relay-fleetboard-controller-${this.short}`;
    await this.creationIntent('relay-agent', name);
    const result = await execute(this.cliArgv('agent', 'register', name), { timeoutMs: 45_000 });
    const payload = tryParseJson(result._rawStdout);
    const token = payload && typeof payload.token === 'string' ? payload.token : undefined;
    if (result.exitCode !== 0 || !token) throw new Error('Failed to register fleet-board controller');
    this.controller = { name, token };
    this.claimAgent(name, 'controller');
    await this.checkpoint();
  }

  controllerEnv() {
    return this.controller ? { RELAY_AGENT_TOKEN: this.controller.token } : {};
  }

  availableBoardNodes() {
    return [this.nodeA, this.nodeB].filter(
      (node) => node?.id && node?.nodeName && !this.taintedNodeIds.has(node.id)
    );
  }

  async waitForSentinel(sentinel, timeoutMs = 90_000, from) {
    if (!this.controller) return { observed: false, detail: 'controller unavailable' };
    const deadline = Date.now() + timeoutMs;
    let last = '';
    while (Date.now() < deadline) {
      const args = ['message', 'search', sentinel, '--limit', '20'];
      if (from) args.push('--from', from);
      const result = await execute(this.cliArgv(...args), {
        timeoutMs: 20_000,
        env: this.controllerEnv(),
        extraSecrets: [this.controller.token],
      });
      last = `${result.stdout}\n${result.stderr}`.trim();
      if (
        result.exitCode === 0 &&
        result.stdoutCaptureTruncated !== true &&
        result.stderrCaptureTruncated !== true
      ) {
        const payload = tryParseJson(result._rawStdout);
        const exact = findExactSentinelMessage(payload, sentinel, from);
        if (exact) {
          return {
            observed: true,
            detail: last,
            argv: result.argv,
            messageIdHash: sha256(exact.id),
            agentName: exact.agentName,
            channelName: exact.channelName,
          };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    return { observed: false, detail: last || `No message matched ${sentinel}` };
  }

  async waitForFleetPlacement(name, expectedNode, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    let observedNode;
    let lastExitCode = null;
    let malformed = false;
    while (Date.now() < deadline) {
      const result = await execute(this.cliArgv('fleet', 'agent', 'list', '--all'), {
        timeoutMs: 30_000,
        maxCaptureBytes: 16 * 1024 * 1024,
      });
      lastExitCode = result.exitCode;
      if (result.stdoutCaptureTruncated || result.stderrCaptureTruncated) {
        malformed = true;
        break;
      }
      const payload = result.exitCode === 0 ? tryParseJson(result._rawStdout) : undefined;
      malformed = result.exitCode === 0 && (!payload || typeof payload !== 'object');
      observedNode = findFleetAgentNode(payload, name);
      if (observedNode && (expectedNode === undefined || observedNode === expectedNode)) {
        return { pass: true, observedNode, lastExitCode, malformed: false };
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    return {
      pass: false,
      observedNode,
      expectedNode,
      lastExitCode,
      malformed,
    };
  }

  async waitForAgentAbsent(name, timeoutMs = 45_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const exists = await this.exactAgentExists(name).catch(() => null);
      if (exists === false) return true;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    return false;
  }

  async waitForNodeAgentAbsent(node, name, timeoutMs = 45_000) {
    if (!node?.id) return false;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const agents = await this.listNodeAgents(node).catch(() => null);
      if (agents && !agents.some((agent) => agent?.name === name)) return true;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    return false;
  }

  async removeIdentity(name) {
    if (!this.isOwnedAgent(name)) return { exitCode: null, skipped: 'not-owned' };
    const result = await execute(
      this.cliArgv('agent', 'remove', name, '--reason', `fleet board ${this.short} exact cleanup`),
      { timeoutMs: 45_000 }
    );
    this.evidence.cleanup.attempts.push({
      type: 'agent-remove-support',
      target: name,
      exitCode: result.exitCode,
      stderr: result.stderr,
    });
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    return result;
  }

  async releaseSupport(name, node, source = 'fleet') {
    if (!this.isOwnedAgent(name)) {
      return node ? this.waitForNodeAgentAbsent(node, name, 15_000) : true;
    }
    const argv =
      source === 'node' && node?.id
        ? this.inside(node.id, 'node', 'agent', 'release', name)
        : this.cliArgv(
            'fleet',
            'release',
            name,
            '--reason',
            `fleet board ${this.short} capacity cleanup`,
            '--delete-agent'
          );
    const result = await execute(argv, { timeoutMs: 45_000 });
    this.evidence.cleanup.attempts.push({
      type: `${source}-release-support`,
      target: name,
      exitCode: result.exitCode,
      stderr: result.stderr,
    });
    const absent = node ? await this.waitForNodeAgentAbsent(node, name, 45_000) : true;
    await this.removeIdentity(name);
    const identityAbsent = await this.waitForAgentAbsent(name, 45_000);
    const resource = this.evidence.resources.find(
      (entry) => entry.type === 'relay-agent' && entry.id === name
    );
    if (resource && absent && identityAbsent) resource.cleanupState = 'absent';
    if (node?.id && (!absent || !identityAbsent)) this.taintedNodeIds.add(node.id);
    await this.checkpoint();
    return absent && identityAbsent;
  }

  async runFleetSpawn(id, options) {
    const requestedNode = [this.nodeA, this.nodeB].find(({ nodeName } = {}) => nodeName === options.node);
    if (requestedNode?.id && this.taintedNodeIds.has(requestedNode.id)) {
      const operation = await this.derived(id, {
        blockedReason: `owned node ${options.node} failed exact cleanup after a prior scenario`,
      });
      return { operation, rawResult: undefined, payload: undefined };
    }
    await this.creationIntent('relay-agent', options.agentName);
    if (options.sandboxName) await this.creationIntent('daytona-sandbox', options.sandboxName);
    const args = buildFleetSpawnArgs(options, this.evidence.environment);
    let rawResult;
    const operation = await this.record(id, async () => {
      rawResult = await execute(this.cliArgv(...args), { timeoutMs: options.timeoutMs ?? 150_000 });
      let agentOwnership = 'not-created';
      if (rawResult.exitCode === 0) {
        this.claimAgent(options.agentName, options.agentRole ?? 'worker');
        agentOwnership = 'created-by-successful-command';
      } else {
        const exists = await this.reconcileFailedSpawnIdentity(
          options.agentName,
          options.agentRole ?? 'worker'
        );
        if (exists === true) {
          agentOwnership = 'reconciled-absent-baseline';
        } else if (exists === null) {
          agentOwnership = 'ambiguous-after-checkpointed-absence';
        }
      }
      const payload = tryParseJson(rawResult._rawStdout);
      const sandbox = payload?.sandbox;
      const resource = this.addSandboxFromPayload(sandbox, options.sandboxRole ?? 'scenario');
      if (resource) {
        const workerResource = this.evidence.resources.find(
          (entry) => entry.type === 'relay-agent' && entry.id === options.agentName
        );
        if (workerResource) {
          Object.assign(workerResource, {
            sandboxId: resource.id,
            sandboxNodeId: resource.nodeId,
            sandboxNodeName: resource.nodeName,
            cloudWorkspaceId: resource.cloudWorkspaceId,
          });
        }
      }
      if (resource) await this.checkpoint();
      let sandboxContract = true;
      const sandboxChecks = [];
      if (options.sandbox) {
        const expectedMounted = options.noMount !== true;
        sandboxContract =
          sandbox?.outcome === 'provisioned' &&
          sandbox?.providerId === 'daytona' &&
          sandbox?.relayfileMounted === expectedMounted;
        sandboxChecks.push(
          `outcome=${sandbox?.outcome ?? 'missing'}`,
          `provider=${sandbox?.providerId ?? 'missing'}`,
          `relayfileMounted=${String(sandbox?.relayfileMounted)}`,
          `expectedMounted=${expectedMounted}`
        );
        if (sandboxContract && options.mountProof && resource?.id) {
          const mountRoot = sandbox.relayfileMountPath ?? '/home/daytona/workspace';
          const [scopeMarker, rootOnlyMarker] = await Promise.all([
            this.inspectSandboxFile(resource.id, path.posix.join(mountRoot, MOUNT_SCOPE_MARKER)),
            this.inspectSandboxFile(resource.id, path.posix.join(mountRoot, MOUNT_ROOT_ONLY_MARKER)),
          ]);
          const scopePass = matchesSandboxFileInspection(scopeMarker, options.mountProof.scope);
          const rootOnlyPass = matchesSandboxFileInspection(rootOnlyMarker, options.mountProof.rootOnly);
          sandboxContract = scopePass && rootOnlyPass;
          sandboxChecks.push(
            `scopeMarkerExpected=${options.mountProof.scope.exists}`,
            `scopeMarkerObserved=${scopeMarker.payload?.exists === true}`,
            `scopeMarkerSha256=${scopeMarker.payload?.sha256 ?? 'absent'}`,
            `scopeMarkerBytes=${scopeMarker.payload?.bytes ?? 0}`,
            `scopeMarkerPass=${scopePass}`,
            `rootOnlyMarkerExpected=${options.mountProof.rootOnly.exists}`,
            `rootOnlyMarkerObserved=${rootOnlyMarker.payload?.exists === true}`,
            `rootOnlyMarkerSha256=${rootOnlyMarker.payload?.sha256 ?? 'absent'}`,
            `rootOnlyMarkerBytes=${rootOnlyMarker.payload?.bytes ?? 0}`,
            `rootOnlyMarkerPass=${rootOnlyPass}`,
            `mountRoot=${mountRoot}`
          );
        }
      }
      const invocationInput = payload?.invocation?.input;
      const invocation = payload?.invocation;
      const inputChecks = [];
      const requireInput = (label, expected, ...keys) => {
        if (expected === undefined) return;
        const observed = keys.map((key) => invocationInput?.[key]).find((value) => value !== undefined);
        inputChecks.push({ label, expected, observed, pass: observed === expected });
      };
      requireInput('provider', options.provider, 'cli');
      requireInput('node', options.node, 'target_node', 'node');
      requireInput('model', options.model, 'model');
      requireInput('cwd', options.cwd, 'worker_cwd', 'cwd');
      requireInput('persona', options.persona, 'persona');
      requireInput('organization', options.organization, 'organization');
      requireInput('project', options.project, 'project');
      requireInput('workstream', options.workstream, 'workstream');
      requireInput('role', options.role, 'role');
      requireInput('objective', options.objective, 'objective');
      requireInput('sessionRef', options.sessionRef, 'session_ref', 'sessionRef');
      if (options.channel !== undefined) {
        const channels = Array.isArray(invocationInput?.channels) ? invocationInput.channels : [];
        inputChecks.push({
          label: 'channel',
          expected: options.channel,
          observed: channels,
          pass: channels.includes(options.channel),
        });
      }
      const inputContract =
        rawResult.exitCode !== 0 ||
        (invocation && inputChecks.length > 0 && inputChecks.every(({ pass }) => pass));
      const noConfirmContract =
        options.noConfirm !== true ||
        (rawResult.durationMs < (options.confirmTimeoutMs ?? 60_000) && invocation?.status === 'dispatched');
      const expectedPlacementNode = options.node ?? sandbox?.nodeName;
      const placement =
        rawResult.exitCode === 0 && expectedPlacementNode
          ? await this.waitForFleetPlacement(options.agentName, expectedPlacementNode, 60_000)
          : { pass: false, observedNode: undefined, expectedNode: expectedPlacementNode };
      const placementContract = placement.pass === true;
      const placementNode = expectedPlacementNode
        ? ([this.nodeA, this.nodeB].find(({ nodeName } = {}) => nodeName === expectedPlacementNode) ??
          (resource?.id ? { id: resource.id, nodeName: sandbox.nodeName } : undefined))
        : undefined;
      const identity =
        rawResult.exitCode === 0 && placementNode
          ? await this.waitForFleetAgentIdentity(
              placementNode,
              options.agentName,
              options.provider,
              options.runtime ?? 'pty',
              options.model
            )
          : { pass: false };
      const identityContract = identity.pass === true;
      let observedSentinel = false;
      let sentinelDetail = '';
      if (rawResult.exitCode === 0 && options.sentinel) {
        const observed = await this.waitForSentinel(
          options.sentinel,
          options.sentinelTimeoutMs,
          options.agentName
        );
        observedSentinel = observed.observed;
        sentinelDetail = observed.detail;
      }
      return {
        ...stripPrivateExecution(rawResult),
        exitCode:
          rawResult.exitCode === 0 &&
          sandboxContract &&
          inputContract &&
          noConfirmContract &&
          placementContract &&
          identityContract
            ? 0
            : 1,
        observedSentinel:
          observedSentinel &&
          sandboxContract &&
          inputContract &&
          noConfirmContract &&
          placementContract &&
          identityContract,
        observedAgentName: identity.agent?.name,
        observedProvider: identity.provider,
        observedRuntime: identity.runtime,
        observedModel: identity.model,
        observedIdentitySource: identityContract ? 'node-agent-list' : 'node-agent-list-failed',
        summary: [
          resource ? `sandboxId=${resource.id} nodeId=${resource.nodeId} provider=${resource.provider}` : '',
          sandboxChecks.join(' '),
          `inputContract=${inputContract} inputChecks=${JSON.stringify(inputChecks)}`,
          `noConfirmContract=${noConfirmContract} rawCommandMs=${Math.round(rawResult.durationMs)}`,
          `placementContract=${placementContract} expectedNode=${expectedPlacementNode ?? 'missing'} observedNode=${placement.observedNode ?? 'missing'} placementListExit=${placement.lastExitCode ?? 'not-run'} placementMalformed=${placement.malformed === true}`,
          `identityContract=${identityContract} observedAgent=${identity.agent?.name ?? 'missing'} observedProvider=${identity.provider ?? 'missing'} observedRuntime=${identity.runtime ?? 'missing'} observedModel=${identity.model ?? 'missing'}`,
          `agentOwnership=${agentOwnership}`,
          sentinelDetail,
        ]
          .filter(Boolean)
          .join('\n'),
      };
    });
    return { operation, rawResult, payload: rawResult ? tryParseJson(rawResult._rawStdout) : undefined };
  }

  async captureSandboxByExactName(name, role) {
    if (
      !this.evidence.ownershipIntents.some(
        (intent) => intent.type === 'daytona-sandbox' && intent.name === name
      )
    ) {
      throw new Error(`Refusing name reconciliation without ownership intent for ${name}`);
    }
    const candidates = (await this.listDaytona()).filter(
      (sandbox) =>
        sandbox.name === name &&
        UUID.test(sandbox.id ?? '') &&
        !this.baselineSandboxIds.has(sandbox.id) &&
        Date.parse(sandbox.createdAt) >= Date.parse(this.evidence.startedAt) - 5_000
    );
    if (candidates.length !== 1) return null;
    const [sandbox] = candidates;
    return this.resource('daytona-sandbox', sandbox.id, {
      role,
      provider: 'daytona',
      nodeName: name,
      snapshot: sandbox.snapshot ?? null,
      createdAt: sandbox.createdAt ?? null,
      state: sandbox.state ?? null,
      observedSnapshotId: null,
      ownership: 'reconciled-absent-baseline',
    });
  }

  async enrichSandbox(resource) {
    const result = await execute(this.daytonaArgv('sandbox', 'info', resource.id, '--format', 'json'), {
      timeoutMs: 30_000,
    });
    const payload = tryParseJson(result._rawStdout);
    if (result.exitCode === 0 && payload) {
      resource.snapshot = payload.snapshot ?? resource.snapshot ?? null;
      resource.createdAt = payload.createdAt ?? resource.createdAt ?? null;
      resource.state = payload.state ?? resource.state ?? null;
      resource.provider = 'daytona';
    }
    if (this.evidence.environment.releaseQualificationRequested) {
      const inspect = await execute(
        this.daytonaArgv(
          'sandbox',
          'exec',
          resource.id,
          '--timeout',
          '30',
          '--',
          'node',
          '-e',
          [
            "const f=require('node:fs'),c=require('node:crypto'),cp=require('node:child_process'),p=require('node:path')",
            "const digest=b=>c.createHash('sha256').update(b).digest('hex')",
            "const cli=f.realpathSync(cp.execFileSync('which',['agent-relay'],{encoding:'utf8'}).trim())",
            'let modules=p.dirname(cli)',
            "while(p.basename(modules)!=='node_modules'&&p.dirname(modules)!==modules)modules=p.dirname(modules)",
            "if(p.basename(modules)!=='node_modules')throw new Error('agent-relay is not installed from node_modules')",
            "const broker=p.join(modules,'@agent-relay',`broker-${process.platform}-${process.arch}`,'bin',process.platform==='win32'?'agent-relay-broker.exe':'agent-relay-broker')",
            'const cliBytes=f.readFileSync(cli),brokerBytes=f.readFileSync(broker),brokerStat=f.statSync(broker)',
            "const manifestBytes=f.readFileSync('/opt/agent-relay/snapshot-manifest.json')",
            "process.stdout.write(JSON.stringify({sha256:digest(manifestBytes),manifest:JSON.parse(manifestBytes),runtime:{platform:process.platform,arch:process.arch,cliPath:cli,cliSha256:digest(cliBytes),cliVersion:cp.execFileSync(cli,['version'],{encoding:'utf8'}).trim(),brokerPath:broker,brokerSha256:digest(brokerBytes),brokerBytes:brokerBytes.length,brokerMode:(brokerStat.mode&0o777).toString(8),brokerVersion:cp.execFileSync(broker,['--version'],{encoding:'utf8'}).trim()}}))",
          ].join(';')
        ),
        { timeoutMs: 45_000, maxCaptureBytes: 1024 * 1024 }
      );
      const inspected = inspect.exitCode === 0 ? tryParseJson(inspect._rawStdout) : undefined;
      resource.snapshotManifest = bindInspectedSnapshotManifest(
        inspected,
        inspect.stderr || `exit ${inspect.exitCode}`
      );
      resource.runtimeAttestation = inspected?.runtime ?? {
        inspectionError: inspect.stderr || `exit ${inspect.exitCode}`,
      };
    }
    await this.checkpoint();
  }

  async provisionBoardNode(letter) {
    const upper = letter.toUpperCase();
    const sandboxName = `relay-fleetboard-${letter}-${this.short}`;
    const agentName = `relay-fleetboard-${letter}-initial-${this.short}`;
    const sentinel = `RELAY_FLEETBOARD_${upper}_${this.short.toUpperCase()}_READY`;
    const result = await this.runFleetSpawn(`provision-node-${letter}`, {
      provider: 'codex',
      agentName,
      agentRole: 'initial-worker',
      task: `Use Agent Relay MCP to post the exact text ${sentinel} to channel general, then remain idle.`,
      sandbox: true,
      sandboxName,
      sandboxRole: 'board-node',
      noMount: true,
      model: process.env.VERIFY_FLEET_CODEX_MODEL ?? 'gpt-5.6-luna',
      sentinel,
      sentinelTimeoutMs: 90_000,
      timeoutMs: 210_000,
    });
    let resource = this.evidence.resources.find(
      (entry) => entry.type === 'daytona-sandbox' && entry.nodeName === sandboxName
    );
    if (!resource) {
      resource = await this.captureSandboxByExactName(sandboxName, 'board-node');
      if (resource) await this.checkpoint();
    }
    if (resource) await this.enrichSandbox(resource);
    const node = resource
      ? { letter, sandboxName, agentName, sentinel, ...resource }
      : { letter, sandboxName, agentName, sentinel };
    if (letter === 'a') this.nodeA = node;
    else this.nodeB = node;
    return result;
  }

  async simpleFleetCommands() {
    const availableNodes = this.availableBoardNodes();
    const availableNames = availableNodes.map(({ nodeName }) => nodeName);
    const primary = availableNodes[0];
    const parseNodes = (result) => {
      const payload = tryParseJson(result._rawStdout);
      return Array.isArray(payload?.nodes) ? payload.nodes : null;
    };
    await this.assertedCommand(
      'fleet-nodes-default',
      this.cliArgv('fleet', 'nodes'),
      (result) => {
        const nodes = parseNodes(result);
        const names = nodes?.map(({ name }) => name) ?? [];
        const pass = availableNames.length > 0 && availableNames.every((name) => names.includes(name));
        return {
          pass,
          summary: `visibleOwnedNodes=${JSON.stringify(names.filter((name) => name?.includes(this.short)))}`,
        };
      },
      { timeoutMs: 45_000, maxCaptureBytes: 4 * 1024 * 1024 }
    );
    await this.assertedCommand(
      'fleet-nodes-name',
      this.cliArgv('fleet', 'nodes', '--name', primary?.nodeName ?? 'missing'),
      (result) => {
        const nodes = parseNodes(result);
        const pass =
          Array.isArray(nodes) && nodes.length >= 1 && nodes.every(({ name }) => name === primary?.nodeName);
        return { pass, summary: `matchCount=${nodes?.length ?? 'invalid'}` };
      },
      { timeoutMs: 45_000, maxCaptureBytes: 4 * 1024 * 1024 }
    );
    await this.assertedCommand(
      'fleet-nodes-capability',
      this.cliArgv('fleet', 'nodes', '--capability', 'spawn:codex'),
      (result) => {
        const nodes = parseNodes(result);
        const pass =
          Array.isArray(nodes) &&
          availableNames.every((name) => nodes.some((node) => node.name === name)) &&
          nodes.every((node) => JSON.stringify(node.capabilities ?? []).includes('spawn:codex'));
        return { pass, summary: `matchingNodes=${nodes?.length ?? 'invalid'}` };
      },
      { timeoutMs: 45_000, maxCaptureBytes: 4 * 1024 * 1024 }
    );
    await this.assertedCommand(
      'fleet-nodes-all',
      this.cliArgv('fleet', 'nodes', '--all'),
      (result) => {
        const nodes = parseNodes(result);
        const names = nodes?.map(({ name }) => name) ?? [];
        return {
          pass: availableNames.length > 0 && availableNames.every((name) => names.includes(name)),
          summary: `totalRows=${nodes?.length ?? 'invalid'}`,
        };
      },
      { timeoutMs: 60_000, maxCaptureBytes: 16 * 1024 * 1024 }
    );
    await this.assertedCommand(
      'fleet-agent-list-json',
      this.cliArgv('fleet', 'agent', 'list', '--json'),
      (result) => {
        const payload = tryParseJson(result._rawStdout);
        const mappings = availableNodes.map(
          (node) => findFleetAgentNode(payload, node.agentName) === node.nodeName
        );
        return {
          pass: mappings.length > 0 && mappings.every(Boolean),
          summary: `mappings=${JSON.stringify(mappings)}`,
        };
      },
      { timeoutMs: 60_000, maxCaptureBytes: 16 * 1024 * 1024 }
    );
    await this.assertedCommand(
      'fleet-agent-list-pretty',
      this.cliArgv('fleet', 'agent', 'list', '--pretty'),
      (result) => ({
        pass:
          availableNodes.length > 0 &&
          availableNodes.every(({ agentName }) => result._rawStdout.includes(agentName)),
        summary: 'Every available board node initial worker must appear in the pretty table.',
      }),
      { timeoutMs: 60_000, maxCaptureBytes: 16 * 1024 * 1024 }
    );
    await this.assertedCommand(
      'fleet-agent-list-node',
      this.cliArgv('fleet', 'agent', 'list', '--node', primary?.nodeName ?? 'missing'),
      (result) => {
        const payload = tryParseJson(result._rawStdout);
        const rows = Array.isArray(payload?.perNode) ? payload.perNode : null;
        return {
          pass:
            Array.isArray(rows) &&
            rows.some(({ name }) => name === primary?.agentName) &&
            rows.every(({ node }) => node === primary?.nodeName),
          summary: `rowCount=${rows?.length ?? 'invalid'}`,
        };
      },
      { timeoutMs: 60_000, maxCaptureBytes: 4 * 1024 * 1024 }
    );
    await this.assertedCommand(
      'fleet-agent-list-all',
      this.cliArgv('fleet', 'agent', 'list', '--all'),
      (result) => {
        const payload = tryParseJson(result._rawStdout);
        return {
          pass:
            availableNodes.length > 0 &&
            availableNodes.every((node) => findFleetAgentNode(payload, node.agentName) === node.nodeName),
          summary: `perNodeRows=${payload?.perNode?.length ?? 'invalid'} rosterOnly=${payload?.unplacedRoster?.length ?? 'invalid'}`,
        };
      },
      { timeoutMs: 90_000, maxCaptureBytes: 16 * 1024 * 1024 }
    );
  }

  async targetedFleetSpawns() {
    const availableNodes = this.availableBoardNodes();
    if (availableNodes.length === 0) {
      for (const id of [
        'fleet-spawn-node',
        'fleet-spawn-target-node-alias',
        'fleet-spawn-automatic-owned-placement',
        'fleet-spawn-session-ref',
        'fleet-spawn-no-confirm-readiness',
        'fleet-spawn-metadata-channel-model-cwd',
      ])
        await this.derived(id, { blockedReason: 'no live owned board node was available' });
      return;
    }
    const nodeAt = (index) => availableNodes[index % availableNodes.length];
    const cases = [
      ['fleet-spawn-node', nodeAt(0), '--node', {}],
      ['fleet-spawn-target-node-alias', nodeAt(1), '--target-node', {}],
      ['fleet-spawn-session-ref', nodeAt(2), '--node', { sessionRef: `fleetboard-session-${this.short}` }],
      ['fleet-spawn-no-confirm-readiness', nodeAt(3), '--node', { noConfirm: true }],
      [
        'fleet-spawn-metadata-channel-model-cwd',
        nodeAt(4),
        '--node',
        {
          channel: `fleetboard-${this.short}`,
          cwd: '/home/daytona',
          persona: 'fleet-board-worker',
          organization: 'AgentWorkforce',
          project: 'relay',
          workstream: 'fleet-cleanroom',
          role: 'verification-worker',
          objective: `Verify fleet metadata ${this.short}`,
        },
      ],
    ];
    for (const [id, node, nodeFlag, extra] of cases) {
      const agentName = `${id}-${this.short}`;
      const sentinel = `${id.replace(/-/g, '_').toUpperCase()}_${this.short.toUpperCase()}_READY`;
      const targetChannel = extra.channel ?? 'general';
      const cwdInstruction = extra.cwd
        ? `First verify your process cwd is exactly ${extra.cwd}; if it is not, post nothing.`
        : '';
      await this.runFleetSpawn(id, {
        provider: 'codex',
        agentName,
        task: `${cwdInstruction} Use Agent Relay MCP to post the exact text ${sentinel} to channel ${targetChannel}, then remain idle.`.trim(),
        node: node.nodeName,
        nodeFlag,
        model: process.env.VERIFY_FLEET_CODEX_MODEL ?? 'gpt-5.6-luna',
        sentinel,
        sentinelTimeoutMs: 60_000,
        timeoutMs: 120_000,
        ...extra,
      });
      if (id === 'fleet-spawn-node') {
        await this.record('fleet-release', async () => {
          const release = await execute(
            this.cliArgv('fleet', 'release', agentName, '--reason', `fleet board ${this.short} lifecycle`),
            { timeoutMs: 45_000 }
          );
          const absent =
            release.exitCode === 0 && (await this.waitForNodeAgentAbsent(node, agentName, 60_000));
          const identityPreserved = (await this.exactAgentExists(agentName).catch(() => null)) === true;
          await this.removeIdentity(agentName);
          const identityCleaned = await this.waitForAgentAbsent(agentName, 45_000);
          const resource = this.evidence.resources.find(
            (entry) => entry.type === 'relay-agent' && entry.id === agentName
          );
          if (resource && absent && identityCleaned) resource.cleanupState = 'absent';
          if (!absent || !identityCleaned) this.taintedNodeIds.add(node.id);
          return {
            ...stripPrivateExecution(release),
            exitCode: absent && identityPreserved ? 0 : 1,
            summary: `confirmedProcessAbsent=${absent} identityPreservedWithoutDelete=${identityPreserved} cleanupIdentityAbsent=${identityCleaned}`,
          };
        });
      } else if (id === 'fleet-spawn-target-node-alias') {
        await this.record('fleet-release-delete-agent', async () => {
          const release = await execute(
            this.cliArgv(
              'fleet',
              'release',
              agentName,
              '--reason',
              `fleet board ${this.short} delete lifecycle`,
              '--delete-agent'
            ),
            { timeoutMs: 45_000 }
          );
          const processAbsent =
            release.exitCode === 0 && (await this.waitForNodeAgentAbsent(node, agentName, 60_000));
          const identityAbsent = processAbsent && (await this.waitForAgentAbsent(agentName, 60_000));
          if (!identityAbsent) {
            await this.removeIdentity(agentName);
            if (!(await this.waitForAgentAbsent(agentName, 45_000))) this.taintedNodeIds.add(node.id);
          }
          const resource = this.evidence.resources.find(
            (entry) => entry.type === 'relay-agent' && entry.id === agentName
          );
          if (resource && processAbsent && identityAbsent) resource.cleanupState = 'absent';
          return {
            ...stripPrivateExecution(release),
            exitCode: processAbsent && identityAbsent ? 0 : 1,
            summary: `confirmedProcessAbsent=${processAbsent} confirmedIdentityAbsent=${identityAbsent}`,
          };
        });
      } else {
        await this.releaseSupport(agentName, node);
      }
    }

    const id = 'fleet-spawn-automatic-owned-placement';
    const agentName = `${id}-${this.short}`;
    const sentinel = `${id.replace(/-/g, '_').toUpperCase()}_${this.short.toUpperCase()}_READY`;
    await this.creationIntent('relay-agent', agentName);
    await this.record(id, async () => {
      const commandResult = await execute(
        this.cliArgv(
          'fleet',
          'spawn',
          'codex',
          '--name',
          agentName,
          '--task',
          `Use Agent Relay MCP to post the exact text ${sentinel} to channel general, then remain idle.`,
          '--model',
          process.env.VERIFY_FLEET_CODEX_MODEL ?? 'gpt-5.6-luna',
          '--persona',
          'fleet-board-worker'
        ),
        { timeoutMs: 120_000 }
      );
      if (commandResult.exitCode === 0) this.claimAgent(agentName, 'automatic-worker');
      else {
        await this.reconcileFailedSpawnIdentity(agentName, 'automatic-worker');
      }
      const placement = await this.waitForFleetPlacement(agentName, undefined, 60_000);
      const assignedNode = placement.observedNode;
      const ownedPlacement = availableNodes.some(({ nodeName }) => nodeName === assignedNode);
      const assignedNodeResource = availableNodes.find(({ nodeName }) => nodeName === assignedNode);
      const identity = ownedPlacement
        ? await this.waitForFleetAgentIdentity(
            assignedNodeResource,
            agentName,
            'codex',
            'pty',
            process.env.VERIFY_FLEET_CODEX_MODEL ?? 'gpt-5.6-luna'
          )
        : { pass: false };
      const observed = await this.waitForSentinel(sentinel, 60_000, agentName);
      return {
        ...stripPrivateExecution(commandResult),
        observedSentinel:
          commandResult.exitCode === 0 &&
          placement.pass &&
          ownedPlacement &&
          identity.pass &&
          observed.observed,
        observedAgentName: identity.agent?.name,
        observedProvider: identity.provider,
        observedRuntime: identity.runtime,
        observedModel: identity.model,
        observedIdentitySource: identity.pass ? 'node-agent-list' : 'node-agent-list-failed',
        summary: `assignedNode=${assignedNode ?? 'missing'} placementObserved=${placement.pass} ownedPlacement=${ownedPlacement} identityContract=${identity.pass} observedProvider=${identity.provider ?? 'missing'} observedRuntime=${identity.runtime ?? 'missing'}\n${observed.detail}`,
      };
    });
    await this.releaseSupport(agentName, null);
  }

  async fleetProviderMatrix() {
    const availableNodes = this.availableBoardNodes();
    if (availableNodes.length === 0) {
      for (const provider of ['claude', 'codex', 'gemini', 'aider', 'goose', 'grok', 'opencode']) {
        await this.derived(`fleet-spawn-provider-${provider}`, {
          blockedReason: 'no live owned board node was available',
        });
      }
    } else {
      const providers = ['claude', 'codex', 'gemini', 'aider', 'goose', 'grok', 'opencode'];
      for (const [index, provider] of providers.entries()) {
        const node = availableNodes[index % availableNodes.length];
        const id = `fleet-spawn-provider-${provider}`;
        const agentName = `${id}-${this.short}`;
        const sentinel = `${id.replace(/-/g, '_').toUpperCase()}_${this.short.toUpperCase()}_READY`;
        await this.runFleetSpawn(id, {
          provider,
          agentName,
          task: `Use Agent Relay MCP to post the exact text ${sentinel} to channel general, then remain idle.`,
          node: node.nodeName,
          model: provider === 'codex' ? (process.env.VERIFY_FLEET_CODEX_MODEL ?? 'gpt-5.6-luna') : undefined,
          sentinel,
          sentinelTimeoutMs: 45_000,
          timeoutMs: 90_000,
        });
        await this.releaseSupport(agentName, node);
      }
    }
    const rejectedName = `fleet-spawn-provider-droid-${this.short}`;
    await this.record('fleet-spawn-reject-droid', async () => {
      const before = await this.captureNoPartialCreationProof(rejectedName);
      const result = await execute(
        this.cliArgv(
          'fleet',
          'spawn',
          'droid',
          '--name',
          rejectedName,
          '--task',
          'This must be rejected by the public Fleet parser.'
        ),
        { timeoutMs: 15_000 }
      );
      const after = await this.captureNoPartialCreationProof(rejectedName);
      return {
        ...stripPrivateExecution(result),
        partialCreationProof: { targetName: rejectedName, before, after },
        summary: `${result.stderr}\nnoPartialCreation=${noPartialCreationProofPass({ targetName: rejectedName, before, after }, rejectedName)}`,
      };
    });
  }

  async mountedSandboxCases() {
    const [scopeMarkerBytes, rootOnlyMarkerBytes] = await Promise.all([
      readFile(path.resolve(SCRIPT_DIR, '../..', MOUNT_SCOPE_MARKER)),
      readFile(path.resolve(SCRIPT_DIR, '../..', MOUNT_ROOT_ONLY_MARKER)),
    ]);
    const present = (bytes) => ({
      exists: true,
      bytes: bytes.length,
      sha256: sha256Bytes(bytes),
    });
    const absent = { exists: false };
    const cases = [
      {
        id: 'fleet-spawn-sandbox-root-mount',
        name: `relay-fleetboard-root-${this.short}`,
        paths: undefined,
        noMount: false,
        mountProof: { scope: present(scopeMarkerBytes), rootOnly: present(rootOnlyMarkerBytes) },
      },
      {
        id: 'fleet-spawn-sandbox-scoped-mount',
        name: `relay-fleetboard-scoped-${this.short}`,
        paths: ['/tests/relayflows/cleanroom/**'],
        noMount: false,
        mountProof: { scope: present(scopeMarkerBytes), rootOnly: absent },
      },
      {
        id: 'fleet-spawn-sandbox-no-mount',
        name: `relay-fleetboard-nomount-${this.short}`,
        paths: undefined,
        noMount: true,
        mountProof: { scope: absent, rootOnly: absent },
      },
    ];
    for (const scenario of cases) {
      const agentName = `${scenario.id}-${this.short}`;
      const sentinel = `${scenario.id.replace(/-/g, '_').toUpperCase()}_${this.short.toUpperCase()}_READY`;
      await this.runFleetSpawn(scenario.id, {
        provider: 'codex',
        agentName,
        task: `Use Agent Relay MCP to post the exact text ${sentinel} to channel general, then remain idle.`,
        sandbox: true,
        sandboxName: scenario.name,
        sandboxRole: scenario.id.replace('fleet-spawn-sandbox-', '') + '-probe',
        mountPaths: scenario.paths,
        noMount: scenario.noMount,
        mountProof: scenario.mountProof,
        model: process.env.VERIFY_FLEET_CODEX_MODEL ?? 'gpt-5.6-luna',
        sentinel,
        sentinelTimeoutMs: 75_000,
        timeoutMs: 600_000,
      });
      const resource = await this.captureSandboxByExactName(
        scenario.name,
        scenario.id.replace('fleet-spawn-sandbox-', '') + '-probe'
      );
      if (resource) {
        await this.enrichSandbox(resource);
        await this.checkpoint();
      }
    }
  }

  async injectionCases() {
    for (const node of [this.nodeA, this.nodeB]) {
      const letter = node?.letter ?? 'a';
      const id = `initial-task-sentinel-${letter}`;
      const provision = this.evidence.operations.find(
        ({ id: operationId }) => operationId === `provision-node-${letter}`
      );
      await this.derived(id, {
        derivedFrom: `provision-node-${letter}`,
        argv: provision?.argv ?? [],
        exitCode: provision?.exitCode ?? 1,
        observedSentinel: provision?.observedSentinel === true,
        summary: `Initial-task MCP sentinel for board node ${letter.toUpperCase()}.`,
      });
    }
    for (const node of [this.nodeA, this.nodeB]) {
      const id = `post-ready-steer-${node?.letter ?? 'a'}`;
      if (!node?.agentName || !this.controller) {
        await this.derived(id, { blockedReason: 'controller or initial agent unavailable' });
        continue;
      }
      const sentinel = `POST_READY_STEER_${node.letter.toUpperCase()}_${this.short.toUpperCase()}_READY`;
      await this.record(id, async () => {
        const commandResult = await execute(
          this.cliArgv(
            'message',
            'dm',
            'send',
            node.agentName,
            `Use Agent Relay MCP to post the exact text ${sentinel} to channel general.`,
            '--mode',
            'steer'
          ),
          { timeoutMs: 30_000, env: this.controllerEnv(), extraSecrets: [this.controller.token] }
        );
        const observed = await this.waitForSentinel(sentinel, 90_000, node.agentName);
        const receiptPayload = tryParseJson(commandResult._rawStdout);
        const messageId = findStringDeep(receiptPayload, ['messageId', 'id']);
        if (commandResult.exitCode === 0 && messageId) {
          this.steerReceipts.push({ messageId, agentName: node.agentName });
        }
        return {
          ...stripPrivateExecution(commandResult),
          observedSentinel: commandResult.exitCode === 0 && observed.observed,
          summary: observed.detail,
        };
      });
    }
    await this.record('post-ready-reader-ack', async () => {
      if (!this.controller) return { argv: [], blockedReason: 'controller unavailable' };
      const expectedAgents = this.availableBoardNodes().map(({ agentName }) => agentName);
      if (expectedAgents.length === 0 || this.steerReceipts.length === 0) {
        return { argv: [], exitCode: 1, summary: 'No live-node steer receipt was available to inspect.' };
      }
      const confirmations = [];
      let lastResult;
      for (const { messageId, agentName } of this.steerReceipts) {
        lastResult = await execute(this.cliArgv('message', 'inbox', 'get_readers', messageId), {
          timeoutMs: 30_000,
          env: this.controllerEnv(),
          extraSecrets: [this.controller.token],
        });
        const payload = tryParseJson(lastResult._rawStdout);
        const readers = Array.isArray(payload?.readers) ? payload.readers : [];
        confirmations.push({
          agentName,
          messageIdHash: sha256(messageId),
          read: readers.some((reader) => reader?.agentName === agentName),
        });
      }
      const pass =
        expectedAgents.every((agentName) =>
          confirmations.some((confirmation) => confirmation.agentName === agentName && confirmation.read)
        ) && lastResult?.exitCode === 0;
      return {
        ...(lastResult ? stripPrivateExecution(lastResult) : { argv: [] }),
        exitCode: pass ? 0 : 1,
        summary: `exactReaderConfirmations=${JSON.stringify(confirmations)}`,
      };
    });
  }

  async releaseInitialWorkers() {
    for (const node of [this.nodeA, this.nodeB]) {
      if (node?.agentName) await this.releaseSupport(node.agentName, node);
    }
  }

  async criticalLifecycleRepeatability() {
    const nodes = this.availableBoardNodes();
    if (nodes.length < this.matrix.minimumBoardNodes || !this.controller) {
      this.evidence.criticalLifecycle = {
        status: 'blocked',
        trials: [],
        blockedReason: 'two live owned board nodes and the controller are required',
      };
      await this.checkpoint();
      return;
    }
    const trials = [];
    for (let offset = 0; offset < this.matrix.minimumCriticalLifecycleTrials; offset += 1) {
      const index = offset + 1;
      const node = nodes[offset % nodes.length];
      const slot = offset % 2 === 0 ? 'a' : 'b';
      const agentName = `critical-lifecycle-${slot}-${this.short}`;
      const initialSentinel = `CRITICAL_LIFECYCLE_${index}_${this.short.toUpperCase()}_INITIAL`;
      const postReadySentinel = `CRITICAL_LIFECYCLE_${index}_${this.short.toUpperCase()}_INJECTED`;
      const monotonicStartNs = process.hrtime.bigint();
      let spawn;
      let placement = { pass: false };
      let initial = { observed: false };
      let injection;
      let injectionMessageIdHash;
      let postReady = { observed: false };
      let postReadyReaderConfirmed = false;
      let releasedAndAbsent = false;
      let preSpawnAgentAbsent = false;
      try {
        // Re-check even when this nonce already checkpointed an intent for the
        // reused name. A prior failed release must make this trial red rather
        // than allowing the next spawn to attach to stale identity state.
        await this.creationIntent('relay-agent', agentName);
        preSpawnAgentAbsent = true;
        spawn = await execute(
          this.cliArgv(
            ...buildFleetSpawnArgs({
              provider: 'codex',
              agentName,
              task: `Use Agent Relay MCP to post the exact text ${initialSentinel} to channel general, then remain idle.`,
              node: node.nodeName,
              model: process.env.VERIFY_FLEET_CODEX_MODEL ?? 'gpt-5.6-luna',
              confirmTimeoutMs: 60_000,
            })
          ),
          { timeoutMs: 120_000 }
        );
        if (spawn.exitCode === 0) this.claimAgent(agentName, 'critical-lifecycle-worker');
        else await this.reconcileFailedSpawnIdentity(agentName, 'critical-lifecycle-worker');
        placement = await this.waitForFleetPlacement(agentName, node.nodeName, 60_000);
        initial = await this.waitForSentinel(initialSentinel, 60_000, agentName);
        injection = await execute(
          this.cliArgv(
            'message',
            'dm',
            'send',
            agentName,
            `Use Agent Relay MCP to post the exact text ${postReadySentinel} to channel general.`,
            '--mode',
            'steer'
          ),
          { timeoutMs: 30_000, env: this.controllerEnv(), extraSecrets: [this.controller.token] }
        );
        const receipt = tryParseJson(injection._rawStdout);
        const messageId = findStringDeep(receipt, ['messageId', 'id']);
        injectionMessageIdHash = typeof messageId === 'string' ? sha256(messageId) : undefined;
        postReady = await this.waitForSentinel(postReadySentinel, 90_000, agentName);
        if (messageId) {
          const readers = await execute(this.cliArgv('message', 'inbox', 'get_readers', messageId), {
            timeoutMs: 30_000,
            env: this.controllerEnv(),
            extraSecrets: [this.controller.token],
          });
          const payload = readers.exitCode === 0 ? tryParseJson(readers._rawStdout) : undefined;
          postReadyReaderConfirmed =
            payload?.readers?.some?.((reader) => reader?.agentName === agentName) === true;
        }
        releasedAndAbsent = await this.releaseSupport(agentName, node);
      } catch (error) {
        await this.releaseSupport(agentName, node).catch(() => false);
        spawn ??= {
          argv: [],
          exitCode: null,
          timedOut: false,
          stderr: redactFleetEvidence(error instanceof Error ? error.stack : String(error)),
        };
      }
      const monotonicEndNs = process.hrtime.bigint();
      const spawned = spawn?.exitCode === 0 && spawn?.timedOut !== true;
      const agentOriginatedAckProof =
        SHA256.test(initial.messageIdHash ?? '') &&
        initial.agentName === agentName &&
        initial.channelName === 'general' &&
        SHA256.test(injectionMessageIdHash ?? '') &&
        SHA256.test(postReady.messageIdHash ?? '') &&
        postReady.agentName === agentName &&
        postReady.channelName === 'general' &&
        initial.messageIdHash !== postReady.messageIdHash;
      const status =
        preSpawnAgentAbsent &&
        spawned &&
        placement.pass === true &&
        initial.observed === true &&
        injection?.exitCode === 0 &&
        postReady.observed === true &&
        postReadyReaderConfirmed &&
        releasedAndAbsent &&
        agentOriginatedAckProof
          ? 'pass'
          : 'fail';
      trials.push({
        index,
        status,
        nodeName: node.nodeName,
        nodeId: node.nodeId,
        agentName,
        monotonicStartNs: monotonicStartNs.toString(),
        monotonicEndNs: monotonicEndNs.toString(),
        durationMs: Number(monotonicEndNs - monotonicStartNs) / 1_000_000,
        preSpawnAgentAbsent,
        spawned,
        placementConfirmed: placement.pass === true,
        initialSentinelObserved: initial.observed === true,
        initialAckMessageIdHash: initial.messageIdHash,
        initialAckAgentName: initial.agentName,
        initialAckChannelName: initial.channelName,
        postReadyInjectionAccepted: injection?.exitCode === 0,
        injectionMessageIdHash,
        postReadySentinelObserved: postReady.observed === true,
        postReadyAckMessageIdHash: postReady.messageIdHash,
        postReadyAckAgentName: postReady.agentName,
        postReadyAckChannelName: postReady.channelName,
        postReadyReaderConfirmed,
        releasedAndAbsent,
        spawnArgv: spawn?.argv ?? [],
        spawnExitCode: spawn?.exitCode ?? null,
        spawnTimedOut: spawn?.timedOut === true,
        spawnStdoutBytes: spawn?.stdoutBytes ?? 0,
        spawnStderrBytes: spawn?.stderrBytes ?? 0,
        spawnOutputTruncated: spawn?.stdoutTruncated === true || spawn?.stderrTruncated === true,
      });
      this.evidence.criticalLifecycle = {
        status: trials.some((trial) => trial.status === 'fail') ? 'fail' : 'pending',
        trials,
      };
      await this.checkpoint();
    }
    this.evidence.criticalLifecycle.status = trials.every(({ status }) => status === 'pass')
      ? 'pass'
      : 'fail';
    await this.checkpoint();
  }

  async nodeObservability() {
    const node = this.availableBoardNodes()[0];
    if (!node) {
      for (const id of [
        'node-status',
        'node-status-wait',
        'node-metrics',
        'node-metrics-agent',
        'node-deadletters',
        'node-deadletters-json',
        'node-redeliver-all',
        'node-redeliver-requires-id',
        'node-tail-agent',
        'node-agent-list',
        'node-agent-list-pretty',
        'node-agent-list-status',
      ])
        await this.derived(id, { blockedReason: 'no live owned board node was available' });
      return;
    }
    const sandboxId = node.id;
    const assertRunningStatus = (result) => {
      const output = result._rawStdout;
      const pass =
        output.includes('Status: RUNNING') &&
        output.includes('Node delivery: CONNECTED') &&
        output.includes(node.nodeName);
      return { pass, summary: `running=${pass} expectedNode=${node.nodeName}` };
    };
    await this.assertedCommand('node-status', this.inside(sandboxId, 'node', 'status'), assertRunningStatus, {
      timeoutMs: 45_000,
    });
    await this.assertedCommand(
      'node-status-wait',
      this.inside(sandboxId, 'node', 'status', '--wait-for', '15'),
      assertRunningStatus,
      { timeoutMs: 45_000 }
    );
    await this.assertedCommand(
      'node-metrics',
      this.inside(sandboxId, 'node', 'metrics'),
      (result) => {
        const payload = tryParseJson(result._rawStdout);
        const names = Array.isArray(payload?.agents)
          ? payload.agents.map(({ name }) => name).filter(Boolean)
          : [];
        const pass =
          names.includes(node.agentName) &&
          Number.isInteger(payload?.broker?.active_agents) &&
          payload.broker.active_agents >= 1;
        return { pass, summary: `agents=${JSON.stringify(names)} active=${payload?.broker?.active_agents}` };
      },
      { timeoutMs: 45_000 }
    );
    await this.assertedCommand(
      'node-metrics-agent',
      this.inside(sandboxId, 'node', 'metrics', '--agent', node.agentName),
      (result) => {
        const payload = tryParseJson(result._rawStdout);
        const names = Array.isArray(payload?.agents)
          ? payload.agents.map(({ name }) => name).filter(Boolean)
          : [];
        return {
          pass: names.length === 1 && names[0] === node.agentName,
          summary: `filteredAgents=${JSON.stringify(names)}`,
        };
      },
      { timeoutMs: 45_000 }
    );
    await this.assertedCommand(
      'node-deadletters',
      this.inside(sandboxId, 'node', 'deadletters'),
      (result) => ({
        pass: result._rawStdout.includes('No dead-letter deliveries.'),
        summary: 'emptyQueueBranch=true',
      }),
      { timeoutMs: 45_000 }
    );
    await this.assertedCommand(
      'node-deadletters-json',
      this.inside(sandboxId, 'node', 'deadletters', '--json'),
      (result) => {
        const payload = tryParseJson(result._rawStdout);
        return {
          pass:
            payload?.count === 0 && Array.isArray(payload.dead_letters) && payload.dead_letters.length === 0,
          summary: `count=${payload?.count ?? 'invalid'} emptyQueueBranch=true`,
        };
      },
      { timeoutMs: 45_000 }
    );
    await this.assertedCommand(
      'node-redeliver-all',
      this.inside(sandboxId, 'node', 'redeliver', '--all'),
      (result) => ({
        pass: result._rawStdout.includes('No dead-letter deliveries to redeliver.'),
        summary: 'emptyQueueBranch=true',
      }),
      { timeoutMs: 45_000 }
    );
    await this.command('node-redeliver-requires-id', this.inside(sandboxId, 'node', 'redeliver'), {
      timeoutMs: 30_000,
    });
    await this.record('node-tail-agent', async () => {
      const tailSentinel = `NODE_TAIL_${this.short.toUpperCase()}_EVENT`;
      const tailPromise = execute(this.inside(sandboxId, 'node', 'tail', '--agent', node.agentName), {
        timeoutMs: 15_000,
      });
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const trigger = this.controller
        ? await execute(
            this.cliArgv(
              'message',
              'dm',
              'send',
              node.agentName,
              `Acknowledge this tail probe: ${tailSentinel}`,
              '--mode',
              'steer'
            ),
            { timeoutMs: 30_000, env: this.controllerEnv(), extraSecrets: [this.controller.token] }
          )
        : { exitCode: 1 };
      const result = await tailPromise;
      const observed = result._rawStdout.includes(tailSentinel);
      return {
        ...stripPrivateExecution(result),
        // Daytona writes its own CLI/API version warning to stderr before the
        // sandbox command starts. Only broker stream bytes on stdout prove tail.
        observedStream: trigger.exitCode === 0 && observed,
        summary: `triggerExit=${trigger.exitCode} brokerStdoutBytes=${Buffer.byteLength(result._rawStdout)} exactSentinel=${observed}`,
      };
    });
    const assertAgentList = (result, withStatus = false) => {
      const payload = tryParseJson(result._rawStdout);
      const agents = Array.isArray(payload) ? payload : [];
      const exact = agents.find(({ name }) => name === node.agentName);
      const pass =
        Boolean(exact) &&
        exact.runtime_kind === 'pty' &&
        (!withStatus || (typeof exact.delivery_mode === 'string' && Array.isArray(exact.pending)));
      return {
        pass,
        summary: `exactAgent=${Boolean(exact)} runtime=${exact?.runtime_kind ?? 'missing'} deliveryMode=${exact?.delivery_mode ?? 'not-requested'}`,
      };
    };
    await this.assertedCommand(
      'node-agent-list',
      this.inside(sandboxId, 'node', 'agent', 'list'),
      (result) => assertAgentList(result),
      { timeoutMs: 45_000 }
    );
    await this.assertedCommand(
      'node-agent-list-pretty',
      this.inside(sandboxId, 'node', 'agent', 'list', '--pretty'),
      (result) => ({
        pass: result._rawStdout.includes(node.agentName) && result._rawStdout.includes('codex'),
        summary: `listedExactAgent=${result._rawStdout.includes(node.agentName)}`,
      }),
      { timeoutMs: 45_000 }
    );
    await this.assertedCommand(
      'node-agent-list-status',
      this.inside(sandboxId, 'node', 'agent', 'list', '--status'),
      (result) => assertAgentList(result, true),
      { timeoutMs: 45_000 }
    );
  }

  async directNodeSpawn(id, node, provider, extra = {}) {
    if (!node?.id || this.taintedNodeIds.has(node.id))
      return this.derived(id, { blockedReason: `board node ${node?.letter ?? '?'} unavailable` });
    const agentName = `${id}-${this.short}`;
    const sentinel = `${id.replace(/-/g, '_').toUpperCase()}_${this.short.toUpperCase()}_READY`;
    await this.creationIntent('relay-agent', agentName);
    return this.record(id, async () => {
      const { args, commandName, expectedModel } = buildDirectNodeSpawnPlan(
        provider,
        agentName,
        sentinel,
        extra
      );
      const commandResult = await execute(this.inside(node.id, ...args), {
        timeoutMs: commandName === 'new' ? 20_000 : 60_000,
      });
      if (commandResult.exitCode === 0) {
        this.claimAgent(agentName, 'direct-node-worker');
      } else {
        await this.reconcileFailedSpawnIdentity(agentName, 'direct-node-worker');
      }
      const observed = await this.waitForSentinel(sentinel, 60_000, agentName);
      let observedExit;
      if (extra.expectExit) observedExit = await this.waitForNodeAgentAbsent(node, agentName, 45_000);
      let inventoryContract = true;
      let inventorySummary = 'not-required-for-exit-lifecycle';
      let observedAgent;
      if (!extra.expectExit) {
        const agents = await this.listNodeAgents(node);
        const exact = agents.find(({ name }) => name === agentName);
        observedAgent = exact;
        const expectedRuntime = extra.runtime === 'native' ? 'native' : 'pty';
        const actualProvider = exact?.cli ?? exact?.provider;
        inventoryContract =
          Boolean(exact) &&
          actualProvider === provider &&
          exact.runtime_kind === expectedRuntime &&
          (expectedModel === undefined || exact.model === expectedModel) &&
          (extra.channels === undefined ||
            extra.channels.every((channel) => exact.channels?.includes?.(channel) === true));
        inventorySummary = `listed=${Boolean(exact)} provider=${actualProvider ?? 'missing'} runtime=${exact?.runtime_kind ?? 'missing'} model=${exact?.model ?? 'missing'} channels=${JSON.stringify(exact?.channels ?? [])}`;
      }
      return {
        ...stripPrivateExecution(commandResult),
        exitCode: commandResult.exitCode === 0 && inventoryContract ? 0 : 1,
        observedSentinel: observed.observed && inventoryContract,
        ...(observedExit === undefined ? {} : { observedExit }),
        observedAgentName: observedAgent?.name,
        observedProvider: observedAgent?.cli ?? observedAgent?.provider,
        observedRuntime: observedAgent?.runtime_kind,
        observedModel: observedAgent?.model,
        observedIdentitySource: observedAgent ? 'node-agent-list' : 'not-required-exit-lifecycle',
        summary: `${inventorySummary}\n${observed.detail}`,
      };
    });
  }

  async nodeSpawnMatrix() {
    const nodes = this.availableBoardNodes();
    if (nodes.length === 0) {
      for (const { id } of this.matrix.operations.filter(({ group }) =>
        ['node-agent-spawn', 'node-agent-provider', 'node-agent'].includes(group)
      )) {
        if (!this.evidence.operations.some((operation) => operation.id === id)) {
          await this.derived(id, { blockedReason: 'no live owned board node was available' });
        }
      }
      return;
    }
    const nodeAt = (index) => nodes[index % nodes.length];
    const autoANode = nodeAt(0);
    await this.directNodeSpawn('node-agent-spawn-codex-auto-a', autoANode, 'codex');
    await this.nodeAgentControls(autoANode);
    const autoBNode = nodeAt(1);
    await this.directNodeSpawn('node-agent-spawn-codex-auto-b', autoBNode, 'codex');
    await this.releaseSupport(`node-agent-spawn-codex-auto-b-${this.short}`, autoBNode, 'node');
    const ptyNode = nodeAt(2);
    await this.directNodeSpawn('node-agent-spawn-codex-pty', ptyNode, 'codex', {
      runtime: 'pty',
      channels: ['general', `fleetboard-${this.short}`],
      cwd: '/home/daytona',
    });
    await this.releaseSupport(`node-agent-spawn-codex-pty-${this.short}`, ptyNode, 'node');
    const nativeNode = nodeAt(3);
    await this.directNodeSpawn('node-agent-spawn-codex-native', nativeNode, 'codex', {
      runtime: 'native',
    });
    await this.releaseSupport(`node-agent-spawn-codex-native-${this.short}`, nativeNode, 'node');
    const taskExitNode = nodeAt(4);
    await this.directNodeSpawn('node-agent-spawn-task-exit', taskExitNode, 'codex', {
      spawnMode: 'task-exit',
      expectExit: true,
    });
    await this.removeIdentity(`node-agent-spawn-task-exit-${this.short}`);
    const exitAfterNode = nodeAt(5);
    await this.directNodeSpawn('node-agent-spawn-exit-after-task', exitAfterNode, 'codex', {
      exitAfterTask: true,
      expectExit: true,
    });
    await this.releaseSupport(`node-agent-spawn-exit-after-task-${this.short}`, exitAfterNode, 'node');
    for (const [index, provider] of [
      'claude',
      'gemini',
      'droid',
      'aider',
      'goose',
      'grok',
      'opencode',
      'cursor',
    ].entries()) {
      const node = nodeAt(index);
      await this.directNodeSpawn(`node-agent-spawn-provider-${provider}`, node, provider);
      await this.releaseSupport(`node-agent-spawn-provider-${provider}-${this.short}`, node, 'node');
    }
    for (const [index, provider] of ['claude', 'opencode', 'pi', 'deepagents'].entries()) {
      const node = nodeAt(index + 8);
      await this.directNodeSpawn(`node-agent-spawn-provider-${provider}-native`, node, provider, {
        runtime: 'native',
      });
      await this.releaseSupport(`node-agent-spawn-provider-${provider}-native-${this.short}`, node, 'node');
    }
    const newNode = nodeAt(10);
    await this.directNodeSpawn('node-agent-new-view', newNode, 'codex', {
      commandName: 'new',
      mode: 'view',
    });
    await this.releaseSupport(`node-agent-new-view-${this.short}`, newNode, 'node');
  }

  async nodeAgentControls(node) {
    const controlName = `node-agent-spawn-codex-auto-a-${this.short}`;
    if (!node?.nodeName || !this.controller) {
      for (const id of [
        'node-agent-attach-view-json',
        'node-agent-attach-drive-json',
        'node-agent-attach-passthrough-json',
        'node-agent-message-hold',
        'node-agent-message-flush',
        'node-agent-message-auto',
        'node-agent-release',
        'node-agent-same-name-reclaim',
      ])
        await this.derived(id, { blockedReason: 'live owned board node or controller unavailable' });
      return;
    }
    for (const mode of ['view', 'drive', 'passthrough']) {
      const id = `node-agent-attach-${mode}-json`;
      await this.record(id, async () => {
        const inputMarker = `FLEET_ATTACH_INPUT_${mode.toUpperCase()}_${this.short.toUpperCase()}`;
        const injectionMarker = `FLEET_ATTACH_INJECTION_${this.short.toUpperCase()}`;
        const attachPromise = execute(
          this.cliArgv(
            'node',
            'agent',
            'attach',
            controlName,
            '--node',
            node.nodeName,
            '--mode',
            mode,
            '--json'
          ),
          {
            timeoutMs: 20_000,
            stdin: [
              { data: `${inputMarker}\n`, delayMs: 2_500, end: false },
              { data: '\x03', delayMs: 7_000, end: true },
            ],
          }
        );
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        const injection =
          mode === 'passthrough' && this.controller
            ? await execute(
                this.cliArgv(
                  'message',
                  'dm',
                  'send',
                  controlName,
                  `Observe this exact attach injection marker: ${injectionMarker}`,
                  '--mode',
                  'steer'
                ),
                {
                  timeoutMs: 30_000,
                  env: this.controllerEnv(),
                  extraSecrets: [this.controller.token],
                }
              )
            : undefined;
        const result = await attachPromise;
        const events = result._rawStdout
          .split(/\r?\n/)
          .map((line) => tryParseJson(line))
          .filter(Boolean);
        const exactStreams = events.filter(
          (event) => event.kind === 'worker_stream' && event.name === controlName
        );
        const workerBytes = exactStreams.map((event) => event.chunk).join('');
        const inputObserved = workerBytes.includes(inputMarker);
        const inputSemantics = mode === 'view' ? !inputObserved : inputObserved;
        const injectionObserved = mode !== 'passthrough' || workerBytes.includes(injectionMarker);
        const pass =
          result.exitCode === 0 &&
          !result.stdinWriteError &&
          exactStreams.length > 0 &&
          inputSemantics &&
          injectionObserved &&
          (mode !== 'passthrough' || injection?.exitCode === 0);
        return {
          ...stripPrivateExecution(result),
          exitCode: pass ? 0 : 1,
          observedStream: pass,
          summary: `mode=${mode} exactWorkerStreamEvents=${exactStreams.length} stdinBytes=${result.stdinBytes ?? 0} inputObserved=${inputObserved} inputSemantics=${inputSemantics} injectionTriggered=${injection?.exitCode === 0} injectionObserved=${injectionObserved}`,
        };
      });
    }
    const readDeliveryState = async (expectedMode, requirePending, timeoutMs = 30_000) => {
      const deadline = Date.now() + timeoutMs;
      let exact;
      while (Date.now() < deadline) {
        const list = await execute(this.inside(node.id, 'node', 'agent', 'list', '--status'), {
          timeoutMs: 20_000,
          maxCaptureBytes: 1024 * 1024,
        });
        const payload = tryParseJson(list._rawStdout);
        exact = Array.isArray(payload) ? payload.find(({ name }) => name === controlName) : undefined;
        const pendingMatches = requirePending
          ? (exact?.pending?.length ?? 0) > 0
          : exact?.pending?.length === 0;
        if (exact?.delivery_mode === expectedMode && pendingMatches) return exact;
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
      return exact;
    };
    const sendControlMessage = async (sentinel) => {
      const result = await execute(
        this.cliArgv(
          'message',
          'dm',
          'send',
          controlName,
          `Use Agent Relay MCP to post the exact text ${sentinel} to channel general.`,
          '--mode',
          'steer'
        ),
        { timeoutMs: 30_000, env: this.controllerEnv(), extraSecrets: [this.controller.token] }
      );
      const payload = tryParseJson(result._rawStdout);
      return { result, messageId: findStringDeep(payload, ['messageId', 'id']) };
    };
    const holdSentinel = `NODE_AGENT_HOLD_FLUSH_${this.short.toUpperCase()}_READY`;
    let heldMessageId;
    await this.record('node-agent-message-hold', async () => {
      const result = await execute(
        this.cliArgv('node', 'agent', 'message', 'hold', controlName, '--node', node.nodeName),
        { timeoutMs: 210_000 }
      );
      const held = await readDeliveryState('manual_flush', false);
      const sent = await sendControlMessage(holdSentinel);
      heldMessageId = sent.messageId;
      const queued = await readDeliveryState('manual_flush', true);
      const early = await this.waitForSentinel(holdSentinel, 8_000, controlName);
      const pass =
        result.exitCode === 0 &&
        sent.result.exitCode === 0 &&
        Boolean(held) &&
        Boolean(queued) &&
        Boolean(heldMessageId) &&
        !early.observed;
      return {
        ...stripPrivateExecution(result),
        exitCode: pass ? 0 : 1,
        summary: `mode=${queued?.delivery_mode ?? held?.delivery_mode ?? 'missing'} pending=${queued?.pending?.length ?? 'missing'} messageIdCaptured=${Boolean(heldMessageId)} injectedBeforeFlush=${early.observed}`,
      };
    });
    await this.record('node-agent-message-flush', async () => {
      const result = await execute(
        this.cliArgv('node', 'agent', 'message', 'flush', controlName, '--node', node.nodeName),
        { timeoutMs: 210_000 }
      );
      const observed = await this.waitForSentinel(holdSentinel, 90_000, controlName);
      const drained = await readDeliveryState('manual_flush', false);
      let readerAck = false;
      if (heldMessageId) {
        const readers = await execute(this.cliArgv('message', 'inbox', 'get_readers', heldMessageId), {
          timeoutMs: 30_000,
          env: this.controllerEnv(),
          extraSecrets: [this.controller.token],
        });
        const payload = tryParseJson(readers._rawStdout);
        readerAck = payload?.readers?.some?.((reader) => reader?.agentName === controlName) === true;
      }
      const pass = result.exitCode === 0 && observed.observed && drained?.pending?.length === 0 && readerAck;
      return {
        ...stripPrivateExecution(result),
        exitCode: pass ? 0 : 1,
        summary: `sentinel=${observed.observed} pending=${drained?.pending?.length ?? 'missing'} exactReaderAck=${readerAck}`,
      };
    });
    const autoSentinel = `NODE_AGENT_AUTO_${this.short.toUpperCase()}_READY`;
    await this.record('node-agent-message-auto', async () => {
      const result = await execute(
        this.cliArgv('node', 'agent', 'message', 'auto', controlName, '--node', node.nodeName),
        { timeoutMs: 210_000 }
      );
      const automatic = await readDeliveryState('auto_inject', false);
      const sent = await sendControlMessage(autoSentinel);
      const observed = await this.waitForSentinel(autoSentinel, 90_000, controlName);
      let readerAck = false;
      if (sent.messageId) {
        const readers = await execute(this.cliArgv('message', 'inbox', 'get_readers', sent.messageId), {
          timeoutMs: 30_000,
          env: this.controllerEnv(),
          extraSecrets: [this.controller.token],
        });
        const payload = tryParseJson(readers._rawStdout);
        readerAck = payload?.readers?.some?.((reader) => reader?.agentName === controlName) === true;
      }
      const pass =
        result.exitCode === 0 &&
        automatic?.delivery_mode === 'auto_inject' &&
        sent.result.exitCode === 0 &&
        observed.observed &&
        readerAck;
      return {
        ...stripPrivateExecution(result),
        exitCode: pass ? 0 : 1,
        summary: `mode=${automatic?.delivery_mode ?? 'missing'} sentinel=${observed.observed} exactReaderAck=${readerAck}`,
      };
    });
    await this.record('node-agent-release', async () => {
      const result = await execute(this.inside(node.id, 'node', 'agent', 'release', controlName), {
        timeoutMs: 45_000,
      });
      const processAbsent = await this.waitForNodeAgentAbsent(node, controlName, 60_000);
      return {
        ...stripPrivateExecution(result),
        exitCode: result.exitCode === 0 && processAbsent ? 0 : 1,
        summary: `confirmedProcessAbsent=${processAbsent}`,
      };
    });
    const sentinel = `NODE_AGENT_SAME_NAME_RECLAIM_${this.short.toUpperCase()}_READY`;
    await this.record('node-agent-same-name-reclaim', async () => {
      const result = await execute(
        this.inside(
          node.id,
          'node',
          'agent',
          'spawn',
          'codex',
          '--name',
          controlName,
          '--task',
          `Use Agent Relay MCP to post the exact text ${sentinel} to channel general, then remain idle.`,
          '--model',
          process.env.VERIFY_FLEET_CODEX_MODEL ?? 'gpt-5.6-luna'
        ),
        { timeoutMs: 60_000 }
      );
      const observed = await this.waitForSentinel(sentinel, 60_000, controlName);
      return {
        ...stripPrivateExecution(result),
        observedSentinel: observed.observed,
        summary: observed.detail,
      };
    });
    await this.releaseSupport(controlName, node, 'node');
  }

  async nodeWorkflows() {
    const ids = [
      'node-workflow-run',
      'node-workflow-logs',
      'node-workflow-logs-follow',
      'node-workflow-sync-dry-run',
      'node-workflow-sync',
    ];
    const node = this.availableBoardNodes().at(-1);
    if (!node?.id) {
      for (const id of ids)
        await this.derived(id, { blockedReason: 'no live owned board node was available' });
      return;
    }
    const workflowPath = `/tmp/relay-fleet-workflow-${this.short}.sh`;
    const workflowSentinel = `RELAY_NODE_WORKFLOW_${this.short.toUpperCase()}_OK`;
    const markerPath = `/tmp/relay-fleet-workflow-result-${this.short}.txt`;
    const markerBytes = `RELAY_NODE_WORKFLOW_EFFECT_${this.short.toUpperCase()}\n`;
    const markerSha256 = sha256(markerBytes);
    const inspectMarker = async () => {
      const inspection = await execute(
        this.daytonaArgv(
          'sandbox',
          'exec',
          node.id,
          '--timeout',
          '30',
          '--',
          'node',
          '-e',
          "const f=require('node:fs'),c=require('node:crypto'),p=process.argv[1];try{const b=f.readFileSync(p);process.stdout.write(JSON.stringify({exists:true,bytes:b.length,sha256:c.createHash('sha256').update(b).digest('hex')}))}catch(e){if(e&&e.code==='ENOENT')process.stdout.write(JSON.stringify({exists:false}));else throw e}",
          markerPath
        ),
        { timeoutMs: 45_000 }
      );
      return { inspection, payload: tryParseJson(inspection._rawStdout) };
    };
    const beforeMarker = await inspectMarker();
    const setup = await execute(
      this.daytonaArgv(
        'sandbox',
        'exec',
        node.id,
        '--timeout',
        '30',
        '--',
        'node',
        '-e',
        "require('node:fs').writeFileSync(process.argv[1], process.argv[2], { mode: 0o700 })",
        workflowPath,
        `#!/bin/sh\nprintf '%s' '${markerBytes}' > '${markerPath}'\nprintf '%s\\n' '${workflowSentinel}'\n`
      ),
      { timeoutMs: 45_000 }
    );
    let rawRun;
    await this.record('node-workflow-run', async () => {
      rawRun = await execute(
        this.inside(node.id, 'node', 'workflow', 'run', workflowPath, '--file-type', 'sh', '--json'),
        { timeoutMs: 60_000 }
      );
      const payload = tryParseJson(rawRun._rawStdout);
      const afterMarker = await inspectMarker();
      const markerCreated =
        beforeMarker.inspection.exitCode === 0 &&
        beforeMarker.payload?.exists === false &&
        afterMarker.inspection.exitCode === 0 &&
        afterMarker.payload?.exists === true &&
        afterMarker.payload?.bytes === Buffer.byteLength(markerBytes) &&
        afterMarker.payload?.sha256 === markerSha256;
      const pass =
        setup.exitCode === 0 &&
        rawRun.exitCode === 0 &&
        typeof findStringDeep(payload, ['runId']) === 'string' &&
        payload?.workflowPath === workflowPath &&
        payload?.fileType === 'sh' &&
        markerCreated;
      return {
        ...stripPrivateExecution(rawRun),
        exitCode: pass ? 0 : 1,
        summary: `fixtureCreated=${setup.exitCode === 0} runId=${findStringDeep(payload, ['runId']) ?? 'missing'} workflowPathMatches=${payload?.workflowPath === workflowPath} markerAbsentBefore=${beforeMarker.payload?.exists === false} markerCreated=${markerCreated} markerBytes=${afterMarker.payload?.bytes ?? 'missing'} markerSha256=${afterMarker.payload?.sha256 ?? 'missing'}`,
      };
    });
    const payload = rawRun ? tryParseJson(rawRun._rawStdout) : undefined;
    const runId = findStringDeep(payload, ['runId', 'id']);
    if (!runId) {
      for (const id of ids.slice(1))
        await this.derived(id, { blockedReason: 'workflow run did not return a run id' });
      return;
    }
    await this.assertedCommand(
      'node-workflow-logs',
      this.inside(node.id, 'node', 'workflow', 'logs', runId, '--json'),
      (result) => {
        const payload = tryParseJson(result._rawStdout);
        return {
          pass:
            payload?.done === true &&
            payload?.status === 'completed' &&
            typeof payload.content === 'string' &&
            payload.content.includes(workflowSentinel),
          summary: `done=${payload?.done} status=${payload?.status} sentinel=${payload?.content?.includes?.(workflowSentinel) === true}`,
        };
      },
      { timeoutMs: 45_000 }
    );
    await this.assertedCommand(
      'node-workflow-logs-follow',
      this.inside(node.id, 'node', 'workflow', 'logs', runId, '--follow', '--poll-interval', '1', '--json'),
      (result) => {
        const payload = tryParseJson(result._rawStdout);
        return {
          pass:
            payload?.done === true &&
            payload?.status === 'completed' &&
            typeof payload.content === 'string' &&
            payload.content.includes(workflowSentinel),
          summary: `done=${payload?.done} status=${payload?.status} sentinel=${payload?.content?.includes?.(workflowSentinel) === true}`,
        };
      },
      { timeoutMs: 60_000 }
    );
    for (const dryRun of [true, false]) {
      const operationId = dryRun ? 'node-workflow-sync-dry-run' : 'node-workflow-sync';
      await this.record(operationId, async () => {
        const result = await execute(
          this.inside(node.id, 'node', 'workflow', 'sync', runId, ...(dryRun ? ['--dry-run'] : []), '--json'),
          { timeoutMs: 45_000 }
        );
        const payload = tryParseJson(result._rawStdout);
        const afterSync = await inspectMarker();
        const markerUnchanged =
          afterSync.inspection.exitCode === 0 &&
          afterSync.payload?.exists === true &&
          afterSync.payload?.bytes === Buffer.byteLength(markerBytes) &&
          afterSync.payload?.sha256 === markerSha256;
        const pass =
          result.exitCode === 0 &&
          payload?.runId === runId &&
          payload?.status === 'completed' &&
          payload?.hasChanges === false &&
          payload?.dryRun === dryRun &&
          markerUnchanged;
        return {
          ...stripPrivateExecution(result),
          exitCode: pass ? 0 : 1,
          summary: `runIdMatches=${payload?.runId === runId} status=${payload?.status} hasChanges=${payload?.hasChanges} dryRun=${payload?.dryRun} markerUnchanged=${markerUnchanged} markerSha256=${afterSync.payload?.sha256 ?? 'missing'}`,
        };
      });
    }
  }

  async fleetPolicyAndStatus() {
    let rawConfig;
    const configOperation = await this.record('fleet-config', async () => {
      rawConfig = await execute(this.cliArgv('fleet', 'config'), {
        timeoutMs: 45_000,
        maxCaptureBytes: 1024 * 1024,
      });
      const payload = tryParseJson(rawConfig._rawStdout);
      const schemaValid =
        payload &&
        Object.prototype.hasOwnProperty.call(payload, 'override') &&
        [true, false, null].includes(payload.override) &&
        typeof payload.effective === 'boolean';
      return {
        ...stripPrivateExecution(rawConfig),
        exitCode: rawConfig.exitCode === 0 && schemaValid ? 0 : 1,
        summary: `schemaValid=${Boolean(schemaValid)} override=${String(payload?.override)} effective=${String(payload?.effective)}`,
      };
    });
    const configPayload = rawConfig ? tryParseJson(rawConfig._rawStdout) : undefined;
    const hasRestorableOverride =
      configPayload &&
      Object.prototype.hasOwnProperty.call(configPayload, 'override') &&
      [true, false, null].includes(configPayload.override);
    const initialOverride = hasRestorableOverride ? configPayload.override : undefined;
    const expectedWorkspaceId = this.evidence.environment.expectedWorkspaceId;
    const actualWorkspaceId = this.evidence.provenance?.resolvedWorkspaceId;
    const requested = this.evidence.environment.policyMutationRequested;
    const authorized =
      requested &&
      typeof expectedWorkspaceId === 'string' &&
      expectedWorkspaceId.length > 0 &&
      actualWorkspaceId === expectedWorkspaceId;
    this.evidence.environment.policyMutationAuthorized = authorized;
    this.evidence.environment.policyInitialOverride = hasRestorableOverride ? initialOverride : 'unknown';
    await this.checkpoint();

    if (!authorized || configOperation.status !== 'pass' || !hasRestorableOverride) {
      const safetyReason = !requested
        ? 'Set both VERIFY_FLEET_DISPOSABLE_WORKSPACE=1 and VERIFY_FLEET_EXPECTED_WORKSPACE_ID to authorize workspace policy mutation.'
        : !expectedWorkspaceId
          ? 'VERIFY_FLEET_EXPECTED_WORKSPACE_ID is required for workspace policy mutation.'
          : actualWorkspaceId !== expectedWorkspaceId
            ? `Active workspace ${actualWorkspaceId ?? 'unknown'} does not match the explicitly expected workspace.`
            : 'fleet config did not return a restorable override, so mutation was not attempted.';
      for (const id of ['fleet-enable', 'fleet-disable', 'fleet-inherit']) {
        await this.derived(id, { safetyReason });
      }
    } else {
      this.evidence.environment.policyMutationPerformed = true;
      const runPolicy = async (id, action, expectedOverride) =>
        this.record(id, async () => {
          const mutation = await execute(this.cliArgv('fleet', action), { timeoutMs: 45_000 });
          const readback = await execute(this.cliArgv('fleet', 'config'), {
            timeoutMs: 45_000,
            maxCaptureBytes: 1024 * 1024,
          });
          const payload = tryParseJson(readback._rawStdout);
          const readbackMatches =
            readback.exitCode === 0 &&
            payload &&
            Object.prototype.hasOwnProperty.call(payload, 'override') &&
            payload.override === expectedOverride;
          return {
            ...stripPrivateExecution(mutation),
            exitCode: mutation.exitCode === 0 && readbackMatches ? 0 : 1,
            summary: `action=${action} expectedOverride=${String(expectedOverride)} observedOverride=${String(payload?.override)} readbackExit=${readback.exitCode}`,
          };
        });
      try {
        await runPolicy('fleet-enable', 'enable', true);
        await runPolicy('fleet-disable', 'disable', false);
        await runPolicy('fleet-inherit', 'inherit', null);
      } finally {
        const restoreArg =
          initialOverride === true ? 'enable' : initialOverride === false ? 'disable' : 'inherit';
        const restore = await execute(this.cliArgv('fleet', restoreArg), { timeoutMs: 45_000 });
        const verify = await execute(this.cliArgv('fleet', 'config'), {
          timeoutMs: 45_000,
          maxCaptureBytes: 1024 * 1024,
        });
        const restoredPayload = tryParseJson(verify._rawStdout);
        const restoredExactly =
          verify.exitCode === 0 &&
          restoredPayload &&
          Object.prototype.hasOwnProperty.call(restoredPayload, 'override') &&
          restoredPayload.override === initialOverride;
        this.evidence.environment.policyRestoration = {
          targetOverride: initialOverride,
          command: restoreArg,
          exitCode: restore.exitCode,
          timedOut: restore.timedOut === true,
          verificationExitCode: verify.exitCode,
          restoredExactly: restoredExactly === true,
          status:
            restore.exitCode === 0 && restore.timedOut !== true && restoredExactly === true ? 'pass' : 'fail',
          stderr: redactFleetEvidence(`${restore.stderr ?? ''}\n${verify.stderr ?? ''}`),
        };
        await this.checkpoint();
      }
    }
    const statusNode = this.availableBoardNodes()[0];
    if (!statusNode?.id) {
      await this.derived('fleet-status', { blockedReason: 'no live owned board node was available' });
    } else {
      await this.assertedCommand(
        'fleet-status',
        this.inside(statusNode.id, 'fleet', 'status'),
        (result) => {
          const payload = tryParseJson(result._rawStdout);
          const pass =
            payload?.broker?.running === true &&
            payload?.node?.available === true &&
            (payload.node.name === statusNode.nodeName || payload.node.nodeName === statusNode.nodeName);
          return {
            pass,
            summary: `brokerRunning=${payload?.broker?.running} nodeAvailable=${payload?.node?.available} exactNode=${statusNode.nodeName}`,
          };
        },
        { timeoutMs: 45_000 }
      );
    }
    await this.record('fleet-serve-migration', async () => {
      const result = await execute(this.cliArgv('fleet', 'serve', '--old-flag'), { timeoutMs: 15_000 });
      const guidance = `${result._rawStdout}${result._rawStderr}`.includes('node up');
      return {
        ...stripPrivateExecution(result),
        exitCode: result.exitCode !== 0 && guidance ? result.exitCode : 0,
        summary: `migrationGuidance=${guidance}`,
      };
    });
  }

  async fleetReleaseCases() {
    const scopedName = `relay-fleetboard-scoped-${this.short}`;
    const scopedAgent = `fleet-spawn-sandbox-scoped-mount-${this.short}`;
    await this.record('fleet-release-reclaims-owned-sandbox', async () => {
      const resource = this.evidence.resources.find(
        (entry) => entry.type === 'daytona-sandbox' && entry.nodeName === scopedName
      );
      if (!resource) return { argv: [], blockedReason: 'scoped sandbox was not provisioned' };
      const node = [this.nodeA, this.nodeB].find(({ nodeName } = {}) => nodeName === resource.nodeName);
      const worker = this.evidence.resources.find(
        (entry) => entry.type === 'relay-agent' && entry.id === scopedAgent
      );
      const intent = this.evidence.ownershipIntents.find(
        ({ type, name }) => type === 'daytona-sandbox' && name === resource.nodeName
      );
      const ownershipBound =
        resource.ownership === 'created-by-run' &&
        intent?.nonce === this.nonce &&
        intent?.name === resource.nodeName &&
        worker?.sandboxId === resource.id &&
        worker?.sandboxNodeId === resource.nodeId &&
        worker?.sandboxNodeName === resource.nodeName &&
        worker?.cloudWorkspaceId === resource.cloudWorkspaceId;
      const result = await execute(
        this.cliArgv(
          'fleet',
          'release',
          scopedAgent,
          '--reason',
          `fleet board ${this.short} sandbox reclaim`,
          '--delete-agent'
        ),
        { timeoutMs: 45_000 }
      );
      let present = true;
      const deadline = Date.now() + 45_000;
      while (Date.now() < deadline) {
        present = Boolean(await this.findSandboxByName(scopedName));
        if (!present) break;
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
      const workerProcessAbsent =
        Boolean(node) && (await this.waitForNodeAgentAbsent(node, scopedAgent, 45_000));
      const workerIdentityAbsent = await this.waitForAgentAbsent(scopedAgent, 45_000);
      const sandboxAbsent = await this.waitForSandboxAbsentId(resource.id, 45_000);
      return {
        ...stripPrivateExecution(result),
        exitCode:
          result.exitCode === 0 &&
          !present &&
          workerProcessAbsent &&
          workerIdentityAbsent &&
          sandboxAbsent &&
          ownershipBound
            ? 0
            : 1,
        sandboxReleaseProof: {
          sandboxId: resource.id,
          sandboxName: resource.nodeName,
          cloudWorkspaceId: resource.cloudWorkspaceId,
          relayWorkspaceId: resource.relayWorkspaceId,
          nodeId: resource.nodeId,
          workerName: scopedAgent,
          ownership: resource.ownership,
          ownershipNonce: intent?.nonce,
          workerProcessAbsent,
          workerIdentityAbsent,
          sandboxAbsent,
        },
        summary: `sandboxId=${resource.id} sandboxName=${resource.nodeName} sandboxPresentAfterRelease=${present} workerProcessAbsent=${workerProcessAbsent} workerIdentityAbsent=${workerIdentityAbsent} sandboxAbsent=${sandboxAbsent} ownershipBound=${ownershipBound}`,
      };
    });
  }

  async nodeLifecycle() {
    const node = this.availableBoardNodes().at(-1);
    if (!node?.id) {
      for (const id of [
        'node-up-already-running',
        'node-down-graceful',
        'node-up-after-down',
        'node-down-all',
      ]) {
        await this.derived(id, { blockedReason: 'board node B unavailable' });
      }
      return;
    }
    const readStatus = () =>
      execute(this.inside(node.id, 'node', 'status'), {
        timeoutMs: 30_000,
        maxCaptureBytes: 1024 * 1024,
      });
    await this.record('node-up-already-running', async () => {
      const before = await readStatus();
      const result = await execute(this.inside(node.id, 'node', 'up', '--background'), {
        timeoutMs: 60_000,
      });
      const after = await readStatus();
      const beforePid = before._rawStdout.match(/PID:\s*(\d+)/)?.[1];
      const afterPid = after._rawStdout.match(/PID:\s*(\d+)/)?.[1];
      const pass =
        result.exitCode === 0 &&
        before._rawStdout.includes('Status: RUNNING') &&
        after._rawStdout.includes('Status: RUNNING') &&
        after._rawStdout.includes(node.nodeName) &&
        Boolean(beforePid) &&
        beforePid === afterPid;
      return {
        ...stripPrivateExecution(result),
        exitCode: pass ? 0 : 1,
        summary: `beforePid=${beforePid ?? 'missing'} afterPid=${afterPid ?? 'missing'} exactNode=${after._rawStdout.includes(node.nodeName)}`,
      };
    });
    await this.record('node-down-graceful', async () => {
      const result = await execute(this.inside(node.id, 'node', 'down', '--timeout', '5000'), {
        timeoutMs: 45_000,
      });
      const after = await readStatus();
      const stopped = !after._rawStdout.includes('Status: RUNNING');
      return {
        ...stripPrivateExecution(result),
        exitCode: result.exitCode === 0 && stopped ? 0 : 1,
        summary: `statusStopped=${stopped} statusExit=${after.exitCode}`,
      };
    });
    await this.record('node-up-after-down', async () => {
      const result = await execute(this.inside(node.id, 'node', 'up', '--background', '--no-spawn'), {
        timeoutMs: 90_000,
      });
      const after = await readStatus();
      const running =
        after.exitCode === 0 &&
        after._rawStdout.includes('Status: RUNNING') &&
        after._rawStdout.includes(node.nodeName);
      return {
        ...stripPrivateExecution(result),
        exitCode: result.exitCode === 0 && running ? 0 : 1,
        summary: `statusRunning=${running} exactNode=${after._rawStdout.includes(node.nodeName)}`,
      };
    });
    await this.record('node-down-all', async () => {
      const result = await execute(this.inside(node.id, 'node', 'down', '--all'), {
        timeoutMs: 45_000,
      });
      const after = await readStatus();
      const stopped = !after._rawStdout.includes('Status: RUNNING');
      return {
        ...stripPrivateExecution(result),
        exitCode: result.exitCode === 0 && stopped ? 0 : 1,
        summary: `statusStopped=${stopped} statusExit=${after.exitCode}`,
      };
    });
  }

  async cleanupAgents() {
    const attempts = [];
    const resourcesNeedingCleanup = new Set(
      this.evidence.resources
        .filter(({ type, cleanupState }) => type === 'relay-agent' && cleanupState !== 'absent')
        .map(({ id }) => id)
    );
    const cleanupNames = new Set([...resourcesNeedingCleanup, this.controller?.name].filter(Boolean));
    const authorizedNames = expectedOwnedAgentNames(this.matrix, this.nonce);
    for (const name of cleanupNames) {
      if (
        !authorizedNames.has(name) ||
        !this.isOwnedAgent(name) ||
        this.baseline?.agentNameHashes?.includes(sha256(name))
      ) {
        throw new Error(`Refusing cleanup of unauthorized Relay agent ${name}`);
      }
      const release = await execute(
        this.cliArgv(
          'fleet',
          'release',
          name,
          '--reason',
          `fleet board ${this.short} cleanup`,
          '--delete-agent'
        ),
        { timeoutMs: 45_000 }
      );
      attempts.push({
        type: 'fleet-release',
        target: name,
        exitCode: release.exitCode,
        stderr: release.stderr,
      });
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const remove = await execute(
        this.cliArgv('agent', 'remove', name, '--reason', `fleet board ${this.short} exact cleanup`),
        { timeoutMs: 45_000 }
      );
      attempts.push({ type: 'agent-remove', target: name, exitCode: remove.exitCode, stderr: remove.stderr });
      const resource = this.evidence.resources.find(
        (entry) => entry.type === 'relay-agent' && entry.id === name
      );
      if (resource) resource.cleanupState = 'delete-requested';
      await this.checkpoint();
      await new Promise((resolve) => setTimeout(resolve, 2_500));
    }
    const expectedAbsent = [...this.agentNames, this.controller?.name].filter(Boolean);
    let existingNames = null;
    let leaked = expectedAbsent;
    const reconciliationDeadline = Date.now() + 120_000;
    while (Date.now() < reconciliationDeadline) {
      existingNames = await this.findExistingAgents(expectedAbsent).catch(() => null);
      if (existingNames) {
        leaked = existingNames;
        if (leaked.length === 0) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
    if (!existingNames) leaked = ['agent-exact-reconciliation-failed'];
    for (const resource of this.evidence.resources.filter(({ type }) => type === 'relay-agent')) {
      resource.cleanupState = leaked.includes(resource.id) ? 'leaked' : 'absent';
    }
    return { attempts, leaked, existingNames };
  }

  async deleteSandbox(resource) {
    if (
      !expectedOwnedSandboxNames(this.nonce).has(resource.nodeName) ||
      !['created-by-run', 'reconciled-absent-baseline'].includes(resource.ownership) ||
      this.baseline?.sandboxIdHashes?.includes(sha256(resource.id)) ||
      this.baseline?.sandboxNameHashes?.includes(sha256(resource.nodeName))
    ) {
      throw new Error(`Refusing cleanup of unauthorized Daytona sandbox ${resource.id}`);
    }
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const result = await execute(this.daytonaArgv('sandbox', 'delete', resource.id), { timeoutMs: 60_000 });
      this.evidence.cleanup.attempts.push({
        type: 'daytona-delete',
        target: resource.id,
        attempt,
        exitCode: result.exitCode,
        stderr: result.stderr,
      });
      const present = (await this.listDaytona()).some(({ id }) => id === resource.id);
      if (!present) {
        resource.cleanupState = result.exitCode === 0 ? 'deleted' : 'absent';
        await this.checkpoint();
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(10_000, attempt * 2_500)));
    }
    resource.cleanupState = 'leaked';
    await this.checkpoint();
    return false;
  }

  async cleanup() {
    const agentCleanup = await this.cleanupAgents().catch((error) => ({
      attempts: [{ type: 'agent-cleanup-error', error: redactFleetEvidence(error) }],
      leaked: ['cleanup-failed'],
      existingNames: null,
    }));
    this.evidence.cleanup.attempts.push(...agentCleanup.attempts);
    await this.record('agent-identity-reconciliation', async () => ({
      argv: this.cliArgv('agent', 'list'),
      exitCode: agentCleanup.leaked.length === 0 ? 0 : 1,
      timedOut: false,
      summary: `leakedExactAgentNames=${JSON.stringify(agentCleanup.leaked)}`,
    }));

    let sandboxesClean = true;
    for (const resource of this.evidence.resources.filter(
      ({ type, cleanupState }) => type === 'daytona-sandbox' && !['deleted', 'absent'].includes(cleanupState)
    )) {
      if (!['created-by-run', 'reconciled-absent-baseline'].includes(resource.ownership)) {
        resource.cleanupState = 'unowned-not-deleted';
        sandboxesClean = false;
        continue;
      }
      try {
        sandboxesClean = (await this.deleteSandbox(resource)) && sandboxesClean;
      } catch (error) {
        resource.cleanupState = 'unauthorized-not-deleted';
        this.evidence.cleanup.attempts.push({
          type: 'daytona-delete-refused',
          target: resource.id,
          error: redactFleetEvidence(error),
        });
        sandboxesClean = false;
      }
      await new Promise((resolve) => setTimeout(resolve, 2_500));
    }
    const finalSandboxes = await this.listDaytona();
    const leakedSandboxIds = this.evidence.resources
      .filter(({ type }) => type === 'daytona-sandbox')
      .map(({ id }) => id)
      .filter((id) => finalSandboxes.some((sandbox) => sandbox.id === id));
    await this.derived('owned-sandbox-cleanup', {
      argv: this.daytonaArgv('sandbox', 'list', '--format', 'json'),
      exitCode: sandboxesClean && leakedSandboxIds.length === 0 ? 0 : 1,
      summary: `leakedOwnedSandboxIds=${JSON.stringify(leakedSandboxIds)}`,
    });
    const exactPrefixLeaks = finalSandboxes
      .filter(
        ({ name }) =>
          typeof name === 'string' && name.includes(this.short) && name.startsWith('relay-fleetboard-')
      )
      .map(({ id, name }) => ({ id, name }));
    const finalSandboxIdHashes = new Set(finalSandboxes.map(({ id }) => sha256(id)));
    const finalSandboxNameHashes = new Set(finalSandboxes.map(({ name }) => sha256(name)));
    const finalAgentNames = await this.listAllWorkspaceAgentNames().catch(() => null);
    const finalAgentNameHashes = finalAgentNames
      ? new Set([...finalAgentNames].map((name) => sha256(name)))
      : null;
    const missingBaselineSandboxIdHashes = (this.baseline?.sandboxIdHashes ?? []).filter(
      (hash) => !finalSandboxIdHashes.has(hash)
    );
    const missingBaselineSandboxNameHashes = (this.baseline?.sandboxNameHashes ?? []).filter(
      (hash) => !finalSandboxNameHashes.has(hash)
    );
    const missingBaselineAgentNameHashes = finalAgentNameHashes
      ? (this.baseline?.agentNameHashes ?? []).filter((hash) => !finalAgentNameHashes.has(hash))
      : ['agent-list-reconciliation-failed'];
    const baselinePreserved =
      missingBaselineSandboxIdHashes.length === 0 &&
      missingBaselineSandboxNameHashes.length === 0 &&
      missingBaselineAgentNameHashes.length === 0;
    await this.derived('daytona-baseline-restored', {
      argv: this.daytonaArgv('sandbox', 'list', '--format', 'json'),
      exitCode: exactPrefixLeaks.length === 0 && baselinePreserved ? 0 : 1,
      summary: `baselineCount=${this.baseline?.count ?? 'unknown'} finalCount=${finalSandboxes.length} exactPrefixLeaks=${JSON.stringify(exactPrefixLeaks)} missingBaselineSandboxIdHashes=${JSON.stringify(missingBaselineSandboxIdHashes)} missingBaselineSandboxNameHashes=${JSON.stringify(missingBaselineSandboxNameHashes)} missingBaselineAgentNameHashes=${JSON.stringify(missingBaselineAgentNameHashes)}`,
    });
    this.evidence.cleanup.status =
      agentCleanup.leaked.length === 0 &&
      leakedSandboxIds.length === 0 &&
      exactPrefixLeaks.length === 0 &&
      baselinePreserved
        ? 'pass'
        : 'fail';
    this.evidence.cleanup.finishedAt = new Date().toISOString();
    await this.checkpoint();
  }

  async fillMissingOperations(reason) {
    for (const { id } of this.matrix.operations) {
      if (!this.evidence.operations.some((operation) => operation.id === id)) {
        await this.derived(id, { blockedReason: reason });
      }
    }
  }

  async run() {
    await this.checkpoint();
    let fatal;
    try {
      await this.captureProvenance();
      const baselineOperation = await this.record('daytona-baseline', async () => {
        const [list, agentNames, onlineAgentNames, fleetNodes] = await Promise.all([
          this.listDaytona(),
          this.listAllWorkspaceAgentNames(),
          this.listOnlineWorkspaceAgentNames(),
          this.listAllFleetNodes(),
        ]);
        const liveFleetNodes = fleetNodes.filter(({ live, status }) => live === true || status === 'online');
        this.baselineSandboxIds = new Set(list.map(({ id }) => id).filter(Boolean));
        this.baselineSandboxNames = new Set(list.map(({ name }) => name).filter(Boolean));
        this.baselineAgentNames = agentNames;
        this.baseline = {
          count: list.length,
          agentCount: agentNames.size,
          onlineAgentCount: onlineAgentNames.size,
          fleetNodeCount: fleetNodes.length,
          liveFleetNodeCount: liveFleetNodes.length,
          capturedAt: new Date().toISOString(),
          sandboxIdHashes: [...this.baselineSandboxIds].map(sha256).sort(),
          sandboxNameHashes: [...this.baselineSandboxNames].map(sha256).sort(),
          agentNameHashes: [...agentNames].map(sha256).sort(),
          fleetNodeNameHashes: fleetNodes
            .map(({ name }) => name)
            .filter((name) => typeof name === 'string' && name.length > 0)
            .map(sha256)
            .sort(),
        };
        this.evidence.baseline = this.baseline;
        const expectedWorkspaceId = this.evidence.environment.expectedWorkspaceId;
        const actualWorkspaceId = this.evidence.provenance?.resolvedWorkspaceId;
        const disposable = this.evidence.environment.policyMutationRequested;
        const clean =
          disposable &&
          typeof expectedWorkspaceId === 'string' &&
          expectedWorkspaceId.length > 0 &&
          actualWorkspaceId === expectedWorkspaceId &&
          agentNames.size === 0 &&
          onlineAgentNames.size === 0 &&
          fleetNodes.length === 0 &&
          liveFleetNodes.length === 0;
        this.evidence.environment.controlPlaneClean = clean;
        return {
          argv: this.daytonaArgv('sandbox', 'list', '--format', 'json'),
          exitCode: clean ? 0 : 1,
          timedOut: false,
          summary: `sandboxCount=${list.length} agentCount=${agentNames.size} onlineAgentCount=${onlineAgentNames.size} fleetNodeCount=${fleetNodes.length} liveFleetNodeCount=${liveFleetNodes.length} disposableWorkspaceAuthorized=${disposable} expectedWorkspaceMatches=${actualWorkspaceId === expectedWorkspaceId}`,
        };
      });
      if (baselineOperation.status !== 'pass') {
        throw new Error(
          'Fleet proof requires an explicitly expected disposable workspace with zero total/online Relay agents and zero total/live Fleet nodes'
        );
      }
      await this.registerController();
      await this.provisionBoardNode('a');
      await this.provisionBoardNode('b');
      await this.record('prove-distinct-fresh-daytona-nodes', async () => {
        const nodes = [this.nodeA, this.nodeB].filter((node) => node?.id);
        const distinctSandboxes = new Set(nodes.map(({ id }) => id)).size === 2;
        const distinctNodes = new Set(nodes.map(({ nodeId }) => nodeId)).size === 2;
        const fresh = nodes.every(
          ({ createdAt }) => Date.parse(createdAt) >= Date.parse(this.evidence.startedAt) - 5_000
        );
        const versions = nodes.map(({ snapshot, snapshotManifest }) =>
          this.evidence.environment.releaseQualificationRequested
            ? snapshotManifest?.packages?.['@agent-relay/sdk']
            : String(snapshot ?? '').match(/sdk-([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)/)?.[1]
        );
        const expectedRelayVersion = this.evidence.environment.expectedRelayVersion;
        const current = versions.every((version) => version === expectedRelayVersion);
        const expectedSnapshotId = this.evidence.environment.expectedSnapshotId;
        const expectedSnapshotName = this.evidence.environment.expectedSnapshotName;
        const expectedManifest = this.evidence.environment.expectedSnapshotManifestSha256;
        const snapshotIdentity =
          !this.evidence.environment.releaseQualificationRequested ||
          nodes.every(
            ({ observedSnapshotId, snapshot, snapshotManifest }) =>
              observedSnapshotId === expectedSnapshotId &&
              snapshot === expectedSnapshotName &&
              snapshotManifest?.sha256 === expectedManifest &&
              snapshotManifest?.snapshot?.name === expectedSnapshotName &&
              snapshotManifest?.snapshot?.mode === 'candidate' &&
              snapshotManifest?.packages?.['@agent-relay/sdk'] === expectedRelayVersion &&
              snapshotManifest?.promotion?.ssmWrite === false &&
              snapshotManifest?.promotion?.selectorWrite === false &&
              snapshotManifest?.promotion?.deploy === false
          );
        return {
          argv: this.daytonaArgv('sandbox', 'info', '<exact-owned-id>', '--format', 'json'),
          exitCode:
            nodes.length === 2 && distinctSandboxes && distinctNodes && fresh && current && snapshotIdentity
              ? 0
              : 1,
          timedOut: false,
          summary: `nodes=${nodes.length} distinctSandboxes=${distinctSandboxes} distinctNodes=${distinctNodes} fresh=${fresh} immutableSnapshotIdProven=${nodes.every(({ observedSnapshotId }) => observedSnapshotId === expectedSnapshotId)} snapshotRelayVersions=${JSON.stringify(versions)} required=${expectedRelayVersion} snapshotIdentity=${snapshotIdentity}`,
        };
      });
      await this.injectionCases();
      await this.simpleFleetCommands();
      await this.nodeObservability();
      await this.releaseInitialWorkers();
      await this.targetedFleetSpawns();
      await this.fleetProviderMatrix();
      await this.mountedSandboxCases();
      await this.fleetPolicyAndStatus();
      await this.nodeSpawnMatrix();
      await this.criticalLifecycleRepeatability();
      await this.nodeWorkflows();
      await this.fleetReleaseCases();
      await this.nodeLifecycle();
    } catch (error) {
      fatal = error;
      this.evidence.fatalError = redactFleetEvidence(error instanceof Error ? error.stack : String(error));
      await this.checkpoint();
    } finally {
      try {
        await this.cleanup();
      } catch (error) {
        this.evidence.cleanup.status = 'fail';
        this.evidence.cleanup.error = redactFleetEvidence(
          error instanceof Error ? error.stack : String(error)
        );
      }
      if (this.evidence.criticalLifecycle.status === 'pending') {
        this.evidence.criticalLifecycle = {
          ...this.evidence.criticalLifecycle,
          status: 'blocked',
          blockedReason: fatal
            ? 'campaign aborted before critical lifecycle repeatability'
            : 'critical lifecycle repeatability was not reached',
        };
      }
      await this.fillMissingOperations(
        fatal ? 'campaign aborted after fatal runner error' : 'operation was not reached'
      );
      this.evidence.finishedAt = new Date().toISOString();
      this.evidence.verdict = deriveFleetVerdict(
        this.evidence.operations,
        this.evidence.cleanup,
        this.evidence.criticalLifecycle
      );
      await this.checkpoint();
    }
    return this.evidence;
  }
}

function artifactDirFor(matrix, nonce) {
  return path.resolve(matrix.artifactRoot, nonce);
}

async function readEvidence(matrix, nonce) {
  return JSON.parse(await readFile(path.join(artifactDirFor(matrix, nonce), 'evidence.json'), 'utf8'));
}

async function activeArtifactSnapshot(matrixPath, artifactDir) {
  const [evidenceBytes, matrixBytes, runnerBytes] = await Promise.all([
    readFile(path.join(artifactDir, 'evidence.json')),
    readFile(path.resolve(matrixPath)),
    readFile(fileURLToPath(import.meta.url)),
  ]);
  return {
    evidenceBytes,
    matrixBytes,
    runnerBytes,
    digests: {
      evidenceSha256: sha256Bytes(evidenceBytes),
      matrixSha256: sha256Bytes(matrixBytes),
      runnerSha256: sha256Bytes(runnerBytes),
    },
  };
}

async function activeArtifactDigests(matrixPath, artifactDir) {
  return (await activeArtifactSnapshot(matrixPath, artifactDir)).digests;
}

export function validateSeal(seal, nonce, digests) {
  assertObject(seal, 'seal');
  if (
    seal.version !== CONTRACT_VERSION ||
    seal.kind !== 'fleet-daytona-evidence-seal' ||
    seal.nonce !== nonce
  ) {
    throw new Error('evidence seal identity is invalid');
  }
  for (const key of ['evidenceSha256', 'matrixSha256', 'runnerSha256']) {
    if (!/^[0-9a-f]{64}$/.test(seal[key] ?? '')) throw new Error(`seal.${key} is invalid`);
    if (seal[key] !== digests[key]) throw new Error(`sealed ${key} no longer matches the active artifact`);
  }
  if (!Number.isFinite(Date.parse(seal.createdAt))) throw new Error('seal.createdAt is invalid');
  return seal;
}

function isPermissionPlaceholder(value, nonce, file) {
  return (
    value?.version === CONTRACT_VERSION &&
    value?.kind === 'fleet-daytona-permission-placeholder' &&
    value?.nonce === nonce &&
    value?.file === file
  );
}

async function readAndValidateSeal(matrixPath, artifactDir, nonce) {
  const [rawSeal, snapshot] = await Promise.all([
    readFile(path.join(artifactDir, 'seal.json'), 'utf8'),
    activeArtifactSnapshot(matrixPath, artifactDir),
  ]);
  return validateSeal(JSON.parse(rawSeal), nonce, snapshot.digests);
}

function campaignReviewSeal(seal) {
  return {
    evidenceSha256: seal.campaignSha256,
    matrixSha256: seal.matrixSha256,
    runnerSha256: seal.runnerSha256,
  };
}

export async function readAndValidateCampaign(matrixPath, matrix, artifactDir, nonce) {
  const [campaignBytes, rawSeal, matrixBytes, runnerBytes] = await Promise.all([
    readFile(path.join(artifactDir, 'campaign.json')),
    readFile(path.join(artifactDir, 'campaign-seal.json'), 'utf8'),
    readFile(matrixPath),
    readFile(fileURLToPath(import.meta.url)),
  ]);
  const campaign = assertObject(JSON.parse(campaignBytes.toString('utf8')), 'campaign');
  const seal = assertObject(JSON.parse(rawSeal), 'campaign seal');
  if (
    campaign.version !== CONTRACT_VERSION ||
    campaign.kind !== 'fleet-daytona-reliability-campaign' ||
    campaign.nonce !== nonce ||
    seal.version !== CONTRACT_VERSION ||
    seal.kind !== 'fleet-daytona-campaign-seal' ||
    seal.nonce !== nonce
  ) {
    throw new Error('campaign identity is invalid');
  }
  const expected = {
    campaignSha256: sha256Bytes(campaignBytes),
    matrixSha256: sha256Bytes(matrixBytes),
    runnerSha256: sha256Bytes(runnerBytes),
  };
  for (const [key, value] of Object.entries(expected)) {
    if (seal[key] !== value) throw new Error(`campaign seal ${key} does not match`);
  }
  if (!Array.isArray(campaign.attempts) || campaign.attempts.length < 2) {
    throw new Error('campaign must contain at least two sealed attempts');
  }
  if (
    !Array.isArray(seal.attemptEvidenceSha256) ||
    seal.attemptEvidenceSha256.length !== campaign.attempts.length
  ) {
    throw new Error('campaign seal attempt list is incomplete');
  }
  const attempts = [];
  for (const [index, record] of campaign.attempts.entries()) {
    assertObject(record, `campaign.attempts[${index}]`);
    const attemptNonce = assertSafeId(record.nonce, `campaign.attempts[${index}].nonce`);
    const attemptArtifactDir = artifactDirFor(matrix, attemptNonce);
    const evidenceBytes = await readFile(path.join(attemptArtifactDir, 'evidence.json'));
    const evidence = validateFleetEvidence(JSON.parse(evidenceBytes.toString('utf8')), matrix);
    const attemptSeal = await readAndValidateSeal(matrixPath, attemptArtifactDir, attemptNonce);
    const evidenceSha256 = sha256Bytes(evidenceBytes);
    const sealedRecord = seal.attemptEvidenceSha256[index];
    if (
      evidence.nonce !== attemptNonce ||
      attemptSeal.evidenceSha256 !== evidenceSha256 ||
      record.evidenceSha256 !== evidenceSha256 ||
      sealedRecord?.nonce !== attemptNonce ||
      sealedRecord?.evidenceSha256 !== evidenceSha256
    ) {
      throw new Error(`campaign attempt ${attemptNonce} is not bound to its sealed evidence`);
    }
    attempts.push({ nonce: attemptNonce, evidence, evidenceSha256 });
  }
  const recomputed = { nonce, ...summarizeFleetCampaign(attempts, matrix) };
  recomputed.createdAt = campaign.createdAt;
  if (JSON.stringify(recomputed) !== JSON.stringify(campaign)) {
    throw new Error('campaign summary no longer matches its sealed attempt evidence');
  }
  return { campaign, seal, reviewSeal: campaignReviewSeal(seal), attempts };
}

async function readReviewTarget(matrixPath, matrix, artifactDir, nonce, scope) {
  if (scope === 'campaign') {
    return readAndValidateCampaign(matrixPath, matrix, artifactDir, nonce);
  }
  if (scope !== 'evidence') throw new Error('--scope must be evidence or campaign');
  const seal = await readAndValidateSeal(matrixPath, artifactDir, nonce);
  return { seal, reviewSeal: seal };
}

function sanitizeJsonStrings(value) {
  if (typeof value === 'string') return redactFleetEvidence(value);
  if (Array.isArray(value)) return value.map(sanitizeJsonStrings);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitizeJsonStrings(entry)]));
  }
  return value;
}

export function validateReview(review, role, kind, seal) {
  assertObject(review, 'review');
  if (review.version !== CONTRACT_VERSION || review.role !== role || review.kind !== kind) {
    throw new Error('review identity contract is invalid');
  }
  for (const key of ['evidenceSha256', 'matrixSha256', 'runnerSha256']) {
    if (review[key] !== seal[key]) throw new Error(`review.${key} does not match the evidence seal`);
  }
  if (!['COMPREHENSIVELY_SATISFIED', 'FINDINGS', 'BLOCKED'].includes(review.verdict)) {
    throw new Error('review verdict is invalid');
  }
  for (const key of ['deterministicEvidence', 'remainingRisks', 'findings']) {
    if (!Array.isArray(review[key])) throw new Error(`review.${key} must be an array`);
  }
  if (
    review.verdict === 'COMPREHENSIVELY_SATISFIED' &&
    (!review.whyPassed || !review.endToEndWiringVerified)
  ) {
    throw new Error('satisfied review requires whyPassed and endToEndWiringVerified');
  }
  for (const [index, finding] of review.findings.entries()) {
    assertObject(finding, `review.findings[${index}]`);
    for (const key of ['findingId', 'file', 'issue', 'fixRequired', 'testRequired', 'evidence']) {
      if (typeof finding[key] !== 'string' || !finding[key].trim()) {
        throw new Error(`review.findings[${index}].${key} must be non-empty`);
      }
    }
    if (!['critical', 'high', 'medium', 'low'].includes(finding.severity)) {
      throw new Error(`review.findings[${index}].severity is invalid`);
    }
    if (!['open', 'resolved', 'accepted-risk'].includes(finding.status)) {
      throw new Error(`review.findings[${index}].status is invalid`);
    }
  }
  if (
    review.verdict === 'COMPREHENSIVELY_SATISFIED' &&
    review.findings.some(({ status }) => status === 'open')
  ) {
    throw new Error('satisfied review cannot contain open findings');
  }
  return review;
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  const matrixPath = path.resolve(options.matrix ?? DEFAULT_MATRIX);
  const matrix = await loadFleetMatrix(matrixPath);
  if (command === 'validate') {
    process.stdout.write(`FLEET_DAYTONA_MATRIX_VALID operations=${matrix.operations.length}\n`);
    return;
  }
  if (['run', 'cleanup'].includes(command)) {
    const credentialEnv = options['workspace-credential-env'];
    if (credentialEnv !== undefined) {
      if (!/^VERIFY_FLEET_WORKSPACE_KEY_FILE_[AB]$/.test(credentialEnv)) {
        throw new Error('--workspace-credential-env must name the fixed A or B credential input');
      }
      const credentialFile = process.env[credentialEnv]?.trim();
      if (!credentialFile) throw new Error(`${credentialEnv} is required`);
      process.env.VERIFY_FLEET_WORKSPACE_KEY_FILE = credentialFile;
      delete process.env.VERIFY_FLEET_EXPECTED_WORKSPACE_ID;
    }
    await loadWorkspaceCredentialFile();
  }
  const nonce = assertSafeId(requiredOption(options, 'nonce'), 'nonce');
  const artifactDir = artifactDirFor(matrix, nonce);
  if (command === 'aggregate') {
    const attemptNonces = requiredOption(options, 'attempts')
      .split(',')
      .map((value) => assertSafeId(value.trim(), 'attempt nonce'));
    const attempts = [];
    for (const attemptNonce of attemptNonces) {
      const attemptArtifactDir = artifactDirFor(matrix, attemptNonce);
      const evidencePath = path.join(attemptArtifactDir, 'evidence.json');
      const evidenceBytes = await readFile(evidencePath);
      const evidence = validateFleetEvidence(JSON.parse(evidenceBytes.toString('utf8')), matrix);
      if (evidence.nonce !== attemptNonce) {
        throw new Error(`attempt ${attemptNonce} evidence nonce does not match its artifact directory`);
      }
      const seal = await readAndValidateSeal(matrixPath, attemptArtifactDir, attemptNonce);
      if (seal.evidenceSha256 !== sha256Bytes(evidenceBytes)) {
        throw new Error(`attempt ${attemptNonce} evidence does not match its validated seal`);
      }
      attempts.push({
        nonce: attemptNonce,
        evidence,
        evidenceSha256: sha256Bytes(evidenceBytes),
        seal,
      });
    }
    const campaign = { nonce, ...summarizeFleetCampaign(attempts, matrix) };
    const campaignBytes = Buffer.from(`${JSON.stringify(campaign, null, 2)}\n`);
    const [matrixBytes, runnerBytes] = await Promise.all([
      readFile(matrixPath),
      readFile(fileURLToPath(import.meta.url)),
    ]);
    await mkdir(artifactDir, { recursive: true });
    for (const file of ['campaign.json', 'campaign-seal.json']) {
      const target = path.join(artifactDir, file);
      try {
        const existing = JSON.parse(await readFile(target, 'utf8'));
        if (!isPermissionPlaceholder(existing, nonce, file)) {
          throw new Error(`Refusing to overwrite existing Fleet campaign artifact ${file}`);
        }
        await unlink(target);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    await writePrivateAtomicExclusive(path.join(artifactDir, 'campaign.json'), campaignBytes);
    const campaignSeal = {
      version: CONTRACT_VERSION,
      kind: 'fleet-daytona-campaign-seal',
      nonce,
      campaignSha256: sha256Bytes(campaignBytes),
      matrixSha256: sha256Bytes(matrixBytes),
      runnerSha256: sha256Bytes(runnerBytes),
      attemptEvidenceSha256: attempts.map(({ nonce: attemptNonce, evidenceSha256 }) => ({
        nonce: attemptNonce,
        evidenceSha256,
      })),
      createdAt: new Date().toISOString(),
    };
    await writePrivateAtomicExclusive(
      path.join(artifactDir, 'campaign-seal.json'),
      `${JSON.stringify(campaignSeal, null, 2)}\n`
    );
    process.stdout.write(
      `FLEET_DAYTONA_CAMPAIGN_COMPLETE nonce=${nonce} attempts=${attempts.length} verdict=${campaign.verdict}\n`
    );
    return;
  }
  if (command === 'gate-campaign') {
    const { campaign } = await readAndValidateCampaign(matrixPath, matrix, artifactDir, nonce);
    process.stdout.write(`FLEET_DAYTONA_CAMPAIGN_VALID nonce=${nonce} verdict=${campaign.verdict}\n`);
    return;
  }
  if (command === 'run') {
    await mkdir(artifactDir, { recursive: true });
    const evidencePath = path.join(artifactDir, 'evidence.json');
    try {
      const existing = JSON.parse(await readFile(evidencePath, 'utf8'));
      if (!isPermissionPlaceholder(existing, nonce, 'evidence.json')) {
        throw new Error(`Refusing to overwrite existing fleet-board evidence for nonce ${nonce}`);
      }
      await unlink(evidencePath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const lockPath = path.join(artifactDir, '.run.lock');
    const lock = await open(lockPath, 'wx', 0o600);
    try {
      await lock.writeFile(
        `${JSON.stringify({ nonce, pid: process.pid, startedAt: new Date().toISOString() })}\n`
      );
      await lock.sync();
      const board = new FleetBoard(matrix, nonce, artifactDir);
      const evidence = await board.run();
      process.stdout.write(
        `FLEET_DAYTONA_COMPLETE nonce=${nonce} verdict=${evidence.verdict} artifact=${path.join(artifactDir, 'evidence.json')}\n`
      );
    } finally {
      await lock.close();
      await unlink(lockPath).catch(() => undefined);
    }
    return;
  }
  if (command === 'cleanup') {
    const evidence = validateRecoveryEvidence(await readEvidence(matrix, nonce), matrix, nonce);
    const board = new FleetBoard(matrix, nonce, artifactDir);
    board.evidence = evidence;
    board.agentNames = new Set(
      evidence.resources.filter(({ type }) => type === 'relay-agent').map(({ id }) => id)
    );
    board.baseline = evidence.baseline ?? null;
    board.evidence.cleanup ??= { status: 'pending', attempts: [] };
    board.evidence.cleanup.status = 'pending';
    board.evidence.operations = board.evidence.operations.filter(
      ({ id }) =>
        !['agent-identity-reconciliation', 'owned-sandbox-cleanup', 'daytona-baseline-restored'].includes(id)
    );
    const controller = evidence.resources.find(
      ({ type, role }) => type === 'relay-agent' && role === 'controller'
    );
    board.controller = controller ? { name: controller.id, token: '' } : null;
    await board.cleanup();
    board.evidence.verdict = deriveFleetVerdict(
      board.evidence.operations,
      board.evidence.cleanup,
      board.evidence.criticalLifecycle
    );
    await board.checkpoint();
    if (board.evidence.cleanup.status !== 'pass') {
      throw new Error(`Fleet Daytona cleanup failed for nonce ${nonce}`);
    }
    process.stdout.write(`FLEET_DAYTONA_CLEANUP_COMPLETE nonce=${nonce}\n`);
    return;
  }
  if (command === 'gate') {
    const snapshot = await activeArtifactSnapshot(matrixPath, artifactDir);
    const snapshotMatrix = validateFleetMatrix(JSON.parse(snapshot.matrixBytes.toString('utf8')));
    const evidence = validateFleetEvidence(
      JSON.parse(snapshot.evidenceBytes.toString('utf8')),
      snapshotMatrix
    );
    if (evidence.nonce !== nonce) {
      throw new Error('evidence nonce does not match the requested artifact nonce');
    }
    const digests = snapshot.digests;
    const sealPath = path.join(artifactDir, 'seal.json');
    let seal;
    try {
      const existing = JSON.parse(await readFile(sealPath, 'utf8'));
      if (isPermissionPlaceholder(existing, nonce, 'seal.json')) {
        seal = {
          version: CONTRACT_VERSION,
          kind: 'fleet-daytona-evidence-seal',
          nonce,
          ...digests,
          createdAt: new Date().toISOString(),
        };
        await writePrivateAtomic(sealPath, `${JSON.stringify(seal, null, 2)}\n`);
      } else {
        seal = validateSeal(existing, nonce, digests);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      seal = {
        version: CONTRACT_VERSION,
        kind: 'fleet-daytona-evidence-seal',
        nonce,
        ...digests,
        createdAt: new Date().toISOString(),
      };
      await writePrivateAtomic(sealPath, `${JSON.stringify(seal, null, 2)}\n`);
    }
    validateSeal(seal, nonce, await activeArtifactDigests(matrixPath, artifactDir));
    process.stdout.write(`FLEET_DAYTONA_EVIDENCE_VALID nonce=${nonce} verdict=${evidence.verdict}\n`);
    return;
  }
  if (command === 'show') {
    const kind = options.kind ?? 'evidence';
    const filename = ['evidence', 'seal', 'signoff', 'campaign'].includes(kind)
      ? `${kind}.json`
      : `review-${assertSafeId(kind, 'kind')}.json`;
    process.stdout.write(await readFile(path.join(artifactDir, filename), 'utf8'));
    return;
  }
  if (command === 'review-upload') {
    const role = assertSafeId(requiredOption(options, 'role'), 'role');
    const kind = assertSafeId(requiredOption(options, 'review-kind'), 'review-kind');
    const inputPath = path.resolve(requiredOption(options, 'file'));
    const expectedInputPath = path.join(artifactDir, `draft-${role}.json`);
    if (inputPath !== expectedInputPath) {
      throw new Error(`review input must be the role's exact draft path: ${expectedInputPath}`);
    }
    const scope = options.scope ?? 'evidence';
    const { reviewSeal } = await readReviewTarget(matrixPath, matrix, artifactDir, nonce, scope);
    const review = validateReview(
      sanitizeJsonStrings(JSON.parse(await readFile(inputPath, 'utf8'))),
      role,
      kind,
      reviewSeal
    );
    review.scope = scope;
    await mkdir(artifactDir, { recursive: true });
    await writePrivateAtomic(
      path.join(artifactDir, `review-${role}.json`),
      `${JSON.stringify(review, null, 2)}\n`
    );
    process.stdout.write(`FLEET_DAYTONA_REVIEW_UPLOADED role=${role}\n`);
    return;
  }
  if (command === 'gate-review') {
    const role = assertSafeId(requiredOption(options, 'role'), 'role');
    const kind = assertSafeId(requiredOption(options, 'review-kind'), 'review-kind');
    const scope = options.scope ?? 'evidence';
    const { reviewSeal } = await readReviewTarget(matrixPath, matrix, artifactDir, nonce, scope);
    const review = validateReview(
      JSON.parse(await readFile(path.join(artifactDir, `review-${role}.json`), 'utf8')),
      role,
      kind,
      reviewSeal
    );
    if (review.scope !== scope) throw new Error('review scope does not match the requested target');
    process.stdout.write(`FLEET_DAYTONA_REVIEW_VALID role=${role} verdict=${review.verdict}\n`);
    return;
  }
  if (command === 'finalize') {
    const claudeRole = assertSafeId(requiredOption(options, 'claude-role'), 'claude-role');
    const codexRole = assertSafeId(requiredOption(options, 'codex-role'), 'codex-role');
    const scope = options.scope ?? 'evidence';
    const { reviewSeal } = await readReviewTarget(matrixPath, matrix, artifactDir, nonce, scope);
    const reviews = [];
    for (const role of [claudeRole, codexRole]) {
      const review = JSON.parse(await readFile(path.join(artifactDir, `review-${role}.json`), 'utf8'));
      const validated = validateReview(review, role, 'review', reviewSeal);
      if (validated.scope !== scope) throw new Error(`review ${role} has the wrong scope`);
      reviews.push(validated);
    }
    const signed = reviews.every(({ verdict }) => verdict === 'COMPREHENSIVELY_SATISFIED');
    const signoff = {
      version: CONTRACT_VERSION,
      nonce,
      scope,
      signed,
      evidenceSha256: reviewSeal.evidenceSha256,
      matrixSha256: reviewSeal.matrixSha256,
      runnerSha256: reviewSeal.runnerSha256,
      reviewers: reviews.map(({ role, verdict }) => ({ role, verdict })),
      createdAt: new Date().toISOString(),
    };
    await writePrivateAtomic(path.join(artifactDir, 'signoff.json'), `${JSON.stringify(signoff, null, 2)}\n`);
    if (!signed) throw new Error('independent reviewers did not both sign off on evidence integrity');
    process.stdout.write(`FLEET_DAYTONA_SIGNOFF_COMPLETE nonce=${nonce}\n`);
    return;
  }
  if (command === 'enforce') {
    const scope = options.scope ?? 'evidence';
    const target = await readReviewTarget(matrixPath, matrix, artifactDir, nonce, scope);
    const reviewSeal = target.reviewSeal;
    const signoff = assertObject(
      JSON.parse(await readFile(path.join(artifactDir, 'signoff.json'), 'utf8')),
      'signoff'
    );
    if (
      signoff.version !== CONTRACT_VERSION ||
      signoff.nonce !== nonce ||
      signoff.scope !== scope ||
      signoff.signed !== true
    ) {
      throw new Error('independent signoff identity is invalid or unsigned');
    }
    for (const key of ['evidenceSha256', 'matrixSha256', 'runnerSha256']) {
      if (signoff[key] !== reviewSeal[key]) {
        throw new Error(`signoff.${key} does not match the ${scope} seal`);
      }
    }
    if (
      !Array.isArray(signoff.reviewers) ||
      signoff.reviewers.length !== 2 ||
      !signoff.reviewers.some(({ role }) => role.includes('claude')) ||
      !signoff.reviewers.some(({ role }) => role.includes('codex')) ||
      signoff.reviewers.some(({ verdict }) => verdict !== 'COMPREHENSIVELY_SATISFIED')
    ) {
      throw new Error('signoff requires one satisfied Claude review and one satisfied Codex review');
    }
    for (const { role } of signoff.reviewers) {
      const review = JSON.parse(await readFile(path.join(artifactDir, `review-${role}.json`), 'utf8'));
      validateReview(review, role, 'review', reviewSeal);
      if (review.scope !== scope) throw new Error(`review ${role} has the wrong scope`);
    }
    const verdict =
      scope === 'campaign'
        ? target.campaign.verdict
        : validateFleetEvidence(await readEvidence(matrix, nonce), matrix).verdict;
    if (verdict !== 'GREEN') throw new Error(`Relay Fleet ${scope} verdict is ${verdict}`);
    process.stdout.write(`FLEET_DAYTONA_PRODUCT_GREEN nonce=${nonce}\n`);
    return;
  }
  throw new Error(`Unknown command: ${command ?? '(missing)'}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `[fleet-daytona] ${redactFleetEvidence(error instanceof Error ? error.stack : String(error))}\n`
    );
    process.exitCode = 2;
  });
}

export { FleetBoard };
