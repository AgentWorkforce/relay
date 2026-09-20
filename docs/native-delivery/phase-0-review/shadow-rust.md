# Shadow review (Rust): phase 0, delivery-backend seam

Role: shadow reviewer, read-only. No product code was edited.
Branch `feat/native-delivery-phase-0-seam`, working tree only, nothing committed.
This file replaces the 08:57 review. That review described a tree where `retry_pending_delivery` discarded the seam's status. The tree has since changed (`runtime/delivery.rs:996-1024` now branches on `InDoubt` and committed errors, and `runtime/tests.rs` was rewritten), so several of its findings are stale and one new defect exists. Every claim below was re-derived from the current files.

## What I read and ran

Read in full: `git diff` (lib.rs, runtime/delivery.rs, runtime/tests.rs), `delivery/{mod,backend,pty}.rs`, `tests/delivery_seam_invariants.rs`, `docs/native-delivery-migration.md`, `phase-contract.json`, `evidence/mutation-proof.md`, `gate-log.txt`. Also every caller of `WorkerRegistry::deliver` / `send_to_worker` and the ack path it feeds (`worker.rs:1454-1569`, `runtime/worker_events.rs:700-940`, `pty_worker.rs:1163, 1655-1712, 2225-2300`, `runtime/maintenance.rs:154-205, 825`, `runtime/fleet.rs:1217, 1985`).

Ran (CARGO_HOME `/tmp/relay-native-delivery-cargo-home`, `--offline`):

- `cargo test -p agent-relay-broker --test delivery_seam_invariants`: 4 passed, 0 failed.
- `cargo test -p agent-relay-broker --lib delivery_retry`: 4 passed, 0 failed (includes the rewritten `delivery_retry_transient_blip_emits_failed_event_for_present_worker`).

Not run:

- **The parity suite.** It launches real brokers and CLIs, which the testing-hazard section (doc:313-319) forbids here. The phase exit ("parity suite green, unchanged") is **unverified by me**, and `gate-log.txt` has no parity line (only `preflight`, `contract`, `seam-rules`).
- **The reinsertion double-write in F1.** It is reachable only through `pub(crate)` functions, so proving it needs a new test in `runtime/tests.rs`, which is product code. F1 is established by reading, not by execution. The test that would prove it is written out under F1.
- I did not re-run the mutation proofs. `evidence/mutation-proof.md` is consistent with the test bodies (transcript line numbers 115, 157, 193, 220 match `delivery_seam_invariants.rs`), and all four mutations were applied inside `backend.rs`, i.e. they prove the coordinator, not the runtime wiring.

## Verdict

The coordinator in `backend.rs` implements the four rules, and its four tests bite. The wiring into the runtime is where the phase goes wrong, in two ways:

1. **It changes PTY behaviour**, on a phase whose exit is "parity unchanged". Every `WorkerRegistry::deliver` error is now classified as post-write, which turns retryable failures into immediate dead letters (F2).
2. **Its new terminal branch does not terminate on one of the two callers.** The committed/`InDoubt` branches return `Failed` without touching the entry, and `insert_and_attempt_delivery` puts the entry straight back into the retry map, still due and with a full retry budget (F1). The seam's own rule 2 is then violated on the exact path it was added to protect.

Separately, the seam is rebuilt per call, so its memory (rules 2 and 3) never outlives one send (F3), and the acknowledgement the PTY route produces on timeout is inferred, not observed (F4, pre-existing, untouched by the seam).

---

## 1. Spec drift

### 1a. In the contract or doc, missing from the tree

