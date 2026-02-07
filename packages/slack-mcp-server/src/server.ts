#!/usr/bin/env node

/**
 * Headless Slack MCP Server — main entry point.
 *
 * Supports two transport modes:
 *   --stdio   : Single-agent MCP over stdin/stdout (for editor integrations)
 *   --http    : Multi-agent MCP over SSE/HTTP (default, for remote agents)
 *
 * Architecture:
 *   Core Engine (storage + business logic)
 *     ├── MCP Server per connection (tools, resources, prompts)
 *     └── HTTP layer (Express + SSE transport for multi-agent)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import { Storage } from './storage.js';
import { Engine } from './engine.js';
import { ALL_TOOLS, handleToolCall, handleToolCallWithNotification } from './tools.js';
import type { SessionState } from './types.js';
import type { MessageEvent } from './engine.js';

// ---------------------------------------------------------------------------
// System prompt for agents
// ---------------------------------------------------------------------------

const AGENT_SYSTEM_PROMPT = `# Headless Slack — Agent Communication Protocol

You are connected to a shared workspace where you can communicate with other AI agents
in real-time using Slack-like primitives: channels, threads, DMs, and reactions.

## Getting Started
1. Call \`register\` with your name to join the workspace
2. Call \`check_inbox\` to see if you have any messages

## Important Habits
- **Check inbox regularly** — call \`check_inbox\` periodically to see new messages and @mentions
- **Use threads** for focused discussions — reply_to_thread keeps conversations organized
- **Use @agentname** in messages to mention and notify specific agents
- **React with emoji** to acknowledge messages without creating noise

## Quick Reference
| Action | Tool |
|--------|------|
| Join workspace | \`register\` |
| Check for messages | \`check_inbox\` |
| Read channel | \`get_messages\` |
| Post to channel | \`post_message\` |
| Reply in thread | \`reply_to_thread\` |
| DM someone | \`send_dm\` |
| Search messages | \`search_messages\` |
| React to message | \`add_reaction\` |

## Channel Conventions
- **#general** — workspace-wide announcements and discussion
- Create topic-specific channels for focused work
- Use DMs for private 1:1 conversations
`;

// ---------------------------------------------------------------------------
// MCP Server factory — creates one MCP server instance per connection
// ---------------------------------------------------------------------------

export function createMCPSession(engine: Engine): {
  server: Server;
  session: SessionState;
} {
  const session: SessionState = {
    agentId: null,
    agentName: null,
    workspaceId: null,
  };

  const server = new Server(
    { name: 'slack-mcp-server', version: '0.1.0' },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );

  // --- Tools ---
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: ALL_TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const result = await handleToolCallWithNotification(
      engine,
      session,
      name,
      (args as Record<string, unknown>) ?? {},
    );
    return {
      content: [{ type: 'text' as const, text: result.text }],
      isError: result.isError,
    };
  });

  // --- Resources ---
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: 'slack://workspace',
        name: 'Workspace Info',
        description: 'Current workspace configuration and status',
        mimeType: 'text/plain',
      },
      {
        uri: 'slack://inbox',
        name: 'Inbox',
        description: 'Your unread messages and mentions',
        mimeType: 'text/plain',
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;

    if (uri === 'slack://workspace') {
      if (!session.agentId) {
        return {
          contents: [
            {
              uri,
              mimeType: 'text/plain',
              text: 'Not registered. Call register first.',
            },
          ],
        };
      }
      const agents = engine.listAgents(session.agentId, 'all');
      const channels = engine.listChannels(session.agentId);
      return {
        contents: [
          {
            uri,
            mimeType: 'text/plain',
            text: `Workspace: ${session.workspaceId}\nAgents: ${agents.map((a) => `${a.name} [${a.status}]`).join(', ')}\nChannels: ${channels.map((c) => `#${c.name}`).join(', ')}`,
          },
        ],
      };
    }

    if (uri === 'slack://inbox') {
      if (!session.agentId) {
        return {
          contents: [
            {
              uri,
              mimeType: 'text/plain',
              text: 'Not registered. Call register first.',
            },
          ],
        };
      }
      const result = await handleToolCall(engine, session, 'check_inbox', {});
      return {
        contents: [{ uri, mimeType: 'text/plain', text: result.text }],
      };
    }

    throw new Error(`Unknown resource: ${uri}`);
  });

  // --- Prompts ---
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
      {
        name: 'slack_protocol',
        description:
          'System prompt for agents — how to use the Headless Slack workspace',
      },
    ],
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    if (request.params.name === 'slack_protocol') {
      return {
        description: 'Headless Slack agent communication protocol',
        messages: [
          {
            role: 'user' as const,
            content: { type: 'text' as const, text: AGENT_SYSTEM_PROMPT },
          },
        ],
      };
    }
    throw new Error(`Unknown prompt: ${request.params.name}`);
  });

  return { server, session };
}

// ---------------------------------------------------------------------------
// Stdio transport (single-agent mode)
// ---------------------------------------------------------------------------

async function runStdio(engine: Engine): Promise<void> {
  const { server } = createMCPSession(engine);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.on('SIGINT', async () => {
    await server.close();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await server.close();
    process.exit(0);
  });

  // eslint-disable-next-line no-console
  console.error('Slack MCP Server running on stdio');
}

// ---------------------------------------------------------------------------
// HTTP + SSE transport (multi-agent mode)
// ---------------------------------------------------------------------------

async function runHttp(engine: Engine, port: number): Promise<void> {
  const app = express();
  app.use(express.json());

  // Track active SSE sessions — keyed by SSE session ID
  const sessions = new Map<
    string,
    { transport: SSEServerTransport; session: SessionState; server: Server }
  >();

  // Layer 3: Proactive MCP notifications.
  // When a message arrives, notify all connected agents who are recipients.
  // Clients that support resource subscriptions will re-read slack://inbox.
  engine.onMessage((event: MessageEvent) => {
    for (const [, entry] of sessions) {
      if (
        entry.session.agentId &&
        event.recipientAgentIds.includes(entry.session.agentId)
      ) {
        // Send MCP resource-updated notification (best-effort)
        entry.server
          .notification({
            method: 'notifications/resources/updated',
            params: { uri: 'slack://inbox' },
          })
          .catch(() => {
            // Client may not support notifications — that's OK,
            // the piggyback layer (Layer 1) will catch it on next tool call.
          });
      }
    }
  });

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', agents: sessions.size });
  });

  // SSE endpoint — one per agent connection
  app.get('/sse', async (req, res) => {
    const transport = new SSEServerTransport('/messages', res);
    const { server, session } = createMCPSession(engine);

    sessions.set(transport.sessionId, { transport, session, server });

    res.on('close', () => {
      sessions.delete(transport.sessionId);
      if (session.agentId) {
        engine.setAgentOffline(session.agentId);
      }
    });

    await server.connect(transport);
  });

  // Message endpoint — routes MCP messages to the correct session
  app.post('/messages', async (req, res) => {
    const sessionId = req.query.sessionId as string;
    const entry = sessions.get(sessionId);
    if (!entry) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    await entry.transport.handlePostMessage(req, res);
  });

  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.error(`Slack MCP Server running on http://localhost:${port}`);
    // eslint-disable-next-line no-console
    console.error(`  SSE endpoint: http://localhost:${port}/sse`);
    // eslint-disable-next-line no-console
    console.error(`  Health check: http://localhost:${port}/health`);
  });
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const isStdio = args.includes('--stdio');
  const portArg = args.find((a) => a.startsWith('--port='));
  const dbArg = args.find((a) => a.startsWith('--db='));
  const wsArg = args.find((a) => a.startsWith('--workspace='));

  const port = portArg ? parseInt(portArg.split('=')[1], 10) : 4100;
  const dbPath = dbArg ? dbArg.split('=')[1] : process.env.SLACK_MCP_DB ?? ':memory:';
  const workspaceName = wsArg ? wsArg.split('=')[1] : process.env.SLACK_MCP_WORKSPACE ?? 'default';

  const storage = new Storage(dbPath);
  const engine = new Engine(storage, workspaceName);

  if (isStdio) {
    await runStdio(engine);
  } else {
    await runHttp(engine, port);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal error:', err);
  process.exit(1);
});
