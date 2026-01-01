/**
 * Message router for the agent relay daemon.
 * Handles routing messages between agents, topic subscriptions, and broadcast.
 */

import { v4 as uuid } from 'uuid';
import {
  type Envelope,
  type SendEnvelope,
  type DeliverEnvelope,
  type AckPayload,
  type ShadowConfig,
  type SpeakOnTrigger,
  PROTOCOL_VERSION,
} from '../protocol/types.js';
import type { StorageAdapter } from '../storage/adapter.js';
import type { AgentRegistry } from './agent-registry.js';

export interface RoutableConnection {
  id: string;
  agentName?: string;
  cli?: string;
  program?: string;
  model?: string;
  task?: string;
  workingDirectory?: string;
  sessionId: string;
  close(): void;
  send(envelope: Envelope): boolean;
  getNextSeq(topic: string, peer: string): number;
}

export interface RemoteAgentInfo {
  name: string;
  status: string;
  daemonId: string;
  daemonName: string;
  machineId: string;
}

export interface CrossMachineHandler {
  sendCrossMachineMessage(
    targetDaemonId: string,
    targetAgent: string,
    fromAgent: string,
    content: string,
    metadata?: Record<string, unknown>
  ): Promise<boolean>;
  isRemoteAgent(agentName: string): RemoteAgentInfo | undefined;
}

export interface DeliveryReliabilityOptions {
  /** How long to wait for an ACK before retrying (ms) */
  ackTimeoutMs: number;
  /** Maximum attempts (initial send counts as attempt 1) */
  maxAttempts: number;
  /** How long to keep retrying before dropping (ms) */
  deliveryTtlMs: number;
}

const DEFAULT_DELIVERY_OPTIONS: DeliveryReliabilityOptions = {
  ackTimeoutMs: 5000,
  maxAttempts: 5,
  deliveryTtlMs: 60_000,
};

interface PendingDelivery {
  envelope: DeliverEnvelope;
  connectionId: string;
  attempts: number;
  firstSentAt: number;
  timer?: NodeJS.Timeout;
}

interface ProcessingState {
  startedAt: number;
  messageId: string;
  timer?: NodeJS.Timeout;
}

/** Internal shadow relationship with resolved defaults */
interface ShadowRelationship extends ShadowConfig {
  shadowAgent: string;
}

export class Router {
  private storage?: StorageAdapter;
  private connections: Map<string, RoutableConnection> = new Map(); // connectionId -> Connection
  private agents: Map<string, RoutableConnection> = new Map(); // agentName -> Connection
  private subscriptions: Map<string, Set<string>> = new Map(); // topic -> Set<agentName>
  private pendingDeliveries: Map<string, PendingDelivery> = new Map(); // deliverId -> pending
  private processingAgents: Map<string, ProcessingState> = new Map(); // agentName -> processing state
  private deliveryOptions: DeliveryReliabilityOptions;
  private registry?: AgentRegistry;
  private crossMachineHandler?: CrossMachineHandler;

  /** Shadow relationships: primaryAgent -> list of shadow configs */
  private shadowsByPrimary: Map<string, ShadowRelationship[]> = new Map();
  /** Reverse lookup: shadowAgent -> primaryAgent (for cleanup) */
  private primaryByShadow: Map<string, string> = new Map();

  /** Default timeout for processing indicator (30 seconds) */
  private static readonly PROCESSING_TIMEOUT_MS = 30_000;

  /** Callback when processing state changes (for real-time dashboard updates) */
  private onProcessingStateChange?: () => void;

  constructor(options: {
    storage?: StorageAdapter;
    delivery?: Partial<DeliveryReliabilityOptions>;
    registry?: AgentRegistry;
    onProcessingStateChange?: () => void;
    crossMachineHandler?: CrossMachineHandler;
  } = {}) {
    this.storage = options.storage;
    this.deliveryOptions = { ...DEFAULT_DELIVERY_OPTIONS, ...options.delivery };
    this.registry = options.registry;
    this.onProcessingStateChange = options.onProcessingStateChange;
    this.crossMachineHandler = options.crossMachineHandler;
  }

  /**
   * Set or update the cross-machine handler.
   */
  setCrossMachineHandler(handler: CrossMachineHandler): void {
    this.crossMachineHandler = handler;
  }

