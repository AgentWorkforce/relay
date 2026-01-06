/**
 * Channel and User Protocol Types
 *
 * Extends the Agent Relay Protocol to support:
 * - First-class user entities (humans, not just AI agents)
 * - Channels for group communication
 * - Direct messaging between any combination of users and agents
 */

import { v4 as uuid } from 'uuid';
import { PROTOCOL_VERSION, type Envelope } from './types.js';

// Re-export PROTOCOL_VERSION for convenience
export { PROTOCOL_VERSION };

/**
 * Entity types in the relay system.
 * - 'agent': AI agent (Claude, GPT, etc.)
 * - 'user': Human user (via dashboard)
 */
export type EntityType = 'agent' | 'user';

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
 * Attachment metadata for messages.
 */
export interface MessageAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  url?: string;
  data?: string; // Base64 for inline
}

/**
 * Payload for CHANNEL_JOIN message.
 * Sent when a user or agent joins a channel.
 */
export interface ChannelJoinPayload {
  /** The channel to join (e.g., '#general', 'dm:alice:bob') */
  channel: string;
  /** Optional display name for the channel member list */
  displayName?: string;
  /** Optional avatar URL */
  avatarUrl?: string;
}

/**
 * Payload for CHANNEL_LEAVE message.
 * Sent when a user or agent leaves a channel.
 */
export interface ChannelLeavePayload {
  /** The channel to leave */
  channel: string;
  /** Optional reason for leaving */
  reason?: string;
}

/**
 * Payload for CHANNEL_MESSAGE.
 * Sent when posting a message to a channel.
 */
export interface ChannelMessagePayload {
  /** The target channel */
  channel: string;
  /** Message content */
  body: string;
  /** Optional thread ID for threaded replies */
  thread?: string;
  /** Optional attachments */
  attachments?: MessageAttachment[];
  /** Optional metadata */
  data?: Record<string, unknown>;
  /** Optional list of mentioned users/agents */
  mentions?: string[];
}

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

// Typed envelopes
export type ChannelJoinEnvelope = Envelope<ChannelJoinPayload> & { type: 'CHANNEL_JOIN' };
export type ChannelLeaveEnvelope = Envelope<ChannelLeavePayload> & { type: 'CHANNEL_LEAVE' };
export type ChannelMessageEnvelope = Envelope<ChannelMessagePayload> & { type: 'CHANNEL_MESSAGE' };
export type ChannelInfoEnvelope = Envelope<ChannelInfoPayload> & { type: 'CHANNEL_INFO' };

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
    id: uuid(),
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
    id: uuid(),
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
    id: uuid(),
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
