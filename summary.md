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

## Readiness gating

Muse readiness no longer accepts output volume as proof: a visible prompt with
no authentication screen on it is the only accepted signal, so the device-login
screen (a prompt glyph plus well past 500 bytes while waiting on a human) can
no longer release a worker as ready. A recognised login screen is classified
`StartupGate::ProviderAuthRequired` — blocking like a trust prompt, and
additionally reported once as `worker_error{code:"provider_auth_required"}`,
which drives the layer 3 failure path: the pending verified spawn fails
immediately with that reason and the worker is released. An unrecognised screen
stays `Unrecognised` and still cannot prove readiness, so the spawn fails
closed on the deadline rather than reporting a task-ready worker. Muse's
initial task is in argv, so refusing to prove readiness never costs the
assigned work.

The device-login phrase list is not derived from a captured Muse screen — this
environment has no Muse binary or workspace key, so `dogpatch-mini` could not
be reached and neither failure mode could be classified against HEAD. The
detector is therefore keyed on whole phrases that only an authentication
interstitial renders, with the risk direction inverted so a wrong guess costs a
closed failure rather than a false ready. The phrases, their rationale, and how
to extend them are documented in `docs/harnesses/muse.md` and at
`detect_muse_device_auth_prompt`. Physical-node verification on `dogpatch-mini`
and a captured-screen test remain outstanding.

## Validation

- Full broker suite: 1,364 unit tests passed plus every integration binary, five
  ignored. Includes `muse_startup_cli`, whose new
  `muse_device_auth_screen_reports_provider_auth_required_without_readiness`
  drives the real broker PTY wrapper against a device-login fixture. With the
  readiness arm removed, that test reproduces the ticket exactly —
  `worker_ready{readiness_proven:true}` on a login screen — and the existing
  `muse_argv_prompt_runs_tool_unattended_then_becomes_ready` stays green
  unchanged.
- Full relay-pty suite: 258 tests passed.
- Full vitest suite: 197 files / 3,652 tests passed, 3 files and 24 tests
  skipped.
- PR-proof and subscription proof guards: 67 and 99 tests passed.
- `cargo fmt --check`: clean. Strict Clippy reports only five pre-existing
  `sliced_string_as_bytes` findings in unchanged `pty_worker.rs` test code;
  `cargo clippy --all-targets -- -D warnings -A clippy::sliced_string_as_bytes`
  passes.
- Environment-caused check failures and their handling are recorded in
  `.relayflow/repair-notes.md`.
