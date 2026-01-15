/**
 * RelayPtyOrchestrator - Orchestrates the relay-pty Rust binary
 *
 * This wrapper spawns the relay-pty binary and communicates via Unix socket.
 * It provides the same interface as PtyWrapper but with improved latency
 * (~550ms vs ~1700ms) by using direct PTY writes instead of tmux send-keys.
 *
 * Architecture:
 * 1. Spawn relay-pty --name {agentName} -- {command} as child process
 * 2. Connect to /tmp/relay-pty-{agentName}.sock for injection
 * 3. Parse stdout for relay commands (relay-pty echoes all output)
 * 4. Translate SEND envelopes → inject messages via socket
 *
 * @see docs/RUST_WRAPPER_DESIGN.md for protocol details
 */

import { spawn, ChildProcess } from 'node:child_process';
import { createConnection, Socket } from 'node:net';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { BaseWrapper, type BaseWrapperConfig } from './base-wrapper.js';
import { OutputParser, type ParsedCommand, parseSummaryWithDetails, parseSessionEndFromOutput } from './parser.js';
import type { SendPayload, SendMeta } from '../protocol/types.js';
import {
  type QueuedMessage,
  stripAnsi,
  sleep,
  buildInjectionString,
  INJECTION_CONSTANTS,
} from './shared.js';

// ============================================================================
// Types for relay-pty socket protocol
// ============================================================================

/**
 * Request types sent to relay-pty socket
 */
interface InjectRequest {
  type: 'inject';
  id: string;
  from: string;
  body: string;
  priority: number;
}

interface StatusRequest {
  type: 'status';
}

interface ShutdownRequest {
  type: 'shutdown';
}

type RelayPtyRequest = InjectRequest | StatusRequest | ShutdownRequest;

/**
 * Response types received from relay-pty socket
 */
interface InjectResultResponse {
  type: 'inject_result';
  id: string;
  status: 'queued' | 'injecting' | 'delivered' | 'failed';
  timestamp: number;
  error?: string;
}

interface StatusResponse {
  type: 'status';
  agent_idle: boolean;
  queue_length: number;
  cursor_position?: [number, number];
  last_output_ms: number;
}

interface BackpressureResponse {
  type: 'backpressure';
  queue_length: number;
  accept: boolean;
}

interface ErrorResponse {
  type: 'error';
  message: string;
}

interface ShutdownAckResponse {
  type: 'shutdown_ack';
}

type RelayPtyResponse =
  | InjectResultResponse
  | StatusResponse
  | BackpressureResponse
  | ErrorResponse
  | ShutdownAckResponse;

/**
 * Configuration for RelayPtyOrchestrator
 */
export interface RelayPtyOrchestratorConfig extends BaseWrapperConfig {
  /** Path to relay-pty binary (default: searches PATH and ./relay-pty/target/release) */
  relayPtyPath?: string;
  /** Socket connect timeout in ms (default: 5000) */
  socketConnectTimeoutMs?: number;
  /** Socket reconnect attempts (default: 3) */
  socketReconnectAttempts?: number;
  /** Callback when agent exits */
  onExit?: (code: number) => void;
  /** Callback when injection fails after retries */
  onInjectionFailed?: (messageId: string, error: string) => void;
}

/**
 * Events emitted by RelayPtyOrchestrator
 */
export interface RelayPtyOrchestratorEvents {
  output: (data: string) => void;
  exit: (code: number) => void;
  error: (error: Error) => void;
  'injection-failed': (event: { messageId: string; from: string; error: string }) => void;
  'backpressure': (event: { queueLength: number; accept: boolean }) => void;
  'summary': (event: { agentName: string; summary: unknown }) => void;
  'session-end': (event: { agentName: string; marker: unknown }) => void;
}

/**
 * Orchestrator for relay-pty Rust binary
 *
 * Extends BaseWrapper to provide the same interface as PtyWrapper
 * but uses the relay-pty binary for improved injection reliability.
 */
