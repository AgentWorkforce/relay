# Trajectory: Surface AgentRelay provider and headless spawns

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** May 27, 2026 at 07:24 AM
> **Completed:** May 27, 2026 at 07:24 AM

---

## Summary

Added high-level AgentRelay.spawnProvider and AgentRelay.spawnHeadless facade methods, widened SpawnHeadlessInput for harness-backed provider metadata, documented the API, updated the changelog, and verified with SDK typecheck, build, formatting, and focused Vitest coverage.

**Approach:** Standard approach

---

## Key Decisions

### Expose typed AgentRelay spawnProvider and spawnHeadless methods
- **Chose:** Expose typed AgentRelay spawnProvider and spawnHeadless methods
- **Reasoning:** Issue 998 needs provider-backed and headless app-server agents to use the high-level facade lifecycle hooks, result contracts, channel handles, and harness resolution instead of dropping to AgentRelayClient.

---

## Chapters

### 1. Work
*Agent: default*

- Expose typed AgentRelay spawnProvider and spawnHeadless methods: Expose typed AgentRelay spawnProvider and spawnHeadless methods
