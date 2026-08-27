import { describe, expect, it, vi } from 'vitest';

import { RelayPlacementError, RelaycastMessagingClient } from './index.js';

type RawNode = {
  id: string;
  name: string;
  status: string;
  live?: boolean;
  handlers_live?: boolean;
  capabilities: Array<{ name: string; kind?: string }>;
  repo_keys?: string[];
  tags?: string[];
};

function createClient(
  nodes: RawNode[],
  {
    getInvocation: getInvocationOverride,
    ...options
  }: {
    placementLog?: (message: string) => void;
    selfNodeName?: string;
    maxQueuedPlacements?: number;
    placementSandboxOnly?: boolean;
    getInvocation?: (name: string, invocationId: string) => Promise<unknown>;
    listNodes?: (query?: { capability?: string; name?: string }) => Promise<RawNode[]>;
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
      list: vi.fn(async (query?: { capability?: string; name?: string }) => {
        if (options.listNodes) return options.listNodes(query);
        return nodes
          .filter(
            (node) =>
              (!query?.name || node.name === query.name) &&
              (!query?.capability ||
                node.capabilities.some((capability) => capability.name === query.capability))
          )
          .map((node) => ({ handlers_live: true, ...node }));
      }),
      get: vi.fn(async (name: string) => {
        const node = nodes.find((candidate) => candidate.name === name);
        return node ? { handlers_live: true, ...node } : null;
      }),
    },
  };
  const getInvocation = vi.fn(getInvocationOverride ?? (async () => undefined));
  const agentClient = {
    actions: {
      invoke,
      getInvocation,
      completeInvocation: vi.fn(),
    },
  };
  const client = new RelaycastMessagingClient({
    relaycast: relaycast as never,
    agentClient: agentClient as never,
    placementTtlMs: 60,
    ...options,
  });
  return { client, invoke, getInvocation, nodes };
}

