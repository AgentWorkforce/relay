import { CloudApiClient, type CloudSession } from '@agent-relay/cloud';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertSharedSessionsCloudApiUrl,
  registerSharedSessionTools,
  SharedSessionsCloudAuthError,
  SharedSessionsCloudPermissionError,
  SharedSessionsInsecureCloudUrlError,
  SharedSessionsMcpClient,
  SharedSessionsMcpClientClosedError,
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

function fakeSession(
  fetchImpl: (path: string, init?: RequestInit) => Promise<Response>,
  apiUrl = 'https://cloud.example'
): CloudSession {
  return {
    auth: {
      apiUrl,
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      accessTokenExpiresAt: '2099-01-01T00:00:00.000Z',
    },
    client: { fetch: fetchImpl } as unknown as CloudApiClient,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SharedSessionsMcpClient', () => {
  it.each(['https://cloud.example', 'http://localhost:8787', 'http://127.0.0.1:8787', 'http://[::1]:8787'])(
    'accepts a credential-safe Cloud API URL: %s',
    (apiUrl) => {
      expect(() => assertSharedSessionsCloudApiUrl(apiUrl)).not.toThrow();
    }
  );

  it.each([
    'http://cloud.example',
    'http://localhost.evil.example',
    'ftp://cloud.example',
    'https://user:password@cloud.example',
  ])('rejects a credential-unsafe Cloud API URL: %s', (apiUrl) => {
    expect(() => assertSharedSessionsCloudApiUrl(apiUrl)).toThrow(SharedSessionsInsecureCloudUrlError);
  });

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

    expect(ensureSession).toHaveBeenCalledWith({
      interactive: false,
      validateApiUrl: expect.any(Function),
    });
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
    await client.close();
  });

  it('reports an actionable login error and retries auth on the next discovery', async () => {
    const ensureSession = vi.fn(async () => {
      throw new Error('Cloud login required');
    });
    const client = new SharedSessionsMcpClient({ ensureSession });

    await expect(client.listTools()).rejects.toThrow(
      'Run `agent-relay cloud login` (or `agent-relay cloud login --device` on a headless machine)'
    );
    await expect(client.listTools()).rejects.toBeInstanceOf(SharedSessionsCloudAuthError);
    expect(ensureSession).toHaveBeenCalledTimes(2);
  });

  it('rejects a non-loopback HTTP API before sending Cloud credentials', async () => {
    const fetchImpl = vi.fn(async () => jsonRpcResponse(null));
    const ensureSession = vi.fn(async () => fakeSession(fetchImpl, 'http://cloud.example'));
    const client = new SharedSessionsMcpClient({ ensureSession });

    await expect(client.listTools()).rejects.toBeInstanceOf(SharedSessionsInsecureCloudUrlError);

    expect(ensureSession).toHaveBeenCalledWith({
      interactive: false,
      validateApiUrl: expect.any(Function),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['initialize', 401, SharedSessionsCloudAuthError, 'cloud login --device'],
    ['initialize', 403, SharedSessionsCloudPermissionError, 'does not have permission'],
    ['call', 401, SharedSessionsCloudAuthError, 'cloud login --device'],
    ['call', 403, SharedSessionsCloudPermissionError, 'does not have permission'],
  ] as const)(
    'maps hosted %s HTTP %s to distinct actionable guidance',
    async (failurePhase, status, ErrorType, message) => {
      const fetchImpl = vi.fn(async (_path: string, init?: RequestInit) => {
        const body = typeof init?.body === 'string' ? init.body : null;
        const method = body ? (JSON.parse(body) as { method?: string }).method : undefined;
        const shouldFail = failurePhase === 'initialize' ? method === 'initialize' : method === 'tools/call';
        if (shouldFail) return new Response('denied', { status });
        return jsonRpcResponse(body);
      });
      const client = new SharedSessionsMcpClient({
        ensureSession: async () => fakeSession(fetchImpl),
      });

      const operation =
        failurePhase === 'initialize'
          ? client.listTools()
          : client.callTool('search_shared_sessions', { query: 'incident' });
      const error = await operation.catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ErrorType);
      expect(error).toHaveProperty('message', expect.stringContaining(message));
      if (status === 403) expect(error).not.toBeInstanceOf(SharedSessionsCloudAuthError);
      await client.close();
    }
  );

  it('close prevents a late auth completion from creating a transport', async () => {
    let resolveSession!: (session: CloudSession) => void;
    const delayedSession = new Promise<CloudSession>((resolve) => {
      resolveSession = resolve;
    });
    const ensureSession = vi.fn(async () => delayedSession);
    const fetchImpl = vi.fn(async (_path: string, init?: RequestInit) =>
      jsonRpcResponse(typeof init?.body === 'string' ? init.body : null)
    );
    const client = new SharedSessionsMcpClient({ ensureSession });

    const discovery = client.listTools();
    await client.close();
    resolveSession(fakeSession(fetchImpl));

    await expect(discovery).rejects.toBeInstanceOf(SharedSessionsMcpClientClosedError);
    await expect(client.listTools()).rejects.toBeInstanceOf(SharedSessionsMcpClientClosedError);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(ensureSession).toHaveBeenCalledTimes(1);
  });

  it('close immediately aborts an in-flight hosted MCP transport', async () => {
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    let aborted = false;
    const fetchImpl = vi.fn(
      async (_path: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          requestStarted();
          const abort = () => {
            aborted = true;
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          };
          if (init?.signal?.aborted) abort();
          else init?.signal?.addEventListener('abort', abort, { once: true });
        })
    );
    const client = new SharedSessionsMcpClient({
      ensureSession: async () => fakeSession(fetchImpl),
    });

    const discovery = client.listTools();
    await started;
    const closing = client.close();

    await expect(discovery).rejects.toBeInstanceOf(SharedSessionsMcpClientClosedError);
    await closing;
    expect(aborted).toBe(true);
  });

  it('close aborts an in-flight tools/list request and prevents client reuse', async () => {
    let listStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      listStarted = resolve;
    });
    let aborted = false;
    const fetchImpl = vi.fn(async (_path: string, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? init.body : null;
      const method = body ? (JSON.parse(body) as { method?: string }).method : undefined;
      if (method !== 'tools/list') return jsonRpcResponse(body);
      return new Promise<Response>((_resolve, reject) => {
        listStarted();
        const abort = () => {
          aborted = true;
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        };
        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener('abort', abort, { once: true });
      });
    });
    const client = new SharedSessionsMcpClient({
      ensureSession: async () => fakeSession(fetchImpl),
    });

    const discovery = client.listTools();
    await started;
    const closing = client.close();

    await expect(discovery).rejects.toBeInstanceOf(SharedSessionsMcpClientClosedError);
    await closing;
    await expect(client.listTools()).rejects.toBeInstanceOf(SharedSessionsMcpClientClosedError);
    expect(aborted).toBe(true);
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
