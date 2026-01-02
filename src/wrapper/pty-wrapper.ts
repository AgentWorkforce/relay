/**
 * PtyWrapper - Node-PTY based wrapper for spawned workers
 *
 * Unlike TmuxWrapper which provides interactive terminal access,
 * PtyWrapper runs agents headlessly with output capture for logs.
 * Used for spawned workers that don't need direct user interaction.
 */

import * as pty from 'node-pty';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { RelayClient } from './client.js';
import type { ParsedCommand } from './parser.js';
import type { SendPayload, SendMeta, SpeakOnTrigger } from '../protocol/types.js';
import {
  type QueuedMessage,
  type InjectionResult,
  type InjectionMetrics,
  type CliType,
  INJECTION_CONSTANTS,
  stripAnsi,
  sleep,
  buildInjectionString,
  calculateSuccessRate,
  createInjectionMetrics,
  getDefaultRelayPrefix,
  detectCliType,
  CLI_QUIRKS,
} from './shared.js';

/** Maximum lines to keep in output buffer */
const MAX_BUFFER_LINES = 10000;

export interface PtyWrapperConfig {
  name: string;
  command: string;
  args?: string[];
  socketPath?: string;
  cwd?: string;
  env?: Record<string, string>;
  /** Relay prefix pattern (default: '->relay:') */
  relayPrefix?: string;
  /** CLI type for special handling (auto-detected from command if not set) */
  cliType?: CliType;
  /** Directory to write log files (optional) */
  logsDir?: string;
  /** Dashboard port for spawn/release API calls (enables nested spawning from spawned agents) */
  dashboardPort?: number;
  /** Callback for spawn commands (fallback if dashboardPort not set) */
  onSpawn?: (name: string, cli: string, task: string) => Promise<void>;
  /** Callback for release commands (fallback if dashboardPort not set) */
  onRelease?: (name: string) => Promise<void>;
  /** Callback when agent exits */
  onExit?: (code: number) => void;
  /** Primary agent to shadow (if this agent is a shadow) */
  shadowOf?: string;
  /** When the shadow should speak (default: ['EXPLICIT_ASK']) */
  shadowSpeakOn?: SpeakOnTrigger[];
  /** Stream output to daemon for dashboard log viewing (default: true) */
  streamLogs?: boolean;
}

export interface InjectionFailedEvent {
  messageId: string;
  from: string;
  attempts: number;
}

export interface PtyWrapperEvents {
  output: (data: string) => void;
  exit: (code: number) => void;
  error: (error: Error) => void;
  'injection-failed': (event: InjectionFailedEvent) => void;
}

export class PtyWrapper extends EventEmitter {
  private config: PtyWrapperConfig;
  private ptyProcess?: pty.IPty;
  private client: RelayClient;
  private running = false;
  private outputBuffer: string[] = [];
  private rawBuffer = '';
  private relayPrefix: string;
  private cliType: CliType;
  private sentMessageHashes: Set<string> = new Set();
  private processedSpawnCommands: Set<string> = new Set();
  private processedReleaseCommands: Set<string> = new Set();
  private messageQueue: QueuedMessage[] = [];
  private isInjecting = false;
  private readyForMessages = false;
  private lastOutputTime = 0;
  private injectionMetrics: InjectionMetrics = createInjectionMetrics();
  private logFilePath?: string;
  private logStream?: fs.WriteStream;
  private hasAcceptedPrompt = false;

  constructor(config: PtyWrapperConfig) {
    super();
    this.config = config;
    this.relayPrefix = config.relayPrefix ?? getDefaultRelayPrefix();

    // Detect CLI type from command for special handling
    this.cliType = config.cliType ?? detectCliType(config.command);

    this.client = new RelayClient({
      agentName: config.name,
      socketPath: config.socketPath,
      cli: this.cliType,
      workingDirectory: config.cwd ?? process.cwd(),
      quiet: true,
    });

    // Handle incoming messages
    this.client.onMessage = (from: string, payload: SendPayload, messageId: string, meta?: SendMeta, originalTo?: string) => {
      this.handleIncomingMessage(from, payload, messageId, meta, originalTo);
    };
  }

