# Fresh-eyes adversarial review, round 2 — phase 0 (seam)

Reviewer: Claude (Opus 5). Read-only. Nothing was committed, pushed, merged or
run against `main`. No CLI was launched in an untrusted directory and no
first-run prompt was answered; the only commands executed were `git diff`,
file reads, and the five node gates in
`scripts/migrate/native-delivery-gates.mjs` (`edit-gate`, `manifest-gate`,
`targeted-gate`, `seam-rules`, `unlaunched-gate`) in their non-recording form.

## What I read

The working-tree diff and every new file in it; the branch diff against
`main`; `phase-contract.json`; `docs/native-delivery-migration.md`;
`reviews/shadow-rust.md`, `reviews/claude-review-1.md`,
`reviews/codex-review-1.md`, `reviews/codex-fix-1.md`,
`reviews/claude-fix-1.md`; every `evidence/*.json` plus
`evidence/mutation-proof.md`; `seal-implementation.json`;
`BLOCKED_NO_COMMIT.md`.

I also read the code the diff *touches but does not show*, because the
defects below live in the interaction: `crates/broker/src/worker.rs`,
`crates/broker/src/runtime/fleet.rs`, `crates/broker/src/runtime/maintenance.rs`,
`crates/broker/src/runtime/dead_letter.rs`, `crates/broker/src/runtime/headless.rs`,
`crates/broker/src/node_control.rs`, `vitest.config.ts`, `vitest.e2e.config.ts`.

I re-derived the five node gates on the live tree rather than trusting the
`-final` artifacts (as `BLOCKED_NO_COMMIT.md` asks): all five pass now,
`targeted-gate` in `mode=full-smoke` with `fallbackReason` absent (the manifest
self-check), which the gate deliberately allows. I did not rebuild Rust or
re-run parity; where a finding depends on runtime behaviour I have said which
line makes the claim true rather than asserting a run I did not do.

## Verdict

**Blocked. Do not seal, commit or merge.** Two HIGH findings below are new in
this pass and both are double-delivery class — the failure mode the doc calls
"the worst" and "a release blocker". R2-1 in particular is a consequence of the
*fix* applied in `claude-fix-1`, not of the code that fix replaced, so it is not
covered by any prior review or by any gate in this campaign.

Findings are numbered `R2-n` to avoid collision with round 1's `F1–F20`. Where
a round-1 finding is still live I say so at the end rather than renumbering it.

---

## R2-1 — HIGH. Dropping the withheld fleet ack punches a permanent hole in the per-agent cumulative ACK cursor; every later delivery to that agent is pinned in `pending_deliveries` and re-injected after the next broker restart

**Where.** `crates/broker/src/runtime/worker_events.rs:866-908` (new) —
the timeout-fallback branch settles by calling
`clear_pending_delivery_if_event_matches` and letting the withheld ack "ride out
on the removed `PendingDelivery`", logged and dropped at `:899-906`.

That path does *not* call `confirm_pending_delivery_and_resolve_fleet_ack`, so
`FleetDeliveryBook` is never told anything about this sequence. The cursor is
strictly prefix-ordered:

- `crates/broker/src/node_control.rs:1152-1177` — `commit_confirmed_delivery`
  advances `acked_up_to_seq` only across a contiguous run of confirmed
  sequences, breaking at the first gap (`:1170-1171`).
- `crates/broker/src/node_control.rs:1180-1186` — `is_delivery_confirmation_held`
  reports true for any confirmed-but-unreleasable sequence.
- `crates/broker/src/runtime/fleet.rs:1814-1827` — when a later delivery
  confirms but cannot release (`(Some(_), None)`), its `PendingDelivery` is
  **re-inserted into `pending_deliveries`** and left there.
- `crates/broker/src/runtime/maintenance.rs:157-165` — those re-inserted
  entries are skipped by the retry sweep while `confirmation_is_held` is true,
  so nothing ever removes them.
