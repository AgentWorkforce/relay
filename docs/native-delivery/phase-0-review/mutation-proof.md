# Phase 0 Rust seam mutation proof

Date: 2026-09-20

Contract target: `crates/broker/tests/delivery_seam_invariants.rs` named tests.

Each mutation was applied to `crates/broker/src/delivery/backend.rs`, then:

1. run the named test and capture the failing transcript,
2. restore `backend.rs`,
3. run the same test again and capture the passing transcript.

Command prefix used throughout: `${CARGO:-$HOME/.cargo/bin/cargo}`.

## Restored baseline

```text
cargo test -p agent-relay-broker --test delivery_seam_invariants

running 4 tests
all seam invariant tests ... ok

test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```

## falls_back_only_before_write

Mutation: in committed-error branch, continue fallback instead of returning.

Fail transcript:

```text
running 1 test
test falls_back_only_before_write ... FAILED

---- falls_back_only_before_write stdout ----
thread 'falls_back_only_before_write' (...) panicked at crates/broker/tests/delivery_seam_invariants.rs:119:10:
post-write failures must not fall back: Fresh(SendReceipt { delivery_id: DeliveryId("del_post_write"), route: RouteId("pty"), status: HandedOver(HandedOver) })

test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 3 filtered out; finished in 0.00s
```

Restored transcript:

```text
running 1 test
test falls_back_only_before_write ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 3 filtered out; finished in 0.00s
```

## never_resends_on_doubt

Mutation: break duplicate-delivery-id lookup so second send is treated fresh.

Fail transcript:

```text
running 1 test
test never_resends_on_doubt ... FAILED

---- never_resends_on_doubt stdout ----
thread 'never_resends_on_doubt' (...) panicked at crates/broker/tests/delivery_seam_invariants.rs:164:5:
assertion `left == right` failed
  left: Fresh(SendReceipt { delivery_id: DeliveryId("del_doubt"), route: RouteId("native"), status: HandedOver(HandedOver) })
 right: AlreadySent(SendReceipt { delivery_id: DeliveryId("del_doubt"), route: RouteId("native"), status: InDoubt })

test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 3 filtered out; finished in 0.00s
```

Restored transcript:

```text
running 1 test
test never_resends_on_doubt ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 3 filtered out; finished in 0.00s
```

## records_route_for_each_send

Mutation: settle via first backend instead of recorded route.

Fail transcript:

```text
running 1 test
test records_route_for_each_send ... FAILED

---- records_route_for_each_send stdout ----
thread 'records_route_for_each_send' (...) panicked at crates/broker/tests/delivery_seam_invariants.rs:203:5:
assertion `left == right` failed
  left: Acked(ObservedAck { detail: "wrong route" })
 right: Acked(ObservedAck { detail: "pty transcript" })

test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 3 filtered out; finished in 0.00s
```

Restored transcript:

```text
running 1 test
test records_route_for_each_send ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 3 filtered out; finished in 0.00s
```

## never_acks_without_observation

Mutation: upgrade `HandedOver` settle result to fabricated `Acked`.

Fail transcript:

```text
running 1 test
test never_acks_without_observation ... FAILED

---- never_acks_without_observation stdout ----
thread 'never_acks_without_observation' (...) panicked at crates/broker/tests/delivery_seam_invariants.rs:243:5:
assertion failed: matches!(settle, SettleStatus::HandedOver(HandoverState::HandedOver))

test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 3 filtered out; finished in 0.00s
```

Restored transcript:

```text
running 1 test
test never_acks_without_observation ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 3 filtered out; finished in 0.00s
```