  /**
   * Start the agent process
   */
  async start(): Promise<void> {
    if (this.running) return;

    // Set up log file if logsDir is provided
    if (this.config.logsDir) {
      try {
        fs.mkdirSync(this.config.logsDir, { recursive: true });
        this.logFilePath = path.join(this.config.logsDir, `${this.config.name}.log`);
        this.logStream = fs.createWriteStream(this.logFilePath, { flags: 'a' });
        this.logStream.write(`\n--- Worker ${this.config.name} started at ${new Date().toISOString()} ---\n`);
      } catch (err: any) {
        console.error(`[pty:${this.config.name}] Failed to create log file: ${err.message}`);
      }
    }

    // Connect to relay daemon
    try {
      await this.client.connect();

      // If this is a shadow agent, bind to the primary after connecting
      if (this.config.shadowOf) {
        const speakOn = this.config.shadowSpeakOn ?? ['EXPLICIT_ASK'];
        const bound = this.client.bindAsShadow(this.config.shadowOf, { speakOn });
        if (bound) {
          console.log(`[pty:${this.config.name}] Bound as shadow of ${this.config.shadowOf} (speakOn: ${speakOn.join(', ')})`);
        } else {
          console.error(`[pty:${this.config.name}] Failed to bind as shadow of ${this.config.shadowOf}`);
        }
      }
    } catch (err: any) {
      console.error(`[pty:${this.config.name}] Relay connect failed: ${err.message}`);
    }

    // Build command args
    const args = this.config.args ?? [];
    const cwd = this.config.cwd ?? process.cwd();

    // Log spawn details for debugging
    console.log(`[pty:${this.config.name}] Spawning: ${this.config.command} ${args.join(' ')}`);
    console.log(`[pty:${this.config.name}] CWD: ${cwd}`);

    // Spawn the process with error handling
    try {
      this.ptyProcess = pty.spawn(this.config.command, args, {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd,
        env: {
          ...process.env,
          ...this.config.env,
          AGENT_RELAY_NAME: this.config.name,
          TERM: 'xterm-256color',
        },
      });
    } catch (spawnError: any) {
      console.error(`[pty:${this.config.name}] Failed to spawn process:`, spawnError.message);
      console.error(`[pty:${this.config.name}] Command: ${this.config.command}`);
      console.error(`[pty:${this.config.name}] Args: ${args.join(' ')}`);
      throw spawnError;
    }

    this.running = true;

    // Capture output
    this.ptyProcess.onData((data: string) => {
      this.handleOutput(data);
    });

    // Handle exit
    this.ptyProcess.onExit(({ exitCode }) => {
      this.running = false;
      this.emit('exit', exitCode);
      this.config.onExit?.(exitCode);
      this.client.destroy();
    });

    // Inject initial instructions after a delay, then mark ready for messages
    setTimeout(() => {
      this.injectInstructions();
      this.readyForMessages = true;
      // Process any messages that arrived while waiting
      this.processMessageQueue();
    }, 2000);
  }

  /**
   * Handle output from the process
   */
  private handleOutput(data: string): void {
    // Track output timing for stability checks
    this.lastOutputTime = Date.now();

    // Append to raw buffer
    this.rawBuffer += data;

    // Write to log file if available
    if (this.logStream) {
      this.logStream.write(data);
    }

    // Emit for external listeners
    this.emit('output', data);

    // Stream to daemon for dashboard log viewing (if connected)
    if (this.config.streamLogs !== false && this.client.state === 'READY') {
      this.client.sendLog(data);
    }

    // Auto-accept Claude's first-run prompt for --dangerously-skip-permissions
    // The prompt shows: "2. Yes, I accept" - we send "2" to accept
    this.handleAutoAcceptPrompts(data);

    // Handle terminal escape sequences that require responses (e.g., cursor position query)
    this.handleTerminalEscapeSequences(data);

    // Store in line buffer for logs
    const lines = data.split('\n');
    for (const line of lines) {
      if (line.trim()) {
        this.outputBuffer.push(line);
      }
    }

    // Trim buffer if too large
    while (this.outputBuffer.length > MAX_BUFFER_LINES) {
      this.outputBuffer.shift();
    }

    // Parse for relay commands
    this.parseRelayCommands();
  }

