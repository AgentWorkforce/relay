# Trajectory: Fix @agent-relay/wrapper module resolution issues - 17 test failures

> **Status:** ✅ Completed
> **Task:** PR-357
> **Confidence:** 90%
> **Started:** February 2, 2026 at 10:32 AM
> **Completed:** February 2, 2026 at 03:14 PM

---

## Summary

Fixed Devin review issue: threaded shadowMode, shadowAgent, shadowTriggers through protocol SpawnPayload, SDK client.spawn(), daemon SpawnManager, and CLI. Added SDK test for shadow options. Created sdk-daemon-parity Claude rule.

**Approach:** Standard approach

---

## Key Decisions

### Thread shadowMode, shadowAgent, shadowTriggers through protocol, SDK, daemon, and CLI layers
- **Chose:** Thread shadowMode, shadowAgent, shadowTriggers through protocol, SDK, daemon, and CLI layers
- **Reasoning:** Devin review found these fields were silently dropped in daemon spawn path. Both the spawner and bridge packages already support them, but protocol SpawnPayload and SDK client.spawn() were missing them, creating silent data loss when using daemon-based spawning vs HTTP API fallback.

### Created sdk-daemon-parity.md Claude rule
- **Chose:** Created sdk-daemon-parity.md Claude rule
- **Reasoning:** Codifies the requirement that all spawn fields must be threaded through protocol, SDK, daemon, and CLI layers to prevent future silent data loss bugs.

---

## Chapters

### 1. Work
*Agent: default*

- Thread shadowMode, shadowAgent, shadowTriggers through protocol, SDK, daemon, and CLI layers: Thread shadowMode, shadowAgent, shadowTriggers through protocol, SDK, daemon, and CLI layers
- Created sdk-daemon-parity.md Claude rule: Created sdk-daemon-parity.md Claude rule
