# Trajectory: Complete ledger integration - remove /tmp dependency

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** January 22, 2026 at 08:33 PM
> **Completed:** January 22, 2026 at 08:33 PM

---

## Summary

Removed /tmp/relay-outbox dependency. Agents now write to ~/.agent-relay/outbox/, with symlinks handling workspace routing transparently. Updated orchestrator, file-writer, all documentation, and tests.

**Approach:** Standard approach

---

## Key Decisions

### Agents always write to ~/.agent-relay/outbox/ - symlinks handle routing
- **Chose:** Agents always write to ~/.agent-relay/outbox/ - symlinks handle routing
- **Reasoning:** Agents don't need to know about workspace IDs. The orchestrator creates symlinks in workspace mode to route writes to the correct location.

### Phase 1 ledger was incomplete - integration was missing
- **Chose:** Phase 1 ledger was incomplete - integration was missing
- **Reasoning:** RelayWatchdog and RelayLedger were implemented but not wired into the daemon. The orchestrator still used /tmp paths. Fixed by updating RelayPtyOrchestrator to use canonical paths.

---

## Chapters

### 1. Work
*Agent: default*

- Agents always write to ~/.agent-relay/outbox/ - symlinks handle routing: Agents always write to ~/.agent-relay/outbox/ - symlinks handle routing
- Phase 1 ledger was incomplete - integration was missing: Phase 1 ledger was incomplete - integration was missing
