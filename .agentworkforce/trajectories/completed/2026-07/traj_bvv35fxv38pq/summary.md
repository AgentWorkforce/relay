# Trajectory: Map AI SDK harness lifecycle events to Relaycast activity

> **Status:** ✅ Completed
> **Confidence:** 95%
> **Started:** July 15, 2026 at 09:42 PM
> **Completed:** July 15, 2026 at 09:42 PM

---

## Summary

Mapped HarnessV1 stream and lifecycle signals to a reliable Relaycast activity state machine.

**Approach:** Standard approach

---

## Key Decisions

### Expose derived agent activity separately from durable session status

- **Chose:** Expose derived agent activity separately from durable session status
- **Reasoning:** HarnessV1 provides structured turn events sufficient for thinking, typing, tool use, approval waiting, idle, starting, and error. These high-frequency activities should be reduced from events and published with reasons, while Relay's durable active/idle/blocked/offline status remains stable.

---

## Chapters

### 1. Work

_Agent: default_

- Expose derived agent activity separately from durable session status: Expose derived agent activity separately from durable session status
