# Fresh-eyes adversarial review — codex fix round 2 (phase 0, the seam)

Reviewer: Claude (Opus 5). Read-only. I edited no product code, no test, and
nothing under `scripts/` or `flows/`. I did not commit, push, merge, or touch
`main`. I did not rebuild Rust or re-run parity; every claim below is anchored
to a line that makes it true, and where a claim depends on runtime timing I say
so explicitly.

## What I read

`git diff main -- crates/` in full, plus the code the diff *touches but does
not show*, because every finding below lives in the interaction:
`crates/broker/src/runtime/fleet.rs` (the confirm path and
`handle_fleet_deliver`), `crates/broker/src/runtime/maintenance.rs` (the retry
filter), `crates/broker/src/node_control.rs` (`FleetDeliveryBook` in full),
`crates/broker/src/worker.rs` (the writer task), `crates/broker/src/pty_worker.rs`,
`crates/broker/src/runtime/headless.rs`, `packages/contracts/fixtures/event-fixtures.json`,
`packages/harness-driver/src/protocol.ts`,
`packages/sdk-swift/Sources/AgentRelayBrokerSDK/BrokerTypes.swift`,
`tests/integration/broker/{stress,cli-spawn}.test.ts`,
`tests/integration/broker/utils/obligation-conformance.ts`.

I read `docs/native-delivery-migration.md` ("Phase 0 — the seam"), and the four
prior review/fix documents in this directory as *claims*, not as findings. I
re-derived everything. Where a prior finding is still live I say so and do not
re-litigate it; where a fix created a new defect I treat it as new.

---

## Verdict

**DO NOT SEAL. DO NOT MERGE.**

Single most important reason: **F1 — `FleetDeliveryBook::abandon_unconfirmed_delivery`
un-holds a sibling delivery that was already confirmed and already delivered,
and nothing removes that sibling from `pending_deliveries`. The maintenance
retry loop then re-injects an already-delivered message into the agent's
terminal, and — because the cursor has moved past its sequence — its next
confirmation cannot clear it, so it is re-injected again roughly every six
seconds, indefinitely.** That is not a one-off double delivery; it is an
unbounded redelivery loop, produced by the single largest change in this fix
pass, on the exact failure mode the design doc calls "the worst" and "a release
blocker".

The fix pass is directionally right — removing the fabricated `delivery_ack`
from the PTY timeout path (`crates/broker/src/pty_worker.rs:2259-2292`) is a
real correction of codex-review-1 F1, and the typed `WorkerDeliverError`
boundary is the right shape. But three of its seven changes each open a path
where a message is delivered twice or lost with no dead letter, and the
cumulative-ACK change is the worst of them.

Counts: **2 blocker, 3 high, 5 medium, 4 low/info.**

---

## F1 — BLOCKER. `abandon_unconfirmed_delivery` releases a held sibling from the retry guard without removing it from the pending map, producing an unbounded re-injection loop for an already-delivered message

### Evidence

`crates/broker/src/node_control.rs:1184-1206` — the new method. Its drain loop
is copied from `commit_confirmed_delivery` (`node_control.rs:1149-1176`) and,
like it, **removes** each drained sequence from `confirmed_delivery_seqs`:

```rust
cursor.confirmed_delivery_seqs.insert(deliver.seq, ());
loop {
    let next = cursor.acked_up_to_seq.saturating_add(1);
    if next > cursor.received_up_to_seq
        || cursor.confirmed_delivery_seqs.remove(&next).is_none()   // <- removes
    { break; }
    cursor.acked_up_to_seq = next;
}
```

`crates/broker/src/node_control.rs:1208-1215` — `confirmed_delivery_seqs` is the
sole backing store for `is_delivery_confirmation_held`.

`crates/broker/src/runtime/maintenance.rs:155-166` — `is_delivery_confirmation_held`
is the *only* thing that keeps an out-of-order-confirmed pending entry out of
the retry sweep:

```rust
let confirmation_is_held = pending.withheld_fleet_ack.as_ref()
    .is_some_and(|deliver| fleet_delivery_book.is_delivery_confirmation_held(deliver));
if pending.next_retry_at <= now && !confirmation_is_held { /* retry */ }
```

