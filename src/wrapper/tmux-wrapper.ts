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
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { BaseWrapper, type BaseWrapperConfig } from './base-wrapper.js';
import { OutputParser, type ParsedCommand, type ParsedSummary, parseSummaryWithDetails, parseSessionEndFromOutput } from './parser.js';
import {
  hasContinuityCommand,
  parseContinuityCommand,
} from '../continuity/index.js';
import { InboxManager } from './inbox.js';
import type { SendPayload, SendMeta } from '../protocol/types.js';
import { SqliteStorageAdapter } from '../storage/sqlite-adapter.js';
import { getProjectPaths } from '../utils/project-namespace.js';
import { getTmuxPath } from '../utils/tmux-resolver.js';
import { findAgentConfig } from '../utils/agent-config.js';
import {
  TrajectoryIntegration,
  getTrajectoryIntegration,
  detectPhaseFromContent,
  detectToolCalls,
  detectErrors,
  getCompactTrailInstructions,
  getTrailEnvVars,
  type PDEROPhase,
} from '../trajectory/integration.js';
import { escapeForShell } from '../bridge/utils.js';
import { detectProviderAuthRevocation, type AuthRevocationResult } from './auth-detection.js';
import {
  type CliType,
  type InjectionCallbacks,
  stripAnsi,
  sleep,
  getDefaultRelayPrefix,
  buildInjectionString,
  injectWithRetry as sharedInjectWithRetry,
  INJECTION_CONSTANTS,
  CLI_QUIRKS,
} from './shared.js';

const execAsync = promisify(exec);

// Constants for cursor stability detection in waitForClearInput
/** Number of consecutive polls with stable cursor before assuming input is clear */
const STABLE_CURSOR_THRESHOLD = 3;
/** Maximum cursor X position that indicates a prompt (typical prompts are 1-4 chars) */
const MAX_PROMPT_CURSOR_POSITION = 4;
/** Maximum characters to show in debug log truncation */
const DEBUG_LOG_TRUNCATE_LENGTH = 40;
/** Maximum characters to show in relay command log truncation */
const RELAY_LOG_TRUNCATE_LENGTH = 50;

export interface TmuxWrapperConfig extends BaseWrapperConfig {
  cols?: number;
  rows?: number;
  /** Optional program identifier (e.g., 'claude', 'gpt-4o') */
  program?: string;
  /** Optional model identifier (e.g., 'claude-3-opus') */
  model?: string;
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
  /** Enable tmux mouse mode for scroll passthrough (default: true) */
  mouseMode?: boolean;
  /** Max time to wait for stable pane output before injection (ms) */
  outputStabilityTimeoutMs?: number;
  /** Poll interval when checking pane stability before injection (ms) */
  outputStabilityPollMs?: number;
}

/**
 * Get the default relay prefix for a given CLI type.
 * All agents now use '->relay:' as the unified prefix.
 * @deprecated Use getDefaultRelayPrefix() from shared.js instead
 */
export function getDefaultPrefix(_cliType: CliType): string {
  return getDefaultRelayPrefix();
}

export class TmuxWrapper extends BaseWrapper {
  protected override config: TmuxWrapperConfig;
  private sessionName: string;
  private parser: OutputParser;
  private inbox?: InboxManager;
  private storage?: SqliteStorageAdapter;
  private storageReady: Promise<boolean>; // Resolves true if storage initialized, false if failed
  private pollTimer?: NodeJS.Timeout;
  private attachProcess?: ChildProcess;
  private lastCapturedOutput = '';
  private lastOutputTime = 0;
  private lastActivityTime = Date.now();
  private activityState: 'active' | 'idle' | 'disconnected' = 'disconnected';
  private recentlySentMessages: Map<string, number> = new Map();
  // Track processed output to avoid re-parsing
  private processedOutputLength = 0;
  private lastLoggedLength = 0; // Track length for incremental log streaming
  private lastDebugLog = 0;
  private lastSummaryHash = ''; // Dedup summary saves
  private pendingRelayCommands: ParsedCommand[] = [];
  private queuedMessageHashes: Set<string> = new Set(); // For offline queue dedup
  private readonly MAX_PENDING_RELAY_COMMANDS = 50;
  private receivedMessageIdSet: Set<string> = new Set();
  private receivedMessageIdOrder: string[] = [];
  private readonly MAX_RECEIVED_MESSAGES = 2000;
  private tmuxPath: string; // Resolved path to tmux binary (system or bundled)
  private trajectory?: TrajectoryIntegration; // Trajectory tracking via trail
  private lastDetectedPhase?: PDEROPhase; // Track last auto-detected PDERO phase
  private seenToolCalls: Set<string> = new Set(); // Dedup tool call trajectory events
  private seenErrors: Set<string> = new Set(); // Dedup error trajectory events
  private authRevoked = false; // Track if auth has been revoked
  private lastAuthCheck = 0; // Timestamp of last auth check (throttle)
  private readonly AUTH_CHECK_INTERVAL = 5000; // Check auth status every 5 seconds max

