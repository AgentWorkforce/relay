# Phase 0 Rust seam mutation proof

Date: 2026-09-20

Contract targets:

- `crates/broker/tests/delivery_seam_invariants.rs`
- `crates/broker/src/delivery/pty.rs` (tests against the shipping route)

Each mutation below was applied to production code, the named test was run and
observed failing, and the mutation was immediately restored. The complete
restored suites are recorded at the end. Transcript excerpts retain the
assertion or outcome that proves the test detects the specific regression.

## falls_back_only_before_write

Mutation: allow the seam to continue to a fallback backend after a committed
send error.

```text
running 1 test
thread 'falls_back_only_before_write' panicked:
post-write failures must not fall back: Fresh(SendReceipt { delivery_id: DeliveryId("del_post_write"), route: RouteId("pty"), status: HandedOver(HandedOver) })
test falls_back_only_before_write ... FAILED
test result: FAILED. 0 passed; 1 failed
```

## never_resends_on_doubt

Mutation: bypass the receipt lookup so a repeated delivery id is sent as a new
delivery.

```text
running 1 test
thread 'never_resends_on_doubt' panicked:
assertion `left == right` failed
  left: Fresh(SendReceipt { delivery_id: DeliveryId("del_doubt"), route: RouteId("native"), status: HandedOver(HandedOver) })
 right: AlreadySent(SendReceipt { delivery_id: DeliveryId("del_doubt"), route: RouteId("native"), status: InDoubt })
test never_resends_on_doubt ... FAILED
test result: FAILED. 0 passed; 1 failed
```

## a_cancelled_send_remains_in_doubt_and_is_not_retried

Mutation: remove the provisional in-doubt receipt written before awaiting the
backend send. The pending backend future was then cancelled by the timeout.

```text
running 1 test
thread 'a_cancelled_send_remains_in_doubt_and_is_not_retried' panicked:
assertion `left == right` failed: cancelling after backend admission must leave a route receipt
  left: None
 right: Some("pending")
test a_cancelled_send_remains_in_doubt_and_is_not_retried ... FAILED
test result: FAILED. 0 passed; 1 failed
```

## records_route_for_each_send

Mutation: settle through the first available backend instead of the route
recorded by the send receipt.

```text
running 1 test
thread 'records_route_for_each_send' panicked:
assertion `left == right` failed
  left: Settled(Acked(ObservedAck { evidence: PeerAck { detail: "wrong route" } }))
 right: Settled(Acked(ObservedAck { evidence: Transcript { source: "pty", offset: 0 } }))
test records_route_for_each_send ... FAILED
test result: FAILED. 0 passed; 1 failed
```

## never_acks_without_observation

Mutation: make the seam's recorded-route settle path return without invoking
the backend.

```text
running 1 test
thread 'never_acks_without_observation' panicked:
assertion `left == right` failed: the seam must consult the recorded route; an empty settle implementation must fail this test
  left: 0
 right: 1
test never_acks_without_observation ... FAILED
test result: FAILED. 0 passed; 1 failed
```

## an_evicted_receipt_does_not_become_a_fresh_send

Mutation: disable the bounded-receipt eviction-history check on send.

```text
running 1 test
thread 'an_evicted_receipt_does_not_become_a_fresh_send' panicked:
an evicted receipt was classified Fresh, so the seam handed an already-sent message to a backend a second time
test an_evicted_receipt_does_not_become_a_fresh_send ... FAILED
test result: FAILED. 0 passed; 1 failed
```

## settle_distinguishes_absence_from_an_unreachable_route

Mutation: collapse a receipt whose recorded route is not present into
`NoReceipt`.

```text
running 1 test
thread 'settle_distinguishes_absence_from_an_unreachable_route' panicked:
assertion `left == right` failed: the recorded route must be named, not erased into absence
  left: NoReceipt
 right: RouteUnavailable(RouteId("pty"))
test settle_distinguishes_absence_from_an_unreachable_route ... FAILED
test result: FAILED. 0 passed; 1 failed
```

## settle_reports_an_evicted_receipt_as_unknown_not_absent

