# Trajectory: Confirm and remove unused package dependencies

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** May 22, 2026 at 12:01 PM
> **Completed:** May 22, 2026 at 12:12 PM

---

## Summary

Confirmed root dependency removals with literal and import-like scans, pruned unused root dependencies and dev dependencies, added missing @agent-relay/memory root dependency, regenerated package-lock, and validated with typecheck, pack validation, import smoke, and npm test.

**Approach:** Standard approach

---

## Key Decisions

### Removed only root dependencies with no root import surface

- **Chose:** Removed only root dependencies with no root import surface
- **Reasoning:** Literal and import-like scans showed removed packages either had no imports or were imported only by workspace packages that declare them. Kept agent-trajectories because root postinstall patches it, and kept Relaycast/Relayfile packages with root CLI imports. Added @agent-relay/memory because the public root export re-exports it.

---

## Chapters

### 1. Work

_Agent: default_

- Removed only root dependencies with no root import surface: Removed only root dependencies with no root import surface