  constructor(config: TmuxWrapperConfig) {
    // Merge defaults with config
    const mergedConfig: TmuxWrapperConfig = {
      cols: process.stdout.columns || 120,
      rows: process.stdout.rows || 40,
      pollInterval: 200, // Slightly slower polling since we're not displaying
      idleBeforeInjectMs: 1500,
      injectRetryMs: 500,
      debug: false,
      debugLogIntervalMs: 0,
      mouseMode: true, // Enable mouse scroll passthrough by default
      activityIdleThresholdMs: 30_000, // Consider idle after 30s with no output
      outputStabilityTimeoutMs: 2000,
      outputStabilityPollMs: 200,
      streamLogs: true, // Stream output to daemon for dashboard
      ...config,
    };

    // Call parent constructor (initializes client, cliType, relayPrefix, continuity)
    super(mergedConfig);
    this.config = mergedConfig;

    // Session name (one agent per name - starting a duplicate kills the existing one)
    this.sessionName = `relay-${config.name}`;

    // Resolve tmux path early so we fail fast if tmux isn't available
    this.tmuxPath = getTmuxPath();

    // Auto-detect agent role from .claude/agents/ or .openagents/ if task not provided
    let detectedTask = this.config.task;
    if (!detectedTask) {
      const agentConfig = findAgentConfig(config.name, this.config.cwd);
      if (agentConfig?.description) {
        detectedTask = agentConfig.description;
        this.logStderr(`Auto-detected role: ${detectedTask.substring(0, 60)}...`, true);
      }
    }

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

    // Initialize trajectory tracking via trail CLI
    this.trajectory = getTrajectoryIntegration(projectPaths.projectId, config.name);

    this.client.onStateChange = (state) => {
      // Only log to stderr, never stdout (user is in tmux)
      if (state === 'READY') {
        this.logStderr('Connected to relay daemon');
        this.flushQueuedRelayCommands();
      } else if (state === 'BACKOFF') {
        this.logStderr('Relay unavailable, will retry (backoff)');
      } else if (state === 'DISCONNECTED') {
        this.logStderr('Relay disconnected (offline mode)');
      } else if (state === 'CONNECTING') {
        this.logStderr('Connecting to relay daemon...');
      }
    };
  }

  // =========================================================================
  // Abstract method implementations
  // =========================================================================

  /**
   * Inject content into the tmux session via paste
   */
  protected async performInjection(content: string): Promise<void> {
    await this.pasteLiteral(content);
  }

