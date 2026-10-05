# Fleet Muse authentication preflight and failure cleanup

Verified Fleet Muse spawns now reject missing or unusable provider login files
before creating a worker or registering its identity. The error includes
`provider_auth_required`, the node and path, and login remediation. Auth contents
are never included. Valid shared logins and symlinked login files remain usable.

The preflight uses `harnessConfig.env` > worker environment > inherited environment
and the existing Muse auth-path resolver. Fresh isolated-auth homes fail closed;
unverified remote spawns retain their behavior with a warning.

A worker's explicit `provider_auth_required` error makes its pending verified
spawn expire immediately. Existing maintenance releases capacity and completes
identity cleanup with the specific reason. Later ready frames cannot overwrite
the failure, and stale generations cannot fail a replacement worker.

Regression coverage includes the Fleet action path before registration and dedup,
harness-env precedence, file usability and symlinks, isolated homes, stale worker
events, failure cleanup, a late-ready race, Fleet DSL delegation, and preservation
of provider errors through CLI spawn confirmation. The existing Muse startup
integration fixture is unchanged.

## Remaining acceptance gap

This implements reviewed-plan.md layers 1 and 3 only. Layer 2 is explicitly gated
on real device-login and authenticated-composer terminal captures. This environment
has no Muse binary or Relay workspace key (`agent-relay fleet nodes` reports no
workspace key), so dogpatch-mini could not be reached, HEAD could not be reproduced,
and neither failure mode nor token expiry could be classified. Captures and node
versions were requested but were not available.

No new terminal detector or worker auth-error producer is included. A present but
expired login can still reach the existing readiness heuristic; this PR does not
claim the expired-auth or authenticated-composer readiness acceptance criteria are
complete. The capture-dependent integration/proof cases and physical-node checks
remain outstanding. This is not a complete resolution of the reported ticket.

## Validation

- Focused Muse Rust tests: 34 unit tests and the existing startup integration test passed.
- Full relay-pty suite: 258 tests passed, one doc test ignored.
- Fleet DSL and CLI confirmation/lifecycle specs: 43 tests passed.
- `cargo fmt --check` and `git diff --check`: passed.
- Full broker suite: 1,362 unit tests and 18 integration tests passed, five ignored, with `GIT_CONFIG_COUNT=0` for the test command. The initial run's four hook-chain failures were caused by the runner injecting `core.hooksPath=/dev/null`.
- Strict Clippy on Rust 1.99 reports five pre-existing `sliced_string_as_bytes` findings in unchanged `pty_worker.rs` tests (lines 2722, 2733, 2801, 2817, 3006). `cargo clippy --all-targets -- -D warnings -A clippy::sliced_string_as_bytes` passes.
