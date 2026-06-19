# Trajectory: Architecture refactor of Relay monorepo

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** June 18, 2026 at 11:36 PM
> **Completed:** June 19, 2026 at 12:16 AM

---

## Summary

Decomposed the two largest Agent Relay CLI god files into cohesive single-responsibility modules: agent-relay-mcp.ts (2215->969 lines, 10 mcp/ modules) and broker-lifecycle.ts (1879->1320, dashboard extracted). Three pure-move refactors, each verified with tsc + full test suite (968 pass) + live MCP probe + independent autoreview. No behavior change.

**Approach:** Standard approach

---

## Key Decisions

### Decomposed agent-relay-mcp.ts god file into cohesive mcp/ modules

- **Chose:** Decomposed agent-relay-mcp.ts god file into cohesive mcp/ modules
- **Reasoning:** 2215-line file mixed 8 concerns (schema adapter, telemetry, resources, inbox, workspace, action tools); split into single-responsibility modules behind unchanged public surface. Verified pure move via dual autoreview, tsc, full test suite, and live MCP stdio probe.

### Extracted dashboard management from broker-lifecycle.ts into broker-dashboard.ts

- **Chose:** Extracted dashboard management from broker-lifecycle.ts into broker-dashboard.ts
- **Reasoning:** 1879-line broker-lifecycle mixed broker start/stop/status with ~550 lines of dashboard discovery/spawn/asset-refresh logic. Moved the self-contained dashboard cluster behind a 7-function boundary. Verified byte-identical move via structural function diff (69->69), dual checks, tsc, full suite, and direct module live test of all 7 exports.

### Extracted messaging MCP tools into mcp/messaging-tools.ts

- **Chose:** Extracted messaging MCP tools into mcp/messaging-tools.ts
- **Reasoning:** registerAgentRelayTools was a 720-line god function; split out the 20 homogeneous messaging tools (channels/messages/threads/DMs/reactions/search/inbox) which depend only on getAgentClient, plus shared zod shapes into mcp/tool-shapes.ts. Main file 2215->969 lines overall. Verified byte-identical move, all 28 tools register live, full suite 968 pass, dual reviewer APPROVE.

---

## Chapters

### 1. Work

_Agent: default_

- Decomposed agent-relay-mcp.ts god file into cohesive mcp/ modules: Decomposed agent-relay-mcp.ts god file into cohesive mcp/ modules
- Extracted dashboard management from broker-lifecycle.ts into broker-dashboard.ts: Extracted dashboard management from broker-lifecycle.ts into broker-dashboard.ts
- Extracted messaging MCP tools into mcp/messaging-tools.ts: Extracted messaging MCP tools into mcp/messaging-tools.ts

---

## Artifacts

**Commits:** afdc289, f5e538c, f7715d3
**Files changed:** 14
