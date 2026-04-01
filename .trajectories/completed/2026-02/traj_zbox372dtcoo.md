# Trajectory: Fix /metrics 404 in relay-dashboard integration

> **Status:** ✅ Completed
> **Confidence:** 89%
> **Started:** February 25, 2026 at 02:55 PM
> **Completed:** February 25, 2026 at 02:59 PM

---

## Summary

Patched relay-dashboard to prevent /metrics 404 by adding resilient static fallback resolution and a regression test

**Approach:** Standard approach

---

## Key Decisions

### Resolved dashboard /metrics 404 by falling back to available UI entrypoints (metrics.html -> metrics/index.html -> app.html -> index.html) instead of hard 404
- **Chose:** Resolved dashboard /metrics 404 by falling back to available UI entrypoints (metrics.html -> metrics/index.html -> app.html -> index.html) instead of hard 404
- **Reasoning:** Recent/static builds may omit metrics.html; route should remain reachable and serve SPA fallback

---

## Chapters

### 1. Work
*Agent: default*

- Resolved dashboard /metrics 404 by falling back to available UI entrypoints (metrics.html -> metrics/index.html -> app.html -> index.html) instead of hard 404: Resolved dashboard /metrics 404 by falling back to available UI entrypoints (metrics.html -> metrics/index.html -> app.html -> index.html) instead of hard 404