export class RelayPtyOrchestrator extends BaseWrapper {
  protected override config: RelayPtyOrchestratorConfig;

  // Process management
  private relayPtyProcess?: ChildProcess;
  private socketPath: string;
  private socket?: Socket;
  private socketConnected = false;

  // Output buffering
  private outputBuffer = '';
  private rawBuffer = '';
  private lastParsedLength = 0;

  // Injection state
  private pendingInjections: Map<string, {
    resolve: (success: boolean) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }> = new Map();
  private backpressureActive = false;
  private readyForMessages = false;

  // Session state
  private sessionEndProcessed = false;
  private lastSummaryRawContent = '';

  constructor(config: RelayPtyOrchestratorConfig) {
    super(config);
    this.config = config;
    this.socketPath = `/tmp/relay-pty-${config.name}.sock`;
  }

  // =========================================================================
  // Abstract method implementations (required by BaseWrapper)
  // =========================================================================

  /**
   * Start the relay-pty process and connect to socket
   */
  override async start(): Promise<void> {
    if (this.running) return;

    console.log(`[relay-pty-orchestrator:${this.config.name}] Starting...`);

    // Find relay-pty binary
    const binaryPath = this.findRelayPtyBinary();
    if (!binaryPath) {
      throw new Error('relay-pty binary not found. Build with: cd relay-pty && cargo build --release');
    }

    console.log(`[relay-pty-orchestrator:${this.config.name}] Using binary: ${binaryPath}`);

    // Connect to relay daemon first
    try {
      await this.client.connect();
      console.log(`[relay-pty-orchestrator:${this.config.name}] Relay daemon connected`);
    } catch (err: any) {
      console.error(`[relay-pty-orchestrator:${this.config.name}] Relay connect failed: ${err.message}`);
    }

    // Spawn relay-pty process
    await this.spawnRelayPty(binaryPath);

    // Wait for socket to become available and connect
    await this.connectToSocket();

    this.running = true;
    this.readyForMessages = true;

    console.log(`[relay-pty-orchestrator:${this.config.name}] Ready for messages`);

    // Process any queued messages
    this.processMessageQueue();
  }

  /**
   * Stop the relay-pty process gracefully
   */
  override async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    console.log(`[relay-pty-orchestrator:${this.config.name}] Stopping...`);

    // Send shutdown command via socket
    if (this.socket && this.socketConnected) {
      try {
        await this.sendSocketRequest({ type: 'shutdown' });
      } catch {
        // Ignore errors during shutdown
      }
    }

    // Close socket
    this.disconnectSocket();

    // Kill process if still running
    if (this.relayPtyProcess && !this.relayPtyProcess.killed) {
      this.relayPtyProcess.kill('SIGTERM');

      // Force kill after timeout
      await Promise.race([
        new Promise<void>((resolve) => {
          this.relayPtyProcess?.on('exit', () => resolve());
        }),
        sleep(5000).then(() => {
          if (this.relayPtyProcess && !this.relayPtyProcess.killed) {
            this.relayPtyProcess.kill('SIGKILL');
          }
        }),
      ]);
    }

    // Cleanup relay client
    this.destroyClient();

