/**
 * TmuxWrapper - Attach-based tmux wrapper
 *
 * Architecture:
 * 1. Start agent in detached tmux session
 * 2. Attach user to tmux (they see real terminal)
 * 3. Background: poll capture-pane silently (no stdout writes)
 * 4. Background: parse @relay commands, send to daemon
 * 5. Background: inject messages via send-keys
 *
 * The key insight: user sees the REAL tmux session, not a proxy.
 * We just do background parsing and injection.
 */

import { exec, execSync, spawn, ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { RelayClient } from './client.js';
import { OutputParser, type ParsedCommand } from './parser.js';
import { InboxManager } from './inbox.js';
import type { SendPayload } from '../protocol/types.js';

const execAsync = promisify(exec);

export interface TmuxWrapperConfig {
  name: string;
  command: string;
  args?: string[];
  socketPath?: string;
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: Record<string, string>;
  /** Use file-based inbox in addition to injection */
  useInbox?: boolean;
  /** Custom inbox directory */
  inboxDir?: string;
  /** Polling interval for capture-pane (ms) */
  pollInterval?: number;
  /** Enable debug logging to stderr */
  debug?: boolean;
  /** Throttle debug logs (ms) */
  debugLogIntervalMs?: number;
  /** Idle time after last output before injecting (ms) */
  idleBeforeInjectMs?: number;
  /** Retry interval while waiting for idle window (ms) */
  injectRetryMs?: number;
  /** CLI type for special handling (auto-detected from command if not set) */
  cliType?: 'claude' | 'codex' | 'gemini' | 'other';
  /** Enable tmux mouse mode for scroll passthrough (default: true) */
  mouseMode?: boolean;
}

export class TmuxWrapper {
  private config: TmuxWrapperConfig;
  private sessionName: string;
  private client: RelayClient;
  private parser: OutputParser;
  private inbox?: InboxManager;
  private running = false;
  private pollTimer?: NodeJS.Timeout;
  private attachProcess?: ChildProcess;
  private lastCapturedOutput = '';
  private lastOutputTime = 0;
  private recentlySentMessages: Map<string, number> = new Map();
  private sentMessageHashes: Set<string> = new Set(); // Permanent dedup
  private messageQueue: Array<{ from: string; body: string; messageId: string }> = [];
  private isInjecting = false;
  // Track processed output to avoid re-parsing
  private processedOutputLength = 0;
  private lastDebugLog = 0;
  private cliType: 'claude' | 'codex' | 'gemini' | 'other';

  constructor(config: TmuxWrapperConfig) {
    this.config = {
      cols: process.stdout.columns || 120,
      rows: process.stdout.rows || 40,
      pollInterval: 200, // Slightly slower polling since we're not displaying
      idleBeforeInjectMs: 1500,
      injectRetryMs: 500,
      debug: true,
      debugLogIntervalMs: 0,
      mouseMode: true, // Enable mouse scroll passthrough by default
      ...config,
    };

    // Detect CLI type from command for special handling
    const cmdLower = config.command.toLowerCase();
    if (config.cliType) {
      this.cliType = config.cliType;
    } else if (cmdLower.includes('gemini')) {
      this.cliType = 'gemini';
    } else if (cmdLower.includes('codex')) {
      this.cliType = 'codex';
    } else if (cmdLower.includes('claude')) {
      this.cliType = 'claude';
    } else {
      this.cliType = 'other';
    }

    // Generate unique session name
    this.sessionName = `relay-${config.name}-${process.pid}`;

    this.client = new RelayClient({
      agentName: config.name,
      socketPath: config.socketPath,
    });

    this.parser = new OutputParser();

    // Initialize inbox if using file-based messaging
    if (config.useInbox) {
      this.inbox = new InboxManager({
        agentName: config.name,
        inboxDir: config.inboxDir,
      });
    }

    // Handle incoming messages from relay
    this.client.onMessage = (from: string, payload: SendPayload, messageId: string) => {
      this.handleIncomingMessage(from, payload, messageId);
    };

    this.client.onStateChange = (state) => {
      // Only log to stderr, never stdout (user is in tmux)
      if (state === 'READY') {
        this.logStderr(`Connected to relay daemon`);
      }
    };
  }

  /**
   * Log to stderr (safe - doesn't interfere with tmux display)
   */
  private logStderr(msg: string, force = false): void {
    if (!force && this.config.debug === false) return;

    const now = Date.now();
    if (!force && this.config.debugLogIntervalMs && this.config.debugLogIntervalMs > 0) {
      if (now - this.lastDebugLog < this.config.debugLogIntervalMs) {
        return;
      }
      this.lastDebugLog = now;
    }

    // Prefix with newline to avoid corrupting tmux status line
    process.stderr.write(`\r[relay:${this.config.name}] ${msg}\n`);
  }

  /**
   * Build the full command with proper quoting
   * Args containing spaces need to be quoted
   */
  private buildCommand(): string {
    if (!this.config.args || this.config.args.length === 0) {
      return this.config.command;
    }

    // Quote any argument that contains spaces, quotes, or special chars
    const quotedArgs = this.config.args.map(arg => {
      if (arg.includes(' ') || arg.includes('"') || arg.includes("'") || arg.includes('$')) {
        // Use double quotes and escape internal quotes
        return `"${arg.replace(/"/g, '\\"')}"`;
      }
      return arg;
    });

    return `${this.config.command} ${quotedArgs.join(' ')}`;
  }

  /**
   * Check if tmux session exists
   */
  private async sessionExists(): Promise<boolean> {
    try {
      await execAsync(`tmux has-session -t ${this.sessionName} 2>/dev/null`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Start the wrapped agent process
   */
  async start(): Promise<void> {
    if (this.running) return;

    // Initialize inbox if enabled
    if (this.inbox) {
      this.inbox.init();
    }

    // Connect to relay daemon (in background, don't block)
    this.client.connect().catch(() => {
      // Silent - relay connection is optional
    });

    // Kill any existing session with this name
    try {
      execSync(`tmux kill-session -t ${this.sessionName} 2>/dev/null`);
    } catch {
      // Session doesn't exist, that's fine
    }

    // Build the command - properly quote args that contain spaces
    const fullCommand = this.buildCommand();
    this.logStderr(`Command: ${fullCommand}`);

    // Create tmux session
    try {
      execSync(`tmux new-session -d -s ${this.sessionName} -x ${this.config.cols} -y ${this.config.rows}`, {
        cwd: this.config.cwd ?? process.cwd(),
        stdio: 'pipe',
      });

      // Configure tmux for seamless scrolling
      // Mouse mode passes scroll events to the application when in alternate screen
      const tmuxSettings = [
        'set -g set-clipboard on',            // Enable clipboard
        'set -g history-limit 50000',         // Large scrollback for when needed
        'setw -g alternate-screen on',        // Ensure alternate screen works
        // Pass through mouse scroll to application in alternate screen mode
        'set -ga terminal-overrides ",xterm*:Tc"',
      ];

      // Add mouse mode if enabled (allows scroll passthrough to CLI apps)
      if (this.config.mouseMode) {
        tmuxSettings.unshift('set -g mouse on');
        this.logStderr('Mouse mode enabled (scroll should work in app)');
      }

      for (const setting of tmuxSettings) {
        try {
          execSync(`tmux ${setting}`, { stdio: 'pipe' });
        } catch {
          // Some settings may not be available in older tmux versions
        }
      }

      // Set environment variables
      for (const [key, value] of Object.entries({
        ...this.config.env,
        AGENT_RELAY_NAME: this.config.name,
        TERM: 'xterm-256color',
      })) {
        const escaped = value.replace(/"/g, '\\"');
        execSync(`tmux setenv -t ${this.sessionName} ${key} "${escaped}"`);
      }

      // Wait for shell to be ready (look for prompt)
      await this.waitForShellReady();

      // Send the command to run
      await this.sendKeysLiteral(fullCommand);
      await this.sleep(100);
      await this.sendKeys('Enter');

    } catch (err: any) {
      throw new Error(`Failed to create tmux session: ${err.message}`);
    }

    // Wait for session to be ready
    await this.waitForSession();

    this.running = true;

    // Start background polling (silent - no stdout writes)
    this.startSilentPolling();

    // Attach user to tmux session
    // This takes over stdin/stdout - user sees the real terminal
    this.attachToSession();
  }

  /**
   * Wait for tmux session to be ready
   */
  private async waitForSession(maxWaitMs = 5000): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      if (await this.sessionExists()) {
        await new Promise(r => setTimeout(r, 200));
        return;
      }
      await new Promise(r => setTimeout(r, 100));
    }

    throw new Error('Timeout waiting for tmux session');
  }

  /**
   * Wait for shell prompt to appear (shell is ready for input)
   */
  private async waitForShellReady(maxWaitMs = 10000): Promise<void> {
    const startTime = Date.now();
    // Common prompt endings: $, %, >, ➜, #
    const promptPatterns = /[$%>#➜]\s*$/;

    this.logStderr('Waiting for shell to initialize...');

    while (Date.now() - startTime < maxWaitMs) {
      try {
        const { stdout } = await execAsync(
          `tmux capture-pane -t ${this.sessionName} -p 2>/dev/null`
        );

        // Check if the last non-empty line looks like a prompt
        const lines = stdout.split('\n').filter(l => l.trim());
        const lastLine = lines[lines.length - 1] || '';

        if (promptPatterns.test(lastLine)) {
          this.logStderr('Shell ready');
          // Extra delay to ensure shell is fully ready
          await this.sleep(200);
          return;
        }
      } catch {
        // Session might not be ready yet
      }

      await this.sleep(200);
    }

    // Fallback: proceed anyway after timeout
    this.logStderr('Shell ready timeout, proceeding anyway');
  }

  /**
   * Attach user to tmux session
   * This spawns tmux attach and lets it take over stdin/stdout
   */
  private attachToSession(): void {
    this.attachProcess = spawn('tmux', ['attach-session', '-t', this.sessionName], {
      stdio: 'inherit', // User's terminal connects directly to tmux
    });

    this.attachProcess.on('exit', (code) => {
      this.logStderr(`Session ended (code: ${code})`, true);
      this.stop();
      process.exit(code ?? 0);
    });

    this.attachProcess.on('error', (err) => {
      this.logStderr(`Attach error: ${err.message}`, true);
      this.stop();
      process.exit(1);
    });

    // Handle signals
    const cleanup = () => {
      this.stop();
    };
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
  }

  /**
   * Start silent polling for @relay commands
   * Does NOT write to stdout - just parses and sends to daemon
   */
  private startSilentPolling(): void {
    this.pollTimer = setInterval(() => {
      this.pollForRelayCommands().catch(() => {
        // Ignore poll errors
      });
    }, this.config.pollInterval);
  }

  /**
   * Poll for @relay commands in output (silent)
   */
  private async pollForRelayCommands(): Promise<void> {
    if (!this.running) return;

    try {
      // Capture scrollback
      const { stdout } = await execAsync(
        `tmux capture-pane -t ${this.sessionName} -p -S - 2>/dev/null`
      );

      // Always parse the FULL capture for @relay commands
      // This handles terminal UIs that rewrite content in place
      const cleanContent = this.stripAnsi(stdout);
      const { commands } = this.parser.parse(cleanContent);

      // Track last output time for injection timing
      if (stdout.length !== this.processedOutputLength) {
        this.lastOutputTime = Date.now();
        this.processedOutputLength = stdout.length;
      }

      // Send any commands found (deduplication handles repeats)
      for (const cmd of commands) {
        this.sendRelayCommand(cmd);
      }

      // Also check for injection opportunity
      this.checkForInjectionOpportunity();

    } catch (err: any) {
      if (err.message?.includes('no such session')) {
        this.stop();
      }
    }
  }

  /**
   * Strip ANSI escape codes
   */
  private stripAnsi(str: string): string {
    // eslint-disable-next-line no-control-regex
    return str.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
  }

  /**
   * Send relay command to daemon
   */
  private sendRelayCommand(cmd: ParsedCommand): void {
    const msgHash = `${cmd.to}:${cmd.body}`;

    // Permanent dedup - never send the same message twice
    if (this.sentMessageHashes.has(msgHash)) return;

    const success = this.client.sendMessage(cmd.to, cmd.body, cmd.kind, cmd.data);
    if (success) {
      this.sentMessageHashes.add(msgHash);
      this.logStderr(`→ ${cmd.to}: ${cmd.body.substring(0, 40)}...`);
    }
  }

  /**
   * Handle incoming message from relay
   */
  private handleIncomingMessage(from: string, payload: SendPayload, messageId: string): void {
    this.logStderr(`← ${from}: ${payload.body.substring(0, 40)}...`);

    // Queue for injection
    this.messageQueue.push({ from, body: payload.body, messageId });

    // Write to inbox if enabled
    if (this.inbox) {
      this.inbox.addMessage(from, payload.body);
    }

    // Try to inject
    this.checkForInjectionOpportunity();
  }

  /**
   * Check if we should inject a message
   */
  private checkForInjectionOpportunity(): void {
    if (this.messageQueue.length === 0) return;
    if (this.isInjecting) return;
    if (!this.running) return;

    // Wait for output to settle (agent might be busy)
    const timeSinceOutput = Date.now() - this.lastOutputTime;
    if (timeSinceOutput < (this.config.idleBeforeInjectMs ?? 1500)) {
      const retryMs = this.config.injectRetryMs ?? 500;
      setTimeout(() => this.checkForInjectionOpportunity(), retryMs);
      return;
    }

    this.injectNextMessage();
  }

  /**
   * Inject message via tmux send-keys
   */
  private async injectNextMessage(): Promise<void> {
    const msg = this.messageQueue.shift();
    if (!msg) return;

    this.isInjecting = true;
    this.logStderr(`Injecting message from ${msg.from} (cli: ${this.cliType})`);

    try {
      let sanitizedBody = msg.body.replace(/[\r\n]+/g, ' ').trim();
      // Short message ID for display (first 8 chars)
      const shortId = msg.messageId.substring(0, 8);

      // Truncate very long messages to avoid display issues
      const maxLen = 2000;
      let wasTruncated = false;
      if (sanitizedBody.length > maxLen) {
        sanitizedBody = sanitizedBody.substring(0, maxLen) + '...';
        wasTruncated = true;
      }

      // Always include message ID; add lookup hint if truncated
      const idTag = `[${shortId}]`;
      const truncationHint = wasTruncated
        ? ` [TRUNCATED - run "agent-relay read ${msg.messageId}"]`
        : '';

      // Gemini CLI interprets input as shell commands, so we need special handling
      if (this.cliType === 'gemini') {
        // For Gemini: Use echo command to display the message
        const echoMsg = `echo "[relay ${idTag} ← ${msg.from}] ${sanitizedBody.replace(/"/g, '\\"')}${truncationHint.replace(/"/g, '\\"')}"`;

        // Clear any partial input
        await this.sendKeys('Escape');
        await this.sleep(30);
        await this.sendKeys('C-u');
        await this.sleep(30);

        // Send echo command to display the message
        await this.sendKeysLiteral(echoMsg);
        await this.sleep(50);
        await this.sendKeys('Enter');

        this.logStderr(`Injection complete (gemini echo mode)`);
      } else {
        // Standard injection for Claude, Codex, etc.
        // Format: Relay message from Sender [abc12345]: content
        const injection = `Relay message from ${msg.from} ${idTag}: ${sanitizedBody}${truncationHint}`;

        // Clear any partial input
        await this.sendKeys('Escape');
        await this.sleep(30);
        await this.sendKeys('C-u');
        await this.sleep(30);

        // Type the message
        await this.sendKeysLiteral(injection);
        await this.sleep(50);

        // Submit
        await this.sendKeys('Enter');
        this.logStderr(`Injection complete`);
      }

    } catch (err: any) {
      this.logStderr(`Injection failed: ${err.message}`, true);
    } finally {
      this.isInjecting = false;

      if (this.messageQueue.length > 0) {
        setTimeout(() => this.checkForInjectionOpportunity(), 1000);
      }
    }
  }

  /**
   * Send special keys to tmux
   */
  private async sendKeys(keys: string): Promise<void> {
    await execAsync(`tmux send-keys -t ${this.sessionName} ${keys}`);
  }

  /**
   * Send literal text to tmux
   */
  private async sendKeysLiteral(text: string): Promise<void> {
    // Escape for shell and use -l for literal
    // Must escape: \ " $ ` ! and remove any newlines
    const escaped = text
      .replace(/[\r\n]+/g, ' ')  // Remove any newlines first
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\$/g, '\\$')
      .replace(/`/g, '\\`')
      .replace(/!/g, '\\!');
    await execAsync(`tmux send-keys -t ${this.sessionName} -l "${escaped}"`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
  }

  /**
   * Stop and cleanup
   */
  stop(): void {
    if (!this.running) return;
    this.running = false;

    // Stop polling
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }

    // Kill tmux session
    try {
      execSync(`tmux kill-session -t ${this.sessionName} 2>/dev/null`);
    } catch {
      // Ignore
    }

    // Disconnect relay
    this.client.destroy();
  }

  get isRunning(): boolean {
    return this.running;
  }

  get name(): string {
    return this.config.name;
  }
}
