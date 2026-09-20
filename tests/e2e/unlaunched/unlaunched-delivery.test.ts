/**
 * The gate `docs/native-delivery-migration.md` says does not exist yet:
 *
 *   "No current scenario delivers into a session relay did NOT launch. That
 *    capability is the entire point of the migration and nothing tests it
 *    today. [...] Until that exists there is no proof of the thing being
 *    claimed."
 *
 * This is that proof, for the one route that exists today. A session host is
 * started here, by the test — not by `spawnPty`, not by `agent-relay-broker
 * wrap`, not by the broker at all — a session is created inside it through the
 * host's own API, and only then is relay told the endpoint. Relay then has to
 * put a message into that session.
 *
 * What it proves, exactly:
 *   - relay delivered into a session process it did not start (asserted by pid
 *     lineage, not by claim),
 *   - the message landed in the session's own conversation, read back from the
 *     host rather than from relay's telemetry,
 *   - it arrived unprompted: the session never asked relay for anything, and
 *     no PTY, no `wrap` and no inbox poll was involved.
 *
 * What it does NOT prove, and must not be read as proving: that relay can
 * discover and reach a `claude` or `codex` session it has never heard of.
 * Those routes do not exist yet; they are phases 1 and 2, and they own the
 * `unlaunched-codex-delivery` / `unlaunched-claude-delivery` scenarios.
 *
 * Deliberately NOT skippable. A skipped scenario reading as a pass is exactly
 * the failure this gate exists to prevent, which is why the cleanroom matrix
 * forbids `# SKIP` in its output. Missing prerequisites fail the suite.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { HarnessDriverClient, type BrokerEvent } from '@agent-relay/harness-driver';

import {
  parentPidOf,
  readSessionTextParts,
  resolveOpencodeBinary,
  startUnlaunchedSession,
  type UnlaunchedSession,
} from './session-host.js';

const AGENT_NAME = `unlaunched-${Math.random().toString(36).slice(2, 8)}`;
/** Unique per run so a stale session in a reused host cannot satisfy the test. */
const MARKER = `relay-unlaunched-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const SENDER = 'Lead';
/**
 * Event kinds only a session relay OWNS can produce: `delivery_verified` comes
 * from `pty_worker.rs` / `runtime/headless.rs` echo-checking a screen relay is
 * reading, and `worker_stream` is that stream. The control case at the bottom
 * of this file spawns a real PTY worker and asserts both DO appear, so the
 * absence assertions above cannot quietly become vacuous if a kind is renamed.
 */
const PTY_OWNED_SESSION_KINDS = ['delivery_verified', 'worker_stream'] as const;

function brokerBinary(): string {
  if (process.env.AGENT_RELAY_BIN) return process.env.AGENT_RELAY_BIN;
  const exe = process.platform === 'win32' ? 'agent-relay-broker.exe' : 'agent-relay-broker';
  for (const profile of ['debug', 'release']) {
    const candidate = path.resolve(process.cwd(), 'target', profile, exe);
    if (existsSync(candidate)) return candidate;
  }
  return exe;
}

async function waitFor<T>(
  read: () => Promise<T | undefined>,
  timeoutMs: number,
  describeFailure: string
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `${describeFailure} (waited ${timeoutMs}ms)${lastError ? `; last error: ${String(lastError)}` : ''}`
  );
}

describe('delivery into a session relay did not launch', () => {
  let session: UnlaunchedSession;
  let client: HarnessDriverClient;
  let events: BrokerEvent[] = [];
  /** PID of this test process — the host's expected parent. */
  const testPid = process.pid;

  beforeAll(async () => {
    const binary = resolveOpencodeBinary();
    // Fail, never skip: the whole point of this gate is that its absence is
    // visible. See the cleanroom row's `forbidOutput: ["# SKIP"]`.
    expect(
      binary,
      'the unlaunched-session host binary is required; set RELAY_UNLAUNCHED_OPENCODE_BIN or install opencode'
    ).toBeTruthy();

    session = await startUnlaunchedSession({
      binary: binary as string,
      title: `relay unlaunched gate ${MARKER}`,
    });

    client = await HarnessDriverClient.spawn({
      binaryPath: brokerBinary(),
      channels: ['general'],
      env: process.env,
    });
    client.onEvent((event) => {
      events.push(event);
    });

    // Relay is handed an endpoint and a session id. It is not given a command
    // to run, and `host.ownership: 'attached'` is the broker's own word for
    // "this process is not mine" — `validate_app_server_config` rejects
    // `broker-owned` outright (crates/broker/src/worker.rs).
    await client.spawnHeadless({
      name: AGENT_NAME,
      cli: 'opencode',
      channels: ['general'],
      harnessConfig: {
        runtime: 'headless',
        driver: 'app_server',
        protocol: 'opencode',
        endpoint: session.endpoint,
        sessionId: session.sessionId,
        host: { ownership: 'attached', pid: session.pid },
        // Never abort or delete a session relay does not own.
        release: 'detach',
      },
    });

    await waitFor(
      async () => (await client.listAgents()).find((agent) => agent.name === AGENT_NAME),
      30_000,
      `relay never registered ${AGENT_NAME} as an addressable agent`
    );
  }, 120_000);

  afterAll(async () => {
    try {
      await client?.release(AGENT_NAME, 'unlaunched gate complete');
    } catch {
      // Release failures must not mask an assertion result.
    }
    try {
      await client?.shutdown();
    } catch {
      // Same.
    }
    await session?.stop();
  }, 60_000);

  it('the session host is not a broker child', () => {
    const parent = parentPidOf(session.pid);
    expect(parent, 'could not read the session host pid lineage').not.toBeNull();
    expect(
      parent,
      `the session host (pid ${session.pid}) must be a child of this test (pid ${testPid}), ` +
        'otherwise relay launched it and the scenario proves nothing'
    ).toBe(testPid);
  });

  it('the session carries no relay conversation before relay sends one', async () => {
    const parts = await readSessionTextParts(session);
    expect(parts.map((part) => part.text).join('\n')).not.toContain(MARKER);
  });

  it('a relay message reaches the session, unprompted', async () => {
    const result = await client.sendMessage({
      to: AGENT_NAME,
      from: SENDER,
      text: MARKER,
    });
    expect(result.event_id, 'relay refused the send outright').not.toBe('unsupported_operation');

    const arrived = await waitFor(
      async () => {
        const parts = await readSessionTextParts(session);
        return parts.find((part) => part.role === 'user' && part.text.includes(MARKER));
      },
      60_000,
      `the message never reached the session: relay could not deliver into a session it did not launch`
    );

    // The body arrives verbatim inside the relay envelope the app-server
    // driver formats (`format_app_server_delivery`), addressed to this session
    // and not truncated, escaped or re-evaluated.
    expect(arrived.text).toContain(AGENT_NAME);
    expect(arrived.text).toContain(MARKER);

    // Relay received it from the named sender. The envelope the session sees
    // renders `delivery.from`, which the workspace round trip resolves to the
    // broker identity when the sender is not itself a registered agent -- so
    // the sender is asserted where relay actually reports it rather than
    // against a string the session was never going to be shown.
    const inbound = events.find(
      (event) => event.kind === 'relay_inbound' && (event as { target?: unknown }).target === AGENT_NAME
    );
    expect(inbound, 'relay never recorded an inbound message for this session').toBeTruthy();
    expect((inbound as unknown as { from?: string }).from).toBe(SENDER);
    expect((inbound as unknown as { body?: string }).body).toBe(MARKER);
  }, 120_000);

  it('the delivery used a push route, not a PTY and not a poll', async () => {
    await waitFor(
      async () =>
        events.find(
          (event) =>
            event.kind === 'message_delivery_confirmed' && (event as { name?: unknown }).name === AGENT_NAME
        ),
      30_000,
      'relay never confirmed the delivery it had already put into the session'
    );
    // PTY verification runs AFTER injection, inside
    // `delivery_verification::VERIFICATION_WINDOW`. Settling past it is what
    // turns "no terminal events yet" into "no terminal events".
    await new Promise((resolve) => setTimeout(resolve, 3_000));

    const kinds = new Set(
      events.filter((event) => (event as { name?: unknown }).name === AGENT_NAME).map((event) => event.kind)
    );

    // The app-server driver acks the `deliver_relay` frame once its own HTTP
    // POST lands. A PTY route would additionally have echo-verified the
    // injection off the terminal screen; asserting that absence is what makes
    // "no PTY" a check rather than a claim.
    expect(
      [...kinds],
      'expected an app-server delivery ack; relay reported no completed delivery for this session'
    ).toContain('delivery_ack');
    // `delivery_verified` is emitted only by `pty_worker.rs` and
    // `runtime/headless.rs` -- the two workers whose output relay owns and can
    // echo-check. `worker_stream` is the output stream itself. Neither can
    // appear for a session relay merely POSTs to. `delivery_read_ack` is NOT
    // in this list: it is a workspace read receipt and rides every transport,
    // so forbidding it would be asserting something untrue.
    for (const ownedSessionOnly of PTY_OWNED_SESSION_KINDS) {
      expect(
        [...kinds],
        `${ownedSessionOnly} means relay owned this session's terminal or stdout`
      ).not.toContain(ownedSessionOnly);
    }
  }, 60_000);

  it('relay addresses a process it never forked', () => {
    const spawned = events.find(
      (event) => event.kind === 'agent_spawned' && (event as { name?: unknown }).name === AGENT_NAME
    );
    expect(spawned, 'relay never announced the attached session').toBeTruthy();
    // Relay reports the attached host's own pid. Combined with the lineage
    // check above -- that pid's parent is this test -- this is the whole claim
    // in two assertions: relay is delivering to a process it did not fork.
    expect((spawned as unknown as { pid?: number }).pid).toBe(session.pid);
    expect((spawned as unknown as { runtime?: string }).runtime).not.toBe('pty');
  });

  it('relay reports the session as a non-PTY agent', async () => {
    const listed = (await client.listAgents()).find((agent) => agent.name === AGENT_NAME);
    expect(listed, `${AGENT_NAME} vanished from the agent directory`).toBeTruthy();
    expect(
      (listed as { runtime?: string }).runtime,
      'a pty runtime means relay owns a terminal for this session'
    ).not.toBe('pty');
  });
});

