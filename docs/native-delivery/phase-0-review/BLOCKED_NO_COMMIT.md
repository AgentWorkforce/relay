# Blocked after Codex fix round 2

run: codex-fix-2
phase: 0 (seam)

Claude review round 2 contained valid findings that require source fixes outside
the phase contract's declared edit scope and/or fresh mutation evidence. I fixed
the source defects I could verify, but the phase must not be sealed or committed
while these recorded gates are red.

## Recorded Green Evidence

- `evidence/rust-seam-invariants-fix-2.json`: `cargo test -p agent-relay-broker --test delivery_seam_invariants` passed, 4 tests.
- `evidence/rust-runtime-delivery-filter-fix-2.json`: `cargo test -p agent-relay-broker --lib delivery_ --no-fail-fast` passed, 135 filtered tests.
- `evidence/unlaunched-gate-fix-2.json`: `unlaunched-gate` passed as `not-required` for phase 0.

## Recorded Red Evidence

- `evidence/edit-gate-fix-2.json`: `edit-gate` failed because valid fixes touched out-of-scope files: `crates/broker/src/node_control.rs`, `crates/broker/src/worker.rs`, `package.json`, `vitest.e2e.config.ts`.
- `evidence/manifest-gate-fix-2.json`: `manifest-gate` failed because runtime files touched by valid fixes remain unrouted: `crates/broker/src/runtime/event_loop.rs`, `crates/broker/src/runtime/headless.rs`, `crates/broker/src/runtime/init.rs`.
- `evidence/targeted-gate-fix-2.json`: `targeted-gate` failed because unmapped paths force full smoke: `crates/broker/src/node_control.rs`, `crates/broker/src/runtime/event_loop.rs`, `crates/broker/src/runtime/headless.rs`, `crates/broker/src/runtime/init.rs`, `crates/broker/src/worker.rs`, `package.json`.
- `evidence/seam-rules-fix-2.json` (recorded against the original `e1954da338e39080b0997036f059d6320b850d76` snapshot): `seam-rules` failed because `mutation-proof.md` lacked per-invariant failing transcripts for `never_resends_on_doubt`, `records_route_for_each_send`, and `never_acks_without_observation` after the gate was tightened.

## Why This Blocks

The phase contract is authoritative. The source fixes for R2-1 and R2-2 are
valid but necessarily cross the current phase scope: R2-1 needs fleet cursor
bookkeeping in `node_control.rs`, and R2-2 needs the PTY worker write commit
boundary in `worker.rs`. The gate evidence now reflects that mismatch instead
of hiding it.
