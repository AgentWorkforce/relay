import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import {
  registerIntegrationCommands,
  type IntegrationCommandDependencies,
  type RelayfileBinding,
} from './integration.js';

interface InboundWebhook {
  webhookId: string;
  url: string;
  token: string;
  channel: string;
  name?: string;
}

function createRelayMock(opts: { inboundWebhooks?: InboundWebhook[] } = {}) {
  let counter = 0;
  return {
    agents: {
      register: vi.fn(async (i: { name: string }) => ({ id: 'a1', token: 't1', name: i.name })),
      list: vi.fn(async () => [{ id: 'a1', name: 'lead' }]),
    },
    integrations: {
      subscriptions: {
        create: vi.fn(async (i: unknown) => ({ id: `sub_${++counter}`, ...(i as object) })),
        delete: vi.fn(async () => undefined),
      },
    },
    webhooks: {
      createInbound: vi.fn(async (i: { channel: string; name?: string }) => ({
        webhookId: `in_${++counter}`,
        url: 'https://relay.example/webhooks/in',
        token: 'tok_once',
        channel: i.channel,
        name: i.name,
      })),
      list: vi.fn(async () => opts.inboundWebhooks ?? []),
      delete: vi.fn(async () => undefined),
      unsubscribe: vi.fn(async () => undefined),
      subscriptions: vi.fn(async () => []),
    },
  };
}

type RelayfileBridge = IntegrationCommandDependencies['relayfile'];

// Stateful mock: `bind` upserts on (provider, resource) and `listBindings`
// reflects it, so a post-bind read sees the new webhook as active — mirroring
// relayfile's real upsert semantics.
function createRelayfileMock(
  initialBindings: RelayfileBinding[] = [],
  overrides: Partial<RelayfileBridge> = {}
) {
  const bindings: RelayfileBinding[] = initialBindings.map((b) => ({ ...b }));
  return {
    isConnected: vi.fn(async () => true),
    connect: vi.fn(async () => undefined),
    bind: vi.fn(
      async (input: {
        provider: string;
        resource: string;
        channel: string;
        webhookId: string;
        subscriptionId: string;
      }) => {
        const record: RelayfileBinding = {
          provider: input.provider,
          resource: input.resource,
          channel: input.channel,
          webhookId: input.webhookId,
          subscriptionId: input.subscriptionId,
        };
        const idx = bindings.findIndex((b) => b.provider === input.provider && b.resource === input.resource);
        if (idx >= 0) bindings[idx] = record;
        else bindings.push(record);
      }
    ),
    listBindings: vi.fn(async (): Promise<RelayfileBinding[]> => bindings.map((b) => ({ ...b }))),
    unbind: vi.fn(async () => undefined),
    resolveWritebackBinding: vi.fn(async () => ({ url: 'https://ingress.example', secret: 's3cr3t' })),
    ...overrides,
  };
}

function harness(
  opts: {
    relay?: ReturnType<typeof createRelayMock>;
    relayfile?: ReturnType<typeof createRelayfileMock>;
  } = {}
) {
  const relay = opts.relay ?? createRelayMock();
  const relayfile = opts.relayfile ?? createRelayfileMock();
  const log = vi.fn();
  const error = vi.fn();
  const exit = vi.fn();
  const program = new Command();
  program.exitOverride();
  registerIntegrationCommands(program, {
    createAgentRelay: () => relay as never,
    relayfile: relayfile as never,
    resolveLocalRelayOptions: async () => undefined,
    isInteractive: () => false,
    log,
    error,
    exit: exit as never,
  } satisfies Partial<IntegrationCommandDependencies>);
  return { program, relay, relayfile, log, error };
}

const RESOURCE = '/slack/channels/C0/**';
const ARGS = (extra: string[] = []) => [
  'integration',
  'subscribe',
  'slack',
  '--resource',
  RESOURCE,
  '--to',
  '#general',
  ...extra,
];

// relayfile:<provider>:<slug>-<hash10>:<nonce10>
const NAME_RE = /^relayfile:slack:.+-[0-9a-f]{10}:[0-9a-f]{10}$/;

