/**
 * High-level facade for the Agent Relay SDK.
 *
 * Provides a clean, property-based API on top of the lower-level
 * {@link AgentRelayClient} protocol client.
 *
 * @example
 * ```ts
 * import { AgentRelay } from "@agent-relay/sdk";
 *
 * const relay = new AgentRelay();
 *
 * relay.onMessageReceived = (message) => console.log(message);
 * relay.onAgentSpawned = (agent) => console.log("spawned", agent.name);
 *
 * const codex = await relay.codex.spawn();
 * const human = relay.human({ name: "System" });
 * await human.sendMessage({ to: codex.name, text: "Hello!" });
 *
 * const agents = await relay.listAgents();
 * for (const a of agents) await a.release();
 * await relay.shutdown();
 * ```
 */

import { randomBytes } from 'node:crypto';
import path from 'node:path';

import {
  AgentRelayClient,
  AgentRelayProtocolError,
  type AgentRelayClientOptions,
  type SendMessageInput,
  type SpawnPtyInput,
} from './client.js';
import type { AgentRuntime, BrokerEvent, BrokerStatus, RestartPolicy } from './protocol.js';
import {
  followLogs as followLogsFromFile,
  getLogs as getLogsFromFile,
  listLoggedAgents as listLoggedAgentsFromFile,
  type FollowLogsOptions,
  type LogFollowHandle,
  type LogsResult,
} from './logs.js';

function isUnsupportedOperation(error: unknown): error is AgentRelayProtocolError {
  return error instanceof AgentRelayProtocolError && error.code === 'unsupported_operation';
}

function buildUnsupportedOperationMessage(
  from: string,
  input: { to: string; text: string; threadId?: string; data?: Record<string, unknown> }
): Message {
  return {
    eventId: 'unsupported_operation',
    from,
    to: input.to,
    text: input.text,
    threadId: input.threadId,
    data: input.data,
  };
}

// ── Public types ────────────────────────────────────────────────────────────

export interface Message {
  eventId: string;
  from: string;
  to: string;
  text: string;
  threadId?: string;
  data?: Record<string, unknown>;
}

export type AgentStatus = 'spawning' | 'ready' | 'idle' | 'exited';
export type DeliveryWaitStatus = 'ack' | 'failed' | 'timeout';
export type DeliveryStateStatus = 'queued' | 'injected' | 'active' | 'verified' | 'failed';
export interface DeliveryWaitResult {
  eventId: string;
  status: DeliveryWaitStatus;
  targets: string[];
}
export interface DeliveryState {
  eventId: string;
  to: string;
  status: DeliveryStateStatus;
  updatedAt: number;
}

export interface SpawnOptions {
  args?: string[];
  channels?: string[];
  model?: string;
  cwd?: string;
  team?: string;
  shadowOf?: string;
  shadowMode?: string;
  idleThresholdSecs?: number;
  restartPolicy?: RestartPolicy;
}

export interface SpawnAndWaitOptions extends SpawnOptions {
  timeoutMs?: number;
  waitForMessage?: boolean;
}

type AgentOutputPayload = { stream: string; chunk: string };
type AgentOutputCallback = ((chunk: string) => void) | ((data: AgentOutputPayload) => void);

export interface Agent {
  readonly name: string;
  readonly runtime: AgentRuntime;
  readonly channels: string[];
  /** Current lifecycle status of the agent. */
  readonly status: AgentStatus;
  /** Set when the agent exits. Available after `onAgentExited` fires. */
  exitCode?: number;
  /** Set when the agent exits via signal. Available after `onAgentExited` fires. */
  exitSignal?: string;
  /** Set when the agent requests exit via /exit. Available after `onAgentExitRequested` fires. */
  exitReason?: string;
  release(reason?: string): Promise<void>;
  waitForReady(timeoutMs?: number): Promise<void>;
  /** Wait for the agent process to exit on its own.
   *  @param timeoutMs — optional timeout in ms. Resolves with `"timeout"` if exceeded,
   *  `"exited"` if the agent exited naturally, or `"released"` if released externally. */
  waitForExit(timeoutMs?: number): Promise<'exited' | 'timeout' | 'released'>;
  /** Wait for the agent to go idle (no PTY output for the configured threshold).
   *  @param timeoutMs — optional timeout in ms. Resolves with `"idle"` when first idle event fires,
   *  `"timeout"` if timeoutMs elapses first, or `"exited"` if the agent exits. */
  waitForIdle(timeoutMs?: number): Promise<'idle' | 'timeout' | 'exited'>;
  sendMessage(input: {
    to: string;
    text: string;
    threadId?: string;
    priority?: number;
    data?: Record<string, unknown>;
  }): Promise<Message>;
  /** Register a callback for PTY output from this agent. Returns an unsubscribe function. */
  onOutput(callback: AgentOutputCallback): () => void;
}

