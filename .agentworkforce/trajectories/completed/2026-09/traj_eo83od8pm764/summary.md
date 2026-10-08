# Trajectory: Add targeted Flows v2 PR verification

> **Status:** ✅ Completed
> **Confidence:** 93%
> **Started:** September 19, 2026 at 06:20 PM
> **Completed:** September 19, 2026 at 06:35 PM

---

## Summary

Added fail-closed targeted pull-request verification generated as a Relayflows v2 spec, backed by the existing feature manifest and cleanroom matrix.

**Approach:** Mapped changed paths to feature/category/scenario evidence, generated a sequential deterministic spec, wired GitHub Actions with pinned relayflowd runtimes, added matrix metadata and product-surface coverage, then validated with a real local flow run and focused repository gates.

---

## Key Decisions

### Route PR diffs through the feature manifest and cleanroom matrix
- **Chose:** Route PR diffs through the feature manifest and cleanroom matrix
- **Rejected:** Hard-coded workflow path filters, one monolithic suite on every PR
- **Reasoning:** The manifest owns file-to-feature identity and the matrix owns executable evidence, so reusing both avoids a second drifting verification catalog.

### Fail closed to the complete smoke profile
- **Chose:** Fail closed to the complete smoke profile
- **Rejected:** Skip unknown paths, fail selection immediately
- **Reasoning:** Selector and catalog changes, plus unknown non-documentation runtime paths, must execute broad verification rather than silently produce a green skip.

### Keep live provider checks as explicit coverage gaps
- **Chose:** Keep live provider checks as explicit coverage gaps
- **Rejected:** Run live Daytona on every PR, hide provider checks from the plan
- **Reasoning:** Generic pull-request runners can deterministically run contract and board-schema tests but cannot honestly claim the authenticated two-node Daytona release proof.

### Allow Flows v2 to auto-start its pinned relayflowd runtime
- **Chose:** Allow Flows v2 to auto-start its pinned relayflowd runtime
- **Rejected:** Prestart a global daemon, use an unpinned globally installed binary
- **Reasoning:** The --no-spawn flag caused daemon_unreachable; pinned optional platform runtimes make attach-or-start reproducible locally and on Linux CI.

---

## Chapters

### 1. Work
*Agent: default*

- Route PR diffs through the feature manifest and cleanroom matrix: Route PR diffs through the feature manifest and cleanroom matrix
- Fail closed to the complete smoke profile: Fail closed to the complete smoke profile
- Keep live provider checks as explicit coverage gaps: Keep live provider checks as explicit coverage gaps
- Allow Flows v2 to auto-start its pinned relayflowd runtime: Allow Flows v2 to auto-start its pinned relayflowd runtime
- Implemented the selector, deterministic v2 spec generator, PR workflow, matrix routing metadata, product-surface coverage, docs, and fixtures. A real local Flows v2 run completed all five steps and exercised 397 Fleet plus 72 board-contract tests. Matrix validation, typecheck, Flows checks, formatting, and workflow parsing pass.
