/**
 * BaseWrapper - Abstract base class for agent wrappers
 *
 * Provides shared functionality between TmuxWrapper and PtyWrapper:
 * - Message queue management and deduplication
 * - Spawn/release command parsing and execution
 * - Continuity integration (agent ID, summary saving)
 * - Relay command handling
 * - Line joining for multi-line commands
 *
 * Subclasses implement:
 * - start() - Initialize and start the agent process
 * - stop() - Stop the agent process
 * - performInjection() - Inject content into the agent
 * - getCleanOutput() - Get cleaned output for parsing
 */

import { EventEmitter } from 'node:events';
import { RelayClient } from './client.js';
import type { ParsedCommand, ParsedSummary } from './parser.js';
import { isPlaceholderTarget } from './parser.js';
import type { SendPayload, SendMeta, SpeakOnTrigger } from '../protocol/types.js';
import {
  type QueuedMessage,
  type InjectionMetrics,
  type CliType,
  getDefaultRelayPrefix,
  detectCliType,
  createInjectionMetrics,
} from './shared.js';
import {
  getContinuityManager,
  parseContinuityCommand,
  hasContinuityCommand,
  type ContinuityManager,
} from '../continuity/index.js';

/**
 * Base configuration shared by all wrapper types
 */
export interface BaseWrapperConfig {
  /** Agent name (must be unique) */
  name: string;
  /** Command to execute */
  command: string;
  /** Command arguments */
  args?: string[];
  /** Relay daemon socket path */
  socketPath?: string;
  /** Working directory */
  cwd?: string;
  /** Environment variables */
  env?: Record<string, string>;
  /** Relay prefix pattern (default: '->relay:') */
  relayPrefix?: string;
  /** CLI type (auto-detected if not set) */
  cliType?: CliType;
  /** Dashboard port for spawn/release API */
  dashboardPort?: number;
  /** Callback when spawn command is parsed */
  onSpawn?: (name: string, cli: string, task: string) => Promise<void>;
  /** Callback when release command is parsed */
  onRelease?: (name: string) => Promise<void>;
  /** Agent ID to resume from (for continuity) */
  resumeAgentId?: string;
  /** Stream logs to daemon */
  streamLogs?: boolean;
  /** Task/role description */
  task?: string;
  /** Shadow configuration */
  shadowOf?: string;
  shadowSpeakOn?: SpeakOnTrigger[];
}

/**
 * Abstract base class for agent wrappers
 */
export abstract class BaseWrapper extends EventEmitter {
  protected config: BaseWrapperConfig;
  protected client: RelayClient;
  protected relayPrefix: string;
  protected cliType: CliType;
  protected running = false;

  // Message queue state
  protected messageQueue: QueuedMessage[] = [];
  protected sentMessageHashes: Set<string> = new Set();
  protected isInjecting = false;
  protected receivedMessageIds: Set<string> = new Set();
  protected injectionMetrics: InjectionMetrics = createInjectionMetrics();

  // Spawn/release state
  protected processedSpawnCommands: Set<string> = new Set();
  protected processedReleaseCommands: Set<string> = new Set();
  protected pendingFencedSpawn: { name: string; cli: string; taskLines: string[] } | null = null;

  // Continuity state
  protected continuity?: ContinuityManager;
  protected agentId?: string;
  protected processedContinuityCommands: Set<string> = new Set();
  protected sessionEndProcessed = false;
  protected sessionEndData?: { summary?: string; completedTasks?: string[] };
  protected lastSummaryRawContent = '';

  constructor(config: BaseWrapperConfig) {
    super();
    this.config = config;
    this.relayPrefix = config.relayPrefix ?? getDefaultRelayPrefix();
    this.cliType = config.cliType ?? detectCliType(config.command);

    // Initialize relay client with full config
    this.client = new RelayClient({
      agentName: config.name,
      socketPath: config.socketPath,
      cli: this.cliType,
      task: config.task,
      workingDirectory: config.cwd,
      quiet: true,
    });

    // Initialize continuity manager
    this.continuity = getContinuityManager({ defaultCli: this.cliType });

    // Set up message handler
    this.client.onMessage = (from, payload, messageId, meta, originalTo) => {
      this.handleIncomingMessage(from, payload, messageId, meta, originalTo);
    };
  }

  // =========================================================================
  // Abstract methods (subclasses must implement)
  // =========================================================================

  /** Start the agent process */
  abstract start(): Promise<void>;

  /** Stop the agent process */
  abstract stop(): Promise<void> | void;

  /** Inject content into the agent */
  protected abstract performInjection(content: string): Promise<void>;

  /** Get cleaned output for parsing */
  protected abstract getCleanOutput(): string;

  // =========================================================================
  // Common getters
  // =========================================================================

  get isRunning(): boolean {
    return this.running;
  }

  get name(): string {
    return this.config.name;
  }

  getAgentId(): string | undefined {
    return this.agentId;
  }

