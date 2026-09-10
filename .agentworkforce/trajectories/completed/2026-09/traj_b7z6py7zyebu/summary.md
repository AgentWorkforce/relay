# Trajectory: Fix Fleet Daytona cleanup tombstone handling

> **Status:** ✅ Completed
> **Task:** relay#1711
> **Confidence:** 90%
> **Started:** September 9, 2026 at 04:21 AM
> **Completed:** September 9, 2026 at 04:41 AM

---

## Summary

Completed Fleet cleanup convergence and fixed the broker readiness race that exposed API routes before BrokerRuntime could service them

**Approach:** Standard approach

---

## Key Decisions

### Publish broker API readiness only after BrokerRuntime construction
- **Chose:** Publish broker API readiness only after BrokerRuntime construction
- **Reasoning:** The standalone macOS failure completed the Relaycast session handshake, then timed out on /api/status because the ready router was exposed while inline channel-ensure network calls still blocked construction of the request receiver. Channel maintenance is best-effort and now runs in an ordered background task; the startup listener keeps returning 503 until runtime-backed routes can be serviced.

### Publish runtime-backed HTTP readiness only after BrokerRuntime construction
- **Chose:** Publish runtime-backed HTTP readiness only after BrokerRuntime construction
- **Reasoning:** The hosted macOS smoke trace showed session readiness succeeded before /api/status timed out. The status route queues onto BrokerRuntime's receiver, but the prior startup sequence exposed the ready router and then awaited best-effort Relaycast channel setup before constructing or running that receiver. Scheduling ordered channel maintenance in the background and handing off only after runtime construction removes that queue starvation while preserving channel setup semantics.

---

## Chapters

### 1. Work
*Agent: default*

- Publish broker API readiness only after BrokerRuntime construction: Publish broker API readiness only after BrokerRuntime construction
- Fleet tombstone cleanup fixtures pass 45/45; standalone macOS failure is isolated to API readiness preceding runtime construction and the focused Rust regression now passes.
- Publish runtime-backed HTTP readiness only after BrokerRuntime construction: Publish runtime-backed HTTP readiness only after BrokerRuntime construction
- The Fleet cleanup implementation is already complete at PR #1665 head. The remaining hosted blocker was a separate deterministic startup-order race exposed by macOS smoke; full broker tests, clippy, formatting, and the Fleet verifier pass after moving readiness.
