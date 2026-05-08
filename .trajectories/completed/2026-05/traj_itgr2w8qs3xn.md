# Trajectory: Make workflow deterministic failures repairable by agents

> **Status:** ✅ Completed
> **Confidence:** 86%
> **Started:** May 8, 2026 at 04:44 PM
> **Completed:** May 8, 2026 at 04:44 PM

---

## Summary

Added bounded deterministic gate repair: failed shell or verification gates select a repair agent, pass command/error/output context, run a repair task, and retry the gate. Added config fields, schema/docs, and a workflow-runner regression test.

**Approach:** Standard approach

---

## Key Decisions

### Repair deterministic gates inside the workflow runner
- **Chose:** Repair deterministic gates inside the workflow runner
- **Reasoning:** Deterministic check failures should be treated as work for an existing workflow agent before becoming terminal workflow failures; this keeps workflows closer to a multi-agent prompt loop.

---

## Chapters

### 1. Work
*Agent: default*

- Repair deterministic gates inside the workflow runner: Repair deterministic gates inside the workflow runner
