# Relay PR #1634 finish status

Owner: `relay-1634-finish-0902`

Branch: `fix/claude-injection-submit-0902`

PR: https://github.com/AgentWorkforce/relay/pull/1634

## Current state

- CI root cause: workflow `CI`, run `33600131630`, Windows job `Relay PTY Synchronization Tests (windows-latest)`; the live ConPTY proof stalled after `blocked-read-proven`.
- Review baseline: 14 unresolved threads at head `24010559540d9749a689380743ac56bf1c6a0380`.
- RelayFlow proof workflows were green at the baseline head and remain protected.
- Local repairs and validation are complete; push, CI, and thread cleanup remain. No merge will be performed.

## Repair scope

- Serialize Unix PTY readiness with verified-write boundary admission and add a deterministic poll-return/pre-lock regression.
- Make Windows ConPTY cancellation yield ordering to verified-write admission.
- Bound wrap write acknowledgements and retire the session on an unknown timed-out delivery outcome.
- Restore broad Windows relay-pty coverage while excluding only two documented legacy failures.
- Address the remaining focused correctness, workflow pinning, proof-harness, and trajectory-artifact review findings.

## Local validation

- `cargo test -p relay-pty`: 230 passed, 0 failed.
- `cargo test -p agent-relay-broker wrap::tests::`: 10 passed, 0 failed.
- `cargo clippy -p relay-pty -p agent-relay-broker --all-targets -- -D warnings`: passed.
- `cargo check -p relay-pty --target x86_64-pc-windows-gnu`: passed.
- `cargo fmt --all -- --check`: passed.
- `actionlint .github/workflows/rust-ci.yml`: passed.
- `node --test tests/relayflows/cases/1634-claude-multiline-task-submit/task-observation.node-test.mjs`: 2 passed, 0 failed.
- `git diff --check` and compacted trajectory JSON validation: passed.

## Coordination

- `attach-input-replay-0902` confirmed PR #1638 is limited to TypeScript attach input-recovery files; there is no overlap with this Rust PTY repair.
- The required `trail` binary is not installed globally. The documented `npx --yes agent-trajectories` fallback was attempted twice but hung without output and was stopped; existing tracked trajectory artifacts were preserved and repaired in place.
