# Trajectory: Fix placement node liveness and sandbox-only policy

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** August 26, 2026 at 09:11 PM
> **Completed:** August 26, 2026 at 09:22 PM

---

## Summary

Hardened SDK placement with strict online/live/handler readiness, atomic automatic dispatch, named fail-fast errors, configurable Cloud JIT sandbox-only eligibility, documentation, focused regression tests, and independent ablation proofs.

**Approach:** Standard approach

---

## Key Decisions

### Preserve Relaycast atomic automatic placement for unrestricted requests; use the established cloud node-type tag family for sandbox-only eligibility
- **Chose:** Preserve Relaycast atomic automatic placement for unrestricted requests; use the established cloud node-type tag family for sandbox-only eligibility
- **Reasoning:** SDK preselection currently retargets automatic requests and creates a liveness TOCTOU; cloud explicitly defines roster tags as stable provenance while names are disposable

### Defaulted sandbox-only placement to false and fail-fast placement to true
- **Chose:** Defaulted sandbox-only placement to false and fail-fast placement to true
- **Reasoning:** Sandbox provenance is workload policy and generic Relay clients must retain local-node eligibility unless configured; fail-fast removes the production five-minute silent wait while preserving queueing as an explicit bounded opt-in.

---

## Chapters

### 1. Work
*Agent: default*

- Preserve Relaycast atomic automatic placement for unrestricted requests; use the established cloud node-type tag family for sandbox-only eligibility: Preserve Relaycast atomic automatic placement for unrestricted requests; use the established cloud node-type tag family for sandbox-only eligibility
- Defaulted sandbox-only placement to false and fail-fast placement to true: Defaulted sandbox-only placement to false and fail-fast placement to true
- Diagnosis showed the SDK already checked the derived live bit, but trusted it without status/handler readiness and converted automatic placement into a targeted TOCTOU request. Strict roster readiness, atomic unconstrained dispatch, explicit sandbox policy, and fail-fast defaults now have independent ablation coverage.
