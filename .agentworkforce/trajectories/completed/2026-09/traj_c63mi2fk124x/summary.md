# Trajectory: Independent exact review of Relay PR #1665 repair at 414c1636

> **Status:** ✅ Completed
> **Confidence:** 92%
> **Started:** September 8, 2026 at 09:50 PM
> **Completed:** September 8, 2026 at 10:03 PM

---

## Summary

Repaired trusted cleanroom candidate hydration: caller-supplied manifest source/package identity is now required, structural hydration does not execute candidate CLI or broker, and the existing #1665 RelayFlow proof plus adversarial marker regressions cover the boundary.

**Approach:** Standard approach

---

## Key Decisions

### Hydrate against caller-supplied candidate identity and verify structurally only
- **Chose:** Hydrate against caller-supplied candidate identity and verify structurally only
- **Reasoning:** The workflow checkout is intentionally github.workflow_sha, so local HEAD/version cannot attest the candidate; hydration must consume the exact manifest-bound source/package identity as data and must not execute candidate binaries before Fleet qualification.

---

## Chapters

### 1. Work
*Agent: default*

- Hydrate against caller-supplied candidate identity and verify structurally only: Hydrate against caller-supplied candidate identity and verify structurally only
- Hydration now binds candidate source/package identity to the manifest-supplied inputs, not the trusted verifier checkout. Structural verification is guarded by marker-bearing candidate executables; focused tests and typecheck are green.

---

## Artifacts

**Commits:** 38065a522
**Files changed:** 3
