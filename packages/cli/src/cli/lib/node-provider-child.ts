import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createLogger } from '@agent-relay/utils';

import type { CoreDependencies, SpawnedProcess } from '../commands/core.js';
import { describeError } from './describe-error.js';

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

/** Derive a package root from a resolved entry on both POSIX and Windows. */
export function packageRootFromEntry(entry: string, packageName: string): string {
  const index = entry.replace(/\\/g, '/').lastIndexOf(packageName);
  return index >= 0 ? entry.slice(0, index + packageName.length) : entry;
}

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
const FAILURE = Symbol('node-provider-failure');

const fail = (message) => {
  console.error('[agent-relay] node provider: ' + message);
  process.exitCode = 2;
  throw FAILURE;
};

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

const errorText = (err) => (err && (err.stack || err.message)) || String(err);
const packageRootFromEntry = ${packageRootFromEntry.toString()};

const main = async () => {
if (!configPath) {
  fail('missing config path argument.');
}
const requireFromConfig = createRequire(configPath);
const importFromConfig = async (specifier) =>
  import(pathToFileURL(requireFromConfig.resolve(specifier)).href);

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
    ...(definition.repoPaths ? { repoPaths: definition.repoPaths } : {}),
  };
  console.log('__AGENT_RELAY_NODE_DESCRIPTOR__' + JSON.stringify(descriptor));
  return;
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
const fleetPackage = '@agent-relay/fleet';
const fleetRoot = packageRootFromEntry(fleetEntry, fleetPackage);
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
const loggingEnabled = Boolean(
  env.AGENT_RELAY_LOG_FILE || env.AGENT_RELAY_LOG_LEVEL || env.AGENT_RELAY_LOG_JSON === '1'
);

const sendLog = (level, message, extra) => {
  if (typeof process.send === 'function') {
    process.send({
      __agentRelayNodeProviderLog: true,
      level,
      message,
      ...(extra && typeof extra === 'object' ? { extra } : {}),
    });
  }
};
const logger = {
  debug: (message, extra) => sendLog('debug', message, extra),
  info: (message, extra) => sendLog('info', message, extra),
  warn: (message, extra) => sendLog('warn', message, extra),
  error: (message, extra) => sendLog('error', message, extra),
};
const warn = loggingEnabled
  ? (message, extra) => logger.warn(message, extra)
  : (message) => console.warn('[agent-relay][node] ' + message);

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
    warn('Message triggers will not sync (' + errorText(err) + ').');
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
    ...(loggingEnabled ? { logger } : { warn }),
  });
} catch (err) {
  if (!stopSignal.signal.aborted) {
    fail('serving ' + configPath + ' failed: ' + errorText(err));
  }
}
};

try {
  await main();
} catch (err) {
  if (err !== FAILURE) {
    throw err;
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
  /** Local-only map relayed to the broker process, never to the Fleet wire. */
  repoPaths?: Record<string, string>;
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
  const repoPaths = stringRecord(parsed.repoPaths);
  return {
    name: parsed.name,
    capabilities: Array.isArray(parsed.capabilities) ? parsed.capabilities : [],
    ...(typeof parsed.maxAgents === 'number' ? { maxAgents: parsed.maxAgents } : {}),
    ...(repoPaths ? { repoPaths } : {}),
  };
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value);
  if (!entries.every(([key, entry]) => Boolean(key) && typeof entry === 'string')) {
    return undefined;
  }
  return Object.fromEntries(entries) as Record<string, string>;
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
const TS_NODE_DEFINITION_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);

/** Whether `configPath` is a JS/TS node definition (as opposed to `agent-relay.py`). */
export function isJsNodeDefinition(configPath: string): boolean {
  return JS_NODE_DEFINITION_EXTENSIONS.has(path.extname(configPath).toLowerCase());
}

/**
 * Write the child bootstrap to a temp file so a child `node` process has
 * something on disk to execute. The compiled binary has no `dist/` on disk, so
 * the source is materialized per run.
 * TypeScript inputs are pre-transpiled by the compiled Bun parent and served
 * through a Node loader hook at their original file URLs. Keeping the original
 * URLs preserves both relative imports and bare-specifier resolution from the
 * config's own `node_modules`.
 * @param configPath - Node definition the bootstrap will load.
 * @param tempRoot - Root in which to create the private bootstrap directory.
 * @returns Materialized bootstrap arguments and an idempotent cleanup handle.
 */