/**
 * The control. Every assertion above is an ABSENCE -- no terminal, no output
 * stream -- and an absence assertion is worthless if the thing can no longer
 * occur at all. So the same kinds are asserted PRESENT for a worker relay did
 * launch, over the same broker and the same send path. If a kind is renamed or
 * retired, this fails rather than silently gutting the unlaunched case.
 */
describe('control: the same assertions against a session relay DID launch', () => {
  const controlName = `launched-${Math.random().toString(36).slice(2, 8)}`;
  const controlMarker = `relay-launched-${Date.now().toString(36)}`;
  let client: HarnessDriverClient;
  const events: BrokerEvent[] = [];

  beforeAll(async () => {
    client = await HarnessDriverClient.spawn({
      binaryPath: brokerBinary(),
      channels: ['general'],
      env: process.env,
    });
    client.onEvent((event) => {
      events.push(event);
    });
    // `cat` echoes its stdin, which is what lets PTY echo-verification settle.
    await client.spawnPty({ name: controlName, cli: 'cat', channels: ['general'] });
    await waitFor(
      async () => (await client.listAgents()).find((agent) => agent.name === controlName),
      30_000,
      `relay never registered the control worker ${controlName}`
    );
  }, 120_000);

  afterAll(async () => {
    try {
      await client?.release(controlName, 'control complete');
    } catch {
      // Never mask an assertion result.
    }
    try {
      await client?.shutdown();
    } catch {
      // Same.
    }
  }, 60_000);

  it('a PTY worker produces the kinds the unlaunched case forbids', async () => {
    await client.sendMessage({ to: controlName, from: SENDER, text: controlMarker });
    for (const kind of PTY_OWNED_SESSION_KINDS) {
      await waitFor(
        async () =>
          events.find((event) => event.kind === kind && (event as { name?: unknown }).name === controlName),
        45_000,
        `a PTY worker produced no ${kind}: the unlaunched case's "no ${kind}" assertion proves nothing`
      );
    }
  }, 120_000);
});