`crates/broker/src/runtime/fleet.rs:1814-1827` — the *confirm* path, when it
advances the cursor, also prunes every sibling at or below the new floor:

```rust
(Some(deliver), Some((_, up_to_seq))) if deliver.seq > 0 => {
    advance_pending_fleet_ack_floors(pending_deliveries, &deliver.agent_id, *up_to_seq);
    pending_deliveries.retain(|_, sibling| { /* drop siblings with seq <= up_to_seq */ });
}
```

`crates/broker/src/runtime/worker_events.rs:864-910` — the new unobserved branch
calls `abandon_unconfirmed_delivery` and **nothing else**: no
`advance_pending_fleet_ack_floors`, no `retain`, no ack enqueue.

`crates/broker/src/runtime/fleet.rs:1825-1827` — and when a confirmation cannot
advance the cursor, the confirm path **re-inserts** the pending entry:

```rust
(Some(_), None) => { pending_deliveries.insert(pending.delivery.delivery_id.clone(), pending.clone()); }
```

### Failure scenario

Agent `worker-a`, two node-control deliveries in flight, both PTY-injected, both
tracked in `pending_deliveries` with a `withheld_fleet_ack`. Cursor starts
`acked = 3`, `received = 5`.

- `A` = msg at `seq 4` (long body; its echo string never matches — this is the
  ordinary cause of a timeout fallback).
- `B` = msg at `seq 5`, injected immediately after, echoes cleanly.

1. `B`'s echo lands first. `delivery_ack` → `confirm_pending_delivery_and_resolve_fleet_ack`
   → `commit_confirmed_delivery(5)` inserts `5` into `confirmed_delivery_seqs`,
   the drain stops at `next = 4` (not confirmed), `acked` stays `3`, so the
   function returns `None`. The `(Some(_), None)` arm at `fleet.rs:1825`
   **re-inserts `B` into `pending_deliveries`**. `B` is excluded from retries
   only because `is_delivery_confirmation_held(5)` is `true`. `B` has been
   delivered, confirmed, `MessageDeliveryConfirmed` emitted, read-acked.
2. Five seconds later `A`'s verification window expires. The worker emits
   `delivery_verified { verification: "timeout_fallback" }`. The new branch at
   `worker_events.rs:864` removes `A` from pending, marks it terminal, and calls
   `abandon_unconfirmed_delivery(A)`.
