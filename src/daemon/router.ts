/**
 * Message router for the agent relay daemon.
 * Handles routing messages between agents, topic subscriptions, and broadcast.
 */

import { v4 as uuid } from 'uuid';
import {
  type Envelope,
  type SendPayload,
  type DeliverEnvelope,
  type AckPayload,
  PROTOCOL_VERSION,
} from '../protocol/types.js';
import type { StorageAdapter } from '../storage/adapter.js';
import type { AgentRegistry } from './agent-registry.js';

export interface RoutableConnection {
  id: string;
  agentName?: string;
  cli?: string;
  workingDirectory?: string;
  sessionId: string;
  close(): void;
  send(envelope: Envelope): boolean;
  getNextSeq(topic: string, peer: string): number;
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
  ackTimeoutMs: 2000,
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

export class Router {
  private storage?: StorageAdapter;
  private connections: Map<string, RoutableConnection> = new Map(); // connectionId -> Connection
  private agents: Map<string, RoutableConnection> = new Map(); // agentName -> Connection
  private subscriptions: Map<string, Set<string>> = new Map(); // topic -> Set<agentName>
  private pendingDeliveries: Map<string, PendingDelivery> = new Map(); // deliverId -> pending
  private deliveryOptions: DeliveryReliabilityOptions;
  private registry?: AgentRegistry;

  constructor(options: { storage?: StorageAdapter; delivery?: Partial<DeliveryReliabilityOptions>; registry?: AgentRegistry } = {}) {
    this.storage = options.storage;
    this.deliveryOptions = { ...DEFAULT_DELIVERY_OPTIONS, ...options.delivery };
    this.registry = options.registry;
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
   * Route a SEND message to its destination(s).
   */
  route(from: RoutableConnection, envelope: Envelope<SendPayload>): void {
    const senderName = from.agentName;
    if (!senderName) {
      console.log(`[router] Dropping message - sender has no name`);
      return;
    }

    this.registry?.recordSend(senderName);

    const to = envelope.to;
    const topic = envelope.topic;

    console.log(`[router] ${senderName} -> ${to}: ${envelope.payload.body?.substring(0, 50)}...`);

    if (to === '*') {
      // Broadcast to all (except sender)
      this.broadcast(senderName, envelope, topic);
    } else if (to) {
      // Direct message
      this.sendDirect(senderName, to, envelope);
    }
  }

  /**
   * Send a direct message to a specific agent.
   */
  private sendDirect(
    from: string,
    to: string,
    envelope: Envelope<SendPayload>
  ): boolean {
    const target = this.agents.get(to);
    if (!target) {
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
    }
    return sent;
  }

  /**
   * Broadcast to all agents (optionally filtered by topic subscription).
   */
  private broadcast(
    from: string,
    envelope: Envelope<SendPayload>,
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
        this.persistDeliverEnvelope(deliver);
        if (sent) {
          this.trackDelivery(target, deliver);
          this.registry?.recordReceive(agentName);
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
    original: Envelope<SendPayload>,
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
      delivery: {
        seq: target.getNextSeq(original.topic ?? 'default', from),
        session_id: target.sessionId,
      },
    };
  }

  /**
   * Persist a delivered message if storage is configured.
   */
  private persistDeliverEnvelope(envelope: DeliverEnvelope): void {
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
      deliverySeq: envelope.delivery.seq,
      deliverySessionId: envelope.delivery.session_id,
      sessionId: envelope.delivery.session_id,
      status: 'unread',
      is_urgent: false,
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
}
