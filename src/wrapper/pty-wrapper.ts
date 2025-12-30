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
import type { SendPayload, SpeakOnTrigger } from '../protocol/types.js';
import { getProjectPaths } from '../utils/project-namespace.js';
import { getTrailEnvVars } from '../trajectory/integration.js';
import { HookRegistry, createTrajectoryHooks, type LifecycleHooks } from '../hooks/index.js';

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
  /** Task/role description for trajectory tracking */
  task?: string;
  /** Custom lifecycle hooks */
  hooks?: LifecycleHooks;
  /** Enable trajectory tracking hooks (default: true if task provided) */
  trajectoryTracking?: boolean;
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
  private readyForMessages = false;
  private logFilePath?: string;
  private logStream?: fs.WriteStream;
  private hasAcceptedPrompt = false;
  private hookRegistry: HookRegistry;
  private sessionStartTime = Date.now();

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

    // Initialize hook registry
    const projectPaths = getProjectPaths();
    this.hookRegistry = new HookRegistry({
      agentName: config.name,
      workingDir: config.cwd ?? process.cwd(),
      projectId: projectPaths.projectId,
      task: config.task,
      env: config.env,
      inject: (text) => this.write(text + '\r'),
      send: async (to, body) => {
        this.client.sendMessage(to, body, 'message');
      },
    });

    // Register trajectory hooks if enabled (default: true if task provided)
    const enableTrajectory = config.trajectoryTracking ?? !!config.task;
    if (enableTrajectory) {
      const trajectoryHooks = createTrajectoryHooks({
        projectId: projectPaths.projectId,
        agentName: config.name,
      });
      this.hookRegistry.registerLifecycleHooks(trajectoryHooks);
    }

    // Register custom hooks if provided
    if (config.hooks) {
      this.hookRegistry.registerLifecycleHooks(config.hooks);
    }

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

    // Get trail environment variables
    const projectPaths = getProjectPaths();
    const trailEnvVars = getTrailEnvVars(projectPaths.projectId, this.config.name, projectPaths.dataDir);

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
          ...trailEnvVars,
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
    this.sessionStartTime = Date.now();

    // Dispatch session start hook (handles trajectory initialization)
    this.hookRegistry.dispatchSessionStart().catch(err => {
      console.error(`[pty:${this.config.name}] Session start hook error:`, err);
    });

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

    // Dispatch output hook (handles phase detection, etc.)
    const cleanData = this.stripAnsi(data);
    this.hookRegistry.dispatchOutput(cleanData, data).catch(err => {
      console.error(`[pty:${this.config.name}] Output hook error:`, err);
    });
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

      // Dispatch message sent hook
      this.hookRegistry.dispatchMessageSent(cmd.to, cmd.body, cmd.thread).catch(err => {
        console.error(`[pty:${this.config.name}] Message sent hook error:`, err);
      });
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
  private handleIncomingMessage(from: string, payload: SendPayload, messageId: string): void {
    this.messageQueue.push({ from, body: payload.body, messageId });
    this.processMessageQueue();

    // Dispatch message received hook
    this.hookRegistry.dispatchMessageReceived(from, payload.body, messageId).catch(err => {
      console.error(`[pty:${this.config.name}] Message received hook error:`, err);
    });
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

    // Note: Trail instructions are injected via hooks (trajectory-hooks.ts)

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

    // Dispatch session end hook (handles trajectory completion)
    this.hookRegistry.dispatchSessionEnd(0, true).catch(err => {
      console.error(`[pty:${this.config.name}] Session end hook error:`, err);
    });

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
    this.hookRegistry.destroy();
  }

  /**
   * Kill the process immediately
   */
  kill(): void {
    this.running = false;

    // Dispatch session end hook (forced termination)
    this.hookRegistry.dispatchSessionEnd(undefined, false).catch(err => {
      console.error(`[pty:${this.config.name}] Session end hook error:`, err);
    });

    if (this.ptyProcess) {
      this.ptyProcess.kill();
    }
    this.closeLogStream();
    this.client.destroy();
    this.hookRegistry.destroy();
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
