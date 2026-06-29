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

function createRelayfileMock(overrides: Partial<RelayfileBridge> = {}) {
  return {
    isConnected: vi.fn(async () => true),
    connect: vi.fn(async () => undefined),
    bind: vi.fn(async () => undefined),
    listBindings: vi.fn(async (): Promise<RelayfileBinding[]> => []),
    unbind: vi.fn(async () => undefined),
    resolveWritebackBinding: vi.fn(async () => ({ url: 'https://ingress.example', secret: 's3cr3t' })),
    ...overrides,
  };
}

type RelayfileBridge = IntegrationCommandDependencies['relayfile'];

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

const ARGS = (extra: string[] = []) => [
  'integration',
  'subscribe',
  'slack',
  '--resource',
  '/slack/channels/C0/**',
  '--to',
  '#general',
  ...extra,
];

describe('integration subscribe', () => {
  it('names the inbound webhook per channel so multiple channels do not collide', async () => {
    const { program, relay, relayfile } = harness();
    await program.parseAsync(ARGS(), { from: 'user' });
    expect(relay.webhooks.createInbound).toHaveBeenCalledWith({
      channel: 'general',
      name: 'relayfile:slack:general',
    });
    expect(relayfile.bind).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'slack', resource: '/slack/channels/C0/**', channel: 'general' })
    );
  });

  it('clears an orphaned webhook left by an earlier partial run before creating', async () => {
    const relay = createRelayMock({
      inboundWebhooks: [
        { webhookId: 'orphan1', url: 'u', token: '', channel: 'general', name: 'relayfile:slack' },
        { webhookId: 'other', url: 'u', token: '', channel: 'ops', name: 'relayfile:slack:ops' },
      ],
    });
    const { program } = harness({ relay });
    await program.parseAsync(ARGS(), { from: 'user' });
    // Legacy-named orphan on this channel is removed; a different channel's webhook is left alone.
    expect(relay.webhooks.delete).toHaveBeenCalledWith('orphan1');
    expect(relay.webhooks.delete).not.toHaveBeenCalledWith('other');
    expect(relay.webhooks.createInbound).toHaveBeenCalled();
  });

  it('replaces an existing binding for the same provider+resource (idempotent re-subscribe)', async () => {
    const relayfile = createRelayfileMock({
      listBindings: vi.fn(async () => [
        {
          provider: 'slack',
          resource: '/slack/channels/C0/**',
          channel: 'general',
          webhookId: 'old_wh',
          subscriptionId: 'old_sub',
        },
      ]),
    });
    const { program, relay } = harness({ relayfile });
    await program.parseAsync(ARGS(), { from: 'user' });
    expect(relay.webhooks.delete).toHaveBeenCalledWith('old_wh');
    expect(relay.webhooks.unsubscribe).toHaveBeenCalledWith('old_sub');
    expect(relayfile.unbind).toHaveBeenCalledWith('slack', '/slack/channels/C0/**');
    // Then a fresh webhook+subscription are created.
    expect(relay.webhooks.createInbound).toHaveBeenCalled();
  });

  it('warns (does not swallow) when rollback after a failed bind cannot delete the webhook', async () => {
    const relay = createRelayMock();
    relay.webhooks.delete.mockRejectedValue(new Error('gone'));
    const relayfile = createRelayfileMock({
      bind: vi.fn(async () => {
        throw new Error('bind failed');
      }),
    });
    const { program, error } = harness({ relay, relayfile });
    await program.parseAsync(ARGS(), { from: 'user' }).catch(() => undefined);
    // The failed cleanup is surfaced, not silently swallowed.
    expect(error.mock.calls.some((c) => String(c[0]).includes('failed to roll back webhook'))).toBe(true);
  });
});
