# Claude fix pass 1 — response to `reviews/codex-review-1.md`

Reviewer input: `reviews/codex-review-1.md` (F1, F2, F3).
Also read first: `docs/native-delivery-migration.md`, `phase-contract.json`,
`BLOCKED_NO_COMMIT.md`, `reviews/claude-review-1.md`, `reviews/codex-fix-1.md`.

Nothing was committed, pushed, merged, or run against `main`. No CLI was
launched in an untrusted directory and no first-run prompt was answered; the
only CLI spawned by any command below is `cat`, from the parity harness.

**Verdict: all three findings were valid. All three are fixed.** Nothing was
disputed. The phase is still blocked for other reasons — see the end.

---

## F1 — High — PTY timeout fallback fabricated an acknowledgement. FIXED.

Codex was right, and right about the ordering being the whole problem: the
previous fix stopped `delivery_verified(timeout_fallback)` from *clearing* the
pending delivery, but the worker had already sent a plain `delivery_ack` for the
same unobserved timeout a few lines earlier, and by the time the fallback branch
ran the delivery was confirmed, the withheld fleet ack released,
`MessageDeliveryConfirmed` emitted and the message marked read.

Two things were needed: stop emitting the frame, and give the broker a real
settlement for the fallback that does not re-open seam rule 2.

### Worker side — `crates/broker/src/pty_worker.rs`

The verification-timeout branch no longer sends `delivery_ack`. It emits only
the explicitly unverified frame.

The emit list moved into one named function rather than staying as inline
`send_frame` calls, so the invariant has somewhere a test can hold it:

- `crates/broker/src/broker/delivery_verification.rs`
  - `TIMEOUT_FALLBACK_VERIFICATION` — the single string both ends compare on.
  - `verification_timeout_frames(delivery_id, event_id, window)` — returns the
    frames a timeout may emit. It returns exactly one: `delivery_verified` with
    `verification: "timeout_fallback"`.

### Broker side — `crates/broker/src/runtime/worker_events.rs`

The `timeout_fallback` branch now *settles* the delivery instead of merely
declining to confirm it:

- removed from `pending_deliveries` — **necessary**, because seam rule 2
  ("never re-send on doubt") is violated by leaving it: `runtime/maintenance.rs`
  sweeps every pending delivery past `next_retry_at` into
  `retry_pending_delivery`, which re-injects. Codex's suggested repair said
  "without clearing pending deliveries"; that is the one part I implemented
  differently, and the reason is that an unobserved PTY write is precisely the
  case where a re-send double-delivers. It is settled terminally, not confirmed.
- recorded in `terminal_failed_deliveries`, so a late or stray `delivery_ack`
  for the same id cannot resurrect and confirm it.
- the withheld engine-facing fleet ack rides out on the removed
  `PendingDelivery` and is therefore **dropped, never sent** (logged at `warn`).
  The engine keeps its own un-acked record, which is the honest state.
- **not** emitted as `MessageDeliveryConfirmed`, **not** passed to
  `mark_delivery_read_ack` — both assert an observation this route does not have.
- **not** dead-lettered either. "In doubt" is not "failed", and a dead letter
  invites a redelivery that would double-deliver. This is the narrow shape of
  the disposition; the general terminal in-doubt outcome is still F11, open.

### Regression test (Codex asked for one)

`runtime::tests::timeout_fallback_never_confirms_or_acks_an_unobserved_delivery`
drives a real `delivery_verified` worker event through
`BrokerRuntime::handle_worker_event` and asserts the fallback produces no
`message_delivery_confirmed`, no `delivery_read_ack`, no `delivery_ack`, no
fleet-control send, no surviving pending entry, and a terminal record.

It carries two controls so the negative assertions cannot pass for the wrong
reason:

1. a **late `delivery_ack`** for the same delivery — the exact frame that used
   to confirm it — still produces none of the above;
2. the **echo arm** of the same handler still produces
   `message_delivery_confirmed` and still clears the pending entry.

Plus two unit tests on the emit site:
`verification_timeout_never_emits_a_delivery_ack` and
`verification_timeout_reports_an_explicitly_unverified_delivery`.

Mutation transcripts for all of these are appended to
`evidence/mutation-proof.md` as M1 and M2. Both mutations reproduce the exact
behaviour F1 described, and both tests fail on them.

### One stale comment corrected

