import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const relay = {
  online: [] as Array<{ name: string }>,
  /** Names the presence endpoint reports as connected; null makes it fail. */
  present: [] as string[] | null,
  fetch: vi.fn(async (url: URL | string) => {
    if (String(url).endsWith('/v1/agents/presence') && relay.present) {
      return new Response(
        JSON.stringify({
          ok: true,
          data: relay.present.map((agent_name) => ({ agent_name, status: 'online' })),
        })
      );
    }
    const route = new URL(String(url)).pathname;
    if (route === '/v1/agents/claude-myproject')
      return new Response(JSON.stringify({ ok: true, data: { id: 'a1' } }));
    if (route === '/v1/agents/claude-myproject/takeover') {
      return new Response(
        JSON.stringify({
          ok: true,
          data: { agent_id: 'a1', name: 'claude-myproject', token: 'at_live_resumed' },
        })
      );
    }
    return new Response('{}', { status: route === '/v1/agents/disconnect' ? 200 : 404 });
  }),
  registerOrRotate: vi.fn(async ({ name }: { name: string }) => ({ name, token: `at_live_${name}` })),
  list: vi.fn(async () => relay.online),
};

vi.mock('@agent-relay/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-relay/sdk')>()),
  createWorkspaceClient: () => ({
    agents: { registerOrRotate: relay.registerOrRotate, list: relay.list },
  }),
  createAgentClient: () => {
    throw new Error('no agent client in tests');
  },
  createRealtimeClient: () => {
    throw new Error('no realtime in tests');
  },
}));

const { createAgentRelayMcpServer } = await import('./agent-relay-mcp.js');

async function connect(clientName: string, options: { clientHint?: string; agentName?: string } = {}) {
  const server = createAgentRelayMcpServer({
    workspaceKey: 'rk_live_test',
    agentName: options.agentName,
    sharedSessionTools: [],
    autoRegister: options.agentName
      ? undefined
      : { cwd: '/home/me/src/myproject', clientHint: options.clientHint, fetch: relay.fetch as never },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: clientName, version: '1.0.0' });
  await client.connect(clientTransport);
  return client;
}

beforeEach(() => {
  relay.online = [];
  relay.present = [];
  relay.fetch.mockClear();
  relay.registerOrRotate.mockClear();
  relay.list.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('relay mcp automatic session identity', () => {
  it('registers as <tool>-<folder> from clientInfo before the first tool call runs', async () => {
    const client = await connect('claude-code');
    const result = await client.callTool({ name: 'register_agent', arguments: { name: 'lead' } });
    expect(relay.registerOrRotate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ name: 'claude-myproject' })
    );
    // register_agent still picks a name of the caller's choosing afterwards.
    expect(relay.registerOrRotate).toHaveBeenNthCalledWith(2, expect.objectContaining({ name: 'lead' }));
    expect(JSON.stringify(result)).toContain('lead');
  });

  it('adds a suffix when a connected session already holds the name', async () => {
    relay.present = ['codex-myproject'];
    // The roster still lists a session that exited a minute ago; presence wins.
    relay.online = [{ name: 'codex-myproject' }, { name: 'codex-myproject-2' }];
    const client = await connect('codex-mcp-client');
    await client.callTool({ name: 'list_agents', arguments: {} });
    expect(relay.fetch).toHaveBeenCalledWith(
      new URL('https://cast.agentrelay.com/v1/agents/presence'),
      expect.anything()
    );
    expect(relay.registerOrRotate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'codex-myproject-2' })
    );
  });

  it('reuses the name of a session that is no longer connected', async () => {
    relay.present = [];
    relay.online = [{ name: 'claude-myproject' }];
    const client = await connect('claude-code');
    await client.callTool({ name: 'list_agents', arguments: {} });
    expect(relay.registerOrRotate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'claude-myproject' })
    );
  });

  it('resumes the identity of an earlier, disconnected session that still holds the name', async () => {
    relay.registerOrRotate.mockRejectedValueOnce(
      Object.assign(new Error('Agent "claude-myproject" already exists in this workspace'), {
        code: 'agent_already_exists',
      })
    );
    const client = await connect('claude-code');
    await client.callTool({ name: 'list_agents', arguments: {} });
    const routes = relay.fetch.mock.calls.map(([url]) => new URL(String(url)).pathname);
    expect(routes).toContain('/v1/agents/claude-myproject/takeover');
  });

  it('keeps the session present with heartbeats as its own agent', async () => {
    const client = await connect('claude-code');
    await client.callTool({ name: 'list_agents', arguments: {} });
    const beat = relay.fetch.mock.calls.find(([url]) => String(url).endsWith('/v1/agents/heartbeat'));
    expect(beat?.[1]).toMatchObject({
      method: 'POST',
      headers: { authorization: 'Bearer at_live_claude-myproject' },
    });
  });

  it('falls back to the online roster when the presence endpoint is unavailable', async () => {
    relay.present = null;
    relay.online = [{ name: 'claude-myproject' }];
    const client = await connect('claude-code');
    await client.callTool({ name: 'list_agents', arguments: {} });
    expect(relay.list).toHaveBeenCalledWith({ status: 'online' });
    expect(relay.registerOrRotate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'claude-myproject-2' })
    );
  });

  it('uses the install hint when the client name is generic', async () => {
    const client = await connect('rmcp', { clientHint: 'devin' });
    await client.callTool({ name: 'list_agents', arguments: {} });
    expect(relay.registerOrRotate).toHaveBeenCalledWith(expect.objectContaining({ name: 'devin-myproject' }));
  });

  it('never registers as orchestrator', async () => {
    const client = await connect('some-unknown-client');
    await client.callTool({ name: 'list_agents', arguments: {} });
    const names = relay.registerOrRotate.mock.calls.map(([input]) => input.name);
    expect(names).toEqual(['some-unknown-myproject']);
    expect(names).not.toContain('orchestrator');
  });

  it('does not auto-register when RELAY_AGENT_NAME configured a name', async () => {
    const client = await connect('claude-code', { agentName: 'lead' });
    await client.callTool({ name: 'list_agents', arguments: {} });
    expect(relay.registerOrRotate).not.toHaveBeenCalled();
  });
});
