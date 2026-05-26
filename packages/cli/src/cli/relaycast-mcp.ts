#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { RelayCast, SDK_VERSION, WsClient, type AgentClient } from '@relaycast/sdk';
import { z } from 'zod';

const DEFAULT_BASE_URL = 'https://api.relaycast.dev';
export const AGENT_RELAY_MCP_VERSION = process.env.AGENT_RELAY_CLI_VERSION ?? SDK_VERSION ?? 'unknown';

const DEFAULT_SYSTEM_PROMPT = `You are an AI agent in a collaborative workspace powered by Agent Relay. You can communicate with other agents using these MCP tools:

## Getting Started
1. If no workspace key is configured, call "create_workspace" or "set_workspace_key"
2. When RELAY_API_KEY is provided at startup, this MCP server auto-registers the session as RELAY_AGENT_NAME (or "orchestrator" by default). Otherwise call "register_agent" with your agent name to join the workspace
3. Use "list_channels" to see available channels
4. Use "join_channel" to join channels of interest
5. Use "check_inbox" to see unread messages and mentions

## Communication
- Post messages to channels with "post_message"
- Send direct messages with "send_dm"
- Reply to threads with "reply_to_thread"
- React to messages with "add_reaction"

## Best Practices
- Check your inbox regularly for new messages and mentions
- Use channels for topic-based discussions
- Use threads for detailed discussions to keep channels organized
- React with emoji to acknowledge messages
- Keep messages concise and actionable`;

const jsonResult = z.object({}).passthrough();
const messageResult = {
  message: z.string().describe('Human-readable confirmation message'),
};
const identityOverrideInputShape = {
  as: z
    .string()
    .optional()
    .describe('Registered agent identity to act as when multiple identities have been registered'),
};

type AgentType = 'agent' | 'human';
type RelayCastLike = Pick<RelayCast, 'agents'>;
type AgentClientLike = AgentClient;

export interface PatchedMcpServerOptions {
  apiKey?: string;
  baseUrl?: string;
  agentToken?: string;
  agentName?: string;
  agentType?: AgentType;
  strictAgentName?: boolean;
  telemetryTransport?: 'stdio' | 'http';
  skipBootstrap?: boolean;
}

interface RegisteredAgent {
  agentName: string;
  agentToken: string;
}

interface SessionState {
  workspaceKey: string | null;
  agentToken: string | null;
  agentName: string | null;
  agents: Map<string, RegisteredAgent>;
  wsBridge: RealtimeResourceBridge | null;
  subscriptions: SubscriptionManager | null;
  wsInitAttempted: boolean;
}

type RegistrationSession = Pick<SessionState, 'workspaceKey' | 'agentToken' | 'agentName'>;
type SessionSetter = (partial: Partial<SessionState>) => void;
type AgentResultCallbackConfig = {
  url: string;
  token: string;
  schema?: unknown;
  agentName?: string;
};

type RegisterAgentWithRebindArgs = {
  session: RegistrationSession;
  setSession: SessionSetter;
  getRelay: () => RelayCastLike;
  name: string;
  type?: AgentType;
  persona?: string;
  metadata?: Record<string, unknown>;
  strictAgentName?: boolean;
  preferredAgentName?: string | null;
  forcedAgentType?: AgentType;
};

/** Return env var value, or undefined if missing / an unresolved ${...} template. */
function resolveEnv(key: string): string | undefined {
  const v = process.env[key];
  if (!v || /^\$\{.+\}$/.test(v)) return undefined;
  return v;
}

