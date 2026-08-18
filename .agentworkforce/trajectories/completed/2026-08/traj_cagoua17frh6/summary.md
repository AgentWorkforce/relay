# Trajectory: Fix intermittent node attach reachability and reconnect failures

> **Status:** ✅ Completed
> **Task:** relay#1571
> **Confidence:** 90%
> **Started:** August 18, 2026 at 04:41 PM
> **Completed:** August 18, 2026 at 05:15 PM

---

## Summary

Reproduced relay#1571's intermittent fleet-node attach failure, traced the initial 503 to Cloud's heartbeat liveness gate and established-session 1011 to CLI reconnect exhaustion, added bounded safe retries and endpoint diagnostics, hardened reconnect recovery, and verified targeted, typecheck, build, lint, and baseline suite behavior.

**Approach:** Standard approach

---

## Key Decisions

### Treat the two symptoms as one transport-resilience fix but not one immediate code-path root cause
- **Chose:** Treat the two symptoms as one transport-resilience fix but not one immediate code-path root cause
- **Reasoning:** Initial attach fails on the cloud terminal-session POST's D1 45s liveness classification; established-session 1011 is emitted by the local loopback proxy after its resume WebSocket budget is exhausted. Both are transient terminal-access interruptions, so reuse the existing bounded retry helper for session creation and align the proxy's bounded resume window with the node terminal lane's 30s reconnect backoff, while preserving distinct diagnostics.

---

## Chapters

### 1. Work
*Agent: default*

- Treat the two symptoms as one transport-resilience fix but not one immediate code-path root cause: Treat the two symptoms as one transport-resilience fix but not one immediate code-path root cause
- Reproduced the live flake twice in 20 pre-fix attaches; the scoped retry/diagnostic fix is implemented and 20/20 post-fix live attaches stayed connected. Targeted tests and typecheck pass. The full suite has one origin-main-confirmed unrelated Reflex log-format expectation failure.
