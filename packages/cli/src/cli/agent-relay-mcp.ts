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
import {
  AgentRelay,
  RELAYCAST_SDK_VERSION,
  createAgentClient,
  createRealtimeClient,
  createWorkspaceClient,
  isInvalidAgentTokenError,
} from '@agent-relay/sdk';
import { z } from 'zod';
import { initTelemetry, shutdown as shutdownTelemetry } from './telemetry/index.js';
import { RealtimeResourceBridge, SubscriptionManager, registerResourceDefinitions } from './mcp/resources.js';
import { jsonContent, jsonResult, textContent } from './mcp/tool-results.js';
import {
  createWorkspace,
  extractWorkspaceKey,
  extractWorkspaceName,
  requireWorkspaceKey,
} from './mcp/workspace.js';
import { enableInboxPiggyback } from './mcp/telemetry.js';
import { registerAgentRelayActionTools } from './mcp/action-tools.js';
import { registerMessagingTools } from './mcp/messaging-tools.js';
import { identityOverrideInputShape, messageResult } from './mcp/tool-shapes.js';
import {
  describeClearedEnrollment,
  persistWorkspaceSession,
  resolveWorkspaceSessionKey,
  validateWorkspaceSessionName,
} from './lib/workspace-session.js';
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

export const AGENT_RELAY_MCP_VERSION =
  process.env.AGENT_RELAY_CLI_VERSION ?? RELAYCAST_SDK_VERSION ?? 'unknown';
let mcpTelemetryExitHookInstalled = false;

const EXIT_AFTER_TASK_INSTRUCTION =
  '## Post-task exit\n' +
  'When the requested task is fully complete and you have reported the final outcome, output `/exit` on its own line so the Agent Relay harness exits cleanly. Do not output `/exit` before the task is complete.';

function withExitAfterTaskInstruction(task: string): string {
  return `${task}\n\n${EXIT_AFTER_TASK_INSTRUCTION}`;
}

const PERSONA_SPAWN_TIMEOUT_MS = 130_000;
const PERSONA_SPAWN_POLL_MS = 250;

type InvocationReader = {
  getInvocation(name: string, invocationId: string): Promise<unknown>;
};

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function invocationText(record: Record<string, unknown>, camel: string, snake?: string): string | undefined {
  const value = record[camel] ?? (snake ? record[snake] : undefined);
  return typeof value === 'string' && value.trim() ? value : undefined;
}

async function waitForPersonaSpawn(
  actions: InvocationReader,
  ackValue: unknown,
  timeoutMs = PERSONA_SPAWN_TIMEOUT_MS
): Promise<unknown> {
  const ack = recordValue(ackValue);
  const actionName = invocationText(ack, 'actionName', 'action_name') ?? 'spawn';
  const invocationId = invocationText(ack, 'invocationId', 'invocation_id');
  if (!invocationId) throw new Error('Persona spawn did not return an invocation id.');

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let invocation: unknown;
    try {
      invocation = await actions.getInvocation(actionName, invocationId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        isInvalidAgentTokenError(error) ||
        /invalid.?agent.?token|unauthori[sz]ed|forbidden/i.test(message)
      ) {
        throw error;
      }
      if (Date.now() >= deadline) {
        throw new Error('Persona spawn timed out before broker registration and harness readiness.');
      }
      await new Promise<void>((resolve) => setTimeout(resolve, PERSONA_SPAWN_POLL_MS));
      continue;
    }
    const record = recordValue(invocation);
    const status = invocationText(record, 'status')?.toLowerCase();
    if (status === 'completed' || status === 'succeeded' || status === 'success') {
      return invocation;
    }
    if (status === 'failed' || status === 'error' || status === 'cancelled' || status === 'canceled') {
      throw new Error(invocationText(record, 'error') ?? `Persona spawn ${status}.`);
    }
    if (Date.now() >= deadline) {
      throw new Error('Persona spawn timed out before broker registration and harness readiness.');
    }
    await new Promise<void>((resolve) => setTimeout(resolve, PERSONA_SPAWN_POLL_MS));
  }
}

