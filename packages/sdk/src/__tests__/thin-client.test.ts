import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const relaycastMocks = vi.hoisted(() => {
  const createWorkspace = vi.fn();
  type Mock = ReturnType<typeof vi.fn>;
  const agentClients: Array<Record<string, unknown>> = [];
  const relayCastInstances: Array<{
    config: Record<string, unknown>;
    as: Mock;
    agents: { list: Mock; registerOrRotate: Mock; spawn: Mock; release: Mock };
  }> = [];
  const wsClientInstances: Array<Record<string, unknown>> = [];

  const makeAgentClient = () => ({
    send: vi.fn(async (...args: unknown[]) => ({ raw: true, args })),
    inbox: vi.fn(async () => ({ unread_channels: [] })),
    markRead: vi.fn(async () => ({})),
    channels: {
      join: vi.fn(async () => ({})),
    },
    actions: {
      invoke: vi.fn(async () => ({ invocation_id: 'inv_1' })),
    },
  });

  const relayCast = vi.fn().mockImplementation(function (config: Record<string, unknown>) {
    const as = vi.fn((_token: string, _options?: unknown) => {
      const agent = makeAgentClient();
      agentClients.push(agent);
      return agent;
    });
    const instance = {
      config,
      as,
      agents: {
        list: vi.fn(async () => [{ name: 'A' }]),
        registerOrRotate: vi.fn(async () => ({ name: 'A', token: 'at_live_a', extra_field: 1 })),
        spawn: vi.fn(async () => ({ spawned: true })),
        release: vi.fn(async () => ({ name: 'A', released: true, deleted: false, reason: null })),
      },
    };
    relayCastInstances.push(instance);
    return instance;
  });

  class FakeWsClient {
    readonly connect = vi.fn();
    readonly disconnect = vi.fn();
    readonly on = vi.fn(() => () => undefined);

    constructor(public readonly config: Record<string, unknown>) {
      wsClientInstances.push(this as unknown as Record<string, unknown>);
    }
  }

  return { createWorkspace, relayCast, relayCastInstances, agentClients, wsClientInstances, FakeWsClient };
});

vi.mock('@relaycast/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@relaycast/sdk')>();
  relaycastMocks.relayCast.createWorkspace = relaycastMocks.createWorkspace;
  return {
    ...actual,
    RelayCast: relaycastMocks.relayCast,
    WsClient: relaycastMocks.FakeWsClient,
  };
});

import {
  createAgentClient,
  createRealtimeClient,
  createWorkspace,
  createWorkspaceClient,
} from '../messaging/thin-client.js';

