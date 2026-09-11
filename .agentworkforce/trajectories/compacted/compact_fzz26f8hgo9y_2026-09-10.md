# PR 1726 review fixes and main rebase

The four review findings are fixed: nonempty unscoped outboxes cannot acquire an upload destination; exhausted local deliveries wait for absent recipients and retry after reconnect; taskless spawns remain idle; IPv6 listener and discovery addresses are bracketed. The outage proof records unexpected traffic during the outage as well as after recovery.

Read the merged software-garden#510 and relaycast#401 diffs before resolving the rebase. Stale roster snapshots remain dispatch-only evidence; offline or inactive ownership never proves an identity can be deleted. Preserved main's bounded status probes, startup ordering, cleanup safeguards, and release notes. Local workers now stay out of remote identity ownership bookkeeping; the process proof rejects a remote identity deletion request without stopping the local worker, and verifies local exit/respawn.

Rebased onto main b90248a39 (v12.0.0). Validation passed: 1,099 Rust tests (four ignored), 163 CLI tests, typecheck, strict Clippy, and local red/green process proofs using the exact base and rebased harness. Both the outbox/retry regressions and the local identity-ownership regression were observed failing before their fixes.

GitHub reports the PR mergeable. CI run 34470354002 passed proof metadata validation and exact artifact verification, then Cloud failed before either proof arm: registering base-prover returned workspace_busy with a 60-second retry interval. The uploaded cloud.log confirms this is a pre-test infrastructure failure. A normal Actions rerun was rejected by GitHub authentication; this durable record also supplies the branch update for a fresh CI run after cooldown. CI is still pending at the time of this record. No merge was performed.
