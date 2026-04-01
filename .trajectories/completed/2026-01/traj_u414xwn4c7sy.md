# Trajectory: Enhance MCP tools footer with decision guidance and daemon verification

> **Status:** ✅ Completed
> **Confidence:** 95%
> **Started:** January 23, 2026 at 09:47 AM
> **Completed:** January 23, 2026 at 09:47 AM

---

## Summary

MCP footer enhanced with dual verification (socket + config) and decision guidance. Commit: 18bab59. Prevents false positives when daemon not running. Footer now clearly positions MCP as primary API with fallback guidance. Quick reference format with arrows for scannability.

**Approach:** Standard approach

---

## Key Decisions

### Realized .mcp.json check alone insufficient - daemon may not be running
- **Chose:** Realized .mcp.json check alone insufficient - daemon may not be running
- **Reasoning:** Footer showed MCP tools even when daemon was down, leading to failed tool calls. Added socket accessibility check with [ -S $RELAY_SOCKET ] to verify daemon is actually accessible.

### Dual verification: .mcp.json AND socket accessible
- **Chose:** Dual verification: .mcp.json AND socket accessible
- **Reasoning:** Both conditions required: (1) MCP installed [ -f .mcp.json ] AND (2) Daemon socket exists [ -S /tmp/agent-relay.sock ]. Env var RELAY_SOCKET respected. False positives eliminated.

### Added decision guidance with 'When in doubt' rule
- **Chose:** Added decision guidance with 'When in doubt' rule
- **Reasoning:** Footer now includes Quick Reference with arrow indicators and clear statement: prefer MCP over file protocol. Fallback guidance for when daemon unavailable. Matches the principle that MCP is primary API.

---

## Chapters

### 1. Work
*Agent: default*

- Realized .mcp.json check alone insufficient - daemon may not be running: Realized .mcp.json check alone insufficient - daemon may not be running
- Dual verification: .mcp.json AND socket accessible: Dual verification: .mcp.json AND socket accessible
- Added decision guidance with 'When in doubt' rule: Added decision guidance with 'When in doubt' rule
