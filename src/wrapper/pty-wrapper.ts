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
import type { ParsedCommand, ParsedSummary, SessionEndMarker } from './parser.js';
import { parseSummaryWithDetails, parseSessionEndFromOutput } from './parser.js';
import type { SendPayload, SendMeta, SpeakOnTrigger } from '../protocol/types.js';
import { getProjectPaths } from '../utils/project-namespace.js';
import { getTrailEnvVars } from '../trajectory/integration.js';
import { findAgentConfig } from '../utils/agent-config.js';
import { HookRegistry, createTrajectoryHooks, type LifecycleHooks } from '../hooks/index.js';
import { getContinuityManager, parseContinuityCommand, hasContinuityCommand, type ContinuityManager } from '../continuity/index.js';
import {
  type QueuedMessage,
  type InjectionMetrics,
  type InjectionCallbacks,
  type CliType,
  INJECTION_CONSTANTS,
  stripAnsi,
  sleep,
  buildInjectionString,
  injectWithRetry as sharedInjectWithRetry,
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
  /** Allow this agent to spawn other agents (default: true for Lead, false for spawned workers) */
  allowSpawn?: boolean;
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
  /** Resume from a previous agent ID (for crash recovery) */
  resumeAgentId?: string;
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

export interface PtyWrapperEvents {
  output: (data: string) => void;
  exit: (code: number) => void;
  error: (error: Error) => void;
  'injection-failed': (event: InjectionFailedEvent) => void;
  /** Emitted when agent outputs a [[SUMMARY]] block. Cloud services can persist this. */
  'summary': (event: SummaryEvent) => void;
  /** Emitted when agent outputs a [[SESSION_END]] block. Cloud services can handle session closure. */
  'session-end': (event: SessionEndEvent) => void;
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
  private pendingFencedSpawn: { name: string; cli: string; taskLines: string[] } | null = null;
  private messageQueue: QueuedMessage[] = [];
  private isInjecting = false;
  private readyForMessages = false;
  private lastOutputTime = 0;
  private injectionMetrics: InjectionMetrics = createInjectionMetrics();
  private logFilePath?: string;
  private logStream?: fs.WriteStream;
  private hasAcceptedPrompt = false;
  private hookRegistry: HookRegistry;
  private sessionStartTime = Date.now();
  private continuity?: ContinuityManager;
  private agentId?: string;
  private processedContinuityCommands: Set<string> = new Set();
  private lastSummaryRawContent = ''; // Dedup summary event emissions
  private sessionEndProcessed = false; // Track if we've already emitted session-end
  private inThinkingBlock = false; // Track if inside <thinking>...</thinking>
  private lastSummaryTime = Date.now(); // Track when last summary was output
  private outputsSinceSummary = 0; // Count outputs since last summary
  private detectedTask?: string; // Auto-detected task from agent config
  private sessionEndData?: SessionEndMarker; // Store SESSION_END data for handoff

  constructor(config: PtyWrapperConfig) {
    super();
    this.config = config;
    this.relayPrefix = config.relayPrefix ?? getDefaultRelayPrefix();

    // Detect CLI type from command for special handling
    this.cliType = config.cliType ?? detectCliType(config.command);

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

    this.client = new RelayClient({
      agentName: config.name,
      socketPath: config.socketPath,
      cli: this.cliType,
      task: detectedTask,
      workingDirectory: config.cwd ?? process.cwd(),
      quiet: true,
    });

    // Initialize hook registry
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

    // Initialize continuity manager
    this.continuity = getContinuityManager({ defaultCli: 'spawned' });

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

    // Initialize continuity and get agentId, then inject context
    this.initializeAgentId()
      .then(() => this.injectContinuityContext())
      .catch(err => {
        console.error(`[pty:${this.config.name}] Agent ID/continuity initialization error:`, err);
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
   * Initialize agent ID for continuity/resume functionality
   */
  private async initializeAgentId(): Promise<void> {
    if (!this.continuity) return;

    try {
      let ledger;

      // If resuming from a previous agent ID, try to find that ledger
      if (this.config.resumeAgentId) {
        ledger = await this.continuity.findLedgerByAgentId(this.config.resumeAgentId);
        if (ledger) {
          console.log(`[pty:${this.config.name}] Resuming agent ID: ${ledger.agentId} (from previous session)`);
        } else {
          console.error(`[pty:${this.config.name}] Resume agent ID ${this.config.resumeAgentId} not found, creating new`);
        }
      }

      // If not resuming or resume ID not found, get or create ledger
      if (!ledger) {
        ledger = await this.continuity.getOrCreateLedger(
          this.config.name,
          'spawned'
        );
        console.log(`[pty:${this.config.name}] Agent ID: ${ledger.agentId} (use this to resume if agent dies)`);
      }

      this.agentId = ledger.agentId;
    } catch (err: any) {
      console.error(`[pty:${this.config.name}] Failed to initialize agent ID: ${err.message}`);
    }
  }

  /**
   * Get the current agent ID
   */
  getAgentId(): string | undefined {
    return this.agentId;
  }

  /**
   * Inject continuity context from previous session.
   * Called after agent ID initialization to restore state from ledger.
   */
  private async injectContinuityContext(): Promise<void> {
    if (!this.continuity || !this.running) return;

    try {
      const context = await this.continuity.getStartupContext(this.config.name);
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
  private async parseContinuityCommands(content: string): Promise<void> {
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
        this.client.sendMessage(this.config.name, response, 'message', {
          thread: 'continuity-response',
        });
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
    if (this.config.streamLogs !== false && this.client.state === 'READY') {
      const filteredData = this.filterThinkingBlocks(data);
      if (filteredData) {
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
    const cleanData = stripAnsi(data);
    this.hookRegistry.dispatchOutput(cleanData, data).catch(err => {
      console.error(`[pty:${this.config.name}] Output hook error:`, err);
    });

    // Check for [[SUMMARY]] and [[SESSION_END]] blocks and emit events
    // This allows cloud services to handle persistence without hardcoding storage
    const cleanContent = stripAnsi(this.rawBuffer);
    this.checkForSummaryAndEmit(cleanContent);
    this.checkForSessionEndAndEmit(cleanContent);

    // Parse for continuity commands (->continuity:save, ->continuity:load, etc.)
    // Use rawBuffer (accumulated content) not immediate chunk, since multi-line
    // fenced commands like ->continuity:save <<<...>>> span multiple output events
    this.parseContinuityCommands(cleanContent).catch(err => {
      console.error(`[pty:${this.config.name}] Continuity command parsing error:`, err);
    });

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
   * Auto-accept Claude's first-run prompts
   * Handles:
   * 1. --dangerously-skip-permissions acceptance ("Yes, I accept")
   * 2. Trust directory prompt ("Yes, I trust this folder")
   */
  private handleAutoAcceptPrompts(data: string): void {
    if (this.hasAcceptedPrompt) return;
    if (!this.ptyProcess || !this.running) return;

    const cleanData = stripAnsi(data);

    // Check for the permission acceptance prompt (--dangerously-skip-permissions)
    // Pattern: "2. Yes, I accept" in the output
    if (cleanData.includes('Yes, I accept') && cleanData.includes('No, exit')) {
      console.log(`[pty:${this.config.name}] Detected permission prompt, auto-accepting...`);
      this.hasAcceptedPrompt = true;
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
    if ((cleanData.includes('trust this folder') || cleanData.includes('safety check'))
        && cleanData.includes('No, exit')) {
      console.log(`[pty:${this.config.name}] Detected trust directory prompt, auto-accepting...`);
      this.hasAcceptedPrompt = true;
      // Send Enter to accept first option (already selected)
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

      // Skip spawn/release commands - they are handled by parseSpawnReleaseCommands
      if (/^spawn$/i.test(target) || /^release$/i.test(target)) {
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

      // Dispatch message sent hook
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
   */
  private parseSpawnReleaseCommands(content: string): void {
    // Need either API port or callbacks to handle spawn/release
    // Also check allowSpawn config - spawned workers should not spawn other agents
    const spawnAllowed = this.config.allowSpawn !== false;
    const canSpawn = spawnAllowed && (this.config.dashboardPort || this.config.onSpawn);
    const canRelease = this.config.dashboardPort || this.config.onRelease;
    if (!canSpawn && !canRelease) return;

    const lines = content.split('\n');
    const spawnPrefix = '->relay:spawn';
    const releasePrefix = '->relay:release';

    for (const line of lines) {
      const trimmed = line.trim();

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

        // Check for fenced format: Name [cli] <<< (CLI optional, defaults to 'claude')
        const fencedMatch = afterSpawn.match(/^(\S+)(?:\s+(\S+))?\s+<<<(.*)$/);
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
            // Start multi-line fenced mode
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
      if (canRelease && trimmed.startsWith(releasePrefix)) {
        const afterRelease = trimmed.substring(releasePrefix.length).trim();
        const name = afterRelease.split(/\s+/)[0];

        // STRICT: Validate agent name format
        if (name && this.isValidAgentName(name) && !this.processedReleaseCommands.has(name)) {
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

    // Dispatch message received hook
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
   * Inject usage instructions including persistence protocol
   */
  private injectInstructions(): void {
    if (!this.running || !this.ptyProcess) return;

    const escapedPrefix = '\\' + this.relayPrefix;
    const instructions = [
      `[Agent Relay] You are "${this.config.name}" - connected for real-time messaging.`,
      `SEND: ${escapedPrefix}AgentName message`,
      `PROTOCOL: (1) ACK receipt (2) Work (3) Send "DONE: summary"`,
      `PERSIST: Output [[SUMMARY]]{"currentTask":"...","context":"..."}[[/SUMMARY]] after major work.`,
      `END: Output [[SESSION_END]]{"summary":"..."}[[/SESSION_END]] when session complete.`,
    ].join(' | ');

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
   * Track significant outputs and inject summary reminder if needed.
   * Works with any CLI (Claude, Gemini, Codex, etc.)
   */
  private trackOutputAndRemind(data: string): void {
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
      const reminder = `\n[Agent Relay] It's been ${Math.round(minutesSinceSummary)} minutes. Please output a [[SUMMARY]] block to checkpoint your progress:\n[[SUMMARY]]\n{"currentTask": "...", "completedTasks": [...], "context": "..."}\n[[/SUMMARY]]\n`;

      // Delay slightly to not interrupt current output
      setTimeout(() => {
        if (this.ptyProcess && this.running) {
          this.ptyProcess.write(reminder + '\r');
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

  /**
   * Save a parsed summary to the continuity ledger.
   * Maps summary fields to ledger fields for session recovery.
   */
  private async saveSummaryToLedger(summary: ParsedSummary): Promise<void> {
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
      console.log(`[pty:${this.config.name}] Saved summary to continuity ledger`);
    }
  }

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
   * Reset session-specific state for wrapper reuse.
   * Call this when starting a new session with the same wrapper instance.
   */
  resetSessionState(): void {
    this.sessionEndProcessed = false;
    this.lastSummaryRawContent = '';
    this.sessionEndData = undefined;
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
