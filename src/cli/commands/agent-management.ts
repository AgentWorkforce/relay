import { Command } from 'commander';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn as spawnProcess } from 'node:child_process';
import { getProjectPaths } from '@agent-relay/config';

import { brokerPidFilename } from '../lib/broker-lifecycle.js';
import { runAgentsCommand, runAgentsLogsCommand, runWhoCommand } from '../lib/agent-management-listing.js';

type ShadowMode = 'subagent' | 'process';
type ShadowTrigger = 'SESSION_END' | 'CODE_WRITTEN' | 'REVIEW_REQUEST' | 'EXPLICIT_ASK' | 'ALL_MESSAGES';

type ExitFn = (code: number) => never;

interface WorkerInfo {
  name: string;
  runtime?: string;
  pid?: number;
}

interface SetModelResult {
  success: boolean;
  model?: string;
}

export interface AgentManagementClient {
  spawnPty(options: {
    name: string;
    cli: string;
    channels: string[];
    task: string;
    team?: string;
    model?: string;
    cwd?: string;
    shadowOf?: string;
    shadowMode?: ShadowMode;
    continueFrom?: string;
  }): Promise<unknown>;
  listAgents(): Promise<WorkerInfo[]>;
  release(name: string, reason: string): Promise<unknown>;
  setModel(name: string, model: string, options: { timeoutMs: number }): Promise<SetModelResult>;
  getMetrics?(agentName?: string): Promise<unknown>;
  shutdown(): Promise<unknown>;
}

export interface AgentManagementDependencies {
  getProjectRoot: () => string;
  getDataDir: () => string;
  createClient: (cwd: string) => AgentManagementClient;
  createAutostartClient: (cwd: string) => AgentManagementClient;
  readTaskFromStdin: () => Promise<string | undefined>;
  fileExists: (filePath: string) => boolean;
  readFile: (filePath: string, encoding?: BufferEncoding) => string;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  nowIso: () => string;
  killProcess: (pid: number, signal?: NodeJS.Signals | number) => void;
  sleep: (ms: number) => Promise<void>;
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: ExitFn;
}

const DEFAULT_DASHBOARD_PORT = process.env.AGENT_RELAY_DASHBOARD_PORT || '3888';
const VALID_SHADOW_TRIGGERS: readonly ShadowTrigger[] = [
  'SESSION_END',
  'CODE_WRITTEN',
  'REVIEW_REQUEST',
  'EXPLICIT_ASK',
  'ALL_MESSAGES',
] as const;
const MAX_API_PORT_ATTEMPTS = 25;
const LOCAL_BROKER_START_TIMEOUT_MS = 10_000;
const LOCAL_BROKER_START_POLL_MS = 250;

function defaultExit(code: number): never {
  process.exit(code);
}

async function readTaskFromStdin(): Promise<string | undefined> {
  if (process.stdin.isTTY) {
    return undefined;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }

  const task = Buffer.concat(chunks).toString('utf-8').trim();
  return task.length > 0 ? task : undefined;
}

interface LocalBrokerClientDependencies {
  fetch: AgentManagementDependencies['fetch'];
  fileExists: AgentManagementDependencies['fileExists'];
  readFile: AgentManagementDependencies['readFile'];
  killProcess: AgentManagementDependencies['killProcess'];
  sleep: AgentManagementDependencies['sleep'];
  spawnProcess: (
    command: string,
    args: string[],
    options?: Record<string, unknown>
  ) => { pid?: number; unref?: () => void };
  execPath: string;
  cliScript: string;
  env: NodeJS.ProcessEnv;
}

