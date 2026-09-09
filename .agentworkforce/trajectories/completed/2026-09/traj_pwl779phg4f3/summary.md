# Trajectory: Pin @vitejs/devtools-vitest's vitest peer so fresh installs survive vitest 5

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** September 3, 2026 at 02:45 PM
> **Completed:** September 3, 2026 at 02:45 PM

---

## Summary

Nested npm override pins @vitejs/devtools-vitest's wildcard vitest peer to the workspace range; verified fresh install with npm 10.9.2 against main's manifests

**Approach:** Standard approach

---

## Key Decisions

### Nested override on @vitejs/devtools-vitest rather than a root vitest override
- **Chose:** Nested override on @vitejs/devtools-vitest rather than a root vitest override
- **Reasoning:** Only the wildcard peer edge is rewritten; the root range and every workspace range stay untouched, and npm 10.9's $vitest reference resolution fails on peer edges so the range is literal

---

## Chapters

### 1. Work
*Agent: default*

- Nested override on @vitejs/devtools-vitest rather than a root vitest override: Nested override on @vitejs/devtools-vitest rather than a root vitest override

---

## Artifacts

**Commits:** 8334fbf
**Files changed:** 1