export function normalizeBaseUrl(baseUrl?: string): string {
  return (baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function isEntrypoint(): boolean {
  const invocationPath = process.argv[1];
  if (!invocationPath) return false;
  try {
    return fs.realpathSync(invocationPath) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(invocationPath) === fileURLToPath(import.meta.url);
  }
}

export function envFlagEnabled(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

export function normalizeAgentType(value: string | undefined): AgentType | undefined {
  if (value === 'agent' || value === 'human') {
    return value;
  }

  return undefined;
}

function readAgentResultCallbackConfig(agentName?: string): AgentResultCallbackConfig | undefined {
  const url = resolveEnv('AGENT_RELAY_RESULT_URL');
  const token = resolveEnv('AGENT_RELAY_RESULT_TOKEN');
  if (!url || !token) {
    return undefined;
  }

  const rawSchema = resolveEnv('AGENT_RELAY_RESULT_SCHEMA');
  let schema: unknown;
  if (rawSchema) {
    try {
      schema = JSON.parse(rawSchema);
    } catch {
      schema = rawSchema;
    }
  }

  return { url, token, schema, agentName };
}

function registerAgentResultTool(server: McpServer, config: AgentResultCallbackConfig | undefined): void {
  if (!config) {
    return;
  }

  const schemaText =
    config.schema === undefined
      ? ''
      : ` Expected JSON schema: ${JSON.stringify(config.schema).slice(0, 4000)}`;

  server.registerTool(
    'submit_result',
    {
      title: 'Submit Result',
      description:
        'Submit the structured result for this spawned Agent Relay task. Call this when the requested work is complete and the result object is ready.' +
        schemaText,
      inputSchema: {
        data: z.unknown().describe('The JSON result payload requested by the spawning SDK caller.'),
        final: z
          .boolean()
          .optional()
          .describe('Whether this is the final result for the task. Defaults to true.'),
        metadata: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Optional diagnostic metadata about the result.'),
      },
      outputSchema: jsonResult,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ data, final, metadata }) => {
      const timeoutMs = Number(resolveEnv('AGENT_RELAY_RESULT_TIMEOUT_MS') ?? 10_000);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetch(config.url, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${config.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            agent: config.agentName,
            data,
            final: final ?? true,
            metadata,
          }),
        });
      } catch (err) {
        if ((err as { name?: string }).name === 'AbortError') {
          throw new Error(`Agent Relay result submission timed out after ${timeoutMs}ms`);
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
      const responseText = await response.text();
      let payload: Record<string, unknown>;
      try {
        payload = responseText ? (JSON.parse(responseText) as Record<string, unknown>) : {};
      } catch {
        payload = { success: false, error: responseText };
      }
      if (!response.ok) {
        throw new Error(
          `Agent Relay result submission failed (${response.status}): ${String(payload.error ?? responseText)}`
        );
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
      };
    }
  );
}

function createInitialSession(options: {
  workspaceKey?: string | null;
  agentToken?: string | null;
  agentName?: string | null;
}): SessionState {
  const agentToken = options.agentToken ?? null;
  const agentName = options.agentName ?? null;
  const agents =
    agentToken && agentName
      ? new Map([[agentName, { agentName, agentToken }]])
      : new Map<string, RegisteredAgent>();

  return {
    workspaceKey: options.workspaceKey ?? null,
    agentToken,
    agentName,
    agents,
    wsBridge: null,
    subscriptions: null,
    wsInitAttempted: false,
  };
}

async function createWorkspace(name: string, baseUrl?: string): Promise<Record<string, unknown>> {
  return (await RelayCast.createWorkspace(name, { baseUrl })) as Record<string, unknown>;
}

function requireWorkspaceKey(session: RegistrationSession): void {
  if (session.workspaceKey) {
    return;
  }

  throw new Error('Workspace key not configured. Call "create_workspace" or "set_workspace_key" first.');
}

type JsonToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, unknown>;
};

function jsonContent(value: unknown): JsonToolResult {
  const structuredContent =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { value };
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent,
  };
}

function textContent(message: string, structuredContent: Record<string, unknown> = { message }) {
  return {
    content: [{ type: 'text' as const, text: message }],
    structuredContent,
  };
}

function createRegisteredAgent(agentName: string, agentToken: string): RegisteredAgent {
  return { agentName, agentToken };
}

export async function registerAgentWithRebind({
  session,
  setSession,
  getRelay,
  name,
  type,
  persona,
  metadata,
  strictAgentName,
  preferredAgentName,
  forcedAgentType,
}: RegisterAgentWithRebindArgs): Promise<Record<string, unknown>> {
  requireWorkspaceKey(session);

  const configuredName = session.agentName ?? preferredAgentName?.trim() ?? null;
  const warnings: string[] = [];
  const effectiveName = strictAgentName && configuredName ? configuredName : name;
  if (strictAgentName && configuredName && name.trim() !== configuredName) {
    warnings.push(
      `Strict worker identity is enabled; ignoring requested name "${name}" and using "${configuredName}".`
    );
  }

  const effectiveType = forcedAgentType ?? type;
  if (forcedAgentType && type && type !== forcedAgentType) {
    warnings.push(
      `Forced worker type is enabled; ignoring requested type "${type}" and using "${forcedAgentType}".`
    );
  }

  if (session.agentToken && effectiveName && strictAgentName) {
    return {
      name: effectiveName,
      token: session.agentToken,
      registered_name: effectiveName,
      warnings,
    };
  }

  const relay = getRelay();
  const result = await relay.agents.registerOrRotate({
    name: effectiveName,
    type: effectiveType,
    persona,
    metadata,
  });
  const reboundName = result.name?.trim() ? result.name : effectiveName;
  setSession({ agentToken: result.token, agentName: reboundName });

  return {
    ...result,
    registered_name: reboundName,
    warnings,
  };
}

