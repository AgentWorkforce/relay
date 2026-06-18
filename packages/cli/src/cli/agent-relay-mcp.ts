#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { RelayCast, SDK_VERSION, WsClient } from '@relaycast/sdk';
import { AgentRelay } from '@agent-relay/sdk';
import { z } from 'zod';
import { initTelemetry, shutdown as shutdownTelemetry } from './telemetry/index.js';
import { withRelaycastTelemetry } from './lib/relaycast-telemetry.js';
import {
  RealtimeResourceBridge,
  SubscriptionManager,
  registerResourceDefinitions,
} from './mcp/resources.js';
import { jsonContent, jsonResult, textContent } from './mcp/tool-results.js';
import {
  createWorkspace,
  extractWorkspaceKey,
  extractWorkspaceName,
  requireWorkspaceKey,
} from './mcp/workspace.js';
import { enableInboxPiggyback } from './mcp/telemetry.js';
import { registerAgentRelayActionTools } from './mcp/action-tools.js';
import type {
  AgentClientLike,
  AgentRelayMcpServerOptions,
  AgentType,
  RegisteredAgent,
  RegistrationSession,
  RelayCastLike,
  SessionSetter,
  SessionState,
} from './mcp/types.js';
export type { AgentRelayMcpServerOptions } from './mcp/types.js';

const DEFAULT_BASE_URL = 'https://gateway.relaycast.dev';
export const AGENT_RELAY_MCP_VERSION = process.env.AGENT_RELAY_CLI_VERSION ?? SDK_VERSION ?? 'unknown';
let mcpTelemetryExitHookInstalled = false;

const EXIT_AFTER_TASK_INSTRUCTION =
  '## Post-task exit\n' +
  'When the requested task is fully complete and you have reported the final outcome, output `/exit` on its own line so the Agent Relay harness exits cleanly. Do not output `/exit` before the task is complete.';

function withExitAfterTaskInstruction(task: string): string {
  return `${task}\n\n${EXIT_AFTER_TASK_INSTRUCTION}`;
}

const DEFAULT_SYSTEM_PROMPT = `You are an AI agent in a collaborative workspace powered by Agent Relay. You can communicate with other agents using these MCP tools:

## Getting Started
1. If no workspace is configured, call "create_workspace"
2. If someone shared an existing workspace key with you, call "set_workspace_key"
3. When a workspace key is provided at startup, this MCP server auto-registers the session as RELAY_AGENT_NAME (or "orchestrator" by default). Otherwise call "register_agent" with your agent name to join the workspace
4. Use "list_channels" to see available channels
5. Use "join_channel" to join channels of interest
6. Use "check_inbox" to see unread messages and mentions

## Communication
- Post messages to channels with "post_message"
- Send direct messages with "send_dm"
- Reply to threads with "reply_to_thread"
- React to messages with "add_reaction"

## Fleet
- Use "query_nodes" to find fleet nodes by capability or name
- Use "spawn" to invoke the fleet spawn action on an eligible node

## Best Practices
- Check your inbox regularly for new messages and mentions
- Use channels for topic-based discussions
- Use threads for detailed discussions to keep channels organized
- React with emoji to acknowledge messages
- Keep messages concise and actionable`;

const messageResult = {
  message: z.string().describe('Human-readable confirmation message'),
};
const identityOverrideInputShape = {
  as: z
    .string()
    .optional()
    .describe('Registered agent identity to act as when multiple identities have been registered'),
};

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

