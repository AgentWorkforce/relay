# Trajectory: Extend sdk-ts broker methods and relaycast utility

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** February 18, 2026 at 09:47 AM
> **Completed:** February 18, 2026 at 09:47 AM

---

## Summary

Extended sdk-ts client protocol methods, added waitForAgentReady, replaced RelaycastApi with createRelaycastClient, and verified with npm test.

**Approach:** Standard approach

---

## Key Decisions

### Added readyAgents tracking and waitForAgentReady listener cleanup

- **Chose:** Added readyAgents tracking and waitForAgentReady listener cleanup
- **Reasoning:** Supports immediate resolution for already-ready agents and prevents onEvent listener leaks.

---

## Chapters

### 1. Work

_Agent: default_

- Added readyAgents tracking and waitForAgentReady listener cleanup: Added readyAgents tracking and waitForAgentReady listener cleanup
