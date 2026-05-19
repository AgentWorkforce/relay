# Trajectory: Relax harness slug validation

> **Status:** ✅ Completed
> **Task:** PR-888
> **Confidence:** 91%
> **Started:** May 19, 2026 at 01:08 PM
> **Completed:** May 19, 2026 at 01:12 PM

---

## Summary

Relaxed orchestrator harness validation so env/header-provided values are sanitized reporting slugs rather than a closed enum, while keeping known process classifiers for automatic detection.

**Approach:** Standard approach

---

## Key Decisions

### Treat orchestrator harness as sanitized reporting slug

- **Chose:** Treat orchestrator harness as sanitized reporting slug
- **Reasoning:** Telemetry consumers only need a bounded string label; keeping a closed enum would drop newly introduced harnesses until every component was updated.

---

## Chapters

### 1. Work

_Agent: default_

- Treat orchestrator harness as sanitized reporting slug: Treat orchestrator harness as sanitized reporting slug
