# Trajectory: Refresh Relaycast SDK lock after 4.1.2 publish

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** June 19, 2026 at 03:02 PM
> **Completed:** June 19, 2026 at 03:05 PM

---

## Summary

Updated agent-relay and @agent-relay/sdk to require @relaycast/sdk ^4.1.2 after the matching @relaycast/types 4.1.2 package became available, preserving caret ranges instead of pinning.

**Approach:** Standard approach

---

## Key Decisions

### Bumped Relaycast SDK range instead of pinning
- **Chose:** Bumped Relaycast SDK range instead of pinning
- **Reasoning:** @relaycast/types@4.1.2 is now published, so the repo can keep caret semantics while requiring the fixed Relaycast SDK release.

---

## Chapters

### 1. Work
*Agent: default*

- Bumped Relaycast SDK range instead of pinning: Bumped Relaycast SDK range instead of pinning
