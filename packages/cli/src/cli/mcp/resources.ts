import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type AgentClient, type RelayCast, type WsClient } from '@relaycast/sdk';

/**
 * Tracks the set of `relay://` resource URIs the MCP client has subscribed to,
 * so realtime events can be filtered down to only the resources that matter.
 */
export class SubscriptionManager {
  private readonly subscriptions = new Set<string>();

  subscribe(uri: string): void {
    this.subscriptions.add(uri);
  }

  unsubscribe(uri: string): void {
    this.subscriptions.delete(uri);
  }

  getMatchingSubscriptions(uris: string[]): string[] {
    return uris.filter((uri) => this.subscriptions.has(uri));
  }

  getAll(): string[] {
    return [...this.subscriptions];
  }

  clear(): void {
    this.subscriptions.clear();
  }
}

function getStringEventField(event: unknown, field: string): string | null {
  if (typeof event !== 'object' || event === null) {
    return null;
  }
  const candidate = (event as Record<string, unknown>)[field];
  return typeof candidate === 'string' ? candidate : null;
}

/**
 * Map a realtime workspace event to the `relay://` resource URIs whose contents
 * it invalidates, so subscribers can be notified to re-fetch.
 */
export function eventToResourceUris(event: unknown): string[] {
  const type = getStringEventField(event, 'type');
  switch (type) {
    case 'message.created': {
      const channel = getStringEventField(event, 'channel');
      return channel ? ['relay://inbox', `relay://channels/${channel}/messages`] : ['relay://inbox'];
    }
    case 'message.updated': {
      const channel = getStringEventField(event, 'channel');
      return channel ? [`relay://channels/${channel}/messages`] : [];
    }
    case 'thread.reply': {
      const parentId = getStringEventField(event, 'parentId');
      return parentId ? ['relay://inbox', `relay://messages/${parentId}/thread`] : ['relay://inbox'];
    }
    case 'dm.received':
    case 'group_dm.received': {
      const conversationId = getStringEventField(event, 'conversationId');
      return conversationId ? ['relay://inbox', `relay://dm/${conversationId}`] : ['relay://inbox'];
    }
    case 'agent.online':
    case 'agent.offline':
      return ['relay://agents'];
    case 'channel.created':
    case 'channel.updated':
    case 'channel.archived':
    case 'member.joined':
    case 'member.left':
      return ['relay://channels'];
    case 'webhook.received':
    case 'command.invoked': {
      const channel = getStringEventField(event, 'channel');
      return channel ? [`relay://channels/${channel}/messages`] : [];
    }
    case 'reaction.added':
    case 'reaction.removed':
      return ['relay://inbox'];
    default:
      return [];
  }
}

/**
 * Bridges the realtime WebSocket event stream to MCP resource notifications:
 * for each workspace event, notifies any subscribed `relay://` resource URIs
 * that the event invalidates.
 */
export class RealtimeResourceBridge {
  private unsubscribeFn: (() => void) | null = null;

  constructor(
    private readonly wsClient: WsClient,
    private readonly subscriptions: SubscriptionManager,
    private readonly notifyCallback: (uri: string) => void
  ) {}

  start(): void {
    this.unsubscribeFn = this.wsClient.on('*', (event) => {
      const type = getStringEventField(event, 'type');
      if (
        type === 'open' ||
        type === 'close' ||
        type === 'error' ||
        type === 'reconnecting' ||
        type === 'permanently_disconnected'
      ) {
        return;
      }
      const matched = this.subscriptions.getMatchingSubscriptions(eventToResourceUris(event));
      for (const uri of matched) {
        this.notifyCallback(uri);
      }
    });
    this.wsClient.connect();
  }

  stop(): void {
    if (this.unsubscribeFn) {
      this.unsubscribeFn();
      this.unsubscribeFn = null;
    }
    this.wsClient.disconnect();
  }
}

/**
 * Register the read-only `relay://` resources (inbox, agents, channels, channel
 * messages, message threads, and DM conversations) on the MCP server.
 */
export function registerResourceDefinitions(
  server: McpServer,
  getAgentClient: (asIdentity?: string) => AgentClient,
  getRelay: () => RelayCast
): void {
  server.registerResource(
    'inbox',
    'relay://inbox',
    { title: 'Inbox', description: 'Unread messages, mentions, and DMs', mimeType: 'application/json' },
    async (uri) => {
      const inbox = await getAgentClient().inbox();
      return { contents: [{ uri: uri.href, text: JSON.stringify(inbox) }] };
    }
  );

  server.registerResource(
    'agents',
    'relay://agents',
    {
      title: 'Agents',
      description: 'Online and offline agents in the workspace',
      mimeType: 'application/json',
    },
    async (uri) => {
      const agents = await getRelay().agents.list();
      return { contents: [{ uri: uri.href, text: JSON.stringify(agents) }] };
    }
  );

  server.registerResource(
    'channels',
    'relay://channels',
    { title: 'Channels', description: 'Available channels in the workspace', mimeType: 'application/json' },
    async (uri) => {
      const channels = await getAgentClient().channels.list();
      return { contents: [{ uri: uri.href, text: JSON.stringify(channels) }] };
    }
  );

  server.registerResource(
    'channel-messages',
    new ResourceTemplate('relay://channels/{name}/messages', { list: undefined }),
    {
      title: 'Channel Messages',
      description: 'Messages in a specific channel',
      mimeType: 'application/json',
    },
    async (uri, params) => {
      const messages = await getAgentClient().messages(String(params.name));
      return { contents: [{ uri: uri.href, text: JSON.stringify(messages) }] };
    }
  );

  server.registerResource(
    'message-thread',
    new ResourceTemplate('relay://messages/{id}/thread', { list: undefined }),
    { title: 'Message Thread', description: 'Thread replies on a message', mimeType: 'application/json' },
    async (uri, params) => {
      const thread = await getAgentClient().thread(String(params.id));
      return { contents: [{ uri: uri.href, text: JSON.stringify(thread) }] };
    }
  );

  server.registerResource(
    'dm-conversation',
    new ResourceTemplate('relay://dm/{conversation_id}', { list: undefined }),
    {
      title: 'DM Conversation',
      description: 'Direct message conversation',
      mimeType: 'application/json',
    },
    async (uri, params) => {
      const messages = await getAgentClient().dms.messages(String(params.conversation_id));
      return { contents: [{ uri: uri.href, text: JSON.stringify(messages) }] };
    }
  );
}