  /**
   * Register a connection after successful handshake.
   */
  register(connection: RoutableConnection): void {
    this.connections.set(connection.id, connection);

    if (connection.agentName) {
      // Handle existing connection with same name (disconnect old)
      const existing = this.agents.get(connection.agentName);
      if (existing && existing.id !== connection.id) {
        existing.close();
        this.connections.delete(existing.id);
      }
      this.agents.set(connection.agentName, connection);
      this.registry?.registerOrUpdate({
        name: connection.agentName,
        cli: connection.cli,
        program: connection.program,
        model: connection.model,
        task: connection.task,
        workingDirectory: connection.workingDirectory,
      });
    }
  }

  /**
   * Unregister a connection.
   */
  unregister(connection: RoutableConnection): void {
    this.connections.delete(connection.id);
    if (connection.agentName) {
      const current = this.agents.get(connection.agentName);
      if (current?.id === connection.id) {
        this.agents.delete(connection.agentName);
      }

      // Remove from all subscriptions
      for (const subscribers of this.subscriptions.values()) {
        subscribers.delete(connection.agentName);
      }

      // Clean up shadow relationships
      this.unbindShadow(connection.agentName);

      // Clear processing state
      this.clearProcessing(connection.agentName);
    }

    this.clearPendingForConnection(connection.id);
  }

  /**
   * Subscribe an agent to a topic.
   */
  subscribe(agentName: string, topic: string): void {
    let subscribers = this.subscriptions.get(topic);
    if (!subscribers) {
      subscribers = new Set();
      this.subscriptions.set(topic, subscribers);
    }
    subscribers.add(agentName);
  }

  /**
   * Unsubscribe an agent from a topic.
   */
  unsubscribe(agentName: string, topic: string): void {
    const subscribers = this.subscriptions.get(topic);
    if (subscribers) {
      subscribers.delete(agentName);
      if (subscribers.size === 0) {
        this.subscriptions.delete(topic);
      }
    }
  }

  /**
   * Bind a shadow agent to a primary agent.
   * The shadow will receive copies of messages to/from the primary.
   */
  bindShadow(
    shadowAgent: string,
    primaryAgent: string,
    options: {
      speakOn?: SpeakOnTrigger[];
      receiveIncoming?: boolean;
      receiveOutgoing?: boolean;
    } = {}
  ): void {
    // Clean up any existing shadow binding for this shadow
    this.unbindShadow(shadowAgent);

    const relationship: ShadowRelationship = {
      shadowAgent,
      primaryAgent,
      speakOn: options.speakOn ?? ['EXPLICIT_ASK'],
      receiveIncoming: options.receiveIncoming ?? true,
      receiveOutgoing: options.receiveOutgoing ?? true,
    };

    // Add to primary's shadow list
    let shadows = this.shadowsByPrimary.get(primaryAgent);
    if (!shadows) {
      shadows = [];
      this.shadowsByPrimary.set(primaryAgent, shadows);
    }
    shadows.push(relationship);

    // Set reverse lookup
    this.primaryByShadow.set(shadowAgent, primaryAgent);

    console.log(`[router] Shadow bound: ${shadowAgent} -> ${primaryAgent} (speakOn: ${relationship.speakOn.join(', ')})`);
  }

  /**
   * Unbind a shadow agent from its primary.
   */
  unbindShadow(shadowAgent: string): void {
    const primaryAgent = this.primaryByShadow.get(shadowAgent);
    if (!primaryAgent) return;

    // Remove from primary's shadow list
    const shadows = this.shadowsByPrimary.get(primaryAgent);
    if (shadows) {
      const updatedShadows = shadows.filter(s => s.shadowAgent !== shadowAgent);
      if (updatedShadows.length === 0) {
        this.shadowsByPrimary.delete(primaryAgent);
      } else {
        this.shadowsByPrimary.set(primaryAgent, updatedShadows);
      }
    }

    // Remove reverse lookup
    this.primaryByShadow.delete(shadowAgent);

    console.log(`[router] Shadow unbound: ${shadowAgent} from ${primaryAgent}`);
  }

  /**
   * Get all shadows for a primary agent.
   */
  getShadowsForPrimary(primaryAgent: string): ShadowRelationship[] {
    return this.shadowsByPrimary.get(primaryAgent) ?? [];
  }

  /**
   * Get the primary agent for a shadow, if any.
   */
  getPrimaryForShadow(shadowAgent: string): string | undefined {
    return this.primaryByShadow.get(shadowAgent);
  }

