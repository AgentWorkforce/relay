/**
 * Business logic engine for the Headless Slack MCP Server.
 *
 * Wraps Storage with validation, access control, and convenience methods.
 * All methods take an agentId (resolved from the MCP session) except register().
 *
 * Key design decisions (from Slack/Discord research):
 * - DMs are just channels with channel_type = DM (Slack's unified conversation model)
 * - Threads use thread_id pointing to parent message (Slack's thread_ts pattern)
 * - Read state is per-agent, per-channel via last_read_id (Snowflake cursor)
 * - Persist-first: messages are stored before any notification
 */

import { Storage } from './storage.js';
import {
  ChannelType,
  type Agent,
  type Channel,
  type Message,
  type InboxResult,
  type GetMessagesOptions,
  type SearchOptions,
  type ReactionSummary,
} from './types.js';

export class Engine {
  constructor(
    private storage: Storage,
    private defaultWorkspaceName: string = 'default',
  ) {}

  // =========================================================================
  // Registration
  // =========================================================================

  /**
   * Register an agent in the workspace. Creates the workspace and #general
   * channel if they don't exist. Auto-joins the agent to #general.
   */
  register(
    agentName: string,
    persona?: string,
    workspaceName?: string,
  ): { agent: Agent; workspace: { id: string; name: string }; channels: Channel[] } {
    const wsName = workspaceName ?? this.defaultWorkspaceName;

    // Find or create workspace
    let workspace = this.storage.getWorkspaceByName(wsName);
    if (!workspace) {
      workspace = this.storage.createWorkspace(wsName);
    }

    // Find or create agent
    let agent = this.storage.getAgent(workspace.id, agentName);
    if (agent) {
      this.storage.updateAgentStatus(agent.id, 'online');
    } else {
      agent = this.storage.createAgent(workspace.id, agentName, persona);
    }

    // Ensure #general channel exists
    let general = this.storage.getChannel(workspace.id, 'general');
    if (!general) {
      general = this.storage.createChannel(
        workspace.id,
        'general',
        agent.id,
        ChannelType.TEXT,
        'General discussion',
      );
    }

    // Auto-join #general
    this.storage.addChannelMember(general.id, agent.id, 'member');

    // Return agent's channels
    const channels = this.storage.getAgentChannels(agent.id);

    return { agent, workspace: { id: workspace.id, name: workspace.name }, channels };
  }

  // =========================================================================
  // Channels
  // =========================================================================