| Item | State | Evidence |
| --- | --- | --- |
| Feature `delivery-backend-seam` (contract `features[0]`: tier 6, `location: crates/broker/src/delivery/`; `tsScope` lists the manifest) | **Missing.** | `grep -n "delivery-backend-seam\|crates/broker/src/delivery" .agentworkforce/features/manifest.yaml` prints nothing; `git status --short .agentworkforce/features tests` is clean. Doc:217-220: an unmapped runtime path fails closed to the full smoke profile. |
| Exit: parity suite green | **No evidence.** | `gate-log.txt`: no parity gate line. |
| Doc trait op `discover` (doc:75) | **Missing.** `transport_status()` (`backend.rs:188`) is a per-route health check, not target discovery. | No `discover` anywhere under `delivery/`. |
| Doc `send` outcomes "sent / refused / failed / in doubt" (doc:76) | Split over two types. `SendStatus{Acked,HandedOver,Refused,InDoubt}` (`backend.rs:104-113`) and `DeliveryError{Unavailable,CommittedError}` (`backend.rs:135-142`). "Failed" exists only as an `Err`. | |
| Doc `settle`: "turn start, outcome and reply" (doc:76-77) | Reduced to `Acked`/`HandedOver`/`Failed(String)` (`backend.rs:168-172`). `Failed` has no producer anywhere. | |
| Doc: "the four outcomes map onto [queue, verification states, telemetry]" (doc:78-79) | **Mapping is partial.** `runtime/delivery.rs:996-1024` maps `InDoubt`, committed error, other error, and "anything else". Nothing maps to telemetry or verification state, and the route is not recorded on any runtime type (see rule 3). | `PendingDelivery` (`runtime/delivery.rs:4-30`) has no route field; `BrokerEvent::MessageDeliveryFailed` construction (`runtime/delivery.rs:1099-1110`) carries none. |
| Wiring `DeliveryBackend` from `runtime/delivery.rs` | Satisfied **only by substring**. `grep -nw DeliveryBackend crates/broker/src/runtime/delivery.rs` is empty; the hit is `PtyDeliveryBackend` at `:992`. The gate is a substring check (`scripts/migrate/native-delivery-gates.mjs:853`, `readFileSync(rule.from).includes(rule.symbol)`), so `PtyDeliveryBackend` alone would satisfy it. | The trait is used only through `seam.send(&mut [&mut pty_backend], ..)` at `:995`, which does route through it. So the wiring is real here; the gate's check is just a weaker proof than the wiring itself. |

### 1b. Implemented, not asked for by the contract or doc

- **Behaviour change on the PTY path** (contract exit says unchanged). `runtime/delivery.rs:1018-1024` fails a delivery on its first post-admission error with no retry, where the old code retried up to `MAX_DELIVERY_RETRIES` (the deleted loop at the old `runtime/tests.rs:3261-3300` asserted exactly that). See F2. This is the largest drift.
- **A pre-existing test was rewritten, not just extended.** `runtime/tests.rs:3219-3334`: the retry-to-cap loop is gone; assertions changed from `attempts == MAX_DELIVERY_RETRIES` to `attempts == 0` at `:3276`, `:3313`, `:3334`; the `|| last_error.contains("max delivery retries exceeded")` alternative was dropped. The new assertions are internally consistent with the new behaviour, but they are the old assertions edited to match it, and `attempts == 0` records an attempt that wrote (or may have written) as zero attempts. Treat as a changed contract that needs an explicit decision, not as a refactor.
- **Wire-visible text.** `pty.rs:51` wraps errors in `DeliveryError::committed`, and its `Display` is `"delivery backend error after possible write: {reason}"` (`backend.rs:140`). `runtime/delivery.rs:1022` stores that string as `last_error`, which surfaces as `lastError` on `message_delivery_failed` and in dead letters. Existing assertions use `contains` (`runtime/tests.rs:3315`), so nothing I found breaks.
- `HandoverState` is a one-variant enum (`backend.rs:82-86`): indirection, no distinction.
- `SendRequest` carries the payload twice (`body`, `backend.rs:47`, and `relay_delivery.body`, `:49`; both filled at `:62-69`). The PTY backend sends only `relay_delivery` (`pty.rs:45`) and ignores `body`, and nothing keeps them equal.
- `SendRequest::new` (`backend.rs:53`) is used only by tests; production uses `pub(crate)` `SendRequest::relay` (`:62`).
- `DeliverySeam.receipts` is an unbounded `VecDeque` scanned linearly per send (`backend.rs:204`, `:217-222`). Harmless today because each seam lives for one call (F3); a leak the moment it is made long-lived, which F3's fix requires.
- Payload is cloned three times per attempt: `runtime/delivery.rs:994` (`pending.delivery.clone()`), `backend.rs:64-67`, `pty.rs:45`. The old code cloned once. (The `pending.clone()` at `:944` predates this diff.)
- No cancel-safety documentation on `DeliverySeam::send` / `settle` (`backend.rs:212`, `:265`), which `.claude/rules/rust.md` requires for async fns. It matters: see F5.

