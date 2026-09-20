# Trajectory: Extend Flows v2 Fleet qualification for fleet nodes list and finish PR 1811 review fixes

> **Status:** ✅ Completed
> **Task:** PR-1811
> **Confidence:** 96%
> **Started:** September 19, 2026 at 05:50 PM
> **Completed:** September 19, 2026 at 06:01 PM

---

## Summary

Fixed PR 1811 review issues, extended the Flows v2 Fleet board from 108 to 110 operations for both fleet nodes list spellings, updated executable inventory semantics and documentation, and validated focused tests, typecheck, lint, and v2 spec generation.

**Approach:** Preserved parent options explicitly, clamped skewed relative timestamps, added focused tests and live board operations, regenerated only the scoped inventory contract, and ran fail-closed validation.

---

## Key Decisions

### Keep the exhaustive Fleet board on Flows v2
- **Chose:** Keep the exhaustive Fleet board on Flows v2
- **Rejected:** Revive PR 1665's v1 workflow
- **Reasoning:** PR 1792 already migrated the qualification to flows/verify/fleet-daytona.spec.ts, so the stale Relayflows v1 branch should not be extended.

### Model executable Commander parents as inventory leaves
- **Chose:** Model executable Commander parents as inventory leaves
- **Rejected:** Cover only fleet nodes list, Keep structural leaf semantics
- **Reasoning:** fleet nodes remains executable after gaining the list child; structural leaf-only inventory would silently drop the compatibility path and miss parent-option forwarding regressions.

### Separate deterministic verdicts from live compatibility evidence
- **Chose:** Separate deterministic verdicts from live compatibility evidence
- **Rejected:** Mock the entire remote spawn path
- **Reasoning:** Matrix, inventory, exit-code, identity, and cleanup validation are deterministic and fail closed; Daytona provisioning, Relaycast transport, and harness startup are live dependencies whose outcomes cannot be made deterministic.

---

## Chapters

### 1. Work
*Agent: default*

- Keep the exhaustive Fleet board on Flows v2: Keep the exhaustive Fleet board on Flows v2
- Model executable Commander parents as inventory leaves: Model executable Commander parents as inventory leaves
- Separate deterministic verdicts from live compatibility evidence: Separate deterministic verdicts from live compatibility evidence
