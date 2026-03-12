# Trajectory: Fix multi-workspace existing-agent token rebind

> **Status:** ✅ Completed
> **Confidence:** 87%
> **Started:** March 12, 2026 at 02:44 PM
> **Completed:** March 12, 2026 at 02:45 PM

---

## Summary

Added a bundled Relaycast MCP stdio wrapper that rebinds same-name registrations with registerOrRotate after workspace switches, and auto-wired broker-spawned workers to use it via RELAYCAST_MCP_COMMAND with focused broker/core regression coverage.

**Approach:** Standard approach

---

## Key Decisions

### Use a bundled Relaycast MCP wrapper for broker-spawned workers
- **Chose:** Use a bundled Relaycast MCP wrapper for broker-spawned workers
- **Reasoning:** The published @relaycast/mcp register tool still uses plain register after set_workspace_key, so same-name re-registration does not rebind a usable agent token. The broker already honors RELAYCAST_MCP_COMMAND, so auto-pointing worker MCP configs at a local patched stdio wrapper fixes the live multi-workspace outbound path without broad prompt or routing changes.

---

## Chapters

### 1. Work
*Agent: default*

- Use a bundled Relaycast MCP wrapper for broker-spawned workers: Use a bundled Relaycast MCP wrapper for broker-spawned workers
