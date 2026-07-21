import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnSpy = vi.fn();
const connectSpy = vi.fn();
const createNativeHarnessLaunchSpy = vi.fn();
const mockSpawnedClient = {
  spawnPty: vi.fn(async () => undefined),
  spawnHeadless: vi.fn(async () => undefined),
};
const mockConnectedClient = {
  spawnPty: vi.fn(async () => undefined),
  spawnHeadless: vi.fn(async () => undefined),
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

vi.mock('@agent-relay/harnesses', () => ({
  resolveHarnessRuntime: (cli: string, runtime = 'auto') => {
    if (runtime === 'native') {
      if (!['claude', 'codex', 'opencode', 'pi', 'deepagents'].includes(cli)) {
        throw new Error(`No native harness adapter is registered for ${cli}`);
      }
      return 'native';
    }
    if (runtime === 'pty') return 'pty';
    if (cli === 'pi' || cli === 'deepagents') {
      throw new Error(`${cli} is an experimental native-only harness`);
    }
    return 'pty';
  },
  createNativeHarnessLaunch: (...args: unknown[]) => {
    createNativeHarnessLaunchSpy(...args);
    return {
      name: 'worker-native',
      cli: 'codex',
      transport: 'headless',
      harnessConfig: { runtime: 'native', command: process.execPath },
    };
  },
}));

import { createRuntimeClient, nativeSidecarLaunch, spawnAgentWithClient } from './client-factory.js';

describe('client-factory', () => {
  beforeEach(() => {
    spawnSpy.mockClear();
    connectSpy.mockClear();
    mockSpawnedClient.spawnPty.mockClear();
    mockSpawnedClient.spawnHeadless.mockClear();
    mockConnectedClient.spawnPty.mockClear();
    mockConnectedClient.spawnHeadless.mockClear();
    createNativeHarnessLaunchSpy.mockClear();
    delete process.env.AGENT_RELAY_BIN;
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

  it('prefers connecting to an existing broker when requested', async () => {
    const client = await createRuntimeClient({
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

  it('spawns an explicit native runtime through the AI SDK sidecar launch', async () => {
    const spawnHeadless = vi.fn(async () => undefined);

    await spawnAgentWithClient({ spawnHeadless } as any, {
      name: 'worker-native',
      cli: 'codex',
      channels: ['general'],
      task: 'inspect the repository',
      runtime: 'native',
    });

    expect(createNativeHarnessLaunchSpy).toHaveBeenCalledWith(
      'codex',
      expect.objectContaining({
        runtime: 'native',
        name: 'worker-native',
        task: 'inspect the repository',
      }),
      undefined
    );
    expect(spawnHeadless).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'worker-native',
        cli: 'codex',
        harnessConfig: expect.objectContaining({ runtime: 'native' }),
      })
    );
  });

  it('re-enters a compiled Bun executable for the bundled native sidecar', () => {
    expect(nativeSidecarLaunch(['bun', '/$bunfs/root/agent-relay', 'node'], '/bin/agent-relay')).toEqual({
      command: '/bin/agent-relay',
      args: ['__ai-sdk-sidecar'],
    });
    expect(nativeSidecarLaunch(['node', '/repo/dist/cli/index.js'], '/usr/bin/node')).toBeUndefined();
  });

  it('keeps auto on PTY for experimental dual-runtime harnesses', async () => {
    const spawnPty = vi.fn(async () => undefined);
    await spawnAgentWithClient({ spawnPty } as any, {
      name: 'worker-auto',
      cli: 'codex',
      channels: ['general'],
      runtime: 'auto',
    });
    expect(spawnPty).toHaveBeenCalledOnce();
  });

  it('rejects unsupported native providers and native task-exit options', async () => {
    await expect(
      spawnAgentWithClient({} as any, {
        name: 'gemini-native',
        cli: 'gemini',
        channels: ['general'],
        runtime: 'native',
      })
    ).rejects.toThrow(/No native harness adapter/);

    await expect(
      spawnAgentWithClient({} as any, {
        name: 'codex-native',
        cli: 'codex',
        channels: ['general'],
        runtime: 'native',
        spawnMode: 'task-exit',
      })
    ).rejects.toThrow(/only interactive spawn mode/);
  });
});
