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
  type AgentRelaySpawnOptions,
} from './client.js';
import type {
  SpawnPtyInput,
  SendMessageInput,
} from './types.js';
import type { BrokerEvent, BrokerStats, BrokerStatus, CrashInsightsResponse } from './protocol.js';

const WORKFLOW_BOOTSTRAP_TASK =
  'You are connected to Agent Relay. Do not reply to this message and wait for relay messages and respond using Relaycast MCP tools.';

const WORKFLOW_CONVENTIONS = [
  'Messaging requirements:',
  '- When you receive `Relay message from <sender> ...`, reply using `mcp__relaycast__message_dm_send(to: "<sender>", text: "...")`.',
  '- Send `ACK: ...` when you receive a task.',
  '- Send `DONE: ...` when the task is complete.',
  '- Do not reply only in terminal text; send the response via mcp__relaycast__message_dm_send.',
  '- Use mcp__relaycast__message_inbox_check() and mcp__relaycast__agent_list() when context is missing.',
].join('\n');

function hasWorkflowConventions(task: string): boolean {
  const lower = task.toLowerCase();
  return lower.includes('mcp__relaycast__message_dm_send(') || lower.includes('relay_send(') || (lower.includes('ack:') && lower.includes('done:'));
}

function buildSpawnTask(
  task: string | undefined,
  includeWorkflowConventions: boolean | undefined
): string | undefined {
  const normalized = typeof task === 'string' ? task.trim() : '';

  if (!includeWorkflowConventions) {
    return normalized.length > 0 ? normalized : undefined;
  }

  if (normalized.length === 0) {
    return `${WORKFLOW_BOOTSTRAP_TASK}\n\n${WORKFLOW_CONVENTIONS}`;
  }

  if (hasWorkflowConventions(normalized)) {
    return normalized;
  }

  return `${normalized}\n\n${WORKFLOW_CONVENTIONS}`;
}

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
  private client: AgentRelayClient | null = null;
  private started = false;
  private readonly spawnOpts: AgentRelaySpawnOptions;
  private readonly stderrListeners = new Set<(line: string) => void>();
  private readonly pendingEventListeners: Array<(event: BrokerEvent) => void> = [];

  constructor(opts: RelayAdapterOptions) {
    this.spawnOpts = {
      binaryPath: opts.binaryPath,
      channels: opts.channels ?? ['general'],
      cwd: opts.cwd,
      env: opts.env,
    };
  }

  private ensureClient(): AgentRelayClient {
    if (!this.client) throw new Error('RelayAdapter not started — call start() first');
    return this.client;
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  /** Start the broker process. Idempotent. */
  async start(): Promise<void> {
    if (this.started) return;
    this.client = await AgentRelayClient.spawn({
      ...this.spawnOpts,
      onStderr: (line) => {
        for (const listener of this.stderrListeners) {
          try { listener(line); } catch { /* ignore */ }
        }
      },
    });
    // Wire any event listeners that were registered before start()
    for (const listener of this.pendingEventListeners) {
      this.client.onEvent(listener);
    }
    this.pendingEventListeners.length = 0;
    this.started = true;
  }

  /** Shut down the broker and all spawned agents. */
  async shutdown(): Promise<void> {
    await this.ensureClient().shutdown();
    this.client = null;
    this.started = false;
  }

  // ── Spawn / Release ─────────────────────────────────────────────

  /** Spawn an agent via the broker's PTY runtime. */
  async spawn(req: RelaySpawnRequest): Promise<RelaySpawnResult> {
    await this.start();
    const client = this.ensureClient();
    try {
      const input: SpawnPtyInput = {
        name: req.name,
        cli: req.cli,
        task: buildSpawnTask(req.task, req.includeWorkflowConventions),
        channels: ['general'],
        model: req.model,
        cwd: req.cwd,
        team: req.team,
        shadowOf: req.shadowOf,
        shadowMode: req.shadowMode,
      };
      const result = await client.spawnPty(input);

      let pid: number | undefined;
      try {
        const agents = await client.listAgents();
        pid = agents.find((a) => a.name === req.name)?.pid;
      } catch {
        // Non-fatal
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
      await this.ensureClient().release(name, reason);
      return { success: true, name };
    } catch (err: any) {
      return { success: false, name, error: err?.message ?? String(err) };
    }
  }

  // ── Query ───────────────────────────────────────────────────────

  /** List all agents managed by this broker instance. */
  async listAgents(): Promise<RelayAgentInfo[]> {
    await this.start();
    const agents = await this.ensureClient().listAgents();
    return agents.map((a) => ({
      name: a.name,
      cli: undefined,
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
    return this.ensureClient().getStatus();
  }

  // ── Messaging ───────────────────────────────────────────────────

  /** Send a message to an agent or channel. */
  async sendMessage(input: SendMessageInput): Promise<{ event_id: string; targets: string[] }> {
    await this.start();
    return this.ensureClient().sendMessage(input);
  }

  // ── PTY Input ───────────────────────────────────────────────────

  async sendInput(name: string, data: string): Promise<void> {
    await this.start();
    await this.ensureClient().sendInput(name, data);
  }

  async interruptAgent(name: string): Promise<boolean> {
    try {
      await this.sendInput(name, '\x1b\x1b');
      return true;
    } catch {
      return false;
    }
  }

  // ── Model ───────────────────────────────────────────────────────

  async setModel(
    name: string,
    model: string,
    opts?: { timeoutMs?: number }
  ): Promise<{ success: boolean; name: string; model: string }> {
    await this.start();
    return this.ensureClient().setModel(name, model, opts);
  }

  // ── Metrics ─────────────────────────────────────────────────────

  async getMetrics(agent?: string): Promise<{
    agents: Array<{ name: string; pid: number; memory_bytes: number; uptime_secs: number }>;
    broker?: BrokerStats;
  }> {
    await this.start();
    return this.ensureClient().getMetrics(agent);
  }

  async getCrashInsights(): Promise<CrashInsightsResponse> {
    await this.start();
    return this.ensureClient().getCrashInsights();
  }

  // ── Events ──────────────────────────────────────────────────────

  onEvent(listener: (event: BrokerEvent) => void): () => void {
    if (this.client) {
      return this.client.onEvent(listener);
    }
    // Queue listener — will be wired after start()
    this.pendingEventListeners.push(listener);
    return () => {
      const idx = this.pendingEventListeners.indexOf(listener);
      if (idx >= 0) this.pendingEventListeners.splice(idx, 1);
    };
  }

  onStderr(listener: (line: string) => void): () => void {
    this.stderrListeners.add(listener);
    return () => { this.stderrListeners.delete(listener); };
  }

  // ── Underlying client (escape hatch) ────────────────────────────

  get raw(): AgentRelayClient {
    return this.ensureClient();
  }
}
