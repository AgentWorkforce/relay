# Trajectory: Remove unused user-directory package

> **Status:** ✅ Completed
> **Confidence:** 93%
> **Started:** May 22, 2026 at 12:27 PM
> **Completed:** May 22, 2026 at 12:36 PM

---

## Summary

Removed the unused @agent-relay/user-directory workspace package, its root dependency/build script, TypeScript path aliases, Vitest workspace alias, and stale lockfile entries. Confirmed no remaining imports or symbol references; current SSH auth already owns the active /data/users/{userId} HOME behavior while credential paths live in @agent-relay/config.

**Approach:** Standard approach

---

## Key Decisions

### Remove user-directory as orphaned package

- **Chose:** Remove user-directory as orphaned package
- **Reasoning:** Exhaustive search found no imports outside the package itself; current SSH auth duplicates the only active behavior by creating /data/users/{userId} and setting HOME directly, while provider credential paths now live in @agent-relay/config and have drifted from user-directory's stale mappings.

---

## Chapters

### 1. Work

_Agent: default_

- Remove user-directory as orphaned package: Remove user-directory as orphaned package