export interface HumanHandle {
  readonly name: string;
  sendMessage(input: {
    to: string;
    text: string;
    threadId?: string;
    priority?: number;
    data?: Record<string, unknown>;
  }): Promise<Message>;
}

export interface AgentSpawner {
  spawn(options?: {
    name?: string;
    args?: string[];
    channels?: string[];
    task?: string;
    model?: string;
    cwd?: string;
  }): Promise<Agent>;
}

export type EventHook<T> = ((value: T) => void) | null;

export interface AgentRelayOptions {
  binaryPath?: string;
  binaryArgs?: string[];
  brokerName?: string;
  channels?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  /**
   * Name for the auto-created Relaycast workspace.
   * If omitted, a random name is generated.
   * Ignored when RELAY_API_KEY is already set in env or process.env.
   */
  workspaceName?: string;
  /**
   * Base URL for the Relaycast API.
   * Defaults to RELAYCAST_BASE_URL env var or https://api.relaycast.dev.
   */
  relaycastBaseUrl?: string;
}

type OutputListener = {
  callback: AgentOutputCallback;
  mode: 'chunk' | 'structured';
};

// ── AgentRelay facade ───────────────────────────────────────────────────────

export class AgentRelay {
  // Event hooks — assign a callback or null to clear.
  onMessageReceived: EventHook<Message> = null;
  onMessageSent: EventHook<Message> = null;
  onAgentSpawned: EventHook<Agent> = null;
  onAgentReleased: EventHook<Agent> = null;
  onAgentExited: EventHook<Agent> = null;
  onAgentReady: EventHook<Agent> = null;
  onWorkerOutput: EventHook<{ name: string; stream: string; chunk: string }> = null;
  onDeliveryUpdate: EventHook<BrokerEvent> = null;
  onAgentExitRequested: EventHook<{ name: string; reason: string }> = null;
  onAgentIdle: EventHook<{ name: string; idleSecs: number }> = null;

  // ── Public accessors ────────────────────────────────────────────────────

  /** The resolved Relaycast workspace API key (available after first spawn). */
  get workspaceKey(): string | undefined {
    return this.relayApiKey;
  }

  /** Observer URL for the auto-created workspace (available after first spawn). */
  get observerUrl(): string | undefined {
    if (!this.relayApiKey) return undefined;
    return `https://observer.relaycast.dev/?key=${this.relayApiKey}`;
  }

  // Shorthand spawners
  readonly codex: AgentSpawner;
  readonly claude: AgentSpawner;
  readonly gemini: AgentSpawner;

  private readonly clientOptions: AgentRelayClientOptions;
  private readonly defaultChannels: string[];
  private readonly workspaceName?: string;
  private readonly relaycastBaseUrl?: string;
  private relayApiKey?: string;
  private client?: AgentRelayClient;
  private startPromise?: Promise<AgentRelayClient>;
  private unsubEvent?: () => void;
  private readonly knownAgents = new Map<string, Agent>();
  private readonly readyAgents = new Set<string>();
  private readonly messageReadyAgents = new Set<string>();
  private readonly exitedAgents = new Set<string>();
  private readonly idleAgents = new Set<string>();
  private readonly deliveryStates = new Map<string, DeliveryState>();
  private readonly outputListeners = new Map<string, Set<OutputListener>>();
  private readonly exitResolvers = new Map<
    string,
    { resolve: (reason: 'exited' | 'released') => void; token: number }
  >();
  private exitResolverSeq = 0;
  private readonly idleResolvers = new Map<
    string,
    { resolve: (reason: 'idle' | 'timeout' | 'exited') => void; token: number }
  >();
  private idleResolverSeq = 0;

  constructor(options: AgentRelayOptions = {}) {
    this.defaultChannels = options.channels ?? ['general'];
    this.workspaceName = options.workspaceName;
    this.relaycastBaseUrl = options.relaycastBaseUrl;
    this.clientOptions = {
      binaryPath: options.binaryPath,
      binaryArgs: options.binaryArgs,
      brokerName: options.brokerName,
      channels: this.defaultChannels,
      cwd: options.cwd,
      env: options.env,
      requestTimeoutMs: options.requestTimeoutMs,
      shutdownTimeoutMs: options.shutdownTimeoutMs,
    };

    this.codex = this.createSpawner('codex', 'Codex', 'pty');
    this.claude = this.createSpawner('claude', 'Claude', 'pty');
    this.gemini = this.createSpawner('gemini', 'Gemini', 'pty');
  }

