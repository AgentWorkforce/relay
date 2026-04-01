# Trajectory: Implement conditional MCP tool discoverability for long agent sessions

> **Status:** ✅ Completed
> **Confidence:** 95%
> **Started:** January 23, 2026 at 09:41 AM
> **Completed:** January 23, 2026 at 09:41 AM

---

## Summary

MCP discoverability implementation complete. Agents now see MCP tools in two places: (1) inbox hook footer reminder when checking messages, (2) spawn-time context prepend when agent starts. Both conditional on .mcp.json availability. Commit: 70c39ae on feature/daemon-spawning-dashboard-default. Files: src/hooks/check-inbox.sh, packages/bridge/src/spawner.ts.

**Approach:** Standard approach

---

## Key Decisions

### Identified MCP availability detection via .mcp.json file
- **Chose:** Identified MCP availability detection via .mcp.json file
- **Reasoning:** Created when MCP installed via 'npx @agent-relay/mcp install'. Detection is simple: fs.existsSync(path.join(projectRoot, '.mcp.json')). Reference: packages/mcp/src/install.ts isInstalledFor() function.

### Implemented conditional MCP footer in inbox hook
- **Chose:** Implemented conditional MCP footer in inbox hook
- **Reasoning:** File: src/hooks/check-inbox.sh. Shows 6 MCP tools (relay_send, relay_spawn, relay_inbox, relay_who, relay_release, relay_status) only if .mcp.json exists. Non-breaking: agents without MCP see original output.

### Implemented conditional MCP context in spawner
- **Chose:** Implemented conditional MCP context in spawner
- **Reasoning:** File: packages/bridge/src/spawner.ts. Prepends MCP tool reference to agent task description only if .mcp.json exists. Agents remember MCP tools from initial spawn context, reducing file protocol memory loss in long sessions.

### Both changes are fully backward compatible
- **Chose:** Both changes are fully backward compatible
- **Reasoning:** MCP tools only shown when MCP is configured. When .mcp.json absent, system falls back to original behavior. No breaking changes, no agent modifications needed.

---

## Chapters

### 1. Work
*Agent: default*

- Identified MCP availability detection via .mcp.json file: Identified MCP availability detection via .mcp.json file
- Implemented conditional MCP footer in inbox hook: Implemented conditional MCP footer in inbox hook
- Implemented conditional MCP context in spawner: Implemented conditional MCP context in spawner
- Both changes are fully backward compatible: Both changes are fully backward compatible
