/**
 * HarnessDriverClient — single client for communicating with an agent-relay broker
 * over HTTP/WS. Works identically for local and remote brokers.
 *
 * Usage:
 *   // Remote broker (Daytona sandbox, cloud, etc.)
 *   const client = new HarnessDriverClient({ baseUrl, apiKey });
 *
 *   // Local broker (spawn and connect)
 *   const client = await HarnessDriverClient.spawn({ cwd: '/my/project' });
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  BrokerTransport,
  HarnessDriverProtocolError,
  type PtyInputStream,
  type PtyInputStreamOptions,
} from './transport.js';
import { getBrokerBinaryPath, formatBrokerNotFoundError } from './broker-path.js';
import type {
  BrokerEvent,
  BrokerStats,
  BrokerStatus,
  CrashInsightsResponse,
  DeadLettersResponse,
  RedeliverDeadLettersResponse,
  PendingRelayMessage,
  PtySnapshot,
  InboundDeliveryMode,
  SnapshotFormat,
  NativeHarnessCommand,
  NativeHarnessCommandAck,
  AgentEventEnvelope,
  AgentEventHistoryResponse,
} from './protocol.js';
import type {
  SpawnAgentResult,
  SpawnCliInput,
  SpawnHeadlessInput,
  SpawnPtyInput,
  SendMessageInput,
  ListAgent,
} from './types.js';
import { EventBus } from './event-bus.js';
import { SpawnedAgentHandle } from './agent-handle.js';
import type {
  AfterAgentReleaseContext,
  AfterAgentSpawnContext,
  HarnessDriverEvents,
  BeforeAgentReleaseContext,
  BeforeAgentSpawnContext,
  BeforeAgentSpawnHandler,
  SpawnPatch,
} from './lifecycle-hooks.js';
import { buildBrokerSpawnConfig, type RuntimeSpawnOptions } from './spawn-config.js';
export type { BrokerInitArgs, BrokerSpawnConfig, RuntimeSpawnOptions } from './spawn-config.js';
import {
  applySpawnPatch,
  buildSpawnCliBody,
  buildSpawnPtyBody,
  isBundledHeadlessCli,
  resolveSpawnTransport,
} from './spawn-request.js';
import {
  cloneBrokerExitInfo,
  drainBrokerStdioAfterStartup,
  formatBrokerStartupError,
  isProcessRunning,
  pushBufferedLine,
  waitForApiUrl,
  waitForExit,
  type BrokerExitInfo,
} from './broker-process.js';
// Re-exported so `export * from './client.js'` keeps BrokerExitInfo on the
// public surface after it moved into the broker-process module.
export type { BrokerExitInfo } from './broker-process.js';

// ── Types ──────────────────────────────────────────────────────────────

export interface HarnessDriverClientOptions {
  baseUrl: string;
  apiKey?: string;
  /** Fetch implementation. Defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
  /** Timeout in ms for HTTP requests. Default: 30000. */
  requestTimeoutMs?: number;
  /**
   * Shared event bus. When constructed bare, the client owns its own bus
   * — listeners registered via `addListener` flow only through this
   * client. When passed in (typically by `AgentRelay`), the client uses
   * the supplied bus so facade-registered listeners observe call-site
   * hooks fired here.
   */
  eventBus?: EventBus<HarnessDriverEvents>;
}

const optionalString = z.preprocess((value) => (value === null ? undefined : value), z.string().optional());
const optionalNumber = z.preprocess((value) => (value === null ? undefined : value), z.number().optional());

export const SpawnAgentResultSchema = z.looseObject({
  success: z.boolean().optional(),
  name: z.string(),
  runtime: z.enum(['pty', 'headless']),
  model: z.string().nullable().optional(),
  pid: optionalNumber,
  pre_registered: z.boolean().optional(),
  warning: z.string().nullable().optional(),
  sessionId: optionalString,
});

export interface SessionInfo {
  broker_version: string;
  protocol_version: number;
  workspace_key?: string;
  relay_base_url?: string;
  default_workspace_id?: string;
  /** The node id the broker registered as; capability providers attach here. */
  node_id?: string;
  /** The node's name (the target others address). */
  node_name?: string;
  /** The node's shared token, so local providers attach without pre-enrollment. */
  node_token?: string;
  mode: string;
  uptime_secs: number;
}

export interface SetInboundDeliveryModeResult {
  mode: InboundDeliveryMode;
  flushed: number;
  /**
   * `true` when the set was applied. `false` when an expected mode or revision
   * did not match, in which case `mode` reports the current unchanged mode.
   * Guarded calls fail closed when a legacy broker omits this field.
   */
  matched: boolean;
  /** Monotonic broker generation after the set, or `null` on a legacy broker. */
  revision: string | null;
}

/** Options for {@link HarnessDriverClient.setInboundDeliveryMode}. */
export interface SetInboundDeliveryModeOptions {
  /**
   * Compare-and-set guard: apply the new mode only if the worker's current
   * mode still equals this value. Used by the CLI detach-restore path to avoid
   * clobbering a concurrent mode change (a read-then-set TOCTOU). Omit for an
   * unconditional set.
   */
  expectedMode?: InboundDeliveryMode;
  /** Require the worker mode generation to still equal this decimal string. */
  expectedRevision?: string;
}

