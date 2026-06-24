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
  PendingRelayMessage,
  PtySnapshot,
  InboundDeliveryMode,
  SnapshotFormat,
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

export const SpawnAgentResultSchema = z
  .object({
    success: z.boolean().optional(),
    name: z.string(),
    runtime: z.enum(['pty', 'headless']),
    model: z.string().nullable().optional(),
    pid: optionalNumber,
    pre_registered: z.boolean().optional(),
    warning: z.string().nullable().optional(),
    sessionId: optionalString,
  })
  .passthrough();

export interface SessionInfo {
  broker_version: string;
  protocol_version: number;
  workspace_key?: string;
  relay_base_url?: string;
  default_workspace_id?: string;
  mode: string;
  uptime_secs: number;
}

export interface SetInboundDeliveryModeResult {
  mode: InboundDeliveryMode;
  flushed: number;
}

export interface WorkerStreamSubscriptionOptions {
  /** Filter by stream name, for example `stdout` or `stderr`. Defaults to all streams. */
  stream?: string;
  /** Sequence offset to pass to the broker event stream when connecting. */
  sinceSeq?: number;
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
    let binaryPath = options?.binaryPath;
    if (!binaryPath) {
      const resolved = getBrokerBinaryPath();
      if (!resolved) {
        throw new Error(formatBrokerNotFoundError());
      }
      binaryPath = resolved;
    }
    const apiKey = `br_${randomBytes(16).toString('hex')}`;
    const { cwd, timeoutMs, args, env } = buildBrokerSpawnConfig(options, apiKey);
    const stderrLines: string[] = [];
    const stdoutLines: string[] = [];

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

    let session: SessionInfo | undefined;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        session = await Promise.race([client.getSession(), brokerExited]);
        break;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const is503 = message.includes('503') || message.includes('Service Unavailable');
        if (!is503 || attempt >= 9) throw err;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    if (!client.brokerExitInfo) {
      client.connectEvents();

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

  async resizePty(
    name: string,
    rows: number,
    cols: number
  ): Promise<{ name: string; rows: number; cols: number }> {
    return this.transport.request(`/api/resize/${encodeURIComponent(name)}`, {
      method: 'POST',
      body: JSON.stringify({ rows, cols }),
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
    mode: InboundDeliveryMode
  ): Promise<SetInboundDeliveryModeResult> {
    const result = await this.transport.request<{ mode?: unknown; flushed?: unknown }>(
      `/api/spawned/${encodeURIComponent(name)}/delivery-mode`,
      {
        method: 'PUT',
        body: JSON.stringify({ mode }),
      }
    );
    if (result.mode !== 'auto_inject' && result.mode !== 'manual_flush') {
      throw new HarnessDriverProtocolError({
        code: 'invalid_response',
        message: "set inbound delivery mode response missing valid 'mode'",
      });
    }
    return {
      mode: result.mode,
      flushed: typeof result.flushed === 'number' ? result.flushed : 0,
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

  subscribeWorkerStream(name: string, options: WorkerStreamSubscriptionOptions = {}): AsyncIterable<string> {
    this.connectEvents(options.sinceSeq);

    return {
      [Symbol.asyncIterator]: () => {
        const queue: string[] = [];
        let pending:
          | {
              resolve: (result: IteratorResult<string>) => void;
              reject: (error: unknown) => void;
            }
          | undefined;
        let done = false;

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
            if (queue.length > 0) {
              return Promise.resolve({ done: false, value: queue.shift() as string });
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
