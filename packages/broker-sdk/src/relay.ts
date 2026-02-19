/**
 * High-level facade for the Agent Relay SDK.
 *
 * Provides a clean, property-based API on top of the lower-level
 * {@link AgentRelayClient} protocol client.
 *
 * @example
 * ```ts
 * import { AgentRelay } from "@agent-relay/broker-sdk";
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

import { randomBytes } from "node:crypto";
import path from "node:path";

import {
  AgentRelayClient,
  AgentRelayProtocolError,
  type AgentRelayClientOptions,
  type SpawnPtyInput,
} from "./client.js";
import type { AgentRuntime, BrokerEvent, BrokerStatus } from "./protocol.js";
import { RelaycastApi } from "./relaycast.js";
import { getLogs as getLogsFromFile, listLoggedAgents as listLoggedAgentsFromFile, type LogsResult, type GetLogsOptions } from "./logs.js";

function isUnsupportedOperation(error: unknown): error is AgentRelayProtocolError {
  return error instanceof AgentRelayProtocolError && error.code === "unsupported_operation";
}

function buildUnsupportedOperationMessage(
  from: string,
  input: { to: string; text: string; threadId?: string },
): Message {
  return {
    eventId: "unsupported_operation",
    from,
    to: input.to,
    text: input.text,
    threadId: input.threadId,
  };
}

// ── Public types ────────────────────────────────────────────────────────────

export interface Message {
  eventId: string;
  from: string;
  to: string;
  text: string;
  threadId?: string;
}

export interface Agent {
  readonly name: string;
  readonly runtime: AgentRuntime;
  readonly channels: string[];
  /** Set when the agent exits. Available after `onAgentExited` fires. */
  exitCode?: number;
  /** Set when the agent exits via signal. Available after `onAgentExited` fires. */
  exitSignal?: string;
  /** Set when the agent requests exit via /exit. Available after `onAgentExitRequested` fires. */
  exitReason?: string;
  release(): Promise<void>;
  /** Wait for the agent process to exit on its own.
   *  @param timeoutMs — optional timeout in ms. Resolves with `"timeout"` if exceeded,
   *  `"exited"` if the agent exited naturally, or `"released"` if released externally. */
  waitForExit(timeoutMs?: number): Promise<"exited" | "timeout" | "released">;
  /** Wait for the agent to go idle (no PTY output for the configured threshold).
   *  @param timeoutMs — optional timeout in ms. Resolves with `"idle"` when first idle event fires,
   *  `"timeout"` if timeoutMs elapses first, or `"exited"` if the agent exits. */
  waitForIdle(timeoutMs?: number): Promise<"idle" | "timeout" | "exited">;
  sendMessage(input: {
    to: string;
    text: string;
    threadId?: string;
    priority?: number;
  }): Promise<Message>;
}

export interface HumanHandle {
  readonly name: string;
  sendMessage(input: {
    to: string;
    text: string;
    threadId?: string;
    priority?: number;
  }): Promise<Message>;
}

