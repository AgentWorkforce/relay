# Trajectory: Expose workspace fleet node flag in Relay SDK and CLI

> **Status:** ✅ Completed
> **Confidence:** 82%
> **Started:** June 18, 2026 at 01:47 PM
> **Completed:** June 18, 2026 at 01:47 PM

---

## Summary

Added Relay SDK workspace.fleetNodes get/set/inherit, CLI fleet config/enable/disable/inherit commands, docs and changelog entries, and updated Relay workspaces to @relaycast/sdk 4.1.1, which ships the Relaycast SDK workspace fleet-node method. SDK tests/build and focused fleet CLI tests pass; full CLI build is blocked by existing current-main cloud auth StoredAuth type errors.

**Approach:** Standard approach

---

## Key Decisions

### Require Relaycast SDK workspace fleet config API

- **Chose:** Require Relaycast SDK workspace fleet config API
- **Reasoning:** Relay should not duplicate the Relaycast REST call. The missing workspace.fleetNodes method belongs in @relaycast/sdk, so Relay delegates to the SDK surface and the Relaycast fix is tracked separately.

---

## Chapters

### 1. Work

_Agent: default_

- Require Relaycast SDK workspace fleet config API: Require Relaycast SDK workspace fleet config API
