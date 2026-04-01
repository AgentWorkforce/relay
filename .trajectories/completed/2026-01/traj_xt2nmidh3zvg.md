# Trajectory: Fix workspace upgrade scaling bugs

> **Status:** ✅ Completed
> **Task:** workspace-upgrade-scaling
> **Confidence:** 90%
> **Started:** January 19, 2026 at 05:37 AM
> **Completed:** January 19, 2026 at 05:38 AM

---

## Summary

Fixed two bugs preventing workspace upgrades: (1) resize() now merges config instead of overwriting, preserving image/services/env vars; (2) getCurrentTier() thresholds corrected from wrong values to match actual tier definitions. All tests pass.

**Approach:** Standard approach

---

## Key Decisions

### Identified resize() was overwriting entire Fly.io machine config instead of merging
- **Chose:** Identified resize() was overwriting entire Fly.io machine config instead of merging
- **Reasoning:** Comparing resize() with updateMachineImage() showed the latter correctly fetches current config first and merges changes, while resize() sent partial config that wiped existing settings like image, services, auto_stop

### Fixed getCurrentTier() memory thresholds that were completely wrong
- **Chose:** Fixed getCurrentTier() memory thresholds that were completely wrong
- **Reasoning:** Thresholds were 4096->xlarge, 2048->large when actual tiers are small:2048, medium:4096, large:8192, xlarge:16384. This caused auto-scaling to think workspaces were already at higher tiers

### Moved skip_launch to query parameter and added response error checking
- **Chose:** Moved skip_launch to query parameter and added response error checking
- **Reasoning:** updateMachineImage used query param for skip_launch while resize used body field. Made them consistent and added proper error handling for API responses

---

## Chapters

### 1. Work
*Agent: default*

- Identified resize() was overwriting entire Fly.io machine config instead of merging: Identified resize() was overwriting entire Fly.io machine config instead of merging
- Fixed getCurrentTier() memory thresholds that were completely wrong: Fixed getCurrentTier() memory thresholds that were completely wrong
- Moved skip_launch to query parameter and added response error checking: Moved skip_launch to query parameter and added response error checking
