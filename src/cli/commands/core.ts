import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec, spawn as spawnProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { Command } from 'commander';

import {
  getProjectPaths,
  loadTeamsConfig,
  resolveProjects,
  validateBrokers,
  getAgentOutboxTemplate,
} from '@agent-relay/config';
import type { AgentRelayBrokerInitArgs } from '@agent-relay/sdk';
import { checkForUpdates, generateAgentName } from '@agent-relay/utils';

import { runBridgeCommand } from '../lib/bridge.js';
import { runDownCommand, runStatusCommand, runUpCommand } from '../lib/broker-lifecycle.js';
import { runUninstallCommand, runUpdateCommand } from '../lib/core-maintenance.js';
import { createAgentRelayClient, spawnAgentWithClient } from '../lib/client-factory.js';

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

export interface BridgeProject {
  id: string;
  path: string;
  leadName: string;
  cli?: string;
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
  /** Relaycast workspace API key, available after the hello handshake. */
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
  resolveBridgeProjects: (projectPaths: string[], cli?: string) => BridgeProject[];
  validateBridgeBrokers: (projects: BridgeProject[]) => {
    valid: BridgeProject[];
    missing: BridgeProject[];
  };
  getAgentOutboxTemplate: () => string;
  createRelay: (cwd: string, apiPort?: number) => CoreRelay | Promise<CoreRelay>;
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
  resolveTemplatesDir: () => string;
  isPortInUse: (port: number) => Promise<boolean>;
  findBrokerApiPort: () => Promise<number>;
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  exit: ExitFn;
}

function defaultExit(code: number): never {
  process.exit(code);
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

  // In workspace / local dev mode, try resolving the dashboard-server package directly
  if (process.env.RELAY_LOCAL_DEV === '1') {
    try {
      const pkgPath = require.resolve('@agent-relay/dashboard-server/package.json');
      const pkgDir = path.dirname(pkgPath);
      const pkgJson = JSON.parse(fileSystem.readFileSync(pkgPath, 'utf-8')) as {
        bin?: Record<string, string>;
      };
      const binEntry = pkgJson.bin?.['relay-dashboard-server'];
      if (binEntry) {
        const binPath = path.resolve(pkgDir, binEntry);
        if (fileSystem.existsSync(binPath)) {
          return binPath;
        }
      }
    } catch {
      // Package not resolvable, fall through to other search methods.
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

async function createDefaultRelay(cwd: string, apiPort = 0): Promise<CoreRelay> {
  const binaryArgs: AgentRelayBrokerInitArgs = {};
  if (apiPort > 0) {
    binaryArgs.persist = true;
    binaryArgs.apiPort = apiPort;
  }
  const stateDir = process.env.AGENT_RELAY_STATE_DIR;
  if (stateDir) {
    binaryArgs.stateDir = stateDir;
  }
  const client = await createAgentRelayClient({
    cwd,
    binaryArgs,
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
    resolveBridgeProjects: (projectPaths: string[], cli?: string) =>
      resolveProjects(projectPaths, cli) as unknown as BridgeProject[],
    validateBridgeBrokers: (projects: BridgeProject[]) =>
      validateBrokers(projects as unknown as Parameters<typeof validateBrokers>[0]) as unknown as {
        valid: BridgeProject[];
        missing: BridgeProject[];
      },
    getAgentOutboxTemplate,
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
      process.on(signal, () => {
        void handler();
      });
    },
    holdOpen: () => new Promise(() => undefined),
    resolveTemplatesDir: () => {
      // Walk up from __dirname to find the sdk package's builtin-templates dir
      const dirname = path.dirname(fileURLToPath(import.meta.url));
      let dir = dirname;
      for (let i = 0; i < 8; i++) {
        const candidate = path.join(dir, 'packages', 'sdk', 'src', 'workflows', 'builtin-templates');
        if (fs.existsSync(candidate)) return candidate;
        const distCandidate = path.join(dir, 'packages', 'sdk', 'dist', 'workflows', 'builtin-templates');
        if (fs.existsSync(distCandidate)) return distCandidate;
        dir = path.dirname(dir);
      }
      return path.join(dirname, 'builtin-templates');
    },
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

function buildDashboardHarnessPath(cliTool?: string): string | undefined {
  const trimmed = cliTool?.trim();
  if (!trimmed) return '/dev/cli-tools';

  return `/dev/cli-tools?tool=${encodeURIComponent(trimmed)}`;
}

function isSupportedDashboardTarget(target: string): boolean {
  return target === 'dashboard.js' || target === 'dashboard';
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
    .option('--verbose', 'Enable verbose logging')
    .option('--workspace-key <key>', 'Use a pre-established Relaycast workspace key')
    .option('--state-dir <path>', 'Directory for broker state and connection files (default: .agent-relay/)')
    .action(
      async (options: {
        dashboard?: boolean;
        port?: string;
        spawn?: boolean;
        background?: boolean;
        verbose?: boolean;
        workspaceKey?: string;
        stateDir?: string;
      }) => {
        await runUpCommand(options, deps);
      }
    );

  program
    .command('start')
    .description('Start focused test harnesses (for example: start dashboard.js claude)')
    .argument('<target>', 'Harness target name')
    .argument('[cli]', 'Optional CLI tool to focus')
    .option('--port <port>', 'Dashboard port', DEFAULT_DASHBOARD_PORT)
    .option('--verbose', 'Enable verbose logging')
    .action(
      async (target: string, cli: string | undefined, options: { port?: string; verbose?: boolean }) => {
        if (!isSupportedDashboardTarget(target.toLowerCase())) {
          deps.error(`Unknown start target "${target}". Supported targets: dashboard.js`);
          deps.exit(1);
        }

        await runUpCommand(
          {
            dashboard: true,
            port: options.port,
            verbose: options.verbose,
            background: false,
            dashboardPath: buildDashboardHarnessPath(cli),
            reuseExistingBroker: true,
          },
          deps
        );
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
    .description('Check broker status')
    .option('--state-dir <path>', 'Directory for broker state and connection files')
    .action(async (options: { stateDir?: string }) => {
      await runStatusCommand(deps, options);
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

  program
    .command('version', { hidden: true })
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
    .command('bridge')
    .description('Bridge multiple projects as orchestrator')
    .argument('[projects...]', 'Project paths to bridge')
    .option('--cli <tool>', 'CLI tool override for all projects')
    .option('--architect [cli]', 'Spawn an architect agent to coordinate all projects (default: claude)')
    .action(async (projectPaths: string[], options: { cli?: string; architect?: string | boolean }) => {
      await runBridgeCommand(projectPaths, options, deps);
    });

  const workflowsCmd = program.command('workflows').description('Manage relay.yaml workflow templates');

  workflowsCmd
    .command('list')
    .description('List available built-in workflow templates')
    .action(() => {
      const templatesDir = deps.resolveTemplatesDir();
      if (!deps.fs.existsSync(templatesDir)) {
        deps.log('No built-in templates found.');
        return;
      }
      const files = deps.fs.readdirSync(templatesDir).filter((f) => f.endsWith('.yaml'));
      if (files.length === 0) {
        deps.log('No built-in templates found.');
        return;
      }
      deps.log('Built-in workflow templates:');
      for (const file of files) {
        deps.log(`  ${file.replace(/\.yaml$/, '')}`);
      }
    });
}
