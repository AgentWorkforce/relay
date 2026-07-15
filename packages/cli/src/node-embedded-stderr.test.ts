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

  it('bounds retained output while continuing to stream every broker diagnostic', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-node-stderr-'));
    tempRoots.push(stateDir);
    const streamed: string[] = [];
    createRuntimeClientMock.mockImplementation(async (options) => {
      for (let index = 0; index < 1_500; index += 1) {
        options.onStderr?.(`startup diagnostic ${index}`);
      }
      return {
        brokerPid: process.pid,
        workspaceKey: 'rk_test',
        getStatus: vi.fn(async () => ({})),
        getSession: vi.fn(async () => ({ workspace_key: 'rk_test' })),
        shutdown: shutdownMock,
      };
    });

    const started = await startEmbeddedNode(
      { stateDir, verbose: true },
      {
        env: {
          AGENT_RELAY_DISABLE_IMPLICIT_FLEET_NODE: '1',
          AGENT_RELAY_STATE_DIR: stateDir,
        },
        onOutput: (entry) => streamed.push(entry.message),
      }
    );

    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error(started.message);
    expect(streamed.length).toBeGreaterThan(1_500);
    expect(started.output.length).toBeLessThanOrEqual(1_000);
    expect(started.output).toContainEqual({
      level: 'info',
      message: '[broker] startup diagnostic 1499',
    });
    await started.handle.stop();
  });
});
