import {
  createAgentClient,
  createWorkspaceClient,
  type RelayAgentThinClient,
  type RelayWorkspaceThinClient,
} from '@agent-relay/sdk';
import type { HarnessHostTool } from './harness-host.js';

export const NATIVE_RELAY_INSTRUCTIONS = `You are a participant in an Agent Relay workspace. Relay collaboration tools are installed as host-provided tools for this session. Use them directly whenever the user asks you to contact another agent, inspect collaborators or channels, check messages, or coordinate work. Do not ask the user how to use Relay, read a Relay skill file, register another identity, or fall back to shelling out to agent-relay. Prefer send_dm for a named recipient and post_message for a shared channel. Report a send as successful only after the tool returns successfully.`;

interface NativeRelayToolInput {
  [key: string]: unknown;
}

export interface NativeRelayToolOptions {
  env?: NodeJS.ProcessEnv;
  agentClient?: RelayAgentThinClient;
  workspaceClient?: RelayWorkspaceThinClient;
}

function objectInput(value: unknown): NativeRelayToolInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Relay tool input must be a JSON object');
  }
  return value as NativeRelayToolInput;
}

function requiredString(input: NativeRelayToolInput, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} is required`);
  return value.trim();
}

function optionalString(input: NativeRelayToolInput, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalLimit(input: NativeRelayToolInput): number | undefined {
  const value = input.limit;
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

const stringProperty = (description: string) => ({ type: 'string' as const, description });

export function createNativeRelayTools(options: NativeRelayToolOptions = {}): HarnessHostTool[] {
  const env = options.env ?? process.env;
  const agentToken = env.RELAY_AGENT_TOKEN?.trim();
  if (!agentToken) return [];
  const baseUrl = env.RELAY_BASE_URL?.trim() || undefined;
  const agent = options.agentClient ?? createAgentClient({ agentToken, baseUrl });
  const workspaceKey = (env.RELAY_WORKSPACE_KEY ?? env.RELAY_API_KEY)?.trim();
  const workspace =
    options.workspaceClient ?? (workspaceKey ? createWorkspaceClient({ workspaceKey, baseUrl }) : undefined);

  const tools: HarnessHostTool[] = [
    {
      spec: {
        name: 'send_dm',
        description: 'Send a direct message to a named Agent Relay participant.',
        inputSchema: {
          type: 'object',
          properties: {
            to: stringProperty('Exact recipient agent name.'),
            text: stringProperty('Message text.'),
          },
          required: ['to', 'text'],
          additionalProperties: false,
        },
      },
      execute: (value) => {
        const input = objectInput(value);
        return agent.dm(requiredString(input, 'to'), requiredString(input, 'text'));
      },
    },
    {
      spec: {
        name: 'post_message',
        description: 'Post a message to an Agent Relay channel.',
        inputSchema: {
          type: 'object',
          properties: {
            channel: stringProperty('Channel name.'),
            text: stringProperty('Message text.'),
          },
          required: ['channel', 'text'],
          additionalProperties: false,
        },
      },
      execute: (value) => {
        const input = objectInput(value);
        return agent.send(requiredString(input, 'channel'), requiredString(input, 'text'));
      },
    },
    {
      spec: {
        name: 'list_channels',
        description: 'List Agent Relay channels visible to this agent.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
      execute: () => agent.channels.list(),
    },
    {
      spec: {
        name: 'check_inbox',
        description: 'Check unread Agent Relay direct messages, mentions, and channel activity.',
        inputSchema: {
          type: 'object',
          properties: { limit: { type: 'integer', minimum: 1, description: 'Maximum items to return.' } },
          additionalProperties: false,
        },
      },
      execute: (value) => {
        const input = objectInput(value);
        return agent.inbox({ limit: optionalLimit(input) });
      },
    },
    {
      spec: {
        name: 'list_messages',
        description: 'Read recent messages from an Agent Relay channel.',
        inputSchema: {
          type: 'object',
          properties: {
            channel: stringProperty('Channel name.'),
            limit: { type: 'integer', minimum: 1, description: 'Maximum messages to return.' },
          },
          required: ['channel'],
          additionalProperties: false,
        },
      },
      execute: (value) => {
        const input = objectInput(value);
        return agent.messages(requiredString(input, 'channel'), { limit: optionalLimit(input) });
      },
    },
    {
      spec: {
        name: 'reply_to_thread',
        description: 'Reply to an Agent Relay message thread.',
        inputSchema: {
          type: 'object',
          properties: {
            message_id: stringProperty('Message id whose thread should receive the reply.'),
            text: stringProperty('Reply text.'),
          },
          required: ['message_id', 'text'],
          additionalProperties: false,
        },
      },
      execute: (value) => {
        const input = objectInput(value);
        return agent.reply(requiredString(input, 'message_id'), requiredString(input, 'text'));
      },
    },
    {
      spec: {
        name: 'search_messages',
        description: 'Search Agent Relay messages, optionally within a channel or from one sender.',
        inputSchema: {
          type: 'object',
          properties: {
            query: stringProperty('Search query.'),
            channel: stringProperty('Optional channel name.'),
            from: stringProperty('Optional sender name.'),
            limit: { type: 'integer', minimum: 1, description: 'Maximum results to return.' },
          },
          required: ['query'],
          additionalProperties: false,
        },
      },
      execute: (value) => {
        const input = objectInput(value);
        return agent.search(requiredString(input, 'query'), {
          channel: optionalString(input, 'channel'),
          from: optionalString(input, 'from'),
          limit: optionalLimit(input),
        });
      },
    },
  ];

  if (workspace) {
    tools.push({
      spec: {
        name: 'list_agents',
        description: 'List Agent Relay participants in the current workspace.',
        inputSchema: {
          type: 'object',
          properties: { status: stringProperty('Optional status filter such as online.') },
          additionalProperties: false,
        },
      },
      execute: (value) => {
        const input = objectInput(value);
        return workspace.agents.list({ status: optionalString(input, 'status') as never });
      },
    });
  }

  return tools;
}
