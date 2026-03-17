import { once } from 'node:events';
import { execSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getProjectPaths } from '@agent-relay/config';

import {
  PROTOCOL_VERSION,
  type AgentRuntime,
  type AgentSpec,
  type BrokerEvent,
  type BrokerStats,
  type BrokerStatus,
  type CrashInsightsResponse,
  type HeadlessProvider,
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
  /** When true, skip injecting the relay MCP configuration and protocol prompt into the spawned agent.
   *  Useful for minor tasks where relay messaging is not needed, saving tokens. */
  skipRelayPrompt?: boolean;
}

export interface SpawnHeadlessInput {
  name: string;
  provider: HeadlessProvider;
  args?: string[];
  channels?: string[];
  task?: string;
  /** When true, skip injecting the relay MCP configuration and protocol prompt into the spawned agent.
   *  Useful for minor tasks where relay messaging is not needed, saving tokens. */
  skipRelayPrompt?: boolean;
}

export type AgentTransport = 'pty' | 'headless';

export interface SpawnProviderInput {
  name: string;
  provider: string;
  transport?: AgentTransport;
  args?: string[];
  channels?: string[];
  task?: string;
  model?: string;
  cwd?: string;
  team?: string;
  shadowOf?: string;
  shadowMode?: string;
  idleThresholdSecs?: number;
  restartPolicy?: RestartPolicy;
  continueFrom?: string;
  /** When true, skip injecting the relay MCP configuration and protocol prompt into the spawned agent.
   *  Useful for minor tasks where relay messaging is not needed, saving tokens. */
  skipRelayPrompt?: boolean;
}

export interface SendMessageInput {
  to: string;
  text: string;
  from?: string;
  threadId?: string;
  workspaceId?: string;
  workspaceAlias?: string;
  priority?: number;
  data?: Record<string, unknown>;
}

export interface ListAgent {
  name: string;
  runtime: AgentRuntime;
  provider?: HeadlessProvider;
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

function isHeadlessProvider(value: string): value is HeadlessProvider {
  return value === 'claude' || value === 'opencode';
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
  /** The workspace key returned by the broker in its hello_ack response. */
  workspaceKey?: string;

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

  get brokerPid(): number | undefined {
    return this.child?.pid;
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

  /**
   * Pre-register a batch of agents with Relaycast before their steps execute.
   * The broker warms its token cache in parallel; subsequent spawn_agent calls
   * hit the cache rather than waiting on individual HTTP registrations.
   * Fire-and-forget from the caller's perspective — broker responds immediately
   * and registers in the background.
   */
  async preflightAgents(agents: Array<{ name: string; cli: string | AgentRuntime }>): Promise<void> {
    if (agents.length === 0) return;
    await this.start();
    await this.requestOk<void>('preflight_agents', { agents });
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
      ...(input.skipRelayPrompt != null ? { skip_relay_prompt: input.skipRelayPrompt } : {}),
    });
    return result;
  }

  async spawnHeadless(input: SpawnHeadlessInput): Promise<{ name: string; runtime: AgentRuntime }> {
    await this.start();
    const agent: AgentSpec = {
      name: input.name,
      runtime: 'headless',
      provider: input.provider,
      args: input.args ?? [],
      channels: input.channels ?? [],
    };
    const result = await this.requestOk<{ name: string; runtime: AgentRuntime }>('spawn_agent', {
      agent,
      ...(input.task != null ? { initial_task: input.task } : {}),
      ...(input.skipRelayPrompt != null ? { skip_relay_prompt: input.skipRelayPrompt } : {}),
    });
    return result;
  }

