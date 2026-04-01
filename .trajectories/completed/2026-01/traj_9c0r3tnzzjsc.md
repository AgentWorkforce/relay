# Trajectory: Add agent-controlled blocking syntax

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** January 16, 2026 at 06:36 AM
> **Completed:** January 16, 2026 at 06:37 AM

---

## Summary

Designed agent-controlled blocking syntax: [await] for blocking, default for fire-and-forget. Added agent-relay-492 for parser support.

**Approach:** Standard approach

---

## Key Decisions

### Agent chooses blocking vs fire-and-forget via [await] syntax
- **Chose:** Agent chooses blocking vs fire-and-forget via [await] syntax
- **Reasoning:** Default remains fire-and-forget for backwards compatibility. Agent adds [await] or [await:30s] to opt into blocking. Receiving agent sees [awaiting] tag to know response expected. Created agent-relay-492 for parser implementation.

---

## Chapters

### 1. Work
*Agent: default*

- Agent chooses blocking vs fire-and-forget via [await] syntax: Agent chooses blocking vs fire-and-forget via [await] syntax