  getInjectionMetrics(): InjectionMetrics & { successRate: number } {
    const total = this.injectionMetrics.total;
    const successes = this.injectionMetrics.successFirstTry + this.injectionMetrics.successWithRetry;
    const successRate = total > 0
      ? (successes / total) * 100
      : 100;
    return {
      ...this.injectionMetrics,
      successRate,
    };
  }

  get pendingMessageCount(): number {
    return this.messageQueue.length;
  }

  // =========================================================================
  // Message handling
  // =========================================================================

  /**
   * Handle incoming message from relay
   */
  protected handleIncomingMessage(
    from: string,
    payload: SendPayload,
    messageId: string,
    meta?: SendMeta,
    originalTo?: string
  ): void {
    // Deduplicate by message ID
    if (this.receivedMessageIds.has(messageId)) return;
    this.receivedMessageIds.add(messageId);

    // Limit dedup set size
    if (this.receivedMessageIds.size > 1000) {
      const oldest = this.receivedMessageIds.values().next().value;
      if (oldest) this.receivedMessageIds.delete(oldest);
    }

    // Queue the message
    const queuedMsg: QueuedMessage = {
      from,
      body: payload.body,
      messageId,
      thread: payload.thread,
      importance: meta?.importance,
      data: payload.data,
      originalTo,
    };

    this.messageQueue.push(queuedMsg);
  }

  /**
   * Send a relay command via the client
   */
  protected sendRelayCommand(cmd: ParsedCommand): void {
    // Validate target
    if (isPlaceholderTarget(cmd.to)) return;

    // Create hash for deduplication (use first 100 chars of body)
    const hash = `${cmd.to}:${cmd.body.substring(0, 100)}`;
    if (this.sentMessageHashes.has(hash)) return;
    this.sentMessageHashes.add(hash);

    // Limit hash set size
    if (this.sentMessageHashes.size > 500) {
      const oldest = this.sentMessageHashes.values().next().value;
      if (oldest) this.sentMessageHashes.delete(oldest);
    }

    // Only send if client ready
    if (this.client.state !== 'READY') return;

    this.client.sendMessage(cmd.to, cmd.body, cmd.kind, cmd.data, cmd.thread);
  }

  // =========================================================================
  // Spawn/release handling
  // =========================================================================

  /**
   * Parse spawn and release commands from output
   */
  protected parseSpawnReleaseCommands(content: string): void {
    // Single-line spawn: ->relay:spawn Name cli "task"
    const spawnPattern = new RegExp(
      `${this.relayPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}spawn\\s+(\\w+)\\s+(\\w+)\\s+"([^"]+)"`
    );
    const spawnMatch = content.match(spawnPattern);
    if (spawnMatch) {
      const [, name, cli, task] = spawnMatch;
      const cmdHash = `spawn:${name}:${cli}:${task}`;
      if (!this.processedSpawnCommands.has(cmdHash)) {
        this.processedSpawnCommands.add(cmdHash);
        this.executeSpawn(name, cli, task);
      }
    }

    // Fenced spawn: ->relay:spawn Name cli <<<\ntask\n>>>
    const fencedSpawnPattern = new RegExp(
      `${this.relayPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}spawn\\s+(\\w+)\\s+(\\w+)\\s+<<<\\n?([\\s\\S]*?)>>>`
    );
    const fencedSpawnMatch = content.match(fencedSpawnPattern);
    if (fencedSpawnMatch) {
      const [, name, cli, task] = fencedSpawnMatch;
      const cmdHash = `spawn:${name}:${cli}:${task.trim()}`;
      if (!this.processedSpawnCommands.has(cmdHash)) {
        this.processedSpawnCommands.add(cmdHash);
        this.executeSpawn(name, cli, task.trim());
      }
    }

    // Release: ->relay:release Name
    const releasePattern = new RegExp(
      `${this.relayPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}release\\s+(\\w+)`
    );
    const releaseMatch = content.match(releasePattern);
    if (releaseMatch) {
      const name = releaseMatch[1];
      const cmdHash = `release:${name}`;
      if (!this.processedReleaseCommands.has(cmdHash)) {
        this.processedReleaseCommands.add(cmdHash);
        this.executeRelease(name);
      }
    }
  }

