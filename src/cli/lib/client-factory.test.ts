import { beforeEach, describe, expect, it, vi } from 'vitest';

const constructorSpy = vi.fn();

vi.mock('@agent-relay/sdk', () => {
  class MockAgentRelayClient {
    constructor(options: unknown) {
      constructorSpy(options);
    }
  }

  return { AgentRelayClient: MockAgentRelayClient };
});

import { createAgentRelayClient, spawnAgentWithClient } from './client-factory.js';

describe('client-factory', () => {
  beforeEach(() => {
    constructorSpy.mockClear();
    delete process.env.AGENT_RELAY_BIN;
  });

  it('builds AgentRelayClient with defaults', () => {
    process.env.AGENT_RELAY_BIN = '/tmp/agent-relay-broker';

    createAgentRelayClient({ cwd: '/tmp/project' });

    expect(constructorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/tmp/project',
        channels: ['general'],
        binaryPath: '/tmp/agent-relay-broker',
      })
    );
  });

  it('builds AgentRelayClient with explicit options', () => {
    createAgentRelayClient({
      cwd: '/tmp/project',
      channels: ['ops'],
      binaryPath: '/custom/broker',
      binaryArgs: ['--debug'],
      env: { TEST: '1' },
      requestTimeoutMs: 1_500,
    });

    expect(constructorSpy).toHaveBeenCalledWith({
      cwd: '/tmp/project',
      channels: ['ops'],
      binaryPath: '/custom/broker',
      binaryArgs: ['--debug'],
      env: { TEST: '1' },
      requestTimeoutMs: 1_500,
    });
  });

  it('spawns through spawnPty when available', async () => {
    const spawnPty = vi.fn(async () => undefined);
    const options = {
      name: 'worker-a',
      cli: 'claude',
      channels: ['general'],
      task: 'hello',
    };

    await spawnAgentWithClient({ spawnPty } as any, options);

    expect(spawnPty).toHaveBeenCalledWith(options);
  });

  it('throws when client does not support spawnPty', async () => {
    await expect(
      spawnAgentWithClient({} as any, {
        name: 'worker-a',
        cli: 'claude',
        channels: ['general'],
      })
    ).rejects.toThrow('Agent relay client does not support spawning agents');
  });
});
