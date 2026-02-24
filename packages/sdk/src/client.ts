import { once } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PROTOCOL_VERSION,
  type AgentRuntime,
  type AgentSpec,
  type BrokerEvent,
  type BrokerStats,
  type BrokerStatus,
  type CrashInsightsResponse,
  type ProtocolEnvelope,
  type ProtocolError,
  type RestartPolicy,
} from './protocol.js';

export interface AgentRelayClientOptions {
  binaryPath?: string;
  binaryArgs?: string[];
  brokerName?: string;
  channels?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  clientName?: string;
  clientVersion?: string;
}

export interface SpawnPtyInput {
  name: string;
  cli: string;
  args?: string[];
  channels?: string[];
  task?: string;
  model?: string;
  cwd?: string;
  team?: string;
  shadowOf?: string;
  shadowMode?: string;
  /** Silence duration in seconds before emitting agent_idle (0 = disabled, default: 30). */
  idleThresholdSecs?: number;
  /** Auto-restart policy for crashed agents. */
  restartPolicy?: RestartPolicy;
  /** Name of a previously released agent whose continuity context should be injected. */
  continueFrom?: string;
}

export interface SpawnHeadlessClaudeInput {
  name: string;
  args?: string[];
  channels?: string[];
  task?: string;
}

export interface SendMessageInput {
  to: string;
  text: string;
  from?: string;
  threadId?: string;
  priority?: number;
  data?: Record<string, unknown>;
}

export interface ListAgent {
  name: string;
  runtime: AgentRuntime;
  cli?: string;
  model?: string;
  team?: string;
  channels: string[];
  parent?: string;
  pid?: number;
}

interface PendingRequest {
  expectedType: 'ok' | 'hello_ack';
  resolve: (value: ProtocolEnvelope<unknown>) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface ParsedEnvelope {
  v: number;
  type: string;
  request_id?: string;
  payload: unknown;
}

export class AgentRelayProtocolError extends Error {
  code: string;
  retryable: boolean;
  data?: unknown;

  constructor(payload: ProtocolError) {
    super(payload.message);
    this.name = 'AgentRelayProtocolError';
    this.code = payload.code;
    this.retryable = payload.retryable;
    this.data = payload.data;
  }
}

export class AgentRelayProcessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentRelayProcessError';
  }
}

export class AgentRelayClient {
  private readonly options: Required<AgentRelayClientOptions>;
  private child?: ChildProcessWithoutNullStreams;
  private stdoutRl?: ReadlineInterface;
  private stderrRl?: ReadlineInterface;
  private lastStderrLine?: string;
  private requestSeq = 0;
  private pending = new Map<string, PendingRequest>();
  private startingPromise?: Promise<void>;
  private eventListeners = new Set<(event: BrokerEvent) => void>();
  private stderrListeners = new Set<(line: string) => void>();
  private eventBuffer: BrokerEvent[] = [];
  private maxBufferSize = 1000;
  private exitPromise?: Promise<void>;

  constructor(options: AgentRelayClientOptions = {}) {
    this.options = {
      binaryPath: options.binaryPath ?? resolveDefaultBinaryPath(),
      binaryArgs: options.binaryArgs ?? [],
      brokerName: options.brokerName ?? (path.basename(options.cwd ?? process.cwd()) || 'project'),
      channels: options.channels ?? ['general'],
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env,
      requestTimeoutMs: options.requestTimeoutMs ?? 10_000,
      shutdownTimeoutMs: options.shutdownTimeoutMs ?? 3_000,
      clientName: options.clientName ?? '@agent-relay/sdk',
      clientVersion: options.clientVersion ?? '0.1.0',
    };
  }

  static async start(options: AgentRelayClientOptions = {}): Promise<AgentRelayClient> {
    const client = new AgentRelayClient(options);
    await client.start();
    return client;
  }

