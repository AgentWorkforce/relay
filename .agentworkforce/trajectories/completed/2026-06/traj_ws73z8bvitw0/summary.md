# Trajectory: Expose workspace fleet node flag in Relay SDK and CLI

> **Status:** ✅ Completed
> **Confidence:** 82%
> **Started:** June 18, 2026 at 01:47 PM
> **Completed:** June 18, 2026 at 01:47 PM

---

## Summary

Added Relay SDK workspace.fleetNodes get/set/inherit, CLI fleet config/enable/disable/inherit commands, docs and changelog entries, and updated Relay workspaces to @relaycast/sdk 4.1.0 with a REST fallback for the missing convenience method. SDK tests/build and focused fleet CLI tests pass; full CLI build is blocked by existing current-main cloud auth StoredAuth type errors.

**Approach:** Standard approach

---

## Key Decisions

### Use REST fallback for workspace fleet config
- **Chose:** Use REST fallback for workspace fleet config
- **Reasoning:** @relaycast/sdk 4.1.0 is published and installed, but its dist types do not expose workspace.fleetNodes, so Relay should call /v1/workspace/fleet-nodes directly when the SDK convenience method is absent.

---

## Chapters

### 1. Work
*Agent: default*

- Use REST fallback for workspace fleet config: Use REST fallback for workspace fleet config
