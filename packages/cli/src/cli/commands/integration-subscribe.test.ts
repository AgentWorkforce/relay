import { Command } from 'commander';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RelayfileControlPlaneError } from '@relayfile/client';

import {
  OWNER_LEASE_CONFIG,
  registerIntegrationCommands,
  relayCleanupScope,
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
        webhookSubscriptionWorkspaceId?: string;
      }) => {
        const record: RelayfileBinding = {
          provider: input.provider,
          resource: input.resource,
          channel: input.channel,
          webhookId: input.webhookId,
          subscriptionId: input.subscriptionId,
          webhookSubscriptionId: input.webhookSubscriptionId,
          webhookSubscriptionWorkspaceId: input.webhookSubscriptionWorkspaceId,
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
    resolveWritebackBinding: vi.fn(async () => ({
      url: 'https://ingress.example',
      secret: 's3cr3t',
      workspaceId: 'rw_test',
    })),
    createWebhookSubscription: vi.fn(async () => ({ subscriptionId: 'whsub_1' })),
    deleteWebhookSubscription: vi.fn(async () => undefined),
    ...overrides,
  };
}

// In-memory CleanupJournal: tests must never touch the default file-backed
// journal under the project data dir.
function memoryJournal(initial: PendingCleanupEntry[] = []) {
  let entries = [...initial];
  const apply = async (
    mutate: (e: PendingCleanupEntry[]) => PendingCleanupEntry[] | Promise<PendingCleanupEntry[]>
  ) => {
    entries = await mutate([...entries]);
  };
  return {
    entries: () => [...entries],
    apply,
    list: vi.fn(async () => [...entries]),
    update: vi.fn(apply),
  };
}

/** Apply a mutate against a memoryJournal from inside a custom update mock. */
async function memoryJournalApply(
  journal: ReturnType<typeof memoryJournal>,
  mutate: (e: PendingCleanupEntry[]) => PendingCleanupEntry[] | Promise<PendingCleanupEntry[]>
) {
  await journal.apply(mutate);
}

const INBOUND_URL = 'https://cast.test/v1/integrations/relayfile/inbound/ws/ch';
const WRITEBACK_URL = 'https://ingress.example';
const RELAYFILE_SCOPE = 'relayfile:project-daemon';