export function materializeNodeProviderChildScript(
  configPath: string,
  tempRoot = os.tmpdir()
): MaterializedNodeProviderChild {
  const directory = fs.mkdtempSync(path.join(tempRoot, 'agent-relay-node-provider-'));
  activeTempDirectories.add(directory);
  registerTempCleanupFallback();

  try {
    const scriptPath = path.join(directory, 'node-provider-child.mjs');
    fs.writeFileSync(scriptPath, NODE_PROVIDER_CHILD_SOURCE, 'utf8');

    const nodeArgs: string[] = [];
    const transpiled = transpileTypeScriptGraph(configPath);
    if (transpiled) {
      const loaderPath = path.join(directory, 'node-definition-loader.mjs');
      const registerPath = path.join(directory, 'register-node-definition-loader.mjs');
      fs.writeFileSync(loaderPath, renderNodeLoader(transpiled), 'utf8');
      fs.writeFileSync(
        registerPath,
        [
          "import { register } from 'node:module';",
          `register(${JSON.stringify(pathToFileURL(loaderPath).href)}, import.meta.url);`,
          '',
        ].join('\n'),
        'utf8'
      );
      nodeArgs.push('--import', registerPath);
    }

    let cleaned = false;
    return {
      scriptPath,
      nodeArgs,
      directory,
      cleanup: () => {
        if (cleaned) return;
        cleaned = true;
        cleanupTempDirectory(directory);
      },
    };
  } catch (err) {
    cleanupTempDirectory(directory);
    throw err;
  }
}

export type MaterializedNodeProviderChild = {
  scriptPath: string;
  nodeArgs: string[];
  directory: string;
  cleanup(): void;
};

type BunTranspiler = {
  transformSync(source: string, loader?: 'ts' | 'tsx'): string;
  scanImports(source: string): Array<{ path: string }>;
};

type BunRuntime = {
  Transpiler: new (options: {
    loader: 'ts' | 'tsx';
    target: 'node';
    define?: Record<string, string>;
  }) => BunTranspiler;
};

type TranspiledGraph = {
  sources: Record<string, string>;
  resolutions: Record<string, string>;
};

const activeTempDirectories = new Set<string>();
let tempCleanupFallbackRegistered = false;

function registerTempCleanupFallback(): void {
  if (tempCleanupFallbackRegistered) return;
  tempCleanupFallbackRegistered = true;
  process.once('exit', () => {
    for (const directory of [...activeTempDirectories]) {
      cleanupTempDirectory(directory);
    }
  });
}

function cleanupTempDirectory(directory: string): void {
  activeTempDirectories.delete(directory);
  try {
    fs.rmSync(directory, { recursive: true, force: true });
  } catch {
    // Best effort: lifecycle cleanup must never mask the provider result.
  }
}

/** Pre-transpile the entry and its statically imported local TypeScript graph. */
function transpileTypeScriptGraph(configPath: string): TranspiledGraph | undefined {
  if (!TS_NODE_DEFINITION_EXTENSIONS.has(path.extname(configPath).toLowerCase())) {
    return undefined;
  }
  const bun = (globalThis as typeof globalThis & { Bun?: BunRuntime }).Bun;
  if (!bun?.Transpiler) {
    // This helper is only selected by the compiled-Bun serving plan. Retaining
    // the native Node path here keeps isolated Node unit tests injectable.
    return undefined;
  }

  const sources: Record<string, string> = {};
  const resolutions: Record<string, string> = {};
  const commonJsSources: Record<string, string> = {};
  const queued = [path.resolve(configPath)];
  const seen = new Set<string>();

  while (queued.length > 0) {
    const file = queued.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);

    const source = fs.readFileSync(file, 'utf8');
    const extension = path.extname(file).toLowerCase();
    const loader = extension === '.tsx' ? 'tsx' : 'ts';
    const transpiler = new bun.Transpiler({
      loader,
      target: 'node',
      ...(extension === '.cts'
        ? {
            define: {
              __filename: '__relayCommonJsFilename',
              __dirname: '__relayCommonJsDirname',
            },
          }
        : {}),
    });
    const parentUrls = new Set([pathToFileURL(file).href, pathToFileURL(fs.realpathSync(file)).href]);
    const transformed = transpiler.transformSync(source, loader);
    for (const parentUrl of parentUrls) {
      if (extension === '.cts') {
        commonJsSources[parentUrl] = transformed;
      } else {
        sources[parentUrl] = transformed;
      }
    }

    for (const imported of transpiler.scanImports(source)) {
      const resolved = resolveImportedTypeScript(file, imported.path);
      if (!resolved) continue;
      const resolvedUrl = pathToFileURL(fs.realpathSync(resolved)).href;
      for (const parentUrl of parentUrls) {
        resolutions[loaderResolutionKey(parentUrl, imported.path)] = resolvedUrl;
      }
      queued.push(resolved);
    }
  }

  for (const entryUrl of Object.keys(commonJsSources)) {
    sources[entryUrl] = wrapCommonJsAsModule(entryUrl, commonJsSources, resolutions);
  }

  return { sources, resolutions };
}

