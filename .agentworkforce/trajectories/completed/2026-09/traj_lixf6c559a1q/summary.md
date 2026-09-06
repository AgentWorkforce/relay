# Trajectory: Fix fleet release intermittent internal server error for live remote agents (issue #1671)

> **Status:** ✅ Completed
> **Confidence:** 86%
> **Started:** September 6, 2026 at 04:05 AM
> **Completed:** September 6, 2026 at 04:23 AM

---

## Summary

Implemented actionable and idempotent fleet release teardown: correlated typed broker errors, complete worker process-group termination, deterministic absence tests, and sealed two-arm RelayFlow case; opened PR #1672.

**Approach:** Standard approach

---

## Key Decisions

### Preserved typed release failure correlation and moved worker teardown to a private process group
- **Chose:** Preserved typed release failure correlation and moved worker teardown to a private process group
- **Reasoning:** The fleet action wire exposes only one error string, so a stable code plus worker/node/invocation labels preserves actionable downstream context across engine versions; signaling the worker session group closes the wrapper-descendant leak while retaining a direct-PID legacy fallback.

---

## Chapters

### 1. Work
*Agent: default*

- Preserved typed release failure correlation and moved worker teardown to a private process group: Preserved typed release failure correlation and moved worker teardown to a private process group
- Broker release now has deterministic process-group absence proof, idempotent unknown-worker success, and fail-closed roster deregistration; cloud two-arm RelayFlow is added for exact-head qualification.

---

## Artifacts

**Commits:** d41526d0f
**Files changed:** 8
