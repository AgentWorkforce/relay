import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Command } from 'commander';
import { InvalidArgumentError } from 'commander';

import {
  assertOriginBindingsWritable,
  boundOrigin,
  configuredOrigin,
  guardCredentialOrigin,
} from '../lib/relaycast-origin-binding.js';
import {
  TOOL_IDS,
  TOOL_TARGETS,
  defaultRunTool,
  defaultToolContext,
  detectTools,
  findOnPath,
  findToolTarget,
  installTool,
  parseToolsFlag,
  resolveMcpLaunch,
  uninstallTool,
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
import { persistWorkspaceSession } from '../lib/workspace-session.js';
import { readWorkspaceStore } from '../lib/workspace-store.js';
import { getProjectPaths } from '@agent-relay/config';

/** The Relaycast server `relay init` runs locally. Pinned so every machine runs the same server. */
export const LOCAL_ENGINE_VERSION = '11.1.0';
export const LOCAL_ENGINE_PACKAGE = `@relaycast/engine@${LOCAL_ENGINE_VERSION}`;
const DEFAULT_LOCAL_PORT = 8787;
const HOSTED_ORIGIN = 'https://cast.agentrelay.com';
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
  /** The command agent tools run for `relay mcp`. */
  resolveLaunch: (ctx: ToolContext) => McpLaunch;
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

/** Where Agent Relay's binaries live: the same directory install.sh uses. */
function binDir(): string {
  return path.join(process.env.AGENT_RELAY_INSTALL_DIR ?? relayHome(), 'bin');
}

/** The standalone server binary install.sh places, when there is one. */
function standaloneEngine(): string | undefined {
  const binary = path.join(
    binDir(),
    process.platform === 'win32' ? 'relaycast-engine.exe' : 'relaycast-engine'
  );
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
    resolveLaunch: (ctx) => resolveMcpLaunch({ ctx }),
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

async function ensureLocalServer(deps: InitCommandDependencies, port: number): Promise<string> {
  const existing = readState();
  if (existing && deps.isAlive(existing.pid) && (await healthy(deps, existing.origin))) {
    return existing.origin;
  }
  const origin = `http://127.0.0.1:${port}`;
  if (await healthy(deps, origin)) {
    throw new Error(
      `Something else is already serving on port ${port}. Stop it, or choose another port with --port.`
    );
  }
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

async function verifyWorkspace(deps: InitCommandDependencies, origin: string, key: string): Promise<void> {
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
}

/**
 * Connect to (or start) the server and save its workspace for this project.
 * This is the original `relay init`; the agent-tool setup comes after it.
 */
async function setupServer(deps: InitCommandDependencies, choice: ServerChoice): Promise<ServerSetup> {
  if (choice.mode === 'own') {
    const { url, key } = choice;
    if (!url || !key) throw new Error('Pass --url and --key together for your own server.');
    const origin = configuredOrigin(url, '--url');
    if (!origin) throw new Error('--url is empty.');
    await verifyWorkspace(deps, origin, key);
    guardCredentialOrigin(key, url);
    const name = choice.name ?? new URL(origin).hostname;
    persistWorkspaceSession({ name, workspaceKey: key });
    return {
      headline: `Connected to your server at ${origin} as workspace "${name}".`,
      details: ['Your key is only ever sent to this server.'],
    };
  }

  if (choice.mode === 'hosted') {
    const name = choice.name ?? `relay-${os.hostname().split('.')[0]}`;
    const relay = await deps.createWorkspace(name, HOSTED_ORIGIN);
    if (!relay.workspaceKey) throw new Error('The hosted service did not return a workspace key.');
    persistWorkspaceSession({ name, workspaceKey: relay.workspaceKey });
    return {
      headline: `Created hosted workspace "${name}".`,
      details: [
        'On another machine, join it with (treat this key like a password):',
        `  relay workspace join ${name} ${relay.workspaceKey}`,
      ],
    };
  }

  const origin = await ensureLocalServer(deps, choice.port);
  const name = choice.name ?? 'local';
  // Re-running init keeps the same local workspace and its agents.
  const stored = readWorkspaceStore().workspaces[name]?.key;
  let workspaceKey = stored && boundOrigin(stored) === origin ? stored : undefined;
  if (workspaceKey) {
    // Only a key the server refuses is replaced. A timeout or server
    // error is reported instead, so a hiccup never swaps the workspace
    // (and its agents and messages) for a new one.
    await verifyWorkspace(deps, origin, workspaceKey).catch((error: unknown) => {
      if (!(error instanceof WorkspaceKeyRejectedError)) throw error;
      workspaceKey = undefined;
    });
  }
  if (!workspaceKey) {
    assertOriginBindingsWritable(origin);
    const relay = await deps.createWorkspace(name, origin);
    if (!relay.workspaceKey) throw new Error('The local server did not return a workspace key.');
    workspaceKey = relay.workspaceKey;
    guardCredentialOrigin(workspaceKey, origin);
  }
  persistWorkspaceSession({ name, workspaceKey });
  return {
    headline: `Relay is running on this machine (${origin}), workspace "${name}". No account needed.`,
    details: ['To work with agents on other machines later, run: relay init --hosted'],
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

function notesFor(installed: ToolId[], scope: InstallScope): string[] {
  return installed
    .map((id) => findToolTarget(id)!.note?.(scope))
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
  yes?: boolean;
  uninstall?: boolean;
}

function serverChoiceFromFlags(o: InitOptions): ServerChoice | undefined {
  if (Boolean(o.url) !== Boolean(o.key))
    throw new Error('Pass --url and --key together for your own server.');
  if (o.url && o.hosted) throw new Error('Choose either --hosted or --url/--key.');
  if (o.url) return { mode: 'own', url: o.url, key: o.key, name: o.name, port: o.port };
  if (o.hosted) return { mode: 'hosted', name: o.name, port: o.port };
  return undefined;
}

function stopLocalServer(deps: InitCommandDependencies): void {
  const state = readState();
  if (!state || !deps.isAlive(state.pid)) {
    deps.log('No local Relay server is running.');
  } else {
    deps.stop(state.pid);
    deps.log(`Stopped the local Relay server on ${state.origin}. Its data is kept in ${localDir()}.`);
  }
  fs.rmSync(statePath(), { force: true });
}

function uninstall(deps: InitCommandDependencies, o: InitOptions): void {
  const ctx = deps.toolContext();
  const scopes: InstallScope[] = o.scope ? [o.scope] : ['project', 'global'];
  const tools = o.tools ?? [...TOOL_IDS];
  const results = scopes.flatMap((scope) =>
    tools.map((id) => uninstallTool(findToolTarget(id)!, { ctx, scope }))
  );
  const shown = results.filter((result) => result.status !== 'absent');
  if (shown.length === 0) {
    deps.log('relay init had not added Relay to any agent tool here; nothing to remove.');
    return;
  }
  for (const result of shown) deps.log(describeResult(result, ctx));
  if (results.some((result) => result.status === 'failed'))
    throw new Error('Some entries could not be removed.');
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
  const scope = o.scope ?? 'project';
  const installed: ToolId[] = [];
  if (tools.length > 0) {
    const launch = deps.resolveLaunch(ctx);
    deps.log('');
    deps.log(
      `Adding the Relay MCP server (${[launch.command, ...launch.args].join(' ')}) to your agent tools:`
    );
    for (const result of installAll(deps, { tools, scope }, ctx, launch)) {
      deps.log(`  ${describeResult(result, ctx)}`);
      if (['installed', 'updated', 'unchanged'].includes(result.status)) installed.push(result.id);
    }
    if (launch.warning) deps.log(`  ! ${launch.warning}`);
    for (const note of notesFor(installed, scope)) deps.log(`  ${note}`);
  } else if (o.tools === undefined) {
    deps.log('');
    deps.log(`No agent tools found (looked for ${TOOL_IDS.join(', ')}). Pass --tools to choose some.`);
  }
  deps.log('');
  deps.log('Next:');
  for (const line of installed.length > 0 ? nextStep(installed, scope, ctx) : []) deps.log(`  ${line}`);
  for (const line of CLI_FALLBACK) deps.log(`  ${line}`);
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

  // d. Scope.
  let scope = o.scope;
  if (!scope) {
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

  // e. Install.
  const launch = deps.resolveLaunch(ctx);
  const summary = [
    ...tools.map((id) => {
      const target = findToolTarget(id)!;
      return `${target.label.padEnd(18)} ${displayPath(target.configPath(scope, ctx), ctx)}  (${plannedMethod(
        target,
        scope,
        ctx
      )})`;
    }),
    '',
    `Runs: ${[launch.command, ...launch.args].join(' ')}`,
    `      ${launch.reason}`,
  ];
  p.note(summary.join('\n'), 'Installation Summary');
  if (launch.warning) p.warn(launch.warning);
  if (!o.yes) {
    const proceed = await p.confirm({ message: 'Proceed with installation?', initialValue: true });
    if (proceed === CANCELLED || !proceed) return cancelled();
  }
  const results = installAll(deps, { tools, scope }, ctx, launch);
  const installed = results
    .filter((result) => ['installed', 'updated', 'unchanged'].includes(result.status))
    .map((result) => result.id);
  p.note(results.map((result) => describeResult(result, ctx)).join('\n'), 'Relay MCP server');
  for (const note of notesFor(installed, scope)) p.info(note);

  // f. Next step.
  p.note([...nextStep(installed, scope, ctx), '', ...CLI_FALLBACK].join('\n'), 'Next');
  p.outro(installed.length > 0 ? 'Relay is ready.' : 'Relay is running, but no agent tool was set up.');
  if (results.some((result) => result.status === 'failed'))
    throw new Error('Some agent tools could not be set up.');
}

/**
 * Register `relay init`: set up where agents talk (a private server on this
 * machine by default, the hosted service, or your own server), then install
 * the Relay MCP server into your agent tools. In a terminal it asks; with
 * `--yes` or without a TTY it uses flags and defaults.
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
      'Set up Relay and connect your agent tools: a private server on this machine (default), the hosted ' +
        'service (--hosted), or your own server (--url and --key), then the Relay MCP server in Claude Code, ' +
        'Codex, OpenCode, Grok, Pi and Devin'
    )
    .option('--hosted', 'Use the hosted service so agents on other machines can join')
    .option('--url <url>', 'Your own Relaycast server')
    .option('--key <key>', 'Workspace key for your own server')
    .option('--name <name>', 'Workspace name to save this as')
    .option('--port <port>', 'Port for the local server', parsePort, DEFAULT_LOCAL_PORT)
    .option(
      '--tools <tools>',
      `Agent tools to connect: ${TOOL_IDS.join(',')}, all, or none (default: the ones installed here)`,
      parseTools
    )
    .option('--scope <scope>', 'Install for this project or every project: project or global', parseScope)
    .option('-y, --yes', 'Do not ask; use flags and defaults')
    .option('--uninstall', 'Remove the Relay MCP entries relay init added (both scopes unless --scope)')
    .option('--stop', 'Stop the local server started by relay init')
    .action(async (o: InitOptions) => {
      await runSdk(deps, async () => {
        if (o.stop) return stopLocalServer(deps);
        if (o.uninstall) return uninstall(deps, o);
        if (!o.yes && deps.isInteractive()) return runGuided(deps, o);
        return runPlain(deps, o);
      });
    });
}
