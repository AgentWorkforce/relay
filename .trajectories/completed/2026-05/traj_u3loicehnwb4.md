# Trajectory: Gate broker diagnostic logs behind env flag

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** May 21, 2026 at 12:14 AM
> **Completed:** May 21, 2026 at 12:14 AM

---

## Summary

Made broker tracing quiet by default with AGENT_RELAY_BROKER_LOG or RUST_LOG opt-in and corrected PTY tracing targets.

**Approach:** Standard approach

---

## Key Decisions

### Default broker tracing filter to off

- **Chose:** Default broker tracing filter to off
- **Reasoning:** PTY worker stderr is parsed as stream fallback output when it is not JSON, so warn-level tracing must not be emitted unless explicitly requested.

---

## Chapters

### 1. Work

_Agent: default_

- Default broker tracing filter to off: Default broker tracing filter to off
