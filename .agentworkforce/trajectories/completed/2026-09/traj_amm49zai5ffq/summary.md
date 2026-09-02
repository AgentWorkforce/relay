# Trajectory: Fix attach buffered-input replay after verified reconnect

> **Status:** ✅ Completed
> **Confidence:** 93%
> **Started:** September 2, 2026 at 08:42 AM
> **Completed:** September 2, 2026 at 09:17 AM

---

## Summary

Reproduced the cross-node input drop as Relaycast's hard 10-minute terminal-session expiry, then fixed relay attach recovery to retain a 64 KiB outage buffer and replay it only after positive same-worker identity verification. Added real-path and unit must-fire/must-not-fire coverage plus overflow safety; 176 focused tests, CLI typecheck, diff check, and changed-file lint pass.

**Approach:** Standard approach

---

## Key Decisions

### Replay outage input automatically only after positive same-worker identity verification
- **Chose:** Replay outage input automatically only after positive same-worker identity verification
- **Reasoning:** Drive attach is a raw interactive stream; prompting would require intercepting terminal control data and stall the session. A positive PID/context match preserves destination safety, while rejected or unavailable identity discards the buffer and detaches.

### Bound each outage buffer at 64 KiB and poison the whole pending buffer on overflow or replay refusal
- **Chose:** Bound each outage buffer at 64 KiB and poison the whole pending buffer on overflow or replay refusal
- **Reasoning:** The bound accommodates human typeahead through the retry window but caps paste and mouse-report floods. Whole-buffer discard prevents a truncated prefix or suffix from becoming a different executable command.

### Do not replay the live write whose rejection initiated recovery
- **Chose:** Do not replay the live write whose rejection initiated recovery
- **Reasoning:** That write may have crossed the socket before its acknowledgement failed, so replay would risk duplicate execution. Only input observed after recovery starts is known not to have been sent.

### Classify defect A as relaycast-cloud hard terminal-session expiry
- **Chose:** Classify defect A as relaycast-cloud hard terminal-session expiry
- **Reasoning:** A read-only production probe reproduced session_expired and WebSocket close 4002 at 602.999 seconds; local attach has no Relaycast terminal-session lease, explaining cross-node specificity.

---

## Chapters

### 1. Work
*Agent: default*

- Replay outage input automatically only after positive same-worker identity verification: Replay outage input automatically only after positive same-worker identity verification
- Bound each outage buffer at 64 KiB and poison the whole pending buffer on overflow or replay refusal: Bound each outage buffer at 64 KiB and poison the whole pending buffer on overflow or replay refusal
- Do not replay the live write whose rejection initiated recovery: Do not replay the live write whose rejection initiated recovery
- Classify defect A as relaycast-cloud hard terminal-session expiry: Classify defect A as relaycast-cloud hard terminal-session expiry
