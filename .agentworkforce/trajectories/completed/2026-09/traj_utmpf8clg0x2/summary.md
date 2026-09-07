# Trajectory: relay#1686: bound an unACKed delivery and give it a terminal dead-letter path

> **Status:** ✅ Completed
> **Task:** relay#1686
> **Confidence:** 85%
> **Started:** September 7, 2026 at 12:52 PM
> **Completed:** September 7, 2026 at 04:56 PM

---

## Summary

relay#1686: bounded an unACKed delivery with a per-delivery wall-clock acknowledgement deadline (30 min default, AGENT_RELAY_DELIVERY_MAX_AGE_MS, clamped both ends, floored per delivery at its own ack timeout) plus a budget-scaled cumulative attempt ceiling as a clock-skew backstop. Both drive the existing terminal path: message_delivery_failed plus a dead-letter entry, withheld fleet ack dropped. failed_attempts cap untouched. Mutation-proven twice; both arms verified end-to-end against real broker binaries and a real Relaycast engine. 16 of 18 review findings fixed, 2 skipped with reason. PR #1701, not merged.

**Approach:** Standard approach

---

## Key Decisions

### Bound the unACKed delivery with a wall-clock deadline, not a cap on attempts
- **Chose:** Bound the unACKed delivery with a wall-clock deadline, not a cap on attempts
- **Reasoning:** The retry cadence IS delivery_ack_timeout: 5 min in Wait mode, the 5s steer verification window. The same attempt count therefore means ~50 minutes in one mode and ~50 seconds in the other, so no single attempt number both spares an agent mid-turn and catches a deaf recipient. 30 min is 6x the wait-mode ack timeout and 360x the steer window. A cumulative attempts ceiling rides along only as a clock-skew backstop, scaled from the configured budget so it can never preempt a raised deadline.

### A healthy PTY worker cannot reproduce a never-ACKed delivery
- **Chose:** A healthy PTY worker cannot reproduce a never-ACKed delivery
- **Reasoning:** pty_worker acks on echo verification OR a 5s timeout fallback (MAX_VERIFICATION_ATTEMPTS=1), so no badly-behaved child can suppress the ack, and the tty line discipline echoes input regardless of stty. The ack is withheld only while the injection WRITE has not completed. The proof case therefore wedges the write itself: a child that never reads stdin plus a body larger than the tty input queue. Relevant to the whole deaf-agent cluster (#1670, #1689): look at the write path, not the child.

---

## Chapters

### 1. Work
*Agent: default*

- Bound the unACKed delivery with a wall-clock deadline, not a cap on attempts: Bound the unACKed delivery with a wall-clock deadline, not a cap on attempts
- A healthy PTY worker cannot reproduce a never-ACKed delivery: A healthy PTY worker cannot reproduce a never-ACKed delivery

---

## Artifacts

**Commits:** 7cb1b52e7, 9db26fc7a, c806a73ed, 0c29b8dbc, 4466f9aff
**Files changed:** 10
