# Codex fresh-eyes review 1: phase 0 delivery seam

Read-only review. I did not edit product code, commit, push, merge, or touch main.

Inputs read: the current diff, `phase-contract.json`, `docs/native-delivery-migration.md`, `reviews/shadow-rust.md`, every JSON file under `evidence/`, and `seal-implementation.json`. I treated prior reviews and evidence as untrusted claims and re-derived the findings from the current files.

## Findings

### F1 - High - PTY timeout fallback still fabricates an acknowledgement

The current fix stops `delivery_verified(timeout_fallback)` from clearing the pending delivery, but the worker still emits a normal `delivery_ack` for the same unobserved timeout first. In `crates/broker/src/pty_worker.rs:2255-2296`, the timeout path explicitly says echo was not detected, then sends `delivery_ack` at `crates/broker/src/pty_worker.rs:2271-2279`, then sends `delivery_verified` with `verification: "timeout_fallback"` at `crates/broker/src/pty_worker.rs:2281-2290`. The broker's `delivery_ack` handler does not know this ack is unverified: it confirms and removes the pending delivery via `confirm_pending_delivery_and_resolve_fleet_ack` at `crates/broker/src/runtime/worker_events.rs:716-727`, emits the public `delivery_ack` event at `crates/broker/src/runtime/worker_events.rs:753-763`, emits `MessageDeliveryConfirmed` at `crates/broker/src/runtime/worker_events.rs:776-786`, and marks the delivery read at `crates/broker/src/runtime/worker_events.rs:787-795`. The later timeout-fallback branch at `crates/broker/src/runtime/worker_events.rs:864-887` is therefore too late to enforce "never ack without observation."

This violates the phase contract invariant "never_acks_without_observation" and the migration doc's rule "Never claim an acknowledgement you did not observe." It also creates semantic drift for native routes: a future native route that only has handoff/in-doubt semantics would be held to a stricter contract than the PTY route that is now behind the seam.

Exact repair: do not emit a normal `delivery_ack` from the PTY timeout-fallback path. Emit only an explicitly unverified event, or add a typed unverified/handed-over frame that the broker handles without clearing pending deliveries, without resolving withheld fleet acks, without emitting `MessageDeliveryConfirmed`, and without calling `mark_delivery_read_ack`. Add a runtime regression test that drives a `delivery_ack`/timeout-fallback scenario and proves unobserved timeout fallback cannot produce `MessageDeliveryConfirmed` or read ack.

### F2 - Medium - The parity scripts count timeout fallback as verified, so the gate can pass the fabricated-ack drift

The changed parity scripts all treat any `delivery_verified` event as success without inspecting its `verification` field. `tests/parity/orch-to-worker.ts:53-68` sets `deliveryVerified = true` on any `delivery_verified`; `tests/parity/multi-worker.ts:63-74`, `tests/parity/broadcast.ts:66-79`, `tests/parity/continuity-handoff.ts:49-61` and `tests/parity/continuity-handoff.ts:94-107`, and `tests/parity/stability-soak.ts:47-50` / `tests/parity/stability-soak.ts:85-92` do the same. The PTY worker emits `delivery_verified` even for timeout fallback at `crates/broker/src/pty_worker.rs:2281-2290`, with `verification: "timeout_fallback"`. Evidence can therefore go green while delivery was never observed by echo/activity.

This is not just an assertion style issue: `evidence/post-claude-review-1-parity.json` records a green `orch-to-worker` run, but that script would also be green on the timeout-fallback path above. The contract exit says parity must be green and unchanged, while the doc explicitly calls out silent behavior drift as reviewer responsibility.

Exact repair: update every phase-0 parity script to require `event.kind === "delivery_verified"` with `event.verification === "echo"` (or whatever the observed-delivery value is in the harness type), and fail on `verification === "timeout_fallback"` unless a specific test is intentionally exercising handoff-only semantics. Add a negative parity or unit test that injects/emits timeout fallback and asserts it is not counted as observed delivery.

### F3 - Medium - The implementation seal is stale relative to the reviewed tree

`seal-implementation.json` records `headSha` as `01292d184a6f57b50c53273926f9d4023c5d7fa6` at `.workflow-artifacts/migrate-native-delivery/phase-0-seam-20260920c/seal-implementation.json:6-8`, but the current tree I reviewed is at `1b899f256bbe6c8aa1464febf52743c65ddcba0b` with uncommitted product changes. The seal also contains only `entries` for artifact files at `.workflow-artifacts/migrate-native-delivery/phase-0-seam-20260920c/seal-implementation.json:9-175`; it has no `sourceEntries`, even though the current gate code now tries to hash product source entries in `scripts/migrate/native-delivery-gates.mjs:1166-1204`. It also omits the later review/fix artifacts that now exist in the evidence directory.

This makes the seal non-authoritative for the code and evidence currently being reviewed. It is especially risky here because the source changed after the seal: for example, `scripts/migrate/native-delivery-gates.mjs:1166-1204` changes seal semantics, but the stored implementation seal predates that shape.

Exact repair: regenerate `seal-implementation.json` after the final code/evidence state, and require it to include the live `headSha`, the current evidence artifacts, and `sourceEntries` for all changed product paths. Reviewers should not accept the old seal as proof of the current tree.

## Notes

Some earlier shadow findings appear repaired in the current diff: `delivery-backend-seam` is now present in the manifest at `.agentworkforce/features/manifest.yaml:103-112`, and `PtyDeliveryBackend` now maps `WorkerRegistry::deliver` errors to `DeliveryError::unavailable` at `crates/broker/src/delivery/pty.rs:48-52`, preserving the legacy retry policy for opaque PTY writer errors. I did not re-run the full parity or unit suites during this review because the task asked for adversarial review and artifact writing, not product-code fixes or fresh CLI launches.
