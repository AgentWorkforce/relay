# PTY injection integrity and fleet task confirmation

Long fleet tasks and relay messages were typed into Claude one character every
5 ms. A 6.7 KB brief occupied the PTY write drainer for roughly 33 seconds, delaying
terminal-query replies and startup auto-responses while the composer could change.
The existing verification timeout acknowledged even a tail-only echo.

This change sends one bracketed paste to harnesses that have advertised DECSET
2004, followed by the existing delayed Enter. The capability is latched across
mode resets; composer readiness is checked independently before writing. A missing
composer, oversized body, or tail-only echo produces an explicit non-retryable
failure. Failed deliveries retain their identity and are never replayed or
subsequently acknowledged as successful duplicates. CRLF becomes LF; bare CR and
ESC cannot submit or terminate the body early.

The verification ladder is shared with wrap: exact echo, normalized head/tail
anchors, then paste summary. Missing heads only count as loss when the observation
window is retained. Absent echoes preserve `timeout_fallback`, now with a warning
and process-local counter. Wrap retains its existing failed-throttle timeout policy.

Verified fleet PTY spawns with a task remain pending after readiness until the
matching task verdict arrives; explicit task failures fail the spawn action.
Native and argv-task startup paths retain their existing readiness contract.
`fleet spawn`, `agent spawn`, and `node agent spawn` accept `--task-file`, read on
the requester and forwarded through existing task transport. Fleet requires
exactly one task source. Message commands and task input validate UTF-8 byte size.

Limits are 16 KiB globally, including the formatted envelope at the PTY boundary,
and 1,536 bytes for the default paced fallback. A slower explicit pace lowers that
cap. Codex retains its chunked initial-task path and uses the smaller derived cap.
The ordinary typed-path budget closes inside 90 seconds:
60 s startup + 15 s prompt recheck + 7.68 s typing + 0.25 s submit + 5 s verification
= 87.93 s. Steer acknowledgements include the injection budget.

## Validation

- Full broker and relay-pty run: **1,627 passed, 0 failed, 7 ignored**.
- Integrity integration suite, including the ignored stress test: **6 passed**.
  Twenty cold starts each receive a >10 KB task and a >10 KB follow-up message,
  verified byte-for-byte in the fake harness's input transcript with one paste
  pair and one submit. Other arms cover tail loss/no replay, explicit size
  rejection, disappearing composer, and absent-echo compatibility.
- CLI regression suites: **188 passed**; CLI TypeScript checking passed.
- `cargo fmt --all --check` and `cargo clippy --all-targets` passed. Clippy reports
  five pre-existing sliced-string warnings in Codex tests.
- Live Claude startup probe observed DECSET 2004; no disable appeared during the
  six-second observation. Parser regression covers enable and disable in one read.

Commands (debug symbols disabled to fit the workspace disk):

```sh
env -u GIT_CONFIG_COUNT CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_INCREMENTAL=0 cargo test -p agent-relay-broker -p relay-pty
CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_INCREMENTAL=0 cargo test -p agent-relay-broker --test pty_injection_integrity -- --include-ignored
CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_INCREMENTAL=0 cargo clippy --all-targets
cargo fmt --all --check
npx vitest run packages/cli/src/cli/lib/task-input.test.ts packages/cli/src/cli/commands/fleet.test.ts packages/cli/src/cli/commands/local-agent.test.ts packages/cli/src/cli/commands/relaycast-groups.test.ts
npx tsc --noEmit -p packages/cli/tsconfig.json
```

This workspace injects `core.hooksPath=/dev/null` through `GIT_CONFIG_COUNT`.
Removing that setting only for the Rust test process lets the existing hook-chain
regressions exercise their own temporary repositories; all four then pass.

## Compatibility and remaining work

Per `reviewed-plan.md`, absent-echo fallback still counts as spawn success. It is
**not cryptographic or byte-for-byte receipt confirmation**; the stronger ticket
acceptance needs a harness receipt protocol. The 20-run proof uses a raw-mode fake
Claude TUI through the real broker, not 20 authenticated Claude transcripts.

Wrap already bulk-wrote Claude input before this change. Fleet gains that behavior
plus explicit paste framing and readiness checks, rather than simply reverting
the 10.4.0 pacing fix. Large Claude inputs can now appear as pasted-content blocks;
the attribution envelope is unchanged.

Duplicate desktop/broker registrations remain a separate investigation requiring
the reporter's ambient MCP configuration. A node-side brief-file writer and
integration-command `--task-file` support are follow-ups. No workflow files were
changed, and no release or merge was performed.
