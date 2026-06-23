import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import relayPlugin, {
  RelayState,
  createRelayAgentsTool,
  createRelayConnectTool,
  createRelayInboxTool,
  createRelayPostTool,
  createRelaySendTool,
  inboxToMessages,
} from '../src/index.js';
import type { InboxResponse } from '@relaycast/sdk';
import {
  MockRelayServer,
  connectRelayState,
  createMockRelayCastFactory,
  createPluginContext,
} from './mock-relay-server.js';

describe('OpenCode relay core tools', () => {
  let server: MockRelayServer;

  beforeEach(() => {
    server = new MockRelayServer();
  });

  afterEach(() => {
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

    const result = await createRelayConnectTool(state, {
      createRelayCast: createMockRelayCastFactory(server),
    }).handler({
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
      createRelayConnectTool(state, {
        createRelayCast: createMockRelayCastFactory(server),
      }).handler({
        workspace: 'workspace-test',
        name: 'Lead',
      })
    ).rejects.toThrow('Invalid workspace key. Get one at relaycast.dev');

    expect(server.requests).toHaveLength(0);
    expect(state.connected).toBe(false);
  });

  it('sends a DM through relay_send', async () => {
    const state = connectRelayState(new RelayState(), server);

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
    const state = connectRelayState(new RelayState(), server);
    server.injectMessage('Researcher', 'ACK: Looking into auth.');
    server.injectMessage('Reviewer', 'DONE: Reviewed the patch.');

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
      }),
    ]);
    expect(secondCheck).toEqual({ count: 0, messages: [] });
  });

  it('drains surfaced inbox messages via markRead so the read-only inbox stops re-surfacing them', async () => {
    const state = connectRelayState(new RelayState(), server);
    server.injectMessage('Researcher', 'ACK: Looking into auth.');

    const firstCheck = await createRelayInboxTool(state).handler({});
    expect(firstCheck.count).toBe(1);

    // The plugin must ack the surfaced message; the mock inbox is read-only and
    // only stops reporting an item once it has been markRead'd.
    const readReqs = server.requests.filter((r) => r.endpoint === 'message/read');
    expect(readReqs).toHaveLength(1);
    expect(readReqs[0].body.messageId).toBe(firstCheck.messages[0].id);

    // A subsequent poll sees nothing new even though inbox() is read-only.
    const secondCheck = await createRelayInboxTool(state).handler({});
    expect(secondCheck).toEqual({ count: 0, messages: [] });
  });

  it('hydrates earlier messages of a multi-message DM conversation', async () => {
    const state = connectRelayState(new RelayState(), server);
    // Three unread DMs in one conversation; the summary would only carry the last.
    server.injectDm('alice', 'conv-alice', 'Step 1: pull the branch.');
    server.injectDm('alice', 'conv-alice', 'Step 2: run migrations.');
    server.injectDm('alice', 'conv-alice', 'Step 3: deploy.');

    const result = await createRelayInboxTool(state).handler({});

    expect(result.count).toBe(3);
    expect(result.messages.map((m) => m.text)).toEqual([
      'Step 1: pull the branch.',
      'Step 2: run migrations.',
      'Step 3: deploy.',
    ]);
    // Hydration goes through the DM messages API.
    expect(server.requests.some((r) => r.endpoint === 'dm/messages')).toBe(true);
    // All three are drained.
    expect(server.requests.filter((r) => r.endpoint === 'message/read')).toHaveLength(3);
  });

  it('surfaces unread channel posts that did not mention the reader', async () => {
    const state = connectRelayState(new RelayState(), server);
    server.injectChannelPost('Bob', 'wave1', 'Build is green.');
    server.injectChannelPost('Bob', 'wave1', 'Shipping now.');

    const result = await createRelayInboxTool(state).handler({});

    expect(result.count).toBe(2);
    expect(result.messages).toEqual([
      expect.objectContaining({ from: 'Bob', channel: 'wave1', text: 'Build is green.' }),
      expect.objectContaining({ from: 'Bob', channel: 'wave1', text: 'Shipping now.' }),
    ]);
    expect(server.requests.some((r) => r.endpoint === 'message/list')).toBe(true);
  });

  it('lists agents through relay_agents', async () => {
    const state = connectRelayState(new RelayState(), server);
    server.agents = ['Lead', 'Researcher', 'Reviewer'];

    const result = await createRelayAgentsTool(state).handler({});

    expect(result).toEqual({
      agents: ['Lead', 'Researcher', 'Reviewer'],
    });
    expect(server.requests[0]?.endpoint).toBe('agent/list');
  });

  it('posts a channel message through relay_post', async () => {
    const state = connectRelayState(new RelayState(), server);

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

describe('inboxToMessages defensive handling', () => {
  it('returns [] for null/undefined inbox', () => {
    expect(inboxToMessages(null)).toEqual([]);
    expect(inboxToMessages(undefined)).toEqual([]);
  });

  it('tolerates missing / non-array mentions and unreadDms', () => {
    expect(inboxToMessages({} as unknown as InboxResponse)).toEqual([]);
    expect(
      inboxToMessages({
        mentions: 'nope',
        unreadDms: null,
      } as unknown as InboxResponse)
    ).toEqual([]);
  });
});
