/**
 * High-level facade for the Agent Relay SDK.
 *
 * Provides a clean, property-based API on top of the lower-level
 * {@link AgentRelayClient} protocol client.
 *
 * @example
 * ```ts
 * import { AgentRelay } from "@agent-relay/sdk-ts";
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
  type AgentRelayClientOptions,
  type SpawnPtyInput,
} from "./client.js";
import type { AgentRuntime, BrokerEvent } from "./protocol.js";
import { RelaycastApi } from "./relaycast.js";

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
  release(): Promise<void>;
  /** Wait for the agent process to exit on its own.
   *  @param timeoutMs — optional timeout in ms. Resolves with `"timeout"` if exceeded,
   *  `"exited"` if the agent exited naturally, or `"released"` if released externally. */
  waitForExit(timeoutMs?: number): Promise<"exited" | "timeout" | "released">;
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
  private readonly exitResolvers = new Map<string, (reason: "exited" | "released") => void>();
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
    const channels = input.channels ?? ["general"];
    const result = await client.spawnPty({
      name: input.name,
      cli: input.cli,
      args: input.args,
      channels,
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
        await relay.ensureStarted();
        const rc = relay.ensureRelaycast(opts.name);
        const channel = relay.resolveChannel(input.to);
        await rc.sendToChannel(channel, input.text);
        const eventId = randomBytes(8).toString("hex");
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

    this.startPromise = AgentRelayClient.start(this.clientOptions).then((c) => {
      this.client = c;
      this.startPromise = undefined;
      this.wireEvents(c);
      return c;
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
          this.exitResolvers.get(event.name)?.("released");
          this.exitResolvers.delete(event.name);
          break;
        }
        case "agent_exited": {
          const agent =
            this.knownAgents.get(event.name) ??
            this.makeAgent(event.name, "pty", []);
          this.onAgentExited?.(agent);
          this.knownAgents.delete(event.name);
          this.exitResolvers.get(event.name)?.("exited");
          this.exitResolvers.delete(event.name);
          break;
        }
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
          let timer: ReturnType<typeof setTimeout> | undefined;
          relay.exitResolvers.set(name, (reason) => {
            if (timer) clearTimeout(timer);
            resolve(reason);
          });
          if (timeoutMs !== undefined) {
            timer = setTimeout(() => {
              relay.exitResolvers.delete(name);
              resolve("timeout");
            }, timeoutMs);
          }
        });
      },
      async sendMessage(input) {
        await relay.ensureStarted();
        const rc = relay.ensureRelaycast(name);
        const channel = relay.resolveChannel(input.to);
        await rc.sendToChannel(channel, input.text);
        const eventId = randomBytes(8).toString("hex");
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

        let result: { name: string; runtime: AgentRuntime };
        if (runtime === "headless_claude") {
          result = await client.spawnHeadlessClaude({ name, args, channels });
        } else {
          result = await client.spawnPty({ name, cli, args, channels });
        }

        const agent = relay.makeAgent(result.name, result.runtime, channels);
        relay.knownAgents.set(agent.name, agent);
        return agent;
      },
    };
  }
}