beforeEach(() => {
  vi.stubEnv('AGENT_RELAY_ORIGIN_ACTOR', '');
  vi.stubEnv('AGENT_RELAY_HARNESS', '');
  vi.stubEnv('AGENT_RELAY_ORCHESTRATOR_HARNESS', '');
  vi.stubEnv('RELAYCAST_HARNESS', '');
  vi.stubEnv('X_RELAYCAST_HARNESS', '');
  vi.stubEnv('AGENT_RELAY_DISTINCT_ID', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  relaycastMocks.relayCastInstances.length = 0;
  relaycastMocks.agentClients.length = 0;
  relaycastMocks.wsClientInstances.length = 0;
});

describe('createWorkspaceClient', () => {
  it('builds a workspace-key client and passes calls through untouched', async () => {
    const client = createWorkspaceClient({
      workspaceKey: 'rk_live_test',
      baseUrl: 'https://api.relaycast.dev',
    });

    const instance = relaycastMocks.relayCastInstances[0];
    expect(instance.config).toEqual({
      apiKey: 'rk_live_test',
      baseUrl: 'https://api.relaycast.dev',
    });

    const registered = await client.agents.registerOrRotate({ name: 'A', type: 'agent' });
    expect(instance.agents.registerOrRotate).toHaveBeenCalledWith({ name: 'A', type: 'agent' });
    // Raw payload: unknown upstream fields survive.
    expect(registered).toEqual({ name: 'A', token: 'at_live_a', extra_field: 1 });

    await client.agents.list({ status: 'online' });
    expect(instance.agents.list).toHaveBeenCalledWith({ status: 'online' });

    await client.agents.spawn({ name: 'W', cli: 'claude', task: 'help' });
    expect(instance.agents.spawn).toHaveBeenCalledWith({ name: 'W', cli: 'claude', task: 'help' });

    const released = await client.agents.release({ name: 'W', deleteAgent: true });
    expect(instance.agents.release).toHaveBeenCalledWith({ name: 'W', deleteAgent: true });
    expect(released.released).toBe(true);
  });

  it('omits baseUrl when not provided and resolves telemetry from the environment', () => {
    vi.stubEnv('AGENT_RELAY_ORIGIN_ACTOR', 'agent-relay-cli/agent/claude-code');
    vi.stubEnv('AGENT_RELAY_DISTINCT_ID', 'distinct_env');

    createWorkspaceClient({ workspaceKey: 'rk_live_test' });

    expect(relaycastMocks.relayCastInstances[0].config).toEqual({
      apiKey: 'rk_live_test',
      originActor: 'agent-relay-cli/agent/claude-code',
      agentRelayDistinctId: 'distinct_env',
    });
  });

  it('prefers explicit telemetry overrides over the environment', () => {
    vi.stubEnv('AGENT_RELAY_ORIGIN_ACTOR', 'agent-relay-cli/agent/env');
    vi.stubEnv('AGENT_RELAY_DISTINCT_ID', 'distinct_env');

    createWorkspaceClient({
      workspaceKey: 'rk_live_test',
      originActor: 'agent-relay-cli/agent/explicit',
      agentRelayDistinctId: 'distinct_explicit',
    });

    expect(relaycastMocks.relayCastInstances[0].config).toMatchObject({
      originActor: 'agent-relay-cli/agent/explicit',
      agentRelayDistinctId: 'distinct_explicit',
    });
  });

  it('propagates upstream errors unchanged', async () => {
    const client = createWorkspaceClient({ workspaceKey: 'rk_live_test' });
    const failure = new Error('Invalid agent token');
    relaycastMocks.relayCastInstances[0].agents.registerOrRotate.mockRejectedValueOnce(failure);

    await expect(client.agents.registerOrRotate({ name: 'A' })).rejects.toBe(failure);
  });
});

describe('createAgentClient', () => {
  it('authenticates the underlying client with the agent token and disables heartbeats by default', async () => {
    const client = createAgentClient({
      agentToken: 'at_live_test',
      baseUrl: 'https://api.relaycast.dev',
    });

    const instance = relaycastMocks.relayCastInstances[0];
    expect(instance.config).toEqual({
      apiKey: 'at_live_test',
      baseUrl: 'https://api.relaycast.dev',
    });
    expect(instance.as).toHaveBeenCalledWith('at_live_test', { autoHeartbeatMs: false });

    const agent = relaycastMocks.agentClients[0] as { send: ReturnType<typeof vi.fn> };
    const sent = await client.send('general', 'hello', { mode: 'wait' });
    expect(agent.send).toHaveBeenCalledWith('general', 'hello', { mode: 'wait' });
    expect(sent).toEqual({ raw: true, args: ['general', 'hello', { mode: 'wait' }] });
  });

  it('honors an explicit heartbeat interval', () => {
    createAgentClient({ agentToken: 'at_live_test', autoHeartbeatMs: 5000 });
    expect(relaycastMocks.relayCastInstances[0].as).toHaveBeenCalledWith('at_live_test', {
      autoHeartbeatMs: 5000,
    });
  });

  it('exposes the raw relay action surface and propagates errors unchanged', async () => {
    const client = createAgentClient({ agentToken: 'at_live_test' });
    const agent = relaycastMocks.agentClients[0] as {
      actions: { invoke: ReturnType<typeof vi.fn> };
      inbox: ReturnType<typeof vi.fn>;
    };

    await client.actions?.invoke('agent.create', { name: 'W' });
    expect(agent.actions.invoke).toHaveBeenCalledWith('agent.create', { name: 'W' });

    const failure = new Error('Invalid agent token');
    agent.inbox.mockRejectedValueOnce(failure);
    await expect(client.inbox()).rejects.toBe(failure);
  });
});

describe('createRealtimeClient', () => {
  it('builds a WsClient with token, baseUrl, and telemetry', () => {
    vi.stubEnv('AGENT_RELAY_DISTINCT_ID', 'distinct_env');

    const client = createRealtimeClient({
      agentToken: 'at_live_test',
      baseUrl: 'https://api.relaycast.dev',
    });

    expect(relaycastMocks.wsClientInstances[0].config).toEqual({
      token: 'at_live_test',
      baseUrl: 'https://api.relaycast.dev',
      agentRelayDistinctId: 'distinct_env',
    });

    const handler = (): void => undefined;
    client.on('*', handler);
    client.connect();
    client.disconnect();
    const ws = relaycastMocks.wsClientInstances[0] as unknown as {
      on: ReturnType<typeof vi.fn>;
      connect: ReturnType<typeof vi.fn>;
      disconnect: ReturnType<typeof vi.fn>;
    };
    expect(ws.on).toHaveBeenCalledWith('*', handler);
    expect(ws.connect).toHaveBeenCalledTimes(1);
    expect(ws.disconnect).toHaveBeenCalledTimes(1);
  });
});

describe('createWorkspace', () => {
  it('creates a workspace with workspace-level telemetry only', async () => {
    vi.stubEnv('AGENT_RELAY_ORIGIN_ACTOR', 'agent-relay-cli/agent/claude-code');
    vi.stubEnv('AGENT_RELAY_DISTINCT_ID', 'distinct_env');
    relaycastMocks.createWorkspace.mockResolvedValueOnce({
      workspace_key: 'rk_live_created',
      name: 'Test',
    });

    const payload = await createWorkspace('Test', { baseUrl: 'https://api.relaycast.dev' });

    // Workspace creation has no agent identity: only the distinct id is sent.
    expect(relaycastMocks.createWorkspace).toHaveBeenCalledWith('Test', {
      baseUrl: 'https://api.relaycast.dev',
      agentRelayDistinctId: 'distinct_env',
    });
    expect(payload).toEqual({ workspace_key: 'rk_live_created', name: 'Test' });
  });

  it('omits baseUrl when not provided', async () => {
    relaycastMocks.createWorkspace.mockResolvedValueOnce({ workspace_key: 'rk_live_created' });

    await createWorkspace('Test');

    expect(relaycastMocks.createWorkspace).toHaveBeenCalledWith('Test', {});
  });
});
