# Trajectory: Fix cloud channel communication for human users

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** January 20, 2026 at 03:51 PM
> **Completed:** January 20, 2026 at 03:52 PM

---

## Summary

Fixed cloud channel communication: 1) Added subscribe_channels to usePresence hook to trigger daemon channel proxy, 2) Normalized channel IDs with # prefix for consistency between API and daemon, 3) Added workspace client tracking for channel_created broadcasts. Messages now flow to all cloud users in real-time without duplicate channels or manual refresh.

**Approach:** Standard approach

---

## Key Decisions

### Added subscribe_channels message to usePresence hook
- **Chose:** Added subscribe_channels message to usePresence hook
- **Reasoning:** Frontend was using usePresence for WebSocket connection but never sent subscribe_channels message, so setupDaemonChannelProxy was never triggered and channel messages weren't forwarded to cloud users

### Normalized channel IDs to include # prefix in API responses
- **Chose:** Normalized channel IDs to include # prefix in API responses
- **Reasoning:** Channel IDs had format mismatch: API stored 'foobar' but daemon used '#foobar'. This caused duplicate channels in UI and messages not appearing until re-selecting channel because selectedChannelId didn't match event.channel

### Added channelClientsByWorkspace tracking for channel event broadcasting
- **Chose:** Added channelClientsByWorkspace tracking for channel event broadcasting
- **Reasoning:** When new channels are created, all connected clients in the workspace need to be notified via WebSocket broadcast so the channel appears in their UI without page refresh

### Used workspace.publicUrl for daemon channel proxy connection
- **Chose:** Used workspace.publicUrl for daemon channel proxy connection
- **Reasoning:** The daemon and userBridge run on the workspace server, not the cloud server. Must connect to workspace.publicUrl to reach the correct daemon instance where agents are spawned

---

## Chapters

### 1. Work
*Agent: default*

- Added subscribe_channels message to usePresence hook: Added subscribe_channels message to usePresence hook
- Normalized channel IDs to include # prefix in API responses: Normalized channel IDs to include # prefix in API responses
- Added channelClientsByWorkspace tracking for channel event broadcasting: Added channelClientsByWorkspace tracking for channel event broadcasting
- Used workspace.publicUrl for daemon channel proxy connection: Used workspace.publicUrl for daemon channel proxy connection
