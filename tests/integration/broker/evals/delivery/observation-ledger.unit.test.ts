/**
 * The delivery-observation ledger, exercised without a broker.
 *
 * `assertDeliveryObservationLedger` replaced the pre-seam invariant
 * `delivery_ack.length === delivery_verified.length`. That equality became
 * wrong by construction when the PTY worker stopped acking deliveries it never
 * observed (seam rule 4: "never claim an acknowledgement you did not observe"):
 * an unobserved delivery emits `delivery_verified` with verification
 * `timeout_fallback` plus `delivery_unobserved`, and NO `delivery_ack`.
 *
 * The risk in relaxing an equality is relaxing it into inertness. These cases
 * exist to hold the replacement to both halves of its job: it must accept the
 * unobserved shape the old assertion wrongly rejected, AND still fail on a
 * dropped ack. The `must fail` cases are the load-bearing ones — if they ever
 * start passing, the helper has stopped measuring anything.
 */
import assert from 'node:assert/strict';
import { describe, expect, it } from 'vitest';

import type { BrokerEvent } from '@agent-relay/harness-driver';
import { assertDeliveryObservationLedger, isObservedVerification } from '../../utils/assert-helpers.js';

const AGENT = 'worker-1';

const ack = (id: string) =>
  ({ kind: 'delivery_ack', name: AGENT, delivery_id: id }) as unknown as BrokerEvent;
const verified = (id: string, verification: string) =>
  ({ kind: 'delivery_verified', name: AGENT, delivery_id: id, verification }) as unknown as BrokerEvent;
const unobserved = (id: string) =>
  ({ kind: 'delivery_unobserved', name: AGENT, delivery_id: id }) as unknown as BrokerEvent;

describe('isObservedVerification', () => {
  it('treats echo and process_exit as observations', () => {
    expect(isObservedVerification(verified('d1', 'echo'))).toBe(true);
    // A headless child that consumed the message and exited cleanly DID read
    // it. Classifying this as unobserved is what made the broker emit
    // contradictory frames for one delivery id.
    expect(isObservedVerification(verified('d1', 'process_exit'))).toBe(true);
  });

  it('treats a timeout fallback as unobserved', () => {
    expect(isObservedVerification(verified('d1', 'timeout_fallback'))).toBe(false);
  });

  it('treats a frame with no verification field as observed', () => {
    // Older recordings predate the field; the helper must not retroactively
    // reclassify them as unobserved and fail on history.
    expect(isObservedVerification({ kind: 'delivery_verified', name: AGENT } as unknown as BrokerEvent)).toBe(
      true
    );
  });
});

describe('assertDeliveryObservationLedger — accepts', () => {
  it('an observed delivery that was acked', () => {
    assertDeliveryObservationLedger([ack('d1'), verified('d1', 'echo')], AGENT);
  });

  it('an unobserved delivery with no ack — the shape the old equality rejected', () => {
    assertDeliveryObservationLedger([verified('d1', 'timeout_fallback'), unobserved('d1')], AGENT);
  });

  it('a mixed stream of observed and unobserved deliveries', () => {
    assertDeliveryObservationLedger(
      [ack('d1'), verified('d1', 'echo'), verified('d2', 'timeout_fallback'), unobserved('d2')],
      AGENT
    );
  });
});

describe('assertDeliveryObservationLedger — still fails on', () => {
  it('an empty event stream', () => {
    assert.throws(() => assertDeliveryObservationLedger([], AGENT), /delivery observation ledger is empty/);
  });

  it('an observed delivery whose ack went missing', () => {
    assert.throws(
      () => assertDeliveryObservationLedger([verified('d1', 'echo')], AGENT),
      /every OBSERVED delivery_verified must have a delivery_ack/
    );
  });

  it('a process_exit delivery whose ack went missing', () => {
    assert.throws(
      () => assertDeliveryObservationLedger([verified('d1', 'process_exit')], AGENT),
      /every OBSERVED delivery_verified must have a delivery_ack/
    );
  });

  it('an unobserved delivery the broker never reported as unobserved', () => {
    // Silence presented as success — the exact substitution the seam exists to
    // prevent.
    assert.throws(
      () => assertDeliveryObservationLedger([verified('d1', 'timeout_fallback')], AGENT),
      /must be reported as delivery_unobserved/
    );
  });

  it('cross-delivery cancellation of a missing ack and a forbidden ack', () => {
    assert.throws(
      () =>
        assertDeliveryObservationLedger(
          [
            verified('missing-ack', 'echo'),
            ack('forbidden-ack'),
            verified('forbidden-ack', 'timeout_fallback'),
            unobserved('forbidden-ack'),
          ],
          AGENT
        ),
      /delivery_id=(missing-ack|forbidden-ack)/
    );
  });
});
