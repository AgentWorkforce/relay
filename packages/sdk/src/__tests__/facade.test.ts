import { describe, expect, it, vi } from 'vitest';

import { AgentRelay, ActionRegistry } from '../index.js';
import type { RelayMessaging } from '../messaging/index.js';

function createMessagingMock() {
  const messages = {
    send: vi.fn(async (input: unknown) => ({ id: 'm1', text: '', from: {}, ...((input as object) ?? {}) })),
    direct: vi.fn(async (input: unknown) => ({ id: 'd1', text: '', from: {}, ...((input as object) ?? {}) })),
    reply: vi.fn(async (input: unknown) => ({ id: 'r1', text: '', from: {}, ...((input as object) ?? {}) })),
    react: vi.fn(async (messageId: string, emoji: string) => ({ emoji, count: 1, agents: [] })),
    groupDirect: vi.fn(async (input: unknown) => ({
      id: 'g1',
      text: '',
      from: {},
      ...((input as object) ?? {}),
    })),
  };
  const agents = {
    register: vi.fn(async (input: { name: string }) => ({
      id: `id-${input.name}`,
      name: input.name,
      token: `tok-${input.name}`,
      status: 'online',
    })),
    me: vi.fn(async () => ({
      id: 'id-self',
      name: 'self',
      type: 'agent',
      status: 'online',
      metadata: {},
      channels: [],
    })),
  };
  const workspace = {
    info: vi.fn(async () => ({ id: 'ws_1', name: 'Ops' })),
    fleetNodes: {
      get: vi.fn(async () => ({ enabled: false, defaultEnabled: false, override: null })),
      set: vi.fn(async (enabled: boolean) => ({ enabled, defaultEnabled: false, override: enabled })),
      inherit: vi.fn(async () => ({ enabled: false, defaultEnabled: false, override: null })),
    },
  };
  const messaging = { messages, agents, workspace, events: {} } as unknown as RelayMessaging;
  return { messaging, messages, agents, workspace };
}

describe('AgentRelay facade (Phase A)', () => {
  it('workspace.register returns live agent clients', async () => {
    const { messaging, agents } = createMessagingMock();
    const relay = new AgentRelay({ messaging, createAgentMessaging: () => messaging });

    const clients = await relay.workspace.register([{ name: 'triager' }, 'engineer']);

    expect(agents.register).toHaveBeenCalledTimes(2);
    expect(clients.map((c) => c.name)).toEqual(['triager', 'engineer']);
    expect(clients.map((c) => c.id)).toEqual(['id-triager', 'id-engineer']);
    expect(clients[0].token).toBe('tok-triager');
    expect(typeof clients[0].status.becomes).toBe('function');
  });

  it('workspace.register returns a single client for a single agent', async () => {
    const { messaging } = createMessagingMock();
    const relay = new AgentRelay({ messaging, createAgentMessaging: () => messaging });

    const alice = await relay.workspace.register({ name: 'Alice' });

    expect(alice.id).toBe('id-Alice');
    expect(alice.name).toBe('Alice');
  });

  it('workspace.reconnect resolves identity from the agent token', async () => {
    const { messaging, agents } = createMessagingMock();
    const relay = new AgentRelay({ messaging, createAgentMessaging: () => messaging });

    const client = await relay.workspace.reconnect({ apiToken: 'tok-self' });

    expect(agents.me).toHaveBeenCalledTimes(1);
    expect(client.id).toBe('id-self');
    expect(client.name).toBe('self');
    expect(client.token).toBe('tok-self');
  });

  it('workspace.fleetNodes delegates fleet node config calls', async () => {
    const { messaging, workspace } = createMessagingMock();
    const relay = new AgentRelay({ messaging });

    await expect(relay.workspace.fleetNodes.get()).resolves.toEqual({
      enabled: false,
      defaultEnabled: false,
      override: null,
    });
    await expect(relay.workspace.fleetNodes.set(true)).resolves.toEqual({
      enabled: true,
      defaultEnabled: false,
      override: true,
    });
    await expect(relay.workspace.fleetNodes.inherit()).resolves.toEqual({
      enabled: false,
      defaultEnabled: false,
      override: null,
    });

    expect(workspace.fleetNodes.get).toHaveBeenCalledTimes(1);
    expect(workspace.fleetNodes.set).toHaveBeenCalledWith(true);
    expect(workspace.fleetNodes.inherit).toHaveBeenCalledTimes(1);
  });

  it('sendMessage routes #channel to messages.send and a bare name to direct', async () => {
    const { messaging, messages } = createMessagingMock();
    const relay = new AgentRelay({ messaging, createAgentMessaging: () => messaging });
    const sender = await relay.workspace.register({ name: 'sender' });

    await sender.sendMessage({ to: '#ops', msg: 'hello channel' });
    expect(messages.send).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'ops', text: 'hello channel' })
    );

    await sender.sendMessage({ to: 'engineer', msg: 'hello agent' });
    expect(messages.direct).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'engineer', text: 'hello agent' })
    );
  });

  it('sendMessage routes an array of handles to a group DM', async () => {
    const { messaging, messages } = createMessagingMock();
    const relay = new AgentRelay({ messaging, createAgentMessaging: () => messaging });
    const sender = await relay.workspace.register({ name: 'sender' });

    await sender.sendMessage({ to: ['@alice', '@bob'], text: 'group hello' });
    expect(messages.groupDirect).toHaveBeenCalledWith(
      expect.objectContaining({ participants: ['alice', 'bob'], text: 'group hello' })
    );
  });

  it('messages.send prepends missing mention handles', async () => {
    const { messaging, messages } = createMessagingMock();
    const relay = new AgentRelay({ messaging });

    await relay.messages.send({ to: '#ops', text: 'ship it', mentions: [{ handle: 'eng' }] });
    expect(messages.send).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'ops', text: '@eng ship it' })
    );
  });

  it('messages.reply accepts a thread reference and react accepts the object form', async () => {
    const { messaging, messages } = createMessagingMock();
    const relay = new AgentRelay({ messaging });

    await relay.messages.reply({ thread: { id: 'parent-1' }, text: 'on it' });
    expect(messages.reply).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'parent-1', text: 'on it' })
    );

    await relay.messages.react({ message: 'm9', emoji: 'eyes' });
    expect(messages.react).toHaveBeenCalledWith('m9', 'eyes');

    await relay.messages.react('m10', 'tada');
    expect(messages.react).toHaveBeenCalledWith('m10', 'tada');
  });

  it('registerAction enforces availableTo and adapts the handler shape', async () => {
    const { messaging } = createMessagingMock();
    const actions = new ActionRegistry();
    const relay = new AgentRelay({ messaging, actions });
    const handler = vi.fn(async () => ({ ok: true }));

    relay.registerAction({
      name: 'spawn-claude',
      description: 'spawn',
      availableTo: [{ name: 'planner' }],
      handler,
    });

    const denied = await actions.invoke({
      name: 'spawn-claude',
      input: {},
      caller: { name: 'intruder', type: 'agent' },
    });
    expect(denied.ok).toBe(false);
    expect(handler).not.toHaveBeenCalled();

    const allowed = await actions.invoke({
      name: 'spawn-claude',
      input: { model: 'opus' },
      caller: { name: 'planner', type: 'agent' },
    });
    expect(allowed.ok).toBe(true);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { model: 'opus' },
        agent: expect.objectContaining({ name: 'planner' }),
      })
    );
  });
});

