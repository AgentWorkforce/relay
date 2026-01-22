/**
 * Relay Client
 * Connects to the daemon and handles message sending/receiving.
 *
 * @deprecated For external use, import from '@agent-relay/sdk' instead.
 * This module is for internal daemon integration.
 *
 * @example
 * // External consumers should use:
 * import { RelayClient } from '@agent-relay/sdk';
 *
 * // Internal daemon code uses this module directly.
 *
 * Optimizations:
 * - Monotonic ID generation (faster than UUID)
 * - Write coalescing (batch socket writes)
 * - Circular dedup cache (O(1) eviction)
 */
import { type Envelope, type SendPayload, type SendMeta, type AckPayload, type PayloadKind, type SpeakOnTrigger, type EntityType } from '@relay/protocol/types';
import type { ChannelMessagePayload, MessageAttachment } from '@relay/protocol/channels';
export type ClientState = 'DISCONNECTED' | 'CONNECTING' | 'HANDSHAKING' | 'READY' | 'BACKOFF';
export interface SyncOptions {
    timeoutMs?: number;
    kind?: PayloadKind;
    data?: Record<string, unknown>;
    thread?: string;
}
export interface ClientConfig {
    socketPath: string;
    agentName: string;
    /** Entity type: 'agent' (default) or 'user' for human users */
    entityType?: EntityType;
    /** Optional CLI identifier to surface to the dashboard */
    cli?: string;
    /** Optional program identifier (e.g., 'claude', 'gpt-4o') */
    program?: string;
    /** Optional model identifier (e.g., 'claude-3-opus-2024-xx') */
    model?: string;
    /** Optional task description for registry/dashboard */
    task?: string;
    /** Optional working directory to surface in registry/dashboard */
    workingDirectory?: string;
    /** Display name for human users */
    displayName?: string;
    /** Avatar URL for human users */
    avatarUrl?: string;
    /** Suppress client-side console logging */
    quiet?: boolean;
    reconnect: boolean;
    maxReconnectAttempts: number;
    reconnectDelayMs: number;
    reconnectMaxDelayMs: number;
}
export declare class RelayClient {
    private config;
    private socket?;
    private parser;
    private _state;
    private sessionId?;
    private resumeToken?;
    private reconnectAttempts;
    private reconnectDelay;
    private reconnectTimer?;
    private _destroyed;
    private dedupeCache;
    private writeQueue;
    private writeScheduled;
    private pendingSyncAcks;
    /**
     * Handler for incoming messages.
     * @param from - The sender agent name
     * @param payload - The message payload
     * @param messageId - Unique message ID
     * @param meta - Optional message metadata
     * @param originalTo - Original 'to' field from sender (e.g., '*' for broadcasts)
     */
    onMessage?: (from: string, payload: SendPayload, messageId: string, meta?: SendMeta, originalTo?: string) => void;
    /**
     * Callback for channel messages.
     * @param from - Sender name
     * @param channel - Channel name
     * @param body - Message content
     * @param envelope - Full envelope for additional data
     */
    onChannelMessage?: (from: string, channel: string, body: string, envelope: Envelope<ChannelMessagePayload>) => void;
    onStateChange?: (state: ClientState) => void;
    onError?: (error: Error) => void;
    constructor(config?: Partial<ClientConfig>);
    get state(): ClientState;
    get agentName(): string;
    /** Get the session ID assigned by the server */
    get currentSessionId(): string | undefined;
    /**
     * Connect to the relay daemon.
     */
    connect(): Promise<void>;
    /**
     * Disconnect from the relay daemon.
     */
    disconnect(): void;
    /**
     * Permanently destroy the client. Disconnects and prevents any reconnection.
     */
    destroy(): void;
    /**
     * Send a message to another agent.
     * @param to - Target agent name or '*' for broadcast
     * @param body - Message body
     * @param kind - Message type (default: 'message')
     * @param data - Optional structured data
     * @param thread - Optional thread ID for grouping related messages
     * @param meta - Optional message metadata (importance, replyTo, etc.)
     */
    sendMessage(to: string, body: string, kind?: PayloadKind, data?: Record<string, unknown>, thread?: string, meta?: SendMeta): boolean;
    /**
     * Send an ACK for a delivered message.
     */
    sendAck(payload: AckPayload): boolean;
    /**
     * Send a message and wait for a correlated ACK response.
     */
    sendAndWait(to: string, body: string, options?: SyncOptions): Promise<AckPayload>;
    /**
     * Broadcast a message to all agents.
     */
    broadcast(body: string, kind?: PayloadKind, data?: Record<string, unknown>): boolean;
    /**
     * Join a channel.
     * @param channel - Channel name (e.g., '#general', 'dm:alice:bob')
     * @param displayName - Optional display name for this member
     */
    joinChannel(channel: string, displayName?: string): boolean;
    /**
     * Admin join: Add any member to a channel (does not require member to be connected).
     * Used by dashboard to sync channel memberships for agents.
     * @param channel - Channel name (e.g., '#general')
     * @param member - Name of the member to add
     */
    adminJoinChannel(channel: string, member: string): boolean;
    /**
     * Leave a channel.
     * @param channel - Channel name to leave
     * @param reason - Optional reason for leaving
     */
    leaveChannel(channel: string, reason?: string): boolean;
    /**
     * Admin remove: Remove any member from a channel (does not require member to be connected).
     * Used by dashboard to remove channel members.
     * @param channel - Channel name (e.g., '#general')
     * @param member - Name of the member to remove
     */
    adminRemoveMember(channel: string, member: string): boolean;
    /**
     * Send a message to a channel.
     * @param channel - Channel name
     * @param body - Message content
     * @param options - Optional thread, mentions, attachments
     */
    sendChannelMessage(channel: string, body: string, options?: {
        thread?: string;
        mentions?: string[];
        attachments?: MessageAttachment[];
        data?: Record<string, unknown>;
    }): boolean;
    /**
     * Subscribe to a topic.
     */
    subscribe(topic: string): boolean;
    /**
     * Unsubscribe from a topic.
     */
    unsubscribe(topic: string): boolean;
    /**
     * Bind this agent as a shadow to a primary agent.
     * As a shadow, this agent will receive copies of messages to/from the primary.
     * @param primaryAgent - The agent to shadow
     * @param options - Shadow configuration options
     */
    bindAsShadow(primaryAgent: string, options?: {
        /** When this shadow should speak (default: ['EXPLICIT_ASK']) */
        speakOn?: SpeakOnTrigger[];
        /** Receive copies of messages TO the primary (default: true) */
        receiveIncoming?: boolean;
        /** Receive copies of messages FROM the primary (default: true) */
        receiveOutgoing?: boolean;
    }): boolean;
    /**
     * Unbind this agent from a primary agent (stop shadowing).
     * @param primaryAgent - The agent to stop shadowing
     */
    unbindAsShadow(primaryAgent: string): boolean;
    /**
     * Send log/output data to the daemon for dashboard streaming.
     * Used by daemon-connected agents (not spawned workers) to stream their output.
     * @param data - The log/output data to send
     * @returns true if sent successfully, false otherwise
     */
    sendLog(data: string): boolean;
    private setState;
    private sendHello;
    private send;
    /**
     * Flush all queued writes in a single syscall.
     */
    private flushWrites;
    private handleData;
    private processFrame;
    private handleWelcome;
    private handleDeliver;
    private handleAck;
    private handleChannelMessage;
    private handlePing;
    private handleErrorFrame;
    private handleDisconnect;
    private handleError;
    private rejectPendingSyncAcks;
    private scheduleReconnect;
    /**
     * Check if message was already delivered (deduplication).
     * Uses circular buffer for O(1) eviction.
     * @returns true if the message has already been seen.
     */
    private markDelivered;
}
//# sourceMappingURL=client.d.ts.map