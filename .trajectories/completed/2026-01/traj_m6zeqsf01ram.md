# Trajectory: Fix channel communication for cloud users

> **Status:** ✅ Completed
> **Task:** channel-communication-fix
> **Confidence:** 85%
> **Started:** January 20, 2026 at 01:52 PM
> **Completed:** January 20, 2026 at 01:52 PM

---

## Summary

Fixed two channel communication issues: 1) Added channel creation broadcast to notify other workspace users via WebSocket, 2) Fixed channel subscription to prefer userBridge over getRelayClient to avoid duplicate daemon connections that broke message routing

**Approach:** Standard approach

---

## Key Decisions

### Track channel WebSocket clients per workspace in cloud server
- **Chose:** Track channel WebSocket clients per workspace in cloud server
- **Reasoning:** Needed a way to broadcast channel events to the right workspace's clients

### Prefer userBridge over getRelayClient for channel subscription
- **Chose:** Prefer userBridge over getRelayClient for channel subscription
- **Reasoning:** Prevents creating duplicate relay connections that would conflict in the daemon

---

## Chapters

### 1. Work
*Agent: default*

- Track channel WebSocket clients per workspace in cloud server: Track channel WebSocket clients per workspace in cloud server
- Prefer userBridge over getRelayClient for channel subscription: Prefer userBridge over getRelayClient for channel subscription
