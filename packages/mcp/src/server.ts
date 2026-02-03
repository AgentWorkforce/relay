import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { RelayClient } from './client.js';
import {
  relaySendTool,
  relaySendSchema,
  handleRelaySend,
  relayInboxTool,
  relayInboxSchema,
  handleRelayInbox,
  relayWhoTool,
  relayWhoSchema,
  handleRelayWho,
  relaySpawnTool,
  relaySpawnSchema,
  handleRelaySpawn,
  relayReleaseTool,
  relayReleaseSchema,
  handleRelayRelease,
  relayStatusTool,
  relayStatusSchema,
  handleRelayStatus,
  relayLogsTool,
  relayLogsSchema,
  handleRelayLogs,
  relayMetricsTool,
  relayMetricsSchema,
  handleRelayMetrics,
  relayHealthTool,
  relayHealthSchema,
  handleRelayHealth,
  relayContinuityTool,
  relayContinuitySchema,
  handleRelayContinuity,
  relayConnectedTool,
  relayConnectedSchema,
  handleRelayConnected,
  relayRemoveAgentTool,
  relayRemoveAgentSchema,
  handleRelayRemoveAgent,
  relayBroadcastTool,
  relayBroadcastSchema,
  handleRelayBroadcast,
  relaySubscribeTool,
  relaySubscribeSchema,
  handleRelaySubscribe,
  relayUnsubscribeTool,
  relayUnsubscribeSchema,
  handleRelayUnsubscribe,
  relayChannelJoinTool,
  relayChannelJoinSchema,
  handleRelayChannelJoin,
  relayChannelLeaveTool,
  relayChannelLeaveSchema,
  handleRelayChannelLeave,
  relayChannelMessageTool,
  relayChannelMessageSchema,
  handleRelayChannelMessage,
  relayAdminChannelJoinTool,
  relayAdminChannelJoinSchema,
  handleRelayAdminChannelJoin,
  relayAdminRemoveMemberTool,
  relayAdminRemoveMemberSchema,
  handleRelayAdminRemoveMember,
  relayShadowBindTool,
  relayShadowBindSchema,
  handleRelayShadowBind,
  relayShadowUnbindTool,
  relayShadowUnbindSchema,
  handleRelayShadowUnbind,
  relayProposalTool,
  relayProposalSchema,
  handleRelayProposal,
  relayVoteTool,
  relayVoteSchema,
  handleRelayVote,
  relayQueryMessagesTool,
  relayQueryMessagesSchema,
  handleRelayQueryMessages,
} from './tools/index.js';
import { protocolPrompt, getProtocolPrompt } from './prompts/index.js';
import {
  agentsResource,
  getAgentsResource,
  inboxResource,
  getInboxResource,
  projectResource,
  getProjectResource,
} from './resources/index.js';

/**
 * All available relay tools
 */
const TOOLS = [
  relaySendTool,
  relayInboxTool,
  relayWhoTool,
  relayConnectedTool,
  relaySpawnTool,
  relayReleaseTool,
  relayRemoveAgentTool,
  relayStatusTool,
  relayLogsTool,
  relayMetricsTool,
  relayHealthTool,
  relayContinuityTool,
  relayBroadcastTool,
  relaySubscribeTool,
  relayUnsubscribeTool,
  relayChannelJoinTool,
  relayChannelLeaveTool,
  relayChannelMessageTool,
  relayAdminChannelJoinTool,
  relayAdminRemoveMemberTool,
  relayShadowBindTool,
  relayShadowUnbindTool,
  relayProposalTool,
  relayVoteTool,
  relayQueryMessagesTool,
];

/**
 * All available prompts
 */
const PROMPTS = [protocolPrompt];

/**
 * All available resources
 */
const RESOURCES = [agentsResource, inboxResource, projectResource];

/**
 * MCP Server configuration options
 */
export interface MCPServerConfig {
  name?: string;
  version?: string;
}

/**
 * Create and configure an MCP server for Agent Relay
 */
