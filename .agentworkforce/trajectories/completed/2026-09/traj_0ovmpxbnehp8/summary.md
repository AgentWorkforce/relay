# Trajectory: Bound broker resolution and stale-PR recovery policy

> **Status:** ✅ Completed
> **Task:** AgentWorkforce/relay#1632
> **Confidence:** 98%
> **Started:** September 1, 2026 at 09:31 PM
> **Completed:** September 1, 2026 at 09:33 PM

---

## Summary

Made base/head broker resolution concurrent within one producer timeout, asserted that timing composition in the source contract, and documented/tested actionable recovery for exact artifacts beyond the 90-day retention boundary. Focused 65-test suite, typecheck, Prettier, syntax and diff checks pass.

**Approach:** Standard approach

---

## Key Decisions

### Resolve base and head artifacts concurrently
- **Chose:** Resolve base and head artifacts concurrently
- **Reasoning:** Each exact-SHA producer may consume the full 30-minute build window. Promise.all keeps the pair within the single broker-resolution budget already composed into the 100-minute dispatcher deadline.

### Require stale PRs to refresh after artifact retention
- **Chose:** Require stale PRs to refresh after artifact retention
- **Reasoning:** The trusted producer intentionally cannot accept arbitrary historical SHAs. Exact artifacts expire after 90 days, so the resolver now emits an actionable update/rebase-and-push recovery and the case author guide documents that bounded policy.

---

## Chapters

### 1. Work
*Agent: default*

- Resolve base and head artifacts concurrently: Resolve base and head artifacts concurrently
- Require stale PRs to refresh after artifact retention: Require stale PRs to refresh after artifact retention
