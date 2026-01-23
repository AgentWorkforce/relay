# Trajectory: Separation of concerns: relay protocol vs application semantics

> **Status:** ✅ Completed
> **Task:** consumer-architecture-feedback
> **Confidence:** 70%
> **Started:** January 23, 2026 at 11:53 PM
> **Completed:** January 23, 2026 at 11:53 PM

---

## Summary

Consumer feedback recorded: relay protocol should be transport-only, removing ACK/DONE workflow conventions. Applications define their own semantics. Affects spawner.ts, relay-pty-orchestrator.ts, MCP prompts. Requires design discussion before implementation.

**Approach:** Standard approach

---

## Key Decisions

### Consumer recommends removing ACK/DONE workflow conventions from relay protocol
- **Chose:** Consumer recommends removing ACK/DONE workflow conventions from relay protocol
- **Reasoning:** Relay protocol overreaches by defining ACK:/DONE: semantics. This conflicts with applications like AgentSwarm that have their own message formats (TASK_DONE, PLANNER_DONE, etc.). Transport layer should only define HOW to send (outbox + trigger), not WHAT messages mean.

---

## Chapters

### 1. Work
*Agent: default*

- Consumer recommends removing ACK/DONE workflow conventions from relay protocol: Consumer recommends removing ACK/DONE workflow conventions from relay protocol