  async spawnProvider(input: SpawnProviderInput): Promise<{ name: string; runtime: AgentRuntime }> {
    const transport = input.transport ?? (input.provider === 'opencode' ? 'headless' : 'pty');
    if (transport === 'headless') {
      if (!isHeadlessProvider(input.provider)) {
        throw new AgentRelayProcessError(
          `provider '${input.provider}' does not support headless transport (supported: claude, opencode)`
        );
      }
      return this.spawnHeadless({
        name: input.name,
        provider: input.provider,
        args: input.args,
        channels: input.channels,
        task: input.task,
        skipRelayPrompt: input.skipRelayPrompt,
      });
    }

    return this.spawnPty({
      name: input.name,
      cli: input.provider,
      args: input.args,
      channels: input.channels,
      task: input.task,
      model: input.model,
      cwd: input.cwd,
      team: input.team,
      shadowOf: input.shadowOf,
      shadowMode: input.shadowMode,
      idleThresholdSecs: input.idleThresholdSecs,
      restartPolicy: input.restartPolicy,
      continueFrom: input.continueFrom,
      skipRelayPrompt: input.skipRelayPrompt,
    });
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
        workspace_id: input.workspaceId,
        workspace_alias: input.workspaceAlias,
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

    void this.requestOk('shutdown', {}).catch(() => {
      // Continue shutdown path if broker is already unhealthy or exits before replying.
    });

    const child = this.child;
    const wait = this.exitPromise ?? Promise.resolve();
    const waitForExit = async (timeoutMs: number): Promise<boolean> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        wait.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
      return result;
    };

