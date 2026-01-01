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

export interface PtyWrapperEvents {
  output: (data: string) => void;
  exit: (code: number) => void;
  error: (error: Error) => void;
}

export class PtyWrapper extends EventEmitter {
  private config: PtyWrapperConfig;
  private ptyProcess?: pty.IPty;
  private client: RelayClient;
  private running = false;
  private outputBuffer: string[] = [];
  private rawBuffer = '';
  private relayPrefix: string;
  private sentMessageHashes: Set<string> = new Set();
  private processedSpawnCommands: Set<string> = new Set();
  private processedReleaseCommands: Set<string> = new Set();
  private messageQueue: Array<{ from: string; body: string; messageId: string; thread?: string; importance?: number; data?: Record<string, unknown> }> = [];
  private isInjecting = false;
  private readyForMessages = false;
  private logFilePath?: string;
  private logStream?: fs.WriteStream;
  private hasAcceptedPrompt = false;

  constructor(config: PtyWrapperConfig) {
    super();
    this.config = config;
    this.relayPrefix = config.relayPrefix ?? '->relay:';

    this.client = new RelayClient({
      agentName: config.name,
      socketPath: config.socketPath,
      cli: 'spawned',
      workingDirectory: config.cwd ?? process.cwd(),
      quiet: true,
    });

    // Handle incoming messages
    this.client.onMessage = (from: string, payload: SendPayload, messageId: string, meta?: SendMeta) => {
      this.handleIncomingMessage(from, payload, messageId, meta);
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
    const cleanData = this.stripAnsi(data);
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
    const cleanContent = this.stripAnsi(this.rawBuffer);

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
   * Strip ANSI escape codes from string.
   * Converts cursor movements to spaces to preserve visual layout.
   */
  private stripAnsi(str: string): string {
    // Convert cursor forward movements to spaces (CSI n C)
    // \x1B[nC means move cursor right n columns
    // eslint-disable-next-line no-control-regex
    str = str.replace(/\x1B\[(\d+)C/g, (_m, n) => ' '.repeat(parseInt(n, 10) || 1));

    // Convert single cursor right (CSI C) to space
    // eslint-disable-next-line no-control-regex
    str = str.replace(/\x1B\[C/g, ' ');

    // Remove carriage returns (causes text overwriting issues)
    str = str.replace(/\r(?!\n)/g, '');

    // Strip remaining ANSI escape sequences (with \x1B prefix)
    // eslint-disable-next-line no-control-regex
    str = str.replace(/\x1B(?:\[[0-9;?]*[A-Za-z]|\].*?(?:\x07|\x1B\\)|[@-Z\\-_])/g, '');

    // Strip orphaned CSI sequences that lost their escape byte
    // These look like [?25h, [?2026l, [0m, etc. at the start of content
    str = str.replace(/^\s*(\[\??\d*[A-Za-z])+\s*/g, '');

    return str;
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
   */
  private handleIncomingMessage(from: string, payload: SendPayload, messageId: string, meta?: SendMeta): void {
    this.messageQueue.push({ from, body: payload.body, messageId, thread: payload.thread, importance: meta?.importance, data: payload.data });
    this.processMessageQueue();
  }

  /**
   * Process queued messages
   */
  private async processMessageQueue(): Promise<void> {
    // Wait until instructions have been injected and agent is ready
    if (!this.readyForMessages) return;
    if (this.isInjecting || this.messageQueue.length === 0) return;
    if (!this.ptyProcess || !this.running) return;

    this.isInjecting = true;

    const msg = this.messageQueue.shift();
    if (!msg) {
      this.isInjecting = false;
      return;
    }

    try {
      const shortId = msg.messageId.substring(0, 8);
      // Strip ANSI escape sequences and orphaned control sequences from message body
      const sanitizedBody = this.stripAnsi(msg.body).replace(/[\r\n]+/g, ' ').trim();
      // Thread/importance hints to match tmux-wrapper format
      const threadHint = msg.thread ? ` [thread:${msg.thread}]` : '';
      const importanceHint = msg.importance !== undefined && msg.importance > 75 ? ' [!!]' :
                             msg.importance !== undefined && msg.importance > 50 ? ' [!]' : '';

      // Extract attachment file paths if present
      let attachmentHint = '';
      if (msg.data?.attachments && Array.isArray(msg.data.attachments)) {
        const filePaths = msg.data.attachments
          .map((att: { filePath?: string }) => att.filePath)
          .filter((p): p is string => typeof p === 'string');
        if (filePaths.length > 0) {
          attachmentHint = ` [Attachments: ${filePaths.join(', ')}]`;
        }
      }

      const injection = `Relay message from ${msg.from} [${shortId}]${threadHint}${importanceHint}${attachmentHint}: ${sanitizedBody}`;

      // Write message to PTY, then send Enter separately after a small delay
      // This matches how TmuxWrapper does it for better CLI compatibility
      this.ptyProcess.write(injection);
      await this.sleep(50);
      this.ptyProcess.write('\r');
    } catch (err: any) {
      console.error(`[pty:${this.config.name}] Injection failed: ${err.message}`);
    } finally {
      this.isInjecting = false;

      // Process next message if any
      if (this.messageQueue.length > 0) {
        setTimeout(() => this.processMessageQueue(), 500);
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
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
}
