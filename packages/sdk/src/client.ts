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
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { BrokerTransport, AgentRelayProtocolError } from './transport.js';
import { getBrokerBinaryPath } from './broker-path.js';
import type {
  AgentRuntime,
  BrokerEvent,
  BrokerStats,
  BrokerStatus,
  CrashInsightsResponse,
  HeadlessProvider,
} from './protocol.js';
import type {
  AgentTransport,
  SpawnHeadlessInput,
  SpawnPtyInput,
  SpawnProviderInput,
  SendMessageInput,
  ListAgent,
} from './types.js';

// ── Types ──────────────────────────────────────────────────────────────

export interface AgentRelayClientOptions {
  baseUrl: string;
  apiKey?: string;
  /** Timeout in ms for HTTP requests. Default: 30000. */
  requestTimeoutMs?: number;
}

export interface AgentRelayBrokerInitArgs {
  /** Optional HTTP API port for dashboard proxy (0 = disabled). */
  apiPort?: number;
  /** Bind address for the HTTP API. Defaults to 127.0.0.1 in the broker. */
  apiBind?: string;
  /** Enable persistence for broker state under the working directory. */
  persist?: boolean;
  /** Override the directory used for broker state files. */
  stateDir?: string;
}

export interface AgentRelaySpawnOptions {
  /** Path to the agent-relay-broker binary. Auto-resolved if omitted. */
  binaryPath?: string;
  /** Structured options mapped to the broker's Rust `init` CLI flags. */
  binaryArgs?: AgentRelayBrokerInitArgs;
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
  /** Timeout in ms to wait for broker to become ready. Default: 45000. */
  startupTimeoutMs?: number;
  /** Timeout in ms for HTTP requests to the broker. Default: 30000. */
  requestTimeoutMs?: number;
}

export interface SessionInfo {
  broker_version: string;
  protocol_version: number;
  workspace_key?: string;
  default_workspace_id?: string;
  mode: string;
  uptime_secs: number;
}

interface BrokerStartupDebugContext {
  binaryPath: string;
  args: string[];
  cwd: string;
  stdoutLines: string[];
  stderrLines: string[];
}

function isHeadlessProvider(value: string): value is HeadlessProvider {
  return value === 'claude' || value === 'opencode';
}

function resolveSpawnTransport(input: SpawnProviderInput): AgentTransport {
  return input.transport ?? (input.provider === 'opencode' ? 'headless' : 'pty');
}