function resolveDefaultDashboardPort(): number {
  const parsed = Number.parseInt(DEFAULT_DASHBOARD_PORT, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3888;
}

function resolveDefaultApiPort(): number {
  return resolveDefaultDashboardPort() + 1;
}

function readPidFile(
  pidPath: string,
  deps: Pick<LocalBrokerClientDependencies, 'fileExists' | 'readFile'>
): number | null {
  if (!deps.fileExists(pidPath)) {
    return null;
  }

  const pid = Number.parseInt(deps.readFile(pidPath, 'utf-8').trim(), 10);
  if (!Number.isFinite(pid) || pid <= 0) {
    return null;
  }

  return pid;
}

function isProcessRunning(pid: number, deps: Pick<LocalBrokerClientDependencies, 'killProcess'>): boolean {
  try {
    deps.killProcess(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function discoverBrokerApiPort(
  preferredApiPort: number,
  deps: Pick<LocalBrokerClientDependencies, 'fetch'>
): Promise<number | null> {
  for (let attempt = 0; attempt < MAX_API_PORT_ATTEMPTS; attempt += 1) {
    const candidatePort = preferredApiPort + attempt;
    try {
      const response = await deps.fetch(`http://127.0.0.1:${candidatePort}/health`);
      if (!response.ok) {
        continue;
      }

      const payload = (await response.json().catch(() => null)) as { service?: string } | null;
      if (payload?.service === 'agent-relay-listen') {
        return candidatePort;
      }
    } catch {
      // Keep scanning nearby ports.
    }
  }

  return null;
}

function resolveCliLaunch(
  deps: Pick<LocalBrokerClientDependencies, 'execPath' | 'cliScript'>
): { command: string; prefixArgs: string[] } {
  const cliScript = deps.cliScript?.trim();
  const isNodeEntrypoint =
    Boolean(cliScript) &&
    cliScript !== deps.execPath &&
    (cliScript.endsWith('.js') || cliScript.endsWith('.cjs') || cliScript.endsWith('.mjs') || cliScript.endsWith('.ts'));

  return {
    command: deps.execPath,
    prefixArgs: isNodeEntrypoint && cliScript ? [cliScript] : [],
  };
}

async function ensureBrokerApi(
  cwd: string,
  deps: LocalBrokerClientDependencies,
  options: { autoStart: boolean }
): Promise<number> {
  const paths = getProjectPaths(cwd);
  const brokerPidPath = path.join(paths.dataDir, brokerPidFilename(paths.projectRoot));
  const legacyBrokerPidPath = path.join(paths.dataDir, 'broker.pid');
  const preferredApiPort = resolveDefaultApiPort();

  let pid = readPidFile(brokerPidPath, deps);
  if (pid === null) {
    pid = readPidFile(legacyBrokerPidPath, deps);
  }

  if (pid !== null && isProcessRunning(pid, deps)) {
    const discoveredPort = await discoverBrokerApiPort(preferredApiPort, deps);
    if (discoveredPort !== null) {
      return discoveredPort;
    }
    throw new Error('broker is running for this project, but its local API is unavailable');
  }

  if (!options.autoStart) {
    throw new Error('broker is not running for this project');
  }

  const { command, prefixArgs } = resolveCliLaunch(deps);
  const dashboardPort = resolveDefaultDashboardPort();
  const child = deps.spawnProcess(
    command,
    [...prefixArgs, 'up', '--no-dashboard', '--port', String(dashboardPort)],
    {
      cwd: paths.projectRoot,
      env: deps.env,
      detached: true,
      stdio: 'ignore',
    }
  );
  child.unref?.();

  const startedAt = Date.now();
  while (Date.now() - startedAt < LOCAL_BROKER_START_TIMEOUT_MS) {
    const discoveredPort = await discoverBrokerApiPort(preferredApiPort, deps);
    if (discoveredPort !== null) {
      return discoveredPort;
    }
    await deps.sleep(LOCAL_BROKER_START_POLL_MS);
  }

  throw new Error(`broker did not become ready within ${LOCAL_BROKER_START_TIMEOUT_MS}ms`);
}

async function readJsonResponse(response: Response): Promise<any> {
  const text = await response.text();
  if (!text) {
    return undefined;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function extractErrorMessage(response: Response, payload: any): string {
  if (typeof payload === 'string' && payload.trim()) {
    return payload.trim();
  }

  const nestedError =
    typeof payload?.error === 'string'
      ? payload.error
      : typeof payload?.error?.message === 'string'
        ? payload.error.message
        : undefined;
  if (nestedError) {
    return nestedError;
  }

  if (typeof payload?.message === 'string' && payload.message.trim()) {
    return payload.message.trim();
  }

  return `${response.status} ${response.statusText}`.trim();
}

function createDefaultClientFactory(
  deps: LocalBrokerClientDependencies,
  options: { autoStart: boolean }
): (cwd: string) => AgentManagementClient {
  return (cwd: string): AgentManagementClient => {
    let apiPortPromise: Promise<number> | undefined;

    const getApiPort = (): Promise<number> => {
      if (!apiPortPromise) {
        apiPortPromise = ensureBrokerApi(cwd, deps, options);
      }
      return apiPortPromise;
    };

    const request = async (pathname: string, init?: RequestInit): Promise<any> => {
      const apiPort = await getApiPort();
      const headers = new Headers(init?.headers);
      const apiKey = deps.env.RELAY_BROKER_API_KEY?.trim();
      if (apiKey && !headers.has('x-api-key') && !headers.has('authorization')) {
        headers.set('x-api-key', apiKey);
      }

      const response = await deps.fetch(`http://127.0.0.1:${apiPort}${pathname}`, {
        ...init,
        headers,
      });
      const payload = await readJsonResponse(response);
      if (!response.ok) {
        throw new Error(extractErrorMessage(response, payload));
      }
      return payload;
    };

    return {
      async spawnPty(options) {
        const payload = await request('/api/spawn', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: options.name,
            cli: options.cli,
            model: options.model,
            args: [],
            task: options.task,
            channels: options.channels,
            cwd: options.cwd,
            team: options.team,
            shadowOf: options.shadowOf,
            shadowMode: options.shadowMode,
            continueFrom: options.continueFrom,
          }),
        });

        return {
          name: typeof payload?.name === 'string' ? payload.name : options.name,
          runtime: 'pty',
        };
      },
      async listAgents() {
        const payload = await request('/api/spawned', { method: 'GET' });
        return Array.isArray(payload?.agents) ? (payload.agents as WorkerInfo[]) : [];
      },
      async release(name: string) {
        const payload = await request(`/api/spawned/${encodeURIComponent(name)}`, {
          method: 'DELETE',
        });
        return {
          name: typeof payload?.name === 'string' ? payload.name : name,
        };
      },
      async setModel(name: string, model: string, options: { timeoutMs: number }) {
        const payload = await request(`/api/spawned/${encodeURIComponent(name)}/model`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model,
            timeoutMs: options.timeoutMs,
          }),
        });

        return {
          success: payload?.success !== false,
          model: typeof payload?.model === 'string' ? payload.model : model,
        };
      },
      async getMetrics() {
        return { agents: [] };
      },
      async shutdown() {
        return undefined;
      },
    };
  };
}

