# Trajectory: Fix thinking indicator showing on all messages

> **Status:** ❌ Abandoned
> **Task:** agent-relay-406
> **Started:** January 2, 2026 at 11:19 AM
> **Completed:** January 2, 2026 at 11:22 AM

---

## Key Decisions

### Track latest message per recipient in a Map and only pass processingState for that message
- **Chose:** Track latest message per recipient in a Map and only pass processingState for that message
- **Reasoning:** The bug was that thinking indicator showed on ALL messages from user to a processing agent. Fix tracks the latest message ID per recipient and only shows indicator on that one.

---

## Chapters

### 1. Work
*Agent: default*

- Track latest message per recipient in a Map and only pass processingState for that message: Track latest message per recipient in a Map and only pass processingState for that message
- Abandoned: Switching to new task: optimistic delivery