class SubscriptionManager {
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

function eventToResourceUris(event: unknown): string[] {
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

class RealtimeResourceBridge {
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

function registerResourceDefinitions(
  server: McpServer,
  getAgentClient: (asIdentity?: string) => AgentClientLike,
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

function hasContentArray(value: unknown): value is { content: Array<Record<string, unknown>> } {
  return (
    typeof value === 'object' && value !== null && Array.isArray((value as { content?: unknown }).content)
  );
}

const SKIP_PIGGYBACK = new Set(['check_inbox', 'create_workspace', 'set_workspace_key', 'register_agent']);

function formatInbox(inbox: any, selfName?: string | null): string {
  const norm = (s: string) => s.trim().replace(/^@/, '').toLowerCase();
  const selfNorm = selfName ? norm(selfName) : null;
  const isSelf = (name: string) => selfNorm != null && norm(name) === selfNorm;
  const lines = ['--- Pending Messages ---'];

  if (inbox.unreadChannels?.length) {
    lines.push('Unread channels:');
    for (const ch of inbox.unreadChannels) {
      lines.push(`  #${ch.channelName}: ${ch.unreadCount} unread`);
    }
  }

  const mentions = selfNorm ? inbox.mentions?.filter((m: any) => !isSelf(m.agentName)) : inbox.mentions;
  if (mentions?.length) {
    lines.push('Mentions:');
    for (const m of mentions) {
      lines.push(`  @${m.agentName} in #${m.channelName}: "${m.text}"`);
    }
  }

  const dms = selfNorm ? inbox.unreadDms?.filter((dm: any) => !isSelf(dm.from)) : inbox.unreadDms;
  if (dms?.length) {
    lines.push('Unread DMs:');
    for (const dm of dms) {
      lines.push(`  From ${dm.from}: ${dm.unreadCount} unread`);
    }
  }

  const reactions = selfNorm
    ? inbox.recentReactions?.filter((reaction: any) => !isSelf(reaction.agentName))
    : inbox.recentReactions;
  if (reactions?.length) {
    lines.push('Reactions (informational; no response required):');
    for (const reaction of reactions) {
      lines.push(
        `  :${reaction.emoji}: on your message in #${reaction.channelName} by @${reaction.agentName}`
      );
    }
  }

  return lines.length === 1 ? '' : lines.join('\n');
}

function enableInboxPiggyback(
  mcpServer: McpServer,
  getSession: () => SessionState,
  getAgentClient: (asIdentity?: string) => AgentClientLike
): void {
  const original = mcpServer.registerTool.bind(mcpServer);
  const mutableServer = mcpServer as McpServer & {
    registerTool: McpServer['registerTool'];
  };

  mutableServer.registerTool = (name: string, config: any, handler: any) => {
    if (!handler) {
      return original(name, config, handler);
    }

    const wrapped = async (...args: unknown[]) => {
      const result = await handler(...args);
      if (SKIP_PIGGYBACK.has(name) || !getSession().agentToken || !hasContentArray(result)) {
        return result;
      }

      try {
        const [input] = args;
        const asIdentity =
          typeof input === 'object' && input !== null && typeof (input as { as?: unknown }).as === 'string'
            ? (input as { as: string }).as
            : undefined;
        const inbox = await getAgentClient(asIdentity).inbox();
        const inboxText = formatInbox(inbox, asIdentity ?? getSession().agentName);
        if (inboxText) {
          result.content.push({ type: 'text', text: inboxText });
        }
      } catch {
        // Inbox piggyback is opportunistic. The original tool result should win.
      }

      return result;
    };

    return original(name, config, wrapped);
  };
}

function resolveEmoji(input: string): string {
  const normalized = input.trim().replace(/^:/, '').replace(/:$/, '').toLowerCase();
  const aliases: Record<string, string> = {
    '+1': '👍',
    thumbsup: '👍',
    thumbs_up: '👍',
    check: '✅',
    white_check_mark: '✅',
    rocket: '🚀',
    eyes: '👀',
    heart: '❤️',
    clap: '👏',
  };
  return aliases[normalized] ?? input;
}

function registerAgentRelayTools(
  server: McpServer,
  getRelay: () => RelayCast,
  getAgentClient: (asIdentity?: string) => AgentClientLike,
  getSession: () => SessionState,
  setSession: SessionSetter,
  baseUrl: string | undefined,
  strictAgentName: boolean | undefined,
  preferredAgentName: string | undefined,
  forcedAgentType: AgentType | undefined
): void {
  server.registerTool(
    'create_workspace',
    {
      title: 'Create Workspace',
      description: 'Create a new Relaycast workspace and store its API key in this MCP session.',
      inputSchema: {
        name: z.string().describe('Human-readable workspace name'),
      },
      outputSchema: jsonResult,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ name }: any) => {
      const workspace = await createWorkspace(name, baseUrl);
      const workspaceKey = workspace.apiKey ?? workspace.api_key;
      if (!workspaceKey || typeof workspaceKey !== 'string') {
        throw new Error('Workspace created, but the response did not include apiKey');
      }

      setSession({
        workspaceKey,
        agentToken: null,
        agentName: null,
        agents: new Map(),
      });
      return jsonContent(workspace);
    }
  );

  server.registerTool(
    'set_workspace_key',
    {
      title: 'Set Workspace Key',
      description: 'Authenticate this MCP session with an existing Relaycast workspace API key.',
      inputSchema: {
        api_key: z.string().describe('Workspace API key starting with "rk_live_"'),
      },
      outputSchema: messageResult,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ api_key }: any) => {
      if (!api_key.startsWith('rk_live_')) {
        throw new Error('Workspace key must start with "rk_live_"');
      }

      const session = getSession();
      const switchingWorkspace = session.workspaceKey !== api_key;
      if (switchingWorkspace) {
        setSession({
          workspaceKey: api_key,
          agentToken: null,
          agentName: null,
          agents: new Map(),
        });
      } else {
        setSession({ workspaceKey: api_key });
      }

      const message = switchingWorkspace
        ? 'Workspace key set. Call "register_agent" to join this workspace.'
        : 'Workspace key set.';
      return textContent(message);
    }
  );

  server.registerTool(
    'register_agent',
    {
      title: 'Register Agent',
      description: 'Register an agent identity in the current workspace and obtain an agent token.',
      inputSchema: {
        name: z.string().describe('Unique agent name within the workspace'),
        type: z.enum(['agent', 'human']).optional().describe('Whether this identity is an AI agent or human'),
        persona: z.string().optional().describe('Free-text persona description'),
        metadata: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Key-value metadata to attach to the agent'),
      },
      outputSchema: jsonResult,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ name, type, persona, metadata }: any) => {
      const payload = await registerAgentWithRebind({
        session: getSession(),
        setSession,
        getRelay,
        name,
        type,
        persona,
        metadata,
        strictAgentName,
        preferredAgentName: preferredAgentName ?? null,
        forcedAgentType,
      });

      const token = typeof payload.token === 'string' ? payload.token : null;
      const registeredName =
        typeof payload.registered_name === 'string'
          ? payload.registered_name
          : typeof payload.name === 'string'
            ? payload.name
            : name;
      if (token) {
        const nextAgents = new Map(getSession().agents);
        nextAgents.set(registeredName, createRegisteredAgent(registeredName, token));
        setSession({ agentToken: token, agentName: registeredName, agents: nextAgents });
      }

      return jsonContent(payload);
    }
  );

  server.registerTool(
    'list_agents',
    {
      title: 'List Agents',
      description: 'List agents registered in the current workspace.',
      inputSchema: {
        status: z.enum(['online', 'offline']).optional().describe('Optional status filter'),
      },
      outputSchema: {
        agents: z.array(z.object({}).passthrough()).describe('Registered agents'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ status }) => {
      requireWorkspaceKey(getSession());
      const agents = await getRelay().agents.list(status ? { status } : undefined);
      return jsonContent({ agents });
    }
  );

  server.registerTool(
    'create_channel',
    {
      title: 'Create Channel',
      description: 'Create a new workspace channel.',
      inputSchema: {
        name: z.string().describe('Unique channel name'),
        topic: z.string().optional().describe('Optional channel topic'),
        ...identityOverrideInputShape,
      },
      outputSchema: jsonResult,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ name, topic, as }) => jsonContent(await getAgentClient(as).channels.create({ name, topic }))
  );

  server.registerTool(
    'list_channels',
    {
      title: 'List Channels',
      description: 'List channels available in the workspace.',
      inputSchema: {
        include_archived: z.boolean().optional().describe('Include archived channels'),
        ...identityOverrideInputShape,
      },
      outputSchema: {
        channels: z.array(z.object({}).passthrough()).describe('Channels'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ include_archived, as }) => {
      const channels = await getAgentClient(as).channels.list(
        include_archived ? { includeArchived: include_archived } : undefined
      );
      return jsonContent({ channels });
    }
  );

  server.registerTool(
    'join_channel',
    {
      title: 'Join Channel',
      description: 'Join an existing channel.',
      inputSchema: {
        channel: z.string().describe('Channel name'),
        ...identityOverrideInputShape,
      },
      outputSchema: messageResult,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ channel, as }) => {
      await getAgentClient(as).channels.join(channel);
      return textContent(`Joined channel #${channel}`);
    }
  );

  server.registerTool(
    'leave_channel',
    {
      title: 'Leave Channel',
      description: 'Leave a channel.',
      inputSchema: {
        channel: z.string().describe('Channel name'),
        ...identityOverrideInputShape,
      },
      outputSchema: messageResult,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ channel, as }) => {
      await getAgentClient(as).channels.leave(channel);
      return textContent(`Left channel #${channel}`);
    }
  );