function withDefaults(overrides: Partial<AgentManagementDependencies> = {}): AgentManagementDependencies {
  const baseClientFactory = createDefaultClientFactory(
    {
      fetch: (url, init) => fetch(url, init),
      fileExists: fs.existsSync,
      readFile: (filePath, encoding = 'utf-8') => fs.readFileSync(filePath, encoding),
      killProcess: process.kill,
      sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
      spawnProcess: (command, args, options) =>
        spawnProcess(command, args, options as Parameters<typeof spawnProcess>[2]) as {
          pid?: number;
          unref?: () => void;
        },
      execPath: process.execPath,
      cliScript: process.argv[1] || 'dist/src/cli/index.js',
      env: process.env,
    },
    { autoStart: false }
  );
  const autostartClientFactory = createDefaultClientFactory(
    {
      fetch: (url, init) => fetch(url, init),
      fileExists: fs.existsSync,
      readFile: (filePath, encoding = 'utf-8') => fs.readFileSync(filePath, encoding),
      killProcess: process.kill,
      sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
      spawnProcess: (command, args, options) =>
        spawnProcess(command, args, options as Parameters<typeof spawnProcess>[2]) as {
          pid?: number;
          unref?: () => void;
        },
      execPath: process.execPath,
      cliScript: process.argv[1] || 'dist/src/cli/index.js',
      env: process.env,
    },
    { autoStart: true }
  );

  return {
    getProjectRoot: () => getProjectPaths().projectRoot,
    getDataDir: () =>
      process.env.AGENT_RELAY_DATA_DIR || path.join(os.homedir(), '.local', 'share', 'agent-relay'),
    createClient: baseClientFactory,
    createAutostartClient: autostartClientFactory,
    readTaskFromStdin,
    fileExists: fs.existsSync,
    readFile: (filePath, encoding = 'utf-8') => fs.readFileSync(filePath, encoding),
    fetch: (url, init) => fetch(url, init),
    nowIso: () => new Date().toISOString(),
    killProcess: process.kill,
    sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (...args: unknown[]) => console.log(...args),
    error: (...args: unknown[]) => console.error(...args),
    exit: defaultExit,
    ...overrides,
  };
}

