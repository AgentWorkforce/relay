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
  type EntityType,
  PROTOCOL_VERSION,
} from '../protocol/types.js';
import type {
  ChannelJoinPayload,
  ChannelLeavePayload,
  ChannelMessagePayload,
} from '../protocol/channels.js';
import type { StorageAdapter } from '../storage/adapter.js';
import type { AgentRegistry } from './agent-registry.js';
import { routerLog } from '../utils/logger.js';

export interface RoutableConnection {
  id: string;
  agentName?: string;
  /** Entity type: 'agent' (default) or 'user' for human users */
  entityType?: EntityType;
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

  /** Channel membership: channel -> Set of member names */
  private channels: Map<string, Set<string>> = new Map();
  /** User entities (human users, not agents) */
  private users: Map<string, RoutableConnection> = new Map();
  /** Reverse lookup: member name -> Set of channels they're in */
  private memberChannels: Map<string, Set<string>> = new Map();

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
      const isUser = connection.entityType === 'user';

      if (isUser) {
        // Handle existing user connection with same name (disconnect old)
        const existingUser = this.users.get(connection.agentName);
        if (existingUser && existingUser.id !== connection.id) {
          existingUser.close();
          this.connections.delete(existingUser.id);
        }
        this.users.set(connection.agentName, connection);
        routerLog.info(`User registered: ${connection.agentName}`);
      } else {
        // Handle existing agent connection with same name (disconnect old)
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
  }

  /**
   * Unregister a connection.
   */
  unregister(connection: RoutableConnection): void {
    this.connections.delete(connection.id);
    if (connection.agentName) {
      const isUser = connection.entityType === 'user';

      if (isUser) {
        const currentUser = this.users.get(connection.agentName);
        if (currentUser?.id === connection.id) {
          this.users.delete(connection.agentName);
        }
      } else {
        const current = this.agents.get(connection.agentName);
        if (current?.id === connection.id) {
          this.agents.delete(connection.agentName);
        }
      }

      // Remove from all subscriptions
      for (const subscribers of this.subscriptions.values()) {
        subscribers.delete(connection.agentName);
      }

      // Remove from all channels and notify remaining members
      this.removeFromAllChannels(connection.agentName);

      // Clean up shadow relationships
      this.unbindShadow(connection.agentName);

      // Clear processing state
      this.clearProcessing(connection.agentName);
    }

    this.clearPendingForConnection(connection.id);
  }

  /**
   * Remove a member from all channels they're in.
   */
  private removeFromAllChannels(memberName: string): void {
    const memberChannelSet = this.memberChannels.get(memberName);
    if (!memberChannelSet) return;

    for (const channelName of memberChannelSet) {
      const members = this.channels.get(channelName);
      if (members) {
        members.delete(memberName);
        // Clean up empty channels
        if (members.size === 0) {
          this.channels.delete(channelName);
        }
      }
    }
    this.memberChannels.delete(memberName);
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

    routerLog.info(`Shadow bound: ${shadowAgent} -> ${primaryAgent}`, { speakOn: relationship.speakOn });
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

    routerLog.info(`Shadow unbound: ${shadowAgent} from ${primaryAgent}`);
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
        routerLog.debug(`Shadow trigger ${trigger} sent to ${shadow.shadowAgent}`, { primary: primaryAgent });
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
      routerLog.warn('Dropping message - sender has no name');
      return;
    }

    // Agent is responding - clear their processing state
    this.clearProcessing(senderName);

    this.registry?.recordSend(senderName);

    const to = envelope.to;
    const topic = envelope.topic;

