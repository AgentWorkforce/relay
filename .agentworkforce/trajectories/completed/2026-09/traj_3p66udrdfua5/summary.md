# Trajectory: Bootstrap default-branch Relay qualification workflow dispatch

> **Status:** ✅ Completed
> **Task:** relay#1665-fleet-qualification
> **Confidence:** 95%
> **Started:** September 6, 2026 at 07:06 AM
> **Completed:** September 6, 2026 at 07:06 AM

---

## Summary

Added fail-closed default-branch workflow_dispatch bootstraps for Relay package and cleanroom qualification, plus exact trigger/input/no-evidence contract tests.

**Approach:** Standard approach

---

## Key Decisions

### Land inert default-branch dispatch definitions instead of the full candidate verifier
- **Chose:** Land inert default-branch dispatch definitions instead of the full candidate verifier
- **Reasoning:** GitHub requires workflow_dispatch files on default, but #1665 must remain unmerged until live qualification. Manual-only stubs with zero permissions and fail-closed jobs expose the exact input contract without importing product code or producing qualification evidence.

---

## Chapters

### 1. Work
*Agent: default*

- Land inert default-branch dispatch definitions instead of the full candidate verifier: Land inert default-branch dispatch definitions instead of the full candidate verifier
- The three-file bootstrap closes only the GitHub discovery gap; the live denominator remains 0/376 until immutable cross-repo producers exist and two candidate dispatches pass.
