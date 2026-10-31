import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Command } from 'commander';
import { InvalidArgumentError } from 'commander';

import {
  assertOriginBindingsWritable,
  boundOrigin,
  configuredOrigin,
  DEFAULT_HOSTED_ORIGIN,
  guardCredentialOrigin,
  isJoinableHostedOrigin,
  UNBOUND_CREDENTIAL_ORIGIN,
} from '../lib/relaycast-origin-binding.js';
import {
  TOOL_IDS,
  TOOL_TARGETS,
  codexProjectRoot,
  codexProjectTrust,
  codexUserConfigPath,
  defaultRunTool,
  defaultToolContext,
  detectTools,
  findOnPath,
  findToolTarget,
  installTool,
  npxPackageSpec,
  parseToolsFlag,
  resolveMcpLaunch,
  trustCodexProject,
  uninstallTool,
  writeKeepingMode,
  type InstallScope,
  type McpLaunch,
  type RunTool,
  type ToolContext,
  type ToolId,
  type ToolResult,
  type ToolTarget,
} from '../lib/agent-tools-mcp.js';
import { CANCELLED, clackPrompter, type InitPrompter } from '../lib/init-prompts.js';
import { sessionBaseName } from '../lib/mcp-session-name.js';
import { runSdk, withSdkDefaults, type SdkCommandDeps } from '../lib/sdk-command.js';
import {
  currentEnginePlatform,
  ensureReleaseBinary,
  ensureStandaloneEngine,
  fetchDownload,
  readEngineVersion,
  type DownloadFile,
  type EnginePlatform,
} from '../lib/relaycast-engine-install.js';
import {
  AUTO_ACTIVATE,
  CORE_START_TIMEOUT_MS,
  PROBE_DELIVERY,
  PROBE_VERSION,
  connectCore,
  coreSocketPath,
  deliveryKeys,
  disableDelivery,
  enableDelivery,
  probeAssetName,
  probeAssetUrl,
  readCoreState,
  readDeliveryRecord,
  readProbeVersion,
  startCoreProcess,
  writePrivateJson,
  type CoreClient,
  type CoreState,
  type CoreStatus,
  type DeliveryRecord,
  type DeliveryResult,
} from '../lib/probe-core.js';
import { shellQuote, shellWord } from '../lib/agent-registration.js';
import {
  claudeFileStates,
  openCodeConfigDir,
  openCodeState,
  piAgentDir,
  piState,
  tidyClaudeSettings,
  tidyOpenCodePlugin,
  tidyPiExtension,
  type ClaudeFileState,
  type OpenCodeState,
  type PiState,
} from '../lib/init-leftovers.js';
import { persistWorkspaceSession } from '../lib/workspace-session.js';
import { readWorkspaceStore } from '../lib/workspace-store.js';
import { assertProjectRoot, getProjectPaths, isHomeProjectRoot } from '@agent-relay/config';
import {
  PROBE_PATH_ENV,
  getCanonicalProbePath,
  getCanonicalRelaycastEnginePath,
  isUsableBinary,
} from '@agent-relay/harness-driver/install-paths';

/** The Relaycast server `relay init` runs locally. Pinned so every machine runs the same server. */
export const LOCAL_ENGINE_VERSION = '11.1.0';
export const LOCAL_ENGINE_PACKAGE = `@relaycast/engine@${LOCAL_ENGINE_VERSION}`;
const DEFAULT_LOCAL_PORT = 8787;
const START_TIMEOUT_MS = 120_000;

/** Injectable effects for `relay init`, replaced in tests. */
export interface InitCommandDependencies extends SdkCommandDeps {
  fetch: typeof fetch;
  /** Start the local engine detached; returns its pid. */
  startEngine: (input: { dataDir: string; port: number; logFile: string }) => number;
  isAlive: (pid: number) => boolean;
  stop: (pid: number) => void;
  sleep: (ms: number) => Promise<void>;
  /** Whether to ask questions: stdin and stdout are a terminal. */
  isInteractive: () => boolean;
  prompter: () => InitPrompter;
  /** Project root, home and environment the agent-tool configs resolve against. */
  toolContext: () => ToolContext;
  /** Runs an agent tool's own `mcp add`. */
  runTool: RunTool;
  /** This CLI's version, pinned when agent tools start Relay through npx. */
  cliVersion?: string;
  /** The command agent tools run for `relay mcp`, for an install scope. */
  resolveLaunch: (ctx: ToolContext, scope: InstallScope) => McpLaunch;
  /**
   * Fetch an `npx` launch's package into npm's cache now, so an agent tool's
   * first start of the server does not hit its MCP startup timeout.
   */
  warmLaunch: (launch: McpLaunch) => void;
  /** Downloads one file of the standalone server release (binary or `.sha256`). */
  downloadEngine: DownloadFile;
  /** The version an installed `relaycast-engine` reports for `--version`. */
  engineVersion: (binary: string) => string | undefined;
  /** Platform, architecture and libc that pick the standalone server asset. */
  enginePlatform: () => EnginePlatform;
  /** The Agent Relay core's bridge socket. */
  coreSocket: () => string;
  /** Connect to the core at a socket; undefined when none answers. */
  connectCore: (socket: string) => Promise<CoreClient | undefined>;
  /** Start the core detached; returns its pid. */
  startCore: (input: { binary: string; socket: string; logFile: string }) => number;
  /** Downloads one file of the core's release (binary or `.sha256`). */
  downloadProbe: DownloadFile;
  /** The version an installed `agent-relay-probe` reports for `--version`. */
  probeVersion: (binary: string) => string | undefined;
}

interface LocalServerState {
  pid: number;
  port: number;
  origin: string;
  engine: string;
}

function projectRoot(): string {
  try {
    return getProjectPaths().projectRoot;
  } catch {
    return process.cwd();
  }
}

function relayHome(): string {
  return process.env.AGENT_RELAY_HOME ?? path.join(os.homedir(), '.agentworkforce/relay');
}

function localDir(): string {
  return path.join(relayHome(), 'local');
}

function statePath(): string {
  return path.join(localDir(), 'server.json');
}

/**
 * The local server `relay init` started, if its record is sane. A pid of 0 or
 * 1 would make `--stop` signal this CLI's own process group or every process
 * the user owns, so anything but an integer above 1 is ignored.
 */
function readState(): LocalServerState | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const state = parsed as Partial<LocalServerState>;
  if (typeof state.pid !== 'number' || !Number.isInteger(state.pid) || state.pid <= 1) return undefined;
  if (typeof state.origin !== 'string' || typeof state.port !== 'number') return undefined;
  return state as LocalServerState;
}

/** The standalone server binary in the canonical bin slot install.sh and the broker use, when there is one. */
function standaloneEngine(): string | undefined {
  const binary = getCanonicalRelaycastEnginePath();
  return fs.existsSync(binary) ? binary : undefined;
}

/** Whether a server is already installed, so starting it needs no download. */
function engineInstalled(): boolean {
  return (
    standaloneEngine() !== undefined ||
    fs.existsSync(
      path.join(
        relayHome(),
        'engine',
        LOCAL_ENGINE_VERSION,
        'node_modules',
        '@relaycast',
        'engine',
        'dist',
        'bin',
        'serve.js'
      )
    )
  );
}

/**
 * Install the pinned server package once, under the relay home rather than
 * npm's npx cache, so it always lives in one known place. Returns its entry.
 */
function packagedEngine(log: number): string {
  const prefix = path.join(relayHome(), 'engine', LOCAL_ENGINE_VERSION);
  const entry = path.join(prefix, 'node_modules', '@relaycast', 'engine', 'dist', 'bin', 'serve.js');
  if (!fs.existsSync(entry)) {
    fs.mkdirSync(prefix, { recursive: true, mode: 0o700 });
    execFileSync(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['install', '--prefix', prefix, '--no-audit', '--no-fund', '--omit=dev', LOCAL_ENGINE_PACKAGE],
      { stdio: ['ignore', log, log], env: process.env }
    );
  }
  if (!fs.existsSync(entry)) throw new Error(`Installing ${LOCAL_ENGINE_PACKAGE} did not produce ${entry}.`);
  return entry;
}

function defaultStartEngine({ dataDir, port, logFile }: { dataDir: string; port: number; logFile: string }) {
  const log = fs.openSync(logFile, 'a', 0o600);
  const args = ['--db', path.join(dataDir, 'relaycast.db'), '--port', String(port)];
  try {
    const binary = standaloneEngine();
    const [command, commandArgs] = binary
      ? [binary, args]
      : // The packaged server needs Node. A Bun-compiled CLI's own executable is not Node.
        [process.versions.bun ? 'node' : process.execPath, [packagedEngine(log), ...args]];
    const child = spawn(command, commandArgs, {
      detached: true,
      stdio: ['ignore', log, log],
      env: process.env,
    });
    child.unref();
    if (child.pid === undefined) throw new Error('Could not start the local Relaycast server.');
    return child.pid;
  } finally {
    fs.closeSync(log);
  }
}

