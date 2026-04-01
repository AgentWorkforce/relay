# Trajectory: Implement spawn readiness detection for SDK

> **Status:** ✅ Completed
> **Confidence:** 85%
> **Started:** January 30, 2026 at 08:45 PM
> **Completed:** January 30, 2026 at 08:49 PM

---

## Summary

Implemented WebSocket/browser transport for SDK with Transport abstraction, SocketTransport, WebSocketTransport, BrowserRelayClient, and auto-detection utilities

**Approach:** Standard approach

---

## Key Decisions

### Use AGENT_READY event broadcast approach
- **Chose:** Use AGENT_READY event broadcast approach
- **Reasoning:** The daemon already emits onActive when an agent connects. Adding an AGENT_READY message type that gets broadcast to interested connections is cleaner than polling or callbacks. The SDK can subscribe to these events and the spawn method can wait for the relevant AGENT_READY event before resolving.

### Create separate BrowserRelayClient instead of modifying existing RelayClient
- **Chose:** Create separate BrowserRelayClient instead of modifying existing RelayClient
- **Reasoning:** The existing RelayClient uses node:net and node:crypto directly, has complex write queue logic with setImmediate, and changing it would risk breaking existing users. Creating a new client allows clean browser support while maintaining full backwards compatibility.

### Add ws as optional dependency for Node.js WebSocket support
- **Chose:** Add ws as optional dependency for Node.js WebSocket support
- **Reasoning:** The ws package is needed for WebSocket in Node.js environments. Making it optional means browser users don't need to install it, and Node.js users who only use Unix sockets also don't need it.

---

## Chapters

### 1. Work
*Agent: default*

- Use AGENT_READY event broadcast approach: Use AGENT_READY event broadcast approach
- Create separate BrowserRelayClient instead of modifying existing RelayClient: Create separate BrowserRelayClient instead of modifying existing RelayClient
- Add ws as optional dependency for Node.js WebSocket support: Add ws as optional dependency for Node.js WebSocket support
