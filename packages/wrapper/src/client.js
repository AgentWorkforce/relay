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
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { generateId } from './id-generator.js';
// Import types from SDK (re-exported via protocol for compatibility)
import { PROTOCOL_VERSION, } from '@relay/protocol/types';
import { encodeFrameLegacy, FrameParser } from '@relay/protocol/framing';
import { DEFAULT_SOCKET_PATH } from '@relay/config/relay-config';
const DEFAULT_CLIENT_CONFIG = {
    socketPath: DEFAULT_SOCKET_PATH,
    agentName: 'agent',
    cli: undefined,
    quiet: false,
    reconnect: true,
    maxReconnectAttempts: 10,
    reconnectDelayMs: 100,
    reconnectMaxDelayMs: 30000,
};
/**
 * Circular buffer for O(1) deduplication with bounded memory.
 */
class CircularDedupeCache {
    ids = new Set();
    ring;
    head = 0;
    capacity;
    constructor(capacity = 2000) {
        this.capacity = capacity;
        this.ring = new Array(capacity);
    }
    /** Returns true if duplicate (already seen) */
    check(id) {
        if (this.ids.has(id))
            return true;
        // Evict oldest if at capacity
        if (this.ids.size >= this.capacity) {
            const oldest = this.ring[this.head];
            if (oldest)
                this.ids.delete(oldest);
        }
        // Add new ID
        this.ring[this.head] = id;
        this.ids.add(id);
        this.head = (this.head + 1) % this.capacity;
        return false;
    }
    clear() {
        this.ids.clear();
        this.ring = new Array(this.capacity);
        this.head = 0;
    }
}
export class RelayClient {
    config;
    socket;
    parser;
    _state = 'DISCONNECTED';
    sessionId;
    resumeToken;
    reconnectAttempts = 0;
    reconnectDelay;
    reconnectTimer;
    _destroyed = false;
    // Circular dedup cache (O(1) eviction vs O(n) array shift)
    dedupeCache = new CircularDedupeCache(2000);
    // Write coalescing: batch multiple writes into single syscall
    writeQueue = [];
    writeScheduled = false;
    pendingSyncAcks = new Map();
    // Event handlers
    /**
     * Handler for incoming messages.
     * @param from - The sender agent name
     * @param payload - The message payload
     * @param messageId - Unique message ID
     * @param meta - Optional message metadata
     * @param originalTo - Original 'to' field from sender (e.g., '*' for broadcasts)
     */
    onMessage;
    /**
     * Callback for channel messages.
     * @param from - Sender name
     * @param channel - Channel name
     * @param body - Message content
     * @param envelope - Full envelope for additional data
     */
    onChannelMessage;
    onStateChange;
    onError;
    constructor(config = {}) {
        this.config = { ...DEFAULT_CLIENT_CONFIG, ...config };
        this.parser = new FrameParser();
        this.parser.setLegacyMode(true); // Use 4-byte header for backwards compatibility
        this.reconnectDelay = this.config.reconnectDelayMs;
    }
    get state() {
        return this._state;
    }
    get agentName() {
        return this.config.agentName;
    }
    /** Get the session ID assigned by the server */
    get currentSessionId() {
        return this.sessionId;
    }
    /**
     * Connect to the relay daemon.
     */
    connect() {
        if (this._state !== 'DISCONNECTED' && this._state !== 'BACKOFF') {
            return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
            let settled = false;
            const settleResolve = () => {
                if (settled)
                    return;
                settled = true;
                resolve();
            };
            const settleReject = (err) => {
                if (settled)
                    return;
                settled = true;
                reject(err);
            };
            this.setState('CONNECTING');
            this.socket = net.createConnection(this.config.socketPath, () => {
                this.setState('HANDSHAKING');
                this.sendHello();
            });
            this.socket.on('data', (data) => this.handleData(data));
            this.socket.on('close', () => {
                this.handleDisconnect();
            });
            this.socket.on('error', (err) => {
                if (this._state === 'CONNECTING') {
                    settleReject(err);
                }
                this.handleError(err);
            });
            // Wait for WELCOME
            const checkReady = setInterval(() => {
                if (this._state === 'READY') {
                    clearInterval(checkReady);
                    clearTimeout(timeout);
                    settleResolve();
                }
            }, 10);
            // Timeout
            const timeout = setTimeout(() => {
                if (this._state !== 'READY') {
                    clearInterval(checkReady);
                    this.socket?.destroy();
                    settleReject(new Error('Connection timeout'));
                }
            }, 5000);
        });
    }
    /**
     * Disconnect from the relay daemon.
     */
    disconnect() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }
        if (this.socket) {
            this.send({
                v: PROTOCOL_VERSION,
                type: 'BYE',
                id: generateId(),
                ts: Date.now(),
                payload: {},
            });
            this.socket.end();
            this.socket = undefined;
        }
        this.setState('DISCONNECTED');
    }
    /**
     * Permanently destroy the client. Disconnects and prevents any reconnection.
     */
    destroy() {
        this._destroyed = true;
        this.disconnect();
    }
    /**
     * Send a message to another agent.
     * @param to - Target agent name or '*' for broadcast
     * @param body - Message body
     * @param kind - Message type (default: 'message')
     * @param data - Optional structured data
     * @param thread - Optional thread ID for grouping related messages
     * @param meta - Optional message metadata (importance, replyTo, etc.)
     */
    sendMessage(to, body, kind = 'message', data, thread, meta) {
        if (this._state !== 'READY') {
            return false;
        }
        const envelope = {
            v: PROTOCOL_VERSION,
            type: 'SEND',
            id: generateId(),
            ts: Date.now(),
            to,
            payload: {
                kind,
                body,
                data,
                thread,
            },
            payload_meta: meta,
        };
        return this.send(envelope);
    }
    /**
     * Send an ACK for a delivered message.
     */
    sendAck(payload) {
        if (this._state !== 'READY') {
            return false;
        }
        const envelope = {
            v: PROTOCOL_VERSION,
            type: 'ACK',
            id: generateId(),
            ts: Date.now(),
            payload,
        };
        return this.send(envelope);
    }
    /**
     * Send a message and wait for a correlated ACK response.
     */
    async sendAndWait(to, body, options = {}) {
        if (this._state !== 'READY') {
            throw new Error('Client not ready');
        }
        const correlationId = randomUUID();
        const timeoutMs = options.timeoutMs ?? 30000;
        const kind = options.kind ?? 'message';
        return new Promise((resolve, reject) => {
            const timeoutHandle = setTimeout(() => {
                this.pendingSyncAcks.delete(correlationId);
                reject(new Error(`ACK timeout after ${timeoutMs}ms`));
            }, timeoutMs);
            this.pendingSyncAcks.set(correlationId, { resolve, reject, timeoutHandle });
            const envelope = {
                v: PROTOCOL_VERSION,
                type: 'SEND',
                id: generateId(),
                ts: Date.now(),
                to,
                payload: {
                    kind,
                    body,
                    data: options.data,
                    thread: options.thread,
                },
                payload_meta: {
                    sync: {
                        correlationId,
                        timeoutMs,
                        blocking: true,
                    },
                },
            };
            const sent = this.send(envelope);
            if (!sent) {
                clearTimeout(timeoutHandle);
                this.pendingSyncAcks.delete(correlationId);
                reject(new Error('Failed to send message'));
            }
        });
    }
    /**
     * Broadcast a message to all agents.
     */
    broadcast(body, kind = 'message', data) {
        return this.sendMessage('*', body, kind, data);
    }
    // =============================================================================
    // Channel Operations
    // =============================================================================
    /**
     * Join a channel.
     * @param channel - Channel name (e.g., '#general', 'dm:alice:bob')
     * @param displayName - Optional display name for this member
     */
    joinChannel(channel, displayName) {
        if (this._state !== 'READY') {
            return false;
        }
        const envelope = {
            v: PROTOCOL_VERSION,
            type: 'CHANNEL_JOIN',
            id: generateId(),
            ts: Date.now(),
            payload: {
                channel,
                displayName,
            },
        };
        return this.send(envelope);
    }
    /**
     * Admin join: Add any member to a channel (does not require member to be connected).
     * Used by dashboard to sync channel memberships for agents.
     * @param channel - Channel name (e.g., '#general')
     * @param member - Name of the member to add
     */
    adminJoinChannel(channel, member) {
        if (this._state !== 'READY') {
            return false;
        }
        const envelope = {
            v: PROTOCOL_VERSION,
            type: 'CHANNEL_JOIN',
            id: generateId(),
            ts: Date.now(),
            payload: {
                channel,
                member, // Admin mode: specify member to add
            },
        };
        return this.send(envelope);
    }
    /**
     * Leave a channel.
     * @param channel - Channel name to leave
     * @param reason - Optional reason for leaving
     */
    leaveChannel(channel, reason) {
        if (this._state !== 'READY')
            return false;
        const envelope = {
            v: PROTOCOL_VERSION,
            type: 'CHANNEL_LEAVE',
            id: generateId(),
            ts: Date.now(),
            payload: {
                channel,
                reason,
            },
        };
        return this.send(envelope);
    }
    /**
     * Admin remove: Remove any member from a channel (does not require member to be connected).
     * Used by dashboard to remove channel members.
     * @param channel - Channel name (e.g., '#general')
     * @param member - Name of the member to remove
     */
    adminRemoveMember(channel, member) {
        if (this._state !== 'READY') {
            return false;
        }
        const envelope = {
            v: PROTOCOL_VERSION,
            type: 'CHANNEL_LEAVE',
            id: generateId(),
            ts: Date.now(),
            payload: {
                channel,
                member, // Admin mode: specify member to remove
            },
        };
        return this.send(envelope);
    }
    /**
     * Send a message to a channel.
     * @param channel - Channel name
     * @param body - Message content
     * @param options - Optional thread, mentions, attachments
     */
    sendChannelMessage(channel, body, options) {
        if (this._state !== 'READY') {
            return false;
        }
        const envelope = {
            v: PROTOCOL_VERSION,
            type: 'CHANNEL_MESSAGE',
            id: generateId(),
            ts: Date.now(),
            payload: {
                channel,
                body,
                thread: options?.thread,
                mentions: options?.mentions,
                attachments: options?.attachments,
                data: options?.data,
            },
        };
        return this.send(envelope);
    }
    /**
     * Subscribe to a topic.
     */
    subscribe(topic) {
        if (this._state !== 'READY')
            return false;
        return this.send({
            v: PROTOCOL_VERSION,
            type: 'SUBSCRIBE',
            id: generateId(),
            ts: Date.now(),
            topic,
            payload: {},
        });
    }
    /**
     * Unsubscribe from a topic.
     */
    unsubscribe(topic) {
        if (this._state !== 'READY')
            return false;
        return this.send({
            v: PROTOCOL_VERSION,
            type: 'UNSUBSCRIBE',
            id: generateId(),
            ts: Date.now(),
            topic,
            payload: {},
        });
    }
    /**
     * Bind this agent as a shadow to a primary agent.
     * As a shadow, this agent will receive copies of messages to/from the primary.
     * @param primaryAgent - The agent to shadow
     * @param options - Shadow configuration options
     */
    bindAsShadow(primaryAgent, options = {}) {
        if (this._state !== 'READY')
            return false;
        return this.send({
            v: PROTOCOL_VERSION,
            type: 'SHADOW_BIND',
            id: generateId(),
            ts: Date.now(),
            payload: {
                primaryAgent,
                speakOn: options.speakOn,
                receiveIncoming: options.receiveIncoming,
                receiveOutgoing: options.receiveOutgoing,
            },
        });
    }
    /**
     * Unbind this agent from a primary agent (stop shadowing).
     * @param primaryAgent - The agent to stop shadowing
     */
    unbindAsShadow(primaryAgent) {
        if (this._state !== 'READY')
            return false;
        return this.send({
            v: PROTOCOL_VERSION,
            type: 'SHADOW_UNBIND',
            id: generateId(),
            ts: Date.now(),
            payload: {
                primaryAgent,
            },
        });
    }
    /**
     * Send log/output data to the daemon for dashboard streaming.
     * Used by daemon-connected agents (not spawned workers) to stream their output.
     * @param data - The log/output data to send
     * @returns true if sent successfully, false otherwise
     */
    sendLog(data) {
        if (this._state !== 'READY') {
            return false;
        }
        const envelope = {
            v: PROTOCOL_VERSION,
            type: 'LOG',
            id: generateId(),
            ts: Date.now(),
            payload: {
                data,
                timestamp: Date.now(),
            },
        };
        return this.send(envelope);
    }
    setState(state) {
        this._state = state;
        if (this.onStateChange) {
            this.onStateChange(state);
        }
    }
    sendHello() {
        const hello = {
            v: PROTOCOL_VERSION,
            type: 'HELLO',
            id: generateId(),
            ts: Date.now(),
            payload: {
                agent: this.config.agentName,
                entityType: this.config.entityType,
                cli: this.config.cli,
                program: this.config.program,
                model: this.config.model,
                task: this.config.task,
                workingDirectory: this.config.workingDirectory,
                displayName: this.config.displayName,
                avatarUrl: this.config.avatarUrl,
                capabilities: {
                    ack: true,
                    resume: true,
                    max_inflight: 256,
                    supports_topics: true,
                },
                session: this.resumeToken ? { resume_token: this.resumeToken } : undefined,
            },
        };
        this.send(hello);
    }
    send(envelope) {
        if (!this.socket)
            return false;
        try {
            const frame = encodeFrameLegacy(envelope);
            this.writeQueue.push(frame);
            // Coalesce writes: schedule flush on next tick if not already scheduled
            if (!this.writeScheduled) {
                this.writeScheduled = true;
                setImmediate(() => this.flushWrites());
            }
            return true;
        }
        catch (err) {
            this.handleError(err);
            return false;
        }
    }
    /**
     * Flush all queued writes in a single syscall.
     */
    flushWrites() {
        this.writeScheduled = false;
        if (this.writeQueue.length === 0 || !this.socket)
            return;
        if (this.writeQueue.length === 1) {
            // Single frame - write directly (no concat needed)
            this.socket.write(this.writeQueue[0]);
        }
        else {
            // Multiple frames - batch into single write
            this.socket.write(Buffer.concat(this.writeQueue));
        }
        this.writeQueue = [];
    }
    handleData(data) {
        try {
            const frames = this.parser.push(data);
            for (const frame of frames) {
                this.processFrame(frame);
            }
        }
        catch (err) {
            this.handleError(err);
        }
    }
    processFrame(envelope) {
        switch (envelope.type) {
            case 'WELCOME':
                this.handleWelcome(envelope);
                break;
            case 'DELIVER':
                this.handleDeliver(envelope);
                break;
            case 'CHANNEL_MESSAGE':
                this.handleChannelMessage(envelope);
                break;
            case 'PING':
                this.handlePing(envelope);
                break;
            case 'ACK':
                this.handleAck(envelope);
                break;
            case 'ERROR':
                this.handleErrorFrame(envelope);
                break;
            case 'BUSY':
                console.warn('[client] Server busy, backing off');
                break;
        }
    }
    handleWelcome(envelope) {
        this.sessionId = envelope.payload.session_id;
        this.resumeToken = envelope.payload.resume_token;
        this.reconnectAttempts = 0;
        this.reconnectDelay = this.config.reconnectDelayMs;
        this.setState('READY');
        if (!this.config.quiet) {
            console.log(`[client] Connected as ${this.config.agentName} (session: ${this.sessionId})`);
        }
    }
    handleDeliver(envelope) {
        console.log(`[relay-client:${this.config.agentName}] Received DELIVER from ${envelope.from}: "${envelope.payload.body?.substring(0, 40)}..."`);
        // Send ACK
        this.send({
            v: PROTOCOL_VERSION,
            type: 'ACK',
            id: generateId(),
            ts: Date.now(),
            payload: {
                ack_id: envelope.id,
                seq: envelope.delivery.seq,
            },
        });
        const duplicate = this.markDelivered(envelope.id);
        if (duplicate) {
            console.log(`[relay-client:${this.config.agentName}] Duplicate delivery, skipping`);
            return;
        }
        // Notify handler
        // Pass originalTo from delivery info so handlers know if this was a broadcast
        if (this.onMessage && envelope.from) {
            this.onMessage(envelope.from, envelope.payload, envelope.id, envelope.payload_meta, envelope.delivery.originalTo);
        }
        else {
            console.log(`[relay-client:${this.config.agentName}] No onMessage handler or no from field`);
        }
    }
    handleAck(envelope) {
        const correlationId = envelope.payload.correlationId;
        if (!correlationId)
            return;
        const pending = this.pendingSyncAcks.get(correlationId);
        if (!pending)
            return;
        clearTimeout(pending.timeoutHandle);
        this.pendingSyncAcks.delete(correlationId);
        pending.resolve(envelope.payload);
    }
    handleChannelMessage(envelope) {
        if (!this.config.quiet) {
            console.log(`[client] handleChannelMessage: from=${envelope.from}, channel=${envelope.payload.channel}`);
        }
        const duplicate = this.markDelivered(envelope.id);
        if (duplicate) {
            if (!this.config.quiet) {
                console.log(`[client] handleChannelMessage: duplicate message ${envelope.id}, skipping`);
            }
            return;
        }
        // Notify channel message handler
        if (this.onChannelMessage && envelope.from) {
            if (!this.config.quiet) {
                console.log(`[client] Calling onChannelMessage callback`);
            }
            this.onChannelMessage(envelope.from, envelope.payload.channel, envelope.payload.body, envelope);
        }
        else if (!this.config.quiet) {
            console.log(`[client] No onChannelMessage handler set (handler=${!!this.onChannelMessage}, from=${envelope.from})`);
        }
        // Also call onMessage for backwards compatibility
        // Convert to SendPayload format (channel is passed as 5th argument, not in payload)
        if (this.onMessage && envelope.from) {
            const sendPayload = {
                kind: 'message',
                body: envelope.payload.body,
                data: {
                    _isChannelMessage: true,
                    _channel: envelope.payload.channel,
                    _mentions: envelope.payload.mentions,
                },
                thread: envelope.payload.thread,
            };
            this.onMessage(envelope.from, sendPayload, envelope.id, undefined, envelope.payload.channel);
        }
    }
    handlePing(envelope) {
        this.send({
            v: PROTOCOL_VERSION,
            type: 'PONG',
            id: generateId(),
            ts: Date.now(),
            payload: envelope.payload ?? {},
        });
    }
    handleErrorFrame(envelope) {
        console.error('[client] Server error:', envelope.payload);
        if (envelope.payload.code === 'RESUME_TOO_OLD') {
            if (this.resumeToken) {
                console.warn('[client] Resume token rejected, clearing and requesting new session');
            }
            // Clear resume token so next HELLO starts a fresh session instead of looping on an invalid token
            this.resumeToken = undefined;
            this.sessionId = undefined;
        }
    }
    handleDisconnect() {
        this.parser.reset();
        this.socket = undefined;
        this.rejectPendingSyncAcks(new Error('Disconnected while awaiting ACK'));
        // Don't reconnect if permanently destroyed
        if (this._destroyed) {
            this.setState('DISCONNECTED');
            return;
        }
        if (this.config.reconnect && this.reconnectAttempts < this.config.maxReconnectAttempts) {
            this.scheduleReconnect();
        }
        else {
            this.setState('DISCONNECTED');
            if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
                console.error(`[client] Max reconnect attempts reached (${this.config.maxReconnectAttempts}), giving up`);
            }
        }
    }
    handleError(error) {
        console.error('[client] Error:', error.message);
        if (this.onError) {
            this.onError(error);
        }
    }
    rejectPendingSyncAcks(error) {
        for (const [correlationId, pending] of this.pendingSyncAcks.entries()) {
            clearTimeout(pending.timeoutHandle);
            pending.reject(error);
            this.pendingSyncAcks.delete(correlationId);
        }
    }
    scheduleReconnect() {
        this.setState('BACKOFF');
        this.reconnectAttempts++;
        // Exponential backoff with jitter
        const jitter = Math.random() * 0.3 + 0.85; // 0.85 - 1.15
        const delay = Math.min(this.reconnectDelay * jitter, this.config.reconnectMaxDelayMs);
        this.reconnectDelay *= 2;
        if (!this.config.quiet) {
            console.log(`[client] Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts})`);
        }
        this.reconnectTimer = setTimeout(() => {
            this.connect().catch(() => {
                // Will trigger another reconnect
            });
        }, delay);
    }
    /**
     * Check if message was already delivered (deduplication).
     * Uses circular buffer for O(1) eviction.
     * @returns true if the message has already been seen.
     */
    markDelivered(id) {
        return this.dedupeCache.check(id);
    }
}
//# sourceMappingURL=client.js.map