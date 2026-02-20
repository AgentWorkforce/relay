/**
 * RelayAdapter — high-level interface over the broker SDK.
 *
 * Wraps AgentRelayClient with auto-start, safe result patterns,
 * and convenience methods. Usable by any integration: dashboard,
 * MCP, ACP bridge, CLI, or custom tooling.
 *
 * Usage:
 *   import { RelayAdapter } from '@agent-relay/sdk';
 *
 *   const relay = new RelayAdapter({ cwd: projectRoot });
 *   await relay.start();
 *
 *   await relay.spawn({ name: 'Worker1', cli: 'claude', task: 'Build auth' });
 *   const agents = await relay.listAgents();
 *   await relay.sendMessage({ to: 'Worker1', text: 'status?' });
 *   await relay.release('Worker1');
 *
 *   await relay.shutdown();
 */

import {
  AgentRelayClient,
  type AgentRelayClientOptions,
  type SpawnPtyInput,
  type SendMessageInput,
  type ListAgent,
} from "./client.js";
import type { BrokerEvent, BrokerStats, BrokerStatus, CrashInsightsResponse } from "./protocol.js";

// ── Public types ────────────────────────────────────────────────────

export interface RelayAdapterOptions {
  /** Project root directory (required — the broker locks per project). */
  cwd: string;
  /** Path to the agent-relay binary. Falls back to bundled/PATH resolution. */
  binaryPath?: string;
  /** Default channels for spawned agents. */
  channels?: string[];
  /** Environment variables forwarded to the broker process. */
  env?: NodeJS.ProcessEnv;
  /** Client name reported in the hello handshake. */
  clientName?: string;
}

export interface RelaySpawnRequest {
  name: string;
  cli: string;
  task?: string;
  team?: string;
  cwd?: string;
  model?: string;
  interactive?: boolean;
  shadowMode?: string;
  shadowOf?: string;
  shadowAgent?: string;
  shadowTriggers?: string;
  shadowSpeakOn?: string;
  spawnerName?: string;
  userId?: string;
  includeWorkflowConventions?: boolean;
}

export interface RelaySpawnResult {
  success: boolean;
  name: string;
  pid?: number;
  error?: string;
}

export interface RelayAgentInfo {
  name: string;
  cli?: string;
  pid?: number;
  channels: string[];
  parent?: string;
  runtime: string;
}

export interface RelayReleaseResult {
  success: boolean;
  name: string;
  error?: string;
}

// ── Adapter ─────────────────────────────────────────────────────────

export class RelayAdapter {
  private client: AgentRelayClient;
  private started = false;

