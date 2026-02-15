# Trajectory: Slack integration: merge unified-agent-auth, wire proxy, add agent routing

> **Status:** ✅ Completed
> **Confidence:** 80%
> **Started:** February 13, 2026 at 02:45 PM
> **Completed:** February 13, 2026 at 02:46 PM

---

## Summary

Full Slack integration wiring: merged auth branch, wired proxy resolver, added Dockerfile support, fixed migrations, updated dashboard UI, implemented agent routing from Slack mentions with auto-spawn

**Approach:** Standard approach

---

## Key Decisions

### Merged feature/unified-agent-auth into feature/slack-cli (relay-cloud) and slack-dashboard (relay-dashboard)
- **Chose:** Merged feature/unified-agent-auth into feature/slack-cli (relay-cloud) and slack-dashboard (relay-dashboard)
- **Reasoning:** Both branches needed the auth infrastructure for integration approval and audit logging

### Added Slack-specific connectionId resolution in proxy.ts using resolveSlackConnection
- **Chose:** Added Slack-specific connectionId resolution in proxy.ts using resolveSlackConnection
- **Reasoning:** Slack uses workspaceId but Nango needs nangoConnectionId — requires DB lookup via slack_workspace_connections table

### Added slack CLI binary to all three workspace Dockerfiles (Dockerfile, Dockerfile.local, Dockerfile.browser)
- **Chose:** Added slack CLI binary to all three workspace Dockerfiles (Dockerfile, Dockerfile.local, Dockerfile.browser)
- **Reasoning:** Agents running in workspace containers need the slack CLI to reply back to Slack threads

### Renumbered integration_auth migration from 0020 to 0021 to avoid collision with conversation_state migration
- **Chose:** Renumbered integration_auth migration from 0020 to 0021 to avoid collision with conversation_state migration
- **Reasoning:** Both slack-integration and unified-agent-auth branches independently created 0020 migrations

### Added postgres error code 42P01 handling in audit/approval endpoints to return empty results
- **Chose:** Added postgres error code 42P01 handling in audit/approval endpoints to return empty results
- **Reasoning:** Tables may not exist if migrations havent run yet — prevents 500 errors in pre-migration state

### Marked all integration providers as Coming Soon, removed GitHub, switched to 4-col grid, removed ApprovalRequestPanel and Unified Agent Auth banner
- **Chose:** Marked all integration providers as Coming Soon, removed GitHub, switched to 4-col grid, removed ApprovalRequestPanel and Unified Agent Auth banner
- **Reasoning:** Integration connect UI is not ready for production use yet, GitHub will use a different flow

### Moved AuditLogViewer from separate sidebar tab into bottom of Integrations section
- **Chose:** Moved AuditLogViewer from separate sidebar tab into bottom of Integrations section
- **Reasoning:** Audit log is part of the integration system, not a top-level settings section

### SlackIntegrationPanel now only shows channels where isMember is true
- **Chose:** SlackIntegrationPanel now only shows channels where isMember is true
- **Reasoning:** Users only care about channels the bot has joined, not all workspace channels

### Replaced unconfigured-channel error with routeToConnectedAgent that finds online daemons and routes to Lead agent
- **Chose:** Replaced unconfigured-channel error with routeToConnectedAgent that finds online daemons and routes to Lead agent
- **Reasoning:** When someone @mentions agent-relay in Slack, we should route to agents instead of showing an error

### Added spawn_agent command to daemon queue when no agents are connected but daemons are online
- **Chose:** Added spawn_agent command to daemon queue when no agents are connected but daemons are online
- **Reasoning:** If no Lead agent exists, spawn one automatically to handle the Slack message

---

## Chapters

### 1. Work
*Agent: default*

- Merged feature/unified-agent-auth into feature/slack-cli (relay-cloud) and slack-dashboard (relay-dashboard): Merged feature/unified-agent-auth into feature/slack-cli (relay-cloud) and slack-dashboard (relay-dashboard)
- Added Slack-specific connectionId resolution in proxy.ts using resolveSlackConnection: Added Slack-specific connectionId resolution in proxy.ts using resolveSlackConnection
- Added slack CLI binary to all three workspace Dockerfiles (Dockerfile, Dockerfile.local, Dockerfile.browser): Added slack CLI binary to all three workspace Dockerfiles (Dockerfile, Dockerfile.local, Dockerfile.browser)
- Renumbered integration_auth migration from 0020 to 0021 to avoid collision with conversation_state migration: Renumbered integration_auth migration from 0020 to 0021 to avoid collision with conversation_state migration
- Added postgres error code 42P01 handling in audit/approval endpoints to return empty results: Added postgres error code 42P01 handling in audit/approval endpoints to return empty results
- Marked all integration providers as Coming Soon, removed GitHub, switched to 4-col grid, removed ApprovalRequestPanel and Unified Agent Auth banner: Marked all integration providers as Coming Soon, removed GitHub, switched to 4-col grid, removed ApprovalRequestPanel and Unified Agent Auth banner
- Moved AuditLogViewer from separate sidebar tab into bottom of Integrations section: Moved AuditLogViewer from separate sidebar tab into bottom of Integrations section
- SlackIntegrationPanel now only shows channels where isMember is true: SlackIntegrationPanel now only shows channels where isMember is true
- Replaced unconfigured-channel error with routeToConnectedAgent that finds online daemons and routes to Lead agent: Replaced unconfigured-channel error with routeToConnectedAgent that finds online daemons and routes to Lead agent
- Added spawn_agent command to daemon queue when no agents are connected but daemons are online: Added spawn_agent command to daemon queue when no agents are connected but daemons are online
