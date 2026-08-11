/**
 * Obligation-lifecycle conformance fixture.
 *
 * The defect: a message can be delivered, injected, READ, and never answered,
 * and nothing in the system can tell that state apart from an answered one.
 * The settled fix: **an obligation is discharged only when the obligating
 * author (or its named discharge delegate) confirms it was answered** — not on
 * read, not on a timer, not on the recipient's belief that it replied.
 *
 * This file does not implement that. It is the test that proves it is missing
 * and that discriminates between an implementation of it and an implementation
 * that merely never discharges anything.
 *
 * ── Why the arms come in a pair ─────────────────────────────────────────────
 *
 * "Fails before the change" proves novelty, not relevance: every test of a
 * feature that does not exist fails. What discriminates is the pair.
 *
 *   Arm A (must-fire)     delivered + read + a non-answering reply + the
 *                         recipient reacts `done` + reacts `seen`
 *                         -> the obligation MUST still return.
 *                         FAILS on unmodified main.
 *
 *   Arm B (must-not-fire) the AUTHOR reacts `done` naming the recipient
 *                         -> it MUST NOT return.
 *                         PASSES on unmodified main, trivially, because
 *                         nothing ever returns.
 *
 * A alone is satisfied by a host that never discharges anything. B alone is
 * satisfied by today's code doing nothing. Neither is worth anything on its
 * own. A-fails / B-passes is the expected and correct pre-implementation state.
 *
 *   Arm C (pending)       no signals at all -> returns at t, 2t, 3t at EQUAL
 *                         intervals (no backoff), then an escalation observed
 *                         at a DIFFERENT recipient.
 *
 *   Arm D (pending)       arm A run twice, once with read state set and once
 *                         unset -> byte-identical behaviour. This makes
 *                         read-independence observable instead of a promise.
 *
 *   Control               the same suite with the boomerang mechanism disabled
 *                         must turn arms A and C RED. A suite that stays green
 *                         with the feature removed is passing vacuously, which
 *                         is the same failure shape as the bug.
 *
 * ── Running it ──────────────────────────────────────────────────────────────
 *
 *   npx tsc -p tests/integration/broker/tsconfig.json
 *   cd tests/integration/broker
 *
 *   # conformance run (arms A and C are expected RED on main)
 *   RELAY_OBLIGATION_CONFORMANCE=1 \
 *   RELAY_OBLIGATION_PATH=native \
 *   RELAY_OBLIGATION_MODEL=openai/gpt-4o-mini \
 *   node --test dist/obligation-conformance.test.js
 *
 *   # control run (mechanism disabled — arms A and C must be RED)
 *   RELAY_OBLIGATION_CONFORMANCE=1 \
 *   RELAY_OBLIGATION_PATH=native \
 *   RELAY_OBLIGATION_MODEL=openai/gpt-4o-mini \
 *   RELAY_OBLIGATION_BOOMERANG=0 \
 *   node --test dist/obligation-conformance.test.js
 *
 * Without RELAY_OBLIGATION_CONFORMANCE=1 every arm skips, so this never runs in
 * normal CI. It is expected to fail on unmodified main, by design.
 *
 * Requires: the agent-relay-broker binary (AGENT_RELAY_BIN or target/debug),
 * and a Relaycast workspace key (RELAY_API_KEY, or one is minted).
 */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import {
  type ArmTranscript,
  type ConformanceContext,
  type TurnEvidence,
  assertEvidenceIsProof,
  assertNoReturn,
  assertRecipientTookTurn,
  boomerangDisabled,
  clientFor,
  ConformancePreconditionError,
  emitSignal,
  readReactions,
  recipientHasReadReceipt,
  sendObligatingDm,
  serializeTranscript,
  skipUnlessConformance,
  startConformanceContext,
  waitForDelivery,
  waitForReturn,
  watchForTurn,
  BOOMERANG_FLAG,
  SIGNAL_GLYPH,
} from './utils/obligation-conformance.js';
import { sleep } from './utils/cli-helpers.js';

const QUESTION = 'Is the release gate open? I am holding until you rule.';

const DECLARATION = {
  blocks: 'halted',
  defaultAction: 'Keep the release paused',
} as const;

/**
 * Run an arm body, or — when the suite is running as the control with the
 * mechanism disabled — assert that it goes RED.
 *
 * Note honestly what this does and does not prove today. With no mechanism at
 * all, the arm is red under both settings, so the control does not yet
 * discriminate. It becomes the load-bearing check the moment boomerang exists:
 * from then on the conformance run must be green and this run must stay red,
 * and any implementation that ignores the toggle fails here.
 */
