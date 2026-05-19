import { describe, expect, it, vi } from 'vitest';

import { optionsFromEnv, registerAgentWithRebind } from './relaycast-mcp.js';

describe('registerAgentWithRebind', () => {
  it('reuses the pre-registered strict token without re-registering', async () => {
    const setSession = vi.fn();
    const registerOrRotate = vi.fn();

    const payload = await registerAgentWithRebind({
      session: {
        workspaceKey: 'rk_live_test',
        agentToken: 'at_live_existing',
        agentName: 'WorkerA',
      },
      setSession,
      getRelay: () =>
        ({
          agents: {
            registerOrRotate,
          },
        }) as never,
      name: 'DifferentName',
      strictAgentName: true,
      preferredAgentName: 'WorkerA',
    });

    expect(registerOrRotate).not.toHaveBeenCalled();
    expect(setSession).not.toHaveBeenCalled();
    expect(payload).toEqual({
      name: 'WorkerA',
      token: 'at_live_existing',
      registered_name: 'WorkerA',
      warnings: [
        'Strict worker identity is enabled; ignoring requested name "DifferentName" and using "WorkerA".',
      ],
    });
  });

  it('registers or rotates and updates the bound session token', async () => {
    const setSession = vi.fn();
    const registerOrRotate = vi.fn().mockResolvedValue({
      id: 'agent_123',
      name: 'WorkerA',
      token: 'at_live_rotated',
      status: 'online',
    });

    const payload = await registerAgentWithRebind({
      session: {
        workspaceKey: 'rk_live_test',
        agentToken: null,
        agentName: null,
      },
      setSession,
      getRelay: () =>
        ({
          agents: {
            registerOrRotate,
          },
        }) as never,
      name: 'WorkerA',
      type: 'agent',
      persona: 'Test worker',
      metadata: { model: 'gpt-5' },
      strictAgentName: true,
      preferredAgentName: 'WorkerA',
    });

    expect(registerOrRotate).toHaveBeenCalledWith({
      name: 'WorkerA',
      type: 'agent',
      persona: 'Test worker',
      metadata: { model: 'gpt-5' },
    });
    expect(setSession).toHaveBeenCalledWith({
      agentToken: 'at_live_rotated',
      agentName: 'WorkerA',
    });
    expect(payload).toMatchObject({
      id: 'agent_123',
      name: 'WorkerA',
      token: 'at_live_rotated',
      registered_name: 'WorkerA',
      warnings: [],
    });
  });
});

describe('optionsFromEnv', () => {
  it('auto-selects an orchestrator identity when a workspace key is configured', () => {
    const previous = {
      apiKey: process.env.RELAY_API_KEY,
      agentName: process.env.RELAY_AGENT_NAME,
      clawName: process.env.RELAY_CLAW_NAME,
    };
    process.env.RELAY_API_KEY = 'rk_live_test';
    delete process.env.RELAY_AGENT_NAME;
    delete process.env.RELAY_CLAW_NAME;

    try {
      expect(optionsFromEnv()).toMatchObject({
        apiKey: 'rk_live_test',
        agentName: 'orchestrator',
      });
    } finally {
      if (previous.apiKey === undefined) delete process.env.RELAY_API_KEY;
      else process.env.RELAY_API_KEY = previous.apiKey;
      if (previous.agentName === undefined) delete process.env.RELAY_AGENT_NAME;
      else process.env.RELAY_AGENT_NAME = previous.agentName;
      if (previous.clawName === undefined) delete process.env.RELAY_CLAW_NAME;
      else process.env.RELAY_CLAW_NAME = previous.clawName;
    }
  });
});
