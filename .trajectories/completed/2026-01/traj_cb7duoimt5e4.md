# Trajectory: OpenCode integration completeness investigation

> **Status:** ✅ Completed
> **Confidence:** 85%
> **Started:** January 28, 2026 at 03:25 PM
> **Completed:** January 28, 2026 at 03:26 PM

---

## Summary

Completed comprehensive OpenCode integration investigation. Found: wrapper implementation complete but not integrated into spawner, MCP install complete, no tests, no OpenAPI spec for OpenCode HTTP API, docs incomplete.

**Approach:** Standard approach

---

## Key Decisions

### Found OpenCode wrapper implementation is complete but not integrated into spawner
- **Chose:** Found OpenCode wrapper implementation is complete but not integrated into spawner
- **Reasoning:** OpenCodeWrapper and OpenCodeApi classes are fully implemented with HTTP API mode, PTY fallback, and SSE events. However, the spawner (packages/bridge/src/spawner.ts) lacks OpenCode-specific handling that exists for other CLIs (Claude, Codex, Gemini, Cursor).

### OpenCode MCP install support is complete
- **Chose:** OpenCode MCP install support is complete
- **Reasoning:** MCP install system (packages/mcp/src/install.ts) has full OpenCode support including: correct config path (~/.config/opencode/opencode.json), correct config key ('mcp'), OpenCode-specific format with 'type: local' and 'command' array.

### OpenAPI spec generation exists but is incomplete
- **Chose:** OpenAPI spec generation exists but is incomplete
- **Reasoning:** generate-openapi.ts script exists in packages/api-types but: 1) No generated openapi.json file found in repo, 2) Script generates Agent Relay API schemas, NOT OpenCode HTTP API endpoints, 3) OpenCode HTTP API endpoints (/tui/*, /session/*, /event) are not documented in any OpenAPI spec.

### No dedicated tests for OpenCode wrapper
- **Chose:** No dedicated tests for OpenCode wrapper
- **Reasoning:** Searched for opencode*.test.ts - none found. Only mention of opencode in tests is in packages/cli-tester/tests/credential-check.test.ts for auth detection.

---

## Chapters

### 1. Work
*Agent: default*

- Found OpenCode wrapper implementation is complete but not integrated into spawner: Found OpenCode wrapper implementation is complete but not integrated into spawner
- OpenCode MCP install support is complete: OpenCode MCP install support is complete
- OpenAPI spec generation exists but is incomplete: OpenAPI spec generation exists but is incomplete
- No dedicated tests for OpenCode wrapper: No dedicated tests for OpenCode wrapper
