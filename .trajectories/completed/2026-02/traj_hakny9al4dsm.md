# Trajectory: Fix CLI refactor blockers/high-priority issues

> **Status:** ✅ Completed
> **Confidence:** 92%
> **Started:** February 20, 2026 at 11:07 AM
> **Completed:** February 20, 2026 at 11:08 AM

---

## Summary

Wired bootstrap as CLI entrypoint, added agents/who/agents:logs to agent-management with tests, removed socketPath refs, hardened cloud URL open, typed spawnPty usage, and verified tests/types/build/version/grep/line limits

**Approach:** Standard approach

---

## Key Decisions

### Extracted agent listing/who/logs logic to lib helper module

- **Chose:** Extracted agent listing/who/logs logic to lib helper module
- **Reasoning:** Kept agent-management.ts under 500 lines while adding required commands and preserving DI

### Removed direct socket path references from CLI command/lib code

- **Chose:** Removed direct socket path references from CLI command/lib code
- **Reasoning:** Switched to broker.pid/runtime checks and deterministic relay.sock paths to satisfy broker-owned lifecycle model

---

## Chapters

### 1. Work

_Agent: default_

- Extracted agent listing/who/logs logic to lib helper module: Extracted agent listing/who/logs logic to lib helper module
- Removed direct socket path references from CLI command/lib code: Removed direct socket path references from CLI command/lib code