  /**
   * Subscribe to broker stderr output. Listener is wired immediately if the
   * client is already started, otherwise it is attached when the client starts.
   * Returns an unsubscribe function.
   */
  onBrokerStderr(listener: (line: string) => void): () => void {
    if (this.client) {
      return this.client.onBrokerStderr(listener);
    }
    // Queue it: once ensureStarted completes, wire it up
    let unsub: (() => void) | undefined;
    const queuedUnsub = () => {
      unsub?.();
    };
    // Use the start promise if one is pending
    const promise = this.startPromise ?? this.ensureStarted();
    promise
      .then((c) => {
        unsub = c.onBrokerStderr(listener);
      })
      .catch(() => {});
    return queuedUnsub;
  }

  // ── Spawning ────────────────────────────────────────────────────────────

  async spawnPty(input: SpawnPtyInput): Promise<Agent> {
    const client = await this.ensureStarted();
    if (!input.channels || input.channels.length === 0) {
      console.warn(
        `[AgentRelay] spawnPty("${input.name}"): no channels specified, defaulting to "general". ` +
          'Set explicit channels for workflow isolation.'
      );
    }
    const channels = input.channels ?? ['general'];
    const result = await client.spawnPty({
      name: input.name,
      cli: input.cli,
      args: input.args,
      channels,
      task: input.task,
      model: input.model,
      cwd: input.cwd,
      team: input.team,
      shadowOf: input.shadowOf,
      shadowMode: input.shadowMode,
      idleThresholdSecs: input.idleThresholdSecs,
      restartPolicy: input.restartPolicy,
    });
    this.readyAgents.delete(result.name);
    this.messageReadyAgents.delete(result.name);
    this.exitedAgents.delete(result.name);
    this.idleAgents.delete(result.name);
    const agent = this.makeAgent(result.name, result.runtime, channels);
    this.knownAgents.set(agent.name, agent);
    return agent;
  }

  async spawn(name: string, cli: string, task?: string, options?: SpawnOptions): Promise<Agent> {
    return this.spawnPty({
      name,
      cli,
      task,
      args: options?.args,
      channels: options?.channels,
      model: options?.model,
      cwd: options?.cwd,
      team: options?.team,
      shadowOf: options?.shadowOf,
      shadowMode: options?.shadowMode,
      idleThresholdSecs: options?.idleThresholdSecs,
      restartPolicy: options?.restartPolicy,
    });
  }

  async spawnAndWait(name: string, cli: string, task: string, options?: SpawnAndWaitOptions): Promise<Agent> {
    const { timeoutMs, waitForMessage, ...spawnOptions } = options ?? {};
    await this.spawn(name, cli, task, spawnOptions);
    if (waitForMessage) {
      return this.waitForAgentMessage(name, timeoutMs ?? 60_000);
    }
    return this.waitForAgentReady(name, timeoutMs ?? 30_000);
  }

  // ── Human source ────────────────────────────────────────────────────────

  human(opts: { name: string }): HumanHandle {
    return {
      name: opts.name,
      sendMessage: async (input) => {
        const client = await this.ensureStarted();
        let result: Awaited<ReturnType<typeof client.sendMessage>>;
        try {
          result = await client.sendMessage({
            to: input.to,
            text: input.text,
            from: opts.name,
            threadId: input.threadId,
            priority: input.priority,
            data: input.data,
          });
        } catch (error) {
          if (isUnsupportedOperation(error)) {
            return buildUnsupportedOperationMessage(opts.name, input);
          }
          throw error;
        }
        if (result?.event_id === 'unsupported_operation') {
          return buildUnsupportedOperationMessage(opts.name, input);
        }

        const eventId = result?.event_id ?? randomBytes(8).toString('hex');
        const msg: Message = {
          eventId,
          from: opts.name,
          to: input.to,
          text: input.text,
          threadId: input.threadId,
          data: input.data,
        };
        this.onMessageSent?.(msg);
        return msg;
      },
    };
  }

  system(): HumanHandle {
    return this.human({ name: 'system' });
  }

  // ── Messaging ─────────────────────────────────────────────────────────

