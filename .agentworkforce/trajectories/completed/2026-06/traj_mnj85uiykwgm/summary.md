# Trajectory: Audit and fix web/content/docs against implementation

> **Status:** ✅ Completed
> **Confidence:** 80%
> **Started:** June 19, 2026 at 04:19 AM
> **Completed:** June 19, 2026 at 04:44 AM

---

## Summary

Audited all 27 docs in web/content/docs against SDK/CLI/harness source. Fixed pervasive errors: action registration must be on an agent client (not workspace client) to reach MCP; envelope.from has no handle (use name); action-caller has no handle; corrected event union/envelope/session-event shapes; real MCP tool names; real DeliveryRunner/AgentDeliveryAdapter/HarnessCreateContext; register is idempotent-by-default; CLI reference gaps; deleted fictional reference-openclaw page

**Approach:** Standard approach

---

## Key Decisions

### Register actions on agent clients, not workspace client

- **Chose:** Register actions on agent clients, not workspace client
- **Reasoning:** Code (agent-relay.ts:256) confirms workspace-client registerAction stays in-process and is not MCP-exposed; only agent clients pass handlerAgent

---

## Chapters

### 1. Work

_Agent: default_

- Register actions on agent clients, not workspace client: Register actions on agent clients, not workspace client

---

## Artifacts

**Commits:** bbb5405, 37c6897, c168617, b87e0ba, 406449f, bc7dff1
**Files changed:** 24
