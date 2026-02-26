# Trajectory: Fix dashboard online status and delivery state transitions

> **Status:** ✅ Completed
> **Confidence:** 88%
> **Started:** February 23, 2026 at 01:52 PM
> **Completed:** February 23, 2026 at 02:04 PM

---

## Summary

Patched dashboard agent online merge + message ack state, added targeted tests, and rebuilt dashboard artifacts for local broker workflow

**Approach:** Standard approach

---

## Key Decisions

### Treat broker-spawned workers as online when broker reports online/pid and mark optimistic sends acked on API success

- **Chose:** Treat broker-spawned workers as online when broker reports online/pid and mark optimistic sends acked on API success
- **Reasoning:** Relaycast presence can lag worker process state; dashboard should reflect broker runtime truth and delivery checkmarks should advance on API ack

---

## Chapters

### 1. Work

_Agent: default_

- Treat broker-spawned workers as online when broker reports online/pid and mark optimistic sends acked on API success: Treat broker-spawned workers as online when broker reports online/pid and mark optimistic sends acked on API success