  server.registerTool(
    'invite_to_channel',
    {
      title: 'Invite to Channel',
      description: 'Invite another agent to a channel.',
      inputSchema: {
        channel: z.string().describe('Channel name'),
        agent: z.string().describe('Agent name to invite'),
        ...identityOverrideInputShape,
      },
      outputSchema: messageResult,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ channel, agent, as }) => {
      await getAgentClient(as).channels.invite(channel, agent);
      return textContent(`Invited ${agent} to #${channel}`);
    }
  );

  server.registerTool(
    'set_channel_topic',
    {
      title: 'Set Channel Topic',
      description: 'Update a channel topic.',
      inputSchema: {
        channel: z.string().describe('Channel name'),
        topic: z.string().describe('New topic'),
        ...identityOverrideInputShape,
      },
      outputSchema: jsonResult,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ channel, topic, as }) => jsonContent(await getAgentClient(as).channels.setTopic(channel, topic))
  );

  server.registerTool(
    'archive_channel',
    {
      title: 'Archive Channel',
      description: 'Archive a channel.',
      inputSchema: {
        channel: z.string().describe('Channel name'),
        ...identityOverrideInputShape,
      },
      outputSchema: messageResult,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ channel, as }) => {
      await getAgentClient(as).channels.archive(channel);
      return textContent(`Archived channel #${channel}`);
    }
  );

  server.registerTool(
    'post_message',
    {
      title: 'Post Message',
      description: 'Post a new message to a channel as the current agent.',
      inputSchema: {
        channel: z.string().describe('Channel name'),
        text: z.string().describe('Message text'),
        attachments: z.array(z.string()).optional().describe('File attachment IDs'),
        mode: z.enum(['wait', 'steer']).optional().describe('Delivery mode'),
        ...identityOverrideInputShape,
      },
      outputSchema: jsonResult,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ channel, text, attachments, mode, as }) =>
      jsonContent(await getAgentClient(as).send(channel, text, { attachments, mode }))
  );

  server.registerTool(
    'list_messages',
    {
      title: 'Get Messages',
      description: 'Retrieve message history from a channel.',
      inputSchema: {
        channel: z.string().describe('Channel name'),
        limit: z.number().optional().describe('Maximum messages to return'),
        before: z.string().optional().describe('Older-than cursor'),
        after: z.string().optional().describe('Newer-than cursor'),
        ...identityOverrideInputShape,
      },
      outputSchema: {
        messages: z.array(z.object({}).passthrough()).describe('Messages'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ channel, limit, before, after, as }) => {
      const messages = await getAgentClient(as).messages(channel, { limit, before, after });
      return jsonContent({ messages });
    }
  );

  server.registerTool(
    'reply_to_thread',
    {
      title: 'Reply to Thread',
      description: 'Reply to an existing message thread.',
      inputSchema: {
        message_id: z.string().describe('Parent message ID'),
        text: z.string().describe('Reply text'),
        ...identityOverrideInputShape,
      },
      outputSchema: jsonResult,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ message_id, text, as }) => jsonContent(await getAgentClient(as).reply(message_id, text))
  );

  server.registerTool(
    'get_message_thread',
    {
      title: 'Get Thread',
      description: 'Retrieve a message thread.',
      inputSchema: {
        message_id: z.string().describe('Parent message ID'),
        limit: z.number().optional().describe('Maximum replies to return'),
        ...identityOverrideInputShape,
      },
      outputSchema: jsonResult,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ message_id, limit, as }) =>
      jsonContent(await getAgentClient(as).thread(message_id, limit ? { limit } : undefined))
  );

  server.registerTool(
    'send_dm',
    {
      title: 'Send Direct Message',
      description: 'Send a private direct message to another agent.',
      inputSchema: {
        to: z.string().describe('Recipient agent name'),
        text: z.string().describe('DM text'),
        mode: z.enum(['wait', 'steer']).optional().describe('Delivery mode'),
        attachments: z.array(z.string()).optional().describe('File attachment IDs'),
        ...identityOverrideInputShape,
      },
      outputSchema: jsonResult,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ to, text, mode, attachments, as }) =>
      jsonContent(await getAgentClient(as).dm(to, text, { mode, attachments }))
  );

  server.registerTool(
    'list_dms',
    {
      title: 'List DM Conversations',
      description: 'List direct message conversations for the current agent.',
      inputSchema: {
        ...identityOverrideInputShape,
      },
      outputSchema: {
        conversations: z.array(z.object({}).passthrough()).describe('DM conversations'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ as }) => jsonContent({ conversations: await getAgentClient(as).dms.conversations() })
  );

  server.registerTool(
    'send_group_dm',
    {
      title: 'Send Group DM',
      description: 'Create a group DM and send the first message.',
      inputSchema: {
        participants: z.array(z.string()).describe('Participant agent names'),
        name: z.string().optional().describe('Optional group name'),
        text: z.string().describe('Initial message'),
        ...identityOverrideInputShape,
      },
      outputSchema: jsonResult,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ participants, name, text, as }) => {
      const client = getAgentClient(as);
      const conversation = await client.dms.createGroup({ participants, name });
      const message = await client.dms.sendMessage(conversation.id, text);
      return jsonContent({ conversation, message });
    }
  );

  server.registerTool(
    'add_reaction',
    {
      title: 'Add Reaction',
      description: 'Add an emoji reaction to a message.',
      inputSchema: {
        message_id: z.string().describe('Message ID'),
        emoji: z.string().describe('Emoji character or shortcode'),
        ...identityOverrideInputShape,
      },
      outputSchema: messageResult,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ message_id, emoji, as }) => {
      const resolved = resolveEmoji(emoji);
      await getAgentClient(as).react(message_id, resolved);
      return textContent(`Reacted with ${resolved}`);
    }
  );

  server.registerTool(
    'remove_reaction',
    {
      title: 'Remove Reaction',
      description: 'Remove an emoji reaction from a message.',
      inputSchema: {
        message_id: z.string().describe('Message ID'),
        emoji: z.string().describe('Emoji character or shortcode'),
        ...identityOverrideInputShape,
      },
      outputSchema: messageResult,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ message_id, emoji, as }) => {
      const resolved = resolveEmoji(emoji);
      await getAgentClient(as).unreact(message_id, resolved);
      return textContent(`Removed reaction ${resolved}`);
    }
  );

  server.registerTool(
    'search_messages',
    {
      title: 'Search Messages',
      description: 'Search messages across the workspace.',
      inputSchema: {
        query: z.string().describe('Text search query'),
        channel: z.string().optional().describe('Optional channel filter'),
        from: z.string().optional().describe('Optional sender filter'),
        limit: z.number().optional().describe('Maximum results'),
        ...identityOverrideInputShape,
      },
      outputSchema: {
        results: z.array(z.object({}).passthrough()).describe('Search results'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ query, channel, from, limit, as }) =>
      jsonContent({ results: await getAgentClient(as).search(query, { channel, from, limit }) })
  );

  server.registerTool(
    'check_inbox',
    {
      title: 'Check Inbox',
      description: 'Check unread messages, mentions, DMs, and reactions for the current agent.',
      inputSchema: {
        limit: z.number().optional().describe('Maximum inbox items'),
        ...identityOverrideInputShape,
      },
      outputSchema: jsonResult,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ limit, as }) =>
      jsonContent(await getAgentClient(as).inbox(limit != null ? { limit } : undefined))
  );

  server.registerTool(
    'mark_message_read',
    {
      title: 'Mark as Read',
      description: 'Mark a message as read for the current agent.',
      inputSchema: {
        message_id: z.string().describe('Message ID'),
        ...identityOverrideInputShape,
      },
      outputSchema: messageResult,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ message_id, as }) => {
      await getAgentClient(as).markRead(message_id);
      return textContent(`Marked message ${message_id} as read`);
    }
  );

  server.registerTool(
    'get_message_readers',
    {
      title: 'Get Readers',
      description: 'List agents who have read a message.',
      inputSchema: {
        message_id: z.string().describe('Message ID'),
        ...identityOverrideInputShape,
      },
      outputSchema: {
        readers: z.array(z.object({}).passthrough()).describe('Readers'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ message_id, as }) => jsonContent({ readers: await getAgentClient(as).readers(message_id) })
  );

  server.registerTool(
    'add_agent',
    {
      title: 'Add Agent',
      description: 'Ask Relaycast to spawn a worker agent for a task.',
      inputSchema: {
        name: z.string().describe('Worker agent name'),
        cli: z.enum(['claude', 'codex', 'gemini', 'aider', 'goose']).describe('AI CLI to launch'),
        task: z.string().describe('Task instructions'),
        channel: z.string().optional().describe('Channel to join'),
        persona: z.string().optional().describe('Worker persona'),
        model: z.string().optional().describe('Model powering the worker'),
      },
      outputSchema: jsonResult,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ name, cli, task, channel, persona, model }) =>
      jsonContent(
        await getRelay().agents.spawn({
          name,
          cli,
          task,
          channel,
          persona,
          metadata: model ? { model } : undefined,
        })
      )
  );

  server.registerTool(
    'remove_agent',
    {
      title: 'Remove Agent',
      description: 'Release a worker agent from active duty.',
      inputSchema: {
        name: z.string().describe('Agent name'),
        reason: z.string().optional().describe('Removal reason'),
        delete_agent: z.boolean().optional().describe('Permanently delete the agent'),
      },
      outputSchema: {
        name: z.string().describe('Removed agent name'),
        removed: z.boolean().describe('Whether the agent was removed'),
        deleted: z.boolean().describe('Whether the agent was deleted'),
        reason: z.string().nullable().describe('Removal reason'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ name, reason, delete_agent }) => {
      const released = await getRelay().agents.release({ name, reason, deleteAgent: delete_agent });
      return jsonContent({
        name: released.name,
        removed: released.released,
        deleted: released.deleted,
        reason: released.reason,
      });
    }
  );
}

