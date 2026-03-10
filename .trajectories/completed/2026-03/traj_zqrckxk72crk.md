# Trajectory: Restructure Next routes to /openclaw and /openclaw/invite/[token], root 404

> **Status:** ✅ Completed
> **Confidence:** 99%
> **Started:** March 4, 2026 at 03:19 PM
> **Completed:** March 4, 2026 at 03:19 PM

---

## Summary

Updated Next route structure to /openclaw and /openclaw/invite/[token], root page now 404, and SST Nextjs router mounted at '/' to avoid double-prefixing.

**Approach:** Standard approach

---

## Key Decisions

### Move content routes under app/openclaw and set app root to notFound

- **Chose:** Move content routes under app/openclaw and set app root to notFound
- **Reasoning:** Makes Next route map explicit and guarantees domain root returns 404 while preserving required OpenClaw paths

---

## Chapters

### 1. Work

_Agent: default_

- Move content routes under app/openclaw and set app root to notFound: Move content routes under app/openclaw and set app root to notFound
