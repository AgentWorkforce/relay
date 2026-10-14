import { describe, expect, it, vi } from 'vitest';

// The runner copies this probe to <target>/.relay-pr-proof before execution.
import { RelaycastMessagingClient } from '../packages/sdk/src/messaging/index.js';

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

const ARM = process.env.RELAY_PR_PROOF_ARM;

function createClient(nodes: RawNode[], options: { getInvocation?: () => Promise<unknown> } = {}) {
  const invoke = vi.fn(async (name: string, input?: Record<string, unknown>) => ({
    invocation_id: 'inv-1',
    action_name: name,
    handler_node_id: 'node_sf_frame',
    dispatched_node_id: 'node_sf_frame',
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
        nodes
          .filter(
            (node) =>
              (!query?.name || node.name === query.name) &&
              (!query?.capability ||
                node.capabilities.some((capability) => capability.name === query.capability))
          )
          .map((node) => ({ handlers_live: true, ...node }))
      ),
      get: vi.fn(async (name: string) => {
        const node = nodes.find((candidate) => candidate.name === name);
        return node ? { handlers_live: true, ...node } : null;
      }),
    },
  };
  const getInvocation = vi.fn(options.getInvocation ?? (async () => undefined));
  const agentClient = { actions: { invoke, getInvocation, completeInvocation: vi.fn() } };
  const client = new RelaycastMessagingClient({
    relaycast: relaycast as never,
    agentClient: agentClient as never,
    placementTtlMs: 60,
  });
  return { client, invoke, getInvocation };
}

// sf-frame serves Grok through a provider-owned `spawn:grok` action: the
// capability the roster advertises is an invokable action, not native broker
// capacity the engine's generic `spawn` dispatcher can place on.
const SERVED_GROK_NODE: RawNode = {
  id: 'node_sf_frame',
  name: 'sf-frame',
  status: 'online',
  live: true,
  capabilities: [{ name: 'spawn:grok', kind: 'action' }],
};

// The same harness advertised as native capacity, which must keep routing
// through the engine's atomic `spawn` dispatcher.
const NATIVE_GROK_NODE: RawNode = {
  ...SERVED_GROK_NODE,
  capabilities: [{ name: 'spawn:grok', kind: 'spawn' }],
};

describe('targeted served spawn dispatch proof', () => {
  it('observes the declared base bug or the complete head fix', async () => {
    expect(['base', 'head']).toContain(ARM);

    const served = createClient([SERVED_GROK_NODE], {
      getInvocation: async () => ({
        invocation_id: 'inv-1',
        status: 'completed',
        output: { spawned: true, ready: true },
      }),
    });
    const servedAck = await served.client.placement.spawn({
      capability: 'spawn:grok',
      node: 'sf-frame',
      confirm: true,
      input: { name: 'worker-grok', cli: 'grok', task: 'ship' },
    });

    const native = createClient([NATIVE_GROK_NODE]);
    await native.client.placement.spawn({
      capability: 'spawn:grok',
      node: 'sf-frame',
      input: { name: 'worker-grok' },
    });

    const automatic = createClient([SERVED_GROK_NODE]);
    await automatic.client.placement.spawn({ capability: 'spawn:grok', input: { name: 'worker-grok' } });

    // Routing that must hold in both arms: native capacity and automatic
    // placement stay on the engine's generic spawn dispatcher.
    expect(native.invoke).toHaveBeenCalledTimes(1);
    expect(native.invoke.mock.calls[0]?.[0]).toBe('spawn');
    expect(automatic.invoke).toHaveBeenCalledTimes(1);
    expect(automatic.invoke.mock.calls[0]?.[0]).toBe('spawn');
    expect(automatic.invoke.mock.calls[0]?.[1]).not.toHaveProperty('target_node');

    if (ARM === 'base') {
      // The served action is rewritten to generic `spawn`, so the request never
      // reaches the provider that owns the advertised `spawn:grok` capability.
      expect(served.invoke).toHaveBeenCalledTimes(1);
      expect(served.invoke.mock.calls[0]?.[0]).toBe('spawn');
      expect(served.getInvocation.mock.calls[0]?.[0]).toBe('spawn');
      return;
    }

    expect(served.invoke).toHaveBeenCalledTimes(1);
    expect(served.invoke.mock.calls[0]?.[0]).toBe('spawn:grok');
    expect(served.invoke.mock.calls[0]?.[1]).toMatchObject({
      name: 'worker-grok',
      cli: 'grok',
      task: 'ship',
      capability: 'spawn:grok',
      node: 'sf-frame',
      target_node: 'sf-frame',
      verify_ready: true,
    });
    // Confirmation polls the same action the dispatch used, so readiness proof
    // comes from the invocation that actually launched the worker.
    expect(served.getInvocation.mock.calls[0]?.[0]).toBe('spawn:grok');
    expect(servedAck.placement).toMatchObject({ state: 'ready', confirmed: true, node: 'sf-frame' });
  });
});
