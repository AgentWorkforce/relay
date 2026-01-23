# Trajectory: Add includeWorkflowConventions opt-in flag for ACK/DONE

> **Status:** ✅ Completed
> **Task:** separation-of-concerns
> **Confidence:** 90%
> **Started:** January 23, 2026 at 11:56 PM
> **Completed:** January 24, 2026 at 12:00 AM

---

## Summary

Implemented separation of concerns: relay protocol is now transport-only by default. Added includeWorkflowConventions flag for applications that want ACK/DONE. Cloud opts in, SDK consumers get clean protocol.

**Approach:** Standard approach

---

## Key Decisions

### Default to transport-only, cloud opts in
- **Chose:** Default to transport-only, cloud opts in
- **Reasoning:** Added includeWorkflowConventions flag (default: false) to SpawnRequest. Relay protocol now only includes transport mechanics by default. Cloud dashboard passes includeWorkflowConventions: true to maintain current behavior. SDK consumers get clean transport-only protocol.

### Updated 7 files across packages
- **Chose:** Updated 7 files across packages
- **Reasoning:** Changes span: types.ts (SpawnRequest), spawner.ts (getRelayInstructions), spawn-manager.ts (pass-through), protocol/types.ts (SpawnPayload), dashboard/server.ts, dashboard-server/server.ts (opt-in), relay-pty-orchestrator.ts (reminder), mcp/prompts/protocol.ts (docs)

---

## Chapters

### 1. Work
*Agent: default*

- Default to transport-only, cloud opts in: Default to transport-only, cloud opts in
- Updated 7 files across packages: Updated 7 files across packages
