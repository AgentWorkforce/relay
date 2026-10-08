# Trajectory: Add pretty fleet node listing command

> **Status:** ✅ Completed
> **Confidence:** 95%
> **Started:** September 19, 2026 at 05:05 PM
> **Completed:** September 19, 2026 at 05:11 PM

---

## Summary

Added agent-relay fleet nodes list --pretty and the shorter fleet nodes --pretty form, with live node metadata and correct unlimited-capacity rendering; verified unit tests, typecheck, lint, build, and live fleet output.

**Approach:** Standard approach

---

## Key Decisions

### Display maxAgents zero as unlimited in the pretty fleet table
- **Chose:** Display maxAgents zero as unlimited in the pretty fleet table
- **Reasoning:** The broker protocol defines zero as unbounded capacity; rendering 0/0 would falsely imply the node cannot spawn.

---

## Chapters

### 1. Work
*Agent: default*

- Display maxAgents zero as unlimited in the pretty fleet table: Display maxAgents zero as unlimited in the pretty fleet table
