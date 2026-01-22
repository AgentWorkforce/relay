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
import type { SendPayload, SendMeta, SpeakOnTrigger, Envelope } from '@relay/protocol/types';
import type { ChannelMessagePayload } from '@relay/protocol/channels';
import { type QueuedMessage, type InjectionMetrics, type CliType } from './shared.js';
import { type ContinuityManager } from '@relay/continuity';
import { UniversalIdleDetector } from './idle-detector.js';
import { StuckDetector, type StuckReason } from './stuck-detector.js';
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
export declare abstract class BaseWrapper extends EventEmitter {
    protected config: BaseWrapperConfig;
    protected client: RelayClient;
    protected relayPrefix: string;
    protected cliType: CliType;
    protected running: boolean;
    protected messageQueue: QueuedMessage[];
    protected sentMessageHashes: Set<string>;
    protected isInjecting: boolean;
    protected receivedMessageIds: Set<string>;
    protected injectionMetrics: InjectionMetrics;
    protected processedSpawnCommands: Set<string>;
    protected processedReleaseCommands: Set<string>;
    protected pendingFencedSpawn: {
        name: string;
        cli: string;
        taskLines: string[];
    } | null;
    protected continuity?: ContinuityManager;
    protected agentId?: string;
    protected processedContinuityCommands: Set<string>;
    protected sessionEndProcessed: boolean;
    protected sessionEndData?: {
        summary?: string;
        completedTasks?: string[];
    };
    protected lastSummaryRawContent: string;
    protected idleDetector: UniversalIdleDetector;
    protected stuckDetector: StuckDetector;
    constructor(config: BaseWrapperConfig);
    /** Start the agent process */
    abstract start(): Promise<void>;
    /** Stop the agent process */
    abstract stop(): Promise<void> | void;
    /** Inject content into the agent */
    protected abstract performInjection(content: string): Promise<void>;
    /** Get cleaned output for parsing */
    protected abstract getCleanOutput(): string;
    get isRunning(): boolean;
    get name(): string;
    getAgentId(): string | undefined;
    getInjectionMetrics(): InjectionMetrics & {
        successRate: number;
    };
    get pendingMessageCount(): number;
    /**
     * Set the PID for process state inspection (Linux only).
     * Call this after the agent process is started.
     */
    protected setIdleDetectorPid(pid: number): void;
    /**
     * Start stuck detection. Call after the agent process starts.
     */
    protected startStuckDetection(): void;
    /**
     * Stop stuck detection. Call when the agent process stops.
     */
    protected stopStuckDetection(): void;
    /**
     * Check if the agent is currently stuck.
     */
    isStuck(): boolean;
    /**
     * Get the reason for being stuck (if stuck).
     */
    getStuckReason(): StuckReason | null;
    /**
     * Feed output to the idle and stuck detectors.
     * Call this whenever new output is received from the agent.
     */
    protected feedIdleDetectorOutput(output: string): void;
    /**
     * Check if the agent is idle and ready for injection.
     * Returns idle state with confidence signals.
     */
    protected checkIdleForInjection(): {
        isIdle: boolean;
        confidence: number;
        signals: Array<{
            source: string;
            confidence: number;
        }>;
    };
    /**
     * Wait for the agent to become idle.
     * Returns when idle or after timeout.
     */
    protected waitForIdleState(timeoutMs?: number, pollMs?: number): Promise<{
        isIdle: boolean;
        confidence: number;
    }>;
    /**
     * Handle incoming message from relay
     */
    protected handleIncomingMessage(from: string, payload: SendPayload, messageId: string, meta?: SendMeta, originalTo?: string): void;
    /**
     * Send an ACK for a sync message after processing completes.
     */
    protected sendSyncAck(messageId: string, sync: SendMeta['sync'] | undefined, response: boolean, responseData?: unknown): void;
    /**
     * Handle incoming channel message from relay.
     * Channel messages include a channel indicator so the agent knows to reply to the channel.
     */
    protected handleIncomingChannelMessage(from: string, channel: string, body: string, envelope: Envelope<ChannelMessagePayload>): void;
    /**
     * Send a relay command via the client
     */
    protected sendRelayCommand(cmd: ParsedCommand): void;
    /**
     * Parse spawn and release commands from output
     */
    protected parseSpawnReleaseCommands(content: string): void;
    /**
     * Execute a spawn command
     */
    protected executeSpawn(name: string, cli: string, task: string): Promise<void>;
    /**
     * Execute a release command
     */
    protected executeRelease(name: string): Promise<void>;
    /**
     * Initialize agent ID for continuity/resume
     */
    protected initializeAgentId(): Promise<void>;
    /**
     * Parse continuity commands from output
     */
    protected parseContinuityCommands(content: string): Promise<void>;
    /**
     * Save a parsed summary to the continuity ledger
     */
    protected saveSummaryToLedger(summary: ParsedSummary): Promise<void>;
    /**
     * Reset session-specific state for wrapper reuse
     */
    resetSessionState(): void;
    /**
     * Join continuation lines for multi-line relay/continuity commands.
     * TUIs like Claude Code insert real newlines in output, causing
     * messages to span multiple lines. This joins indented
     * continuation lines back to the command line.
     */
    protected joinContinuationLines(content: string): string;
    /**
     * Clean up resources
     */
    protected destroyClient(): void;
}
//# sourceMappingURL=base-wrapper.d.ts.map