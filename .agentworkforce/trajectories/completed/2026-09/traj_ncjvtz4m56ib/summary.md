# Trajectory: Fix Relay Fleet issue #1400: align advertised commands with always-on node delivery

> **Status:** ✅ Completed
> **Confidence:** 93%
> **Started:** September 9, 2026 at 05:42 AM
> **Completed:** September 9, 2026 at 05:54 AM

---

## Summary

Removed obsolete workspace Fleet rollout controls, preserved hidden always-on migration diagnostics, updated SDK/CLI contracts and verification matrices, and added exact base/head RelayFlow proof for issue #1400.

**Approach:** Standard approach

---

## Key Decisions

### Removed the Relaycast workspace fleet rollout facade instead of recreating a removed API
- **Chose:** Removed the Relaycast workspace fleet rollout facade instead of recreating a removed API
- **Reasoning:** Relaycast now delivers to nodes unconditionally; hidden CLI shims preserve credential-safe migration diagnostics while the public SDK and feature manifest stop advertising a false remote contract.

---

## Chapters

### 1. Work
*Agent: default*

- Removed the Relaycast workspace fleet rollout facade instead of recreating a removed API: Removed the Relaycast workspace fleet rollout facade instead of recreating a removed API
- Issue #1400 implementation and cleanroom proof are green: production contains no workspace.fleetNodes dependency, legacy controls fail locally with always-on guidance, and the exact base/head RelayFlow case observes the stale contract then the fixed contract.

---

## Artifacts

**Commits:** 1957505b0
**Files changed:** 20
