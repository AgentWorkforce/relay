import { describe, expect, it, vi } from 'vitest';

import { RelayPlacementError, RelaycastMessagingClient } from './index.js';

type RawNode = {
  id: string;
  name: string;
  status: string;
  live?: boolean;
  capabilities: Array<{ name: string; kind?: string }>;
  repo_keys?: string[];
};

function createClient(
  nodes: RawNode[],
  options: {
    placementLog?: (message: string) => void;
    selfNodeName?: string;
    maxQueuedPlacements?: number;
  } = {}
) {
  const invoke = vi.fn(async (name: string, input?: Record<string, unknown>) => ({
    invocation_id: `inv-${invoke.mock.calls.length}`,
    action_name: name,
    handler_node_id: input?.target_node === 'node-b' ? 'node_b' : 'node_a',
    dispatched_node_id: input?.target_node === 'node-b' ? 'node_b' : 'node_a',
    input,
    status: 'invoked',
  }));
  const relaycast = {
    agents: {
      list: vi.fn(async () => []),
      get: vi.fn(),
      register: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      presence: vi.fn(async () => []),
    },
    channels: { list: vi.fn(async () => []), get: vi.fn() },
    messages: { list: vi.fn(async () => []), get: vi.fn(), thread: vi.fn(), reactions: vi.fn() },
    nodes: {
      list: vi.fn(async (query?: { capability?: string; name?: string }) =>
        nodes.filter(
          (node) =>
            (!query?.name || node.name === query.name) &&
            (!query?.capability ||
              node.capabilities.some((capability) => capability.name === query.capability))
        )
      ),
      get: vi.fn(async (name: string) => nodes.find((node) => node.name === name) ?? null),
    },
  };
  const agentClient = {
    actions: {
      invoke,
      getInvocation: vi.fn(),
      completeInvocation: vi.fn(),
    },
  };
  const client = new RelaycastMessagingClient({
    relaycast: relaycast as never,
    agentClient: agentClient as never,
    placementTtlMs: 60,
    ...options,
  });
  return { client, invoke, nodes };
}

