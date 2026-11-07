# Trajectory: Stop standalone smoke CI from creating throwaway Relaycast workspaces

> **Status:** ✅ Completed
> **Confidence:** 93%
> **Started:** August 18, 2026 at 11:34 AM
> **Completed:** August 18, 2026 at 12:03 PM

---

## Summary

Reworked standalone smoke CI to reuse one secret-backed workspace, fail closed without the key, clear higher-precedence multi-workspace state, use collision-resistant broker names, and assert/announce workspace reuse. Seeded the GitHub Actions secret without exposing it; validated two concurrent real smokes plus a follow-up, a green Package Validation run, the full 2,068-test suite, shell/format checks, and opened PR #1567 without merging.

**Approach:** Standard approach

---

## Key Decisions

### Reuse one secret-backed CI workspace and give every smoke process a unique broker name
- **Chose:** Reuse one secret-backed CI workspace and give every smoke process a unique broker name
- **Reasoning:** The smoke asserts local status/down/up/readiness behavior; fresh workspace provisioning is incidental. A committed pin would expose a credential and create-and-delete is unavailable (relaycast#336). Temporary HOME/project directories isolate local state, while unique broker names and derived node identities prevent concurrent runs from colliding in the shared workspace. Missing credentials fail closed; fork PRs skip the live-cloud job because GitHub withholds repository secrets.

---

## Chapters

### 1. Work
*Agent: default*

- Reuse one secret-backed CI workspace and give every smoke process a unique broker name: Reuse one secret-backed CI workspace and give every smoke process a unique broker name
- The shared-workspace design is behaving as intended: two concurrent real brokers and a follow-up all completed, with unique broker names preventing collision and temp HOME/project roots isolating state. One initial verification harness used relative binary paths and failed before startup; correcting to absolute paths proved the target behavior without creating another workspace.

---

## Artifacts

**Commits:** 09d73b040
**Files changed:** 5
