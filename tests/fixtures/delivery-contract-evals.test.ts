/**
 * Delivery-contract regression coverage for the native-delivery migration.
 *
 * `docs/native-delivery-migration.md` names four suites as the gate that "the
 * delivery contract is unchanged" when a message stops arriving over the PTY
 * and starts arriving over a native route:
 *
 *   evals/suites/{delivery-modes,messaging,read-receipts,agent-directory}
 *
 * Naming a suite in a document does not run it. This file runs all four
 * through the same executor and the same assertion functions that
 * `npm run evals` uses, and then adds regression cases for the Phase-0 seam
 * rules that the existing suites only state as human-reviewed prose.
 *
 * Scope note: these cases pin the delivery contract as the TypeScript SDK
 * expresses it (`DeliveryRunner` over durable inbox state). They do not
 * execute `crates/broker/src/delivery/`; the Rust seam's own invariants are
 * proven by `crates/broker/tests/delivery_seam_invariants.rs`. What these
 * cases catch is a native backend that settles an inbox item differently from
 * the PTY route.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { assertHumanEvalExpected, validateHumanEvalCase } from '@agent-assistant/telemetry/evals';
import { beforeAll, describe, expect, it } from 'vitest';

import { assertRelayExpected } from '../../scripts/evals/relay-checks.mjs';
import { createRelayExecutor } from '../../scripts/evals/relay-executor.mjs';

/** The four suites the migration doc names as the delivery-contract gate. */
const CONTRACT_SUITES = ['delivery-modes', 'messaging', 'read-receipts', 'agent-directory'] as const;

const SUITES_DIR = path.resolve(__dirname, '../../evals/suites');

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

/**
 * Run one case exactly the way `scripts/evals/run-relay-evals.mjs` does, and
 * return the checks that did not pass.
 */
async function failedChecks(testCase: EvalCase): Promise<FailedCheck[]> {
  validateHumanEvalCase(testCase as any);
  const actual = await execute(testCase as any, { providerMode: false, rootDir: process.cwd() });
  return [...assertHumanEvalExpected(testCase as any, actual), ...assertRelayExpected(testCase, actual)]
    .filter((check: { passed: boolean }) => !check.passed)
    .map(({ name, message }: FailedCheck) => ({ name, message }));
}

describe('delivery-contract eval suites', () => {
  const casesBySuite = new Map<string, EvalCase[]>();

  beforeAll(async () => {
    for (const suite of CONTRACT_SUITES) {
      const raw = await readFile(path.join(SUITES_DIR, suite, 'cases.jsonl'), 'utf8');
      const cases = raw
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('#'))
        .map((line) => JSON.parse(line) as EvalCase);
      casesBySuite.set(suite, cases);
    }
  });

  it('keeps every named contract suite populated and compiled', () => {
    for (const suite of CONTRACT_SUITES) {
      const cases = casesBySuite.get(suite) ?? [];
      expect(cases.length, `${suite} has no compiled cases`).toBeGreaterThan(0);
      for (const testCase of cases) {
        expect(testCase.suite, testCase.id).toBe(suite);
      }
    }
  });

  for (const suite of CONTRACT_SUITES) {
    it(`passes every ${suite} case against the delivery executor`, async () => {
      const cases = casesBySuite.get(suite) ?? [];
      const failures: Array<{ id: string; checks: FailedCheck[] }> = [];
      for (const testCase of cases) {
        const failed = await failedChecks(testCase);
        if (failed.length > 0) failures.push({ id: testCase.id, checks: failed });
      }
      expect(failures, JSON.stringify(failures, null, 2)).toEqual([]);
    });
  }
});

/**
 * Phase-0 seam rules, expressed against the delivery contract.
 *
 * Each case below is written so that it fails if the named property stops
 * holding. Where this harness cannot observe a rule, there is no case — see
 * the `unobservable` block at the end of this file rather than a check that
 * would pass no matter what the runner did.
 */
