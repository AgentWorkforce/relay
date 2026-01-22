/**
 * Channel and User Protocol Types
 *
 * Extends the Agent Relay Protocol to support:
 * - First-class user entities (humans, not just AI agents)
 * - Channels for group communication
 * - Direct messaging between any combination of users and agents
 */

import { generateId } from './id-generator.js';
import {
  PROTOCOL_VERSION,
  type EntityType,
  type MessageAttachment,
  type ChannelJoinPayload,
  type ChannelLeavePayload,
  type ChannelMessagePayload,
  type ChannelJoinEnvelope,
  type ChannelLeaveEnvelope,
  type ChannelMessageEnvelope,
} from './types.js';

// Re-export commonly-used channel payload types for convenience
export type {
  MessageAttachment,
  ChannelJoinPayload,
  ChannelLeavePayload,
  ChannelMessagePayload,
  ChannelJoinEnvelope,
  ChannelLeaveEnvelope,
  ChannelMessageEnvelope,
} from './types.js';

// Re-export for convenience
export { PROTOCOL_VERSION };
// EntityType is already exported from types.js, don't re-export here

/**
 * Extended message types for channels.
 */
export type ChannelMessageType =
  | 'CHANNEL_JOIN'
  | 'CHANNEL_LEAVE'
  | 'CHANNEL_MESSAGE'
  | 'CHANNEL_INFO'
  | 'CHANNEL_MEMBERS'
  | 'CHANNEL_TYPING';

/**
 * Channel member info.
 */
export interface ChannelMember {
  name: string;
  entityType: EntityType;
  displayName?: string;
  avatarUrl?: string;
  status?: 'online' | 'away' | 'offline';
}

/**
 * Payload for CHANNEL_INFO.
 * Contains metadata about a channel.
 */
export interface ChannelInfoPayload {
  /** Channel identifier */
  channel: string;
  /** Human-readable channel name */
  name: string;
  /** Optional description */
  description?: string;
  /** Optional current topic */
  topic?: string;
  /** List of members */
  members: ChannelMember[];
  /** When the channel was created */
  createdAt: string;
  /** Whether the channel is private */
  isPrivate?: boolean;
}

/**
 * Payload for CHANNEL_MEMBERS.
 * List of members in a channel.
 */
export interface ChannelMembersPayload {
  channel: string;
  members: ChannelMember[];
}

/**
 * Payload for CHANNEL_TYPING.
 * Indicates someone is typing in a channel.
 */
export interface ChannelTypingPayload {
  channel: string;
  isTyping: boolean;
}

/**
 * Check if an entity type represents a user.
 */
export function isUserEntity(entityType: EntityType | undefined): boolean {
  return entityType === 'user';
}

/**
 * Check if an entity type represents an agent.
 * Undefined defaults to agent for backwards compatibility.
 */
export function isAgentEntity(entityType: EntityType | undefined): boolean {
  return entityType === 'agent' || entityType === undefined;
}

/**
 * Type guard to check if an envelope is a channel message.
 */
export function isChannelMessage(envelope: { type: string }): envelope is ChannelMessageEnvelope {
  return envelope.type === 'CHANNEL_MESSAGE';
}

/**
 * Type guard to check if an envelope is a channel join.
 */
export function isChannelJoin(envelope: { type: string }): envelope is ChannelJoinEnvelope {
  return envelope.type === 'CHANNEL_JOIN';
}

/**
 * Type guard to check if an envelope is a channel leave.
 */
export function isChannelLeave(envelope: { type: string }): envelope is ChannelLeaveEnvelope {
  return envelope.type === 'CHANNEL_LEAVE';
}

/**
 * Create a CHANNEL_JOIN envelope.
 */
export function createChannelJoinEnvelope(
  from: string,
  channel: string,
  options?: { displayName?: string; avatarUrl?: string }
): ChannelJoinEnvelope {
  return {
    v: PROTOCOL_VERSION,
    type: 'CHANNEL_JOIN',
    id: generateId(),
    ts: Date.now(),
    from,
    payload: {
      channel,
      displayName: options?.displayName,
      avatarUrl: options?.avatarUrl,
    },
  };
}

/**
 * Create a CHANNEL_LEAVE envelope.
 */
export function createChannelLeaveEnvelope(
  from: string,
  channel: string,
  reason?: string
): ChannelLeaveEnvelope {
  return {
    v: PROTOCOL_VERSION,
    type: 'CHANNEL_LEAVE',
    id: generateId(),
    ts: Date.now(),
    from,
    payload: {
      channel,
      reason,
    },
  };
}

/**
 * Create a CHANNEL_MESSAGE envelope.
 */
export function createChannelMessageEnvelope(
  from: string,
  channel: string,
  body: string,
  options?: {
    thread?: string;
    mentions?: string[];
    attachments?: MessageAttachment[];
    data?: Record<string, unknown>;
  }
): ChannelMessageEnvelope {
  return {
    v: PROTOCOL_VERSION,
    type: 'CHANNEL_MESSAGE',
    id: generateId(),
    ts: Date.now(),
    from,
    payload: {
      channel,
      body,
      thread: options?.thread,
      mentions: options?.mentions,
      attachments: options?.attachments,
      data: options?.data,
    },
  };
}

/**
 * Parse a DM channel name to extract participants.
 * DM channels follow the format: dm:<participant1>:<participant2>:...
 */
export function parseDmChannel(channel: string): string[] | null {
  if (!channel.startsWith('dm:')) {
    return null;
  }
  const parts = channel.split(':').slice(1);
  return parts.length >= 2 ? parts : null;
}

/**
 * Create a DM channel name from participants.
 * Participants are sorted alphabetically for consistency.
 */
export function createDmChannelName(...participants: string[]): string {
  if (participants.length < 2) {
    throw new Error('DM requires at least 2 participants');
  }
  const sorted = [...participants].sort();
  return `dm:${sorted.join(':')}`;
}

/**
 * Check if a channel is a DM (direct message).
 */
export function isDmChannel(channel: string): boolean {
  return channel.startsWith('dm:');
}

/**
 * Check if a channel is private.
 */
export function isPrivateChannel(channel: string): boolean {
  return channel.startsWith('private:');
}

/**
 * Check if a channel is a public channel (starts with #).
 */
export function isPublicChannel(channel: string): boolean {
  return channel.startsWith('#');
}

/**
 * Normalize channel name for storage/lookup.
 * - Removes leading # from public channels
 * - Sorts participants in DM channels
 */
export function normalizeChannelName(channel: string): string {
  if (channel.startsWith('#')) {
    return channel.slice(1);
  }
  if (channel.startsWith('dm:')) {
    const participants = parseDmChannel(channel);
    if (participants) {
      return createDmChannelName(...participants);
    }
  }
  return channel;
}
