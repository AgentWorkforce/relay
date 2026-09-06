# Trajectory: Upgrade Relay broker to relaycast 8.0.0 and prove mcp-args registration diagnostics

> **Status:** ✅ Completed
> **Task:** relaycast#374
> **Confidence:** 92%
> **Started:** September 6, 2026 at 04:24 AM
> **Completed:** September 6, 2026 at 04:30 AM

---

## Summary

Bumped Relay to published relaycast 8.0.0 and added deterministic mcp-args registration diagnostic coverage.

**Approach:** Standard approach

---

## Key Decisions

### Pin Relay to published relaycast 8.0.0 and preserve terminal registration diagnostics
- **Chose:** Pin Relay to published relaycast 8.0.0 and preserve terminal registration diagnostics
- **Reasoning:** The SDK release carries request ID and attempt metadata; Relay must compile against its new API and prove mcp-args exposes the fields without replaying unsafe registration POSTs.

---

## Chapters

### 1. Work
*Agent: default*

- Pin Relay to published relaycast 8.0.0 and preserve terminal registration diagnostics: Pin Relay to published relaycast 8.0.0 and preserve terminal registration diagnostics
