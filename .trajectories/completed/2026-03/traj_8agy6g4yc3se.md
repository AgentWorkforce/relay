# Trajectory: Analyze openclaw boundary split for relaycast package migration

> **Status:** ✅ Completed
> **Confidence:** 91%
> **Started:** March 5, 2026 at 08:33 AM
> **Completed:** March 5, 2026 at 08:34 AM

---

## Summary

Delivered file-level stay/migrate boundary for @agent-relay/openclaw vs @relaycast/openclaw, required import contract, and migration risk matrix.

**Approach:** Standard approach

---

## Key Decisions

### Keep gateway/spawn/mcp/control/runtime/identity/auth in @agent-relay/openclaw
- **Chose:** Keep gateway/spawn/mcp/control/runtime/identity/auth in @agent-relay/openclaw
- **Reasoning:** These modules orchestrate process lifecycle, websocket pairing, or Relay SDK flows and should remain app-layer concerns.

### Migrate config/env/shared bridge primitives to @relaycast/openclaw
- **Chose:** Migrate config/env/shared bridge primitives to @relaycast/openclaw
- **Reasoning:** They are reusable SDK primitives with no need for @agent-relay orchestration dependencies and currently duplicated across packages.

---

## Chapters

### 1. Work
*Agent: default*

- Keep gateway/spawn/mcp/control/runtime/identity/auth in @agent-relay/openclaw: Keep gateway/spawn/mcp/control/runtime/identity/auth in @agent-relay/openclaw
- Migrate config/env/shared bridge primitives to @relaycast/openclaw: Migrate config/env/shared bridge primitives to @relaycast/openclaw
