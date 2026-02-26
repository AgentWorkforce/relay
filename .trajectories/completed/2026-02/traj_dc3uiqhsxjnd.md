# Trajectory: Delete unused legacy packages after broker SDK migration

> **Status:** ✅ Completed
> **Confidence:** 86%
> **Started:** February 18, 2026 at 10:23 AM
> **Completed:** February 18, 2026 at 10:34 AM

---

## Summary

Deleted legacy daemon/sdk/wrapper/bridge/spawner/protocol/state/resiliency/continuity packages, migrated remaining references in kept packages, updated build/workflow configs, and verified full build passes.

**Approach:** Standard approach

---

## Key Decisions

### Replaced residual protocol/resiliency imports in kept packages with broker-sdk or local compatibility types

- **Chose:** Replaced residual protocol/resiliency imports in kept packages with broker-sdk or local compatibility types
- **Reasoning:** Allowed deleting legacy packages without breaking kept package builds and minimized API churn outside removed workspaces.

### Removed root legacy re-export shims tied to deleted packages

- **Chose:** Removed root legacy re-export shims tied to deleted packages
- **Reasoning:** These shims imported removed workspaces directly; keeping them would break TypeScript build after package deletion.

---

## Chapters

### 1. Work

_Agent: default_

- Replaced residual protocol/resiliency imports in kept packages with broker-sdk or local compatibility types: Replaced residual protocol/resiliency imports in kept packages with broker-sdk or local compatibility types
- Removed root legacy re-export shims tied to deleted packages: Removed root legacy re-export shims tied to deleted packages