  /**
   * Emit a trigger event for an agent's shadows.
   * Shadows configured to speakOn this trigger will receive a notification.
   * @param primaryAgent The agent whose shadows should be notified
   * @param trigger The trigger event that occurred
   * @param context Optional context data about the trigger
   */
  emitShadowTrigger(
    primaryAgent: string,
    trigger: SpeakOnTrigger,
    context?: Record<string, unknown>
  ): void {
    const shadows = this.shadowsByPrimary.get(primaryAgent);
    if (!shadows || shadows.length === 0) return;

    for (const shadow of shadows) {
      // Check if this shadow is configured to speak on this trigger
      if (!shadow.speakOn.includes(trigger) && !shadow.speakOn.includes('ALL_MESSAGES')) {
        continue;
      }

      const target = this.agents.get(shadow.shadowAgent);
      if (!target) continue;

      // Create a trigger notification envelope
      const triggerEnvelope: SendEnvelope = {
        v: PROTOCOL_VERSION,
        type: 'SEND',
        id: uuid(),
        ts: Date.now(),
        from: primaryAgent,
        to: shadow.shadowAgent,
        payload: {
          kind: 'action',
          body: `SHADOW_TRIGGER:${trigger}`,
          data: {
            _shadowTrigger: trigger,
            _shadowOf: primaryAgent,
            _triggerContext: context,
          },
        },
      };

      const deliver = this.createDeliverEnvelope(
        primaryAgent,
        shadow.shadowAgent,
        triggerEnvelope,
        target
      );
      const sent = target.send(deliver);
      if (sent) {
        this.trackDelivery(target, deliver);
        console.log(`[router] Shadow trigger ${trigger} sent to ${shadow.shadowAgent} (primary: ${primaryAgent})`);
        // Set processing state for triggered shadows - they're expected to respond
        this.setProcessing(shadow.shadowAgent, deliver.id);
      }
    }
  }

  /**
   * Check if a shadow should speak based on a specific trigger.
   */
  shouldShadowSpeak(shadowAgent: string, trigger: SpeakOnTrigger): boolean {
    const primaryAgent = this.primaryByShadow.get(shadowAgent);
    if (!primaryAgent) return true; // Not a shadow, can always speak

    const shadows = this.shadowsByPrimary.get(primaryAgent);
    if (!shadows) return true;

    const relationship = shadows.find(s => s.shadowAgent === shadowAgent);
    if (!relationship) return true;

    return relationship.speakOn.includes(trigger) || relationship.speakOn.includes('ALL_MESSAGES');
  }

  /**
   * Route a SEND message to its destination(s).
   */
  route(from: RoutableConnection, envelope: SendEnvelope): void {
    const senderName = from.agentName;
    if (!senderName) {
      console.log(`[router] Dropping message - sender has no name`);
      return;
    }

    // Agent is responding - clear their processing state
    this.clearProcessing(senderName);

    this.registry?.recordSend(senderName);

    const to = envelope.to;
    const topic = envelope.topic;

    console.log(`[router] ${senderName} -> ${to}:${envelope.payload.body?.substring(0, 50)}...`);

    if (to === '*') {
      // Broadcast to all (except sender)
      this.broadcast(senderName, envelope, topic);
    } else if (to) {
      // Direct message
      this.sendDirect(senderName, to, envelope);
    }

    // Route copies to shadows of the sender (outgoing messages)
    this.routeToShadows(senderName, envelope, 'outgoing');

    // Route copies to shadows of the recipient (incoming messages)
    if (to && to !== '*') {
      this.routeToShadows(to, envelope, 'incoming', senderName);
    }
  }