export function createMCPServer(client: RelayClient, config?: MCPServerConfig): Server {
  const serverName = config?.name ?? 'agent-relay-mcp';
  const serverVersion = config?.version ?? '0.1.0';

  const server = new Server(
    {
      name: serverName,
      version: serverVersion,
    },
    {
      capabilities: {
        tools: {},
        prompts: {},
        resources: {},
      },
    }
  );

  // Register tool listing handler
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  // Register tool call handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      let result: string;

      switch (name) {
        case 'relay_send': {
          const input = relaySendSchema.parse(args);
          result = await handleRelaySend(client, input);
          break;
        }

        case 'relay_inbox': {
          const input = relayInboxSchema.parse(args);
          result = await handleRelayInbox(client, input);
          break;
        }

        case 'relay_who': {
          const input = relayWhoSchema.parse(args);
          result = await handleRelayWho(client, input);
          break;
        }

        case 'relay_connected': {
          const input = relayConnectedSchema.parse(args);
          result = await handleRelayConnected(client, input);
          break;
        }

        case 'relay_spawn': {
          const input = relaySpawnSchema.parse(args);
          result = await handleRelaySpawn(client, input);
          break;
        }

        case 'relay_release': {
          const input = relayReleaseSchema.parse(args);
          result = await handleRelayRelease(client, input);
          break;
        }

        case 'relay_remove_agent': {
          const input = relayRemoveAgentSchema.parse(args);
          result = await handleRelayRemoveAgent(client, input);
          break;
        }

        case 'relay_status': {
          const input = relayStatusSchema.parse(args);
          result = await handleRelayStatus(client, input);
          break;
        }

        case 'relay_logs': {
          const input = relayLogsSchema.parse(args);
          result = await handleRelayLogs(client, input);
          break;
        }

        case 'relay_metrics': {
          const input = relayMetricsSchema.parse(args);
          result = await handleRelayMetrics(client, input);
          break;
        }

        case 'relay_health': {
          const input = relayHealthSchema.parse(args);
          result = await handleRelayHealth(client, input);
          break;
        }

        case 'relay_continuity': {
          const input = relayContinuitySchema.parse(args);
          result = await handleRelayContinuity(client, input);
          break;
        }

        case 'relay_broadcast': {
          const input = relayBroadcastSchema.parse(args);
          result = await handleRelayBroadcast(client, input);
          break;
        }

        case 'relay_subscribe': {
          const input = relaySubscribeSchema.parse(args);
          result = await handleRelaySubscribe(client, input);
          break;
        }

        case 'relay_unsubscribe': {
          const input = relayUnsubscribeSchema.parse(args);
          result = await handleRelayUnsubscribe(client, input);
          break;
        }

        case 'relay_channel_join': {
          const input = relayChannelJoinSchema.parse(args);
          result = await handleRelayChannelJoin(client, input);
          break;
        }

        case 'relay_channel_leave': {
          const input = relayChannelLeaveSchema.parse(args);
          result = await handleRelayChannelLeave(client, input);
          break;
        }

        case 'relay_channel_message': {
          const input = relayChannelMessageSchema.parse(args);
          result = await handleRelayChannelMessage(client, input);
          break;
        }

        case 'relay_admin_channel_join': {
          const input = relayAdminChannelJoinSchema.parse(args);
          result = await handleRelayAdminChannelJoin(client, input);
          break;
        }

        case 'relay_admin_remove_member': {
          const input = relayAdminRemoveMemberSchema.parse(args);
          result = await handleRelayAdminRemoveMember(client, input);
          break;
        }

        case 'relay_shadow_bind': {
          const input = relayShadowBindSchema.parse(args);
          result = await handleRelayShadowBind(client, input);
          break;
        }

        case 'relay_shadow_unbind': {
          const input = relayShadowUnbindSchema.parse(args);
          result = await handleRelayShadowUnbind(client, input);
          break;
        }

        case 'relay_proposal': {
          const input = relayProposalSchema.parse(args);
          result = await handleRelayProposal(client, input);
          break;
        }

        case 'relay_vote': {
          const input = relayVoteSchema.parse(args);
          result = await handleRelayVote(client, input);
          break;
        }

        case 'relay_query_messages': {
          const input = relayQueryMessagesSchema.parse(args);
          result = await handleRelayQueryMessages(client, input);
          break;
        }

        default:
          return {
            content: [
              {
                type: 'text' as const,
                text: `Unknown tool: ${name}`,
              },
            ],
            isError: true,
          };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: result,
          },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error executing ${name}: ${message}`,
          },
        ],
        isError: true,
      };
    }
  });

  // Register prompt listing handler
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: PROMPTS,
  }));

  // Register prompt get handler
  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name } = request.params;

    if (name === 'relay_protocol') {
      return {
        description: 'Agent Relay protocol documentation',
        messages: [
          {
            role: 'user' as const,
            content: { type: 'text' as const, text: getProtocolPrompt() },
          },
        ],
      };
    }

    throw new Error(`Unknown prompt: ${name}`);
  });

  // Register resource listing handler
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: RESOURCES,
  }));

  // Register resource read handler
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;

    switch (uri) {
      case 'relay://agents':
        return {
          contents: [
            {
              uri,
              mimeType: 'application/json',
              text: await getAgentsResource(client),
            },
          ],
        };

      case 'relay://inbox':
        return {
          contents: [
            {
              uri,
              mimeType: 'application/json',
              text: await getInboxResource(client),
            },
          ],
        };

      case 'relay://project':
        return {
          contents: [
            {
              uri,
              mimeType: 'application/json',
              text: await getProjectResource(client),
            },
          ],
        };

      default:
        throw new Error(`Unknown resource: ${uri}`);
    }
  });

  return server;
}

/**
 * Run the MCP server with stdio transport.
 * This is the main entry point when running as a standalone process.
 */
export async function runMCPServer(client: RelayClient, config?: MCPServerConfig): Promise<void> {
  const server = createMCPServer(client, config);
  const transport = new StdioServerTransport();

  await server.connect(transport);

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    await server.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await server.close();
    process.exit(0);
  });
}