function attemptEntry(overrides: Partial<PendingCleanupEntry> = {}): PendingCleanupEntry {
  return {
    kind: 'subscribe-attempt',
    scope: RELAYFILE_SCOPE,
    provider: 'slack',
    resource: RESOURCE,
    url: INBOUND_URL,
    pathGlobs: [RESOURCE],
    webhookName: 'relayfile:slack:stale-name:0000000000',
    writebackUrl: WRITEBACK_URL,
    relayScope: relayCleanupScope({ workspaceKey: 'rk_live_test' }),
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
      workspace: 'rw_test',
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
    expect(relayfile.deleteWebhookSubscription).toHaveBeenCalledWith('old_whsub', undefined);
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
    expect(relayfile.deleteWebhookSubscription).toHaveBeenCalledWith('whsub_stale', undefined);
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
    // The first journal write (the attempt reservation) precedes every
    // external create.
    const reservationOrder = journal.update.mock.invocationCallOrder[0]!;
    expect(reservationOrder).toBeLessThan(relay.webhooks.createInbound.mock.invocationCallOrder[0]!);
    expect(reservationOrder).toBeLessThan(relayfile.createWebhookSubscription.mock.invocationCallOrder[0]!);
    // Clean completion leaves no retained attempt.
    expect(journal.entries()).toEqual([]);
  });

  it('aborts before any create on a retained matching attempt when the client cannot list (P1)', async () => {
    // v3-compatible daemon (ensureCompatible passes) but the installed
    // 0.10.20 client has no runtime list method — the bridge omits it.
    const journal = memoryJournal([attemptEntry()]);
    const relayfile = createRelayfileMock();
    expect(relayfile.listWebhookSubscriptions).toBeUndefined();
    const { program, relay, error, exit } = harness({ relayfile, journal });

    await program.parseAsync(ARGS(), { from: 'user' });

    expect(error).toHaveBeenCalledWith(expect.stringContaining('interrupted'));
    expect(exit).toHaveBeenCalledWith(1);
    expect(relay.webhooks.createInbound).not.toHaveBeenCalled();
    expect(relayfile.createWebhookSubscription).not.toHaveBeenCalled();
    expect(relay.integrations.subscriptions.create).not.toHaveBeenCalled();
    // The attempt stays retained for a later reconciling run.
    expect(journal.entries()).toEqual([attemptEntry()]);
  });

  it('recovers a lease whose pid is ALIVE but whose bounded lease expired (PID-reuse bound)', async () => {
    // The pid probe passes (it is THIS live process — exactly what PID reuse
    // looks like), but the heartbeat is far beyond OWNER_LEASE_MS: the owner
    // must be treated as dead, so the stale attempt is reconciled and the
    // new subscribe proceeds instead of wedging forever.
    const reusedPidAttempt = attemptEntry({
      relayfileWorkspaceId: 'rw_1',
      owner: {
        pid: process.pid,
        host: os.hostname(),
        attemptId: 'reused-pid',
        heartbeatAt: Date.now() - 16 * 60_000,
      },
    });
    const journal = memoryJournal([reusedPidAttempt]);
    const relayfile = createRelayfileMock([], {
      listWebhookSubscriptions: vi.fn(async () => ({ workspaceId: 'rw_1', subscriptions: [] })),
    });
    const { program, exit } = harness({ relayfile, journal });

    await program.parseAsync(ARGS(), { from: 'user' });

    expect(exit).not.toHaveBeenCalled();
    expect(relayfile.createWebhookSubscription).toHaveBeenCalled();
    expect(journal.entries().filter((e) => e.kind === 'subscribe-attempt')).toEqual([]);
  });

  it('keeps a >lease-duration lifecycle protected via periodic renewal (P1)', async () => {
    // Deterministic tiny windows: the external create outlives the lease by
    // 2x, the renewal timer refreshes several times meanwhile, and a rival
    // probing DURING the long await must still see a LIVE reservation.
    const saved = { ...OWNER_LEASE_CONFIG };
    Object.assign(OWNER_LEASE_CONFIG, { leaseMs: 250, renewalMs: 50, skewMs: 100 });
    try {
      const journal = memoryJournal();
      let rivalChecked = false;
      const relayfile = createRelayfileMock([], {
        createWebhookSubscription: vi.fn(async () => {
          // Long external await: past the (tiny) lease, with renewal running.
          await new Promise((resolve) => setTimeout(resolve, 550));
          const rival = harness({ relayfile: createRelayfileMock(), journal });
          await rival.program.parseAsync(ARGS(), { from: 'user' });
          expect(rival.error).toHaveBeenCalledWith(expect.stringContaining('in progress'));
          expect(rival.exit).toHaveBeenCalledWith(1);
          expect(rival.relay.webhooks.createInbound).not.toHaveBeenCalled();
          rivalChecked = true;
          return { subscriptionId: 'whsub_1' };
        }),
      });
      const { program, exit } = harness({ relayfile, journal });

      await program.parseAsync(ARGS(), { from: 'user' });

      expect(exit).not.toHaveBeenCalled();
      expect(rivalChecked).toBe(true);
      expect(journal.entries().filter((e) => e.kind === 'subscribe-attempt')).toEqual([]);
    } finally {
      Object.assign(OWNER_LEASE_CONFIG, saved);
    }
  });

  it('a renewal tick in flight at stop() settles as a no-op after success (P3)', async () => {
    // Hold a renewal tick across the lifecycle's completion: the lifecycle
    // removes its reservation and stops the timer; releasing the held tick
    // afterwards must neither warn, nor latch, nor resurrect the record,
    // nor reject unhandled.
    const saved = { ...OWNER_LEASE_CONFIG };
    Object.assign(OWNER_LEASE_CONFIG, { leaseMs: 400, renewalMs: 30, skewMs: 100 });
    try {
      const journal = memoryJournal();
      let holdRenewals = false;
      let releaseHeld: (() => void) | undefined;
      const held = new Promise<void>((resolve) => {
        releaseHeld = resolve;
      });
      const inner = journal.update.getMockImplementation()!;
      journal.update.mockImplementation(async (mutate) => {
        if (holdRenewals) {
          holdRenewals = false; // hold exactly one tick
          await held;
        }
        await inner(mutate);
      });
      const relayfile = createRelayfileMock([], {
        createWebhookSubscription: vi.fn(async () => {
          holdRenewals = true;
          // Long enough for one renewal tick to fire and block on the gate.
          await new Promise((resolve) => setTimeout(resolve, 120));
          return { subscriptionId: 'whsub_1' };
        }),
      });
      const { program, error, exit } = harness({ relayfile, journal });

      await program.parseAsync(ARGS(), { from: 'user' });
      expect(exit).not.toHaveBeenCalled();

      // Lifecycle done, reservation removed, timer stopped — now release the
      // held tick and let it settle.
      releaseHeld!();
      await new Promise((resolve) => setTimeout(resolve, 80));

      expect(journal.entries().filter((e) => e.kind === 'subscribe-attempt')).toEqual([]);
      for (const call of error.mock.calls) {
        expect(String(call[0])).not.toContain('lifecycle lease');
      }
    } finally {
      Object.assign(OWNER_LEASE_CONFIG, saved);
    }
  });

  it('latches a renewal failure and aborts before further external mutations (P1)', async () => {
    const saved = { ...OWNER_LEASE_CONFIG };
    Object.assign(OWNER_LEASE_CONFIG, { leaseMs: 250, renewalMs: 40, skewMs: 100 });
    try {
      const journal = memoryJournal();
      // The reservation (1st write) and prior-record write path succeed;
      // every later journal write — including renewal ticks — fails.
      let updates = 0;
      journal.update.mockImplementation(async (mutate) => {
        updates += 1;
        if (updates > 1) throw new Error('journal offline');
        await memoryJournalApply(journal, mutate);
      });
      const relay = createRelayMock();
      relay.webhooks.createInbound.mockImplementation(async () => {
        // Long enough for a failing renewal tick to latch.
        await new Promise((resolve) => setTimeout(resolve, 200));
        return { webhookId: 'in_1', url: 'u', token: 'tok_once', channel: 'general' };
      });
      const relayfile = createRelayfileMock();
      const { program, error, exit } = harness({ relay, relayfile, journal });

      await program.parseAsync(ARGS(), { from: 'user' });

      expect(error).toHaveBeenCalledWith(expect.stringContaining('could not be renewed'));
      expect(exit).toHaveBeenCalledWith(1);
      // The latch fired before the cloud create — nothing external beyond
      // the rolled-back webhook was mutated.
      expect(relayfile.createWebhookSubscription).not.toHaveBeenCalled();
      expect(relay.webhooks.delete).toHaveBeenCalledWith('in_1');
    } finally {
      Object.assign(OWNER_LEASE_CONFIG, saved);
    }
  });

  it('recovers a lease whose heartbeat is FUTURE-dated beyond the skew bound (P1)', async () => {
    // A finite-but-absurd future heartbeat (malformed value or badly skewed
    // clock) must not make its owner immortal: beyond the documented skew it
    // counts as expired even though the pid probes alive.
    const futureAttempt = attemptEntry({
      relayfileWorkspaceId: 'rw_1',
      owner: {
        pid: process.pid,
        host: os.hostname(),
        attemptId: 'future-heartbeat',
        heartbeatAt: Date.now() + 9e15,
      },
    });
    const journal = memoryJournal([futureAttempt]);
    const relayfile = createRelayfileMock([], {
      listWebhookSubscriptions: vi.fn(async () => ({ workspaceId: 'rw_1', subscriptions: [] })),
    });
    const { program, exit } = harness({ relayfile, journal });

    await program.parseAsync(ARGS(), { from: 'user' });

    expect(exit).not.toHaveBeenCalled();
    expect(relayfile.createWebhookSubscription).toHaveBeenCalled();
    expect(journal.entries().filter((e) => e.kind === 'subscribe-attempt')).toEqual([]);
  });

  it('aborts before any create while a live concurrent subscribe holds the reservation (P1)', async () => {
    // The lease-owner is this very process, which is provably alive — exactly
    // what a second CLI racing the same resource would observe.
    const liveAttempt = attemptEntry({
      owner: { pid: process.pid, host: os.hostname(), attemptId: 'other-attempt', heartbeatAt: Date.now() },
    });
    const journal = memoryJournal([liveAttempt]);
    const relayfile = createRelayfileMock([], {
      listWebhookSubscriptions: vi.fn(async () => ({ workspaceId: 'rw_1', subscriptions: [] })),
    });
    const { program, relay, error, exit } = harness({ relayfile, journal });

    await program.parseAsync(ARGS(), { from: 'user' });

    expect(error).toHaveBeenCalledWith(expect.stringContaining('in progress'));
    expect(exit).toHaveBeenCalledWith(1);
    expect(relay.webhooks.createInbound).not.toHaveBeenCalled();
    expect(relayfile.createWebhookSubscription).not.toHaveBeenCalled();
    // The live attempt's reservation is never swept or cleared.
    expect(journal.entries()).toEqual([liveAttempt]);
    expect(relayfile.deleteWebhookSubscription).not.toHaveBeenCalled();
  });

  it('recovers a crash-after-webhook-create attempt by exact name, sparing other names (P1)', async () => {
    const deadAttempt = attemptEntry({
      webhookName: 'relayfile:slack:slack-channels-c0-0123456789:deadbeef00',
      relayfileWorkspaceId: 'rw_1',
    });
    const relay = createRelayMock({
      inboundWebhooks: [
        {
          webhookId: 'wh_orphan',
          url: 'u',
          token: '',
          channel: 'general',
          name: 'relayfile:slack:slack-channels-c0-0123456789:deadbeef00',
        },
        {
          // Same resource prefix, different attempt nonce — must survive.
          webhookId: 'wh_other_attempt',
          url: 'u',
          token: '',
          channel: 'general',
          name: 'relayfile:slack:slack-channels-c0-0123456789:aaaaaaaaaa',
        },
      ],
    });
    const journal = memoryJournal([deadAttempt]);
    const relayfile = createRelayfileMock([], {
      listWebhookSubscriptions: vi.fn(async () => ({ workspaceId: 'rw_1', subscriptions: [] })),
    });
    const { program, exit } = harness({ relay, relayfile, journal });

    await program.parseAsync(ARGS(), { from: 'user' });

    expect(exit).not.toHaveBeenCalled();
    expect(relay.webhooks.delete).toHaveBeenCalledWith('wh_orphan');
    expect(relay.webhooks.delete).not.toHaveBeenCalledWith('wh_other_attempt');
    expect(journal.entries().filter((e) => e.kind === 'subscribe-attempt')).toEqual([]);
  });

  it('spares a live concurrent attempt pre-bind webhook from prefix hygiene (P1)', async () => {
    // A completed run's hygiene sweep sees a same-prefix, not-yet-bound
    // webhook created by a LIVE different attempt (reservation journaled
    // before its create); it must survive.
    const liveAttempt = attemptEntry({
      webhookName: 'relayfile:slack:slack-channels-c0-0123456789:bbbbbbbbbb',
      owner: { pid: process.pid, host: os.hostname(), attemptId: 'concurrent-live', heartbeatAt: Date.now() },
    });
    const relay = createRelayMock({
      inboundWebhooks: [
        {
          webhookId: 'wh_live_prebind',
          url: 'u',
          token: '',
          channel: 'general',
          name: 'relayfile:slack:slack-channels-c0-0123456789:bbbbbbbbbb',
        },
      ],
    });
    const journal = memoryJournal([liveAttempt]);
    const relayfile = createRelayfileMock();
    const { program, error, exit } = harness({ relay, relayfile, journal });

    await program.parseAsync(ARGS(), { from: 'user' });

    // The live same-key reservation aborts this run before creating anything
    // AND nothing it does may touch the live attempt's webhook.
    expect(exit).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('in progress'));
    expect(relay.webhooks.delete).not.toHaveBeenCalledWith('wh_live_prebind');
  });

  it('prefix hygiene spares a live different-resource attempt webhook after a successful bind', async () => {
    // Different resource, same provider — the run completes normally, and its
    // hygiene loop must still exclude the live attempt's pre-bind webhook.
    const liveAttempt = attemptEntry({
      resource: '/slack/channels/C9/**',
      pathGlobs: ['/slack/channels/C9/**'],
      webhookName: 'relayfile:slack:slack-channels-c0-0123456789:cccccccccc',
      owner: {
        pid: process.pid,
        host: os.hostname(),
        attemptId: 'other-resource-live',
        heartbeatAt: Date.now(),
      },
    });
    const relay = createRelayMock({
      inboundWebhooks: [
        {
          webhookId: 'wh_live_prebind',
          url: 'u',
          token: '',
          channel: 'general',
          // Same prefix as THIS run's resource — prefix-hygiene bait.
          name: 'relayfile:slack:slack-channels-c0-0123456789:cccccccccc',
        },
      ],
    });
    const journal = memoryJournal([liveAttempt]);
    const relayfile = createRelayfileMock();
    const { program, exit } = harness({ relay, relayfile, journal });

    await program.parseAsync(ARGS(), { from: 'user' });

    expect(exit).not.toHaveBeenCalled();
    expect(relay.webhooks.delete).not.toHaveBeenCalledWith('wh_live_prebind');
  });

  it('recovers a dead attempt subscription by its exact per-attempt url on a shared channel (P1)', async () => {
    const deadAttempt = attemptEntry({
      writebackUrl: `${WRITEBACK_URL}?relaySubscribeAttempt=deadbeef`,
      relayfileWorkspaceId: 'rw_1',
    });
    const relay = createRelayMock();
    relay.webhooks.subscriptions.mockResolvedValue([
      { id: 'sub_dead', url: `${WRITEBACK_URL}?relaySubscribeAttempt=deadbeef` },
      // Another attempt's pre-bind subscription on the SAME channel base url.
      { id: 'sub_other_attempt', url: `${WRITEBACK_URL}?relaySubscribeAttempt=aaaaaaaa` },
      { id: 'sub_bare', url: WRITEBACK_URL },
    ]);
    const journal = memoryJournal([deadAttempt]);
    const relayfile = createRelayfileMock([], {
      listWebhookSubscriptions: vi.fn(async () => ({ workspaceId: 'rw_1', subscriptions: [] })),
    });
    const { program, exit } = harness({ relay, relayfile, journal });

    await program.parseAsync(ARGS(), { from: 'user' });

    expect(exit).not.toHaveBeenCalled();
    expect(relay.webhooks.unsubscribe).toHaveBeenCalledWith('sub_dead');
    expect(relay.webhooks.unsubscribe).not.toHaveBeenCalledWith('sub_other_attempt');
    expect(relay.webhooks.unsubscribe).not.toHaveBeenCalledWith('sub_bare');
    expect(journal.entries().filter((e) => e.kind === 'subscribe-attempt')).toEqual([]);
  });

  it('recovers a crash-after-subscription-create attempt via writeback url, sparing active ids (P1)', async () => {
    const activeBinding: RelayfileBinding = {
      provider: 'slack',
      resource: '/slack/channels/C9/**',
      channel: 'general',
      webhookId: 'wh_other',
      subscriptionId: 'sub_active',
    };
    const deadAttempt = attemptEntry({ relayfileWorkspaceId: 'rw_1' });
    const relay = createRelayMock();
    relay.webhooks.subscriptions.mockResolvedValue([
      { id: 'sub_orphan', url: WRITEBACK_URL },
      { id: 'sub_active', url: WRITEBACK_URL },
      { id: 'sub_elsewhere', url: 'https://elsewhere.example' },
    ]);
    const journal = memoryJournal([deadAttempt]);
    const relayfile = createRelayfileMock([activeBinding], {
      listWebhookSubscriptions: vi.fn(async () => ({ workspaceId: 'rw_1', subscriptions: [] })),
    });
    const { program, exit } = harness({ relay, relayfile, journal });

    await program.parseAsync(ARGS(), { from: 'user' });

    expect(exit).not.toHaveBeenCalled();
    expect(relay.webhooks.unsubscribe).toHaveBeenCalledWith('sub_orphan');
    expect(relay.webhooks.unsubscribe).not.toHaveBeenCalledWith('sub_active');
    expect(relay.webhooks.unsubscribe).not.toHaveBeenCalledWith('sub_elsewhere');
    expect(journal.entries().filter((e) => e.kind === 'subscribe-attempt')).toEqual([]);
  });

  it('claims a stale attempt as a live recovery lease before any remote recovery call (P1)', async () => {
    const deadAttempt = attemptEntry({ relayfileWorkspaceId: 'rw_1' });
    const journal = memoryJournal([deadAttempt]);
    const listMock = vi.fn(async () => {
      // At the moment recovery reaches out remotely, the stale attempt must
      // already be re-owned by a LIVE lease — a concurrent prepare would now
      // abort instead of interleaving a same-key create.
      const held = journal
        .entries()
        .find((e) => e.kind === 'subscribe-attempt' && e.owner?.host === os.hostname());
      expect(held).toBeDefined();
      expect(() => process.kill(held!.owner!.pid, 0)).not.toThrow();
      return { workspaceId: 'rw_1', subscriptions: [] };
    });
    const relayfile = createRelayfileMock([], {
      listWebhookSubscriptions: listMock,
      resolveWritebackBinding: vi.fn(async () => ({
        url: WRITEBACK_URL,
        secret: 's3cr3t',
        workspaceId: 'rw_1',
      })),
    });
    const { program, exit } = harness({ relayfile, journal });

    await program.parseAsync(ARGS(), { from: 'user' });

    expect(exit).not.toHaveBeenCalled();
    expect(listMock).toHaveBeenCalled();
    // Fully reconciled: the claimed record is removed.
    expect(journal.entries().filter((e) => e.kind === 'subscribe-attempt')).toEqual([]);
  });

  it('blocks a same-resource subscribe while a recovery claim is held, mid-reconcile (P1)', async () => {
    const deadAttempt = attemptEntry({ relayfileWorkspaceId: 'rw_1' });
    const journal = memoryJournal([deadAttempt]);

    // Recovery's remote list stalls until we release it, holding the claim.
    let releaseRecovery!: () => void;
    const recoveryGate = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    let raceChecked = false;
    const recoveringRelayfile = createRelayfileMock([], {
      listWebhookSubscriptions: vi.fn(async () => {
        if (!raceChecked) {
          raceChecked = true;
          // While the claim is held, a concurrent same-resource subscribe
          // sharing the journal must abort BEFORE any create.
          const rival = harness({ relayfile: createRelayfileMock(), journal });
          await rival.program.parseAsync(ARGS(), { from: 'user' });
          expect(rival.error).toHaveBeenCalledWith(expect.stringContaining('in progress'));
          expect(rival.exit).toHaveBeenCalledWith(1);
          expect(rival.relay.webhooks.createInbound).not.toHaveBeenCalled();
          expect(rival.relayfile.createWebhookSubscription).not.toHaveBeenCalled();
          await recoveryGate;
        }
        return { workspaceId: 'rw_1', subscriptions: [] };
      }),
      resolveWritebackBinding: vi.fn(async () => ({
        url: WRITEBACK_URL,
        secret: 's3cr3t',
        workspaceId: 'rw_1',
      })),
    });
    const { program, exit } = harness({ relayfile: recoveringRelayfile, journal });

    const run = program.parseAsync(ARGS(), { from: 'user' });
    // Let the recovery reach its stalled list call, then release it.
    await vi.waitFor(() => expect(raceChecked).toBe(true));
    releaseRecovery();
    await run;

    expect(exit).not.toHaveBeenCalled();
    // Once the claim released (reconcile completed), the original run's own
    // subscribe proceeded normally.
    expect(recoveringRelayfile.createWebhookSubscription).toHaveBeenCalled();
    expect(journal.entries().filter((e) => e.kind === 'subscribe-attempt')).toEqual([]);
  });

  it('releases a partial recovery claim back to a reclaimable state', async () => {
    // Cloud reconciliation cannot complete (no list capability), so recovery
    // must hand the lease back — a live-held claim would block every later
    // lifecycle until this pid exits.
    const deadAttempt = attemptEntry({ relayfileWorkspaceId: 'rw_1' });
    const journal = memoryJournal([deadAttempt]);
    const relayfile = createRelayfileMock();
    expect(relayfile.listWebhookSubscriptions).toBeUndefined();
    const { program, exit } = harness({ relayfile, journal });

    await program.parseAsync(ARGS(), { from: 'user' });

    // Same-key subscribe aborted (unreconciled attempt) — and the retained
    // record is NOT live-owned by this process.
    expect(exit).toHaveBeenCalledWith(1);
    const retained = journal.entries().find((e) => e.kind === 'subscribe-attempt');
    expect(retained).toBeDefined();
    expect(retained!.owner).toEqual(deadAttempt.owner);
  });

  it('retains an unpinned attempt instead of list-matching the wrong workspace', async () => {
    // Crash landed the create but not its response: no workspace pin. After a
    // workspace switch, listing the NOW-active workspace must not settle it.
    const deadAttempt = attemptEntry(); // no relayfileWorkspaceId
    const journal = memoryJournal([deadAttempt]);
    const listMock = vi.fn(async () => ({ workspaceId: 'rw_2', subscriptions: [] }));
    const relayfile = createRelayfileMock([], { listWebhookSubscriptions: listMock });
    const { program } = harness({ relayfile, journal });

    await program.parseAsync(ARGS(), { from: 'user' });

    // The sweep never list-matched the unpinned attempt (the only list calls
    // are the pre-pin lookups), and the record is retained.
    expect(journal.entries().some((e) => e.kind === 'subscribe-attempt' && e.owner === undefined)).toBe(true);
  });

  it('passes the journaled workspace pin into the cloud create itself', async () => {
    const relayfile = createRelayfileMock([], {
      resolveWritebackBinding: vi.fn(async () => ({
        url: WRITEBACK_URL,
        secret: 's3cr3t',
        workspaceId: 'rw_pinned',
      })),
    });
    const { program, exit } = harness({ relayfile });

    await program.parseAsync(ARGS(), { from: 'user' });

    expect(exit).not.toHaveBeenCalled();
    // The create is pinned to the SAME workspace journaled in the attempt, so
    // a workspace switch between writeback resolution and the POST cannot
    // strand the subscription outside the recorded pin.
    expect(relayfile.createWebhookSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: 'rw_pinned' })
    );
    // The live binding persists the pin for later pinned cleanup.
    await expect(relayfile.listBindings()).resolves.toEqual([
      expect.objectContaining({ webhookSubscriptionWorkspaceId: 'rw_pinned' }),
    ]);
  });

  it('retains an attempt when the list echo does not exactly match its pin', async () => {
    const deadAttempt = attemptEntry({ relayfileWorkspaceId: 'rw_pin' });
    const journal = memoryJournal([deadAttempt]);
    // Daemon answers without echoing the workspace — fail closed, retain.
    const relayfile = createRelayfileMock([], {
      listWebhookSubscriptions: vi.fn(async () => ({ workspaceId: undefined, subscriptions: [] })),
      resolveWritebackBinding: vi.fn(async () => ({
        url: WRITEBACK_URL,
        secret: 's3cr3t',
        workspaceId: 'rw_pin',
      })),
    });
    const { program } = harness({ relayfile, journal });

    await program.parseAsync(ARGS(), { from: 'user' }).catch(() => undefined);

    expect(journal.entries().some((e) => e.kind === 'subscribe-attempt' && e.owner === undefined)).toBe(true);
    expect(relayfile.deleteWebhookSubscription).not.toHaveBeenCalled();
  });

  it('pins the workspace before the cloud create and aborts when it cannot (fail closed)', async () => {
    const relayfile = createRelayfileMock([], {
      resolveWritebackBinding: vi.fn(async () => ({ url: WRITEBACK_URL, secret: 's3cr3t' })),
      listWebhookSubscriptions: vi.fn(async () => ({ workspaceId: undefined, subscriptions: [] })),
    });
    const { program, relay, error, exit } = harness({ relayfile });

    await program.parseAsync(ARGS(), { from: 'user' });

    expect(error).toHaveBeenCalledWith(expect.stringContaining('active relayfile workspace'));
    expect(exit).toHaveBeenCalledWith(1);
    expect(relay.webhooks.createInbound).not.toHaveBeenCalled();
    expect(relayfile.createWebhookSubscription).not.toHaveBeenCalled();
  });

  it('with --bridge-url overrides, consults the control plane for the workspace pin only (P1)', async () => {
    const resolveMock = vi.fn(async () => ({
      url: 'https://daemon-writeback.example',
      secret: 'daemon-secret',
      workspaceId: 'rw_bridge_pin',
    }));
    const relayfile = createRelayfileMock([], { resolveWritebackBinding: resolveMock });
    const { program, relay, exit } = harness({ relayfile });

    await program.parseAsync(ARGS(['--bridge-url', 'https://override.example', '--bridge-secret', 'shh']), {
      from: 'user',
    });

    expect(exit).not.toHaveBeenCalled();
    // The daemon was consulted for identity, but the OVERRIDE url/secret won:
    // the relay event subscription targets the override url (with the
    // per-attempt marker), never the daemon's writeback url.
    expect(resolveMock).toHaveBeenCalled();
    expect(relay.integrations.subscriptions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        url: expect.stringMatching(/^https:\/\/override\.example\?relaySubscribeAttempt=[0-9a-f]{16}$/),
        secret: 'shh',
      })
    );
    // ...and the pin flowed into the cloud create + binding.
    expect(relayfile.createWebhookSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: 'rw_bridge_pin' })
    );
    await expect(relayfile.listBindings()).resolves.toEqual([
      expect.objectContaining({ webhookSubscriptionWorkspaceId: 'rw_bridge_pin' }),
    ]);
  });

  it('with --bridge-url overrides, aborts before any create when no pin is obtainable (P1)', async () => {
    const relayfile = createRelayfileMock([], {
      resolveWritebackBinding: vi.fn(async () => undefined),
    });
    expect(relayfile.listWebhookSubscriptions).toBeUndefined();
    const { program, relay, error, exit } = harness({ relayfile });

    await program.parseAsync(ARGS(['--bridge-url', 'https://override.example', '--bridge-secret', 'shh']), {
      from: 'user',
    });

    expect(error).toHaveBeenCalledWith(expect.stringContaining('active relayfile workspace'));
    expect(exit).toHaveBeenCalledWith(1);
    expect(relay.webhooks.createInbound).not.toHaveBeenCalled();
    expect(relayfile.createWebhookSubscription).not.toHaveBeenCalled();
    expect(relay.integrations.subscriptions.create).not.toHaveBeenCalled();
  });

  it('pins recorded cloud entries to their workspace and converges 404 only when pinned', async () => {
    const pinned: PendingCleanupEntry = {
      kind: 'relayfile-webhook-subscription',
      scope: RELAYFILE_SCOPE,
      id: 'whsub_pinned',
      relayfileWorkspaceId: 'rw_old',
    };
    const unpinned: PendingCleanupEntry = {
      kind: 'relayfile-webhook-subscription',
      scope: RELAYFILE_SCOPE,
      id: 'whsub_unpinned',
    };
    const journal = memoryJournal([pinned, unpinned]);
    const relayfile = createRelayfileMock([], {
      deleteWebhookSubscription: vi.fn(async () => {
        throw new RelayfileControlPlaneError('BINDING_NOT_FOUND', 'gone', 404);
      }),
    });
    const { program, exit } = harness({ relayfile, journal });

    await program.parseAsync(ARGS(), { from: 'user' });

    expect(exit).not.toHaveBeenCalled();
    // The pinned delete carried its workspace and its 404 converged...
    expect(relayfile.deleteWebhookSubscription).toHaveBeenCalledWith('whsub_pinned', 'rw_old');
    expect(journal.entries().some((e) => e.id === 'whsub_pinned')).toBe(false);
    // ...the unpinned 404 might just be the wrong active workspace: retained.
    expect(journal.entries().some((e) => e.id === 'whsub_unpinned')).toBe(true);
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
    const journal = memoryJournal([attemptEntry({ relayfileWorkspaceId: 'rw_1' })]);
    const relayfile = createRelayfileMock([activeBinding], {
      listWebhookSubscriptions: vi.fn(async () => ({
        workspaceId: 'rw_1',
        subscriptions: [
          { subscriptionId: 'whsub_orphan', url: INBOUND_URL, pathGlobs: [RESOURCE] },
          { subscriptionId: 'whsub_active', url: INBOUND_URL, pathGlobs: [RESOURCE] },
          { subscriptionId: 'whsub_other_url', url: 'https://cast.test/other', pathGlobs: [RESOURCE] },
        ],
      })),
    });
    const { program, relayfile: bridge, exit } = harness({ relayfile, journal });

    await program.parseAsync(ARGS(), { from: 'user' });

    expect(exit).not.toHaveBeenCalled();
    // Only the unreferenced, key-matching orphan is deleted (pinned to rw_1)...
    expect(bridge.deleteWebhookSubscription).toHaveBeenCalledWith('whsub_orphan', 'rw_1');
    expect(bridge.deleteWebhookSubscription).not.toHaveBeenCalledWith('whsub_active', 'rw_1');
    expect(bridge.deleteWebhookSubscription).not.toHaveBeenCalledWith('whsub_other_url', 'rw_1');
    // ...the attempt is cleared, and the new subscribe proceeded normally.
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
    expect(relayfile.deleteWebhookSubscription).toHaveBeenCalledWith('whsub_1', 'rw_test');
  });
});

