# Trajectory: Fix spawn timing race condition

> **Status:** ✅ Completed
> **Confidence:** 78%
> **Started:** January 21, 2026 at 10:10 PM
> **Completed:** January 21, 2026 at 10:30 PM

---

## Summary

Hardened spawn registration checks against registry timing gaps and added freshness tests

**Approach:** Standard approach

---

## Key Decisions

### Synced spawn registration by requiring both connected-agents.json and agents.json freshness before sending spawn tasks
- **Chose:** Synced spawn registration by requiring both connected-agents.json and agents.json freshness before sending spawn tasks
- **Reasoning:** Avoids mismatched online checks and prevents sending before registry is ready

### Pass spawning callbacks to orchestrator and CLI spawners to keep router queueing aligned
- **Chose:** Pass spawning callbacks to orchestrator and CLI spawners to keep router queueing aligned
- **Reasoning:** Ensures messages to spawning agents are queued consistently across entrypoints

---

## Chapters

### 1. Work
*Agent: default*

- Synced spawn registration by requiring both connected-agents.json and agents.json freshness before sending spawn tasks: Synced spawn registration by requiring both connected-agents.json and agents.json freshness before sending spawn tasks
- Pass spawning callbacks to orchestrator and CLI spawners to keep router queueing aligned: Pass spawning callbacks to orchestrator and CLI spawners to keep router queueing aligned
