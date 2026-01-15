---
paths:
  - "src/cloud/server.ts"
  - "src/cloud/*.ts"
---

# Cloud WebSocket Routing - CRITICAL

## The Rule

**Agent logs WebSocket MUST route to `workspace.publicUrl`, NOT `getLocalDashboardUrl()`.**

## Why This Matters

Agents are spawned on the workspace server via:
```
POST ${workspace.publicUrl}/api/spawn
```

The spawner tracks workers in memory **on that specific server**. When the logs WebSocket connects, it checks `spawner.hasWorker(agentName)`. If the logs connect to a different server than where the agent was spawned, this check fails → **4404 Agent not found**.

## Correct Pattern

```typescript
// In wssLogs.on('connection') handler:

// ✅ CORRECT - Use workspace.publicUrl where agent runs
const dashboardUrl = workspace.publicUrl || await getLocalDashboardUrl();

// ❌ WRONG - This broke setup terminals!
const dashboardUrl = await getLocalDashboardUrl();
```

## Routing Table

| WebSocket Type | Endpoint | Target Server | Reason |
|----------------|----------|---------------|--------|
| **Agent Logs** | `/ws/logs/:workspaceId/:agentName` | `workspace.publicUrl` | Agent/spawner state lives on workspace |
| **Channels** | `/ws/channels/:workspaceId/:username` | `getLocalDashboardUrl()` | Channel state is local to daemon |
| **Presence** | `/ws/presence` | Local (no proxy) | Cloud server manages directly |

## History

This broke in commit `5569296` (Jan 13, 2026) when channel routing was changed to use `getLocalDashboardUrl()`. The logs WebSocket was accidentally changed along with channels.

**Symptoms when broken:**
- Setup terminals (`__setup__*`) fail with "Agent not found"
- Dashboard shows repeated WebSocket disconnections with code 4404
- Logs show: `[daemon] Logs WebSocket client disconnected (code: 4404, reason: Agent not found)`

## Tests

See `src/cloud/websocket-routing.test.ts` for tests that verify this routing requirement.

## When Modifying WebSocket Routing

1. **Check which WebSocket type you're modifying** (logs vs channels)
2. **Logs must use `workspace.publicUrl`** - the agent runs there
3. **Channels use `getLocalDashboardUrl()`** - channel state is local
4. **Run the routing tests**: `npm test -- src/cloud/websocket-routing.test.ts`
5. **Test setup terminals manually** after changes to cloud WebSocket routing
