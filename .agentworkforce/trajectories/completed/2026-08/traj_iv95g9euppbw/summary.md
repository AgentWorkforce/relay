# Trajectory: Stabilize PR 1610 proof shutdown

> **Status:** ✅ Completed
> **Task:** PR-1610
> **Confidence:** 95%
> **Started:** August 26, 2026 at 02:38 AM
> **Completed:** August 26, 2026 at 02:39 AM

---

## Summary

Removed the reconnect observation race from the application-ack RelayFlow harness.

**Approach:** Kept the first socket responsive until closure, accepted the second connection deterministically, then aborted the client only for harness cleanup.

---

## Key Decisions

### Keep the reconnected loopback WebSocket alive until the harness captures the reconnect
- **Chose:** Keep the reconnected loopback WebSocket alive until the harness captures the reconnect
- **Reasoning:** The harness only needs to deterministically observe a second public node-control connection; aborting the client afterward avoids an irrelevant shutdown race.

---

## Chapters

### 1. Work
*Agent: default*

- Keep the reconnected loopback WebSocket alive until the harness captures the reconnect: Keep the reconnected loopback WebSocket alive until the harness captures the reconnect

---

## Artifacts

**Commits:** 8e46228de
**Files changed:** 2
