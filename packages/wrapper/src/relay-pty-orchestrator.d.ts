/**
 * RelayPtyOrchestrator - Orchestrates the relay-pty Rust binary
 *
 * This wrapper spawns the relay-pty binary and communicates via Unix socket.
 * It provides the same interface as PtyWrapper but with improved latency
 * (~550ms vs ~1700ms) by using direct PTY writes instead of tmux send-keys.
 *
 * Architecture:
 * 1. Spawn relay-pty --name {agentName} -- {command} as child process
 * 2. Connect to socket for injection:
 *    - With WORKSPACE_ID: /tmp/relay/{workspaceId}/sockets/{agentName}.sock
 *    - Without: /tmp/relay-pty-{agentName}.sock (legacy)
 * 3. Parse stdout for relay commands (relay-pty echoes all output)
 * 4. Translate SEND envelopes → inject messages via socket
 *
 * @see docs/RUST_WRAPPER_DESIGN.md for protocol details
 */
import { BaseWrapper, type BaseWrapperConfig } from './base-wrapper.js';
import type { SendPayload, SendMeta } from '@relay/protocol/types';
interface StatusResponse {
    type: 'status';
    agent_idle: boolean;
    queue_length: number;
    cursor_position?: [number, number];
    last_output_ms: number;
}
/**
 * Configuration for RelayPtyOrchestrator
 */
export interface RelayPtyOrchestratorConfig extends BaseWrapperConfig {
    /** Path to relay-pty binary (default: searches PATH and ./relay-pty/target/release) */
    relayPtyPath?: string;
    /** Socket connect timeout in ms (default: 5000) */
    socketConnectTimeoutMs?: number;
    /** Socket reconnect attempts (default: 3) */
    socketReconnectAttempts?: number;
    /** Callback when agent exits */
    onExit?: (code: number) => void;
    /** Callback when injection fails after retries */
    onInjectionFailed?: (messageId: string, error: string) => void;
    /** Enable debug logging (default: false) */
    debug?: boolean;
}
/**
 * Events emitted by RelayPtyOrchestrator
 */
export interface RelayPtyOrchestratorEvents {
    output: (data: string) => void;
    exit: (code: number) => void;
    error: (error: Error) => void;
    'injection-failed': (event: {
        messageId: string;
        from: string;
        error: string;
    }) => void;
    'backpressure': (event: {
        queueLength: number;
        accept: boolean;
    }) => void;
    'summary': (event: {
        agentName: string;
        summary: unknown;
    }) => void;
    'session-end': (event: {
        agentName: string;
        marker: unknown;
    }) => void;
}
/**
 * Orchestrator for relay-pty Rust binary
 *
 * Extends BaseWrapper to provide the same interface as PtyWrapper
 * but uses the relay-pty binary for improved injection reliability.
 */
