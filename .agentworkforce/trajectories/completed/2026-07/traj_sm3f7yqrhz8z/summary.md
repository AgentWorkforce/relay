# Trajectory: Recover Fleet delivery cursor after broker restart

> **Status:** ✅ Completed
> **Task:** #1240
> **Confidence:** 94%
> **Started:** July 10, 2026 at 10:14 AM
> **Completed:** July 10, 2026 at 10:14 AM

---

## Summary

Negotiated Relaycast delivery cursors during agent registration, keyed broker cursors by immutable agent identity, retained strict gap detection, and added restart/compatibility coverage.

**Approach:** Standard approach

---

## Key Decisions

### Use a negotiated server-authoritative cursor handshake

- **Chose:** Use a negotiated server-authoritative cursor handshake
- **Reasoning:** Inferring a cursor from the first replay could skip a genuine gap, while broker-local persistence can become stale if the engine or identity changes. Relaycast returns delivery_ack_seq only after the broker advertises relay:delivery-cursor-v1; Relay keys it to agent_id and retains cursor+1 validation.

---

## Chapters

### 1. Work

_Agent: default_

- Use a negotiated server-authoritative cursor handshake: Use a negotiated server-authoritative cursor handshake
