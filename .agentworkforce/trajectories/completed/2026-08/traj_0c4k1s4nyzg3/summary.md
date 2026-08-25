# Trajectory: Fix relay #1602 authoritative live-worker inventory

> **Status:** ✅ Completed
> **Task:** AgentWorkforce/relay#1602
> **Confidence:** 93%
> **Started:** August 25, 2026 at 08:48 AM
> **Completed:** August 25, 2026 at 09:27 AM

---

## Summary

Unified fleet heartbeat live-agent names with the authoritative reconnect inventory, added divergence and reconnect regressions, and validated broker/TypeScript behavior.

**Approach:** Standard approach

---

## Key Decisions

### Use retained fleet_inventory as the sole broker-side identity/name set for inventory.sync and heartbeat live-agent capability
- **Chose:** Use retained fleet_inventory as the sole broker-side identity/name set for inventory.sync and heartbeat live-agent capability
- **Reasoning:** inventory carries authoritative immutable agent IDs, is populated only after registration or audited read-only reconciliation of live PTYs, survives node-control reconnects, and preserves multi-node claim arbitration; deriving heartbeat names from every worker-registry key is the divergent unauthorised projection that caused #1602

---

## Chapters

### 1. Work
*Agent: default*

- Use retained fleet_inventory as the sole broker-side identity/name set for inventory.sync and heartbeat live-agent capability: Use retained fleet_inventory as the sole broker-side identity/name set for inventory.sync and heartbeat live-agent capability
- Issue 1602 regression now proves heartbeat authorization names and reconnect inventory derive from one retained live-worker vector. Existing reconciliation remains responsible for adopting live PTYs without registration or token rotation; immutable-id/name mismatch guards preserve multi-node claim semantics.
