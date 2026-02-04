# Trajectory: MCP/SDK Consolidation and Bug Fixes

> **Status:** ✅ Completed
> **Confidence:** 95%
> **Started:** February 4, 2026 at 10:41 AM
> **Completed:** February 4, 2026 at 10:43 AM

---

## Summary

Consolidated MCP to use SDK RelayClient via adapter pattern, eliminating duplicate client code and fixing silent failures. Fixed two additional bugs: teams.json log spam (added mtime-based caching) and release agent error for non-spawned agents (added fallback to force-disconnect). All work validated by multi-agent team (Coordinator, Developer, ReviewerA, ReviewerGemini, Documenter) with 2 independent approvals.

**Approach:** 1) Spawned multi-CLI team via agent-relay to implement changes. 2) Developer (Codex) created client-adapter.ts wrapping SDK RelayClient. 3) Updated all 17 MCP tool files to use adapter. 4) Deleted obsolete client.ts. 5) Added reason param to SDK release(). 6) Two independent reviews approved changes. 7) Investigated and fixed log spam by adding caching to loadTeamsConfig(). 8) Fixed release agent error by adding onReleaseFallback callback to SpawnManager.

---

## Key Decisions

### Create client-adapter.ts to wrap SDK RelayClient for MCP tools
- **Chose:** Create client-adapter.ts to wrap SDK RelayClient for MCP tools
- **Rejected:** Keep separate client implementations, Merge MCP client into SDK directly
- **Reasoning:** MCP had duplicate client code in client.ts. By creating an adapter that wraps the SDK RelayClient, we eliminate code duplication and ensure MCP uses socket-based operations instead of file-based operations that only work with relay-pty.

### Delete packages/mcp/src/client.ts after creating adapter
- **Chose:** Delete packages/mcp/src/client.ts after creating adapter
- **Rejected:** Keep both files, Rename old file as legacy
- **Reasoning:** The old client.ts had file-based operations that only worked with relay-pty wrapper. After creating client-adapter.ts that uses SDK's socket-based RelayClient, the old file became obsolete and was removed to prevent confusion.

### Add optional reason parameter to SDK release() method
- **Chose:** Add optional reason parameter to SDK release() method
- **Rejected:** Keep reason in a separate field, Pass reason via options object
- **Reasoning:** The release() method needed to support an optional reason parameter for better logging and telemetry tracking of why agents are being released.

### Add mtime-based caching to loadTeamsConfig() in @agent-relay/config
- **Chose:** Add mtime-based caching to loadTeamsConfig() in @agent-relay/config
- **Rejected:** Remove the console.log entirely, Add a flag to suppress logging, Use file watcher instead of polling
- **Reasoning:** Dashboard server was calling loadTeamsConfig every second via broadcastData(), causing log spam with 'Loaded team...' messages. By caching based on file modification time (mtime), we only reload and log when the file actually changes, eliminating the log spam while still picking up config changes.

### Add onReleaseFallback callback to SpawnManager for releasing non-spawned agents
- **Chose:** Add onReleaseFallback callback to SpawnManager for releasing non-spawned agents
- **Rejected:** Store all agents in activeWorkers on connect, Send termination message to agent, Only support releasing spawned agents
- **Reasoning:** The spawner.release() only works for agents in activeWorkers map. Agents auto-spawned via teams.json before daemon restart or connected independently would fail to release with 'Agent not found'. By adding a fallback that calls router.forceRemoveAgent(), we can release any connected agent regardless of how it was spawned.

### Use multi-CLI team (Claude Coordinator, Codex Developer, Claude+Gemini Reviewers, Claude Documenter) for MCP/SDK consolidation
- **Chose:** Use multi-CLI team (Claude Coordinator, Codex Developer, Claude+Gemini Reviewers, Claude Documenter) for MCP/SDK consolidation
- **Rejected:** Single agent implementation, All Claude team, Manual spawning without teams.json
- **Reasoning:** Leveraged different CLI strengths: Claude for coordination and documentation, Codex for implementation, mixed Claude/Gemini for diverse code review perspectives. This demonstrated the teams.json auto-spawn capability and validated multi-agent workflows.

### Identified and documented MCP hybrid-client bug where spawn/send/release silently failed
- **Chose:** Identified and documented MCP hybrid-client bug where spawn/send/release silently failed
- **Rejected:** Keep file-based operations and require relay-pty, Add error detection to file-based operations
- **Reasoning:** MCP tools returned success but operations failed because hybrid-client.ts used file-based operations that only work with relay-pty wrapper, not the daemon. Root cause was discovered during team spawning when agents appeared spawned but weren't actually running. Fix was the client-adapter.ts using socket-based SDK operations.

---

## Chapters

### 1. Initial work
*Agent: Dashboard*

- Create client-adapter.ts to wrap SDK RelayClient for MCP tools: Create client-adapter.ts to wrap SDK RelayClient for MCP tools
- Delete packages/mcp/src/client.ts after creating adapter: Delete packages/mcp/src/client.ts after creating adapter
- Add optional reason parameter to SDK release() method: Add optional reason parameter to SDK release() method
- Add mtime-based caching to loadTeamsConfig() in @agent-relay/config: Add mtime-based caching to loadTeamsConfig() in @agent-relay/config
- Add onReleaseFallback callback to SpawnManager for releasing non-spawned agents: Add onReleaseFallback callback to SpawnManager for releasing non-spawned agents
- Use multi-CLI team (Claude Coordinator, Codex Developer, Claude+Gemini Reviewers, Claude Documenter) for MCP/SDK consolidation: Use multi-CLI team (Claude Coordinator, Codex Developer, Claude+Gemini Reviewers, Claude Documenter) for MCP/SDK consolidation
- Identified and documented MCP hybrid-client bug where spawn/send/release silently failed: Identified and documented MCP hybrid-client bug where spawn/send/release silently failed
