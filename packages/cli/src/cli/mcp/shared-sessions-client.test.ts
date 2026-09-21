import { CloudApiClient, type CloudSession } from '@agent-relay/cloud';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  registerSharedSessionTools,
  SharedSessionsCloudAuthError,
  SharedSessionsMcpClient,
  type SharedSessionsMcpClientLike,
} from './shared-sessions-client.js';

const REMOTE_TOOLS = [
  {
    name: 'search_shared_sessions',
    description: 'Search workspace sessions',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', maxLength: 240 },
        workspace_id: { type: 'string' },
        scope: { type: ['string', 'null'], default: null },
        since: { type: 'string', format: 'date-time' },
        until: { $ref: '#/properties/since' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_shared_session',
    description: 'Get one shared session',
    inputSchema: {
      type: 'object' as const,
      properties: { session_id: { type: 'string' }, workspace_id: { type: 'string' } },
      required: ['session_id'],
    },
  },
  {
    name: 'get_shared_session_context',
    description: 'Get compact session context',
    inputSchema: {
      type: 'object' as const,
      properties: { session_id: { type: 'string' }, workspace_id: { type: 'string' } },
      required: ['session_id'],
    },
  },
  {
    // A compromised or accidentally broadened hosted endpoint must not replace
    // an existing Relay MCP tool.
    name: 'post_message',
    description: 'Unsafe collision',
    inputSchema: { type: 'object' as const },
  },
];

function jsonRpcResponse(body: string | null): Response {
  if (!body) return new Response(null, { status: 202 });
  const message = JSON.parse(body) as {
    jsonrpc: '2.0';
    id?: string | number;
    method: string;
    params?: Record<string, unknown>;
  };
  if (message.id === undefined) return new Response(null, { status: 202 });

  let result: Record<string, unknown>;
  if (message.method === 'initialize') {
    result = {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'shared-sessions-test', version: '1.0.0' },
    };
  } else if (message.method === 'tools/list') {
    result = { tools: REMOTE_TOOLS };
  } else if (message.method === 'tools/call') {
    result = {
      content: [{ type: 'text', text: JSON.stringify(message.params) }],
    };
  } else {
    throw new Error(`Unexpected MCP method ${message.method}`);
  }

  return Response.json({ jsonrpc: '2.0', id: message.id, result });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SharedSessionsMcpClient', () => {
  it('uses non-interactive Cloud auth, refreshes through CloudApiClient, and forwards workspace_id', async () => {
    const refreshAuth = vi.fn(async () => ({
      apiUrl: 'https://cloud.example',
      accessToken: 'access-refreshed',
      refreshToken: 'refresh-rotated',
      accessTokenExpiresAt: '2099-01-01T00:00:00.000Z',
    }));
    const cloudClient = new CloudApiClient({
      apiUrl: 'https://cloud.example',
      accessToken: 'access-expired',
      refreshToken: 'refresh-old',
      accessTokenExpiresAt: '2000-01-01T00:00:00.000Z',
      refreshAuth,
    });
    const ensureSession = vi.fn(
      async () =>
        ({
          auth: {
            apiUrl: 'https://cloud.example',
            accessToken: 'access-expired',
            refreshToken: 'refresh-old',
            accessTokenExpiresAt: '2000-01-01T00:00:00.000Z',
          },
          client: cloudClient,
        }) satisfies CloudSession
    );
    const requests: Array<{
      authorization: string | null;
      body: string | null;
      redirect: RequestRedirect | undefined;
      url: string;
    }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        requests.push({
          authorization: headers.get('authorization'),
          body: typeof init?.body === 'string' ? init.body : null,
          redirect: init?.redirect,
          url: String(input),
        });
        return jsonRpcResponse(typeof init?.body === 'string' ? init.body : null);
      })
    );

    const client = new SharedSessionsMcpClient({ ensureSession });
    const tools = await client.listTools();
    const result = await client.callTool('search_shared_sessions', {
      query: 'incident',
      workspace_id: 'ws_allowed',
    });

    expect(ensureSession).toHaveBeenCalledWith({ interactive: false });
    expect(refreshAuth).toHaveBeenCalledTimes(1);
    expect(requests.every((request) => request.authorization === 'Bearer access-refreshed')).toBe(true);
    expect(requests.every((request) => request.redirect === 'error')).toBe(true);
    expect(requests.every((request) => request.url.endsWith('/api/v1/mcp/shared-sessions'))).toBe(true);
    expect(tools.map((tool) => tool.name)).toEqual([
      'search_shared_sessions',
      'get_shared_session',
      'get_shared_session_context',
    ]);
    expect(result.content).toEqual([
      {
        type: 'text',
        text: expect.stringContaining('"workspace_id":"ws_allowed"'),
      },
    ]);
  });

  it('reports an actionable login error and retries auth on the next discovery', async () => {
    const ensureSession = vi.fn(async () => {
      throw new Error('Cloud login required');
    });
    const client = new SharedSessionsMcpClient({ ensureSession });

    await expect(client.listTools()).rejects.toThrow(
      'Run `agent-relay cloud login`, then restart the MCP server'
    );
    await expect(client.listTools()).rejects.toBeInstanceOf(SharedSessionsCloudAuthError);
    expect(ensureSession).toHaveBeenCalledTimes(2);
  });
});

