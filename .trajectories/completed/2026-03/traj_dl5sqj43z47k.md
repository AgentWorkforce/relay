# Trajectory: Fix broker WS channel subscription bug

> **Status:** ✅ Completed
> **Confidence:** 94%
> **Started:** March 13, 2026 at 01:03 PM
> **Completed:** March 13, 2026 at 01:06 PM

---

## Summary

Subscribed the broker websocket to active channels after connect and to newly joined channels at runtime, then verified with cargo build and cargo test.

**Approach:** Standard approach

---

## Key Decisions

### Use the SDK's real ws.subscribe flow on connect and runtime joins
- **Chose:** Use the SDK's real ws.subscribe flow on connect and runtime joins
- **Reasoning:** The broker was only tracking local subscriptions, so channel messages never reached the socket even though the Relaycast crate already handles subscribe frames and reconnect replay.

---

## Chapters

### 1. Work
*Agent: default*

- Use the SDK's real ws.subscribe flow on connect and runtime joins: Use the SDK's real ws.subscribe flow on connect and runtime joins
- The websocket bug was isolated to the broker's wrapper, not the Relaycast crate itself, so the minimal safe fix was to route existing and newly joined channels through WsClient::subscribe while preserving the broker's synthetic join events.
