/**
 * AgentRelayClient — single client for communicating with an agent-relay broker
 * over HTTP/WS. Works identically for local and remote brokers.
 *
 * Usage:
 *   // Remote broker (Daytona sandbox, cloud, etc.)
 *   const client = new AgentRelayClient({ baseUrl, apiKey });
 *
 *   // Local broker (spawn and connect)
 *   const client = await AgentRelayClient.spawn({ cwd: '/my/project' });
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { BrokerTransport } from './transport.js';
import { getBrokerBinaryPath } from './broker-path.js';
import type { AgentRuntime, BrokerEvent, BrokerStats, CrashInsightsResponse } from './protocol.js';
import type { SpawnPtyInput, SpawnProviderInput, SendMessageInput, ListAgent } from './types.js';

// ── Types ──────────────────────────────────────────────────────────────

export interface AgentRelayClientOptions {
  baseUrl: string;
  apiKey?: string;
}

export interface AgentRelaySpawnOptions {
  /** Path to the agent-relay-broker binary. Auto-resolved if omitted. */
  binaryPath?: string;
  /** Extra args passed to `broker init` (e.g. ['--persist']). */
  binaryArgs?: string[];
  /** Broker name. Defaults to cwd basename. */
  brokerName?: string;
  /** Default channels for spawned agents. */
  channels?: string[];
  /** Working directory for the broker process. */
  cwd?: string;
  /** Environment variables for the broker process. */
  env?: NodeJS.ProcessEnv;
  /** Forward broker stderr to this callback. */
  onStderr?: (line: string) => void;
  /** Timeout in ms to wait for broker to become ready. Default: 15000. */
  startupTimeoutMs?: number;
}

export interface SessionInfo {
  broker_version: string;
  protocol_version: number;
  workspace_key?: string;
  default_workspace_id?: string;
  mode: string;
  uptime_secs: number;
}

// ── Client ─────────────────────────────────────────────────────────────

export class AgentRelayClient {
  private readonly transport: BrokerTransport;

  /** Set after spawn() — the managed child process. */
  private child: ChildProcess | null = null;
  /** Lease renewal timer (only for spawned brokers). */
  private leaseTimer: ReturnType<typeof setInterval> | null = null;

  workspaceKey?: string;