export const AGENT_RELAY_MCP_INSTRUCTIONS = `You are an AI agent in a collaborative workspace powered by Agent Relay. You can communicate with other agents using these MCP tools:

## Coordination rule
- When the user asks you to work with, contact, coordinate with, or wait for named participants that already exist in this Agent Relay workspace, use Agent Relay tools such as "list_agents", "send_dm", "post_message", and "check_inbox".
- Existing Relay participants are not local or built-in subagents. Do not replace them with your CLI's native subagent, team, task, or collaboration feature.
- Do not claim to have contacted or waited for a Relay participant unless the corresponding Relay tool call succeeded.

## Getting Started
1. The current project workspace is resumed automatically when one was selected before
2. Call "create_workspace" only when you explicitly want to start a new workspace session
3. If someone shared an existing workspace key with you, call "set_workspace_key"
4. When a workspace key is available at startup, this MCP server auto-registers the session as RELAY_AGENT_NAME (or "orchestrator" by default). Otherwise call "register_agent" with your agent name to join the workspace
5. Use "list_channels" to see available channels
6. Use "join_channel" to join channels of interest
7. Use "check_inbox" to see unread messages and mentions

## Communication
- Post messages to channels with "post_message"
- Send direct messages with "send_dm"
- Reply to threads with "reply_to_thread"
- React to messages with "add_reaction"

## Fleet
- Use "query_nodes" to find fleet nodes by capability or name
- Use "spawn" with either a CLI or an AgentWorkforce persona to invoke the fleet spawn action on an eligible node
- Persona spawns require a node exposing "spawn:persona" through @agentworkforce/local-surface's defineWorkforcePersonaSpawnNode

## Best Practices
- Check your inbox regularly for new messages and mentions
- Use channels for topic-based discussions
- Use threads for detailed discussions to keep channels organized
- React with emoji to acknowledge messages
- Keep messages concise and actionable`;

const DEFAULT_SYSTEM_PROMPT = AGENT_RELAY_MCP_INSTRUCTIONS;

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
  const value = process.env[key]?.trim();
  if (!value || isUnresolvedEnvTemplate(value)) return undefined;
  return value;
}

/** Return whether an environment value is an unresolved `${...}` placeholder. */
function isUnresolvedEnvTemplate(value: string): boolean {
  return /^\$\{.+\}$/.test(value.trim());
}

/**
 * Normalize a base URL by stripping trailing slashes. Returns `undefined` when
 * no base URL is provided — this helper never injects a default. The hosted
 * base-URL default is owned by the underlying Relaycast engine clients (the
 * `@agent-relay/sdk` thin clients and `AgentRelay` apply it when
 * `options.baseUrl` is omitted).
 *
 * @deprecated No longer used internally; retained only to keep the public
 * `agent-relay/mcp` export surface stable for downstream importers.
 */
