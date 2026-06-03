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
import {
  INVALID_AGENT_TOKEN_CODE,
  agentTokenRecoveryMessage,
  isInvalidAgentTokenError,
  isInvalidAgentTokenToolResult,
} from '@agent-relay/sdk';
import type {
  ActionAuditEvent,
  ActionSchema,
  AgentRelayActionDescriptor,
  AgentRelayActions,
  JsonSchemaLiteObject,
  ZodLikeSchema,
} from '@agent-relay/sdk/actions';
import { z } from 'zod';
import {
  initTelemetry,
  shutdown as shutdownTelemetry,
  track,
  type AgentRelayToolCallCategory,
  type AgentRelayToolCallType,
} from './telemetry/index.js';
import { relaycastWorkspaceTelemetryOptions, withRelaycastTelemetry } from './lib/relaycast-telemetry.js';
import { errorClassName } from './lib/telemetry-helpers.js';

const DEFAULT_BASE_URL = 'https://api.relaycast.dev';
export const AGENT_RELAY_MCP_VERSION = process.env.AGENT_RELAY_CLI_VERSION ?? SDK_VERSION ?? 'unknown';
let mcpTelemetryExitHookInstalled = false;

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

export interface AgentRelayMcpServerOptions {
  workspaceKey?: string;
  /** @deprecated Use workspaceKey. */
  apiKey?: string;
  baseUrl?: string;
  agentToken?: string;
  agentName?: string;
  agentType?: AgentType;
  strictAgentName?: boolean;
  telemetryTransport?: 'stdio' | 'http';
  skipBootstrap?: boolean;
  actions?: AgentRelayActions;
  onActionAuditEvent?: (event: ActionAuditEvent) => Promise<void> | void;
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

type RegistrationSession = Pick<SessionState, 'workspaceKey' | 'agentToken' | 'agentName'> & {
  agents?: Map<string, RegisteredAgent>;
};
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

async function createWorkspace(name: string, baseUrl?: string): Promise<Record<string, unknown>> {
  return (await RelayCast.createWorkspace(name, {
    baseUrl,
    ...relaycastWorkspaceTelemetryOptions(),
  })) as Record<string, unknown>;
}

function extractWorkspaceKey(payload: Record<string, unknown>): string | undefined {
  const data =
    payload.data && typeof payload.data === 'object' ? (payload.data as Record<string, unknown>) : {};
  const value =
    payload.workspaceKey ??
    payload.workspace_key ??
    payload.apiKey ??
    payload.api_key ??
    data.workspaceKey ??
    data.workspace_key ??
    data.apiKey ??
    data.api_key;

  return typeof value === 'string' && value.trim() ? value : undefined;
}

function extractWorkspaceName(payload: Record<string, unknown>, fallback: string): string {
  const data =
    payload.data && typeof payload.data === 'object' ? (payload.data as Record<string, unknown>) : {};
  const value = payload.workspaceName ?? payload.workspace_name ?? payload.name ?? data.workspaceName;
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function requireWorkspaceKey(session: RegistrationSession): void {
  if (session.workspaceKey) {
    return;
  }

  throw new Error(
    'Workspace key not configured. Call "create_workspace" first, or "set_workspace_key" if someone shared a workspace key.'
  );
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

function isSchemaObject(schema: ActionSchema | undefined): schema is JsonSchemaLiteObject {
  return Boolean(
    schema &&
    typeof schema === 'object' &&
    !Array.isArray(schema) &&
    typeof (schema as { safeParse?: unknown }).safeParse !== 'function'
  );
}

function getSchemaDescription(schema: ActionSchema | undefined): string | undefined {
  return isSchemaObject(schema) && typeof schema.description === 'string' ? schema.description : undefined;
}

function zodFromJsonSchema(schema: ActionSchema | undefined): z.ZodTypeAny {
  if (schema === false) {
    return z.never();
  }

  if (!isSchemaObject(schema)) {
    return z.unknown();
  }

  let zodType: z.ZodTypeAny;
  const schemaType = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (schemaType) {
    case 'array':
      zodType = z.array(zodFromJsonSchema(schema.items));
      break;
    case 'boolean':
      zodType = z.boolean();
      break;
    case 'integer':
      zodType = z.number().int();
      break;
    case 'number':
      zodType = z.number();
      break;
    case 'object':
      if (schema.properties) {
        const required = new Set(schema.required ?? []);
        const shape: Record<string, z.ZodTypeAny> = {};
        for (const [key, childSchema] of Object.entries(schema.properties)) {
          const child = zodFromJsonSchema(childSchema);
          shape[key] = required.has(key) ? child : child.optional();
        }
        zodType = z.object(shape).passthrough();
      } else {
        zodType = z.record(z.string(), z.unknown());
      }
      break;
    case 'string':
      zodType = z.string();
      break;
    default:
      zodType = z.unknown();
      break;
  }

  const description = getSchemaDescription(schema);
  return description ? zodType.describe(description) : zodType;
}

function actionToolInputSchema(schema: ActionSchema | undefined): Record<string, z.ZodTypeAny> {
  const zodShape = zodObjectShape(schema);
  if (zodShape) {
    return zodShape;
  }

  if (!isSchemaObject(schema) || schema.type !== 'object') {
    return {
      input: z.unknown().describe('Action input payload. The action registry performs final validation.'),
    };
  }

  const required = new Set(schema.required ?? []);
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, childSchema] of Object.entries(schema.properties ?? {})) {
    const child = zodFromJsonSchema(childSchema);
    shape[key] = required.has(key) ? child : child.optional();
  }
  return shape;
}

function actionInvocationInput(descriptor: AgentRelayActionDescriptor, args: unknown): unknown {
  const schema = descriptor.inputSchema;
  if (zodObjectShape(schema)) {
    return args;
  }
  if (!isSchemaObject(schema) || schema.type !== 'object') {
    return typeof args === 'object' && args !== null && 'input' in args
      ? (args as { input?: unknown }).input
      : args;
  }
  return args;
}

function zodObjectShape(schema: ActionSchema | undefined): Record<string, z.ZodTypeAny> | undefined {
  if (schema instanceof z.ZodObject) {
    return schema.shape;
  }
  return undefined;
}

function serializableActionDescriptor(descriptor: AgentRelayActionDescriptor): Record<string, unknown> {
  return {
    name: descriptor.name,
    description: descriptor.description,
    visibility: descriptor.visibility,
    ...(descriptor.inputSchema ? { inputSchema: serializableActionSchema(descriptor.inputSchema) } : {}),
    ...(descriptor.outputSchema ? { outputSchema: serializableActionSchema(descriptor.outputSchema) } : {}),
  };
}

function serializableActionSchema(schema: ActionSchema): unknown {
  if (isSchemaObject(schema)) {
    return schema;
  }
  if (isZodLikeSchema(schema)) {
    return {
      type: 'zod',
      ...(schema.description ? { description: schema.description } : {}),
    };
  }
  return schema;
}

function isZodLikeSchema(schema: ActionSchema | undefined): schema is ZodLikeSchema {
  return Boolean(
    schema &&
    typeof schema === 'object' &&
    !Array.isArray(schema) &&
    typeof (schema as { safeParse?: unknown }).safeParse === 'function'
  );
}

function registerAgentRelayActionTools(
  server: McpServer,
  actions: AgentRelayActions | undefined,
  getSession: () => SessionState,
  onAuditEvent?: (event: ActionAuditEvent) => Promise<void> | void,
  getAgentClient?: (asIdentity?: string) => AgentClientLike,
  actionToolNames?: Set<string>
): void {
  if (!actions) {
    return;
  }

  /**
   * Fire-and-forget invocation through the relay: returns an immediate ack
   * (with an `invocation_id`) and does NOT run the handler inline. Falls back to
   * the local in-process registry when the relay action surface is unavailable.
   */
  const invokeAction = async (name: string, input: unknown) => {
    const relayActions = getRelayAgentActions(getAgentClient);
    if (relayActions) {
      try {
        const ack = await relayActions.invoke(name, asInputRecord(input));
        return jsonContent({ ok: true, status: 'invoked', invocation: ack });
      } catch (error) {
        return { ...jsonContent({ ok: false, error: errorMessage(error) }), isError: true };
      }
    }

    const session = getSession();
    const result = await actions.invoke({
      name,
      input,
      context: {
        caller: { name: session.agentName ?? 'mcp', type: 'agent' },
        emit: onAuditEvent,
      },
    });
    return result.ok ? jsonContent(result) : { ...jsonContent(result), isError: true };
  };

  server.registerTool(
    'list_actions',
    {
      title: 'List Actions',
      description: 'List Agent Relay actions available to this agent.',
      inputSchema: {},
      outputSchema: jsonResult,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () =>
      jsonContent({
        actions: (await actions.list({ visibility: 'agent' })).map(serializableActionDescriptor),
      })
  );

  server.registerTool(
    'invoke_action',
    {
      title: 'Invoke Action',
      description:
        'Invoke a registered Agent Relay action by name. Fire-and-forget: returns an ack with an invocation id; the result arrives asynchronously to the action handler.',
      inputSchema: {
        name: z.string().describe('Registered action name'),
        input: z.unknown().describe('Action input payload'),
      },
      outputSchema: jsonResult,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ name, input }: { name: string; input: unknown }) => invokeAction(name, input)
  );

  void actions
    .list({ visibility: 'agent' })
    .then((descriptors) => {
      for (const descriptor of descriptors) {
        actionToolNames?.add(descriptor.name);
        server.registerTool(
          descriptor.name,
          {
            title: descriptor.name,
            description: descriptor.description,
            inputSchema: actionToolInputSchema(descriptor.inputSchema),
            outputSchema: jsonResult,
            annotations: {
              readOnlyHint: false,
              destructiveHint: false,
              idempotentHint: false,
              openWorldHint: false,
            },
          },
          async (args: unknown) => invokeAction(descriptor.name, actionInvocationInput(descriptor, args))
        );
      }
    })
    .catch(() => undefined);
}

/** The relay-backed action surface on the live agent client, when available. */
function getRelayAgentActions(
  getAgentClient?: (asIdentity?: string) => AgentClientLike
): AgentClientLike['actions'] | undefined {
  if (!getAgentClient) {
    return undefined;
  }
  try {
    return getAgentClient().actions;
  } catch {
    return undefined;
  }
}

function asInputRecord(input: unknown): Record<string, unknown> | undefined {
  if (input === undefined || input === null) {
    return undefined;
  }
  if (typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return { input };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
    case 'webhook.received': {
      const channel = getStringEventField(event, 'channel');
      return channel ? [`relay://channels/${channel}/messages`] : [];
    }
    case 'action.invoked':
    case 'action.completed':
    case 'action.failed':
      // Actions are not channel-scoped; surface invocations via the inbox.
      return ['relay://inbox'];
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

function readAsIdentity(args: unknown[]): string | undefined {
  const [input] = args;
  if (typeof input !== 'object' || input === null) return undefined;
  const as = (input as { as?: unknown }).as;
  return typeof as === 'string' ? as : undefined;
}

function invalidAgentTokenToolResult(): JsonToolResult & { isError: true } {
  const text = agentTokenRecoveryMessage();
  return {
    content: [{ type: 'text', text }],
    structuredContent: {
      error: { code: INVALID_AGENT_TOKEN_CODE, message: text },
    },
    isError: true,
  };
}

interface AgentRelayToolCallMetadata {
  toolType: AgentRelayToolCallType;
  toolCategory: AgentRelayToolCallCategory;
}

const AGENT_RELAY_TOOL_CALL_METADATA = {
  add_agent: { toolType: 'agent.create', toolCategory: 'spawn' },
  remove_agent: { toolType: 'agent.release', toolCategory: 'release' },
  invoke_action: { toolType: 'action.invoke', toolCategory: 'action' },
  list_actions: { toolType: 'action.list', toolCategory: 'action' },
  submit_result: { toolType: 'result.submit', toolCategory: 'result' },
  create_workspace: { toolType: 'workspace.create', toolCategory: 'workspace' },
  set_workspace_key: { toolType: 'workspace.set_key', toolCategory: 'workspace' },
  register_agent: { toolType: 'agent.register', toolCategory: 'agent' },
  list_agents: { toolType: 'agent.list', toolCategory: 'agent' },
  post_message: { toolType: 'message.post', toolCategory: 'message' },
  send_dm: { toolType: 'message.dm', toolCategory: 'message' },
  send_group_dm: { toolType: 'message.group_dm', toolCategory: 'message' },
  list_dms: { toolType: 'message.dm_list', toolCategory: 'message' },
  list_messages: { toolType: 'message.list', toolCategory: 'message' },
  get_message: { toolType: 'message.get', toolCategory: 'message' },
  reply_to_thread: { toolType: 'message.reply', toolCategory: 'message' },
  get_message_thread: { toolType: 'message.thread', toolCategory: 'message' },
  get_thread: { toolType: 'message.thread', toolCategory: 'message' },
  search_messages: { toolType: 'message.search', toolCategory: 'message' },
  create_channel: { toolType: 'channel.create', toolCategory: 'channel' },
  list_channels: { toolType: 'channel.list', toolCategory: 'channel' },
  join_channel: { toolType: 'channel.join', toolCategory: 'channel' },
  leave_channel: { toolType: 'channel.leave', toolCategory: 'channel' },
  set_channel_topic: { toolType: 'channel.set_topic', toolCategory: 'channel' },
  archive_channel: { toolType: 'channel.archive', toolCategory: 'channel' },
  invite_to_channel: { toolType: 'channel.invite', toolCategory: 'channel' },
  list_channel_members: { toolType: 'channel.member_list', toolCategory: 'channel' },
  add_reaction: { toolType: 'reaction.add', toolCategory: 'reaction' },
  remove_reaction: { toolType: 'reaction.remove', toolCategory: 'reaction' },
  check_inbox: { toolType: 'inbox.check', toolCategory: 'inbox' },
  mark_message_read: { toolType: 'inbox.mark_read', toolCategory: 'inbox' },
  get_message_readers: { toolType: 'inbox.reader_list', toolCategory: 'inbox' },
} satisfies Record<string, AgentRelayToolCallMetadata>;

function readInvokedActionName(name: string, args: unknown[]): AgentRelayToolCallType | undefined {
  if (name !== 'invoke_action') {
    return undefined;
  }
  const [input] = args;
  if (!input || typeof input !== 'object') {
    return undefined;
  }
  const actionName = (input as { name?: unknown }).name;
  return typeof actionName === 'string' && actionName.trim() ? actionName : undefined;
}

function agentRelayActionNameCategory(name: string): AgentRelayToolCallCategory {
  const leaf = name.split(/[._-]/).filter(Boolean).at(-1)?.toLowerCase();
  switch (leaf) {
    case 'create':
    case 'spawn':
    case 'attach':
      return 'spawn';
    case 'release':
      return 'release';
    case 'status':
      return 'agent';
    default:
      return 'action';
  }
}

function agentRelayToolCallMetadata(
  name: string,
  args: unknown[],
  actionToolNames: Set<string>
): AgentRelayToolCallMetadata {
  const invokedActionName = readInvokedActionName(name, args);
  if (invokedActionName) {
    return {
      toolType: invokedActionName,
      toolCategory: agentRelayActionNameCategory(invokedActionName),
    };
  }

  const known = (AGENT_RELAY_TOOL_CALL_METADATA as Partial<Record<string, AgentRelayToolCallMetadata>>)[name];
  if (known) {
    return known;
  }

  if (actionToolNames.has(name)) {
    return {
      toolType: name,
      toolCategory: agentRelayActionNameCategory(name),
    };
  }

  return { toolType: name, toolCategory: 'tool' };
}

function isErrorToolResult(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && (value as { isError?: unknown }).isError === true);
}

function trackAgentRelayToolCall(input: {
  toolName: string;
  toolType: AgentRelayToolCallType;
  toolCategory: AgentRelayToolCallCategory;
  transport?: AgentRelayMcpServerOptions['telemetryTransport'];
  startedAt: number;
  success: boolean;
  errorClass?: string;
}): void {
  track('agent_relay_tool_call', {
    tool_name: input.toolName,
    tool_type: input.toolType,
    tool_category: input.toolCategory,
    transport: input.transport ?? 'unknown',
    success: input.success,
    duration_ms: Date.now() - input.startedAt,
    ...(input.errorClass ? { error_class: input.errorClass } : {}),
  });
}

function enableInboxPiggyback(
  mcpServer: McpServer,
  getSession: () => SessionState,
  getAgentClient: (asIdentity?: string) => AgentClientLike,
  invalidateAgentToken: (asIdentity?: string) => void,
  telemetryTransport?: AgentRelayMcpServerOptions['telemetryTransport'],
  actionToolNames = new Set<string>()
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
      const asIdentity = readAsIdentity(args);
      const startedAt = Date.now();
      const toolMetadata = agentRelayToolCallMetadata(name, args, actionToolNames);

      let result: any;
      try {
        result = await handler(...args);
      } catch (err) {
        // `register_agent` is the recovery path itself — never invalidate a
        // freshly-issued token, and let registration errors bubble normally.
        if (name !== 'register_agent' && isInvalidAgentTokenError(err)) {
          invalidateAgentToken(asIdentity);
          trackAgentRelayToolCall({
            toolName: name,
            toolType: toolMetadata.toolType,
            toolCategory: toolMetadata.toolCategory,
            transport: telemetryTransport,
            startedAt,
            success: false,
            errorClass: errorClassName(err) ?? 'InvalidAgentToken',
          });
          return invalidAgentTokenToolResult();
        }
        trackAgentRelayToolCall({
          toolName: name,
          toolType: toolMetadata.toolType,
          toolCategory: toolMetadata.toolCategory,
          transport: telemetryTransport,
          startedAt,
          success: false,
          errorClass: errorClassName(err),
        });
        throw err;
      }

      // Successful response that still carries an "Invalid agent token" body.
      if (name !== 'register_agent' && isInvalidAgentTokenToolResult(result)) {
        invalidateAgentToken(asIdentity);
        trackAgentRelayToolCall({
          toolName: name,
          toolType: toolMetadata.toolType,
          toolCategory: toolMetadata.toolCategory,
          transport: telemetryTransport,
          startedAt,
          success: false,
          errorClass: 'InvalidAgentToken',
        });
        if (hasContentArray(result)) {
          result.content.push({ type: 'text', text: agentTokenRecoveryMessage() });
        }
        return result;
      }

      if (!SKIP_PIGGYBACK.has(name) && getSession().agentToken && hasContentArray(result)) {
        try {
          const inbox = await getAgentClient(asIdentity).inbox();
          const inboxText = formatInbox(inbox, asIdentity ?? getSession().agentName);
          if (inboxText) {
            result.content.push({ type: 'text', text: inboxText });
          }
        } catch (err) {
          // Inbox piggyback is opportunistic; the original tool result should
          // still win. But if the inbox fetch itself reveals an invalid token,
          // clear the stale identity so the next call doesn't reuse it.
          if (isInvalidAgentTokenError(err)) {
            invalidateAgentToken(asIdentity);
          }
        }
      }

      const resultIsError = isErrorToolResult(result);
      trackAgentRelayToolCall({
        toolName: name,
        toolType: toolMetadata.toolType,
        toolCategory: toolMetadata.toolCategory,
        transport: telemetryTransport,
        startedAt,
        success: !resultIsError,
        ...(resultIsError ? { errorClass: 'ToolResultError' } : {}),
      });
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
        const wsClient = new WsClient(
          withRelaycastTelemetry({
            token: session.agentToken,
            baseUrl: options.baseUrl,
          })
        );
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

    // Clear the active-session token when the invalidated identity is the
    // active one (or the caller didn't pin to a particular identity). The
    // active workspaceKey stays intact so `register_agent` can recover.
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

  if (session.agentToken && !session.wsBridge) {
    setSession({ agentToken: session.agentToken, agentName: session.agentName });
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
