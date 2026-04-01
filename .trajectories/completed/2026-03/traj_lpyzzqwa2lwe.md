# Trajectory: Investigate broker spawn flow for agent.spawn_requested silent drop

> **Status:** ✅ Completed
> **Confidence:** 88%
> **Started:** March 11, 2026 at 10:48 AM
> **Completed:** March 11, 2026 at 10:53 AM

---

## Summary

Fixed Relaycast broker spawn dedup so name-only agent.spawn_requested events reach workers.spawn while preserving local echo suppression for event-id keyed echoes; added regression tests

**Approach:** Standard approach

---

## Key Decisions

### Condition branch-local spawn dedup on whether top-level control dedup already used the agent-name key
- **Chose:** Condition branch-local spawn dedup on whether top-level control dedup already used the agent-name key
- **Reasoning:** Preserves local WS echo suppression for event-id keyed spawns while preventing valid name-only broker spawn requests from being discarded before workers.spawn()

---

## Chapters

### 1. Work
*Agent: default*

- Condition branch-local spawn dedup on whether top-level control dedup already used the agent-name key: Condition branch-local spawn dedup on whether top-level control dedup already used the agent-name key