  createChannel(agentId: string, name: string, topic?: string): Channel {
    const agent = this.requireAgent(agentId);
    const normalized = name.replace(/^#/, '').toLowerCase().replace(/\s+/g, '-');

    const existing = this.storage.getChannel(agent.workspace_id, normalized);
    if (existing) {
      throw new Error(`Channel #${normalized} already exists`);
    }

    const channel = this.storage.createChannel(
      agent.workspace_id,
      normalized,
      agentId,
      ChannelType.TEXT,
      topic,
    );

    // Creator auto-joins as owner
    this.storage.addChannelMember(channel.id, agentId, 'owner');
    return channel;
  }

  listChannels(agentId: string, includeArchived?: boolean): Channel[] {
    const agent = this.requireAgent(agentId);
    return this.storage.listChannels(
      agent.workspace_id,
      includeArchived,
      ChannelType.TEXT,
    );
  }

  joinChannel(agentId: string, channelName: string): Channel {
    const agent = this.requireAgent(agentId);
    const channel = this.requireChannel(agent.workspace_id, channelName);

    if (channel.is_archived) {
      throw new Error(`Channel #${channelName} is archived`);
    }

    this.storage.addChannelMember(channel.id, agentId, 'member');
    return channel;
  }

  leaveChannel(agentId: string, channelName: string): void {
    const agent = this.requireAgent(agentId);
    const channel = this.requireChannel(agent.workspace_id, channelName);
    this.storage.removeChannelMember(channel.id, agentId);
  }

  inviteToChannel(
    agentId: string,
    channelName: string,
    targetAgentName: string,
  ): void {
    const agent = this.requireAgent(agentId);
    const channel = this.requireChannel(agent.workspace_id, channelName);
    this.requireMembership(channel.id, agentId);

    const target = this.storage.getAgent(agent.workspace_id, targetAgentName);
    if (!target) {
      throw new Error(`Agent "${targetAgentName}" not found`);
    }

    this.storage.addChannelMember(channel.id, target.id, 'member');
  }

  setChannelTopic(
    agentId: string,
    channelName: string,
    topic: string,
  ): Channel {
    const agent = this.requireAgent(agentId);
    const channel = this.requireChannel(agent.workspace_id, channelName);
    this.requireMembership(channel.id, agentId);

    this.storage.setChannelTopic(channel.id, topic);
    return { ...channel, topic };
  }

  archiveChannel(agentId: string, channelName: string): void {
    const agent = this.requireAgent(agentId);
    const channel = this.requireChannel(agent.workspace_id, channelName);
    this.requireMembership(channel.id, agentId);
    this.storage.archiveChannel(channel.id);
  }

  // =========================================================================
  // Messages
  // =========================================================================

  /**
   * Post a message to a channel. Agent must be a member.
   * Returns the created message (persist-first pattern).
   */
  postMessage(agentId: string, channelName: string, text: string): Message {
    const agent = this.requireAgent(agentId);
    const channel = this.requireChannel(agent.workspace_id, channelName);
    this.requireMembership(channel.id, agentId);

    if (channel.is_archived) {
      throw new Error(`Channel #${channelName} is archived`);
    }

    return this.storage.createMessage(
      agent.workspace_id,
      channel.id,
      agentId,
      text,
    );
  }

  /**
   * Reply to a thread. Creates or continues a thread on the parent message.
   */
  replyToThread(
    agentId: string,
    threadId: string,
    text: string,
  ): Message {
    const agent = this.requireAgent(agentId);

    // Verify parent message exists
    const parent = this.storage.getMessage(threadId);
    if (!parent) {
      throw new Error(`Message "${threadId}" not found`);
    }

    // Use the root thread ID (in case someone replies to a reply)
    const rootThreadId = parent.thread_id ?? parent.id;

    // Verify agent is a member of the channel
    this.requireMembership(parent.channel_id, agentId);

    return this.storage.createMessage(
      agent.workspace_id,
      parent.channel_id,
      agentId,
      text,
      rootThreadId,
    );
  }

  /**
   * Get messages from a channel with cursor-based pagination.
   * Also marks the channel as read for the requesting agent.
   */
  getMessages(
    agentId: string,
    channelName: string,
    options?: GetMessagesOptions,
  ): Message[] {
    const agent = this.requireAgent(agentId);
    const channel = this.requireChannel(agent.workspace_id, channelName);
    this.requireMembership(channel.id, agentId);

    const messages = this.storage.getMessages(channel.id, options);
    const enriched = this.storage.enrichMessages(messages);

    // Mark as read (last message ID)
    if (enriched.length > 0) {
      const lastId = enriched[enriched.length - 1].id;
      this.storage.updateLastRead(channel.id, agentId, lastId);
    }

    return enriched;
  }

  /**
   * Get all messages in a thread (parent + replies).
   */
  getThread(agentId: string, threadId: string): Message[] {
    this.requireAgent(agentId);

    const parent = this.storage.getMessage(threadId);
    if (!parent) {
      throw new Error(`Message "${threadId}" not found`);
    }

    this.requireMembership(parent.channel_id, agentId);

    const messages = this.storage.getThread(threadId);
    return this.storage.enrichMessages(messages);
  }

  // =========================================================================
  // Direct Messages
  // =========================================================================

  /**
   * Send a DM. Creates or reuses a DM channel between the two agents.
   * DM channels are named dm:{sorted_name1}:{sorted_name2}.
   */
  sendDm(agentId: string, targetAgentName: string, text: string): Message {
    const agent = this.requireAgent(agentId);
    const target = this.storage.getAgent(agent.workspace_id, targetAgentName);
    if (!target) {
      throw new Error(`Agent "${targetAgentName}" not found`);
    }

    const channel = this.findOrCreateDmChannel(agent, target);
    return this.storage.createMessage(
      agent.workspace_id,
      channel.id,
      agentId,
      text,
    );
  }

  /**
   * Get DM history with another agent.
   */
  getDms(
    agentId: string,
    targetAgentName: string,
    options?: GetMessagesOptions,
  ): Message[] {
    const agent = this.requireAgent(agentId);
    const target = this.storage.getAgent(agent.workspace_id, targetAgentName);
    if (!target) {
      throw new Error(`Agent "${targetAgentName}" not found`);
    }

    const dmName = this.dmChannelName(agent.name, target.name);
    const channel = this.storage.getChannel(agent.workspace_id, dmName);
    if (!channel) {
      return []; // No DM history
    }

    const messages = this.storage.getMessages(channel.id, options);
    const enriched = this.storage.enrichMessages(messages);

    // Mark as read
    if (enriched.length > 0) {
      const lastId = enriched[enriched.length - 1].id;
      this.storage.updateLastRead(channel.id, agentId, lastId);
    }

    return enriched;
  }

  // =========================================================================
  // Reactions
  // =========================================================================

  addReaction(
    agentId: string,
    messageId: string,
    emoji: string,
  ): ReactionSummary[] {
    this.requireAgent(agentId);

    const message = this.storage.getMessage(messageId);
    if (!message) {
      throw new Error(`Message "${messageId}" not found`);
    }

    this.requireMembership(message.channel_id, agentId);
    this.storage.addReaction(messageId, agentId, emoji);
    return this.storage.getReactions(messageId);
  }

  removeReaction(
    agentId: string,
    messageId: string,
    emoji: string,
  ): void {
    this.requireAgent(agentId);

    const message = this.storage.getMessage(messageId);
    if (!message) {
      throw new Error(`Message "${messageId}" not found`);
    }

    const removed = this.storage.removeReaction(messageId, agentId, emoji);
    if (!removed) {
      throw new Error('Reaction not found');
    }
  }

  // =========================================================================
  // Search
  // =========================================================================

  searchMessages(agentId: string, options: SearchOptions): Message[] {
    const agent = this.requireAgent(agentId);

    // Resolve channel name to ID if provided
    let resolvedOptions = { ...options };
    if (options.channel_id) {
      const channel = this.requireChannel(agent.workspace_id, options.channel_id);
      resolvedOptions = { ...options, channel_id: channel.id };
    }

    const messages = this.storage.searchMessages(
      agent.workspace_id,
      resolvedOptions,
    );
    return this.storage.enrichMessages(messages);
  }

  // =========================================================================
  // Inbox
  // =========================================================================

  /**
   * Check inbox: unread channels, mentions, and unread DMs.
   * This is the core method agents should call regularly.
   */
  checkInbox(agentId: string): InboxResult {
    const agent = this.requireAgent(agentId);
    this.storage.touchAgent(agentId);

    const unreads = this.storage.getUnreadCounts(agentId);
    const mentions = this.storage.getMentions(agentId, agent.name);

    return {
      unread_channels: unreads
        .filter((u) => u.channel_type === ChannelType.TEXT)
        .map((u) => ({
          channel_id: u.channel_id,
          channel_name: u.channel_name,
          channel_type: u.channel_type as ChannelType,
          unread_count: u.unread_count,
          mention_count: 0,
        })),
      mentions: this.storage.enrichMessages(mentions),
      unread_dms: unreads
        .filter((u) => u.channel_type === ChannelType.DM || u.channel_type === ChannelType.GROUP_DM)
        .map((u) => ({
          channel_id: u.channel_id,
          channel_name: u.channel_name,
          channel_type: u.channel_type as ChannelType,
          unread_count: u.unread_count,
          mention_count: 0,
        })),
    };
  }

  // =========================================================================
  // Agents
  // =========================================================================

  listAgents(agentId: string, status?: string): Agent[] {
    const agent = this.requireAgent(agentId);
    return this.storage.listAgents(agent.workspace_id, status);
  }

  setAgentOffline(agentId: string): void {
    this.storage.updateAgentStatus(agentId, 'offline');
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  private requireAgent(agentId: string): Agent {
    const agent = this.storage.getAgentById(agentId);
    if (!agent) {
      throw new Error('Not registered. Call the register tool first.');
    }
    return agent;
  }

  private requireChannel(workspaceId: string, name: string): Channel {
    const normalized = name.replace(/^#/, '').toLowerCase();
    const channel = this.storage.getChannel(workspaceId, normalized);
    if (!channel) {
      throw new Error(`Channel #${normalized} not found`);
    }
    return channel;
  }

  private requireMembership(channelId: string, agentId: string): void {
    if (!this.storage.isChannelMember(channelId, agentId)) {
      throw new Error('Not a member of this channel. Join first.');
    }
  }

  private dmChannelName(name1: string, name2: string): string {
    const sorted = [name1, name2].sort();
    return `dm:${sorted[0]}:${sorted[1]}`;
  }

  private findOrCreateDmChannel(agent: Agent, target: Agent): Channel {
    const dmName = this.dmChannelName(agent.name, target.name);
    let channel = this.storage.getChannel(agent.workspace_id, dmName);

    if (!channel) {
      channel = this.storage.createChannel(
        agent.workspace_id,
        dmName,
        agent.id,
        ChannelType.DM,
      );
      this.storage.addChannelMember(channel.id, agent.id, 'member');
      this.storage.addChannelMember(channel.id, target.id, 'member');
    }

    return channel;
  }
}
