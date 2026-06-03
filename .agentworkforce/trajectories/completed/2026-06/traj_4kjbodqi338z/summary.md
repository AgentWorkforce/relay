# Trajectory: Review and repair PR 1032

> **Status:** ✅ Completed
> **Confidence:** 86%
> **Started:** June 3, 2026 at 09:34 AM
> **Completed:** June 3, 2026 at 09:38 AM

---

## Summary

Reviewed PR 1032 docs default-version changes. Removed stale Next bare-doc redirects that intercepted new v8 docs routes, taught docs version helpers to parse old /docs/8.0.0 URLs, and added focused unit tests for v8, legacy archive, and transitional paths. Web unit tests and web TypeScript pass; Next production build was attempted twice and killed by the host with exit 137 during optimized build.

**Approach:** Standard approach

---

## Key Decisions

### Removed stale bare docs redirect table
- **Chose:** Removed stale bare docs redirect table
- **Reasoning:** Next redirects run before app routes and were redirecting new v8 bare docs pages such as /docs/cli-messaging to replacement pages, defeating the PR's v8 default routes and updated links.

---

## Chapters

### 1. Work
*Agent: default*

- Removed stale bare docs redirect table: Removed stale bare docs redirect table
