import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec, spawn as spawnProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { Command } from 'commander';

import { getProjectPaths, loadTeamsConfig } from '@agent-relay/config';
import type { BrokerInitArgs } from '@agent-relay/harness-driver';
import { checkForUpdates, generateAgentName } from '@agent-relay/utils';

import { runDownCommand, runStatusCommand, runUpCommand } from '../lib/broker-lifecycle.js';
import { runUninstallCommand, runUpdateCommand } from '../lib/core-maintenance.js';
import { createRuntimeClient, spawnAgentWithClient } from '../lib/client-factory.js';
import { defaultExit, runSignalHandler } from '../lib/exit.js';

const execAsync = promisify(exec);
const DEFAULT_DASHBOARD_PORT = process.env.AGENT_RELAY_DASHBOARD_PORT || '3888';

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
  /** PID of the underlying broker process, when available. */
  brokerPid?: number;
}

export interface CoreFileSystem {
  existsSync: (path: string) => boolean;
  readFileSync: (path: string, encoding: BufferEncoding) => string;
  writeFileSync: (path: string, data: string, encoding?: BufferEncoding) => void;
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

export interface CoreDependencies {
  getProjectPaths: () => CoreProjectPaths;
  loadTeamsConfig: (projectRoot: string) => CoreTeamsConfig | null;
  createRelay: (cwd: string, apiPort?: number, brokerName?: string) => CoreRelay | Promise<CoreRelay>;
  findDashboardBinary: () => string | null;
  spawnProcess: (command: string, args: string[], options?: Record<string, unknown>) => SpawnedProcess;
  execCommand: (command: string) => Promise<{ stdout: string; stderr: string }>;
  killProcess: (pid: number, signal?: NodeJS.Signals | number) => void;
  fs: CoreFileSystem;
  generateAgentName: () => string;
  checkForUpdates: (version: string) => Promise<UpdateInfo>;
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
  findBrokerApiPort: () => Promise<number>;
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

function findDashboardBinaryDefault(fileSystem: CoreFileSystem): string | null {
  // Allow explicit override via env var (for local development)
  const envOverride = process.env.RELAY_DASHBOARD_BINARY;
  if (envOverride && fileSystem.existsSync(envOverride)) {
    return envOverride;
  }

  // In local multi-repo workspaces, prefer a sibling relay-dashboard build when available.
  // Only when RELAY_LOCAL_DEV is set — otherwise the installed binary should win so
  // users don't accidentally run a stale dev build.
  if (process.env.RELAY_LOCAL_DEV === '1') {
    const siblingWorkspaceBuild = path.resolve(
      process.cwd(),
      '..',
      'relay-dashboard',
      'packages',
      'dashboard-server',
      'dist',
      'start.js'
    );
    if (fileSystem.existsSync(siblingWorkspaceBuild)) {
      return siblingWorkspaceBuild;
    }
  }

  const binaryName = 'relay-dashboard-server';
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';

  const searchPaths = [
    path.join(homeDir, '.local', 'bin', binaryName),
    path.join(homeDir, '.agent-relay', 'bin', binaryName),
    path.join('/usr/local/bin', binaryName),
  ];

  for (const candidate of searchPaths) {
    try {
      if (!fileSystem.existsSync(candidate)) {
        continue;
      }
      fileSystem.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Continue searching.
    }
  }

  const envPath = process.env.PATH || '';
  for (const dir of envPath.split(path.delimiter)) {
    const candidate = path.join(dir, binaryName);
    try {
      if (!fileSystem.existsSync(candidate)) {
        continue;
      }
      fileSystem.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Continue searching.
    }
  }

  return null;
}

async function createDefaultRelay(cwd: string, apiPort = 0, brokerName?: string): Promise<CoreRelay> {
  const binaryArgs: BrokerInitArgs = {};
  if (apiPort > 0) {
    binaryArgs.persist = true;
    binaryArgs.apiPort = apiPort;
  }
  const stateDir = process.env.AGENT_RELAY_STATE_DIR;
  if (stateDir) {
    binaryArgs.stateDir = stateDir;
  }
  const client = await createRuntimeClient({
    cwd,
    binaryArgs,
    brokerName,
    preferConnect: apiPort > 0,
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
    get brokerPid() {
      return client.brokerPid;
    },
  };
  return relay;
}

function withDefaults(overrides: Partial<CoreDependencies> = {}): CoreDependencies {
  const fileSystem: CoreFileSystem = overrides.fs ?? {
    existsSync: fs.existsSync,
    readFileSync: (filePath, encoding) => fs.readFileSync(filePath, encoding),
    writeFileSync: (filePath, data, encoding) => fs.writeFileSync(filePath, data, encoding),
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
    findDashboardBinary: () => findDashboardBinaryDefault(fileSystem),
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
    findBrokerApiPort: async () => {
      const dp = Number.parseInt(process.env.AGENT_RELAY_DASHBOARD_PORT ?? '3888', 10);
      const startPort = (Number.isFinite(dp) ? dp : 3888) + 1;
      for (let i = 0; i < 25; i++) {
        const port = startPort + i;
        if (port > 65535) break;
        try {
          const res = await fetch(`http://localhost:${port}/health`);
          if (res.ok) return port;
        } catch {
          // Not responding, keep scanning.
        }
      }
      return 0;
    },
    exit: defaultExit,
    ...overrides,
  };
}

export function registerCoreCommands(program: Command, overrides: Partial<CoreDependencies> = {}): void {
  const deps = withDefaults(overrides);

  program
    .command('up')
    .description('Start broker with web dashboard')
    .option('--no-dashboard', 'Disable web dashboard')
    .option('--port <port>', 'Dashboard port', DEFAULT_DASHBOARD_PORT)
    .option('--spawn', 'Force spawn all agents from teams.json')
    .option('--no-spawn', 'Do not auto-spawn agents (just start broker)')
    .option('--background', 'Run broker in the background (detached)')
    .option('--foreground', 'Run --no-dashboard attached to this terminal')
    .option('--verbose', 'Enable verbose logging')
    .option('--workspace-key <key>', 'Use a pre-established Relaycast workspace key')
    .option('--state-dir <path>', 'Directory for broker state and connection files (default: .agent-relay/)')
    .option('--broker-name <name>', 'Override the broker name (defaults to project directory basename)')
    .action(
      async (options: {
        dashboard?: boolean;
        port?: string;
        spawn?: boolean;
        background?: boolean;
        foreground?: boolean;
        verbose?: boolean;
        workspaceKey?: string;
        stateDir?: string;
        brokerName?: string;
      }) => {
        await runUpCommand(options, deps);
      }
    );

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
      try {
        const client = await createRuntimeClient({ cwd: process.cwd(), preferConnect: true });
        const metrics = await client.getMetrics(options.agent);
        deps.log(JSON.stringify(metrics, null, 2));
      } catch (err) {
        deps.error(err instanceof Error ? err.message : String(err));
        deps.exit(1);
      }
    });
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