export interface WorkerStreamSubscriptionOptions {
  /** Filter by stream name, for example `stdout` or `stderr`. Defaults to all streams. */
  stream?: string;
  /** Sequence offset to pass to the broker event stream when connecting. */
  sinceSeq?: number;
  /**
   * Maximum number of unconsumed chunks buffered when the caller isn't
   * pulling from the iterator as fast as events arrive. Once the cap is hit,
   * the oldest buffered chunk is dropped to make room for the newest one (a
   * slow/paused consumer trades completeness for bounded memory rather than
   * growing without limit). A single warning is logged the first time this
   * happens per subscription.
   *
   * Normalized to a finite positive integer: non-finite (`NaN`/`Infinity`),
   * zero, or negative values are ignored and fall back to the default rather
   * than silently disabling the bound. Default: 10000.
   */
  maxQueueSize?: number;
}

export interface AgentEventSubscriptionOptions {
  sinceSequence?: number;
  /** Broker event cursor used to make subscribe-before-history gap-free. */
  sinceBrokerSeq?: number;
  maxQueueSize?: number;
}

const DEFAULT_WORKER_STREAM_MAX_QUEUE_SIZE = 10_000;

/**
 * Coerce a caller-supplied `maxQueueSize` to a finite positive integer. A
 * non-finite, zero, or negative value would defeat the buffer bound entirely
 * (`queue.length >= NaN` is always false), so those fall back to the default.
 */
function normalizeMaxQueueSize(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_WORKER_STREAM_MAX_QUEUE_SIZE;
  }
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : DEFAULT_WORKER_STREAM_MAX_QUEUE_SIZE;
}

type BrokerExitListener = (info: BrokerExitInfo) => void;

// ── Client ─────────────────────────────────────────────────────────────

export class HarnessDriverClient {
  private readonly transport: BrokerTransport;

  /** Set after spawn() — the managed child process. */
  private child: ChildProcess | null = null;
  /** Lease renewal timer (only for spawned brokers). */
  private leaseTimer: ReturnType<typeof setInterval> | null = null;
  private brokerExitInfo: BrokerExitInfo | null = null;
  private brokerExitListeners = new Set<BrokerExitListener>();

  workspaceKey?: string;
  /** Resolved broker URL — captured so call-site lifecycle contexts can surface it. */
  readonly baseUrl: string;
  /** Shared multi-listener registry. Created bare when no `eventBus` is passed in. */
  readonly eventBus: EventBus<HarnessDriverEvents>;

  constructor(options: HarnessDriverClientOptions) {
    this.baseUrl = options.baseUrl;
    this.eventBus = options.eventBus ?? new EventBus<HarnessDriverEvents>();
    this.transport = new BrokerTransport({
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      fetch: options.fetch,
      requestTimeoutMs: options.requestTimeoutMs,
    });
  }

  /**
   * Register a listener on the client's event bus. Returns an unsubscribe
   * function. Equivalent to `client.eventBus.addListener(...)` but mirrors
   * the `AgentRelay` facade API so direct-client callers don't need to
   * reach through `.eventBus`.
   *
   * `beforeAgentSpawn` is the one event whose handler may return a
   * `SpawnPatch` to mutate the spawn input — the dedicated overload
   * keeps that contract type-safe without forcing other events to accept
   * non-void returns.
   */
  addListener(event: 'beforeAgentSpawn', handler: BeforeAgentSpawnHandler): () => void;
  addListener<K extends keyof HarnessDriverEvents>(
    event: K,
    handler: (...args: HarnessDriverEvents[K]) => void | Promise<void>
  ): () => void;
  addListener<K extends keyof HarnessDriverEvents>(
    event: K,
    handler: ((...args: HarnessDriverEvents[K]) => void | Promise<void>) | BeforeAgentSpawnHandler
  ): () => void {
    return this.eventBus.addListener(
      event,
      handler as (...args: HarnessDriverEvents[K]) => void | Promise<void>
    );
  }

  /** Remove a previously-registered listener. */
  removeListener(event: 'beforeAgentSpawn', handler: BeforeAgentSpawnHandler): void;
  removeListener<K extends keyof HarnessDriverEvents>(
    event: K,
    handler: (...args: HarnessDriverEvents[K]) => void | Promise<void>
  ): void;
  removeListener<K extends keyof HarnessDriverEvents>(
    event: K,
    handler: ((...args: HarnessDriverEvents[K]) => void | Promise<void>) | BeforeAgentSpawnHandler
  ): void {
    this.eventBus.removeListener(event, handler as (...args: HarnessDriverEvents[K]) => void | Promise<void>);
  }

  /**
   * Fold `beforeAgentSpawn` patches into the input. Listeners run in
   * registration order; each may return a {@link SpawnPatch} that is
   * shallow-merged over the running result. Handler exceptions are caught
   * and logged but do not abort the chain.
   */
  private async runBeforeSpawn<TInput extends SpawnPtyInput | SpawnCliInput>(
    ctx: BeforeAgentSpawnContext<TInput>
  ): Promise<TInput> {
    let resolved: TInput = { ...ctx.input };
    for (const handler of this.eventBus.listeners<'beforeAgentSpawn', void | SpawnPatch>(
      'beforeAgentSpawn'
    )) {
      try {
        const patch = await handler({ ...ctx, input: resolved });
        if (patch && typeof patch === 'object') {
          resolved = applySpawnPatch(resolved, patch);
        }
      } catch (err) {
        console.error('[agent-relay] beforeAgentSpawn listener threw:', err);
      }
    }
    return resolved;
  }