/** Execute a transpiled .cts graph synchronously with Node-like CommonJS modules. */
function wrapCommonJsAsModule(
  entryUrl: string,
  commonJsSources: Record<string, string>,
  resolutions: Record<string, string>
): string {
  return [
    "import { Module as __RelayModule, createRequire as __relayCreateRequire } from 'node:module';",
    "import { dirname as __relayDirname } from 'node:path';",
    "import { fileURLToPath as __relayFileURLToPath } from 'node:url';",
    `const __relaySources = new Map(Object.entries(${JSON.stringify(commonJsSources)}));`,
    `const __relayResolutions = new Map(Object.entries(${JSON.stringify(resolutions)}));`,
    `const __relayKey = (parentURL, specifier) => parentURL + '\\0' + specifier;`,
    'const __relayCache = new Map();',
    'const __relayLoad = (url, parent) => {',
    '  const cached = __relayCache.get(url);',
    '  if (cached) return cached.exports;',
    '  const source = __relaySources.get(url);',
    "  if (source === undefined) throw new Error('Missing transpiled CommonJS source for ' + url);",
    '  const filename = __relayFileURLToPath(url);',
    '  const dirname = __relayDirname(filename);',
    '  const nativeRequire = __relayCreateRequire(url);',
    '  const relayModule = new __RelayModule(filename, parent);',
    '  relayModule.filename = filename;',
    '  relayModule.path = dirname;',
    "  relayModule.paths = nativeRequire.resolve.paths('__agent_relay_module_paths__') || [];",
    '  const relayRequire = (specifier) => {',
    '    const resolved = __relayResolutions.get(__relayKey(url, specifier));',
    '    return resolved && __relaySources.has(resolved)',
    '      ? __relayLoad(resolved, relayModule)',
    '      : nativeRequire(specifier);',
    '  };',
    '  relayRequire.resolve = nativeRequire.resolve;',
    '  relayRequire.cache = nativeRequire.cache;',
    '  relayRequire.extensions = nativeRequire.extensions;',
    '  relayRequire.main = nativeRequire.main;',
    '  relayModule.require = relayRequire;',
    '  __relayCache.set(url, relayModule);',
    '  const factory = new Function(',
    "    'exports', 'require', 'module', '__filename', '__dirname',",
    "    '__relayCommonJsFilename', '__relayCommonJsDirname', source",
    '  );',
    '  factory.call(',
    '    relayModule.exports, relayModule.exports, relayRequire, relayModule,',
    '    filename, dirname, filename, dirname',
    '  );',
    '  relayModule.loaded = true;',
    '  return relayModule.exports;',
    '};',
    `export default __relayLoad(${JSON.stringify(entryUrl)}, undefined);`,
    '',
  ].join('\n');
}

