# Trajectory: Fix cloud channel/message routing to use workspace.publicUrl

> **Status:** ✅ Completed
> **Confidence:** 85%
> **Started:** January 19, 2026 at 08:49 AM
> **Completed:** January 19, 2026 at 08:50 AM

---

## Summary

Fixed three routing issues in cloud mode: 1) wssChannels now uses workspace.publicUrl to connect to correct daemon, 2) direct_message type now forwarded through proxy, 3) /api/channels/message routes to workspace server. All fixes include fallback to getLocalDashboardUrl for local mode compatibility.

**Approach:** Standard approach

---

## Key Decisions

### wssChannels proxy used getLocalDashboardUrl instead of workspace.publicUrl
- **Chose:** wssChannels proxy used getLocalDashboardUrl instead of workspace.publicUrl
- **Reasoning:** Same bug pattern as wssLogs that was fixed previously. Cloud dashboard connects to localhost:3889 which doesn't exist on cloud server - should connect to workspace server where daemon runs

### Added direct_message type forwarding to wssChannels proxy
- **Chose:** Added direct_message type forwarding to wssChannels proxy
- **Reasoning:** Proxy only forwarded channel_message and presence types - direct_message from agents was silently dropped. Also removed broken targetUser check for channel_message

### Added workspace-aware routing for /api/channels/message endpoint
- **Chose:** Added workspace-aware routing for /api/channels/message endpoint
- **Reasoning:** User messages need to go to the workspace daemon where agents are connected - using workspaceId from request body to lookup workspace.publicUrl

---

## Chapters

### 1. Work
*Agent: default*

- wssChannels proxy used getLocalDashboardUrl instead of workspace.publicUrl: wssChannels proxy used getLocalDashboardUrl instead of workspace.publicUrl
- Added direct_message type forwarding to wssChannels proxy: Added direct_message type forwarding to wssChannels proxy
- Added workspace-aware routing for /api/channels/message endpoint: Added workspace-aware routing for /api/channels/message endpoint