  /**
   * Auto-accept Claude's first-run prompts for --dangerously-skip-permissions
   * Detects the acceptance prompt and sends "2" to select "Yes, I accept"
   */
  private handleAutoAcceptPrompts(data: string): void {
    if (this.hasAcceptedPrompt) return;
    if (!this.ptyProcess || !this.running) return;

    // Check for the permission acceptance prompt
    // Pattern: "2. Yes, I accept" in the output
    const cleanData = stripAnsi(data);
    if (cleanData.includes('Yes, I accept') && cleanData.includes('No, exit')) {
      console.log(`[pty:${this.config.name}] Detected permission prompt, auto-accepting...`);
      this.hasAcceptedPrompt = true;
      // Send "2" to select "Yes, I accept" and Enter to confirm
      setTimeout(() => {
        if (this.ptyProcess && this.running) {
          this.ptyProcess.write('2');
        }
      }, 100);
    }
  }

  /**
   * Handle terminal escape sequences that require responses.
   *
   * Some CLI tools (like Codex) query terminal capabilities and expect responses.
   * Without proper responses, they timeout and crash.
   *
   * Supported sequences:
   * - CSI 6 n (DSR - Device Status Report for cursor position)
   *   Response: CSI row ; col R (we report position 1;1)
   */
  private handleTerminalEscapeSequences(data: string): void {
    if (!this.ptyProcess || !this.running) return;

    // Check for cursor position query: ESC [ 6 n
    // This can appear as \x1b[6n or \x1b[?6n
    // eslint-disable-next-line no-control-regex
    if (/\x1b\[\??6n/.test(data)) {
      // Respond with cursor at position (1, 1)
      // Format: ESC [ row ; col R
      const response = '\x1b[1;1R';

      // Small delay to ensure the query has been fully processed
      setTimeout(() => {
        if (this.ptyProcess && this.running) {
          this.ptyProcess.write(response);
        }
      }, 10);
    }
  }

  /**
   * Parse relay commands from output.
   * Handles both single-line and multi-line (fenced) formats.
   * Deduplication via sentMessageHashes.
   */
  private parseRelayCommands(): void {
    const cleanContent = stripAnsi(this.rawBuffer);

    // First, try to find fenced multi-line messages: ->relay:Target <<<\n...\n>>>
    this.parseFencedMessages(cleanContent);

    // Then parse single-line messages
    this.parseSingleLineMessages(cleanContent);

    // Parse spawn/release commands
    this.parseSpawnReleaseCommands(cleanContent);
  }

  /**
   * Parse fenced multi-line messages: ->relay:Target [thread:xxx] <<<\n...\n>>>
   */
  private parseFencedMessages(content: string): void {
    // Pattern: ->relay:Target [thread:xxx] <<<  (with content on same or following lines until >>>)
    // Thread is optional, can be [thread:id] or [thread:project:id] for cross-project
    const escapedPrefix = this.relayPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const fenceStartPattern = new RegExp(
      `${escapedPrefix}(\\S+)(?:\\s+\\[thread:(?:([\\w-]+):)?([\\w-]+)\\])?\\s*<<<`,
      'g'
    );

    let match;
    while ((match = fenceStartPattern.exec(content)) !== null) {
      const target = match[1];
      const threadProject = match[2]; // Optional: project part of thread
      const threadId = match[3];      // Thread ID
      const startIdx = match.index + match[0].length;

      // Find the closing >>>
      const endIdx = content.indexOf('>>>', startIdx);
      if (endIdx === -1) continue;

      // Extract the body between <<< and >>>
      const body = content.substring(startIdx, endIdx).trim();
      if (!body) continue;

      // Parse target for cross-project syntax
      const colonIdx = target.indexOf(':');
      let to = target;
      let project: string | undefined;
      if (colonIdx > 0 && colonIdx < target.length - 1) {
        project = target.substring(0, colonIdx);
        to = target.substring(colonIdx + 1);
      }

      this.sendRelayCommand({
        to,
        kind: 'message',
        body,
        project,
        thread: threadId || undefined,
        threadProject: threadProject || undefined,
        raw: match[0],
      });
    }
  }

  /**
   * Parse single-line messages (no fenced format)
   * Format: ->relay:Target [thread:xxx] message body
   */
  private parseSingleLineMessages(content: string): void {
    const lines = content.split('\n');

    for (const line of lines) {
      // Skip lines that are part of fenced messages
      if (line.includes('<<<') || line.includes('>>>')) continue;

      // Find the relay prefix in the line
      const prefixIdx = line.indexOf(this.relayPrefix);
      if (prefixIdx === -1) continue;

      // Extract everything after the prefix
      const afterPrefix = line.substring(prefixIdx + this.relayPrefix.length);

      // Pattern: Target [thread:project:id] body or Target [thread:id] body or Target body
      // Thread is optional, can include project prefix
      const targetMatch = afterPrefix.match(/^(\S+)(?:\s+\[thread:(?:([\w-]+):)?([\w-]+)\])?\s+(.+)$/);
      if (!targetMatch) {
        // Fallback: try simpler pattern without thread
        const simpleMatch = afterPrefix.match(/^(\S+)\s+(.+)$/);
        if (!simpleMatch) continue;

        const [, target, body] = simpleMatch;
        if (!body) continue;

        // Parse target for cross-project syntax
        const colonIdx = target.indexOf(':');
        let to = target;
        let project: string | undefined;
        if (colonIdx > 0 && colonIdx < target.length - 1) {
          project = target.substring(0, colonIdx);
          to = target.substring(colonIdx + 1);
        }

        this.sendRelayCommand({
          to,
          kind: 'message',
          body,
          project,
          raw: line,
        });
        continue;
      }

      const [, target, threadProject, threadId, body] = targetMatch;
      if (!body) continue;

      // Parse target for cross-project syntax
      const colonIdx = target.indexOf(':');
      let to = target;
      let project: string | undefined;
      if (colonIdx > 0 && colonIdx < target.length - 1) {
        project = target.substring(0, colonIdx);
        to = target.substring(colonIdx + 1);
      }

      this.sendRelayCommand({
        to,
        kind: 'message',
        body,
        project,
        thread: threadId || undefined,
        threadProject: threadProject || undefined,
        raw: line,
      });
    }
  }

  /**
   * Send relay command to daemon
   */
  private sendRelayCommand(cmd: ParsedCommand): void {
    const msgHash = `${cmd.to}:${cmd.body}`;

    if (this.sentMessageHashes.has(msgHash)) {
      return;
    }

    if (this.client.state !== 'READY') {
      return;
    }

    const success = this.client.sendMessage(cmd.to, cmd.body, cmd.kind, cmd.data, cmd.thread);
    if (success) {
      this.sentMessageHashes.add(msgHash);
    }
  }

  /**
   * Parse spawn/release commands from output
   * Uses string-based parsing for robustness with PTY output.
   * Delegates to dashboard API if dashboardPort is set (for nested spawns).
   */
  private parseSpawnReleaseCommands(content: string): void {
    // Need either API port or callbacks to handle spawn/release
    const canSpawn = this.config.dashboardPort || this.config.onSpawn;
    const canRelease = this.config.dashboardPort || this.config.onRelease;
    if (!canSpawn && !canRelease) return;

    const lines = content.split('\n');
    const spawnPrefix = '->relay:spawn';
    const releasePrefix = '->relay:release';

    for (const line of lines) {
      // Check for spawn command
      const spawnIdx = line.indexOf(spawnPrefix);
      if (spawnIdx !== -1 && canSpawn) {
        const afterSpawn = line.substring(spawnIdx + spawnPrefix.length).trim();
        // Parse: WorkerName cli OR WorkerName cli "task" (task is optional)
        const parts = afterSpawn.split(/\s+/);
        if (parts.length >= 2) {
          const name = parts[0];
          const cli = parts[1];
          // Task is everything after cli, potentially in quotes (optional)
          let task = '';
          if (parts.length >= 3) {
            const taskPart = parts.slice(2).join(' ');
            // Remove surrounding quotes if present
            const quoteMatch = taskPart.match(/^["'](.*)["']$/);
            task = quoteMatch ? quoteMatch[1] : taskPart;
          }

          if (name && cli) {
            const spawnKey = `${name}:${cli}`;
            if (!this.processedSpawnCommands.has(spawnKey)) {
              this.processedSpawnCommands.add(spawnKey);
              this.executeSpawn(name, cli, task);
            }
          }
        }
        continue;
      }

      // Check for release command
      const releaseIdx = line.indexOf(releasePrefix);
      if (releaseIdx !== -1 && canRelease) {
        const afterRelease = line.substring(releaseIdx + releasePrefix.length).trim();
        const name = afterRelease.split(/\s+/)[0];

        if (name && !this.processedReleaseCommands.has(name)) {
          this.processedReleaseCommands.add(name);
          this.executeRelease(name);
        }
      }
    }
  }

  /**
   * Execute spawn via API or callback
   */
  private async executeSpawn(name: string, cli: string, task: string): Promise<void> {
    if (this.config.dashboardPort) {
      // Use dashboard API for spawning (works from spawned agents)
      try {
        const response = await fetch(`http://localhost:${this.config.dashboardPort}/api/spawn`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, cli, task }),
        });
        const result = await response.json() as { success: boolean; error?: string };
        if (result.success) {
          console.log(`[pty:${this.config.name}] Spawned ${name} via API`);
        } else {
          console.error(`[pty:${this.config.name}] Spawn failed: ${result.error}`);
        }
      } catch (err: any) {
        console.error(`[pty:${this.config.name}] Spawn API call failed: ${err.message}`);
      }
    } else if (this.config.onSpawn) {
      // Fall back to callback
      try {
        await this.config.onSpawn(name, cli, task);
      } catch (err: any) {
        console.error(`[pty:${this.config.name}] Spawn failed: ${err.message}`);
      }
    }
  }

