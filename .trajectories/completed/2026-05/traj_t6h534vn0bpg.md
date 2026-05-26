# Trajectory: Resolve PR merge conflicts

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** May 26, 2026 at 06:11 AM
> **Completed:** May 26, 2026 at 06:21 AM

---

## Summary

Resolved origin/main merge conflicts for PR 977, preserved the owned agent-relay MCP server, kept @relaycast/mcp out of package metadata, aligned MCP hints/tests with underscore tool names, and validated with focused Vitest, SDK workflow test, Rust injection tests, repo typecheck, and CLI package build.

**Approach:** Standard approach

---

## Key Decisions

### Resolved main merge by keeping the monorepo package move while preserving owned Agent Relay MCP behavior
- **Chose:** Resolved main merge by keeping the monorepo package move while preserving owned Agent Relay MCP behavior
- **Reasoning:** Root package metadata now stays monorepo-only, CLI package owns the agent-relay mcp export and @relaycast/sdk dependency, @relaycast/mcp remains removed, and runtime/test hints use underscore MCP names.

---

## Chapters

### 1. Work
*Agent: default*

- Resolved main merge by keeping the monorepo package move while preserving owned Agent Relay MCP behavior: Resolved main merge by keeping the monorepo package move while preserving owned Agent Relay MCP behavior
