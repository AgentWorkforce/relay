# Trajectory: Finish relay PR #1567 whitespace guard and review threads

> **Status:** ✅ Completed
> **Confidence:** 95%
> **Started:** August 18, 2026 at 12:52 PM
> **Completed:** August 18, 2026 at 01:19 PM

---

## Summary

Finished PR #1567: rejected unset, empty, space-only, and tab-only workspace keys before any binary invocation; strengthened the focused contract with invocation logging; preserved the real-CLI integration boundary; closed the short-lived readiness log/liveness race found by Node 24 CI; replied to and resolved all review threads; updated the PR impact to roughly 1,700 avoided throwaway workspaces per day; verified focused tests, shell checks, Node.js Compatibility, and Package Validation including Standalone macOS Smoke.

**Approach:** Standard approach

---

## Key Decisions

### Keep the fake CLI as the focused shell-script seam
- **Chose:** Keep the fake CLI as the focused shell-script seam
- **Reasoning:** The unit test owns ci-standalone-smoke.sh control flow; Package Validation's Standalone macOS Smoke invokes the real built CLI and broker with RELAY_CI_WORKSPACE_KEY, so live output drift is already covered and a recorded transcript would remain static.

### Re-check readiness after a short-lived node up exits
- **Chose:** Re-check readiness after a short-lived node up exits
- **Reasoning:** Two Node 24 CI failures showed the fake CLI log already contained Broker started while the polling loop reported unready: the process exited between the loop's log check and liveness check. Re-reading the completed log closes that race without widening timeouts or weakening output assertions.

---

## Chapters

### 1. Work
*Agent: default*

- Keep the fake CLI as the focused shell-script seam: Keep the fake CLI as the focused shell-script seam
- Re-check readiness after a short-lived node up exits: Re-check readiness after a short-lived node up exits

---

## Artifacts

**Commits:** 9117f803c, bd5913a6c, dc2b59745
**Files changed:** 2