describe('workspace.register idempotency', () => {
  function createRotatingMessagingMock() {
    const base = createMessagingMock();
    const registerOrRotate = vi.fn(async (input: { name: string }) => ({
      id: `id-${input.name}`,
      name: input.name,
      token: `rotated-${input.name}`,
      status: 'online',
    }));
    (base.messaging.agents as { registerOrRotate?: typeof registerOrRotate }).registerOrRotate =
      registerOrRotate;
    return { ...base, registerOrRotate };
  }

  it('uses registerOrRotate by default so re-registering a name succeeds', async () => {
    const { messaging, agents, registerOrRotate } = createRotatingMessagingMock();
    const relay = new AgentRelay({ messaging, createAgentMessaging: () => messaging });

    const first = await relay.workspace.register({ name: 'triager' });
    const second = await relay.workspace.register({ name: 'triager' });

    expect(registerOrRotate).toHaveBeenCalledTimes(2);
    expect(agents.register).not.toHaveBeenCalled();
    expect(first.id).toBe('id-triager');
    expect(second.id).toBe('id-triager');
    expect(second.token).toBe('rotated-triager');
  });

  it('register({ strict: true }) bypasses rotation and uses plain register', async () => {
    const { messaging, agents, registerOrRotate } = createRotatingMessagingMock();
    const relay = new AgentRelay({ messaging, createAgentMessaging: () => messaging });

    await relay.workspace.register({ name: 'triager' }, { strict: true });

    expect(agents.register).toHaveBeenCalledTimes(1);
    expect(registerOrRotate).not.toHaveBeenCalled();
  });

  it('falls back to plain register when the backend lacks registerOrRotate', async () => {
    const { messaging, agents } = createMessagingMock();
    const relay = new AgentRelay({ messaging, createAgentMessaging: () => messaging });

    const client = await relay.workspace.register({ name: 'triager' });

    expect(agents.register).toHaveBeenCalledTimes(1);
    expect(client.token).toBe('tok-triager');
  });

  it('rejects in-batch duplicate names with a typed name_conflict error', async () => {
    const { messaging } = createRotatingMessagingMock();
    const relay = new AgentRelay({ messaging, createAgentMessaging: () => messaging });

    await expect(relay.workspace.register(['triager', 'triager'])).rejects.toMatchObject({
      name: 'RelayError',
      code: 'name_conflict',
      retryable: false,
    });
  });
});
