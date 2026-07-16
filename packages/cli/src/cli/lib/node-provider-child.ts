import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { CoreDependencies, SpawnedProcess } from '../commands/core.js';

/**
 * Credentials handed to an out-of-process node provider, mirroring the env
 * contract the Python provider already uses.
 */
export type NodeProviderCredentials = {
  nodeToken: string;
  baseUrl?: string;
  nodeId: string;
  nodeName: string;
  workspaceKey?: string;
};

/**
 * Bootstrap executed by a child `node` process to serve a JS/TS fleet node
 * definition.
 *
 * Why this exists: a `bun build --compile` binary cannot resolve a bare package
 * specifier out of a user's on-disk `node_modules` when the package's entry
 * point lives in a subdirectory (`dist/`, `lib/`) rather than at the package
 * root — which is every package built from TypeScript, `@agent-relay/factory`
 * and `@agent-relay/fleet` included. So importing a node config inside the
 * shipped binary fails on the config's own `@agent-relay/factory/node` import,
 * and the failure is transitive through the user's whole dependency graph, so
 * no entry-point-only resolution fix can work.
 *
 * Node resolves bare specifiers relative to the *importing file*, so importing
 * the config by absolute path from this bootstrap (wherever the bootstrap
 * itself lives) resolves the config's imports against the config's own
 * `node_modules`, exactly as a plain `node` run would.
 *
 * Kept as source text rather than a shipped file because the compiled binary
 * has no `dist/` on disk to point `node` at; it is materialized to a temp file
 * at spawn time.
 *
 * `@agent-relay/fleet` and `@agent-relay/sdk` are resolved from the *config's*
 * directory — the only copies on disk, since the compiled binary's own are
 * sealed inside it — mirroring how the Python provider uses the user's own SDK.
 * That makes the user's fleet version part of the contract: `serveNode`'s
 * connection shape changed in fleet 10 (`{nodeToken, nodeId}`; fleet 9 took
 * `{url, apiKey}`), so an older fleet is rejected up front rather than left to
 * fail as an endless reconnect loop against a URL it never received.
 */
export const NODE_PROVIDER_CHILD_SOURCE = String.raw`
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const configPath = process.argv[2];
const describeOnly = process.argv.includes('--describe');

const fail = (message) => {
  console.error('[agent-relay] node provider: ' + message);
  process.exit(2);
};

if (!configPath) {
  fail('missing config path argument.');
}

const isDefinition = (value) =>
  Boolean(value && typeof value === 'object' && value.__agentRelayFleetNode === true);

const unwrap = (loaded) => {
  let candidate = loaded;
  for (let depth = 0; depth < 3; depth += 1) {
    if (isDefinition(candidate)) return candidate;
    if (!candidate || typeof candidate !== 'object' || !('default' in candidate)) return candidate;
    candidate = candidate.default;
  }
  return candidate;
};

const requireFromConfig = createRequire(configPath);
const importFromConfig = async (specifier) =>
  import(pathToFileURL(requireFromConfig.resolve(specifier)).href);

const errorText = (err) => (err && (err.stack || err.message)) || String(err);

let definition;
try {
  definition = unwrap(await import(pathToFileURL(configPath).href));
} catch (err) {
  fail('failed to load ' + configPath + ': ' + errorText(err));
}

if (!isDefinition(definition)) {
  fail(configPath + ' must default-export defineNode(...)');
}

// Describe mode: report the definition's identity/capability names so the CLI can
// advertise spawn:<harness> capacity and fail fast on a bad explicit --config
// without ever loading the definition in-process. Marker-prefixed and read from
// the last matching line, so a config that prints on import cannot corrupt it.
if (describeOnly) {
  const descriptor = {
    name: definition.name,
    capabilities: Object.keys(definition.capabilities || {}),
    ...(typeof definition.maxAgents === 'number' ? { maxAgents: definition.maxAgents } : {}),
  };
  console.log('__AGENT_RELAY_NODE_DESCRIPTOR__' + JSON.stringify(descriptor));
  process.exit(0);
}

// Only serving needs the fleet runtime; describing must not require it, so a
// config can be validated even where @agent-relay/fleet is not installed.
let fleetEntry;
try {
  fleetEntry = requireFromConfig.resolve('@agent-relay/fleet');
} catch (err) {
  fail(
    "cannot resolve '@agent-relay/fleet' from " +
      configPath +
      '. Install it alongside your node config (npm i @agent-relay/fleet). Cause: ' +
      errorText(err)
  );
}

// serveNode's connection contract below is fleet >=10 ({nodeToken, nodeId}).
// Fleet 9 took {url, apiKey} and would silently reconnect forever instead.
const fleetRoot = fleetEntry.slice(
  0,
  fleetEntry.lastIndexOf('@agent-relay/fleet') + '@agent-relay/fleet'.length
);
let fleetVersion;
try {
  fleetVersion = requireFromConfig(fleetRoot + '/package.json').version;
} catch {
  // Version unreadable (exports-gated package.json): proceed rather than block
  // an install that may well work.
}
const fleetMajor = Number.parseInt(String(fleetVersion).split('.')[0], 10);
if (Number.isFinite(fleetMajor) && fleetMajor < 10) {
  fail(
    'the @agent-relay/fleet installed next to ' +
      configPath +
      ' is v' +
      fleetVersion +
      ', which cannot be served by this CLI (needs >=10). Upgrade it: npm i @agent-relay/fleet@latest'
  );
}

let fleet;
try {
  fleet = await import(pathToFileURL(fleetEntry).href);
} catch (err) {
  fail('failed to load @agent-relay/fleet from ' + configPath + ': ' + errorText(err));
}

const env = process.env;
const nodeToken = env.RELAY_NODE_TOKEN;
const nodeId = env.RELAY_NODE_ID;
const nodeName = env.RELAY_NODE_NAME;
const baseUrl = env.RELAY_BASE_URL && env.RELAY_BASE_URL.trim();
const workspaceKey = env.RELAY_WORKSPACE_KEY && env.RELAY_WORKSPACE_KEY.trim();

if (!nodeToken || !nodeId) {
  fail('RELAY_NODE_TOKEN and RELAY_NODE_ID are required.');
}

let triggers;
if (workspaceKey) {
  try {
    const { AgentRelay } = await importFromConfig('@agent-relay/sdk');
    const relay = new AgentRelay({ workspaceKey, ...(baseUrl ? { baseUrl } : {}) });
    triggers = {
      list: () => relay.triggers.list(),
      create: (input) => relay.triggers.create(input),
      update: (id, input) => relay.triggers.update(id, input),
      delete: (id) => relay.triggers.delete(id),
    };
  } catch (err) {
    console.warn(
      '[agent-relay] node provider: message triggers will not sync (' + errorText(err) + ').'
    );
  }
}

const stopSignal = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => stopSignal.abort());
}

try {
  await fleet.serveNode({
    definition,
    connection: { nodeToken, nodeId, ...(baseUrl ? { baseUrl } : {}) },
    ...(nodeName ? { nameOverride: nodeName } : {}),
    providerName: definition.name,
    ...(triggers ? { triggers } : {}),
    reconnect: true,
    signal: stopSignal.signal,
    log: (message) => console.log('[agent-relay][node] ' + message),
    warn: (message) => console.warn('[agent-relay][node] ' + message),
  });
} catch (err) {
  if (!stopSignal.signal.aborted) {
    fail('serving ' + configPath + ' failed: ' + errorText(err));
  }
}
`;