  /**
   * Connect to an already-running broker by reading its connection file.
   *
   * The broker writes `connection.json` to its data directory ({cwd}/.agentworkforce/relay/
   * in persist mode). This method reads that file to get the URL and API key.
   *
   * @param cwd — project directory (default: process.cwd())
   * @param connectionPath — explicit path to connection.json (overrides cwd)
   */
  static connect(options?: {
    cwd?: string;
    connectionPath?: string;
    eventBus?: EventBus<HarnessDriverEvents>;
  }): HarnessDriverClient {
    const cwd = options?.cwd ?? process.cwd();
    const stateDir = process.env.AGENT_RELAY_STATE_DIR;
    const connPath =
      options?.connectionPath ??
      path.join(stateDir ?? path.join(cwd, '.agentworkforce/relay'), 'connection.json');

    if (!existsSync(connPath)) {
      throw new Error(
        `No running broker found (${connPath} does not exist). Start one with 'agent-relay up' or use HarnessDriverClient.spawn().`
      );
    }

    const raw = readFileSync(connPath, 'utf-8');
    let conn: { url?: string; api_key?: string; workspace_key?: string; port?: number; pid?: number };
    try {
      conn = JSON.parse(raw);
    } catch {
      throw new Error(`Corrupt broker connection file (${connPath}). Remove it and start the broker again.`);
    }

    if (typeof conn.url !== 'string' || typeof conn.api_key !== 'string' || typeof conn.pid !== 'number') {
      throw new Error(
        `Invalid broker connection metadata in ${connPath}. Remove it and start the broker again.`
      );
    }

    if (!isProcessRunning(conn.pid)) {
      throw new Error(
        `Stale broker connection file (${connPath}) points to dead pid ${conn.pid}. Start the broker with 'agent-relay up' or use HarnessDriverClient.spawn().`
      );
    }

    return new HarnessDriverClient({
      baseUrl: conn.url,
      apiKey: conn.api_key,
      ...(options?.eventBus ? { eventBus: options.eventBus } : {}),
    });
  }