describe('RelaycastMessagingClient placement', () => {
  it('places a targeted spawn on the named live eligible node', async () => {
    const { client, invoke } = createClient([
      {
        id: 'node_a',
        name: 'node-a',
        status: 'online',
        live: true,
        capabilities: [{ name: 'spawn:claude', kind: 'spawn' }],
        repo_keys: ['relay'],
      },
    ]);

    const ack = await client.placement.spawn({
      capability: 'spawn:claude',
      node: 'node-a',
      repo: 'relay',
      input: { name: 'worker-1', task: 'ship' },
    });

    expect(ack.placement).toMatchObject({
      capability: 'spawn:claude',
      node: 'node-a',
      repo: 'relay',
      attempts: 1,
      queued: false,
    });
    expect(ack.handlerNodeId).toBe('node_a');
    expect(invoke).toHaveBeenCalledWith('spawn', {
      name: 'worker-1',
      task: 'ship',
      capability: 'spawn:claude',
      node: 'node-a',
      target_node: 'node-a',
      repo: 'relay',
      ttl_override_ms: 60,
      cli: 'claude',
    });
  });

  it('rejects a spawn whose input cli does not match the spawn: capability', async () => {
    const { client, invoke } = createClient([
      {
        id: 'node_a',
        name: 'node-a',
        status: 'online',
        live: true,
        capabilities: [{ name: 'spawn:claude', kind: 'spawn' }],
        repo_keys: ['relay'],
      },
    ]);

    await expect(
      client.placement.spawn({
        capability: 'spawn:claude',
        node: 'node-a',
        repo: 'relay',
        input: { name: 'worker-mismatch', cli: 'codex' },
      })
    ).rejects.toMatchObject({
      name: 'RelayPlacementError',
      code: 'capability_mismatch',
      capability: 'spawn:claude',
    });
    // The broker is never invoked with the wrong harness.
    expect(invoke).not.toHaveBeenCalled();
  });

  it('overwrites cli from the spawn: capability when the input cli already matches', async () => {
    const { client, invoke } = createClient([
      {
        id: 'node_a',
        name: 'node-a',
        status: 'online',
        live: true,
        capabilities: [{ name: 'spawn:claude', kind: 'spawn' }],
        repo_keys: ['relay'],
      },
    ]);

    await client.placement.spawn({
      capability: 'spawn:claude',
      node: 'node-a',
      repo: 'relay',
      input: { name: 'worker-match', cli: 'claude' },
    });

    expect(invoke).toHaveBeenCalledWith('spawn', expect.objectContaining({ cli: 'claude' }));
  });

  it('hard-fails a named node that does not advertise the requested capability', async () => {
    const { client, invoke } = createClient([
      {
        id: 'node_b',
        name: 'node-b',
        status: 'online',
        live: true,
        capabilities: [{ name: 'spawn:codex', kind: 'spawn' }],
        repo_keys: ['relay'],
      },
    ]);

    await expect(
      client.placement.spawn({ capability: 'spawn:claude', node: 'node-b', repo: 'relay' })
    ).rejects.toMatchObject({
      name: 'RelayPlacementError',
      code: 'capability_mismatch',
      capability: 'spawn:claude',
      node: 'node-b',
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('resolves node self through the client self node name', async () => {
    const { client, invoke } = createClient(
      [
        {
          id: 'node_self',
          name: 'laptop',
          status: 'online',
          live: true,
          capabilities: [{ name: 'workflow:run', kind: 'action' }],
          repo_keys: ['relay'],
        },
      ],
      { selfNodeName: 'laptop' }
    );

    const ack = await client.placement.spawn({
      capability: 'workflow:run',
      node: 'self',
      repo: 'relay',
      input: { workflow: 'factory.yml' },
    });

    expect(ack.placement.node).toBe('laptop');
    expect(invoke).toHaveBeenCalledWith(
      'workflow:run',
      expect.objectContaining({ workflow: 'factory.yml', node: 'laptop', target_node: 'laptop' })
    );
  });

  it('places exactly once when two nodes are simultaneously eligible (no bleed)', async () => {
    const { client, invoke } = createClient([
      {
        id: 'node_a',
        name: 'node-a',
        status: 'online',
        live: true,
        capabilities: [{ name: 'spawn:claude', kind: 'spawn' }],
        repo_keys: ['relay'],
      },
      {
        id: 'node_b',
        name: 'node-b',
        status: 'online',
        live: true,
        capabilities: [{ name: 'spawn:claude', kind: 'spawn' }],
        repo_keys: ['relay'],
      },
    ]);

    const ack = await client.placement.spawn({
      capability: 'spawn:claude',
      repo: 'relay',
      input: { name: 'worker-2nodes' },
    });

    // A single placement is dispatched — no cross-node double-dispatch.
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(['node-a', 'node-b']).toContain(ack.placement.node);
    expect(ack.placement).toMatchObject({ queued: false, attempts: 1 });
  });

  it('rejects with placement_queue_full and reconciles a failed event when the queue is full', async () => {
    const reconciled: unknown[] = [];
    const logs: string[] = [];
    const { client, invoke } = createClient([], {
      maxQueuedPlacements: 0,
      placementLog: (line) => logs.push(line),
    });

    await expect(
      client.placement.spawn({
        capability: 'spawn:claude',
        repo: 'relay',
        input: { name: 'worker-overflow' },
        ttlMs: 1_000,
        pollIntervalMs: 25,
        onReconcile: (event) => {
          reconciled.push(event);
        },
      })
    ).rejects.toMatchObject({
      name: 'RelayPlacementError',
      code: 'placement_queue_full',
      attempts: 1,
    });

    expect(invoke).not.toHaveBeenCalled();
    expect(reconciled).toContainEqual(
      expect.objectContaining({ action: 'failed', reason: 'no_eligible_node' })
    );
    expect(logs.join('\n')).toContain('placement queue full');
  });

  it('fails fast with no eligible node after a single attempt and reconciles failed', async () => {
    const reconciled: unknown[] = [];
    const { client, invoke } = createClient([]);

    await expect(
      client.placement.spawn({
        capability: 'workflow:run',
        failFast: true,
        onReconcile: (event) => {
          reconciled.push(event);
        },
      })
    ).rejects.toMatchObject({
      name: 'RelayPlacementError',
      code: 'placement_ttl_expired',
      attempts: 1,
    });

    expect(invoke).not.toHaveBeenCalled();
    expect(reconciled).toEqual([expect.objectContaining({ action: 'failed', reason: 'no_eligible_node' })]);
  });

  it('fails fast with code unmapped_repo when a live capable node never maps the repo', async () => {
    const reconciled: unknown[] = [];
    const { client, invoke } = createClient([
      {
        id: 'node_a',
        name: 'node-a',
        status: 'online',
        live: true,
        capabilities: [{ name: 'spawn:claude', kind: 'spawn' }],
        repo_keys: ['cloud'],
      },
    ]);

    await expect(
      client.placement.spawn({
        capability: 'spawn:claude',
        repo: 'relay',
        failFast: true,
        onReconcile: (event) => {
          reconciled.push(event);
        },
      })
    ).rejects.toMatchObject({
      name: 'RelayPlacementError',
      code: 'unmapped_repo',
      capability: 'spawn:claude',
      repo: 'relay',
    });

    expect(invoke).not.toHaveBeenCalled();
    expect(reconciled).toEqual([
      expect.objectContaining({ action: 'failed', reason: 'unmapped_repo', repo: 'relay' }),
    ]);
  });

  it('isolates a throwing onReconcile hook so placement still drains', async () => {
    const { client, invoke, nodes } = createClient([
      {
        id: 'node_a',
        name: 'node-a',
        status: 'offline',
        live: false,
        capabilities: [{ name: 'spawn:claude', kind: 'spawn' }],
        repo_keys: ['relay'],
      },
    ]);

    const placement = client.placement.spawn({
      capability: 'spawn:claude',
      node: 'node-a',
      repo: 'relay',
      input: { name: 'worker-throwing-hook' },
      pollIntervalMs: 25,
      onReconcile: () => {
        throw new Error('observability sink down');
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 35));
    nodes[0] = { ...nodes[0], status: 'online', live: true };

    const ack = await placement;
    expect(ack.placement).toMatchObject({ node: 'node-a', queued: true });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('queues a targeted offline node with reason target_offline and drains once it is live', async () => {
    const reconciled: unknown[] = [];
    const { client, invoke, nodes } = createClient([
      {
        id: 'node_a',
        name: 'node-a',
        status: 'offline',
        live: false,
        capabilities: [{ name: 'spawn:claude', kind: 'spawn' }],
        repo_keys: ['relay'],
      },
    ]);

    const placement = client.placement.spawn({
      capability: 'spawn:claude',
      node: 'node-a',
      repo: 'relay',
      input: { name: 'worker-offline' },
      pollIntervalMs: 25,
      onReconcile: (event) => {
        reconciled.push(event);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 35));
    nodes[0] = { ...nodes[0], status: 'online', live: true };

    const ack = await placement;

    expect(ack.placement).toMatchObject({ node: 'node-a', queued: true });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(reconciled).toContainEqual(
      expect.objectContaining({ action: 'queued', reason: 'target_offline', node: 'node-a' })
    );
  });

  it('queues a targeted node that does not map the repo and drains once the repo map updates', async () => {
    const reconciled: unknown[] = [];
    const logs: string[] = [];
    const { client, invoke, nodes } = createClient(
      [
        {
          id: 'node_a',
          name: 'node-a',
          status: 'online',
          live: true,
          capabilities: [{ name: 'spawn:claude', kind: 'spawn' }],
          repo_keys: ['cloud'],
        },
      ],
      { placementLog: (line) => logs.push(line) }
    );

    const placement = client.placement.spawn({
      capability: 'spawn:claude',
      node: 'node-a',
      repo: 'relay',
      input: { name: 'worker-targeted-unmapped' },
      pollIntervalMs: 25,
      onReconcile: (event) => {
        reconciled.push(event);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 35));
    nodes[0] = { ...nodes[0], repo_keys: ['cloud', 'relay'] };

    const ack = await placement;

    expect(ack.placement).toMatchObject({ node: 'node-a', repo: 'relay', queued: true });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(reconciled).toContainEqual(
      expect.objectContaining({ action: 'queued', reason: 'unmapped_repo', node: 'node-a' })
    );
    expect(logs.join('\n')).toContain('does not map repo "relay"');
  });

  it('reconciles an unmapped repo by queueing until a mapped eligible node appears', async () => {
    const logs: string[] = [];
    const reconciled: unknown[] = [];
    const { client, invoke, nodes } = createClient(
      [
        {
          id: 'node_a',
          name: 'node-a',
          status: 'online',
          live: true,
          capabilities: [{ name: 'spawn:claude', kind: 'spawn' }],
          repo_keys: ['cloud'],
        },
      ],
      { placementLog: (line) => logs.push(line) }
    );

    const placement = client.placement.spawn({
      capability: 'spawn:claude',
      repo: 'relay',
      input: { name: 'worker-2' },
      pollIntervalMs: 25,
      onReconcile: (event) => {
        reconciled.push(event);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 35));
    nodes.push({
      id: 'node_b',
      name: 'node-b',
      status: 'online',
      live: true,
      capabilities: [{ name: 'spawn:claude', kind: 'spawn' }],
      repo_keys: ['relay'],
    });

    const ack = await placement;

    expect(ack.placement).toMatchObject({ node: 'node-b', repo: 'relay', queued: true });
    expect(invoke).toHaveBeenCalledWith(
      'spawn',
      expect.objectContaining({ target_node: 'node-b', repo: 'relay', cli: 'claude' })
    );
    expect(logs.join('\n')).toContain('maps repo "relay"');
    expect(reconciled).toContainEqual(
      expect.objectContaining({ action: 'queued', reason: 'unmapped_repo', repo: 'relay' })
    );
  });

  it('queues when no eligible node is live and drains before TTL', async () => {
    const { client, nodes } = createClient([
      {
        id: 'node_a',
        name: 'node-a',
        status: 'offline',
        live: false,
        capabilities: [{ name: 'spawn:codex', kind: 'spawn' }],
        repo_keys: ['relay'],
      },
    ]);

    const placement = client.placement.spawn({
      capability: 'spawn:codex',
      repo: 'relay',
      input: { name: 'worker-3' },
      pollIntervalMs: 25,
    });
    await new Promise((resolve) => setTimeout(resolve, 35));
    nodes[0] = { ...nodes[0], status: 'online', live: true };

    await expect(placement).resolves.toMatchObject({
      placement: { node: 'node-a', queued: true },
    });
  });

  it('fails after placement TTL instead of silently dropping the spawn', async () => {
    const logs: string[] = [];
    const { client, invoke } = createClient([], { placementLog: (line) => logs.push(line) });

    await expect(
      client.placement.spawn({ capability: 'workflow:run', ttlMs: 30, pollIntervalMs: 25 })
    ).rejects.toBeInstanceOf(RelayPlacementError);

    expect(invoke).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain('placement TTL expired');
  });
});
