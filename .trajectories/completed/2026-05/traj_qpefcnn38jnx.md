# Trajectory: Document harness lifecycle

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** May 25, 2026 at 09:32 AM
> **Completed:** May 25, 2026 at 09:36 AM

---

## Summary

Added harness lifecycle documentation to the Harnesses docs page, covering SDK selection, broker adapter resolution, executable lookup, built-in adapter preparation, argv rendering, runtime events, and how SDK hooks differ from broker lifecycle adapters.

**Approach:** Standard approach

---

## Key Decisions

### Documented harness lifecycle as broker-owned adapter preparation

- **Chose:** Documented harness lifecycle as broker-owned adapter preparation
- **Reasoning:** The shipped behavior keeps executable config serializable in SDKs while CLI-specific MCP/session setup runs in Rust broker adapters; docs need to clarify where hooks and custom harness definitions fit.

---

## Chapters

### 1. Work

_Agent: default_

- Documented harness lifecycle as broker-owned adapter preparation: Documented harness lifecycle as broker-owned adapter preparation
