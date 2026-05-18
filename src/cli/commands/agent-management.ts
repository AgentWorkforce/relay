import { Command } from 'commander';
import { spawn as spawnProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentRelayClient, spawnFromEnv } from '@agent-relay/sdk';
import { getProjectPaths } from '@agent-relay/config';

import { runAgentsCommand, runAgentsLogsCommand, runWhoCommand } from '../lib/agent-management-listing.js';
import { defaultExit } from '../lib/exit.js';

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
    skipRelayPrompt?: boolean;
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
  createClient: (cwd: string) => AgentManagementClient | Promise<AgentManagementClient>;
  createAutostartClient: (cwd: string) => AgentManagementClient | Promise<AgentManagementClient>;
  readTaskFromStdin: () => Promise<string | undefined>;
  fileExists: (filePath: string) => boolean;
  readFile: (filePath: string, encoding?: BufferEncoding) => string;
  readFileTail: (
    filePath: string,
    maxBytes: number,
    encoding?: BufferEncoding
  ) => { text: string; size: number };
  readFileFrom: (
    filePath: string,
    offset: number,
    maxBytes: number,
    encoding?: BufferEncoding
  ) => { text: string; size: number };
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

async function createSdkClient(cwd: string, autoStart: boolean): Promise<AgentManagementClient> {
  let client: AgentRelayClient;

  // Connect to an existing broker if one is running
  try {
    client = AgentRelayClient.connect({ cwd });
  } catch (err) {
    if (!autoStart) {
      if (err instanceof Error && err.message !== '') {
        throw err;
      }
      throw new Error('No running broker found. Start one with: agent-relay up');
    }

    await startBackgroundBroker(cwd);
    client = await waitForBrokerClient(cwd);
  }

  await waitForReadyBrokerClient(client);
  return client as unknown as AgentManagementClient;
}

function isBrokerWarmupError(err: unknown): boolean {
  if (err instanceof Error) {
    const maybeProtocol = err as { code?: string };
    return (
      maybeProtocol.code === 'http_503' ||
      err.message.includes('503') ||
      err.message.includes('Service Unavailable') ||
      err.message.includes('Broker is starting')
    );
  }
  const message = String(err);
  return (
    message.includes('503') ||
    message.includes('Service Unavailable') ||
    message.includes('Broker is starting')
  );
}

async function waitForReadyBrokerClient(
  client: AgentRelayClient,
  timeoutMs = 15_000,
  intervalMs = 250
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      await client.getSession();
      return;
    } catch (err) {
      lastError = err;
      if (!isBrokerWarmupError(err)) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Broker did not become ready: ${detail}`);
}

function startBackgroundBroker(cwd: string): void {
  const cliScript = process.argv[1];
  if (!cliScript) {
    throw new Error('Unable to locate agent-relay CLI script for broker autostart');
  }

  const child = spawnProcess(
    process.execPath,
    [cliScript, 'up', '--background', '--no-dashboard', '--no-spawn'],
    {
      cwd,
      detached: true,
      stdio: 'ignore',
      env: process.env,
    }
  );
  child.unref();
}

async function waitForBrokerClient(
  cwd: string,
  timeoutMs = 15_000,
  intervalMs = 250
): Promise<AgentRelayClient> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const client = AgentRelayClient.connect({ cwd });
      await waitForReadyBrokerClient(client, Math.max(1, deadline - Date.now()), intervalMs);
      return client;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Broker did not become ready after autostart: ${detail}`);
}

function withDefaults(overrides: Partial<AgentManagementDependencies> = {}): AgentManagementDependencies {
  const readFileTail = (filePath: string, maxBytes: number, encoding: BufferEncoding = 'utf-8') => {
    const stats = fs.statSync(filePath);
    const start = Math.max(0, stats.size - maxBytes);
    const length = stats.size - start;
    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, start);
      return { text: buffer.toString(encoding), size: stats.size };
    } finally {
      fs.closeSync(fd);
    }
  };
  const readFileFrom = (
    filePath: string,
    offset: number,
    maxBytes: number,
    encoding: BufferEncoding = 'utf-8'
  ) => {
    const stats = fs.statSync(filePath);
    if (stats.size <= offset) {
      return { text: '', size: stats.size };
    }
    const length = Math.min(maxBytes, stats.size - offset);
    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, offset);
      return { text: buffer.toString(encoding), size: offset + length };
    } finally {
      fs.closeSync(fd);
    }
  };

  return {
    getProjectRoot: () => getProjectPaths().projectRoot,
    getDataDir: () =>
      process.env.AGENT_RELAY_DATA_DIR || path.join(os.homedir(), '.local', 'share', 'agent-relay'),
    createClient: (cwd: string) => createSdkClient(cwd, false),
    createAutostartClient: (cwd: string) => createSdkClient(cwd, true),
    readTaskFromStdin,
    fileExists: fs.existsSync,
    readFile: (filePath, encoding = 'utf-8') => fs.readFileSync(filePath, encoding),
    readFileTail,
    readFileFrom,
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
    .option('--skip-relay-prompt', 'Skip relay MCP prompt injection and agent pre-registration')
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
          skipRelayPrompt?: boolean;
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

        let client: AgentManagementClient;
        try {
          client = await deps.createAutostartClient(deps.getProjectRoot());
        } catch (err: any) {
          deps.error(`Failed to connect to broker: ${err?.message || String(err)}`);
          deps.exit(1);
          return;
        }
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
            skipRelayPrompt: options.skipRelayPrompt,
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
    .option('--plain', 'ANSI-stripped, deduped, line-oriented (greppable)')
    .option('--json', 'Structured JSON: { agent, file, lines[] } (sanitized; snapshot only)')
    .action(
      async (
        name: string,
        options: { lines?: string; follow?: boolean; plain?: boolean; json?: boolean }
      ) => {
        await runAgentsLogsCommand(name, options, deps);
      }
    );

  program
    .command('release')
    .description('Release a spawned agent via API (no terminal required)')
    .argument('<name>', 'Agent name to release')
    .option('--port <port>', 'Dashboard port', DEFAULT_DASHBOARD_PORT)
    .action(async (name: string) => {
      let client: AgentManagementClient;
      try {
        client = await deps.createClient(deps.getProjectRoot());
      } catch (err: any) {
        deps.error(`Failed to connect to broker: ${err?.message || String(err)}`);
        deps.exit(1);
        return;
      }
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
      let client: AgentManagementClient;
      try {
        client = await deps.createClient(deps.getProjectRoot());
      } catch (err: any) {
        deps.error(`Failed to connect to broker: ${err?.message || String(err)}`);
        deps.exit(1);
        return;
      }
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
      let client: AgentManagementClient;
      try {
        client = await deps.createClient(deps.getProjectRoot());
      } catch (err: any) {
        deps.error(`Failed to connect to broker: ${err?.message || String(err)}`);
        deps.exit(1);
        return;
      }
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