  /**
   * Execute release via API or callback
   */
  private async executeRelease(name: string): Promise<void> {
    if (this.config.dashboardPort) {
      // Use dashboard API for releasing
      try {
        const response = await fetch(`http://localhost:${this.config.dashboardPort}/api/spawned/${name}`, {
          method: 'DELETE',
        });
        const result = await response.json() as { success: boolean; error?: string };
        if (result.success) {
          console.log(`[pty:${this.config.name}] Released ${name} via API`);
        } else {
          console.error(`[pty:${this.config.name}] Release failed: ${result.error}`);
        }
      } catch (err: any) {
        console.error(`[pty:${this.config.name}] Release API call failed: ${err.message}`);
      }
    } else if (this.config.onRelease) {
      // Fall back to callback
      try {
        await this.config.onRelease(name);
      } catch (err: any) {
        console.error(`[pty:${this.config.name}] Release failed: ${err.message}`);
      }
    }
  }

  /**
   * Handle incoming message from relay
   * @param originalTo - The original 'to' field from sender. '*' indicates this was a broadcast message.
   */
  private handleIncomingMessage(from: string, payload: SendPayload, messageId: string, meta?: SendMeta, originalTo?: string): void {
    this.messageQueue.push({ from, body: payload.body, messageId, thread: payload.thread, importance: meta?.importance, data: payload.data, originalTo });
    this.processMessageQueue();
  }

