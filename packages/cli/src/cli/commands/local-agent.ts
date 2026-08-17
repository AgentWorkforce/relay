import type { Command } from 'commander';

import { HarnessDriverClient } from '@agent-relay/harness-driver';
import type { InboundDeliveryMode, ListAgent, PendingRelayMessage } from '@agent-relay/harness-driver';
import type { HarnessRuntime } from '@agent-relay/harnesses';
import { stripAnsiFast } from '@agent-relay/utils';

import { classifyTask, composeTeam, buildDirectorPrompt } from '../../auto/index.js';
import { createBrokerClient } from '../lib/attach-broker.js';
import { attachDrive } from '../lib/attach-drive.js';
import type { AttachMode } from '../lib/attach-mode.js';
import { attachNative, isNativeHarness, type NativeAttachOptions } from '../lib/attach-native.js';
import { attachPassthrough } from '../lib/attach-passthrough.js';
import { attachRemoteNode, type RemoteNodeAttachOptions } from '../lib/attach-remote-node.js';
import { startFleetNodeAttachProxy } from '../lib/attach-fleet-node.js';
import { attachView } from '../lib/attach-view.js';
import { createBackpressureAwareWriter } from '../lib/attach.js';
import {
  defaultStateDir,
  readConnectionFileFromDisk,
  resolveBrokerConnection,
  type BrokerConnectionOptions,
} from '../lib/broker-connection.js';
import { resolvedSpawnRuntime, spawnAgentWithClient } from '../lib/client-factory.js';
import { describeError } from '../lib/describe-error.js';
import { defaultExit } from '../lib/exit.js';
import { redeemJoinTicket } from '../lib/join-ticket.js';
import { describeClearedEnrollment, persistWorkspaceSession } from '../lib/workspace-session.js';

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

/**
 * Options for the `--node` fleet path. Deliberately not `NativeAttachOptions`:
 * a fleet attach authenticates with the Relaycast workspace key and has no
 * local broker, so `--broker-url` / `--api-key` / `--state-dir` are rejected
 * rather than accepted and ignored.
 */
export type FleetNodeAttachCliOptions = Pick<NativeAttachOptions, 'json' | 'reasoning' | 'diagnostics'> & {
  workspaceKey?: string;
};

/**
 * Run an existing attach mode against the short-lived loopback adapter for a
 * remote fleet node. Deliberately bypasses native-harness detection: the proxy
 * represents a PTY byte stream, while native mode is an event protocol.
 */
