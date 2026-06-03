import { afterEach, describe, expect, it, vi } from 'vitest';

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

describe('AgentRelay workspace setup', () => {
  afterEach(() => {
    relaycastMocks.createWorkspace.mockReset();
    relaycastMocks.relayCast.mockClear();
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
});