---

## 2. The four seam rules

### Rule 1: fall back to another transport only on a strictly pre-write error

**Enforced, in the coordinator only.** `backend.rs:228-259`:

- `transport_status()` unavailable: `continue` to the next route (`:229-235`).
- `Ok(SendStatus::Refused)`: recorded as a pre-write error, `continue` (`:239-243`).
- `Err(e)` with `e.is_pre_write()`: `continue` (`:249-251`).
- Any other `Err` (committed): record an `InDoubt` receipt on that route and `return Err` **without visiting later backends** (`:252-257`).
- Test: `falls_back_only_before_write` (`delivery_seam_invariants.rs:80-125`) checks both directions (`native.sends == 1, pty.sends == 0` on committed).

Two defects, both at the production classification boundary, not in the coordinator:

- **Over-classification as committed.** `pty.rs:48-51` maps *every* `WorkerRegistry::deliver` error to `DeliveryError::committed`. `deliver` (`worker.rs:1554-1569`) can fail strictly before any byte is admitted to the writer: `ensure!(!initial_tasks…)` (`:1555`), `serde_json::to_value` (`:1567`), `unknown worker` (`send_to_worker:1461-1464`), `encode_worker_frame` (`:1467`), the 250 ms `WORKER_COMMAND_QUEUE_TIMEOUT` expiring while the frame is still un-queued (`:1469-1478`), and writer channel closed (`:1478`). Only the failures at `:1486-1493` (completion channel dropped, or the writer reporting a failed write) are post-admission. `pty.rs:41-47` shows the author knows how to return `unavailable` (missing target / payload) and then discards the distinction for the call that matters. The `.with_context("failed writing frame…")` on every branch (`worker.rs:1479, 1491, 1493`) is why the error text alone cannot separate them; the adapter would need `deliver` to return a typed error.
- **Nothing consumes the pre-write/committed distinction for fallback in production.** There is exactly one backend in the slice at `runtime/delivery.rs:995`. So rule 1's *fallback* half has no production consumer in phase 0; its only observable production effect is the retry-vs-terminal classification in F2.

### Rule 2: never re-send on doubt

**Enforced in the coordinator (test-only); violated by the runtime wiring.**

- Enforcement: `backend.rs:217-224` returns the stored receipt for a repeated `delivery_id` before touching any backend; the committed path stores an `InDoubt` receipt first (`:253-256`). Test: `never_resends_on_doubt` (`delivery_seam_invariants.rs:128-160`); the mutation proof shows it failing when the lookup is disabled.
- Production: the `DeliverySeam` is created inside `retry_pending_delivery` on every call (`runtime/delivery.rs:991`) and dropped at the end of it. The receipt lookup at `backend.rs:217-224` therefore never has anything to find in production. The only thing that stops a re-send is what `retry_pending_delivery` does with the result, and that is F1 (broken) and the pre-existing ack-timeout resend (F6).
- `Ok(SendStatus::InDoubt)` is handled at `runtime/delivery.rs:996-1002` but **no production backend can return it** (`pty.rs:52` returns only `HandedOver`). That branch is untested dead code today. If a future backend does return it, it inherits F1.

### Rule 3: record which route each send took and settle by that route's rules

**Enforced in the coordinator (test-only); absent from the runtime.**