    if (await waitForExit(this.options.shutdownTimeoutMs)) {
      return;
    }

    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
    }
    if (await waitForExit(1_000)) {
      return;
    }

    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
    await waitForExit(1_000);
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
      ...(this.options.channels.length > 0 ? ['--channels', this.options.channels.join(',')] : []),
      ...this.options.binaryArgs,
    ];

    // Ensure the SDK bin directory (containing agent-relay-broker) is on
    // PATH so spawned workers can find it without any user setup.
    const env = { ...this.options.env };
    if (isExplicitPath(this.options.binaryPath)) {
      const binDir = path.dirname(path.resolve(resolvedBinary));
      const currentPath = env.PATH ?? env.Path ?? '';
      if (!currentPath.split(path.delimiter).includes(binDir)) {
        env.PATH = `${binDir}${path.delimiter}${currentPath}`;
      }
    }

    console.error(`[broker] Starting: ${resolvedBinary} ${args.join(' ')}`);
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
      // Use 'close' instead of 'exit' so that all buffered stderr/stdout
      // data has been consumed before we build the error message.  The
      // 'exit' event fires when the process terminates, but stdio streams
      // may still have unread data; 'close' fires after both the process
      // exits AND all stdio streams have ended.
      child.once('close', (code, signal) => {
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

    const helloAck = await this.requestHello();
    console.error('[broker] Broker ready (hello handshake complete)');
    if (helloAck.workspace_key) {
      this.workspaceKey = helloAck.workspace_key;
    }
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

  private async requestHello(): Promise<{
    broker_version: string;
    protocol_version: number;
    workspace_key?: string;
  }> {
    const payload = {
      client_name: this.options.clientName,
      client_version: this.options.clientVersion,
    };
    const frame = await this.sendRequest('hello', payload, 'hello_ack');
    return frame.payload as { broker_version: string; protocol_version: number; workspace_key?: string };
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

const CLI_DEFAULT_ARGS: Record<string, string[]> = {
  codex: ['-c', 'check_for_update_on_startup=false'],
};

function buildPtyArgsWithModel(cli: string, args: string[], model?: string): string[] {
  const cliName = cli.split(':')[0].trim().toLowerCase();
  const defaultArgs = CLI_DEFAULT_ARGS[cliName] ?? [];
  const baseArgs = [...defaultArgs, ...args];
  if (!model) {
    return baseArgs;
  }
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

function detectPlatformSuffix(): string | null {
  const platformMap: Record<string, Record<string, string>> = {
    darwin: { arm64: 'darwin-arm64', x64: 'darwin-x64' },
    linux: { arm64: 'linux-arm64', x64: 'linux-x64' },
    win32: { x64: 'win32-x64' },
  };
  return platformMap[process.platform]?.[process.arch] ?? null;
}

function getLatestVersionSync(): string | null {
  try {
    const result = execSync('curl -fsSL https://api.github.com/repos/AgentWorkforce/relay/releases/latest', {
      timeout: 15_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString();
    const match = result.match(/"tag_name"\s*:\s*"([^"]+)"/);
    if (!match?.[1]) return null;
    // Strip tag prefixes: "openclaw-v3.1.18" -> "3.1.18", "v3.1.18" -> "3.1.18"
    return match[1].replace(/^openclaw-/, '').replace(/^v/, '');
  } catch {
    return null;
  }
}

function installBrokerBinary(): string {
  const suffix = detectPlatformSuffix();
  if (!suffix) {
    throw new AgentRelayProcessError(`Unsupported platform: ${process.platform}-${process.arch}`);
  }

  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const installDir = path.join(homeDir, '.agent-relay', 'bin');
  const brokerExe = process.platform === 'win32' ? 'agent-relay-broker.exe' : 'agent-relay-broker';
  const targetPath = path.join(installDir, brokerExe);

  console.log(`[agent-relay] Broker binary not found, installing for ${suffix}...`);

  const version = getLatestVersionSync();
  if (!version) {
    throw new AgentRelayProcessError(
      'Failed to fetch latest agent-relay version from GitHub.\n' +
        'Install manually: curl -fsSL https://raw.githubusercontent.com/AgentWorkforce/relay/main/install.sh | bash'
    );
  }

  const binaryName = `agent-relay-broker-${suffix}`;
  const downloadUrl = `https://github.com/AgentWorkforce/relay/releases/download/v${version}/${binaryName}`;

  console.log(`[agent-relay] Downloading v${version} from ${downloadUrl}`);

  try {
    fs.mkdirSync(installDir, { recursive: true });
    execSync(`curl -fsSL "${downloadUrl}" -o "${targetPath}"`, {
      timeout: 60_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    fs.chmodSync(targetPath, 0o755);

    // macOS: strip quarantine attribute and re-sign to avoid Gatekeeper issues
    if (process.platform === 'darwin') {
      try {
        execSync(`xattr -d com.apple.quarantine "${targetPath}" 2>/dev/null || true`, {
          timeout: 10_000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch {
        // Non-fatal
      }
      try {
        execSync(`codesign --force --sign - "${targetPath}"`, {
          timeout: 10_000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch {
        // Non-fatal
      }
    }

    // Verify
    execSync(`"${targetPath}" --help`, { timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) {
    try {
      fs.unlinkSync(targetPath);
    } catch {
      /* ignore */
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new AgentRelayProcessError(
      `Failed to install broker binary: ${message}\n` +
        'Install manually: curl -fsSL https://raw.githubusercontent.com/AgentWorkforce/relay/main/install.sh | bash'
    );
  }

  console.log(`[agent-relay] Broker installed to ${targetPath}`);
  return targetPath;
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

  // 2. Check for bundled platform-specific broker binary in SDK package (npm install).
  //    Only use binaries that match the current platform to avoid running
  //    e.g. a macOS binary on Linux (or vice-versa).
  const binDir = path.resolve(moduleDir, '..', 'bin');
  const suffix = detectPlatformSuffix();
  if (suffix) {
    const ext = process.platform === 'win32' ? '.exe' : '';
    const platformBinary = path.join(binDir, `agent-relay-broker-${suffix}${ext}`);
    if (fs.existsSync(platformBinary)) {
      return platformBinary;
    }
  }

  // 3. Check for standalone broker binary in ~/.agent-relay/bin/ (install.sh)
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const standaloneBroker = path.join(homeDir, '.agent-relay', 'bin', brokerExe);
  if (fs.existsSync(standaloneBroker)) {
    return standaloneBroker;
  }

  // 4. Auto-install from GitHub releases
  return installBrokerBinary();
}

// ---------------------------------------------------------------------------
// HTTP transport client — connects to an already-running broker's HTTP API
// ---------------------------------------------------------------------------

export interface HttpAgentRelayClientOptions {
  port: number;
  apiKey?: string;
}

export interface DiscoverAndConnectOptions {
  cwd?: string;
  apiKey?: string;
  /** Auto-start the broker if not running (default: false). */
  autoStart?: boolean;
  /**
   * Path to the broker binary for auto-start.
   * If not provided, the SDK resolves it automatically via standard install locations
   * (~/.agent-relay/bin, bundled platform binary, or Cargo release build).
   * Only used when `autoStart: true`.
   */
  brokerBinaryPath?: string;
}

const DEFAULT_DASHBOARD_PORT = (() => {
  const envPort = typeof process !== 'undefined' ? process.env.AGENT_RELAY_DASHBOARD_PORT : undefined;
  if (envPort) {
    const parsed = Number.parseInt(envPort, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 3888;
})();
const HTTP_MAX_PORT_SCAN = 25;
const HTTP_AUTOSTART_TIMEOUT_MS = 10_000;
const HTTP_AUTOSTART_POLL_MS = 250;

function sanitizeBrokerName(name: string): string {
  return name.replace(/[^\p{L}\p{N}-]/gu, '-');
}

function brokerPidFilename(projectRoot: string): string {
  const brokerName = path.basename(projectRoot) || 'project';
  return `broker-${sanitizeBrokerName(brokerName)}.pid`;
}

export class HttpAgentRelayClient {
  private readonly port: number;
  private readonly apiKey?: string;

  constructor(options: HttpAgentRelayClientOptions) {
    this.port = options.port;
    this.apiKey = options.apiKey;
  }

  /**
   * Connect to an already-running broker on the given port.
   */
  static async connectHttp(
    port: number,
    options?: { apiKey?: string }
  ): Promise<HttpAgentRelayClient> {
    const client = new HttpAgentRelayClient({ port, apiKey: options?.apiKey });
    // Verify connectivity
    await client.healthCheck();
    return client;
  }

  /**
   * Discover a running broker for the current project and connect to it.
   * Reads the broker PID file, verifies the process is alive, scans ports
   * for the HTTP API, and returns a connected client.
   */
  static async discoverAndConnect(
    options?: DiscoverAndConnectOptions
  ): Promise<HttpAgentRelayClient> {
    const cwd = options?.cwd ?? process.cwd();
    const apiKey = options?.apiKey ?? process.env.RELAY_BROKER_API_KEY?.trim();
    const autoStart = options?.autoStart ?? false;
    const paths = getProjectPaths(cwd);
    const preferredApiPort = DEFAULT_DASHBOARD_PORT + 1;

    // Try to find a running broker via PID file
    const pidFilePath = path.join(paths.dataDir, brokerPidFilename(paths.projectRoot));
    const legacyPidPath = path.join(paths.dataDir, 'broker.pid');
    let brokerRunning = false;

    for (const pidPath of [pidFilePath, legacyPidPath]) {
      if (fs.existsSync(pidPath)) {
        const pidStr = fs.readFileSync(pidPath, 'utf-8').trim();
        const pid = Number.parseInt(pidStr, 10);
        if (Number.isFinite(pid) && pid > 0) {
          try {
            process.kill(pid, 0);
            brokerRunning = true;
            break;
          } catch {
            // Process not running
          }
        }
      }
    }

    if (brokerRunning) {
      const port = await HttpAgentRelayClient.scanForBrokerPort(preferredApiPort);
      if (port !== null) {
        return new HttpAgentRelayClient({ port, apiKey });
      }
      throw new AgentRelayProcessError(
        'broker is running for this project, but its local API is unavailable'
      );
    }

    if (!autoStart) {
      throw new AgentRelayProcessError('broker is not running for this project');
    }

    // Auto-start the broker using the resolved binary path (not process.argv[1],
    // which only works from CLI context — breaks when SDK is imported by user apps).
    // The broker binary requires the `init` subcommand with `--api-port` and
    // `--persist` so it writes PID files for subsequent discovery.
    const brokerBinary = options?.brokerBinaryPath ?? resolveDefaultBinaryPath();

    const child = spawn(
      brokerBinary,
      ['init', '--persist', '--api-port', String(preferredApiPort)],
      {
        cwd: paths.projectRoot,
        env: process.env,
        detached: true,
        stdio: 'ignore',
      }
    );
    child.unref();

    const startedAt = Date.now();
    while (Date.now() - startedAt < HTTP_AUTOSTART_TIMEOUT_MS) {
      const port = await HttpAgentRelayClient.scanForBrokerPort(preferredApiPort);
      if (port !== null) {
        return new HttpAgentRelayClient({ port, apiKey });
      }
      await new Promise((resolve) => setTimeout(resolve, HTTP_AUTOSTART_POLL_MS));
    }

    throw new AgentRelayProcessError(
      `broker did not become ready within ${HTTP_AUTOSTART_TIMEOUT_MS}ms`
    );
  }

  private static async scanForBrokerPort(startPort: number): Promise<number | null> {
    for (let i = 0; i < HTTP_MAX_PORT_SCAN; i++) {
      const port = startPort + i;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        if (!res.ok) continue;
        const payload = (await res.json().catch(() => null)) as { service?: string } | null;
        if (payload?.service === 'agent-relay-listen') {
          return port;
        }
      } catch {
        // Keep scanning
      }
    }
    return null;
  }

  private async request<T = unknown>(pathname: string, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers);
    if (this.apiKey && !headers.has('x-api-key') && !headers.has('authorization')) {
      headers.set('x-api-key', this.apiKey);
    }

    const response = await fetch(`http://127.0.0.1:${this.port}${pathname}`, {
      ...init,
      headers,
    });

    const text = await response.text();
    let payload: unknown;
    try {
      payload = text ? JSON.parse(text) : undefined;
    } catch {
      payload = text;
    }

    if (!response.ok) {
      const msg = HttpAgentRelayClient.extractErrorMessage(response, payload);
      throw new AgentRelayProcessError(msg);
    }

    return payload as T;
  }

  private static extractErrorMessage(response: Response, payload: unknown): string {
    if (typeof payload === 'string' && payload.trim()) return payload.trim();
    const p = payload as Record<string, unknown> | undefined;
    if (typeof p?.error === 'string') return p.error;
    if (typeof (p?.error as Record<string, unknown>)?.message === 'string')
      return (p!.error as Record<string, unknown>).message as string;
    if (typeof p?.message === 'string' && (p.message as string).trim())
      return (p.message as string).trim();
    return `${response.status} ${response.statusText}`.trim();
  }

  async healthCheck(): Promise<{ service: string }> {
    return this.request<{ service: string }>('/health');
  }

  /** No-op — broker is already running. */
  async start(): Promise<void> {}

  /** No-op — don't kill an externally-managed broker. */
  async shutdown(): Promise<void> {}

  async spawnPty(input: SpawnPtyInput): Promise<{ name: string; runtime: AgentRuntime }> {
    const payload = await this.request<{ name?: string }>('/api/spawn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
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
    return {
      name: typeof payload?.name === 'string' ? payload.name : input.name,
      runtime: 'pty',
    };
  }

  async sendMessage(input: SendMessageInput): Promise<{ event_id: string; targets: string[] }> {
    return this.request<{ event_id: string; targets: string[] }>('/api/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        to: input.to,
        text: input.text,
        from: input.from,
        threadId: input.threadId,
        workspaceId: input.workspaceId,
        workspaceAlias: input.workspaceAlias,
        priority: input.priority,
        data: input.data,
      }),
    });
  }

  async listAgents(): Promise<ListAgent[]> {
    const payload = await this.request<{ agents?: ListAgent[] }>('/api/spawned', { method: 'GET' });
    return Array.isArray(payload?.agents) ? payload.agents : [];
  }

  async release(name: string, reason?: string): Promise<{ name: string }> {
    const payload = await this.request<{ name?: string }>(
      `/api/spawned/${encodeURIComponent(name)}`,
      {
        method: 'DELETE',
        ...(reason
          ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason }) }
          : {}),
      }
    );
    return { name: typeof payload?.name === 'string' ? payload.name : name };
  }

  async setModel(
    name: string,
    model: string,
    opts?: { timeoutMs?: number }
  ): Promise<{ name: string; model: string; success: boolean }> {
    const payload = await this.request<{ success?: boolean; model?: string }>(
      `/api/spawned/${encodeURIComponent(name)}/model`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, timeoutMs: opts?.timeoutMs }),
      }
    );
    return {
      name,
      model: typeof payload?.model === 'string' ? payload.model : model,
      success: payload?.success !== false,
    };
  }

  async getConfig(): Promise<{ workspace_key?: string }> {
    return this.request<{ workspace_key?: string }>('/api/config');
  }
}