  constructor(options: AgentRelayClientOptions) {
    this.transport = new BrokerTransport({
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
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
  static async spawn(options?: AgentRelaySpawnOptions): Promise<AgentRelayClient> {
    const binaryPath = options?.binaryPath ?? getBrokerBinaryPath() ?? 'agent-relay-broker';
    const cwd = options?.cwd ?? process.cwd();
    const brokerName = options?.brokerName ?? (path.basename(cwd) || 'project');
    const channels = options?.channels ?? ['general'];
    const timeoutMs = options?.startupTimeoutMs ?? 15_000;
    const userArgs = options?.binaryArgs ?? [];

    const apiKey = `br_${randomBytes(16).toString('hex')}`;

    const env = {
      ...process.env,
      ...options?.env,
      RELAY_BROKER_API_KEY: apiKey,
    };

    const args = [
      'init',
      '--name', brokerName,
      '--channels', channels.join(','),
      ...userArgs,
    ];

    const child = spawn(binaryPath, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', options?.onStderr ? 'pipe' : 'ignore'],
    });

    // Forward stderr if requested
    if (options?.onStderr && child.stderr) {
      const { createInterface } = await import('node:readline');
      const rl = createInterface({ input: child.stderr });
      rl.on('line', (line) => options.onStderr!(line));
    }

    // Parse the API port from stdout (the broker prints it after binding)
    const port = await waitForApiPort(child, timeoutMs);

    const client = new AgentRelayClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey });
    client.child = child;

    await client.getSession();
    client.connectEvents();

    // Renew the owner lease so the broker doesn't auto-shutdown
    client.leaseTimer = setInterval(() => {
      client.renewLease().catch(() => {});
    }, 60_000);

    child.on('exit', () => {
      client.disconnectEvents();
      if (client.leaseTimer) {
        clearInterval(client.leaseTimer);
        client.leaseTimer = null;
      }
    });

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

  queryEvents(filter?: { kind?: string; name?: string; since?: number; limit?: number }): BrokerEvent[] {
    return this.transport.queryEvents(filter);
  }

  getLastEvent(kind: string, name?: string): BrokerEvent | undefined {
    return this.transport.getLastEvent(kind, name);
  }

  // ── Agent lifecycle ────────────────────────────────────────────────

  async spawnPty(input: SpawnPtyInput): Promise<{ name: string; runtime: AgentRuntime }> {
    return this.transport.request('/api/spawn', {
      method: 'POST',
      body: JSON.stringify({
        name: input.name,
        cli: input.cli,
        model: input.model,
        args: input.args ?? [],
        task: input.task,
        channels: input.channels ?? [],
        cwd: input.cwd,
        team: input.team,
        shadowOf: input.shadowOf,
        shadowMode: input.shadowMode,
        continueFrom: input.continueFrom,
        idleThresholdSecs: input.idleThresholdSecs,
        restartPolicy: input.restartPolicy,
        skipRelayPrompt: input.skipRelayPrompt,
      }),
    });
  }

  async spawnProvider(input: SpawnProviderInput): Promise<{ name: string; runtime: AgentRuntime }> {
    return this.transport.request('/api/spawn', {
      method: 'POST',
      body: JSON.stringify({
        name: input.name,
        cli: input.provider,
        model: input.model,
        args: input.args ?? [],
        task: input.task,
        channels: input.channels ?? [],
        cwd: input.cwd,
        team: input.team,
        shadowOf: input.shadowOf,
        shadowMode: input.shadowMode,
        continueFrom: input.continueFrom,
        idleThresholdSecs: input.idleThresholdSecs,
        restartPolicy: input.restartPolicy,
        skipRelayPrompt: input.skipRelayPrompt,
        transport: input.transport,
      }),
    });
  }

  async release(name: string, reason?: string): Promise<{ name: string }> {
    return this.transport.request(`/api/spawned/${encodeURIComponent(name)}`, {
      method: 'DELETE',
      ...(reason ? { body: JSON.stringify({ reason }) } : {}),
    });
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

  async resizePty(name: string, rows: number, cols: number): Promise<{ name: string; rows: number; cols: number }> {
    return this.transport.request(`/api/resize/${encodeURIComponent(name)}`, {
      method: 'POST',
      body: JSON.stringify({ rows, cols }),
    });
  }

  // ── Messaging ──────────────────────────────────────────────────────

  async sendMessage(input: SendMessageInput): Promise<{ event_id: string; targets: string[] }> {
    return this.transport.request('/api/send', {
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
  }

  // ── Model control ──────────────────────────────────────────────────

  async setModel(name: string, model: string, opts?: { timeoutMs?: number }): Promise<{ name: string; model: string; success: boolean }> {
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

  async getMetrics(agent?: string): Promise<{ agents: Array<{ name: string; pid: number; memory_bytes: number; uptime_secs: number }>; broker?: BrokerStats }> {
    const query = agent ? `?agent=${encodeURIComponent(agent)}` : '';
    return this.transport.request(`/api/metrics${query}`);
  }

  async getStatus(): Promise<unknown> {
    return this.transport.request('/api/status');
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

  /** Shut down the broker and clean up. For spawned brokers, waits for the process to exit. */
  async shutdown(): Promise<void> {
    if (this.leaseTimer) {
      clearInterval(this.leaseTimer);
      this.leaseTimer = null;
    }

    try {
      await this.transport.request('/api/shutdown', { method: 'POST' });
    } catch {
      // Broker may already be dead
    }
    this.transport.disconnect();

    if (this.child) {
      await waitForExit(this.child, 5000);
      this.child = null;
    }
  }

  async getConfig(): Promise<{ workspaceKey?: string }> {
    return this.transport.request('/api/config');
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Parse the API port from the broker's stdout. The broker prints:
 *   [agent-relay] API listening on http://{bind}:{port}
 */
async function waitForApiPort(
  child: ChildProcess,
  timeoutMs: number,
): Promise<number> {
  const { createInterface } = await import('node:readline');

  return new Promise<number>((resolve, reject) => {
    if (!child.stdout) {
      reject(new Error('Broker stdout not available'));
      return;
    }

    let resolved = false;
    const rl = createInterface({ input: child.stdout });

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        rl.close();
        reject(new Error(`Broker did not report API port within ${timeoutMs}ms`));
      }
    }, timeoutMs);

    child.on('exit', (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        rl.close();
        reject(new Error(`Broker process exited with code ${code} before becoming ready`));
      }
    });

    rl.on('line', (line) => {
      if (resolved) return;

      const match = line.match(/API listening on https?:\/\/[^:]+:(\d+)/);
      if (match) {
        resolved = true;
        clearTimeout(timer);
        resolve(parseInt(match[1], 10));
      }
    });
  });
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, timeoutMs);
    child.on('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
