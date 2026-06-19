import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  agentTokenRecoveryMessage,
  isInvalidAgentTokenError,
  isInvalidAgentTokenToolResult,
} from '@agent-relay/sdk';

import { track, type AgentRelayToolCallCategory, type AgentRelayToolCallType } from '../telemetry/index.js';
import { errorClassName } from '../lib/telemetry-helpers.js';
import { formatInbox, SKIP_PIGGYBACK } from './inbox.js';
import { hasContentArray, invalidAgentTokenToolResult, isErrorToolResult } from './tool-results.js';
import type { AgentClientLike, AgentRelayMcpServerOptions, SessionState } from './types.js';

interface AgentRelayToolCallMetadata {
  toolType: AgentRelayToolCallType;
  toolCategory: AgentRelayToolCallCategory;
}

/**
 * Owned tools that delegate to the actions surface (`actions.invoke(...)`)
 * rather than the agents/messaging APIs. Together with the dynamic per-action
 * tools (tracked via `actionToolNames`), these intentionally skip per-tool
 * telemetry so the same underlying action is not counted differently depending
 * on which MCP surface the caller used (e.g. `spawn` vs `invoke_action`).
 */
const ACTION_ROUTED_TOOL_NAMES = new Set(['invoke_action', 'spawn']);

/**
 * Coarse type/category metadata for the statically-registered ("owned") MCP
 * tools. Action-routed calls (see `ACTION_ROUTED_TOOL_NAMES`) and the dynamic
 * per-action tools surfaced from the actions registry are intentionally
 * excluded from per-tool telemetry (see the skip in `enableInboxPiggyback`),
 * so they have no entry.
 */
const AGENT_RELAY_TOOL_CALL_METADATA = {
  add_agent: { toolType: 'agent.create', toolCategory: 'spawn' },
  remove_agent: { toolType: 'agent.release', toolCategory: 'release' },
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
  reply_to_thread: { toolType: 'message.reply', toolCategory: 'message' },
  get_message_thread: { toolType: 'message.thread', toolCategory: 'message' },
  search_messages: { toolType: 'message.search', toolCategory: 'message' },
  create_channel: { toolType: 'channel.create', toolCategory: 'channel' },
  list_channels: { toolType: 'channel.list', toolCategory: 'channel' },
  join_channel: { toolType: 'channel.join', toolCategory: 'channel' },
  leave_channel: { toolType: 'channel.leave', toolCategory: 'channel' },
  set_channel_topic: { toolType: 'channel.set_topic', toolCategory: 'channel' },
  archive_channel: { toolType: 'channel.archive', toolCategory: 'channel' },
  invite_to_channel: { toolType: 'channel.invite', toolCategory: 'channel' },
  add_reaction: { toolType: 'reaction.add', toolCategory: 'reaction' },
  remove_reaction: { toolType: 'reaction.remove', toolCategory: 'reaction' },
  check_inbox: { toolType: 'inbox.check', toolCategory: 'inbox' },
  mark_message_read: { toolType: 'inbox.mark_read', toolCategory: 'inbox' },
  get_message_readers: { toolType: 'inbox.reader_list', toolCategory: 'inbox' },
} satisfies Record<string, AgentRelayToolCallMetadata>;

function agentRelayToolCallMetadata(name: string): AgentRelayToolCallMetadata {
  const known = (AGENT_RELAY_TOOL_CALL_METADATA as Partial<Record<string, AgentRelayToolCallMetadata>>)[name];
  return known ?? { toolType: name, toolCategory: 'tool' };
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

function readAsIdentity(args: unknown[]): string | undefined {
  const [input] = args;
  if (typeof input !== 'object' || input === null) return undefined;
  const as = (input as { as?: unknown }).as;
  return typeof as === 'string' ? as : undefined;
}

/**
 * Wrap `server.registerTool` so every owned tool emits `agent_relay_tool_call`
 * telemetry, surfaces invalid-agent-token errors as recoverable results, and
 * piggybacks a compact inbox summary onto successful results.
 */
export function enableInboxPiggyback(
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
      // Action-routed calls (`invoke_action`, `spawn`, and the dynamic
      // per-action tools) run through the actions surface and deliberately skip
      // per-tool telemetry; only the owned tools emit `agent_relay_tool_call`.
      const toolMetadata =
        !ACTION_ROUTED_TOOL_NAMES.has(name) && !actionToolNames.has(name)
          ? agentRelayToolCallMetadata(name)
          : undefined;

      let result: any;
      try {
        result = await handler(...args);
      } catch (err) {
        if (name !== 'register_agent' && isInvalidAgentTokenError(err)) {
          invalidateAgentToken(asIdentity);
          if (toolMetadata) {
            trackAgentRelayToolCall({
              toolName: name,
              toolType: toolMetadata.toolType,
              toolCategory: toolMetadata.toolCategory,
              transport: telemetryTransport,
              startedAt,
              success: false,
              errorClass: errorClassName(err) ?? 'InvalidAgentToken',
            });
          }
          return invalidAgentTokenToolResult();
        }
        if (toolMetadata) {
          trackAgentRelayToolCall({
            toolName: name,
            toolType: toolMetadata.toolType,
            toolCategory: toolMetadata.toolCategory,
            transport: telemetryTransport,
            startedAt,
            success: false,
            errorClass: errorClassName(err),
          });
        }
        throw err;
      }

      if (name !== 'register_agent' && isInvalidAgentTokenToolResult(result)) {
        invalidateAgentToken(asIdentity);
        if (toolMetadata) {
          trackAgentRelayToolCall({
            toolName: name,
            toolType: toolMetadata.toolType,
            toolCategory: toolMetadata.toolCategory,
            transport: telemetryTransport,
            startedAt,
            success: false,
            errorClass: 'InvalidAgentToken',
          });
        }
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
          if (isInvalidAgentTokenError(err)) {
            invalidateAgentToken(asIdentity);
          }
        }
      }

      if (toolMetadata) {
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
      }

      return result;
    };

    return original(name, config, wrapped);
  };
}
