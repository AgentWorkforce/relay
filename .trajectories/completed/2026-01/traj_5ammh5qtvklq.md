# Trajectory: Evaluate Fly.io Sprites and implement workspace resilience

> **Status:** ✅ Completed
> **Task:** evaluate-flyio-sprites
> **Confidence:** 90%
> **Started:** January 6, 2026 at 06:24 AM
> **Completed:** January 6, 2026 at 06:25 AM

---

## Summary

Evaluated Fly.io Sprites - not suitable for agent hosting (designed for code sandboxing). Implemented automated volume snapshots with 14-day retention for workspace resilience. Added snapshot management API methods (createSnapshot, listSnapshots, getVolumeId) to WorkspaceProvisioner.

**Approach:** Standard approach

---

## Key Decisions

### Keep Fly.io Machines instead of adopting Sprites
- **Chose:** Keep Fly.io Machines instead of adopting Sprites
- **Reasoning:** Sprites designed for ephemeral AI code execution, not long-running agent sessions. Current Machines provide same Firecracker isolation at ~5x lower cost for our use case.

### Add automated volume snapshots with 14-day retention
- **Chose:** Add automated volume snapshots with 14-day retention
- **Reasoning:** Fly.io provides built-in daily snapshots at $0.08/GB/month. 14-day retention provides good recovery window with minimal cost impact (~$0.50-1.50/month per workspace).

### Create volumes explicitly via API before machines
- **Chose:** Create volumes explicitly via API before machines
- **Reasoning:** Explicit volume creation allows setting snapshot_retention and auto_backup_enabled parameters that are not configurable through fly.toml mounts section.

---

## Chapters

### 1. Work
*Agent: default*

- Keep Fly.io Machines instead of adopting Sprites: Keep Fly.io Machines instead of adopting Sprites
- Add automated volume snapshots with 14-day retention: Add automated volume snapshots with 14-day retention
- Create volumes explicitly via API before machines: Create volumes explicitly via API before machines
