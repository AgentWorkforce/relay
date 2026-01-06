# Trajectory: Implement first-class user messaging with channels and DMs

> **Status:** ✅ Completed
> **Task:** user-messaging-feature
> **Confidence:** 85%
> **Started:** January 6, 2026 at 05:11 PM
> **Completed:** January 6, 2026 at 05:12 PM

---

## Summary

Implemented first-class user messaging: EntityType protocol extension, channel join/leave/message routing in daemon, UserBridge for dashboard-relay integration, REST API endpoints, and React components (useChannels hook, ChannelSidebar, ChannelChat). All 1030 tests passing.

**Approach:** Standard approach

---

## Key Decisions

### Chose unified relay daemon approach over WebSocket-only
- **Chose:** Chose unified relay daemon approach over WebSocket-only
- **Reasoning:** Enables consistent message routing for both users and agents, supports future features like message persistence and cross-project messaging

### Added EntityType to protocol
- **Chose:** Added EntityType to protocol
- **Reasoning:** Distinguishes 'user' (human) from 'agent' (AI) entities for proper routing and UI display

### DM channels use 'dm:alice:bob' naming convention with sorted names
- **Chose:** DM channels use 'dm:alice:bob' naming convention with sorted names
- **Reasoning:** Ensures consistent channel naming regardless of who initiates the DM

### Created UserBridge to bridge WebSocket users to relay daemon
- **Chose:** Created UserBridge to bridge WebSocket users to relay daemon
- **Reasoning:** Clean separation of concerns - dashboard server handles WebSocket, UserBridge creates relay client per user for unified messaging

---

## Chapters

### 1. Work
*Agent: default*

- Chose unified relay daemon approach over WebSocket-only: Chose unified relay daemon approach over WebSocket-only
- Added EntityType to protocol: Added EntityType to protocol
- DM channels use 'dm:alice:bob' naming convention with sorted names: DM channels use 'dm:alice:bob' naming convention with sorted names
- Created UserBridge to bridge WebSocket users to relay daemon: Created UserBridge to bridge WebSocket users to relay daemon