describe('integration subscribe', () => {
  it('names the inbound webhook per (provider, resource), unique per attempt', async () => {
    const { program, relay, relayfile } = harness();
    await program.parseAsync(ARGS(), { from: 'user' });
    expect(relay.webhooks.createInbound).toHaveBeenCalledWith({
      channel: 'general',
      name: expect.stringMatching(NAME_RE),
    });
    expect(relayfile.bind).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'slack', resource: RESOURCE, channel: 'general' })
    );
  });

  it('retires an orphaned, unbound legacy webhook after the new binding is live', async () => {
    const relay = createRelayMock({
      inboundWebhooks: [
        { webhookId: 'orphan1', url: 'u', token: '', channel: 'general', name: 'relayfile:slack' },
        {
          webhookId: 'otherchan',
          url: 'u',
          token: '',
          channel: 'ops',
          name: 'relayfile:slack:ops-aaaaaaaaaa:bbbbbbbbbb',
        },
      ],
    });
    // No active binding references either webhook → legacy one is safe to retire.
    const { program } = harness({ relay });
    await program.parseAsync(ARGS(), { from: 'user' });
    expect(relay.webhooks.createInbound).toHaveBeenCalled();
    expect(relay.webhooks.delete).toHaveBeenCalledWith('orphan1');
    // A different resource's webhook (different name prefix) is never touched.
    expect(relay.webhooks.delete).not.toHaveBeenCalledWith('otherchan');
  });

  it('replaces an existing binding create-first, retiring the prior webhook + subscription after', async () => {
    const prior: RelayfileBinding = {
      provider: 'slack',
      resource: RESOURCE,
      channel: 'general',
      webhookId: 'old_wh',
      subscriptionId: 'old_sub',
    };
    const relay = createRelayMock({
      inboundWebhooks: [
        {
          webhookId: 'old_wh',
          url: 'u',
          token: '',
          channel: 'general',
          name: 'relayfile:slack:slack-channels-c0-0123456789:cccccccccc',
        },
      ],
    });
    const relayfile = createRelayfileMock([prior]);
    const { program } = harness({ relay, relayfile });
    await program.parseAsync(ARGS(), { from: 'user' });

    // New webhook is created before the old one is removed.
    const createOrder = relay.webhooks.createInbound.mock.invocationCallOrder[0]!;
    const deleteOrder = relay.webhooks.delete.mock.invocationCallOrder[0]!;
    expect(createOrder).toBeLessThan(deleteOrder);

    expect(relay.webhooks.delete).toHaveBeenCalledWith('old_wh');
    expect(relay.webhooks.unsubscribe).toHaveBeenCalledWith('old_sub');
  });

  it('does NOT delete another resource’s webhook routed to the same channel (P2)', async () => {
    // Resource B already bound to the same #general channel, with its own webhook.
    const otherBinding: RelayfileBinding = {
      provider: 'slack',
      resource: '/slack/channels/C9/**',
      channel: 'general',
      webhookId: 'wh_B',
      subscriptionId: 'sub_B',
    };
    const relay = createRelayMock({
      inboundWebhooks: [
        {
          webhookId: 'wh_B',
          url: 'u',
          token: '',
          channel: 'general',
          name: 'relayfile:slack:slack-channels-c9-9999999999:dddddddddd',
        },
      ],
    });
    const relayfile = createRelayfileMock([otherBinding]);
    const { program } = harness({ relay, relayfile });
    // Subscribe resource A (RESOURCE) to the same channel.
    await program.parseAsync(ARGS(), { from: 'user' });
    expect(relay.webhooks.createInbound).toHaveBeenCalled();
    // Resource B's webhook must survive — it backs an active, unrelated binding.
    expect(relay.webhooks.delete).not.toHaveBeenCalledWith('wh_B');
  });

  it('does NOT tear down the prior working binding when creation fails (P1)', async () => {
    const prior: RelayfileBinding = {
      provider: 'slack',
      resource: RESOURCE,
      channel: 'general',
      webhookId: 'old_wh',
      subscriptionId: 'old_sub',
    };
    const relay = createRelayMock();
    relay.webhooks.createInbound.mockRejectedValue(new Error('transient'));
    const relayfile = createRelayfileMock([prior]);
    const { program } = harness({ relay, relayfile });
    await program.parseAsync(ARGS(), { from: 'user' }).catch(() => undefined);
    // The prior webhook/subscription/bind are left intact.
    expect(relay.webhooks.delete).not.toHaveBeenCalledWith('old_wh');
    expect(relay.webhooks.unsubscribe).not.toHaveBeenCalledWith('old_sub');
    expect(relayfile.unbind).not.toHaveBeenCalled();
  });

  it('never deletes a webhook an active binding still references, even at its own prefix', async () => {
    // Represents a concurrent re-subscribe that already owns this resource's
    // binding and points at a newer same-prefix webhook.
    const active: RelayfileBinding = {
      provider: 'slack',
      resource: RESOURCE,
      channel: 'general',
      webhookId: 'wh_active',
      subscriptionId: 'sub_active',
    };
    const relay = createRelayMock({
      inboundWebhooks: [
        {
          webhookId: 'wh_active',
          url: 'u',
          token: '',
          channel: 'general',
          name: 'relayfile:slack:slack-channels-c0-0123456789:ffffffffff',
        },
      ],
    });
    // bind is a no-op so the active binding stays pointing at wh_active at sweep time.
    const relayfile = createRelayfileMock([active], { bind: vi.fn(async () => undefined) });
    const { program } = harness({ relay, relayfile });
    await program.parseAsync(ARGS(), { from: 'user' });
    expect(relay.webhooks.delete).not.toHaveBeenCalledWith('wh_active');
  });

  it('aborts without creating anything when the binding store cannot be read (fail fast)', async () => {
    const relay = createRelayMock();
    const relayfile = createRelayfileMock([], {
      listBindings: vi.fn(async () => {
        throw new Error('relayfile unavailable');
      }),
    });
    const { program } = harness({ relay, relayfile });
    await program.parseAsync(ARGS(), { from: 'user' }).catch(() => undefined);
    expect(relay.webhooks.createInbound).not.toHaveBeenCalled();
  });

  it('warns (does not swallow) when post-failure rollback cannot delete the new webhook', async () => {
    const relay = createRelayMock();
    relay.webhooks.delete.mockRejectedValue(new Error('gone'));
    const relayfile = createRelayfileMock([], {
      bind: vi.fn(async () => {
        throw new Error('bind failed');
      }),
    });
    const { program, error } = harness({ relay, relayfile });
    await program.parseAsync(ARGS(), { from: 'user' }).catch(() => undefined);
    expect(error.mock.calls.some((c) => String(c[0]).includes('failed to clean up webhook'))).toBe(true);
  });
});
