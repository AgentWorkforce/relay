# PR 1672 review repair evidence — 2026-09-06

Starting head: `b71c88efc04434e3dce53e387450e232c7a99a90`.

Eight review threads are addressed. The remote same-ID takeover P1 (`PRRT_kwDOQqeBuc6fpw1L`) remains a merge blocker; it is confirmed, not disputed.

## Regression proof

The full broker library suite passed with all mutation switches disabled: **1,068 passed, 4 ignored**. Inherited `GIT_CONFIG_*` and `RELAY_ATTEST_*` variables were removed from the test subprocess so Git-hook fixtures exercised their own configuration. No repository checks or hooks were bypassed.

Temporary source mutations were compiled together and enabled one at a time with `RELAY_1672_MUTATION`, then the exact named regression was run. Every local mutant below failed at a behavioral assertion. The source mutations were restored before commit. The last row changes the remote identity fixture to reproduce the unresolved takeover bug; it is not a fixed mutation.

| Mutation / reproduction | Test | Observed failure |
| --- | --- | --- |
| `stale_binding` | `broker::tests::defer_identity_release_prefers_valid_authoritative_binding` | assertion left == right failed   left: "agent-persisted"  right: "agent-rebound" |
| `stale_binding` | `runtime::tests::release_after_broker_restart_uses_rebound_identity` | assertion left == right failed: the current remote identity must actually be released   left: 0  right: 1 |
| `lose_previous` | `broker::tests::pending_releases_preserve_both_generations_across_restart` | no entry found for key note: run with RUST_BACKTRACE=1 environment variable to display a backtrace test broker::tests::pending_releases_preserve_both_generations_across_restart ... FAILED |
| `pending_before_active` | `runtime::tests::stale_generation_release_after_restart_preserves_persisted_replacement` | stale handle must fail before touching persisted replacement: Object {"name": String("persisted-replacement"), "success": Bool(true)} note: run with RUST_BACKTRACE=1 environment variable to display a backtrace test runtime::tests::stale_generation_release_after_restart_preserves_persisted_replacement ... FAILED |
| `binding_loses_identity` | `runtime::tests::http_spawn_retains_identity_when_node_binding_warns` | binding warning must not discard the registered identity: "mutation: discarded registered identity on bind warning" note: run with RUST_BACKTRACE=1 environment variable to display a backtrace test runtime::tests::http_spawn_retains_identity_when_node_binding_warns ... FAILED |
| `kill_replacement` | `runtime::tests::stale_generation_release_does_not_stop_same_name_replacement` | the replacement process must remain alive note: run with RUST_BACKTRACE=1 environment variable to display a backtrace test runtime::tests::stale_generation_release_does_not_stop_same_name_replacement ... FAILED |
| `all_pids_live` | `runtime::tests::release_after_broker_restart_recovers_dead_persisted_exact_identity` | dead persisted worker should finish exact cleanup: "worker 'persisted-dead-worker' has a live persisted process but this broker no longer owns its process handle; refusing to report release success" note: run with RUST_BACKTRACE=1 environment variable to display a backtrace test runtime::tests::release_after_broker_restart_recovers_dead_persisted_exact_identity ... FAILED |
| `skip_live_guard` | `runtime::tests::release_after_broker_restart_refuses_unowned_live_persisted_process` | an unowned live persisted process must fail closed: Object {"name": String("persisted-live-worker"), "success": Bool(true)} note: run with RUST_BACKTRACE=1 environment variable to display a backtrace test runtime::tests::release_after_broker_restart_refuses_unowned_live_persisted_process ... FAILED |
| `skip_promotion` | `runtime::tests::release_after_broker_restart_recovers_dead_persisted_exact_identity` | assertion left == right failed: every pending identity must be checked   left: 0  right: 1 |
| `stop_after_one` | `runtime::tests::release_after_broker_restart_drains_both_pending_generations` | assertion failed: !fixture.runtime.state.pending_identity_releases.contains_key(&name) note: run with RUST_BACKTRACE=1 environment variable to display a backtrace test runtime::tests::release_after_broker_restart_drains_both_pending_generations ... FAILED |
| `stable_id_takeover` | `relaycast::ws::tests::exact_agent_release_does_not_release_a_same_name_replacement` | assertion left == right failed: a stale cleanup must never dispatch a release to the replacement   left: 3  right: 0 |

Mutation runner and complete per-case logs are retained locally at `/private/tmp/relay-1672-mutate.py` and `/private/tmp/relay-1672-mutation-*.log`.

## Implementation decisions

- Prefer a nonblank authoritative delivery-book ID over stale persisted state. Both the state unit regression and real release request-count assertion fail under the old precedence.
- Prefer a persisted active generation over an older pending generation after restart. Guard tests also assert zero remote requests.
- Resolve HTTP fallback registration independently of node binding. A real HTTP spawn with a native `sleep` fixture verifies the returned warning and persisted agent ID. Lookup failures stop launch and retain the cached credential for retry.
- Keep superseded pending generations in serialized state; clearing the current record promotes the older record and the release path drains all retained records.
- Exercise the persisted PID gate using a spawned, killed, and reaped child PID. Assert replacement child liveness independently of its registry entry.
- Keep changelog wording impact-first and limit the protection claim to local replacements.

## Unresolved remote contract

Freshly fetched Relaycast main `8e36b742ced89d5e2d4be0866a7f641b31e0acfb` and pinned Rust SDK 7.0.0 expose only `name`, `reason`, and `delete_agent` on release. Takeover preserves the ID while rotating credentials. The same-ID fixture reproduction sends **3 forbidden release POSTs** (SDK retry policy). A GET before a name-addressed POST is not an atomic generation guard. The engine must enforce a credential/process-generation condition through dispatch and completion before broker cleanup can safely handle this race. The review thread remains open and the merge monitor has been notified.
