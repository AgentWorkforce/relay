import { describe, expect, it, vi } from 'vitest';

import { spawnFleetSandbox, FleetSandboxSpawnError, type SpawnFleetSandboxDependencies } from '../fleet.js';

const SANDBOX_ID = 'sbx_3f2b8c4e-1d2a-4b5c-8d9e-0a1b2c3d4e5f';

function provisioned(overrides: Record<string, unknown> = {}) {
  return {
    outcome: 'provisioned' as const,
    cloudWorkspaceId: 'cw_1',
    nodeId: 'node_1',
    nodeName: 'fleet-sandbox-node',
    sandboxId: SANDBOX_ID,
    relayWorkspaceId: 'rw_1',
    relayfileMounted: true,
    relayfileMountPath: '/workspace',
    providerId: 'e2b' as const,
    ...overrides,
  };
}

function harness(
  options: {
    ensure?: () => Promise<unknown>;
    spawn?: (input: Record<string, unknown>) => Promise<unknown>;
  } = {}
) {
  const calls: string[] = [];
  const ensureCloudFleetSandbox = vi.fn(async (input: Record<string, unknown>) => {
    calls.push('ensure');
    void input;
    return (options.ensure ?? (async () => provisioned()))();
  });
  const deleteCloudFleetSandbox = vi.fn(async (_input: Record<string, unknown>) => {
    calls.push('delete-sandbox');
  });
  const release = vi.fn(async (input: { name: string }) => {
    calls.push(`release:${input.name}`);
  });
  const register = vi.fn(async (input: { name: string }) => {
    calls.push(`register:${input.name}`);
    return { token: 'launcher-token' };
  });
  const workspaceRelay = {
    workspace: { register, release, info: vi.fn(async () => ({ id: 'rw_1' })) },
  };
  const spawn = vi.fn(async (input: Record<string, unknown>) => {
    calls.push('spawn');
    if (options.spawn) return options.spawn(input);
    return {
      id: 'inv_1',
      status: 'completed',
      node: { id: 'node_1', name: 'fleet-sandbox-node', status: 'online', capabilities: [] },
      placement: {
        capability: 'spawn:claude',
        node: 'fleet-sandbox-node',
        attempts: 1,
        queued: false,
        state: 'ready',
        confirmed: true,
      },
    };
  });
  const createWorkspaceRelay = vi.fn((_options: Record<string, unknown>) => workspaceRelay);
  const createAgentRelay = vi.fn((_options: Record<string, unknown>) => ({
    messaging: { placement: { spawn } },
  }));
  const startFleetNodeAttachProxy = vi.fn(async (_options: Record<string, unknown>) => ({
    socketPath: '/tmp/attach.sock',
    finished: Promise.resolve(0),
    close: async () => undefined,
  }));
  const deps = {
    ensureCloudFleetSandbox,
    deleteCloudFleetSandbox,
    createWorkspaceRelay,
    createAgentRelay,
    startFleetNodeAttachProxy,
    warn: vi.fn(),
  } as unknown as SpawnFleetSandboxDependencies;
  return {
    deps,
    calls,
    ensureCloudFleetSandbox,
    deleteCloudFleetSandbox,
    release,
    spawn,
    createAgentRelay,
    startFleetNodeAttachProxy,
  };
}

const base = {
  cli: 'claude',
  name: 'sandbox-worker',
  task: 'Review the repository',
  workspaceId: 'rw_1',
  workspaceKey: 'rk_live_test',
  provider: 'e2b' as const,
};

