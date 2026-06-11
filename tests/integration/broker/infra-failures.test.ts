/**
 * Broker infrastructure-failure integration tests.
 *
 * Covers delivery durability and observability when the infrastructure
 * itself fails, rather than the agent protocol:
 * - pending deliveries survive a broker crash (SIGKILL) and reload on restart
 * - graceful shutdown persists undelivered pending deliveries
 * - per-worker queue overflow (MAX_PENDING_PER_WORKER) emits delivery_dropped
 * - echo-verification timeouts are reported as timeout_fallback, not success
 *
 * Run:
 *   npx tsc -p tests/integration/broker/tsconfig.json
 *   node --test tests/integration/broker/dist/infra-failures.test.js
 *
 * Requires:
 *   RELAY_API_KEY — Relaycast workspace key (auto-provisioned if unset)
 *   AGENT_RELAY_BIN (optional) — path to agent-relay-broker binary
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import type { BrokerEvent } from '@agent-relay/harness-driver';
import { BrokerHarness, checkPrerequisites, uniqueSuffix } from './utils/broker-harness.js';
import { assertNoDroppedDeliveries } from './utils/assert-helpers.js';

function skipIfMissing(t: TestContext): boolean {
  const reason = checkPrerequisites();
  if (reason) {
    t.skip(reason);
    return true;
  }
  return false;
}

// ── Fixtures ────────────────────────────────────────────────────────────────

/**
 * A PTY recipient that never echoes injected text back: it disables TTY echo
 * and discards stdin. Deliveries to it are injected but can never be
 * echo-verified, so they stay in the pending-deliveries map until the
 * verification window (5s) acks them via timeout fallback.
 */
const SINK_CLI = 'sh';
const SINK_ARGS = ['-c', 'stty -echo; printf "SINK_READY\\n"; exec cat > /dev/null'];

/** Per-worker pending queue cap in the broker (types.rs MAX_PENDING_PER_WORKER). */
const MAX_PENDING_PER_WORKER = 256;

interface PersistedPendingDelivery {
  worker_name: string;
  delivery: {
    delivery_id: string;
    event_id: string;
    from: string;
    target: string;
    body: string;
  };
  attempts: number;
}

/** Path of the broker's pending-deliveries snapshot for a given state dir + broker name. */
function pendingFilePath(stateDir: string, brokerName: string): string {
  return path.join(stateDir, `pending-${brokerName}.json`);
}

function readPendingFile(filePath: string): PersistedPendingDelivery[] | null {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as PersistedPendingDelivery[];
}

