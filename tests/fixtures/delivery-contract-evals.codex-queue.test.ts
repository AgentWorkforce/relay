/**
 * Phase-1 delivery-contract regression coverage: the codex-queue route.
 *
 * `docs/native-delivery-migration.md` names four suites as the gate that "the
 * delivery contract is unchanged" once a message stops arriving over the PTY:
 *
 *   evals/suites/{delivery-modes,messaging,read-receipts,agent-directory}
 *
 * Phase 0's `delivery-contract-evals.test.ts` runs every compiled case in those
 * four suites and adds the seam-rule cases the suites only state as prose. This
 * file is the phase-1 layer on top: cases for the properties the *codex queue*
 * route introduces, driven through the same executor and the same assertion
 * functions `npm run evals` uses.
 *
 * Deliberately not re-asserted here, because phase 0 already gates it: that the
 * four suites are populated, compiled, and pass. Re-running them would make a
 * phase-1 failure report a phase-0 regression.
 *
 * Scope note, inherited and still true: these cases pin the delivery contract
 * as the TypeScript SDK expresses it (`DeliveryRunner` over durable inbox
 * state). They do not execute `crates/broker/src/delivery/codex_queue.rs`; that
 * module's own behaviour is proven by its unit tests and by
 * `crates/broker/tests/delivery_seam_invariants.rs`. What these cases catch is
 * a native route that settles an inbox item differently from the PTY route.
 *
 * Every case below asserts something the *runner* produced, not something the
 * case's own mock supplied. A check that reads back a fixture is a check that
 * cannot fail.
 */

import { assertHumanEvalExpected, validateHumanEvalCase } from '@agent-assistant/telemetry/evals';
import { describe, expect, it } from 'vitest';

import { assertRelayExpected } from '../../scripts/evals/relay-checks.mjs';
import { createRelayExecutor } from '../../scripts/evals/relay-executor.mjs';

interface EvalCase {
  id: string;
  suite?: string;
  executor?: string;
  input: { message?: string; operation?: unknown };
  expected?: Record<string, any>;
  mock?: Record<string, any>;
}

interface FailedCheck {
  name: string;
  message: string;
}

const execute = createRelayExecutor();

/** Run one case exactly the way `scripts/evals/run-relay-evals.mjs` does. */
async function failedChecks(testCase: EvalCase): Promise<FailedCheck[]> {
  validateHumanEvalCase(testCase as any);
  const actual = await execute(testCase as any, { providerMode: false, rootDir: process.cwd() });
  return [...assertHumanEvalExpected(testCase as any, actual), ...assertRelayExpected(testCase, actual)]
    .filter((check: { passed: boolean }) => !check.passed)
    .map(({ name, message }: FailedCheck) => ({ name, message }));
}

/**
 * The correlation marker `CodexThreadSession::body_with_marker` appends, because
 * Codex assigns its own `client_id` to a queued message and relay therefore has
 * to carry its delivery id inside the text
 * (`crates/broker/src/codex_thread.rs`, and the Phase 1 section of the doc).
 */
const ROUTE_MARKER = 'relay-delivery-id:del_codex_1';

