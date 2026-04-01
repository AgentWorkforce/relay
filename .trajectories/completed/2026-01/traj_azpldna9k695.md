# Trajectory: Add JSONL ledger to relay-pty for crash recovery and durability

> **Status:** ❌ Abandoned
> **Task:** agent-relay-547
> **Started:** January 29, 2026 at 09:54 AM
> **Completed:** January 29, 2026 at 09:54 AM

---

## Key Decisions

### Use JSONL instead of SQLite for relay-pty ledger
- **Chose:** Use JSONL instead of SQLite for relay-pty ledger
- **Reasoning:** JSONL is simpler than SQLite, no native dependencies, append-only is sufficient for this use case, easy to debug/inspect, and matches existing JSONL patterns in the codebase

---

## Chapters

### 1. Work
*Agent: default*

- Use JSONL instead of SQLite for relay-pty ledger: Use JSONL instead of SQLite for relay-pty ledger
- Abandoned: Deferring implementation - bead agent-relay-547 created for future work