  /**
   * Broadcast a message to all connected agents.
   * @param text — the message body
   * @param options — optional sender name (defaults to "human:orchestrator")
   */
  async broadcast(text: string, options?: { from?: string }): Promise<Message> {
    const from = options?.from ?? 'human:orchestrator';
    return this.human({ name: from }).sendMessage({ to: '*', text });
  }

  async sendAndWaitForDelivery(input: SendMessageInput, timeoutMs = 30_000): Promise<DeliveryWaitResult> {
    const client = await this.ensureStarted();
    const result = await client.sendMessage(input);

    if (!result.targets.length) {
      return { eventId: result.event_id, status: 'failed', targets: [] };
    }

    return new Promise<DeliveryWaitResult>((resolve) => {
      let resolved = false;
      const ackedTargets = new Set<string>();
      // eslint-disable-next-line prefer-const
      let unsubscribe: (() => void) | undefined;

      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          unsubscribe?.();
          resolve({ eventId: result.event_id, status: 'timeout', targets: result.targets });
        }
      }, timeoutMs);

      unsubscribe = client.onEvent((event) => {
        if (resolved) return;

        if (
          event.kind === 'delivery_ack' &&
          event.event_id === result.event_id &&
          result.targets.includes(event.name)
        ) {
          ackedTargets.add(event.name);
          if (ackedTargets.size >= result.targets.length) {
            resolved = true;
            clearTimeout(timer);
            unsubscribe?.();
            resolve({ eventId: result.event_id, status: 'ack', targets: result.targets });
          }
        }

        if (
          event.kind === 'delivery_failed' &&
          event.event_id === result.event_id &&
          result.targets.includes(event.name)
        ) {
          resolved = true;
          clearTimeout(timer);
          unsubscribe?.();
          resolve({ eventId: result.event_id, status: 'failed', targets: result.targets });
        }
      });
    });
  }

  // ── Listing ─────────────────────────────────────────────────────────────

  async listAgents(): Promise<Agent[]> {
    const client = await this.ensureStarted();
    const list = await client.listAgents();
    return list.map((entry) => {
      const existing = this.knownAgents.get(entry.name);
      if (existing) return existing;
      const agent = this.makeAgent(entry.name, entry.runtime, entry.channels);
      this.knownAgents.set(agent.name, agent);
      return agent;
    });
  }

  /** Pre-register a batch of agents with Relaycast before steps execute. */
  async preflightAgents(agents: Array<{ name: string; cli: string }>): Promise<void> {
    const client = await this.ensureStarted();
    await client.preflightAgents(agents);
  }

  /** List agents with PIDs from the broker (for worker registration). */
  async listAgentsRaw(): Promise<Array<{ name: string; pid?: number }>> {
    const client = await this.ensureStarted();
    return client.listAgents();
  }

  // ── Status ────────────────────────────────────────────────────────────

  async getStatus(): Promise<BrokerStatus> {
    const client = await this.ensureStarted();
    return client.getStatus();
  }

  getDeliveryState(eventId: string): DeliveryState | undefined {
    return this.deliveryStates.get(eventId);
  }

  // ── Logs ──────────────────────────────────────────────────────────────

  /**
   * Read the last N lines of an agent's log file.
   *
   * @example
   * ```ts
   * const logs = await relay.getLogs("Worker1", { lines: 100 });
   * if (logs.found) console.log(logs.content);
   * ```
   */
  async getLogs(agentName: string, options?: { lines?: number }): Promise<LogsResult> {
    const cwd = this.clientOptions.cwd ?? process.cwd();
    const logsDir = path.join(cwd, '.agent-relay', 'team', 'worker-logs');
    return getLogsFromFile(agentName, { logsDir, lines: options?.lines });
  }

  /** List all agents that have log files. */
  async listLoggedAgents(): Promise<string[]> {
    const cwd = this.clientOptions.cwd ?? process.cwd();
    const logsDir = path.join(cwd, '.agent-relay', 'team', 'worker-logs');
    return listLoggedAgentsFromFile(logsDir);
  }

  /**
   * Follow an agent's local log file with history bootstrap + incremental updates.
   *
   * @example
   * ```ts
   * const handle = relay.followLogs("Worker1", {
   *   historyLines: 100,
   *   onEvent(event) {
   *     if (event.type === "log") console.log(event.content);
   *   },
   * });
   *
   * // Later:
   * handle.unsubscribe();
   * ```
   */
  followLogs(agentName: string, options: Omit<FollowLogsOptions, 'logsDir'>): LogFollowHandle {
    const cwd = this.clientOptions.cwd ?? process.cwd();
    const logsDir = path.join(cwd, '.agent-relay', 'team', 'worker-logs');
    return followLogsFromFile(agentName, { ...options, logsDir });
  }

  // ── Wait helpers ──────────────────────────────────────────────────────

  /**
   * Wait for any one of the given agents to exit. Returns the first agent
   * that exits along with its exit reason.
   *
   * @example
   * ```ts
   * const { agent, result } = await AgentRelay.waitForAny([worker1, worker2], 60_000);
   * console.log(`${agent.name} finished: ${result}`);
   * ```
   */
  static async waitForAny(
    agents: Agent[],
    timeoutMs?: number
  ): Promise<{ agent: Agent; result: 'exited' | 'timeout' | 'released' }> {
    if (agents.length === 0) {
      throw new Error('waitForAny requires at least one agent');
    }
    return Promise.race(
      agents.map(async (agent) => {
        const result = await agent.waitForExit(timeoutMs);
        return { agent, result };
      })
    );
  }

  /**
   * Resolves when the agent process has started and connected to the broker.
   * The agent's CLI may not yet be ready to receive messages.
   * Use `waitForAgentMessage()` for full readiness.
   */
  async waitForAgentReady(name: string, timeoutMs = 30_000): Promise<Agent> {
    const client = await this.ensureStarted();
    const existing = this.knownAgents.get(name);
    if (existing && this.readyAgents.has(name)) {
      return existing;
    }

    return new Promise<Agent>((resolve, reject) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        unsubscribe();
        if (timeout) {
          clearTimeout(timeout);
          timeout = undefined;
        }
      };

      const resolveWith = (agent: Agent) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(agent);
      };

      const rejectWith = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };

      const unsubscribe = client.onEvent((event) => {
        if (event.kind !== 'worker_ready' || event.name !== name) {
          return;
        }
        const agent = this.ensureAgentHandle(event.name, event.runtime);
        this.readyAgents.add(event.name);
        this.exitedAgents.delete(event.name);
        resolveWith(agent);
      });

      timeout = setTimeout(() => {
        rejectWith(new Error(`Timed out waiting for worker_ready for '${name}' after ${timeoutMs}ms`));
      }, timeoutMs);

      const known = this.knownAgents.get(name);
      if (known && this.readyAgents.has(name)) {
        resolveWith(known);
      }
    });
  }

  async waitForAgentMessage(name: string, timeoutMs = 60_000): Promise<Agent> {
    const client = await this.ensureStarted();
    const existing = this.knownAgents.get(name);
    if (existing && this.messageReadyAgents.has(name)) {
      return existing;
    }

    return new Promise<Agent>((resolve, reject) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        unsubscribe();
        if (timeout) {
          clearTimeout(timeout);
          timeout = undefined;
        }
      };

      const resolveWith = (agent: Agent) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(agent);
      };

      const rejectWith = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };

      const unsubscribe = client.onEvent((event) => {
        if (event.kind === 'relay_inbound' && event.from === name) {
          this.messageReadyAgents.add(name);
          this.exitedAgents.delete(name);
          resolveWith(this.ensureAgentHandle(name));
          return;
        }
        if (event.kind === 'agent_exited' && event.name === name) {
          rejectWith(new Error(`Agent '${name}' exited before sending its first relay message`));
          return;
        }
        if (event.kind === 'agent_released' && event.name === name) {
          rejectWith(new Error(`Agent '${name}' was released before sending its first relay message`));
        }
      });

      timeout = setTimeout(() => {
        rejectWith(
          new Error(`Timed out waiting for first relay message from '${name}' after ${timeoutMs}ms`)
        );
      }, timeoutMs);

      const known = this.knownAgents.get(name);
      if (known && this.messageReadyAgents.has(name)) {
        resolveWith(known);
      }
    });
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  async shutdown(): Promise<void> {
    if (this.unsubEvent) {
      this.unsubEvent();
      this.unsubEvent = undefined;
    }
    if (this.client) {
      await this.client.shutdown();
      this.client = undefined;
    }
    this.knownAgents.clear();
    this.readyAgents.clear();
    this.messageReadyAgents.clear();
    this.exitedAgents.clear();
    this.idleAgents.clear();
    this.deliveryStates.clear();
    this.outputListeners.clear();
    for (const entry of this.exitResolvers.values()) {
      entry.resolve('released');
    }
    this.exitResolvers.clear();
    for (const entry of this.idleResolvers.values()) {
      entry.resolve('exited');
    }
    this.idleResolvers.clear();
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  private ensureAgentHandle(name: string, runtime: AgentRuntime = 'pty', channels: string[] = []): Agent {
    const existing = this.knownAgents.get(name);
    if (existing) {
      return existing;
    }
    const agent = this.makeAgent(name, runtime, channels);
    this.knownAgents.set(name, agent);
    return agent;
  }

  private updateDeliveryState(
    eventId: string,
    to: string,
    status: DeliveryStateStatus,
    updatedAt: number
  ): void {
    this.deliveryStates.set(eventId, { eventId, to, status, updatedAt });
  }

  private resolveEventTimestamp(candidate?: unknown): number {
    return typeof candidate === 'number' ? candidate : Date.now();
  }

  /** Resolve a target to a channel name. If `to` is `#channel`, use that
   *  channel. If it's a known agent name, use the agent's first channel.
   *  Otherwise fall back to the relay's default channel. */
  private resolveChannel(to: string): string {
    if (to.startsWith('#')) return to.slice(1);
    const agent = this.knownAgents.get(to);
    if (agent && agent.channels.length > 0) return agent.channels[0];
    return this.defaultChannels[0];
  }

  private inferOutputMode(callback: AgentOutputCallback): 'chunk' | 'structured' {
    const source = callback.toString().trim().replace(/\s+/g, ' ');
    if (source.startsWith('({') || source.startsWith('async ({') || source.startsWith('function ({')) {
      return 'structured';
    }
    return 'chunk';
  }

  private dispatchOutput(name: string, stream: string, chunk: string): void {
    const listeners = this.outputListeners.get(name);
    if (!listeners) return;
    for (const listener of listeners) {
      if (listener.mode === 'structured') {
        (listener.callback as (data: AgentOutputPayload) => void)({ stream, chunk });
      } else {
        (listener.callback as (chunk: string) => void)(chunk);
      }
    }
  }

  /**
   * Ensure a Relaycast workspace API key is available.
   * Resolution order:
   *   1. Already resolved (cached from a previous call)
   *   2. RELAY_API_KEY in options.env
   *   3. RELAY_API_KEY in process.env
   *   4. Auto-create a fresh workspace via the Relaycast REST API
   */
  private async ensureRelaycastApiKey(): Promise<void> {
    if (this.relayApiKey) return;

    const envKey = this.clientOptions.env?.RELAY_API_KEY ?? process.env.RELAY_API_KEY;
    if (envKey) {
      this.relayApiKey = envKey;
      // Ensure the broker subprocess inherits the full process env + the key.
      // Without this, spawning with an explicit binaryPath but no env option
      // would cause the broker to start with an empty environment (no PATH,
      // no RELAY_API_KEY), making connect_relay() hang and triggering the
      // hello-handshake timeout.
      if (!this.clientOptions.env) {
        this.clientOptions.env = { ...process.env, RELAY_API_KEY: envKey };
      } else if (!this.clientOptions.env.RELAY_API_KEY) {
        this.clientOptions.env.RELAY_API_KEY = envKey;
      }
      return;
    }

    // No API key in env — broker will create/select its own workspace.
    // Ensure the broker process inherits the full environment (PATH, etc.)
    // so it can connect to Relaycast. The actual workspace key will be
    // read from the broker's hello_ack response in ensureStarted().
    if (!this.clientOptions.env) {
      this.clientOptions.env = { ...process.env };
    }
  }

  private async ensureStarted(): Promise<AgentRelayClient> {
    if (this.client) return this.client;
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.ensureRelaycastApiKey()
      .then(() => AgentRelayClient.start(this.clientOptions))
      .then((c) => {
        this.client = c;
        this.startPromise = undefined;
        // Use the workspace key the broker actually connected with.
        // This ensures SDK and workers are always on the same workspace.
        if (c.workspaceKey) {
          this.relayApiKey = c.workspaceKey;
        }
        this.wireEvents(c);
        return c;
      })
      .catch((err) => {
        this.startPromise = undefined;
        throw err;
      });

    return this.startPromise;
  }

  private wireEvents(client: AgentRelayClient): void {
    // eslint-disable-next-line complexity
    this.unsubEvent = client.onEvent((event: BrokerEvent) => {
      switch (event.kind) {
        case 'relay_inbound': {
          if (this.knownAgents.has(event.from)) {
            this.messageReadyAgents.add(event.from);
            this.exitedAgents.delete(event.from);
          }
          const msg: Message = {
            eventId: event.event_id,
            from: event.from,
            to: event.target,
            text: event.body,
            threadId: event.thread_id,
          };
          this.onMessageReceived?.(msg);
          break;
        }
        case 'agent_spawned': {
          const agent = this.ensureAgentHandle(event.name, event.runtime);
          this.readyAgents.delete(event.name);
          this.messageReadyAgents.delete(event.name);
          this.exitedAgents.delete(event.name);
          this.idleAgents.delete(event.name);
          this.onAgentSpawned?.(agent);
          break;
        }
        case 'agent_released': {
          const agent = this.knownAgents.get(event.name) ?? this.ensureAgentHandle(event.name, 'pty', []);
          this.exitedAgents.add(event.name);
          this.readyAgents.delete(event.name);
          this.messageReadyAgents.delete(event.name);
          this.idleAgents.delete(event.name);
          this.onAgentReleased?.(agent);
          this.knownAgents.delete(event.name);
          this.outputListeners.delete(event.name);
          this.exitResolvers.get(event.name)?.resolve('released');
          this.exitResolvers.delete(event.name);
          this.idleResolvers.get(event.name)?.resolve('exited');
          this.idleResolvers.delete(event.name);
          break;
        }
        case 'agent_exited': {
          const agent = this.knownAgents.get(event.name) ?? this.ensureAgentHandle(event.name, 'pty', []);
          this.exitedAgents.add(event.name);
          this.readyAgents.delete(event.name);
          this.messageReadyAgents.delete(event.name);
          this.idleAgents.delete(event.name);
          // Populate exit info before firing the hook
          (agent as { exitCode?: number }).exitCode = event.code;
          (agent as { exitSignal?: string }).exitSignal = event.signal;
          this.onAgentExited?.(agent);
          this.knownAgents.delete(event.name);
          this.outputListeners.delete(event.name);
          this.exitResolvers.get(event.name)?.resolve('exited');
          this.exitResolvers.delete(event.name);
          this.idleResolvers.get(event.name)?.resolve('exited');
          this.idleResolvers.delete(event.name);
          break;
        }
        case 'agent_exit': {
          const agent = this.knownAgents.get(event.name) ?? this.ensureAgentHandle(event.name, 'pty', []);
          (agent as { exitReason?: string }).exitReason = event.reason;
          this.onAgentExitRequested?.({ name: event.name, reason: event.reason });
          break;
        }
        case 'worker_ready': {
          const agent = this.ensureAgentHandle(event.name, event.runtime);
          this.readyAgents.add(event.name);
          this.exitedAgents.delete(event.name);
          this.idleAgents.delete(event.name);
          this.onAgentReady?.(agent);
          break;
        }
        case 'delivery_queued': {
          this.updateDeliveryState(
            event.event_id,
            event.name,
            'queued',
            this.resolveEventTimestamp(event.timestamp)
          );
          break;
        }
        case 'delivery_injected': {
          this.updateDeliveryState(
            event.event_id,
            event.name,
            'injected',
            this.resolveEventTimestamp(event.timestamp)
          );
          break;
        }
        case 'delivery_active': {
          this.updateDeliveryState(event.event_id, event.name, 'active', this.resolveEventTimestamp());
          break;
        }
        case 'delivery_verified': {
          this.updateDeliveryState(event.event_id, event.name, 'verified', this.resolveEventTimestamp());
          break;
        }
        case 'delivery_failed': {
          this.updateDeliveryState(event.event_id, event.name, 'failed', this.resolveEventTimestamp());
          break;
        }
        case 'worker_stream': {
          // Agent producing output is no longer idle
          this.idleAgents.delete(event.name);
          this.onWorkerOutput?.({
            name: event.name,
            stream: event.stream,
            chunk: event.chunk,
          });
          // Dispatch to per-agent output listeners
          this.dispatchOutput(event.name, event.stream, event.chunk);
          break;
        }
        case 'agent_idle': {
          this.idleAgents.add(event.name);
          this.onAgentIdle?.({
            name: event.name,
            idleSecs: event.idle_secs,
          });
          // Resolve idle waiters
          this.idleResolvers.get(event.name)?.resolve('idle');
          this.idleResolvers.delete(event.name);
          break;
        }
      }
      if (event.kind.startsWith('delivery_')) {
        this.onDeliveryUpdate?.(event);
      }
    });
  }

  private makeAgent(name: string, runtime: AgentRuntime, channels: string[]): Agent {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const relay = this;
    return {
      name,
      runtime,
      channels,
      get status(): AgentStatus {
        if (relay.exitedAgents.has(name)) return 'exited';
        if (relay.idleAgents.has(name)) return 'idle';
        if (relay.readyAgents.has(name)) return 'ready';
        return 'spawning';
      },
      exitCode: undefined,
      exitSignal: undefined,
      async release(reason?: string) {
        const client = await relay.ensureStarted();
        await client.release(name, reason);
      },
      async waitForReady(timeoutMs = 30_000) {
        await relay.waitForAgentReady(name, timeoutMs);
      },
      waitForExit(timeoutMs?: number) {
        return new Promise<'exited' | 'timeout' | 'released'>((resolve) => {
          // If already gone, resolve immediately
          if (!relay.knownAgents.has(name)) {
            resolve('exited');
            return;
          }
          // Non-blocking poll: timeoutMs === 0 means "check now, return immediately"
          if (timeoutMs === 0) {
            resolve('timeout');
            return;
          }
          let timer: ReturnType<typeof setTimeout> | undefined;
          const token = ++relay.exitResolverSeq;
          relay.exitResolvers.set(name, {
            resolve(reason) {
              if (timer) clearTimeout(timer);
              resolve(reason);
            },
            token,
          });
          if (timeoutMs !== undefined) {
            timer = setTimeout(() => {
              // Only delete if this is still our resolver (not one from a later call)
              const current = relay.exitResolvers.get(name);
              if (current?.token === token) {
                relay.exitResolvers.delete(name);
              }
              resolve('timeout');
            }, timeoutMs);
          }
        });
      },
      waitForIdle(timeoutMs?: number) {
        return new Promise<'idle' | 'timeout' | 'exited'>((resolve) => {
          if (!relay.knownAgents.has(name)) {
            resolve('exited');
            return;
          }
          if (timeoutMs === 0) {
            resolve('timeout');
            return;
          }
          let timer: ReturnType<typeof setTimeout> | undefined;
          const token = ++relay.idleResolverSeq;
          relay.idleResolvers.set(name, {
            resolve(reason) {
              if (timer) clearTimeout(timer);
              resolve(reason);
            },
            token,
          });
          if (timeoutMs !== undefined) {
            timer = setTimeout(() => {
              const current = relay.idleResolvers.get(name);
              if (current?.token === token) {
                relay.idleResolvers.delete(name);
              }
              resolve('timeout');
            }, timeoutMs);
          }
        });
      },
      async sendMessage(input) {
        const client = await relay.ensureStarted();
        let result: Awaited<ReturnType<typeof client.sendMessage>>;
        try {
          result = await client.sendMessage({
            to: input.to,
            text: input.text,
            from: name,
            threadId: input.threadId,
            priority: input.priority,
            data: input.data,
          });
        } catch (error) {
          if (isUnsupportedOperation(error)) {
            return buildUnsupportedOperationMessage(name, input);
          }
          throw error;
        }
        if (result?.event_id === 'unsupported_operation') {
          return buildUnsupportedOperationMessage(name, input);
        }
        const eventId = result?.event_id ?? randomBytes(8).toString('hex');
        const msg: Message = {
          eventId,
          from: name,
          to: input.to,
          text: input.text,
          threadId: input.threadId,
          data: input.data,
        };
        relay.onMessageSent?.(msg);
        return msg;
      },
      onOutput(callback: AgentOutputCallback): () => void {
        let listeners = relay.outputListeners.get(name);
        if (!listeners) {
          listeners = new Set();
          relay.outputListeners.set(name, listeners);
        }
        const listener: OutputListener = {
          callback,
          mode: relay.inferOutputMode(callback),
        };
        listeners.add(listener);
        return () => {
          listeners!.delete(listener);
          if (listeners!.size === 0) {
            relay.outputListeners.delete(name);
          }
        };
      },
    };
  }

  private createSpawner(cli: string, defaultName: string, runtime: AgentRuntime): AgentSpawner {
    return {
      spawn: async (options?) => {
        const client = await this.ensureStarted();
        const name = options?.name ?? defaultName;
        const channels = options?.channels ?? ['general'];
        const args = options?.args ?? [];

        const task = options?.task;
        let result: { name: string; runtime: AgentRuntime };
        if (runtime === 'headless_claude') {
          result = await client.spawnHeadlessClaude({ name, args, channels, task });
        } else {
          result = await client.spawnPty({
            name,
            cli,
            args,
            channels,
            task,
            model: options?.model,
            cwd: options?.cwd,
          });
        }

        const agent = this.makeAgent(result.name, result.runtime, channels);
        this.knownAgents.set(agent.name, agent);
        return agent;
      },
    };
  }
}