function resolveImportedTypeScript(parentFile: string, specifier: string): string | undefined {
  let candidate: string;
  try {
    if (specifier.startsWith('file:')) {
      candidate = fileURLToPath(specifier);
    } else if (specifier.startsWith('.') || path.isAbsolute(specifier)) {
      candidate = path.resolve(path.dirname(parentFile), specifier);
    } else {
      candidate = createRequire(parentFile).resolve(specifier);
    }
  } catch {
    return undefined;
  }

  const attempts = [candidate];
  if (!path.extname(candidate)) {
    for (const extension of TS_NODE_DEFINITION_EXTENSIONS) {
      attempts.push(candidate + extension, path.join(candidate, 'index' + extension));
    }
  } else if (/\.[cm]?js$/i.test(candidate)) {
    const stem = candidate.replace(/\.[cm]?js$/i, '');
    attempts.push(stem + '.ts', stem + '.tsx', stem + '.mts', stem + '.cts');
  }
  const resolved = attempts.find(
    (attempt) => TS_NODE_DEFINITION_EXTENSIONS.has(path.extname(attempt).toLowerCase()) && isFile(attempt)
  );
  return resolved ? path.resolve(resolved) : undefined;
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function loaderResolutionKey(parentUrl: string, specifier: string): string {
  return `${parentUrl}\0${specifier}`;
}

function renderNodeLoader(graph: TranspiledGraph): string {
  return [
    `const sources = new Map(Object.entries(${JSON.stringify(graph.sources)}));`,
    `const resolutions = new Map(Object.entries(${JSON.stringify(graph.resolutions)}));`,
    `const key = (parentURL, specifier) => parentURL + '\\0' + specifier;`,
    'export async function resolve(specifier, context, nextResolve) {',
    '  const url = resolutions.get(key(context.parentURL || "", specifier));',
    '  return url ? { url, shortCircuit: true } : nextResolve(specifier, context);',
    '}',
    'export async function load(url, context, nextLoad) {',
    '  const source = sources.get(url);',
    "  return source === undefined ? nextLoad(url, context) : { format: 'module', source, shortCircuit: true };",
    '}',
    '',
  ].join('\n');
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
  const materialized = materializeNodeProviderChildScript(configPath, deps.env.TMPDIR?.trim() || os.tmpdir());
  const command = [nodeBin, ...materialized.nodeArgs, materialized.scriptPath, configPath, '--describe']
    .map(shellQuote)
    .join(' ');

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
  } finally {
    materialized.cleanup();
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
  return describeError(err);
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
 * @returns A supervised child handle, or `undefined` when it could not be started.
 */
export async function startNodeJsNodeProvider(
  configPath: string,
  credentials: NodeProviderCredentials,
  deps: CoreDependencies
): Promise<RunningNodeProviderChild | undefined> {
  const nodeBin = deps.env.AGENT_RELAY_NODE?.trim() || 'node';
  const env: NodeJS.ProcessEnv = {
    ...deps.env,
    RELAY_NODE_TOKEN: credentials.nodeToken,
    RELAY_NODE_ID: credentials.nodeId,
    RELAY_NODE_NAME: credentials.nodeName,
    ...(credentials.baseUrl ? { RELAY_BASE_URL: credentials.baseUrl } : {}),
    ...(credentials.workspaceKey ? { RELAY_WORKSPACE_KEY: credentials.workspaceKey } : {}),
  };
  const loggingEnabled = childLoggingEnabled(env);
  let materialized: MaterializedNodeProviderChild | undefined;

  try {
    materialized = materializeNodeProviderChildScript(configPath, deps.env.TMPDIR?.trim() || os.tmpdir());
    const child = deps.spawnProcess(
      nodeBin,
      [...materialized.nodeArgs, materialized.scriptPath, configPath],
      {
        stdio: loggingEnabled ? ['inherit', 'inherit', 'inherit', 'ipc'] : 'inherit',
        env,
        cwd: path.dirname(configPath),
      }
    );
    attachChildLogger(child, loggingEnabled);
    const managed = manageNodeProviderChild(child, materialized, deps, configPath);
    await managed.started;
    deps.log(
      `Serving fleet node provider: ${nodeBin} ${path.basename(configPath)} (pid: ${child.pid ?? 'unknown'}).`
    );
    return managed.handle;
  } catch (err) {
    materialized?.cleanup();
    deps.warn(
      `Fleet node provider skipped: ${err instanceof Error ? err.message : String(err)}. ` +
        `Serving a JS/TS node definition from the standalone agent-relay binary requires \`${nodeBin}\` on PATH; ` +
        'set AGENT_RELAY_NODE to point at a Node.js executable.'
    );
    return undefined;
  }
}

/** Managed child contract used by the broker lifecycle. */
export type RunningNodeProviderChild = {
  pid?: number;
  done: Promise<void>;
  stop(): Promise<void>;
};

type EventedSpawnedProcess = SpawnedProcess & {
  once?: (event: string, listener: (...args: unknown[]) => void) => unknown;
  on?: (event: string, listener: (...args: unknown[]) => void) => unknown;
};

function childLoggingEnabled(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.AGENT_RELAY_LOG_FILE || env.AGENT_RELAY_LOG_LEVEL || env.AGENT_RELAY_LOG_JSON === '1');
}

function attachChildLogger(child: SpawnedProcess, enabled: boolean): void {
  const evented = child as EventedSpawnedProcess;
  if (!enabled || typeof evented.on !== 'function') return;
  const logger = createLogger('fleet');
  evented.on('message', (message: unknown) => {
    if (!isChildLogMessage(message)) return;
    logger[message.level](message.message, message.extra);
  });
}

type ChildLogMessage = {
  __agentRelayNodeProviderLog: true;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  extra?: Record<string, unknown>;
};

function isChildLogMessage(value: unknown): value is ChildLogMessage {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ChildLogMessage>;
  return (
    candidate.__agentRelayNodeProviderLog === true &&
    typeof candidate.message === 'string' &&
    ['debug', 'info', 'warn', 'error'].includes(String(candidate.level)) &&
    (candidate.extra === undefined ||
      (typeof candidate.extra === 'object' && candidate.extra !== null && !Array.isArray(candidate.extra)))
  );
}

function manageNodeProviderChild(
  child: SpawnedProcess,
  materialized: MaterializedNodeProviderChild,
  deps: CoreDependencies,
  configPath: string
): { started: Promise<void>; handle: RunningNodeProviderChild } {
  const evented = child as EventedSpawnedProcess;
  const observesLifecycle = typeof evented.once === 'function';
  let stopping = false;
  let settled = false;
  let resolveDone!: () => void;
  let rejectDone!: (err: Error) => void;
  let resolveStarted!: () => void;
  let rejectStarted!: (err: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  // A child may fail between startNodeJsNodeProvider returning and the broker
  // attaching its lifecycle race. Mark the promise handled without changing
  // what callers observe when they await the original promise.
  void done.catch(() => undefined);
  const started = new Promise<void>((resolve, reject) => {
    resolveStarted = resolve;
    rejectStarted = reject;
  });

  const finish = (error?: Error): void => {
    if (settled) return;
    settled = true;
    materialized.cleanup();
    if (error && !stopping) {
      rejectDone(error);
    } else {
      resolveDone();
    }
  };

  if (observesLifecycle) {
    evented.once!('spawn', () => resolveStarted());
    evented.once!('error', (rawError: unknown) => {
      const error = rawError instanceof Error ? rawError : new Error(String(rawError));
      rejectStarted(error);
      finish(new Error(`Fleet node provider for ${configPath} failed: ${error.message}`, { cause: error }));
    });
    evented.once!('exit', (code: unknown, signal: unknown) => {
      const detail = signal ? `signal ${String(signal)}` : `code ${String(code)}`;
      finish(new Error(`Fleet node provider for ${configPath} exited unexpectedly (${detail}).`));
    });
  } else {
    resolveStarted();
  }

  return {
    started,
    handle: {
      ...(child.pid !== undefined ? { pid: child.pid } : {}),
      done,
      stop: async () => {
        stopping = true;
        if (!settled) {
          try {
            if (child.pid) {
              deps.killProcess(child.pid, 'SIGTERM');
            } else {
              child.kill?.('SIGTERM');
            }
          } catch {
            // The child may already have exited between the state check and kill.
          }
        }
        if (observesLifecycle && !settled) {
          const exited = await Promise.race([
            done.then(
              () => true,
              () => true
            ),
            deps.sleep(5_000).then(() => false),
          ]);
          if (!exited && !settled) {
            try {
              if (child.pid) {
                deps.killProcess(child.pid, 'SIGKILL');
              } else {
                child.kill?.('SIGKILL');
              }
            } catch {
              // The child may have exited while graceful shutdown timed out.
            }
            await Promise.race([done.catch(() => undefined), deps.sleep(1_000)]);
          }
        }
        finish();
      },
    },
  };
}
