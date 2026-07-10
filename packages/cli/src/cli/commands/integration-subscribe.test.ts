import { Command } from 'commander';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RelayfileControlPlaneError } from '@relayfile/client';

import {
  registerIntegrationCommands,
  type IntegrationCommandDependencies,
  type RelayfileBinding,
} from './integration.js';
import type { PendingCleanupEntry } from './integration-cleanup-journal.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

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
        webhookSubscriptionId: string;
      }) => {
        const record: RelayfileBinding = {
          provider: input.provider,
          resource: input.resource,
          channel: input.channel,
          webhookId: input.webhookId,
          subscriptionId: input.subscriptionId,
          webhookSubscriptionId: input.webhookSubscriptionId,
        };
        const idx = bindings.findIndex((b) => b.provider === input.provider && b.resource === input.resource);
        if (idx >= 0) bindings[idx] = record;
        else bindings.push(record);
      }
    ),
    listBindings: vi.fn(async (): Promise<RelayfileBinding[]> => bindings.map((b) => ({ ...b }))),
    unbind: vi.fn(async () => undefined),
    // Identity resolve: tests pass an already-resolved glob as --resource, mirroring
    // relayfile's idempotent resolve-path (a glob resolves to itself).
    resolveResourcePath: vi.fn(async (_provider: string, resource: string) => ({ pathGlob: resource })),
    ensureCompatible: vi.fn(async () => undefined),
    resolveWritebackBinding: vi.fn(async () => ({ url: 'https://ingress.example', secret: 's3cr3t' })),
    createWebhookSubscription: vi.fn(async () => ({ subscriptionId: 'whsub_1' })),
    deleteWebhookSubscription: vi.fn(async () => undefined),
    ...overrides,
  };
}

// In-memory CleanupJournal: tests must never touch the default file-backed
// journal under the project data dir.
function memoryJournal(initial: PendingCleanupEntry[] = []) {
  let entries = [...initial];
  return {
    entries: () => [...entries],
    list: vi.fn(async () => [...entries]),
    update: vi.fn(async (mutate: (e: PendingCleanupEntry[]) => PendingCleanupEntry[]) => {
      entries = mutate([...entries]);
    }),
  };
}

const INBOUND_URL = 'https://cast.test/v1/integrations/relayfile/inbound/ws/ch';
const RELAYFILE_SCOPE = 'relayfile:project-daemon';

function intentEntry(overrides: Partial<PendingCleanupEntry> = {}): PendingCleanupEntry {
  return {
    kind: 'relayfile-webhook-subscription-intent',
    scope: RELAYFILE_SCOPE,
    provider: 'slack',
    resource: RESOURCE,
    url: INBOUND_URL,
    pathGlobs: [RESOURCE],
    ...overrides,
  };
}