export function normalizeBaseUrl(baseUrl?: string): string | undefined {
  if (!baseUrl) return undefined;
  // Strip trailing slashes with a linear loop rather than a regex. A pattern
  // like `/\/+$/` triggers CodeQL's polynomial-backtracking (ReDoS) warning on
  // uncontrolled input with many repeated '/'; `endsWith`/`slice` is O(n) and
  // has no backtracking.
  let url = baseUrl;
  while (url.endsWith('/')) url = url.slice(0, -1);
  return url;
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
        'Submit the structured result for this spawned Agent Relay task. Call this when the requested work is complete and the result object is ready. ' +
        'Returns the acknowledgement payload from the spawning caller. Throws if the caller rejects the submission, in which case the result was not recorded. A timeout leaves the outcome unknown — the request may have been recorded before the client stopped waiting — so treat a retry as a possible duplicate rather than a safe repeat.' +
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

function registerAgentRelayTools(
  server: McpServer,
  getRelay: () => RelayCastLike,
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
      description:
        'Explicitly start a new Agent Relay workspace session and persist it for this project. ' +
        "Returns the new workspace key and its resolved name. A `warning` field appears in two cases, and its text says which: the workspace was created but its session could not be saved to disk, meaning the key must be kept and re-supplied to reconnect; or the session was saved and doing so dropped this project's enrolled Cloud fleet node, because the new workspace is not the one that node belongs to.",
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
      const requestedName = validateWorkspaceSessionName(name);
      const workspace = await createWorkspace(requestedName, baseUrl);
      const workspaceKey = extractWorkspaceKey(workspace);
      if (!workspaceKey || typeof workspaceKey !== 'string') {
        throw new Error('Workspace created, but the response did not include a workspace key.');
      }
      const workspaceName = extractWorkspaceName(workspace, requestedName);

      setSession({
        workspaceKey,
        agentToken: null,
        agentName: null,
        agents: new Map(),
      });
      let persistenceWarning: string | undefined;
      try {
        // A new workspace key never matches an existing pin, so this can drop
        // the project's enrolled fleet node. Report it rather than letting the
        // next `node up` be the first thing that mentions it.
        persistenceWarning = describeClearedEnrollment(
          persistWorkspaceSession({ name: workspaceName, workspaceKey })
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        persistenceWarning =
          `Workspace created, but its session could not be persisted locally: ${message}. ` +
          'Keep the returned workspace key and retry persistence before starting another session.';
      }
      return jsonContent({
        workspaceKey,
        workspaceName,
        ...(persistenceWarning ? { warning: persistenceWarning } : {}),
      });
    }
  );

  server.registerTool(
    'set_workspace_key',
    {
      title: 'Set Workspace Key',
      description:
        'Join this MCP session to an existing Agent Relay workspace using a shared workspace key. ' +
        'Returns a confirmation message stating whether the key was persisted for this project, and whether "register_agent" must be called to claim an identity in the newly joined workspace. The message also reports when joining dropped this project\'s enrolled Cloud fleet node, which happens when the key names a workspace that node does not belong to.',
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
      let persistenceWarning: string | undefined;
      try {
        // Joining a different workspace drops this project's enrolled fleet
        // node; surface that here instead of at the next `node up`.
        persistenceWarning = describeClearedEnrollment(persistWorkspaceSession({ workspaceKey: key }));
      } catch (error) {
        const persistenceError = error instanceof Error ? error.message : String(error);
        persistenceWarning =
          `The workspace is active for this process, but its session could not be persisted locally: ` +
          `${persistenceError}. Retry persistence before restarting this MCP server.`;
      }

      const persistedMessage = switchingWorkspace
        ? 'Workspace key set and persisted for this project. Call "register_agent" to join this workspace.'
        : 'Workspace key set and persisted for this project.';
      const activeMessage = switchingWorkspace
        ? 'Workspace key set. Call "register_agent" to join this workspace.'
        : 'Workspace key set.';
      const message = persistenceWarning ? `${activeMessage} ${persistenceWarning}` : persistedMessage;
      return textContent(message);
    }
  );

  server.registerTool(
    'register_agent',
    {
      title: 'Register Agent',
      description:
        'Claim a named identity in the current workspace so this session can post messages, read channels, and be addressed by other agents. ' +
        'Required before any messaging tool will work. ' +
        'Returns the agent token and the registered name, which can differ from the requested `name` when that name is already taken and the session rebinds to an available one. ' +
        'The token is stored in this session, so later tool calls do not need to pass it.',
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
      description:
        'List agents registered in the current workspace. ' +
        'Returns an `agents` array of registered identities, narrowed to only online or only offline agents when `status` is supplied. An empty array means the workspace has no agent matching the filter.',
      inputSchema: {
        status: z.enum(['online', 'offline']).optional().describe('Optional status filter'),
      },
      outputSchema: {
        agents: z.array(z.looseObject({})).describe('Registered agents'),
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
      description:
        'Query registered fleet nodes by capability or name. ' +
        'Returns a `nodes` array of the fleet nodes matching every supplied filter; an empty array means no node matched. Use it to find a node name to pass as `target_node` when spawning.',
      inputSchema: {
        capability: z.string().optional().describe('Optional capability name filter'),
        name: z.string().optional().describe('Optional node name filter'),
      },
      outputSchema: {
        nodes: z.array(z.looseObject({})).describe('Fleet nodes'),
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

  registerMessagingTools(server, getAgentClient);

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
        'Do NOT use the built-in Agent/Task tool for relay workers. ' +
        'Returns the spawn record for the new worker, including the name it registered under. The worker boots asynchronously, so a successful return means the spawn was accepted, not that the worker is ready — watch for its messages or poll "list_agents" to confirm it came online.',
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
          cli,
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
      description:
        'Invoke the fleet spawn action with either a raw `cli` or an AgentWorkforce `persona` name/path. ' +
        'Persona requests route to a node exposing `spawn:persona` (for example, `defineWorkforcePersonaSpawnNode` from `@agentworkforce/local-surface`) and return only after broker registration and harness readiness are verified. Raw CLI requests retain asynchronous acknowledgement behavior.',
      inputSchema: {
        name: z.string().describe('Agent name'),
        cli: z
          .enum(['claude', 'codex', 'gemini', 'aider', 'goose', 'grok', 'opencode'])
          .optional()
          .describe('AI CLI to launch; mutually exclusive with persona'),
        persona: z
          .string()
          .optional()
          .describe('AgentWorkforce persona id or JSON path; mutually exclusive with cli'),
        task: z.string().optional().describe('Initial task instructions'),
        cwd: z.string().optional().describe('Project cwd used for persona registry resolution'),
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
    async ({ name, cli, persona, task, cwd, channel, channels, model, session_ref, target_node, as }) => {
      const actions = getAgentClient(as).actions;
      if (!actions) {
        throw new Error('spawn requires an agent-scoped Relaycast actions client.');
      }
      if (Boolean(cli) === Boolean(persona)) {
        throw new Error('spawn requires exactly one of `cli` or `persona`.');
      }
      if (persona && model) {
        throw new Error('Persona harness and model come from the persona spec; omit `model`.');
      }
      if (persona && session_ref) {
        throw new Error('Persona session settings come from the persona launch plan; omit `session_ref`.');
      }
      const actionInput = {
        name,
        ...(cli ? { cli } : { persona, capability: 'spawn:persona' }),
        ...(task ? { task } : {}),
        ...(persona && cwd ? { cwd } : {}),
        ...(model ? { model } : {}),
        ...(session_ref ? { session_ref } : {}),
        ...(target_node ? { target_node } : {}),
        ...((channels ?? (channel ? [channel] : undefined)) ? { channels: channels ?? [channel] } : {}),
      };
      if (!persona) {
        return jsonContent({ invocation: await actions.invoke('spawn', actionInput) });
      }
      const session = getSession();
      const agentToken = as ? session.agents.get(as)?.agentToken : session.agentToken;
      if (!agentToken) {
        throw new Error('Persona spawn requires a registered agent identity.');
      }
      const relay = new AgentRelay({ agentToken, baseUrl });
      const invocation = await relay.messaging.commands.invoke('spawn', actionInput);
      return jsonContent({
        invocation: await waitForPersonaSpawn(relay.messaging.commands, invocation),
      });
    }
  );

  server.registerTool(
    'remove_agent',
    {
      title: 'Remove Agent',
      description:
        'Release a worker agent from active duty, optionally deleting it outright. ' +
        'Returns an `invocation` record acknowledging the request, which is processed asynchronously. Releasing keeps the agent registered and re-spawnable; passing `delete_agent` removes the identity permanently.',
      inputSchema: {
        name: z.string().describe('Agent name'),
        reason: z.string().optional().describe('Removal reason'),
        delete_agent: z.boolean().optional().describe('Permanently delete the agent'),
      },
      outputSchema: jsonResult,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ name, reason, delete_agent }) => {
      const invocation = await getRelay().agents.release({ name, reason, deleteAgent: delete_agent });
      return jsonContent({ invocation });
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
      instructions: AGENT_RELAY_MCP_INSTRUCTIONS,
    }
  );

  const getSession = (): SessionState => session;
  const getRelay = (): RelayCastLike => {
    const workspaceKey = session.workspaceKey;
    if (!workspaceKey) {
      throw new Error(
        'Workspace key not configured. Call "create_workspace" first, or provide a shared workspace key with "set_workspace_key".'
      );
    }

    return createWorkspaceClient({ workspaceKey, baseUrl: options.baseUrl });
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
        const wsClient = createRealtimeClient({
          agentToken: session.agentToken,
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
    return createAgentClient({ agentToken, baseUrl: options.baseUrl });
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

  const relay = createWorkspaceClient({ workspaceKey, baseUrl: options.baseUrl });

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
  let workspaceKey =
    resolveEnv('RELAY_WORKSPACE_KEY') ??
    resolveEnv('AGENT_RELAY_WORKSPACE_KEY') ??
    resolveEnv('RELAY_API_KEY');
  let resumedPersistedWorkspace = false;
  const hasUnresolvedWorkspacePlaceholder = [
    process.env.RELAY_WORKSPACE_KEY,
    process.env.AGENT_RELAY_WORKSPACE_KEY,
    process.env.RELAY_API_KEY,
  ].some((value) => value !== undefined && isUnresolvedEnvTemplate(value));

  if (!workspaceKey && !hasUnresolvedWorkspacePlaceholder) {
    try {
      workspaceKey = resolveWorkspaceSessionKey();
      resumedPersistedWorkspace = Boolean(workspaceKey);
    } catch {
      // A malformed or unreadable local store must not brick MCP startup. The
      // session can still be selected explicitly with set_workspace_key.
    }
  }
  const agentName =
    resolveEnv('RELAY_AGENT_NAME') ??
    resolveEnv('RELAY_CLAW_NAME') ??
    (workspaceKey ? 'orchestrator' : undefined);
  return {
    workspaceKey,
    baseUrl: resolveEnv('RELAY_BASE_URL'),
    // An agent token has no workspace identity encoded locally. Only reuse it
    // when the workspace was selected alongside it through the environment;
    // a persisted project/store fallback must register into that workspace
    // instead of silently pairing it with a possibly stale ambient token.
    agentToken: resumedPersistedWorkspace ? undefined : resolveEnv('RELAY_AGENT_TOKEN'),
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