  /**
   * Route a copy of a message to shadows of an agent.
   * @param primaryAgent The primary agent whose shadows should receive the message
   * @param envelope The original message envelope
   * @param direction Whether this is an 'incoming' or 'outgoing' message for the primary
   * @param actualFrom Override the 'from' field (for incoming messages, use original sender)
   */
  private routeToShadows(
    primaryAgent: string,
    envelope: SendEnvelope,
    direction: 'incoming' | 'outgoing',
    actualFrom?: string
  ): void {
    const shadows = this.shadowsByPrimary.get(primaryAgent);
    if (!shadows || shadows.length === 0) return;

    for (const shadow of shadows) {
      // Check if shadow wants this direction
      if (direction === 'incoming' && shadow.receiveIncoming === false) continue;
      if (direction === 'outgoing' && shadow.receiveOutgoing === false) continue;

      // Don't send to self
      if (shadow.shadowAgent === (actualFrom ?? primaryAgent)) continue;

      const target = this.agents.get(shadow.shadowAgent);
      if (!target) continue;

      // Create a shadow copy envelope with metadata indicating it's a shadow copy
      const shadowEnvelope: SendEnvelope = {
        ...envelope,
        payload: {
          ...envelope.payload,
          data: {
            ...envelope.payload.data,
            _shadowCopy: true,
            _shadowOf: primaryAgent,
            _shadowDirection: direction,
          },
        },
      };

      const deliver = this.createDeliverEnvelope(
        actualFrom ?? primaryAgent,
        shadow.shadowAgent,
        shadowEnvelope,
        target
      );
      const sent = target.send(deliver);
      if (sent) {
        this.trackDelivery(target, deliver);
        console.log(`[router] Shadow copy to ${shadow.shadowAgent} (${direction} from ${primaryAgent})`);
        // Note: Don't set processing state for shadow copies - shadow stays passive
      }
    }
  }

  /**
   * Send a direct message to a specific agent.
   */
  private sendDirect(
    from: string,
    to: string,
    envelope: SendEnvelope
  ): boolean {
    const target = this.agents.get(to);

    // If agent not found locally, check if it's on a remote machine
    if (!target) {
      const remoteAgent = this.crossMachineHandler?.isRemoteAgent(to);
      if (remoteAgent) {
        console.log(`[router] Routing to remote agent: ${to} on ${remoteAgent.daemonName}`);
        return this.sendToRemoteAgent(from, to, envelope, remoteAgent);
      }
      console.log(`[router] Target "${to}" not found. Available agents: ${Array.from(this.agents.keys()).join(', ')}`);
      return false;
    }

    const deliver = this.createDeliverEnvelope(from, to, envelope, target);
    const sent = target.send(deliver);
    console.log(`[router] Delivered to ${to}: ${sent ? 'success' : 'failed'}`);
    this.persistDeliverEnvelope(deliver);
    if (sent) {
      this.trackDelivery(target, deliver);
      this.registry?.recordReceive(to);
      // Mark recipient as processing
      this.setProcessing(to, deliver.id);
    }
    return sent;
  }

  /**
   * Send a message to an agent on a remote machine via cloud.
   */
  private sendToRemoteAgent(
    from: string,
    to: string,
    envelope: SendEnvelope,
    remoteAgent: RemoteAgentInfo
  ): boolean {
    if (!this.crossMachineHandler) {
      console.log(`[router] Cross-machine handler not available`);
      return false;
    }

    // Send asynchronously via cloud
    this.crossMachineHandler.sendCrossMachineMessage(
      remoteAgent.daemonId,
      to,
      from,
      envelope.payload.body,
      {
        topic: envelope.topic,
        thread: envelope.payload.thread,
        kind: envelope.payload.kind,
        data: envelope.payload.data,
        originalId: envelope.id,
      }
    ).then((sent) => {
      if (sent) {
        console.log(`[router] Cross-machine message sent to ${to} on ${remoteAgent.daemonName}`);
        // Persist as cross-machine message
        this.storage?.saveMessage({
          id: envelope.id || `cross-${Date.now()}`,
          ts: Date.now(),
          from,
          to,
          topic: envelope.topic,
          kind: envelope.payload.kind,
          body: envelope.payload.body,
          data: {
            ...envelope.payload.data,
            _crossMachine: true,
            _targetDaemon: remoteAgent.daemonId,
            _targetDaemonName: remoteAgent.daemonName,
          },
          thread: envelope.payload.thread,
          status: 'unread',
          is_urgent: false,
          is_broadcast: false,
        }).catch(err => console.error('[router] Failed to persist cross-machine message:', err));
      } else {
        console.error(`[router] Failed to send cross-machine message to ${to}`);
      }
    }).catch(err => {
      console.error(`[router] Cross-machine send error:`, err);
    });

    // Return true immediately - message is queued
    return true;
  }

