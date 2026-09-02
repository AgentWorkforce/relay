# Trajectory: Address exact-head follow-up feedback on PR #1630

> **Status:** ✅ Completed
> **Task:** AgentWorkforce/relay#1630
> **Confidence:** 97%
> **Started:** September 1, 2026 at 08:29 PM
> **Completed:** September 1, 2026 at 08:29 PM

---

## Summary

Corrected the scoped-mount README task to use the sandbox mount root and verified formatting and exact example paths.

**Approach:** Standard approach

---

## Key Decisions

### Use the sandbox mount-root path in the scoped-mount README task
- **Chose:** Use the sandbox mount-root path in the scoped-mount README task
- **Reasoning:** Relayfile remote paths are materialized below /workspace in the spawned sandbox, so the agent-facing example must reference /workspace/live-review/run-123 rather than the remote path as a host absolute path.

---

## Chapters

### 1. Work
*Agent: default*

- Use the sandbox mount-root path in the scoped-mount README task: Use the sandbox mount-root path in the scoped-mount README task