`runtime/tests.rs` carried a relay#1310 note asserting that "pty_worker.rs sends
the same internal `delivery_ack` event either way" (echo or timeout fallback).
That is no longer true and was updated rather than left to mislead the next
reader.

---

## F2 — Medium — the parity scripts counted timeout fallback as verified. FIXED.

Valid, and the more important of the two: this is the gate that the phase's exit
criterion rests on, so the F1 drift could have shipped underneath a green suite.

`tests/benchmarks/harness.ts` gains two shared predicates:

- `isObservedDelivery(event)` — `kind === 'delivery_verified' && verification === 'echo'`.
  Written as an **allow-list**, not `!== 'timeout_fallback'`: a deny-list lets
  any future unobserved verification kind through by default.
- `isUnobservedDelivery(event)` — the complement, tracked and reported
  separately so a red run says *why*.

All five phase-0 parity scripts now count only observed deliveries, print the
unobserved count, and **fail** if any unobserved hand-off occurred:

| script | change |
| --- | --- |
| `tests/parity/orch-to-worker.ts` | `passed` requires `deliveryVerified && !deliveryUnobserved` |
| `tests/parity/multi-worker.ts` | `verified === WORKER_COUNT && unobserved === 0` |
| `tests/parity/broadcast.ts` | `verified === AGENT_COUNT && unobserved === 0` |
| `tests/parity/continuity-handoff.ts` | both legs require `verifiedN && !unobservedN` |
| `tests/parity/stability-soak.ts` | `unobserved` counts toward `total` (so it drags the success rate) **and** `passed` requires `unobserved === 0` |

Codex also asked for a negative test proving timeout fallback is not counted as
observed delivery. That is M3 in `evidence/mutation-proof.md`, and it is a real
end-to-end proof rather than a unit assertion: the broker's two echo emit sites
were relabelled `timeout_fallback`, the debug broker rebuilt, and
`parity-orch-to-worker` run against it —

- **Arm A**, the fixed script: `=== Orch-to-Worker Parity Test FAILED ===`
- **Arm B**, control, the *pre-fix* predicate (`kind` alone) against the *same*
  mutated broker: `=== Orch-to-Worker Parity Test PASSED ===`

Arm B is F2's claim demonstrated, not argued. Source and binary were restored
before any evidence in this pass was recorded.

Deliberately **not** changed: the other `delivery_verified` consumers
(`tests/integration/broker/*`, `tests/benchmarks/reliability.ts`,
`tests/integration/sdk/*`). They are outside the phase-0 parity list and
changing them widens the blast radius past the finding.

---

## F3 — Medium — the seal was stale. FIXED (regenerated).

Valid. The stored `seal-implementation.json` recorded `headSha`
`01292d184a…` against a tree that had moved to `1b899f256b…` with uncommitted
product changes, and had no `sourceEntries` even though `seal()` in
`scripts/migrate/native-delivery-gates.mjs` now hashes changed product paths.

The seal *implementation* was already correct; only the stored artifact was old.
It was regenerated as the last action of this pass, after every recorder below
had run, so it now carries the live `headSha`, the current evidence set, and
`sourceEntries` for every changed product path.

Codex's underlying point stands and is worth repeating for the next reviewer:
**do not accept a seal as proof of a tree you have not re-derived.** Two gate
artifacts in this very directory were stale in exactly that way — see the next
section.

---

## Found while re-running: two `-final` gates were green on a tree they no longer described

Not a codex-review-1 finding, but it falls out of F3 and had to be repaired to
re-record anything.

`manifest-gate` and `targeted-gate` both went **red** on the current tree:

```text
GATE_FAILED manifest-gate phase=0
  unrouted runtime files: crates/broker/src/broker/delivery_verification.rs
GATE_FAILED targeted-gate phase=0
  unmapped runtime paths, so every migration PR runs a full smoke:
  crates/broker/src/broker/delivery_verification.rs,
  tests/e2e/unlaunched/session-host.ts,
  tests/e2e/unlaunched/unlaunched-delivery.test.ts
```

All three paths were already in the working tree *before* this pass, and
`crates/broker/src/broker/` is in phase 0's `scope`, so those gates were red
before their `-final` evidence claimed green — the evidence predated the files.

