/**
 * TmuxWrapper - Attach-based tmux wrapper
 *
 * Architecture:
 * 1. Start agent in detached tmux session
 * 2. Attach user to tmux (they see real terminal)
 * 3. Background: poll capture-pane silently (no stdout writes)
 * 4. Background: parse ->relay commands, send to daemon
 * 5. Background: inject messages via send-keys
 *
 * The key insight: user sees the REAL tmux session, not a proxy.
 * We just do background parsing and injection.
 */

import { exec, execSync, spawn, ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { RelayClient } from './client.js';
import { OutputParser, type ParsedCommand, parseSummaryWithDetails, parseSessionEndFromOutput, ParsedMessageMetadata } from './parser.js';
import { InboxManager } from './inbox.js';
import type { SendPayload } from '../protocol/types.js';
import { SqliteStorageAdapter } from '../storage/sqlite-adapter.js';
import { getProjectPaths } from '../utils/project-namespace.js';

const execAsync = promisify(exec);
const escapeRegex = (str: string): string => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Constants for cursor stability detection in waitForClearInput
/** Number of consecutive polls with stable cursor before assuming input is clear */
const STABLE_CURSOR_THRESHOLD = 3;
/** Maximum cursor X position that indicates a prompt (typical prompts are 1-4 chars) */
const MAX_PROMPT_CURSOR_POSITION = 4;
/** Maximum characters to show in debug log truncation */
const DEBUG_LOG_TRUNCATE_LENGTH = 40;
/** Maximum characters to show in relay command log truncation */
const RELAY_LOG_TRUNCATE_LENGTH = 50;

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
  /** How long with no output before marking session idle (ms) */
  activityIdleThresholdMs?: number;
  /** Max time to wait for clear input before injecting (ms) */
  inputWaitTimeoutMs?: number;
  /** Polling interval when waiting for clear input (ms) */
  inputWaitPollMs?: number;
  /** CLI type for special handling (auto-detected from command if not set) */
  cliType?: 'claude' | 'codex' | 'gemini' | 'other';
  /** Enable tmux mouse mode for scroll passthrough (default: true) */
  mouseMode?: boolean;
  /** Relay prefix pattern (default: '->relay:') */
  relayPrefix?: string;
}

/**
 * Get the default relay prefix for a given CLI type.
 * All agents now use '->relay:' as the unified prefix.
 */
export function getDefaultPrefix(cliType: 'claude' | 'codex' | 'gemini' | 'other'): string {
  // Unified prefix for all agent types
  return '->relay:';
}

export class TmuxWrapper {
  private config: TmuxWrapperConfig;
  private sessionName: string;
  private client: RelayClient;
  private parser: OutputParser;
  private inbox?: InboxManager;
  private storage?: SqliteStorageAdapter;
  private storageReady: Promise<boolean>; // Resolves true if storage initialized, false if failed
  private running = false;
  private pollTimer?: NodeJS.Timeout;
  private attachProcess?: ChildProcess;
  private lastCapturedOutput = '';
  private lastOutputTime = 0;
  private lastActivityTime = Date.now();
  private activityState: 'active' | 'idle' | 'disconnected' = 'disconnected';
  private recentlySentMessages: Map<string, number> = new Map();
  private sentMessageHashes: Set<string> = new Set(); // Permanent dedup
  private messageQueue: Array<{ from: string; body: string; messageId: string }> = [];
  private isInjecting = false;
  // Track processed output to avoid re-parsing
  private processedOutputLength = 0;
  private lastDebugLog = 0;
  private cliType: 'claude' | 'codex' | 'gemini' | 'other';
  private relayPrefix: string;
  private lastSummaryHash = ''; // Dedup summary saves
  private lastSummaryRawContent = ''; // Dedup invalid JSON error logging
  private sessionEndProcessed = false; // Track if we've already processed session end