const CODEX_QUEUE_CASES: EvalCase[] = [
  {
    /**
     * `codex queue` is a QUEUE. It appends to a thread's durable queue; it
     * cannot interrupt a turn the way typing into a terminal can. That is a
     * real semantic difference between the PTY route and this one, and the
     * risk is that steer quietly degrades into wait once the transport can no
     * longer interrupt.
     *
     * This case pins the half the contract can still hold: the runner must
     * carry steer intent to the adapter as `immediate`. The assertion reads
     * `metadata.mode`, which the DEFAULT adapter builds from the runner's own
     * `context.mode` (`relay-executor.mjs` `receiveMessage`) — there is no
     * `result` fixture in the mock, so nothing here can be satisfied by a
     * value the case supplied.
     */
    id: 'delivery-modes.codex-queue-steer-still-reaches-the-route-as-immediate',
    suite: 'delivery-modes',
    executor: 'relay',
    input: {
      message:
        'A steer-mode delivery over a queue-shaped route still reaches the adapter as an immediate injection, not as an idle wait.',
      operation: [{ op: 'deliver', as: 'codex-session', mode: 'steer', reason: 'mention' }],
    },
    mock: {
      agents: [{ name: 'codex-session', type: 'agent' }],
      delivery: { target: 'codex-session', serverDeliveryState: true },
    },
    expected: {
      ok: true,
      contentMatches: ['"mode": "immediate"'],
      // `next-message` is the wait mapping. Seeing it here would mean steer was
      // downgraded to wait because the transport could not interrupt.
      forbidPatterns: ['"mode": "next-message"'],
      toolCallsInclude: ['deliver'],
      maxToolCalls: 1,
    },
  },
  {
    /**
     * Exactly once, at the layer the contract can see it.
     *
     * The migration doc calls double delivery "the worst failure mode, and the
     * one agent-deck hit", and phase 1 is the first phase whose route can
     * double-deliver in a way the PTY never could: `codex queue` writes into a
     * durable queue, so a re-send after a send left in doubt lands a second
     * copy that the session will actually read.
     *
     * "Twice" is counted where a duplicate would actually show up — inside the
     * recipient's own conversation — not anywhere in the observed record. The
     * record echoes each op's result, so the body legitimately appears once per
     * op that returns it; forbidding two occurrences globally would fail on a
     * correct run. The checks below are anchored past `list_dms:` instead, so a
     * second `messageId` in the recipient's conversation is what fails, and
     * `unreadCount` pins the same fact from the inbox side.
     */
    id: 'messaging.codex-queue-body-lands-once-in-the-recipient-inbox',
    suite: 'messaging',
    executor: 'relay',
    input: {
      message:
        'A message delivered over a queue route appears once in the recipient inbox, with one unread item.',
      operation: [
        {
          op: 'send_dm',
          as: 'Lead',
          to: 'codex-session',
          text: `queue once ${ROUTE_MARKER}`,
          id: 'dm_codex_once_1',
        },
        { op: 'check_inbox', as: 'codex-session' },
        { op: 'list_dms', as: 'codex-session' },
      ],
    },
    mock: {
      agents: [
        { name: 'Lead', type: 'human' },
        { name: 'codex-session', type: 'agent' },
      ],
    },
    expected: {
      ok: true,
      messageExists: [{ kind: 'dm', from: 'Lead', text: `queue once ${ROUTE_MARKER}` }],
      contentIncludes: [ROUTE_MARKER],
      contentMatches: ['"unreadCount": 1'],
      forbidPatterns: [
        // Two occurrences of the delivery id inside the recipient's own
        // conversation. Anchored past `list_dms:` — the last op — so the
        // per-op echoes of the body in the `send_dm` and `check_inbox`
        // results, which a correct run always produces, are not counted.
        `list_dms:[\\s\\S]*${ROUTE_MARKER}[\\s\\S]*${ROUTE_MARKER}`,
        '"unreadCount": 2',
      ],
      toolCallsInclude: ['send_dm', 'check_inbox', 'list_dms'],
    },
  },
  {
    /**
     * Seam rule 4, in the shape phase 1 gives it.
     *
     * The codex route settles by finding its marker in the thread's own session
     * file (`observe_marker`). That is an observation about ARRIVAL. It is not
     * a read receipt, and the contract must not let one become the other — a
     * route that marked its own deliveries read would make every message look
     * consumed the instant it was queued.
     *
     * The body deliberately carries the settle marker, so the case fails if
     * anything treats that marker as evidence the recipient read the message.
     */
    id: 'read-receipts.codex-queue-settle-marker-is-not-a-read-receipt',
    suite: 'read-receipts',
    executor: 'relay',
    input: {
      message:
        'A message whose body carries the route settle marker still has no readers until the recipient marks it read.',
      operation: [
        {
          op: 'send_dm',
          as: 'Lead',
          to: 'codex-session',
          text: `settle check ${ROUTE_MARKER}`,
          id: 'dm_codex_receipt_1',
        },
        { op: 'get_readers', messageId: 'dm_codex_receipt_1' },
        { op: 'mark_read', as: 'codex-session', messageId: 'dm_codex_receipt_1' },
        { op: 'get_readers', messageId: 'dm_codex_receipt_1' },
      ],
    },
    mock: {
      agents: [
        { name: 'Lead', type: 'human' },
        { name: 'codex-session', type: 'agent' },
      ],
    },
    expected: {
      ok: true,
      // Ordered: the first get_readers is empty and the reader only appears
      // after mark_read. Anchored on the op trace so a later reader cannot
      // satisfy the earlier check.
      contentMatches: ['get_readers: \\[\\][\\s\\S]*mark_read:[\\s\\S]*"agentName": "codex-session"'],
      eventEmitted: [{ type: 'messageRead', agentName: 'codex-session' }],
      toolCallsInclude: ['send_dm', 'get_readers', 'mark_read'],
    },
  },
  {
    /**
     * Decision D4 plus the thing a thread id can get wrong.
     *
     * `codex queue --thread <uuid>` addresses ONE thread. Relay resolves that
     * id per agent (`target_for_worker`), so a mis-resolved id delivers a
     * message into somebody else's session — the native-route equivalent of
     * typing into the wrong terminal, and a confidentiality bug, not just a
     * routing one.
     *
     * Two identities are registered (verify_tier 4): the unlaunched codex
     * session, which registered itself rather than being spawned, and a second
     * agent. A DM to the first must be visible to the first and to nobody else.
     */
    id: 'agent-directory.codex-queue-delivery-reaches-only-the-addressed-session',
    suite: 'agent-directory',
    executor: 'relay',
    input: {
      message:
        'Two self-registered sessions are addressable; a direct message to one is not visible to the other.',
      operation: [
        { op: 'register_agent', name: 'codex-session', type: 'agent', persona: 'Unlaunched' },
        { op: 'register_agent', name: 'other-session', type: 'agent', persona: 'Unlaunched' },
        {
          op: 'send_dm',
          as: 'Lead',
          to: 'codex-session',
          text: `addressed thread ${ROUTE_MARKER}`,
          id: 'dm_codex_thread_1',
        },
        { op: 'list_dms', as: 'codex-session' },
        { op: 'list_dms', as: 'other-session' },
        { op: 'list_agents', status: 'online' },
      ],
    },
    mock: { agents: [{ name: 'Lead', type: 'human' }] },
    expected: {
      ok: true,
      agentPresence: [
        { name: 'codex-session', status: 'online' },
        { name: 'other-session', status: 'online' },
      ],
      messageExists: [{ kind: 'dm', from: 'Lead', text: `addressed thread ${ROUTE_MARKER}` }],
      // Bound to the registration result itself: being addressed later must not
      // be what brings a self-registered session online.
      contentMatches: [
        'register_agent: \\{[^}]*"name": "codex-session"[^}]*"status": "online"',
        'register_agent: \\{[^}]*"name": "other-session"[^}]*"status": "online"',
      ],
      // The marker must not appear twice: once for the addressed session's
      // list_dms, never again for the other session's. Anchored past the
      // first `list_dms:` so the `send_dm` echo, which a correct run always
      // produces, is not what fails it — a second marker at or after that
      // point means the unaddressed session saw the message.
      forbidPatterns: [`list_dms:[\\s\\S]*${ROUTE_MARKER}[\\s\\S]*${ROUTE_MARKER}`],
      toolCallsInclude: ['register_agent', 'send_dm', 'list_dms', 'list_agents'],
      // Reachability must not depend on the broker having spawned either one.
      toolCallsExclude: ['add_agent'],
    },
  },
];

