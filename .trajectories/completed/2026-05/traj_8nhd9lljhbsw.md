# Trajectory: Switch owned MCP tool names to underscores

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** May 25, 2026 at 06:05 PM
> **Completed:** May 25, 2026 at 06:14 PM

---

## Summary

Renamed owned Relaycast MCP tools from dotted namespaces to action-oriented underscore names, removed dotted registrations, updated prompts/skills/bootstrap docs, and validated the CLI/MCP focused Vitest suites.

**Approach:** Standard approach

---

## Key Decisions

### Use action-oriented underscore MCP tool names only

- **Chose:** Use action-oriented underscore MCP tool names only
- **Reasoning:** The owned MCP server no longer needs to preserve @relaycast/mcp compatibility for the major release, and underscore names like add_reaction and post_message are easier for agents and MCP clients than dotted names.

---

## Chapters

### 1. Work

_Agent: default_

- Use action-oriented underscore MCP tool names only: Use action-oriented underscore MCP tool names only
