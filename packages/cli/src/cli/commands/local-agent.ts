import type { Command } from 'commander';

import { HarnessDriverClient } from '@agent-relay/harness-driver';
import type { ListAgent } from '@agent-relay/harness-driver';
import type { HarnessRuntime } from '@agent-relay/harnesses';
import { stripAnsiFast } from '@agent-relay/utils';

import { classifyTask, composeTeam, buildDirectorPrompt } from '../../auto/index.js';
import { createBrokerClient } from '../lib/attach-broker.js';
import { attachDrive } from '../lib/attach-drive.js';
import type { AttachMode } from '../lib/attach-mode.js';
import { attachNative, isNativeHarness, type NativeAttachOptions } from '../lib/attach-native.js';
import { attachPassthrough } from '../lib/attach-passthrough.js';
import { attachRemoteNode, type RemoteNodeAttachOptions } from '../lib/attach-remote-node.js';
import { attachView } from '../lib/attach-view.js';
import {
  defaultStateDir,
  readConnectionFileFromDisk,
  resolveBrokerConnection,
  type BrokerConnectionOptions,
} from '../lib/broker-connection.js';
import { resolvedSpawnRuntime, spawnAgentWithClient } from '../lib/client-factory.js';
import { defaultExit } from '../lib/exit.js';

// ── Auto-routing model resolution ─────────────────────────────────────────────

// Maps the routing tier to a concrete Claude model ID.
const CLAUDE_MODEL_IDS: Record<'haiku' | 'sonnet' | 'opus', string> = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-8',
};

/**
 * If `model === 'auto'`, run the task classifier → team composer → Director
 * meta-prompt builder and return resolved spawn options.
 *
 * Only applies to the 'claude' provider — other CLIs use model=auto as a
 * passthrough until their routing tables are defined.
 */
function resolveAutoSpawn(
  provider: string,
  name: string,
  task: string | undefined,
  model: string | undefined
): { name: string; task: string | undefined; model: string | undefined } {
  if (model !== 'auto' || provider !== 'claude' || !task) {
    return { name, task, model };
  }
  const assessment = classifyTask(task);
  const team = composeTeam(assessment, task);
  const directorPrompt = buildDirectorPrompt(task, team);
  return {
    name: name === provider ? 'Director' : name,
    task: directorPrompt,
    model: CLAUDE_MODEL_IDS[team.lead.model],
  };
}

export type { AttachMode } from '../lib/attach-mode.js';
export type LocalAgentMessageBrokerOptions = BrokerConnectionOptions;

/** Dispatch `local agent attach --mode` to the drive/view/passthrough session runners. */
export function runAttach(name: string, mode: AttachMode, options: NativeAttachOptions): Promise<number> {
  return isNativeHarness(name, options).then((nativeHarness) => {
    if (nativeHarness) return attachNative(name, mode, options);
    switch (mode) {
      case 'view':
        return attachView(name, options);
      case 'passthrough':
        return attachPassthrough(name, options);
      case 'drive':
      default:
        return attachDrive(name, options);
    }
  });
}

type ExitFn = (code: number) => never;

export interface LocalAgentDependencies {
  connect: (cwd: string) => Promise<HarnessDriverClient>;
  connectLocal: (cwd: string, options: LocalAgentMessageBrokerOptions) => Promise<HarnessDriverClient>;
  attach: (name: string, mode: AttachMode, options: NativeAttachOptions) => Promise<number>;
  attachRemote: (
    name: string,
    mode: AttachMode,
    node: string,
    options: RemoteNodeAttachOptions
  ) => Promise<number>;
  cwd: () => string;
  readConnectionFile: (stateDir: string) => unknown;
  getDefaultStateDir: () => string;
  env: NodeJS.ProcessEnv;
  fetch: typeof globalThis.fetch;
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: ExitFn;
  now: () => Date;
}

function withDefaults(overrides: Partial<LocalAgentDependencies> = {}): LocalAgentDependencies {
  const deps = {
    connect: async (cwd: string) => HarnessDriverClient.connect({ cwd }),
    cwd: () => process.cwd(),
    readConnectionFile: readConnectionFileFromDisk,
    getDefaultStateDir: defaultStateDir,
    env: process.env,
    fetch: globalThis.fetch,
    attach: runAttach,
    attachRemote: attachRemoteNode,
    log: (...args: unknown[]) => console.log(...args),
    error: (...args: unknown[]) => console.error(...args),
    exit: defaultExit,
    now: () => new Date(),
    ...overrides,
  } as LocalAgentDependencies;
  deps.connectLocal ??= async (_cwd: string, options: LocalAgentMessageBrokerOptions) => {
    const connection = resolveBrokerConnection(options, {
      readConnectionFile: deps.readConnectionFile,
      getDefaultStateDir: deps.getDefaultStateDir,
      env: deps.env,
    });
    if (!connection) {
      throw new Error(
        'Error: could not locate broker connection. Pass --broker-url, set RELAY_BROKER_URL, ' +
          'or run from a directory containing .agentworkforce/relay/connection.json.'
      );
    }
    return createBrokerClient(connection, deps.fetch);
  };
  return deps;
}

