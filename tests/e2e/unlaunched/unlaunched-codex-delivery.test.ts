/**
 * Phase 1's exit gate: a relay message reaches a **codex** session relay did
 * not launch, unprompted, exactly once.
 *
 *   "No current scenario delivers into a session relay did NOT launch. That
 *    capability is the entire point of the migration and nothing tests it
 *    today. [...] Until that exists there is no proof of the thing being
 *    claimed."   — docs/native-delivery-migration.md
 *
 * The phase-0 sibling (`unlaunched-delivery.test.ts`) proves the idea for the
 * one route that existed then — an attached `opencode serve` — and says in its
 * own header that it does NOT prove relay can reach a codex session, and that
 * `unlaunched-codex-delivery` belongs to phase 1. This is that scenario.
 *
 * What it asserts, in order, each as its own failure:
 *
 *   1. `codex queue` exists on the installed codex and documents the flags the
 *      backend invokes. This is the route's own precondition; a phase-1 claim
 *      is worthless on a codex that cannot queue.
 *   2. The session is not relay's. A bare `codex app-server` is started by this
 *      test, in an isolated CODEX_HOME, with no pty anywhere — and its parent
 *      pid is asserted to be this test process, not the broker.
 *   3. The session registers ITSELF: `set_workspace_key` then `register_agent`,
 *      called through the codex process's own MCP client against the relay MCP
 *      server codex spawned. Relay is not told about the session by relay.
 *   4. Relay accepts that already-running thread as a delivery target.
 *   5. A message sent to the registered name lands in the codex thread's own
 *      records — read back from codex, not from relay's telemetry — exactly
 *      once, and stays exactly once after the retry window has passed.
 *   6. No pty. The event kinds only a session relay OWNS can produce are
 *      asserted absent, with the phase-0 control proving those kinds still
 *      occur for a launched worker.
 *
 * Deliberately NOT skippable. `tests/relayflows/cleanroom/relay.matrix.json`
 * forbids `# SKIP` in this scenario's output precisely so a missing
 * prerequisite cannot read as a pass. Every prerequisite below fails.
 *
 * Config-safety: see `codex-session-host.ts`. CODEX_HOME is a temp directory
 * for every codex this file starts, including the capability probe, so the
 * operator's `~/.codex` is never read for state nor written.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { HarnessDriverClient, type BrokerEvent } from '@agent-relay/harness-driver';
import { RelayCast } from '@relaycast/sdk';

import {
  countOccurrences,
  parentPidOf,
  probeCodexQueueCapability,
  resolveCodexBinary,
  startUnlaunchedCodexSession,
  type CodexQueueCapability,
  type UnlaunchedCodexSession,
} from './codex-session-host.js';

/** Unique per run, so a stale thread or a reused workspace cannot satisfy it. */
const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const AGENT_NAME = `unlaunched-codex-${RUN.slice(-6)}`;
const SENDER = 'Lead';
/** The body token counted in the codex thread. Never a substring of anything else. */
const MARKER = `relay-unlaunched-codex-${RUN}`;
/** Marker the codex-queue backend carries so it can settle (`codex_thread.rs`). */
const ROUTE_MARKER_PREFIX = 'relay-delivery-id:';
const DELIVERY_WAIT_MS = Number(process.env.RELAY_UNLAUNCHED_DELIVERY_WAIT_MS ?? 120_000);
const TERMINAL_WAIT_MS = Number(process.env.RELAY_UNLAUNCHED_TERMINAL_WAIT_MS ?? 120_000);

/**
 * Event kinds only a session relay OWNS can produce: `delivery_verified` comes
 * from the pty/headless worker echo-checking a screen relay is reading, and
 * `worker_stream` is that stream. `unlaunched-delivery.test.ts` carries the
 * control that asserts both DO appear for a launched worker, so these absence
 * assertions cannot quietly become vacuous if a kind is renamed.
 */
const PTY_OWNED_SESSION_KINDS = ['delivery_verified', 'worker_stream'] as const;

function brokerBinary(): string {
  if (process.env.AGENT_RELAY_BIN) return process.env.AGENT_RELAY_BIN;
  const exe = process.platform === 'win32' ? 'agent-relay-broker.exe' : 'agent-relay-broker';
  for (const profile of ['release', 'debug']) {
    const candidate = path.resolve(process.cwd(), 'target', profile, exe);
    if (existsSync(candidate)) return candidate;
  }
  return exe;
}

/** The relay MCP stdio server, as an unlaunched codex would be configured to spawn it. */
function relayMcpEntrypoint(): string {
  return (
    process.env.RELAY_UNLAUNCHED_CLI_ENTRYPOINT?.trim() ||
    path.resolve(process.cwd(), 'packages/cli/dist/cli/index.js')
  );
}

let generatedWorkspaceKey: string | undefined;