  /**
   * Get cleaned output for parsing (strip ANSI codes)
   */
  protected getCleanOutput(): string {
    return stripAnsi(this.lastCapturedOutput);
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
   * Detect PDERO phase from output content and auto-transition if needed.
   * Also detects tool calls and errors, recording them to the trajectory.
   */
  private detectAndTransitionPhase(content: string): void {
    if (!this.trajectory) return;

    // Detect phase transitions
    const detectedPhase = detectPhaseFromContent(content);
    if (detectedPhase && detectedPhase !== this.lastDetectedPhase) {
      const currentPhase = this.trajectory.getPhase();
      if (detectedPhase !== currentPhase) {
        this.trajectory.transition(detectedPhase, 'Auto-detected from output');
        this.lastDetectedPhase = detectedPhase;
        this.logStderr(`Phase transition: ${currentPhase || 'none'} → ${detectedPhase}`);
      }
    }

    // Detect and record tool calls
    // Note: We deduplicate by tool+status to record each unique tool type once per session
    // (e.g., "Read" started, "Read" completed). This provides a summary of tools used
    // without flooding the trajectory with every individual invocation.
    const tools = detectToolCalls(content);
    for (const tool of tools) {
      const key = `${tool.tool}:${tool.status || 'started'}`;
      if (!this.seenToolCalls.has(key)) {
        this.seenToolCalls.add(key);
        const statusLabel = tool.status === 'completed' ? ' (completed)' : '';
        this.trajectory.event(`Tool: ${tool.tool}${statusLabel}`, 'tool_call');
      }
    }

    // Detect and record errors
    const errors = detectErrors(content);
    for (const error of errors) {
      if (!this.seenErrors.has(error.message)) {
        this.seenErrors.add(error.message);
        const prefix = error.type === 'warning' ? 'Warning' : 'Error';
        this.trajectory.event(`${prefix}: ${error.message}`, 'error');
      }
    }
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
      await execAsync(`"${this.tmuxPath}" has-session -t ${this.sessionName} 2>/dev/null`);
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
    this.client.connect().catch((err: Error) => {
      // Connection failures will retry via client backoff; surface once to stderr.
      this.logStderr(`Relay connect failed: ${err.message}. Will retry if enabled.`, true);
    });

    // Kill any existing session with this name
    try {
      execSync(`"${this.tmuxPath}" kill-session -t ${this.sessionName} 2>/dev/null`);
    } catch {
      // Session doesn't exist, that's fine
    }

    // Build the command - properly quote args that contain spaces
    const fullCommand = this.buildCommand();
    this.logStderr(`Command: ${fullCommand}`);
    this.logStderr(`Prefix: ${this.relayPrefix} (use ${this.relayPrefix}AgentName to send)`);

    // Create tmux session
    try {
      execSync(`"${this.tmuxPath}" new-session -d -s ${this.sessionName} -x ${this.config.cols} -y ${this.config.rows}`, {
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
        'set -g mode-keys vi',                // Predictable key table (avoid copy-mode surprises)
      ];

      // Add mouse mode if enabled (allows scroll passthrough to CLI apps)
      if (this.config.mouseMode) {
        tmuxSettings.unshift('set -g mouse on');
        this.logStderr('Mouse mode enabled (scroll should work in app)');
      }

      for (const setting of tmuxSettings) {
        try {
          execSync(`"${this.tmuxPath}" ${setting}`, { stdio: 'pipe' });
        } catch {
          // Some settings may not be available in older tmux versions
        }
      }

      // Mouse scroll should work for both TUIs (alternate screen) and plain shells.
      // If the pane is in alternate screen, pass scroll to the app; otherwise enter copy-mode and scroll tmux history.
      const tmuxMouseBindings = [
        'unbind -T root WheelUpPane',
        'unbind -T root WheelDownPane',
        'unbind -T root MouseDrag1Pane',
        'bind -T root WheelUpPane if-shell -F "#{alternate_on}" "send-keys -M" "copy-mode -e; send-keys -X scroll-up"',
        'bind -T root WheelDownPane if-shell -F "#{alternate_on}" "send-keys -M" "send-keys -X scroll-down"',
        'bind -T root MouseDrag1Pane if-shell -F "#{alternate_on}" "send-keys -M" "copy-mode -e"',
      ];

      for (const setting of tmuxMouseBindings) {
        try {
          execSync(`"${this.tmuxPath}" ${setting}`, { stdio: 'pipe' });
        } catch {
          // Ignore on older tmux versions lacking these key tables
        }
      }

      // Set environment variables including trail/trajectory vars
      const projectPaths = getProjectPaths();
      const trailEnvVars = getTrailEnvVars(projectPaths.projectId, this.config.name, projectPaths.dataDir);

      for (const [key, value] of Object.entries({
        ...this.config.env,
        ...trailEnvVars,
        AGENT_RELAY_NAME: this.config.name,
        TERM: 'xterm-256color',
      })) {
        // Use proper shell escaping to prevent command injection via env var values
        const escaped = escapeForShell(value);
        execSync(`"${this.tmuxPath}" setenv -t ${this.sessionName} ${key} "${escaped}"`);
      }

      // Wait for shell to be ready (look for prompt)
      await this.waitForShellReady();

      // Send the command to run
      await this.sendKeysLiteral(fullCommand);
      await sleep(100);
      await this.sendKeys('Enter');

    } catch (err: any) {
      throw new Error(`Failed to create tmux session: ${err.message}`);
    }

    // Wait for session to be ready
    await this.waitForSession();

    this.running = true;
    this.lastActivityTime = Date.now();
    this.activityState = 'active';

    // Initialize trajectory tracking (auto-start if task provided)
    this.initializeTrajectory();

    // Initialize continuity and get/create agentId
    this.initializeAgentId();

    // Inject instructions for the agent (after a delay to let CLI initialize)
    setTimeout(() => this.injectInstructions(), 3000);

    // Start background polling (silent - no stdout writes)
    this.startSilentPolling();

    // Attach user to tmux session
    // This takes over stdin/stdout - user sees the real terminal
    this.attachToSession();
  }

  /**
   * Initialize trajectory tracking
   * Auto-starts a trajectory if task is provided in config
   */
  private async initializeTrajectory(): Promise<void> {
    if (!this.trajectory) return;

    // Auto-start trajectory if task is provided
    if (this.config.task) {
      const success = await this.trajectory.initialize(this.config.task);
      if (success) {
        this.logStderr(`Trajectory started for task: ${this.config.task}`);
      }
    } else {
      // Just initialize without starting a trajectory
      await this.trajectory.initialize();
    }
  }

  /**
   * Initialize agent ID for continuity/resume functionality (uses logStderr for tmux)
   */
  protected override async initializeAgentId(): Promise<void> {
    if (!this.continuity) return;

    try {
      let ledger;

      // If resuming from a previous agent ID, try to find that ledger
      if (this.config.resumeAgentId) {
        ledger = await this.continuity.findLedgerByAgentId(this.config.resumeAgentId);
        if (ledger) {
          this.logStderr(`Resuming agent ID: ${ledger.agentId} (from previous session)`);
        } else {
          this.logStderr(`Resume agent ID ${this.config.resumeAgentId} not found, creating new`, true);
        }
      }

      // If not resuming or resume ID not found, get or create ledger
      if (!ledger) {
        ledger = await this.continuity.getOrCreateLedger(
          this.config.name,
          this.cliType
        );
        this.logStderr(`Agent ID: ${ledger.agentId} (use this to resume if agent dies)`);
      }

      this.agentId = ledger.agentId;
    } catch (err: any) {
      this.logStderr(`Failed to initialize agent ID: ${err.message}`, true);
    }
  }

  /**
   * Inject usage instructions for the agent including persistence protocol
   */
  private async injectInstructions(): Promise<void> {
    if (!this.running) return;

    // Use escaped prefix (\->relay:) in examples to prevent parser from treating them as real commands
    const escapedPrefix = '\\' + this.relayPrefix;

    // Build instructions including relay and trail
    const relayInstructions = [
      `[Agent Relay] You are "${this.config.name}" - connected for real-time messaging.`,
      `SEND: ${escapedPrefix}AgentName message`,
      `MULTI-LINE: ${escapedPrefix}AgentName <<<(newline)content(newline)>>> - ALWAYS end with >>> on its own line!`,
      `PERSIST: Output [[SUMMARY]]{"currentTask":"...","context":"..."}[[/SUMMARY]] after major work.`,
      `END: Output [[SESSION_END]]{"summary":"..."}[[/SESSION_END]] when session complete.`,
    ].join(' | ');

    // Add trail instructions if available
    const trailInstructions = getCompactTrailInstructions();

    try {
      await this.sendKeysLiteral(relayInstructions);
      await sleep(50);
      await this.sendKeys('Enter');

      // Inject trail instructions
      if (this.trajectory?.isTrailInstalledSync()) {
        await sleep(100);
        await this.sendKeysLiteral(trailInstructions);
        await sleep(50);
        await this.sendKeys('Enter');
      }

      // Inject continuity context from previous session
      await this.injectContinuityContext();
    } catch {
      // Silent fail - instructions are nice-to-have
    }
  }

  /**
   * Inject continuity context from previous session
   */
  private async injectContinuityContext(): Promise<void> {
    if (!this.continuity || !this.running) return;

    try {
      const context = await this.continuity.getStartupContext(this.config.name);
      if (context && context.formatted) {
        // Inject a brief notification about loaded context
        const notification = `[Continuity] Previous session context loaded. ${
          context.ledger ? `Task: ${context.ledger.currentTask?.slice(0, 50) || 'unknown'}` : ''
        }${context.handoff ? ` | Last handoff: ${context.handoff.createdAt.toISOString().split('T')[0]}` : ''}`;

        await sleep(200);
        await this.sendKeysLiteral(notification);
        await sleep(50);
        await this.sendKeys('Enter');

        // Queue the full context for injection when agent is ready
        this.messageQueue.push({
          from: 'system',
          body: context.formatted,
          messageId: `continuity-startup-${Date.now()}`,
        });
        this.checkForInjectionOpportunity();

        if (this.config.debug) {
          this.logStderr(`[CONTINUITY] Loaded context for ${this.config.name}`);
        }
      }
    } catch (err: any) {
      this.logStderr(`[CONTINUITY] Failed to load context: ${err.message}`, true);
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
          `"${this.tmuxPath}" capture-pane -t ${this.sessionName} -p -J 2>/dev/null`
        );

        // Check if the last non-empty line looks like a prompt
        const lines = stdout.split('\n').filter(l => l.trim());
        const lastLine = lines[lines.length - 1] || '';

        if (promptPatterns.test(lastLine)) {
          this.logStderr('Shell ready');
          // Extra delay to ensure shell is fully ready
          await sleep(200);
          return;
        }
      } catch {
        // Session might not be ready yet
      }

      await sleep(200);
    }

    // Fallback: proceed anyway after timeout
    this.logStderr('Shell ready timeout, proceeding anyway');
  }

