# Trajectory Compaction: 2026-11-14 - 2026-11-14

## Summary
PR #2163 review addressed OpenIDEA queue executable selection and process ancestry validation. Regression tests reproduced `NotInstalled` without a configured CLI and nested host inheritance across a present ancestor whose executable could not be read. Reported fix routes queue delivery using the executable of the exact same-user, trusted OpenIDEA thread lock holder, rechecks process start identity, and rejects unreadable ancestor executables while preserving readable launchers and configured CLI fallback. Session also documented integrated-terminal loaded-thread boundary: process ancestry cannot attest which OpenIDEA UI created server. Validation reported 2,797 tests passed, 21 ignored; changed-file rustfmt, diff check, and release build passed. Clippy completed with baseline `unused_io_amount` allowed and 104 existing warnings. Deployed Core remained unchanged. Implementation and regressions are committed alongside this record on fix/openidea-codex-sidecar, based on 51802f580d02.

## Key Decisions (3)
| Question | Decision | Impact |
|----------|----------|--------|
| Which executable should handle OpenIDEA queue delivery? | Use exact same-user, trusted thread lock holder and recheck process start identity; preserve configured CLI fallback. | Queue delivery invokes the trusted target thread lock holder executable without requiring a separately configured CLI. |
| How should ancestry validation handle an ancestor whose executable cannot be read? | Fail closed on unreadable ancestor executables while retaining readable launcher support. | Unknown executable breaks ancestry trust instead of allowing inheritance from more distant host. |
| Can ancestry establish which OpenIDEA UI created server? | Document integrated-terminal loaded-thread boundary explicitly. | Routing guarantees remain bounded by available process and thread evidence; UI provenance remains unproven. |

## Conventions Established
- **Pair trusted lock-holder selection with process start identity recheck.**: Delivery requires validating selected process identity, not merely finding candidate executable. (scope: OpenIDEA queue executable routing.)
- **Treat unreadable ancestor executables as trust failures; preserve readable launcher compatibility.**: Unknown ancestors must not inherit trust from outer host. (scope: OpenIDEA process ancestry validation.)
- **Add red/green regressions for missing CLI configuration and unreadable intermediate ancestors.**: Both reproduced failures involve discovery conditions ordinary successful routing may miss. (scope: Queue routing and nested host detection tests.)

## Lessons Learned
- Executable discovery must cover installations without configured CLI. (`NotInstalled` reproduced despite available trusted OpenIDEA thread lock holder.) - Retain no-configured-CLI regression alongside configured fallback coverage.
- Ancestry evidence supports narrower claims than UI ownership. (Nested host inheritance crossed unreadable ancestor; ancestry also could not identify originating OpenIDEA UI.) - Reject unknown executable ancestry and document loaded-thread boundary without claiming UI provenance.

## Implementation Evidence

- `CHANGELOG.md`
- `crates/relay-node/src/relay/openidea.rs`
- `crates/relay-node/src/relay/codex/processes.rs`
- `crates/relay-node/src/relay/codex/router.rs`
- `crates/relay-node/src/relay/codex/router/system.rs`

Regression symbols: `an_openidea_thread_uses_its_lock_holders_codex_without_a_configured_cli`, `an_openidea_queue_without_support_falls_back_to_the_configured_cli`, `a_present_ancestor_with_an_unreadable_executable_blocks_the_host`, `an_integrated_terminals_app_server_needs_a_loaded_thread`.

## Open Questions

- Maintainer review of the documented ancestry-based host contract, including manually loaded threads under the integrated terminal.

## Stats
- Sessions: 1, Agents: default, Files: 5; this record accompanies the implementation commit
- Date range: 2026-11-14T03:48:36.387Z - 2026-11-14T04:05:00.403Z