describe('integration unsubscribe', () => {
  it('aborts unsubscribe before deletes/unbind while a live subscribe holds the lease (P1)', async () => {
    const binding: RelayfileBinding = {
      provider: 'slack',
      resource: RESOURCE,
      channel: 'general',
      webhookId: 'wh_1',
      subscriptionId: 'sub_1',
    };
    const liveSubscribe = attemptEntry({
      owner: { pid: process.pid, host: os.hostname(), attemptId: 'live-subscribe' },
    });
    const journal = memoryJournal([liveSubscribe]);
    const relayfile = createRelayfileMock([binding]);
    const { program, relay, error, exit } = harness({ relayfile, journal });

    await program.parseAsync(['integration', 'unsubscribe', 'slack', '--resource', RESOURCE], {
      from: 'user',
    });

    expect(error).toHaveBeenCalledWith(expect.stringContaining('in progress'));
    expect(exit).toHaveBeenCalledWith(1);
    expect(relay.webhooks.delete).not.toHaveBeenCalled();
    expect(relayfile.deleteWebhookSubscription).not.toHaveBeenCalled();
    expect(relayfile.unbind).not.toHaveBeenCalled();
    // The live subscribe's lease is untouched.
    expect(journal.entries()).toEqual([liveSubscribe]);
  });

  it('aborts subscribe before creates while a live unsubscribe holds the lease (P1)', async () => {
    const liveUnsubscribe: PendingCleanupEntry = {
      kind: 'subscribe-attempt',
      operation: 'unsubscribe',
      scope: RELAYFILE_SCOPE,
      provider: 'slack',
      resource: RESOURCE,
      owner: {
        pid: process.pid,
        host: os.hostname(),
        attemptId: 'live-unsubscribe',
        heartbeatAt: Date.now(),
      },
    };
    const journal = memoryJournal([liveUnsubscribe]);
    const relayfile = createRelayfileMock();
    const { program, relay, error, exit } = harness({ relayfile, journal });

    await program.parseAsync(ARGS(), { from: 'user' });

    expect(error).toHaveBeenCalledWith(expect.stringContaining('in progress'));
    expect(exit).toHaveBeenCalledWith(1);
    expect(relay.webhooks.createInbound).not.toHaveBeenCalled();
    expect(relayfile.createWebhookSubscription).not.toHaveBeenCalled();
    expect(journal.entries()).toEqual([liveUnsubscribe]);
  });

  it('releases the unsubscribe reservation when aborting on a record failure, keeping the binding', async () => {
    const binding: RelayfileBinding = {
      provider: 'slack',
      resource: RESOURCE,
      channel: 'general',
      webhookId: 'wh_1',
      subscriptionId: 'sub_1',
      webhookSubscriptionId: 'whsub_1',
    };
    const journal = memoryJournal();
    let updates = 0;
    journal.update.mockImplementation(async (mutate) => {
      updates += 1;
      // 1st write = reservation, 2nd = failure record (fails), later =
      // release (succeeds).
      if (updates === 2) throw new Error('disk full');
      await memoryJournalApply(journal, mutate);
    });
    const relayfile = createRelayfileMock([binding], {
      deleteWebhookSubscription: vi.fn(async () => {
        throw new Error('cloud outage');
      }),
    });
    const { program, error, exit } = harness({ relayfile, journal });

    await program.parseAsync(['integration', 'unsubscribe', 'slack', '--resource', RESOURCE], {
      from: 'user',
    });

    expect(error).toHaveBeenCalledWith(expect.stringContaining('binding was left in place'));
    expect(exit).toHaveBeenCalledWith(1);
    expect(relayfile.unbind).not.toHaveBeenCalled();
    // The reservation is released even on the abort path — a wedged lease
    // would block every later lifecycle until this pid exits.
    expect(journal.entries()).toEqual([]);
  });

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
    expect(relayfile.deleteWebhookSubscription).toHaveBeenCalledWith('whsub_1', undefined);
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
    // The lifecycle reservation (first write) lands; the failure-record write
    // later is what fails.
    let updates = 0;
    journal.update.mockImplementation(async (mutate) => {
      updates += 1;
      if (updates > 1) throw new Error('disk full');
      await memoryJournalApply(journal, mutate);
    });
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
    let updates = 0;
    journal.update.mockImplementation(async (mutate) => {
      updates += 1;
      if (updates > 1) throw new Error('disk full');
      await memoryJournalApply(journal, mutate);
    });
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

  it('pins the unsubscribe delete to the binding workspace across a workspace switch', async () => {
    const binding: RelayfileBinding = {
      provider: 'slack',
      resource: RESOURCE,
      channel: 'general',
      webhookId: 'wh_1',
      subscriptionId: 'sub_1',
      webhookSubscriptionId: 'whsub_old_ws',
      webhookSubscriptionWorkspaceId: 'rw_old',
    };
    const relayfile = createRelayfileMock([binding], {
      deleteWebhookSubscription: vi.fn(async (_id: string, workspace?: string) => {
        // The daemon's ACTIVE workspace has switched to rw_new; only a
        // pinned delete reaches the right workspace.
        if (workspace !== 'rw_old') {
          throw new RelayfileControlPlaneError('BINDING_NOT_FOUND', 'not found', 404);
        }
      }),
    });
    const { program, exit } = harness({ relayfile });

    await program.parseAsync(['integration', 'unsubscribe', 'slack', '--resource', RESOURCE], {
      from: 'user',
    });

    expect(exit).not.toHaveBeenCalled();
    expect(relayfile.deleteWebhookSubscription).toHaveBeenCalledWith('whsub_old_ws', 'rw_old');
    expect(relayfile.unbind).toHaveBeenCalledWith('slack', RESOURCE);
  });

  it('records an unpinned 404 unsubscribe delete instead of discarding it', async () => {
    // Legacy binding without a workspace pin: a 404 might just be the wrong
    // active workspace, so the id must be recorded before unbind discards it.
    const binding: RelayfileBinding = {
      provider: 'slack',
      resource: RESOURCE,
      channel: 'general',
      webhookId: 'wh_1',
      subscriptionId: 'sub_1',
      webhookSubscriptionId: 'whsub_legacy',
    };
    const relayfile = createRelayfileMock([binding], {
      deleteWebhookSubscription: vi.fn(async () => {
        throw new RelayfileControlPlaneError('BINDING_NOT_FOUND', 'not found', 404);
      }),
    });
    const { program, journal, exit } = harness({ relayfile });

    await program.parseAsync(['integration', 'unsubscribe', 'slack', '--resource', RESOURCE], {
      from: 'user',
    });

    expect(exit).not.toHaveBeenCalled();
    expect(relayfile.unbind).toHaveBeenCalled();
    expect(journal.entries()).toEqual([
      { kind: 'relayfile-webhook-subscription', scope: RELAYFILE_SCOPE, id: 'whsub_legacy' },
    ]);
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