export function createPatchedRelayMcpServer(options: PatchedMcpServerOptions): McpServer {
  const session = createInitialSession({
    workspaceKey: options.apiKey ?? null,
    agentToken: options.agentToken ?? null,
    agentName: options.agentName ?? null,
  });

  const mcpServer = new McpServer(
    { name: 'agent-relay', version: AGENT_RELAY_MCP_VERSION },
    {
      capabilities: {
        resources: { subscribe: true, listChanged: true },
        tools: {},
        prompts: {},
      },
    }
  );

  const getSession = (): SessionState => session;
  const getRelay = (): RelayCast => {
    const workspaceKey = session.workspaceKey;
    if (!workspaceKey) {
      throw new Error(
        'Workspace key not configured. Set RELAY_API_KEY at startup, or call "create_workspace" or "set_workspace_key" first.'
      );
    }

    return new RelayCast({
      apiKey: workspaceKey,
      baseUrl: options.baseUrl,
    });
  };

  const notifySubscribers = () => {
    const uris = session.subscriptions?.getAll() ?? [];
    for (const uri of uris) {
      mcpServer.server.sendResourceUpdated({ uri }).catch(() => undefined);
    }
  };

  const setSession: SessionSetter = (partial) => {
    const switchingWorkspace =
      partial.workspaceKey !== undefined && partial.workspaceKey !== session.workspaceKey;
    const changingToken = partial.agentToken !== undefined && partial.agentToken !== session.agentToken;

    if (switchingWorkspace || changingToken) {
      notifySubscribers();
      session.wsBridge?.stop();
      session.subscriptions?.clear();
      session.wsBridge = null;
      session.subscriptions = null;
      session.wsInitAttempted = false;
    }

    Object.assign(session, partial);

    if (session.agentToken && !session.wsBridge && !session.wsInitAttempted) {
      try {
        const subscriptions = new SubscriptionManager();
        const wsClient = new WsClient({
          token: session.agentToken,
          baseUrl: options.baseUrl,
        });
        const wsBridge = new RealtimeResourceBridge(wsClient, subscriptions, (uri) => {
          mcpServer.server.sendResourceUpdated({ uri }).catch(() => undefined);
        });
        wsBridge.start();
        session.wsBridge = wsBridge;
        session.subscriptions = subscriptions;
        session.wsInitAttempted = true;
      } catch {
        session.wsBridge = null;
        session.subscriptions = null;
        session.wsInitAttempted = true;
      }
    }
  };

  const resolveAgentToken = (asIdentity?: string): string => {
    if (asIdentity) {
      const registered = session.agents.get(asIdentity);
      if (!registered) {
        throw new Error(`Unknown agent identity "${asIdentity}". Register it first.`);
      }
      return registered.agentToken;
    }

    if (!session.agentToken) {
      throw new Error('Not registered. Call the "register_agent" tool first.');
    }

    return session.agentToken;
  };

  const getAgentClient = (asIdentity?: string): AgentClientLike => {
    const agentToken = resolveAgentToken(asIdentity);
    return new RelayCast({
      apiKey: agentToken,
      baseUrl: options.baseUrl,
    }).as(agentToken, { autoHeartbeatMs: false });
  };

  enableInboxPiggyback(mcpServer, getSession, getAgentClient);
  registerResourceDefinitions(mcpServer, getAgentClient, getRelay);
  mcpServer.server.setRequestHandler(SubscribeRequestSchema, async (req) => {
    session.subscriptions?.subscribe(req.params.uri);
    return {};
  });
  mcpServer.server.setRequestHandler(UnsubscribeRequestSchema, async (req) => {
    session.subscriptions?.unsubscribe(req.params.uri);
    return {};
  });
  registerAgentRelayTools(
    mcpServer,
    getRelay,
    getAgentClient,
    getSession,
    setSession,
    options.baseUrl,
    options.strictAgentName,
    options.agentName,
    options.agentType
  );
  registerAgentResultTool(mcpServer, readAgentResultCallbackConfig(options.agentName));

  mcpServer.registerPrompt(
    'system',
    {
      title: 'System Prompt',
      description: 'Get the default system instructions for Agent Relay collaboration.',
    },
    async () => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: DEFAULT_SYSTEM_PROMPT,
          },
        },
      ],
    })
  );

  const handlers = (
    mcpServer.server as unknown as {
      _requestHandlers: Map<
        string,
        (req: unknown, extra: unknown) => Promise<{ tools?: Array<Record<string, unknown>> }>
      >;
    }
  )._requestHandlers;
  const origToolsListHandler = handlers.get('tools/list');
  if (origToolsListHandler) {
    mcpServer.server.setRequestHandler(ListToolsRequestSchema, async (req, extra) => {
      const result = await origToolsListHandler(req, extra);
      if (result?.tools) {
        result.tools = result.tools.map((tool) => {
          const { execution, outputSchema, _meta, ...clean } = tool;
          void execution;
          void outputSchema;
          void _meta;
          return clean;
        });
      }
      return result;
    });
  }

  if (session.agentToken && !session.wsBridge) {
    setSession({ agentToken: session.agentToken, agentName: session.agentName });
  }

  return mcpServer;
}

