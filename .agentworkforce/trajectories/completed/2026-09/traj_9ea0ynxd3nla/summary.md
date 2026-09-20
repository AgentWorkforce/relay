# Trajectory: Native-delivery phase 0: TypeScript lane (feature manifest + delivery-contract regression coverage)

> **Status:** ✅ Completed
> **Confidence:** 85%
> **Started:** September 20, 2026 at 09:32 AM
> **Completed:** September 20, 2026 at 09:33 AM

---

## Summary

Registered delivery-backend-seam in the feature manifest routing all five phase-0 Rust paths, and added 13 tests: the four doc-named delivery-contract suites now execute in npm test, plus 5 seam-rule regression cases and 2 manifest-routing assertions. Every assertion mutation-proven. Reported two campaign-level gate defects rather than working around them.

**Approach:** Standard approach

---

## Key Decisions

### Registered delivery-backend-seam routing five phase-0 Rust paths, not just crates/broker/src/delivery/
- **Chose:** Registered delivery-backend-seam routing five phase-0 Rust paths, not just crates/broker/src/delivery/
- **Reasoning:** The contract names delivery/ as the minimum and the gate uses includes(); routing lib.rs, runtime/delivery.rs, runtime/tests.rs and tests/ as well is what actually stops #1812's fail-closed fallback for this PR's real changed-file set (63 scenarios -> 1)

### Put the new delivery-contract cases in tests/fixtures/ rather than evals/suites/*/cases.md
- **Chose:** Put the new delivery-contract cases in tests/fixtures/ rather than evals/suites/*/cases.md
- **Reasoning:** The phase-0 edit-gate allowlist treats any evals/ change as scope creep and tsScope is tests/ + manifest.yaml only; tests/fixtures runs in npm test, loads and asserts all four named suites, and keeps the lane green. Flagged the allowlist gap for the operator

---

## Chapters

### 1. Work
*Agent: default*

- Registered delivery-backend-seam routing five phase-0 Rust paths, not just crates/broker/src/delivery/: Registered delivery-backend-seam routing five phase-0 Rust paths, not just crates/broker/src/delivery/
- Put the new delivery-contract cases in tests/fixtures/ rather than evals/suites/*/cases.md: Put the new delivery-contract cases in tests/fixtures/ rather than evals/suites/*/cases.md
- Manifest routing fixed (63 scenarios -> 1) and 13 new tests land green, all mutation-proven. Two gates stay red and both are outside this lane: phase-0 scope omits its own wiring file (crates/broker/src/runtime/), and targeted-gate structurally cannot pass in the same PR that manifest-gate requires the manifest edit in.

---

## Artifacts

**Commits:** e3bd628d0
**Files changed:** 1
