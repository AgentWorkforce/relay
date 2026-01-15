/**
 * Mock API Service for Channels V1
 *
 * Provides mock implementations of the channel APIs for development.
 * Replace with real API calls when backend is ready.
 */

import type {
  Channel,
  ChannelMember,
  ChannelMessage,
  ListChannelsResponse,
  GetChannelResponse,
  GetMessagesResponse,
  CreateChannelRequest,
  CreateChannelResponse,
  SendMessageRequest,
  SendMessageResponse,
} from './types';

import {
  MOCK_CHANNELS,
  MOCK_ARCHIVED_CHANNELS,
  MOCK_MESSAGES,
} from './types';

// Only seed demo data when explicitly enabled (prevents example channels in cloud)
const ENABLE_DEMO_DATA = process.env.NEXT_PUBLIC_ENABLE_CHANNEL_DEMO === 'true';

function getInitialChannels(): Channel[] {
  return ENABLE_DEMO_DATA ? [...MOCK_CHANNELS] : [];
}

function getInitialArchivedChannels(): Channel[] {
  return ENABLE_DEMO_DATA ? [...MOCK_ARCHIVED_CHANNELS] : [];
}

function getInitialMessages(): ChannelMessage[] {
  return ENABLE_DEMO_DATA ? [...MOCK_MESSAGES] : [];
}

// Simulated latency for realistic UX
const MOCK_LATENCY_MS = 300;

// In-memory state
let channels = getInitialChannels();
let archivedChannels = getInitialArchivedChannels();
let messages = getInitialMessages();
let messageIdCounter = ENABLE_DEMO_DATA ? 100 : 0;

/**
 * Simulate network latency
 */
async function delay(ms: number = MOCK_LATENCY_MS): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Generate a unique message ID
 */
function generateMessageId(): string {
  return `msg-${++messageIdCounter}`;
}

/**
 * Mock: List channels for current user
 */
export async function listChannels(): Promise<ListChannelsResponse> {
  await delay();
  return {
    channels: [...channels],
    archivedChannels: [...archivedChannels],
  };
}

/**
 * Mock: Get channel details
 */
export async function getChannel(channelId: string): Promise<GetChannelResponse> {
  await delay();

  const channel = [...channels, ...archivedChannels].find(c => c.id === channelId);
  if (!channel) {
    throw new Error(`Channel not found: ${channelId}`);
  }

  // Generate mock members
  const mockMembers: ChannelMember[] = [
    {
      id: 'Lead',
      displayName: 'Lead Agent',
      entityType: 'agent',
      role: 'owner',
      status: 'online',
      joinedAt: channel.createdAt,
    },
    {
      id: 'Frontend',
      displayName: 'Frontend Engineer',
      entityType: 'agent',
      role: 'member',
      status: 'online',
      joinedAt: channel.createdAt,
    },
    {
      id: 'CodeReviewer',
      displayName: 'Code Reviewer',
      entityType: 'agent',
      role: 'member',
      status: 'away',
      joinedAt: channel.createdAt,
    },
  ];

  return {
    channel,
    members: mockMembers,
  };
}

/**
 * Mock: Get messages in a channel
 */
export async function getMessages(
  channelId: string,
  options?: { before?: string; limit?: number; threadId?: string }
): Promise<GetMessagesResponse> {
  await delay();

  const limit = options?.limit || 50;
  let channelMessages = messages.filter(m => m.channelId === channelId);

  if (options?.threadId) {
    channelMessages = channelMessages.filter(m =>
      m.threadId === options.threadId || m.id === options.threadId
    );
  }

  if (options?.before) {
    const beforeIndex = channelMessages.findIndex(m => m.id === options.before);
    if (beforeIndex > 0) {
      channelMessages = channelMessages.slice(0, beforeIndex);
    }
  }

  const result = channelMessages.slice(-limit);

  // Calculate unread state (mock: last 2 messages are unread)
  const unreadCount = Math.min(2, result.filter(m => !m.isRead).length);
  const firstUnread = result.find(m => !m.isRead);

  return {
    messages: result,
    hasMore: channelMessages.length > limit,
    unread: {
      count: unreadCount,
      firstUnreadMessageId: firstUnread?.id,
    },
  };
}

/**
 * Mock: Create a channel
 */