  /**
   * Broadcast to all agents (optionally filtered by topic subscription).
   */
  private broadcast(
    from: string,
    envelope: SendEnvelope,
    topic?: string
  ): void {
    const recipients = topic
      ? this.subscriptions.get(topic) ?? new Set()
      : new Set(this.agents.keys());

    for (const agentName of recipients) {
      if (agentName === from) continue; // Don't send to self

      const target = this.agents.get(agentName);
      if (target) {
        const deliver = this.createDeliverEnvelope(from, agentName, envelope, target);
        const sent = target.send(deliver);
        this.persistDeliverEnvelope(deliver, true); // Mark as broadcast
        if (sent) {
          this.trackDelivery(target, deliver);
          this.registry?.recordReceive(agentName);
          // Mark recipient as processing
          this.setProcessing(agentName, deliver.id);
        }
      }
    }
  }

  /**
   * Create a DELIVER envelope from a SEND.
   */
  private createDeliverEnvelope(
    from: string,
    to: string,
    original: SendEnvelope,
    target: RoutableConnection
  ): DeliverEnvelope {
    return {
      v: PROTOCOL_VERSION,
      type: 'DELIVER',
      id: uuid(),
      ts: Date.now(),
      from,
      to,
      topic: original.topic,
      payload: original.payload,
      payload_meta: original.payload_meta,
      delivery: {
        seq: target.getNextSeq(original.topic ?? 'default', from),
        session_id: target.sessionId,
      },
    };
  }

  /**
   * Persist a delivered message if storage is configured.
   */
  private persistDeliverEnvelope(envelope: DeliverEnvelope, isBroadcast: boolean = false): void {
    if (!this.storage) return;

    this.storage.saveMessage({
      id: envelope.id,
      ts: envelope.ts,
      from: envelope.from ?? 'unknown',
      to: envelope.to ?? 'unknown',
      topic: envelope.topic,
      kind: envelope.payload.kind,
      body: envelope.payload.body,
      data: envelope.payload.data,
      payloadMeta: envelope.payload_meta,
      thread: envelope.payload.thread,
      deliverySeq: envelope.delivery.seq,
      deliverySessionId: envelope.delivery.session_id,
      sessionId: envelope.delivery.session_id,
      status: 'unread',
      is_urgent: false,
      is_broadcast: isBroadcast || envelope.to === '*',
    }).catch((err) => {
      console.error('[router] Failed to persist message', err);
    });
  }

  /**
   * Get list of connected agent names.
   */
  getAgents(): string[] {
    return Array.from(this.agents.keys());
  }

  /**
   * Get connection by agent name.
   */
  getConnection(agentName: string): RoutableConnection | undefined {
    return this.agents.get(agentName);
  }

  /**
   * Get number of active connections.
   */
  get connectionCount(): number {
    return this.connections.size;
  }

  get pendingDeliveryCount(): number {
    return this.pendingDeliveries.size;
  }

  /**
   * Get list of agents currently processing (thinking).
   * Returns an object with agent names as keys and processing info as values.
   */
  getProcessingAgents(): Record<string, { startedAt: number; messageId: string }> {
    const result: Record<string, { startedAt: number; messageId: string }> = {};
    for (const [name, state] of this.processingAgents.entries()) {
      result[name] = { startedAt: state.startedAt, messageId: state.messageId };
    }
    return result;
  }

  /**
   * Check if a specific agent is processing.
   */
  isAgentProcessing(agentName: string): boolean {
    return this.processingAgents.has(agentName);
  }

  /**
   * Mark an agent as processing (called when they receive a message).
   */
  private setProcessing(agentName: string, messageId: string): void {
    // Clear any existing processing state
    this.clearProcessing(agentName);

    const timer = setTimeout(() => {
      this.clearProcessing(agentName);
      console.log(`[router] Processing timeout for ${agentName}`);
    }, Router.PROCESSING_TIMEOUT_MS);

    this.processingAgents.set(agentName, {
      startedAt: Date.now(),
      messageId,
      timer,
    });
    console.log(`[router] ${agentName} started processing (message: ${messageId})`);
    this.onProcessingStateChange?.();
  }

  /**
   * Clear processing state for an agent (called when they send a message).
   */
  private clearProcessing(agentName: string): void {
    const state = this.processingAgents.get(agentName);
    if (state) {
      if (state.timer) {
        clearTimeout(state.timer);
      }
      this.processingAgents.delete(agentName);
      console.log(`[router] ${agentName} finished processing`);
      this.onProcessingStateChange?.();
    }
  }

