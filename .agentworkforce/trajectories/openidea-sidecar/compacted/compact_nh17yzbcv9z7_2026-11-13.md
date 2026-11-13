# Trajectory Compaction: 2026-11-13 - 2026-11-13

## Summary
Completed OpenIDEA-hosted Codex sidecar recognition in relay-node. Added platform-specific OpenIDEA executable recognition and bounded, same-user ancestor checks; connected trusted Codex app-server processes to queue-drainer discovery. Preserved generic app-server liveness behavior, existing writer-lock evidence, and rejection of nested Codex tool runs. Associated working-tree paths: crates/relay-node/src/relay/openidea.rs, crates/relay-node/src/relay/codex.rs, crates/relay-node/src/relay/codex/processes.rs, crates/relay-node/src/relay.rs, and CHANGELOG.md. Trajectory metadata recorded no file changes or commits, so implementation attribution relies on session summary and supplied working-tree context. Four OpenIDEA regressions passed, covering writer-lock behavior and idle stop/resume discovery. Full relay-node suite passed with RUST_MIN_STACK=16777216: 2793 passed, 21 ignored. Release build and isolated engine/Core readback confirmed automatic registration and activation of a real OpenIDEA task, with live push, through a separate local profile Core. Production Core remained unchanged. User-assisted DM round-trip verification subsequently passed; the temporary test sender and profile were cleaned up, with the production Core still running and all protected file hashes restored. Default formatting and Clippy have the documented unrelated baseline problems.

## Key Decisions (3)
| Question | Decision | Impact |
|----------|----------|--------|
| How should OpenIDEA-hosted Codex app-servers become discoverable? | Recognize OpenIDEA executable ancestry and route qualifying trusted Codex app-servers into queue-drainer discovery. | Real OpenIDEA task registered automatically through isolated local Core. |
| Which trust checks must sidecar recognition preserve? | Use bounded, same-user ancestry checks alongside trusted Codex identification and existing writer-lock evidence; reject nested Codex tool runs. | Added host recognition retains existing process eligibility boundaries. |
| How should live validation run without replacing production Core? | Use release build with isolated engine and separate local profile Core. | Discovery, automatic activation and a user-triggered DM/reply round-trip passed in isolation; test resources were removed and protected hashes restored. |

## Conventions Established
- **Keep host-specific executable recognition separate from generic app-server liveness.**: New host support should extend discovery eligibility without changing shared lifecycle semantics. (scope: relay-node process discovery; associated files include crates/relay-node/src/relay/openidea.rs and crates/relay-node/src/relay/codex/processes.rs.)
- **Combine bounded same-user ancestry, trusted executable identity, and existing writer-lock evidence.**: Host ancestry supplements existing trust checks; nested Codex tool runs remain ineligible. (scope: OpenIDEA Codex sidecar recognition and future host integrations.)
- **Cover writer-lock behavior and idle stop/resume transitions in discovery regressions.**: Successful initial discovery does not establish correct behavior across idle and resumed states. (scope: relay-node sidecar discovery tests.)

## Lessons Learned
- Full-suite success required larger test stack. (Recorded passing run used RUST_MIN_STACK=16777216 and produced 2793 passed, 21 ignored; underlying stack failure details were not preserved.) - Preserve stack setting when reproducing this validation and capture original failure before diagnosing its cause.
- Automatic registration and live push do not establish complete messaging behavior. (Real OpenIDEA task activated through separate local profile Core, but DM round-trip still required user assistance.) - Track discovery, activation, live push, and DM round-trip as distinct validation outcomes; finish DM check before claiming end-to-end messaging verified.
- Passing tests and release build can coexist with unresolved static-check failures. (Default formatting and Clippy exposed issues described as unrelated baseline problems; exact diagnostics were not included.) - Retain concrete diagnostics and baseline comparison so future reviewers can assess attribution.
- Trajectory metadata did not capture reported implementation changes. (Retrospective describes completed code changes, while Files changed and Commits fields are empty; supplied git snapshot shows associated working-tree changes.) - Record changed paths and commit identifiers when available so compacted summaries retain traceable implementation evidence.

## Open Questions
- What caused need for RUST_MIN_STACK=16777216, and should test tooling encode that setting?

## Stats
- Sessions: 1, Agents: default, Files: 0, Commits: 0
- Date range: 2026-11-13T16:40:15.878Z - 2026-11-13T16:58:56.284Z

## Subsequent validation

- Implementation commit: `7aa3c15f2b0850f0da9d89677ff9c33169efdae0`; PR #2163.
- User-triggered DM from a temporary sender reached the actual OpenIDEA task, which returned the matching random marker. The probe read back the distinct reply and reported PASS.
- The initial probe correctly refused to send while OpenIDEA had stopped its idle app-server. After a normal message resumed the same task, automatic discovery recovered without register.
- Temporary sender, test engine/Core, profile pointer and profile hook/trust/rules were removed. Production Core stayed running. Production helper, pointer, Codex config, hooks and Relay rules hashes match the pre-test baseline exactly.
- Baseline static-check diagnostics: formatting at `session_cli.rs:602`; Clippy `unused_io_amount` at `sdk_http.rs:158`. Both source files match main at `d783c7d89adc0f6781cd82db50e3a42f41ebcdd8`.
