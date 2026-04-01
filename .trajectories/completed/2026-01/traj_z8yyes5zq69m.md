# Trajectory: Relay-PTY architecture decisions and continuity redesign

> **Status:** ✅ Completed
> **Task:** agent-relay-504
> **Confidence:** 90%
> **Started:** January 16, 2026 at 07:19 AM
> **Completed:** January 16, 2026 at 07:20 AM

---

## Summary

Architecture decisions for relay-pty: workspace namespacing, file-based continuity replacing terminal markers, auto-fallback on exit, simple stuck detection over sidecar complexity, streamlined docs. Created 13 beads tasks (P0-P4) with dependency graph.

**Approach:** Standard approach

---

## Key Decisions

### Use workspace-namespaced paths for multi-tenant isolation
- **Chose:** Use workspace-namespaced paths for multi-tenant isolation
- **Reasoning:** Current /tmp/relay-pty-{name}.sock paths collide in multi-user/cloud environments. Using /tmp/relay/{workspaceId}/sockets/{name}.sock provides isolation per workspace.

### Remove [[SUMMARY]] and [[SESSION_END]] terminal markers
- **Chose:** Remove [[SUMMARY]] and [[SESSION_END]] terminal markers
- **Reasoning:** Terminal markers add noise, don't work in interactive mode (stdout inherited), and require agent compliance. File-based continuity is more reliable and consistent with relay messaging pattern.

### Convert continuity to file-based format (KIND: continuity)
- **Chose:** Convert continuity to file-based format (KIND: continuity)
- **Reasoning:** Consistency with relay messaging protocol. File-based format is immune to terminal corruption, works in interactive mode, and uses same outbox/trigger pattern as messages.

### Auto-generate fallback continuity on process exit
- **Chose:** Auto-generate fallback continuity on process exit
- **Reasoning:** Don't rely on agent compliance. Orchestrator always generates basic continuity (last output, exit code, duration, git diff) if agent doesn't save explicitly. Ensures continuity always exists.

### Skip Progress Tracker sidecar, use simple stuck detection in orchestrator
- **Chose:** Skip Progress Tracker sidecar, use simple stuck detection in orchestrator
- **Reasoning:** Sidecar adds complexity (another process, LLM costs, coordination). Orchestrator already has all signals needed. Simple heuristics (idle 10min, error loop, output loop) catch 90%+ of stuck cases without LLM.

### Streamline agent documentation (247→85 lines snippet, 239→102 lines protocol)
- **Chose:** Streamline agent documentation (247→85 lines snippet, 239→102 lines protocol)
- **Reasoning:** Less for agents to remember = better compliance. Removed verbose examples, duplicate info, deprecated terminal markers. Focus on essential patterns only.

---

## Chapters

### 1. Work
*Agent: default*

- Use workspace-namespaced paths for multi-tenant isolation: Use workspace-namespaced paths for multi-tenant isolation
- Remove [[SUMMARY]] and [[SESSION_END]] terminal markers: Remove [[SUMMARY]] and [[SESSION_END]] terminal markers
- Convert continuity to file-based format (KIND: continuity): Convert continuity to file-based format (KIND: continuity)
- Auto-generate fallback continuity on process exit: Auto-generate fallback continuity on process exit
- Skip Progress Tracker sidecar, use simple stuck detection in orchestrator: Skip Progress Tracker sidecar, use simple stuck detection in orchestrator
- Streamline agent documentation (247→85 lines snippet, 239→102 lines protocol): Streamline agent documentation (247→85 lines snippet, 239→102 lines protocol)
