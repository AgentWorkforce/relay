# Codex fix round 2

Reviewed: `reviews/claude-review-2.md`

Verdict: source defects were valid. I fixed the high-risk delivery semantics,
but the phase remains blocked because the authoritative phase contract does not
allow every file the valid fixes require, and mutation proof evidence must be
regenerated for the stricter gate.

## Changes Made

- R2-1: added `FleetDeliveryBook::abandon_unconfirmed_delivery` and call it for
  unobserved `delivery_verified` frames so one timeout fallback cannot pin the
  per-agent cumulative ACK cursor forever.
- R2-2/R2-11: added a typed PTY writer commit boundary
  (`WorkerDeliverError`) and mapped post-admission writer failures to
  `DeliveryError::CommittedError` in `PtyDeliveryBackend`.
- R2-3/R2-9: made Rust verification handling echo-only. Missing, unknown,
  `timeout_fallback`, and `process_exit` verification values now settle as
  unobserved and emit `delivery_unobserved`; headless success reports
  `verification: "process_exit"` instead of being defaulted to echo.
- R2-4: changed `DeliverySeam::send` to return `SendOutcome::Fresh` vs
  `SendOutcome::AlreadySent`, bounded recorded receipts, and made retry callers
  treat cached receipts as no new attempt.
- R2-5: replaced the unbounded `terminal_failed_deliveries` set with a bounded
  FIFO-backed guard.
- R2-6: made the broker Steer retry timeout strictly later than the worker echo
  verification window by adding `VERIFICATION_TICK` plus slack.
- R2-7/R2-8: introduced `DeliveryAttemptOutcome::TerminalInDoubt` so possible
  writes stop retrying without being dead-lettered for operator redelivery;
  zero-write failures still dead-letter normally and report zero attempts.
- R2-10: replaced the killed-child retry expectation with a deterministic
  terminal-in-doubt assertion for committed writer failure; retained broader
  filtered runtime coverage.
- R2-12: made `tests/e2e/unlaunched` opt-in via `test:e2e:unlaunched` and
  excluded it from the default e2e config; aligned its broker binary resolver
  to debug-first then release.
- R2-13: tightened `seam-rules` so every configured invariant must have its own
  failing mutation transcript.

## Disputes

None. The review findings were treated as valid. The only remaining blocker is
phase-contract scope/evidence, not disagreement with the findings.

## Evidence Re-run

Green:

- `evidence/rust-seam-invariants-fix-2.json`
- `evidence/rust-runtime-delivery-filter-fix-2.json`
- `evidence/unlaunched-gate-fix-2.json`

Red:

- `evidence/edit-gate-fix-2.json`
- `evidence/manifest-gate-fix-2.json`
- `evidence/targeted-gate-fix-2.json`
- `evidence/seam-rules-fix-2.json`

The red gates are also summarized in `BLOCKED_NO_COMMIT.md`. No commit, push,
merge, or main-branch operation was performed.
