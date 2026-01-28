/**
 * Typed Event Definitions for Agent Relay Wrapper
 *
 * Inspired by opencode's BusEvent pattern, this provides type-safe event
 * definitions with Zod schema validation. Events can be used for:
 * - Wrapper internal notifications
 * - SDK client subscriptions
 * - OpenAPI spec generation
 *
 * @example
 * ```typescript
 * import { RelayEvent, emitEvent, onEvent } from './wrapper-events.js';
 *
 * // Subscribe to events
 * onEvent(RelayEvent.AgentConnected, (event) => {
 *   console.log(`Agent ${event.properties.agentName} connected`);
 * });
 *
 * // Emit events
 * emitEvent(RelayEvent.AgentConnected, {
 *   agentName: 'MyAgent',
 *   connectionId: 'abc123',
 * });
 * ```
 */

import { z } from 'zod';
import { EventEmitter } from 'node:events';

// =========================================================================
// Event Definition Factory
// =========================================================================

/**
 * Event definition with type and schema
 */
export interface EventDefinition<
  Type extends string = string,
  Schema extends z.ZodType = z.ZodType
> {
  type: Type;
  schema: Schema;
}

/**
 * Define a typed event with Zod schema validation
 */
export function defineEvent<Type extends string, Schema extends z.ZodType>(
  type: Type,
  schema: Schema
): EventDefinition<Type, Schema> {
  return { type, schema };
}

/**
 * Infer the properties type from an event definition
 */
export type EventProperties<E extends EventDefinition> = z.infer<E['schema']>;

/**
 * Event payload with type and properties
 */
export interface EventPayload<E extends EventDefinition = EventDefinition> {
  type: E['type'];
  properties: EventProperties<E>;
  timestamp: number;
}

// =========================================================================
// Daemon Event Definitions
// =========================================================================

export namespace RelayEvent {
  // --- Agent Lifecycle Events ---

  export const AgentConnected = defineEvent(
    'daemon.agent.connected',
    z.object({
      agentName: z.string(),
      connectionId: z.string(),
      cli: z.string().optional(),
      task: z.string().optional(),
      workingDirectory: z.string().optional(),
    })
  );

  export const AgentDisconnected = defineEvent(
    'daemon.agent.disconnected',
    z.object({
      agentName: z.string(),
      connectionId: z.string(),
      reason: z.enum(['clean', 'error', 'timeout', 'replaced']).optional(),
    })
  );

  export const AgentSpawned = defineEvent(
    'daemon.agent.spawned',
    z.object({
      agentName: z.string(),
      parentAgent: z.string(),
      cli: z.string(),
      task: z.string(),
    })
  );

  export const AgentReleased = defineEvent(
    'daemon.agent.released',
    z.object({
      agentName: z.string(),
      releasedBy: z.string(),
    })
  );

  // --- Message Events ---

  export const MessageRouted = defineEvent(
    'daemon.message.routed',
    z.object({
      messageId: z.string(),
      from: z.string(),
      to: z.string(),
      kind: z.string().optional(),
      bodyPreview: z.string().optional(),
    })
  );

  export const MessageDelivered = defineEvent(
    'daemon.message.delivered',
    z.object({
      messageId: z.string(),
      to: z.string(),
      deliverySeq: z.number(),
    })
  );

  export const MessageFailed = defineEvent(
    'daemon.message.failed',
    z.object({
      messageId: z.string(),
      to: z.string(),
      error: z.string(),
    })
  );

  // --- Channel Events ---

  export const ChannelJoined = defineEvent(
    'daemon.channel.joined',
    z.object({
      channel: z.string(),
      member: z.string(),
    })
  );

  export const ChannelLeft = defineEvent(
    'daemon.channel.left',
    z.object({
      channel: z.string(),
      member: z.string(),
    })
  );

  export const ChannelMessage = defineEvent(
    'daemon.channel.message',
    z.object({
      channel: z.string(),
      from: z.string(),
      bodyPreview: z.string().optional(),
    })
  );

  // --- Processing State Events ---

  export const AgentProcessingStarted = defineEvent(
    'daemon.agent.processing.started',
    z.object({
      agentName: z.string(),
      messageId: z.string(),
    })
  );

  export const AgentProcessingEnded = defineEvent(
    'daemon.agent.processing.ended',
    z.object({
      agentName: z.string(),
      durationMs: z.number().optional(),
    })
  );

  // --- Shadow Events ---

  export const ShadowBound = defineEvent(
    'daemon.shadow.bound',
    z.object({
      shadowAgent: z.string(),
      primaryAgent: z.string(),
      speakOn: z.array(z.string()),
    })
  );

