# Trajectory: Fail-close unsupported Relayflow v2 schedules

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** September 2, 2026 at 09:05 PM
> **Completed:** September 2, 2026 at 09:16 PM

---

## Summary

Fail-closed unsupported Relayflow v2 schedule selection locally while preserving omitted schedule behavior and run v1/v2 selection; added red-first CLI and Cloud client contract coverage.

**Approach:** Standard approach

---

## Key Decisions

### Narrowed schedule relayflowVersion to v1 and fail-close v2
- **Chose:** Narrowed schedule relayflowVersion to v1 and fail-close v2
- **Reasoning:** Cloud PR #3270 head 5a238912 rejects relayflowVersion v2 on both schedule create and update; run v1/v2 remains supported.

### Validate schedule v2 before auth, file access, network, or durable effects
- **Chose:** Validate schedule v2 before auth, file access, network, or durable effects
- **Reasoning:** Both the CLI parser and Cloud client reject with the precise unsupported error so unsupported schedule requests cannot escape locally.

---

## Chapters

### 1. Work
*Agent: default*

- Narrowed schedule relayflowVersion to v1 and fail-close v2: Narrowed schedule relayflowVersion to v1 and fail-close v2
- Validate schedule v2 before auth, file access, network, or durable effects: Validate schedule v2 before auth, file access, network, or durable effects
- Red-first focused run failed 2/2 (Cloud reached missing workflow; CLI invoked mocked request). Green focused pair passed 113/113, the full typecheck chain passed, Prettier and diff checks passed. Full Vitest reached 2295 passing with 7 unrelated environment/load failures; selector suites were green. GitHub proof run 33667836953 remains in progress in step 13 and live logs withhold its Cloud run ID, so it was left untouched.

---

## Artifacts

**Commits:** bca6cdb3
**Files changed:** 6
