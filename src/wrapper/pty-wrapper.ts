/**
 * PtyWrapper - Node-PTY based wrapper for spawned workers
 *
 * Unlike TmuxWrapper which provides interactive terminal access,
 * PtyWrapper runs agents headlessly with output capture for logs.
 * Used for spawned workers that don't need direct user interaction.
 *
 * Extends BaseWrapper for shared message handling, spawn/release,
 * and continuity integration.
 */

import * as pty from 'node-pty';
import fs from 'node:fs';
import path from 'node:path';
import { BaseWrapper, type BaseWrapperConfig } from './base-wrapper.js';
import type { ParsedCommand, ParsedSummary, SessionEndMarker } from './parser.js';
import { parseSummaryWithDetails, parseSessionEndFromOutput, isPlaceholderTarget } from './parser.js';
import type { SendPayload, SendMeta } from '../protocol/types.js';
import { getProjectPaths } from '../utils/project-namespace.js';
import { getTrailEnvVars } from '../trajectory/integration.js';
import { findAgentConfig } from '../utils/agent-config.js';
import { HookRegistry, createTrajectoryHooks, type LifecycleHooks } from '../hooks/index.js';
import { parseContinuityCommand, hasContinuityCommand } from '../continuity/index.js';
import {
  type InjectionCallbacks,
  INJECTION_CONSTANTS,
  stripAnsi,
  sleep,
  buildInjectionString,
  injectWithRetry as sharedInjectWithRetry,
  CLI_QUIRKS,
} from './shared.js';
import { detectProviderAuthRevocation, type AuthRevocationResult } from './auth-detection.js';

/** Maximum lines to keep in output buffer */
const MAX_BUFFER_LINES = 10000;

/**
 * PtyWrapper-specific configuration.
 * Extends BaseWrapperConfig with PTY-specific options.
 */
export interface PtyWrapperConfig extends BaseWrapperConfig {
  /** Directory to write log files (optional) */
  logsDir?: string;
  /** Allow this agent to spawn other agents (default: true for Lead, false for spawned workers) */
  allowSpawn?: boolean;
  /** Callback when agent exits */
  onExit?: (code: number) => void;
  /** Custom lifecycle hooks */
  hooks?: LifecycleHooks;
  /** Enable trajectory tracking hooks (default: true if task provided) */
  trajectoryTracking?: boolean;
  /** Interactive mode - disables auto-accept of permission prompts (for auth setup flows) */
  interactive?: boolean;
  /**
   * Summary reminder configuration. Set to false to disable.
   * Default: { intervalMinutes: 15, minOutputs: 50 }
   */
  summaryReminder?: {
    /** Minutes of activity before reminding (default: 15) */
    intervalMinutes?: number;
    /** Minimum significant outputs before reminding (default: 50) */
    minOutputs?: number;
  } | false;
}

export interface InjectionFailedEvent {
  messageId: string;
  from: string;
  attempts: number;
}

export interface SummaryEvent {
  agentName: string;
  summary: ParsedSummary;
}

export interface SessionEndEvent {
  agentName: string;
  marker: SessionEndMarker;
}

export interface AuthRevokedEvent {
  agentName: string;
  provider: string;
  message?: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface PtyWrapperEvents {
  output: (data: string) => void;
  exit: (code: number) => void;
  error: (error: Error) => void;
  'injection-failed': (event: InjectionFailedEvent) => void;
  /** Emitted when agent outputs a [[SUMMARY]] block. Cloud services can persist this. */
  'summary': (event: SummaryEvent) => void;
  /** Emitted when agent outputs a [[SESSION_END]] block. Cloud services can handle session closure. */
  'session-end': (event: SessionEndEvent) => void;
  /** Emitted when auth revocation is detected. Cloud services can handle re-auth flow. */
  'auth_revoked': (event: AuthRevokedEvent) => void;
}

export class PtyWrapper extends BaseWrapper {
  // Override config with PtyWrapper-specific type
  protected override config: PtyWrapperConfig;

  // PTY-specific state
  private ptyProcess?: pty.IPty;
  private outputBuffer: string[] = [];
  private rawBuffer = '';
  private readyForMessages = false;
  private lastOutputTime = 0;
  private logFilePath?: string;
  private logStream?: fs.WriteStream;
  private acceptedPrompts: Set<string> = new Set(); // Track which prompts have been accepted
  private hookRegistry: HookRegistry;
  private sessionStartTime = Date.now();
  private inThinkingBlock = false; // Track if inside <thinking>...</thinking>
  private lastSummaryTime = Date.now(); // Track when last summary was output
  private outputsSinceSummary = 0; // Count outputs since last summary
  private detectedTask?: string; // Auto-detected task from agent config
  private instructionsInjected = false; // Track if init instructions have been injected
  private continuityInjected = false; // Track if continuity context has been injected
  private recentLogChunks: Map<string, number> = new Map(); // Dedup log streaming (hash -> timestamp)
  private static readonly LOG_DEDUP_WINDOW_MS = 500; // Window for considering logs as duplicates
  private static readonly LOG_DEDUP_MAX_SIZE = 100; // Max entries in dedup map
  private lastParsedLength = 0; // Track last parsed position to avoid re-parsing entire buffer
  private lastContinuityParsedLength = 0; // Same for continuity commands

  // Auth revocation detection state
  private authRevoked = false;
  private lastAuthCheck = 0;
  private readonly AUTH_CHECK_INTERVAL = 5000; // Check every 5 seconds max