  export const ShadowUnbound = defineEvent(
    'daemon.shadow.unbound',
    z.object({
      shadowAgent: z.string(),
      primaryAgent: z.string(),
    })
  );

  // --- System Events ---

  export const DaemonStarted = defineEvent(
    'daemon.system.started',
    z.object({
      socketPath: z.string(),
      version: z.string().optional(),
    })
  );

  export const DaemonStopped = defineEvent(
    'daemon.system.stopped',
    z.object({
      reason: z.string().optional(),
    })
  );

  export const RateLimitExceeded = defineEvent(
    'daemon.system.rate_limit_exceeded',
    z.object({
      agentName: z.string(),
    })
  );

  // --- All event definitions for iteration ---

  export const all = [
    AgentConnected,
    AgentDisconnected,
    AgentSpawned,
    AgentReleased,
    MessageRouted,
    MessageDelivered,
    MessageFailed,
    ChannelJoined,
    ChannelLeft,
    ChannelMessage,
    AgentProcessingStarted,
    AgentProcessingEnded,
    ShadowBound,
    ShadowUnbound,
    DaemonStarted,
    DaemonStopped,
    RateLimitExceeded,
  ] as const;
}

// =========================================================================
// Event Bus
// =========================================================================

/**
 * Type-safe event bus for daemon events
 */
class RelayEventBus extends EventEmitter {
  private static instance: RelayEventBus;

  private constructor() {
    super();
    this.setMaxListeners(100); // Allow many subscribers
  }

  static getInstance(): RelayEventBus {
    if (!RelayEventBus.instance) {
      RelayEventBus.instance = new RelayEventBus();
    }
    return RelayEventBus.instance;
  }

  /**
   * Emit a typed event
   */
  emitEvent<E extends EventDefinition>(
    definition: E,
    properties: EventProperties<E>
  ): void {
    const payload: EventPayload<E> = {
      type: definition.type,
      properties,
      timestamp: Date.now(),
    };

    // Validate properties against schema
    const result = definition.schema.safeParse(properties);
    if (!result.success) {
      console.error(`[RelayEventBus] Invalid event properties for ${definition.type}:`, result.error);
      return;
    }

    // Emit to specific subscribers and wildcard subscribers
    this.emit(definition.type, payload);
    this.emit('*', payload);
  }

  /**
   * Subscribe to a typed event
   */
  onEvent<E extends EventDefinition>(
    definition: E,
    callback: (event: EventPayload<E>) => void
  ): () => void {
    this.on(definition.type, callback);
    return () => this.off(definition.type, callback);
  }

  /**
   * Subscribe to all events (wildcard)
   */
  onAnyEvent(callback: (event: EventPayload) => void): () => void {
    this.on('*', callback);
    return () => this.off('*', callback);
  }

  /**
   * Subscribe to an event once
   */
  onceEvent<E extends EventDefinition>(
    definition: E,
    callback: (event: EventPayload<E>) => void
  ): void {
    this.once(definition.type, callback);
  }
}

// =========================================================================
// Exports
// =========================================================================

/**
 * Global daemon event bus instance
 */
export const relayEventBus = RelayEventBus.getInstance();

/**
 * Emit a daemon event
 */
export function emitEvent<E extends EventDefinition>(
  definition: E,
  properties: EventProperties<E>
): void {
  relayEventBus.emitEvent(definition, properties);
}

/**
 * Subscribe to a daemon event
 */
export function onEvent<E extends EventDefinition>(
  definition: E,
  callback: (event: EventPayload<E>) => void
): () => void {
  return relayEventBus.onEvent(definition, callback);
}

/**
 * Subscribe to all daemon events
 */
export function onAnyEvent(callback: (event: EventPayload) => void): () => void {
  return relayEventBus.onAnyEvent(callback);
}

// =========================================================================
// OpenAPI Schema Generation
// =========================================================================

/**
 * Generate OpenAPI-compatible schema for all daemon events
 * This can be used to auto-generate SDK types
 */
export function generateEventSchemas(): Record<string, unknown> {
  const schemas: Record<string, unknown> = {};

  for (const definition of RelayEvent.all) {
    // Extract JSON Schema from Zod schema
    // Note: This is a simplified version - production use should use zod-to-json-schema
    schemas[definition.type] = {
      type: 'object',
      properties: {
        type: { type: 'string', const: definition.type },
        properties: definition.schema._def, // Simplified - use zod-to-json-schema for production
        timestamp: { type: 'number' },
      },
      required: ['type', 'properties', 'timestamp'],
    };
  }

  return schemas;
}