    console.log(`[relay-pty-orchestrator:${this.config.name}] Stopped`);
  }

  /**
   * Inject content into the agent via socket
   */
  protected async performInjection(content: string): Promise<void> {
    // This is called by BaseWrapper but we handle injection differently
    // via the socket protocol in processMessageQueue
    throw new Error('Use injectMessage() instead of performInjection()');
  }

  /**
   * Get cleaned output for parsing
   */
  protected getCleanOutput(): string {
    return stripAnsi(this.rawBuffer);
  }

  // =========================================================================
  // Process management
  // =========================================================================

  /**
   * Find the relay-pty binary
   */
  private findRelayPtyBinary(): string | null {
    // Check config path first
    if (this.config.relayPtyPath && existsSync(this.config.relayPtyPath)) {
      return this.config.relayPtyPath;
    }

    // Check common locations
    const candidates = [
      // Local build
      join(process.cwd(), 'relay-pty', 'target', 'release', 'relay-pty'),
      join(process.cwd(), 'relay-pty', 'target', 'debug', 'relay-pty'),
      // Installed
      '/usr/local/bin/relay-pty',
      // In node_modules (future: npm package)
      join(process.cwd(), 'node_modules', '.bin', 'relay-pty'),
    ];

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  /**
   * Spawn the relay-pty process
   */
  private async spawnRelayPty(binaryPath: string): Promise<void> {
    const args = [
      '--name', this.config.name,
      '--socket', this.socketPath,
      '--idle-timeout', String(this.config.idleBeforeInjectMs ?? 500),
      '--', this.config.command,
      ...(this.config.args ?? []),
    ];

    console.log(`[relay-pty-orchestrator:${this.config.name}] Spawning: ${binaryPath} ${args.join(' ')}`);

    this.relayPtyProcess = spawn(binaryPath, args, {
      cwd: this.config.cwd ?? process.cwd(),
      env: {
        ...process.env,
        ...this.config.env,
        AGENT_RELAY_NAME: this.config.name,
        TERM: 'xterm-256color',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Handle stdout (agent output)
    this.relayPtyProcess.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      this.handleOutput(text);
    });

    // Handle stderr (relay-pty logs and JSON output)
    this.relayPtyProcess.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      this.handleStderr(text);
    });

    // Handle exit
    this.relayPtyProcess.on('exit', (code, signal) => {
      const exitCode = code ?? (signal === 'SIGKILL' ? 137 : 1);
      console.log(`[relay-pty-orchestrator:${this.config.name}] Process exited: code=${exitCode} signal=${signal}`);
      this.running = false;
      this.emit('exit', exitCode);
      this.config.onExit?.(exitCode);
    });

    // Handle error
    this.relayPtyProcess.on('error', (err) => {
      console.error(`[relay-pty-orchestrator:${this.config.name}] Process error: ${err.message}`);
      this.emit('error', err);
    });

    // Wait for process to start
    await sleep(500);

    if (this.relayPtyProcess.exitCode !== null) {
      throw new Error(`relay-pty exited immediately with code ${this.relayPtyProcess.exitCode}`);
    }
  }

  /**
   * Handle output from relay-pty stdout
   */
  private handleOutput(data: string): void {
    this.rawBuffer += data;
    this.outputBuffer += data;

    // Feed to idle detector
    this.feedIdleDetectorOutput(data);

    // Emit output event
    this.emit('output', data);

    // Stream to daemon if configured
    if (this.config.streamLogs !== false && this.client.state === 'READY') {
      this.client.sendLog(data);
    }

    // Parse for relay commands
    this.parseRelayCommands();

    // Check for summary and session end
    const cleanContent = stripAnsi(this.rawBuffer);
    this.checkForSummary(cleanContent);
    this.checkForSessionEnd(cleanContent);
  }

  /**
   * Handle stderr from relay-pty (logs and JSON parsed commands)
   */
  private handleStderr(data: string): void {
    // relay-pty can output JSON parsed commands to stderr with --json-output
    // For now, just log to console for debugging
    const lines = data.split('\n').filter(l => l.trim());
    for (const line of lines) {
      if (line.startsWith('{')) {
        // JSON output - could be parsed relay command
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === 'relay_command') {
            console.log(`[relay-pty-orchestrator:${this.config.name}] Parsed command: ${parsed.from} -> ${parsed.to}`);
          }
        } catch {
          // Not JSON, just log
          console.error(`[relay-pty:${this.config.name}] ${line}`);
        }
      } else {
        console.error(`[relay-pty:${this.config.name}] ${line}`);
      }
    }
  }

  // =========================================================================
  // Socket communication
  // =========================================================================

  /**
   * Connect to the relay-pty socket
   */
  private async connectToSocket(): Promise<void> {
    const timeout = this.config.socketConnectTimeoutMs ?? 5000;
    const maxAttempts = this.config.socketReconnectAttempts ?? 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.attemptSocketConnection(timeout);
        console.log(`[relay-pty-orchestrator:${this.config.name}] Socket connected`);
        return;
      } catch (err: any) {
        console.warn(`[relay-pty-orchestrator:${this.config.name}] Socket connect attempt ${attempt}/${maxAttempts} failed: ${err.message}`);
        if (attempt < maxAttempts) {
          await sleep(1000 * attempt); // Exponential backoff
        }
      }
    }

    throw new Error(`Failed to connect to socket after ${maxAttempts} attempts`);
  }

  /**
   * Attempt a single socket connection
   */
  private attemptSocketConnection(timeout: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Socket connection timeout'));
      }, timeout);

      this.socket = createConnection(this.socketPath, () => {
        clearTimeout(timer);
        this.socketConnected = true;
        resolve();
      });

      this.socket.on('error', (err) => {
        clearTimeout(timer);
        this.socketConnected = false;
        reject(err);
      });

      this.socket.on('close', () => {
        this.socketConnected = false;
        console.log(`[relay-pty-orchestrator:${this.config.name}] Socket closed`);
      });

      // Handle incoming data (responses)
      let buffer = '';
      this.socket.on('data', (data: Buffer) => {
        buffer += data.toString();

        // Process complete lines
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? ''; // Keep incomplete line in buffer

        for (const line of lines) {
          if (line.trim()) {
            this.handleSocketResponse(line);
          }
        }
      });
    });
  }

  /**
   * Disconnect from socket
   */
  private disconnectSocket(): void {
    if (this.socket) {
      this.socket.destroy();
      this.socket = undefined;
      this.socketConnected = false;
    }

    // Reject all pending injections
    for (const [id, pending] of this.pendingInjections) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Socket disconnected'));
    }
    this.pendingInjections.clear();
  }

  /**
   * Send a request to the socket and optionally wait for response
   */
  private sendSocketRequest(request: RelayPtyRequest): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.socketConnected) {
        reject(new Error('Socket not connected'));
        return;
      }

      const json = JSON.stringify(request) + '\n';
      this.socket.write(json, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Handle a response from the socket
   */
  private handleSocketResponse(line: string): void {
    try {
      const response = JSON.parse(line) as RelayPtyResponse;

      switch (response.type) {
        case 'inject_result':
          this.handleInjectResult(response);
          break;

        case 'status':
          // Status responses are typically requested explicitly
          console.log(`[relay-pty-orchestrator:${this.config.name}] Status: idle=${response.agent_idle} queue=${response.queue_length}`);
          break;

        case 'backpressure':
          this.handleBackpressure(response);
          break;

        case 'error':
          console.error(`[relay-pty-orchestrator:${this.config.name}] Socket error: ${response.message}`);
          break;

        case 'shutdown_ack':
          console.log(`[relay-pty-orchestrator:${this.config.name}] Shutdown acknowledged`);
          break;
      }
    } catch (err: any) {
      console.error(`[relay-pty-orchestrator:${this.config.name}] Failed to parse socket response: ${err.message}`);
    }
  }

  /**
   * Handle injection result response
   */
  private handleInjectResult(response: InjectResultResponse): void {
    const pending = this.pendingInjections.get(response.id);
    if (!pending) {
      // Response for unknown message - might be from a previous session
      return;
    }

    if (response.status === 'delivered') {
      clearTimeout(pending.timeout);
      this.pendingInjections.delete(response.id);
      pending.resolve(true);
      console.log(`[relay-pty-orchestrator:${this.config.name}] Message ${response.id.substring(0, 8)} delivered`);
    } else if (response.status === 'failed') {
      clearTimeout(pending.timeout);
      this.pendingInjections.delete(response.id);
      pending.resolve(false);
      console.error(`[relay-pty-orchestrator:${this.config.name}] Message ${response.id.substring(0, 8)} failed: ${response.error}`);
      this.emit('injection-failed', {
        messageId: response.id,
        from: 'unknown',
        error: response.error ?? 'Unknown error',
      });
    }
    // queued/injecting are intermediate states - wait for final status
  }

  /**
   * Handle backpressure notification
   */
  private handleBackpressure(response: BackpressureResponse): void {
    const wasActive = this.backpressureActive;
    this.backpressureActive = !response.accept;

    if (this.backpressureActive !== wasActive) {
      console.log(`[relay-pty-orchestrator:${this.config.name}] Backpressure: ${this.backpressureActive ? 'ACTIVE' : 'cleared'} (queue=${response.queue_length})`);
      this.emit('backpressure', { queueLength: response.queue_length, accept: response.accept });

      // Resume processing if backpressure cleared
      if (!this.backpressureActive) {
        this.processMessageQueue();
      }
    }
  }

  // =========================================================================
  // Message handling
  // =========================================================================

  /**
   * Inject a message into the agent via socket
   */
  private async injectMessage(msg: QueuedMessage): Promise<boolean> {
    if (!this.socket || !this.socketConnected) {
      console.error(`[relay-pty-orchestrator:${this.config.name}] Cannot inject - socket not connected`);
      return false;
    }

    // Build injection content
    const content = buildInjectionString(msg);

    // Create request
    const request: InjectRequest = {
      type: 'inject',
      id: msg.messageId,
      from: msg.from,
      body: content,
      priority: msg.importance ?? 0,
    };

    // Create promise for result
    return new Promise<boolean>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingInjections.delete(msg.messageId);
        resolve(false); // Timeout = failure
      }, 30000); // 30 second timeout for injection

      this.pendingInjections.set(msg.messageId, { resolve, reject, timeout });

      // Send request
      this.sendSocketRequest(request).catch((err) => {
        clearTimeout(timeout);
        this.pendingInjections.delete(msg.messageId);
        resolve(false);
      });
    });
  }

  /**
   * Process queued messages
   */
  private async processMessageQueue(): Promise<void> {
    if (!this.readyForMessages || this.backpressureActive || this.isInjecting) {
      return;
    }

    if (this.messageQueue.length === 0) {
      return;
    }

    this.isInjecting = true;

    const msg = this.messageQueue.shift()!;
    const bodyPreview = msg.body.substring(0, 50).replace(/\n/g, '\\n');
    console.log(`[relay-pty-orchestrator:${this.config.name}] Processing message from ${msg.from}: "${bodyPreview}..." (remaining=${this.messageQueue.length})`);

    try {
      const success = await this.injectMessage(msg);

      if (!success) {
        console.error(`[relay-pty-orchestrator:${this.config.name}] Injection failed for message ${msg.messageId.substring(0, 8)}`);
        this.injectionMetrics.failed++;
        this.config.onInjectionFailed?.(msg.messageId, 'Injection failed');
      } else {
        this.injectionMetrics.successFirstTry++;
      }

      this.injectionMetrics.total++;
    } catch (err: any) {
      console.error(`[relay-pty-orchestrator:${this.config.name}] Injection error: ${err.message}`);
      this.injectionMetrics.failed++;
      this.injectionMetrics.total++;
    } finally {
      this.isInjecting = false;

      // Process next message after delay
      if (this.messageQueue.length > 0 && !this.backpressureActive) {
        setTimeout(() => this.processMessageQueue(), INJECTION_CONSTANTS.QUEUE_PROCESS_DELAY_MS);
      }
    }
  }

  /**
   * Override handleIncomingMessage to trigger queue processing
   */
  protected override handleIncomingMessage(
    from: string,
    payload: SendPayload,
    messageId: string,
    meta?: SendMeta,
    originalTo?: string
  ): void {
    super.handleIncomingMessage(from, payload, messageId, meta, originalTo);
    this.processMessageQueue();
  }

  // =========================================================================
  // Output parsing
  // =========================================================================

  /**
   * Parse relay commands from output
   */
  private parseRelayCommands(): void {
    const cleanContent = stripAnsi(this.rawBuffer);

    if (cleanContent.length <= this.lastParsedLength) {
      return;
    }

    // Parse new content with lookback for fenced messages
    const lookbackStart = Math.max(0, this.lastParsedLength - 500);
    const contentToParse = cleanContent.substring(lookbackStart);

    // Parse fenced messages
    this.parseFencedMessages(contentToParse);

    // Parse single-line messages
    this.parseSingleLineMessages(contentToParse);

    // Parse spawn/release commands
    this.parseSpawnReleaseCommands(contentToParse);

    this.lastParsedLength = cleanContent.length;
  }

  /**
   * Parse fenced multi-line messages
   */
  private parseFencedMessages(content: string): void {
    const escapedPrefix = this.relayPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const fencePattern = new RegExp(
      `${escapedPrefix}(\\S+)(?:\\s+\\[thread:([\\w-]+)\\])?\\s*<<<([\\s\\S]*?)>>>`,
      'g'
    );

    let match;
    while ((match = fencePattern.exec(content)) !== null) {
      const target = match[1];
      const thread = match[2];
      const body = match[3].trim();

      if (!body || target === 'spawn' || target === 'release') {
        continue;
      }

      this.sendRelayCommand({
        to: target,
        kind: 'message',
        body,
        thread,
        raw: match[0],
      });
    }
  }

  /**
   * Parse single-line messages
   */
  private parseSingleLineMessages(content: string): void {
    const lines = content.split('\n');
    const escapedPrefix = this.relayPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`${escapedPrefix}(\\S+)(?:\\s+\\[thread:([\\w-]+)\\])?\\s+(.+)$`);

    for (const line of lines) {
      // Skip fenced messages
      if (line.includes('<<<') || line.includes('>>>')) {
        continue;
      }

      const match = line.match(pattern);
      if (!match) {
        continue;
      }

      const target = match[1];
      const thread = match[2];
      const body = match[3].trim();

      if (!body || target === 'spawn' || target === 'release') {
        continue;
      }

      this.sendRelayCommand({
        to: target,
        kind: 'message',
        body,
        thread,
        raw: line,
      });
    }
  }

  // =========================================================================
  // Summary and session end detection
  // =========================================================================

  /**
   * Check for [[SUMMARY]] blocks
   */
  private checkForSummary(content: string): void {
    const result = parseSummaryWithDetails(content);
    if (!result.found || !result.valid) {
      return;
    }

    if (result.rawContent === this.lastSummaryRawContent) {
      return;
    }
    this.lastSummaryRawContent = result.rawContent ?? '';

    this.emit('summary', {
      agentName: this.config.name,
      summary: result.summary,
    });
  }

  /**
   * Check for [[SESSION_END]] blocks
   */
  private checkForSessionEnd(content: string): void {
    if (this.sessionEndProcessed) {
      return;
    }

    const sessionEnd = parseSessionEndFromOutput(content);
    if (!sessionEnd) {
      return;
    }

    this.sessionEndProcessed = true;
    this.emit('session-end', {
      agentName: this.config.name,
      marker: sessionEnd,
    });
  }

  // =========================================================================
  // Public API
  // =========================================================================

  /**
   * Query status from relay-pty
   */
  async queryStatus(): Promise<StatusResponse | null> {
    if (!this.socket || !this.socketConnected) {
      return null;
    }

    try {
      await this.sendSocketRequest({ type: 'status' });
      // Response will come asynchronously via handleSocketResponse
      // For now, return null - could implement request/response matching
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Get raw output buffer
   */
  getRawOutput(): string {
    return this.rawBuffer;
  }

  /**
   * Check if backpressure is active
   */
  isBackpressureActive(): boolean {
    return this.backpressureActive;
  }

  /**
   * Get the socket path
   */
  getSocketPath(): string {
    return this.socketPath;
  }

  /**
   * Get the relay-pty process PID
   */
  get pid(): number | undefined {
    return this.relayPtyProcess?.pid;
  }
}