  constructor(config: PtyWrapperConfig) {
    super(config);
    this.config = config;

    // Auto-detect agent role from .claude/agents/ or .openagents/ if task not provided
    let detectedTask = config.task;
    if (!detectedTask) {
      const agentConfig = findAgentConfig(config.name, config.cwd);
      if (agentConfig?.description) {
        detectedTask = agentConfig.description;
        // Use stderr for consistency with TmuxWrapper's logStderr pattern
        process.stderr.write(`[pty:${config.name}] Auto-detected role: ${detectedTask.substring(0, 60)}...\n`);
      }
    }
    // Store detected task for use in hook registry
    this.detectedTask = detectedTask;

    // Initialize hook registry (PTY-specific)
    const projectPaths = getProjectPaths();
    this.hookRegistry = new HookRegistry({
      agentName: config.name,
      workingDir: config.cwd ?? process.cwd(),
      projectId: projectPaths.projectId,
      task: this.detectedTask,
      env: config.env,
      inject: (text) => this.write(text + '\r'),
      send: async (to, body) => {
        this.client.sendMessage(to, body, 'message');
      },
    });

    // Register trajectory hooks if enabled (default: true if task provided or auto-detected)
    const enableTrajectory = config.trajectoryTracking ?? !!this.detectedTask;
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
  }

  // =========================================================================
  // Abstract method implementations (required by BaseWrapper)
  // =========================================================================

  /**
   * Inject content into the PTY process.
   * Used by BaseWrapper for message injection.
   */
  protected async performInjection(content: string): Promise<void> {
    if (this.ptyProcess && this.running) {
      this.ptyProcess.write(content);
    }
  }

  /**
   * Get cleaned output buffer for command parsing.
   * Strips ANSI codes and returns raw buffer content.
   */
  protected getCleanOutput(): string {
    return stripAnsi(this.rawBuffer);
  }

  // =========================================================================
  // Lifecycle methods
  // =========================================================================

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

    // Skip hooks and continuity in interactive mode - user handles all prompts directly
    if (!this.config.interactive) {
      // Dispatch session start hook (handles trajectory initialization)
      this.hookRegistry.dispatchSessionStart().catch(err => {
        console.error(`[pty:${this.config.name}] Session start hook error:`, err);
      });

      // Initialize continuity and get agentId, then inject context
      this.initializeAgentId()
        .then(() => this.injectContinuityContext())
        .catch(err => {
          console.error(`[pty:${this.config.name}] Agent ID/continuity initialization error:`, err);
        });
    }

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
    // Skip in interactive mode - user handles all prompts directly
    setTimeout(() => {
      if (!this.config.interactive) {
        this.injectInstructions();
      }
      this.readyForMessages = true;
      // Process any messages that arrived while waiting (skip in interactive mode)
      if (!this.config.interactive) {
        this.processMessageQueue();
      }
    }, 2000);
  }

  // Note: initializeAgentId() and getAgentId() are inherited from BaseWrapper

  /**
   * Inject continuity context from previous session.
   * Called after agent ID initialization to restore state from ledger.
   */
  private async injectContinuityContext(): Promise<void> {
    if (!this.continuity || !this.running) return;

    // Guard: Only inject once per session
    if (this.continuityInjected) {
      console.log(`[pty:${this.config.name}] Continuity context already injected, skipping`);
      return;
    }
    this.continuityInjected = true;

    try {
      const context = await this.continuity.getStartupContext(this.config.name);
      // Skip if no meaningful context (empty ledger or just boilerplate)
      if (!context?.formatted || context.formatted.length < 50) {
        console.log(`[pty:${this.config.name}] Skipping continuity injection (no meaningful context)`);
        return;
      }
      if (context?.formatted) {
        // Build context notification similar to TmuxWrapper
        const taskInfo = context.ledger?.currentTask
          ? `Task: ${context.ledger.currentTask.slice(0, 50)}`
          : '';
        const handoffInfo = context.handoff
          ? `Last handoff: ${context.handoff.createdAt.toISOString().split('T')[0]}`
          : '';
        const statusParts = [taskInfo, handoffInfo].filter(Boolean).join(' | ');

        const notification = `[Continuity] Previous session context loaded.${statusParts ? ` ${statusParts}` : ''}\n\n${context.formatted}`;

        // Queue continuity context directly to messageQueue with 'system' as sender
        // This avoids creating confusing "Agent -> Agent" self-messages in the dashboard
        // Fix for Lead communication issue: continuity checkpoints were creating self-messages
        this.messageQueue.push({
          from: 'system',
          body: notification,
          messageId: `continuity-startup-${Date.now()}`,
          thread: 'continuity-context',
        });
        this.processMessageQueue();

        const mode = context.handoff ? 'resume' : 'continue';
        console.log(`[pty:${this.config.name}] Continuity context injected (${mode})`);
      }
    } catch (err: any) {
      console.error(`[pty:${this.config.name}] Failed to inject continuity context: ${err.message}`);
    }
  }