export interface AgentSpawner {
  spawn(options?: {
    name?: string;
    args?: string[];
    channels?: string[];
    task?: string;
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
}

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

  // Shorthand spawners
  readonly codex: AgentSpawner;
  readonly claude: AgentSpawner;
  readonly gemini: AgentSpawner;

  private readonly clientOptions: AgentRelayClientOptions;
  private readonly defaultChannels: string[];
  private client?: AgentRelayClient;
  private startPromise?: Promise<AgentRelayClient>;
  private unsubEvent?: () => void;
  private readonly knownAgents = new Map<string, Agent>();
  private readonly exitResolvers = new Map<
    string,
    { resolve: (reason: "exited" | "released") => void; token: number }
  >();
  private exitResolverSeq = 0;
  private readonly idleResolvers = new Map<
    string,
    { resolve: (reason: "idle" | "timeout" | "exited") => void; token: number }
  >();
  private idleResolverSeq = 0;
  private readonly relaycastByName = new Map<string, RelaycastApi>();

  constructor(options: AgentRelayOptions = {}) {
    this.defaultChannels = options.channels ?? ["general"];
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

    this.codex = this.createSpawner("codex", "Codex", "pty");
    this.claude = this.createSpawner("claude", "Claude", "pty");
    this.gemini = this.createSpawner("gemini", "Gemini", "pty");
  }

  // ── Spawning ────────────────────────────────────────────────────────────

  async spawnPty(input: SpawnPtyInput): Promise<Agent> {
    const client = await this.ensureStarted();
    if (!input.channels || input.channels.length === 0) {
      console.warn(
        `[AgentRelay] spawnPty("${input.name}"): no channels specified, defaulting to "general". ` +
        'Set explicit channels for workflow isolation.',
      );
    }
    const channels = input.channels ?? ["general"];
    const result = await client.spawnPty({
      name: input.name,
      cli: input.cli,
      args: input.args,
      channels,
      task: input.task,
      idleThresholdSecs: input.idleThresholdSecs,
    });
    const agent = this.makeAgent(result.name, result.runtime, channels);
    this.knownAgents.set(agent.name, agent);
    return agent;
  }

  // ── Human source ────────────────────────────────────────────────────────

  human(opts: { name: string }): HumanHandle {
    const relay = this;
    return {
      name: opts.name,
      async sendMessage(input) {
        const client = await relay.ensureStarted();
        let result: Awaited<ReturnType<typeof client.sendMessage>>;
        try {
          result = await client.sendMessage({
            to: input.to,
            text: input.text,
            from: opts.name,
            threadId: input.threadId,
            priority: input.priority,
          });
        } catch (error) {
          if (isUnsupportedOperation(error)) {
            return buildUnsupportedOperationMessage(opts.name, input);
          }
          throw error;
        }
        if (result?.event_id === "unsupported_operation") {
          return buildUnsupportedOperationMessage(opts.name, input);
        }

        const eventId = result?.event_id ?? randomBytes(8).toString("hex");
        const msg: Message = {
          eventId,
          from: opts.name,
          to: input.to,
          text: input.text,
          threadId: input.threadId,
        };
        relay.onMessageSent?.(msg);
        return msg;
      },
    };
  }

  // ── Messaging ─────────────────────────────────────────────────────────

  /**
   * Broadcast a message to all connected agents.
   * @param text — the message body
   * @param options — optional sender name (defaults to "human:orchestrator")
   */
  async broadcast(
    text: string,
    options?: { from?: string },
  ): Promise<Message> {
    const from = options?.from ?? "human:orchestrator";
    return this.human({ name: from }).sendMessage({ to: "*", text });
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
    const logsDir = path.join(cwd, ".agent-relay", "team", "worker-logs");
    return getLogsFromFile(agentName, { logsDir, lines: options?.lines });
  }

  /** List all agents that have log files. */
  async listLoggedAgents(): Promise<string[]> {
    const cwd = this.clientOptions.cwd ?? process.cwd();
    const logsDir = path.join(cwd, ".agent-relay", "team", "worker-logs");
    return listLoggedAgentsFromFile(logsDir);
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
    timeoutMs?: number,
  ): Promise<{ agent: Agent; result: "exited" | "timeout" | "released" }> {
    if (agents.length === 0) {
      throw new Error("waitForAny requires at least one agent");
    }
    return Promise.race(
      agents.map(async (agent) => {
        const result = await agent.waitForExit(timeoutMs);
        return { agent, result };
      }),
    );
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
    for (const entry of this.exitResolvers.values()) {
      entry.resolve("released");
    }
    this.exitResolvers.clear();
    for (const entry of this.idleResolvers.values()) {
      entry.resolve("exited");
    }
    this.idleResolvers.clear();
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  /** Resolve a target to a channel name. If `to` is `#channel`, use that
   *  channel. If it's a known agent name, use the agent's first channel.
   *  Otherwise fall back to the relay's default channel. */
  private resolveChannel(to: string): string {
    if (to.startsWith("#")) return to.slice(1);
    const agent = this.knownAgents.get(to);
    if (agent && agent.channels.length > 0) return agent.channels[0];
    return this.defaultChannels[0];
  }

  private ensureRelaycast(agentName: string): RelaycastApi {
    let rc = this.relaycastByName.get(agentName);
    if (!rc) {
      const cwd = this.clientOptions.cwd ?? process.cwd();
      rc = new RelaycastApi({
        agentName,
        cachePath: path.join(cwd, ".agent-relay", "relaycast.json"),
      });
      this.relaycastByName.set(agentName, rc);
    }
    return rc;
  }

  private async ensureStarted(): Promise<AgentRelayClient> {
    if (this.client) return this.client;
    if (this.startPromise) return this.startPromise;

    this.startPromise = AgentRelayClient.start(this.clientOptions)
      .then((c) => {
        this.client = c;
        this.startPromise = undefined;
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
    this.unsubEvent = client.onEvent((event: BrokerEvent) => {
      switch (event.kind) {
        case "relay_inbound": {
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
        case "agent_spawned": {
          let agent = this.knownAgents.get(event.name);
          if (!agent) {
            agent = this.makeAgent(event.name, event.runtime, []);
            this.knownAgents.set(event.name, agent);
          }
          this.onAgentSpawned?.(agent);
          break;
        }
        case "agent_released": {
          const agent =
            this.knownAgents.get(event.name) ??
            this.makeAgent(event.name, "pty", []);
          this.onAgentReleased?.(agent);
          this.knownAgents.delete(event.name);
          this.exitResolvers.get(event.name)?.resolve("released");
          this.exitResolvers.delete(event.name);
          this.idleResolvers.get(event.name)?.resolve("exited");
          this.idleResolvers.delete(event.name);
          break;
        }
        case "agent_exited": {
          const agent =
            this.knownAgents.get(event.name) ??
            this.makeAgent(event.name, "pty", []);
          // Populate exit info before firing the hook
          (agent as { exitCode?: number }).exitCode = event.code;
          (agent as { exitSignal?: string }).exitSignal = event.signal;
          this.onAgentExited?.(agent);
          this.knownAgents.delete(event.name);
          this.exitResolvers.get(event.name)?.resolve("exited");
          this.exitResolvers.delete(event.name);
          this.idleResolvers.get(event.name)?.resolve("exited");
          this.idleResolvers.delete(event.name);
          break;
        }
        case "agent_exit": {
          const agent =
            this.knownAgents.get(event.name) ??
            this.makeAgent(event.name, "pty", []);
          (agent as { exitReason?: string }).exitReason = event.reason;
          this.onAgentExitRequested?.({ name: event.name, reason: event.reason });
          break;
        }
        case "worker_ready": {
          let agent = this.knownAgents.get(event.name);
          if (!agent) {
            agent = this.makeAgent(event.name, event.runtime, []);
            this.knownAgents.set(event.name, agent);
          }
          this.onAgentReady?.(agent);
          break;
        }
        case "worker_stream": {
          this.onWorkerOutput?.({
            name: event.name,
            stream: event.stream,
            chunk: event.chunk,
          });
          break;
        }
        case "agent_idle": {
          this.onAgentIdle?.({
            name: event.name,
            idleSecs: event.idle_secs,
          });
          // Resolve idle waiters
          this.idleResolvers.get(event.name)?.resolve("idle");
          this.idleResolvers.delete(event.name);
          break;
        }
      }
      if (event.kind.startsWith("delivery_")) {
        this.onDeliveryUpdate?.(event);
      }
    });
  }

  private makeAgent(
    name: string,
    runtime: AgentRuntime,
    channels: string[],
  ): Agent {
    const relay = this;
    return {
      name,
      runtime,
      channels,
      exitCode: undefined,
      exitSignal: undefined,
      async release() {
        const client = await relay.ensureStarted();
        await client.release(name);
      },
      waitForExit(timeoutMs?: number) {
        return new Promise<"exited" | "timeout" | "released">((resolve) => {
          // If already gone, resolve immediately
          if (!relay.knownAgents.has(name)) {
            resolve("exited");
            return;
          }
          // Non-blocking poll: timeoutMs === 0 means "check now, return immediately"
          if (timeoutMs === 0) {
            resolve("timeout");
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
              resolve("timeout");
            }, timeoutMs);
          }
        });
      },
      waitForIdle(timeoutMs?: number) {
        return new Promise<"idle" | "timeout" | "exited">((resolve) => {
          if (!relay.knownAgents.has(name)) {
            resolve("exited");
            return;
          }
          if (timeoutMs === 0) {
            resolve("timeout");
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
              resolve("timeout");
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
          });
        } catch (error) {
          if (isUnsupportedOperation(error)) {
            return buildUnsupportedOperationMessage(name, input);
          }
          throw error;
        }
        if (result?.event_id === "unsupported_operation") {
          return buildUnsupportedOperationMessage(name, input);
        }
        const eventId = result?.event_id ?? randomBytes(8).toString("hex");
        const msg: Message = {
          eventId,
          from: name,
          to: input.to,
          text: input.text,
          threadId: input.threadId,
        };
        relay.onMessageSent?.(msg);
        return msg;
      },
    };
  }

  private createSpawner(
    cli: string,
    defaultName: string,
    runtime: AgentRuntime,
  ): AgentSpawner {
    const relay = this;
    return {
      async spawn(options?) {
        const client = await relay.ensureStarted();
        const name = options?.name ?? defaultName;
        const channels = options?.channels ?? ["general"];
        const args = options?.args ?? [];

        const task = options?.task;
        let result: { name: string; runtime: AgentRuntime };
        if (runtime === "headless_claude") {
          result = await client.spawnHeadlessClaude({ name, args, channels, task });
        } else {
          result = await client.spawnPty({ name, cli, args, channels, task });
        }

        const agent = relay.makeAgent(result.name, result.runtime, channels);
        relay.knownAgents.set(agent.name, agent);
        return agent;
      },
    };
  }
}
