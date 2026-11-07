# Trajectory: Fix PR 831 CI conflicts

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** May 10, 2026 at 05:18 PM
> **Completed:** May 10, 2026 at 05:29 PM

---

## Summary

Merged main into PR 831, resolved SDK package/version conflict, refreshed package-lock, fixed SDK cloud path/build configuration, added cloud schedule telemetry typing, externalized ssh2 for CJS bundling, and updated CLI bootstrap command-count test. Validated SDK check, build, workers safety, workflow reliability, package validation, imports, lint, and full npm test.

**Approach:** Standard approach

---

## Key Decisions

### Resolved package merge by keeping SDK cloud dependency and aligning internal versions to 6.0.14

- **Chose:** Resolved package merge by keeping SDK cloud dependency and aligning internal versions to 6.0.14
- **Reasoning:** PR added @agent-relay/cloud exports from the SDK, while main released packages at 6.0.14; mismatched internal package versions were breaking install/typecheck CI.

---

## Chapters

### 1. Work

_Agent: default_

- Resolved package merge by keeping SDK cloud dependency and aligning internal versions to 6.0.14: Resolved package merge by keeping SDK cloud dependency and aligning internal versions to 6.0.14
- Resolved PR 831 merge and CI failures: SDK now maps and builds cloud dependency, telemetry knows schedule event, CJS build externalizes ssh2 native addon, CLI command count matches new schedule commands. Local validation green.
