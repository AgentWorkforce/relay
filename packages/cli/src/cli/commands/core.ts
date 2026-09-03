import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec, spawn as spawnProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { Command, InvalidArgumentError, Option } from 'commander';

import { getProjectPaths, loadTeamsConfig } from '@agent-relay/config';
import { HarnessDriverClient, type BrokerInitArgs } from '@agent-relay/harness-driver';
import { checkForUpdates, generateAgentName } from '@agent-relay/utils';

import { runDownCommand, runStatusCommand, runUpCommand } from '../lib/broker-lifecycle.js';
import { runUninstallCommand, runUpdateCommand } from '../lib/core-maintenance.js';
import { createRuntimeClient, spawnAgentWithClient } from '../lib/client-factory.js';
import { defaultExit, runSignalHandler } from '../lib/exit.js';

const execAsync = promisify(exec);

type ExitFn = (code: number) => never;

export interface CoreProjectPaths {
  projectRoot: string;
  dataDir: string;
  teamDir: string;
  dbPath?: string;
  projectId?: string;
}

export interface CoreTeamsConfig {
  team: string;
  autoSpawn?: boolean;
  agents: Array<{
    name: string;
    cli: string;
    task?: string;
  }>;
}

export interface SpawnedProcess {
  pid?: number;
  killed?: boolean;
  kill: (signal?: NodeJS.Signals | number) => void;
  unref?: () => void;
}

export interface CoreRelay {
  spawn: (input: {
    name: string;
    cli: string;
    channels: string[];
    args?: string[];
    task?: string;
    team?: string;
    shadowOf?: string;
    shadowMode?: 'subagent' | 'process';
  }) => Promise<unknown>;
  getStatus: () => Promise<unknown>;
  shutdown: () => Promise<unknown>;
  /** Agent Relay workspace key, available after the hello handshake. */
  workspaceKey?: string;
  /** Relay workspace id the broker joined, available after the hello handshake. */
  workspaceId?: string;
  /** PID of the underlying broker process, when available. */
  brokerPid?: number;
  /** Actual HTTP API port bound by the broker, including OS-assigned ports. */
  apiPort?: number;
}

export interface CoreFileSystem {
  existsSync: (path: string) => boolean;
  readFileSync: (path: string, encoding: BufferEncoding) => string;
  writeFileSync: (path: string, data: string, encoding?: BufferEncoding) => void;
  renameSync: (oldPath: string, newPath: string) => void;
  unlinkSync: (path: string) => void;
  readdirSync: (path: string) => string[];
  mkdirSync: (path: string, options?: { recursive?: boolean }) => void;
  rmSync: (path: string, options?: { recursive?: boolean; force?: boolean }) => void;
  accessSync: (path: string, mode?: number) => void;
}

type UpdateInfo = {
  updateAvailable: boolean;
  latestVersion?: string;
  error?: string;
};

export interface CloudNodeIdentity {
  id?: string;
  nodeId?: string;
  name: string;
}

const CLOUD_NODE_LOOKUP_BACKOFFS_MS = [200, 400, 800] as const;
// `node status` already waits on the local broker and is covered by a 10s
// end-to-end command deadline. Keep this optional Cloud diagnostic well inside
// that budget so an unreachable control plane cannot make local status hang.
const CLOUD_NODE_LOOKUP_TIMEOUT_MS = 2_000;

function cloudNodeLookupHeaders(workspaceKey: string, version: string): Record<string, string> {
  return {
    Authorization: `Bearer ${workspaceKey}`,
    'X-SDK-Version': version,
    'X-Relaycast-Origin-Client': 'agent-relay-cli',
    'X-Relaycast-Origin-Version': version,
  };
}

async function fetchCloudNodeWithRetry(
  url: URL,
  headers: Record<string, string>,
  signal: AbortSignal
): Promise<Response> {
  let response = await fetch(url, { headers, signal });
  for (const backoff of CLOUD_NODE_LOOKUP_BACKOFFS_MS) {
    if (response.status < 500 || response.status > 599) return response;
    await new Promise((resolve) => setTimeout(resolve, backoff));
    response = await fetch(url, { headers, signal });
  }
  return response;
}