const SEAM_CASES: EvalCase[] = [
  {
    // Seam rule 1 (fall back only before a write) and rule 2 (never re-send on
    // doubt), at the contract layer: a failure the route reports *after* a
    // possible write must settle the inbox item terminally, and the adapter
    // must not be asked again.
    id: 'delivery-modes.committed-failure-is-terminal',
    suite: 'delivery-modes',
    executor: 'relay',
    input: {
      message:
        'A route that fails after a possible write must fail the inbox item terminally, not defer, ack, or re-send it.',
      operation: [{ op: 'deliver', as: 'worker', mode: 'wait', reason: 'message' }],
    },
    mock: {
      agents: [{ name: 'worker', type: 'agent' }],
      delivery: {
        target: 'worker',
        serverDeliveryState: true,
        result: {
          status: 'failed',
          reason: 'delivery backend error after possible write: worker writer channel closed',
          metadata: { commitBoundary: 'post-write', route: 'pty' },
        },
      },
    },
    expected: {
      ok: true,
      contentMatches: [
        '"state": "failed"',
        '"reason": "delivery backend error after possible write',
        '"route": "pty"',
      ],
      forbidPatterns: [
        // Acking or deferring a post-write failure is the double-delivery bug
        // the seam exists to prevent.
        '"state": "delivered"',
        '"state": "deferred"',
        '"availableAt"',
        // Two recorded results means the adapter was driven twice for one item.
        '"status": "failed"[\\s\\S]*"status": "failed"',
      ],
      toolCallsInclude: ['deliver'],
      maxToolCalls: 1,
    },
  },
  {
    // Seam rule 1's safe half: a strictly pre-write error is the only failure
    // another transport may be tried after. The contract-visible signature is
    // that no delivery result was ever produced.
    id: 'delivery-modes.pre-write-error-produces-no-result',
    suite: 'delivery-modes',
    executor: 'relay',
    input: {
      message:
        'An injection that throws before any write records a retryable failure and produces no delivery result.',
      operation: [{ op: 'deliver', as: 'worker', mode: 'wait', reason: 'message' }],
    },
    mock: {
      agents: [{ name: 'worker', type: 'agent' }],
      delivery: {
        target: 'worker',
        serverDeliveryState: true,
        throws: 'delivery backend unavailable before write: PTY route requires a worker target',
      },
    },
    expected: {
      ok: true,
      contentMatches: [
        // No onResult fired: nothing was handed to any route.
        '"results": \\[\\]',
        '"state": "failed"',
        '"reason": "delivery backend unavailable before write',
      ],
      forbidPatterns: ['"state": "delivered"', '"state": "deferred"', '"status": "delivered"'],
      toolCallsInclude: ['deliver'],
    },
  },
  {
    // Seam rule 4 (never claim an acknowledgement you did not observe), at the
    // layer where this harness can actually see it: arrival is not reading.
    // A native route that marks its own deliveries read would fail here.
    id: 'read-receipts.delivery-does-not-imply-a-read-receipt',
    suite: 'read-receipts',
    executor: 'relay',
    input: {
      message: 'A delivered direct message has no readers until the recipient explicitly marks it read.',
      operation: [
        { op: 'send_dm', as: 'Lead', to: 'WorkerA', text: 'transport check', id: 'dm_seam_read_1' },
        { op: 'get_readers', messageId: 'dm_seam_read_1' },
        { op: 'check_inbox', as: 'WorkerA' },
        { op: 'mark_read', as: 'WorkerA', messageId: 'dm_seam_read_1' },
        { op: 'get_readers', messageId: 'dm_seam_read_1' },
      ],
    },
    mock: {
      agents: [
        { name: 'Lead', type: 'human' },
        { name: 'WorkerA', type: 'agent' },
      ],
    },
    expected: {
      ok: true,
      contentMatches: [
        // Ordered: the first get_readers is empty, the receipt only appears
        // after mark_read.
        'get_readers: \\[\\][\\s\\S]*mark_read:[\\s\\S]*"agentName": "WorkerA"',
        '"unreadCount": 1',
      ],
      eventEmitted: [{ type: 'messageRead', agentName: 'WorkerA' }],
      toolCallsInclude: ['send_dm', 'get_readers', 'mark_read'],
    },
  },
  {
    // Native routes re-encode the message body: `codex queue --message=<text>`
    // puts it on an argv, the Claude inbox socket puts it in JSON. Phase 1 also
    // plans to carry a correlation marker inside the body. Anything that
    // mangles, truncates or shell-interprets the payload breaks both.
    id: 'messaging.delivery-preserves-the-message-payload-verbatim',
    suite: 'messaging',
    executor: 'relay',
    input: {
      message: 'A message body survives delivery with its markers and metacharacters intact.',
      operation: [
        {
          op: 'send_dm',
          as: 'Lead',
          to: 'WorkerA',
          text: 'relay-marker-7f3a\nsecond line: `backtick` --message=injected $(whoami)\nunicode: ✅ π',
          id: 'dm_seam_payload_1',
        },
        { op: 'list_dms', as: 'WorkerA' },
      ],
    },
    mock: {
      agents: [
        { name: 'Lead', type: 'human' },
        { name: 'WorkerA', type: 'agent' },
      ],
    },
    expected: {
      ok: true,
      messageExists: [{ kind: 'dm', from: 'Lead', text: 'relay-marker-7f3a' }],
      contentIncludes: ['--message=injected', '$(whoami)', 'backtick', '✅'],
      // The body must arrive as text, never as something a route evaluated.
      forbidPatterns: ['relay-marker-7f3a\\.\\.\\.', '"text": "relay-marker-7f3a"'],
      toolCallsInclude: ['send_dm', 'list_dms'],
    },
  },
  {
    // Decision D4: "agent relay did not launch" is meant to be a first-class
    // case, not a desktop-app special case. An identity that registered itself
    // -- no spawn, no wrap, no token minted by the broker -- must be present
    // and addressable in the directory. This is the contract-level precursor to
    // the cleanroom scenario the doc says does not exist yet.
    id: 'agent-directory.unlaunched-agent-is-registered-and-addressable',
    suite: 'agent-directory',
    executor: 'relay',
    input: {
      message:
        'An agent that registered itself rather than being spawned is online in the directory and can be sent a direct message.',
      operation: [
        { op: 'register_agent', name: 'DesktopSession', type: 'agent', persona: 'Unlaunched' },
        {
          op: 'send_dm',
          as: 'Lead',
          to: 'DesktopSession',
          text: 'reaches a session relay did not launch',
          id: 'dm_seam_unlaunched_1',
        },
        { op: 'list_agents', status: 'online' },
        { op: 'list_dms', as: 'DesktopSession' },
      ],
    },
    mock: { agents: [{ name: 'Lead', type: 'human' }] },
    expected: {
      ok: true,
      agentPresence: [{ name: 'DesktopSession', status: 'online' }],
      messageExists: [{ kind: 'dm', from: 'Lead', text: 'reaches a session relay did not launch' }],
      contentMatches: [
        // Bound to the registration result itself: being addressed later must
        // not be what brings an unlaunched session online.
        // `[^}]` keeps the match inside the register_agent result object, so a
        // later "online" from list_agents cannot satisfy it.
        'register_agent: \\{[^}]*"name": "DesktopSession"[^}]*"status": "online"',
      ],
      contentIncludes: ['DesktopSession', 'Unlaunched'],
      toolCallsInclude: ['register_agent', 'send_dm', 'list_dms'],
      // Reachability must not depend on the broker having spawned it.
      toolCallsExclude: ['add_agent'],
    },
  },
];

