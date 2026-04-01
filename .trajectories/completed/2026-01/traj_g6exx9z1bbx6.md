# Trajectory: Fix cloud channel routing for agent messages

> **Status:** ✅ Completed
> **Task:** cloud-message-routing-fix
> **Confidence:** 90%
> **Started:** January 19, 2026 at 08:58 AM
> **Completed:** January 19, 2026 at 08:58 AM

---

## Summary

Fixed cloud message routing - wssChannels, /api/channels/message, and direct_message forwarding now use workspace.publicUrl where agents run. Root cause was incomplete fix in add4194 that only fixed wssLogs but left wssChannels broken.

**Approach:** Standard approach

---

## Key Decisions

### Identified root cause: wssChannels routing left broken after wssLogs fix
- **Chose:** Identified root cause: wssChannels routing left broken after wssLogs fix
- **Reasoning:** Commit 5569296 broke both wssLogs and wssChannels. Commit add4194 only fixed wssLogs, leaving wssChannels routing to getLocalDashboardUrl() instead of workspace.publicUrl

### Fixed wssChannels to use workspace.publicUrl
- **Chose:** Fixed wssChannels to use workspace.publicUrl
- **Reasoning:** Agents run on workspace server, so channel WebSocket must connect there (same pattern as wssLogs fix)

### Added direct_message type forwarding
- **Chose:** Added direct_message type forwarding
- **Reasoning:** wssChannels proxy was silently dropping direct_message type, only forwarding channel_message. Agent DMs weren't reaching cloud users.

### Fixed /api/channels/message to be workspace-aware
- **Chose:** Fixed /api/channels/message to be workspace-aware
- **Reasoning:** POST messages were going to localhost instead of workspace where daemon/agents run

---

## Chapters

### 1. Work
*Agent: default*

- Identified root cause: wssChannels routing left broken after wssLogs fix: Identified root cause: wssChannels routing left broken after wssLogs fix
- Fixed wssChannels to use workspace.publicUrl: Fixed wssChannels to use workspace.publicUrl
- Added direct_message type forwarding: Added direct_message type forwarding
- Fixed /api/channels/message to be workspace-aware: Fixed /api/channels/message to be workspace-aware
