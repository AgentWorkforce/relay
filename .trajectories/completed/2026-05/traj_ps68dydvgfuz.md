# Trajectory: Add SDK harness adapter abstraction

> **Status:** ✅ Completed
> **Confidence:** 86%
> **Started:** May 25, 2026 at 10:04 AM
> **Completed:** May 25, 2026 at 10:19 AM

---

## Summary

Added SDK harness runtime adapter types, clarified CLI harness adapter naming, and propagated broker spawn pid through SDK spawn results, agent handles, lifecycle hooks, and worker_ready events.

**Approach:** Standard approach

---

## Key Decisions

### Split CLI harness config from runtime harness control types

- **Chose:** Split CLI harness config from runtime harness control types
- **Reasoning:** The SDK already uses HarnessAdapter for serializable CLI command templates consumed by the Rust broker. A non-CLI harness needs a runtime contract over a serializable boundary, so this pass adds explicit runtime-facing types while preserving existing CLI registration behavior.

---

## Chapters

### 1. Work

_Agent: default_

- Split CLI harness config from runtime harness control types: Split CLI harness config from runtime harness control types