async function resolveWorkspaceKey(): Promise<string> {
  // Generic workspace variables belong to the developer's ambient Relay
  // session and may name a legacy or non-canonical deployment. This clean-room
  // gate must not silently inherit them: use the dedicated override or create
  // a fresh workspace against the matching dedicated/default endpoint.
  const configured = process.env.RELAY_UNLAUNCHED_WORKSPACE_KEY?.trim() || '';
  if (configured) return configured;
  if (generatedWorkspaceKey) return generatedWorkspaceKey;
  const baseUrl = process.env.RELAY_UNLAUNCHED_BASE_URL?.trim();
  const workspace = await RelayCast.createWorkspace(`unlaunched-codex-${RUN}`, {
    ...(baseUrl ? { baseUrl } : {}),
  });
  if (!workspace.apiKey) {
    throw new Error('Relaycast workspace did not return an API key for the unlaunched Codex gate');
  }
  generatedWorkspaceKey = workspace.apiKey;
  return generatedWorkspaceKey;
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
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `${describeFailure} (waited ${timeoutMs}ms)${lastError ? `; last error: ${String(lastError)}` : ''}`
  );
}

/** Distinct `relay-delivery-id:<id>` values present in the thread's records. */
function routeMarkerIds(fragments: string[]): string[] {
  const ids = new Set<string>();
  for (const fragment of fragments) {
    for (const match of fragment.matchAll(/relay-delivery-id:([A-Za-z0-9_.:-]+)/g)) {
      ids.add(match[1]);
    }
  }
  return [...ids];
}

function markerRecordSummary(fragments: string[], marker: string): string {
  return JSON.stringify(
    fragments
      .filter((fragment) => fragment.includes(marker))
      .map((fragment) => {
        try {
          const record = JSON.parse(fragment) as Record<string, unknown>;
          const payload = (record.payload ?? {}) as Record<string, unknown>;
          const item = (record.item ?? payload.item ?? {}) as Record<string, unknown>;
          return {
            type: record.type,
            payloadType: payload.type,
            id: record.id ?? payload.id ?? item.id,
            turnId: record.turnId ?? record.turn_id ?? payload.turnId ?? payload.turn_id,
            itemType: item.type,
          };
        } catch {
          return { type: 'unparsed' };
        }
      })
  );
}

/** Safe route diagnostics: deliberately excludes message bodies, tokens, and workspace keys. */
function deliveryEventSummary(events: BrokerEvent[]): string {
  return events
    .map((event) => {
      const detail = event as {
        kind: string;
        name?: unknown;
        from?: unknown;
        to?: unknown;
        delivery_id?: unknown;
        event_id?: unknown;
        verification?: unknown;
        reason?: unknown;
        lastError?: unknown;
      };
      return JSON.stringify({
        kind: detail.kind,
        name: detail.name,
        from: detail.from,
        to: detail.to,
        delivery_id: detail.delivery_id,
        event_id: detail.event_id,
        verification: detail.verification,
        reason: detail.reason,
        lastError: detail.lastError,
      });
    })
    .join(', ');
}

