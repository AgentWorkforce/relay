# Trajectory: Fix stuck messages in queue - add queue monitor

> **Status:** ✅ Completed
> **Task:** messages-stuck-queue
> **Confidence:** 85%
> **Started:** January 21, 2026 at 02:21 PM
> **Completed:** January 21, 2026 at 02:22 PM

---

## Summary

Added queue monitor to RelayPtyOrchestrator that periodically checks for stuck messages (30s interval). When agent is idle and has messages in queue, it triggers processMessageQueue() to ensure messages are processed.

**Approach:** Standard approach

---

## Key Decisions

### Added periodic queue monitor (30s interval) to detect stuck messages
- **Chose:** Added periodic queue monitor (30s interval) to detect stuck messages
- **Reasoning:** Root cause: No mechanism to re-trigger processMessageQueue() when agent becomes idle with orphaned messages. Fix: Queue monitor checks every 30s if agent is idle AND has messages in queue, then triggers processing.

---

## Chapters

### 1. Work
*Agent: default*

- Added periodic queue monitor (30s interval) to detect stuck messages: Added periodic queue monitor (30s interval) to detect stuck messages
