import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const relaycastMocks = vi.hoisted(() => {
  const createWorkspace = vi.fn();
  const relayCast = vi.fn().mockImplementation(function (config: Record<string, unknown>) {
    return {
      config,
      agents: {
        list: vi.fn(async () => []),
        get: vi.fn(),
        register: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        presence: vi.fn(async () => []),
      },
      channels: {
        list: vi.fn(async () => []),
        get: vi.fn(),
      },
      messages: {
        list: vi.fn(async () => []),
        get: vi.fn(),
        thread: vi.fn(),
        reactions: vi.fn(async () => []),
      },
    };
  });

  return { createWorkspace, relayCast };
});

vi.mock('@relaycast/sdk', () => {
  relaycastMocks.relayCast.createWorkspace = relaycastMocks.createWorkspace;
  return { RelayCast: relaycastMocks.relayCast };
});

import { AgentRelay } from '../index.js';
import { relaycastTelemetryOptions } from '../relaycast-telemetry.js';

describe('AgentRelay workspace setup', () => {
  beforeEach(() => {
    vi.stubEnv('AGENT_RELAY_HARNESS', '');
    vi.stubEnv('AGENT_RELAY_ORCHESTRATOR_HARNESS', '');
    vi.stubEnv('RELAYCAST_HARNESS', '');
    vi.stubEnv('X_RELAYCAST_HARNESS', '');
    vi.stubEnv('AGENT_RELAY_DISTINCT_ID', '');
  });

  afterEach(() => {
    relaycastMocks.createWorkspace.mockReset();
    relaycastMocks.relayCast.mockClear();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('creates a workspace and initializes messaging with its workspace key', async () => {
    relaycastMocks.createWorkspace.mockResolvedValue({
      workspaceKey: 'rk_live_created',
      workspaceName: 'Ops',
    });

    const relay = await AgentRelay.createWorkspace({
      name: 'Ops',
      baseUrl: 'https://api.example.test',
    });

    expect(relaycastMocks.createWorkspace).toHaveBeenCalledWith('Ops', {
      baseUrl: 'https://api.example.test',
    });
    expect(relay.workspaceKey).toBe('rk_live_created');
    expect(relaycastMocks.relayCast).toHaveBeenCalledWith({
      apiKey: 'rk_live_created',
      baseUrl: 'https://api.example.test',
    });
  });

  it('accepts workspaceKey without requiring an apiKey option', async () => {
    const relay = new AgentRelay({
      workspaceKey: 'rk_live_existing',
      baseUrl: 'https://api.example.test',
    });

    expect(relay.workspaceKey).toBe('rk_live_existing');
    expect(relaycastMocks.relayCast).toHaveBeenCalledWith({
      apiKey: 'rk_live_existing',
      baseUrl: 'https://api.example.test',
    });
  });

  it('passes explicit Relaycast telemetry through existing workspace clients', () => {
    const relay = new AgentRelay({
      workspaceKey: 'rk_live_existing',
      baseUrl: 'https://api.example.test',
      originActor: 'agent-relay-cli/agent/claude-code',
      agentRelayDistinctId: 'distinct_test',
    });

    expect(relay.workspaceKey).toBe('rk_live_existing');
    expect(relaycastMocks.relayCast).toHaveBeenCalledWith({
      apiKey: 'rk_live_existing',
      baseUrl: 'https://api.example.test',
      originActor: 'agent-relay-cli/agent/claude-code',
      agentRelayDistinctId: 'distinct_test',
    });
  });

  it('passes Relaycast telemetry through createWorkspace bootstrap and clients', async () => {
    relaycastMocks.createWorkspace.mockResolvedValue({
      workspaceKey: 'rk_live_created',
      workspaceName: 'Ops',
    });

    const relay = await AgentRelay.createWorkspace({
      name: 'Ops',
      baseUrl: 'https://api.example.test',
      originActor: 'agent-relay-cli/agent/claude-code',
      agentRelayDistinctId: 'distinct_test',
    });

    expect(relaycastMocks.createWorkspace).toHaveBeenCalledWith('Ops', {
      baseUrl: 'https://api.example.test',
      agentRelayDistinctId: 'distinct_test',
    });
    expect(relay.workspaceKey).toBe('rk_live_created');
    expect(relaycastMocks.relayCast).toHaveBeenCalledWith({
      apiKey: 'rk_live_created',
      baseUrl: 'https://api.example.test',
      originActor: 'agent-relay-cli/agent/claude-code',
      agentRelayDistinctId: 'distinct_test',
    });
  });

  it('uses Relaycast telemetry from environment variables when options omit it', () => {
    vi.stubEnv('AGENT_RELAY_ORIGIN_ACTOR', 'agent-relay-cli/agent/claude-code');
    vi.stubEnv('AGENT_RELAY_DISTINCT_ID', 'distinct_test');

    const relay = new AgentRelay({
      workspaceKey: 'rk_live_existing',
      baseUrl: 'https://api.example.test',
    });

    expect(relay.workspaceKey).toBe('rk_live_existing');
    expect(relaycastMocks.relayCast).toHaveBeenCalledWith({
      apiKey: 'rk_live_existing',
      baseUrl: 'https://api.example.test',
      originActor: 'agent-relay-cli/agent/claude-code',
      agentRelayDistinctId: 'distinct_test',
    });
  });

  it('does not require a Node process global for SDK client construction', () => {
    const originalProcess = globalThis.process;
    vi.stubGlobal('process', undefined);

    try {
      expect(relaycastTelemetryOptions()).toEqual({});
      const relay = new AgentRelay({
        workspaceKey: 'rk_live_existing',
        baseUrl: 'https://api.example.test',
      });

      expect(relay.workspaceKey).toBe('rk_live_existing');
      expect(relaycastMocks.relayCast).toHaveBeenCalledWith({
        apiKey: 'rk_live_existing',
        baseUrl: 'https://api.example.test',
      });
    } finally {
      vi.stubGlobal('process', originalProcess);
    }
  });
});