  constructor(opts: RelayAdapterOptions) {
    const clientOpts: AgentRelayClientOptions = {
      binaryPath: opts.binaryPath,
      channels: opts.channels ?? ["general"],
      cwd: opts.cwd,
      env: opts.env,
      clientName: opts.clientName ?? "relay-adapter",
    };
    this.client = new AgentRelayClient(clientOpts);
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  /** Start the broker process. Idempotent. */
  async start(): Promise<void> {
    if (this.started) return;
    await this.client.start();
    this.started = true;
  }

  /** Shut down the broker and all spawned agents. */
  async shutdown(): Promise<void> {
    await this.client.shutdown();
    this.started = false;
  }

  // ── Spawn / Release ─────────────────────────────────────────────

  /** Spawn an agent via the broker's PTY runtime. */
  async spawn(req: RelaySpawnRequest): Promise<RelaySpawnResult> {
    await this.start();
    try {
      const input: SpawnPtyInput = {
        name: req.name,
        cli: req.cli,
        task: req.task,
        channels: ["general"],
        model: req.model,
        cwd: req.cwd,
        team: req.team,
        shadowOf: req.shadowOf,
        shadowMode: req.shadowMode,
      };
      const result = await this.client.spawnPty(input);

      // Try to get PID from agent list
      let pid: number | undefined;
      try {
        const agents = await this.client.listAgents();
        pid = agents.find((a) => a.name === req.name)?.pid;
      } catch {
        // Non-fatal — PID is informational
      }

      return { success: true, name: result.name, pid };
    } catch (err: any) {
      return { success: false, name: req.name, error: err?.message ?? String(err) };
    }
  }

  /** Release (stop) a spawned agent. */
  async release(name: string, reason?: string): Promise<RelayReleaseResult> {
    await this.start();
    try {
      await this.client.release(name, reason);
      return { success: true, name };
    } catch (err: any) {
      return { success: false, name, error: err?.message ?? String(err) };
    }
  }

  // ── Query ───────────────────────────────────────────────────────

  /** List all agents managed by this broker instance. */
  async listAgents(): Promise<RelayAgentInfo[]> {
    await this.start();
    const agents = await this.client.listAgents();
    return agents.map((a) => ({
      name: a.name,
      cli: undefined, // Rust binary doesn't track CLI in list_agents response
      pid: a.pid,
      channels: a.channels,
      parent: a.parent,
      runtime: a.runtime,
    }));
  }

  /** Check if a specific agent is spawned. */
  async hasAgent(name: string): Promise<boolean> {
    const agents = await this.listAgents();
    return agents.some((a) => a.name === name);
  }

  /** Get broker status (agent count, pending deliveries). */
  async getStatus(): Promise<BrokerStatus> {
    await this.start();
    return this.client.getStatus();
  }

  // ── Messaging ───────────────────────────────────────────────────

  /** Send a message to an agent or channel. */
  async sendMessage(input: SendMessageInput): Promise<{ event_id: string; targets: string[] }> {
    await this.start();
    return this.client.sendMessage(input);
  }

  // ── PTY Input ───────────────────────────────────────────────────

  /**
   * Send raw input to an agent's PTY stdin.
   * Useful for interrupts (ESC sequences), confirmations, etc.
   */
  async sendInput(name: string, data: string): Promise<void> {
    await this.start();
    await this.client.sendInput(name, data);
  }

  /**
   * Send an interrupt (ESC ESC) to an agent.
   * Convenience wrapper around sendInput.
   */
  async interruptAgent(name: string): Promise<boolean> {
    try {
      await this.sendInput(name, "\x1b\x1b");
      return true;
    } catch {
      return false;
    }
  }

  // ── Model ───────────────────────────────────────────────────────

  /** Switch an agent's model at runtime. */
  async setModel(
    name: string,
    model: string,
    opts?: { timeoutMs?: number },
  ): Promise<{ success: boolean; name: string; model: string }> {
    await this.start();
    return this.client.setModel(name, model, opts);
  }

  // ── Metrics ─────────────────────────────────────────────────────

  /** Get resource metrics for agents (memory, uptime) and broker stats. */
  async getMetrics(agent?: string): Promise<{
    agents: Array<{ name: string; pid: number; memory_bytes: number; uptime_secs: number }>;
    broker?: BrokerStats;
  }> {
    await this.start();
    return this.client.getMetrics(agent);
  }

  /** Get crash insights: recent crashes, patterns, and health score. */
  async getCrashInsights(): Promise<CrashInsightsResponse> {
    await this.start();
    return this.client.getCrashInsights();
  }

  // ── Events ──────────────────────────────────────────────────────

  /**
   * Subscribe to broker events (agent_spawned, agent_released,
   * relay_inbound, worker_stream, etc.).
   *
   * Returns an unsubscribe function.
   */
  onEvent(listener: (event: BrokerEvent) => void): () => void {
    return this.client.onEvent(listener);
  }

  /**
   * Subscribe to broker stderr output (debug logs from the Rust binary).
   * Returns an unsubscribe function.
   */
  onStderr(listener: (line: string) => void): () => void {
    return this.client.onBrokerStderr(listener);
  }

  // ── Underlying client (escape hatch) ────────────────────────────

  /** Access the underlying AgentRelayClient for advanced operations. */
  get raw(): AgentRelayClient {
    return this.client;
  }
}
