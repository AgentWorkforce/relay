import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnSpy = vi.fn();
const connectSpy = vi.fn();
const mockSpawnedClient = {
  spawnPty: vi.fn(async () => undefined),
};
const mockConnectedClient = {
  spawnPty: vi.fn(async () => undefined),
};

vi.mock('@agent-relay/harness-driver', () => {
  return {
    HarnessDriverClient: {
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

import { createRuntimeClient, spawnAgentWithClient } from './client-factory.js';

const originalEnv = { ...process.env };

describe('client-factory', () => {
  beforeEach(() => {
    spawnSpy.mockClear();
    connectSpy.mockClear();
    mockSpawnedClient.spawnPty.mockClear();
    mockConnectedClient.spawnPty.mockClear();
    delete process.env.AGENT_RELAY_BIN;
    delete process.env.AGENT_RELAY_STATE_DIR;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('builds HarnessDriverClient with defaults', async () => {
    process.env.AGENT_RELAY_BIN = '/tmp/agent-relay-broker';

    await createRuntimeClient({ cwd: '/tmp/project' });

    expect(spawnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/tmp/project',
        channels: ['general'],
        binaryPath: '/tmp/agent-relay-broker',
      })
    );
    expect(connectSpy).not.toHaveBeenCalled();
  });

  it('builds HarnessDriverClient with explicit options', async () => {
    await createRuntimeClient({
      cwd: '/tmp/project',
      channels: ['ops'],
      binaryPath: '/custom/broker',
      binaryArgs: { persist: true, apiPort: 4321 },
      env: { TEST: '1' } as unknown as NodeJS.ProcessEnv,
    });

    expect(spawnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/tmp/project',
        channels: ['ops'],
        binaryPath: '/custom/broker',
        binaryArgs: { persist: true, apiPort: 4321 },
      })
    );
  });

  it('resolves the broker binary from the isolated env instead of the host env', async () => {
    process.env.AGENT_RELAY_BIN = '/host/agent-relay-broker';
    const env = {
      AGENT_RELAY_BIN: '/embedded/agent-relay-broker',
      EMBEDDED_ONLY: '1',
    } as NodeJS.ProcessEnv;

    await createRuntimeClient({
      cwd: '/tmp/project',
      env,
      parentEnv: env,
    });

    expect(spawnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        binaryPath: '/embedded/agent-relay-broker',
        env,
        parentEnv: env,
      })
    );
  });

  it('prefers connecting to an existing broker when requested', async () => {
    const client = await createRuntimeClient({
      cwd: '/tmp/project',
      preferConnect: true,
    });

    expect(connectSpy).toHaveBeenCalledWith({ cwd: '/tmp/project' });
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(client).toBe(mockConnectedClient);
  });

  it('resolves an existing broker connection from the isolated env', async () => {
    process.env.AGENT_RELAY_STATE_DIR = '/host/state';
    const env = { AGENT_RELAY_STATE_DIR: '/embedded/state' } as NodeJS.ProcessEnv;

    await createRuntimeClient({
      cwd: '/tmp/project',
      env,
      preferConnect: true,
    });

    expect(connectSpy).toHaveBeenCalledWith({ cwd: '/tmp/project', env });
    expect(spawnSpy).not.toHaveBeenCalled();
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