  /**
   * Parse ->continuity: commands from output and handle them.
   *
   * Supported commands:
   *   ->continuity:save <<<...>>>  - Save session state to ledger
   *   ->continuity:load            - Request context injection
   *   ->continuity:search "query"  - Search past handoffs
   *   ->continuity:uncertain "..."  - Mark item as uncertain
   *   ->continuity:handoff <<<...>>> - Create explicit handoff
   */
  /**
   * Parse continuity commands from output.
   * Overrides BaseWrapper to use client.sendMessage instead of queuing.
   */
  protected override async parseContinuityCommands(content: string): Promise<void> {
    if (!this.continuity) return;
    if (!hasContinuityCommand(content)) return;

    const command = parseContinuityCommand(content);
    if (!command) return;

    // Deduplication: use type + content hash for all commands
    // Fixed: content-less commands (like load) now use static hash to prevent infinite loops
    const cmdHash = `${command.type}:${command.content || command.query || command.item || 'no-content'}`;

    if (this.processedContinuityCommands.has(cmdHash)) return;
    this.processedContinuityCommands.add(cmdHash);

    // Limit dedup set size
    if (this.processedContinuityCommands.size > 100) {
      const oldest = this.processedContinuityCommands.values().next().value;
      if (oldest) this.processedContinuityCommands.delete(oldest);
    }

    try {
      const response = await this.continuity.handleCommand(this.config.name, command);
      if (response) {
        // Inject response via relay message to self
        this.client.sendMessage(this.config.name, response, 'message', undefined, 'continuity-response');
        console.log(`[pty:${this.config.name}] Continuity command handled: ${command.type}`);
      }
    } catch (err: any) {
      console.error(`[pty:${this.config.name}] Continuity command error: ${err.message}`);
    }
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
    // Filter out Claude's extended thinking blocks before streaming
    // Also deduplicate to prevent terminal redraws from causing duplicate log entries
    if (this.config.streamLogs !== false && this.client.state === 'READY') {
      const filteredData = this.filterThinkingBlocks(data);
      if (filteredData && !this.isDuplicateLogChunk(filteredData)) {
        this.client.sendLog(filteredData);
      }
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

    // Dispatch output hook (handles phase detection, etc.)
    // Skip in interactive mode - no hooks should inject content
    const cleanData = stripAnsi(data);
    if (!this.config.interactive) {
      this.hookRegistry.dispatchOutput(cleanData, data).catch(err => {
        console.error(`[pty:${this.config.name}] Output hook error:`, err);
      });
    }

    // Check for [[SUMMARY]] and [[SESSION_END]] blocks and emit events
    // This allows cloud services to handle persistence without hardcoding storage
    const cleanContent = stripAnsi(this.rawBuffer);
    this.checkForSummaryAndEmit(cleanContent);
    this.checkForSessionEndAndEmit(cleanContent);

    // Check for auth revocation patterns
    this.checkAuthRevocation(cleanContent);

    // Parse for continuity commands (->continuity:save, ->continuity:load, etc.)
    // Use rawBuffer (accumulated content) not immediate chunk, since multi-line
    // fenced commands like ->continuity:save <<<...>>> span multiple output events
    // Optimization: Only parse new content with lookback for incomplete fenced commands
    // Skip in interactive mode - no continuity features needed
    if (!this.config.interactive && cleanContent.length > this.lastContinuityParsedLength) {
      const lookbackStart = Math.max(0, this.lastContinuityParsedLength - 500);
      const contentToParse = cleanContent.substring(lookbackStart);
      // Join continuation lines for multi-line fenced commands
      const joinedContent = this.joinContinuationLines(contentToParse);
      this.parseContinuityCommands(joinedContent).catch(err => {
        console.error(`[pty:${this.config.name}] Continuity command parsing error:`, err);
      });
      this.lastContinuityParsedLength = cleanContent.length;
    }

    // Track outputs and potentially remind about summaries
    this.trackOutputAndRemind(data);
  }

  /**
   * Filter Claude's extended thinking blocks from output.
   * Thinking blocks are wrapped in <thinking>...</thinking> tags and should
   * not be streamed to the dashboard or stored in output buffers.
   *
   * This method tracks state across calls to handle multi-line thinking blocks.
   */
  private filterThinkingBlocks(data: string): string {
    const THINKING_START = /<thinking>/;
    const THINKING_END = /<\/thinking>/;

    const lines = data.split('\n');
    const outputLines: string[] = [];

    for (const line of lines) {
      // If in thinking block, check for end
      if (this.inThinkingBlock) {
        if (THINKING_END.test(line)) {
          this.inThinkingBlock = false;
          // If there's content after </thinking> on the same line, keep it
          const afterEnd = line.split('</thinking>')[1];
          if (afterEnd && afterEnd.trim()) {
            outputLines.push(afterEnd);
          }
        }
        // Skip this line - inside thinking block
        continue;
      }

      // Check for thinking start
      if (THINKING_START.test(line)) {
        this.inThinkingBlock = true;
        // Check if it ends on the same line
        if (THINKING_END.test(line)) {
          this.inThinkingBlock = false;
        }
        // Keep content before <thinking> if any
        const beforeStart = line.split('<thinking>')[0];
        if (beforeStart && beforeStart.trim()) {
          outputLines.push(beforeStart);
        }
        continue;
      }

      // Normal line - keep it
      outputLines.push(line);
    }

    return outputLines.join('\n');
  }

  /**
   * Check if a log chunk is a duplicate (recently streamed).
   * Prevents terminal redraws from causing duplicate log entries in the dashboard.
   *
   * Uses content normalization and time-based deduplication:
   * - Strips whitespace and normalizes content for comparison
   * - Considers chunks with same normalized content within LOG_DEDUP_WINDOW_MS as duplicates
   * - Cleans up old entries to prevent memory growth
   */
  private isDuplicateLogChunk(data: string): boolean {
    // Normalize: strip excessive whitespace, limit to first 200 chars for hash
    // This helps catch redraws that might have slight formatting differences
    const normalized = stripAnsi(data).replace(/\s+/g, ' ').trim().substring(0, 200);

    // Very short chunks (likely control chars or partial output) - allow through
    if (normalized.length < 10) {
      return false;
    }

    // Simple hash using string as key
    const hash = normalized;
    const now = Date.now();

    // Check if this chunk was recently streamed
    const lastSeen = this.recentLogChunks.get(hash);
    if (lastSeen && (now - lastSeen) < PtyWrapper.LOG_DEDUP_WINDOW_MS) {
      return true; // Duplicate
    }

    // Record this chunk
    this.recentLogChunks.set(hash, now);

    // Cleanup: remove old entries if map is getting large
    if (this.recentLogChunks.size > PtyWrapper.LOG_DEDUP_MAX_SIZE) {
      const cutoff = now - PtyWrapper.LOG_DEDUP_WINDOW_MS * 2;
      for (const [key, timestamp] of this.recentLogChunks) {
        if (timestamp < cutoff) {
          this.recentLogChunks.delete(key);
        }
      }
    }

    return false; // Not a duplicate
  }

  /**
   * Auto-accept Claude's first-run prompts
   * Handles multiple prompts in sequence:
   * 1. --dangerously-skip-permissions acceptance ("Yes, I accept")
   * 2. Trust directory prompt ("Yes, I trust this folder")
   * 3. "Ready to code here?" permission prompt ("Yes, continue")
   *
   * Uses a Set to track which prompts have been accepted, allowing
   * multiple different prompts to be handled in sequence.
   */
  private handleAutoAcceptPrompts(data: string): void {
    if (!this.ptyProcess || !this.running) return;

    // Skip auto-accept in interactive mode - user responds to prompts directly
    if (this.config.interactive) return;

    const cleanData = stripAnsi(data);

    // Check for the permission acceptance prompt (--dangerously-skip-permissions)
    // Pattern: "2. Yes, I accept" in the output
    if (!this.acceptedPrompts.has('permission') &&
        cleanData.includes('Yes, I accept') && cleanData.includes('No, exit')) {
      console.log(`[pty:${this.config.name}] Detected permission prompt, auto-accepting...`);
      this.acceptedPrompts.add('permission');
      // Send "2" to select "Yes, I accept" and Enter to confirm
      setTimeout(() => {
        if (this.ptyProcess && this.running) {
          this.ptyProcess.write('2');
        }
      }, 100);
      return;
    }

    // Check for the trust directory prompt
    // Pattern: "1. Yes, I trust this folder" with "No, exit"
    if (!this.acceptedPrompts.has('trust') &&
        (cleanData.includes('trust this folder') || cleanData.includes('safety check'))
        && cleanData.includes('No, exit')) {
      console.log(`[pty:${this.config.name}] Detected trust directory prompt, auto-accepting...`);
      this.acceptedPrompts.add('trust');
      // Send Enter to accept first option (already selected)
      setTimeout(() => {
        if (this.ptyProcess && this.running) {
          this.ptyProcess.write('\r');
        }
      }, 300);
      return;
    }

    // Check for "Ready to code here?" permission prompt
    // Pattern: "Yes, continue" with "No, exit" and "Ready to code here?"
    // This prompt asks for permission to work with files in the workspace
    if (!this.acceptedPrompts.has('ready-to-code') &&
        cleanData.includes('Yes, continue') && cleanData.includes('No, exit')
        && (cleanData.includes('Ready to code here') || cleanData.includes('permission to work with your files'))) {
      console.log(`[pty:${this.config.name}] Detected "Ready to code here?" prompt, auto-accepting...`);
      this.acceptedPrompts.add('ready-to-code');
      // Send Enter to accept first option (already selected with ❯)
      setTimeout(() => {
        if (this.ptyProcess && this.running) {
          this.ptyProcess.write('\r');
        }
      }, 300);
      return;
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
   *
   * Optimization: Only parses new content since last parse to avoid O(n²) behavior.
   * Uses lookback buffer for incomplete fenced messages that span output chunks.
   */
  private parseRelayCommands(): void {
    const cleanContent = stripAnsi(this.rawBuffer);

    // Skip if no new content
    if (cleanContent.length <= this.lastParsedLength) return;

    // For fenced messages, need some lookback for incomplete fences that span chunks
    // 500 chars is enough to capture most relay message headers
    const lookbackStart = Math.max(0, this.lastParsedLength - 500);
    const contentToParse = cleanContent.substring(lookbackStart);

    // First, try to find fenced multi-line messages: ->relay:Target <<<\n...\n>>>
    this.parseFencedMessages(contentToParse);

    // Then parse single-line messages
    this.parseSingleLineMessages(contentToParse);

    // Parse spawn/release commands
    this.parseSpawnReleaseCommands(contentToParse);

    // Update parsed position
    this.lastParsedLength = cleanContent.length;
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

      // Skip spawn/release commands - they are handled by parseSpawnReleaseCommands
      if (/^spawn$/i.test(target) || /^release$/i.test(target)) {
        continue;
      }

      // Skip placeholder targets (documentation examples like "AgentName", "Lead", etc.)
      if (isPlaceholderTarget(target)) {
        continue;
      }

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

      // Skip placeholder targets after parsing cross-project syntax
      if (isPlaceholderTarget(to)) {
        continue;
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

      // Skip spawn/release commands - they are handled by parseSpawnReleaseCommands
      const afterPrefixForCheck = line.substring(prefixIdx + this.relayPrefix.length);
      if (/^spawn\s+/i.test(afterPrefixForCheck) || /^release\s+/i.test(afterPrefixForCheck)) {
        continue;
      }

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

        // Skip placeholder targets (documentation examples)
        if (isPlaceholderTarget(target)) continue;

        // Parse target for cross-project syntax
        const colonIdx = target.indexOf(':');
        let to = target;
        let project: string | undefined;
        if (colonIdx > 0 && colonIdx < target.length - 1) {
          project = target.substring(0, colonIdx);
          to = target.substring(colonIdx + 1);
        }

        // Skip placeholder targets after parsing cross-project syntax
        if (isPlaceholderTarget(to)) continue;

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

      // Skip placeholder targets (documentation examples)
      if (isPlaceholderTarget(target)) continue;

      // Parse target for cross-project syntax
      const colonIdx = target.indexOf(':');
      let to = target;
      let project: string | undefined;
      if (colonIdx > 0 && colonIdx < target.length - 1) {
        project = target.substring(0, colonIdx);
        to = target.substring(colonIdx + 1);
      }

      // Skip placeholder targets after parsing cross-project syntax
      if (isPlaceholderTarget(to)) continue;

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
   * Send relay command to daemon.
   * Extends BaseWrapper to add PTY-specific logging and hook dispatch.
   */
  protected override sendRelayCommand(cmd: ParsedCommand): void {
    // Check if this message would be sent (before BaseWrapper deduplicates)
    const msgHash = `${cmd.to}:${cmd.body.substring(0, 100)}`;
    const wouldSend = !this.sentMessageHashes.has(msgHash) && this.client.state === 'READY';

    // Call base class to handle deduplication and actual send
    super.sendRelayCommand(cmd);

    // PTY-specific: Dispatch message sent hook if the message was sent
    if (wouldSend && this.sentMessageHashes.has(msgHash)) {
      this.hookRegistry.dispatchMessageSent(cmd.to, cmd.body, cmd.thread).catch(err => {
        console.error(`[pty:${this.config.name}] Message sent hook error:`, err);
      });
    }
  }

  /** Valid CLI types for spawn commands */
  private static readonly VALID_CLI_TYPES = new Set([
    'claude', 'codex', 'gemini', 'droid', 'aider', 'cursor', 'cline', 'opencode',
  ]);

  /** Validate agent name format (PascalCase, alphanumeric, 2-30 chars) */
  private isValidAgentName(name: string): boolean {
    // Must start with uppercase letter, contain only alphanumeric chars
    // Length 2-30 characters
    return /^[A-Z][a-zA-Z0-9]{1,29}$/.test(name);
  }

  /** Validate CLI type */
  private isValidCliType(cli: string): boolean {
    return PtyWrapper.VALID_CLI_TYPES.has(cli.toLowerCase());
  }

  /**
   * Parse spawn/release commands from output
   * Uses string-based parsing for robustness with PTY output.
   * Supports two formats:
   *   Single-line: ->relay:spawn WorkerName cli "task description"
   *   Multi-line (fenced): ->relay:spawn WorkerName cli <<<
   *                        task description here
   *                        can span multiple lines>>>
   * Delegates to dashboard API if dashboardPort is set (for nested spawns).
   *
   * STRICT VALIDATION:
   * - Command must be at start of line (after whitespace)
   * - Agent name must be PascalCase (e.g., Backend, Frontend, Worker1)
   * - CLI must be a known type (claude, codex, gemini, etc.)
   *
   * Overrides BaseWrapper to add PTY-specific validation and logging.
   */
  protected override parseSpawnReleaseCommands(content: string): void {
    // Need either API port or callbacks to handle spawn/release
    // Also check allowSpawn config - spawned workers should not spawn other agents
    const spawnAllowed = this.config.allowSpawn !== false;
    const canSpawn = spawnAllowed && (this.config.dashboardPort || this.config.onSpawn);
    const canRelease = this.config.dashboardPort || this.config.onRelease;

    // Debug: always log spawn detection for debugging
    if (content.includes('->relay:spawn')) {
      console.log(`[pty:${this.config.name}] [SPAWN-DEBUG] Spawn pattern detected in content`);
      console.log(`[pty:${this.config.name}] [SPAWN-DEBUG] canSpawn=${canSpawn} (allowSpawn=${spawnAllowed}, dashboardPort=${this.config.dashboardPort}, hasOnSpawn=${!!this.config.onSpawn})`);
      // Log the actual lines containing spawn
      const spawnLines = content.split('\n').filter(l => l.includes('->relay:spawn'));
      spawnLines.forEach((line, i) => {
        console.log(`[pty:${this.config.name}] [SPAWN-DEBUG] Line ${i}: "${line.substring(0, 100)}"`);
      });
    }

    // Debug: always log release detection for debugging
    if (content.includes('->relay:release')) {
      console.log(`[pty:${this.config.name}] [RELEASE-DEBUG] Release pattern detected in content`);
      console.log(`[pty:${this.config.name}] [RELEASE-DEBUG] canRelease=${canRelease} (dashboardPort=${this.config.dashboardPort}, hasOnRelease=${!!this.config.onRelease})`);
    }

    if (!canSpawn && !canRelease) return;

    const lines = content.split('\n');
    const spawnPrefix = '->relay:spawn';
    const releasePrefix = '->relay:release';

    for (const line of lines) {
      let trimmed = line.trim();

      // Strip bullet/prompt prefixes but PRESERVE the ->relay: pattern
      // Look for ->relay: in the line and only strip what comes before it
      const relayIdx = trimmed.indexOf('->relay:');
      if (relayIdx > 0) {
        // There's content before ->relay: - check if it's just prefix chars
        const beforeRelay = trimmed.substring(0, relayIdx);
        // Only strip if the prefix is just bullets/prompts/whitespace
        if (/^[\s●•◦‣⁃⏺◆◇○□■│┃┆┇┊┋╎╏✦→➜›»$%#*]+$/.test(beforeRelay)) {
          const originalTrimmed = trimmed;
          trimmed = trimmed.substring(relayIdx);
          console.log(`[pty:${this.config.name}] [SPAWN-DEBUG] Stripped prefix: "${originalTrimmed.substring(0, 60)}" -> "${trimmed.substring(0, 60)}"`);
        }
      }

      // Skip escaped commands: \->relay:spawn should not trigger
      if (trimmed.includes('\\->relay:')) {
        continue;
      }

      // If we're in fenced spawn mode, accumulate lines until we see >>>
      if (this.pendingFencedSpawn) {
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
            console.log(`[pty:${this.config.name}] Spawn command (fenced): ${name} (${cli}) - "${taskStr.substring(0, 50)}..."`);
            this.executeSpawn(name, cli, taskStr);
          }

          this.pendingFencedSpawn = null;
        } else {
          // Accumulate line as part of task
          this.pendingFencedSpawn.taskLines.push(line);
        }
        continue;
      }

      // Check for fenced spawn start: ->relay:spawn Name [cli] <<<
      // STRICT: Must be at start of line (after whitespace)
      if (canSpawn && trimmed.startsWith(spawnPrefix)) {
        const afterSpawn = trimmed.substring(spawnPrefix.length).trim();
        console.log(`[pty:${this.config.name}] [SPAWN-DEBUG] Detected spawn prefix, afterSpawn: "${afterSpawn.substring(0, 60)}"`);

        // Check for fenced format: Name [cli] <<< (CLI optional, defaults to 'claude')
        const fencedMatch = afterSpawn.match(/^(\S+)(?:\s+(\S+))?\s+<<<(.*)$/);
        console.log(`[pty:${this.config.name}] [SPAWN-DEBUG] Fenced match result: ${fencedMatch ? 'MATCHED' : 'NO MATCH'}`);
        if (fencedMatch) {
          const [, name, cliOrUndefined, inlineContent] = fencedMatch;
          let cli = cliOrUndefined || 'claude';

          // STRICT: Validate agent name (PascalCase) and CLI type
          if (!this.isValidAgentName(name)) {
            console.warn(`[pty:${this.config.name}] Invalid agent name format, skipping: name=${name} (must be PascalCase)`);
            continue;
          }
          if (!this.isValidCliType(cli)) {
            console.warn(`[pty:${this.config.name}] Unknown CLI type, using default: cli=${cli}`);
            cli = 'claude';
          }

          // Check if fence closes on same line
          const inlineCloseIdx = inlineContent.indexOf('>>>');
          if (inlineCloseIdx !== -1) {
            // Single line fenced: extract task between <<< and >>>
            const taskStr = inlineContent.substring(0, inlineCloseIdx).trim();
            const spawnKey = `${name}:${cli}`;

            if (!this.processedSpawnCommands.has(spawnKey)) {
              this.processedSpawnCommands.add(spawnKey);
              console.log(`[pty:${this.config.name}] Spawn command (fenced): ${name} (${cli}) - "${taskStr.substring(0, 50)}..."`);
              this.executeSpawn(name, cli, taskStr);
            }
          } else {
            // Start multi-line fenced mode - but only if not already processed
            const spawnKey = `${name}:${cli}`;
            if (this.processedSpawnCommands.has(spawnKey)) {
              // Already processed this spawn, skip the fenced capture
              continue;
            }
            this.pendingFencedSpawn = {
              name,
              cli,
              taskLines: inlineContent.trim() ? [inlineContent.trim()] : [],
            };
            console.log(`[pty:${this.config.name}] Starting fenced spawn capture: ${name} (${cli})`);
          }
          continue;
        }

        // Parse single-line format: WorkerName [cli] [task]
        // CLI defaults to 'claude' if not provided
        const parts = afterSpawn.split(/\s+/);
        if (parts.length >= 1) {
          const name = parts[0];
          // CLI is optional - defaults to 'claude'
          let cli = parts[1] || 'claude';
          // Task is everything after cli (if cli was provided) or after name (if cli was omitted)
          let task = '';
          const taskStartIndex = parts[1] ? 2 : 1;
          if (parts.length > taskStartIndex) {
            const taskPart = parts.slice(taskStartIndex).join(' ');
            // Remove surrounding quotes if present
            const quoteMatch = taskPart.match(/^["'](.*)["']$/);
            task = quoteMatch ? quoteMatch[1] : taskPart;
          }

          if (name) {
            // STRICT: Validate agent name (PascalCase) and CLI type
            if (!this.isValidAgentName(name)) {
              // Don't log warning for documentation text - just silently skip
              continue;
            }
            if (!this.isValidCliType(cli)) {
              // Default CLI 'claude' should always be valid, but validate anyway
              console.warn(`[pty:${this.config.name}] Unknown CLI type, using default: cli=${cli}, defaulting to 'claude'`);
              cli = 'claude';
            }

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
      // STRICT: Must be at start of line (after whitespace)
      if (trimmed.startsWith(releasePrefix)) {
        console.log(`[pty:${this.config.name}] [RELEASE-DEBUG] Release prefix detected, canRelease=${canRelease}`);
        if (canRelease) {
          const afterRelease = trimmed.substring(releasePrefix.length).trim();
          const name = afterRelease.split(/\s+/)[0];
          console.log(`[pty:${this.config.name}] [RELEASE-DEBUG] Parsed name: ${name}, isValidName=${name ? this.isValidAgentName(name) : false}, alreadyProcessed=${this.processedReleaseCommands.has(name)}`);

          // STRICT: Validate agent name format
          if (name && this.isValidAgentName(name) && !this.processedReleaseCommands.has(name)) {
            this.processedReleaseCommands.add(name);
            this.executeRelease(name);
          }
        }
      }
    }
  }

  /**
   * Execute spawn via API or callback.
   * Overrides BaseWrapper to add PTY-specific logging and API path.
   */
  protected override async executeSpawn(name: string, cli: string, task: string): Promise<void> {
    console.log(`[pty:${this.config.name}] [SPAWN-DEBUG] executeSpawn called: name=${name}, cli=${cli}, task="${task.substring(0, 50)}..."`);
    console.log(`[pty:${this.config.name}] [SPAWN-DEBUG] dashboardPort=${this.config.dashboardPort}, hasOnSpawn=${!!this.config.onSpawn}`);

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
   * Execute release via API or callback.
   * Overrides BaseWrapper to add PTY-specific logging and API path.
   */
  protected override async executeRelease(name: string): Promise<void> {
    if (this.config.dashboardPort) {
      // Use dashboard API for releasing
      try {
        const response = await fetch(`http://localhost:${this.config.dashboardPort}/api/spawned/${encodeURIComponent(name)}`, {
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
   * Handle incoming message from relay.
   * Extends BaseWrapper to add PTY-specific behavior.
   */
  protected override handleIncomingMessage(from: string, payload: SendPayload, messageId: string, meta?: SendMeta, originalTo?: string): void {
    // Call base class to handle deduplication and queuing
    super.handleIncomingMessage(from, payload, messageId, meta, originalTo);

    // PTY-specific: Process the message queue immediately
    this.processMessageQueue();

    // PTY-specific: Dispatch message received hook
    this.hookRegistry.dispatchMessageReceived(from, payload.body, messageId).catch(err => {
      console.error(`[pty:${this.config.name}] Message received hook error:`, err);
    });
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
   * Check if the agent process is still alive and responsive.
   */
  private isAgentAlive(): boolean {
    return this.running && this.ptyProcess !== undefined;
  }

  /**
   * Process queued messages with reliability improvements:
   * 1. Wait for output stability before injection
   * 2. Verify injection appeared in output
   * 3. Retry with backoff on failure
   * 4. Fall back to logging on complete failure
   *
   * Uses shared injection logic with PTY-specific callbacks.
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

      // Create callbacks for shared injection logic
      const callbacks: InjectionCallbacks = {
        getOutput: async () => {
          // Look at last 2000 chars to avoid scanning entire buffer
          return this.rawBuffer.slice(-2000);
        },
        performInjection: async (inj: string) => {
          if (!this.ptyProcess || !this.running) {
            throw new Error('PTY process not running');
          }
          // Write message to PTY, then send Enter separately after a small delay
          this.ptyProcess.write(inj);
          await sleep(INJECTION_CONSTANTS.ENTER_DELAY_MS);
          this.ptyProcess.write('\r');
        },
        log: (message: string) => console.log(`[pty:${this.config.name}] ${message}`),
        logError: (message: string) => console.error(`[pty:${this.config.name}] ${message}`),
        getMetrics: () => this.injectionMetrics,
        // Skip verification for PTY-based injection - CLIs don't echo input back
        // so verification will always fail. Trust that pty.write() succeeds.
        skipVerification: true,
      };

      // Inject with retry and verification using shared logic
      const result = await sharedInjectWithRetry(injection, shortId, msg.from, callbacks);

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
   * Queue minimal agent identity notification as the first message.
   *
   * Full protocol instructions are in ~/.claude/CLAUDE.md (set up by entrypoint.sh).
   * We only inject a brief identity message here to let the agent know its name
   * and that it's connected to the relay.
   */
  private injectInstructions(): void {
    if (!this.running) return;

    // Guard: Only inject once per session
    if (this.instructionsInjected) {
      console.log(`[pty:${this.config.name}] Init instructions already injected, skipping`);
      return;
    }
    this.instructionsInjected = true;

    // Minimal notification - full protocol is in ~/.claude/CLAUDE.md
    const notification = `You are agent "${this.config.name}" connected to Agent Relay. See CLAUDE.md for the messaging protocol. ACK messages, do work, send DONE when complete.`;

    // Queue as first message from "system" - will be injected when CLI is ready
    this.messageQueue.unshift({
      from: 'system',
      body: notification,
      messageId: `init-${Date.now()}`,
    });
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
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    // Auto-save continuity state before stopping
    // Pass sessionEndData to populate handoff (fixes empty handoff issue)
    if (this.continuity) {
      try {
        await this.continuity.autoSave(this.config.name, 'session_end', this.sessionEndData);
      } catch (err) {
        console.error(`[pty:${this.config.name}] Continuity auto-save failed:`, err);
      }
    }

    // Dispatch session end hook (handles trajectory completion)
    try {
      await this.hookRegistry.dispatchSessionEnd(0, true);
    } catch (err) {
      console.error(`[pty:${this.config.name}] Session end hook error:`, err);
    }

    if (this.ptyProcess) {
      // Try graceful termination first
      this.ptyProcess.write('\x03'); // Ctrl+C
      await sleep(1000);
      if (this.ptyProcess) {
        this.ptyProcess.kill();
      }
    }

    this.closeLogStream();
    this.client.destroy();
    this.hookRegistry.destroy();
  }

  /**
   * Kill the process immediately
   */
  async kill(): Promise<void> {
    this.running = false;

    // Auto-save continuity state before killing (with timeout to avoid hanging)
    // Pass sessionEndData if available (may have been parsed before kill)
    if (this.continuity) {
      try {
        await Promise.race([
          this.continuity.autoSave(this.config.name, 'crash', this.sessionEndData),
          sleep(2000), // 2s timeout for crash saves
        ]);
      } catch (err) {
        console.error(`[pty:${this.config.name}] Continuity auto-save failed:`, err);
      }
    }

    // Dispatch session end hook (forced termination, with timeout)
    try {
      await Promise.race([
        this.hookRegistry.dispatchSessionEnd(undefined, false),
        sleep(1000), // 1s timeout for hooks on kill
      ]);
    } catch (err) {
      console.error(`[pty:${this.config.name}] Session end hook error:`, err);
    }

    if (this.ptyProcess) {
      this.ptyProcess.kill();
    }
    this.closeLogStream();
    this.client.destroy();
    this.hookRegistry.destroy();
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

  get pid(): number | undefined {
    return this.ptyProcess?.pid;
  }

  get logPath(): string | undefined {
    return this.logFilePath;
  }

  /**
   * Track significant outputs and inject summary reminder if needed.
   * Works with any CLI (Claude, Gemini, Codex, etc.)
   */
  private trackOutputAndRemind(data: string): void {
    // Skip in interactive mode - user handles all prompts directly
    if (this.config.interactive) return;
    // Disabled if config.summaryReminder === false or env RELAY_SUMMARY_REMINDER_ENABLED=false
    if (this.config.summaryReminder === false) return;
    if (process.env.RELAY_SUMMARY_REMINDER_ENABLED === 'false') return;

    const config = this.config.summaryReminder ?? {};
    // Env vars take precedence over config, config takes precedence over defaults
    const intervalMinutes = process.env.RELAY_SUMMARY_INTERVAL_MINUTES
      ? parseInt(process.env.RELAY_SUMMARY_INTERVAL_MINUTES, 10)
      : (config.intervalMinutes ?? 15);
    const minOutputs = process.env.RELAY_SUMMARY_MIN_OUTPUTS
      ? parseInt(process.env.RELAY_SUMMARY_MIN_OUTPUTS, 10)
      : (config.minOutputs ?? 50);

    // Only count "significant" outputs (more than just whitespace/control chars)
    const cleanData = stripAnsi(data).trim();
    if (cleanData.length > 20) {
      this.outputsSinceSummary++;
    }

    // Check if we should remind
    const minutesSinceSummary = (Date.now() - this.lastSummaryTime) / (1000 * 60);
    const shouldRemind =
      minutesSinceSummary >= intervalMinutes &&
      this.outputsSinceSummary >= minOutputs;

    if (shouldRemind && this.running && this.ptyProcess) {
      // Reset counters before injecting (prevent spam)
      this.lastSummaryTime = Date.now();
      this.outputsSinceSummary = 0;

      // Inject reminder as a relay-style message
      // IMPORTANT: Must be single-line - embedded newlines cause the message to span
      // multiple lines in the CLI input buffer, and the final Enter only submits
      // the last (empty) line. Regular relay messages are also single-line (see buildInjectionString).
      const reminder = `[Agent Relay] It's been ${Math.round(minutesSinceSummary)} minutes. Please output a [[SUMMARY]] block to checkpoint your progress: [[SUMMARY]]{"currentTask": "...", "completedTasks": [...], "context": "..."}[[/SUMMARY]]`;

      // Delay slightly to not interrupt current output, then write + Enter
      setTimeout(async () => {
        if (this.ptyProcess && this.running) {
          this.ptyProcess.write(reminder);
          await sleep(INJECTION_CONSTANTS.ENTER_DELAY_MS);
          this.ptyProcess.write('\r');
        }
      }, 1000);
    }
  }

  /**
   * Check for [[SUMMARY]] blocks and emit 'summary' event.
   * Allows cloud services to persist summaries without hardcoding storage.
   * Also updates the local continuity ledger for session recovery.
   */
  private checkForSummaryAndEmit(content: string): void {
    const result = parseSummaryWithDetails(content);

    // No SUMMARY block found
    if (!result.found) return;

    // Dedup based on raw content - prevents repeated event emissions for same summary
    if (result.rawContent === this.lastSummaryRawContent) return;
    this.lastSummaryRawContent = result.rawContent || '';

    // Reset reminder counters on any summary (even invalid JSON)
    this.lastSummaryTime = Date.now();
    this.outputsSinceSummary = 0;

    // Invalid JSON - log warning
    if (!result.valid) {
      console.warn(`[pty:${this.config.name}] Invalid JSON in SUMMARY block`);
      return;
    }

    const summary = result.summary!;

    // Save to local continuity ledger for session recovery
    // This ensures the ledger has actual data instead of placeholders
    if (this.continuity) {
      this.saveSummaryToLedger(summary).catch(err => {
        console.error(`[pty:${this.config.name}] Failed to save summary to ledger:`, err);
      });
    }

    // Emit event for external handlers (cloud services, dashboard, etc.)
    this.emit('summary', {
      agentName: this.config.name,
      summary,
    });
  }

  // Note: saveSummaryToLedger() is inherited from BaseWrapper

  /**
   * Check for [[SESSION_END]] blocks and emit 'session-end' event.
   * Allows cloud services to handle session closure without hardcoding storage.
   * Also stores the data for use in autoSave to populate handoff.
   */
  private checkForSessionEndAndEmit(content: string): void {
    if (this.sessionEndProcessed) return; // Only emit once per session

    const sessionEnd = parseSessionEndFromOutput(content);
    if (!sessionEnd) return;

    this.sessionEndProcessed = true;

    // Store SESSION_END data for use in autoSave (fixes empty handoff issue)
    this.sessionEndData = sessionEnd;

    // Emit event for external handlers
    this.emit('session-end', {
      agentName: this.config.name,
      marker: sessionEnd,
    });
  }

  /**
   * Check for auth revocation patterns in output.
   * Detects when the CLI's OAuth session has been revoked (e.g., user logged in elsewhere).
   * Emits 'auth_revoked' event and sends notification to relay daemon.
   */
  private checkAuthRevocation(output: string): void {
    // Only check once - auth revocation is a terminal state
    if (this.authRevoked) return;

    // Throttle checks to avoid performance impact
    const now = Date.now();
    if (now - this.lastAuthCheck < this.AUTH_CHECK_INTERVAL) return;
    this.lastAuthCheck = now;

    // Determine provider from config
    const provider = this.config.command || this.cliType || 'claude';

    // Check for auth revocation patterns
    const result = detectProviderAuthRevocation(output, provider);

    if (result.detected && result.confidence !== 'low') {
      this.authRevoked = true;

      console.error(
        `[pty:${this.config.name}] Auth revocation detected: ` +
        `pattern="${result.pattern}" confidence=${result.confidence} ` +
        `message="${result.message}"`
      );

      // Send notification to relay daemon via system channel
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

      // Emit event for external handlers (cloud services, dashboard)
      this.emit('auth_revoked', {
        agentName: this.config.name,
        provider,
        message: result.message,
        confidence: result.confidence,
      });
    }
  }

  /**
   * Reset auth state (e.g., after re-authentication)
   */
  resetAuthState(): void {
    this.authRevoked = false;
    this.lastAuthCheck = 0;
  }

  /**
   * Check if auth has been revoked
   */
  isAuthRevoked(): boolean {
    return this.authRevoked;
  }
}
