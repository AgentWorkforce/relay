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
import type { SendPayload, SendMeta, SpeakOnTrigger, Envelope } from '@agent-relay/protocol/types';
import type { ChannelMessagePayload } from '@agent-relay/protocol/channels';
import {
  type QueuedMessage,
  type InjectionMetrics,
  type CliType,
  type MessagePriority,
  getDefaultRelayPrefix,
  detectCliType,
  createInjectionMetrics,
  sortByPriority,
  getPriorityFromImportance,
  MESSAGE_PRIORITY,
} from './shared.js';
import {
  DEFAULT_IDLE_BEFORE_INJECT_MS,
  DEFAULT_IDLE_CONFIDENCE_THRESHOLD,
} from '@agent-relay/config/relay-config';
import {
  getContinuityManager,
  parseContinuityCommand,
  hasContinuityCommand,
  type ContinuityManager,
} from '@agent-relay/continuity';
import { UniversalIdleDetector } from './idle-detector.js';
import { StuckDetector, type StuckEvent, type StuckReason } from './stuck-detector.js';

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
  /** Milliseconds of idle time before injection is allowed (default: 1500) */
  idleBeforeInjectMs?: number;
  /** Confidence threshold for idle detection (0-1, default: 0.7) */
  idleConfidenceThreshold?: number;
  /** Skip initial instruction injection (when using --append-system-prompt) */
  skipInstructions?: boolean;
  /** Skip continuity loading (for spawned agents that don't need session recovery) */
  skipContinuity?: boolean;
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

  // Universal idle detection (shared across all wrapper types)
  protected idleDetector: UniversalIdleDetector;

  // Stuck detection (extended idle, error loops, output loops)
  protected stuckDetector: StuckDetector;

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
      _internal: true, // Suppress deprecation warning for internal wrapper usage
    });

    // Initialize continuity manager (skip for spawned agents that don't need session recovery)
    if (!config.skipContinuity) {
      this.continuity = getContinuityManager({ defaultCli: this.cliType });
    }

    // Initialize universal idle detector for robust injection timing
    this.idleDetector = new UniversalIdleDetector({
      minSilenceMs: config.idleBeforeInjectMs ?? DEFAULT_IDLE_BEFORE_INJECT_MS,
      confidenceThreshold: config.idleConfidenceThreshold ?? DEFAULT_IDLE_CONFIDENCE_THRESHOLD,
    });

    // Initialize stuck detector for extended idle and loop detection
    this.stuckDetector = new StuckDetector();
    this.stuckDetector.on('stuck', (event: StuckEvent) => {
      // Events are emitted for programmatic use - no terminal logging to avoid noise
      this.emit('stuck', event);
    });
    this.stuckDetector.on('unstuck', () => {
      this.emit('unstuck');
    });

    // Set up message handler for direct messages
    this.client.onMessage = (from, payload, messageId, meta, originalTo) => {
      this.handleIncomingMessage(from, payload, messageId, meta, originalTo);
    };

    // Set up channel message handler
    this.client.onChannelMessage = (from, channel, body, envelope) => {
      this.handleIncomingChannelMessage(from, channel, body, envelope);
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
  // Idle detection (shared across all wrapper types)
  // =========================================================================

  /**
   * Set the PID for process state inspection (Linux only).
   * Call this after the agent process is started.
   */
  protected setIdleDetectorPid(pid: number): void {
    this.idleDetector.setPid(pid);
  }

  /**
   * Start stuck detection. Call after the agent process starts.
   */
  protected startStuckDetection(): void {
    this.stuckDetector.start();
  }

  /**
   * Stop stuck detection. Call when the agent process stops.
   */
  protected stopStuckDetection(): void {
    this.stuckDetector.stop();
  }

  /**
   * Check if the agent is currently stuck.
   */
  isStuck(): boolean {
    return this.stuckDetector.getIsStuck();
  }

  /**
   * Get the reason for being stuck (if stuck).
   */
  getStuckReason(): StuckReason | null {
    return this.stuckDetector.getStuckReason();
  }

  /**
   * Feed output to the idle and stuck detectors.
   * Call this whenever new output is received from the agent.
   */
  protected feedIdleDetectorOutput(output: string): void {
    this.idleDetector.onOutput(output);
    this.stuckDetector.onOutput(output);
  }

  /**
   * Check if the agent is idle and ready for injection.
   * Returns idle state with confidence signals.
   */
  protected checkIdleForInjection(): { isIdle: boolean; confidence: number; signals: Array<{ source: string; confidence: number }> } {
    return this.idleDetector.checkIdle({
      minSilenceMs: this.config.idleBeforeInjectMs ?? DEFAULT_IDLE_BEFORE_INJECT_MS,
    });
  }

  /**
   * Wait for the agent to become idle.
   * Returns when idle or after timeout.
   */
  protected async waitForIdleState(timeoutMs = 30000, pollMs = 200): Promise<{ isIdle: boolean; confidence: number }> {
    return this.idleDetector.waitForIdle(timeoutMs, pollMs);
  }

  // =========================================================================
  // Priority queue management
  // =========================================================================

  /**
   * Sort the message queue by priority (urgent first).
   * Call this before processing messages to ensure proper ordering.
   */
  protected sortQueueByPriority(): void {
    if (this.messageQueue.length > 1) {
      this.messageQueue = sortByPriority(this.messageQueue);
    }
  }

  /**
   * Get the next message from the queue (highest priority first).
   * Does not remove the message - call dequeueMessage() to remove.
   */
  protected peekNextMessage(): QueuedMessage | undefined {
    this.sortQueueByPriority();
    return this.messageQueue[0];
  }

  /**
   * Remove and return the next message from the queue.
   * Messages are sorted by priority before dequeue.
   */
  protected dequeueMessage(): QueuedMessage | undefined {
    this.sortQueueByPriority();
    return this.messageQueue.shift();
  }

  /**
   * Get the priority of the next message in queue.
   * Returns MESSAGE_PRIORITY.NORMAL if queue is empty.
   */
  protected getNextMessagePriority(): MessagePriority {
    const next = this.messageQueue[0];
    return next ? getPriorityFromImportance(next.importance) : MESSAGE_PRIORITY.NORMAL;
  }

  /**
   * Check if there are urgent messages that should bypass normal idle wait.
   */
  protected hasUrgentMessages(): boolean {
    return this.messageQueue.some(
      msg => getPriorityFromImportance(msg.importance) === MESSAGE_PRIORITY.URGENT
    );
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
      sync: meta?.sync,
      originalTo,
    };

    this.messageQueue.push(queuedMsg);
  }

  /**
   * Send an ACK for a sync message after processing completes.
   * @param messageId - The message ID being acknowledged
   * @param sync - Sync metadata from the original message
   * @param response - Response status: 'OK' for success, 'ERROR' for failure
   * @param responseData - Optional structured response data
   */
  protected sendSyncAck(messageId: string, sync: SendMeta['sync'] | undefined, response: 'OK' | 'ERROR' | string, responseData?: unknown): void {
    if (!sync?.correlationId) return;
    this.client.sendAck({
      ack_id: messageId,
      seq: 0,
      correlationId: sync.correlationId,
      response,
      responseData,
    });
  }

  /**
   * Handle incoming channel message from relay.
   * Channel messages include a channel indicator so the agent knows to reply to the channel.
   */
  protected handleIncomingChannelMessage(
    from: string,
    channel: string,
    body: string,
    envelope: Envelope<ChannelMessagePayload>
  ): void {
    const messageId = envelope.id;

    // Deduplicate by message ID
    if (this.receivedMessageIds.has(messageId)) return;
    this.receivedMessageIds.add(messageId);

    // Limit dedup set size
    if (this.receivedMessageIds.size > 1000) {
      const oldest = this.receivedMessageIds.values().next().value;
      if (oldest) this.receivedMessageIds.delete(oldest);
    }

    // Queue the message with channel indicator in the body
    // Format: "Relay message from Alice [abc123] [#general]: message body"
    // This lets the agent know to reply to the channel, not the sender
    const queuedMsg: QueuedMessage = {
      from,
      body,
      messageId,
      thread: envelope.payload.thread,
      data: {
        _isChannelMessage: true,
        _channel: channel,
        _mentions: envelope.payload.mentions,
      },
      originalTo: channel, // Set channel as the reply target
    };

    console.error(`[base-wrapper] Received channel message: from=${from} channel=${channel} id=${messageId.substring(0, 8)}`);
    this.messageQueue.push(queuedMsg);
  }

  /**
   * Send a relay command via the client
   */
  protected sendRelayCommand(cmd: ParsedCommand): void {
    // Validate target
    if (isPlaceholderTarget(cmd.to)) {
      console.error(`[base-wrapper] Skipped message - placeholder target: ${cmd.to}`);
      return;
    }

    // Create hash for deduplication (use first 100 chars of body)
    const hash = `${cmd.to}:${cmd.body.substring(0, 100)}`;
    if (this.sentMessageHashes.has(hash)) {
      console.error(`[base-wrapper] Skipped duplicate message to ${cmd.to}`);
      return;
    }
    this.sentMessageHashes.add(hash);

    // Limit hash set size
    if (this.sentMessageHashes.size > 500) {
      const oldest = this.sentMessageHashes.values().next().value;
      if (oldest) this.sentMessageHashes.delete(oldest);
    }

    // Only send if client ready
    if (this.client.state !== 'READY') {
      console.error(`[base-wrapper] Client not ready (state=${this.client.state}), dropping message to ${cmd.to}`);
      return;
    }

    console.error(`[base-wrapper] sendRelayCommand: to=${cmd.to}, body=${cmd.body.substring(0, 50)}...`);

    let sendMeta: SendMeta | undefined;
    if (cmd.meta) {
      sendMeta = {
        importance: cmd.meta.importance,
        replyTo: cmd.meta.replyTo,
        requires_ack: cmd.meta.ackRequired,
      };
    }

    // Check if target is a channel (starts with #)
    if (cmd.to.startsWith('#')) {
      // Use CHANNEL_MESSAGE protocol for channel targets
      console.error(`[base-wrapper] Sending CHANNEL_MESSAGE to ${cmd.to}`);
      this.client.sendChannelMessage(cmd.to, cmd.body, {
        thread: cmd.thread,
        data: cmd.data,
      });
    } else {
      // Use SEND protocol for direct messages and broadcasts
      if (cmd.sync?.blocking) {
        this.client.sendAndWait(cmd.to, cmd.body, {
          timeoutMs: cmd.sync.timeoutMs,
          kind: cmd.kind,
          data: cmd.data,
          thread: cmd.thread,
        }).catch((err) => {
          console.error(`[base-wrapper] sendAndWait failed for ${cmd.to}: ${err.message}`);
        });
      } else {
        this.client.sendMessage(cmd.to, cmd.body, cmd.kind, cmd.data, cmd.thread, sendMeta);
      }
    }
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
      `${this.relayPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}spawn\\s+(\\w+)\\s+(\\w+)\\s*<<<[\\s]*([\\s\\S]*?)>>>`
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
    // TODO: Re-enable daemon socket spawn when client.spawn() is implemented
    // See: docs/SDK-MIGRATION-PLAN.md for planned implementation
    // For now, go directly to dashboard API or callback

    // Try dashboard API
    if (this.config.dashboardPort) {
      try {
        const response = await fetch(
          `http://localhost:${this.config.dashboardPort}/api/spawn`,
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

    // Use callback as final fallback
    if (this.config.onSpawn) {
      await this.config.onSpawn(name, cli, task);
    }
  }

  /**
   * Execute a release command
   */
  protected async executeRelease(name: string): Promise<void> {
    // TODO: Re-enable daemon socket release when client.release() is implemented
    // See: docs/SDK-MIGRATION-PLAN.md for planned implementation
    // For now, go directly to dashboard API or callback

    // Try dashboard API as fallback (backwards compatibility)
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

    // Use callback as final fallback
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
      }

      // Otherwise get or create
      if (!ledger) {
        ledger = await this.continuity.getOrCreateLedger(
          this.config.name,
          this.cliType
        );
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