function harness(
  opts: {
    relay?: ReturnType<typeof createRelayMock>;
    relayfile?: ReturnType<typeof createRelayfileMock>;
    journal?: ReturnType<typeof memoryJournal>;
    resolveLocalRelayOptions?: IntegrationCommandDependencies['resolveLocalRelayOptions'];
  } = {}
) {
  const relay = opts.relay ?? createRelayMock();
  const relayfile = opts.relayfile ?? createRelayfileMock();
  const journal = opts.journal ?? memoryJournal();
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            data: {
              url: 'https://cast.test/v1/integrations/relayfile/inbound/ws/ch',
              secret: 'inbound-secret',
            },
          }),
          {
            status: 201,
            headers: { 'content-type': 'application/json' },
          }
        )
    )
  );
  const log = vi.fn();
  const error = vi.fn();
  const exit = vi.fn();
  const program = new Command();
  program.exitOverride();
  registerIntegrationCommands(program, {
    createAgentRelay: () => relay as never,
    relayfile: relayfile as never,
    cleanupJournal: journal,
    resolveLocalRelayOptions:
      opts.resolveLocalRelayOptions ?? (async () => ({ workspaceKey: 'rk_live_test' })),
    isInteractive: () => false,
    log,
    error,
    exit: exit as never,
  } satisfies Partial<IntegrationCommandDependencies>);
  return { program, relay, relayfile, journal, log, error, exit };
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
      expect.objectContaining({
        provider: 'slack',
        resource: RESOURCE,
        channel: 'general',
        webhookSubscriptionId: 'whsub_1',
      })
    );
    expect(relayfile.createWebhookSubscription).toHaveBeenCalledWith({
      url: 'https://cast.test/v1/integrations/relayfile/inbound/ws/ch',
      pathGlobs: [RESOURCE],
      secret: 'inbound-secret',
    });
  });

  it('resolves provider-native resources before binding and replacement lookup', async () => {
    const resolved = '/slack/channels/C123__watchdog-test/**';
    const relayfile = createRelayfileMock([], {
      resolveResourcePath: vi.fn(async () => ({ pathGlob: resolved })),
    });
    const { program, relay } = harness({ relayfile });
    await program.parseAsync(
      ['integration', 'subscribe', 'slack', '--resource', '#watchdog-test', '--to', '#general'],
      { from: 'user' }
    );

    expect(relayfile.resolveResourcePath).toHaveBeenCalledWith('slack', '#watchdog-test');
    expect(relayfile.bind).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'slack', resource: resolved, channel: 'general' })
    );
    expect(relay.webhooks.createInbound).toHaveBeenCalledWith({
      channel: 'general',
      name: expect.stringMatching(
        /^relayfile:slack:slack-channels-c123-watchdog-test-[0-9a-f]{10}:[0-9a-f]{10}$/
      ),
    });
  });

  it('does not send inbound-target provisioning to the locally stored broker base URL', async () => {
    const { program } = harness({
      resolveLocalRelayOptions: async () => ({
        workspaceKey: 'rk_live_local',
        baseUrl: 'https://local-broker-session.example',
      }),
    });

    await program.parseAsync(ARGS(), { from: 'user' });

    expect(fetch).toHaveBeenCalledWith(
      new URL('/v1/integrations/relayfile/inbound-target', 'https://cast.agentrelay.com'),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer rk_live_local' }),
      })
    );
  });

  it('allows an explicit Relaycast base URL for inbound-target provisioning', async () => {
    const { program } = harness();

    await program.parseAsync(ARGS(['--base-url', 'https://relaycast.example']), { from: 'user' });

    expect(fetch).toHaveBeenCalledWith(
      new URL('/v1/integrations/relayfile/inbound-target', 'https://relaycast.example'),
      expect.any(Object)
    );
  });

  it('fails loudly before provisioning when no workspace key is available', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-no-workspace-'));
    vi.stubEnv('AGENT_RELAY_HOME', home);
    vi.stubEnv('RELAY_WORKSPACE_KEY', '');
    vi.stubEnv('RELAY_API_KEY', '');
    const { program, relay, relayfile, error, exit } = harness({
      resolveLocalRelayOptions: async () => undefined,
    });

    try {
      await program.parseAsync(ARGS(), { from: 'user' });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }

    expect(error).toHaveBeenCalledWith(expect.stringContaining('No workspace key found'));
    expect(exit).toHaveBeenCalledWith(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(relay.webhooks.createInbound).not.toHaveBeenCalled();
    expect(relayfile.createWebhookSubscription).not.toHaveBeenCalled();
  });

  it.each([
    ['blank URL', { url: '   ', secret: 'inbound-secret' }, 'invalid relayfile inbound target response'],
    [
      'blank secret',
      { url: 'https://cast.test/inbound', secret: '   ' },
      'invalid relayfile inbound target response',
    ],
    ['non-HTTPS URL', { url: 'http://cast.test/inbound', secret: 'inbound-secret' }, 'non-https'],
  ])('rejects %s in inbound-target responses before creating webhooks', async (_case, data, message) => {
    const { program, relay, relayfile, error, exit } = harness();
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, data }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      })
    );

    await program.parseAsync(ARGS(), { from: 'user' });

    expect(error).toHaveBeenCalledWith(expect.stringContaining(message));
    expect(exit).toHaveBeenCalledWith(1);
    expect(relay.webhooks.createInbound).not.toHaveBeenCalled();
    expect(relayfile.createWebhookSubscription).not.toHaveBeenCalled();
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
      webhookSubscriptionId: 'old_whsub',
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
    expect(relayfile.deleteWebhookSubscription).toHaveBeenCalledWith('old_whsub');
    expect(relayfile.bind.mock.invocationCallOrder[0]!).toBeLessThan(
      relayfile.deleteWebhookSubscription.mock.invocationCallOrder[0]!
    );
    await expect(relayfile.listBindings()).resolves.toEqual([
      expect.objectContaining({ webhookSubscriptionId: 'whsub_1' }),
    ]);
  });

  it('journals a failed superseded cloud-subscription delete for retry (P2)', async () => {
    const prior: RelayfileBinding = {
      provider: 'slack',
      resource: RESOURCE,
      channel: 'general',
      webhookId: 'old_wh',
      subscriptionId: 'old_sub',
      webhookSubscriptionId: 'old_whsub',
    };
    const relayfile = createRelayfileMock([prior], {
      deleteWebhookSubscription: vi.fn(async (id: string) => {
        if (id === 'old_whsub') throw new Error('temporary relayfile-cloud outage');
      }),
    });
    const { program, journal, log, error, exit } = harness({ relayfile });

    await program.parseAsync(ARGS(), { from: 'user' });

    // The replacement still lands, the superseded id is durably recorded, and
    // neither the id nor the inbound url is ever logged.
    expect(exit).not.toHaveBeenCalled();
    expect(journal.entries()).toEqual([
      { kind: 'relayfile-webhook-subscription', scope: RELAYFILE_SCOPE, id: 'old_whsub' },
    ]);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('stays recorded'));
    for (const call of [...error.mock.calls, ...log.mock.calls]) {
      expect(String(call[0])).not.toContain('old_whsub');
      expect(String(call[0])).not.toContain(INBOUND_URL);
    }
  });

  it('retries a journaled cloud-subscription cleanup on the next run, sparing keep/active ids', async () => {
    const journal = memoryJournal([
      { kind: 'relayfile-webhook-subscription', scope: RELAYFILE_SCOPE, id: 'whsub_stale' },
    ]);
    const relayfile = createRelayfileMock();
    const { program, exit } = harness({ relayfile, journal });

    await program.parseAsync(ARGS(), { from: 'user' });

    expect(exit).not.toHaveBeenCalled();
    expect(relayfile.deleteWebhookSubscription).toHaveBeenCalledWith('whsub_stale');
    // The subscription backing the binding just created is never swept.
    expect(relayfile.deleteWebhookSubscription).not.toHaveBeenCalledWith('whsub_1');
    expect(journal.entries()).toEqual([]);
  });

  it('keeps a journaled cleanup whose retry still fails', async () => {
    const journal = memoryJournal([
      { kind: 'relayfile-webhook-subscription', scope: RELAYFILE_SCOPE, id: 'whsub_stale' },
    ]);
    const relayfile = createRelayfileMock([], {
      deleteWebhookSubscription: vi.fn(async (id: string) => {
        if (id === 'whsub_stale') throw new Error('still down');
      }),
    });
    const { program, exit } = harness({ relayfile, journal });

    await program.parseAsync(ARGS(), { from: 'user' });

    expect(exit).not.toHaveBeenCalled();
    expect(journal.entries()).toEqual([
      { kind: 'relayfile-webhook-subscription', scope: RELAYFILE_SCOPE, id: 'whsub_stale' },
    ]);
  });

  it('journals the subscribe intent before any create and clears it on success', async () => {
    const relayfile = createRelayfileMock();
    const { program, relay, journal, exit } = harness({ relayfile });

    await program.parseAsync(ARGS(), { from: 'user' });

    expect(exit).not.toHaveBeenCalled();
    // The first journal write (the intent) precedes every external create.
    const intentWriteOrder = journal.update.mock.invocationCallOrder[0]!;
    expect(intentWriteOrder).toBeLessThan(relay.webhooks.createInbound.mock.invocationCallOrder[0]!);
    expect(intentWriteOrder).toBeLessThan(relayfile.createWebhookSubscription.mock.invocationCallOrder[0]!);
    // Clean completion leaves no retained intent.
    expect(journal.entries()).toEqual([]);
  });

  it('aborts before any create on a retained matching intent when the client cannot list (P1)', async () => {
    // v3-compatible daemon (ensureCompatible passes) but the installed
    // 0.10.20 client has no runtime list method — the bridge omits it.
    const journal = memoryJournal([intentEntry()]);
    const relayfile = createRelayfileMock();
    expect(relayfile.listWebhookSubscriptions).toBeUndefined();
    const { program, relay, error, exit } = harness({ relayfile, journal });

    await program.parseAsync(ARGS(), { from: 'user' });

    expect(error).toHaveBeenCalledWith(expect.stringContaining('interrupted'));
    expect(exit).toHaveBeenCalledWith(1);
    expect(relay.webhooks.createInbound).not.toHaveBeenCalled();
    expect(relayfile.createWebhookSubscription).not.toHaveBeenCalled();
    expect(relay.integrations.subscriptions.create).not.toHaveBeenCalled();
    // The intent stays retained for a later reconciling run.
    expect(journal.entries()).toEqual([intentEntry()]);
  });

  it('recovers a crash-after-create orphan via list-match, sparing active-binding ids', async () => {
    // A prior run crashed after creating whsub_orphan but before persisting it;
    // whsub_active backs another live binding on the same inbound url.
    const activeBinding: RelayfileBinding = {
      provider: 'slack',
      resource: '/slack/channels/C9/**',
      channel: 'general',
      webhookId: 'wh_other',
      subscriptionId: 'sub_other',
      webhookSubscriptionId: 'whsub_active',
    };
    const journal = memoryJournal([intentEntry()]);
    const relayfile = createRelayfileMock([activeBinding], {
      listWebhookSubscriptions: vi.fn(async () => [
        { subscriptionId: 'whsub_orphan', url: INBOUND_URL, pathGlobs: [RESOURCE] },
        { subscriptionId: 'whsub_active', url: INBOUND_URL, pathGlobs: [RESOURCE] },
        { subscriptionId: 'whsub_other_url', url: 'https://cast.test/other', pathGlobs: [RESOURCE] },
      ]),
    });
    const { program, relayfile: bridge, exit } = harness({ relayfile, journal });

    await program.parseAsync(ARGS(), { from: 'user' });

    expect(exit).not.toHaveBeenCalled();
    // Only the unreferenced, key-matching orphan is deleted...
    expect(bridge.deleteWebhookSubscription).toHaveBeenCalledWith('whsub_orphan');
    expect(bridge.deleteWebhookSubscription).not.toHaveBeenCalledWith('whsub_active');
    expect(bridge.deleteWebhookSubscription).not.toHaveBeenCalledWith('whsub_other_url');
    // ...the intent is cleared, and the new subscribe proceeded normally.
    expect(journal.entries()).toEqual([]);
    expect(bridge.createWebhookSubscription).toHaveBeenCalled();
  });

  it('aborts before any create when the journal cannot record the intent', async () => {
    const journal = memoryJournal();
    journal.update.mockRejectedValue(new Error('journal is corrupt'));
    const relayfile = createRelayfileMock();
    const { program, relay, error, exit } = harness({ relayfile, journal });

    await program.parseAsync(ARGS(), { from: 'user' });

    expect(error).toHaveBeenCalledWith(expect.stringContaining('journal is corrupt'));
    expect(exit).toHaveBeenCalledWith(1);
    expect(relay.webhooks.createInbound).not.toHaveBeenCalled();
    expect(relayfile.createWebhookSubscription).not.toHaveBeenCalled();
  });

  it('journals rollback losses when a failed subscribe cannot delete what it created', async () => {
    const relayfile = createRelayfileMock([], {
      bind: vi.fn(async () => {
        throw new Error('bind failed');
      }),
      deleteWebhookSubscription: vi.fn(async () => {
        throw new Error('cloud unreachable');
      }),
    });
    const relay = createRelayMock();
    relay.webhooks.delete.mockRejectedValue(new Error('relay unreachable'));
    relay.integrations.subscriptions.delete.mockRejectedValue(new Error('relay unreachable'));
    const { program, journal, error, exit } = harness({ relay, relayfile });

    await program.parseAsync(ARGS(), { from: 'user' });

    expect(error).toHaveBeenCalledWith(expect.stringContaining('bind failed'));
    expect(exit).toHaveBeenCalledWith(1);
    const kinds = journal
      .entries()
      .map((e) => e.kind)
      .sort();
    // Every orphaned id is durably recorded; the concrete cloud id entry
    // supersedes the intent.
    expect(kinds).toEqual(['relay-subscription', 'relay-webhook', 'relayfile-webhook-subscription']);
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
    const { program, error, exit } = harness({ relay, relayfile });
    await program.parseAsync(ARGS(), { from: 'user' });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('transient'));
    expect(exit).toHaveBeenCalledWith(1);
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
    const { program, error, exit } = harness({ relay, relayfile });
    await program.parseAsync(ARGS(), { from: 'user' });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('relayfile unavailable'));
    expect(exit).toHaveBeenCalledWith(1);
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
    const { program, error, exit } = harness({ relay, relayfile });
    await program.parseAsync(ARGS(), { from: 'user' });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('bind failed'));
    expect(exit).toHaveBeenCalledWith(1);
    expect(error.mock.calls.some((c) => String(c[0]).includes('relay inbound webhook'))).toBe(true);
    expect(relayfile.deleteWebhookSubscription).toHaveBeenCalledWith('whsub_1');
  });
});