- Recording: `backend.rs:245-247` (success) and `:253-255` (committed error).
- Settle by recorded route: `backend.rs:270-283` looks up the receipt, then finds the backend whose `route_id()` equals the recorded route; it never falls through to another backend. `settle` returns `None` if that backend is not in the slice. Test: `records_route_for_each_send` (`delivery_seam_invariants.rs:163-200`) asserts the stale-native backend's `settles` stay empty.
- Production: **`seam.settle` has no caller.** `grep -rn "\.settle(" crates/broker/src` finds only the definition and `pty.rs:56`. The route is recorded into a seam that is dropped at `runtime/delivery.rs:1051`. No runtime type stores it (`PendingDelivery`, `runtime/delivery.rs:4-30`, has no route field; neither does any event). So on the live path "record the route" and "settle by it" do not happen; the PTY is simply the only route.
- Coordinator defect: `settle` returns `None` both when there is no receipt (`backend.rs:274`, `?`) and when the recorded route's backend is missing from the slice (`:282`, `?`). A caller cannot tell "never sent" from "sent, and the route is gone", which is the case rule 3 exists to catch.
- `PtyDeliveryBackend::settle` (`pty.rs:56-61`) returns `HandedOver` unconditionally and consults nothing. It cannot be wrong in the dangerous direction, but it is not "that route's rules" either. The PTY's real settlement is `delivery_verified` / `delivery_ack` handling in `worker_events.rs`, which bypasses the seam.

### Rule 4: never claim an acknowledgement you did not observe

**Enforced for the send return value; not enforced for the ack itself.**

- Send: `pty.rs:52` returns `HandedOver` for `Ok(())` from `deliver`, which only means the frame was written to the worker's stdin pipe (`worker.rs:1486-1495`). The runtime treats `Ok(_)` as `Attempted` (`runtime/delivery.rs:1003-1017`), sets `last_error = None` and schedules an ack-timeout retry (`:1007-1008`). It does not emit a confirmation. Correct.
- Coordinator: passes `SendStatus` through unchanged (`backend.rs:244-248`). It cannot *verify* that an `Acked(ObservedAck)` was observed. `ObservedAck` is a public `String` wrapper with a public constructor (`backend.rs:89-100`), so rule 4 for any future backend rests on convention. `never_acks_without_observation` (`delivery_seam_invariants.rs:203-232`) passes against a coordinator that simply forwards, and its final `assert_ne!` (`:231`) is vacuous given the `assert_eq!` on `:230`. The mutation proof works only because the mutation *adds* an upgrade that the real code does not contain.
- The acknowledgement the PTY route actually produces is F4.

---

## 3. Double delivery: every path where a message can be written twice

Numbered by write site. "Stopped by" says what actually prevents the second write, or "nothing" if I found nothing.

**W1. Committed failure, re-inserted, retried by maintenance** (NEW in this diff; the defect in F1).
`runtime/delivery.rs:1018-1024` removes the entry and returns `Failed` with the entry unmodified (`attempts` unchanged, `failed_attempts == 0`, `next_retry_at` still in the past). `insert_and_attempt_delivery` puts it straight back (`:923-932`, comment: "Preserve ownership locally so the maintenance retry path can record the terminal failure"). Maintenance selects it as due (`maintenance.rs:161`, `next_retry_at <= now`), and `retry_pending_delivery` passes the retry-cap guard (`:962`, `0 < 10`) and writes again through a fresh seam (`:991`). Old behaviour made this reinsertion safe because `Failed` came only from guards that fire *before* any write (`:962`, `:974`), so re-running them terminated. Callers that reach it: `queue_and_try_delivery_raw` (initial task at `worker_events.rs:1426`, continuity load at `:1761`) and the fleet `WorkerMissing` path (`fleet.rs:1217`). Stopped by: only the worker-side duplicate filter (W6), which is not part of the seam.

**W2. Ack-timeout resend after a successful handoff** (pre-existing, and preserved deliberately).
`runtime/delivery.rs:1003-1009` sets `next_retry_at = now + delivery_ack_timeout` (5 min in Wait mode, `runtime/mod.rs:62`), and `maintenance.rs:161-175` calls `retry_pending_delivery` again, which writes again. `wait_delivery_successful_handoffs_do_not_exhaust_failure_budget` (`runtime/tests.rs:3390-3440`) pins this: "a successful handoff must remain redeliverable while its wait ack is pending". That is a re-send on doubt (rule 2) that the seam neither prevents nor can, given F3. Stopped by: `pty_worker.rs:1163` drops a repeat `delivery_id` while the worker still holds it pending ("skipping duplicate pending delivery", `:1184`).