  /**
   * Attach user to tmux session
   * This spawns tmux attach and lets it take over stdin/stdout
   */
  private attachToSession(): void {
    this.attachProcess = spawn(this.tmuxPath, ['attach-session', '-t', this.sessionName], {
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
        `"${this.tmuxPath}" capture-pane -t ${this.sessionName} -p -J -S - 2>/dev/null`
      );

      // Always parse the FULL capture for ->relay commands
      // This handles terminal UIs that rewrite content in place
      const cleanContent = stripAnsi(stdout);
      // Join continuation lines that TUIs split across multiple lines
      const joinedContent = this.joinContinuationLines(cleanContent);
      const { commands, output: filteredOutput } = this.parser.parse(joinedContent);

      // Debug: log relay commands being parsed
      if (commands.length > 0 && this.config.debug) {
        for (const cmd of commands) {
          const bodyPreview = cmd.body.substring(0, 80).replace(/\n/g, '\\n');
          this.logStderr(`[RELAY_PARSED] to=${cmd.to}, body="${bodyPreview}...", lines=${cmd.body.split('\n').length}`);
        }
      }

      // Track last output time for injection timing
      if (stdout.length !== this.processedOutputLength) {
        this.lastOutputTime = Date.now();
        this.markActivity();
        this.processedOutputLength = stdout.length;

        // Stream new output to daemon for dashboard log viewing
        // Use filtered output to exclude thinking blocks and relay commands
        if (this.config.streamLogs && this.client.state === 'READY') {
          // Send incremental filtered output since last log
          const newContent = filteredOutput.substring(this.lastLoggedLength);
          if (newContent.length > 0) {
            this.client.sendLog(newContent);
            this.lastLoggedLength = filteredOutput.length;
          }
        }
      }

      // Send any commands found (deduplication handles repeats)
      for (const cmd of commands) {
        this.sendRelayCommand(cmd);
      }

      // Check for [[SUMMARY]] blocks and save to storage
      this.parseSummaryAndSave(cleanContent);

      // Detect PDERO phase transitions from output content
      this.detectAndTransitionPhase(cleanContent);

      // Parse and handle continuity commands (->continuity:save, ->continuity:load, etc.)
      await this.parseContinuityCommands(joinedContent);

      // Check for [[SESSION_END]] blocks to explicitly close session
      this.parseSessionEndAndClose(cleanContent);

      // Check for ->relay:spawn and ->relay:release commands (any agent can spawn)
      // Use joinedContent to handle multi-line output from TUIs like Claude Code
      this.parseSpawnReleaseCommands(joinedContent);

      // Check for auth revocation (limited sessions scenario)
      this.checkAuthRevocation(cleanContent);

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
   * Check if the CLI output indicates auth has been revoked.
   * This can happen when the user authenticates elsewhere (limited sessions).
   */
  private checkAuthRevocation(output: string): void {
    // Don't check if already revoked or if we checked recently
    if (this.authRevoked) return;
    const now = Date.now();
    if (now - this.lastAuthCheck < this.AUTH_CHECK_INTERVAL) return;
    this.lastAuthCheck = now;

    // Get the CLI type/provider from config
    const provider = this.config.program || this.cliType || 'claude';

    // Check for auth revocation patterns in recent output
    const result = detectProviderAuthRevocation(output, provider);

    if (result.detected && result.confidence !== 'low') {
      this.authRevoked = true;
      this.logStderr(`[AUTH] Auth revocation detected (${result.confidence} confidence): ${result.message}`);

      // Send auth status message to daemon
      if (this.client.state === 'READY') {
        const authPayload = JSON.stringify({
          type: 'auth_revoked',
          agent: this.config.name,
          provider,
          message: result.message,
          confidence: result.confidence,
          timestamp: new Date().toISOString(),
        });
        this.client.sendMessage('#system', authPayload, 'message');
      }

      // Emit event for listeners
      this.emit('auth_revoked', {
        agent: this.config.name,
        provider,
        message: result.message,
        confidence: result.confidence,
      });
    }
  }

  /**
   * Reset auth revocation state (called after successful re-authentication)
   */
  public resetAuthState(): void {
    this.authRevoked = false;
    this.lastAuthCheck = 0;
    this.logStderr('[AUTH] Auth state reset');
  }

  /**
   * Check if auth has been revoked
   */
  public isAuthRevoked(): boolean {
    return this.authRevoked;
  }

  /**
   * Send relay command to daemon (overrides BaseWrapper for offline queue support)
   */
  protected override sendRelayCommand(cmd: ParsedCommand): void {
    const msgHash = `${cmd.to}:${cmd.body}`;

    // Permanent dedup - never send the same message twice (silent)
    if (this.sentMessageHashes.has(msgHash)) {
      return;
    }

    // If client not ready, queue for later and return
    if (this.client.state !== 'READY') {
      if (this.queuedMessageHashes.has(msgHash)) {
        return; // Already queued
      }
      if (this.pendingRelayCommands.length >= this.MAX_PENDING_RELAY_COMMANDS) {
        this.logStderr('Relay offline queue full, dropping oldest');
        const dropped = this.pendingRelayCommands.shift();
        if (dropped) {
          this.queuedMessageHashes.delete(`${dropped.to}:${dropped.body}`);
        }
      }
      this.pendingRelayCommands.push(cmd);
      this.queuedMessageHashes.add(msgHash);
      this.logStderr(`Relay offline; queued message to ${cmd.to}`);
      return;
    }

    // Convert ParsedMessageMetadata to SendMeta if present
    let sendMeta: SendMeta | undefined;
    if (cmd.meta) {
      sendMeta = {
        importance: cmd.meta.importance,
        replyTo: cmd.meta.replyTo,
        requires_ack: cmd.meta.ackRequired,
      };
    }

    const success = this.client.sendMessage(cmd.to, cmd.body, cmd.kind, cmd.data, cmd.thread, sendMeta);
    if (success) {
      this.sentMessageHashes.add(msgHash);
      this.queuedMessageHashes.delete(msgHash);
      const truncatedBody = cmd.body.substring(0, Math.min(RELAY_LOG_TRUNCATE_LENGTH, cmd.body.length));
      this.logStderr(`→ ${cmd.to}: ${truncatedBody}...`);

      // Record in trajectory via trail
      this.trajectory?.message('sent', this.config.name, cmd.to, cmd.body);
    } else if (this.client.state !== 'READY') {
      // Only log failure once per state change
      this.logStderr(`Send failed (client ${this.client.state})`);
    }
  }

  /**
   * Flush any queued relay commands when the client reconnects.
   */
  private flushQueuedRelayCommands(): void {
    if (this.pendingRelayCommands.length === 0) return;

    const queued = [...this.pendingRelayCommands];
    this.pendingRelayCommands = [];
    this.queuedMessageHashes.clear();

    for (const cmd of queued) {
      this.sendRelayCommand(cmd);
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

    // Save to continuity ledger for session recovery
    // This ensures the ledger has actual data instead of placeholders
    if (this.continuity) {
      this.saveSummaryToLedger(summary).catch(err => {
        this.logStderr(`Failed to save summary to ledger: ${err.message}`, true);
      });
    }

    // Wait for storage to be ready before saving to project storage
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
   * Save a parsed summary to the continuity ledger (uses logStderr for tmux).
   * Maps summary fields to ledger fields for session recovery.
   */
  protected override async saveSummaryToLedger(summary: ParsedSummary): Promise<void> {
    if (!this.continuity) return;

    const updates: Record<string, unknown> = {};

    // Map summary fields to ledger fields
    if (summary.currentTask) {
      updates.currentTask = summary.currentTask;
    }

    if (summary.completedTasks && summary.completedTasks.length > 0) {
      updates.completed = summary.completedTasks;
    }

    if (summary.context) {
      // Store context in inProgress as "next steps" hint
      updates.inProgress = [summary.context];
    }

    if (summary.files && summary.files.length > 0) {
      updates.fileContext = summary.files.map((f: string) => ({ path: f }));
    }

    // Only save if we have meaningful updates
    if (Object.keys(updates).length > 0) {
      await this.continuity.saveLedger(this.config.name, updates);
      this.logStderr('Saved summary to continuity ledger');
    }
  }

  /**
   * Parse ->continuity: commands from output and handle them.
   * Supported commands:
   *   ->continuity:save <<<...>>>  - Save session state to ledger
   *   ->continuity:load            - Request context injection
   *   ->continuity:search "query"  - Search past handoffs
   *   ->continuity:uncertain "..."  - Mark item as uncertain
   *   ->continuity:handoff <<<...>>> - Create explicit handoff
   */
  protected override async parseContinuityCommands(content: string): Promise<void> {
    if (!this.continuity) return;
    if (!hasContinuityCommand(content)) return;

    const command = parseContinuityCommand(content);
    if (!command) return;

    // Create a hash for deduplication
    // For commands with content (save, handoff, uncertain), use content hash
    // For commands without content (load, search), allow each unique call
    const hasContent = command.content || command.query || command.item;
    const cmdHash = hasContent
      ? `${command.type}:${command.content || command.query || command.item}`
      : `${command.type}:${Date.now()}`; // Allow load/search to run each time
    if (hasContent && this.processedContinuityCommands.has(cmdHash)) return;
    this.processedContinuityCommands.add(cmdHash);

    // Limit dedup set size
    if (this.processedContinuityCommands.size > 100) {
      const oldest = this.processedContinuityCommands.values().next().value;
      if (oldest) this.processedContinuityCommands.delete(oldest);
    }

    try {
      if (this.config.debug) {
        this.logStderr(`[CONTINUITY] Processing ${command.type} command`);
      }

      const response = await this.continuity.handleCommand(this.config.name, command);

      // If there's a response (e.g., from load or search), inject it
      if (response) {
        this.messageQueue.push({
          from: 'system',
          body: response,
          messageId: `continuity-${Date.now()}`,
        });
        this.checkForInjectionOpportunity();
      }
    } catch (err: any) {
      this.logStderr(`[CONTINUITY] Error: ${err.message}`, true);
    }
  }

  /**
   * Parse [[SESSION_END]] blocks from output and close session explicitly.
   * Agents output this to mark their work session as complete:
   *
   * [[SESSION_END]]
   * {"summary": "Completed auth module", "completedTasks": ["login", "logout"]}
   * [[/SESSION_END]]
   *
   * Also stores the data for use in autoSave to populate handoff (fixes empty handoff issue).
   */
  private parseSessionEndAndClose(content: string): void {
    if (this.sessionEndProcessed) return; // Only process once per session

    const sessionEnd = parseSessionEndFromOutput(content);
    if (!sessionEnd) return;

    // Store SESSION_END data for use in autoSave (fixes empty handoff issue)
    this.sessionEndData = sessionEnd;

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
   * Execute spawn via API (if dashboardPort set) or callback
   */
  protected override async executeSpawn(name: string, cli: string, task: string): Promise<void> {
    if (this.config.dashboardPort) {
      // Use dashboard API for spawning (works from any context, no terminal required)
      try {
        const response = await fetch(`http://localhost:${this.config.dashboardPort}/api/spawn`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, cli, task }),
        });
        const result = await response.json() as { success: boolean; error?: string };
        if (result.success) {
          this.logStderr(`Spawned ${name} via API`);
        } else {
          this.logStderr(`Spawn failed: ${result.error}`, true);
        }
      } catch (err: any) {
        this.logStderr(`Spawn API call failed: ${err.message}`, true);
      }
    } else if (this.config.onSpawn) {
      // Fall back to callback
      try {
        await this.config.onSpawn(name, cli, task);
      } catch (err: any) {
        this.logStderr(`Spawn failed: ${err.message}`, true);
      }
    }
  }

  /**
   * Execute release via API (if dashboardPort set) or callback
   */
  protected override async executeRelease(name: string): Promise<void> {
    if (this.config.dashboardPort) {
      // Use dashboard API for release (works from any context, no terminal required)
      try {
        const response = await fetch(`http://localhost:${this.config.dashboardPort}/api/spawned/${encodeURIComponent(name)}`, {
          method: 'DELETE',
        });
        const result = await response.json() as { success: boolean; error?: string };
        if (result.success) {
          this.logStderr(`Released ${name} via API`);
        } else {
          this.logStderr(`Release failed: ${result.error}`, true);
        }
      } catch (err: any) {
        this.logStderr(`Release API call failed: ${err.message}`, true);
      }
    } else if (this.config.onRelease) {
      // Fall back to callback
      try {
        await this.config.onRelease(name);
      } catch (err: any) {
        this.logStderr(`Release failed: ${err.message}`, true);
      }
    }
  }

  /**
   * Parse ->relay:spawn and ->relay:release commands from output.
   * Supports two formats:
   *   Single-line: ->relay:spawn WorkerName cli "task description"
   *   Multi-line (fenced): ->relay:spawn WorkerName cli <<<
   *                        task description here
   *                        can span multiple lines>>>
   *   ->relay:release WorkerName
   */
  protected override parseSpawnReleaseCommands(content: string): void {
    // Only process if we have API or callbacks configured
    const canSpawn = this.config.dashboardPort || this.config.onSpawn;
    const canRelease = this.config.dashboardPort || this.config.onRelease;
    if (!canSpawn && !canRelease) return;

    const lines = content.split('\n');

    // Pattern to strip common line prefixes (bullets, prompts, etc.)
    // Must include ● (U+25CF BLACK CIRCLE) used by Claude's TUI
    const linePrefixPattern = /^(?:[>$%#→➜›»●•◦‣⁃\-*⏺◆◇○□■│┃┆┇┊┋╎╏✦]\s*)+/;

    for (const line of lines) {
      let trimmed = line.trim();

      // Strip common line prefixes (bullets, prompts) before checking for commands
      trimmed = trimmed.replace(linePrefixPattern, '');

      // If we're in fenced spawn mode, accumulate lines until we see >>>
      if (this.pendingFencedSpawn) {
        // Check for fence close (>>> at end of line or on its own line)
        const closeIdx = trimmed.indexOf('>>>');
        if (closeIdx !== -1) {
          // Add content before >>> to task
          const contentBeforeClose = trimmed.substring(0, closeIdx);
          if (contentBeforeClose) {
            this.pendingFencedSpawn.taskLines.push(contentBeforeClose);
          }

          // Execute the spawn with accumulated task
          const { name, cli, taskLines } = this.pendingFencedSpawn;
          const taskStr = taskLines.join('\n').trim();
          const spawnKey = `${name}:${cli}`;

          if (!this.processedSpawnCommands.has(spawnKey)) {
            this.processedSpawnCommands.add(spawnKey);
            if (taskStr) {
              this.logStderr(`Spawn command (fenced): ${name} (${cli}) - "${taskStr.substring(0, 50)}..."`);
            } else {
              this.logStderr(`Spawn command (fenced): ${name} (${cli}) - no task`);
            }
            this.executeSpawn(name, cli, taskStr);
          }

          this.pendingFencedSpawn = null;
        } else {
          // Accumulate line as part of task
          this.pendingFencedSpawn.taskLines.push(line);
        }
        continue;
      }

      // Check for fenced spawn start: ->relay:spawn Name [cli] <<< (CLI optional, defaults to 'claude')
      // Prefixes are stripped above, so we just look for the command at start of line
      const fencedSpawnMatch = trimmed.match(/^->relay:spawn\s+(\S+)(?:\s+(\S+))?\s+<<<(.*)$/);
      if (fencedSpawnMatch && canSpawn) {
        const [, name, cliOrUndefined, inlineContent] = fencedSpawnMatch;
        const cli = cliOrUndefined || 'claude';

        // Validate name
        if (name.length < 2) {
          this.logStderr(`Fenced spawn has invalid name, skipping: name=${name}`);
          continue;
        }

        // Check if fence closes on same line (e.g., ->relay:spawn Worker cli <<<task>>>)
        const inlineCloseIdx = inlineContent.indexOf('>>>');
        if (inlineCloseIdx !== -1) {
          // Single line fenced: extract task between <<< and >>>
          const taskStr = inlineContent.substring(0, inlineCloseIdx).trim();
          const spawnKey = `${name}:${cli}`;

          if (!this.processedSpawnCommands.has(spawnKey)) {
            this.processedSpawnCommands.add(spawnKey);
            if (taskStr) {
              this.logStderr(`Spawn command: ${name} (${cli}) - "${taskStr.substring(0, 50)}..."`);
            } else {
              this.logStderr(`Spawn command: ${name} (${cli}) - no task`);
            }
            this.executeSpawn(name, cli, taskStr);
          }
        } else {
          // Start multi-line fenced mode
          this.pendingFencedSpawn = {
            name,
            cli,
            taskLines: inlineContent.trim() ? [inlineContent.trim()] : [],
          };
          this.logStderr(`Starting fenced spawn capture: ${name} (${cli})`);
        }
        continue;
      }

      // Match single-line spawn: ->relay:spawn WorkerName [cli] ["task"]
      // CLI is optional - defaults to 'claude'. Task is also optional.
      // Prefixes are stripped above, so we just look for the command at start of line
      const spawnMatch = trimmed.match(/^->relay:spawn\s+(\S+)(?:\s+(\S+))?(?:\s+["'](.+?)["'])?\s*$/);
      if (spawnMatch && canSpawn) {
        const [, name, cliOrUndefined, task] = spawnMatch;
        const cli = cliOrUndefined || 'claude';

        // Validate the parsed values
        if (cli === '<<<' || cli === '>>>' || name === '<<<' || name === '>>>') {
          this.logStderr(`Invalid spawn command (fence markers), skipping: name=${name}, cli=${cli}`);
          continue;
        }
        if (name.length < 2) {
          this.logStderr(`Spawn command has suspiciously short name, skipping: name=${name}`);
          continue;
        }

        const taskStr = task || '';
        const spawnKey = `${name}:${cli}`;

        if (!this.processedSpawnCommands.has(spawnKey)) {
          this.processedSpawnCommands.add(spawnKey);
          if (taskStr) {
            this.logStderr(`Spawn command: ${name} (${cli}) - "${taskStr.substring(0, 50)}..."`);
          } else {
            this.logStderr(`Spawn command: ${name} (${cli}) - no task`);
          }
          this.executeSpawn(name, cli, taskStr);
        }
        continue;
      }

      // Match ->relay:release WorkerName
      // Prefixes are stripped above, so we just look for the command at start of line
      const releaseMatch = trimmed.match(/^->relay:release\s+(\S+)\s*$/);
      if (releaseMatch && canRelease) {
        const [, name] = releaseMatch;

        if (!this.processedReleaseCommands.has(name)) {
          this.processedReleaseCommands.add(name);
          this.logStderr(`Release command: ${name}`);
          this.executeRelease(name);
        }
      }
    }
  }

  /**
   * Handle incoming message from relay
   * @param originalTo - The original 'to' field from sender. '*' indicates this was a broadcast message.
   *                     Agents should reply to originalTo to maintain channel routing (e.g., respond to #general, not DM).
   */
  protected override handleIncomingMessage(from: string, payload: SendPayload, messageId: string, meta?: SendMeta, originalTo?: string): void {
    if (this.hasSeenIncoming(messageId)) {
      this.logStderr(`← ${from}: duplicate delivery (${messageId.substring(0, 8)})`);
      return;
    }

    const truncatedBody = payload.body.substring(0, Math.min(DEBUG_LOG_TRUNCATE_LENGTH, payload.body.length));
    const channelInfo = originalTo === '*' ? ' [broadcast]' : '';
    this.logStderr(`← ${from}${channelInfo}: ${truncatedBody}...`);

    // Record in trajectory via trail
    this.trajectory?.message('received', from, this.config.name, payload.body);

    // Queue for injection - include originalTo so we can inform the agent how to route responses
    this.messageQueue.push({ from, body: payload.body, messageId, thread: payload.thread, importance: meta?.importance, data: payload.data, originalTo });

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
   * Inject message via tmux send-keys.
   * Uses shared injection logic with tmux-specific callbacks.
   */
  private async injectNextMessage(): Promise<void> {
    const msg = this.messageQueue.shift();
    if (!msg) return;

    this.isInjecting = true;
    this.logStderr(`Injecting message from ${msg.from} (cli: ${this.cliType})`);

    try {
      const shortId = msg.messageId.substring(0, 8);

      // Wait for input to be clear before injecting
      // If input is not clear (human typing), re-queue and try later - never clear forcefully!
      // Fix for agent-relay-j9z: forceful clearing destroys human input in progress
      const waitTimeoutMs = this.config.inputWaitTimeoutMs ?? 5000;
      const waitPollMs = this.config.inputWaitPollMs ?? 200;
      const inputClear = await this.waitForClearInput(waitTimeoutMs, waitPollMs);
      if (!inputClear) {
        // Input still has text after timeout - DON'T clear forcefully, re-queue instead
        // This preserves any human input in progress
        this.logStderr('Input not clear after waiting, re-queuing injection to preserve human input');
        this.messageQueue.unshift(msg);
        this.isInjecting = false;
        setTimeout(() => this.checkForInjectionOpportunity(), this.config.injectRetryMs ?? 1000);
        return;
      }

      // Ensure pane output is stable to avoid interleaving with active generation
      const stablePane = await this.waitForStablePane(
        this.config.outputStabilityTimeoutMs ?? 2000,
        this.config.outputStabilityPollMs ?? 200
      );
      if (!stablePane) {
        this.logStderr('Output still active, re-queuing injection');
        this.messageQueue.unshift(msg);
        this.isInjecting = false;
        setTimeout(() => this.checkForInjectionOpportunity(), this.config.injectRetryMs ?? 500);
        return;
      }

      // For Gemini: check if we're at a shell prompt ($) vs chat prompt (>)
      // If at shell prompt, skip injection to avoid shell command execution
      if (this.cliType === 'gemini') {
        const lastLine = await this.getLastLine();
        const cleanLine = stripAnsi(lastLine).trim();
        if (CLI_QUIRKS.isShellPrompt(cleanLine)) {
          this.logStderr('Gemini at shell prompt, skipping injection to avoid shell execution');
          // Re-queue the message for later
          this.messageQueue.unshift(msg);
          this.isInjecting = false;
          setTimeout(() => this.checkForInjectionOpportunity(), 2000);
          return;
        }
      }

      // Build injection string using shared utility
      let injection = buildInjectionString(msg);

      // Gemini-specific: wrap body in backticks to prevent shell keyword interpretation
      if (this.cliType === 'gemini') {
        const colonIdx = injection.indexOf(': ');
        if (colonIdx > 0) {
          const prefix = injection.substring(0, colonIdx + 2);
          const body = injection.substring(colonIdx + 2);
          injection = prefix + CLI_QUIRKS.wrapForGemini(body);
        }
      }

      // Create callbacks for shared injection logic
      const callbacks: InjectionCallbacks = {
        getOutput: async () => {
          try {
            const { stdout } = await execAsync(
              `"${this.tmuxPath}" capture-pane -t ${this.sessionName} -p -S - 2>/dev/null`
            );
            return stdout;
          } catch {
            return '';
          }
        },
        performInjection: async (inj: string) => {
          await this.pasteLiteral(inj);
          await sleep(INJECTION_CONSTANTS.ENTER_DELAY_MS);
          await this.sendKeys('Enter');
        },
        log: (message: string) => this.logStderr(message),
        logError: (message: string) => this.logStderr(message, true),
        getMetrics: () => this.injectionMetrics,
      };

      // Inject with retry and verification using shared logic
      const result = await sharedInjectWithRetry(injection, shortId, msg.from, callbacks);

      if (result.success) {
        this.logStderr(`Injection complete (attempt ${result.attempts})`);
      } else {
        // All retries failed - log and optionally fall back to inbox
        this.logStderr(
          `Message delivery failed after ${result.attempts} attempts: from=${msg.from} id=${shortId}`,
          true
        );

        // Write to inbox as fallback if enabled
        if (this.inbox) {
          this.inbox.addMessage(msg.from, msg.body);
          this.logStderr('Wrote message to inbox as fallback');
        }
      }

    } catch (err: any) {
      this.logStderr(`Injection failed: ${err.message}`, true);
    } finally {
      this.isInjecting = false;

      if (this.messageQueue.length > 0) {
        setTimeout(() => this.checkForInjectionOpportunity(), INJECTION_CONSTANTS.QUEUE_PROCESS_DELAY_MS);
      }
    }
  }

  private hasSeenIncoming(messageId: string): boolean {
    if (this.receivedMessageIdSet.has(messageId)) {
      return true;
    }

    this.receivedMessageIdSet.add(messageId);
    this.receivedMessageIdOrder.push(messageId);

    if (this.receivedMessageIdOrder.length > this.MAX_RECEIVED_MESSAGES) {
      const oldest = this.receivedMessageIdOrder.shift();
      if (oldest) {
        this.receivedMessageIdSet.delete(oldest);
      }
    }

    return false;
  }

  /**
   * Send special keys to tmux
   */
  private async sendKeys(keys: string): Promise<void> {
    await execAsync(`"${this.tmuxPath}" send-keys -t ${this.sessionName} ${keys}`);
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
    await execAsync(`"${this.tmuxPath}" send-keys -t ${this.sessionName} -l "${escaped}"`);
  }

  /**
   * Paste text using tmux buffer with optional bracketed paste to avoid interleaving with ongoing output.
   * Some CLIs (like droid) don't handle bracketed paste sequences properly, so we skip -p for them.
   */
  private async pasteLiteral(text: string): Promise<void> {
    // Sanitize newlines to keep injection single-line inside paste buffer
    const sanitized = text.replace(/[\r\n]+/g, ' ');
    const escaped = sanitized
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\$/g, '\\$')
      .replace(/`/g, '\\`')
      .replace(/!/g, '\\!');

    // Set tmux buffer then paste
    // Skip bracketed paste (-p) for CLIs that don't handle it properly (droid, other)
    await execAsync(`"${this.tmuxPath}" set-buffer -- "${escaped}"`);
    const useBracketedPaste = this.cliType === 'claude' || this.cliType === 'codex' || this.cliType === 'gemini' || this.cliType === 'opencode';
    if (useBracketedPaste) {
      await execAsync(`"${this.tmuxPath}" paste-buffer -t ${this.sessionName} -p`);
    } else {
      await execAsync(`"${this.tmuxPath}" paste-buffer -t ${this.sessionName}`);
    }
  }

  /**
   * Reset session-specific state for wrapper reuse.
   * Call this when starting a new session with the same wrapper instance.
   */
  override resetSessionState(): void {
    super.resetSessionState();
    // TmuxWrapper-specific state
    this.lastSummaryHash = '';
  }

  /**
   * Get the prompt pattern for the current CLI type.
   */
  private getPromptPattern(): RegExp {
    return CLI_QUIRKS.getPromptPattern(this.cliType);
  }

  /**
   * Capture the last non-empty line from the tmux pane.
   */
  private async getLastLine(): Promise<string> {
    try {
      const { stdout } = await execAsync(
        `"${this.tmuxPath}" capture-pane -t ${this.sessionName} -p -J 2>/dev/null`
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
    const cleanLine = stripAnsi(line).trimEnd();
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
      const cleanLine = stripAnsi(lineToCheck).trimEnd();
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
        `"${this.tmuxPath}" display-message -t ${this.sessionName} -p "#{cursor_x}" 2>/dev/null`
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

      await sleep(pollIntervalMs);
    }

    this.logStderr(`waitForClearInput: timed out after ${maxWaitMs}ms`);
    return false;
  }

  /**
   * Capture a signature of the current pane content for stability checks.
   * Uses hash+length to cheaply detect changes without storing full content.
   */
  private async capturePaneSignature(): Promise<string | null> {
    try {
      const { stdout } = await execAsync(
        `"${this.tmuxPath}" capture-pane -t ${this.sessionName} -p -J -S - 2>/dev/null`
      );
      const hash = crypto.createHash('sha1').update(stdout).digest('hex');
      return `${stdout.length}:${hash}`;
    } catch {
      return null;
    }
  }

  /**
   * Wait for pane output to stabilize before injecting to avoid interleaving with ongoing output.
   */
  private async waitForStablePane(maxWaitMs = 2000, pollIntervalMs = 200, requiredStablePolls = 2): Promise<boolean> {
    const start = Date.now();
    let lastSig = await this.capturePaneSignature();
    if (!lastSig) return false;

    let stableCount = 0;

    while (Date.now() - start < maxWaitMs) {
      await sleep(pollIntervalMs);
      const sig = await this.capturePaneSignature();
      if (!sig) continue;

      if (sig === lastSig) {
        stableCount++;
        if (stableCount >= requiredStablePolls) {
          return true;
        }
      } else {
        stableCount = 0;
        lastSig = sig;
      }
    }

    this.logStderr(`waitForStablePane: timed out after ${maxWaitMs}ms`);
    return false;
  }

  /**
   * Stop and cleanup
   */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.activityState = 'disconnected';

    // Auto-save continuity state before shutdown (fire and forget)
    // Pass sessionEndData to populate handoff (fixes empty handoff issue)
    if (this.continuity) {
      this.continuity.autoSave(this.config.name, 'session_end', this.sessionEndData).catch((err) => {
        this.logStderr(`[CONTINUITY] Auto-save failed: ${err.message}`, true);
      });
    }

    // Reset session state for potential reuse
    this.resetSessionState();

    // Stop polling
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }

    // Kill tmux session
    try {
      execSync(`"${this.tmuxPath}" kill-session -t ${this.sessionName} 2>/dev/null`);
    } catch {
      // Ignore
    }

    // Disconnect relay
    this.client.destroy();
  }
}
