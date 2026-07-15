import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createRuntimeClientMock = vi.hoisted(() => vi.fn());
const shutdownMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('./cli/lib/client-factory.js', () => ({
  createRuntimeClient: createRuntimeClientMock,
  spawnAgentWithClient: vi.fn(async () => undefined),
}));

vi.mock('./cli/lib/reflex-capture.js', () => ({
  startReflexCapture: () => ({ stop: vi.fn(async () => undefined) }),
}));

import { startEmbeddedNode } from './node-embedded.js';

const tempRoots: string[] = [];

beforeEach(() => {
  shutdownMock.mockClear();
  createRuntimeClientMock.mockReset();
  createRuntimeClientMock.mockImplementation(async (options) => {
    options.onStderr?.('[agent-relay][startup +1ms] resolving broker identity');
    return {
      brokerPid: process.pid,
      workspaceKey: 'rk_test',
      getStatus: vi.fn(async () => ({})),
      getSession: vi.fn(async () => ({ workspace_key: 'rk_test' })),
      shutdown: shutdownMock,
    };
  });
});

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('embedded node broker stderr', () => {
  it('reports a clean real-default-relay lifecycle as success despite startup diagnostics', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-node-stderr-'));
    tempRoots.push(stateDir);
    const env = {
      ...process.env,
      AGENT_RELAY_DISABLE_IMPLICIT_FLEET_NODE: '1',
      AGENT_RELAY_STATE_DIR: stateDir,
    };

    const started = await startEmbeddedNode({ stateDir, verbose: true }, { env });

    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error(started.message);
    expect(createRuntimeClientMock).toHaveBeenCalledTimes(1);
    expect(started.output).toContainEqual({
      level: 'info',
      message: '[broker] [agent-relay][startup +1ms] resolving broker identity',
    });

    await expect(started.handle.stop()).resolves.toMatchObject({ ok: true, code: 0 });
    await expect(started.handle.completion).resolves.toMatchObject({ ok: true, code: 0 });
    expect(shutdownMock).toHaveBeenCalledTimes(1);
  });
});