**W3. Cancelled first attempt, then maintenance.**
`try_inject_pending_relay_message` wraps `queue_and_try_delivery_raw` in `timeout(retry_interval, …)` (`runtime/delivery.rs:751-782`). The entry is inserted first with `next_retry_at = now` (`:908-921`). If the timeout fires while `deliver` awaits the writer's completion (`worker.rs:1486`), the frame is already admitted and will be written (the comment at `worker.rs:1480-1485` says this), and the entry is still due, so maintenance writes it again. Pre-existing. Stopped by: W6 only. A per-call seam cannot help: the future is dropped mid-`send`, so no receipt is recorded even in the coordinator (`backend.rs:238-247` records only after `send` returns).

**W4. Boomerang injection bypasses the seam.** `maintenance.rs:825` calls `self.workers.deliver` directly. One write, no retry there, no `DeliveryId` reuse. Not a double-write, but a PTY write that no seam rule governs, and its `Err` is only logged (`:826-832`).

**W5. Manual-flush injection bypasses the seam and retries after any error.** `try_inject_pending_relay_message_once` (`runtime/delivery.rs:818-834`) calls `workers.deliver` directly, and its caller (`fleet.rs:1985-1988`) sets `result.failure` and `break`s on any error while the message stays at the head of the FIFO (the comment at `runtime/delivery.rs:785-788` says so). The next flush writes it again. If the failing write was a post-admission error, that is a double write. Stopped by: W6. Not classified pre-write vs. post-write at all, so rule 1 does not exist here.

**W6. The one thing that actually stops most of the above.** `pty_worker.rs:1163` `pending_worker_delivery_ids.insert(..)` returns false for a repeat id, so the second frame is dropped. Limits: it is in-process memory of one worker, cleared at `pty_worker.rs:1706` and `:2196` (echo verified) and `:2293` (timeout fallback); so a delivery whose ack was already sent, or a worker restarted between the two writes (the restart keeps unacknowledged deliveries, per the comment at `worker_events.rs:1457-1459`), is not protected. It is not part of the seam and no seam test refers to it.

**W7. Cross-route.** Not reachable in phase 0 (one backend). In the coordinator, cross-route double-send is prevented by `backend.rs:252-257` (committed error returns before the next backend) and `:217-224` (repeat id). Both are test-covered and neither survives past one `retry_pending_delivery` call in production (F3).

---

## 4. Acknowledgements inferred rather than observed

1. **Timeout-fallback ack (pre-existing, on the live PTY path, not touched by the seam).** `pty_worker.rs:2266-2293`: when no echo is seen within `verification_window`, the worker logs "acknowledging via timeout fallback (unverified)" and emits the **same `delivery_ack` frame** as a verified delivery (`:2270`), plus `delivery_verified` with `verification: "timeout_fallback"` (`:2285`). The other two ack sites (`:1676`, `:2149`) fire only after `pending_verification_echo_seen` / `queue_or_take_confirmed_verification`, i.e. on observed echo. The broker treats `delivery_ack` as confirmation: `worker_events.rs:696-800` resolves the pending entry, releases the withheld fleet ack (`enqueue_delivery_ack`, `:740`), emits `MessageDeliveryConfirmed` (`:778`), and sends the read ack (`mark_delivery_read_ack`, `:787`). The `delivery_verified` handler (`:827`) also emits `MessageDeliveryConfirmed` (`:890`) for `timeout_fallback`. So an unobserved delivery is promoted to Confirmed and read. This is exactly what rule 4 forbids for a native route. The seam says nothing about it: `pty.rs:56-61` reports `HandedOver` and the runtime never consults `settle`. If phase 0's claim is "PTY behind the trait, unchanged", this is a known, named deviation that should be written down in the phase notes (the doc, doc:90-91, states the rule without exempting the PTY route).
2. **Handoff success treated as progress, not ack.** `runtime/delivery.rs:1003-1015` does not infer an ack from `Ok(_)`; it resets `failed_attempts` and schedules the retry. Not an inference, but note `failed_attempts = 0` erases the failure count on success, so alternating success and failure never reaches the cap.
3. **`PtyDeliveryBackend::settle` (`pty.rs:56-61`)** returns a constant. Conservative (never `Acked`), but it asserts a state ("handed over") it did not check. It is unused.
4. **`ObservedAck`** carries only a `detail` string (`backend.rs:89-100`); nothing distinguishes an observed ack from a constructed one (see rule 4).
5. **The `InDoubt` branch invents a failure reason.** `runtime/delivery.rs:1000` writes `"delivery route is in doubt after possible write"` and dead-letters the message. That is a claim of *failed* made without observing failure; a message in doubt may have been delivered (doc:39, "reporting NOT delivered for a message that was delivered" is one of the cited failure modes). The same applies to the committed branch, `:1018-1024`. Since the sender's `message_delivery_failed` event can cause an upstream retry, the "in doubt" state has no representation in the event vocabulary.

