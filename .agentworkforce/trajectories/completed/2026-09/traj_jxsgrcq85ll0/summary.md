# Trajectory: Move cleanroom qualification into a trusted default-branch consumer

> **Status:** ✅ Completed
> **Task:** relay#1682
> **Confidence:** 86%
> **Started:** September 6, 2026 at 03:20 PM
> **Completed:** September 6, 2026 at 03:24 PM

---

## Summary

Added a no-secret qualification request workflow and trusted default-branch workflow_run consumer with exact actor, ref, manifest, artifact, candidate, Fleet, and cleanup evidence gates.

**Approach:** Standard approach

---

## Key Decisions

### Use a no-secret request artifact plus workflow_run consumer pinned to github.workflow_sha
- **Chose:** Use a no-secret request artifact plus workflow_run consumer pinned to github.workflow_sha
- **Reasoning:** Candidate refs must remain immutable data inputs; only default-branch verifier and Fleet workflow code may receive qualification secrets.

### Validate candidate CLI inventory independently from the trusted verifier checkout
- **Chose:** Validate candidate CLI inventory independently from the trusted verifier checkout
- **Reasoning:** The trusted prerequisite lands before candidate-only CLI options; the live board still compares the hydrated candidate to the immutable inventory before any operation earns credit.

---

## Chapters

### 1. Work
*Agent: default*

- Use a no-secret request artifact plus workflow_run consumer pinned to github.workflow_sha: Use a no-secret request artifact plus workflow_run consumer pinned to github.workflow_sha
- Validate candidate CLI inventory independently from the trusted verifier checkout: Validate candidate CLI inventory independently from the trusted verifier checkout
- Trusted request and default-branch consumer are implemented with actor/ref/artifact binding, provider secrets scoped to the Fleet step, trusted fallback cleanup, and local red/green proof; full unit and type gates pass.

---

## Artifacts

**Commits:** 8da029154
**Files changed:** 31
