# Trajectory: Fix broker session read paths and agent listing errors

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** May 19, 2026 at 02:37 PM
> **Completed:** May 19, 2026 at 02:48 PM

---

## Summary

Fixed broker read surfaces to use the project broker connection and report agent-list query failures instead of empty lists

**Approach:** Standard approach

---

## Key Decisions

### Resolved CLI read surfaces through the project broker connection file

- **Chose:** Resolved CLI read surfaces through the project broker connection file
- **Reasoning:** status already reads the project .agent-relay/connection.json; passing that path explicitly prevents AGENT_RELAY_STATE_DIR from redirecting who/agents/history/replies to a stale broker

---

## Chapters

### 1. Work

_Agent: default_

- Resolved CLI read surfaces through the project broker connection file: Resolved CLI read surfaces through the project broker connection file