describe('phase-1 codex-queue route, at the delivery contract', () => {
  for (const testCase of CODEX_QUEUE_CASES) {
    it(testCase.id, async () => {
      const failed = await failedChecks(testCase);
      expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
    });
  }
});

/**
 * Codex-route properties this harness cannot observe, recorded rather than
 * faked. A check that passes no matter what the runner did is worse than no
 * check, so none of these has a case above.
 *
 *  - The capability probe. `ensure_queue_capability` runs `codex queue --help`
 *    as a separate child and classifies any failure as pre-write, which is what
 *    permits a PTY fallback without double-delivering. The executor's `deliver`
 *    op drives exactly one adapter with one outcome, so "route A refused
 *    pre-write, route B delivered, and the item was acked once" cannot be
 *    expressed. It is covered in Rust by
 *    `unavailable_queue_capability_falls_back_before_write`.
 *    `tests/e2e/unlaunched/unlaunched-codex-delivery.test.ts` reproduces the
 *    probe's decision against a real codex, where it is the gate's first
 *    precondition.
 *  - Hand-over versus acknowledgement. `CodexQueueBackend::send` always returns
 *    `HandedOver`, never `Acked`; only `settle` can produce an ack, and only
 *    from the thread's session file. `DeliveryRunner` does draw the
 *    distinction (`accepted` acks with `state: undefined`), but the executor's
 *    `inbox.ack` collapses it with `input.state ?? 'delivered'`, so an
 *    unobserved hand-over reads as delivered either way. Unchanged from phase 0.
 *  - Re-send on doubt. One `deliver` op creates one inbox item and drives the
 *    runner once; there is no second attempt to forbid. The exactly-once case
 *    above pins the adjacent, observable property (one copy in the recipient's
 *    inbox) instead.
 *  - The marker's own shape. `body_with_marker` is idempotent and appends an
 *    HTML comment; that is Rust-side string handling with no TypeScript
 *    counterpart, and is covered by `codex_thread::tests`.
 */