  /**
   * Handle ACK for previously delivered messages.
   */
  handleAck(connection: RoutableConnection, envelope: Envelope<AckPayload>): void {
    const ackId = envelope.payload.ack_id;
    const pending = this.pendingDeliveries.get(ackId);
    if (!pending) return;

    // Only accept ACKs from the same connection that received the deliver
    if (pending.connectionId !== connection.id) return;

    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    this.pendingDeliveries.delete(ackId);
    const statusUpdate = this.storage?.updateMessageStatus?.(ackId, 'acked');
    if (statusUpdate instanceof Promise) {
      statusUpdate.catch(err => {
        console.error('[router] Failed to record ACK status', err);
      });
    }
    console.log(`[router] ACK received for ${ackId}`);
  }

  /**
   * Clear pending deliveries for a connection (e.g., on disconnect).
   */
  clearPendingForConnection(connectionId: string): void {
    for (const [id, pending] of this.pendingDeliveries.entries()) {
      if (pending.connectionId === connectionId) {
        if (pending.timer) clearTimeout(pending.timer);
        this.pendingDeliveries.delete(id);
      }
    }
  }

  /**
   * Track a delivery and schedule retries until ACKed or TTL/attempts exhausted.
   */
  private trackDelivery(target: RoutableConnection, deliver: DeliverEnvelope): void {
    const pending: PendingDelivery = {
      envelope: deliver,
      connectionId: target.id,
      attempts: 1,
      firstSentAt: Date.now(),
    };

    pending.timer = this.scheduleRetry(deliver.id);
    this.pendingDeliveries.set(deliver.id, pending);
  }

  private scheduleRetry(deliverId: string): NodeJS.Timeout | undefined {
    return setTimeout(() => {
      const pending = this.pendingDeliveries.get(deliverId);
      if (!pending) return;

      const now = Date.now();
      const elapsed = now - pending.firstSentAt;
      if (elapsed > this.deliveryOptions.deliveryTtlMs) {
        console.warn(`[router] Dropping ${deliverId} after TTL (${this.deliveryOptions.deliveryTtlMs}ms)`);
        this.pendingDeliveries.delete(deliverId);
        return;
      }

      if (pending.attempts >= this.deliveryOptions.maxAttempts) {
        console.warn(`[router] Dropping ${deliverId} after max attempts (${this.deliveryOptions.maxAttempts})`);
        this.pendingDeliveries.delete(deliverId);
        return;
      }

      const target = this.connections.get(pending.connectionId);
      if (!target) {
        console.warn(`[router] Dropping ${deliverId} - connection unavailable`);
        this.pendingDeliveries.delete(deliverId);
        return;
      }

      pending.attempts++;
      const sent = target.send(pending.envelope);
      if (!sent) {
        console.warn(`[router] Retry failed for ${deliverId} (attempt ${pending.attempts})`);
      } else {
        console.log(`[router] Retried ${deliverId} (attempt ${pending.attempts})`);
      }

      pending.timer = this.scheduleRetry(deliverId);
    }, this.deliveryOptions.ackTimeoutMs);
  }

  /**
   * Replay any pending (unacked) messages for a resumed session.
   */
  async replayPending(connection: RoutableConnection): Promise<void> {
    if (!this.storage?.getPendingMessagesForSession || !connection.agentName) {
      return;
    }

    const pending = await this.storage.getPendingMessagesForSession(connection.agentName, connection.sessionId);
    if (!pending.length) return;

    console.log(`[router] Replaying ${pending.length} messages to ${connection.agentName}`);

    for (const msg of pending) {
      const deliver: DeliverEnvelope = {
        v: PROTOCOL_VERSION,
        type: 'DELIVER',
        id: msg.id,
        ts: msg.ts,
        from: msg.from,
        to: msg.to,
        topic: msg.topic,
        payload: {
          kind: msg.kind,
          body: msg.body,
          data: msg.data,
          thread: msg.thread,
        },
        payload_meta: msg.payloadMeta,
        delivery: {
          seq: msg.deliverySeq ?? connection.getNextSeq(msg.topic ?? 'default', msg.from),
          session_id: msg.deliverySessionId ?? connection.sessionId,
        },
      };

      const sent = connection.send(deliver);
      if (sent) {
        this.trackDelivery(connection, deliver);
      }
    }
  }
}