  constructor(config: TmuxWrapperConfig) {
    this.config = {
      cols: process.stdout.columns || 120,
      rows: process.stdout.rows || 40,
      pollInterval: 200, // Slightly slower polling since we're not displaying
      idleBeforeInjectMs: 1500,
      injectRetryMs: 500,
      debug: false,
      debugLogIntervalMs: 0,
      mouseMode: true, // Enable mouse scroll passthrough by default
      activityIdleThresholdMs: 30_000, // Consider idle after 30s with no output
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

    // Determine relay prefix: explicit config > auto-detect from CLI type
    this.relayPrefix = config.relayPrefix ?? getDefaultPrefix(this.cliType);

    // Generate unique session name
    this.sessionName = `relay-${config.name}-${process.pid}`;

    this.client = new RelayClient({
      agentName: config.name,
      socketPath: config.socketPath,
      cli: this.cliType,
      workingDirectory: this.config.cwd ?? process.cwd(),
    });

    this.parser = new OutputParser({ prefix: this.relayPrefix });

    // Initialize inbox if using file-based messaging
    if (config.useInbox) {
      this.inbox = new InboxManager({
        agentName: config.name,
        inboxDir: config.inboxDir,
      });
    }

    // Initialize storage for session/summary persistence
    const projectPaths = getProjectPaths();
    this.storage = new SqliteStorageAdapter({ dbPath: projectPaths.dbPath });
    // Initialize asynchronously (don't block constructor) - methods await storageReady
    this.storageReady = this.storage.init().then(() => true).catch(err => {
      this.logStderr(`Failed to initialize storage: ${err.message}`, true);
      this.storage = undefined;
      return false;
    });

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
    if (!force && !this.config.debug) return;

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
    this.logStderr(`Prefix: ${this.relayPrefix} (use ${this.relayPrefix}AgentName to send)`);

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
        'set -g status-left-length 100',      // Provide ample space for agent name in status bar
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
    this.lastActivityTime = Date.now();
    this.activityState = 'active';

    // Inject instructions for the agent (after a delay to let CLI initialize)
    setTimeout(() => this.injectInstructions(), 3000);

    // Start background polling (silent - no stdout writes)
    this.startSilentPolling();

    // Attach user to tmux session
    // This takes over stdin/stdout - user sees the real terminal
    this.attachToSession();
  }

  /**
   * Inject usage instructions for the agent
   */
  private async injectInstructions(): Promise<void> {
    if (!this.running) return;

    const instructions = [
      `[Agent Relay] You are "${this.config.name}" - connected for real-time messaging.`,
      `SEND: ${this.relayPrefix}AgentName message (or ${this.relayPrefix}* to broadcast)`,
      `RECEIVE: Messages appear as "Relay message from X [id]: content"`,
      `SUMMARY: Periodically output [[SUMMARY]]{"currentTask":"...","context":"..."}[[/SUMMARY]] to track progress`,
      `END: Output [[SESSION_END]]{"summary":"..."}[[/SESSION_END]] when your task is complete`,
    ].join(' | ');

    try {
      await this.sendKeysLiteral(instructions);
      await this.sleep(50);
      await this.sendKeys('Enter');
    } catch {
      // Silent fail - instructions are nice-to-have
    }
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
          // -J joins wrapped lines so long prompts/messages stay intact
          `tmux capture-pane -t ${this.sessionName} -p -J 2>/dev/null`
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
   * Start silent polling for ->relay commands
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
   * Poll for ->relay commands in output (silent)
   */
  private async pollForRelayCommands(): Promise<void> {
    if (!this.running) return;

    try {
      // Capture scrollback
      const { stdout } = await execAsync(
        // -J joins wrapped lines to avoid truncating ->relay commands mid-line
        `tmux capture-pane -t ${this.sessionName} -p -J -S - 2>/dev/null`
      );

      // Always parse the FULL capture for ->relay commands
      // This handles terminal UIs that rewrite content in place
      const cleanContent = this.stripAnsi(stdout);
      // Join continuation lines that TUIs split across multiple lines
      const joinedContent = this.joinContinuationLines(cleanContent);
      const { commands } = this.parser.parse(joinedContent);

      // Track last output time for injection timing
      if (stdout.length !== this.processedOutputLength) {
        this.lastOutputTime = Date.now();
        this.markActivity();
        this.processedOutputLength = stdout.length;
      }

      // Send any commands found (deduplication handles repeats)
      for (const cmd of commands) {
        this.sendRelayCommand(cmd);
      }

      // Check for [[SUMMARY]] blocks and save to storage
      this.parseSummaryAndSave(cleanContent);

      // Check for [[SESSION_END]] blocks to explicitly close session
      this.parseSessionEndAndClose(cleanContent);

      this.updateActivityState();

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
   * Join continuation lines after ->relay commands.
   * Claude Code and other TUIs insert real newlines in output, causing
   * ->relay messages to span multiple lines. This joins indented
   * continuation lines back to the ->relay line.
   */
  private joinContinuationLines(content: string): string {
    const lines = content.split('\n');
    const result: string[] = [];

    // Pattern to detect relay command line (with optional bullet prefix)
    const escapedPrefix = escapeRegex(this.relayPrefix);
    const relayPattern = new RegExp(
      `^(?:\\s*(?:[>$%#→➜›»●•◦‣⁃\\-*⏺◆◇○□■]\\s*)*)?${escapedPrefix}`
    );
    // Pattern to detect a continuation line (starts with spaces, no bullet/command)
    const continuationPattern = /^[ \t]+[^>$%#→➜›»●•◦‣⁃\-*⏺◆◇○□■\s]/;
    // Pattern to detect a new block/bullet (stops continuation)
    const newBlockPattern = /^(?:\s*)?[>$%#→➜›»●•◦‣⁃\-*⏺◆◇○□■]/;

    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      // Check if this is a ->relay line
      if (relayPattern.test(line)) {
        let joined = line;
        let j = i + 1;

        // Look ahead for continuation lines
        while (j < lines.length) {
          const nextLine = lines[j];

          // Empty line stops continuation
          if (nextLine.trim() === '') break;

          // New bullet/block stops continuation
          if (newBlockPattern.test(nextLine)) break;

          // Check if it looks like a continuation (indented text)
          if (continuationPattern.test(nextLine)) {
            // Join with space, trimming the indentation
            joined += ' ' + nextLine.trim();
            j++;
          } else {
            break;
          }
        }

        result.push(joined);
        i = j; // Skip the lines we joined
      } else {
        result.push(line);
        i++;
      }
    }

    return result.join('\n');
  }

  /**
   * Record recent activity and transition back to active if needed.
   */
  private markActivity(): void {
    this.lastActivityTime = Date.now();
    if (this.activityState === 'idle') {
      this.activityState = 'active';
      this.logStderr('Session active');
    }
  }

  /**
   * Update activity state based on idle threshold and trigger injections when idle.
   */
  private updateActivityState(): void {
    if (this.activityState === 'disconnected') return;

    const now = Date.now();
    const idleThreshold = this.config.activityIdleThresholdMs ?? 30000;
    const timeSinceActivity = now - this.lastActivityTime;

    if (timeSinceActivity > idleThreshold && this.activityState === 'active') {
      this.activityState = 'idle';
      this.logStderr('Session went idle');
      this.checkForInjectionOpportunity();
    } else if (timeSinceActivity <= idleThreshold && this.activityState === 'idle') {
      this.activityState = 'active';
      this.logStderr('Session active');
    }
  }

  /**
   * Send relay command to daemon
   */
  private sendRelayCommand(cmd: ParsedCommand): void {
    const msgHash = `${cmd.to}:${cmd.body}`;

    // Permanent dedup - never send the same message twice (silent)
    if (this.sentMessageHashes.has(msgHash)) {
      return;
    }

    const success = this.client.sendMessage(cmd.to, cmd.body, cmd.kind, cmd.data);
    if (success) {
      this.sentMessageHashes.add(msgHash);
      const truncatedBody = cmd.body.substring(0, Math.min(RELAY_LOG_TRUNCATE_LENGTH, cmd.body.length));
      this.logStderr(`→ ${cmd.to}: ${truncatedBody}...`);
    } else if (this.client.state !== 'READY') {
      // Only log failure once per state change
      this.logStderr(`Send failed (client ${this.client.state})`);
    }
  }

  /**
   * Parse [[SUMMARY]] blocks from output and save to storage.
   * Agents can output summaries to maintain running context:
   *
   * [[SUMMARY]]
   * {"currentTask": "Implementing auth", "context": "Completed login flow"}
   * [[/SUMMARY]]
   */
  private parseSummaryAndSave(content: string): void {
    const result = parseSummaryWithDetails(content);

    // No SUMMARY block found
    if (!result.found) return;

    // Dedup based on raw content - prevents repeated error logging for same invalid JSON
    if (result.rawContent === this.lastSummaryRawContent) return;
    this.lastSummaryRawContent = result.rawContent || '';

    // Invalid JSON - log error once (deduped above)
    if (!result.valid) {
      this.logStderr('[parser] Invalid JSON in SUMMARY block');
      return;
    }

    const summary = result.summary!;

    // Dedup valid summaries - don't save same summary twice
    const summaryHash = JSON.stringify(summary);
    if (summaryHash === this.lastSummaryHash) return;
    this.lastSummaryHash = summaryHash;

    // Wait for storage to be ready before saving
    this.storageReady.then(ready => {
      if (!ready || !this.storage) {
        this.logStderr('Cannot save summary: storage not initialized');
        return;
      }

      const projectPaths = getProjectPaths();
      this.storage.saveAgentSummary({
        agentName: this.config.name,
        projectId: projectPaths.projectId,
        currentTask: summary.currentTask,
        completedTasks: summary.completedTasks,
        decisions: summary.decisions,
        context: summary.context,
        files: summary.files,
      }).then(() => {
        this.logStderr(`Saved agent summary: ${summary.currentTask || 'updated context'}`);
      }).catch(err => {
        this.logStderr(`Failed to save summary: ${err.message}`, true);
      });
    });
  }

  /**
   * Parse [[SESSION_END]] blocks from output and close session explicitly.
   * Agents output this to mark their work session as complete:
   *
   * [[SESSION_END]]
   * {"summary": "Completed auth module", "completedTasks": ["login", "logout"]}
   * [[/SESSION_END]]
   */
  private parseSessionEndAndClose(content: string): void {
    if (this.sessionEndProcessed) return; // Only process once per session

    const sessionEnd = parseSessionEndFromOutput(content);
    if (!sessionEnd) return;

    // Get session ID from client connection - if not available yet, don't set flag
    // so we can retry when sessionId becomes available
    const sessionId = this.client.currentSessionId;
    if (!sessionId) {
      this.logStderr('Cannot close session: no session ID yet, will retry');
      return;
    }

    this.sessionEndProcessed = true;

    // Wait for storage to be ready before attempting to close session
    this.storageReady.then(ready => {
      if (!ready || !this.storage) {
        this.logStderr('Cannot close session: storage not initialized');
        return;
      }

      this.storage.endSession(sessionId, {
        summary: sessionEnd.summary,
        closedBy: 'agent',
      }).then(() => {
        this.logStderr(`Session closed by agent: ${sessionEnd.summary || 'complete'}`);
      }).catch(err => {
        this.logStderr(`Failed to close session: ${err.message}`, true);
      });
    });
  }

  /**
   * Handle incoming message from relay
   */
  private handleIncomingMessage(from: string, payload: SendPayload, messageId: string): void {
    const truncatedBody = payload.body.substring(0, Math.min(DEBUG_LOG_TRUNCATE_LENGTH, payload.body.length));
    this.logStderr(`← ${from}: ${truncatedBody}...`);

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

      // Gemini interprets certain keywords (While, For, If, etc.) as shell commands
      // Wrap in backticks to prevent shell keyword interpretation
      if (this.cliType === 'gemini') {
        sanitizedBody = `\`${sanitizedBody.replace(/`/g, "'")}\``;
      }

      // Short message ID for display (first 8 chars)
      const shortId = msg.messageId.substring(0, 8);

      // Remove message truncation to allow full messages to pass through
      const wasTruncated = false;

      // Always include message ID; add lookup hint if truncated
      const idTag = `[${shortId}]`;
      const truncationHint = wasTruncated
        ? ` [TRUNCATED - run "agent-relay read ${msg.messageId}"]`
        : '';

      // Wait for input to be clear before injecting
      const waitTimeoutMs = this.config.inputWaitTimeoutMs ?? 5000;
      const waitPollMs = this.config.inputWaitPollMs ?? 200;
      const inputClear = await this.waitForClearInput(waitTimeoutMs, waitPollMs);
      if (!inputClear) {
        // Input still has text after timeout - clear it forcefully
        this.logStderr('Input not clear after waiting, clearing forcefully');
        await this.sendKeys('Escape');
        await this.sleep(30);
        await this.sendKeys('C-u');
        await this.sleep(30);
      }

      // For Gemini: check if we're at a shell prompt ($) vs chat prompt (>)
      // If at shell prompt, skip injection to avoid shell command execution
      if (this.cliType === 'gemini') {
        const lastLine = await this.getLastLine();
        const cleanLine = this.stripAnsi(lastLine).trim();
        if (/^\$\s*$/.test(cleanLine) || /^\s*\$\s*$/.test(cleanLine)) {
          this.logStderr('Gemini at shell prompt, skipping injection to avoid shell execution');
          // Re-queue the message for later
          this.messageQueue.unshift(msg);
          this.isInjecting = false;
          setTimeout(() => this.checkForInjectionOpportunity(), 2000);
          return;
        }
      }

      // Standard injection for all CLIs including Gemini
      // Format: Relay message from Sender [abc12345]: content
      const injection = `Relay message from ${msg.from} ${idTag}: ${sanitizedBody}${truncationHint}`;

      // Type the message as literal text
      await this.sendKeysLiteral(injection);
      await this.sleep(50);

      // Submit
      await this.sendKeys('Enter');
      this.logStderr(`Injection complete`);

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
   * Reset session-specific state for wrapper reuse.
   * Call this when starting a new session with the same wrapper instance.
   */
  resetSessionState(): void {
    this.sessionEndProcessed = false;
    this.lastSummaryHash = '';
    this.lastSummaryRawContent = '';
  }

  /**
   * Get the prompt pattern for the current CLI type.
   */
  private getPromptPattern(): RegExp {
    const promptPatterns: Record<string, RegExp> = {
      claude: /^[>›»]\s*$/,           // Claude: "> " or similar
      gemini: /^[>›»]\s*$/,           // Gemini: "> "
      codex: /^[>›»]\s*$/,            // Codex: "> "
      other: /^[>$%#➜›»]\s*$/,        // Shell or other: "$ ", "> ", etc.
    };

    return promptPatterns[this.cliType] || promptPatterns.other;
  }

  /**
   * Capture the last non-empty line from the tmux pane.
   */
  private async getLastLine(): Promise<string> {
    try {
      const { stdout } = await execAsync(
        `tmux capture-pane -t ${this.sessionName} -p -J 2>/dev/null`
      );
      const lines = stdout.split('\n').filter(l => l.length > 0);
      return lines[lines.length - 1] || '';
    } catch {
      return '';
    }
  }

  /**
   * Detect if the provided line contains visible user input (beyond the prompt).
   */
  private hasVisibleInput(line: string): boolean {
    const cleanLine = this.stripAnsi(line).trimEnd();
    if (cleanLine === '') return false;

    return !this.getPromptPattern().test(cleanLine);
  }

  /**
   * Check if the input line is clear (no user-typed text after the prompt).
   * Returns true if the last visible line appears to be just a prompt.
   */
  private async isInputClear(lastLine?: string): Promise<boolean> {
    try {
      const lineToCheck = lastLine ?? await this.getLastLine();
      const cleanLine = this.stripAnsi(lineToCheck).trimEnd();
      const isClear = this.getPromptPattern().test(cleanLine);

      if (this.config.debug) {
        const truncatedLine = cleanLine.substring(0, Math.min(DEBUG_LOG_TRUNCATE_LENGTH, cleanLine.length));
        this.logStderr(`isInputClear: lastLine="${truncatedLine}", clear=${isClear}`);
      }

      return isClear;
    } catch {
      // If we can't capture, assume not clear (safer)
      return false;
    }
  }

  /**
   * Get cursor X position to detect input length.
   * Returns the cursor column (0-indexed).
   */
  private async getCursorX(): Promise<number> {
    try {
      const { stdout } = await execAsync(
        `tmux display-message -t ${this.sessionName} -p "#{cursor_x}" 2>/dev/null`
      );
      return parseInt(stdout.trim(), 10) || 0;
    } catch {
      return 0;
    }
  }

  /**
   * Wait for the input line to be clear before injecting.
   * Polls until the input appears empty or timeout is reached.
   *
   * @param maxWaitMs Maximum time to wait (default 5000ms)
   * @param pollIntervalMs How often to check (default 200ms)
   * @returns true if input became clear, false if timed out
   */
  private async waitForClearInput(maxWaitMs = 5000, pollIntervalMs = 200): Promise<boolean> {
    const startTime = Date.now();
    let lastCursorX = -1;
    let stableCursorCount = 0;

    while (Date.now() - startTime < maxWaitMs) {
      const lastLine = await this.getLastLine();

      // Check if input line is just a prompt
      if (await this.isInputClear(lastLine)) {
        return true;
      }

      const hasInput = this.hasVisibleInput(lastLine);

      // Also check cursor stability - if cursor is moving, agent is typing
      const cursorX = await this.getCursorX();
      if (!hasInput && cursorX === lastCursorX) {
        stableCursorCount++;
        // If cursor has been stable for enough polls and at typical prompt position,
        // the agent might be done but we just can't match the prompt pattern
        if (stableCursorCount >= STABLE_CURSOR_THRESHOLD && cursorX <= MAX_PROMPT_CURSOR_POSITION) {
          this.logStderr(`waitForClearInput: cursor stable at x=${cursorX}, assuming clear`);
          return true;
        }
      } else {
        stableCursorCount = 0;
        lastCursorX = cursorX;
      }

      await this.sleep(pollIntervalMs);
    }

    this.logStderr(`waitForClearInput: timed out after ${maxWaitMs}ms`);
    return false;
  }

  /**
   * Stop and cleanup
   */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.activityState = 'disconnected';

    // Reset session state for potential reuse
    this.resetSessionState();

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
