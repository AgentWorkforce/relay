import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnSpy = vi.fn();
const connectSpy = vi.fn();
const mockSpawnedClient = {
  spawnPty: vi.fn(async () => undefined),
};
const mockConnectedClient = {
  spawnPty: vi.fn(async () => undefined),
};

vi.mock('@agent-relay/sdk', () => {
  return {
    AgentRelayClient: {
      spawn: (...args: unknown[]) => {
        spawnSpy(...args);
        return Promise.resolve(mockSpawnedClient);
      },
      connect: (...args: unknown[]) => {
        connectSpy(...args);
        return mockConnectedClient;
      },
    },
  };
});

import { createAgentRelayClient, spawnAgentWithClient } from './client-factory.js';

describe('client-factory', () => {
  beforeEach(() => {
    spawnSpy.mockClear();
    connectSpy.mockClear();
    mockSpawnedClient.spawnPty.mockClear();
    mockConnectedClient.spawnPty.mockClear();
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
    expect(connectSpy).not.toHaveBeenCalled();
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

  it('prefers connecting to an existing broker when requested', async () => {
    const client = await createAgentRelayClient({
      cwd: '/tmp/project',
      preferConnect: true,
    });

    expect(connectSpy).toHaveBeenCalledWith({ cwd: '/tmp/project' });
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(client).toBe(mockConnectedClient);
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