---

## 5. Test and evidence quality

- The four invariant tests pass and bite at the coordinator (mutation transcripts match the test bodies). They exercise only `ScriptedBackend`; none go through `PtyDeliveryBackend` or `retry_pending_delivery`.
- No test covers the new runtime branches: `runtime/delivery.rs:996-1002` (`InDoubt`) is unreachable, and `:1018-1024` (committed) is exercised only through direct `retry_pending_delivery`, never through `insert_and_attempt_delivery`, which is where F1 lives. `initial_delivery_failure_stays_owned_until_dead_lettered` (`runtime/tests.rs:3171-3215`) covers reinsertion only for the "recipient gone" guard, which is pre-write.
- The rewritten transient-blip test asserts `pending_deliveries.is_empty()` after `retry_pending_delivery` (the direct call); that is exactly the property the reinsertion in `insert_and_attempt_delivery:931` defeats one layer up.
- `mutation-proof.md` never mutates the runtime wiring, so nothing proves that the seam changes any production outcome, and per F2 it does change one.

---

## 6. Ranked findings

**F1 (high). The committed/`InDoubt` "terminal" branches are not terminal on the `insert_and_attempt_delivery` path, so a possibly-written message is re-queued at full retry budget and re-sent.**
Evidence: `runtime/delivery.rs:1018-1024` (and `:996-1002`) return `Failed { pending: <unmodified>, .. }`; `:923-932` re-inserts it; `:908-921` shows the entry it was built from has `failed_attempts: 0`, `next_retry_at: Instant::now()`; `maintenance.rs:161` selects it; `:962` does not stop it; `:995` writes again.
Failure scenario: an initial task (`worker_events.rs:1426`) or fleet `WorkerMissing` delivery (`fleet.rs:1217`) hits a writer error after the frame was admitted. The caller sees `Err`, the entry is back in the map, the next maintenance tick writes the same `delivery_id` again. Only `pty_worker.rs:1163` (in-memory, per worker) may swallow the duplicate.
Proof needed (not run, product code): a `runtime/tests.rs` test that calls `insert_and_attempt_delivery` against the "worker-blip" registry from `:3219`, asserts `Err`, then calls `retry_pending_delivery` once more on the surviving entry and counts writes to the worker's stdin. Expected today: a second write. A correct fix is to make the entry genuinely terminal at the call site (mark `failed_attempts = MAX_DELIVERY_RETRIES` and set `last_error` before reinserting, or dead-letter at the raw path), not to loosen the test.

**F2 (high). The PTY adapter classifies every `deliver` error as post-write, changing the retry contract and dead-lettering retryable failures.**
Evidence: `pty.rs:48-51`; `worker.rs:1555, 1461-1467, 1469-1478` (pre-write failures, several transient: a 250 ms queue timeout on a busy writer); `runtime/delivery.rs:1018-1024`; rewritten test `runtime/tests.rs:3261-3334` (`attempts == 0`, no retry).
Failure scenario: a worker whose command queue is momentarily full (`WORKER_COMMAND_QUEUE_TIMEOUT`, `worker.rs:73`) previously stayed queued and retried up to 10 times; now the first miss is a dead letter with `attempts: 0` and an error string saying "after possible write". The phase contract exit says parity is "unchanged"; the parity suite was not run (and its cases probably do not inject a full writer queue), so green parity would not clear this.
Fix direction: make `deliver` return a typed pre-/post-admission error and map only post-admission errors to `committed`.

