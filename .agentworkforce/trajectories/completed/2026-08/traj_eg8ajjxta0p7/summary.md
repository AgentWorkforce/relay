# Trajectory: Harden fleet-node attach recovery

> **Status:** ✅ Completed
> **Task:** PR-1573
> **Confidence:** 96%
> **Started:** August 18, 2026 at 10:28 PM
> **Completed:** August 18, 2026 at 10:28 PM

---

## Summary

Hardened fleet-node attach with a 90-second structured-safe session-allocation budget, independently bounded WebSocket handshake and readiness recovery, stale-generation rejection, propagated loopback HTTP deadlines, actionable diagnostics, deterministic tests, exact package smoke, and live view/drive validation.

**Approach:** Standard approach

---

## Key Decisions

### Bound terminal-session creation to a 90-second aggregate deadline
- **Chose:** Bound terminal-session creation to a 90-second aggregate deadline
- **Reasoning:** A 30-second per-attempt timeout plus all structured-safe retries could otherwise keep the interactive attach pending for roughly three minutes; the aggregate bound retains safe recovery while ambiguous POST completion is never replayed.

### Separate WebSocket handshake and terminal readiness deadlines
- **Chose:** Separate WebSocket handshake and terminal readiness deadlines
- **Reasoning:** HTTP upgrade and terminal.ready are distinct phases, and late readiness from an expired generation must not revive a stale connection.

### Carry readiness-gated calls across bounded reconnect generations
- **Chose:** Carry readiness-gated calls across bounded reconnect generations
- **Reasoning:** Snapshot, delivery-mode, and resize requests can begin during reconnect backoff, so both their server wait and caller HTTP deadline must cover the complete finite recovery path.

---

## Chapters

### 1. Work
*Agent: default*

- Bound terminal-session creation to a 90-second aggregate deadline: Bound terminal-session creation to a 90-second aggregate deadline
- Separate WebSocket handshake and terminal readiness deadlines: Separate WebSocket handshake and terminal readiness deadlines
- Carry readiness-gated calls across bounded reconnect generations: Carry readiness-gated calls across bounded reconnect generations
- PR 1573 hardened fleet-node attach recovery and diagnostics, then incorporated review fixes that preserve the last structured upstream cause and propagate the full bounded readiness budget through the loopback HTTP client. Exact packaged artifacts passed standalone smoke and live view 20/20 plus drive 10/10; the final focused suite passed 313 tests.