Repair, in `.agentworkforce/features/manifest.yaml` under
`delivery-backend-seam`: added `crates/broker/src/broker/delivery_verification.rs`
(now genuinely seam surface — it holds `verification_timeout_frames` and
`TIMEOUT_FALLBACK_VERIFICATION`) and `tests/e2e/unlaunched/` to `location`.
Both gates are green again.

Caveat, stated rather than hidden: `tests/e2e/unlaunched/` is scaffolding for
the unlaunched-session gate, which phase 0's contract does not require
(`"unlaunched": false`). Mapping it to `delivery-backend-seam` is the narrowest
honest route available today, but it should be re-homed onto the phase-1/2
features (`codex-queue-delivery`, `claude-socket-delivery`) when those register.
That is the same over-broad-ownership problem claude-review-1 raised as F12,
which is still open.

---

## Evidence re-recorded

All through `scripts/migrate/native-delivery-gates.mjs record`, run id
`phase-0-seam-20260920c-claudefix1`.

| recorder | verdict |
| --- | --- |
| `rust-fmt` | green |
| `rust-clippy` | green |
| `rust-build` | green |
| `invariant-tests` (`cargo test -p agent-relay-broker`) | green — 1285 lib + 4 seam-invariant + 12 + 2 + 3 |
| `ts-typecheck` | green |
| `parity-orch-to-worker` | green — verified(echo) true, unobserved 0 |
| `parity-multi-worker` | green — 3/3 echo-observed, unobserved 0 |
| `parity-broadcast` | green — 3/3 echo-observed, unobserved 0 |
| `parity-continuity-handoff` | green — both legs echo-observed, unobserved 0 |
| `parity-stability-soak` | green — 32 verified, 0 failed, 0 unobserved, 100% |
| `edit-gate` / `-final` | green |
| `manifest-gate` / `-final` | green (after the mapping fix above) |
| `targeted-gate` / `-final` | green |
| `seam-rules` / `-final` | green |
| `unlaunched-gate` / `-final` | green (not required at phase 0) |
| `unit-tests` (`npx vitest run --maxWorkers=4`) | **red — pre-existing, see below** |

The parity suite is therefore green **with strictly stronger assertions than
before**, and with the PTY backend behind the seam. That is the phase's exit
criterion, now meaning what it says.

### Red evidence observed and not papered over

**`invariant-tests`, first attempt: red.**
`terminal_control::tests::terminal_control_watchdog_survives_a_wedged_writer`
failed with `Protocol(MissingConnectionUpgradeHeader)` — a WebSocket handshake
race under parallel load. It passes in isolation, `crates/broker/src/terminal_control.rs`
is not in this diff, and the same full suite was green twice before and after.
Re-recorded with `--retry-on-red 1` (the recorder's documented mechanism; the
command must still pass, the verdict is the final attempt's). Flagging it rather
than burying it: if it recurs, it is a real flake to file, not a delivery bug.

**`unit-tests`: red, pre-existing, not from this phase.** Same failures, with
the same messages, as the evidence recorded *before* this pass:

- `tests/fixtures/verify-fleet-daytona.test.ts` — "expected … length 36 but got
  35" on the current-main CLI command surface. Deterministic across runs;
  reads as upstream `main` drift in the command inventory.
- `packages/harness-driver/src/broker-process.test.ts` — two spawn-cleanup tests
  failing `ENOENT … child.pid`. Flaky: 2 failures on one run, 1 on the next.

Neither file is touched by this diff and neither imports anything it changes.
I did not touch either test. They keep `accept` red, correctly.

---

## Still blocked — do not seal or commit

`BLOCKED_NO_COMMIT.md` has been updated. F8 in it is now closed (it was
codex-review-1 F1). Still open:

- **F4** — `DeliverySeam` is constructed per call inside `retry_pending_delivery`,
  so its receipt memory dies immediately; the duplicate guard and
  `settle`/`recorded_route` have no production effect. Needs a runtime-owned,
  bounded seam with the route recorded on `PendingDelivery`.
- **F11** — there is still no distinct terminal *in-doubt* disposition. This
  pass gives the PTY timeout fallback a correct narrow settlement; it does not
  give the seam a general one, and `InDoubt` / committed-error remain
  unreachable from the production route.
- **F12** — `delivery-backend-seam` owns broad PTY/runtime/parity surface, and
  this pass widened it further (see above). Needs re-homing as later phases
  register their own features.
- **`unit-tests` red** — pre-existing, but real, and `accept` reads it.