export async function createChannel(
  request: CreateChannelRequest
): Promise<CreateChannelResponse> {
  await delay();

  const newChannel: Channel = {
    id: `#${request.name}`,
    name: request.name,
    description: request.description,
    visibility: request.visibility,
    status: 'active',
    createdAt: new Date().toISOString(),
    createdBy: 'CurrentUser',
    memberCount: 1,
    unreadCount: 0,
    hasMentions: false,
    isDm: false,
  };

  channels.push(newChannel);

  return { channel: newChannel };
}

/**
 * Mock: Send a message
 */
export async function sendMessage(
  channelId: string,
  request: SendMessageRequest
): Promise<SendMessageResponse> {
  await delay(100); // Fast for good UX

  const newMessage: ChannelMessage = {
    id: generateMessageId(),
    channelId,
    from: 'CurrentUser',
    fromEntityType: 'user',
    content: request.content,
    timestamp: new Date().toISOString(),
    threadId: request.threadId,
    isRead: true,
  };

  messages.push(newMessage);

  // Update channel's last activity
  const channel = channels.find(c => c.id === channelId);
  if (channel) {
    channel.lastActivityAt = newMessage.timestamp;
    channel.lastMessage = {
      content: request.content.slice(0, 100),
      from: 'CurrentUser',
      timestamp: newMessage.timestamp,
    };
  }

  return { message: newMessage };
}

/**
 * Mock: Join a channel
 */
export async function joinChannel(channelId: string): Promise<Channel> {
  await delay();

  const channel = channels.find(c => c.id === channelId);
  if (!channel) {
    throw new Error(`Channel not found: ${channelId}`);
  }

  channel.memberCount++;
  return channel;
}

/**
 * Mock: Leave a channel
 */
export async function leaveChannel(channelId: string): Promise<void> {
  await delay();

  const channelIndex = channels.findIndex(c => c.id === channelId);
  if (channelIndex >= 0) {
    channels[channelIndex].memberCount--;
    // Optionally remove from list if member count is personal preference
  }
}

/**
 * Mock: Archive a channel
 */
export async function archiveChannel(channelId: string): Promise<Channel> {
  await delay();

  const channelIndex = channels.findIndex(c => c.id === channelId);
  if (channelIndex < 0) {
    throw new Error(`Channel not found: ${channelId}`);
  }

  const channel = channels[channelIndex];
  channel.status = 'archived';
  channels.splice(channelIndex, 1);
  archivedChannels.push(channel);

  return channel;
}

/**
 * Mock: Unarchive a channel
 */
export async function unarchiveChannel(channelId: string): Promise<Channel> {
  await delay();

  const channelIndex = archivedChannels.findIndex(c => c.id === channelId);
  if (channelIndex < 0) {
    throw new Error(`Channel not found: ${channelId}`);
  }

  const channel = archivedChannels[channelIndex];
  channel.status = 'active';
  archivedChannels.splice(channelIndex, 1);
  channels.push(channel);

  return channel;
}

/**
 * Mock: Delete a channel
 */
export async function deleteChannel(channelId: string): Promise<void> {
  await delay();

  channels = channels.filter(c => c.id !== channelId);
  archivedChannels = archivedChannels.filter(c => c.id !== channelId);
  messages = messages.filter(m => m.channelId !== channelId);
}

/**
 * Mock: Mark messages as read
 */
export async function markRead(
  channelId: string,
  upToTimestamp: string
): Promise<void> {
  await delay(50);

  const channelMessages = messages.filter(m => m.channelId === channelId);
  const upToTime = new Date(upToTimestamp).getTime();

  channelMessages.forEach(m => {
    if (new Date(m.timestamp).getTime() <= upToTime) {
      m.isRead = true;
    }
  });

  // Update channel unread count
  const channel = channels.find(c => c.id === channelId);
  if (channel) {
    channel.unreadCount = channelMessages.filter(m => !m.isRead).length;
    channel.hasMentions = false;
  }
}

/**
 * Mock: Get mention suggestions
 */
export async function getMentionSuggestions(): Promise<string[]> {
  await delay(50);
  return ['Lead', 'Frontend', 'CodeReviewer', 'Backend', 'DevOps', 'QA'];
}

/**
 * Reset mock state (for testing)
 */
export function resetMockState(): void {
  channels = getInitialChannels();
  archivedChannels = getInitialArchivedChannels();
  messages = getInitialMessages();
  messageIdCounter = ENABLE_DEMO_DATA ? 100 : 0;
}
