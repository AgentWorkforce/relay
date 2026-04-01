# Trajectory: Fix continuity parser to handle markdown content

> **Status:** ✅ Completed
> **Task:** relay-continuity-parser
> **Confidence:** 95%
> **Started:** January 3, 2026 at 04:03 PM
> **Completed:** January 3, 2026 at 04:09 PM

---

## Summary

Fixed XTermLogViewer scrollback by increasing WebSocket initial history from 200 to 5000 lines in server.ts:1632

**Approach:** Standard approach

---

## Key Decisions

### Increased WebSocket log history from 200 to 5000 lines
- **Chose:** Increased WebSocket log history from 200 to 5000 lines
- **Reasoning:** Root cause: server.ts line 1632 only sent 200 lines on WebSocket connect. xterm scrollback (10000) and pty buffer (10000) were fine. Fixed by increasing getWorkerOutput limit to 5000 (half of max buffer).

---

## Chapters

### 1. Work
*Agent: default*

- Increased WebSocket log history from 200 to 5000 lines: Increased WebSocket log history from 200 to 5000 lines