function defaultWarmLaunch(launch: McpLaunch): void {
  const spec = npxPackageSpec(launch);
  if (!spec) return;
  // `--version` runs no Relay code beyond printing; failures are left for the
  // agent tool to surface, since the entry itself is still right. Windows
  // starts npx (a .cmd) only through a shell; the spec is a plain package name.
  const options = { stdio: 'ignore' as const, timeout: 180_000, env: process.env };
  if (process.platform === 'win32') spawnSync(`npx -y ${spec} --version`, { ...options, shell: true });
  else spawnSync('npx', ['-y', spec, '--version'], options);
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function defaultStop(pid: number): void {
  try {
    // The engine was started in its own process group; stop npx and the server together.
    process.kill(process.platform === 'win32' ? pid : -pid, 'SIGTERM');
  } catch {
    // Already gone.
  }
}

/**
 * Fill in the real effects for any dependency a caller did not override.
 *
 * @param overrides - Dependencies to replace, typically in tests.
 * @returns A complete dependency set.
 */
export function withInitDefaults(overrides: Partial<InitCommandDependencies> = {}): InitCommandDependencies {
  return {
    ...withSdkDefaults(overrides),
    fetch: globalThis.fetch,
    startEngine: defaultStartEngine,
    isAlive: defaultIsAlive,
    stop: defaultStop,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    isInteractive: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
    prompter: clackPrompter,
    toolContext: () => defaultToolContext(projectRoot()),
    runTool: defaultRunTool,
    resolveLaunch: (ctx, scope) => resolveMcpLaunch({ ctx, scope, version: overrides.cliVersion }),
    warmLaunch: defaultWarmLaunch,
    downloadEngine: fetchDownload,
    engineVersion: readEngineVersion,
    enginePlatform: currentEnginePlatform,
    coreSocket: () => coreSocketPath(process.env, os.homedir()),
    connectCore: (socket) => connectCore(socket),
    startCore: startCoreProcess,
    downloadProbe: fetchDownload,
    probeVersion: readProbeVersion,
    ...overrides,
  };
}

async function healthy(deps: InitCommandDependencies, origin: string): Promise<boolean> {
  try {
    const response = await deps.fetch(new URL('/health', origin), { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false;
  }
}

function logTail(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n').slice(-8).join('\n');
  } catch {
    return '';
  }
}

/**
 * Put the pinned standalone server in the bin slot when it is missing or
 * older. It runs on any Node version and needs no npm install scripts; when it
 * cannot be had, the npm package is the fallback.
 */
async function installStandaloneEngine(deps: InitCommandDependencies): Promise<void> {
  const target = getCanonicalRelaycastEnginePath();
  const result = await ensureStandaloneEngine({
    version: LOCAL_ENGINE_VERSION,
    target,
    platform: deps.enginePlatform(),
    download: deps.downloadEngine,
    readVersion: deps.engineVersion,
    progress: (line) => deps.log(line),
  });
  if (result.status === 'installed') {
    deps.log(`Installed relaycast-engine v${LOCAL_ENGINE_VERSION} to ${target}.`);
  } else if (result.status === 'failed') {
    deps.log(
      `Could not install the standalone Relaycast server (${result.reason}); ` +
        (fs.existsSync(target)
          ? `using the one already at ${target}.`
          : `falling back to the npm package ${LOCAL_ENGINE_PACKAGE}.`)
    );
  }
}

/** The origin of the local server `relay init` started earlier, if it is still up. */
async function runningLocalServer(deps: InitCommandDependencies): Promise<string | undefined> {
  const existing = readState();
  if (existing && deps.isAlive(existing.pid) && (await healthy(deps, existing.origin))) {
    return existing.origin;
  }
  return undefined;
}

async function ensureLocalServer(deps: InitCommandDependencies, port: number): Promise<string> {
  const running = await runningLocalServer(deps);
  if (running) return running;
  const origin = `http://127.0.0.1:${port}`;
  const refuseOccupiedPort = async () => {
    if (await healthy(deps, origin)) {
      throw new Error(
        `Something else is already serving on port ${port}. Stop it, or choose another port with --port.`
      );
    }
  };
  // Before the download too, so a taken port fails fast.
  await refuseOccupiedPort();
  await installStandaloneEngine(deps);
  // The download can take a while; another `relay init` may have started the server meanwhile.
  const startedMeanwhile = await runningLocalServer(deps);
  if (startedMeanwhile) return startedMeanwhile;
  await refuseOccupiedPort();
  fs.mkdirSync(localDir(), { recursive: true, mode: 0o700 });
  const logFile = path.join(localDir(), 'server.log');
  deps.log(
    `Starting a local Relaycast server on ${origin}${engineInstalled() ? '' : ' (downloading it the first time)'}…`
  );
  const pid = deps.startEngine({ dataDir: localDir(), port, logFile });
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await healthy(deps, origin)) {
      const state: LocalServerState = { pid, port, origin, engine: LOCAL_ENGINE_PACKAGE };
      fs.writeFileSync(statePath(), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      return origin;
    }
    if (!deps.isAlive(pid)) break;
    await deps.sleep(500);
  }
  deps.stop(pid);
  const tail = logTail(logFile);
  throw new Error(
    `The local Relaycast server did not start. Install the standalone server with the install script ` +
      `(curl -fsSL https://raw.githubusercontent.com/AgentWorkforce/relay/main/install.sh | bash), ` +
      `or use Node.js 22 or 24 with npm install scripts enabled.` +
      (tail ? `\nLast lines of ${logFile}:\n${tail}` : '')
  );
}

/** The server answered and refused the key, as opposed to being unreachable or failing. */
class WorkspaceKeyRejectedError extends Error {}

/**
 * Check a workspace key against its server.
 * @returns The workspace's Relaycast id, when the server names it
 */
async function verifyWorkspace(
  deps: InitCommandDependencies,
  origin: string,
  key: string
): Promise<WorkspaceInfo> {
  let response: Response;
  try {
    response = await deps.fetch(new URL('/v1/workspace', origin), {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    const reason =
      error instanceof Error ? ((error.cause as Error | undefined)?.message ?? error.message) : '';
    throw new Error(
      `Could not reach ${origin}${reason ? ` (${reason})` : ''}. If your server uses a private certificate ` +
        `authority, set NODE_EXTRA_CA_CERTS to its certificate file.`,
      { cause: error }
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new WorkspaceKeyRejectedError(`${origin} rejected the workspace key.`);
  }
  if (!response.ok) throw new Error(`${origin} answered ${response.status} when checking the workspace.`);
  return workspaceInfoIn(response);
}

/** What `GET /v1/workspace` says about a key's workspace, when it says. */
interface WorkspaceInfo {
  id?: string;
  name?: string;
}

/** The `id` and `name` of a `GET /v1/workspace` answer (`{ok, data: {id, name}}`), read leniently. */
async function workspaceInfoIn(response: Response): Promise<WorkspaceInfo> {
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined;
  try {
    const body = (await response.json()) as {
      data?: { id?: unknown; name?: unknown };
      id?: unknown;
      name?: unknown;
    } | null;
    return { id: text(body?.data?.id ?? body?.id), name: text(body?.data?.name ?? body?.name) };
  } catch {
    return {};
  }
}

/** The workspace id a key belongs to, when its server can say; never throws. */
async function workspaceIdOf(
  deps: InitCommandDependencies,
  origin: string,
  key: string
): Promise<string | undefined> {
  return verifyWorkspace(deps, origin, key).then(
    (workspace) => workspace.id,
    () => undefined
  );
}

function parsePort(value: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new InvalidArgumentError('Expected a port.');
  return port;
}

function parseScope(value: string): InstallScope {
  if (value === 'project' || value === 'global') return value;
  throw new InvalidArgumentError('Expected project or global.');
}

function parseTools(value: string): ToolId[] {
  try {
    return parseToolsFlag(value);
  } catch (error) {
    throw new InvalidArgumentError((error as Error).message);
  }
}

/** Where agents talk. */
type ServerMode = 'local' | 'hosted' | 'own';

interface ServerChoice {
  mode: ServerMode;
  url?: string;
  key?: string;
  name?: string;
  port: number;
}

/** What setting up the server produced, for the person to read. */
interface ServerSetup {
  headline: string;
  details: string[];
  /** Where the workspace lives. */
  mode: ServerMode;
  /** The Relaycast server the workspace is on. */
  origin: string;
  /** The workspace saved for this project. */
  workspace: string;
  /** Its Relaycast workspace id (`GET /v1/workspace`), when the server named it. */
  workspaceId?: string;
  /** Another workspace left active machine-wide, when there was one. */
  keptActive?: string;
}

/** The command that makes `name` the machine-wide active workspace. */
function switchCommand(name: string): string {
  return `relay workspace switch ${shellWord(name)}`;
}

/**
 * The npm package spec a teammate's `npx` runs: the `next` dist-tag for a
 * `-next` prerelease (or a build that is not a published version), else
 * this exact version.
 */
function teammatePackage(version: string | undefined): string {
  const published = version?.trim();
  if (!published || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(published) || published.includes('-next')) {
    return 'agent-relay@next';
  }
  return `agent-relay@${published}`;
}

/**
 * The one command a teammate runs in their project to join a hosted
 * workspace, Relay installed or not: it saves the workspace (named as the
 * server names it), starts the Agent Relay core and turns on message
 * injection for their agent tools. `relay workspace join` only saves it.
 */
function joinCommand(key: string, origin: string, version: string | undefined): string {
  return `npx -y ${teammatePackage(version)} init --url ${shellWord(origin)} --key ${shellQuote(key)}`;
}

/**
 * A free name for a workspace joined by key: `name`, unless a saved
 * workspace under it holds another key, then `name-2` and on.
 */
function freeWorkspaceName(name: string, key: string): string {
  const saved = readWorkspaceStore().workspaces;
  const free = (candidate: string) => !saved[candidate] || saved[candidate]?.key === key;
  if (free(name)) return name;
  for (let n = 2; ; n += 1) {
    if (free(`${name}-${n}`)) return `${name}-${n}`;
  }
}

/**
 * Save the workspace and bind it to this project. It becomes the machine-wide
 * active workspace only when no other one is: a machine already serving a
 * workspace (a fleet node, other projects) must not be moved by setting up one
 * project.
 * @returns The other workspace left active, and the line explaining it.
 */
function saveWorkspace(
  name: string,
  workspaceKey: string
): Pick<ServerSetup, 'workspace' | 'keptActive'> & {
  lines: string[];
} {
  const { keptActiveWorkspace } = persistWorkspaceSession({ name, workspaceKey, activate: 'if-none' });
  if (!keptActiveWorkspace) return { workspace: name, lines: [] };
  return {
    workspace: name,
    keptActive: keptActiveWorkspace,
    lines: [
      `This project now uses workspace "${name}"; "${keptActiveWorkspace}" stays active machine-wide. ` +
        `To make "${name}" the default everywhere, run: ${switchCommand(name)}`,
    ],
  };
}

/**
 * Agent tools set up globally run in every project, and a project without its
 * own workspace (and no flag or environment selection) uses the machine-wide
 * active one. Say so when that is not the
 * workspace just set up.
 */
function globalScopeNote(setup: ServerSetup, scope: InstallScope, installed: ToolId[]): string | undefined {
  if (scope !== 'global' || installed.length === 0 || !setup.keptActive) return undefined;
  return (
    `In projects without their own workspace, globally set up agent tools use the active workspace "${setup.keptActive}". ` +
    `To make "${setup.workspace}" the machine-wide fallback, run: ${switchCommand(setup.workspace)}`
  );
}

/** A workspace name part: lowercase letters, digits and single dashes. */
function nameSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The name `relay init --hosted` gives a new workspace without `--name`:
 * the person and the project folder (`alice-api`), with a numeric suffix
 * when a saved workspace already has that name, so a second hosted
 * workspace never replaces the first in the store.
 */
function defaultHostedName(projectRoot: string): string {
  let user = '';
  try {
    user = os.userInfo().username;
  } catch {
    // No passwd entry (some containers): the folder alone.
  }
  const base =
    [nameSlug(user), nameSlug(path.basename(projectRoot))].filter(Boolean).join('-').slice(0, 40) || 'relay';
  const taken = new Set(Object.keys(readWorkspaceStore().workspaces));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  }
}

/**
 * Connect to (or start) the server and save its workspace for this project.
 * This is the original `relay init`; the agent-tool setup comes after it.
 */
async function setupServer(deps: InitCommandDependencies, choice: ServerChoice): Promise<ServerSetup> {
  if (choice.mode === 'own') {
    const { key } = choice;
    if (!key) throw new Error('Pass --key with --url for your own server.');
    // `--key` alone follows the key's server. A key with none recorded and no
    // armadillo format predates that default, so it goes where unbound keys
    // go: only an explicit --url sends it anywhere else. A key bound to a
    // self-hosted server is never sent to the hosted service.
    const bound = choice.url ? undefined : boundOrigin(key);
    const url = choice.url ?? bound ?? UNBOUND_CREDENTIAL_ORIGIN;
    if (bound && !isJoinableHostedOrigin(new URL(bound).origin)) {
      throw new Error(
        `This workspace key belongs to ${new URL(bound).origin}, so relay init will not send it to the hosted ` +
          `service. To use it there, run: relay init --url ${shellWord(new URL(bound).origin)} --key <key>`
      );
    }
    const origin = configuredOrigin(url, '--url');
    if (!origin) throw new Error('--url is empty.');
    const workspace = await verifyWorkspace(deps, origin, key);
    const workspaceId = workspace.id;
    guardCredentialOrigin(key, url);
    const hosted = isJoinableHostedOrigin(origin);
    // Named as the person says, else as the server names the workspace.
    const name =
      choice.name ??
      freeWorkspaceName(
        workspace.name ??
          (hosted ? defaultHostedName(deps.toolContext().projectRoot) : new URL(origin).hostname),
        key
      );
    const { lines, ...saved } = saveWorkspace(name, key);
    // A teammate joining a hosted workspace by key: the hosted service, not
    // a server of their own. It stays an `own` setup: init did not create
    // the workspace, so its name never stands in for a workspace id when
    // checking which workspace the core serves (`sameWorkspace`).
    if (hosted) {
      return {
        ...saved,
        workspaceId,
        mode: 'own',
        origin,
        headline: `Joined hosted workspace "${name}" (${origin}).`,
        details: ['Your key is only ever sent to the hosted service.', ...lines],
      };
    }
    return {
      ...saved,
      workspaceId,
      mode: 'own',
      origin,
      headline: `Connected to your server at ${origin} as workspace "${name}".`,
      details: ['Your key is only ever sent to this server.', ...lines],
    };
  }

  if (choice.mode === 'hosted') {
    const name = choice.name ?? defaultHostedName(deps.toolContext().projectRoot);
    assertOriginBindingsWritable(DEFAULT_HOSTED_ORIGIN);
    const relay = await deps.createWorkspace(name, DEFAULT_HOSTED_ORIGIN);
    if (!relay.workspaceKey) throw new Error('The hosted service did not return a workspace key.');
    guardCredentialOrigin(relay.workspaceKey, DEFAULT_HOSTED_ORIGIN);
    const { lines, ...saved } = saveWorkspace(name, relay.workspaceKey);
    return {
      ...saved,
      workspaceId: await workspaceIdOf(deps, DEFAULT_HOSTED_ORIGIN, relay.workspaceKey),
      mode: 'hosted',
      origin: DEFAULT_HOSTED_ORIGIN,
      headline: `Created hosted workspace "${name}".`,
      details: [
        ...(choice.name ? [] : [`Named after you and this folder; pass --name to choose another.`]),
        ...lines,
        'On another machine, run this in the project to join it and connect its agent tools ' +
          '(treat this key like a password):',
        `  ${joinCommand(relay.workspaceKey, DEFAULT_HOSTED_ORIGIN, deps.cliVersion)}`,
      ],
    };
  }

  const origin = await ensureLocalServer(deps, choice.port);
  const name = choice.name ?? 'local';
  // Re-running init keeps the same local workspace and its agents.
  const stored = readWorkspaceStore().workspaces[name]?.key;
  let workspaceKey = stored && boundOrigin(stored) === origin ? stored : undefined;
  let workspaceId: string | undefined;
  if (workspaceKey) {
    // Only a key the server refuses is replaced. A timeout or server
    // error is reported instead, so a hiccup never swaps the workspace
    // (and its agents and messages) for a new one.
    workspaceId = await verifyWorkspace(deps, origin, workspaceKey).then(
      (workspace) => workspace.id,
      (error: unknown) => {
        if (!(error instanceof WorkspaceKeyRejectedError)) throw error;
        workspaceKey = undefined;
        return undefined;
      }
    );
  }
  if (!workspaceKey) {
    assertOriginBindingsWritable(origin);
    const relay = await deps.createWorkspace(name, origin);
    if (!relay.workspaceKey) throw new Error('The local server did not return a workspace key.');
    workspaceKey = relay.workspaceKey;
    guardCredentialOrigin(workspaceKey, origin);
    workspaceId = await workspaceIdOf(deps, origin, workspaceKey);
  }
  const { lines, ...saved } = saveWorkspace(name, workspaceKey);
  return {
    ...saved,
    workspaceId,
    mode: 'local',
    origin,
    headline: `Relay is running on this machine (${origin}), workspace "${name}". No account needed.`,
    details: [...lines, 'To work with agents on other machines later, run: relay init --hosted'],
  };
}

// ---------------------------------------------------------------------------
// Agent tools

function displayPath(file: string, ctx: ToolContext): string {
  const relative = path.relative(ctx.projectRoot, file);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return relative;
  const fromHome = path.relative(ctx.home, file);
  if (fromHome && !fromHome.startsWith('..') && !path.isAbsolute(fromHome)) return path.join('~', fromHome);
  return file;
}

const PLACEHOLDER_LAUNCH: McpLaunch = { command: 'agent-relay', args: ['mcp'], reason: '' };

/** How a tool will be set up, for the summary before installing. */
function plannedMethod(target: ToolTarget, scope: InstallScope, ctx: ToolContext): string {
  return findOnPath(target.binary, ctx.env) && target.cliAdd?.(scope, PLACEHOLDER_LAUNCH, {})
    ? `${target.binary} mcp add`
    : 'config file';
}

const STATUS_MARK: Record<ToolResult['status'], string> = {
  installed: '✓',
  updated: '✓',
  unchanged: '✓',
  removed: '✓',
  absent: '·',
  kept: '!',
  failed: '✗',
};

function describeResult(result: ToolResult, ctx: ToolContext): string {
  const where = displayPath(result.path, ctx);
  const how = result.method === 'cli' ? ` (${findToolTarget(result.id)?.binary} mcp add)` : '';
  const what =
    result.status === 'installed'
      ? 'added'
      : result.status === 'updated'
        ? 'updated'
        : result.status === 'unchanged'
          ? 'already set up'
          : result.status === 'removed'
            ? 'removed'
            : result.status === 'absent'
              ? 'nothing to remove'
              : result.status === 'kept'
                ? 'left as is'
                : 'failed';
  return `${STATUS_MARK[result.status]} ${result.label.padEnd(18)} ${what}: ${where}${how}${
    result.message && (result.status === 'failed' || result.status === 'kept')
      ? `\n    ${result.message}`
      : ''
  }`;
}

/** The session name a tool's agent will get when opened in the project. */
function agentNameFor(id: ToolId, ctx: ToolContext): string {
  return sessionBaseName({ hint: id, cwd: ctx.projectRoot });
}

const CLI_FALLBACK = [
  'Scripts and shells without MCP can use the CLI instead:',
  '  relay agent register alice',
  '  relay message dm send bob "hello" --as alice',
  '  relay message inbox check --as bob',
];

/** The one thing to do next. */
function nextStep(installed: ToolId[], scope: InstallScope, ctx: ToolContext): string[] {
  const where =
    scope === 'project' ? `in ${displayPath(ctx.projectRoot, ctx) || ctx.projectRoot}` : 'in any project';
  const [first, second] = installed.map((id) => findToolTarget(id)!);
  if (first && second) {
    return [
      `Open ${first.label} ${where} and ask it:`,
      `  "Send a message to ${agentNameFor(second.id, ctx)} saying hello"`,
      `Then open ${second.label} there too. Each session joins Relay as <tool>-<folder>, so they are ${agentNameFor(
        first.id,
        ctx
      )} and ${agentNameFor(second.id, ctx)}.`,
    ];
  }
  if (first) {
    return [
      `Open ${first.label} ${where} and ask it: "Who is on Relay?"`,
      `It joins as ${agentNameFor(first.id, ctx)}. Open a second session or tool to give it someone to talk to.`,
    ];
  }
  return ['No agent tool was set up. Run relay init again to choose some.'];
}

function notesFor(installed: ToolId[], scope: InstallScope, ctx: ToolContext): string[] {
  return installed
    .map((id) => findToolTarget(id)!.note?.(scope, ctx))
    .filter((note): note is string => Boolean(note));
}

interface AgentPlan {
  tools: ToolId[];
  scope: InstallScope;
}

function installAll(
  deps: InitCommandDependencies,
  plan: AgentPlan,
  ctx: ToolContext,
  launch: McpLaunch
): ToolResult[] {
  return plan.tools.map((id) =>
    installTool(findToolTarget(id)!, launch, { ctx, scope: plan.scope, runTool: deps.runTool })
  );
}

// ---------------------------------------------------------------------------
// Message injection: the Agent Relay core

/** How messages reach an agent tool's sessions. */
type Delivery = 'inject' | 'mcp';

function coreStatePath(): string {
  return path.join(localDir(), 'core.json');
}

/** The core settings relay init turned on, so `--uninstall` turns off exactly those. */
function deliveryRecordPath(): string {
  return path.join(localDir(), 'core-settings.json');
}

/** How init came to be talking to the core. */
type CoreOrigin = 'started' | 'reused' | 'attached';

interface CoreSession {
  client: CoreClient;
  status: CoreStatus;
  origin: CoreOrigin;
  logFile?: string;
}

/**
 * The core's command line as a person can paste it: the binary relay init
 * runs, by path, since its bin folder is not on PATH (and a core relay init
 * starts keeps no copy in ~/.local/bin).
 */
function probeCommand(): string {
  return shellWord(process.env[PROBE_PATH_ENV]?.trim() || getCanonicalProbePath());
}

/** The core binary: `AGENT_RELAY_PROBE_PATH`, else the pinned release in the canonical bin slot. */
async function installProbe(deps: InitCommandDependencies): Promise<{ binary: string } | { reason: string }> {
  const explicit = process.env[PROBE_PATH_ENV]?.trim();
  if (explicit) {
    return isUsableBinary(explicit)
      ? { binary: explicit }
      : { reason: `${PROBE_PATH_ENV} (${explicit}) is not an executable file` };
  }
  const target = getCanonicalProbePath();
  const platform = deps.enginePlatform();
  const asset = probeAssetName(PROBE_VERSION, platform);
  const result = await ensureReleaseBinary({
    version: PROBE_VERSION,
    target,
    asset,
    url: asset ? probeAssetUrl(PROBE_VERSION, asset) : undefined,
    unsupported: `no Agent Relay core is published for ${platform.platform}-${platform.arch}${
      platform.musl ? ' (musl)' : ''
    }`,
    description: `the Agent Relay core (agent-relay-probe v${PROBE_VERSION}, ${asset})`,
    download: deps.downloadProbe,
    readVersion: deps.probeVersion,
    progress: (line) => deps.log(line),
  });
  if (result.status === 'installed') deps.log(`Installed agent-relay-probe v${PROBE_VERSION} to ${target}.`);
  if (result.status !== 'failed') return { binary: target };
  if (isUsableBinary(target)) {
    deps.log(`Could not update the Agent Relay core (${result.reason}); using the one at ${target}.`);
    return { binary: target };
  }
  return { reason: result.reason };
}

async function connectTo(
  deps: InitCommandDependencies,
  socket: string
): Promise<{ client: CoreClient; status: CoreStatus } | undefined> {
  const client = await deps.connectCore(socket);
  if (!client) return undefined;
  try {
    return { client, status: await client.call<CoreStatus>('status.get') };
  } catch (error) {
    client.close();
    throw error;
  }
}

/**
 * Attach to the core running on this machine, or start one. One core runs
 * per machine: the desktop app's, a service's, or the one an earlier
 * `relay init` started; a second is never started beside it.
 */
async function ensureCore(deps: InitCommandDependencies): Promise<CoreSession | { reason: string }> {
  const socket = deps.coreSocket();
  const state = readCoreState(coreStatePath());
  let running: Awaited<ReturnType<typeof connectTo>>;
  try {
    running = await connectTo(deps, socket);
  } catch (error) {
    return { reason: (error as Error).message };
  }
  if (running) {
    return { ...running, origin: state?.pid === running.status.daemon.pid ? 'reused' : 'attached' };
  }
  const probe = await installProbe(deps);
  if ('reason' in probe) return probe;
  // The download can take a while; a desktop app may have started its core meanwhile.
  const meanwhile = await connectTo(deps, socket).catch(() => undefined);
  if (meanwhile) return { ...meanwhile, origin: 'attached' };

  fs.mkdirSync(localDir(), { recursive: true, mode: 0o700 });
  const logFile = path.join(localDir(), 'core.log');
  deps.log('Starting the Agent Relay core…');
  let pid: number;
  try {
    pid = deps.startCore({ binary: probe.binary, socket, logFile });
  } catch (error) {
    return { reason: `the Agent Relay core could not be started (${(error as Error).message})` };
  }
  const deadline = Date.now() + CORE_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const up = await connectTo(deps, socket).catch(() => undefined);
    if (up) {
      // Another core may have taken the socket first; that one is then attached to.
      const started = up.status.daemon.pid === pid;
      if (started) {
        const record: CoreState = { pid, socket, binary: probe.binary, version: up.status.daemon.version };
        writePrivateJson(coreStatePath(), record);
      }
      return { ...up, origin: started ? 'started' : 'attached', logFile };
    }
    if (!deps.isAlive(pid)) break;
    await deps.sleep(250);
  }
  deps.stop(pid);
  const tail = logTail(logFile);
  return {
    reason: `the Agent Relay core did not start${tail ? `. Last lines of ${logFile}:\n${tail}` : ''}`,
  };
}

function describeCore(session: CoreSession): string {
  const { pid, version } = session.status.daemon;
  switch (session.origin) {
    case 'started':
      return `Started the Agent Relay core (agent-relay-probe ${version}, pid ${pid}) in the background. Log: ${session.logFile}`;
    case 'reused':
      return `The Agent Relay core relay init started earlier is running (agent-relay-probe ${version}, pid ${pid}).`;
    case 'attached':
      return (
        `Using the Agent Relay core already running on this machine (agent-relay-probe ${version}, pid ${pid}), ` +
        `the desktop app's or a service's. relay init does not start a second one.`
      );
  }
}

function sameOrigin(a: string | null | undefined, b: string): boolean {
  if (!a) return false;
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/**
 * Whether the core serves this project's workspace; undefined when it cannot
 * be told. One server can host many workspaces, so the verified workspace
 * ids decide whenever both are known; names stand in only for workspaces
 * init named itself (a self-hosted one is saved under the person's name).
 */
function sameWorkspace(workspace: CoreStatus['workspace'], setup: ServerSetup): boolean | undefined {
  if (!sameOrigin(workspace.base_url, setup.origin)) return false;
  const coreId = workspace.verification === 'verified' ? workspace.workspace_id : undefined;
  if (coreId && setup.workspaceId) return coreId === setup.workspaceId;
  if (setup.mode === 'own') return undefined;
  return !workspace.workspace_name || workspace.workspace_name === setup.workspace;
}

/**
 * The core serves one workspace per machine (the machine-wide active one,
 * unless its environment names another). Say so when that is not this
 * project's, since its agents would then be injected from a different
 * workspace than the one the CLI uses here.
 */
async function coreWorkspaceNote(
  deps: InitCommandDependencies,
  client: CoreClient,
  setup: ServerSetup
): Promise<string | undefined> {
  let workspace: CoreStatus['workspace'];
  try {
    workspace = await client.call<CoreStatus['workspace']>('workspace.refresh');
    // Verifying a newly found key is quick but asynchronous.
    for (let i = 0; i < 20 && workspace.state === 'found' && workspace.verification === 'pending'; i += 1) {
      await deps.sleep(500);
      workspace = (await client.call<CoreStatus>('status.get')).workspace;
    }
  } catch {
    return undefined;
  }
  if (workspace.state !== 'found') {
    return `The Agent Relay core has not found workspace "${setup.workspace}" yet; it looks again every 30 seconds.`;
  }
  if (workspace.verification === 'rejected') {
    return `The Agent Relay core's workspace key was refused by ${workspace.base_url ?? 'its server'}.`;
  }
  const same = sameWorkspace(workspace, setup);
  if (same === true) return undefined;
  if (same === undefined) {
    return (
      `Could not confirm that the Agent Relay core serves "${setup.workspace}" (${setup.origin} names no ` +
      `workspace id it can compare). See which one it serves with: ${probeCommand()} relay call status.get`
    );
  }
  const served = workspace.workspace_name ? `workspace "${workspace.workspace_name}"` : 'another workspace';
  return (
    `The Agent Relay core on this machine serves ${served} (${workspace.base_url ?? 'unknown server'}), ` +
    `not "${setup.workspace}": agents here join that workspace. The core follows the machine-wide active ` +
    `workspace; to use "${setup.workspace}" everywhere, run: ${switchCommand(setup.workspace)}`
  );
}

interface InjectionSetup {
  core: string;
  results: DeliveryResult[];
  workspaceNote?: string;
}

/**
 * Attach to or start the core, then turn on its delivery for `tools`. The
 * settings are the person's own (under their home), so they apply to every
 * project on this machine whatever the install scope.
 */
async function setupInjection(
  deps: InitCommandDependencies,
  tools: ToolId[],
  setup: ServerSetup
): Promise<InjectionSetup | { reason: string }> {
  const session = await ensureCore(deps);
  if ('reason' in session) return session;
  try {
    const record = readDeliveryRecord(deliveryRecordPath());
    const ctx = deps.toolContext();
    // Every Claude login's crossSessionInbound before anything changes: what
    // turning direct delivery off again puts back, the person's own choices
    // included, instead of the hold the core writes on each login.
    const before = tools.includes('claude') ? claudeInboundValues(ctx) : {};
    // The files the core is about to edit, as they are now: what --uninstall
    // tidies back to (a settings.json, plugins or extensions folder, or off
    // marker init created).
    const files: Leftovers = {
      claudeFiles: tools.includes('claude') ? claudeFileStates(claudeLoginSettings(ctx)) : undefined,
      openCode: tools.includes('opencode') ? openCodeState(openCodeConfigDir(ctx.env, ctx.home)) : undefined,
      pi: tools.includes('pi') ? piState(piAgentDir(ctx.env, ctx.home), ctx.home) : undefined,
    };
    const { results, turnedOn, turnedOff } = await enableDelivery(session.client, tools, record.turnedOn);
    // Applied to the record as it is now, not as it was read: another
    // relay init may have recorded its own changes meanwhile.
    const save = () =>
      updateDeliveryRecord((current) => {
        // Older originals win: they were recorded before init first changed anything.
        const originals = { ...before, ...current.claudeInbound };
        if (turnedOff.includes('direct_delivery')) restoreClaudeInbound(originals);
        // A setting this run turned on, kept or rolled back again (then in
        // turnedOff): its files are tidied below once nothing edits them.
        const touched = [...turnedOn, ...turnedOff];
        const claudeOn = touched.some((key) => CLAUDE_FILE_KEYS.includes(key));
        return tidyLeftovers({
          turnedOn: [...new Set([...current.turnedOn, ...turnedOn])].filter(
            (key) => !turnedOff.includes(key)
          ),
          claudeInbound: turnedOff.includes('direct_delivery')
            ? {}
            : turnedOn.includes('direct_delivery')
              ? originals
              : current.claudeInbound,
          claudeFiles:
            claudeOn && files.claudeFiles
              ? { ...files.claudeFiles, ...current.claudeFiles }
              : current.claudeFiles,
          openCode: touched.includes('opencode_plugin')
            ? (current.openCode ?? files.openCode)
            : current.openCode,
          pi: touched.includes('pi_extension') ? (current.pi ?? files.pi) : current.pi,
        });
      });
    try {
      save();
    } catch (error) {
      await undoUnrecorded(session.client, turnedOn, before, files, error as Error);
      throw error;
    }
    // A failed tool whose settings could not be turned off is still on the
    // core's route: it gets no MCP server, and setup stops (it is recorded,
    // so --uninstall can still turn it off).
    const stuck = results.filter((result) => result.stuck && result.stuck.length > 0);
    if (stuck.length > 0) {
      throw new InjectionStuckError(
        stuck.map((result) => `${findToolTarget(result.id)!.label}: ${result.message}`).join('\n') +
          '\nThese settings relay init turned on could not be turned off after the tool failed, so no ' +
          'Relay MCP server was added for it (two routes would split its messages). Run relay init ' +
          'again once the core answers, or relay init --uninstall.'
      );
    }
    const workspaceNote = await coreWorkspaceNote(deps, session.client, setup);
    return { core: describeCore(session), results, workspaceNote };
  } catch (error) {
    if (error instanceof InjectionStuckError) throw error;
    return { reason: `the Agent Relay core could not be set up (${(error as Error).message})` };
  } finally {
    session.client.close();
  }
}

/** The bytes of the regular file `file` is or links to; undefined when there is none. */
function readIfFile(file: string): Buffer | undefined {
  let fd: number | undefined;
  try {
    // One descriptor for the check and the read, so they see the same file.
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    return fs.fstatSync(fd).isFile() ? fs.readFileSync(fd) : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Puts `bytes` back in `file`; a failure leaves the core's marker, which means the same. */
function restoreBytes(file: string, bytes: Buffer): void {
  try {
    fs.writeFileSync(file, bytes);
  } catch {
    // The core's own marker stays: Pi is still off.
  }
}

/** Settings init turned on that are neither recorded nor turned off: setup stops. */
class InjectionStuckError extends Error {}

/**
 * The record of what this run turned on could not be saved: turn those
 * settings off again, so the MCP fallback is the only route and nothing is
 * left that `--uninstall` would not know about.
 * @throws InjectionStuckError when any stays on; no MCP server is added then.
 */
async function undoUnrecorded(
  client: CoreClient,
  turnedOn: string[],
  before: Record<string, string | null>,
  files: Leftovers,
  cause: Error
): Promise<void> {
  const failures = await disableDelivery(client, turnedOn);
  const failed = (key: string) => failures.some((f) => f.startsWith(`${key}:`));
  if (turnedOn.includes('direct_delivery') && !failed('direct_delivery')) {
    restoreClaudeInbound(before);
  }
  if (turnedOn.some((key) => CLAUDE_FILE_KEYS.includes(key)) && !CLAUDE_FILE_KEYS.some(failed)) {
    if (files.claudeFiles) tidyClaudeSettings(files.claudeFiles);
  }
  if (turnedOn.includes('opencode_plugin') && !failed('opencode_plugin') && files.openCode) {
    tidyOpenCodePlugin(files.openCode);
  }
  if (turnedOn.includes('pi_extension') && !failed('pi_extension') && files.pi) {
    tidyPiExtension(files.pi);
  }
  if (failures.length > 0) {
    throw new InjectionStuckError(
      `Could not save ${deliveryRecordPath()} (${cause.message}), and these settings relay init turned on ` +
        `could not be turned off again: ${failures.join('; ')}. Turn them off with ` +
        `${probeCommand()} relay call settings.set --params '{"<setting>":false}', then run relay init again.`,
      { cause }
    );
  }
}

const DELIVERY_MARK: Record<DeliveryResult['status'], string> = { on: '✓', held: '!', failed: '✗' };

function describeDelivery(result: DeliveryResult): string {
  const label = findToolTarget(result.id)!.label.padEnd(18);
  if (result.status === 'failed') {
    return `${DELIVERY_MARK.failed} ${label} not injected: ${result.message}\n    Using the Relay MCP server for it instead.`;
  }
  const line = `${DELIVERY_MARK[result.status]} ${label} injected through ${result.route}`;
  return result.status === 'held' ? `${line}\n    ${result.message}` : line;
}

const INJECTION_SCOPE_NOTE =
  'These are settings of your user account, so they apply in every project on this machine. ' +
  'relay init --uninstall turns off what it turned on; relay init --stop stops a core it started.';

/**
 * Remove the MCP entry an earlier `relay init` added for tools whose messages
 * are now injected, in both scopes: the session's identity is the core's, and
 * a second one through MCP would split its messages. A removal that failed is
 * returned too, so the person can finish it.
 */
function removeSupersededMcp(tools: ToolId[], ctx: ToolContext): ToolResult[] {
  return tools.flatMap((id) =>
    (['project', 'global'] as const)
      .map((scope) => uninstallTool(findToolTarget(id)!, { ctx, scope }))
      .filter((result) => result.status === 'removed' || result.status === 'failed')
  );
}

function describeSupersededMcp(result: ToolResult, ctx: ToolContext): string {
  const where = displayPath(result.path, ctx);
  if (result.status === 'removed') {
    return `✓ ${result.label.padEnd(18)} removed the earlier Relay MCP entry from ${where}: one identity per session`;
  }
  return (
    `✗ ${result.label.padEnd(18)} could not remove the earlier Relay MCP entry from ${where}` +
    `${result.message ? ` (${result.message})` : ''}.\n    Remove its agent-relay entry by hand: ` +
    'until then its sessions also join through MCP, as a second identity.'
  );
}

/** What is next when messages are injected. */
function injectionNextStep(injected: ToolId[]): string[] {
  const labels = injected.map((id) => findToolTarget(id)!.label);
  const tools = labels.length > 1 ? `${labels.slice(0, -1).join(', ')} or ${labels.at(-1)}` : labels[0];
  return [
    `Open ${tools} in any project. Each session joins Relay on its own, and messages to it are`,
    'typed into the running session: no inbox to check. See who is on Relay with: relay agent list',
  ];
}

/** The Claude Code config folder the CLI's environment uses. */
function claudeConfigDir(ctx: ToolContext): string {
  const configured = ctx.env.CLAUDE_CONFIG_DIR;
  return configured && path.isAbsolute(configured) ? configured : path.join(ctx.home, '.claude');
}

/**
 * The settings files of every Claude login the core's direct delivery
 * follows (`ClaudeSettings::login_settings` in crates/probe): this login,
 * then the `.claude` and `.claude-<name>` folders beside it, the folders in
 * `AGENT_RELAY_CLAUDE_CONFIG_DIRS`, and those the core recorded in
 * `claude-config-dirs.json`, each counted only when it holds `.claude.json`.
 */
function claudeLoginSettings(ctx: ToolContext): string[] {
  const own = claudeConfigDir(ctx);
  const others = [...claudeSiblings(own), ...claudeEnvironmentDirs(ctx), ...claudeRecordedDirs()];
  const seen = new Set<string>();
  const files: string[] = [];
  for (const folder of [own, ...others]) {
    if (folder !== own && !fs.existsSync(path.join(folder, '.claude.json'))) continue;
    const file = path.join(folder, 'settings.json');
    const real = realOrResolved(file);
    if (seen.has(real)) continue;
    seen.add(real);
    files.push(file);
  }
  return files;
}

function realOrResolved(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

/** The `.claude` and `.claude-<name>` folders beside `own`, as account switchers keep. */
function claudeSiblings(own: string): string[] {
  const parent = path.dirname(own);
  try {
    return fs
      .readdirSync(parent)
      .sort()
      .filter((name) => name === '.claude' || name.startsWith('.claude-'))
      .map((name) => path.join(parent, name));
  } catch {
    return [];
  }
}

/** `AGENT_RELAY_CLAUDE_CONFIG_DIRS`, as the core reads it. */
function claudeEnvironmentDirs(ctx: ToolContext): string[] {
  return (ctx.env.AGENT_RELAY_CLAUDE_CONFIG_DIRS ?? '')
    .split(path.delimiter)
    .map((entry) => entry.trim().replace(/^~(?=$|[\\/])/, ctx.home))
    .filter((folder) => folder && path.isAbsolute(folder));
}

/** The folders added in the desktop's Settings or seen running, from `claude-config-dirs.json`. */
function claudeRecordedDirs(): string[] {
  try {
    const recorded = JSON.parse(
      fs.readFileSync(path.join(relayHome(), 'claude-config-dirs.json'), 'utf8')
    ) as { added?: unknown; running?: unknown } | null;
    return [recorded?.added, recorded?.running]
      .flatMap((list) => (Array.isArray(list) ? list : []))
      .filter((folder): folder is string => typeof folder === 'string' && path.isAbsolute(folder));
  } catch {
    return [];
  }
}

/** A Claude settings file's `crossSessionInbound`, `null` when unset, undefined when unreadable. */
function claudeInbound(file: string): string | null | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined;
  }
  try {
    const settings = JSON.parse(text) as unknown;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return undefined;
    const value = (settings as Record<string, unknown>).crossSessionInbound;
    return value === undefined ? null : typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Each readable Claude login's `crossSessionInbound` (null: absent), by settings file. */
function claudeInboundValues(ctx: ToolContext): Record<string, string | null> {
  const values: Record<string, string | null> = {};
  for (const file of claudeLoginSettings(ctx)) {
    // A login folder Claude Code has never made holds nothing to put back.
    if (!fs.existsSync(path.dirname(file))) continue;
    const value = claudeInbound(file);
    if (value !== undefined) values[file] = value;
  }
  return values;
}

/**
 * The core turns Claude Code's direct delivery off by writing
 * `crossSessionInbound: "hold"` (Claude Code's own default) on every login
 * where it was on, the person's own `accept` included. Run after that core
 * call (the core writes it then, and not again until direct delivery is
 * turned on), this puts back each login's value from before init: removed
 * where it was absent, the person's own value where they had one. A login
 * the person changed since (anything but `hold`) is left as it is.
 * @param originals - Settings file to its value before init (null: absent)
 */
function restoreClaudeInbound(originals: Record<string, string | null>): void {
  for (const [file, original] of Object.entries(originals)) {
    if (original === 'hold') continue;
    try {
      const settings = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) continue;
      if (settings.crossSessionInbound !== 'hold') continue;
      if (original === null) delete settings.crossSessionInbound;
      else settings.crossSessionInbound = original;
      writeKeepingMode(file, `${JSON.stringify(settings, null, 2)}\n`);
    } catch {
      // Unreadable or not JSON: left as the core wrote it.
    }
  }
}

/** The Claude values to restore: the recorded ones, else (an older record) this login's unset. */
function recordedClaudeFiles(record: DeliveryRecord, ctx: ToolContext): Record<string, string | null> {
  return Object.keys(record.claudeInbound).length > 0
    ? record.claudeInbound
    : { [path.join(claudeConfigDir(ctx), 'settings.json')]: null };
}

/** The core settings that edit a Claude login's `settings.json`. */
const CLAUDE_FILE_KEYS = ['direct_delivery', 'claude_session_hook'];

/** The tool files init found before the core edited them (see `init-leftovers.ts`). */
interface Leftovers {
  claudeFiles?: Record<string, ClaudeFileState>;
  openCode?: OpenCodeState;
  pi?: PiState;
}

/**
 * Once nothing init turned on edits a tool's files any more, tidies them
 * back to how init found them (a Claude settings.json init created, the
 * OpenCode plugin's and Pi extension's off markers) and drops their
 * recorded state. Run after
 * the core turned the settings off and the original crossSessionInbound is
 * back.
 * @returns The record without the states it used
 */
function tidyLeftovers(record: DeliveryRecord): DeliveryRecord {
  let { claudeFiles, openCode, pi } = record;
  if (claudeFiles && !record.turnedOn.some((key) => CLAUDE_FILE_KEYS.includes(key))) {
    tidyClaudeSettings(claudeFiles);
    claudeFiles = undefined;
  }
  if (openCode && !record.turnedOn.includes('opencode_plugin')) {
    tidyOpenCodePlugin(openCode);
    openCode = undefined;
  }
  if (pi && !record.turnedOn.includes('pi_extension')) {
    tidyPiExtension(pi);
    pi = undefined;
  }
  return {
    turnedOn: record.turnedOn,
    claudeInbound: record.claudeInbound,
    ...(claudeFiles ? { claudeFiles } : {}),
    ...(openCode ? { openCode } : {}),
    ...(pi ? { pi } : {}),
  };
}

/**
 * Change the record of what init turned on, reading it just before the
 * write so concurrent runs do not drop each other's changes.
 */
function updateDeliveryRecord(change: (current: DeliveryRecord) => DeliveryRecord): void {
  writeDeliveryRecord(change(readDeliveryRecord(deliveryRecordPath())));
}

/** Save what init turned on; no record at all once nothing is. */
function writeDeliveryRecord(record: DeliveryRecord): void {
  if (record.turnedOn.length === 0) {
    fs.rmSync(deliveryRecordPath(), { force: true });
    return;
  }
  writePrivateJson(deliveryRecordPath(), {
    turnedOn: record.turnedOn,
    ...(Object.keys(record.claudeInbound).length > 0 ? { claudeInbound: record.claudeInbound } : {}),
    ...(record.claudeFiles ? { claudeFiles: record.claudeFiles } : {}),
    ...(record.openCode ? { openCode: record.openCode } : {}),
    ...(record.pi ? { pi: record.pi } : {}),
  });
}

/**
 * The recorded settings to turn off when `tools` leave injection: theirs,
 * and automatic activation once no tool init injects into is left.
 */
function recordedKeysFor(tools: ToolId[]): string[] {
  const recorded = readDeliveryRecord(deliveryRecordPath()).turnedOn;
  const leaving = new Set(tools.flatMap(deliveryKeys));
  const keys = recorded.filter((key) => leaving.has(key));
  const remaining = recorded.filter((key) => !leaving.has(key) && key !== AUTO_ACTIVATE.read);
  if (keys.length > 0 && remaining.length === 0 && recorded.includes(AUTO_ACTIVATE.read)) {
    keys.push(AUTO_ACTIVATE.read);
  }
  return keys;
}

/**
 * Turn off recorded core settings, starting a core for it when none runs
 * (and stopping that one again). Throws, keeping the record of what stayed
 * on, when any could not be turned off.
 * @returns The keys turned off
 */
async function turnOffInjection(deps: InitCommandDependencies, keys: string[]): Promise<string[]> {
  if (keys.length === 0) return [];
  const session = await ensureCore(deps);
  if ('reason' in session) {
    throw new Error(`Could not reach the Agent Relay core to turn off message injection: ${session.reason}`);
  }
  try {
    // A Pi off marker already there was the person's own opt-out after init
    // (the desktop app's switch), not this run's: it is kept, byte for byte,
    // though turning pi_extension off rewrites it.
    const pi = readDeliveryRecord(deliveryRecordPath()).pi;
    const piOptedOut =
      keys.includes('pi_extension') &&
      pi !== undefined &&
      fs.lstatSync(pi.marker, { throwIfNoEntry: false }) !== undefined;
    const piMarker = piOptedOut && pi ? readIfFile(pi.marker) : undefined;
    const failures = await disableDelivery(session.client, keys);
    if (pi && piMarker) restoreBytes(pi.marker, piMarker);
    const done = keys.filter((key) => !failures.some((failure) => failure.startsWith(`${key}:`)));
    const ctx = deps.toolContext();
    updateDeliveryRecord((current) => {
      if (done.includes('direct_delivery')) restoreClaudeInbound(recordedClaudeFiles(current, ctx));
      return tidyLeftovers({
        ...current,
        // Kept as if it had been there before init; an extensions folder init created still goes.
        ...(piOptedOut && current.pi ? { pi: { ...current.pi, off: true } } : {}),
        turnedOn: current.turnedOn.filter((key) => !done.includes(key)),
        claudeInbound: done.includes('direct_delivery') ? {} : current.claudeInbound,
      });
    });
    if (failures.length > 0) {
      throw new Error(`Some injection settings could not be turned off: ${failures.join('; ')}`);
    }
    return done;
  } finally {
    session.client.close();
    // A core started only to undo the settings is stopped again.
    if (session.origin === 'started') await stopCore(deps, true);
  }
}

/** Turn off everything relay init turned on in the core. */
async function uninstallInjection(deps: InitCommandDependencies): Promise<string[]> {
  return turnOffInjection(deps, readDeliveryRecord(deliveryRecordPath()).turnedOn);
}

/**
 * Stop the core relay init started, never one it attached to.
 * @param quiet - Say nothing (used after a core started only for `--uninstall`)
 */
async function stopCore(deps: InitCommandDependencies, quiet = false): Promise<void> {
  const say = (line: string) => {
    if (!quiet) deps.log(line);
  };
  const state = readCoreState(coreStatePath());
  if (!state) return;
  const running = await connectTo(deps, state.socket).catch(() => undefined);
  if (running && running.status.daemon.pid !== state.pid) {
    running.client.close();
    say(
      'The Agent Relay core running now was not started by relay init (the desktop app or a service); left running.'
    );
  } else if (running) {
    await running.client.call('daemon.shutdown').catch(() => undefined);
    running.client.close();
    for (let i = 0; i < 40 && deps.isAlive(state.pid); i += 1) await deps.sleep(250);
    if (deps.isAlive(state.pid)) deps.stop(state.pid);
    say(
      'Stopped the Agent Relay core relay init started. Messages are no longer injected until it runs again.'
    );
  } else {
    // No core answers: the one init started has exited. Its pid may belong to
    // another program by now, so it is never signalled; the record is dropped.
    say('The Agent Relay core relay init started is no longer running.');
  }
  fs.rmSync(coreStatePath(), { force: true });
}

// ---------------------------------------------------------------------------
// Command

interface InitOptions {
  hosted?: boolean;
  url?: string;
  key?: string;
  name?: string;
  port: number;
  stop?: boolean;
  tools?: ToolId[];
  scope?: InstallScope;
  delivery?: Delivery;
  /** Accepted for older commands; asking nothing is already the default. */
  yes?: boolean;
  interactive?: boolean;
  uninstall?: boolean;
}

function serverChoiceFromFlags(o: InitOptions): ServerChoice | undefined {
  if (o.url && !o.key) throw new Error('Pass --key with --url for your own server.');
  if (o.url && o.hosted) throw new Error('Choose either --hosted or --url/--key.');
  // A key joins its workspace: on --url's server, else on the hosted service.
  if (o.key) return { mode: 'own', url: o.url, key: o.key, name: o.name, port: o.port };
  if (o.hosted) return { mode: 'hosted', name: o.name, port: o.port };
  return undefined;
}

async function stopLocalServer(deps: InitCommandDependencies): Promise<void> {
  const state = readState();
  if (!state || !deps.isAlive(state.pid)) {
    deps.log('No local Relay server is running.');
  } else {
    deps.stop(state.pid);
    deps.log(`Stopped the local Relay server on ${state.origin}. Its data is kept in ${localDir()}.`);
  }
  fs.rmSync(statePath(), { force: true });
  await stopCore(deps);
}

/**
 * Remove `~/.local/bin/agent-relay-probe` when it is a byte-for-byte copy of
 * the core relay init installs. The desktop app's core keeps that copy up to
 * date for terminal use, and cores up to 15.0.3 did so even when relay init
 * started them; a copy of any other build (the desktop's own) is left alone,
 * and the desktop puts its copy back when it next starts.
 * @returns The removed copy's path, when there was one to remove.
 */
function removeProbeCopy(ctx: ToolContext): string | undefined {
  const copy = path.join(
    ctx.home,
    '.local',
    'bin',
    process.platform === 'win32' ? 'agent-relay-probe.exe' : 'agent-relay-probe'
  );
  // Best effort: an unreadable ~/.local/bin never fails the uninstall.
  try {
    // lstat, so a symlink there (someone's own install) is never followed.
    if (!fs.lstatSync(copy, { throwIfNoEntry: false })?.isFile()) return undefined;
    const ours = readIfFile(getCanonicalProbePath());
    const theirs = ours ? readIfFile(copy) : undefined;
    if (!ours || !theirs || !ours.equals(theirs)) return undefined;
    fs.rmSync(copy);
    return copy;
  } catch {
    return undefined;
  }
}

async function uninstall(deps: InitCommandDependencies, o: InitOptions): Promise<void> {
  const ctx = deps.toolContext();
  // Outside a project (in ~, or a folder whose nearest Relay folder is a relay
  // home) there is no project scope: its paths would be the user's own global
  // configs (~/.grok/config.toml), which only the global scope may touch.
  const noProject = isHomeProjectRoot(ctx.projectRoot);
  if (noProject && o.scope === 'project') {
    deps.log('Not inside a project, so there is no project scope to remove Relay from.');
    return;
  }
  const scopes: InstallScope[] = o.scope ? [o.scope] : noProject ? ['global'] : ['project', 'global'];
  const tools = o.tools ?? [...TOOL_IDS];
  const results = scopes.flatMap((scope) =>
    tools.map((id) => uninstallTool(findToolTarget(id)!, { ctx, scope }))
  );
  const shown = results.filter((result) => result.status !== 'absent');
  for (const result of shown) deps.log(describeResult(result, ctx));

  // Injection settings are the user's own, not a project's: turned off with
  // the global scope (or both), and only for all tools at once.
  let turnedOff: string[] = [];
  const injectionKept = readDeliveryRecord(deliveryRecordPath()).turnedOn.length > 0;
  if (injectionKept && o.scope !== 'project' && o.tools === undefined) {
    turnedOff = await uninstallInjection(deps);
    deps.log(`✓ Message injection    turned off what relay init turned on (${turnedOff.join(', ')})`);
  } else if (injectionKept) {
    deps.log(
      '! Message injection is a per-user setting and was left on. Run relay init --uninstall without ' +
        '--scope project or --tools to turn it off.'
    );
  }
  const removedCopy = o.scope !== 'project' && o.tools === undefined ? removeProbeCopy(ctx) : undefined;
  if (removedCopy)
    deps.log(`✓ Agent Relay core     removed the copy a core relay init started left at ${removedCopy}`);
  if (shown.length === 0 && turnedOff.length === 0 && !injectionKept && !removedCopy) {
    deps.log('relay init had not added Relay to any agent tool here; nothing to remove.');
    return;
  }
  if (results.some((result) => result.status === 'failed'))
    throw new Error('Some entries could not be removed.');
}

/** The tools that end up on the MCP server, and the injection results, for one run. */
interface DeliveryPlan {
  injection?: InjectionSetup;
  /** Why injection is not used, when it was wanted. */
  unavailable?: string;
  injected: ToolId[];
  mcp: ToolId[];
  removedMcp: ToolResult[];
  /** Core settings init had turned on for tools now on the MCP server, turned off again. */
  turnedOff: string[];
}

/** Set up injection for `tools` when wanted; whatever it cannot serve goes to the MCP server. */
async function planDelivery(
  deps: InitCommandDependencies,
  tools: ToolId[],
  delivery: Delivery,
  setup: ServerSetup,
  ctx: ToolContext
): Promise<DeliveryPlan> {
  if (tools.length === 0) return { injected: [], mcp: tools, removedMcp: [], turnedOff: [] };
  if (delivery === 'mcp') {
    // One route per tool: what init injected into these tools is turned off
    // before their MCP server is added, or the MCP server is not added.
    const turnedOff = await turnOffInjection(deps, recordedKeysFor(tools));
    return { injected: [], mcp: tools, removedMcp: [], turnedOff };
  }
  const injection = await setupInjection(deps, tools, setup);
  if ('reason' in injection)
    return { unavailable: injection.reason, injected: [], mcp: tools, removedMcp: [], turnedOff: [] };
  const injected = injection.results.filter((r) => r.status !== 'failed').map((r) => r.id);
  return {
    injection,
    injected,
    mcp: injection.results.filter((r) => r.status === 'failed').map((r) => r.id),
    removedMcp: removeSupersededMcp(injected, ctx),
    turnedOff: [],
  };
}

/** The line saying injection was turned off for a switch to the MCP server. */
function turnedOffLine(keys: string[]): string {
  return (
    `✓ Message injection    turned off what relay init had turned on (${keys.join(', ')}): ` +
    'these tools now use only the Relay MCP server, one identity per session'
  );
}

function unavailableLine(reason: string): string {
  return (
    `Message injection is not available (${reason}). Using the Relay MCP server instead: ` +
    'agents check its inbox themselves.'
  );
}

function injectionLines(plan: DeliveryPlan, ctx: ToolContext): string[] {
  if (!plan.injection) return [];
  return [
    plan.injection.core,
    ...plan.injection.results.map(describeDelivery),
    ...plan.removedMcp.map((result) => describeSupersededMcp(result, ctx)),
    ...(plan.injection.workspaceNote ? [`! ${plan.injection.workspaceNote}`] : []),
    INJECTION_SCOPE_NOTE,
  ];
}

/** `relay init` without prompts: flags, then sensible defaults. */
async function runPlain(deps: InitCommandDependencies, o: InitOptions): Promise<void> {
  const setup = await setupServer(
    deps,
    serverChoiceFromFlags(o) ?? { mode: 'local', name: o.name, port: o.port }
  );
  deps.log(setup.headline);
  for (const line of setup.details) deps.log(line);

  const ctx = deps.toolContext();
  const tools = o.tools ?? detectTools(ctx).map((tool) => tool.id);
  const scope = o.scope ?? 'global';
  const plan = await planDelivery(deps, tools, o.delivery ?? 'inject', setup, ctx);
  if (plan.injection) {
    deps.log('');
    deps.log('Injecting messages into your agent sessions:');
    for (const line of injectionLines(plan, ctx)) deps.log(`  ${line}`);
  } else if (plan.unavailable) {
    deps.log('');
    deps.log(unavailableLine(plan.unavailable));
  }
  if (plan.turnedOff.length > 0) {
    deps.log('');
    deps.log(turnedOffLine(plan.turnedOff));
  }

  const installed: ToolId[] = [];
  if (plan.mcp.length > 0) {
    const launch = deps.resolveLaunch(ctx, scope);
    deps.warmLaunch(launch);
    deps.log('');
    deps.log(
      `Adding the Relay MCP server (${[launch.command, ...launch.args].join(' ')}) to your agent tools:`
    );
    for (const result of installAll(deps, { tools: plan.mcp, scope }, ctx, launch)) {
      deps.log(`  ${describeResult(result, ctx)}`);
      if (['installed', 'updated', 'unchanged'].includes(result.status)) installed.push(result.id);
    }
    if (launch.warning) deps.log(`  ! ${launch.warning}`);
    for (const note of notesFor(installed, scope, ctx)) deps.log(`  ${note}`);
    const scopeNote = globalScopeNote(setup, scope, installed);
    if (scopeNote) deps.log(`  ! ${scopeNote}`);
  } else if (tools.length === 0 && o.tools === undefined) {
    deps.log('');
    deps.log(`No agent tools found (looked for ${TOOL_IDS.join(', ')}). Pass --tools to choose some.`);
  }
  deps.log('');
  deps.log('Next:');
  if (plan.injected.length > 0) for (const line of injectionNextStep(plan.injected)) deps.log(`  ${line}`);
  for (const line of installed.length > 0 ? nextStep(installed, scope, ctx) : []) deps.log(`  ${line}`);
  for (const line of CLI_FALLBACK) deps.log(`  ${line}`);
  deps.log('');
  for (const line of choicesSummary(o, setup, tools, scope)) deps.log(line);
}

/**
 * What a `relay init` that asked nothing chose, each with the flag that
 * changes it, so the defaults are never a surprise.
 */
function choicesSummary(o: InitOptions, setup: ServerSetup, tools: ToolId[], scope: InstallScope): string[] {
  const where =
    setup.mode === 'local'
      ? 'this machine (--hosted for agents on other machines, or --url and --key for your own server)'
      : setup.mode === 'hosted' && !o.url
        ? `hosted workspace "${setup.workspace}"${o.name ? '' : ' (--name to name it)'}`
        : `workspace "${setup.workspace}" on ${setup.origin}`;
  const toolList = tools.length > 0 ? tools.join(', ') : 'none';
  return [
    'Chosen without asking:',
    `  Server:  ${where}`,
    `  Tools:   ${toolList}${o.tools ? '' : ' (the ones installed here; --tools to choose)'}`,
    `  Scope:   ${scope}${o.scope ? '' : ' (--scope project for this project only)'}`,
    'To choose each step yourself, run: relay init --interactive',
  ];
}

/**
 * Codex reads a project's .codex/config.toml only once that project is
 * trusted, which `codex exec` never asks about. Offer to record the trust
 * Codex's own first-run prompt would, since it also relaxes Codex's approval
 * defaults in the project. `--yes` never trusts on the person's behalf.
 */
async function offerCodexTrust(p: InitPrompter, ctx: ToolContext): Promise<void> {
  if (codexProjectTrust(ctx) !== 'unset') return;
  const root = codexProjectRoot(ctx);
  const trust = await p.confirm({
    message:
      `Codex reads .codex/config.toml only in projects it trusts. Trust ${root} in Codex now? ` +
      '(Codex asks the same on its first run here; trusted projects get its trusted approval defaults.)',
    initialValue: true,
  });
  if (trust !== true) return;
  try {
    trustCodexProject(ctx);
    p.info(`Codex now trusts ${root} (${displayPath(codexUserConfigPath(ctx), ctx)}).`);
  } catch (error) {
    p.warn((error as Error).message);
  }
}

/** `relay init` in a terminal: ask what flags did not say. */
async function runGuided(deps: InitCommandDependencies, o: InitOptions): Promise<void> {
  const p = deps.prompter();
  const cancelled = (): void => p.cancel('Setup cancelled. Nothing else was changed.');
  p.intro(' relay init ');

  // a. Where agents talk.
  let choice = serverChoiceFromFlags(o);
  if (!choice) {
    const mode = await p.select<ServerMode>({
      message: 'Where should your agents talk?',
      initialValue: 'local',
      options: [
        { value: 'local', label: 'This machine', hint: 'a private server here, no account needed' },
        { value: 'hosted', label: 'Hosted', hint: 'agents on other machines can join' },
        { value: 'own', label: 'My own server', hint: 'a Relaycast server you run' },
      ],
    });
    if (mode === CANCELLED) return cancelled();
    choice = { mode, name: o.name, port: o.port };
    if (mode === 'own') {
      const url = await p.text({
        message: 'Server URL',
        placeholder: 'https://relay.example.com',
        validate: (value) => {
          try {
            return configuredOrigin(value.trim(), 'URL') ? undefined : 'Enter the server URL.';
          } catch (error) {
            return (error as Error).message;
          }
        },
      });
      if (url === CANCELLED) return cancelled();
      const key = await p.password({
        message: 'Workspace key',
        validate: (value) => (value.trim() ? undefined : 'Enter the workspace key.'),
      });
      if (key === CANCELLED) return cancelled();
      choice = { ...choice, url: url.trim(), key: key.trim() };
    }
  }

  // b. Server and workspace.
  const spin = p.spinner();
  spin.start(choice.mode === 'local' ? 'Starting Relay on this machine' : 'Connecting to Relay');
  let setup: ServerSetup;
  try {
    setup = await setupServer({ ...deps, log: (...args) => spin.message(args.join(' ')) }, choice);
  } catch (error) {
    spin.error('Relay could not be set up.');
    throw error;
  }
  spin.stop(setup.headline);
  for (const line of setup.details) p.info(line);

  // c. Agent tools.
  const ctx = deps.toolContext();
  const detected = new Map(detectTools(ctx).map((tool) => [tool.id, tool]));
  let tools = o.tools;
  if (!tools) {
    const picked = await p.multiselect<ToolId>({
      message: 'Which agents should get Relay?',
      initialValues: TOOL_TARGETS.filter((target) => detected.has(target.id)).map((target) => target.id),
      options: TOOL_TARGETS.map((target) => ({
        value: target.id,
        label: target.label,
        hint: detected.has(target.id) ? 'detected' : 'not found',
      })),
    });
    if (picked === CANCELLED) return cancelled();
    tools = picked;
  }
  if (tools.length === 0) {
    p.note(CLI_FALLBACK.join('\n'), 'No agents selected');
    p.outro('Relay is ready. Run relay init again any time to add agents.');
    return;
  }

  // d. Scope: where the MCP server goes. Injection is per user, so only the MCP route asks.
  const delivery = o.delivery ?? 'inject';
  let scope = o.scope;
  if (!scope && delivery === 'mcp') {
    const picked = await p.select<InstallScope>({
      message: 'Installation scope',
      initialValue: 'project',
      options: [
        { value: 'project', label: 'Project', hint: `only in ${ctx.projectRoot}` },
        { value: 'global', label: 'Global', hint: 'every project on this machine' },
      ],
    });
    if (picked === CANCELLED) return cancelled();
    scope = picked;
  }
  const mcpScope = scope ?? 'project';

  // e. Install.
  const launch = deps.resolveLaunch(ctx, mcpScope);
  const summary =
    delivery === 'inject'
      ? [
          ...tools.map((id) => `${findToolTarget(id)!.label.padEnd(18)} ${PROBE_DELIVERY[id].route}`),
          '',
          'Messages are injected into running sessions by the Agent Relay core, which relay init',
          'starts in the background (or reuses, when the desktop app already runs one).',
          INJECTION_SCOPE_NOTE,
        ]
      : [
          ...tools.map((id) => {
            const target = findToolTarget(id)!;
            return `${target.label.padEnd(18)} ${displayPath(target.configPath(mcpScope, ctx), ctx)}  (${plannedMethod(
              target,
              mcpScope,
              ctx
            )})`;
          }),
          '',
          `Runs: ${[launch.command, ...launch.args].join(' ')}`,
          `      ${launch.reason}`,
        ];
  p.note(summary.join('\n'), 'Installation Summary');
  if (delivery === 'mcp' && launch.warning) p.warn(launch.warning);
  // `--interactive` asks to the end; `--yes` changes nothing here either.
  const proceed = await p.confirm({ message: 'Proceed with installation?', initialValue: true });
  if (proceed === CANCELLED || !proceed) return cancelled();

  const injecting = p.spinner();
  if (delivery === 'inject') injecting.start('Setting up message injection');
  const plan = await planDelivery(
    { ...deps, log: (...args) => injecting.message(args.join(' ')) },
    tools,
    delivery,
    setup,
    ctx
  );
  if (plan.injection) {
    injecting.stop('Message injection is set up.');
    p.note(injectionLines(plan, ctx).join('\n'), 'Message injection');
  } else if (plan.unavailable) {
    injecting.stop('Message injection is not available.');
    p.warn(unavailableLine(plan.unavailable));
  }
  if (plan.turnedOff.length > 0) p.info(turnedOffLine(plan.turnedOff));

  let results: ToolResult[] = [];
  if (plan.mcp.length > 0) {
    if (delivery === 'inject' && launch.warning) p.warn(launch.warning);
    deps.warmLaunch(launch);
    results = installAll(deps, { tools: plan.mcp, scope: mcpScope }, ctx, launch);
    p.note(results.map((result) => describeResult(result, ctx)).join('\n'), 'Relay MCP server');
  }
  const installed = results
    .filter((result) => ['installed', 'updated', 'unchanged'].includes(result.status))
    .map((result) => result.id);
  if (mcpScope === 'project' && installed.includes('codex')) await offerCodexTrust(p, ctx);
  for (const note of notesFor(installed, mcpScope, ctx)) p.info(note);
  const scopeNote = globalScopeNote(setup, mcpScope, installed);
  if (scopeNote) p.warn(scopeNote);

  // f. Next step.
  const next = [
    ...(plan.injected.length > 0 ? injectionNextStep(plan.injected) : []),
    ...(installed.length > 0 ? nextStep(installed, mcpScope, ctx) : []),
  ];
  p.note([...next, '', ...CLI_FALLBACK].join('\n'), 'Next');
  const ready = plan.injected.length > 0 || installed.length > 0;
  p.outro(ready ? 'Relay is ready.' : 'Relay is running, but no agent tool was set up.');
  if (results.some((result) => result.status === 'failed'))
    throw new Error('Some agent tools could not be set up.');
}

function parseDelivery(value: string): Delivery {
  if (value === 'inject' || value === 'mcp') return value;
  throw new InvalidArgumentError('Expected inject or mcp.');
}

/**
 * Register `relay init`: set up where agents talk (a private server on this
 * machine by default, the hosted service, or your own server), then connect
 * your agent tools. By default the Agent Relay core injects messages into
 * their running sessions; `--delivery mcp` (or a machine the core cannot run
 * on) uses the Relay MCP server instead. It asks nothing: flags, then
 * defaults (this machine, every installed tool, global scope), and a summary
 * of what it chose. `--interactive` asks each step in a terminal; `--yes` is
 * accepted and changes nothing.
 *
 * @param program - The commander program to add the command to.
 * @param overrides - Dependencies to replace, typically in tests.
 */
export function registerInitCommand(
  program: Command,
  overrides: Partial<InitCommandDependencies> = {}
): void {
  const deps = withInitDefaults(overrides);
  program
    .command('init')
    .description(
      'Set up Relay and connect your agent tools without asking: a private server on this machine (default), ' +
        'the hosted service (--hosted), or your own server (--url and --key), every installed agent tool, and ' +
        'the Agent Relay core injecting messages into running Claude Code, Codex, OpenCode, Grok, Pi and Devin ' +
        'sessions. --interactive asks each step instead'
    )
    .option('--hosted', 'Use the hosted service so agents on other machines can join')
    .option('--url <url>', 'Your own Relaycast server (with --key)')
    .option('--key <key>', 'Join the workspace this key belongs to: hosted, or on --url')
    .option('--name <name>', 'Workspace name to save this as (default: the one its server names)')
    .option('--port <port>', 'Port for the local server', parsePort, DEFAULT_LOCAL_PORT)
    .option(
      '--tools <tools>',
      `Agent tools to connect: ${TOOL_IDS.join(',')}, all, or none (default: the ones installed here)`,
      parseTools
    )
    .option(
      '--delivery <delivery>',
      'inject (default): the Agent Relay core types messages into running sessions; mcp: the Relay MCP ' +
        'server, whose inbox agents check',
      parseDelivery
    )
    .option(
      '--scope <scope>',
      'Where the Relay MCP server goes: global (default) or project (injection is always per user)',
      parseScope
    )
    .option(
      '-i, --interactive',
      'Ask where agents talk, which agent tools to connect and where the MCP server goes'
    )
    .option('-y, --yes', 'Accepted for older scripts: relay init asks nothing unless --interactive')
    .option(
      '--uninstall',
      'Remove the Relay MCP entries relay init added (both scopes unless --scope) and turn off the injection it turned on'
    )
    .option('--stop', 'Stop the local server and the Agent Relay core started by relay init')
    .action(async (o: InitOptions) => {
      await runSdk(deps, async () => {
        if (o.stop) return stopLocalServer(deps);
        if (o.uninstall) return uninstall(deps, o);
        // Before anything starts or is written: the workspace pin, and the
        // project-scoped MCP files (.mcp.json, opencode.json, .devin/...), go in
        // the project root. In ~ (or a root walked up to ~) they would land in
        // the person's home and its relay home.
        assertProjectRoot(projectRoot());
        assertProjectRoot(deps.toolContext().projectRoot);
        if (o.interactive) {
          if (!deps.isInteractive()) {
            throw new Error(
              'relay init --interactive needs a terminal; run relay init without it to use the defaults.'
            );
          }
          return runGuided(deps, o);
        }
        return runPlain(deps, o);
      });
    });
}
