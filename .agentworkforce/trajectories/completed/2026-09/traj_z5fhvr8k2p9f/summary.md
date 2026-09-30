# Trajectory: Fix publish ERESOLVE on major bump vs @relayflows/sdk peer <13

> **Status:** ✅ Completed
> **Confidence:** 85%
> **Started:** September 30, 2026 at 04:43 PM
> **Completed:** September 30, 2026 at 04:44 PM

---

## Summary

Publish major bump failed ERESOLVE on @relayflows/sdk optional peer <13; publish version bump now pins those peers via npm overrides. PR #1868.

**Approach:** Standard approach

---

## Key Decisions

### Pin @relayflows/sdk optional peers via npm overrides during publish version bump
- **Chose:** Pin @relayflows/sdk optional peers via npm overrides during publish version bump
- **Reasoning:** Publish major to 13.0.0 failed ERESOLVE because @relayflows/sdk@2.0.36 peerOptional caps @agent-relay/sdk at <13. Override forces workspace versions so clean reinstall after bump succeeds without waiting on a flows peer-range release.

---

## Chapters

### 1. Work
*Agent: default*

- Pin @relayflows/sdk optional peers via npm overrides during publish version bump: Pin @relayflows/sdk optional peers via npm overrides during publish version bump

---

## Artifacts

**Commits:** 2bee676c1
**Files changed:** 5