describe('phase-0 delivery seam rules, at the delivery contract', () => {
  for (const testCase of SEAM_CASES) {
    it(testCase.id, async () => {
      const failed = await failedChecks(testCase);
      expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
    });
  }

  it('asserts something in every seam case', () => {
    for (const testCase of SEAM_CASES) {
      const expected = testCase.expected ?? {};
      const deterministic =
        (expected.contentMatches?.length ?? 0) +
        (expected.contentIncludes?.length ?? 0) +
        (expected.forbidPatterns?.length ?? 0) +
        (expected.messageExists?.length ?? 0) +
        (expected.agentPresence?.length ?? 0) +
        (expected.eventEmitted?.length ?? 0);
      expect(deterministic, `${testCase.id} has no deterministic checks`).toBeGreaterThan(0);
    }
  });
});

/**
 * Seam properties this harness cannot observe, recorded rather than faked.
 *
 * A check that passes no matter what the runner did is worse than no check,
 * so none of these has a case above. Each needs a fidelity fix in
 * `scripts/evals/relay-executor.mjs` (out of the phase-0 TypeScript lane)
 * before it can be gated here.
 *
 *  - Rule 4, hand-over versus acknowledgement. `DeliveryRunner` acks an
 *    `accepted` result with `state: undefined` and only a `delivered` result
 *    with `state: 'delivered'`, which is exactly the distinction a native
 *    route needs. The executor's `inbox.ack` collapses it with
 *    `input.state ?? 'delivered'`, so an unobserved hand-over is recorded as
 *    delivered either way.
 *  - Retryable versus terminal failure. The runner passes `retry: true` for a
 *    thrown injection and `retry: false` for an adapter-reported failure;
 *    `inbox.fail` drops the flag. `pre-write-error-produces-no-result` pins
 *    the adjacent, observable difference (no result was ever recorded)
 *    instead.
 *  - Idempotency. `messages.send`/`messages.direct` accept an
 *    `idempotencyKey` and ignore it; the id comes from the case's explicit
 *    `id`. `messaging.idempotent-channel-post` therefore passes today with
 *    two distinct messages in the store.
 *  - Multi-item ordering. `mock.inbox` is never read; a `deliver` op creates
 *    exactly one inbox item, so `delivery-modes.orders-multiple-inbox-items`
 *    exercises a single item despite its name.
 */
