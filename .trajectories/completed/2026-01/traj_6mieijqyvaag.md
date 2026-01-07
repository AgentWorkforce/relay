# Trajectory: Fix xterm interactive terminal for provider auth setup

> **Status:** ✅ Completed
> **Task:** xterm-display
> **Confidence:** 85%
> **Started:** January 7, 2026 at 09:27 AM
> **Completed:** January 7, 2026 at 09:28 AM

---

## Summary

Fixed xterm interactive terminal for provider auth: WebSocket proxy path, API endpoint mapping, spawner interactive mode, and updated development docs

**Approach:** Standard approach

---

## Key Decisions

### Fixed WebSocket proxy path - cloud server must connect to /ws/logs/:agentName not root path
- **Chose:** Fixed WebSocket proxy path - cloud server must connect to /ws/logs/:agentName not root path
- **Reasoning:** Dashboard server uses path-based WebSocket routing - root path triggers socket.destroy()

### API proxy uses /api/spawn and /api/spawned endpoints
- **Chose:** API proxy uses /api/spawn and /api/spawned endpoints
- **Reasoning:** Dashboard server exposes these endpoints, not /workspaces/:id/agents

### Empty task enables interactive terminal mode
- **Chose:** Empty task enables interactive terminal mode
- **Reasoning:** Spawner was prepending relay reminder even with empty task, causing auto-input. Fixed to only send messages when actual task provided

---

## Chapters

### 1. Work
*Agent: default*

- Fixed WebSocket proxy path - cloud server must connect to /ws/logs/:agentName not root path: Fixed WebSocket proxy path - cloud server must connect to /ws/logs/:agentName not root path
- API proxy uses /api/spawn and /api/spawned endpoints: API proxy uses /api/spawn and /api/spawned endpoints
- Empty task enables interactive terminal mode: Empty task enables interactive terminal mode