**F3 (high). The seam is constructed per call and dropped, so rules 2 and 3 have no effect on the live path.**
Evidence: `runtime/delivery.rs:991` (new `DeliverySeam` per `retry_pending_delivery`); `backend.rs:204-224` (state lives in `receipts`); `seam.settle` has no caller. The idempotency check at `backend.rs:217` and the recorded route can never fire in production.
Consequence: the phase reads "PTY behind the trait" but the four rules are enforced by the test double only. The runtime's own bookkeeping (`PendingDelivery.attempts`, `next_retry_at`) is what actually decides re-sends, and it re-sends on doubt (W2). Either make the seam a runtime-owned, bounded, long-lived object, or describe phase 0 honestly as "trait and coordinator exist; the runtime uses them as a classifier".

**F4 (high). An unobserved delivery is acknowledged and confirmed on the PTY route (rule 4), and the seam neither exposes nor gates it.**
Evidence: `pty_worker.rs:2266-2293`; `worker_events.rs:696-800, 827-900`; `pty.rs:56-61`. Pre-existing and unchanged by this diff, so it is a phase-scope decision rather than a regression: it must be recorded, and `SettleStatus` should be able to say "acked, unverified" before a native backend is compared against it.

**F5 (medium). No cancel-safety documentation, and the seam is not cancel-safe.**
Evidence: `backend.rs:212-263` awaits `backend.send` and records the receipt only afterwards (`:245-247`), so dropping the future after the write commits leaves no receipt; `runtime/delivery.rs:751` is a live cancellation site (W3). `.claude/rules/rust.md` requires the cancel-safety statement.

**F6 (medium). Two PTY writers bypass the seam, and one retries after any error (W4, W5).**
Evidence: `maintenance.rs:825`, `runtime/delivery.rs:826`, `fleet.rs:1985-1988`. Rule 1 and rule 2 are not applied to either; the manual-flush path (`fleet.rs:1985`) re-sends after an unclassified error. The wiring rule in the contract names only `runtime/delivery.rs` and is satisfied, but "the PTY backend behind the new trait" is only partly true.

**F7 (medium). Feature `delivery-backend-seam` is not in `.agentworkforce/features/manifest.yaml`.**
Evidence: the grep in section 1a. Doc:217-220: unmapped runtime files fail closed to the full smoke profile (~53 min); `tsScope` in the contract names the manifest, and it is unmodified.

**F8 (medium). The tests changed to pass are the tests that pinned the old contract.**
Evidence: `runtime/tests.rs:3219-3334` (see 1b). Not evidence of bad intent; the new behaviour follows a stated rule. But the change is a decision (retry policy for present workers on writer error) and belongs in the phase notes, not in a test edit.

**F9 (low). `ObservedAck` carries no evidence** (`backend.rs:89-100`). `never_acks_without_observation` is satisfied by a pass-through coordinator, and `delivery_seam_invariants.rs:231` is redundant with `:230`.

**F10 (low). `settle` conflates "no receipt" with "route's backend missing"** (`backend.rs:270-283`).

**F11 (low). Extra surface:** wire-visible `lastError` prefix (`backend.rs:140`), one-variant `HandoverState` (`:82-86`), duplicated payload (`:47`, `:49`), unbounded receipt log (`:204`), three clones per attempt, `discover` absent.

---

## What would change my verdict

- F1: a test that drives `insert_and_attempt_delivery` into the committed branch and shows the surviving entry is not retried (or a code path I missed that marks it terminal). That converts F1 from "by reading" to closed.
- F2: a typed pre-/post-admission error from `WorkerRegistry::deliver`, with `pty.rs` mapping only the latter to `committed`, and the rewritten test split into a retryable arm and a terminal arm (keeping the original retry-to-cap assertion for the retryable one).
- Parity results (all five commands in the contract) from an environment where the testing-hazard rules in doc:313-319 are satisfied.
- A written decision on F4: whether phase 0 accepts the PTY's timeout-fallback ack as a documented exemption.
