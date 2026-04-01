# Trajectory: Stabilize flaky CLI agents --json test timeout

> **Status:** ✅ Completed
> **Confidence:** 93%
> **Started:** March 4, 2026 at 01:01 PM
> **Completed:** March 4, 2026 at 01:12 PM

---

## Summary

Added deterministic unit tests for agent-management-listing and messaging history JSON; reduced CLI JSON integration surface to a single agents --json smoke test

**Approach:** Standard approach

---

## Key Decisions

### Moved agents/who/history JSON assertions from process-level CLI test to deterministic unit tests
- **Chose:** Moved agents/who/history JSON assertions from process-level CLI test to deterministic unit tests
- **Reasoning:** direct handler tests avoid broker startup/network timing and remove CI timeout flake while keeping one end-to-end smoke check

---

## Chapters

### 1. Work
*Agent: default*

- Moved agents/who/history JSON assertions from process-level CLI test to deterministic unit tests: Moved agents/who/history JSON assertions from process-level CLI test to deterministic unit tests

---

## Artifacts

**Commits:** be51324e, 4e2a8934
**Files changed:** 20