export declare class RelayPtyOrchestrator extends BaseWrapper {
    protected config: RelayPtyOrchestratorConfig;
    private relayPtyProcess?;
    private socketPath;
    private _logPath;
    private _outboxPath;
    private _legacyOutboxPath;
    private _workspaceId?;
    private socket?;
    private socketConnected;
    private outputBuffer;
    private rawBuffer;
    private lastParsedLength;
    private isInteractive;
    private pendingInjections;
    private backpressureActive;
    private readyForMessages;
    private lastUnreadIndicatorTime;
    private readonly UNREAD_INDICATOR_COOLDOWN_MS;
    private hasReceivedOutput;
    private queueMonitorTimer?;
    private readonly QUEUE_MONITOR_INTERVAL_MS;
    private protocolWatcher?;
    private protocolReminderCooldown;
    private readonly PROTOCOL_REMINDER_COOLDOWN_MS;
    private periodicReminderTimer?;
    private readonly PERIODIC_REMINDER_INTERVAL_MS;
    private sessionStartTime;
    constructor(config: RelayPtyOrchestratorConfig);
    /**
     * Debug log - only outputs when debug is enabled
     */
    private log;
    /**
     * Error log - always outputs (errors are important)
     */
    private logError;
    /**
     * Get the outbox path for this agent (for documentation purposes)
     */
    get outboxPath(): string;
    /**
     * Start the relay-pty process and connect to socket
     */
    start(): Promise<void>;
    /**
     * Stop the relay-pty process gracefully
     */
    stop(): Promise<void>;
    /**
     * Inject content into the agent via socket
     */
    protected performInjection(_content: string): Promise<void>;
    /**
     * Get cleaned output for parsing
     */
    protected getCleanOutput(): string;
    /**
     * Find the relay-pty binary
     */
    private findRelayPtyBinary;
    /**
     * Spawn the relay-pty process
     */
    private spawnRelayPty;
    /**
     * Handle output from relay-pty stdout (headless mode only)
     * In interactive mode, stdout goes directly to terminal via inherited stdio
     */
    private handleOutput;
    /**
     * Format an unread message indicator if there are pending messages.
     * Returns empty string if no pending messages or within cooldown period.
     *
     * Example output:
     * ───────────────────────────
     * 📬 2 unread messages (from: Alice, Bob)
     */
    private formatUnreadIndicator;
    /**
     * Handle stderr from relay-pty (logs and JSON parsed commands)
     */
    private handleStderr;
    /**
     * Handle a parsed command from Rust relay-pty
     * Rust outputs structured JSON with 'kind' field: "message", "spawn", "release"
     */
    private handleRustParsedCommand;
    /**
     * Handle spawn command (from Rust stderr JSON parsing)
     *
     * Note: We do NOT send the initial task message here because the spawner
     * now handles it after waitUntilCliReady(). Sending it here would cause
     * duplicate task delivery.
     */
    private handleSpawnCommand;
    /**
     * Handle release command
     */
    private handleReleaseCommand;
    /**
     * Spawn agent via dashboard API
     */
    private spawnViaDashboardApi;
    /**
     * Release agent via dashboard API
     */
    private releaseViaDashboardApi;
    /**
     * Connect to the relay-pty socket
     */
    private connectToSocket;
    /**
     * Attempt a single socket connection
     */
    private attemptSocketConnection;
    /**
     * Disconnect from socket
     */
    private disconnectSocket;
    /**
     * Send a request to the socket and optionally wait for response
     */
    private sendSocketRequest;
    /**
     * Handle a response from the socket
     */
    private handleSocketResponse;
    /**
     * Handle injection result response
     * After Rust reports 'delivered', verifies the message appeared in output.
     * If verification fails, retries up to MAX_RETRIES times.
     */
    private handleInjectResult;
    /**
     * Handle backpressure notification
     */
    private handleBackpressure;
    /**
     * Inject a message into the agent via socket
     */
    private injectMessage;
    /**
     * Process queued messages
     */
    private processMessageQueue;
    /**
     * Override handleIncomingMessage to trigger queue processing
     */
    protected handleIncomingMessage(from: string, payload: SendPayload, messageId: string, meta?: SendMeta, originalTo?: string): void;
    /**
     * Start the queue monitor to periodically check for stuck messages.
     * This ensures messages don't get orphaned in the queue when the agent is idle.
     */
    private startQueueMonitor;
    /**
     * Stop the queue monitor.
     */
    private stopQueueMonitor;
    /**
     * Start watching for protocol issues in the outbox directory.
     * Detects common mistakes like:
     * - Empty AGENT_RELAY_NAME causing files at /tmp/relay-outbox//
     * - Files created directly in /tmp/relay-outbox/ instead of agent subdirectory
     */
    private startProtocolMonitor;
    /**
     * Stop the protocol monitor.
     */
    private stopProtocolMonitor;
    /**
     * Scan for existing protocol issues (called once at startup).
     */
    private scanForProtocolIssues;
    /**
     * Handle a detected protocol issue by injecting a helpful reminder.
     */
    private handleProtocolIssue;
    /**
     * Inject a protocol reminder message to the agent.
     */
    private injectProtocolReminder;
    /**
     * Start sending periodic protocol reminders.
     * Agents in long sessions sometimes forget the relay protocol - these
     * reminders help them stay on track without user intervention.
     */
    private startPeriodicReminder;
    /**
     * Stop periodic protocol reminders.
     */
    private stopPeriodicReminder;
    /**
     * Send a periodic protocol reminder to the agent.
     * This reminds agents about proper relay communication format after long sessions.
     */
    private sendPeriodicProtocolReminder;
    /**
     * Check for messages stuck in the queue and process them if the agent is idle.
     *
     * This handles cases where:
     * 1. Messages arrived while the agent was busy and the retry mechanism failed
     * 2. Socket disconnection/reconnection left messages orphaned
     * 3. Injection timeouts occurred without proper queue resumption
     */
    private checkForStuckQueue;
    /**
     * Parse relay commands from output
     */
    private parseRelayCommands;
    /**
     * Parse fenced multi-line messages
     */
    private parseFencedMessages;
    /**
     * Parse single-line messages
     */
    private parseSingleLineMessages;
    /**
     * Check for [[SUMMARY]] blocks
     */
    private checkForSummary;
    /**
     * Check for [[SESSION_END]] blocks
     */
    private checkForSessionEnd;
    /**
     * Query status from relay-pty
     */
    queryStatus(): Promise<StatusResponse | null>;
    /**
     * Wait for the CLI to be ready to receive messages.
     * This waits for:
     * 1. The CLI to produce at least one output (it has started)
     * 2. The CLI to become idle (it's ready for input)
     *
     * This is more reliable than a random sleep because it waits for
     * actual signals from the CLI rather than guessing how long it takes to start.
     *
     * @param timeoutMs Maximum time to wait (default: 30s)
     * @param pollMs Polling interval (default: 100ms)
     * @returns true if CLI is ready, false if timeout
     */
    waitUntilCliReady(timeoutMs?: number, pollMs?: number): Promise<boolean>;
    /**
     * Check if the CLI has produced any output yet.
     * Useful for checking if the CLI has started without blocking.
     */
    hasCliStarted(): boolean;
    /**
     * Get raw output buffer
     */
    getRawOutput(): string;
    /**
     * Check if backpressure is active
     */
    isBackpressureActive(): boolean;
    /**
     * Get the socket path
     */
    getSocketPath(): string;
    /**
     * Get the relay-pty process PID
     */
    get pid(): number | undefined;
    /**
     * Get the log file path (not used by relay-pty, returns undefined)
     */
    get logPath(): string | undefined;
    /**
     * Kill the process forcefully
     */
    kill(): Promise<void>;
    /**
     * Get output lines (for compatibility with PtyWrapper)
     * @param limit Maximum number of lines to return
     */
    getOutput(limit?: number): string[];
    /**
     * Write data directly to the process stdin
     * @param data Data to write
     */
    write(data: string | Buffer): Promise<void>;
    /**
     * Get the agent ID (from continuity if available)
     */
    getAgentId(): string | undefined;
}
export {};
//# sourceMappingURL=relay-pty-orchestrator.d.ts.map