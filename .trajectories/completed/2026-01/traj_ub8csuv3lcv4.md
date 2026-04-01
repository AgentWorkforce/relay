# Trajectory: Fix WebSocket disconnections for workspace instances

> **Status:** ✅ Completed
> **Task:** workspace-websocket-stability
> **Confidence:** 90%
> **Started:** January 6, 2026 at 06:13 PM
> **Completed:** January 6, 2026 at 06:16 PM

---

## Summary

Added ping/pong keepalive to main and bridge WebSockets to fix connection instability

**Approach:** Standard approach

---

## Key Decisions

### Add ping/pong keepalive to main and bridge WebSockets
- **Chose:** Add ping/pong keepalive to main and bridge WebSockets
- **Reasoning:** Main dashboard and bridge WebSocket endpoints were missing ping/pong keepalive, while logs and presence endpoints had it. Without keepalive, TCP/proxy timeouts kill idle connections (typically 60-120s).

---

## Chapters

### 1. Work
*Agent: default*

- Add ping/pong keepalive to main and bridge WebSockets: Add ping/pong keepalive to main and bridge WebSockets