3. Inside it: insert `4`; drain `next = 4` → `acked = 4`; drain `next = 5`,
   which **is** present (that is `B`'s held confirmation) → **removed** →
   `acked = 5`.
4. `is_delivery_confirmation_held(5)` is now `false`. `B`'s pending entry has
   `next_retry_at = t_inject(B) + delivery_ack_timeout(Steer) ≈ t + 6s`, which
   is at most ~1s away. The next maintenance tick retries it.
5. `retry_pending_delivery` re-sends `B` through the seam →
   `PtyDeliveryBackend` → `WorkerRegistry::deliver_with_commit_boundary` → the
   agent's terminal receives message `B` **a second time**.
6. It does not stop. When the second copy echoes, `commit_confirmed_delivery(5)`
   hits `if deliver.seq <= cursor.acked_up_to_seq { return None; }`
   (`node_control.rs:1160`), returns `None`, and the `(Some(_), None)` arm
   re-inserts `B` again — this time with `is_delivery_confirmation_held(5)`
   still false, because `5` is no longer in the map and nothing will ever put it
   back. `B` is re-injected on every ack-timeout cycle, forever, and emits a
   fresh `MessageDeliveryConfirmed` each round.

Wrong outcome: an agent receives the same message every ~6 seconds until the
broker is restarted, and the orchestrator is told it was confirmed every time.
Note that the two preconditions are *correlated, not independent*: the message
whose echo never matches is exactly the one whose successor confirms first.

### Repair

`abandon_unconfirmed_delivery` must not be allowed to drain another delivery's
held confirmation as a side effect, and any advance it does cause must go
through the same bookkeeping as `commit_confirmed_delivery`:

1. Make it return `Option<u64>` exactly like `commit_confirmed_delivery`, and at
   the call site in `worker_events.rs:902` apply the full consequence set the
   confirm path applies: `advance_pending_fleet_ack_floors`, the sibling
   `retain`, and `enqueue_delivery_ack`. Extracting one
   `apply_cursor_advance(pending_deliveries, book, agent_id, up_to_seq)` helper
   used by both call sites is the only way this stays true under later edits.
2. Add a regression test with the exact shape above: two same-agent fleet
   deliveries, higher seq confirmed first, lower seq settled unobserved, then
   assert `pending_deliveries.is_empty()` and that no second
   `deliver_relay` frame reaches the worker. Mutate the `retain` away and prove
   the test goes red.

---

## F2 — BLOCKER. `TerminalInDoubt` on the fleet path makes the *engine* redeliver a message whose write may already have committed

### Evidence

`crates/broker/src/runtime/delivery.rs:1036-1042` — a `CommittedError` removes
the pending entry and returns `TerminalInDoubt`.

`crates/broker/src/runtime/delivery.rs:941-943` — `insert_and_attempt_delivery`
converts that into `anyhow::bail!(last_error)`.

`crates/broker/src/runtime/fleet.rs:1217-1227` — the fleet `WorkerMissing` path
calls `insert_and_attempt_delivery` and propagates its `Err`.

`crates/broker/src/runtime/fleet.rs:909-921` — `handle_fleet_deliver`'s `Err`
arm: logs "fleet delivery injection failed; withholding ack" and `return`s. It
does **not** call `commit_received`, so `seen_msg_ids` never learns this
`msg_id` and `received_up_to_seq` never advances.

`crates/broker/src/node_control.rs:1013-1040` — on the engine's redelivery of
that same frame, `observe` therefore returns `Deliver`, not `Duplicate` and not
`Stale`.

### Failure scenario

A node-control `deliver` for `worker-a` at `seq 7` arrives while the worker
handle exists but its stdin writer faults mid-frame. The writer's completion
channel returns `Err` (`worker.rs:1519`) → `WorkerDeliverError::Committed` →
`DeliveryError::CommittedError` (`delivery/pty.rs:55-57`) → `TerminalInDoubt` →
`bail!` → `handle_fleet_deliver` withholds the ack and drops the frame without
recording it.

Relaycast still holds `seq 7` outstanding and redelivers it on the next
reconnect or retry. The broker has no memory of it, classifies it `Deliver`, and
injects it again — **on the same transport, after a failure the code has just
classified as post-write**. That is rule 1 inverted: the commit boundary was
computed correctly and then discarded one stack frame later. Rule 2 ("never
re-send on doubt") is violated by the same path, with the engine doing the
re-send.

Secondary, on the same finding: `emit_delivery_attempt_outcome`
(`delivery.rs:1153-1176`) emits `BrokerEvent::MessageDeliveryFailed` for an
in-doubt delivery while its own `tracing::warn!` says it is deliberately not
dead-lettering "because redelivery may duplicate". Telling the orchestrator a
message *failed* is the same invitation to redeliver as a dead letter, delivered
over a different channel. And the withheld `Deliver` riding on the removed
`PendingDelivery` is never passed to `abandon_unconfirmed_delivery`, so this
path reproduces in full the cursor-pinning defect (R2-1) that
`abandon_unconfirmed_delivery` was written to cure — the cure was applied to one
of the several terminal paths.

### Repair

An in-doubt fleet delivery must be *recorded as received and owned* before it is
abandoned, so the engine cannot resurrect it:

1. In the `TerminalInDoubt` arm of `handle_fleet_deliver`'s caller, call
   `fleet_delivery_book.commit_received(&deliver)` (so `seen_msg_ids` dedupes a
   redelivery to `Duplicate`) and route the withheld ack through the same
   cursor-advance helper F1 asks for.
2. Replace `MessageDeliveryFailed` with a distinct in-doubt event
   (`packages/contracts/fixtures/event-fixtures.json` already declares an
   `uncertain` message-lifecycle state — use it) so no consumer reads "failed"
   and redelivers.
3. Test: drive a committed writer failure on a fleet delivery, then replay the
   identical `Deliver` frame, and assert the second frame is classified
   `Duplicate` and produces no `deliver_relay` to the worker.

---

## F3 — HIGH. The commit boundary reports `Committed` for frames that were provably never written, and those messages are then dropped with no dead letter

This is the inverse of the failure mode the task asked me to hunt ("reports
pre-write after bytes reached the tty") and is the one that is actually present.

### Evidence

`crates/broker/src/worker.rs:333-340` — when one write fails, the writer drains
every *queued, unwritten* command and completes each with an `Err`:

```rust
while let Ok(mut queued) = command_rx.try_recv() {
    if let Some(completion) = queued.completion.take() {
        let _ = completion.send(Err(format!(
            "worker command writer stopped after write failure: {error}"
        )));
    }
}
```

`crates/broker/src/worker.rs:1517-1519` — every `Ok(Err(msg))` from that channel
is mapped to `WorkerDeliverError::Committed`, unconditionally.

`crates/broker/src/delivery/pty.rs:55-57` → `DeliveryError::committed` →
`crates/broker/src/runtime/delivery.rs:1036-1042` → `TerminalInDoubt` → removed
from `pending_deliveries`, **not** dead-lettered (`delivery.rs:1153-1176`).

### Failure scenario

`WORKER_WRITE_QUEUE_CAPACITY` is 128 (`worker.rs:70`). A burst of, say, 12
messages is queued to `worker-a`; the first one's write times out at
`WORKER_WRITE_TIMEOUT` (`worker.rs:77`). Message 1 is genuinely in doubt —
correct. Messages 2..12 never reached `stdin.write_all` at all; the writer
drained them from the mpsc queue. All eleven are reported `Committed`, become
`TerminalInDoubt`, are removed from `pending_deliveries`, and are **not**
written to the dead-letter store. Eleven messages are silently lost, with no
operator-visible record beyond a `MessageDeliveryFailed` event and a warn line.
Before this pass those eleven would have returned an ordinary error, been
retried, and — on exhaustion — dead-lettered for redelivery.

### Repair

The drain loop knows perfectly well that it did not write these frames. Give it
a distinct error so the boundary is honest:

1. In `worker.rs:333-340`, complete drained commands with a marker the caller
   can classify, e.g. `Err(format!("{UNWRITTEN_PREFIX}{error}"))` or (better) a
   typed completion payload `Result<(), WriteFailure>` carrying
   `WriteFailure::NotAttempted` / `WriteFailure::AfterWriteStarted`.
2. Map `NotAttempted` to `WorkerDeliverError::PreWrite`, so those deliveries
   keep the legacy retry-then-dead-letter policy.
3. Test: queue two commands, force the first write to fail, assert the second
   resolves as `PreWrite` and reaches the dead-letter store after the retry cap.

---

## F4 — HIGH. On the post-restart path `abandon_unconfirmed_delivery` can jump the cumulative cursor over lower, unconfirmed siblings, because it skips the prologue the confirm path performs

### Evidence

`crates/broker/src/runtime/fleet.rs:1791-1796` — the confirm path's prologue,
and the reason it exists:

```rust
if let Some(deliver) = pending_deliveries.get(delivery_id).and_then(|p| p.withheld_fleet_ack.as_ref()) {
    let group = pending_fleet_ack_group(pending_deliveries.values(), &deliver.agent_id);
    fleet_delivery_book.restore_pending_agent(&group.deliveries, group.floor);
}
```

Its doc comment (`fleet.rs:1772-1781`) states the hazard verbatim: "the broker
may retry an already-landed delivery, but it cannot falsely ACK an undelivered
lower one."

`crates/broker/src/runtime/worker_events.rs:900-903` — the unobserved branch
calls `abandon_unconfirmed_delivery` with no such prologue.

`crates/broker/src/node_control.rs:1110-1126` — inside `commit_received`, when
the cursor has no sequenced position, it **seeds** `acked = received = seq - 1`
and then advances `received` to `seq`.

### Failure scenario

The broker restarts with persisted pending deliveries for `worker-a` at
`seq 5, 6, 7` (all previously injected, none confirmed). The book is empty at
startup; `restore_pending_agent` and `seed_cursor` are only reached from the
confirm path (`fleet.rs:1795`) and agent re-registration (`fleet.rs:2111`), and
`token.delivery_ack_seq` is `Option` — if it is absent, no seed happens.

The maintenance loop re-injects all three. `seq 7`'s verification window expires
first (it is the shortest body, or simply the first to hit five seconds) and
settles unobserved. `abandon_unconfirmed_delivery(deliver_7)` →
`commit_received` finds no sequenced position → seeds `acked = received = 6` →
advances `received` to `7` → inserts `7` and drains it → **`acked = 7`**.

Sequences 5 and 6 were never delivered and never confirmed, and the broker's
cursor now sits above them. The next genuinely confirmed delivery (`seq 8`)
emits `enqueue_delivery_ack(worker-a, 8)`, and a cumulative ack through 8 claims
5, 6 and 7 as delivered. `crates/broker/src/runtime/delivery.rs:107-111` states
this contract explicitly: "A cumulative ACK through `acked_up_to_seq` proves
every lower sequence is complete." Two messages the agent never saw are retired
at the engine, with no dead letter and no unread state.

### Repair

Give the abandon path the same prologue, and refuse to advance past an
unrestored frontier:

1. At `worker_events.rs:900`, call
   `pending_fleet_ack_group` + `restore_pending_agent` for the agent before
   `abandon_unconfirmed_delivery`, exactly as `fleet.rs:1791-1796` does.
2. In `abandon_unconfirmed_delivery`, return early when
   `!cursor.has_sequenced_position` rather than letting `commit_received` seed
   the cursor from the abandoned frame — an unobserved delivery is the worst
   possible source of truth for a cursor origin.
3. Test: restart-shaped fixture with pending `5,6,7`, settle `7` unobserved,
   assert `acked_up_to_seq` is still below 5.

---

## F5 — MEDIUM. Abandoning still claims the acknowledgement, one message later, and leaves sibling ack floors stale

`crates/broker/src/node_control.rs:1180-1183` claims: "This does not return an
ACK to send immediately". True and irrelevant — the cursor it advances is
cumulative. Once `acked_up_to_seq` includes an unobserved sequence, the *next*
real confirmation emits an ack that covers it (`fleet.rs:967-972`,
`delivery.rs:107-111`). The engine retires a message nobody observed landing.
Rule 4 is satisfied in the letter of the immediate frame and broken in the
substance.

Separately, `advance_pending_fleet_ack_floors` (`delivery.rs:112-128`) is never
called from the abandon path. Its doc comment says the raise exists "so a later
broker restart cannot wait forever for an already acknowledged confirmation" —
so every surviving same-agent sibling keeps a floor below the new cursor, which
is exactly the state that comment says must not persist across a restart.

**Repair.** If the project accepts "advance past unobserved", it must be
explicit and observable: emit the cumulative ack at abandon time with an
`unobserved_through_seq` marker on the probe
(`crates/broker/src/node_delivery_probe.rs`), and call
`advance_pending_fleet_ack_floors` in the same breath. If it does not accept it,
the delivery must instead be dead-lettered *and* the engine told explicitly, not
silently folded into a later cumulative ack. Either way the current middle
position — silently advance, tell nobody — is the one option that is
indefensible.

---

## F6 — MEDIUM. The seam is still constructed per call, so `SendOutcome`, `recorded_route`, `settle` and the bounded receipt memory have no production effect — and the shape chosen for `AlreadySent` will wedge the retry loop the moment that is fixed

`crates/broker/src/runtime/delivery.rs:1003-1004`:

```rust
let mut seam = crate::delivery::DeliverySeam::new();
let mut pty_backend = crate::delivery::pty::PtyDeliveryBackend::new(workers);
```

A fresh `DeliverySeam` per attempt means `receipts` is always empty. So:
`SendOutcome::AlreadySent` is unreachable in production (`delivery.rs:1008` is
dead), `recorded_route` has no production caller, `DeliverySeam::settle` has no
production caller at all, and `MAX_RECEIPTS`
(`crates/broker/src/delivery/backend.rs:231`) bounds nothing. Three of the four
contract rules are enforced only inside
`crates/broker/tests/delivery_seam_invariants.rs`, against `ScriptedBackend`.
This was claude-review-1 F4; it is still live and I re-derived it independently.

What is *new* is that the R2-4 fix picked a mapping that makes the eventual
repair actively dangerous. When the seam is hoisted to live on `BrokerRuntime`:

- `delivery.rs:1008` maps `AlreadySent` to `DeliveryAttemptOutcome::Noop`,
  which does not touch `next_retry_at`. A pending delivery whose ack never
  arrives would then be re-entered by every maintenance tick, return `Noop`
  every time without advancing its own clock, and never retry, never fail,
  never dead-letter — a permanently stuck delivery plus a hot loop.
- At 4096 receipts the FIFO eviction in `record_receipt`
  (`backend.rs:325-330`) drops the oldest receipt. A delivery whose receipt was
  evicted and which is retried afterwards is classified `Fresh` again — the
  duplicate guard resurrects precisely the duplicate it exists to stop. The
  bound is on the wrong key: it should be a time/size-bounded map keyed by
  delivery id with an explicit "forgotten, therefore never retry" tombstone, not
  a FIFO of receipts that silently forgets.

**Repair.** Hoist the seam to a runtime field in the same change that maps
`AlreadySent` to a *distinct* outcome (e.g. `AlreadyRouted { route }`) which
still advances `next_retry_at` and still permits dead-lettering, and replace the
FIFO with a bounded structure whose eviction cannot produce `Fresh` for a known
id.

---

## F7 — MEDIUM. The headless route acks before the child has read anything, and now also declares the same delivery unobserved

`crates/broker/src/runtime/headless.rs:277-286` sends `delivery_ack`
*immediately after spawning the child*, before it has written or read a byte of
the message. The broker treats that as an observation:
`worker_events.rs:716-727` confirms and clears the pending delivery,
`:776-786` emits `MessageDeliveryConfirmed`, `:787-795` marks it read. That is
rule 4 broken at the source, and this fix pass did not touch it.

The pass then added `"verification": "process_exit"` at
`headless.rs:318-324`. Under the new `verification != "echo" ⇒ unobserved` rule
(`worker_events.rs:838-846`), the broker now emits a `delivery_unobserved` event
for a delivery it has already confirmed, read-acked and (for a fleet delivery)
acked to the engine. Consumers get both statements about one delivery id. And if
the earlier `delivery_ack` frame is dropped — `headless.rs:277` is
`let _ = send_frame(...)` on a bounded channel — the unobserved branch runs
instead, and a delivery whose child exited 0 is settled terminally and has its
fleet cursor abandoned.

**Repair.** Move the headless `delivery_ack` to after `child.wait()` succeeds,
and treat `process_exit` as an *observed* verification value (it is one: the
process consumed the message and exited cleanly). Add `process_exit` beside
`ECHO_VERIFICATION` in a single `is_observed(verification)` predicate in
`delivery_verification.rs` so the worker and the broker cannot drift.

---

## F8 — MEDIUM. The retry-timing ordering is usually true, not guaranteed

`crates/broker/src/runtime/delivery.rs:1075-1085` makes the Steer ack timeout
`VERIFICATION_WINDOW + VERIFICATION_TICK + 800ms` = 6.0s against a 5.0s worker
window. Three reasons the ordering is not actually guaranteed:

1. **Different clock origins.** The broker's `next_retry_at` starts when the
   frame is written to the worker's stdin (`delivery.rs:1025-1026`); the
   worker's window starts at `injected_at` (`pty_worker.rs:2126`), after paced
   keystroke injection completes. With a slow `RELAY_INJECT_RATE_MS` and a long
   body, injection alone can exceed the 1.0s of slack. The ordering is restored
   only by the `delivery_injected` frame resetting `next_retry_at`
   (`worker_events.rs:800-806`) — and that frame is emitted best-effort
   (`let _ = send_frame`) over a bounded channel. Lose it under load and the
   broker's retry fires inside the worker's echo window: a re-injection while
   the first copy is still pending verification, i.e. a double delivery.
2. **Per-CLI windows are not linked to the constant.**
   `pty_worker.rs:948-952` picks `Duration::from_secs(3)` for droid and
   `VERIFICATION_WINDOW` otherwise. Nothing — no type, no test, no
   `const_assert` — prevents the next per-CLI window from exceeding
   `VERIFICATION_WINDOW` and silently inverting the ordering.
3. **The slack is a magic 800ms** with no comment tying it to the maintenance
   tick period, which is the real quantisation of "when the retry actually
   fires".

**Repair.** Derive the broker timeout from a single exported
`max_verification_window()` in `delivery_verification.rs` that the per-CLI
selection must go through, add a unit test asserting
`delivery_ack_timeout(Steer, _) > max_verification_window() + tick`, and make
the relationship a compile-time or test-time fact rather than two constants that
happen to be ordered today.

---

## F9 — MEDIUM. Killed-child write failures now vanish instead of dead-lettering, and ~90 lines of retry-cap lifecycle coverage went with the test that proved it

`crates/broker/src/runtime/tests.rs` — `delivery_retry_transient_blip_emits_failed_event_for_present_worker`
was replaced by `delivery_retry_committed_writer_failure_stops_without_dead_letter`.
The deleted assertions covered: attempts staying within `MAX_DELIVERY_RETRIES`,
`last_error` accumulating the writer message, the terminal `Failed` outcome, the
`message_delivery_failed` wire shape including the typed `lastError` field, the
`dead_letter_added` event, and `dead_letters.len() == 1` with the body retained.

The replacement asserts the new classification — which is the behaviour change,
not a proof it is right. A child that has been killed is not "in doubt": it
cannot have consumed the message. Treating a broken-pipe write to a dead child
as committed converts a dead-lettered, operator-redeliverable message into a
silent drop, in exactly the case the deleted test covered.

**Repair.** Restore the lifecycle assertions against a *transient* writer error
(the case that still retries), and keep the new in-doubt assertion as a second
case. If a dead child is to be classified in doubt, the dead-letter store must
still receive the entry under an `in_doubt` disposition so nothing is lost — a
dead letter that is marked "do not auto-redeliver" satisfies both rules at once.

---

## F10 — MEDIUM-LOW. `verification_timeout_frames` tests cannot fail for the invariant they claim to guard

`crates/broker/src/broker/delivery_verification.rs:290-317` introduces the
function and a doc comment saying its purpose is to give the "never emit
`delivery_ack` here" invariant "a place a test can hold it to". The tests at
`:388-412` then assert properties of the vector the function returns.

They cannot fail for the thing that matters. Nothing links the function to the
`pty_worker` select loop. A future edit that adds
`send_frame(&out_tx, "delivery_ack", ...)` back into the timeout arm at
`pty_worker.rs:2288-2292` — right beside the loop that consumes these frames —
leaves both tests green. The test guards the helper; the hazard is at the call
site.

**Repair.** Assert on the frames the worker actually emits: drive the timeout
arm with a fake `out_tx` and assert the received kinds, or (cheaper and still
real) add a test that reads `pty_worker.rs` and fails if `"delivery_ack"`
appears inside the verification-timeout block. The mutation proof for this
invariant should mutate `pty_worker.rs`, not `backend.rs`.

---

## F11 — LOW. `delivery_unobserved` is a new wire event with no contract, no SDK type, and no fixture

`crates/broker/src/runtime/worker_events.rs:935-950` emits `delivery_unobserved`.
It appears nowhere else in the repository: not in
`packages/contracts/fixtures/event-fixtures.json` (`broker_event_kinds`), not in
`packages/harness-driver/src/protocol.ts`, not in
`packages/sdk-py/src/agent_relay/protocol.py`, not in the Swift `BrokerEvent`
decoder. Swift degrades to `.unknown` safely, so this is not a crash — it is an
undeclared event no consumer can act on, which makes the seam's central new
signal invisible to every client.

Note the contract fixture already declares `"uncertain"` in
`message_lifecycle_states` — the vocabulary for this exists and was not used.

**Repair.** Add the kind to the contract fixture and to each SDK's event union
in the same change, or map the state onto the existing `uncertain` lifecycle
state rather than minting a parallel one.

---

## F12 — LOW. Existing integration conformance now contradicts the new frame sequence on the fallback path

- `tests/integration/broker/stress.test.ts:119` asserts
  `acks.length === verified.length`. The timeout-fallback path now emits
  `delivery_verified` with no `delivery_ack`, so any fallback during the stress
  run breaks this equality.
- `tests/integration/broker/cli-spawn.test.ts:327` asserts
  `ackIdx < verifiedIdx`, which requires a `delivery_ack` to exist.
- `tests/integration/broker/utils/obligation-conformance.ts:557,579` documents
  and asserts the sequence `… → message_delivery_confirmed → delivery_verified
  → delivery_read_ack`, none of which the unobserved path now produces.

None of these are in the phase's declared exit gates, which is itself the point:
the gate set cannot see this drift. (The parity scripts' blindness to the
`verification` field is codex-review-1 F2 and is still live — I re-derived it and
am not re-reporting it.)

**Repair.** Update these three suites to branch on `verification`, and add
`delivery_unobserved` to the sequence they accept, in the same change that ships
the frame change.

---

## F13 — LOW. `TerminalDeliveryGuard` bound and coverage

`crates/broker/src/runtime/event_loop.rs:288-318`. At `CAPACITY = 4096` the FIFO
evicts the oldest id, after which a late `delivery_ack` for that id is no longer
suppressed. In practice this is benign — the pending entry is already gone, so
`confirm_pending_delivery_and_resolve_fleet_ack` returns `(None, None)` — but
the guard's stated purpose ("a later stray `delivery_ack` cannot resurrect and
confirm it", `worker_events.rs:876-886`) is no longer unconditionally true, and
nothing tests the boundary.

Also: the guard is consulted only by the `delivery_ack` handler
(`worker_events.rs:705-707`). The `delivery_verified` handler
(`worker_events.rs:827`) never checks it, so a terminal delivery can still be
re-settled (and re-emit `delivery_unobserved`) by a stray verified frame.

**Repair.** Check the guard at the top of the `delivery_verified` handler too,
and add a test at the capacity boundary asserting a late ack for an evicted id
still produces no confirmation.

---

## F14 — INFO

- `crates/broker/src/lib.rs:9` makes `delivery` a `pub mod`, exporting
  `DeliverySeam`, `SendRequest::new`, `RouteId` and the whole trait surface as
  public API of `relay_broker` solely so an integration test can reach them. A
  `#[doc(hidden)]` module or a `pub(crate)` module plus a test-only re-export
  would keep the surface honest.
- All four tests in `crates/broker/tests/delivery_seam_invariants.rs` run
  against `ScriptedBackend`. `PtyDeliveryBackend` — the only backend that exists
  — is exercised by none of them. Combined with F6 (the seam is per-call in
  production), the four named contract invariants are currently properties of a
  mock harness, not of the shipping broker. This is R2-11; still live.
- `SettleStatus` has no `InDoubt` variant, so a route that has lost track of a
  delivery must report `Failed(String)` or `HandedOver` — neither of which means
  "I wrote it and I will never know". Phase 1's Codex route will need this.

---

## What would change my verdict

F1, F2 and F3 repaired, each with a test that is shown red before the fix (the
`seam-rules` per-invariant transcript requirement already forces this shape), and
F4 repaired or explicitly demonstrated unreachable with a restart-shaped
fixture. F5–F9 should be dispositioned in writing before seal even if some are
deferred; F10–F14 can ride a follow-up.

The two blockers share one root cause worth naming: this pass moved delivery
state between `pending_deliveries`, `confirmed_delivery_seqs` and the cumulative
cursor from **three** new places, while the pre-existing code changed all three
from exactly **one** place (`confirm_pending_delivery_and_resolve_fleet_ack`).
Every new call site reproduced part of that function's body and dropped a
different part of it. Until the advance and its consequences live behind one
helper that all callers must use, the next fix pass will open the next hole.