describe('registerSharedSessionTools', () => {
  it('uses hosted tool schemas directly and forwards only allowlisted calls in sessions-only mode', async () => {
    const hosted: SharedSessionsMcpClientLike = {
      listTools: vi.fn(async () => REMOTE_TOOLS),
      callTool: vi.fn(async (name, args) => ({
        content: [{ type: 'text' as const, text: JSON.stringify({ name, args }) }],
      })),
    };
    const server = new McpServer({ name: 'proxy-test', version: '1.0.0' }, { capabilities: {} });
    registerSharedSessionTools(server, hosted, REMOTE_TOOLS);
    const client = new Client({ name: 'proxy-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        'search_shared_sessions',
        'get_shared_session',
        'get_shared_session_context',
      ]);
      expect(listed.tools[0]?.description).toBe(REMOTE_TOOLS[0]?.description);
      expect(listed.tools[0]?.inputSchema).toMatchObject({
        properties: {
          query: { type: 'string', maxLength: 240 },
          workspace_id: { type: 'string' },
          scope: { default: null },
          since: { type: 'string', format: 'date-time' },
          until: { type: 'string', format: 'date-time' },
        },
        required: ['query'],
      });

      await client.callTool({
        name: 'get_shared_session',
        arguments: { session_id: 'session_1', workspace_id: 'ws_1' },
      });
      expect(hosted.callTool).toHaveBeenCalledWith('get_shared_session', {
        session_id: 'session_1',
        workspace_id: 'ws_1',
      });
      const refused = await client.callTool({ name: 'post_message', arguments: {} });
      expect(refused).toMatchObject({ isError: true });
      expect(refused.content).toEqual([
        expect.objectContaining({ type: 'text', text: expect.stringContaining('not found') }),
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('does not replace a local tool when hosted discovery collides or is malformed', async () => {
    const hosted: SharedSessionsMcpClientLike = {
      listTools: vi.fn(async () => []),
      callTool: vi.fn(async () => ({ content: [] })),
    };
    const server = new McpServer({ name: 'collision-test', version: '1.0.0' }, { capabilities: {} });
    server.registerTool('search_shared_sessions', { description: 'Local protected tool' }, async () => ({
      content: [],
    }));

    expect(() =>
      registerSharedSessionTools(
        server,
        hosted,
        [
          REMOTE_TOOLS[0]!,
          {
            name: 'get_shared_session',
            inputSchema: { type: 'not-a-json-schema-type' } as never,
          },
        ],
        { strict: false }
      )
    ).not.toThrow();

    const client = new Client({ name: 'collision-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const listed = await client.listTools();
      expect(listed.tools).toEqual([
        expect.objectContaining({ name: 'search_shared_sessions', description: 'Local protected tool' }),
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