describe('spawnFleetSandbox', () => {
  it('provisions a sandbox, starts the harness on it, and returns a live attachable handle', async () => {
    const h = harness();
    const handle = await spawnFleetSandbox(
      { ...base, readonlyPaths: ['/docs/**'], relayfilePaths: ['/docs/**', '/work/**'] },
      h.deps
    );

    const ensureInput = h.ensureCloudFleetSandbox.mock.calls[0][0];
    expect(ensureInput).toMatchObject({
      workspaceId: 'rw_1',
      requiredCapability: 'spawn:claude',
      maxAgents: 1,
      mountRelayfile: true,
      readonlyPaths: ['/docs/**'],
      relayfilePaths: ['/docs/**', '/work/**'],
      providerId: 'e2b',
      forceProvision: true,
    });
    expect(ensureInput.sandboxId).toMatch(/^sbx_[0-9a-f-]{36}$/);

    const spawnInput = h.spawn.mock.calls[0][0] as Record<string, any>;
    expect(spawnInput).toMatchObject({
      capability: 'spawn:claude',
      node: 'fleet-sandbox-node',
      confirm: true,
    });
    expect(spawnInput.input).toMatchObject({
      name: 'sandbox-worker',
      cli: 'claude',
      task: 'Review the repository',
      worker_cwd: '/workspace',
    });

    expect(handle).toMatchObject({
      sandboxId: SANDBOX_ID,
      nodeId: 'node_1',
      nodeName: 'fleet-sandbox-node',
      agentName: 'sandbox-worker',
      ownsSandbox: true,
    });
    // The temporary launcher identity never outlives the spawn.
    expect(h.calls.filter((call) => call.startsWith('release:fleet-spawn-launcher-'))).toHaveLength(1);

    const proxy = await handle.attach({ mode: 'drive' });
    expect(proxy.socketPath).toBe('/tmp/attach.sock');
    expect(h.startFleetNodeAttachProxy).toHaveBeenCalledWith(
      expect.objectContaining({
        node: 'fleet-sandbox-node',
        agent: 'sandbox-worker',
        mode: 'drive',
        workspaceKey: 'rk_live_test',
      })
    );
  });

  it('tears down idempotently: releases the agent, then deletes the sandbox it provisioned', async () => {
    const h = harness();
    const handle = await spawnFleetSandbox(base, h.deps);
    h.calls.length = 0;
    await Promise.all([handle.destroy(), handle.destroy()]);
    await handle.destroy();
    expect(h.calls).toEqual(['release:sandbox-worker', 'delete-sandbox']);
    expect(h.deleteCloudFleetSandbox).toHaveBeenCalledWith({
      cloudWorkspaceId: 'cw_1',
      sandboxId: SANDBOX_ID,
      providerId: 'e2b',
    });
  });

  it('retains a caller-declared sandbox on destroy', async () => {
    const h = harness();
    const handle = await spawnFleetSandbox({ ...base, sandboxId: SANDBOX_ID }, h.deps);
    expect(handle.ownsSandbox).toBe(false);
    await handle.destroy();
    expect(h.deleteCloudFleetSandbox).not.toHaveBeenCalled();
  });

  it('fails closed and cleans up when the agent lands on a different node', async () => {
    const h = harness({
      spawn: async () => ({
        id: 'inv_1',
        status: 'completed',
        placement: {
          capability: 'spawn:claude',
          node: 'some-other-node',
          attempts: 1,
          queued: false,
          state: 'ready',
          confirmed: true,
        },
      }),
    });
    await expect(spawnFleetSandbox(base, h.deps)).rejects.toMatchObject({
      name: 'FleetSandboxSpawnError',
      code: 'placement_mismatch',
    });
    expect(h.calls).toContain('release:sandbox-worker');
    expect(h.deleteCloudFleetSandbox).toHaveBeenCalledTimes(1);
  });

  it('deletes the provisioned sandbox when the harness fails to start', async () => {
    const h = harness({
      spawn: async () => {
        throw new Error('spawn failed on node');
      },
    });
    await expect(spawnFleetSandbox(base, h.deps)).rejects.toThrow('spawn failed on node');
    expect(h.deleteCloudFleetSandbox).toHaveBeenCalledTimes(1);
  });

  it('deletes a timed-out sandbox and reports the timeout', async () => {
    const h = harness({
      ensure: async () => ({
        outcome: 'provisioning_timeout',
        cloudWorkspaceId: 'cw_1',
        sandboxId: SANDBOX_ID,
        relayWorkspaceId: 'rw_1',
        nodeName: 'fleet-sandbox-node',
        waitedMs: 90_000,
        providerId: 'e2b',
      }),
    });
    await expect(spawnFleetSandbox(base, h.deps)).rejects.toThrow(/did not become ready within 90000ms/);
    expect(h.deleteCloudFleetSandbox).toHaveBeenCalledTimes(1);
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('omits an empty readonlyPaths list and rejects env it cannot deliver', async () => {
    const h = harness();
    await spawnFleetSandbox({ ...base, readonlyPaths: [], env: {} }, h.deps);
    expect(h.ensureCloudFleetSandbox.mock.calls[0][0]).not.toHaveProperty('readonlyPaths');

    const rejected = harness();
    await expect(spawnFleetSandbox({ ...base, env: { SECRET: 'x' } }, rejected.deps)).rejects.toBeInstanceOf(
      FleetSandboxSpawnError
    );
    expect(rejected.ensureCloudFleetSandbox).not.toHaveBeenCalled();
  });
});
