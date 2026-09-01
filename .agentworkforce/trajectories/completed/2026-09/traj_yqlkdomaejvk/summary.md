# Trajectory: Adapt PR 1631 proof to the locked-down Daytona image

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** September 1, 2026 at 08:02 PM
> **Completed:** September 1, 2026 at 08:02 PM

---

## Summary

Reworked the Cloud proof for the locked-down image: exact base Rust wiring derives 10s and times out against a 12s healthy response; exact head wiring derives 30s and accepts it. Both local arms and all 45 proof-contract tests pass.

**Approach:** Standard approach

---

## Key Decisions

### Derive the production bound from exact Rust wiring and execute it against a delayed local endpoint
- **Chose:** Derive the production bound from exact Rust wiring and execute it against a delayed local endpoint
- **Reasoning:** The proof image has neither Cargo nor outbound access, so it cannot compile the target. The case now validates the exact inline or named timeout wiring for each SHA and exercises that derived bound over real HTTP; compiled behavior remains independently established by the local exact-SHA run and Rust CI.

---

## Chapters

### 1. Work
*Agent: default*

- Derive the production bound from exact Rust wiring and execute it against a delayed local endpoint: Derive the production bound from exact Rust wiring and execute it against a delayed local endpoint
