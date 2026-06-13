# Trajectory: Workspace-level event stream via relaycast 2.5.1

> **Status:** ✅ Completed
> **Confidence:** 72%
> **Started:** June 3, 2026 at 12:27 PM
> **Completed:** June 13, 2026 at 05:22 PM

---

## Summary

Reviewed PR 1124 cloud worker CLI/runtime changes; fixed unresolved reviewer findings around abort handling, cleanup, SSE reader cancellation, heartbeat validation, token scoping, payload validation, and ack-based dedupe; added focused cloud worker regression tests.

**Approach:** Standard approach

---

## Key Decisions

### Port PR 888 telemetry lessons to current split
- **Chose:** Port PR 888 telemetry lessons to current split
- **Reasoning:** User requested Relaycast request attribution, install/update events, and MCP action-call telemetry while preserving UA-like harness values.

### Added DeliveryOutcome::Unverified for timeout-fallback acks
- **Chose:** Added DeliveryOutcome::Unverified for timeout-fallback acks
- **Reasoning:** Fallback ack must stay (re-injection deliberately disabled to avoid duplicates) but unverified deliveries must not feed the throttle's success streak; a neutral variant breaks the streak without backing off

### PendingDeliveryStore wrapper with DerefMut dirty tracking
- **Chose:** PendingDeliveryStore wrapper with DerefMut dirty tracking
- **Reasoning:** Free delivery helpers take &mut HashMap across many call sites; a Deref/DerefMut wrapper marks dirty on any mutable coercion so the event loop persists after every mutating event with zero call-site churn

### Kept --persist flag default-off
- **Chose:** Kept --persist flag default-off
- **Reasoning:** The flag also gates state files, lock/PID files, MCP config injection mode, and lease-based ephemeral shutdown; flipping it would change far more than delivery durability and break ephemeral one-shot SDK sessions

### Skipped dedup-cache persistence
- **Chose:** Skipped dedup-cache persistence
- **Reasoning:** Optional per task; would add restart-replay dedup but bloats the diff beyond delivery semantics

### Use ordered queryEvents history for waitForResult replay
- **Chose:** Use ordered queryEvents history for waitForResult replay
- **Reasoning:** The live waitForResult path resolves on the first matching agent_result after subscription, so replay should read broker history in chronological order instead of using getLastEvent.

### Resolved PR 1073 trajectory conflict by keeping the active main trajectory and merging PR broker decisions into it
- **Chose:** Resolved PR 1073 trajectory conflict by keeping the active main trajectory and merging PR broker decisions into it
- **Reasoning:** main added a later waitForResult decision after PR 1073 completed the same trajectory; keeping active plus removing stale completed artifacts preserves both histories without duplicate active/completed records for the same id

### Clean CHANGELOG by tag range
- **Chose:** Clean CHANGELOG by tag range
- **Reasoning:** Only commits after v8.4.0 should remain in [Unreleased]; recent released sections should be curated from the commits between adjacent release tags.

### PR 1123 lockfile is reproducible from current manifests
- **Chose:** PR 1123 lockfile is reproducible from current manifests
- **Reasoning:** package-lock.json is the sole changed file; npm install --package-lock-only, npm ci, npm test, typecheck, lint, and targeted prettier all validate the lockfile change. Broader syncpack/format issues are outside this lockfile PR.

### Kept PR fixes scoped to cloud worker runtime and CLI worker lifecycle comments
- **Chose:** Kept PR fixes scoped to cloud worker runtime and CLI worker lifecycle comments
- **Reasoning:** All unresolved reviewer findings were in the PR-added cloud worker files; broader docstring and local metadata formatting issues are advisory/out of scope.

---

## Chapters

### 1. Work
*Agent: default*

- events.connect() falls back to the relaycast 2.5 workspace stream when no agent client; fixes relay#1031 so workspace relay.addListener streams. Bumped @relaycast/sdk to ^2.5.1. Also fixed pre-existing vitest-4 constructor-mock breakage in agent-relay.test.ts (main 'Test' workflow was red).: events.connect() falls back to the relaycast 2.5 workspace stream when no agent client; fixes relay#1031 so workspace relay.addListener streams. Bumped @relaycast/sdk to ^2.5.1. Also fixed pre-existing vitest-4 constructor-mock breakage in agent-relay.test.ts (main 'Test' workflow was red).
- Port PR 888 telemetry lessons to current split: Port PR 888 telemetry lessons to current split
- Added DeliveryOutcome::Unverified for timeout-fallback acks: Added DeliveryOutcome::Unverified for timeout-fallback acks
- PendingDeliveryStore wrapper with DerefMut dirty tracking: PendingDeliveryStore wrapper with DerefMut dirty tracking
- Kept --persist flag default-off: Kept --persist flag default-off
- Skipped dedup-cache persistence: Skipped dedup-cache persistence
- Use ordered queryEvents history for waitForResult replay: Use ordered queryEvents history for waitForResult replay
- Resolved PR 1073 trajectory conflict by keeping the active main trajectory and merging PR broker decisions into it: Resolved PR 1073 trajectory conflict by keeping the active main trajectory and merging PR broker decisions into it
- Clean CHANGELOG by tag range: Clean CHANGELOG by tag range
- PR 1123 lockfile is reproducible from current manifests: PR 1123 lockfile is reproducible from current manifests
- PR 1123 review complete: no code edits needed; lockfile-only change validated locally and GitHub Actions are green
- Kept PR fixes scoped to cloud worker runtime and CLI worker lifecycle comments: Kept PR fixes scoped to cloud worker runtime and CLI worker lifecycle comments

---

## Artifacts

**Commits:** 10afd571, 101d08a9, fe53c66f, 0a29e587, 0bac4eea, c9c566a3, c48693e3, 2e366871, 1f219873, 56aeb4be, 0f87d23b, fe2f9f6f, 5ffa36fb, 50c8cc52, f939a51b, 7546dca1, fb683a37, 1d24cd56, b74b4769, da244a27, a037f155, 4f7034c7, fa4b257f, ffabf6b0, 05a57f5b, ad83e66b, 79fb8f84, fc130435, 8892f235, 4226027d, f87fa77a, 9fe26de0, 1084cbf8, e07d55a9, 48ca05cc, 8a98ad92, 9244d9da, 89bc24da, 2c174d73, eb01b476, 040da377, 8abbf5ae, 3180838e, 2d28ab5d, d4729a92, 9909d6f9, 97c20f6f, eec14ab4, c3c772ca, dfc38bf6, eaadff6b, e16e862c, 2cdca133, 48104726, bdded6f6, 7e9a44ab, cc27e547, 2183884e, 9bc6186d, b07eb230, 95be33cd, 3b300b85, f6d28c83, 6b67acfc, 8f39248f, d8247f70, 38d627bd, f0a14f26, 28f59b5b, 152ea978, 1301a319, d67f6de6, b11c257e, ad9dbe41, 6eef2da3, bc6b9826, eb55a2b7, 8f4db312, ac43ef4b, a14f65f9, d8d00e2c, 58d7f729, 7f2392d7, 6df294fc, b17be37e, 1433c47e, c7811469, 80e42410, aaa65c91, f4ff7e02, 1cb41cff, d18bd284, a5ce5aae, 0a651273, 767f954b, 9c6d2229, 51ee3852, 235a7507, 9959deed, eb9dc4c2, 00a2c436, f48136a6
**Files changed:** 324
