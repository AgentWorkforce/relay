import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnSpy = vi.fn();
const mockClient = {
  spawnPty: vi.fn(async () => undefined),
};

vi.mock('@agent-relay/sdk', () => {
  return {
    AgentRelayClient: {
      spawn: (...args: unknown[]) => {
        spawnSpy(...args);
        return Promise.resolve(mockClient);
      },
    },
  };
});

import { createAgentRelayClient, spawnAgentWithClient } from './client-factory.js';

describe('client-factory', () => {
  beforeEach(() => {
    spawnSpy.mockClear();
    mockClient.spawnPty.mockClear();
    delete process.env.AGENT_RELAY_BIN;
  });

  it('builds AgentRelayClient with defaults', async () => {
    process.env.AGENT_RELAY_BIN = '/tmp/agent-relay-broker';

    await createAgentRelayClient({ cwd: '/tmp/project' });

    expect(spawnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/tmp/project',
        channels: ['general'],
        binaryPath: '/tmp/agent-relay-broker',
      })
    );
  });

  it('builds AgentRelayClient with explicit options', async () => {
    await createAgentRelayClient({
      cwd: '/tmp/project',
      channels: ['ops'],
      binaryPath: '/custom/broker',
      binaryArgs: ['--debug'],
      env: { TEST: '1' } as unknown as NodeJS.ProcessEnv,
    });

    expect(spawnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/tmp/project',
        channels: ['ops'],
        binaryPath: '/custom/broker',
        binaryArgs: ['--debug'],
      })
    );
  });

  it('spawns through spawnPty', async () => {
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
});
