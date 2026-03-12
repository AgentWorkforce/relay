#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createInternalRelayCast, createInternalWsClient } from '@relaycast/sdk/internal';
import { MCP_VERSION } from '@relaycast/mcp';
import { enablePiggyback } from '@relaycast/mcp/dist/piggyback.js';
import { registerResourceDefinitions } from '@relaycast/mcp/dist/resources/definitions.js';
import { SubscriptionManager } from '@relaycast/mcp/dist/resources/subscriptions.js';
import { registerChannelTools } from '@relaycast/mcp/dist/tools/channels.js';
import { registerFeatureTools } from '@relaycast/mcp/dist/tools/features.js';
import { registerMessagingTools } from '@relaycast/mcp/dist/tools/messaging.js';
import { registerProgrammabilityTools } from '@relaycast/mcp/dist/tools/programmability.js';
import { createMcpTelemetry } from '@relaycast/mcp/dist/telemetry.js';
import { createInitialSession, type SessionState } from '@relaycast/mcp/dist/types.js';
import { WsBridge } from '@relaycast/mcp/dist/resources/ws-bridge.js';
import { z } from 'zod';

const DEFAULT_BASE_URL = 'https://api.relaycast.dev';
const DEFAULT_SYSTEM_PROMPT = `You are an AI agent in a collaborative workspace powered by Agent Relay. You can communicate with other agents using the following tools:

## Getting Started
1. If workspace key is not configured, call "create_workspace" or "set_workspace_key"
2. Call "register" with your agent name to join the workspace
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
- React with emoji to acknowledge messages (e.g. thumbsup for agreement)
- Keep messages concise and actionable`;

const jsonResult = z.object({}).passthrough();

type AgentType = 'agent' | 'human';
type RelayCastLike = ReturnType<typeof createInternalRelayCast>;
type AgentClientLike = ReturnType<RelayCastLike['as']>;

export interface PatchedMcpServerOptions {
  apiKey?: string;
  baseUrl?: string;
  agentToken?: string;
  agentName?: string;
  agentType?: AgentType;
  strictAgentName?: boolean;
  telemetryTransport?: 'stdio' | 'http';
}

type RegistrationSession = Pick<SessionState, 'workspaceKey' | 'agentToken' | 'agentName'>;
type SessionSetter = (partial: Partial<SessionState>) => void;

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

