import type { CoreClient } from '@agent-relay/core-bridge';
import { CoreRpcError } from '@agent-relay/core-bridge';
import { describe, expect, it } from 'vitest';
import { CoreNode } from './core-node.js';

describe('CoreNode preflight against a fake core', () => {
  const node = { id: 'n1', name: 'node-one' };
  const goodTarget = {
    id: 'n1',
    name: 'node-one',
    live: true,
    handlers_live: true,
    stale: false,
    capabilities: ['spawn:claude'],
    active_agents: 0,
    reserved_agents: 0,
    max_agents: 2,
  };
  const goodSettings = {
    accept_spawns: true,
    spawn_full_access_claude: false,
    spawn_requester_approvals: false,
  };

  function fakeCore(settings: object, targets: object[], calls: string[] = []): () => Promise<CoreClient> {
    return async () =>
      ({
        hello: { methods: ['spawn.targets', 'settings.get', 'agents.end'] },
        call: async (method: string) => {
          calls.push(method);
          if (method === 'settings.get') return settings;
          if (method === 'spawn.targets') return { targets };
          return {};
        },
        close: async () => undefined,
      }) as unknown as CoreClient;
  }

  it('passes a correctly configured node', async () => {
    const core = new CoreNode({ connect: fakeCore(goodSettings, [goodTarget]) });
    await expect(core.preflight('claude', node)).resolves.toBeUndefined();
  });

  it.each([
    [
      'full access on',
      { ...goodSettings, spawn_full_access_claude: true },
      [goodTarget],
      'full_access_enabled',
    ],
    ['full access unreported', { accept_spawns: true }, [goodTarget], 'full_access_enabled'],
    ['spawns off', { ...goodSettings, accept_spawns: false }, [goodTarget], 'spawns_not_accepted'],
    [
      'requester approvals on',
      { ...goodSettings, spawn_requester_approvals: true },
      [goodTarget],
      'requester_approvals_enabled',
    ],
    ['unknown node', goodSettings, [{ ...goodTarget, id: 'other' }], 'node_not_found'],
    ['offline', goodSettings, [{ ...goodTarget, live: false }], 'node_not_live'],
    ['stale', goodSettings, [{ ...goodTarget, stale: true }], 'node_not_live'],
    ['no harness', goodSettings, [{ ...goodTarget, capabilities: ['spawn:codex'] }], 'harness_not_available'],
    [
      'requester approvals unreported',
      { accept_spawns: true, spawn_full_access_claude: false },
      [goodTarget],
      'requester_approvals_enabled',
    ],
    ['full', goodSettings, [{ ...goodTarget, active_agents: 1, reserved_agents: 1 }], 'node_at_capacity'],
  ])('refuses: %s', async (_label, settings, targets, code) => {
    const core = new CoreNode({ connect: fakeCore(settings, targets as object[]) });
    await expect(core.preflight('claude', node)).resolves.toBe(code);
  });

  it('treats max_agents 0 as no limit', async () => {
    const core = new CoreNode({
      connect: fakeCore(goodSettings, [{ ...goodTarget, max_agents: 0, active_agents: 9 }]),
    });
    await expect(core.preflight('claude', node)).resolves.toBeUndefined();
  });

  it('fails closed when the core cannot be reached', async () => {
    const core = new CoreNode({
      connect: async () => {
        throw new Error('nope');
      },
    });
    await expect(core.preflight('claude', node)).resolves.toBe('core_unavailable');
  });

  const failing = (kind: string) => async () =>
    ({
      call: async () => {
        throw new CoreRpcError('x', { kind: kind as never });
      },
      close: async () => undefined,
    }) as unknown as CoreClient;

  it('maps agents.end outcomes', async () => {
    await expect(new CoreNode({ connect: fakeCore(goodSettings, []) }).endAgent('x')).resolves.toBe('ended');
    await expect(new CoreNode({ connect: failing('not_found') }).endAgent('x')).resolves.toBe('not_found');
    await expect(new CoreNode({ connect: failing('refused') }).endAgent('x')).resolves.toBe('refused');
    await expect(new CoreNode({ connect: failing('internal') }).endAgent('x')).rejects.toBeInstanceOf(Error);
  });
});