async function runOrExpectRed(name: string, body: () => Promise<unknown>): Promise<void> {
  if (!boomerangDisabled()) {
    await body();
    return;
  }
  await assert.rejects(
    body,
    (error: unknown) => {
      // A precondition failure is not the red the control is looking for. If
      // the message never arrived, the arm never got as far as testing the
      // mechanism, and calling that "correctly failed" would be reporting a
      // result nobody observed.
      if (error instanceof ConformancePreconditionError) throw error;
      return true;
    },
    `control: with ${BOOMERANG_FLAG}=0 arm ${name} must fail. It did not, which means the ` +
      `arm passes without the mechanism it is supposed to be testing.`
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// ARM A — must-fire
// ══════════════════════════════════════════════════════════════════════════════

test(
  'obligation arm A: read, replied-to, and recipient-signalled `done` — the obligation MUST still return',
  { timeout: 300_000 },
  async (t: TestContext) => {
    if (skipUnlessConformance(t)) return;

    const ctx = await startConformanceContext({ label: 'a' });
    try {
      await runOrExpectRed('A', () => armA(ctx, { setReadState: true }));
    } finally {
      await ctx.stop();
    }
  }
);

interface ArmARun {
  transcript: ArmTranscript;
  /**
   * Whether the recipient's read receipt was actually set. This is arm D's
   * independent variable and is deliberately NOT part of the transcript, which
   * is the dependent one.
   */
  readStateObserved: boolean;
}

/**
 * Arm A body. Returns the normalised transcript so arm D can compare two runs.
 *
 * Every message here crosses the production send path:
 * `createAgentClient({ agentToken }).dm(...)` is the exact call the
 * `mcp__agent-relay__send_dm` tool makes, and the broker under test is the real
 * binary spawned by BrokerHarness. There is no test-only constructor and no
 * fake host anywhere in this flow.
 */
async function armA(ctx: ConformanceContext, options: { setReadState: boolean }): Promise<ArmARun> {
  const { harness, author, recipient, path, intervalMs } = ctx;

  harness.clearEvents();
  const since = harness.getEvents().length;

  // 1. The author sends an obligating event through the production send path.
  const obligationId = await sendObligatingDm(author, recipient.name, QUESTION, DECLARATION);

  // 2. It is delivered and injected at the recipient. A failure here is a
  //    delivery-path failure and says nothing about the obligation lifecycle;
  //    waitForDelivery's error message says so explicitly.
  await waitForDelivery(harness, recipient.name, { since, timeoutMs: 60_000 });

  // 3. Read state. The point of the arm is that this must not matter.
  //
  //    On the PTY path the broker sets it automatically anyway: delivery is
  //    confirmed by scanning recipient stdout for the injected string, the
  //    worker acks, and the read-ack follows from that match with no model in
  //    the loop. The native runtime reaches the same place by a shorter route —
  //    the sidecar acks the `deliver_relay` frame and the broker marks it read
  //    off that ack. The "unset" variant used by arm D is therefore only as
  //    unset as the substrate permits, which is what arm D checks first.
  if (options.setReadState) {
    await clientFor(recipient).markRead(obligationId);
  }

  // 4. The recipient posts a reply that does NOT answer the question, through
  //    the production send path.
  await clientFor(recipient).dm(author.name, 'Got it — looking at this shortly.');

  // 5. The recipient emits `done` and then `seen`.
  //
  //    Per the protocol a recipient's `done` is a claim that it answered:
  //    evidence, not a discharge. A party's signal never states anything about
  //    another party's work. Neither of these may close the obligation.
  await emitSignal(recipient, obligationId, 'done');
  await emitSignal(recipient, obligationId, 'seen');

  const readStateObserved = await recipientHasReadReceipt(author, obligationId, recipient.name);

  // 6. The obligation MUST still return, and the return MUST take a model turn
  //    at the recipient.
  //    Arm A records no interval bucket. Interval spacing is arm C's
  //    assertion; carrying a wall-clock-derived number in arm A's transcript
  //    would make arm D's byte-for-byte comparison fail on scheduling jitter
  //    rather than on anything to do with read state.
  const returns: ArmTranscript['returns'] = [];
  const evidence: TurnEvidence[] = [];

  const watch = await watchForTurn(harness, recipient.name, path);
  const observed = await waitForReturn(harness, recipient.name, obligationId, {
    since,
    timeoutMs: intervalMs * 3,
  });
  returns.push({ index: 1, via: observed.via });

  const turn = await assertRecipientTookTurn(harness, recipient.name, watch, {
    timeoutMs: 120_000,
    path,
  });
  assertEvidenceIsProof(turn, path);
  evidence.push(turn);

  return {
    transcript: { arm: 'A', returns, turnEvidence: evidence.map((e) => e.kind), escalations: 0 },
    readStateObserved,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// ARM B — must-not-fire
// ══════════════════════════════════════════════════════════════════════════════

test(
  'obligation arm B: the AUTHOR reacts `done` naming the recipient — it MUST NOT return',
  { timeout: 300_000 },
  async (t: TestContext) => {
    if (skipUnlessConformance(t)) return;

    const ctx = await startConformanceContext({ label: 'b' });
    try {
      const { harness, author, recipient, intervalMs } = ctx;
      harness.clearEvents();
      const since = harness.getEvents().length;

      const obligationId = await sendObligatingDm(author, recipient.name, QUESTION, DECLARATION);
      await waitForDelivery(harness, recipient.name, { since, timeoutMs: 60_000 });

      // The author discharges.
      //
      // SUBSTRATE GAP, stated rather than papered over: the spec requires a
      // discharging reaction to name, in `recipient`, the recipient it
      // discharges, and says a reaction naming no recipient discharges
      // nothing. The reaction record here is
      // `{ id, message_id, agent_id, emoji, created_at }` — there is no
      // `recipient` field to set. So this call cannot express the naming the
      // spec requires; it is the closest the substrate allows, and the arm is
      // correspondingly weaker than the spec until the field exists.
      await emitSignal(author, obligationId, 'done');

      // Arm B is deliberately NOT wrapped in runOrExpectRed. It must hold with
      // the mechanism enabled and with it disabled alike — a control run that
      // turned B red would mean the control had broken the must-not-fire half
      // of the pair rather than removed the mechanism.
      await assertNoReturn(harness, recipient.name, obligationId, {
        since,
        windowMs: intervalMs * 3 + 2_000,
      });

      // Said plainly so no one reads a green B as evidence of anything:
      // on unmodified main this passes because nothing ever returns. It is
      // only meaningful paired with arm A.
    } finally {
      await ctx.stop();
    }
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// ARM C — PENDING IMPLEMENTATION
// ══════════════════════════════════════════════════════════════════════════════

test(
  'obligation arm C [pending-implementation]: no signals — returns at t, 2t, 3t at EQUAL intervals, then escalation at a different recipient',
  { timeout: 600_000 },
  async (t: TestContext) => {
    if (skipUnlessConformance(t)) return;

    const ctx = await startConformanceContext({ label: 'c', withEscalationTarget: true });
    try {
      await runOrExpectRed('C', () => armC(ctx));
    } finally {
      await ctx.stop();
    }
  }
);

/**
 * PENDING IMPLEMENTATION.
 *
 * Two things about this arm are worth stating.
 *
 * First, it asserts equal intervals, not merely three returns. Backing off
 * makes an unanswered obligation quieter over time, which is the failure being
 * fixed, so a backoff must fail this arm rather than slip through it.
 *
 * Second, it sleeps through real wall-clock time, which is a defect in the arm
 * and not a property of the design. The broker's existing Scheduler takes `now`
 * as a parameter instead of reading the clock internally
 * (crates/broker/src/scheduler.rs), which is exactly what makes it testable.
 * Boomerang state should do the same; when it does, this arm should drive the
 * clock instead of waiting on it, and RELAY_OBLIGATION_INTERVAL_MS becomes
 * unnecessary.
 */
async function armC(ctx: ConformanceContext): Promise<ArmTranscript> {
  const { harness, author, recipient, escalationTarget, intervalMs } = ctx;

  harness.clearEvents();
  let since = harness.getEvents().length;
  const sentAt = Date.now();

  const obligationId = await sendObligatingDm(author, recipient.name, QUESTION, DECLARATION);
  await waitForDelivery(harness, recipient.name, { since, timeoutMs: 60_000 });

  // No signals at all. Nobody reads it, nobody reacts, nobody replies.

  const returns: ArmTranscript['returns'] = [];
  for (let index = 1; index <= 3; index += 1) {
    const observed = await waitForReturn(harness, recipient.name, obligationId, {
      since,
      timeoutMs: intervalMs * (index + 1),
    });
    // Advance the cursor past this return so the next iteration waits for a
    // distinct event rather than re-discovering the same one.
    since = harness.getEvents().length;
    returns.push({
      index,
      bucket: Math.round((Date.now() - sentAt) / intervalMs),
      via: observed.via,
    });
  }

  // Equal intervals: buckets must be 1, 2, 3. Any backoff pushes the later
  // buckets out and fails here.
  assert.deepEqual(
    returns.map((entry) => entry.bucket),
    [1, 2, 3],
    `returns must arrive at t, 2t and 3t at equal intervals (no backoff). ` +
      `Observed buckets: ${JSON.stringify(returns.map((entry) => entry.bucket))}`
  );

  // Escalation is observed at a DIFFERENT recipient. Each rung is itself an
  // obligating event addressed to one recipient, so the ladder is recursive and
  // an escalation target that fails silently is caught one rung up.
  const escalation = await waitForReturn(harness, escalationTarget.name, obligationId, {
    since,
    timeoutMs: intervalMs * 2,
  });
  assert.ok(escalation.via, 'escalation must reach a recipient other than the original');

  return { arm: 'C', returns, turnEvidence: [], escalations: 1 };
}

// ══════════════════════════════════════════════════════════════════════════════
// ARM D — PENDING IMPLEMENTATION
// ══════════════════════════════════════════════════════════════════════════════

test(
  'obligation arm D [pending-implementation]: arm A with read state set and unset — byte-identical behaviour',
  { timeout: 600_000 },
  async (t: TestContext) => {
    if (skipUnlessConformance(t)) return;

    // Arm D is not wrapped in runOrExpectRed: it is a statement about the shape
    // of the behaviour, not about whether the mechanism fires. With the
    // mechanism disabled both runs are empty and identical, which is true but
    // uninformative — the two guards below are what stop that from reading as
    // a pass.
    const withRead = await startConformanceContext({ label: 'd-read' });
    let readRun: ArmARun;
    try {
      readRun = await armA(withRead, { setReadState: true });
    } finally {
      await withRead.stop();
    }

    const withoutRead = await startConformanceContext({ label: 'd-unread' });
    let unreadRun: ArmARun;
    try {
      unreadRun = await armA(withoutRead, { setReadState: false });
    } finally {
      await withoutRead.stop();
    }

    // Guard 1 — did the independent variable actually vary?
    //
    // Usually it will not, and that is a substrate finding rather than a bug in
    // the arm. The broker marks an inbound message read on the recipient's
    // behalf as soon as the delivery is acked, on both runtimes, so "read state
    // unset" is not a state a test can currently put the system into. Skipping
    // the explicit markRead call does not make the message unread.
    //
    // The arm fails loudly here rather than comparing two runs that were
    // secretly the same run. Asserting read-independence from two identical
    // read states would be exactly the substitution of a well-formed signal for
    // an unverified fact that this whole issue is about.
    assert.notEqual(
      readRun.readStateObserved,
      unreadRun.readStateObserved,
      'arm D could not vary read state: the recipient read receipt was ' +
        `${readRun.readStateObserved} in both runs. The broker sets it automatically off the ` +
        'delivery ack, so read-independence is not observable on this substrate yet. Making it ' +
        'observable needs a way to suppress the automatic read-ack for one delivery — until then ' +
        'this arm asserts nothing and must not be reported as passing.'
    );

    // Guard 2 — equality alone is vacuously satisfiable: two runs that both
    // observed nothing are byte-identical. Require the runs to have observed
    // the conformant behaviour before comparing them.
    assert.ok(
      readRun.transcript.returns.length >= 1,
      'arm D compares two runs of arm A; with no return observed there is nothing to compare'
    );

    assert.equal(
      serializeTranscript(readRun.transcript),
      serializeTranscript(unreadRun.transcript),
      'read state must not change behaviour. Read state MUST NOT be an input to discharge ' +
        'anywhere in the implementation, including as an optimisation.'
    );
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// Substrate gaps — these PASS today and are here to keep the gaps visible.
// ══════════════════════════════════════════════════════════════════════════════

test(
  'obligation substrate: a reaction cannot name the recipient it discharges',
  { timeout: 120_000 },
  async (t: TestContext) => {
    if (skipUnlessConformance(t)) return;

    const ctx = await startConformanceContext({ label: 'gap' });
    try {
      const { author, recipient } = ctx;
      const obligationId = await sendObligatingDm(author, recipient.name, QUESTION, DECLARATION);

      // The author reacts `done`; so does the recipient. The spec makes these
      // two acts categorically different — one discharges, one is merely
      // evidence — and the store makes them indistinguishable apart from
      // `agent_id`. Neither carries a `recipient`, so neither is a well-formed
      // discharging reaction under the spec.
      await emitSignal(author, obligationId, 'done');
      await emitSignal(recipient, obligationId, 'done');
      await sleep(1_000);

      const stored = await readReactions(ctx.apiKey, obligationId);
      const done = stored.filter((entry) => entry.emoji === SIGNAL_GLYPH.done);
      assert.ok(done.length > 0, 'the `done` reactions should be stored');

      for (const entry of done) {
        assert.equal(
          'recipient' in entry,
          false,
          'if a reaction has grown a `recipient` field, arm B can finally assert what the spec ' +
            'requires — that a discharging reaction names the recipient it discharges — and ' +
            'this test should be deleted'
        );
      }

      // And the author's `done` is indistinguishable from the recipient's
      // except by actor, which is the entire author/recipient asymmetry the
      // design rests on being absent from the record.
      const shapes = new Set(done.map((entry) => JSON.stringify(Object.keys(entry).sort())));
      assert.equal(
        shapes.size,
        1,
        'the author and recipient `done` records should currently have identical shapes'
      );
    } finally {
      await ctx.stop();
    }
  }
);