function normalizeBaseUrl(baseUrl?: string): string {
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

function envFlagEnabled(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function normalizeAgentType(value: string | undefined): AgentType | undefined {
  if (value === 'agent' || value === 'human') {
    return value;
  }

  return undefined;
}

async function createWorkspace(name: string, baseUrl?: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/v1/workspaces`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const payload = (await response.json()) as {
    ok?: boolean;
    data?: Record<string, unknown>;
    error?: { message?: string };
  } | null;

  if (!payload || typeof payload !== 'object' || typeof payload.ok !== 'boolean') {
    throw new Error('Invalid response while creating workspace');
  }
  if (!payload.ok) {
    throw new Error(payload.error?.message ?? 'Failed to create workspace');
  }

  return payload.data ?? {};
}

function requireWorkspaceKey(session: RegistrationSession): void {
  if (session.workspaceKey) {
    return;
  }

  throw new Error('Workspace key not configured. Call "create_workspace" or "set_workspace_key" first.');
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

function registerPatchedRegistrationTools(
  server: McpServer,
  getRelay: () => RelayCastLike,
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
      description:
        'Create a new Relaycast workspace and automatically store its API key in this MCP session. The workspace serves as an isolated environment where agents can communicate via channels, DMs, and threads. After creation, the workspace key is ready for immediate use with register and other workspace-level tools.',
      inputSchema: {
        name: z
          .string()
          .describe('Human-readable workspace name, used to identify the workspace in dashboards and logs'),
      },
      outputSchema: jsonResult,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ name }) => {
      const workspace = await createWorkspace(name, baseUrl);
      const workspaceKey = workspace.api_key ?? workspace.apiKey;
      if (!workspaceKey || typeof workspaceKey !== 'string') {
        throw new Error('Workspace created, but the response did not include api_key');
      }

      setSession({ workspaceKey, agentToken: null, agentName: null });
      return {
        content: [{ type: 'text', text: JSON.stringify(workspace, null, 2) }],
        structuredContent: workspace,
      };
    }
  );

  server.registerTool(
    'set_workspace_key',
    {
      title: 'Set Workspace Key',
      description:
        'Authenticate this MCP session by providing an existing workspace API key (rk_live_...). This enables all workspace-level tools including agent registration, channel management, and messaging. If the key belongs to a different workspace than the current session, the previous agent identity is cleared and you must re-register.',
      inputSchema: {
        api_key: z
          .string()
          .describe(
            'Workspace API key starting with "rk_live_", obtained from workspace creation or the Relaycast dashboard'
          ),
      },
      outputSchema: {
        message: z
          .string()
          .describe('Confirmation message indicating whether the workspace key was set successfully'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ api_key }) => {
      if (!api_key.startsWith('rk_live_')) {
        throw new Error('Workspace key must start with "rk_live_"');
      }

      const session = getSession();
      const switchingWorkspace = session.workspaceKey !== api_key;
      if (switchingWorkspace) {
        setSession({ workspaceKey: api_key, agentToken: null, agentName: null });
      } else {
        setSession({ workspaceKey: api_key });
      }

      const message = switchingWorkspace
        ? 'Workspace key set. Previous agent session was cleared; call "register" again.'
        : 'Workspace key set.';
      return {
        content: [{ type: 'text', text: message }],
        structuredContent: { message },
      };
    }
  );

  server.registerTool(
    'register',
    {
      title: 'Register Agent',
      description:
        'Register an agent identity in the current workspace and obtain an agent token for all subsequent operations. The agent name must be unique within the workspace. Re-registering the same name rotates or rebinds a usable token for that agent in the current workspace.',
      inputSchema: {
        name: z
          .string()
          .describe(
            'Unique agent name within the workspace, used as the display name in messages and mentions'
          ),
        type: z
          .enum(['agent', 'human'])
          .optional()
          .describe('Whether this identity represents an AI agent or a human user'),
        persona: z
          .string()
          .optional()
          .describe(
            "Free-text persona description that other agents can read to understand this agent's role and capabilities"
          ),
        metadata: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            'Key-value metadata to attach to the agent (e.g. { "cli": "claude", "model": "claude-sonnet-4-6" }). Use "model" to indicate which AI model powers this agent.'
          ),
      },
      outputSchema: jsonResult,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ name, type, persona, metadata }) => {
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

      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
      };
    }
  );
}

export function createPatchedRelayMcpServer(options: PatchedMcpServerOptions): McpServer {
  const session = createInitialSession({
    workspaceKey: options.apiKey ?? null,
    agentToken: options.agentToken ?? null,
    agentName: options.agentName ?? null,
  });

  const mcpOrigin = {
    surface: 'mcp',
    client: '@agent-relay/relaycast-mcp',
    version: MCP_VERSION,
  } as const;
  const telemetry = createMcpTelemetry(MCP_VERSION, {
    originSurface: mcpOrigin.surface,
    originClient: mcpOrigin.client,
    originVersion: mcpOrigin.version,
  });

  const mcpServer = new McpServer(
    { name: 'agent-relay', version: MCP_VERSION },
    {
      capabilities: {
        resources: { subscribe: true, listChanged: true },
        tools: {},
        prompts: {},
      },
    }
  );
  telemetry.capture('relaycast_mcp_server_started', {
    source_surface: 'mcp',
    transport: options.telemetryTransport ?? 'unknown',
  });

  const getSession = (): SessionState => session;
  const getRelay = (): RelayCastLike => {
    const workspaceKey = session.workspaceKey;
    if (!workspaceKey) {
      throw new Error(
        'Workspace key not configured. Set RELAY_API_KEY at startup, or call "create_workspace" or "set_workspace_key" first.'
      );
    }

    return createInternalRelayCast(
      {
        apiKey: workspaceKey,
        baseUrl: options.baseUrl,
      },
      mcpOrigin
    );
  };

  const setSession: SessionSetter = (partial) => {
    const nextAgentToken = partial.agentToken === undefined ? session.agentToken : partial.agentToken;
    const nextAgentName = partial.agentName ?? session.agentName ?? null;
    const shouldResetBridge = partial.agentToken !== undefined && partial.agentToken !== session.agentToken;

    if (shouldResetBridge && session.wsBridge) {
      session.wsBridge.stop();
      session.subscriptions?.clear();
      session.wsBridge = null;
      session.subscriptions = null;
    }
    if (shouldResetBridge) {
      session.wsInitAttempted = false;
    }

    if (nextAgentToken && !session.wsBridge && !session.wsInitAttempted) {
      try {
        const subscriptions = new SubscriptionManager();
        const wsClient = createInternalWsClient(
          {
            token: nextAgentToken,
            baseUrl: options.baseUrl,
          },
          mcpOrigin
        );
        const wsBridge = new WsBridge(wsClient as never, subscriptions, (uri) => {
          mcpServer.server.sendResourceUpdated({ uri }).catch(() => undefined);
        });
        wsBridge.start();
        Object.assign(session, partial, {
          wsBridge,
          subscriptions,
          wsInitAttempted: true,
        });
      } catch {
        Object.assign(session, partial, {
          wsBridge: null,
          subscriptions: null,
          wsInitAttempted: true,
        });
      }
      telemetry.capture('relaycast_mcp_session_authenticated', {
        source_surface: 'mcp',
        agent_name: nextAgentName,
      });
    } else {
      Object.assign(session, partial);
    }
  };

  const getAgentClient = (): AgentClientLike => {
    if (!session.agentToken) {
      throw new Error('Not registered. Call the "register" tool first.');
    }

    return createInternalRelayCast(
      {
        apiKey: session.agentToken,
        baseUrl: options.baseUrl,
      },
      mcpOrigin
    ).as(session.agentToken);
  };

  enablePiggyback(mcpServer, getSession, getAgentClient as never, telemetry);
  registerResourceDefinitions(mcpServer, getAgentClient as never, getRelay as never);
  registerPatchedRegistrationTools(
    mcpServer,
    getRelay,
    getSession,
    setSession,
    options.baseUrl,
    options.strictAgentName,
    options.agentName,
    options.agentType
  );
  registerChannelTools(mcpServer, getAgentClient as never);
  registerMessagingTools(mcpServer, getAgentClient as never);
  registerFeatureTools(mcpServer, getAgentClient as never);
  registerProgrammabilityTools(mcpServer, getRelay as never, getAgentClient as never);

  mcpServer.registerPrompt(
    'system',
    {
      title: 'System Prompt',
      description: 'Get the default system instructions for Relaycast collaboration.',
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

export async function resolvePatchedStdioBootstrapOptions(
  options: PatchedMcpServerOptions
): Promise<PatchedMcpServerOptions> {
  if (!options.apiKey || !options.agentName) {
    return options;
  }

  const relay = createInternalRelayCast(
    {
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
    },
    {
      surface: 'mcp',
      client: '@agent-relay/relaycast-mcp',
      version: MCP_VERSION,
    }
  );

  if (options.agentToken) {
    try {
      await relay.as(options.agentToken).inbox();
      return options;
    } catch (err) {
      const relayErr = err as { code?: string; statusCode?: number } | undefined;
      const unauthorized =
        relayErr?.code === 'unauthorized' || relayErr?.statusCode === 401 || relayErr?.statusCode === 403;
      if (!unauthorized) {
        throw err;
      }
    }
  }

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

function optionsFromEnv(): PatchedMcpServerOptions {
  return {
    apiKey: process.env.RELAY_API_KEY,
    baseUrl: process.env.RELAY_BASE_URL,
    agentToken: process.env.RELAY_AGENT_TOKEN,
    agentName: process.env.RELAY_AGENT_NAME ?? process.env.RELAY_CLAW_NAME,
    agentType: normalizeAgentType(process.env.RELAY_AGENT_TYPE),
    strictAgentName: envFlagEnabled(process.env.RELAY_STRICT_AGENT_NAME),
  };
}

if (isEntrypoint()) {
  startPatchedStdio(optionsFromEnv()).catch((error) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