/** Marker the child prints its descriptor JSON behind, so config output can't corrupt it. */
export const NODE_DESCRIPTOR_MARKER = '__AGENT_RELAY_NODE_DESCRIPTOR__';

/**
 * What the CLI learns about a node definition it never loads in-process:
 * enough to advertise capacity and to validate an explicit `--config`.
 */
export type NodeDefinitionDescriptor = {
  name: string;
  capabilities: string[];
  maxAgents?: number;
};

/**
 * Parse the descriptor a `--describe` child printed.
 * @param stdout - Raw child stdout, which may contain the config's own output.
 * @returns The descriptor, or `undefined` when no marker line was produced.
 */
export function parseNodeDescriptor(stdout: string): NodeDefinitionDescriptor | undefined {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith(NODE_DESCRIPTOR_MARKER));
  const last = lines.at(-1);
  if (!last) {
    return undefined;
  }
  const parsed = JSON.parse(last.slice(NODE_DESCRIPTOR_MARKER.length)) as NodeDefinitionDescriptor;
  return {
    name: parsed.name,
    capabilities: Array.isArray(parsed.capabilities) ? parsed.capabilities : [],
    ...(typeof parsed.maxAgents === 'number' ? { maxAgents: parsed.maxAgents } : {}),
  };
}

/**
 * Adapt a descriptor to the capacity shape, so a node definition served
 * out-of-process still contributes its `spawn:<harness>` capabilities to the
 * broker's advertised capacity.
 * @param descriptor - Descriptor reported by the `--describe` child.
 */
export function descriptorCapacitySource(descriptor: NodeDefinitionDescriptor): {
  capabilities: Record<string, unknown>;
} {
  return { capabilities: Object.fromEntries(descriptor.capabilities.map((name) => [name, true])) };
}

/**
 * File extensions served through a child `node` process when the CLI itself is
 * a `bun build --compile` binary.
 */
const JS_NODE_DEFINITION_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']);

/** Whether `configPath` is a JS/TS node definition (as opposed to `agent-relay.py`). */
export function isJsNodeDefinition(configPath: string): boolean {
  return JS_NODE_DEFINITION_EXTENSIONS.has(path.extname(configPath).toLowerCase());
}

