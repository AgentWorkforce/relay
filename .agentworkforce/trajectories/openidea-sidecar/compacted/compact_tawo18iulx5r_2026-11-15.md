# Trajectory Compaction: 2026-11-15 - 2026-11-15

## Summary
PR #2163 fixed environment authorization hiding writer-lock evidence for OpenIDEA servers in crates/relay-node/src/relay/codex/processes.rs. At PR head 2b62406ee, discovery returned only authorizing record; queue_send without configured CLI returned NotInstalled. Fix moved early exit after collection of every trusted writer lock, preserving environment caller authorization, same-user UID checks, and trusted executable requirements. Only duplicate legacy resume authorization is skipped. Regression coverage in processes.rs and crates/relay-node/src/relay/codex/router.rs checks all-lock collection, exact executable selection without configured CLI, and unique legacy resume authorization. Two new regressions failed before fix and passed afterward; focused Codex suite reported 327 passed, 2 ignored. Upstream main b6145fef0 was merged through d5a5558af after v18.7.3 caused CHANGELOG.md conflict. Resolution preserved upstream release history verbatim and retained pending OpenIDEA entry under [Unreleased - Patch]. Superseded full test run was stopped; final merged base passed 2878 tests, with 21 ignored and zero failures. Release build and changed-file rustfmt/diff checks passed. Clippy passed with existing unused_io_amount allowed and 106 current-base warnings; full formatting check retained pre-existing session_cli.rs tuple-formatting issue. Broad file list includes upstream release, Muse, and chief-execution-bridge changes; session’s authored fix centers on Codex discovery, routing regressions, and pending changelog entry. Deployed Core remained unchanged.

## Key Decisions (3)
| Question | Decision | Impact |
|----------|----------|--------|
| How should environment authorization interact with writer-lock discovery and legacy resume authorization? | Retain environment authorization, collect every trusted writer lock, then skip only duplicate legacy resume authorization. | OpenIDEA discovery retains all trusted writer locks and supports exact executable selection without configured CLI. Same-user UID and trusted executable checks remain enforced; legacy resume authorization has uniqueness coverage. |
| How should PR #2163 resolve changelog conflict after upstream v18.7.3 release? | Merge main b6145fef0, preserve released v18.7.3 history exactly, and retain only pending OpenIDEA fix under [Unreleased - Patch]. | Merge d5a5558af restored compatibility with upstream while keeping OpenIDEA fix pending at patch release level. |
| Which revision should supply final validation evidence? | Stop superseded full suite and rerun validation against final merged base. | Final merged base passed 2878 tests, release build, and changed-file checks; lint and full-format limitations were recorded separately. |

## Conventions Established
- **Complete trusted writer-lock collection before taking environment-authorization shortcut.**: Authorization success must not suppress evidence needed for subsequent executable selection and routing. (scope: crates/relay-node/src/relay/codex/processes.rs; environment-authorized OpenIDEA server discovery.)
- **Preserve same-user UID and trusted executable requirements across authorization paths.**: Collecting more evidence must retain existing trust boundaries. (scope: Codex process discovery and writer-lock acceptance.)
- **Cover discovery evidence and downstream routing behavior together.**: Incomplete discovery surfaced as queue_send returning NotInstalled. Tests must check all-lock collection, exact executable selection without configured CLI, and legacy resume authorization uniqueness. (scope: crates/relay-node/src/relay/codex/processes.rs and crates/relay-node/src/relay/codex/router.rs.)
- **Preserve published changelog sections verbatim when merging release updates; retain unmerged user-visible fixes under appropriate Unreleased level.**: Prevents released changes from reappearing as pending work and preserves release history. (scope: CHANGELOG.md; PR updates across upstream releases.)
- **Report changed-file checks separately from repository-wide baseline failures and lint allowances.**: Passing local checks does not imply clean full formatting or warning-free Clippy. (scope: Rust validation reports and PR completion evidence.)

## Lessons Learned
- Authorization shortcuts can break downstream routing by discarding discovery evidence. (Environment-authorized server returned only authorizing record; queue_send without configured CLI failed with NotInstalled.) - Audit early returns for required evidence collection. Add regressions that exercise discovery output and consumers relying on it.
- Prove regression tests fail against original PR head before accepting passing results. (Two new OpenIDEA regressions failed at 2b62406ee and passed after moving early exit.) - Retain before/after evidence for control-flow fixes, especially when successful authorization masks incomplete results.
- Upstream merges invalidate final validation claims tied to earlier revisions. (Release-related merge changed PR base during validation; earlier full run was stopped and suite rerun after merge.) - Tie completion evidence to final merged revision and replace superseded runs when base changes.
- Baseline exceptions need explicit attribution. (Clippy passed with unused_io_amount allowed and 106 current-base warnings. Changed-file rustfmt passed, while full formatting retained existing session_cli.rs tuple issue.) - Record allowances and unchanged baseline failures alongside successful checks; avoid claiming warning-free lint or clean repository-wide formatting.

## Open Questions
- Was PR #2163 subsequently merged? Session records upstream merge into feature branch, but no PR merge outcome.
- When will deployed Core receive and validate fix? Session explicitly left deployed Core unchanged.
- Which commit contains source fix and regression tests? Retrospective references accompanying source-fix commit, but supplied commit list identifies upstream and merge commits without naming that commit.

## Stats
- Sessions: 1, Agents: default, Files: 28, Commits: 4
- Date range: 2026-11-15T04:16:50.157Z - 2026-11-15T04:29:47.871Z