const AGENT_STATE_DISPLAY: Record<
  NonNullable<ListAgent['current_state']>,
  { symbol: string; label: string }
> = {
  working: { symbol: '●', label: 'working' },
  idle: { symbol: '○', label: 'idle' },
  blocked_on_send: { symbol: '◐', label: 'waiting' },
};

function formatRelativeTime(value: string | undefined, now: Date): string {
  if (!value) return 'unknown';
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return 'unknown';

  const seconds = Math.max(0, Math.floor((now.getTime() - timestamp) / 1_000));
  if (seconds < 5) return 'now';
  if (seconds < 60) return `${seconds} seconds ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;

  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/**
 * Render the count of messages still waiting to reach the agent. Brokers older
 * than the field report nothing, which stays `-` rather than claiming an empty
 * queue.
 */
function formatPendingCount(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '-';
  return String(Math.floor(value));
}

/** Keep broker-provided text from escaping its table cell or controlling the terminal. */
function sanitizeTerminalCell(value: string): string {
  // eslint-disable-next-line no-control-regex
  return stripAnsiFast(value).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '�');
}

/** Render a compact terminal view while retaining JSON as the script-friendly default. */
export function formatPrettyAgentList(agents: ListAgent[], now: Date): string {
  if (agents.length === 0) return 'No agents running.';

  const rows = agents.map((agent) => {
    const state = agent.current_state ? AGENT_STATE_DISPLAY[agent.current_state] : undefined;
    return {
      name: sanitizeTerminalCell(agent.name),
      cliModel: sanitizeTerminalCell(
        [agent.cli ?? agent.provider ?? agent.runtime, agent.model].filter(Boolean).join(' / ')
      ),
      state: sanitizeTerminalCell(state ? `${state.symbol} ${state.label}` : '· unknown'),
      pending: formatPendingCount(agent.pending_messages),
      lastActive: sanitizeTerminalCell(formatRelativeTime(agent.last_activity_at, now)),
    };
  });
  const columns = [
    { header: 'NAME', values: rows.map((row) => row.name) },
    { header: 'CLI / MODEL', values: rows.map((row) => row.cliModel) },
    { header: 'STATE', values: rows.map((row) => row.state) },
    { header: 'PENDING', values: rows.map((row) => row.pending) },
    { header: 'LAST ACTIVE', values: rows.map((row) => row.lastActive) },
  ];
  const widths = columns.map((column) =>
    Math.max(column.header.length, ...column.values.map((value) => value.length))
  );
  const formatRow = (values: string[]) =>
    values
      .map((value, index) => value.padEnd(widths[index]!))
      .join('  ')
      .trimEnd();

  return [
    formatRow(columns.map((column) => column.header)),
    formatRow(columns.map((_, index) => '-'.repeat(widths[index]!))),
    ...rows.map((row) => formatRow([row.name, row.cliModel, row.state, row.pending, row.lastActive])),
  ].join('\n');
}

async function run(
  deps: LocalAgentDependencies,
  fn: (client: HarnessDriverClient) => Promise<void>
): Promise<void> {
  let client: HarnessDriverClient | undefined;
  try {
    client = await deps.connect(deps.cwd());
    await fn(client);
  } catch (err) {
    deps.error(err instanceof Error ? err.message : String(err));
    deps.exit(1);
  } finally {
    client?.disconnect?.();
  }
}

async function runLocalBroker(
  deps: LocalAgentDependencies,
  options: LocalAgentMessageBrokerOptions,
  fn: (client: HarnessDriverClient) => Promise<void>
): Promise<void> {
  try {
    await fn(await deps.connectLocal(deps.cwd(), options));
  } catch (err) {
    deps.error(err instanceof Error ? err.message : String(err));
    deps.exit(1);
  }
}

function addBrokerOptions(command: Command): Command {
  return command
    .option('--broker-url <url>', 'Broker base URL (overrides RELAY_BROKER_URL and connection.json)')
    .option('--api-key <key>', 'Broker API key (overrides RELAY_BROKER_API_KEY and connection.json)')
    .option('--state-dir <dir>', 'Directory containing connection.json (default: .agentworkforce/relay/)');
}

function brokerOptionsFromOpts(opts: Record<string, unknown>): LocalAgentMessageBrokerOptions {
  return {
    brokerUrl: opts.brokerUrl as string | undefined,
    apiKey: opts.apiKey as string | undefined,
    stateDir: opts.stateDir as string | undefined,
  };
}

function parseRuntimeOption(deps: LocalAgentDependencies, value: unknown): HarnessRuntime | undefined {
  const runtime = (value ?? 'auto') as string;
  if (runtime === 'auto' || runtime === 'native' || runtime === 'pty') return runtime;
  deps.error(`Unknown runtime "${runtime}". Expected one of: auto, native, pty.`);
  deps.exit(1);
  return undefined;
}

function resolveRuntimeOption(
  deps: LocalAgentDependencies,
  provider: string,
  value: unknown
): { requested: HarnessRuntime; selected: ReturnType<typeof resolvedSpawnRuntime> } | undefined {
  const requested = parseRuntimeOption(deps, value);
  if (!requested) return undefined;
  try {
    return { requested, selected: resolvedSpawnRuntime({ cli: provider, runtime: requested }) };
  } catch (error) {
    deps.error(error instanceof Error ? error.message : String(error));
    deps.exit(1);
    return undefined;
  }
}

function parseSpawnModeOption(
  deps: LocalAgentDependencies,
  value: unknown
): 'interactive' | 'task_exit' | undefined {
  const spawnMode = (value ?? 'interactive') as string;
  if (spawnMode === 'interactive') return 'interactive';
  if (spawnMode === 'task-exit' || spawnMode === 'task_exit') return 'task_exit';
  deps.error(`Unknown spawn mode "${spawnMode}". Expected one of: interactive, task-exit.`);
  deps.exit(1);
  return undefined;
}

function validateNativeOptions(
  deps: LocalAgentDependencies,
  options: {
    runtime: ReturnType<typeof resolvedSpawnRuntime>;
    spawnMode: 'interactive' | 'task_exit';
    exitAfterTask: boolean;
    attachMode?: AttachMode;
  }
): boolean {
  if (options.runtime !== 'native') return true;
  if (options.attachMode === 'passthrough') {
    deps.error('Native harnesses do not support passthrough attach mode; use drive or view.');
    deps.exit(1);
    return false;
  }
  if (options.spawnMode !== 'interactive') {
    deps.error('Native harnesses currently support only interactive spawn mode.');
    deps.exit(1);
    return false;
  }
  if (options.exitAfterTask) {
    deps.error('Native harnesses do not currently support --exit-after-task.');
    deps.exit(1);
    return false;
  }
  return true;
}

/**
 * Register the `local agent …` subtree (and `runtime tail`) onto the driver
 * group. List/spawn/release/kill talk to a running local broker.
 */
export function registerLocalAgentCommands(
  group: Command,
  overrides: Partial<LocalAgentDependencies> = {}
): void {
  const deps = withDefaults(overrides);
  const agent = group.command('agent').description('Inspect and manage broker-spawned agents');

  agent
    .command('list')
    .description('List agents running on the local broker')
    .option('--pretty', 'Show a compact human-readable list')
    .action(async (opts: { pretty?: boolean }) => {
      await run(deps, async (client) => {
        const agents = await client.listAgents();
        deps.log(opts.pretty ? formatPrettyAgentList(agents, deps.now()) : JSON.stringify(agents, null, 2));
      });
    });

  agent
    .command('spawn')
    .description('Spawn an agent with the given provider CLI')
    .argument(
      '<provider>',
      'CLI provider (claude, codex, gemini, droid, …); droid is high-risk for delegation/spawn tasks'
    )
    .option('--name <name>', 'Agent name (defaults to the provider)')
    .option('--channels <channels...>', 'Channels to join', ['general'])
    .option('--task <task>', 'Initial task prompt')
    .option('--model <model>', 'Model override')
    .option('--runtime <runtime>', 'Harness runtime: auto | native | pty', 'auto')
    .option('--cwd <path>', 'Working directory for the spawned agent')
    .option('--spawn-mode <mode>', 'Spawn lifecycle: interactive | task-exit', 'interactive')
    .option('--exit-after-task', 'Exit the spawned agent after it completes the injected task')
    .action(async (provider: string, opts: Record<string, unknown>) => {
      const runtime = resolveRuntimeOption(deps, provider, opts.runtime);
      const spawnMode = parseSpawnModeOption(deps, opts.spawnMode);
      if (!runtime || !spawnMode) return;
      if (
        !validateNativeOptions(deps, {
          runtime: runtime.selected,
          spawnMode,
          exitAfterTask: Boolean(opts.exitAfterTask),
        })
      )
        return;
      await run(deps, async (client) => {
        const baseName = (opts.name as string | undefined) ?? provider;
        const resolved = resolveAutoSpawn(
          provider,
          baseName,
          opts.task as string | undefined,
          opts.model as string | undefined
        );
        await spawnAgentWithClient(client, {
          name: resolved.name,
          cli: provider,
          channels: (opts.channels as string[] | undefined) ?? ['general'],
          task: resolved.task,
          model: resolved.model,
          cwd: opts.cwd as string | undefined,
          spawnMode,
          exitAfterTask: opts.exitAfterTask as boolean | undefined,
          runtime: runtime.requested,
        });
        const autoNote = opts.model === 'auto' ? ' (auto-routed)' : '';
        deps.log(`Spawned ${resolved.name} (${provider}, ${runtime.selected})${autoNote}.`);
      });
    });

  agent
    .command('new')
    .description('Spawn an agent and attach to it')
    .argument(
      '<provider>',
      'CLI provider (claude, codex, gemini, droid, …); droid is high-risk for delegation/spawn tasks'
    )
    .option('--name <name>', 'Agent name (defaults to the provider)')
    .option('--mode <mode>', 'Attach mode: drive | view | passthrough', 'drive')
    .option('--channels <channels...>', 'Channels to join', ['general'])
    .option('--task <task>', 'Initial task prompt')
    .option('--model <model>', 'Model override')
    .option('--runtime <runtime>', 'Harness runtime: auto | native | pty', 'auto')
    .option('--cwd <path>', 'Working directory for the spawned agent')
    .option('--spawn-mode <mode>', 'Spawn lifecycle: interactive | task-exit', 'interactive')
    .option('--exit-after-task', 'Exit the spawned agent after it completes the injected task')
    .action(async (provider: string, options: Record<string, unknown>) => {
      const mode = (options.mode as string) ?? 'drive';
      if (mode !== 'drive' && mode !== 'view' && mode !== 'passthrough') {
        deps.error(`Unknown attach mode "${mode}". Expected one of: drive, view, passthrough.`);
        deps.exit(1);
        return;
      }
      const runtime = resolveRuntimeOption(deps, provider, options.runtime);
      const spawnMode = parseSpawnModeOption(deps, options.spawnMode);
      if (!runtime || !spawnMode) return;
      if (
        !validateNativeOptions(deps, {
          runtime: runtime.selected,
          spawnMode,
          exitAfterTask: Boolean(options.exitAfterTask),
          attachMode: mode,
        })
      )
        return;
      const baseName = (options.name as string | undefined) ?? provider;
      const resolved = resolveAutoSpawn(
        provider,
        baseName,
        options.task as string | undefined,
        options.model as string | undefined
      );
      await run(deps, async (client) => {
        await spawnAgentWithClient(client, {
          name: resolved.name,
          cli: provider,
          channels: (options.channels as string[] | undefined) ?? ['general'],
          task: resolved.task,
          model: resolved.model,
          cwd: options.cwd as string | undefined,
          spawnMode,
          exitAfterTask: options.exitAfterTask as boolean | undefined,
          runtime: runtime.requested,
        });
        const autoNote = options.model === 'auto' ? ' (auto-routed)' : '';
        deps.log(
          `Spawned ${resolved.name} (${provider}, ${runtime.selected}). Attaching (${mode})${autoNote}…`
        );
      });
      // `new` spawns and attaches on the same default local broker — broker
      // override flags belong on the standalone `attach` command.
      const code = await deps.attach(resolved.name, mode as AttachMode, {});
      if (code !== 0) {
        deps.exit(code);
      }
    });

  agent
    .command('release')
    .description('Release an agent (graceful stop)')
    .argument('<name>', 'Agent name')
    .action(async (name: string) => {
      await run(deps, async (client) => {
        await client.release(name);
        deps.log(`Released ${name}.`);
      });
    });

  agent
    .command('set-model')
    .description("Switch a running agent's model (sends `/model` to its TUI; best-effort)")
    .argument('<name>', 'Agent name')
    .argument('<model>', 'Model identifier to switch to')
    .action(async (name: string, model: string) => {
      await run(deps, async (client) => {
        await client.setModel(name, model);
        deps.log(`Sent \`/model ${model}\` to ${name} (best-effort — the agent's TUI applies it).`);
      });
    });

  agent
    .command('attach')
    .description('Attach to a running agent interactively (drive | view | passthrough)')
    .argument('<name>', 'Agent name')
    .option('--mode <mode>', 'drive | view | passthrough', 'view')
    .option('--ssh-host <host>', 'SSH host fallback for a physical fleet node')
    .option('--broker-url <url>', 'Broker base URL (overrides RELAY_BROKER_URL and connection.json)')
    .option('--api-key <key>', 'Broker API key (overrides RELAY_BROKER_API_KEY and connection.json)')
    .option(
      '--state-dir <dir>',
      'Directory containing connection.json (with --ssh-host: path on target; auto-discovered when omitted)'
    )
    .option('--json', 'Emit normalized agent events as NDJSON')
    .option('--reasoning', 'Include agent reasoning events')
    .option('--diagnostics', 'Include native harness diagnostics')
    .action(async (name: string, options: Record<string, unknown>) => {
      const mode = (options.mode as string) ?? 'view';
      if (mode !== 'drive' && mode !== 'view' && mode !== 'passthrough') {
        deps.error(`Unknown attach mode "${mode}". Expected one of: drive, view, passthrough.`);
        deps.exit(1);
        return;
      }
      const sshHost = options.sshHost as string | undefined;
      if (sshHost !== undefined) {
        if (options.brokerUrl !== undefined || options.apiKey !== undefined) {
          deps.error('Error: --ssh-host cannot be combined with --broker-url or --api-key.');
          deps.exit(1);
          return;
        }
        const code = await deps.attachRemote(name, mode, sshHost, {
          stateDir: options.stateDir as string | undefined,
          json: options.json as boolean | undefined,
          reasoning: options.reasoning as boolean | undefined,
          diagnostics: options.diagnostics as boolean | undefined,
        });
        if (code !== 0) deps.exit(code);
        return;
      }
      const code = await deps.attach(name, mode, {
        brokerUrl: options.brokerUrl as string | undefined,
        apiKey: options.apiKey as string | undefined,
        stateDir: options.stateDir as string | undefined,
        json: options.json as boolean | undefined,
        reasoning: options.reasoning as boolean | undefined,
        diagnostics: options.diagnostics as boolean | undefined,
      });
      if (code !== 0) {
        deps.exit(code);
      }
    });

  const message = agent.command('message').description('Control local broker message delivery for an agent');

  addBrokerOptions(
    message
      .command('flush')
      .description('Flush queued relay messages into a held local agent')
      .argument('<name>', 'Agent name')
  ).action(async (name: string, opts: Record<string, unknown>) => {
    await runLocalBroker(deps, brokerOptionsFromOpts(opts), async (client) => {
      deps.log(JSON.stringify({ name, ...(await client.flushPending(name)) }, null, 2));
    });
  });

  addBrokerOptions(
    message
      .command('hold')
      .description('Hold new relay messages for a local agent until flushed')
      .argument('<name>', 'Agent name')
  ).action(async (name: string, opts: Record<string, unknown>) => {
    await runLocalBroker(deps, brokerOptionsFromOpts(opts), async (client) => {
      deps.log(
        JSON.stringify({ name, ...(await client.setInboundDeliveryMode(name, 'manual_flush')) }, null, 2)
      );
    });
  });

  addBrokerOptions(
    message
      .command('auto')
      .description('Resume automatic relay message injection for a local agent')
      .argument('<name>', 'Agent name')
  ).action(async (name: string, opts: Record<string, unknown>) => {
    await runLocalBroker(deps, brokerOptionsFromOpts(opts), async (client) => {
      deps.log(
        JSON.stringify({ name, ...(await client.setInboundDeliveryMode(name, 'auto_inject')) }, null, 2)
      );
    });
  });

  group
    .command('tail')
    .description('Stream broker events (optionally filtered to one agent)')
    .option('--agent <name>', "Filter to a single agent's output stream")
    .action(async (options: { agent?: string }) => {
      await run(deps, async (client) => {
        if (options.agent) {
          for await (const chunk of client.subscribeWorkerStream(options.agent)) {
            process.stdout.write(chunk);
          }
          return;
        }
        client.connectEvents();
        await new Promise<void>((resolve) => {
          client.onEvent((event) => {
            deps.log(JSON.stringify(event));
          });
          // Ctrl+C ends a streaming tail cleanly (exit 0, no error output).
          process.once('SIGINT', () => resolve());
        });
      });
    });
}