export const createAgentRelayMcpServer = createPatchedRelayMcpServer;

/** Relaycast agent tokens are opaque `at_live_<hex>` literals. Anything else
 * (for example a RelayAuth JWT carried in RELAY_AGENT_TOKEN by `relay on start`)
 * is not a valid Relaycast credential and must be replaced. */
function isRelaycastAgentToken(token: string | undefined): token is string {
  return typeof token === 'string' && token.startsWith('at_live_');
}

export async function resolvePatchedStdioBootstrapOptions(
  options: PatchedMcpServerOptions
): Promise<PatchedMcpServerOptions> {
  if (isRelaycastAgentToken(options.agentToken) || options.skipBootstrap) {
    return options;
  }

  if (!options.apiKey || !options.agentName) {
    return options;
  }

  const relay = new RelayCast({
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
  });

  const registered = await relay.agents.registerOrRotate({
    name: options.agentName,
    type: options.agentType,
  });
  return {
    ...options,
    agentToken: registered.token,
    agentName: registered.name ?? options.agentName,
  };
}

export async function startPatchedStdio(options: PatchedMcpServerOptions): Promise<void> {
  const bootstrappedOptions = await resolvePatchedStdioBootstrapOptions(options);
  const mcpServer = createPatchedRelayMcpServer({
    ...bootstrappedOptions,
    telemetryTransport: 'stdio',
  });
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
}

export const startAgentRelayMcpStdio = startPatchedStdio;

export function optionsFromEnv(): PatchedMcpServerOptions {
  const apiKey = resolveEnv('RELAY_API_KEY');
  const agentName =
    resolveEnv('RELAY_AGENT_NAME') ?? resolveEnv('RELAY_CLAW_NAME') ?? (apiKey ? 'orchestrator' : undefined);
  return {
    apiKey,
    baseUrl: resolveEnv('RELAY_BASE_URL'),
    agentToken: resolveEnv('RELAY_AGENT_TOKEN'),
    agentName,
    agentType: normalizeAgentType(resolveEnv('RELAY_AGENT_TYPE')),
    strictAgentName: envFlagEnabled(resolveEnv('RELAY_STRICT_AGENT_NAME')),
    skipBootstrap: envFlagEnabled(resolveEnv('RELAY_SKIP_BOOTSTRAP')),
  };
}

if (isEntrypoint()) {
  startPatchedStdio(optionsFromEnv()).catch((error) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
