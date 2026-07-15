import { beforeEach, describe, expect, it, vi } from 'vitest';

const createRuntimeClientMock = vi.hoisted(() => vi.fn());

vi.mock('../lib/client-factory.js', () => ({
  createRuntimeClient: createRuntimeClientMock,
  spawnAgentWithClient: vi.fn(async () => undefined),
}));

import { createDefaultRelay } from './core.js';

describe('createDefaultRelay runtime environment', () => {
  beforeEach(() => {
    createRuntimeClientMock.mockReset();
    createRuntimeClientMock.mockResolvedValue({
      getStatus: vi.fn(async () => ({})),
      getSession: vi.fn(async () => ({})),
      shutdown: vi.fn(async () => undefined),
    });
  });

  it('uses an explicit embedded env as the broker child parent env', async () => {
    const env = {
      AGENT_RELAY_STATE_DIR: '/embedded/state',
      EMBEDDED_ONLY: '1',
    } as NodeJS.ProcessEnv;

    await createDefaultRelay('/tmp/project', 3889, 'embedded-node', false, { env });

    expect(createRuntimeClientMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/tmp/project',
        binaryArgs: {
          persist: true,
          apiPort: 3889,
          stateDir: '/embedded/state',
        },
        env,
        parentEnv: env,
      })
    );
  });

  it('keeps normal CLI process-env inheritance when no runtime env is supplied', async () => {
    await createDefaultRelay('/tmp/project');

    const options = createRuntimeClientMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(options.env).toBe(process.env);
    expect(options).not.toHaveProperty('parentEnv');
  });
});
