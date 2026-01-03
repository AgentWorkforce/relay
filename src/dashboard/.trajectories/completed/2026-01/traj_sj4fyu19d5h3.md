# Trajectory: Integrate xterm.js for LogViewer PTY streaming

> **Status:** ✅ Completed
> **Task:** LogViewer encoding fix
> **Confidence:** 85%
> **Started:** January 3, 2026 at 03:36 PM
> **Completed:** January 3, 2026 at 03:36 PM

---

## Summary

Integrated xterm.js for LogViewer panel mode. Created XTermLogViewer component with proper terminal emulation, search addon, and dark theme matching dashboard. Build and lint pass. Ready for visual testing.

**Approach:** Standard approach

---

## Key Decisions

### Chose xterm.js over stripping ANSI at source
- **Chose:** Chose xterm.js over stripping ANSI at source
- **Reasoning:** xterm.js handles all terminal sequences natively including colors, cursor movement, line clearing. Regex-based sanitization was 30+ lines of fragile code that couldn't handle all edge cases. xterm.js is the proper solution for terminal emulation.

### Keep inline mode as plain text, only use xterm.js for panel mode
- **Chose:** Keep inline mode as plain text, only use xterm.js for panel mode
- **Reasoning:** User preference - inline mode is a compact preview where full terminal emulation adds unnecessary overhead. Panel mode is the full-featured view where proper rendering matters.

### XTermLogViewer manages its own WebSocket connection
- **Chose:** XTermLogViewer manages its own WebSocket connection
- **Reasoning:** Rather than modifying useAgentLogs hook to support raw mode callbacks, created self-contained component with its own WebSocket logic. Simpler integration, no changes to existing hook consumers.

---

## Chapters

### 1. Work
*Agent: default*

- Chose xterm.js over stripping ANSI at source: Chose xterm.js over stripping ANSI at source
- Keep inline mode as plain text, only use xterm.js for panel mode: Keep inline mode as plain text, only use xterm.js for panel mode
- XTermLogViewer manages its own WebSocket connection: XTermLogViewer manages its own WebSocket connection
