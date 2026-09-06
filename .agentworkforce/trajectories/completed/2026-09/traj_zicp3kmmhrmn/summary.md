# Trajectory: Add sealed base/head RelayFlow proof for Relaycast registration diagnostics

> **Status:** ✅ Completed
> **Task:** relay#1673
> **Confidence:** 95%
> **Started:** September 6, 2026 at 04:38 AM
> **Completed:** September 6, 2026 at 04:40 AM

---

## Summary

Added sealed RelayFlow case 1673-relaycast-registration-diagnostics. Locally proved relaycast 7.0.0 replays unsafe registration POSTs and loses terminal diagnostics, while relaycast 8.0.0 emits status/code/message/request ID/attempt count with one POST and no final Retry-After sleep.

**Approach:** Standard approach

---

## Key Decisions

### Seal regression as a real binary base/head RelayFlow case
- **Chose:** Seal regression as a real binary base/head RelayFlow case
- **Reasoning:** The case invokes the broker supplied by the proof harness against a loopback 503 server, so it detects both unsafe POST replay in relaycast 7.0.0 and caller-visible terminal diagnostics/no final Retry-After delay in 8.0.0.

---

## Chapters

### 1. Work
*Agent: default*

- Seal regression as a real binary base/head RelayFlow case: Seal regression as a real binary base/head RelayFlow case
