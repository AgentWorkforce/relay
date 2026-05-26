# Trajectory: Fix issue 924

> **Status:** ✅ Completed
> **Task:** #924
> **Confidence:** 88%
> **Started:** May 20, 2026 at 01:35 AM
> **Completed:** May 20, 2026 at 01:47 AM

---

## Summary

Added authenticated PTY input websocket stream and TypeScript SDK openInputStream helper with ordered acks, bounded buffering, docs, and tests.

**Approach:** Standard approach

---

## Key Decisions

### Use dedicated PTY input websocket

- **Chose:** Use dedicated PTY input websocket
- **Reasoning:** A separate /api/input/{name}/stream path isolates low-latency input from dashboard event replay, can reuse broker API-key auth, and lets the server preserve per-agent ordering by processing one frame at a time.

---

## Chapters

### 1. Work

_Agent: default_

- Use dedicated PTY input websocket: Use dedicated PTY input websocket