Mutation: forget eviction history in settle and report an evicted receipt as
ordinary absence.

```text
running 1 test
thread 'settle_reports_an_evicted_receipt_as_unknown_not_absent' panicked:
assertion `left == right` failed: a forgotten receipt must say it was forgotten
  left: NoReceipt
 right: RouteUnknown
test settle_reports_an_evicted_receipt_as_unknown_not_absent ... FAILED
test result: FAILED. 0 passed; 1 failed
```

## an_acknowledgement_must_name_the_observation_behind_it

Mutation: construct `peer_ack` with the `Echo` evidence variant, erasing the
distinction between two observation sources.

```text
running 1 test
thread 'an_acknowledgement_must_name_the_observation_behind_it' panicked:
assertion `left != right` failed
  left: ObservedAck { evidence: Echo { matched: "ok" } }
 right: ObservedAck { evidence: Echo { matched: "ok" } }
test an_acknowledgement_must_name_the_observation_behind_it ... FAILED
test result: FAILED. 0 passed; 1 failed
```

## real_pty_route_unknown_worker_is_pre_write_and_may_fall_back

Mutation: classify the shipping PTY route's unknown-worker pre-write refusal
as a committed error.

```text
running 1 test
thread 'delivery::pty::real_route_invariants::real_pty_route_unknown_worker_is_pre_write_and_may_fall_back' panicked:
an unknown worker is a pre-write refusal, so the seam may fall back: CommittedError { reason: "unknown worker 'no-such-worker'" }
test delivery::pty::real_route_invariants::real_pty_route_unknown_worker_is_pre_write_and_may_fall_back ... FAILED
test result: FAILED. 0 passed; 1 failed
```

## real_pty_route_write_failure_after_commit_does_not_fall_back

Mutation: classify the shipping PTY route's post-admission write failure as
available for fallback.

```text
running 1 test
thread 'delivery::pty::real_route_invariants::real_pty_route_write_failure_after_commit_does_not_fall_back' panicked:
a write that may have partially landed must not fall back: Fresh(SendReceipt { delivery_id: DeliveryId("del_committed"), route: RouteId("fallback-probe"), status: HandedOver(HandedOver) })
test delivery::pty::real_route_invariants::real_pty_route_write_failure_after_commit_does_not_fall_back ... FAILED
test result: FAILED. 0 passed; 1 failed
```

## real_pty_route_never_reports_an_observed_ack

Mutation: have the shipping PTY route fabricate a peer acknowledgement during
settlement even though it cannot observe the child reading the frame.

```text
running 1 test
thread 'delivery::pty::real_route_invariants::real_pty_route_never_reports_an_observed_ack' panicked:
the PTY route observes nothing, so it must settle as a hand-over, got Acked(ObservedAck { evidence: PeerAck { detail: "mutation" } })
test delivery::pty::real_route_invariants::real_pty_route_never_reports_an_observed_ack ... FAILED
test result: FAILED. 0 passed; 1 failed
```

## Restored baselines

```text
$ cargo test -p agent-relay-broker --test delivery_seam_invariants -- --nocapture

running 9 tests
test an_acknowledgement_must_name_the_observation_behind_it ... ok
test records_route_for_each_send ... ok
test never_acks_without_observation ... ok
test settle_distinguishes_absence_from_an_unreachable_route ... ok
test falls_back_only_before_write ... ok
test never_resends_on_doubt ... ok
test a_cancelled_send_remains_in_doubt_and_is_not_retried ... ok
test an_evicted_receipt_does_not_become_a_fresh_send ... ok
test settle_reports_an_evicted_receipt_as_unknown_not_absent ... ok

test result: ok. 9 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
```

```text
$ cargo test -p agent-relay-broker real_pty_route_ -- --nocapture

running 3 tests
test delivery::pty::real_route_invariants::real_pty_route_never_reports_an_observed_ack ... ok
test delivery::pty::real_route_invariants::real_pty_route_unknown_worker_is_pre_write_and_may_fall_back ... ok
test delivery::pty::real_route_invariants::real_pty_route_write_failure_after_commit_does_not_fall_back ... ok

test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 1308 filtered out
```