- `crates/broker/src/runtime/delivery.rs:230-245, 275` — `pending_deliveries`
  is persisted, and reloaded with `next_retry_at: Instant::now()` ("retry
  immediately on restart"). `confirmed_delivery_seqs`
  (`node_control.rs:681-685`) is in-memory only and does **not** survive.

**Failure scenario (concrete).** Agent `worker-a`, fleet sequences 7, 8, 9.
Delivery 7 is injected; the PTY echo is not matched inside the 5 s window (a
false negative — noisy TUI repaint, a wrapped line, a CLI that reflows its
composer). The new branch removes delivery 7 from `pending_deliveries`, records
it terminal, and drops its withheld ack. `acked_up_to_seq` stays at 6 forever.
Deliveries 8 and 9 land and echo-verify normally; each calls
`commit_confirmed_delivery`, which parks them in `confirmed_delivery_seqs` and
returns `None`, so `fleet.rs:1822` re-inserts both into `pending_deliveries`.
The engine never receives a `delivery_ack` ≥ 7 for this agent again. The broker
restarts (upgrade, `node down`, crash). The reloaded snapshot contains 8 and 9,
due immediately, with an empty `confirmed_delivery_seqs`, so
`confirmation_is_held` is false and `retry_pending_delivery` re-injects both.
**Two messages the agent already read are delivered to it a second time**, and
the operator sees a healthy broker.

The comment at `fleet.rs:1779-1782` accepts "the broker may retry an
already-landed delivery" precisely because the hold was assumed *transient* —
before this change the timeout fallback always eventually confirmed, so the
prefix always closed. This change makes the hold permanent for any agent that
ever has one unmatched echo.

Partial mitigation, stated for accuracy: a genuine Relaycast read receipt for
sequence 7 would still advance the cursor
(`node_control.rs:1127-1145`, via `fleet.rs:1995`). That requires the recipient
to mark that exact message read — which is exactly what this change also stopped
requesting (see R2-9) — and is impossible in the case the fallback is supposed
to represent, where the message never landed.

**Severity.** HIGH. Double delivery plus a permanently un-acked engine cursor
for the affected agent. The `timeout_fallback` path is not exotic; it is the
designed response to every echo false negative.

**Repair.** Do not settle a withheld fleet ack by silently dropping it. Give the
book an explicit *abandon* operation — e.g.
`FleetDeliveryBook::abandon_unconfirmed_delivery(&Deliver)` — that removes that
sequence from the contiguity requirement so later confirmations can release
(either by advancing `received_up_to_seq` past it with an explicit
"never-confirmed" record, or by treating an abandoned seq as satisfiable in the
`commit_confirmed_delivery` loop at `node_control.rs:1167-1175`). Call it from
the new branch in `worker_events.rs:886-908` alongside the pending removal, and
assert in `timeout_fallback_never_confirms_or_acks_an_unobserved_delivery` that
a *subsequent* echo-verified delivery to the same agent both releases its own
ack and leaves `pending_deliveries` empty. Without that assertion the test is
green on the broken state today.

---

## R2-2 — HIGH. The PTY backend declares every write failure pre-write, so `falls_back_only_before_write` is false at the only backend that exists — and the repo says so, three files away

**Where.** `crates/broker/src/delivery/pty.rs:48-52`:

```rust
self.workers
    .deliver(worker_name.as_str(), delivery)
    .await
    .map_err(|error| DeliveryError::unavailable(error.to_string()))?;
```

Every error from `WorkerRegistry::deliver` becomes `Unavailable`, which
`backend.rs:157-159` defines as `is_pre_write() == true`, which
`backend.rs:258-260` uses as the licence to try the next backend.

That classification is contradicted in this crate:

- `crates/broker/src/worker.rs:1480-1493` — `send_to_worker` deliberately waits
  for the writer's own completion rather than timing out, and returns the
  writer's error.
- `crates/broker/src/worker.rs:322` — the writer's comment, on the path that
  produces that error: *"A failed or timed-out write may have consumed part of
  the frame."*
- `crates/broker/src/worker.rs:293-310` — the failure is a `write_all` + `flush`
  under a 5 s timeout. A `flush` that times out after a successful `write_all`
  is the canonical post-write error: the bytes are in the pipe and the worker
  will parse and inject them.

**Failure scenario.** Phase 1 lands `codex queue` as a second backend and the
ordering puts PTY first (or a `[native, pty]` list where PTY is reached and then
faults). A worker's stdin flush stalls past 5 s under load; `write_all` already
completed, so the worker parses the frame and injects the message. `deliver`
returns `Err`, `pty.rs:51` labels it `Unavailable`, `DeliverySeam::send`
continues to the next backend, and the message is delivered twice. Today, with
one backend, the same misclassification instead routes into
`retry_pending_delivery`'s retry arm (`runtime/delivery.rs:1025-1049`), which
re-sends up to `MAX_DELIVERY_RETRIES` — the same double delivery, arrived at
through the legacy path.

The trait doc at `backend.rs:190-194` acknowledges this as deliberate ("otherwise
use `Unavailable` and let the route's legacy retry policy stand"). That is a
decision to make the phase's first named invariant false at the seam's only
real implementation, written down in the seam rather than fixed.

**Severity.** HIGH. It is the contract invariant `falls_back_only_before_write`,
inverted, at the one place it can currently be observed.

**Repair.** Make the commit boundary observable instead of assumed. The writer
already knows: `worker.rs:289-333` distinguishes "never dequeued / queue closed"
(pre-write) from "write or flush faulted after the frame entered the writer"
(post-write). Thread that distinction out — a typed error on
`WorkerWriteCommand`'s completion channel, or a `WorkerDeliverError` enum with a
`committed: bool` — and map it in `pty.rs:48-52` to
`DeliveryError::committed(..)` for the post-write half. Then extend
`crates/broker/tests/delivery_seam_invariants.rs` with a case that drives
`PtyDeliveryBackend` (not `ScriptedBackend`) against a registry whose writer
faults mid-frame, and assert no second backend is consulted. If the boundary
genuinely cannot be recovered, the honest move is to fail the invariant in the
contract, not to document the hole in the trait.

---

## R2-3 — MEDIUM-HIGH. `verification` defaults to `"echo"`, so a route that never echo-checked anything is recorded as echo-observed — and the default is fail-open on exactly the question the phase exists to answer

**Where.** `crates/broker/src/runtime/worker_events.rs:840-845`:

```rust
let verification = payload
    .get("verification")
    .and_then(Value::as_str)
    .unwrap_or("echo");
```

`crates/broker/src/runtime/headless.rs:311-325` emits `delivery_verified` with
**no** `verification` field, on `exit_status.success()` — i.e. the headless
route's evidence is a process exit code, not an echo. The broker relabels it
`"echo"` and re-emits it to the SDK at `worker_events.rs:919-931`.

This was cosmetic before this diff. It is load-bearing now, in two places added
by this diff:

1. `worker_events.rs:846-848` — anything not exactly `"timeout_fallback"` takes
   the confirm-and-ack branch. A future route that emits
   `verification: "queued"` or `"handed_over"` is silently confirmed.
2. `tests/benchmarks/harness.ts:58-65` — `isObservedDelivery` is written as an
   allow-list (`=== 'echo'`) with a comment explaining why a deny-list is
   unsafe. The Rust side, which produces the value that predicate reads, is a
   deny-list with `"echo"` as the default. The parity gate therefore counts
   every headless delivery as echo-observed.

This is the hunt-list item "a route recorded as one transport and settled by
another's rules", in the one field the whole phase now keys on.

**Failure scenario.** A headless (`runtime: headless`) worker exits 0 without
having shown the message to a model — a wrapper script, a CLI that accepts and
discards on a config error, a `-p` invocation that prints usage and exits 0.
Relay emits `delivery_verified { verification: "echo" }`, confirms the pending
delivery, releases the engine ack, emits `MessageDeliveryConfirmed`, and marks
the message read. Nothing observed the delivery. Phase 0's stated purpose is to
stop exactly this.

**Repair.** Make the Rust side an allow-list too. Introduce
`const ECHO_VERIFICATION: &str = "echo"` next to
`TIMEOUT_FALLBACK_VERIFICATION` (`broker/delivery_verification.rs:283-286`) and
treat *only* an explicit `"echo"` as observed; route a missing or unknown value
into the same unobserved settlement as `timeout_fallback`. Separately, give the
headless route its own honest label — `verification: "process_exit"` — at
`headless.rs:316-325`, and decide explicitly whether a zero exit is an
observation (it is a defensible one; it is not an echo). Add a unit test on the
handler asserting that a `delivery_verified` payload with no `verification`
field does not produce `message_delivery_confirmed`.

---

## R2-4 — MEDIUM-HIGH. The seam's duplicate guard returns a cached receipt that the caller cannot distinguish from a fresh send, so F4's required fix will silently disable the retry loop

**Where.** `crates/broker/src/delivery/backend.rs:226-233` returns a stored
`SendReceipt` without consulting any backend.
`crates/broker/src/runtime/delivery.rs:1002-1024` — the caller's `Ok(_)` arm
treats any non-`InDoubt` receipt as a completed attempt: it increments
`attempts`, **resets `failed_attempts` to 0**, pushes `next_retry_at` out by a
full `delivery_ack_timeout`, clears `last_error`, and reports
`DeliveryAttemptOutcome::Attempted`, which
`emit_delivery_attempt_outcome` turns into a retry event on the wire.

Today the seam is constructed per call (`delivery.rs:997`), so the cache is
always empty — that is F4, still open, and it is the reason this is latent
rather than live. But F4's repair is explicitly "own the seam for the broker
runtime lifetime" (`BLOCKED_NO_COMMIT.md`). The moment that happens:

**Failure scenario.** Delivery `del_x` hands over to the PTY. No ack arrives
(the worker died between accepting the frame and injecting). Maintenance fires
`retry_pending_delivery`; the long-lived seam finds the `del_x` receipt and
returns it; no backend is called; the caller records a successful attempt,
resets `failed_attempts` to 0 and re-arms the timer. This repeats forever. The
message is never re-sent, `failed_attempts` never reaches
`MAX_DELIVERY_RETRIES`, the delivery never dead-letters, and the SDK receives a
`message_delivery_retry` event per tick for a retry that never happened —
a fabricated attempt, reported on the wire, indefinitely.

`never_resends_on_doubt` (`delivery_seam_invariants.rs:149-159`) *asserts* this
aliasing is correct (`assert_eq!(duplicate, receipt)`), so the invariant suite
will stay green through it.

**Repair.** Make the cached path distinguishable. Return
`Result<SendOutcome, DeliveryError>` where
`SendOutcome::{Fresh(SendReceipt), AlreadySent(SendReceipt)}`, and have
`retry_pending_delivery` treat `AlreadySent` as "leave the pending entry exactly
as it is" — no `attempts` increment, no `failed_attempts` reset, no
`next_retry_at` extension, no `Attempted` event. Bound and evict `receipts`
(`backend.rs:209`) in the same change, since F4's fix is what makes the
unbounded `VecDeque` reachable. Update `never_resends_on_doubt` to assert the
`AlreadySent` discriminant rather than receipt equality.

---

## R2-5 — MEDIUM. `terminal_failed_deliveries` now grows on every unmatched echo and can never shed those entries

**Where.** `crates/broker/src/runtime/worker_events.rs:896-899` (new) inserts
the delivery id. The only removal is `:729`, inside the `delivery_ack` handler
— but `:705-714` returns early for any id already in the set, so `:729` is
unreachable for anything this new branch inserted. The set is a plain
`HashSet<DeliveryId>` with no cap or sweep
(`crates/broker/src/runtime/event_loop.rs:256`,
`crates/broker/src/runtime/init.rs:724`).

**Failure scenario.** A long-lived broker (the whole point of `up --background`
on an always-on host) accumulates one permanent 20-plus-byte `DeliveryId` per
unverified delivery, forever, and pays an ever-growing hash lookup on the
`delivery_ack` hot path. Before this diff the set only grew on explicit
`delivery_failed` (`:1000`), which is rare; the timeout fallback is not.

**Repair.** Bound it the way the crate already bounds this shape — a
`VecDeque` + `HashSet` pair with a capacity and FIFO eviction, exactly as
`FleetDeliveryBook::retire_identity` does at
`crates/broker/src/node_control.rs:740-751` with
`RETIRED_AGENT_ID_CAPACITY` — or evict on the same schedule as the pending
store. Add a unit test that inserts `capacity + 1` terminal ids and asserts the
oldest is gone and the newest still guards.

---

## R2-6 — MEDIUM. The broker's Steer ack timeout equals the worker's verification window, and the only duplicate guard is cleared at exactly that instant

**Where.**
- `crates/broker/src/runtime/delivery.rs:1060-1069` —
  `delivery_ack_timeout(Steer, _) = max(retry_interval, VERIFICATION_WINDOW)`;
  `VERIFICATION_WINDOW` is 5 s (`broker/delivery_verification.rs:102`) and the
  default retry interval is 1 s (`runtime/util.rs:232-238`). So: exactly 5 s.
- `crates/broker/src/pty_worker.rs:2256-2258` — the worker's timeout fires on a
  200 ms tick once `injected_at.elapsed() >= verification_window`, i.e. also
  ~5 s, from a slightly *earlier* origin than the broker's timer (the broker
  arms its timer when it receives `delivery_injected`).
- `crates/broker/src/pty_worker.rs:2293` — the fallback removes the id from
  `pending_worker_delivery_ids`, the worker-local set (`:1164`) that is the
  only thing dropping a duplicate `deliver_relay` frame (`:1182-1187`).

**Failure scenario.** Steer-mode delivery. At T+5 s both timers are due. The
event loop (`runtime/event_loop.rs:387-395`) serialises worker events and
maintenance ticks, so ordering is whichever the `select!` takes. If the
maintenance tick wins: `retry_pending_delivery` re-injects the same
`delivery_id`; the worker has just cleared it from
`pending_worker_delivery_ids`, so the duplicate is **not** deduped and is
injected a second time. The fallback frame for the first attempt is then
processed, removes the pending entry and records the id in
`terminal_failed_deliveries` — so when the second injection *does* echo-verify,
its `delivery_ack` is discarded by the terminal guard at
`worker_events.rs:705-714`. Net result: the agent sees the message twice, the
engine ack is dropped, and the delivery is filed as terminally failed.

This race pre-dates the diff, but the diff is what makes both of its
consequences bite: previously the fallback produced a `delivery_ack` that
confirmed cleanly, and the terminal record that now poisons the second attempt
did not exist.

**Repair.** Make the two deadlines strictly ordered rather than equal: the
broker must not consider a delivery retryable until it has had a chance to hear
the worker's verdict. Change `delivery_ack_timeout`'s `Steer` minimum
(`runtime/delivery.rs:1066`) to `VERIFICATION_WINDOW + VERIFICATION_TICK +
slack` (or gate the retry on having received either a `delivery_verified` or a
`delivery_failed` for that id). Add a runtime test that drives the maintenance
tick and the fallback frame in the adverse order and asserts exactly one
`deliver_relay` reaches the registry.

---

## R2-7 — MEDIUM. The new "terminal shape" in `insert_and_attempt_delivery` is not terminal, and its comment contradicts its code

**Where.** `crates/broker/src/runtime/delivery.rs:928-938`. The comment says the
entry "must not become due and get handed to a route again before maintenance
emits the dead letter", and the very next lines set
`pending.next_retry_at = Instant::now()` — immediately due. The thing actually
holding the line is `failed_attempts = MAX_DELIVERY_RETRIES` and the cap check
at `:969-979`.

But that cap check is **not first**. `:956-966` runs before it:

```rust
if pending.delivery.event_id.as_str().starts_with("local_")
    && !workers.has_worker(&pending.worker_name)
{
    current.failed_attempts = 0;          // ← un-terminalises it
    current.next_retry_at = Instant::now() + retry_interval;
```

**Failure scenario.** A `local_` delivery fails with the seam's committed-error
or `InDoubt` disposition (`:998-1008`, `:1024-1030`) — a possible write. The
entry is re-inserted in the "terminal" shape. Before maintenance's next tick the
recipient is reaped or restarts (`has_worker` false). The `local_` branch now
resets `failed_attempts` to 0 and keeps the entry pending. When the worker
reconnects, the delivery is injected again: a re-send of a message that may
already have been written. That is seam rule 2 violated by the code written to
enforce it.

The same block also fabricates an attempt count: `attempts.max(1)` at `:934`
reports one transport attempt for the "recipient gone" case, where zero writes
were made, and that number reaches the wire via the dead letter and
`message_delivery_failed`. (Round 1's F10 named the fabricated count; the
`local_` reset is new.)

**Repair.** Mark the disposition, don't encode it in counters. Add a
`terminal: bool` (or a `Disposition` enum carrying `InDoubt`) to
`PendingDelivery`, set it here, and check it at the very top of
`retry_pending_delivery` — before the `local_` branch and before the cap — so no
later branch can resurrect it. Fix the comment at `:931-933` to describe what
the code does. Drop `attempts.max(1)` and let a zero-attempt terminal failure
report zero.

---

## R2-8 — MEDIUM. The seam's in-doubt dispositions dead-letter, and redelivering a dead letter deliberately mints a fresh delivery id so a late ack cannot match

**Where.** `crates/broker/src/runtime/delivery.rs:998-1007` (`InDoubt`) and
`:1025-1031` (committed error) both return `DeliveryAttemptOutcome::Failed`,
which `emit_delivery_attempt_outcome` files as a dead letter. Meanwhile
`crates/broker/src/runtime/worker_events.rs:889-893` (new) refuses to
dead-letter the PTY timeout fallback, in a comment that states the reason
exactly: *"a dead letter invites a redelivery that would double-deliver."*

Both statements cannot be right. And the dead-letter store is not inert:
`crates/broker/src/runtime/dead_letter.rs:208-237` requeues on operator command
(`runtime/api.rs:2310-2313`) and **assigns a new `delivery_id`** specifically so
that "a late ACK from the previous attempt … [cannot] match" — which is also
precisely what would make an in-doubt redelivery undetectable as a duplicate.

**Failure scenario.** A committed-error delivery dead-letters with reason
`"delivery backend error after possible write: …"`. An operator running
`node deadletters --redeliver` (reasonably: the queue's documented meaning is
"never delivered") requeues it under a fresh id. The agent receives the message
twice and nothing in the system can correlate the two.

**Repair.** Pick one disposition and make it consistent. Either route in-doubt
outcomes to the same terminal-without-dead-letter settlement the timeout
fallback now uses, or keep the dead letter but tag the entry
(`DeadLetterEntry { in_doubt: true }`), have `requeue_dead_letter` refuse it
outright, and have `node deadletters` render it as
"possibly delivered — redelivery may duplicate". This is the missing "general
terminal in-doubt outcome" already tracked as F11; R2-8 is the concrete harm
that makes it more than a design gap.

---

## R2-9 — MEDIUM. The read receipt is no longer sent for a timeout fallback, so a message that did land stays permanently unread in the workspace

**Where.** `crates/broker/src/runtime/worker_events.rs:886-895` deliberately
skips `mark_delivery_read_ack` (the call at `:787-795` on the ack path).

The reasoning is sound for a message that never arrived. But the timeout
fallback's dominant real-world cause is an echo *false negative* — the message
arrived and the screen scrape missed it. For those:

**Failure scenario.** The agent receives and answers the message. Relay never
marks it read. The workspace keeps it in the unread set, so `check_inbox` and
the unread/mention counts keep re-presenting a message the agent has already
handled, and the engine's un-acked record (R2-1) keeps the cursor stalled. From
the user's side the symptom is an agent that appears to have an inbox it never
drains.

This is precisely the "silent behaviour drift" the doc assigns to review rather
than to the gates: no parity script, eval or unit test observes read state.

**Repair.** Separate the two claims. "The recipient read this" (a read receipt)
and "relay observed the delivery land" (the engine ack) are different
assertions, and only the second is unsupported here. If relay is unwilling to
assert either, then the honest state must be *visible*: emit a distinct
`delivery_unobserved` SDK event (not a relabelled `delivery_verified`) carrying
the delivery id, and add a runtime test asserting that an operator-visible
signal exists for every timeout fallback. At minimum, record the decision in
`docs/native-delivery-migration.md` under the drift section, since Phase 2's
Claude routes will face the same choice with no completion signal at all.

---

## R2-10 — MEDIUM. The transient-blip test was rewritten in a way that both drops lifecycle coverage and re-arms a known flake

**Where.** `crates/broker/src/runtime/tests.rs:3405-3466`, replacing
`delivery_retry_transient_blip_emits_failed_event_for_present_worker`.

Two separate problems.

*Coverage.* The old test drove the full retry loop for a **present** worker to
cap exhaustion and asserted the terminal `message_delivery_failed` payload, the
`dead_letter_added` event, dead-letter retention, and the wire contract that the
field is `lastError` and not `last_error`. The new test makes one call and
asserts `Noop`. I checked for the coverage elsewhere rather than assuming its
absence: `retry_exhaustion_dead_letters_instead_of_discarding`
(`tests.rs:1991-2052`) covers exhaustion → dead letter for an *absent* worker
via a pre-seeded `failed_attempts`, and `tests.rs:4720-4745` covers the
`lastError` field name. What is now uncovered is the loop itself — that a
present worker's repeated writer faults actually reach the cap — which is the
only part of that lifecycle the seam change can break.

*Flake.* The old test carried an explicit tolerance:
"Some platforms can accept a final pipe write after the child exits, so terminal
failure may arrive on the immediate post-cap check", and accepted `Attempted`
for any `retry_index <= MAX_DELIVERY_RETRIES`. The new test requires the **first**
write against a killed child to fail: `assert_eq!(outcome, Noop)`,
`attempts == 1`, `failed_attempts == 1`. On any platform or scheduling where
that first pipe write is accepted, the outcome is `Attempted` and the test
fails. This is the same test named in relay#980 as a contention flake; the
rewrite removes the tolerance that made it survivable.

**Repair.** Restore the loop-to-cap arm (it can keep the old `retry_index`
tolerance) and keep the new single-attempt classification assertion as a
separate test driven by a deterministic fault injection — a closed command
channel — rather than by killing a child and hoping the pipe rejects the write.

---

## R2-11 — LOW-MEDIUM. The invariant suite never exercises the only backend that exists

**Where.** `crates/broker/tests/delivery_seam_invariants.rs:6-77` — all four
contract invariants are proven against `ScriptedBackend`, a mock whose
`send_results.pop()` returns a scripted value and otherwise
`unwrap_or(Ok(HandedOver))` (`:62-64`).

The mutation transcripts in `evidence/mutation-proof.md` are honest and the
tests do bite — but every mutation was applied to
`crates/broker/src/delivery/backend.rs`, the coordinator. `PtyDeliveryBackend`
has no test of any kind, which is why R2-2 (the adapter asserting the wrong
commit boundary) passes all four invariant tests. A gate that proves the
coordinator routes correctly while the only route lies to it about the commit
boundary is proving the wrong half.

Related, smaller: `never_acks_without_observation:230-231` asserts
`settle == HandedOver` and then `settle != Acked("fabricated")` — the second
assertion cannot fail given the first.

**Repair.** Add at least one invariant case per backend implementation, driving
`PtyDeliveryBackend` against a `WorkerRegistry` fixture (the runtime tests
already build these: `make_worker_registry_with_worker`). Cover the pre-write
refusal (`pty.rs:41-47`), the hand-over (`:52`), and — once R2-2 is fixed — the
committed error.

---

## R2-12 — LOW. `tests/e2e/unlaunched/` breaks `npm run test:e2e` wherever `opencode` is absent, for a capability this phase's contract excludes

**Where.** `vitest.e2e.config.ts:44` includes `tests/e2e/**/*.test.ts`, so
`npm run test:e2e` (`package.json:126`) picks up the new file.
`tests/e2e/unlaunched/unlaunched-delivery.test.ts:92-99` fails — deliberately,
never skips — when `resolveOpencodeBinary()`
(`tests/e2e/unlaunched/session-host.ts:46-51`) finds nothing.

Refusing to skip is the right instinct and I am not asking for a skip. The
problem is placement: `phase-contract.json` sets `"unlaunched": false`, the
`unlaunched-gate` correctly reports `not-required`, and this suite was added to
`delivery-backend-seam`'s manifest `location` only to un-red `manifest-gate`
(stated plainly in `reviews/claude-fix-1.md`). So an existing repo-wide command
now fails on every developer machine and CI lane without `opencode`, in service
of a gate the phase does not require. It has also never been run: nothing in
`evidence/` executes `test:e2e`.

Smaller, same file: `brokerBinary()` at `:58-62` resolves only
`target/release/…`, while `tests/benchmarks/harness.ts:16-28` tries `debug`
first, then `release`. A debug-only checkout gets an ENOENT spawn failure
instead of the intended message.

**Repair.** Either gate the suite behind its own script
(`test:e2e:unlaunched`) and a `RELAY_UNLAUNCHED_E2E=1` opt-in until phase 1/2
own it, or make `opencode` a declared prerequisite of `npm run test:e2e` and
prove the suite passes at least once in `evidence/`. Align `brokerBinary()` with
`resolveBinaryPath()`.

---

## R2-13 — LOW. The `seam-rules` mutation check accepts one named invariant out of four

**Where.** `scripts/migrate/native-delivery-gates.mjs:1088-1097`:
`named.length === 0` is the only failure condition, so a `mutation-proof.md`
that names a single invariant and contains the substring `FAILED` satisfies the
gate for all four. The per-invariant `fn <name>(` check at `:995-999` does catch
a deleted test, so this is a proof-completeness gap, not a coverage gap. The
current `mutation-proof.md` happens to cover more than the minimum.

**Repair.** Require every `config.invariants` entry to appear in the transcript,
and require a `FAILED` line within that invariant's own section rather than
anywhere in the file.

---

## Round-1 findings I independently re-derived as still live

Listed without re-argument; each is unchanged in the current tree.

- **F4** — `DeliverySeam` is constructed per call
  (`runtime/delivery.rs:997-998`), so the duplicate guard, `settle` and
  `recorded_route` have no production caller. See R2-4 for what its fix breaks.
- **F6** — the exit criterion is "parity green, **unchanged**", and the parity
  scripts were changed in this diff: the module (`@agent-relay/sdk` →
  `@agent-relay/harness-driver`) and the binary they resolve (`agent-relay` →
  `agent-relay-broker`, `tests/benchmarks/harness.ts:19`) both moved. The
  assertion change is a strict tightening and clearly right; the point stands
  that no "before" baseline of this suite exists, so the parity evidence cannot
  speak to unchanged behaviour — only to the new suite's behaviour against the
  new code.
- **F11** — no general terminal in-doubt disposition. R2-8 is the concrete harm.
- **F12** — `delivery-backend-seam` `location` now spans the PTY worker, the
  runtime tests, the whole parity directory and the unlaunched e2e scaffolding
  (`.agentworkforce/features/manifest.yaml:111`). One feature row owning
  `crates/broker/src/pty_worker.rs` means every future PTY change routes here.
- **F19** — `pty_worker.rs:2201-2224` still re-queues an injection whose write
  the drainer did not confirm, at `InjectionStage::Body`, entirely outside the
  seam. That is a re-send after a possible write, in the injector the seam is
  supposed to be wrapping.
- **`unit-tests` red** — re-derived from `evidence/unit-tests.json`
  (`exitCode: 1`): `tests/fixtures/verify-fleet-daytona.test.ts` (36 vs 35,
  deterministic) and two `packages/harness-driver/src/broker-process.test.ts`
  spawn-cleanup ENOENTs. Neither is touched by this diff. Correctly left red.

Round-1 findings I checked and found genuinely closed: **F1** (no `RELAY_MUTATION`
residue survives in `crates/broker/src` or `crates/relay-pty/src`; `seam-rules`
now gates it), **F5** (`check_echo_in_output` normalises only `\r\n`, and
`check_echo_does_not_turn_bare_cr_into_line_break` pins it), **codex F1**
(`pty_worker.rs:2283-2291` emits only the unverified frame), **codex F2** (all
five parity scripts require `verification === 'echo'`).

## What would change my verdict

R2-1 and R2-2 repaired, each with a test that fails on the unrepaired code
(for R2-1: a second delivery to the same agent after a fallback releases its
own ack and leaves `pending_deliveries` empty; for R2-2: a `PtyDeliveryBackend`
case where a post-write writer fault stops the fallback loop). R2-3 and R2-4
repaired or explicitly deferred in `BLOCKED_NO_COMMIT.md` with the trap in
R2-4 written down so F4's fix does not land on top of it. The rest can be
tracked.
