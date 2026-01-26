/**
 * Message router for the agent relay daemon.
 * Handles routing messages between agents, topic subscriptions, and broadcast.
 */

import { generateId } from '@agent-relay/wrapper';
import {
  type Envelope,
  type SendEnvelope,
  type DeliverEnvelope,
  type AckPayload,
  type ErrorPayload,
  type ShadowConfig,
  type SpeakOnTrigger,
  type EntityType,
  PROTOCOL_VERSION,
} from '@agent-relay/protocol/types';
import type {
  ChannelJoinPayload,
  ChannelLeavePayload,
  ChannelMessagePayload,
} from '@agent-relay/protocol/channels';
import type { StorageAdapter } from '@agent-relay/storage/adapter';
import type { AgentRegistry } from './agent-registry.js';
import { routerLog } from '@agent-relay/utils/logger';
import { RateLimiter, NoOpRateLimiter, type RateLimitConfig } from './rate-limiter.js';
import * as crypto from 'node:crypto';
import {
  DeliveryTracker,
  type DeliveryReliabilityOptions,
} from './delivery-tracker.js';
import type { ChannelMembershipStore } from './channel-membership-store.js';

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
  /** Check if a user is on a remote machine (connected via cloud dashboard) */
  isRemoteUser?(userName: string): RemoteAgentInfo | undefined;
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
  private channelMembershipStore?: ChannelMembershipStore;
  private connections: Map<string, RoutableConnection> = new Map(); // connectionId -> Connection
  private agents: Map<string, RoutableConnection> = new Map(); // agentName -> Connection
  private subscriptions: Map<string, Set<string>> = new Map(); // topic -> Set<agentName>
  private processingAgents: Map<string, ProcessingState> = new Map(); // agentName -> processing state
  private registry?: AgentRegistry;
  private crossMachineHandler?: CrossMachineHandler;
  private deliveryTracker: DeliveryTracker;

  /** Shadow relationships: primaryAgent -> list of shadow configs */
  private shadowsByPrimary: Map<string, ShadowRelationship[]> = new Map();
  /** Reverse lookup: shadowAgent -> primaryAgent (for cleanup) */
  private primaryByShadow: Map<string, string> = new Map();

  /** Channel membership: channel -> Set of member names */
  private channels: Map<string, Set<string>> = new Map();
  /** User entities (human users, not agents) - supports multiple connections per user (multi-tab) */
  private users: Map<string, Set<RoutableConnection>> = new Map();
  /** Reverse lookup: member name -> Set of channels they're in */
  private memberChannels: Map<string, Set<string>> = new Map();

  /**
   * Agents that are currently being spawned but haven't completed HELLO yet.
   * Maps agent name to timestamp when spawn started.
   * Messages sent to these agents will be queued for delivery after HELLO completes.
   */
  private spawningAgents: Map<string, number> = new Map();

  /** Default timeout for processing indicator (30 seconds) */
  private static readonly PROCESSING_TIMEOUT_MS = 30_000;

  /** Timeout for spawning agent entries (60 seconds) */
  private static readonly SPAWNING_TIMEOUT_MS = 60_000;

  /** Callback when processing state changes (for real-time dashboard updates) */
  private onProcessingStateChange?: () => void;

  /** Rate limiter for per-agent throttling */
  private rateLimiter: RateLimiter;

  constructor(options: {
    storage?: StorageAdapter;
    delivery?: Partial<DeliveryReliabilityOptions>;
    registry?: AgentRegistry;
    onProcessingStateChange?: () => void;
    crossMachineHandler?: CrossMachineHandler;
    /** Rate limit configuration. Set to null to disable rate limiting. */
    rateLimit?: Partial<RateLimitConfig> | null;
    channelMembershipStore?: ChannelMembershipStore;
  } = {}) {
    this.storage = options.storage;
    this.channelMembershipStore = options.channelMembershipStore;
    this.registry = options.registry;
    this.onProcessingStateChange = options.onProcessingStateChange;
    this.crossMachineHandler = options.crossMachineHandler;
    this.deliveryTracker = new DeliveryTracker({
      storage: this.storage,
      delivery: options.delivery,
      getConnection: (id) => this.connections.get(id),
    });
    // Initialize rate limiter (null = disabled)
    this.rateLimiter = options.rateLimit === null
      ? new NoOpRateLimiter()
      : new RateLimiter(options.rateLimit);
  }

  /**
   * Restore channel memberships from persisted storage.
   */
  async restoreChannelMemberships(): Promise<void> {
    if (!this.storage && !this.channelMembershipStore) return;

    try {
      if (this.channelMembershipStore) {
        const memberships = await this.channelMembershipStore.loadMemberships();
        for (const membership of memberships) {
          this.handleMembershipUpdate({
            channel: membership.channel,
            member: membership.member,
            action: 'join',
          });
        }
      }

      if (this.storage) {
        const messages = await this.storage.getMessages({ order: 'asc' });
        for (const msg of messages) {
          const channel = msg.to;
          const data = msg.data as Record<string, unknown> | undefined;
          const membership = data?._channelMembership as { member?: string; action?: 'join' | 'leave' | 'invite' } | undefined;
          if (!channel || !membership?.member) {
            continue;
          }
          const action = membership.action ?? 'join';
          this.handleMembershipUpdate({
            channel,
            member: membership.member,
            action,
          });
        }
      }
    } catch (err) {
      routerLog.error('Failed to restore channel memberships', { error: String(err) });
    }
  }

  /**
   * Set or update the cross-machine handler.
   */
  setCrossMachineHandler(handler: CrossMachineHandler): void {
    this.crossMachineHandler = handler;
  }

  /**
   * Mark an agent as spawning (before HELLO completes).
   * Messages sent to this agent will be queued for delivery after registration.
   */
  markSpawning(agentName: string): void {
    this.spawningAgents.set(agentName, Date.now());
    routerLog.info(`Agent marked as spawning: ${agentName}`, {
      currentSpawning: Array.from(this.spawningAgents.keys()),
    });
    // Clean up stale spawning entries
    this.cleanupStaleSpawning();
  }

  /**
   * Clear the spawning flag for an agent.
   * Called when agent completes registration or spawn fails.
   */
  clearSpawning(agentName: string): void {
    if (this.spawningAgents.delete(agentName)) {
      routerLog.debug(`Agent spawning flag cleared: ${agentName}`);
    }
  }

  /**
   * Check if an agent is currently spawning.
   */
  isSpawning(agentName: string): boolean {
    const timestamp = this.spawningAgents.get(agentName);
    if (!timestamp) return false;
    // Check if spawn has timed out
    if (Date.now() - timestamp > Router.SPAWNING_TIMEOUT_MS) {
      this.spawningAgents.delete(agentName);
      return false;
    }
    return true;
  }

  /**
   * Clean up spawning entries older than SPAWNING_TIMEOUT_MS.
   */
  private cleanupStaleSpawning(): void {
    const now = Date.now();
    for (const [name, timestamp] of this.spawningAgents) {
      if (now - timestamp > Router.SPAWNING_TIMEOUT_MS) {
        this.spawningAgents.delete(name);
        routerLog.debug(`Cleaned up stale spawning entry: ${name}`);
      }
    }
  }

  /**
   * Register a connection after successful handshake.
   */
  register(connection: RoutableConnection): void {
    this.connections.set(connection.id, connection);

    if (connection.agentName) {
      const isUser = connection.entityType === 'user';

      if (isUser) {
        // Users can have multiple connections (e.g., multiple browser tabs)
        // Track ALL connections per user so messages reach all tabs
        if (!this.users.has(connection.agentName)) {
          this.users.set(connection.agentName, new Set());
        }
        this.users.get(connection.agentName)!.add(connection);
        routerLog.info(`User registered: ${connection.agentName} (${this.users.get(connection.agentName)!.size} connections)`);
      } else {
        // Handle existing agent connection with same name (disconnect old)
        const existing = this.agents.get(connection.agentName);
        if (existing && existing.id !== connection.id) {
          routerLog.warn('Duplicate agent connection detected, closing old connection', {
            agent: connection.agentName,
            oldConnectionId: existing.id,
            newConnectionId: connection.id,
          });
          // Send fatal error before closing to prevent reconnection loop
          const errorEnvelope: Envelope<ErrorPayload> = {
            v: PROTOCOL_VERSION,
            type: 'ERROR',
            id: generateId(),
            ts: Date.now(),
            payload: {
              code: 'DUPLICATE_CONNECTION',
              message: `Another agent with name "${connection.agentName}" connected. This connection will be closed.`,
              fatal: true,
            },
          };
          existing.send(errorEnvelope);
          existing.close();
          this.connections.delete(existing.id);
        }
        this.agents.set(connection.agentName, connection);
        // Clear spawning flag now that agent has completed registration
        this.clearSpawning(connection.agentName);
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
      let wasCurrentConnection = false;

      if (isUser) {
        const userConnections = this.users.get(connection.agentName);
        if (userConnections) {
          userConnections.delete(connection);
          if (userConnections.size === 0) {
            this.users.delete(connection.agentName);
            wasCurrentConnection = true;
            routerLog.info(`User fully unregistered: ${connection.agentName} (all connections closed)`);
          } else {
            routerLog.debug(`User connection closed: ${connection.agentName} (${userConnections.size} connections remaining)`);
          }
        }
      } else {
        const current = this.agents.get(connection.agentName);
        if (current?.id === connection.id) {
          this.agents.delete(connection.agentName);
          wasCurrentConnection = true;
        }
      }

      // Only clean up channel/subscription state if this was the current connection.
      // If a new connection replaced this one, we don't want to remove channel memberships
      // that the new connection should inherit.
      if (wasCurrentConnection) {
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
        id: generateId(),
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
    // Check if this is a cross-machine message (injected from cloud)
    const isCrossMachine = envelope.payload?.data?._crossMachine === true;

    // Use envelope.from for cross-machine messages where the connection is the recipient,
    // otherwise use the connection's agent name (normal local messages)
    const senderName = isCrossMachine ? envelope.from : (envelope.from || from.agentName);
    if (!senderName) {
      routerLog.warn('Dropping message - sender has no name');
      return;
    }

    // Skip rate limiting, processing state, and send recording for cross-machine messages
    // These only apply to local agents sending messages
    if (!isCrossMachine) {
      // Check rate limit
      if (!this.rateLimiter.tryAcquire(senderName)) {
        routerLog.warn(`Rate limited: ${senderName}`);
        return;
      }

      // Agent is responding - clear their processing state
      this.clearProcessing(senderName);

      this.registry?.recordSend(senderName);
    }

    const to = envelope.to;
    const topic = envelope.topic;

    routerLog.debug(`Route ${senderName} -> ${to}`, { preview: envelope.payload.body?.substring(0, 50) });

    if (to === '*') {
      // Broadcast to all (except sender)
      this.broadcast(senderName, envelope, topic);
    } else if (to === '@users') {
      // Broadcast to all human users only (not agents)
      this.broadcastToUsers(senderName, envelope);
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
   *
   * If the target agent is offline but known (has connected before),
   * the message is persisted for delivery when the agent reconnects.
   * This prevents silent message drops during brief disconnections or spawn timing issues.
   */
  private sendDirect(
    from: string,
    to: string,
    envelope: SendEnvelope
  ): boolean {
    // Check for agent first, then user connections
    const agentTarget = this.agents.get(to);
    const userConnections = this.users.get(to);
    const hasTarget = agentTarget || (userConnections && userConnections.size > 0);

    // If target not found locally, check remote
    if (!hasTarget) {
      const remoteAgent = this.crossMachineHandler?.isRemoteAgent(to);
      if (remoteAgent) {
        routerLog.info(`Routing to remote agent: ${to}`, { daemonName: remoteAgent.daemonName });
        return this.sendToRemoteAgent(from, to, envelope, remoteAgent);
      }
      // Also check if it's a remote user (human connected via cloud dashboard)
      const remoteUser = this.crossMachineHandler?.isRemoteUser?.(to);
      if (remoteUser) {
        routerLog.info(`Routing to remote user: ${to}`, { daemonName: remoteUser.daemonName });
        return this.sendToRemoteAgent(from, to, envelope, remoteUser);
      }

      // Check if this is a known agent (has connected before) - queue for later delivery
      // This prevents message drops during brief disconnections or spawn timing issues
      if (this.registry?.has(to)) {
        routerLog.info(`Target "${to}" offline but known, queueing message for delivery on reconnect`);
        this.persistMessageForOfflineAgent(from, to, envelope);
        return true; // Message accepted (queued), not dropped
      }

      // Check if agent is currently spawning (pre-HELLO) - queue for delivery after registration
      // This handles the race condition between spawn completion and HELLO handshake
      const spawning = this.isSpawning(to);
      routerLog.debug(`Spawning check for "${to}": ${spawning}`, {
        spawningAgents: Array.from(this.spawningAgents.keys()),
        hasStorage: !!this.storage,
      });
      if (spawning) {
        routerLog.info(`Target "${to}" is spawning, queueing message for delivery after registration`);
        this.persistMessageForOfflineAgent(from, to, envelope);
        return true; // Message accepted (queued), not dropped
      }

      routerLog.warn(`Target "${to}" not found and unknown`, { availableAgents: Array.from(this.agents.keys()), spawningAgents: Array.from(this.spawningAgents.keys()) });
      return false;
    }

    // For user targets, send to ALL connections (multi-tab support)
    if (userConnections && userConnections.size > 0) {
      let anySent = false;
      for (const userConn of userConnections) {
        const deliver = this.createDeliverEnvelope(from, to, envelope, userConn);
        const sent = userConn.send(deliver);
        if (sent) anySent = true;
        routerLog.debug(`Delivered ${from} -> ${to} (user connection ${userConn.id})`, {
          success: sent,
          preview: envelope.payload.body?.substring(0, 40),
        });
        // Persist only once (for the first connection)
        if (userConn === [...userConnections][0]) {
          this.persistDeliverEnvelope(deliver);
        }
        if (sent) {
          this.trackDelivery(userConn, deliver);
        }
      }
      if (anySent) {
        this.registry?.recordReceive(to);
      }
      return anySent;
    }

    // For agent targets, send to single connection
    const target = agentTarget!;
    const deliver = this.createDeliverEnvelope(from, to, envelope, target);
    const sent = target.send(deliver);
    routerLog.debug(`Delivered ${from} -> ${to}`, { success: sent, preview: envelope.payload.body?.substring(0, 40) });
    this.persistDeliverEnvelope(deliver);
    if (sent) {
      this.trackDelivery(target, deliver);
      this.registry?.recordReceive(to);
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
    // Build recipients list from both agents and users
    const recipients = topic
      ? this.subscriptions.get(topic) ?? new Set()
      : new Set([...this.agents.keys(), ...this.users.keys()]);

    for (const recipientName of recipients) {
      if (recipientName === from) continue; // Don't send to self

      // Check agents first
      const agentTarget = this.agents.get(recipientName);
      if (agentTarget) {
        const deliver = this.createDeliverEnvelope(from, recipientName, envelope, agentTarget);
        const sent = agentTarget.send(deliver);
        this.persistDeliverEnvelope(deliver, true); // Mark as broadcast
        if (sent) {
          this.trackDelivery(agentTarget, deliver);
          this.registry?.recordReceive(recipientName);
          this.setProcessing(recipientName, deliver.id);
        }
        continue;
      }

      // Check user connections (send to all connections for multi-tab)
      const userConnections = this.users.get(recipientName);
      if (userConnections && userConnections.size > 0) {
        let persisted = false;
        for (const userConn of userConnections) {
          const deliver = this.createDeliverEnvelope(from, recipientName, envelope, userConn);
          const sent = userConn.send(deliver);
          if (!persisted) {
            this.persistDeliverEnvelope(deliver, true); // Mark as broadcast, persist once
            persisted = true;
          }
          if (sent) {
            this.trackDelivery(userConn, deliver);
            this.registry?.recordReceive(recipientName);
          }
        }
      }
    }
  }

  /**
   * Broadcast a message to all human users (not agents).
   * Used for system notifications that only humans should see.
   */
  private broadcastToUsers(
    from: string,
    envelope: SendEnvelope
  ): void {
    for (const [userName, userConnections] of this.users) {
      if (userName === from) continue; // Don't send to self
      if (userConnections.size === 0) continue;

      let persisted = false;
      for (const userConn of userConnections) {
        const deliver = this.createDeliverEnvelope(from, userName, envelope, userConn);
        const sent = userConn.send(deliver);
        if (!persisted) {
          this.persistDeliverEnvelope(deliver, true); // Mark as broadcast, persist once
          persisted = true;
        }
        if (sent) {
          this.trackDelivery(userConn, deliver);
          this.registry?.recordReceive(userName);
          routerLog.debug(`Broadcast to user ${userName} (connection ${userConn.id})`);
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
      id: generateId(),
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
   * Persist a message for an offline agent.
   * Called when a message is sent to a known agent that is not currently connected.
   * The message is marked with _offlineQueued and will be delivered when the agent reconnects.
   */
  private persistMessageForOfflineAgent(from: string, to: string, envelope: SendEnvelope): void {
    if (!this.storage) {
      routerLog.warn('Cannot queue offline message: no storage configured');
      return;
    }

    routerLog.info(`Persisting offline message for "${to}"`, {
      from,
      messageId: envelope.id,
      bodyPreview: envelope.payload.body?.substring(0, 50),
    });

    this.storage.saveMessage({
      id: envelope.id || generateId(),
      ts: Date.now(),
      from,
      to,
      topic: envelope.topic,
      kind: envelope.payload.kind,
      body: envelope.payload.body,
      data: {
        ...envelope.payload.data,
        _offlineQueued: true,  // Mark as queued for offline delivery
        _queuedAt: Date.now(),
      },
      payloadMeta: envelope.payload_meta,
      thread: envelope.payload.thread,
      status: 'unread',  // Unread = pending delivery
      is_urgent: false,
      is_broadcast: false,
    }).catch((err) => {
      routerLog.error('Failed to persist offline message', { error: String(err), to });
    });
  }

  /**
   * Deliver pending messages to an agent that just connected.
   * Queries for unread messages addressed to this agent that were queued while offline.
   * This handles messages that were sent while the agent was offline.
   */
  async deliverPendingMessages(connection: RoutableConnection): Promise<void> {
    const agentName = connection.agentName;
    if (!agentName) return;
    if (!this.storage?.getMessages) return;

    try {
      // Query for unread messages addressed to this agent
      const pendingMessages = await this.storage.getMessages({
        to: agentName,
        unreadOnly: true,
        order: 'asc',  // Deliver oldest first
      });

      // Filter to only include offline-queued messages (not already-delivered unacked messages)
      const offlineMessages = pendingMessages.filter(
        msg => msg.data?._offlineQueued === true
      ).sort((a, b) => a.ts - b.ts);

      if (offlineMessages.length === 0) return;

      routerLog.info(`Delivering ${offlineMessages.length} pending messages to ${agentName}`);

      for (const msg of offlineMessages) {
        // Create deliver envelope
        const deliverEnvelope: DeliverEnvelope = {
          v: PROTOCOL_VERSION,
          type: 'DELIVER',
          id: generateId(),
          ts: Date.now(),
          from: msg.from,
          to: agentName,
          topic: msg.topic,
          payload: {
            body: msg.body,
            kind: msg.kind,
            data: msg.data,
            thread: msg.thread,
          },
          payload_meta: msg.payloadMeta,
          delivery: {
            seq: connection.getNextSeq(msg.topic ?? 'default', msg.from),
            session_id: connection.sessionId,
          },
        };

        const sent = connection.send(deliverEnvelope);
        if (sent) {
          this.trackDelivery(connection, deliverEnvelope);
          this.registry?.recordReceive(agentName);
          this.setProcessing(agentName, deliverEnvelope.id);

          // Mark original message as delivered (update status)
          if (this.storage.updateMessageStatus) {
            await this.storage.updateMessageStatus(msg.id, 'read');
          }

          routerLog.info(`Delivered pending message to ${agentName}`, {
            from: msg.from,
            preview: msg.body.substring(0, 40),
          });
        } else {
          routerLog.warn(`Failed to deliver pending message to ${agentName}`);
        }
      }
    } catch (err) {
      routerLog.error('Failed to deliver pending messages', { error: String(err), agentName });
    }
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
    return this.deliveryTracker.pendingCount;
  }

  /**
   * Get rate limiter statistics.
   */
  getRateLimiterStats(): { agentCount: number; config: RateLimitConfig } {
    return this.rateLimiter.getStats();
  }

  /**
   * Reset rate limit for a specific agent (admin operation).
   */
  resetRateLimit(agentName: string): void {
    this.rateLimiter.reset(agentName);
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
    this.deliveryTracker.handleAck(connection.id, ackId);
  }

  /**
   * Clear pending deliveries for a connection (e.g., on disconnect).
   */
  clearPendingForConnection(connectionId: string): void {
    this.deliveryTracker.clearPendingForConnection(connectionId);
  }

  /**
   * Track a delivery and schedule retries until ACKed or TTL/attempts exhausted.
   */
  private trackDelivery(target: RoutableConnection, deliver: DeliverEnvelope): void {
    this.deliveryTracker.track(target, deliver);
  }

  /**
   * Broadcast a system message to all connected agents.
   * Used for system notifications like agent death announcements.
   */
  broadcastSystemMessage(message: string, data?: Record<string, unknown>): void {
    const envelope: SendEnvelope = {
      v: PROTOCOL_VERSION,
      type: 'SEND',
      id: generateId(),
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
   * If payload.member is set, adds that member (admin mode).
   * Otherwise, adds the connection's agent name.
   */
  handleChannelJoin(
    connection: RoutableConnection,
    envelope: Envelope<ChannelJoinPayload>
  ): void {
    // Use payload.member if provided (admin mode), otherwise use connection's name
    const memberName = envelope.payload.member ?? connection.agentName;
    if (!memberName) {
      routerLog.warn('CHANNEL_JOIN from connection without name and no member specified');
      return;
    }

    const channel = envelope.payload.channel;
    const isAdminJoin = Boolean(envelope.payload.member);

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

    // Only notify existing members for non-admin joins (agents joining themselves)
    // Admin joins are silent to avoid spamming notifications when syncing
    if (!isAdminJoin) {
      const existingMembers = members ? Array.from(members) : [];
      for (const existingMember of existingMembers) {
        const memberConn = this.getConnectionByName(existingMember);
        if (memberConn) {
          const joinNotification: Envelope<ChannelJoinPayload> = {
            v: PROTOCOL_VERSION,
            type: 'CHANNEL_JOIN',
            id: generateId(),
            ts: Date.now(),
            from: memberName,
            payload: envelope.payload,
          };
          memberConn.send(joinNotification);
        }
      }
    }

    const added = this.addChannelMember(channel, memberName, { persist: true });
    if (!added) {
      routerLog.debug(`${memberName} already in ${channel}`);
      return;
    }

    routerLog.info(`${memberName} joined ${channel} (${this.channels.get(channel)?.size ?? 0} members)${isAdminJoin ? ' [admin]' : ''}`);
  }

  /**
   * Handle a CHANNEL_LEAVE message.
   * Removes the member from the channel and notifies remaining members.
   * If payload.member is provided, removes that member instead (admin mode).
   */
  handleChannelLeave(
    connection: RoutableConnection,
    envelope: Envelope<ChannelLeavePayload>
  ): void {
    // Use payload.member if provided (admin mode), otherwise use connection's name
    const memberName = envelope.payload.member ?? connection.agentName;
    if (!memberName) {
      routerLog.warn('CHANNEL_LEAVE from connection without name and no member specified');
      return;
    }

    const channel = envelope.payload.channel;
    const isAdminRemove = Boolean(envelope.payload.member);
    const members = this.channels.get(channel);

    if (!members || !members.has(memberName)) {
      routerLog.debug(`${memberName} not in ${channel}, ignoring leave`);
      return;
    }

    const removed = this.removeChannelMember(channel, memberName, { persist: true });
    if (!removed) {
      routerLog.debug(`${memberName} not in ${channel}, ignoring leave`);
      return;
    }

    // Only notify remaining members for non-admin removes
    // Admin removes are silent to avoid spamming notifications
    if (!isAdminRemove) {
      const remainingMembers = this.channels.get(channel);
      if (remainingMembers) {
        for (const remainingMember of remainingMembers) {
          const memberConn = this.getConnectionByName(remainingMember);
          if (memberConn) {
            const leaveNotification: Envelope<ChannelLeavePayload> = {
              v: PROTOCOL_VERSION,
              type: 'CHANNEL_LEAVE',
              id: generateId(),
              ts: Date.now(),
              from: memberName,
              payload: envelope.payload,
            };
            memberConn.send(leaveNotification);
          }
        }
      }
    }

    routerLog.info(`${memberName} left ${channel}${isAdminRemove ? ' [admin]' : ''}`);
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

    routerLog.info(`routeChannelMessage: channel=${channel} sender=${senderName} members=${members ? Array.from(members).join(',') : 'NONE'}`);

    if (!members) {
      routerLog.warn(`Message to non-existent channel ${channel} (available channels: ${Array.from(this.channels.keys()).join(', ')})`);
      return;
    }

    // Case-insensitive membership check
    const senderMemberName = this.findMemberInSet(members, senderName);
    if (!senderMemberName) {
      routerLog.warn(`${senderName} not a member of ${channel} (members: ${Array.from(members).join(', ')})`);
      return;
    }

    // Route to all members except the sender (no echo)
    const allMembers = Array.from(members);
    routerLog.info(`Routing channel message from ${senderName} to ${channel}`, {
      totalMembers: allMembers.length,
      members: allMembers,
    });

    let deliveredCount = 0;
    const undeliveredMembers: string[] = [];
    const connectedAgents = Array.from(this.agents.keys());
    const connectedUsers = Array.from(this.users.keys());
    routerLog.info(`Connected entities: agents=[${connectedAgents.join(',')}] users=[${connectedUsers.join(',')}]`);

    for (const memberName of members) {
      // Case-insensitive comparison to skip sender
      if (this.namesMatch(memberName, senderName)) {
        continue;
      }

      // Check for agent connection first
      const agentConn = this.agents.get(memberName);
      if (agentConn) {
        const deliverEnvelope: Envelope<ChannelMessagePayload> = {
          v: PROTOCOL_VERSION,
          type: 'CHANNEL_MESSAGE',
          id: generateId(),
          ts: Date.now(),
          from: senderName,
          payload: envelope.payload,
        };
        const sent = agentConn.send(deliverEnvelope);
        if (sent) {
          deliveredCount++;
          routerLog.info(`Delivered to ${memberName} (agent)`);
        } else {
          routerLog.warn(`Failed to send to ${memberName}`);
          undeliveredMembers.push(memberName);
        }
        continue;
      }

      // Check for user connections (send to ALL for multi-tab support)
      const userConnections = this.users.get(memberName);
      if (userConnections && userConnections.size > 0) {
        let anyDelivered = false;
        for (const userConn of userConnections) {
          const deliverEnvelope: Envelope<ChannelMessagePayload> = {
            v: PROTOCOL_VERSION,
            type: 'CHANNEL_MESSAGE',
            id: generateId(),
            ts: Date.now(),
            from: senderName,
            payload: envelope.payload,
          };
          const sent = userConn.send(deliverEnvelope);
          if (sent) {
            anyDelivered = true;
            routerLog.info(`Delivered to ${memberName} (user connection ${userConn.id})`);
          }
        }
        if (anyDelivered) {
          deliveredCount++;
        } else {
          routerLog.warn(`Failed to send to any connection for user ${memberName}`);
          undeliveredMembers.push(memberName);
        }
        continue;
      }

      // Member not connected
      routerLog.warn(`Member ${memberName} is registered in channel but NOT connected to daemon - message not delivered`);
      undeliveredMembers.push(memberName);
    }

    // Persist channel message
    this.persistChannelMessage(envelope, senderName);

    const recipientCount = allMembers.length - 1; // Exclude sender
    routerLog.info(`${senderName} -> ${channel}: delivered to ${deliveredCount}/${recipientCount} members`);

    // Log warning if some members didn't receive the message
    if (undeliveredMembers.length > 0) {
      routerLog.warn(`Channel message undelivered to: [${undeliveredMembers.join(', ')}] - these agents may need to reconnect to the relay daemon`);
    }
  }

  /**
   * Persist a channel message to storage.
   */
  private persistChannelMessage(
    envelope: Envelope<ChannelMessagePayload>,
    from: string
  ): void {
    if (!this.storage) return;

    const payloadData = {
      ...envelope.payload.data,
      _isChannelMessage: true,
      _channel: envelope.payload.channel,
      _mentions: envelope.payload.mentions,
    };

    this.storage.saveMessage({
      id: envelope.id,
      ts: envelope.ts,
      from,
      to: envelope.payload.channel, // Channel name as "to"
      topic: undefined,
      kind: 'message',
      body: envelope.payload.body,
      data: payloadData,
      thread: envelope.payload.thread,
      status: 'unread',
      is_urgent: false,
      is_broadcast: true, // Channel messages are effectively broadcasts
    }).catch((err) => {
      routerLog.error('Failed to persist channel message', { error: String(err) });
    });
  }

  private persistChannelMembership(
    channel: string,
    member: string,
    action: 'join' | 'leave',
    opts?: { invitedBy?: string }
  ): void {
    if (this.storage) {
      this.storage.saveMessage({
        id: crypto.randomUUID(),
        ts: Date.now(),
        from: '__system__',
        to: channel,
        topic: undefined,
        kind: 'state', // membership events stored as state
        body: `${action}:${member}`,
        data: {
          _channelMembership: {
            member,
            action,
            invitedBy: opts?.invitedBy,
          },
        },
        status: 'read',
        is_urgent: false,
        is_broadcast: true,
      }).catch((err) => {
        routerLog.error('Failed to persist channel membership', { error: String(err) });
      });
    }

    if (this.channelMembershipStore) {
      const persistPromise = action === 'leave'
        ? this.channelMembershipStore.removeMember(channel, member)
        : this.channelMembershipStore.addMember(channel, member);

      persistPromise.catch((err) => {
        routerLog.error('Failed to sync channel membership to cloud store', {
          channel,
          member,
          action,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
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
   * Uses case-insensitive lookup to handle mismatched casing.
   * For users with multiple connections, returns the first connection.
   */
  private getConnectionByName(name: string): RoutableConnection | undefined {
    // Try exact match for agent first
    const agentExact = this.agents.get(name);
    if (agentExact) return agentExact;

    // Try exact match for user (get first connection from set)
    const userConnections = this.users.get(name);
    if (userConnections && userConnections.size > 0) {
      return [...userConnections][0];
    }

    // Fall back to case-insensitive search
    const lowerName = name.toLowerCase();
    for (const [key, conn] of this.agents) {
      if (key.toLowerCase() === lowerName) return conn;
    }
    for (const [key, conns] of this.users) {
      if (key.toLowerCase() === lowerName && conns.size > 0) {
        return [...conns][0];
      }
    }
    return undefined;
  }

  /**
   * Check if a member is in a Set (case-insensitive).
   * Returns the actual stored name if found, undefined otherwise.
   */
  private findMemberInSet(members: Set<string>, name: string): string | undefined {
    // Try exact match first
    if (members.has(name)) return name;

    // Fall back to case-insensitive search
    const lowerName = name.toLowerCase();
    for (const member of members) {
      if (member.toLowerCase() === lowerName) return member;
    }
    return undefined;
  }

  /**
   * Check if two names match (case-insensitive).
   */
  private namesMatch(a: string, b: string): boolean {
    return a.toLowerCase() === b.toLowerCase();
  }

  /**
   * Auto-join a member to a channel without notifications.
   * Used for default channel membership (e.g., #general).
   * @param memberName - The agent or user name to add
   * @param channel - The channel to join (e.g., '#general')
   */
  autoJoinChannel(memberName: string, channel: string, options?: { persist?: boolean }): void {
    // Get or create channel
    let members = this.channels.get(channel);
    if (!members) {
      members = new Set();
      this.channels.set(channel, members);
    }

    // Check if already a member
    const added = this.addChannelMember(channel, memberName, { persist: options?.persist });
    if (added) {
      routerLog.debug(`Auto-joined ${memberName} to ${channel}`);
    }
  }

  private addChannelMember(
    channel: string,
    memberName: string,
    options?: { persist?: boolean }
  ): boolean {
    let members = this.channels.get(channel);
    if (!members) {
      members = new Set();
      this.channels.set(channel, members);
    }
    // Case-insensitive check for existing membership
    const existingMember = this.findMemberInSet(members, memberName);
    if (existingMember) {
      return false;
    }
    members.add(memberName);

    const memberChannelSet = this.memberChannels.get(memberName) ?? new Set();
    memberChannelSet.add(channel);
    this.memberChannels.set(memberName, memberChannelSet);

    if (options?.persist ?? true) {
      this.persistChannelMembership(channel, memberName, 'join');
    }

    return true;
  }

  private removeChannelMember(
    channel: string,
    memberName: string,
    options?: { persist?: boolean }
  ): boolean {
    const members = this.channels.get(channel);
    if (!members) {
      return false;
    }

    // Case-insensitive lookup to find actual stored name
    const actualMemberName = this.findMemberInSet(members, memberName);
    if (!actualMemberName) {
      return false;
    }

    members.delete(actualMemberName);
    if (members.size === 0) {
      this.channels.delete(channel);
    }

    // Also try case-insensitive for memberChannels cleanup
    const memberChannelSet = this.memberChannels.get(actualMemberName) ?? this.memberChannels.get(memberName);
    if (memberChannelSet) {
      memberChannelSet.delete(channel);
      if (memberChannelSet.size === 0) {
        this.memberChannels.delete(actualMemberName);
        this.memberChannels.delete(memberName); // Clean up both potential keys
      }
    }

    if (options?.persist ?? true) {
      this.persistChannelMembership(channel, actualMemberName, 'leave');
    }

    return true;
  }

  handleMembershipUpdate(update: { channel: string; member: string; action: 'join' | 'leave' | 'invite' }) {
    if (!update.channel || !update.member) {
      return;
    }

    if (update.action === 'leave') {
      this.removeChannelMember(update.channel, update.member, { persist: false });
    } else {
      this.addChannelMember(update.channel, update.member, { persist: false });
    }
  }

  /**
   * Auto-rejoin an agent to their persisted channels on reconnect.
   * This handles daemon restarts where in-memory channel state is lost.
   * Queries both cloud DB (if available) and SQLite storage for memberships.
   * Uses silent/admin mode to avoid spamming join notifications.
   */
  async autoRejoinChannelsForAgent(agentName: string): Promise<void> {
    const channelsToJoin = new Set<string>();

    // Query cloud DB if available
    if (this.channelMembershipStore?.loadMembershipsForAgent) {
      try {
        const cloudMemberships = await this.channelMembershipStore.loadMembershipsForAgent(agentName);
        for (const membership of cloudMemberships) {
          channelsToJoin.add(membership.channel);
        }
        if (cloudMemberships.length > 0) {
          routerLog.debug(`Found ${cloudMemberships.length} channel memberships for ${agentName} in cloud DB`);
        }
      } catch (err) {
        routerLog.error('Failed to query cloud DB for channel memberships', {
          agentName,
          error: String(err),
        });
      }
    }

    // Query SQLite storage if available
    if (this.storage?.getChannelMembershipsForAgent) {
      try {
        const sqliteMemberships = await this.storage.getChannelMembershipsForAgent(agentName);
        for (const channel of sqliteMemberships) {
          channelsToJoin.add(channel);
        }
        if (sqliteMemberships.length > 0) {
          routerLog.debug(`Found ${sqliteMemberships.length} channel memberships for ${agentName} in SQLite`);
        }
      } catch (err) {
        routerLog.error('Failed to query SQLite for channel memberships', {
          agentName,
          error: String(err),
        });
      }
    }

    if (channelsToJoin.size === 0) {
      routerLog.debug(`No persisted channel memberships found for ${agentName}`);
      return;
    }

    // Rejoin channels silently (don't notify other members)
    let rejoinedCount = 0;
    for (const channel of channelsToJoin) {
      // Skip if already in channel (handles deduplication)
      const members = this.channels.get(channel);
      if (members && this.findMemberInSet(members, agentName)) {
        routerLog.debug(`${agentName} already in ${channel}, skipping auto-rejoin`);
        continue;
      }

      // Add to channel without persisting (already persisted) or notifying
      const added = this.addChannelMember(channel, agentName, { persist: false });
      if (added) {
        rejoinedCount++;
      }
    }

    if (rejoinedCount > 0) {
      routerLog.info(`Auto-rejoined ${agentName} to ${rejoinedCount} channels`, {
        channels: Array.from(channelsToJoin),
      });
    }
  }
}
