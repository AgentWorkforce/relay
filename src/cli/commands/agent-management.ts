import { Command } from 'commander';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getProjectPaths } from '@agent-relay/config';

import { createAgentRelayClient } from '../lib/client-factory.js';
import {
  runAgentsCommand,
  runAgentsLogsCommand,
  runWhoCommand,
} from '../lib/agent-management-listing.js';

type ShadowMode = 'subagent' | 'process';
type ShadowTrigger =
  | 'SESSION_END'
  | 'CODE_WRITTEN'
  | 'REVIEW_REQUEST'
  | 'EXPLICIT_ASK'
  | 'ALL_MESSAGES';

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

function createDefaultClient(cwd: string): AgentManagementClient {
  return createAgentRelayClient({ cwd }) as unknown as AgentManagementClient;
}

function withDefaults(
  overrides: Partial<AgentManagementDependencies> = {}
): AgentManagementDependencies {
  return {
    getProjectRoot: () => getProjectPaths().projectRoot,
    getDataDir: () =>
      process.env.AGENT_RELAY_DATA_DIR || path.join(os.homedir(), '.local', 'share', 'agent-relay'),
    createClient: createDefaultClient,
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

        const client = deps.createClient(options.cwd || deps.getProjectRoot());
        let exitCode = 0;

        const taskToSpawn = finalTask;

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
    .command('broker-spawn')
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
    .command('agents')
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
    .action(async (name: string, options: { lines?: string }) => {
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
    .command('agents:kill')
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
