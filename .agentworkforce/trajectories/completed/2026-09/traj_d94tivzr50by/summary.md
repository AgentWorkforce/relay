# Trajectory: Phase 0 seam: route phase-0 TS proof files in the feature manifest

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** September 20, 2026 at 09:39 AM
> **Completed:** September 20, 2026 at 09:39 AM

---

## Summary

Manifest now routes every changed phase-0 runtime path; targeted-gate green with unmapped=0 (full-smoke remains, from the manifest self-check, which the gate expects). Verified by mutation: removing the two paths reproduces the original GATE_FAILED.

**Approach:** Standard approach

---

## Key Decisions

### Routed tests/fixtures/delivery-contract-evals.test.ts and tests/fixtures/targeted-feature-verification.test.ts onto the existing delivery-backend-seam location list
- **Chose:** Routed tests/fixtures/delivery-contract-evals.test.ts and tests/fixtures/targeted-feature-verification.test.ts onto the existing delivery-backend-seam location list
- **Reasoning:** The selector fails closed on unmapped runtime paths; both files are this phase's TypeScript-side proof of the seam (contract evals, and the assertions guarding the seam's own manifest row). The semantically tighter fix - adding the selector's unit-test fixture to SELF_CHECK_PATHS in scripts/verify-features/targeted-pr-plan.mjs - is outside the phase contract's edit scope and would fail edit-gate. No feature row was added or deleted.

---

## Chapters

### 1. Work
*Agent: default*

- Routed tests/fixtures/delivery-contract-evals.test.ts and tests/fixtures/targeted-feature-verification.test.ts onto the existing delivery-backend-seam location list: Routed tests/fixtures/delivery-contract-evals.test.ts and tests/fixtures/targeted-feature-verification.test.ts onto the existing delivery-backend-seam location list