  /**
   * Wait for output to stabilize before injection.
   * Returns true if output has been stable for the required duration.
   */
  private async waitForOutputStable(): Promise<boolean> {
    const startTime = Date.now();
    let stablePolls = 0;
    let lastBufferLength = this.rawBuffer.length;

    while (Date.now() - startTime < INJECTION_CONSTANTS.STABILITY_TIMEOUT_MS) {
      await sleep(INJECTION_CONSTANTS.STABILITY_POLL_MS);

      const timeSinceOutput = Date.now() - this.lastOutputTime;
      const bufferUnchanged = this.rawBuffer.length === lastBufferLength;

      // Consider stable if no output for at least one poll interval
      if (timeSinceOutput >= INJECTION_CONSTANTS.STABILITY_POLL_MS && bufferUnchanged) {
        stablePolls++;
        if (stablePolls >= INJECTION_CONSTANTS.REQUIRED_STABLE_POLLS) {
          return true;
        }
      } else {
        stablePolls = 0;
        lastBufferLength = this.rawBuffer.length;
      }
    }

    // Timeout - return true anyway to avoid blocking forever
    console.warn(`[pty:${this.config.name}] Stability timeout, proceeding with injection`);
    return true;
  }

  /**
   * Verify that an injected message appeared in the output.
   * Looks for the message pattern in recent output.
   */
  private async verifyInjection(shortId: string, from: string): Promise<boolean> {
    const expectedPattern = `Relay message from ${from} [${shortId}]`;
    const startTime = Date.now();

    while (Date.now() - startTime < INJECTION_CONSTANTS.VERIFICATION_TIMEOUT_MS) {
      // Check if pattern appears in recent buffer
      // Look at last 2000 chars to avoid scanning entire buffer
      const recentOutput = this.rawBuffer.slice(-2000);
      if (recentOutput.includes(expectedPattern)) {
        return true;
      }

      await sleep(100);
    }

    return false;
  }