describe('integration unsubscribe', () => {
  it('removes the persisted relayfile-cloud subscription before unbinding', async () => {
    const binding: RelayfileBinding = {
      provider: 'slack',
      resource: RESOURCE,
      channel: 'general',
      webhookId: 'wh_1',
      subscriptionId: 'sub_1',
      webhookSubscriptionId: 'whsub_1',
    };
    const relayfile = createRelayfileMock([binding]);
    const { program, relay } = harness({ relayfile });

    await program.parseAsync(['integration', 'unsubscribe', 'slack', '--resource', RESOURCE], {
      from: 'user',
    });

    expect(relay.webhooks.delete).toHaveBeenCalledWith('wh_1');
    expect(relay.webhooks.unsubscribe).toHaveBeenCalledWith('sub_1');
    expect(relayfile.deleteWebhookSubscription).toHaveBeenCalledWith('whsub_1');
    expect(relayfile.deleteWebhookSubscription.mock.invocationCallOrder[0]!).toBeLessThan(
      relayfile.unbind.mock.invocationCallOrder[0]!
    );
  });

  it('journals a failed cloud delete and still completes the unsubscribe', async () => {
    const binding: RelayfileBinding = {
      provider: 'slack',
      resource: RESOURCE,
      channel: 'general',
      webhookId: 'wh_1',
      subscriptionId: 'sub_1',
      webhookSubscriptionId: 'whsub_current',
    };
    const relayfile = createRelayfileMock([binding], {
      deleteWebhookSubscription: vi.fn(async () => {
        throw new Error('temporary relayfile-cloud outage');
      }),
    });
    const { program, relay, journal, error, exit } = harness({ relayfile });

    await program.parseAsync(['integration', 'unsubscribe', 'slack', '--resource', RESOURCE], {
      from: 'user',
    });

    // The id is durably recorded, so the user's unsubscribe completes.
    expect(exit).not.toHaveBeenCalled();
    expect(journal.entries()).toEqual([
      { kind: 'relayfile-webhook-subscription', scope: RELAYFILE_SCOPE, id: 'whsub_current' },
    ]);
    expect(relay.webhooks.delete).toHaveBeenCalledWith('wh_1');
    expect(relayfile.unbind).toHaveBeenCalledWith('slack', RESOURCE);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('recorded for retry'));
    for (const call of error.mock.calls) {
      expect(String(call[0])).not.toContain('whsub_current');
    }
  });

  it('aborts before unbind when a failed cloud delete cannot be journaled', async () => {
    const binding: RelayfileBinding = {
      provider: 'slack',
      resource: RESOURCE,
      channel: 'general',
      webhookId: 'wh_1',
      subscriptionId: 'sub_1',
      webhookSubscriptionId: 'whsub_current',
    };
    const journal = memoryJournal();
    journal.update.mockRejectedValue(new Error('disk full'));
    const relayfile = createRelayfileMock([binding], {
      deleteWebhookSubscription: vi.fn(async () => {
        throw new Error('temporary relayfile-cloud outage');
      }),
    });
    const { program, error, exit } = harness({ relayfile, journal });

    await program.parseAsync(['integration', 'unsubscribe', 'slack', '--resource', RESOURCE], {
      from: 'user',
    });

    // Losing the id AND its record would orphan the cloud subscription
    // forever — the binding (its only persisted home) must survive.
    expect(error).toHaveBeenCalledWith(expect.stringContaining('binding was left in place'));
    expect(exit).toHaveBeenCalledWith(1);
    expect(relayfile.unbind).not.toHaveBeenCalled();
    await expect(relayfile.listBindings()).resolves.toEqual([binding]);
  });

  it('aborts before unbind when a failed relay-side delete cannot be journaled', async () => {
    const binding: RelayfileBinding = {
      provider: 'slack',
      resource: RESOURCE,
      channel: 'general',
      webhookId: 'wh_1',
      subscriptionId: 'sub_1',
    };
    const journal = memoryJournal();
    journal.update.mockRejectedValue(new Error('disk full'));
    const relay = createRelayMock();
    relay.webhooks.delete.mockRejectedValue(new Error('relay unreachable'));
    const relayfile = createRelayfileMock([binding]);
    const { program, error, exit } = harness({ relay, relayfile, journal });

    await program.parseAsync(['integration', 'unsubscribe', 'slack', '--resource', RESOURCE], {
      from: 'user',
    });

    expect(error).toHaveBeenCalledWith(expect.stringContaining('binding was left in place'));
    expect(exit).toHaveBeenCalledWith(1);
    expect(relayfile.unbind).not.toHaveBeenCalled();
  });

  it('treats a relay-side 404 during unsubscribe as already-clean and completes', async () => {
    const binding: RelayfileBinding = {
      provider: 'slack',
      resource: RESOURCE,
      channel: 'general',
      webhookId: 'wh_1',
      subscriptionId: 'sub_1',
    };
    const relay = createRelayMock();
    relay.webhooks.delete.mockRejectedValue(Object.assign(new Error('not found'), { statusCode: 404 }));
    relay.webhooks.unsubscribe.mockRejectedValue(Object.assign(new Error('not found'), { status: 404 }));
    const relayfile = createRelayfileMock([binding]);
    const { program, journal, exit } = harness({ relay, relayfile });

    await program.parseAsync(['integration', 'unsubscribe', 'slack', '--resource', RESOURCE], {
      from: 'user',
    });

    expect(exit).not.toHaveBeenCalled();
    expect(relayfile.unbind).toHaveBeenCalledWith('slack', RESOURCE);
    expect(journal.entries()).toEqual([]);
  });

  it('converges a journaled relay-side cleanup whose resource is already gone (404)', async () => {
    const binding: RelayfileBinding = {
      provider: 'slack',
      resource: RESOURCE,
      channel: 'general',
      webhookId: 'wh_1',
      subscriptionId: 'sub_1',
    };
    // First run: relay-side deletes fail hard, so both ids get journaled with
    // the run's real relay scope.
    const failingRelay = createRelayMock();
    failingRelay.webhooks.delete.mockRejectedValue(new Error('down'));
    failingRelay.webhooks.unsubscribe.mockRejectedValue(new Error('down'));
    const seedJournal = memoryJournal();
    const first = harness({
      relay: failingRelay,
      relayfile: createRelayfileMock([binding]),
      journal: seedJournal,
    });
    await first.program.parseAsync(['integration', 'unsubscribe', 'slack', '--resource', RESOURCE], {
      from: 'user',
    });
    const recorded = seedJournal.entries();
    expect(recorded.map((e) => e.kind).sort()).toEqual(['relay-subscription', 'relay-webhook']);

    // Later run: the resources are already gone (404) — the sweep must clear
    // the entries instead of retaining them forever.
    const relay404 = createRelayMock();
    relay404.webhooks.delete.mockImplementation(async (id: string) => {
      if (id === 'wh_1') throw Object.assign(new Error('gone'), { statusCode: 404 });
    });
    relay404.webhooks.unsubscribe.mockImplementation(async (id: string) => {
      if (id === 'sub_1') throw Object.assign(new Error('gone'), { status: 404 });
    });
    const followupJournal = memoryJournal(recorded);
    const second = harness({ relay: relay404, relayfile: createRelayfileMock(), journal: followupJournal });
    await second.program.parseAsync(ARGS(), { from: 'user' });
    expect(
      followupJournal.entries().filter((e) => e.kind === 'relay-webhook' || e.kind === 'relay-subscription')
    ).toEqual([]);
  });

  it('treats an already-deleted cloud subscription as successful retry cleanup', async () => {
    const binding: RelayfileBinding = {
      provider: 'slack',
      resource: RESOURCE,
      channel: 'general',
      webhookId: 'wh_1',
      subscriptionId: 'sub_1',
      webhookSubscriptionId: 'whsub_1',
    };
    const relayfile = createRelayfileMock([binding], {
      deleteWebhookSubscription: vi.fn(async () => {
        throw new RelayfileControlPlaneError('NOT_FOUND', 'already deleted', 404);
      }),
    });
    const { program, relay } = harness({ relayfile });

    await program.parseAsync(['integration', 'unsubscribe', 'slack', '--resource', RESOURCE], {
      from: 'user',
    });

    expect(relay.webhooks.delete).toHaveBeenCalledWith('wh_1');
    expect(relayfile.unbind).toHaveBeenCalledWith('slack', RESOURCE);
  });
});
