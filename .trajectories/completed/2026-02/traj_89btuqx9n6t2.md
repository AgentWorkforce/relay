# Trajectory: Add agent interrupt endpoint

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** February 24, 2026 at 10:36 PM
> **Completed:** February 24, 2026 at 10:43 PM

---

## Summary

Added /api/agents/by-name/{name}/interrupt stub (501) to broker listen API and covered it with a unit test.

**Approach:** Standard approach

---

## Key Decisions

### Reintroduced /api/agents/by-name/{name}/interrupt as a 501 stub

- **Chose:** Reintroduced /api/agents/by-name/{name}/interrupt as a 501 stub
- **Reasoning:** Some dashboards expect this endpoint for agent view ESC/interrupt behavior, but the broker HTTP API doesn't implement interrupts yet.

---

## Chapters

### 1. Work

_Agent: default_

- Reintroduced /api/agents/by-name/{name}/interrupt as a 501 stub: Reintroduced /api/agents/by-name/{name}/interrupt as a 501 stub