  /**
   * Spawn a local broker process and return a connected client.
   *
   * 1. Generates a random API key
   * 2. Spawns the broker binary (attached)
   * 3. Parses the API port from stdout
   * 4. Connects HTTP/WS transport
   * 5. Fetches session metadata
   * 6. Starts event stream + lease renewal
   */
  static async spawn(options?: RuntimeSpawnOptions): Promise<HarnessDriverClient> {
    const onStep = options?.onStep;
    let binaryPath = options?.binaryPath;
    if (!binaryPath) {
      const resolved = getBrokerBinaryPath();
      if (!resolved) {
        throw new Error(formatBrokerNotFoundError());
      }
      binaryPath = resolved;
    }
    onStep?.(`Resolved broker binary: ${binaryPath}`);
    const apiKey = `br_${randomBytes(16).toString('hex')}`;
    const { cwd, timeoutMs, args, env } = buildBrokerSpawnConfig(options, apiKey);
    const stderrLines: string[] = [];
    const stdoutLines: string[] = [];

    onStep?.(`Spawning broker process: ${binaryPath} ${args.join(' ')}`);
    const child = spawn(binaryPath, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (child.stderr) {
      const { createInterface } = await import('node:readline');
      const rl = createInterface({ input: child.stderr });
      rl.on('line', (line) => {
        pushBufferedLine(stderrLines, line);
        options?.onStderr?.(line);
      });
    }

    // Parse the API URL from stdout (the broker prints it after binding)
    const baseUrl = await waitForApiUrl(child, timeoutMs, {
      binaryPath,
      args,
      cwd,
      stdoutLines,
      stderrLines,
    });
    onStep?.(`Broker API listening at ${baseUrl}`);
    drainBrokerStdioAfterStartup(child);

    const client = new HarnessDriverClient({
      baseUrl,
      apiKey,
      requestTimeoutMs: options?.requestTimeoutMs,
      ...(options?.eventBus ? { eventBus: options.eventBus } : {}),
    });
    client.child = child;
    client.installManagedBrokerExitHandler(child, stderrLines);

    // The broker prints "API listening on …" the moment its TCP listener is
    // bound, but it still needs to complete a Relaycast handshake before
    // `getSession()` will return. Two failure modes to handle:
    //
    //   1. Broker is alive and warming up — the startup-only API responds
    //      503 until the handshake completes. Poll until it succeeds.
    //   2. Broker died during the handshake (e.g. Relaycast unreachable) —
    //      the in-flight fetch sees the socket drop as `TypeError: fetch
    //      failed`, which is uninformative on its own.
    //
    // We race each `getSession()` against `brokerExited` so case (2) reports
    // as the actual broker exit (with its stderr tail and exit code), not as
    // a mystery network error. No backoff for the death case — we know it
    // immediately. 503 polling stays simple at 1s intervals.
    const brokerExited = new Promise<never>((_, reject) => {
      child.once('exit', (code) => {
        reject(
          new Error(
            formatBrokerStartupError(
              `Broker process exited with code ${code} during initial handshake`,
              child,
              { binaryPath, args, cwd, stdoutLines, stderrLines }
            )
          )
        );
      });
    });
    // Suppress unhandledRejection if the race is won by getSession before
    // the broker exits later (e.g. on normal shutdown).
    brokerExited.catch(() => {});

    onStep?.('Waiting for broker session handshake...');
    let session: SessionInfo | undefined;
    // The Relaycast handshake can take many seconds on a cold or slow network,
    // during which the startup-only API answers 503. Poll for the full startup
    // budget (`timeoutMs`) rather than a fixed attempt count so a slow-but-
    // healthy handshake isn't misreported as a spawn failure. The `brokerExited`
    // race still surfaces a dead broker immediately, so this only extends how
    // long we wait on a broker that is alive and warming up.
    const handshakeDeadline = Date.now() + timeoutMs;
    for (let attempt = 0; ; attempt++) {
      try {
        session = await Promise.race([client.getSession(), brokerExited]);
        break;
      } catch (err) {
        // The broker's startup-only API returns a structured 503
        // (`http_503`) while it warms up. Prefer the typed fields over the
        // formatted message, which the broker is free to customize.
        const is503 =
          err instanceof HarnessDriverProtocolError
            ? err.status === 503 || err.code === 'http_503'
            : /503|Service Unavailable/.test(err instanceof Error ? err.message : String(err));
        if (!is503 || Date.now() >= handshakeDeadline) throw err;
        onStep?.(`Broker still starting (handshake attempt ${attempt + 1}), retrying in 1s...`);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    onStep?.(`Broker handshake complete (workspace: ${session?.workspace_key ?? 'unknown'})`);

    if (!client.brokerExitInfo) {
      client.connectEvents();
      onStep?.('Event stream connected.');

      // Renew the owner lease so the broker doesn't auto-shutdown
      client.leaseTimer = setInterval(() => {
        client.renewLease().catch(() => {});
      }, 60_000);
    }

    return client;
  }

  /** PID of the managed broker process, if spawned locally. */
  get brokerPid(): number | undefined {
    return this.child?.pid;
  }

  // ── Session ────────────────────────────────────────────────────────

  async getSession(): Promise<SessionInfo> {
    const session = await this.transport.request<SessionInfo>('/api/session');
    this.workspaceKey = session.workspace_key;
    return session;
  }

  async healthCheck(): Promise<{ service: string }> {
    return this.transport.request<{ service: string }>('/health');
  }

  // ── Events ─────────────────────────────────────────────────────────

  connectEvents(sinceSeq?: number): void {
    this.transport.connect(sinceSeq);
  }

  disconnectEvents(): void {
    this.transport.disconnect();
  }

  onEvent(listener: (event: BrokerEvent) => void): () => void {
    return this.transport.onEvent(listener);
  }

  /**
   * Subscribe to managed broker child-process exit.
   *
   * Clients created with `new HarnessDriverClient(...)` or `connect()` do not own a
   * broker child process, so this is a no-op for them.
   */
  onBrokerExit(listener: BrokerExitListener): () => void {
    if (!this.child && !this.brokerExitInfo) {
      return () => {};
    }

    this.brokerExitListeners.add(listener);

    if (this.brokerExitInfo) {
      const info = cloneBrokerExitInfo(this.brokerExitInfo);
      queueMicrotask(() => {
        if (this.brokerExitListeners.has(listener)) {
          try {
            listener(info);
          } catch {
            // Listener failures should not interfere with SDK cleanup.
          }
        }
      });
    }

    return () => {
      this.brokerExitListeners.delete(listener);
    };
  }

  queryEvents(filter?: { kind?: string; name?: string; since?: number; limit?: number }): BrokerEvent[] {
    return this.transport.queryEvents(filter);
  }

  getLastEvent(kind: string, name?: string): BrokerEvent | undefined {
    return this.transport.getLastEvent(kind, name);
  }

  // ── Agent lifecycle ────────────────────────────────────────────────

  async spawnPty(input: SpawnPtyInput): Promise<SpawnedAgentHandle> {
    const beforeCtx: BeforeAgentSpawnContext<SpawnPtyInput> = {
      kind: 'pty',
      input,
      spawnerPid: process.pid,
      spawnStartTs: new Date().toISOString(),
      baseUrl: this.baseUrl,
    };
    const t0 = Date.now();
    const resolvedInput = await this.runBeforeSpawn(beforeCtx);
    try {
      const rawResult = await this.transport.request<unknown>('/api/spawn', {
        method: 'POST',
        body: JSON.stringify(buildSpawnPtyBody(resolvedInput)),
      });
      const result = SpawnAgentResultSchema.parse(rawResult);
      await this.emitAfterSpawn(beforeCtx, resolvedInput, t0, result, undefined);
      return new SpawnedAgentHandle(result, this);
    } catch (err) {
      await this.emitAfterSpawn(beforeCtx, resolvedInput, t0, undefined, err);
      throw err;
    }
  }

  async spawnCli(input: SpawnCliInput): Promise<SpawnedAgentHandle> {
    const beforeCtx: BeforeAgentSpawnContext<SpawnCliInput> = {
      kind: 'cli',
      input,
      spawnerPid: process.pid,
      spawnStartTs: new Date().toISOString(),
      baseUrl: this.baseUrl,
    };
    return this.spawnCliWithContext(beforeCtx, input);
  }

  private async spawnCliWithContext(
    beforeCtx: BeforeAgentSpawnContext<SpawnCliInput>,
    input: SpawnCliInput
  ): Promise<SpawnedAgentHandle> {
    const t0 = Date.now();
    const resolvedInput = await this.runBeforeSpawn(beforeCtx);
    const transport = resolveSpawnTransport(resolvedInput);
    if (
      transport === 'headless' &&
      !isBundledHeadlessCli(resolvedInput.cli) &&
      !resolvedInput.harnessConfig
    ) {
      throw new Error(
        `cli '${resolvedInput.cli}' does not support headless transport (supported: claude, opencode)`
      );
    }

    try {
      const rawResult = await this.transport.request<unknown>('/api/spawn', {
        method: 'POST',
        body: JSON.stringify(buildSpawnCliBody(resolvedInput, transport)),
      });
      const result = SpawnAgentResultSchema.parse(rawResult);
      await this.emitAfterSpawn(beforeCtx, resolvedInput, t0, result, undefined);
      return new SpawnedAgentHandle(result, this);
    } catch (err) {
      await this.emitAfterSpawn(beforeCtx, resolvedInput, t0, undefined, err);
      throw err;
    }
  }

  async spawnHeadless(input: SpawnHeadlessInput): Promise<SpawnedAgentHandle> {
    const cliInput: SpawnCliInput = { ...input, transport: 'headless' };
    const beforeCtx: BeforeAgentSpawnContext<SpawnCliInput> = {
      kind: 'headless',
      input: cliInput,
      spawnerPid: process.pid,
      spawnStartTs: new Date().toISOString(),
      baseUrl: this.baseUrl,
    };
    return this.spawnCliWithContext(beforeCtx, cliInput);
  }

  async spawnClaude(input: Omit<SpawnCliInput, 'cli'>): Promise<SpawnedAgentHandle> {
    return this.spawnCli({ ...input, cli: 'claude' });
  }

  async spawnOpencode(input: Omit<SpawnCliInput, 'cli'>): Promise<SpawnedAgentHandle> {
    return this.spawnCli({ ...input, cli: 'opencode' });
  }

  async release(name: string, reason?: string): Promise<{ name: string }> {
    const beforeCtx: BeforeAgentReleaseContext = { name, reason, baseUrl: this.baseUrl };
    const t0 = Date.now();
    await this.eventBus.emit('beforeAgentRelease', beforeCtx);
    try {
      const result = await this.transport.request<{ name: string }>(
        `/api/spawned/${encodeURIComponent(name)}`,
        {
          method: 'DELETE',
          ...(reason ? { body: JSON.stringify({ reason }) } : {}),
        }
      );
      const afterCtx: AfterAgentReleaseContext = {
        ...beforeCtx,
        durationMs: Date.now() - t0,
      };
      await this.eventBus.emit('afterAgentRelease', afterCtx);
      return result;
    } catch (err) {
      const afterCtx: AfterAgentReleaseContext = {
        ...beforeCtx,
        error: err instanceof Error ? err : new Error(String(err)),
        durationMs: Date.now() - t0,
      };
      await this.eventBus.emit('afterAgentRelease', afterCtx);
      throw err;
    }
  }

  private async emitAfterSpawn(
    beforeCtx: BeforeAgentSpawnContext,
    resolvedInput: SpawnPtyInput | SpawnCliInput,
    startMs: number,
    result: SpawnAgentResult | undefined,
    error: unknown
  ): Promise<void> {
    const afterCtx: AfterAgentSpawnContext = {
      ...beforeCtx,
      resolvedInput,
      ...(result ? { result } : {}),
      ...(error !== undefined ? { error: error instanceof Error ? error : new Error(String(error)) } : {}),
      durationMs: Date.now() - startMs,
    };
    await this.eventBus.emit('afterAgentSpawn', afterCtx);
  }

  async listAgents(): Promise<ListAgent[]> {
    const result = await this.transport.request<{ agents: ListAgent[] }>('/api/spawned');
    return result.agents;
  }

  // ── PTY control ────────────────────────────────────────────────────

  async sendInput(name: string, data: string): Promise<{ name: string; bytes_written: number }> {
    return this.transport.request(`/api/input/${encodeURIComponent(name)}`, {
      method: 'POST',
      body: JSON.stringify({ data }),
    });
  }

  openInputStream(name: string, options?: PtyInputStreamOptions): PtyInputStream {
    return this.transport.openInputStream(name, options);
  }

  /**
   * Resize a worker's PTY.
   *
   * Under the broker's single-resizer policy (#1247) an attach client should
   * pass a stable `sessionId` so only one client owns the shared PTY size at a
   * time; on detach it sends `release: true` to hand ownership back. Calls
   * without `sessionId` are always applied (legacy behaviour), so the extra
   * options are fully backward compatible.
   *
   * `rows`/`cols` are optional so a pure ownership release (`release: true`)
   * can omit them entirely rather than sending placeholder dimensions — the
   * broker defaults them to zero and skips the resize on such a release.
   *
   * A release MAY still carry dimensions, in which case the broker applies
   * them and *then* drops ownership. Attach clients that reserved a status row
   * use this to hand the row back atomically: a separate resize would need to
   * land strictly before the release or it re-claims the lease (#1247).
   * `resized` reports whether the broker *dispatched* the restore resize to the
   * worker — unlike `write_pty` it parks no pending request, so this is not a
   * worker-side acknowledgement.
   */
  async resizePty(
    name: string,
    rows?: number,
    cols?: number,
    options?: { sessionId?: string; release?: boolean }
  ): Promise<{
    name: string;
    rows?: number;
    cols?: number;
    applied?: boolean;
    released?: boolean;
    resized?: boolean;
  }> {
    return this.transport.request(`/api/resize/${encodeURIComponent(name)}`, {
      method: 'POST',
      body: JSON.stringify({
        ...(rows !== undefined ? { rows } : {}),
        ...(cols !== undefined ? { cols } : {}),
        ...(options?.sessionId ? { session_id: options.sessionId } : {}),
        ...(options?.release ? { release: true } : {}),
      }),
    });
  }

  async getInboundDeliveryMode(name: string): Promise<InboundDeliveryMode> {
    const result = await this.transport.request<{ mode?: unknown }>(
      `/api/spawned/${encodeURIComponent(name)}/delivery-mode`
    );
    if (result.mode !== 'auto_inject' && result.mode !== 'manual_flush') {
      throw new HarnessDriverProtocolError({
        code: 'invalid_response',
        message: "inbound delivery mode response missing valid 'mode'",
      });
    }
    return result.mode;
  }

  async setInboundDeliveryMode(
    name: string,
    mode: InboundDeliveryMode,
    options?: SetInboundDeliveryModeOptions
  ): Promise<SetInboundDeliveryModeResult> {
    const body: {
      mode: InboundDeliveryMode;
      expected_mode?: InboundDeliveryMode;
      expected_revision?: string;
    } = { mode };
    if (options?.expectedMode !== undefined) {
      body.expected_mode = options.expectedMode;
    }
    if (options?.expectedRevision !== undefined) {
      body.expected_revision = options.expectedRevision;
    }
    const result = await this.transport.request<{
      mode?: unknown;
      flushed?: unknown;
      matched?: unknown;
      revision?: unknown;
    }>(`/api/spawned/${encodeURIComponent(name)}/delivery-mode`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
    if (result.mode !== 'auto_inject' && result.mode !== 'manual_flush') {
      throw new HarnessDriverProtocolError({
        code: 'invalid_response',
        message: "set inbound delivery mode response missing valid 'mode'",
      });
    }
    return {
      mode: result.mode,
      flushed: typeof result.flushed === 'number' ? result.flushed : 0,
      // A guarded call must fail closed when a legacy broker omits `matched`.
      matched:
        typeof result.matched === 'boolean'
          ? result.matched
          : options?.expectedMode === undefined && options?.expectedRevision === undefined,
      revision: typeof result.revision === 'string' && /^\d+$/.test(result.revision) ? result.revision : null,
    };
  }

  async getPending(name: string): Promise<PendingRelayMessage[]> {
    const result = await this.transport.request<{ pending?: unknown }>(
      `/api/spawned/${encodeURIComponent(name)}/pending`
    );
    return Array.isArray(result.pending) ? (result.pending as PendingRelayMessage[]) : [];
  }

  async flushPending(name: string): Promise<{ flushed: number }> {
    const result = await this.transport.request<{ flushed?: unknown }>(
      `/api/spawned/${encodeURIComponent(name)}/flush`,
      { method: 'POST' }
    );
    return { flushed: typeof result.flushed === 'number' ? result.flushed : 0 };
  }

  async snapshot(name: string, format: SnapshotFormat = 'plain'): Promise<PtySnapshot> {
    return this.transport.request<PtySnapshot>(
      `/api/spawned/${encodeURIComponent(name)}/snapshot?format=${encodeURIComponent(format)}`
    );
  }

  async getAgentEventHistory(name: string, sinceSequence = 0): Promise<AgentEventHistoryResponse> {
    return this.transport.request<AgentEventHistoryResponse>(
      `/api/spawned/${encodeURIComponent(name)}/agent-events/history?sinceSequence=${encodeURIComponent(String(sinceSequence))}`
    );
  }

  async sendNativeHarnessCommand(
    name: string,
    command: Omit<NativeHarnessCommand, 'protocol_version'>
  ): Promise<NativeHarnessCommandAck> {
    return this.transport.request<NativeHarnessCommandAck>(
      `/api/spawned/${encodeURIComponent(name)}/native-harness/command`,
      {
        method: 'POST',
        body: JSON.stringify({ protocol_version: 1, ...command }),
      }
    );
  }

  subscribeAgentEvents(
    name: string,
    options: AgentEventSubscriptionOptions = {}
  ): AsyncIterable<AgentEventEnvelope> {
    this.connectEvents(options.sinceBrokerSeq);
    const maxQueueSize = normalizeMaxQueueSize(options.maxQueueSize);
    let highWater = options.sinceSequence ?? 0;
    return {
      [Symbol.asyncIterator]: () => {
        const queue: AgentEventEnvelope[] = [];
        let pending:
          | {
              resolve: (result: IteratorResult<AgentEventEnvelope>) => void;
              reject: (error: unknown) => void;
            }
          | undefined;
        let done = false;
        let failure: Error | undefined;
        const unsubscribe = this.onEvent((event) => {
          if (event.kind !== 'agent_event' || event.name !== name || event.sequence <= highWater) return;
          highWater = event.sequence;
          if (pending) {
            const { resolve } = pending;
            pending = undefined;
            resolve({ done: false, value: event });
            return;
          }
          if (queue.length >= maxQueueSize) {
            failure = new Error(
              `agent event subscription for ${JSON.stringify(name)} exceeded ${maxQueueSize} buffered events; reconnect with the last processed sequence`
            );
            queue.length = 0;
            done = true;
            unsubscribe();
            return;
          }
          queue.push(event);
        });
        const close = (): IteratorResult<AgentEventEnvelope> => {
          done = true;
          unsubscribe();
          pending?.resolve({ done: true, value: undefined as never });
          pending = undefined;
          return { done: true, value: undefined as never };
        };
        return {
          next: () => {
            const value = queue.shift();
            if (value) return Promise.resolve({ done: false, value });
            if (failure) return Promise.reject(failure);
            if (done) return Promise.resolve({ done: true, value: undefined as never });
            return new Promise<IteratorResult<AgentEventEnvelope>>((resolve, reject) => {
              pending = { resolve, reject };
            });
          },
          return: () => Promise.resolve(close()),
          throw: (error?: unknown) => {
            done = true;
            unsubscribe();
            pending?.reject(error);
            pending = undefined;
            return Promise.reject(error);
          },
          [Symbol.asyncIterator]() {
            return this;
          },
        };
      },
    };
  }

  /**
   * Current durable-event sequence number. An attaching client uses this as
   * the `sinceSeq` cutoff when opening the live event WS so the broker does
   * not replay historical durable events (e.g. old `delivery_queued`
   * frames) that would otherwise inflate a freshly-seeded pending counter.
   *
   * Requests with `sinceSeq` set beyond everything retained so the response
   * carries only the cutoff, not a payload of replayed events. Returns `0`
   * on brokers that predate the `currentSeq` field.
   */
  async currentEventSeq(): Promise<number> {
    const body = await this.transport.request<{ currentSeq?: number }>(
      `/api/events/replay?sinceSeq=${Number.MAX_SAFE_INTEGER}`
    );
    return typeof body.currentSeq === 'number' ? body.currentSeq : 0;
  }

  /**
   * Subscribe to live `worker_stream` chunks for a worker as an async
   * iterable of strings.
   *
   * Backpressure policy: each iterator buffers chunks the caller hasn't
   * consumed yet, bounded by `options.maxQueueSize` (default 10000). Once
   * the buffer is full, the oldest buffered chunk is dropped to make room
   * for the newest one and a single warning is logged — a slow or paused
   * consumer trades completeness for bounded memory rather than growing
   * without limit.
   *
   * @param name - The worker's name.
   * @param options - Stream filter, replay cutoff, and queue size.
   * @returns An async iterable yielding stream chunks.
   */
  subscribeWorkerStream(name: string, options: WorkerStreamSubscriptionOptions = {}): AsyncIterable<string> {
    this.connectEvents(options.sinceSeq);
    const maxQueueSize = normalizeMaxQueueSize(options.maxQueueSize);
    let didWarnQueueOverflow = false;

    return {
      [Symbol.asyncIterator]: () => {
        // Ring-style buffer: `queue` is the backing array and `head` is the
        // index of the oldest live chunk. Dropping or consuming the oldest
        // chunk advances `head` (O(1)) instead of `Array.prototype.shift()`
        // (O(n)) — under sustained overload at the cap every chunk would
        // otherwise pay an O(n) memmove. The dead prefix is reclaimed by
        // `compactQueue` amortized O(1).
        const queue: string[] = [];
        let head = 0;
        let pending:
          | {
              resolve: (result: IteratorResult<string>) => void;
              reject: (error: unknown) => void;
            }
          | undefined;
        let done = false;

        const compactQueue = (): void => {
          if (head === 0) {
            return;
          }
          if (head >= queue.length) {
            // Fully drained — reset so the backing array is reused from the
            // front rather than growing without bound.
            queue.length = 0;
            head = 0;
            return;
          }
          // Only pay the O(n) splice once the dead prefix has grown to at
          // least half the backing array (past a small floor), keeping the
          // per-chunk cost amortized O(1).
          if (head >= 32 && head * 2 >= queue.length) {
            queue.splice(0, head);
            head = 0;
          }
        };

        const unsubscribe = this.onEvent((event) => {
          if (
            event.kind !== 'worker_stream' ||
            event.name !== name ||
            (options.stream !== undefined && event.stream !== options.stream)
          ) {
            return;
          }
          if (pending) {
            const { resolve } = pending;
            pending = undefined;
            resolve({ done: false, value: event.chunk });
            return;
          }
          // Drop-oldest: a consumer that isn't pulling fast enough trades
          // completeness for bounded memory rather than buffering forever.
          if (queue.length - head >= maxQueueSize) {
            queue[head] = undefined as unknown as string; // release reference
            head += 1;
            compactQueue();
            if (!didWarnQueueOverflow) {
              didWarnQueueOverflow = true;
              console.error(
                `[agent-relay] subscribeWorkerStream(${JSON.stringify(name)}) queue exceeded ${maxQueueSize} buffered chunks; dropping oldest chunks. The consumer is not reading fast enough.`
              );
            }
          }
          queue.push(event.chunk);
        });

        const close = (): IteratorResult<string> => {
          done = true;
          unsubscribe();
          if (pending) {
            const { resolve } = pending;
            pending = undefined;
            resolve({ done: true, value: undefined as never });
          }
          return { done: true, value: undefined as never };
        };

        return {
          next(): Promise<IteratorResult<string>> {
            if (queue.length - head > 0) {
              const value = queue[head];
              queue[head] = undefined as unknown as string; // release reference
              head += 1;
              compactQueue();
              return Promise.resolve({ done: false, value });
            }
            if (done) {
              return Promise.resolve({ done: true, value: undefined as never });
            }
            return new Promise<IteratorResult<string>>((resolve, reject) => {
              pending = { resolve, reject };
            });
          },
          return(): Promise<IteratorResult<string>> {
            return Promise.resolve(close());
          },
          throw(error?: unknown): Promise<IteratorResult<string>> {
            done = true;
            unsubscribe();
            if (pending) {
              const { reject } = pending;
              pending = undefined;
              reject(error);
            }
            return Promise.reject(error);
          },
          [Symbol.asyncIterator]() {
            return this;
          },
        };
      },
    };
  }

  // ── Messaging ──────────────────────────────────────────────────────

  async sendMessage(input: SendMessageInput): Promise<{ event_id: string; targets: string[] }> {
    try {
      return await this.transport.request('/api/send', {
        method: 'POST',
        body: JSON.stringify({
          to: input.to,
          text: input.text,
          from: input.from,
          threadId: input.threadId,
          workspaceId: input.workspaceId,
          workspaceAlias: input.workspaceAlias,
          priority: input.priority,
          data: input.data,
          mode: input.mode,
        }),
      });
    } catch (error) {
      if (error instanceof HarnessDriverProtocolError && error.code === 'unsupported_operation') {
        return { event_id: 'unsupported_operation', targets: [] };
      }
      throw error;
    }
  }

  // ── Model control ──────────────────────────────────────────────────

  async setModel(
    name: string,
    model: string,
    opts?: { timeoutMs?: number }
  ): Promise<{ name: string; model: string; success: boolean }> {
    return this.transport.request(`/api/spawned/${encodeURIComponent(name)}/model`, {
      method: 'POST',
      body: JSON.stringify({ model, timeout_ms: opts?.timeoutMs }),
    });
  }

  // ── Channels ───────────────────────────────────────────────────────

  async subscribeChannels(name: string, channels: string[]): Promise<void> {
    await this.transport.request(`/api/spawned/${encodeURIComponent(name)}/subscribe`, {
      method: 'POST',
      body: JSON.stringify({ channels }),
    });
  }

  async unsubscribeChannels(name: string, channels: string[]): Promise<void> {
    await this.transport.request(`/api/spawned/${encodeURIComponent(name)}/unsubscribe`, {
      method: 'POST',
      body: JSON.stringify({ channels }),
    });
  }

  // ── Observability ──────────────────────────────────────────────────

  async getMetrics(agent?: string): Promise<{
    agents: Array<{ name: string; pid: number; memory_bytes: number; uptime_secs: number }>;
    broker?: BrokerStats;
  }> {
    const query = agent ? `?agent=${encodeURIComponent(agent)}` : '';
    return this.transport.request(`/api/metrics${query}`);
  }

  async getStatus(): Promise<BrokerStatus> {
    return this.transport.request<BrokerStatus>('/api/status');
  }

  async getCrashInsights(): Promise<CrashInsightsResponse> {
    return this.transport.request('/api/crash-insights');
  }

  /** List terminally-failed deliveries retained in the broker's dead-letter queue. */
  async getDeadLetters(): Promise<DeadLettersResponse> {
    return this.transport.request('/api/dead-letters');
  }

  /**
   * Requeue dead-letter entries through the normal delivery path with a
   * reset retry count. Pass an id for a single entry, or `{ all: true }`
   * for every entry whose recipient is currently running.
   */
  async redeliverDeadLetters(
    input: { id: string; all?: never } | { id?: never; all: true }
  ): Promise<RedeliverDeadLettersResponse> {
    return this.transport.request('/api/dead-letters/redeliver', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  async preflight(agents: Array<{ name: string; cli: string }>): Promise<{ queued: number }> {
    return this.transport.request('/api/preflight', {
      method: 'POST',
      body: JSON.stringify({ agents }),
    });
  }

  async renewLease(): Promise<{ renewed: boolean; expires_in_secs: number }> {
    return this.transport.request('/api/session/renew', { method: 'POST' });
  }

  /**
   * Shut down and clean up.
   * - For spawned brokers (via .spawn()): sends POST /api/shutdown to kill the broker, waits for exit.
   * - For connected brokers (via .connect() or constructor): just disconnects the transport.
   *   Does NOT kill the broker — the caller doesn't own it.
   */
  async shutdown(): Promise<void> {
    if (this.leaseTimer) {
      clearInterval(this.leaseTimer);
      this.leaseTimer = null;
    }

    // Only send the shutdown command if we own the broker process
    if (this.child) {
      try {
        await this.transport.request('/api/shutdown', { method: 'POST' });
      } catch {
        // Broker may already be dead
      }
    }

    this.transport.disconnect();

    if (this.child) {
      await waitForExit(this.child, 5000);
      this.child = null;
    }
  }

  /** Disconnect without shutting down the broker. Alias for cases where the intent is clear. */
  disconnect(): void {
    if (this.leaseTimer) {
      clearInterval(this.leaseTimer);
      this.leaseTimer = null;
    }
    this.transport.disconnect();
  }

  async getConfig(): Promise<{ workspaceKey?: string }> {
    return this.transport.request('/api/config');
  }

  private notifyBrokerExit(info: BrokerExitInfo): void {
    if (this.brokerExitInfo) return;

    this.brokerExitInfo = cloneBrokerExitInfo(info);
    for (const listener of this.brokerExitListeners) {
      try {
        listener(cloneBrokerExitInfo(info));
      } catch {
        // Listener failures should not interfere with SDK cleanup.
      }
    }
  }

  private installManagedBrokerExitHandler(child: ChildProcess, stderrLines: string[]): void {
    const handleExit = (code: number | null, signal: NodeJS.Signals | null) => {
      this.notifyBrokerExit({
        code,
        signal,
        pid: child.pid,
        recentStderr: [...stderrLines],
      });
      this.disconnectEvents();
      if (this.leaseTimer) {
        clearInterval(this.leaseTimer);
        this.leaseTimer = null;
      }
      if (this.child === child) {
        this.child = null;
      }
    };

    if (child.exitCode !== null || child.signalCode !== null) {
      handleExit(child.exitCode, child.signalCode);
      return;
    }

    child.once('exit', handleExit);
  }
}

/** @internal Test-only hooks; not part of the public SDK API. */
export const __clientTestInternals = {
  drainBrokerStdioAfterStartup,
};
