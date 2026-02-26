# Trajectory: Fix publish workflow version sync for devDependencies

> **Status:** ✅ Completed
> **Confidence:** 86%
> **Started:** February 10, 2026 at 12:06 PM
> **Completed:** February 10, 2026 at 12:06 PM

---

## Summary

Updated publish workflow to sync internal devDependencies alongside dependencies

**Approach:** Standard approach

---

## Key Decisions

### Sync internal devDependencies during publish version bump

- **Chose:** Sync internal devDependencies during publish version bump
- **Reasoning:** Packages like @agent-relay/mcp depend on @agent-relay/sdk as a devDependency; syncing both avoids resolving published versions during staging build

---

## Chapters

### 1. Work

_Agent: default_

- Sync internal devDependencies during publish version bump: Sync internal devDependencies during publish version bump