describe('delivery into a codex session relay did not launch', () => {
  let codexBinary: string;
  let capability: CodexQueueCapability;
  let session: UnlaunchedCodexSession;
  let client: HarnessDriverClient;
  let key: string;
  let brokerStateDir: string;
  const events: BrokerEvent[] = [];
  const brokerStderr: string[] = [];
  const testPid = process.pid;

  beforeAll(async () => {
    const binary = resolveCodexBinary();
    expect(
      binary,
      'a real codex is required for the phase-1 gate; install it or set RELAY_UNLAUNCHED_CODEX_BIN'
    ).toBeTruthy();
    codexBinary = binary as string;

    // Precondition 1. Checked before anything is started, because everything
    // below is meaningless on a codex that cannot queue.
    capability = probeCodexQueueCapability(codexBinary);
    expect(
      capability.available,
      `the phase-1 route is unavailable on the installed codex: ${capability.reason}. ` +
        '`codex queue --thread <uuid> --message=<text>` is the command this phase delivers over ' +
        '(docs/native-delivery-migration.md, Phase 1); without it there is no route to gate.'
    ).toBe(true);

    const entrypoint = relayMcpEntrypoint();
    expect(
      existsSync(entrypoint),
      `the relay MCP entrypoint ${entrypoint} is missing; run \`npm run build:core\` ` +
        'or set RELAY_UNLAUNCHED_CLI_ENTRYPOINT'
    ).toBe(true);

    key = await resolveWorkspaceKey();
    expect(
      key.length,
      'this gate needs a hosted workspace and two registered identities (verify_tier 4): ' +
        'set RELAY_UNLAUNCHED_WORKSPACE_KEY if automatic workspace creation is unavailable'
    ).toBeGreaterThan(0);

    const relayBaseUrl = process.env.RELAY_UNLAUNCHED_BASE_URL?.trim();
    const brokerEnv = { ...process.env };
    for (const variable of [
      'RELAY_API_KEY',
      'RELAY_WORKSPACE_KEY',
      'AGENT_RELAY_WORKSPACE_KEY',
      'RELAY_BASE_URL',
      'RELAYCAST_BASE_URL',
    ]) {
      delete brokerEnv[variable];
    }
    brokerEnv.RELAY_API_KEY = key;
    if (relayBaseUrl) brokerEnv.RELAYCAST_BASE_URL = relayBaseUrl;

    client = await HarnessDriverClient.spawn({
      binaryPath: brokerBinary(),
      // A failed or interrupted hosted run may not reach `shutdown()`. Reusing
      // the worktree basename would then collide with that run's still-owned
      // broker identity and make a clean retry fail before the scenario starts.
      brokerName: `unlaunched-broker-${RUN}`,
      channels: ['general'],
      binaryArgs: {
        persist: true,
        stateDir: (brokerStateDir = mkdtempSync(path.join(tmpdir(), 'relay-unlaunched-broker-'))),
      },
      env: { ...brokerEnv, RUST_LOG: process.env.RUST_LOG ?? 'info' },
      onStderr: (line) => {
        brokerStderr.push(line);
        if (brokerStderr.length > 200) brokerStderr.shift();
      },
    });
    client.onEvent((event) => {
      events.push(event);
    });

    const connection = JSON.parse(readFileSync(path.join(brokerStateDir, 'connection.json'), 'utf8')) as {
      url?: unknown;
      api_key?: unknown;
    };
    expect(typeof connection.url).toBe('string');
    expect(typeof connection.api_key).toBe('string');

    // Precondition 2. A bare codex, started here, over stdio, with no pty.
    session = await startUnlaunchedCodexSession({
      binary: codexBinary,
      relayMcp: {
        command: process.execPath,
        args: [entrypoint, 'mcp'],
        // The MCP server gets no agent token: an unlaunched session has not been
        // minted one. It mints its own in `register_agent`, below, which is the
        // whole difference between this and a spawned worker. Broker credentials
        // only authorize the local attach half of that same tool call.
        env: {
          AGENT_RELAY_TELEMETRY_DISABLED: '1',
          RELAY_BROKER_URL: connection.url as string,
          RELAY_BROKER_API_KEY: connection.api_key as string,
          // `startUnlaunchedCodexSession` deliberately strips every RELAY_*
          // variable from the bare Codex process so it cannot auto-register.
          // Carry the selected Relaycast deployment back into the MCP child
          // explicitly; otherwise a key for a non-default deployment is sent
          // to production and `register_agent` reports "Invalid API key".
          ...(relayBaseUrl ? { RELAY_BASE_URL: relayBaseUrl } : {}),
        },
      },
    });
  }, 300_000);

  afterAll(async () => {
    try {
      await client?.release(AGENT_NAME, 'unlaunched codex gate complete');
    } catch {
      // Release failures must not mask an assertion result.
    }
    try {
      await client?.shutdown();
    } catch {
      // Same.
    }
    await session?.stop();
    if (brokerStateDir && process.env.RELAY_KEEP_UNLAUNCHED_STATE !== '1') {
      rmSync(brokerStateDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('the installed codex exposes the `codex queue` route this phase delivers over', () => {
    expect(capability.available, capability.reason).toBe(true);
  });

  it('the codex session is not a broker child', () => {
    const parent = parentPidOf(session.pid);
    expect(parent, 'could not read the codex session pid lineage').not.toBeNull();
    expect(
      parent,
      `the codex session (pid ${session.pid}) must be a child of this test (pid ${testPid}); ` +
        'if relay launched it, the scenario proves nothing'
    ).toBe(testPid);
  });

  it('the session registers itself with set_workspace_key then register_agent', async () => {
    const keyed = await session.callRelayTool('set_workspace_key', { workspace_key: key });
    expect(keyed.isError, `set_workspace_key failed inside the codex session: ${keyed.text}`).toBe(false);

    const registered = await session.callRelayTool('register_agent', {
      name: AGENT_NAME,
      type: 'agent',
      native_delivery: {
        provider: 'codex',
        thread_id: session.threadId,
      },
    });
    expect(registered.isError, `register_agent failed inside the codex session: ${registered.text}`).toBe(
      false
    );
    // The registration is the session's own, so its own name must come back.
    expect(registered.text).toContain(AGENT_NAME);
    const result = registered.structuredContent as {
      token?: unknown;
      native_delivery?: { route?: unknown; owns_session?: unknown };
    } | null;
    expect(typeof result?.token, 'register_agent did not return the session-owned agent token').toBe(
      'string'
    );
    expect(result?.native_delivery?.route).toBe('codex-queue');
    expect(result?.native_delivery?.owns_session).toBe(false);
  }, 120_000);

  it('the thread carries no relay conversation before relay sends one', async () => {
    const fragments = await session.readThreadText();
    expect(countOccurrences(fragments, MARKER)).toBe(0);
    expect(routeMarkerIds(fragments)).toEqual([]);
  });

  it('self-registration makes the already-running Codex thread addressable', async () => {
    const listed = await waitFor(
      async () => (await client.listAgents()).find((agent) => agent.name === AGENT_NAME),
      30_000,
      `register_agent never made ${AGENT_NAME} addressable as a native Codex target`
    );
    expect((listed as { runtime?: string }).runtime, 'a pty runtime means relay owns a terminal').not.toBe(
      'pty'
    );

    const inventory = await waitFor(
      async () => {
        const snapshot = await client.listFleetInventory();
        return snapshot.agents.find((agent) => agent.name === AGENT_NAME);
      },
      30_000,
      `register_agent attached ${AGENT_NAME} locally but did not publish it in node inventory`
    );
    expect(inventory.session_ref, 'the attached codex thread is absent from node inventory').toBe(
      session.threadId
    );
  }, 120_000);

  it('a relay message reaches the codex thread, unprompted and exactly once', async () => {
    const result = await client.sendMessage({ to: AGENT_NAME, from: SENDER, text: MARKER, mode: 'steer' });
    expect(result.event_id, 'relay refused the send outright').not.toBe('unsupported_operation');

    try {
      await waitFor(
        async () => {
          const fragments = await session.readThreadText();
          return countOccurrences(fragments, MARKER) > 0 ? true : undefined;
        },
        DELIVERY_WAIT_MS,
        'the message never reached the codex thread: relay could not deliver into a codex session it did not launch'
      );
    } catch (error) {
      const sendStatus = result as unknown as Record<string, unknown>;
      throw new Error(
        `${String(error)}; send status: ${JSON.stringify({
          delivery_status: sendStatus.delivery_status,
          recipient_live: sendStatus.recipient_live,
          recipient_status: sendStatus.recipient_status,
          local: sendStatus.local,
        })}; broker route events: [${deliveryEventSummary(events)}]; broker stderr tail: ${brokerStderr.join(
          '\n'
        )}`
      );
    }

    const fragments = await session.readThreadText();
    expect(
      countOccurrences(fragments, MARKER),
      'the message body appears in the codex thread more than once: relay re-sent a delivery it had already handed over; ' +
        markerRecordSummary(fragments, MARKER)
    ).toBe(1);
    const markerIds = routeMarkerIds(fragments);
    expect(markerIds, `expected exactly one ${ROUTE_MARKER_PREFIX} marker for this send`).toHaveLength(1);
    const deliveryId = markerIds[0];

    let terminalDelivery: BrokerEvent;
    try {
      terminalDelivery = await waitFor(
        async () => {
          const terminal = events.find(
            (event) =>
              (event.kind === 'message_delivery_confirmed' || event.kind === 'message_delivery_failed') &&
              (event as { name?: unknown }).name === AGENT_NAME &&
              (event as { delivery_id?: unknown }).delivery_id === deliveryId
          );
          return terminal;
        },
        TERMINAL_WAIT_MS,
        'relay never reported a terminal delivery outcome after codex queue handoff'
      );
    } catch (error) {
      throw new Error(`${String(error)}; broker route events: [${deliveryEventSummary(events)}]`);
    }
    expect(
      terminalDelivery.kind,
      `codex queue delivery reached the thread but relay reported failure: ${deliveryEventSummary(events)}`
    ).toBe('message_delivery_confirmed');
    expect(
      (terminalDelivery as { event_id?: unknown }).event_id,
      'confirmed delivery event did not name the Relaycast message id'
    ).toBeTruthy();
    const settledFragments = await session.readThreadText();
    expect(
      countOccurrences(settledFragments, MARKER),
      'the settled message was injected more than once; ' + markerRecordSummary(settledFragments, MARKER)
    ).toBe(1);
    expect(routeMarkerIds(settledFragments)).toEqual([deliveryId]);
  }, 300_000);

  it('the delivery used the native route, not a PTY', async () => {
    const kinds = new Set(
      events.filter((event) => (event as { name?: unknown }).name === AGENT_NAME).map((event) => event.kind)
    );
    for (const ownedSessionOnly of PTY_OWNED_SESSION_KINDS) {
      expect(
        [...kinds],
        `${ownedSessionOnly} means relay owned this session's terminal or stdout`
      ).not.toContain(ownedSessionOnly);
    }
    // And the process is still not relay's, after delivery as before it.
    expect(parentPidOf(session.pid)).toBe(testPid);
  });
});