  /**
   * Execute a spawn command
   */
  protected async executeSpawn(name: string, cli: string, task: string): Promise<void> {
    // Try dashboard API first
    if (this.config.dashboardPort) {
      try {
        const response = await fetch(
          `http://localhost:${this.config.dashboardPort}/api/agents/spawn`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, cli, task }),
          }
        );
        if (response.ok) return;
      } catch {
        // Fall through to callback
      }
    }

    // Use callback
    if (this.config.onSpawn) {
      await this.config.onSpawn(name, cli, task);
    }
  }

  /**
   * Execute a release command
   */
  protected async executeRelease(name: string): Promise<void> {
    // Try dashboard API first
    if (this.config.dashboardPort) {
      try {
        const response = await fetch(
          `http://localhost:${this.config.dashboardPort}/api/agents/${name}`,
          { method: 'DELETE' }
        );
        if (response.ok) return;
      } catch {
        // Fall through to callback
      }
    }

    // Use callback
    if (this.config.onRelease) {
      await this.config.onRelease(name);
    }
  }

  // =========================================================================
  // Continuity handling
  // =========================================================================

  /**
   * Initialize agent ID for continuity/resume
   */
  protected async initializeAgentId(): Promise<void> {
    if (!this.continuity) return;

    try {
      let ledger;

      // If resuming, try to find previous ledger
      if (this.config.resumeAgentId) {
        ledger = await this.continuity.findLedgerByAgentId(this.config.resumeAgentId);
        if (ledger) {
          console.log(`[${this.config.name}] Resuming agent ID: ${ledger.agentId}`);
        }
      }

      // Otherwise get or create
      if (!ledger) {
        ledger = await this.continuity.getOrCreateLedger(
          this.config.name,
          this.cliType
        );
        console.log(`[${this.config.name}] Agent ID: ${ledger.agentId}`);
      }

      this.agentId = ledger.agentId;
    } catch (err: any) {
      console.error(`[${this.config.name}] Failed to initialize agent ID: ${err.message}`);
    }
  }

  /**
   * Parse continuity commands from output
   */
  protected async parseContinuityCommands(content: string): Promise<void> {
    if (!this.continuity) return;
    if (!hasContinuityCommand(content)) return;

    const command = parseContinuityCommand(content);
    if (!command) return;

    // Deduplication
    const cmdHash = `${command.type}:${command.content || command.query || command.item || 'no-content'}`;
    if (command.content && this.processedContinuityCommands.has(cmdHash)) return;
    this.processedContinuityCommands.add(cmdHash);

    // Limit dedup set size
    if (this.processedContinuityCommands.size > 100) {
      const oldest = this.processedContinuityCommands.values().next().value;
      if (oldest) this.processedContinuityCommands.delete(oldest);
    }

    try {
      const response = await this.continuity.handleCommand(this.config.name, command);
      if (response) {
        // Queue response for injection
        this.messageQueue.push({
          from: 'system',
          body: response,
          messageId: `continuity-${Date.now()}`,
          thread: 'continuity-response',
        });
      }
    } catch (err: any) {
      console.error(`[${this.config.name}] Continuity command error: ${err.message}`);
    }
  }

  /**
   * Save a parsed summary to the continuity ledger
   */
  protected async saveSummaryToLedger(summary: ParsedSummary): Promise<void> {
    if (!this.continuity) return;

    const updates: Record<string, unknown> = {};

    if (summary.currentTask) {
      updates.currentTask = summary.currentTask;
    }

    if (summary.completedTasks && summary.completedTasks.length > 0) {
      updates.completed = summary.completedTasks;
    }

    if (summary.context) {
      updates.inProgress = [summary.context];
    }

    if (summary.files && summary.files.length > 0) {
      updates.fileContext = summary.files.map((f: string) => ({ path: f }));
    }

    if (Object.keys(updates).length > 0) {
      await this.continuity.saveLedger(this.config.name, updates);
      console.log(`[${this.config.name}] Saved summary to continuity ledger`);
    }
  }

  /**
   * Reset session-specific state for wrapper reuse
   */
  resetSessionState(): void {
    this.sessionEndProcessed = false;
    this.lastSummaryRawContent = '';
    this.sessionEndData = undefined;
  }

  // =========================================================================
  // Utility methods
  // =========================================================================

  /**
   * Join continuation lines for multi-line relay/continuity commands.
   * TUIs like Claude Code insert real newlines in output, causing
   * messages to span multiple lines. This joins indented
   * continuation lines back to the command line.
   */
  protected joinContinuationLines(content: string): string {
    const lines = content.split('\n');
    const result: string[] = [];

    // Pattern to detect relay OR continuity command line (with optional bullet prefix)
    const escapedPrefix = this.relayPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const commandPattern = new RegExp(
      `^(?:\\s*(?:[>$%#→➜›»●•◦‣⁃\\-*⏺◆◇○□■]\\s*)*)?(?:${escapedPrefix}|->continuity:)`
    );
    // Pattern to detect a continuation line (starts with spaces, no bullet/command)
    const continuationPattern = /^[ \t]+[^>$%#→➜›»●•◦‣⁃\-*⏺◆◇○□■\s]/;
    // Pattern to detect a new block/bullet (stops continuation)
    const newBlockPattern = /^(?:\s*)?[>$%#→➜›»●•◦‣⁃\-*⏺◆◇○□■]/;

    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      // Check if this is a command line
      if (commandPattern.test(line)) {
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
            // Join with newline to preserve multi-line message content
            joined += '\n' + nextLine.trim();
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
   * Clean up resources
   */
  protected destroyClient(): void {
    this.client.destroy();
  }
}
