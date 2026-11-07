# Trajectory: Remove personas from @agent-relay/sdk

> **Status:** ✅ Completed
> **Task:** GH-997
> **Confidence:** 86%
> **Started:** May 27, 2026 at 05:22 AM
> **Completed:** May 27, 2026 at 05:33 AM

---

## Summary

Removed SDK persona loading, spawn, dry-run, exports, dependency, tests, and example; updated migration notes and ensured SDK builds remove stale persona dist outputs before packing.

**Approach:** Standard approach

---

## Key Decisions

### Removed SDK-owned persona APIs instead of relocating them in this repo

- **Chose:** Removed SDK-owned persona APIs instead of relocating them in this repo
- **Reasoning:** Issue 997 asks for @agent-relay/sdk to know nothing about personas; there is already a separate packages/personas pack, while persona execution side effects should be owned by AgentWorkforce CLI or a workforce package.

### Removed stale persona dist artifacts during SDK builds

- **Chose:** Removed stale persona dist artifacts during SDK builds
- **Reasoning:** Deleting the source and package export is not enough if an existing dist/personas.js survives a package-level build; the SDK build now deletes the persona outputs before compiling so npm pack cannot include them.

---

## Chapters

### 1. Work

_Agent: default_

- Removed SDK-owned persona APIs instead of relocating them in this repo: Removed SDK-owned persona APIs instead of relocating them in this repo
- Removed stale persona dist artifacts during SDK builds: Removed stale persona dist artifacts during SDK builds

---

## Artifacts

**Commits:** 6a456b7f
