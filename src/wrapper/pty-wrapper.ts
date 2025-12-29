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
import type { SendPayload } from '../protocol/types.js';

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
  /** Callback for spawn commands */
  onSpawn?: (name: string, cli: string, task: string) => Promise<void>;
  /** Callback for release commands */
  onRelease?: (name: string) => Promise<void>;
  /** Callback when agent exits */
  onExit?: (code: number) => void;
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
  private messageQueue: Array<{ from: string; body: string; messageId: string }> = [];
  private isInjecting = false;
  private logFilePath?: string;
  private logStream?: fs.WriteStream;

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
    this.client.onMessage = (from: string, payload: SendPayload, messageId: string) => {
      this.handleIncomingMessage(from, payload, messageId);
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
    } catch (err: any) {
      console.error(`[pty:${this.config.name}] Relay connect failed: ${err.message}`);
    }

    // Build command args
    const args = this.config.args ?? [];

    // Spawn the process
    this.ptyProcess = pty.spawn(this.config.command, args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd: this.config.cwd ?? process.cwd(),
      env: {
        ...process.env,
        ...this.config.env,
        AGENT_RELAY_NAME: this.config.name,
        TERM: 'xterm-256color',
      },
    });

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

    // Inject initial instructions after a delay
    setTimeout(() => this.injectInstructions(), 2000);
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
   * Parse fenced multi-line messages: ->relay:Target <<<\n...\n>>>
   */
  private parseFencedMessages(content: string): void {
    // Pattern: ->relay:Target <<<  (with content on same or following lines until >>>)
    const fenceStartPattern = new RegExp(
      `${this.relayPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\S+)\\s*<<<`,
      'g'
    );

    let match;
    while ((match = fenceStartPattern.exec(content)) !== null) {
      const target = match[1];
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
        raw: match[0],
      });
    }
  }

  /**
   * Parse single-line messages (no fenced format)
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

      // Find the target (first non-whitespace segment)
      const targetMatch = afterPrefix.match(/^(\S+)/);
      if (!targetMatch) continue;

      const target = targetMatch[1];
      const bodyStart = targetMatch[0].length;
      const body = afterPrefix.substring(bodyStart).trim();

      // Skip if no body
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

    // Strip remaining ANSI escape sequences
    // eslint-disable-next-line no-control-regex
    return str.replace(/\x1B(?:\[[0-9;]*[A-Za-z]|\].*?(?:\x07|\x1B\\)|[@-Z\\-_])/g, '');
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
   * Uses string-based parsing for robustness with PTY output
   */
  private parseSpawnReleaseCommands(content: string): void {
    if (!this.config.onSpawn && !this.config.onRelease) return;

    const lines = content.split('\n');
    const spawnPrefix = '->relay:spawn';
    const releasePrefix = '->relay:release';

    for (const line of lines) {
      // Check for spawn command
      const spawnIdx = line.indexOf(spawnPrefix);
      if (spawnIdx !== -1 && this.config.onSpawn) {
        const afterSpawn = line.substring(spawnIdx + spawnPrefix.length).trim();
        // Parse: WorkerName cli "task" or WorkerName cli 'task'
        const parts = afterSpawn.split(/\s+/);
        if (parts.length >= 3) {
          const name = parts[0];
          const cli = parts[1];
          // Task is everything after cli, potentially in quotes
          const taskPart = parts.slice(2).join(' ');
          // Remove surrounding quotes if present
          const quoteMatch = taskPart.match(/^["'](.*)["']$/);
          const task = quoteMatch ? quoteMatch[1] : taskPart;

          if (name && cli && task) {
            const spawnKey = `${name}:${cli}:${task}`;
            if (!this.processedSpawnCommands.has(spawnKey)) {
              this.processedSpawnCommands.add(spawnKey);
              this.config.onSpawn(name, cli, task).catch(err => {
                console.error(`[pty:${this.config.name}] Spawn failed: ${err.message}`);
              });
            }
          }
        }
        continue;
      }

      // Check for release command
      const releaseIdx = line.indexOf(releasePrefix);
      if (releaseIdx !== -1 && this.config.onRelease) {
        const afterRelease = line.substring(releaseIdx + releasePrefix.length).trim();
        const name = afterRelease.split(/\s+/)[0];

        if (name && !this.processedReleaseCommands.has(name)) {
          this.processedReleaseCommands.add(name);
          this.config.onRelease(name).catch(err => {
            console.error(`[pty:${this.config.name}] Release failed: ${err.message}`);
          });
        }
      }
    }
  }

  /**
   * Handle incoming message from relay
   */
  private handleIncomingMessage(from: string, payload: SendPayload, messageId: string): void {
    this.messageQueue.push({ from, body: payload.body, messageId });
    this.processMessageQueue();
  }

  /**
   * Process queued messages
   */
  private async processMessageQueue(): Promise<void> {
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
      const sanitizedBody = msg.body.replace(/[\r\n]+/g, ' ').trim();
      const injection = `Relay message from ${msg.from} [${shortId}]: ${sanitizedBody}`;

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
    const instructions = `[Agent Relay] You are "${this.config.name}" - connected for real-time messaging. SEND: ${escapedPrefix}AgentName message`;

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