  /**
   * Check if the agent process is still alive and responsive.
   */
  private isAgentAlive(): boolean {
    return this.running && this.ptyProcess !== undefined;
  }

  /**
   * Perform a single injection attempt.
   */
  private async performInjection(injection: string): Promise<void> {
    if (!this.ptyProcess || !this.running) {
      throw new Error('PTY process not running');
    }

    // Write message to PTY, then send Enter separately after a small delay
    this.ptyProcess.write(injection);
    await sleep(INJECTION_CONSTANTS.ENTER_DELAY_MS);
    this.ptyProcess.write('\r');
  }

  /**
   * Inject a message with retry logic and verification.
   */
  private async injectWithRetry(
    injection: string,
    shortId: string,
    from: string
  ): Promise<InjectionResult> {
    this.injectionMetrics.total++;

    for (let attempt = 0; attempt < INJECTION_CONSTANTS.MAX_RETRIES; attempt++) {
      try {
        // Perform the injection
        await this.performInjection(injection);

        // Verify it appeared in output
        const verified = await this.verifyInjection(shortId, from);

        if (verified) {
          if (attempt === 0) {
            this.injectionMetrics.successFirstTry++;
          } else {
            this.injectionMetrics.successWithRetry++;
            console.log(`[pty:${this.config.name}] Injection succeeded on attempt ${attempt + 1}`);
          }
          return { success: true, attempts: attempt + 1 };
        }

        // Not verified - log and retry
        console.warn(
          `[pty:${this.config.name}] Injection not verified, attempt ${attempt + 1}/${INJECTION_CONSTANTS.MAX_RETRIES}`
        );

        // Backoff before retry
        if (attempt < INJECTION_CONSTANTS.MAX_RETRIES - 1) {
          await sleep(INJECTION_CONSTANTS.RETRY_BACKOFF_MS * (attempt + 1));
        }
      } catch (err: any) {
        console.error(`[pty:${this.config.name}] Injection error on attempt ${attempt + 1}: ${err.message}`);
      }
    }

    // All retries failed
    this.injectionMetrics.failed++;
    return { success: false, attempts: INJECTION_CONSTANTS.MAX_RETRIES };
  }