async function findCloudNodeByName(
  input: { workspaceKey: string; baseUrl?: string; nodeName: string },
  version: string
): Promise<CloudNodeIdentity | null> {
  const url = new URL(
    `/v1/nodes/${encodeURIComponent(input.nodeName)}`,
    input.baseUrl ?? 'https://cast.agentrelay.com'
  );
  // `node status` is primarily a local diagnostic. The SDK retries 5xx
  // responses, but its general HTTP client has no request deadline; this
  // status-specific lookup keeps those retries inside a total abort budget.
  const response = await fetchCloudNodeWithRetry(
    url,
    cloudNodeLookupHeaders(input.workspaceKey, version),
    AbortSignal.timeout(CLOUD_NODE_LOOKUP_TIMEOUT_MS)
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Cloud node lookup returned HTTP ${response.status}.`);
  const envelope = (await response.json()) as {
    ok?: boolean;
    data?: { id?: unknown; node_id?: unknown; nodeId?: unknown; name?: unknown };
  };
  if (envelope.ok !== true || typeof envelope.data?.name !== 'string') {
    throw new Error('Cloud node lookup returned an invalid response.');
  }
  const id =
    typeof envelope.data.id === 'string'
      ? envelope.data.id
      : typeof envelope.data.node_id === 'string'
        ? envelope.data.node_id
        : undefined;
  const nodeId = typeof envelope.data.nodeId === 'string' ? envelope.data.nodeId : undefined;
  return {
    name: envelope.data.name,
    ...(id ? { id } : {}),
    ...(nodeId ? { nodeId } : {}),
  };
}

export interface CoreDependencies {
  getProjectPaths: () => CoreProjectPaths;
  loadTeamsConfig: (projectRoot: string) => CoreTeamsConfig | null;
  createRelay: (
    cwd: string,
    apiPort?: number,
    brokerName?: string,
    verbose?: boolean
  ) => CoreRelay | Promise<CoreRelay>;
  spawnProcess: (command: string, args: string[], options?: Record<string, unknown>) => SpawnedProcess;
  execCommand: (command: string) => Promise<{ stdout: string; stderr: string }>;
  killProcess: (pid: number, signal?: NodeJS.Signals | number) => void;
  fs: CoreFileSystem;
  generateAgentName: () => string;
  checkForUpdates: (version: string) => Promise<UpdateInfo>;
  /** Resolve the Cloud fleet row addressed by a running broker's local node name. */
  findCloudNodeByName: (input: {
    workspaceKey: string;
    baseUrl?: string;
    nodeName: string;
  }) => Promise<CloudNodeIdentity | null>;
  getVersion: () => string;
  env: NodeJS.ProcessEnv;
  argv: string[];
  execPath: string;
  cliScript: string;
  pid: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  onSignal: (signal: NodeJS.Signals, handler: () => void | Promise<void>) => void;
  holdOpen: () => Promise<void>;
  isPortInUse: (port: number) => Promise<boolean>;
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  exit: ExitFn;
}

function findPackageJson(startDir: string, fileSystem: CoreFileSystem): string {
  let current = startDir;
  while (current !== path.dirname(current)) {
    const candidate = path.join(current, 'package.json');
    if (fileSystem.existsSync(candidate)) {
      return candidate;
    }
    current = path.dirname(current);
  }
  throw new Error('Could not find package.json');
}

function resolveCliVersion(fileSystem: CoreFileSystem): string {
  const envVersion = process.env.AGENT_RELAY_VERSION;
  if (envVersion) {
    return envVersion;
  }

  try {
    const dirname = path.dirname(fileURLToPath(import.meta.url));
    const packageJsonPath = findPackageJson(dirname, fileSystem);
    const packageJson = JSON.parse(fileSystem.readFileSync(packageJsonPath, 'utf-8')) as {
      version?: string;
    };
    return packageJson.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

async function createDefaultRelay(
  cwd: string,
  apiPort = 0,
  brokerName?: string,
  verbose = false
): Promise<CoreRelay> {
  // This is the `up` command's broker factory. `up` is persistent even when
  // port 0 delegates atomic port selection to the OS; the connection file is
  // how later `status`, `down`, and enrolled-node recovery find that broker.
  const binaryArgs: BrokerInitArgs = {
    persist: true,
    apiPort,
  };
  const stateDir = process.env.AGENT_RELAY_STATE_DIR;
  if (stateDir) {
    binaryArgs.stateDir = stateDir;
  }
  const client = await createRuntimeClient({
    cwd,
    binaryArgs,
    brokerName,
    preferConnect: apiPort > 0,
    ...(verbose
      ? {
          onStep: (message: string) => console.error(`[agent-relay][verbose] ${message}`),
          onStderr: (line: string) => console.error(`[broker] ${line}`),
        }
      : {}),
  });

  const relay: CoreRelay = {
    spawn: (input) => spawnAgentWithClient(client, input),
    getStatus: async () => {
      const status = await client.getStatus();
      if (!client.workspaceKey) {
        await client.getSession().catch(() => undefined);
      }
      return status;
    },
    shutdown: () => client.shutdown(),
    get workspaceKey() {
      return client.workspaceKey;
    },
    get workspaceId() {
      return client.workspaceId;
    },
    get brokerPid() {
      return client.brokerPid;
    },
    get apiPort() {
      const port = Number.parseInt(new URL(client.baseUrl).port, 10);
      return Number.isInteger(port) && port > 0 ? port : undefined;
    },
  };
  return relay;
}

export function withDefaults(overrides: Partial<CoreDependencies> = {}): CoreDependencies {
  const fileSystem: CoreFileSystem = overrides.fs ?? {
    existsSync: fs.existsSync,
    readFileSync: (filePath, encoding) => fs.readFileSync(filePath, encoding),
    writeFileSync: (filePath, data, encoding) => fs.writeFileSync(filePath, data, encoding),
    renameSync: (oldPath, newPath) => fs.renameSync(oldPath, newPath),
    unlinkSync: fs.unlinkSync,
    readdirSync: (dirPath) => fs.readdirSync(dirPath),
    mkdirSync: (dirPath, options) => fs.mkdirSync(dirPath, options),
    rmSync: (targetPath, options) => fs.rmSync(targetPath, options),
    accessSync: fs.accessSync,
  };

  const defaultVersion = resolveCliVersion(fileSystem);

  return {
    getProjectPaths: () => getProjectPaths() as unknown as CoreProjectPaths,
    loadTeamsConfig: (projectRoot: string) =>
      (loadTeamsConfig(projectRoot) as unknown as CoreTeamsConfig | null) ?? null,
    createRelay: createDefaultRelay,
    spawnProcess: (command, args, options) =>
      spawnProcess(command, args, options as Parameters<typeof spawnProcess>[2]) as unknown as SpawnedProcess,
    execCommand: async (command: string) => {
      const result = await execAsync(command);
      return {
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
      };
    },
    killProcess: process.kill,
    fs: fileSystem,
    generateAgentName,
    checkForUpdates: (version: string) => checkForUpdates(version) as Promise<UpdateInfo>,
    findCloudNodeByName: (input) => findCloudNodeByName(input, defaultVersion),
    getVersion: () => defaultVersion,
    env: process.env,
    argv: process.argv,
    execPath: process.execPath,
    cliScript: process.argv[1] || 'dist/src/cli/index.js',
    pid: process.pid,
    isPortInUse: (port: number) =>
      new Promise((resolve) => {
        // Use a connect probe instead of a bind probe.  On macOS,
        // net.createServer().listen() sets SO_REUSEADDR which can succeed
        // even when another process is already listening on the port.
        // A connect() call reliably detects whether something is listening.
        const socket = net.createConnection({ port, host: '127.0.0.1' });
        socket.once('connect', () => {
          socket.destroy();
          resolve(true); // something is listening → port is in use
        });
        socket.once('error', () => {
          socket.destroy();
          resolve(false); // nothing listening → port is free
        });
      }),
    now: () => Date.now(),
    sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    onSignal: (signal: NodeJS.Signals, handler: () => void | Promise<void>) => {
      // See `runSignalHandler` — wraps the handler so `CliExit` thrown by
      // `deps.exit(code)` becomes a flush-then-real-exit, not an unhandled
      // async rejection (which would override the intended exit code).
      process.on(signal, () => runSignalHandler(handler));
    },
    holdOpen: () => new Promise(() => undefined),
    log: (...args: unknown[]) => console.log(...args),
    error: (...args: unknown[]) => console.error(...args),
    warn: (...args: unknown[]) => console.warn(...args),
    exit: defaultExit,
    ...overrides,
  };
}

/** Options accepted by the `up` command action (shared by `local`/`node`). */
export interface UpCommandOptions {
  spawn?: boolean;
  background?: boolean;
  /** Internal marker set only on the detached child re-exec. */
  backgroundChild?: boolean;
  verbose?: boolean;
  workspaceKey?: string;
  stateDir?: string;
  brokerName?: string;
  config?: string;
  logFile?: string;
  logLevel?: string;
  logJson?: boolean;
}

/**
 * Attach the shared `up` broker options to a command. `node up` adds `--config`
 * on top of these; `local up` uses them as-is.
 */
export function addUpCommandOptions(command: Command): Command {
  return (
    command
      .option('--spawn', 'Force spawn all agents from teams.json')
      .option('--no-spawn', 'Do not auto-spawn agents (just start broker)')
      .option('--background', 'Run broker in the background (detached)')
      .addOption(new Option('--background-child').hideHelp())
      .option('--verbose', 'Enable verbose logging')
      .option('--workspace-key <key>', 'Use a pre-established Relaycast workspace key')
      .option('--wk <key>', 'Alias for --workspace-key')
      .option(
        '--state-dir <path>',
        'Directory for broker state and connection files (default: .agentworkforce/relay/)'
      )
      .option('--broker-name <name>', 'Override the broker name (defaults to project directory basename)')
      .option(
        '--log-file <path>',
        'Write structured node logs (capabilities registered, actions invoked/completed) to a file'
      )
      .option(
        '--log-level <level>',
        'Node log verbosity: debug | info | warn | error (default: info)',
        parseLogLevel
      )
      .option('--log-json', 'Emit node logs as JSON lines instead of text')
      // Fold the `--wk` alias into `workspaceKey` before the action runs, matching
      // the SDK commands' `addSdkOptions`. An explicit `--workspace-key` wins.
      .hook('preAction', (thisCommand) => {
        const opts = thisCommand.opts();
        if (typeof opts.wk === 'string' && opts.wk.trim() && !opts.workspaceKey) {
          thisCommand.setOptionValue('workspaceKey', opts.wk);
        }
      })
  );
}

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

/**
 * Validate `--log-level` at parse time (case-insensitive). Rejecting a typo here
 * — rather than passing it through — avoids the silent failure where an
 * unrecognized `AGENT_RELAY_LOG_LEVEL` drops every log line.
 */
function parseLogLevel(value: string): string {
  const normalized = value.toLowerCase();
  if (!(LOG_LEVELS as readonly string[]).includes(normalized)) {
    throw new InvalidArgumentError(`Expected one of: ${LOG_LEVELS.join(', ')}.`);
  }
  return normalized;
}

export function registerCoreCommands(
  program: Command,
  overrides: Partial<CoreDependencies> = {},
  opts: { includeUp?: boolean } = {}
): void {
  const deps = withDefaults(overrides);

  if (opts.includeUp !== false) {
    addUpCommandOptions(program.command('up').description('Start the local broker')).action(
      async (options: UpCommandOptions) => {
        await runUpCommand(options, deps);
      }
    );
  }

  program
    .command('down')
    .description('Stop broker')
    .option('--force', 'Force cleanup even if process is stuck')
    .option('--all', 'Kill all agent-relay processes system-wide')
    .option('--timeout <ms>', 'Timeout waiting for graceful shutdown', '5000')
    .option('--state-dir <path>', 'Directory for broker state and connection files')
    .action(async (options: { force?: boolean; all?: boolean; timeout?: string; stateDir?: string }) => {
      await runDownCommand(options, deps);
    });

  program
    .command('status')
    .description('Check whether the local broker daemon is running')
    .option('--state-dir <path>', 'Directory for broker state and connection files')
    .option('--wait-for <seconds>', 'Poll for broker readiness for up to this many seconds')
    .action(async (options: { stateDir?: string; waitFor?: string }) => {
      await runStatusCommand(deps, options);
    });

  program
    .command('metrics')
    .description('Show resource usage for the local broker and its agents')
    .option('--agent <name>', 'Filter to a single agent')
    .action(async (options: { agent?: string }) => {
      let client: HarnessDriverClient | undefined;
      try {
        client = HarnessDriverClient.connect({ cwd: process.cwd() });
        const metrics = await client.getMetrics(options.agent);
        deps.log(JSON.stringify(metrics, null, 2));
      } catch (err) {
        deps.error(err instanceof Error ? err.message : String(err));
        deps.exit(1);
      } finally {
        client?.disconnect();
      }
    });

  program
    .command('deadletters')
    .description('List terminally-failed deliveries retained in the broker dead-letter queue')
    .option('--json', 'Output raw JSON')
    .action(async (options: { json?: boolean }) => {
      let client: HarnessDriverClient | undefined;
      try {
        client = HarnessDriverClient.connect({ cwd: process.cwd() });
        const result = await client.getDeadLetters();
        if (options.json) {
          deps.log(JSON.stringify(result, null, 2));
          return;
        }
        if (result.count === 0) {
          deps.log('No dead-letter deliveries.');
          return;
        }
        for (const entry of result.dead_letters) {
          deps.log(
            `${entry.delivery_id}  recipient=${entry.worker_name}  from=${entry.from}  ` +
              `age=${formatAgeMs(entry.age_ms)}  attempts=${entry.attempts}  reason=${entry.reason}`
          );
        }
      } catch (err) {
        deps.error(err instanceof Error ? err.message : String(err));
        deps.exit(1);
      } finally {
        client?.disconnect();
      }
    });

  program
    .command('redeliver [id]')
    .description('Requeue dead-letter deliveries through the normal delivery path')
    .option('--all', 'Redeliver every dead-letter entry')
    .action(async (id: string | undefined, options: { all?: boolean }) => {
      if (Boolean(id) === Boolean(options.all)) {
        deps.error('Provide exactly one of <id> or --all.');
        deps.exit(1);
      }
      let client: HarnessDriverClient | undefined;
      try {
        client = HarnessDriverClient.connect({ cwd: process.cwd() });
        const result = await client.redeliverDeadLetters(id ? { id } : { all: true });
        for (const entry of result.redelivered) {
          deps.log(`Redelivered ${entry.delivery_id} to ${entry.worker_name}`);
        }
        for (const entry of result.skipped) {
          deps.warn(`Skipped ${entry.delivery_id} (${entry.worker_name}): ${entry.reason}`);
        }
        if (result.redelivered.length === 0 && result.skipped.length === 0) {
          deps.log('No dead-letter deliveries to redeliver.');
        }
      } catch (err) {
        deps.error(err instanceof Error ? err.message : String(err));
        deps.exit(1);
      } finally {
        client?.disconnect();
      }
    });
}

/** Render a millisecond age as a compact human-readable duration. */
function formatAgeMs(ageMs: number): string {
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60 ? `${minutes % 60}m` : ''}`;
  const days = Math.floor(hours / 24);
  return `${days}d${hours % 24 ? `${hours % 24}h` : ''}`;
}

/**
 * Top-level maintenance verbs that live outside the `local` namespace because
 * they manage the installed CLI itself, not the broker: `version`, `update`,
 * `uninstall`.
 */
export function registerCoreMaintenance(program: Command, overrides: Partial<CoreDependencies> = {}): void {
  const deps = withDefaults(overrides);

  program
    .command('version')
    .description('Show version information')
    .action(() => {
      deps.log(`agent-relay v${deps.getVersion()}`);
    });

  program
    .command('update')
    .description('Check for updates and install if available')
    .option('--check', 'Only check for updates, do not install')
    .action(async (options: { check?: boolean }) => {
      await runUpdateCommand(options, deps);
    });

  program
    .command('uninstall')
    .description('Remove agent-relay data, configuration, and global binaries')
    .option('--keep-data', 'Keep message history and database (only remove runtime files)')
    .option('--zed', 'Also remove Zed editor configuration')
    .option('--zed-name <name>', 'Name of the Zed agent server entry to remove (default: Agent Relay)')
    .option('--snippets', 'Also remove agent-relay snippets from CLAUDE.md, GEMINI.md, AGENTS.md')
    .option('--force', 'Skip confirmation prompt')
    .option('--dry-run', 'Show what would be removed without actually removing')
    .action(
      async (options: {
        keepData?: boolean;
        zed?: boolean;
        zedName?: string;
        snippets?: boolean;
        force?: boolean;
        dryRun?: boolean;
      }) => {
        await runUninstallCommand(options, deps);
      }
    );
}