export async function attachFleetNode(
  name: string,
  mode: AttachMode,
  node: string,
  options: FleetNodeAttachCliOptions
): Promise<number> {
  const proxy = await startFleetNodeAttachProxy({
    agent: name,
    node,
    mode,
    ...(options.workspaceKey === undefined ? {} : { workspaceKey: options.workspaceKey }),
  });
  const jsonWriter = options.json ? createBackpressureAwareWriter(process.stdout) : undefined;
  try {
    const connectionOptions = { brokerUrl: proxy.brokerUrl, apiKey: proxy.apiKey };
    // Fleet agents expose a PTY stream rather than native-harness envelopes.
    // In JSON mode retain the machine-readable contract by serializing every
    // rendered stream chunk as NDJSON, including the initial snapshot.
    const jsonOutput = (chunk: string) => {
      jsonWriter?.write(`${JSON.stringify({ kind: 'worker_stream', name, stream: 'stdout', chunk })}\n`);
    };
    if (options.reasoning || options.diagnostics) {
      process.stderr.write(
        '[node attach] reasoning and diagnostics are unavailable for remote PTY terminal sessions.\n'
      );
    }
    switch (mode) {
      case 'view':
        return await attachView(
          name,
          connectionOptions,
          options.json ? { writeChunk: jsonOutput, stdoutIsTty: false } : {}
        );
      case 'passthrough':
        return await attachPassthrough(
          name,
          connectionOptions,
          options.json
            ? {
                writeChunk: jsonOutput,
                // JSON mode is a non-terminal stream. Suppressing the local
                // status line and reset controls keeps only worker bytes in
                // the NDJSON records, matching SSH's no-TTY JSON behaviour.
                terminal: { getSize: () => null, onResize: () => () => undefined },
              }
            : {}
        );
      case 'drive':
      default:
        return await attachDrive(
          name,
          connectionOptions,
          options.json
            ? {
                writeChunk: jsonOutput,
                terminal: { getSize: () => null, onResize: () => () => undefined },
              }
            : {}
        );
    }
  } finally {
    // NDJSON is a data contract, unlike an interactive screen: queue every
    // locally buffered record before teardown so the shared CLI stdio drain
    // can carry it through a backpressured pipe.
    jsonWriter?.flush();
    jsonWriter?.dispose();
    await proxy.close();
  }
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
  attachNode: (
    name: string,
    mode: AttachMode,
    node: string,
    options: FleetNodeAttachCliOptions
  ) => Promise<number>;
  cwd: () => string;
  readConnectionFile: (stateDir: string) => unknown;
  getDefaultStateDir: () => string;
  env: NodeJS.ProcessEnv;
  fetch: typeof globalThis.fetch;
  redeemJoinTicket: typeof redeemJoinTicket;
  persistWorkspaceSession: typeof persistWorkspaceSession;
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
    redeemJoinTicket,
    persistWorkspaceSession,
    attach: runAttach,
    attachRemote: attachRemoteNode,
    attachNode: attachFleetNode,
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

type AttachCredentialSelection =
  | { ok: true; workspaceKey?: string; joinTicket?: string }
  | { ok: false; error: string };

function resolveAttachCredentialSelection(
  rawWorkspaceKey: string | undefined,
  rawJoinTicket: string | undefined,
  node: string | undefined,
  sshHost: string | undefined
): AttachCredentialSelection {
  const workspaceKey = rawWorkspaceKey?.trim() || undefined;
  const joinTicket = rawJoinTicket?.trim() || undefined;
  if (rawWorkspaceKey !== undefined && rawJoinTicket !== undefined) {
    return { ok: false, error: 'Error: --join-ticket cannot be combined with --workspace-key.' };
  }
  if (rawJoinTicket !== undefined && !joinTicket) {
    return { ok: false, error: 'Error: --join-ticket requires a non-empty ticket.' };
  }
  if (rawWorkspaceKey !== undefined && node === undefined) {
    return {
      ok: false,
      error:
        sshHost !== undefined
          ? 'Error: --workspace-key requires --node. The --ssh-host attach path reads the target broker connection.json — locate it with --state-dir instead.'
          : 'Error: --workspace-key requires --node. The local attach path uses --broker-url / --api-key or reads connection.json from --state-dir instead.',
    };
  }
  if (rawJoinTicket !== undefined && node === undefined) {
    return {
      ok: false,
      error:
        sshHost !== undefined
          ? 'Error: --join-ticket requires --node. The --ssh-host attach path reads the target broker connection.json — locate it with --state-dir instead.'
          : 'Error: --join-ticket requires --node. The local attach path uses --broker-url / --api-key or reads connection.json from --state-dir instead.',
    };
  }
  return { ok: true, workspaceKey, joinTicket };
}

async function redeemAndPersistAttachCredential(
  deps: LocalAgentDependencies,
  options: { ticket: string; node: string; agent: string; mode: AttachMode }
): Promise<string> {
  const redeemed = await deps.redeemJoinTicket({
    ticket: options.ticket,
    node: options.node,
    agent: options.agent,
    mode: options.mode,
    env: deps.env,
    fetch: deps.fetch,
  });
  const persisted = deps.persistWorkspaceSession({
    workspaceKey: redeemed.workspaceKey,
    workspaceId: redeemed.workspaceId,
    projectRoot: deps.cwd(),
  });
  const warning = describeClearedEnrollment(persisted);
  if (warning) deps.error(warning);
  return redeemed.workspaceKey;
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

/** Fixed-width text table shared by the plain and delivery-status pretty views. */
function renderTable(columns: { header: string; values: string[] }[]): string {
  const widths = columns.map((column) =>
    Math.max(column.header.length, ...column.values.map((value) => value.length))
  );
  const formatRow = (values: string[]) =>
    values
      .map((value, index) => value.padEnd(widths[index]!))
      .join('  ')
      .trimEnd();
  const rowCount = columns[0]?.values.length ?? 0;

  return [
    formatRow(columns.map((column) => column.header)),
    formatRow(columns.map((_, index) => '-'.repeat(widths[index]!))),
    ...Array.from({ length: rowCount }, (_, rowIndex) =>
      formatRow(columns.map((column) => column.values[rowIndex]!))
    ),
  ].join('\n');
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

  return renderTable([
    { header: 'NAME', values: rows.map((row) => row.name) },
    { header: 'CLI / MODEL', values: rows.map((row) => row.cliModel) },
    { header: 'STATE', values: rows.map((row) => row.state) },
    { header: 'PENDING', values: rows.map((row) => row.pending) },
    { header: 'LAST ACTIVE', values: rows.map((row) => row.lastActive) },
  ]);
}

/**
 * A `ListAgent` enriched with the two delivery-observability fields that
 * `/api/spawned` does not carry: the worker's current `InboundDeliveryMode`
 * and its raw pending-queue contents (relay#1387). `delivery_mode`/`pending`
 * are `undefined` when the per-agent fetch failed (e.g. the worker vanished
 * mid-request), so callers can tell "unknown" apart from "empty".
 */
export interface AgentDeliveryStatus extends ListAgent {
  delivery_mode?: InboundDeliveryMode;
  pending?: PendingRelayMessage[];
}

/** Four agents at once means no more than eight concurrent broker reads. */
const DELIVERY_STATUS_AGENT_CONCURRENCY = 4;

/** Map in input order without allowing a fleet status read to overwhelm its broker. */
async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      results[index] = await mapper(values[index]!);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return results;
}

/**
 * Fetch delivery mode + pending-queue contents for every listed agent. A
 * status read costs one `/api/spawned` call plus two calls per agent, but we
 * limit enrichment to four agents at once so inspecting a busy fleet cannot
 * turn into an unbounded broker request fan-out.
 */
export async function withDeliveryStatus(
  client: Pick<HarnessDriverClient, 'getInboundDeliveryMode' | 'getPending'>,
  agents: ListAgent[]
): Promise<AgentDeliveryStatus[]> {
  return mapWithConcurrency(agents, DELIVERY_STATUS_AGENT_CONCURRENCY, async (agent) => {
      const [delivery_mode, pending] = await Promise.all([
        client.getInboundDeliveryMode(agent.name).catch(() => undefined),
        client.getPending(agent.name).catch(() => undefined),
      ]);
      return { ...agent, delivery_mode, pending };
  });
}

/** A worker holding messages it cannot currently act on: parked in `manual_flush` with a non-empty queue. */
function stuckStatus(agent: AgentDeliveryStatus): 'yes' | 'no' | 'unknown' {
  // A failed status read is observability data, not proof that the queue is empty.
  if (agent.delivery_mode === undefined || agent.pending === undefined) return 'unknown';
  return agent.delivery_mode === 'manual_flush' && agent.pending.length > 0 ? 'yes' : 'no';
}

/** Render the `--status` pretty view: mode, pending depth, and the derived stuck signal, alongside last-activity. */
export function formatPrettyAgentStatusList(agents: AgentDeliveryStatus[], now: Date): string {
  if (agents.length === 0) return 'No agents running.';

  const rows = agents.map((agent) => ({
    name: sanitizeTerminalCell(agent.name),
    mode: sanitizeTerminalCell(agent.delivery_mode ?? 'unknown'),
    pending: agent.pending ? String(agent.pending.length) : '-',
    stuck: stuckStatus(agent),
    lastActive: sanitizeTerminalCell(formatRelativeTime(agent.last_activity_at, now)),
  }));

  return renderTable([
    { header: 'NAME', values: rows.map((row) => row.name) },
    { header: 'MODE', values: rows.map((row) => row.mode) },
    { header: 'PENDING', values: rows.map((row) => row.pending) },
    { header: 'STUCK', values: rows.map((row) => row.stuck) },
    { header: 'LAST ACTIVE', values: rows.map((row) => row.lastActive) },
  ]);
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
    .option('--status', 'Include each agent inbound delivery mode and pending-queue contents (relay#1387)')
    .action(async (opts: { pretty?: boolean; status?: boolean }) => {
      await run(deps, async (client) => {
        const agents = await client.listAgents();
        if (opts.status) {
          const withStatus = await withDeliveryStatus(client, agents);
          deps.log(
            opts.pretty
              ? formatPrettyAgentStatusList(withStatus, deps.now())
              : JSON.stringify(withStatus, null, 2)
          );
          return;
        }
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
    .option('--node <node>', 'Canonical authenticated fleet-node terminal attach (physical or Daytona)')
    .option('--ssh-host <host>', 'SSH host fallback for a physical fleet node')
    .option('--broker-url <url>', 'Broker base URL (overrides RELAY_BROKER_URL and connection.json)')
    .option('--api-key <key>', 'Broker API key (overrides RELAY_BROKER_API_KEY and connection.json)')
    .option(
      '--state-dir <dir>',
      'Directory containing connection.json (with --ssh-host: path on target; auto-discovered when omitted)'
    )
    .option(
      '--workspace-key <key>',
      'Relaycast workspace key for --node (overrides RELAY_WORKSPACE_KEY, the project pin, and the machine-global active workspace)'
    )
    .option(
      '--join-ticket <ticket>',
      "Short-lived Relaycast join ticket for --node (redeemed and saved as this project's workspace credential)"
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
      const node = options.node as string | undefined;
      const rawWorkspaceKey = options.workspaceKey as string | undefined;
      const rawJoinTicket = options.joinTicket as string | undefined;
      // Only the fleet path authenticates with a workspace key. The local and
      // SSH paths speak the broker contract, so accepting the flag there would
      // silently ignore it and send the caller to the wrong workspace. Gate on
      // the raw option rather than the normalized one: `--workspace-key "$KEY"`
      // with an unset variable is still a caller asking for a workspace, and
      // must be told so instead of being routed to a broker.
      const credential = resolveAttachCredentialSelection(rawWorkspaceKey, rawJoinTicket, node, sshHost);
      if (!credential.ok) {
        deps.error(credential.error);
        deps.exit(1);
        return;
      }
      if (node !== undefined && sshHost !== undefined) {
        deps.error(
          'Error: --node cannot be combined with --ssh-host. Use --ssh-host only as the explicit SSH fallback.'
        );
        deps.exit(1);
        return;
      }
      if (node !== undefined) {
        if (
          options.brokerUrl !== undefined ||
          options.apiKey !== undefined ||
          options.stateDir !== undefined
        ) {
          deps.error(
            'Error: --node cannot be combined with --broker-url, --api-key, or --state-dir. It opens an ephemeral authenticated loopback session.'
          );
          deps.exit(1);
          return;
        }
        try {
          let attachWorkspaceKey = credential.workspaceKey;
          if (credential.joinTicket) {
            // Pass the redeemed key explicitly into the first attach. Merely
            // writing the project pin would leave this process vulnerable to
            // a higher-precedence ambient workspace environment variable.
            attachWorkspaceKey = await redeemAndPersistAttachCredential(deps, {
              ticket: credential.joinTicket,
              node,
              agent: name,
              mode,
            });
          }
          const code = await deps.attachNode(name, mode, node, {
            workspaceKey: attachWorkspaceKey,
            json: options.json as boolean | undefined,
            reasoning: options.reasoning as boolean | undefined,
            diagnostics: options.diagnostics as boolean | undefined,
          });
          if (code !== 0) deps.exit(code);
        } catch (error) {
          const message = describeError(error);
          deps.error(message.startsWith('Error:') ? message : `Error: ${message}`);
          deps.exit(1);
        }
        return;
      }
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