  /**
   * Process queued messages with reliability improvements:
   * 1. Wait for output stability before injection
   * 2. Verify injection appeared in output
   * 3. Retry with backoff on failure
   * 4. Fall back to logging on complete failure
   */
  private async processMessageQueue(): Promise<void> {
    // Wait until instructions have been injected and agent is ready
    if (!this.readyForMessages) return;
    if (this.isInjecting || this.messageQueue.length === 0) return;

    // Health check: is agent still alive?
    if (!this.isAgentAlive()) {
      console.error(`[pty:${this.config.name}] Agent not alive, cannot inject messages`);
      return;
    }

    this.isInjecting = true;

    const msg = this.messageQueue.shift();
    if (!msg) {
      this.isInjecting = false;
      return;
    }

    try {
      // Wait for output to stabilize before injecting
      await this.waitForOutputStable();

      // For Gemini: check if at shell prompt, skip injection to avoid shell execution
      if (this.cliType === 'gemini') {
        const recentOutput = this.rawBuffer.slice(-200);
        const lastLine = recentOutput.split('\n').filter(l => l.trim()).pop() || '';
        if (CLI_QUIRKS.isShellPrompt(lastLine)) {
          console.log(`[pty:${this.config.name}] Gemini at shell prompt, re-queuing message`);
          this.messageQueue.unshift(msg);
          this.isInjecting = false;
          setTimeout(() => this.processMessageQueue(), 2000);
          return;
        }
      }

      // Build injection string using shared utility
      let injection = buildInjectionString(msg);

      // Gemini-specific: wrap in backticks to prevent shell keyword interpretation
      if (this.cliType === 'gemini') {
        // Extract the message body part and wrap it
        const colonIdx = injection.indexOf(': ');
        if (colonIdx > 0) {
          const prefix = injection.substring(0, colonIdx + 2);
          const body = injection.substring(colonIdx + 2);
          injection = prefix + CLI_QUIRKS.wrapForGemini(body);
        }
      }

      const shortId = msg.messageId.substring(0, 8);

      // Inject with retry and verification
      const result = await this.injectWithRetry(injection, shortId, msg.from);

      if (!result.success) {
        // Log the failed message for debugging/recovery
        console.error(
          `[pty:${this.config.name}] Message delivery failed after ${result.attempts} attempts: ` +
          `from=${msg.from} id=${shortId}`
        );

        // Emit event for external monitoring (e.g., dashboard)
        this.emit('injection-failed', {
          messageId: msg.messageId,
          from: msg.from,
          attempts: result.attempts,
        });
      }
    } catch (err: any) {
      console.error(`[pty:${this.config.name}] Injection failed: ${err.message}`);
    } finally {
      this.isInjecting = false;

      // Process next message if any
      if (this.messageQueue.length > 0) {
        setTimeout(() => this.processMessageQueue(), INJECTION_CONSTANTS.QUEUE_PROCESS_DELAY_MS);
      }
    }
  }

  /**
   * Inject usage instructions
   */
  private injectInstructions(): void {
    if (!this.running || !this.ptyProcess) return;

    const escapedPrefix = '\\' + this.relayPrefix;
    const instructions = `[Agent Relay] You are "${this.config.name}" - connected for real-time messaging. SEND: ${escapedPrefix}AgentName message. PROTOCOL: (1) Wait for task via relay. (2) ACK receipt before starting. (3) Send "DONE: <summary>" when complete, then wait for next task.`;

    try {
      this.ptyProcess.write(instructions + '\r');
    } catch {
      // Silent fail
    }
  }

  /**
   * Write directly to the PTY
   */
  write(data: string): void {
    if (this.ptyProcess && this.running) {
      this.ptyProcess.write(data);
    }
  }

  /**
   * Get captured output lines
   */
  getOutput(limit?: number): string[] {
    if (limit && limit > 0) {
      return this.outputBuffer.slice(-limit);
    }
    return [...this.outputBuffer];
  }

  /**
   * Get raw output buffer
   */
  getRawOutput(): string {
    return this.rawBuffer;
  }

  /**
   * Stop the agent process
   */
  stop(): void {
    if (!this.running) return;
    this.running = false;

    if (this.ptyProcess) {
      // Try graceful termination first
      this.ptyProcess.write('\x03'); // Ctrl+C
      setTimeout(() => {
        if (this.ptyProcess) {
          this.ptyProcess.kill();
        }
      }, 1000);
    }

    this.closeLogStream();
    this.client.destroy();
  }

  /**
   * Kill the process immediately
   */
  kill(): void {
    this.running = false;
    if (this.ptyProcess) {
      this.ptyProcess.kill();
    }
    this.closeLogStream();
    this.client.destroy();
  }

  /**
   * Close the log file stream
   */
  private closeLogStream(): void {
    if (this.logStream) {
      this.logStream.write(`\n--- Worker ${this.config.name} stopped at ${new Date().toISOString()} ---\n`);
      this.logStream.end();
      this.logStream = undefined;
    }
  }

  get isRunning(): boolean {
    return this.running;
  }

  get name(): string {
    return this.config.name;
  }

  get pid(): number | undefined {
    return this.ptyProcess?.pid;
  }

  get logPath(): string | undefined {
    return this.logFilePath;
  }

  /**
   * Get injection reliability metrics
   */
  getInjectionMetrics(): InjectionMetrics & { successRate: number } {
    return {
      ...this.injectionMetrics,
      successRate: calculateSuccessRate(this.injectionMetrics),
    };
  }

  /**
   * Get count of pending messages in queue
   */
  get pendingMessageCount(): number {
    return this.messageQueue.length;
  }
}