/**
 * Write the child bootstrap to a temp file so a child `node` process has
 * something on disk to execute. The compiled binary has no `dist/` on disk, so
 * the source is materialized per run.
 * @param mkdtemp - Temp-dir factory, injectable for tests.
 * @returns Absolute path to the materialized bootstrap module.
 */
export function materializeNodeProviderChildScript(
  mkdtemp: (prefix: string) => string = (prefix) => fs.mkdtempSync(prefix)
): string {
  const dir = mkdtemp(path.join(os.tmpdir(), 'agent-relay-node-provider-'));
  const file = path.join(dir, 'node-provider-child.mjs');
  fs.writeFileSync(file, NODE_PROVIDER_CHILD_SOURCE, 'utf8');
  return file;
}

/** Single-quote a path for safe interpolation into a shell command. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Load a node definition's descriptor by running the bootstrap in `--describe`
 * mode under a child `node` process.
 *
 * This is how the compiled binary learns anything at all about a JS/TS node
 * definition: it cannot import one itself (scoped specifiers in the user's
 * `node_modules` do not resolve under `bun build --compile`), so it asks Node.
 *
 * @param configPath - Absolute path to the user's node definition file.
 * @param deps - Core dependencies (exec, env).
 * @returns The descriptor.
 * @throws When the child cannot load or validate the definition.
 */
export async function describeNodeDefinitionViaNode(
  configPath: string,
  deps: CoreDependencies
): Promise<NodeDefinitionDescriptor> {
  const nodeBin = deps.env.AGENT_RELAY_NODE?.trim() || 'node';
  const script = materializeNodeProviderChildScript();
  const command = `${shellQuote(nodeBin)} ${shellQuote(script)} ${shellQuote(configPath)} --describe`;

  let stdout: string;
  try {
    ({ stdout } = await deps.execCommand(command));
  } catch (err) {
    const detail = extractChildFailure(err);
    throw new Error(
      `Failed to load ${configPath} via ${nodeBin}: ${detail}. ` +
        `Serving a JS/TS node definition from the standalone agent-relay binary requires \`${nodeBin}\` on PATH ` +
        '(set AGENT_RELAY_NODE to override).'
    );
  }

  const descriptor = parseNodeDescriptor(stdout);
  if (!descriptor) {
    throw new Error(`Fleet node file ${configPath} must default-export defineNode(...)`);
  }
  return descriptor;
}

/** Pull the useful text out of an execCommand rejection (stderr beats the generic message). */
function extractChildFailure(err: unknown): string {
  const stderr =
    err && typeof err === 'object' && 'stderr' in err ? String((err as { stderr?: unknown }).stderr) : '';
  const trimmed = stderr.trim();
  if (trimmed) {
    return trimmed;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Serve a JS/TS fleet node definition in a child `node` process.
 *
 * Used only when the CLI is running as a `bun build --compile` binary, where
 * loading the definition in-process is impossible (see
 * {@link NODE_PROVIDER_CHILD_SOURCE}). Under Node the definition is still
 * served in-process, which keeps the existing behavior unchanged.
 *
 * @param configPath - Absolute path to the user's node definition file.
 * @param credentials - Node identity/token the child registers with.
 * @param deps - Core dependencies (spawn, env, logging).
 * @returns The spawned child, or `undefined` when it could not be started.
 */
export function startNodeJsNodeProvider(
  configPath: string,
  credentials: NodeProviderCredentials,
  deps: CoreDependencies
): SpawnedProcess | undefined {
  const nodeBin = deps.env.AGENT_RELAY_NODE?.trim() || 'node';
  const env: NodeJS.ProcessEnv = {
    ...deps.env,
    RELAY_NODE_TOKEN: credentials.nodeToken,
    RELAY_NODE_ID: credentials.nodeId,
    RELAY_NODE_NAME: credentials.nodeName,
    ...(credentials.baseUrl ? { RELAY_BASE_URL: credentials.baseUrl } : {}),
    ...(credentials.workspaceKey ? { RELAY_WORKSPACE_KEY: credentials.workspaceKey } : {}),
  };

  try {
    const script = materializeNodeProviderChildScript();
    const child = deps.spawnProcess(nodeBin, [script, configPath], {
      stdio: 'inherit',
      env,
      cwd: path.dirname(configPath),
    });
    deps.log(
      `Serving fleet node provider: ${nodeBin} ${path.basename(configPath)} (pid: ${child.pid ?? 'unknown'}).`
    );
    return child;
  } catch (err) {
    deps.warn(
      `Fleet node provider skipped: ${err instanceof Error ? err.message : String(err)}. ` +
        `Serving a JS/TS node definition from the standalone agent-relay binary requires \`${nodeBin}\` on PATH; ` +
        'set AGENT_RELAY_NODE to point at a Node.js executable.'
    );
    return undefined;
  }
}
