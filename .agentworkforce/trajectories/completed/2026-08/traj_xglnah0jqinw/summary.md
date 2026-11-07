# Trajectory: Fix main publish blocker in CI standalone smoke test

> **Status:** ✅ Completed
> **Confidence:** 95%
> **Started:** August 18, 2026 at 11:15 PM
> **Completed:** August 18, 2026 at 11:37 PM

---

## Summary

Prevented recursive EXIT cleanup in the standalone CI smoke lifecycle, retained the exact three-shutdown assertion with mechanism documentation, and verified all 2,100 tests in the publish-equivalent Node 22/Linux environment.

**Approach:** Standard approach

---

## Key Decisions

### Treat the fourth node-down call as erroneous EXIT cleanup re-entry
- **Chose:** Treat the fourth node-down call as erroneous EXIT cleanup re-entry
- **Reasoning:** The invocation order [1,4,6,7] shows the configured preflight down, deadline teardown, and then two adjacent cleanup downs. Commits #1568 and #1572 do not touch the smoke script; #1567 introduced the cleanup trap. Disarming EXIT before its cleanup subshell preserves the required three-step lifecycle without weakening the assertion.

---

## Chapters

### 1. Work
*Agent: default*

- Treat the fourth node-down call as erroneous EXIT cleanup re-entry: Treat the fourth node-down call as erroneous EXIT cleanup re-entry
- The merge-interaction hypothesis was disproved: main ends at #1567, while #1568 is Rust-only and #1572 changes fleet attach code. The failure is #1567 cleanup re-entry exposed by CI scheduling. The fix preserves the exact three-shutdown contract and passes the full publish-equivalent Node 22/Linux suite.
