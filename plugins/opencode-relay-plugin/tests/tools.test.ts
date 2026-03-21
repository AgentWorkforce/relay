import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import relayPlugin, {
  RelayState,
  createRelayAgentsTool,
  createRelayConnectTool,
  createRelayInboxTool,
  createRelayPostTool,
  createRelaySendTool,
} from '../src/index.js';
import {
  MockRelayServer,
  connectRelayState,
  createMockFetch,
  createPluginContext,
} from './mock-relay-server.js';

describe('OpenCode relay core tools', () => {
  let server: MockRelayServer;

  beforeEach(() => {
    server = new MockRelayServer();
    vi.stubGlobal('fetch', createMockFetch(server) as typeof fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('registers all seven tools through the plugin entry point', async () => {
    const { ctx, tools } = createPluginContext();

    await relayPlugin(ctx);

    expect(Array.from(tools.keys())).toEqual([
      'relay_connect',
      'relay_send',
      'relay_inbox',
      'relay_agents',
      'relay_post',
      'relay_spawn',
      'relay_dismiss',
    ]);
  });

  it('connects successfully and stores the relay token', async () => {
    const state = new RelayState();

    const result = await createRelayConnectTool(state).handler({
      workspace: 'rk_live_test_fake_workspace_key',
      name: 'Lead',
    });

    expect(result).toEqual({
      ok: true,
      name: 'Lead',
      workspace: 'rk_live_test...',
    });
    expect(state.connected).toBe(true);
    expect(state.agentName).toBe('Lead');
    expect(state.workspace).toBe('rk_live_test_fake_workspace_key');
    expect(state.token).toBe('test-token-123');
    expect(server.requests[0]).toMatchObject({
      endpoint: 'register',
      body: {
        workspace: 'rk_live_test_fake_workspace_key',
        name: 'Lead',
        cli: 'opencode',
      },
    });
  });

  it('rejects an invalid workspace key before registering', async () => {
    const state = new RelayState();

    await expect(
      createRelayConnectTool(state).handler({
        workspace: 'workspace-test',
        name: 'Lead',
      })
    ).rejects.toThrow('Invalid workspace key. Get one at relaycast.dev');

    expect(server.requests).toHaveLength(0);
    expect(state.connected).toBe(false);
  });

  it('sends a DM through relay_send', async () => {
    const state = connectRelayState(new RelayState());

    const result = await createRelaySendTool(state).handler({
      to: 'Researcher',
      text: 'Check the auth module.',
    });

    expect(result).toEqual({ sent: true, to: 'Researcher' });
    expect(server.requests[0]).toMatchObject({
      endpoint: 'dm/send',
      body: {
        to: 'Researcher',
        text: 'Check the auth module.',
      },
    });
  });

  it('throws if relay_send is called before connecting', async () => {
    await expect(
      createRelaySendTool(new RelayState()).handler({
        to: 'Researcher',
        text: 'Hello',
      })
    ).rejects.toThrow('Not connected to Relay. Call relay_connect first.');
  });

  it('returns inbox messages and clears the queue', async () => {
    const state = connectRelayState(new RelayState());
    server.injectMessage('Researcher', 'ACK: Looking into auth.');
    server.injectMessage('Reviewer', 'DONE: Reviewed the patch.', { channel: 'wave1-opencode' });

    const firstCheck = await createRelayInboxTool(state).handler({});
    const secondCheck = await createRelayInboxTool(state).handler({});

    expect(firstCheck.count).toBe(2);
    expect(firstCheck.messages).toEqual([
      expect.objectContaining({
        from: 'Researcher',
        text: 'ACK: Looking into auth.',
      }),
      expect.objectContaining({
        from: 'Reviewer',
        text: 'DONE: Reviewed the patch.',
        channel: 'wave1-opencode',
      }),
    ]);
    expect(secondCheck).toEqual({ count: 0, messages: [] });
  });

  it('lists agents through relay_agents', async () => {
    const state = connectRelayState(new RelayState());
    server.agents = ['Lead', 'Researcher', 'Reviewer'];

    const result = await createRelayAgentsTool(state).handler({});

    expect(result).toEqual({
      agents: ['Lead', 'Researcher', 'Reviewer'],
    });
    expect(server.requests[0]?.endpoint).toBe('agent/list');
  });

  it('posts a channel message through relay_post', async () => {
    const state = connectRelayState(new RelayState());

    const result = await createRelayPostTool(state).handler({
      channel: 'wave1-opencode',
      text: 'DONE: Phase 1 complete.',
    });

    expect(result).toEqual({
      posted: true,
      channel: 'wave1-opencode',
    });
    expect(server.requests[0]).toMatchObject({
      endpoint: 'message/post',
      body: {
        channel: 'wave1-opencode',
        text: 'DONE: Phase 1 complete.',
      },
    });
  });
});