function initMcpTelemetry(): void {
  initTelemetry({
    showNotice: false,
    cliVersion: process.env.AGENT_RELAY_CLI_VERSION ?? AGENT_RELAY_MCP_VERSION,
    sdkVersion: process.env.AGENT_RELAY_SDK_VERSION,
    app: 'cli',
    surface: 'mcp',
    orchestratorHarness: process.env.AGENT_RELAY_ORCHESTRATOR_HARNESS ?? process.env.AGENT_RELAY_HARNESS,
  });

  if (mcpTelemetryExitHookInstalled) {
    return;
  }

  mcpTelemetryExitHookInstalled = true;
  process.on('beforeExit', () => {
    void shutdownTelemetry().catch(() => undefined);
  });
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
    // If the session tracks per-identity agents, only short-circuit when the
    // strict-named identity is still registered. After an `agent_token_invalid`
    // recovery the entry is dropped from the map, which lets this fall through
    // to a fresh registerOrRotate instead of handing back the dead token.
    const cachedAgent = session.agents?.get(effectiveName);
    const knowsIdentities = session.agents !== undefined;
    if (!knowsIdentities || cachedAgent) {
      return {
        name: effectiveName,
        token: cachedAgent?.agentToken ?? session.agentToken,
        registered_name: effectiveName,
        warnings,
      };
    }
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
      description: 'Create a new Agent Relay workspace and store its workspace key in this MCP session.',
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
      const workspaceKey = extractWorkspaceKey(workspace);
      if (!workspaceKey || typeof workspaceKey !== 'string') {
        throw new Error('Workspace created, but the response did not include a workspace key.');
      }
      const workspaceName = extractWorkspaceName(workspace, name);

      setSession({
        workspaceKey,
        agentToken: null,
        agentName: null,
        agents: new Map(),
      });
      return jsonContent({
        workspaceKey,
        workspaceName,
      });
    }
  );

  server.registerTool(
    'set_workspace_key',
    {
      title: 'Set Workspace Key',
      description: 'Join this MCP session to an existing Agent Relay workspace using a shared workspace key.',
      inputSchema: {
        workspace_key: z.string().optional().describe('Workspace key starting with "rk_live_"'),
        api_key: z.string().optional().describe('Deprecated alias for workspace_key'),
      },
      outputSchema: messageResult,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ workspace_key, api_key }: any) => {
      const key = workspace_key ?? api_key;
      if (!key || typeof key !== 'string') {
        throw new Error('Workspace key is required.');
      }
      if (!key.startsWith('rk_live_')) {
        throw new Error('Workspace key must start with "rk_live_"');
      }

      const session = getSession();
      const switchingWorkspace = session.workspaceKey !== key;
      if (switchingWorkspace) {
        setSession({
          workspaceKey: key,
          agentToken: null,
          agentName: null,
          agents: new Map(),
        });
      } else {
        setSession({ workspaceKey: key });
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
    'query_nodes',
    {
      title: 'Query Fleet Nodes',
      description: 'Query registered fleet nodes by capability or name.',
      inputSchema: {
        capability: z.string().optional().describe('Optional capability name filter'),
        name: z.string().optional().describe('Optional node name filter'),
      },
      outputSchema: {
        nodes: z.array(z.object({}).passthrough()).describe('Fleet nodes'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ capability, name }) => {
      const session = getSession();
      requireWorkspaceKey(session);
      const relay = new AgentRelay({ workspaceKey: session.workspaceKey ?? undefined, baseUrl });
      return jsonContent({ nodes: await relay.nodes.list({ capability, name }) });
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
      description:
        'Spawn another AI agent (relay worker) to delegate a task to. This is how you ' +
        'create workers — including non-Claude ones. Use it for any "spawn a <tool> agent" request. ' +
        'Examples: "spawn a codex agent" → cli:"codex"; ' +
        '"spawn an opus claude agent" → cli:"claude", model:"claude-opus-4-8"; ' +
        '"spawn a sonnet claude agent" → cli:"claude", model:"claude-sonnet-4-6". ' +
        'Do NOT use the built-in Agent/Task tool for relay workers.',
      inputSchema: {
        name: z.string().describe('Worker agent name'),
        cli: z
          .enum(['claude', 'codex', 'gemini', 'aider', 'goose', 'grok', 'opencode'])
          .describe(
            'Which AI CLI runs the worker: "codex agent" → codex, "gemini agent" → gemini, ' +
              '"claude/opus claude/sonnet claude agent" → claude (default).'
          ),
        task: z.string().describe('Task instructions'),
        channel: z.string().optional().describe('Channel to join'),
        persona: z.string().optional().describe('Worker persona'),
        model: z
          .string()
          .optional()
          .describe(
            'Model to pin (Claude only). Required when a tier is specified: ' +
              '"opus claude" → claude-opus-4-8, "sonnet claude" → claude-sonnet-4-6, ' +
              '"haiku" → claude-haiku-4-5-20251001.'
          ),
        spawn_mode: z
          .enum(['interactive', 'task_exit', 'task-exit', 'single_shot', 'single-shot'])
          .optional()
          .describe('Spawn lifecycle. Use task_exit to exit after the injected task completes.'),
        exit_after_task: z
          .boolean()
          .optional()
          .describe('Exit the worker after it completes the injected task.'),
      },
      outputSchema: jsonResult,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ name, cli, task, channel, persona, model, spawn_mode, exit_after_task }) =>
      jsonContent(
        await getRelay().agents.spawn({
          name,
          // The broker/gateway support grok and opencode at runtime, but the
          // @relaycast/sdk SpawnAgentRequest type narrows cli to the core five.
          // Cast to keep grok/opencode selectable from the MCP tool enum.
          cli: cli as 'claude' | 'codex' | 'gemini' | 'aider' | 'goose',
          task:
            exit_after_task ||
            spawn_mode === 'task_exit' ||
            spawn_mode === 'task-exit' ||
            spawn_mode === 'single_shot' ||
            spawn_mode === 'single-shot'
              ? withExitAfterTaskInstruction(task)
              : task,
          channel,
          persona,
          // SpawnAgentRequest has no top-level model field; pass via metadata
          // so the broker can extract it and forward --model to the launched CLI.
          metadata: model ? { model } : undefined,
        })
      )
  );

  server.registerTool(
    'spawn',
    {
      title: 'Spawn Agent',
      description: 'Invoke the fleet spawn action. Optionally target a specific node.',
      inputSchema: {
        name: z.string().describe('Agent name'),
        cli: z.enum(['claude', 'codex', 'gemini', 'aider', 'goose']).describe('AI CLI to launch'),
        task: z.string().optional().describe('Initial task instructions'),
        channel: z.string().optional().describe('Channel to join'),
        channels: z.array(z.string()).optional().describe('Channels to join'),
        model: z.string().optional().describe('Model powering the worker'),
        session_ref: z.string().optional().describe('Session reference for resumable spawns'),
        target_node: z.string().optional().describe('Optional target fleet node name'),
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
    async ({ name, cli, task, channel, channels, model, session_ref, target_node, as }) => {
      const actions = getAgentClient(as).actions;
      if (!actions) {
        throw new Error('spawn requires an agent-scoped Relaycast actions client.');
      }
      const actionInput = {
        name,
        cli,
        ...(task ? { task } : {}),
        ...(model ? { model } : {}),
        ...(session_ref ? { session_ref } : {}),
        ...(target_node ? { target_node } : {}),
        ...((channels ?? (channel ? [channel] : undefined)) ? { channels: channels ?? [channel] } : {}),
      };
      return jsonContent({ invocation: await actions.invoke('spawn', actionInput) });
    }
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

export function createAgentRelayMcpServer(options: AgentRelayMcpServerOptions): McpServer {
  const session = createInitialSession({
    workspaceKey: options.workspaceKey ?? options.apiKey ?? null,
    agentToken: options.agentToken ?? null,
    agentName: options.agentName ?? null,
  });
  const actionToolNames = new Set<string>();

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
        'Workspace key not configured. Call "create_workspace" first, or provide a shared workspace key with "set_workspace_key".'
      );
    }

    return new RelayCast(
      withRelaycastTelemetry({
        apiKey: workspaceKey,
        baseUrl: options.baseUrl,
      })
    );
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

  const invalidateAgentToken = (asIdentity?: string): void => {
    const partial: Partial<SessionState> = {};
    const targetName = asIdentity ?? session.agentName ?? null;

    if (targetName && session.agents.has(targetName)) {
      const nextAgents = new Map(session.agents);
      nextAgents.delete(targetName);
      partial.agents = nextAgents;
    }

    if (!asIdentity || asIdentity === session.agentName) {
      if (session.agentToken !== null) {
        partial.agentToken = null;
      }
      if (session.agentName !== null && (!asIdentity || asIdentity === session.agentName)) {
        partial.agentName = null;
      }
    }

    if (Object.keys(partial).length > 0) {
      setSession(partial);
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
    return new RelayCast(
      withRelaycastTelemetry({
        apiKey: agentToken,
        baseUrl: options.baseUrl,
      })
    ).as(agentToken, { autoHeartbeatMs: false });
  };

  enableInboxPiggyback(
    mcpServer,
    getSession,
    getAgentClient,
    invalidateAgentToken,
    options.telemetryTransport,
    actionToolNames
  );
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
  registerAgentRelayActionTools(
    mcpServer,
    options.actions,
    getSession,
    options.onActionAuditEvent,
    getAgentClient,
    actionToolNames
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

  return mcpServer;
}

/** Relaycast agent tokens are opaque `at_live_<hex>` literals. Anything else
 * (for example a RelayAuth JWT carried in RELAY_AGENT_TOKEN by `relay on start`)
 * is not a valid Relaycast credential and must be replaced. */
function isRelaycastAgentToken(token: string | undefined): token is string {
  return typeof token === 'string' && token.startsWith('at_live_');
}

export async function resolveStdioBootstrapOptions(
  options: AgentRelayMcpServerOptions
): Promise<AgentRelayMcpServerOptions> {
  if (isRelaycastAgentToken(options.agentToken) || options.skipBootstrap) {
    return options;
  }

  const workspaceKey = options.workspaceKey ?? options.apiKey;

  if (!workspaceKey || !options.agentName) {
    return options;
  }

  const relay = new RelayCast(
    withRelaycastTelemetry({
      apiKey: workspaceKey,
      baseUrl: options.baseUrl,
    })
  );

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

export async function startAgentRelayMcpStdio(options: AgentRelayMcpServerOptions): Promise<void> {
  initMcpTelemetry();
  const bootstrappedOptions = await resolveStdioBootstrapOptions(options);
  const mcpServer = createAgentRelayMcpServer({
    ...bootstrappedOptions,
    telemetryTransport: 'stdio',
  });
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
}

export function optionsFromEnv(): AgentRelayMcpServerOptions {
  const workspaceKey = resolveEnv('RELAY_WORKSPACE_KEY') ?? resolveEnv('RELAY_API_KEY');
  const agentName =
    resolveEnv('RELAY_AGENT_NAME') ??
    resolveEnv('RELAY_CLAW_NAME') ??
    (workspaceKey ? 'orchestrator' : undefined);
  return {
    workspaceKey,
    baseUrl: resolveEnv('RELAY_BASE_URL'),
    agentToken: resolveEnv('RELAY_AGENT_TOKEN'),
    agentName,
    agentType: normalizeAgentType(resolveEnv('RELAY_AGENT_TYPE')),
    strictAgentName: envFlagEnabled(resolveEnv('RELAY_STRICT_AGENT_NAME')),
    skipBootstrap: envFlagEnabled(resolveEnv('RELAY_SKIP_BOOTSTRAP')),
  };
}

if (isEntrypoint()) {
  startAgentRelayMcpStdio(optionsFromEnv()).catch(async (error) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    await shutdownTelemetry().catch(() => undefined);
    process.exit(1);
  });
}
