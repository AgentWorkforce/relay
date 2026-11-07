# Trajectory: Remove unsafe spawn patch casts

> **Status:** ✅ Completed
> **Task:** PR-1003
> **Confidence:** 93%
> **Started:** May 27, 2026 at 10:17 AM
> **Completed:** May 27, 2026 at 10:23 AM

---

## Summary

Removed unsafe before-spawn patch assertions by preserving concrete spawn input types through runBeforeSpawn and applying allowed SpawnPatch fields explicitly; validated SDK check, lifecycle hook tests, formatting, diff check, and build.

**Approach:** Standard approach

---

## Key Decisions

### Typed before-spawn patch flow instead of asserting patch shape

- **Chose:** Typed before-spawn patch flow instead of asserting patch shape
- **Reasoning:** The lifecycle hook return is SDK user code, not a broker response, so the safer fix is to preserve the concrete SpawnPtyInput or SpawnCliInput generic through runBeforeSpawn and apply only the allowed SpawnPatch fields without type assertions.

---

## Chapters

### 1. Work

_Agent: default_

- Typed before-spawn patch flow instead of asserting patch shape: Typed before-spawn patch flow instead of asserting patch shape