  onEvent(listener: (event: BrokerEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  queryEvents(filter?: { kind?: string; name?: string; since?: number; limit?: number }): BrokerEvent[] {
    let events = [...this.eventBuffer];
    if (filter?.kind) {
      events = events.filter((event) => event.kind === filter.kind);
    }
    if (filter?.name) {
      events = events.filter((event) => 'name' in event && event.name === filter.name);
    }
    const since = filter?.since;
    if (since !== undefined) {
      events = events.filter(
        (event) => 'timestamp' in event && typeof event.timestamp === 'number' && event.timestamp >= since
      );
    }
    const limit = filter?.limit;
    if (limit !== undefined) {
      events = events.slice(-limit);
    }
    return events;
  }

  getLastEvent(kind: string, name?: string): BrokerEvent | undefined {
    for (let i = this.eventBuffer.length - 1; i >= 0; i -= 1) {
      const event = this.eventBuffer[i];
      if (event.kind === kind && (!name || ('name' in event && event.name === name))) {
        return event;
      }
    }
    return undefined;
  }

  onBrokerStderr(listener: (line: string) => void): () => void {
    this.stderrListeners.add(listener);
    return () => {
      this.stderrListeners.delete(listener);
    };
  }

  async start(): Promise<void> {
    if (this.child) {
      return;
    }
    if (this.startingPromise) {
      return this.startingPromise;
    }

    this.startingPromise = this.startInternal();
    try {
      await this.startingPromise;
    } finally {
      this.startingPromise = undefined;
    }
  }

  async spawnPty(input: SpawnPtyInput): Promise<{ name: string; runtime: AgentRuntime }> {
    await this.start();
    const args = buildPtyArgsWithModel(input.cli, input.args ?? [], input.model);
    const agent: AgentSpec = {
      name: input.name,
      runtime: 'pty',
      cli: input.cli,
      args,
      channels: input.channels ?? [],
      model: input.model,
      cwd: input.cwd ?? this.options.cwd,
      team: input.team,
      shadow_of: input.shadowOf,
      shadow_mode: input.shadowMode,
      restart_policy: input.restartPolicy,
    };
    const result = await this.requestOk<{ name: string; runtime: AgentRuntime }>('spawn_agent', {
      agent,
      ...(input.task != null ? { initial_task: input.task } : {}),
      ...(input.idleThresholdSecs != null ? { idle_threshold_secs: input.idleThresholdSecs } : {}),
      ...(input.continueFrom != null ? { continue_from: input.continueFrom } : {}),
    });
    return result;
  }

  async spawnHeadlessClaude(
    input: SpawnHeadlessClaudeInput
  ): Promise<{ name: string; runtime: AgentRuntime }> {
    await this.start();
    const agent: AgentSpec = {
      name: input.name,
      runtime: 'headless_claude',
      args: input.args ?? [],
      channels: input.channels ?? [],
    };
    const result = await this.requestOk<{ name: string; runtime: AgentRuntime }>('spawn_agent', {
      agent,
      ...(input.task != null ? { initial_task: input.task } : {}),
    });
    return result;
  }

  async release(name: string, reason?: string): Promise<{ name: string }> {
    await this.start();
    return this.requestOk<{ name: string }>('release_agent', { name, reason });
  }

  async sendInput(name: string, data: string): Promise<{ name: string; bytes_written: number }> {
    await this.start();
    return this.requestOk<{ name: string; bytes_written: number }>('send_input', { name, data });
  }

  async setModel(
    name: string,
    model: string,
    opts?: { timeoutMs?: number }
  ): Promise<{ name: string; model: string; success: boolean }> {
    await this.start();
    return this.requestOk<{ name: string; model: string; success: boolean }>('set_model', {
      name,
      model,
      timeout_ms: opts?.timeoutMs,
    });
  }

  async getMetrics(agent?: string): Promise<{
    agents: Array<{ name: string; pid: number; memory_bytes: number; uptime_secs: number }>;
    broker?: BrokerStats;
  }> {
    await this.start();
    return this.requestOk<{
      agents: Array<{ name: string; pid: number; memory_bytes: number; uptime_secs: number }>;
      broker?: BrokerStats;
    }>('get_metrics', { agent });
  }

  async getCrashInsights(): Promise<CrashInsightsResponse> {
    await this.start();
    return this.requestOk<CrashInsightsResponse>('get_crash_insights', {});
  }

  async sendMessage(input: SendMessageInput): Promise<{ event_id: string; targets: string[] }> {
    await this.start();
    try {
      return await this.requestOk<{ event_id: string; targets: string[] }>('send_message', {
        to: input.to,
        text: input.text,
        from: input.from,
        thread_id: input.threadId,
        priority: input.priority,
        data: input.data,
      });
    } catch (error) {
      if (error instanceof AgentRelayProtocolError && error.code === 'unsupported_operation') {
        return { event_id: 'unsupported_operation', targets: [] };
      }
      throw error;
    }
  }

  async listAgents(): Promise<ListAgent[]> {
    await this.start();
    const result = await this.requestOk<{ agents: ListAgent[] }>('list_agents', {});
    return result.agents;
  }

  async getStatus(): Promise<BrokerStatus> {
    await this.start();
    return this.requestOk<BrokerStatus>('get_status', {});
  }

  async shutdown(): Promise<void> {
    if (!this.child) {
      return;
    }

    try {
      await this.requestOk('shutdown', {});
    } catch {
      // Continue shutdown path if broker is already unhealthy.
    }

    const child = this.child;
    const wait = this.exitPromise ?? Promise.resolve();
    const timeout = setTimeout(() => {
      if (!child.killed) {
        child.kill('SIGTERM');
      }
    }, this.options.shutdownTimeoutMs);

    try {
      await wait;
    } finally {
      clearTimeout(timeout);
      if (this.child) {
        this.child.kill('SIGKILL');
      }
    }
  }

  async waitForExit(): Promise<void> {
    if (!this.child) {
      return;
    }
    await this.exitPromise;
  }

  private async startInternal(): Promise<void> {
    const resolvedBinary = expandTilde(this.options.binaryPath);
    if (isExplicitPath(this.options.binaryPath) && !fs.existsSync(resolvedBinary)) {
      throw new AgentRelayProcessError(`broker binary not found: ${this.options.binaryPath}`);
    }
    this.lastStderrLine = undefined;

    const args = [
      'init',
      '--name',
      this.options.brokerName,
      '--channels',
      this.options.channels.join(','),
      ...this.options.binaryArgs,
    ];

    // Ensure the SDK bin directory (containing agent-relay-broker + relay_send) is on
    // PATH so spawned workers can find relay_send without any user setup.
    const env = { ...this.options.env };
    if (isExplicitPath(this.options.binaryPath)) {
      const binDir = path.dirname(path.resolve(resolvedBinary));
      const currentPath = env.PATH ?? env.Path ?? '';
      if (!currentPath.split(path.delimiter).includes(binDir)) {
        env.PATH = `${binDir}${path.delimiter}${currentPath}`;
      }
    }

    const child = spawn(resolvedBinary, args, {
      cwd: this.options.cwd,
      env,
      stdio: 'pipe',
    });

    this.child = child;
    this.stdoutRl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.stderrRl = createInterface({ input: child.stderr, crlfDelay: Infinity });

    this.stdoutRl.on('line', (line) => {
      this.handleStdoutLine(line);
    });

    this.stderrRl.on('line', (line) => {
      const trimmed = line.trim();
      if (trimmed) {
        this.lastStderrLine = trimmed;
      }
      for (const listener of this.stderrListeners) {
        listener(line);
      }
    });

    this.exitPromise = new Promise<void>((resolve) => {
      child.once('exit', (code, signal) => {
        const detail = this.lastStderrLine ? `: ${this.lastStderrLine}` : '';
        const error = new AgentRelayProcessError(
          `broker exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})${detail}`
        );
        this.failAllPending(error);
        this.disposeProcessHandles();
        resolve();
      });
      child.once('error', (error) => {
        this.failAllPending(error);
        this.disposeProcessHandles();
        resolve();
      });
    });

    await this.requestHello();
  }

  private disposeProcessHandles(): void {
    this.stdoutRl?.close();
    this.stderrRl?.close();
    this.stdoutRl = undefined;
    this.stderrRl = undefined;
    this.lastStderrLine = undefined;
    this.child = undefined;
    this.exitPromise = undefined;
  }

  private failAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private handleStdoutLine(line: string): void {
    let parsed: ParsedEnvelope;
    try {
      parsed = JSON.parse(line) as ParsedEnvelope;
    } catch {
      // Non-protocol output should not crash the SDK.
      return;
    }

    if (!parsed || typeof parsed !== 'object') {
      return;
    }
    if (parsed.v !== PROTOCOL_VERSION || typeof parsed.type !== 'string') {
      return;
    }

    const envelope: ProtocolEnvelope<unknown> = {
      v: parsed.v,
      type: parsed.type,
      request_id: parsed.request_id,
      payload: parsed.payload,
    };

    if (envelope.type === 'event') {
      const payload = envelope.payload as BrokerEvent;
      this.eventBuffer.push(payload);
      if (this.eventBuffer.length > this.maxBufferSize) {
        this.eventBuffer.shift();
      }
      for (const listener of this.eventListeners) {
        listener(payload);
      }
      return;
    }

    if (!envelope.request_id) {
      return;
    }

    const pending = this.pending.get(envelope.request_id);
    if (!pending) {
      return;
    }

    if (envelope.type === 'error') {
      clearTimeout(pending.timeout);
      this.pending.delete(envelope.request_id);
      pending.reject(new AgentRelayProtocolError(envelope.payload as ProtocolError));
      return;
    }

    if (envelope.type !== pending.expectedType) {
      clearTimeout(pending.timeout);
      this.pending.delete(envelope.request_id);
      pending.reject(
        new AgentRelayProcessError(
          `unexpected response type '${envelope.type}' for request '${envelope.request_id}' (expected '${pending.expectedType}')`
        )
      );
      return;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(envelope.request_id);
    pending.resolve(envelope);
  }

  private async requestHello(): Promise<{ broker_version: string; protocol_version: number }> {
    const payload = {
      client_name: this.options.clientName,
      client_version: this.options.clientVersion,
    };
    const frame = await this.sendRequest('hello', payload, 'hello_ack');
    return frame.payload as { broker_version: string; protocol_version: number };
  }

  private async requestOk<T = unknown>(type: string, payload: unknown): Promise<T> {
    const frame = await this.sendRequest(type, payload, 'ok');
    const result = frame.payload as { result: T };
    return result.result;
  }

  private async sendRequest(
    type: string,
    payload: unknown,
    expectedType: 'ok' | 'hello_ack'
  ): Promise<ProtocolEnvelope<unknown>> {
    if (!this.child) {
      throw new AgentRelayProcessError('broker is not running');
    }

    const requestId = `req_${++this.requestSeq}`;
    const message: ProtocolEnvelope<unknown> = {
      v: PROTOCOL_VERSION,
      type,
      request_id: requestId,
      payload,
    };

    const responsePromise = new Promise<ProtocolEnvelope<unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(
          new AgentRelayProcessError(
            `request timed out after ${this.options.requestTimeoutMs}ms (type='${type}', request_id='${requestId}')`
          )
        );
      }, this.options.requestTimeoutMs);

      this.pending.set(requestId, {
        expectedType,
        resolve,
        reject,
        timeout,
      });
    });

