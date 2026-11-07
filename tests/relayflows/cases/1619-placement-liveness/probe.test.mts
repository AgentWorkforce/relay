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

function createClient(
  nodes: RawNode[],
  options: { placementSandboxOnly?: boolean; placementTtlMs?: number } = {}
) {
  const invoke = vi.fn(async (name: string, input?: Record<string, unknown>) => ({
    invocation_id: `inv-${invoke.mock.calls.length}`,
    action_name: name,
    handler_node_id: 'node_a',
    dispatched_node_id: 'node_a',
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
      list: vi.fn(async () => nodes),
      get: vi.fn(async (name: string) => nodes.find((node) => node.name === name) ?? null),
    },
  };
  const agentClient = {
    actions: {
      invoke,
      getInvocation: vi.fn(async () => undefined),
      completeInvocation: vi.fn(),
    },
  };
  const client = new RelaycastMessagingClient({
    relaycast: relaycast as never,
    agentClient: agentClient as never,
    placementTtlMs: options.placementTtlMs ?? 30,
    placementSandboxOnly: options.placementSandboxOnly,
  });
  return { client, invoke };
}

const READY_NODE: RawNode = {
  id: 'node_a',
  name: 'node-a',
  status: 'online',
  live: true,
  handlers_live: true,
  capabilities: [{ name: 'spawn:claude', kind: 'spawn' }],
  repo_keys: ['relay'],
};

async function captureError(run: () => Promise<unknown>): Promise<Record<string, unknown> | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return error as Record<string, unknown>;
  }
}

describe('placement liveness and policy proof', () => {
  it('observes the declared base bug or the complete head fix', async () => {
    expect(['base', 'head']).toContain(ARM);

    const stale = createClient([{ ...READY_NODE, name: 'stale-node', status: 'offline' }]);
    const staleError = await captureError(() =>
      stale.client.placement.spawn({ capability: 'spawn:claude', repo: 'relay' })
    );

    const deadHandlers = createClient([{ ...READY_NODE, handlers_live: false }]);
    const handlerError = await captureError(() =>
      deadHandlers.client.placement.spawn({ capability: 'spawn:claude', repo: 'relay' })
    );

    const absent = createClient([], { placementTtlMs: 30 });
    const absentError = await captureError(() =>
      absent.client.placement.spawn({ capability: 'spawn:claude', pollIntervalMs: 25 })
    );

    const sandboxed = createClient([READY_NODE], { placementSandboxOnly: true });
    const sandboxError = await captureError(() =>
      sandboxed.client.placement.spawn({ capability: 'spawn:claude', repo: 'relay' })
    );

    const automatic = createClient([READY_NODE]);
    await automatic.client.placement.spawn({
      capability: 'spawn:claude',
      input: { node: 'caller-target', target_node: 'caller-target' },
    });
    const automaticInput = automatic.invoke.mock.calls[0]?.[1] as Record<string, unknown>;

    if (ARM === 'base') {
      expect(staleError).toBeUndefined();
      expect(stale.invoke).toHaveBeenCalledTimes(1);
      expect(handlerError).toBeUndefined();
      expect(deadHandlers.invoke).toHaveBeenCalledTimes(1);
      expect(absentError).toMatchObject({ code: 'placement_ttl_expired' });
      expect(sandboxError).toBeUndefined();
      expect(sandboxed.invoke).toHaveBeenCalledTimes(1);
      expect(automaticInput).toMatchObject({ node: 'node-a', target_node: 'node-a' });
      return;
    }

    expect(staleError).toMatchObject({ code: 'no_eligible_node', attempts: 1 });
    expect(stale.invoke).not.toHaveBeenCalled();
    expect(handlerError).toMatchObject({ code: 'no_eligible_node', attempts: 1 });
    expect(deadHandlers.invoke).not.toHaveBeenCalled();
    expect(absentError).toMatchObject({ code: 'no_eligible_node', attempts: 1 });
    expect(sandboxError).toMatchObject({ code: 'sandbox_policy_mismatch', attempts: 1 });
    expect(sandboxed.invoke).not.toHaveBeenCalled();
    expect(automatic.invoke).toHaveBeenCalledTimes(1);
    expect(automaticInput).toBeDefined();
    expect(automaticInput).not.toHaveProperty('node');
    expect(automaticInput).not.toHaveProperty('target_node');
  });
});
