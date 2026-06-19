# Trajectory: Fix publish failure from unavailable @relaycast/types version

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** June 19, 2026 at 02:19 PM
> **Completed:** June 19, 2026 at 02:23 PM

---

## Summary

Pinned agent-relay runtime dependencies on @relaycast/sdk to 4.1.1 so publish-time npm installs do not float to a Relaycast SDK release whose exact @relaycast/types dependency may be unavailable or still propagating.

**Approach:** Standard approach

---

## Key Decisions

### Pinned @relaycast/sdk runtime dependency exactly

- **Chose:** Pinned @relaycast/sdk runtime dependency exactly
- **Reasoning:** Publish build removes package-lock.json and runs npm install after versioning; caret ranges can float to a newly published @relaycast/sdk whose exact @relaycast/types dependency may not have propagated yet.

---

## Chapters

### 1. Work

_Agent: default_

- Pinned @relaycast/sdk runtime dependency exactly: Pinned @relaycast/sdk runtime dependency exactly