    const line = `${JSON.stringify(message)}\n`;
    if (!this.child.stdin.write(line)) {
      await once(this.child.stdin, 'drain');
    }

    return responsePromise;
  }
}

const CLI_MODEL_FLAG_CLIS = new Set(['claude', 'codex', 'gemini', 'goose', 'aider']);

function buildPtyArgsWithModel(cli: string, args: string[], model?: string): string[] {
  const baseArgs = [...args];
  if (!model) {
    return baseArgs;
  }
  const cliName = cli.split(':')[0].trim().toLowerCase();
  if (!CLI_MODEL_FLAG_CLIS.has(cliName)) {
    return baseArgs;
  }
  if (hasModelArg(baseArgs)) {
    return baseArgs;
  }
  return ['--model', model, ...baseArgs];
}

function hasModelArg(args: string[]): boolean {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--model') {
      return true;
    }
    if (arg.startsWith('--model=')) {
      return true;
    }
  }
  return false;
}

function expandTilde(p: string): string {
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
    const home = os.homedir();
    return path.join(home, p.slice(2));
  }
  return p;
}

function isExplicitPath(binaryPath: string): boolean {
  return (
    binaryPath.includes('/') ||
    binaryPath.includes('\\') ||
    binaryPath.startsWith('.') ||
    binaryPath.startsWith('~')
  );
}

function resolveDefaultBinaryPath(): string {
  const brokerExe = process.platform === 'win32' ? 'agent-relay-broker.exe' : 'agent-relay-broker';
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));

  // 1. In a source checkout, prefer Cargo's release binary to avoid stale bundled
  // copies when local dev rebuilds happen while broker processes are running.
  const workspaceRelease = path.resolve(moduleDir, '..', '..', '..', 'target', 'release', brokerExe);
  if (fs.existsSync(workspaceRelease)) {
    return workspaceRelease;
  }

  // 2. Check for bundled broker binary in SDK package (npm install)
  const bundled = path.resolve(moduleDir, '..', 'bin', brokerExe);
  if (fs.existsSync(bundled)) {
    return bundled;
  }

  // 3. Check for standalone broker binary in ~/.agent-relay/bin/ (install.sh)
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const standaloneBroker = path.join(homeDir, '.agent-relay', 'bin', brokerExe);
  if (fs.existsSync(standaloneBroker)) {
    return standaloneBroker;
  }

  // 4. Fall back to agent-relay on PATH (may be Node CLI — will fail for broker ops)
  return 'agent-relay';
}
