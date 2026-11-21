# Trajectory: Fix PR 1712 exact-head parser review findings

> **Status:** ✅ Completed
> **Task:** PR-1712
> **Confidence:** 93%
> **Started:** September 9, 2026 at 04:02 PM
> **Completed:** September 9, 2026 at 04:34 PM

---

## Summary

Closed PR 1712 parser review gaps with red-first regressions for nested expression scopes, Python annotated definitions and bindings, TypeScript expression/type boundaries, typed builders, and astral labels; verified Node 22 focused/full suites, builds, adversarial probes, and near-linear scaling.

**Approach:** Standard approach

---

## Key Decisions

### Preserve structural scopes while overlaying expression scopes
- **Chose:** Preserve structural scopes while overlaying expression scopes
- **Reasoning:** Reparent direct nested brace scopes beneath synthetic arrow/lambda scopes so inner method/catch bindings and enclosing expression parameters both remain visible without per-position ancestor scans.

### Replace broad Python assignment and lambda matching with statement/header-aware scans
- **Chose:** Replace broad Python assignment and lambda matching with statement/header-aware scans
- **Reasoning:** Anchored assignment targets exclude comparisons, keyword arguments, and defaults; structural colon discovery supports return annotations and colon-containing lambda defaults while retaining near-linear scans.

---

## Chapters

### 1. Work
*Agent: default*

- Preserve structural scopes while overlaying expression scopes: Preserve structural scopes while overlaying expression scopes
- Replace broad Python assignment and lambda matching with statement/header-aware scans: Replace broad Python assignment and lambda matching with statement/header-aware scans
- Red-first coverage now closes all independent review findings; Node 22 focused/full suites, build, probes, and scaling checks pass.