    routerLog.debug(`${senderName} -> ${to}`, { preview: envelope.payload.body?.substring(0, 50) });

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
        routerLog.debug(`Shadow copy to ${shadow.shadowAgent}`, { direction, primary: primaryAgent });
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
        routerLog.info(`Routing to remote agent: ${to}`, { daemonName: remoteAgent.daemonName });
        return this.sendToRemoteAgent(from, to, envelope, remoteAgent);
      }
      routerLog.warn(`Target "${to}" not found`, { availableAgents: Array.from(this.agents.keys()) });
      return false;
    }

    const deliver = this.createDeliverEnvelope(from, to, envelope, target);
    const sent = target.send(deliver);
    routerLog.debug(`Delivered to ${to}`, { success: sent });
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
      routerLog.warn('Cross-machine handler not available');
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
        routerLog.info(`Cross-machine message sent to ${to}`, { daemonName: remoteAgent.daemonName });
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
        }).catch(err => routerLog.error('Failed to persist cross-machine message', { error: String(err) }));
      } else {
        routerLog.error(`Failed to send cross-machine message to ${to}`);
      }
    }).catch(err => {
      routerLog.error('Cross-machine send error', { error: String(err) });
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
    // Preserve the original 'to' field for broadcasts so agents know to reply to '*'
    const originalTo = original.to;

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
        originalTo: originalTo !== to ? originalTo : undefined, // Only include if different
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
      routerLog.error('Failed to persist message', { error: String(err) });
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
      routerLog.warn(`Processing timeout for ${agentName}`);
    }, Router.PROCESSING_TIMEOUT_MS);

    this.processingAgents.set(agentName, {
      startedAt: Date.now(),
      messageId,
      timer,
    });
    routerLog.debug(`${agentName} started processing`, { messageId });
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
      routerLog.debug(`${agentName} finished processing`);
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
        routerLog.error('Failed to record ACK status', { error: String(err) });
      });
    }
    routerLog.debug(`ACK received for ${ackId}`);
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
        routerLog.warn(`Dropping ${deliverId} after TTL`, { ttlMs: this.deliveryOptions.deliveryTtlMs });
        this.pendingDeliveries.delete(deliverId);
        // Mark message as failed in storage
        const statusUpdate = this.storage?.updateMessageStatus?.(deliverId, 'failed');
        if (statusUpdate instanceof Promise) {
          statusUpdate.catch(err => {
            routerLog.error(`Failed to update status for ${deliverId}`, { error: String(err) });
          });
        }
        return;
      }

      if (pending.attempts >= this.deliveryOptions.maxAttempts) {
        routerLog.warn(`Dropping ${deliverId} after max attempts`, { maxAttempts: this.deliveryOptions.maxAttempts });
        this.pendingDeliveries.delete(deliverId);
        // Mark message as failed in storage
        const statusUpdate = this.storage?.updateMessageStatus?.(deliverId, 'failed');
        if (statusUpdate instanceof Promise) {
          statusUpdate.catch(err => {
            routerLog.error(`Failed to update status for ${deliverId}`, { error: String(err) });
          });
        }
        return;
      }

      const target = this.connections.get(pending.connectionId);
      if (!target) {
        routerLog.warn(`Dropping ${deliverId} - connection unavailable`);
        this.pendingDeliveries.delete(deliverId);
        // Mark message as failed in storage
        const statusUpdate = this.storage?.updateMessageStatus?.(deliverId, 'failed');
        if (statusUpdate instanceof Promise) {
          statusUpdate.catch(err => {
            routerLog.error(`Failed to update status for ${deliverId}`, { error: String(err) });
          });
        }
        return;
      }

      pending.attempts++;
      const sent = target.send(pending.envelope);
      if (!sent) {
        routerLog.warn(`Retry failed for ${deliverId}`, { attempt: pending.attempts });
      } else {
        routerLog.debug(`Retried ${deliverId}`, { attempt: pending.attempts });
      }

      pending.timer = this.scheduleRetry(deliverId);
    }, this.deliveryOptions.ackTimeoutMs);
  }

  /**
   * Broadcast a system message to all connected agents.
   * Used for system notifications like agent death announcements.
   */
  broadcastSystemMessage(message: string, data?: Record<string, unknown>): void {
    const envelope: SendEnvelope = {
      v: PROTOCOL_VERSION,
      type: 'SEND',
      id: uuid(),
      ts: Date.now(),
      from: '_system',
      to: '*',
      payload: {
        kind: 'message',
        body: message,
        data: {
          ...data,
          _isSystemMessage: true,
        },
      },
    };

    // Broadcast to all agents
    for (const [agentName, connection] of this.agents.entries()) {
      const deliver = this.createDeliverEnvelope('_system', agentName, envelope, connection);
      const sent = connection.send(deliver);
      if (sent) {
        routerLog.debug(`System broadcast sent to ${agentName}`);
      }
    }
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

    routerLog.info(`Replaying ${pending.length} messages to ${connection.agentName}`);

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

  // ==================== Channel Methods ====================

  /**
   * Handle a CHANNEL_JOIN message.
   * Adds the member to the channel and notifies existing members.
   */
  handleChannelJoin(
    connection: RoutableConnection,
    envelope: Envelope<ChannelJoinPayload>
  ): void {
    const memberName = connection.agentName;
    if (!memberName) {
      routerLog.warn('CHANNEL_JOIN from connection without name');
      return;
    }

    const channel = envelope.payload.channel;

    // Get or create channel
    let members = this.channels.get(channel);
    if (!members) {
      members = new Set();
      this.channels.set(channel, members);
    }

    // Check if already a member
    if (members.has(memberName)) {
      routerLog.debug(`${memberName} already in ${channel}`);
      return;
    }

    // Notify existing members about the new joiner
    for (const existingMember of members) {
      const memberConn = this.getConnectionByName(existingMember);
      if (memberConn) {
        const joinNotification: Envelope<ChannelJoinPayload> = {
          v: PROTOCOL_VERSION,
          type: 'CHANNEL_JOIN',
          id: uuid(),
          ts: Date.now(),
          from: memberName,
          payload: envelope.payload,
        };
        memberConn.send(joinNotification);
      }
    }

    // Add the new member
    members.add(memberName);

    // Track which channels this member is in
    let memberChannelSet = this.memberChannels.get(memberName);
    if (!memberChannelSet) {
      memberChannelSet = new Set();
      this.memberChannels.set(memberName, memberChannelSet);
    }
    memberChannelSet.add(channel);

    routerLog.info(`${memberName} joined ${channel} (${members.size} members)`);
  }

  /**
   * Handle a CHANNEL_LEAVE message.
   * Removes the member from the channel and notifies remaining members.
   */
  handleChannelLeave(
    connection: RoutableConnection,
    envelope: Envelope<ChannelLeavePayload>
  ): void {
    const memberName = connection.agentName;
    if (!memberName) {
      routerLog.warn('CHANNEL_LEAVE from connection without name');
      return;
    }

    const channel = envelope.payload.channel;
    const members = this.channels.get(channel);

    if (!members || !members.has(memberName)) {
      routerLog.debug(`${memberName} not in ${channel}, ignoring leave`);
      return;
    }

    // Remove from channel
    members.delete(memberName);

    // Remove from member's channel list
    const memberChannelSet = this.memberChannels.get(memberName);
    if (memberChannelSet) {
      memberChannelSet.delete(channel);
      if (memberChannelSet.size === 0) {
        this.memberChannels.delete(memberName);
      }
    }

    // Notify remaining members
    for (const remainingMember of members) {
      const memberConn = this.getConnectionByName(remainingMember);
      if (memberConn) {
        const leaveNotification: Envelope<ChannelLeavePayload> = {
          v: PROTOCOL_VERSION,
          type: 'CHANNEL_LEAVE',
          id: uuid(),
          ts: Date.now(),
          from: memberName,
          payload: envelope.payload,
        };
        memberConn.send(leaveNotification);
      }
    }

    // Clean up empty channels
    if (members.size === 0) {
      this.channels.delete(channel);
      routerLog.debug(`Channel ${channel} deleted (empty)`);
    }

    routerLog.info(`${memberName} left ${channel}`);
  }

  /**
   * Route a channel message to all members except the sender.
   */
  routeChannelMessage(
    connection: RoutableConnection,
    envelope: Envelope<ChannelMessagePayload>
  ): void {
    const senderName = connection.agentName;
    if (!senderName) {
      routerLog.warn('CHANNEL_MESSAGE from connection without name');
      return;
    }

    const channel = envelope.payload.channel;
    const members = this.channels.get(channel);

    if (!members) {
      routerLog.warn(`Message to non-existent channel ${channel}`);
      return;
    }

    if (!members.has(senderName)) {
      routerLog.warn(`${senderName} not a member of ${channel}`);
      return;
    }

    // Route to all members except sender
    for (const memberName of members) {
      if (memberName === senderName) continue;

      const memberConn = this.getConnectionByName(memberName);
      if (memberConn) {
        const deliverEnvelope: Envelope<ChannelMessagePayload> = {
          v: PROTOCOL_VERSION,
          type: 'CHANNEL_MESSAGE',
          id: uuid(),
          ts: Date.now(),
          from: senderName,
          payload: envelope.payload,
        };
        memberConn.send(deliverEnvelope);
      }
    }

    // Persist channel message
    this.persistChannelMessage(envelope, senderName);

    routerLog.debug(`${senderName} -> ${channel}: ${envelope.payload.body.substring(0, 50)}`);
  }

  /**
   * Persist a channel message to storage.
   */
  private persistChannelMessage(
    envelope: Envelope<ChannelMessagePayload>,
    from: string
  ): void {
    if (!this.storage) return;

    this.storage.saveMessage({
      id: envelope.id,
      ts: envelope.ts,
      from,
      to: envelope.payload.channel, // Channel name as "to"
      topic: undefined,
      kind: 'message',
      body: envelope.payload.body,
      data: {
        ...envelope.payload.data,
        _isChannelMessage: true,
        _channel: envelope.payload.channel,
        _mentions: envelope.payload.mentions,
      },
      thread: envelope.payload.thread,
      status: 'unread',
      is_urgent: false,
      is_broadcast: true, // Channel messages are effectively broadcasts
    }).catch((err) => {
      routerLog.error('Failed to persist channel message', { error: String(err) });
    });
  }

  /**
   * Get all members of a channel.
   */
  getChannelMembers(channel: string): string[] {
    const members = this.channels.get(channel);
    return members ? Array.from(members) : [];
  }

  /**
   * Get all channels.
   */
  getChannels(): string[] {
    return Array.from(this.channels.keys());
  }

  /**
   * Get all channels a member is in.
   */
  getChannelsForMember(memberName: string): string[] {
    const channels = this.memberChannels.get(memberName);
    return channels ? Array.from(channels) : [];
  }

  /**
   * Check if a name belongs to a user (not an agent).
   */
  isUser(name: string): boolean {
    return this.users.has(name);
  }

  /**
   * Check if a name belongs to an agent (not a user).
   */
  isAgent(name: string): boolean {
    return this.agents.has(name);
  }

  /**
   * Get list of connected user names (human users only).
   */
  getUsers(): string[] {
    return Array.from(this.users.keys());
  }

  /**
   * Get a connection by name (checks both agents and users).
   */
  private getConnectionByName(name: string): RoutableConnection | undefined {
    return this.agents.get(name) ?? this.users.get(name);
  }
}