function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function buildBrokerInitArgs(args?: AgentRelayBrokerInitArgs): string[] {
  if (!args) {
    return [];
  }

  const cliArgs: string[] = [];

  if (args.persist) {
    cliArgs.push('--persist');
  }
  if (args.apiPort !== undefined) {
    cliArgs.push('--api-port', String(args.apiPort));
  }
  if (args.apiBind !== undefined) {
    cliArgs.push('--api-bind', args.apiBind);
  }
  if (args.stateDir !== undefined) {
    cliArgs.push('--state-dir', args.stateDir);
  }

  return cliArgs;
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
      requestTimeoutMs: options.requestTimeoutMs,
    });
  }

  /**
   * Connect to an already-running broker by reading its connection file.
   *
   * The broker writes `connection.json` to its data directory ({cwd}/.agent-relay/
   * in persist mode). This method reads that file to get the URL and API key.
   *
   * @param cwd — project directory (default: process.cwd())
   * @param connectionPath — explicit path to connection.json (overrides cwd)
   */
  static connect(options?: { cwd?: string; connectionPath?: string }): AgentRelayClient {
    const cwd = options?.cwd ?? process.cwd();
    const stateDir = process.env.AGENT_RELAY_STATE_DIR;
    const connPath =
      options?.connectionPath ?? path.join(stateDir ?? path.join(cwd, '.agent-relay'), 'connection.json');

    if (!existsSync(connPath)) {
      throw new Error(
        `No running broker found (${connPath} does not exist). Start one with 'agent-relay up' or use AgentRelayClient.spawn().`
      );
    }

    const raw = readFileSync(connPath, 'utf-8');
    let conn: { url?: string; api_key?: string; port?: number; pid?: number };
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
        `Stale broker connection file (${connPath}) points to dead pid ${conn.pid}. Start the broker with 'agent-relay up' or use AgentRelayClient.spawn().`
      );
    }

    return new AgentRelayClient({ baseUrl: conn.url, apiKey: conn.api_key });
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
    const timeoutMs = options?.startupTimeoutMs ?? 45_000;
    const userArgs = buildBrokerInitArgs(options?.binaryArgs);

    const apiKey = `br_${randomBytes(16).toString('hex')}`;

    const env = {
      ...process.env,
      ...options?.env,
      AGENT_RELAY_STARTUP_DEBUG:
        options?.env?.AGENT_RELAY_STARTUP_DEBUG ?? process.env.AGENT_RELAY_STARTUP_DEBUG ?? '1',
      RELAY_BROKER_API_KEY: apiKey,
    };

    const args = ['init', '--name', brokerName, '--channels', channels.join(','), ...userArgs];
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

    const client = new AgentRelayClient({
      baseUrl,
      apiKey,
      requestTimeoutMs: options?.requestTimeoutMs,
    });
    client.child = child;

    // Broker may still be connecting to Relaycast. Retry getSession
    // with backoff if we get 503 (broker warming up).
    let session: SessionInfo | undefined;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        session = await client.getSession();
        break;
      } catch (err) {
        const is503 =
          err instanceof Error &&
          (err.message.includes('503') || err.message.includes('Service Unavailable'));
        if (!is503 || attempt >= 9) throw err;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

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
        agentToken: input.agentToken,
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
    const transport = resolveSpawnTransport(input);
    if (transport === 'headless' && !isHeadlessProvider(input.provider)) {
      throw new Error(
        `provider '${input.provider}' does not support headless transport (supported: claude, opencode)`
      );
    }

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
        agentToken: input.agentToken,
        shadowOf: input.shadowOf,
        shadowMode: input.shadowMode,
        continueFrom: input.continueFrom,
        idleThresholdSecs: input.idleThresholdSecs,
        restartPolicy: input.restartPolicy,
        skipRelayPrompt: input.skipRelayPrompt,
        transport,
      }),
    });
  }

  async spawnHeadless(input: SpawnHeadlessInput): Promise<{ name: string; runtime: AgentRuntime }> {
    return this.spawnProvider({ ...input, transport: 'headless' });
  }

  async spawnClaude(
    input: Omit<SpawnProviderInput, 'provider'>
  ): Promise<{ name: string; runtime: AgentRuntime }> {
    return this.spawnProvider({ ...input, provider: 'claude' });
  }

  async spawnOpencode(
    input: Omit<SpawnProviderInput, 'provider'>
  ): Promise<{ name: string; runtime: AgentRuntime }> {
    return this.spawnProvider({ ...input, provider: 'opencode' });
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
      if (error instanceof AgentRelayProtocolError && error.code === 'unsupported_operation') {
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

  async getMessageHistory(): Promise<Array<Record<string, unknown>>> {
    const response = await this.transport.request<{ messages?: Array<Record<string, unknown>> }>(
      '/api/history/messages'
    );
    return Array.isArray(response.messages) ? response.messages : [];
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
}

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Parse the API URL from the broker's stdout. The broker prints:
 *   [agent-relay] API listening on http://{bind}:{port}
 * Returns the full URL (e.g. "http://127.0.0.1:3889").
 */
async function waitForApiUrl(
  child: ChildProcess,
  timeoutMs: number,
  debug: BrokerStartupDebugContext
): Promise<string> {
  const { createInterface } = await import('node:readline');

  return new Promise<string>((resolve, reject) => {
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
        child.kill('SIGTERM');
        reject(
          new Error(
            formatBrokerStartupError(`Broker did not report API port within ${timeoutMs}ms`, child, debug)
          )
        );
      }
    }, timeoutMs);

    child.on('exit', (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        rl.close();
        reject(
          new Error(
            formatBrokerStartupError(
              `Broker process exited with code ${code} before becoming ready`,
              child,
              debug
            )
          )
        );
      }
    });

    child.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        rl.close();
        reject(new Error(formatBrokerStartupError(`Failed to start broker: ${err.message}`, child, debug)));
      }
    });

    rl.on('line', (line) => {
      if (resolved) return;
      pushBufferedLine(debug.stdoutLines, line);

      const match = line.match(/API listening on (https?:\/\/[^\s]+)/);
      if (match) {
        resolved = true;
        clearTimeout(timer);
        rl.close();
        resolve(match[1]);
      }
    });
  });
}

function pushBufferedLine(lines: string[], line: string): void {
  lines.push(line);
  if (lines.length > 40) {
    lines.splice(0, lines.length - 40);
  }
}

function formatBrokerStartupError(
  message: string,
  child: ChildProcess,
  debug: BrokerStartupDebugContext
): string {
  const details = [
    `pid=${child.pid ?? 'unknown'}`,
    `cwd=${debug.cwd}`,
    `command=${formatCommand(debug.binaryPath, debug.args)}`,
    `stdout_tail=${formatBufferedLines(debug.stdoutLines)}`,
    `stderr_tail=${formatBufferedLines(debug.stderrLines)}`,
  ];
  return `${message} (${details.join('; ')})`;
}

function formatBufferedLines(lines: string[]): string {
  if (lines.length === 0) {
    return '<empty>';
  }
  return lines
    .slice(-8)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(' | ');
}

function formatCommand(binaryPath: string, args: string[]): string {
  const render = [binaryPath, ...args].map((value) => {
    if (/^[A-Za-z0-9_./:@=-]+$/u.test(value)) {
      return value;
    }
    return JSON.stringify(value);
  });
  return render.join(' ');
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