const LIVE_NODE_A = {
  id: 'node_a',
  name: 'node-a',
  status: 'online',
  live: true,
  capabilities: [{ name: 'spawn:claude', kind: 'spawn' }],
  repo_keys: ['relay'],
};

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

  it('leaves unconstrained automatic placement atomic in the engine', async () => {
    const { client, invoke } = createClient([LIVE_NODE_A]);

    const ack = await client.placement.spawn({
      capability: 'spawn:claude',
      input: { node: 'caller-target', target_node: 'caller-target' },
    });

    expect(ack.placement.node).toBe('node-a');
    expect(invoke).toHaveBeenCalledWith('spawn', {
      capability: 'spawn:claude',
      ttl_override_ms: 60,
      cli: 'claude',
    });
  });

  it('preserves a successful automatic dispatch when ack node metadata is unavailable', async () => {
    const { client, invoke } = createClient([LIVE_NODE_A]);
    invoke.mockResolvedValueOnce({
      invocation_id: 'inv-without-node',
      action_name: 'spawn',
      status: 'invoked',
    });

    const ack = await client.placement.spawn({ capability: 'spawn:claude' });

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(ack.invocationId).toBe('inv-without-node');
    expect(ack.node).toBeUndefined();
    expect(ack.placement.node).toBeUndefined();
  });

  it('preserves an accepted automatic dispatch when roster refresh and placement logging fail', async () => {
    const placementLog = vi.fn(() => {
      throw new Error('observability sink down');
    });
    let rosterReads = 0;
    const { client, invoke } = createClient([LIVE_NODE_A], {
      placementLog,
      listNodes: async () => {
        rosterReads += 1;
        if (rosterReads > 1) throw new Error('roster refresh down');
        return [{ handlers_live: true, ...LIVE_NODE_A }];
      },
    });

    await expect(client.placement.spawn({ capability: 'spawn:claude' })).resolves.toMatchObject({
      invocationId: 'inv-1',
      placement: { queued: false, attempts: 1 },
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(placementLog).toHaveBeenCalledWith(expect.stringContaining('roster refresh down'));
  });

  it('never selects a roster-offline node even when its live bit is stale', async () => {
    const { client, invoke } = createClient([
      {
        id: 'node_a',
        name: 'stale-node',
        status: 'offline',
        live: true,
        capabilities: [{ name: 'spawn:claude', kind: 'spawn' }],
        repo_keys: ['relay'],
      },
      {
        id: 'node_b',
        name: 'ready-node',
        status: 'online',
        live: true,
        capabilities: [{ name: 'spawn:claude', kind: 'spawn' }],
        repo_keys: ['relay'],
      },
    ]);

    const ack = await client.placement.spawn({ capability: 'spawn:claude', repo: 'relay' });

    expect(ack.placement.node).toBe('ready-node');
    expect(invoke).toHaveBeenCalledWith(
      'spawn',
      expect.objectContaining({ node: 'ready-node', target_node: 'ready-node' })
    );
  });

  it('never selects a node whose action handlers are not live', async () => {
    const { client, invoke } = createClient([
      {
        id: 'node_a',
        name: 'dead-handlers',
        status: 'online',
        live: true,
        handlers_live: false,
        capabilities: [{ name: 'spawn:claude', kind: 'spawn' }],
        repo_keys: ['relay'],
      },
    ]);

    await expect(client.placement.spawn({ capability: 'spawn:claude', repo: 'relay' })).rejects.toMatchObject(
      { name: 'RelayPlacementError', code: 'no_eligible_node', attempts: 1 }
    );
    expect(invoke).not.toHaveBeenCalled();
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
        failFast: false,
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
        onReconcile: (event) => {
          reconciled.push(event);
        },
      })
    ).rejects.toMatchObject({
      name: 'RelayPlacementError',
      code: 'no_eligible_node',
      attempts: 1,
    });

    expect(invoke).not.toHaveBeenCalled();
    expect(reconciled).toEqual([expect.objectContaining({ action: 'failed', reason: 'no_eligible_node' })]);
  });

  it('defaults sandbox policy off so ordinary live nodes remain eligible', async () => {
    const { client, invoke } = createClient([LIVE_NODE_A]);

    await expect(client.placement.spawn({ capability: 'spawn:claude' })).resolves.toMatchObject({
      placement: { node: 'node-a' },
    });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('sandbox-only placement excludes non-sandbox nodes and selects Cloud JIT nodes', async () => {
    const { client, invoke } = createClient(
      [
        LIVE_NODE_A,
        {
          id: 'node_b',
          name: 'daytona-jit',
          status: 'online',
          live: true,
          capabilities: [{ name: 'spawn:claude', kind: 'spawn' }],
          repo_keys: ['relay'],
          tags: ['cloud:node-type:daytona-jit'],
        },
      ],
      { placementSandboxOnly: true }
    );

    const ack = await client.placement.spawn({ capability: 'spawn:claude', repo: 'relay' });

    expect(ack.placement.node).toBe('daytona-jit');
    expect(invoke).toHaveBeenCalledWith(
      'spawn',
      expect.objectContaining({ node: 'daytona-jit', target_node: 'daytona-jit' })
    );
  });

  it('sandbox-only placement fails closed when no live Cloud sandbox is eligible', async () => {
    const { client, invoke } = createClient([LIVE_NODE_A], { placementSandboxOnly: true });

    await expect(client.placement.spawn({ capability: 'spawn:claude' })).rejects.toMatchObject({
      name: 'RelayPlacementError',
      code: 'sandbox_policy_mismatch',
      attempts: 1,
    });
    expect(invoke).not.toHaveBeenCalled();
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
      failFast: false,
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
      failFast: false,
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
      failFast: false,
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
      failFast: false,
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
      failFast: false,
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
      client.placement.spawn({
        capability: 'workflow:run',
        ttlMs: 30,
        pollIntervalMs: 25,
        failFast: false,
      })
    ).rejects.toBeInstanceOf(RelayPlacementError);

    expect(invoke).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain('placement TTL expired');
  });

  // Issue #1430: a node running an obsolete broker advertises `spawn:<harness>`
  // capacity, accepts the invocation, and launches nothing. Placement acceptance
  // is therefore not evidence of a spawn, and the requester cannot assume the
  // node is current enough to report its own failure.
  describe('spawn confirmation (#1430)', () => {
    it('does not confirm by default, so acceptance alone still resolves', async () => {
      const { client, getInvocation } = createClient([LIVE_NODE_A]);

      const ack = await client.placement.spawn({
        capability: 'spawn:claude',
        node: 'node-a',
        repo: 'relay',
        input: { name: 'worker-unconfirmed' },
      });

      // Control arm for the tests below: without `confirm` the invocation is
      // never read back, and the ack says so rather than implying a launch.
      expect(getInvocation).not.toHaveBeenCalled();
      expect(ack.placement.confirmed).toBe(false);
      expect(ack.confirmation).toBeUndefined();
    });

    it('resolves when the node confirms the spawn completed', async () => {
      const { client, getInvocation } = createClient([LIVE_NODE_A], {
        getInvocation: async (name, invocationId) => ({
          invocation_id: invocationId,
          action_name: name,
          status: 'completed',
          output: { spawned: true, name: 'worker-confirmed' },
        }),
      });

      const ack = await client.placement.spawn({
        capability: 'spawn:claude',
        node: 'node-a',
        repo: 'relay',
        confirm: true,
        input: { name: 'worker-confirmed' },
      });

      expect(getInvocation).toHaveBeenCalled();
      expect(ack.placement.confirmed).toBe(true);
      expect(ack.confirmation?.status).toBe('completed');
    });

    // The sf-mini reproduction: capacity advertised, invocation accepted, no
    // process, and no result ever reported. This must fail, not succeed.
    it('fails with spawn_unconfirmed when the node accepts but never reports a result', async () => {
      const { client } = createClient([LIVE_NODE_A], {
        // An obsolete broker leaves the invocation non-terminal forever.
        getInvocation: async (name, invocationId) => ({
          invocation_id: invocationId,
          action_name: name,
          status: 'invoked',
        }),
      });

      const error = await client.placement
        .spawn({
          capability: 'spawn:claude',
          node: 'node-a',
          repo: 'relay',
          confirm: true,
          confirmTimeoutMs: 60,
          confirmPollIntervalMs: 10,
          input: { name: 'worker-silent' },
        })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(RelayPlacementError);
      expect((error as RelayPlacementError).code).toBe('spawn_unconfirmed');
      expect((error as RelayPlacementError).node).toBe('node-a');
      expect((error as Error).message).toContain('never reported a result');
    });

    it('surfaces the node-reported failure detail as spawn_failed', async () => {
      const { client } = createClient([LIVE_NODE_A], {
        getInvocation: async (name, invocationId) => ({
          invocation_id: invocationId,
          action_name: name,
          status: 'failed',
          error:
            "spawn_failed: agent 'worker-dead' process exited during startup (exit status: 19); see worker log /tmp/worker-dead.log",
        }),
      });

      const error = await client.placement
        .spawn({
          capability: 'spawn:claude',
          node: 'node-a',
          repo: 'relay',
          confirm: true,
          confirmTimeoutMs: 1_000,
          confirmPollIntervalMs: 10,
          input: { name: 'worker-dead' },
        })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(RelayPlacementError);
      expect((error as RelayPlacementError).code).toBe('spawn_failed');
      // The broker's detail (exit status + log path) must survive to the caller.
      expect((error as Error).message).toContain('exit status: 19');
      expect((error as Error).message).toContain('/tmp/worker-dead.log');
    });

    it('times out as spawn_unconfirmed when the invocation cannot be read at all', async () => {
      const { client } = createClient([LIVE_NODE_A], {
        getInvocation: async () => {
          throw new Error('getInvocation is not supported by this engine');
        },
      });

      const error = await client.placement
        .spawn({
          capability: 'spawn:claude',
          node: 'node-a',
          repo: 'relay',
          confirm: true,
          confirmTimeoutMs: 60,
          confirmPollIntervalMs: 10,
          input: { name: 'worker-unreadable' },
        })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(RelayPlacementError);
      expect((error as RelayPlacementError).code).toBe('spawn_unconfirmed');
      expect((error as Error).message).toContain('getInvocation is not supported');
    });
  });
});