/** Poll until `check` returns truthy or the deadline passes. */
async function pollUntil<T>(
  check: () => T | null | undefined | false,
  timeoutMs: number,
  intervalMs = 100,
  label = 'condition'
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = check();
    if (result) return result;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function spawnSink(harness: BrokerHarness, name: string): Promise<void> {
  await harness.client.spawnPty({
    name,
    cli: SINK_CLI,
    args: SINK_ARGS,
    channels: ['general'],
  });
  await harness.waitForEvent('agent_spawned', 15_000, (e) => e.kind === 'agent_spawned' && e.name === name)
    .promise;
}

function makeTempDirs(prefix: string): { cwd: string; stateDir: string } {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const stateDir = path.join(cwd, 'state');
  return { cwd, stateDir };
}

// ── Crash recovery ──────────────────────────────────────────────────────────

test(
  'infra: pending deliveries survive broker SIGKILL and are reloaded on restart',
  { timeout: 240_000 },
  async (t) => {
    if (skipIfMissing(t)) return;

    const { cwd, stateDir } = makeTempDirs('relay-infra-crash-');
    const suffix = uniqueSuffix();
    const brokerName = `infra-crash-${suffix}`;
    const pendingPath = pendingFilePath(stateDir, brokerName);
    const echoer = `echoer-${suffix}`;
    const sink = `sink-${suffix}`;

    const opts = { cwd, brokerName, binaryArgs: { persist: true, stateDir } };
    const phase1 = new BrokerHarness(opts);
    let phase2: BrokerHarness | undefined;
    let killedPid: number | undefined;

    try {
      await phase1.start();

      // An echoing recipient (PTY echo verifies quickly) and a sink that
      // can never ack via echo.
      await phase1.spawnAgent(echoer);
      await phase1.waitForEvent(
        'agent_spawned',
        15_000,
        (e) => e.kind === 'agent_spawned' && e.name === echoer
      ).promise;
      await spawnSink(phase1, sink);

      // Deliver one message fully (acked) — it must NOT survive as pending.
      const acked = await phase1.sendMessage({ to: echoer, from: 'infra-test', text: 'deliver me fully' });
      await phase1.waitForEvent(
        'delivery_ack',
        20_000,
        (e) => e.kind === 'delivery_ack' && e.name === echoer && e.event_id === acked.event_id
      ).promise;

      // Two in-flight deliveries to the sink — injected but never echo-acked.
      const inflight1 = await phase1.sendMessage({ to: sink, from: 'infra-test', text: 'in flight 1' });
      const inflight2 = await phase1.sendMessage({ to: sink, from: 'infra-test', text: 'in flight 2' });
      const inflightIds = [inflight1.event_id, inflight2.event_id];
      for (const eventId of inflightIds) {
        await phase1.waitForEvent(
          'delivery_injected',
          10_000,
          (e) => e.kind === 'delivery_injected' && e.name === sink && e.event_id === eventId
        ).promise;
      }

      // The pending snapshot is flushed on every map mutation; wait for it to
      // contain both in-flight deliveries, then SIGKILL inside the 5s
      // verification window (before the timeout-fallback ack removes them).
      await pollUntil(
        () => {
          const entries = readPendingFile(pendingPath);
          return entries && inflightIds.every((id) => entries.some((p) => p.delivery.event_id === id))
            ? entries
            : null;
        },
        3_000,
        50,
        'pending file to contain in-flight deliveries'
      );

      killedPid = phase1.client.brokerPid;
      assert.ok(killedPid, 'broker pid should be known');
      process.kill(killedPid, 'SIGKILL');
      await pollUntil(() => !isProcessAlive(killedPid as number), 10_000, 50, 'broker process to die');

      // Crash durability: file holds exactly the unacked deliveries.
      const persisted = readPendingFile(pendingPath);
      assert.ok(persisted, 'pending-deliveries file should survive SIGKILL');
      const persistedIds = persisted.map((p) => p.delivery.event_id).sort();
      assert.deepEqual(
        persistedIds,
        [...inflightIds].sort(),
        'persisted pending deliveries should be exactly the unacked in-flight messages'
      );
      for (const entry of persisted) {
        assert.equal(entry.worker_name, sink, 'pending entries should target the sink worker');
      }
      assert.ok(
        !persisted.some((p) => p.delivery.event_id === acked.event_id),
        'an already-acked delivery must not be persisted as pending (no duplicate redelivery)'
      );

      // Restart with the same state dir: the broker must reload the pending
      // deliveries and attempt redelivery. The sink process died with the
      // broker, so each reloaded delivery surfaces as message_delivery_failed
      // ("recipient gone") — proving it was reloaded and retried rather than
      // silently dropped.
      phase2 = new BrokerHarness(opts);
      await phase2.start();
      for (const eventId of inflightIds) {
        await phase2.waitForEvent(
          'message_delivery_failed',
          30_000,
          (e) => e.kind === 'message_delivery_failed' && e.name === sink && e.event_id === eventId
        ).promise;
      }

      // Dedup: the restarted broker must not re-handle the already-acked
      // delivery in any way.
      const phase2Events = phase2.getEvents();
      const ackedRefs = phase2Events.filter(
        (e: BrokerEvent) => 'event_id' in e && (e as { event_id?: string }).event_id === acked.event_id
      );
      assert.equal(
        ackedRefs.length,
        0,
        `restarted broker should not reference the acked delivery; got: ${JSON.stringify(ackedRefs)}`
      );
    } finally {
      if (killedPid && isProcessAlive(killedPid)) {
        try {
          process.kill(killedPid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
      await phase1.stop();
      if (phase2) await phase2.stop();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }
);

// ── Graceful shutdown persistence ───────────────────────────────────────────

test(
  'infra: graceful shutdown persists undelivered pending deliveries',
  { timeout: 120_000 },
  async (t) => {
    if (skipIfMissing(t)) return;

    const { cwd, stateDir } = makeTempDirs('relay-infra-shutdown-');
    const suffix = uniqueSuffix();
    const brokerName = `infra-shutdown-${suffix}`;
    const pendingPath = pendingFilePath(stateDir, brokerName);
    const sink = `sink-${suffix}`;

    const harness = new BrokerHarness({ cwd, brokerName, binaryArgs: { persist: true, stateDir } });

    try {
      await harness.start();
      await spawnSink(harness, sink);

      const msg1 = await harness.sendMessage({ to: sink, from: 'infra-test', text: 'undelivered 1' });
      const msg2 = await harness.sendMessage({ to: sink, from: 'infra-test', text: 'undelivered 2' });
      const eventIds = [msg1.event_id, msg2.event_id];
      for (const eventId of eventIds) {
        await harness.waitForEvent(
          'delivery_injected',
          10_000,
          (e) => e.kind === 'delivery_injected' && e.name === sink && e.event_id === eventId
        ).promise;
      }

      // Clean shutdown while both deliveries are still awaiting verification.
      // Regression test for the old behavior where shutdown cleared the
      // pending map before persisting, losing undelivered messages.
      await harness.stop();

      const persisted = readPendingFile(pendingPath);
      assert.ok(persisted, 'pending-deliveries file must survive a graceful shutdown with entries');
      const persistedIds = persisted.map((p) => p.delivery.event_id).sort();
      assert.deepEqual(
        persistedIds,
        [...eventIds].sort(),
        'graceful shutdown should persist exactly the undelivered entries'
      );
    } finally {
      await harness.stop();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }
);

// ── Queue overflow observability ────────────────────────────────────────────

test(
  'infra: queue overflow past MAX_PENDING_PER_WORKER emits delivery_dropped for the oldest messages',
  { timeout: 240_000 },
  async (t) => {
    if (skipIfMissing(t)) return;

    const harness = new BrokerHarness();
    await harness.start();
    const suffix = uniqueSuffix();
    const agentName = `overflow-${suffix}`;
    const overflow = 4;
    const total = MAX_PENDING_PER_WORKER + overflow;

    try {
      await harness.spawnAgent(agentName);
      await harness.waitForEvent(
        'agent_spawned',
        15_000,
        (e) => e.kind === 'agent_spawned' && e.name === agentName
      ).promise;

      // Park every inbound message in the per-worker queue so nothing drains.
      const modeResult = await harness.client.setInboundDeliveryMode(agentName, 'manual_flush');
      assert.equal(modeResult.mode, 'manual_flush');

      // The first `overflow` senders must be enqueued in a known order so we
      // can assert the eviction policy drops the oldest; the rest can be
      // pipelined for speed.
      const sequentialHead = overflow * 2;
      for (let i = 0; i < sequentialHead; i++) {
        await harness.sendMessage({ to: agentName, from: `ofsender-${i}`, text: `overflow message ${i}` });
      }
      const chunkSize = 28;
      for (let start = sequentialHead; start < total; start += chunkSize) {
        const chunk = [];
        for (let i = start; i < Math.min(start + chunkSize, total); i++) {
          chunk.push(
            harness.sendMessage({ to: agentName, from: `ofsender-${i}`, text: `overflow message ${i}` })
          );
        }
        await Promise.all(chunk);
      }

      // Exactly `overflow` evictions, each surfaced as a delivery_dropped event.
      const dropped = await pollUntil(
        () => {
          const events = harness
            .getEventsByKind('delivery_dropped')
            .filter((e) => 'name' in e && e.name === agentName);
          return events.length >= overflow ? events : null;
        },
        30_000,
        100,
        `${overflow} delivery_dropped events`
      );
      assert.equal(dropped.length, overflow, 'one delivery_dropped event per evicted message');

      // The evicted messages are the oldest, in enqueue order.
      dropped.forEach((event, i) => {
        assert.equal(event.kind, 'delivery_dropped');
        if (event.kind !== 'delivery_dropped') return;
        assert.equal(event.count, 1, 'each cap eviction drops exactly one message');
        assert.match(
          event.reason,
          new RegExp(`pending queue full \\(max ${MAX_PENDING_PER_WORKER}\\)`),
          'reason should name the queue cap'
        );
        assert.ok(
          event.reason.endsWith(`evicted oldest message from ofsender-${i}`),
          `eviction ${i} should drop the oldest message (ofsender-${i}); reason: ${event.reason}`
        );
      });

      // The surviving queue is full and starts at the first non-evicted sender.
      // (The tail of the burst is pipelined, so only set membership — not
      // order — is guaranteed beyond the sequential head.)
      const pending = await harness.client.getPending(agentName);
      assert.equal(pending.length, MAX_PENDING_PER_WORKER, 'queue should sit exactly at the cap');
      assert.equal(pending[0]?.from, `ofsender-${overflow}`, 'oldest survivor follows the evicted senders');
      const survivors = new Set(pending.map((p) => p.from));
      const expectedSurvivors = new Set(
        Array.from({ length: MAX_PENDING_PER_WORKER }, (_, i) => `ofsender-${i + overflow}`)
      );
      assert.deepEqual(survivors, expectedSurvivors, 'exactly the non-evicted senders should survive');

      // The shared assertion helper must flag this scenario.
      assert.throws(
        () => assertNoDroppedDeliveries(harness.getEvents()),
        /delivery_dropped/,
        'assertNoDroppedDeliveries should fail when the queue cap dropped messages'
      );
    } finally {
      try {
        await harness.releaseAgent(agentName);
      } catch {
        /* ignore cleanup errors */
      }
      await harness.stop();
    }
  }
);

// ── Unverified delivery visibility ──────────────────────────────────────────

test(
  'infra: unverified delivery is reported as timeout_fallback, not a verified success',
  { timeout: 120_000 },
  async (t) => {
    if (skipIfMissing(t)) return;

    const harness = new BrokerHarness();
    await harness.start();
    const suffix = uniqueSuffix();
    const sink = `sink-${suffix}`;

    try {
      await spawnSink(harness, sink);

      const result = await harness.sendMessage({ to: sink, from: 'infra-test', text: 'swallow me' });

      // The sink swallows all output, so the echo can never be observed. The
      // broker still acks after the verification window, but it must mark the
      // delivery as unverified instead of conflating it with an echo-verified
      // success.
      const verified = await harness.waitForEvent(
        'delivery_verified',
        30_000,
        (e) => e.kind === 'delivery_verified' && e.name === sink && e.event_id === result.event_id
      ).promise;
      assert.equal(verified.kind, 'delivery_verified');
      if (verified.kind !== 'delivery_verified') return;
      assert.equal(
        verified.verification,
        'timeout_fallback',
        'echo-less delivery must be reported as timeout_fallback'
      );
      assert.match(
        verified.reason ?? '',
        /echo not detected/,
        'reason should explain the missing echo verification'
      );

      // The fallback still acks the delivery (re-injection stays disabled to
      // avoid duplicates) — but never as an echo-verified success.
      await harness.waitForEvent(
        'delivery_ack',
        10_000,
        (e) => e.kind === 'delivery_ack' && e.name === sink && e.event_id === result.event_id
      ).promise;
      const echoVerified = harness
        .getEventsByKind('delivery_verified')
        .filter(
          (e) =>
            e.kind === 'delivery_verified' &&
            e.event_id === result.event_id &&
            e.verification !== 'timeout_fallback'
        );
      assert.equal(
        echoVerified.length,
        0,
        `no echo-verified event should exist for a swallowed delivery: ${JSON.stringify(echoVerified)}`
      );
    } finally {
      try {
        await harness.releaseAgent(sink);
      } catch {
        /* ignore cleanup errors */
      }
      await harness.stop();
    }
  }
);

// ── Upstream (Relaycast) connection loss ────────────────────────────────────

test(
  'infra: behavior across an upstream Relaycast connection gap',
  { skip: 'suite runs against the hosted Relaycast backend; no fake/local endpoint exists to drop and restore' },
  () => {
    // Intentionally skipped. The broker harness provisions a real workspace on
    // the hosted engine (see ensureApiKey) and the broker dials it directly,
    // so there is no seam to sever the upstream WS deterministically. Add this
    // once the suite grows a local/fake Relaycast endpoint.
  }
);
