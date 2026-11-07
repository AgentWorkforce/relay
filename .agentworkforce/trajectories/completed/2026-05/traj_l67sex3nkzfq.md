# Trajectory: Fix failing harness PR e2e tests

> **Status:** ✅ Completed
> **Confidence:** 88%
> **Started:** May 25, 2026 at 07:22 PM
> **Completed:** May 25, 2026 at 07:32 PM

---

## Summary

Fixed the SDK spawn result schema so broker pid:null responses parse as undefined, added a regression test, and validated SDK checks/build plus daemon-only E2E smoke.

**Approach:** Standard approach

---

## Key Decisions

### Normalize null spawn pid in SDK schema

- **Chose:** Normalize null spawn pid in SDK schema
- **Reasoning:** CI showed /api/spawn can return pid:null before the PTY worker emits worker_ready with the harness PID; the SDK public type already treats pid as optional, so null should parse as undefined like sessionId.

---

## Chapters

### 1. Work

_Agent: default_

- Normalize null spawn pid in SDK schema: Normalize null spawn pid in SDK schema
