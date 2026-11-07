# Trajectory: Remove broker harness registry footgun

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** May 25, 2026 at 05:55 PM
> **Completed:** May 25, 2026 at 06:02 PM

---

## Summary

Removed broker harness registry and harnessId from the PR. SDK named harnesses now resolve to inline harnessConfig before spawn; broker and Relaycast reject harnessId and require concrete configs for custom harness behavior.

**Approach:** Standard approach