function parseShadowTriggers(
  value: string | undefined,
  deps: AgentManagementDependencies
): ShadowTrigger[] | undefined {
  if (!value) return undefined;

  const triggers = value.split(',').map((trigger) => trigger.trim().toUpperCase()) as ShadowTrigger[];
  const invalid = triggers.filter((trigger) => !VALID_SHADOW_TRIGGERS.includes(trigger));
  if (invalid.length > 0) {
    deps.error(`Error: Invalid triggers: ${invalid.join(', ')}`);
    deps.error(`Valid triggers: ${VALID_SHADOW_TRIGGERS.join(', ')}`);
    deps.exit(1);
  }

  return triggers;
}

export function registerAgentManagementCommands(
  program: Command,
  overrides: Partial<AgentManagementDependencies> = {}
): void {
  const deps = withDefaults(overrides);

  program
    .command('spawn')
    .description('Spawn an agent via broker (recommended for programmatic use, no TTY or dashboard required)')
    .argument('<name>', 'Agent name')
    .argument('<cli>', 'CLI to use (claude, codex, gemini, etc.)')
    .argument('[task]', 'Task description (can also be piped via stdin)')
    .option('--port <port>', 'Dashboard port', DEFAULT_DASHBOARD_PORT)
    .option('--team <team>', 'Team name for the agent')
    .option('--spawner <name>', 'Name of the agent requesting the spawn (for policy enforcement)')
    .option('--interactive', 'Disable auto-accept of permission prompts (for auth setup flows)')
    .option('--cwd <path>', 'Working directory for the agent')
    .option('--shadow-mode <mode>', 'Shadow execution mode: subagent or process')
    .option('--shadow-of <name>', 'Primary agent to shadow (if this agent is a shadow)')
    .option('--shadow-agent <profile>', 'Shadow agent profile to use')
    .option(
      '--shadow-triggers <triggers>',
      'When to trigger shadow (comma-separated: SESSION_END,CODE_WRITTEN,REVIEW_REQUEST,EXPLICIT_ASK,ALL_MESSAGES)'
    )
    .option(
      '--shadow-speak-on <triggers>',
      'When shadow should speak (comma-separated, same values as --shadow-triggers)'
    )
    .option('--model <model>', 'Model override (e.g., opus, sonnet, haiku, o3, gemini-2.5-pro)')
    .option('--continue', 'Continue from a previously released agent with the same name')
    .option('--continue-from <name>', 'Continue from a specific previously released agent')
    .action(
      async (
        name: string,
        cli: string,
        task: string | undefined,
        options: {
          port?: string;
          team?: string;
          spawner?: string;
          interactive?: boolean;
          cwd?: string;
          model?: string;
          shadowMode?: string;
          shadowOf?: string;
          shadowAgent?: string;
          shadowTriggers?: string;
          shadowSpeakOn?: string;
          continue?: boolean;
          continueFrom?: string;
        }
      ) => {
        let finalTask = task;
        if (!finalTask) {
          finalTask = await deps.readTaskFromStdin();
        }

        if (!finalTask) {
          deps.error('Error: Task description required (as argument or via stdin)');
          deps.exit(1);
          return;
        }

        if (options.shadowMode && !['subagent', 'process'].includes(options.shadowMode)) {
          deps.error('Error: --shadow-mode must be "subagent" or "process"');
          deps.exit(1);
        }

        parseShadowTriggers(options.shadowTriggers, deps);
        parseShadowTriggers(options.shadowSpeakOn, deps);

        const client = deps.createAutostartClient(options.cwd || deps.getProjectRoot());
        let exitCode = 0;

        const taskToSpawn = finalTask;

        // Resolve --continue / --continue-from into continueFrom
        const continueFrom = options.continueFrom ?? (options.continue ? name : undefined);

        try {
          await client.spawnPty({
            name,
            cli,
            channels: ['general'],
            task: taskToSpawn,
            team: options.team,
            model: options.model,
            cwd: options.cwd,
            shadowOf: options.shadowOf,
            shadowMode: options.shadowMode as ShadowMode | undefined,
            continueFrom,
          });
          const agents = await client.listAgents().catch(() => []);
          const spawned = agents.find((agent) => agent.name === name);
          if (spawned?.pid) {
            deps.log(`Spawned agent: ${name} (pid: ${spawned.pid})`);
          } else {
            deps.log(`Spawned agent: ${name}`);
          }
        } catch (err: any) {
          deps.error(`Failed to spawn ${name}: ${err?.message || String(err)}`);
          exitCode = 1;
        } finally {
          await client.shutdown().catch(() => undefined);
        }

        deps.exit(exitCode);
      }
    );

  program
    .command('broker-spawn', { hidden: true })
    .description(
      'Spawn an agent from environment variables. Canonical entry point for cloud/sandbox spawning. ' +
        'Reads AGENT_NAME, AGENT_CLI, RELAY_API_KEY from env. Applies SDK-owned bypass flags automatically.'
    )
    .option('--from-env', 'Read all configuration from environment variables (required)')
    .action(async (options: { fromEnv?: boolean }) => {
      if (!options.fromEnv) {
        deps.error('[broker-spawn] Usage: agent-relay broker-spawn --from-env');
        deps.error('[broker-spawn] All configuration is read from environment variables.');
        deps.exit(1);
      }

      let exitCode = 0;
      try {
        const { spawnFromEnv } = await import('@agent-relay/sdk');
        const result = await spawnFromEnv({
          binaryPath: process.env.AGENT_RELAY_BIN,
        });
        exitCode = result.exitCode ?? 0;
      } catch (err: any) {
        deps.error(`[broker-spawn] ${err?.message || String(err)}`);
        exitCode = 1;
      }

      deps.exit(exitCode);
    });

  program
    .command('agents', { hidden: true })
    .description('List connected agents and spawned workers')
    .option('--all', 'Include internal/CLI agents')
    .option('--remote', 'Include agents from other linked machines (requires cloud link)')
    .option('--json', 'Output as JSON')
    .action(async (options: { all?: boolean; remote?: boolean; json?: boolean }) => {
      await runAgentsCommand(options, deps);
    });

  program
    .command('who')
    .description('Show currently active agents (last seen within 30 seconds)')
    .option('--all', 'Include internal/CLI agents')
    .option('--json', 'Output as JSON')
    .action(async (options: { all?: boolean; json?: boolean }) => {
      await runWhoCommand(options, deps);
    });

  program
    .command('agents:logs')
    .description('Show recent output from a spawned agent')
    .argument('<name>', 'Agent name')
    .option('-n, --lines <n>', 'Number of lines to show', '50')
    .option('-f, --follow', 'Follow log output (like tail -f)')
    .action(async (name: string, options: { lines?: string; follow?: boolean }) => {
      await runAgentsLogsCommand(name, options, deps);
    });

  program
    .command('release')
    .description('Release a spawned agent via API (no terminal required)')
    .argument('<name>', 'Agent name to release')
    .option('--port <port>', 'Dashboard port', DEFAULT_DASHBOARD_PORT)
    .action(async (name: string) => {
      const client = deps.createClient(deps.getProjectRoot());
      let exitCode = 0;
      try {
        await client.release(name, 'released via cli');
        deps.log(`Released agent: ${name}`);
      } catch (err: any) {
        deps.error(`Failed to release ${name}: ${err?.message || String(err)}`);
        exitCode = 1;
      } finally {
        await client.shutdown().catch(() => undefined);
      }

      deps.exit(exitCode);
    });

  program
    .command('set-model')
    .description('Switch the model of a running spawned agent')
    .argument('<name>', 'Agent name')
    .argument('<model>', 'Target model (e.g., opus, sonnet, haiku)')
    .option('--timeout <ms>', 'Idle wait timeout in milliseconds', '30000')
    .action(async (name: string, model: string, options: { timeout?: string }) => {
      const timeoutMs = parseInt(options.timeout || '30000', 10);
      const client = deps.createClient(deps.getProjectRoot());
      let exitCode = 0;

      try {
        const result = await client.setModel(name, model, { timeoutMs });
        if (result.success) {
          deps.log(`Model switched for ${name}: ${result.model || model}`);
        } else {
          deps.error(`Failed to switch model for ${name}`);
          exitCode = 1;
        }
      } catch (err: unknown) {
        const errObj = err as { message?: string };
        deps.error(`Failed to switch model for ${name}: ${errObj.message ?? String(err)}`);
        exitCode = 1;
      } finally {
        await client.shutdown().catch(() => undefined);
      }

      deps.exit(exitCode);
    });

  program
    .command('agents:kill', { hidden: true })
    .description('Kill a spawned agent')
    .argument('<name>', 'Agent name')
    .option('--force', 'Skip graceful shutdown, kill immediately')
    .action(async (name: string, options: { force?: boolean }) => {
      const client = deps.createClient(deps.getProjectRoot());
      const workers = await client.listAgents().catch(() => []);
      await client.shutdown().catch(() => undefined);
      const worker = workers.find((entry) => entry.name === name);

      if (!worker) {
        deps.error(`Spawned agent "${name}" not found`);
        deps.log(`Run 'agent-relay agents' to see available agents`);
        deps.exit(1);
        return;
      }

      if (!worker.pid) {
        deps.error(`Agent "${name}" has no PID recorded`);
        deps.exit(1);
        return;
      }

      const pid = worker.pid;

      try {
        if (!options.force) {
          deps.log(`Sending SIGTERM to ${name} (pid: ${pid})...`);
          deps.killProcess(pid, 'SIGTERM');
          await deps.sleep(2000);

          try {
            deps.killProcess(pid, 0);
            deps.log('Agent still running, sending SIGKILL...');
            deps.killProcess(pid, 'SIGKILL');
          } catch {
            // Graceful shutdown succeeded.
          }
        } else {
          deps.log(`Force killing ${name} (pid: ${pid})...`);
          deps.killProcess(pid, 'SIGKILL');
        }

        deps.log(`Killed agent: ${name}`);
      } catch (err: any) {
        if (err.code === 'ESRCH') {
          deps.log(`Agent ${name} is no longer running (pid: ${pid})`);
        } else {
          deps.error(`Failed to kill ${name}:`, err.message);
          deps.exit(1);
        }
      }
    });
}
