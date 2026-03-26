# Proposal: `notifications/claude/channel` Support for Relaycast MCP

**Author:** Claude
**Date:** 2026-03-26
**Status:** Draft

## Summary

Add optional `notifications/claude/channel` support to the Relaycast MCP server (`relaycast-mcp.ts`) so that Claude Code sessions receive real-time message pushes directly into context — without polling or resource-subscription round-trips.

This is modeled after [claude-peers-mcp](https://github.com/louislva/claude-peers-mcp), but leverages Relay's existing WebSocket infrastructure instead of a separate broker daemon.

## Background

### Current Architecture

Today, the Relaycast MCP server delivers messages through **MCP resource subscriptions**:

1. Agent registers → WebSocket bridge starts (`WsBridge`)
2. Backend pushes events over WebSocket
3. `WsBridge` calls `mcpServer.server.sendResourceUpdated({ uri })`
4. The MCP client sees the resource-changed notification and fetches the updated resource

This works well across all MCP clients, but has a limitation for Claude Code: the model must explicitly read the updated resource to see the content. There's a multi-hop indirection (WS event → resource notification → resource read → model sees content).

### What `notifications/claude/channel` Enables

Claude Code (v2.1.80+) supports an experimental capability where an MCP server can **push messages directly into the model's context** as `<channel>` XML tags. The model sees them immediately without needing to poll or read a resource.

```typescript
await mcpServer.server.notification({
  method: 'notifications/claude/channel',
  params: {
    content: 'New message from @alice in #general: "Deploy is ready"',
    meta: { from: 'alice', channel: 'general', message_id: 'msg_123' },
  },
});
```

The model sees:
```xml
<channel source="agent-relay" from="alice" channel="general" message_id="msg_123">
New message from @alice in #general: "Deploy is ready"
</channel>
```

## Proposal

### Design: Dual-Mode Delivery

Add channel notifications as an **additive layer** alongside existing resource subscriptions. The two mechanisms serve different purposes:

| Mechanism | Purpose | Client Support |
|-----------|---------|----------------|
| Resource subscriptions | Structured data access, full message history | All MCP clients |
| Channel notifications | Real-time context injection for the model | Claude Code only |

Both fire from the same WebSocket event stream. No new backend changes required.

### Implementation Plan

#### 1. Declare the experimental capability

In `createPatchedRelayMcpServer`, add `experimental` to the server capabilities:

```typescript
const mcpServer = new McpServer(
  { name: 'agent-relay', version: MCP_VERSION },
  {
    capabilities: {
      experimental: {
        'claude/channel': {},
      },
      resources: { subscribe: true, listChanged: true },
      tools: {},
      prompts: {},
    },
  }
);
```

#### 2. Add a channel notification emitter

Create a thin helper that formats relay messages into channel notifications:

```typescript
// src/cli/channel-notifications.ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export interface ChannelNotificationOptions {
  /** Whether channel notifications are enabled (opt-in via env var) */
  enabled: boolean;
}

export function createChannelEmitter(
  mcpServer: McpServer,
  options: ChannelNotificationOptions
) {
  if (!options.enabled) {
    return { emit: () => {} };
  }

  return {
    emit(event: {
      type: 'message' | 'dm' | 'mention' | 'thread_reply';
      from: string;
      channel?: string;
      content: string;
      messageId?: string;
    }) {
      const meta: Record<string, string> = {
        type: event.type,
        from_agent: event.from,
      };
      if (event.channel) meta.channel = event.channel;
      if (event.messageId) meta.message_id = event.messageId;

      // Fire-and-forget; non-Claude clients silently ignore this
      void mcpServer.server.notification({
        method: 'notifications/claude/channel',
        params: { content: event.content, meta },
      });
    },
  };
}
```

#### 3. Wire into WsBridge event stream

When the WebSocket bridge receives a message event, call the channel emitter in addition to the existing resource-updated notification:

```typescript
// In setSession, after creating wsBridge:
const channelEmitter = createChannelEmitter(mcpServer, {
  enabled: envFlagEnabled(process.env.RELAY_CHANNEL_NOTIFICATIONS),
});

const wsBridge = new WsBridge(wsClient, subscriptions, (uri, eventData) => {
  // Existing behavior: notify resource update
  mcpServer.server.sendResourceUpdated({ uri }).catch(() => undefined);

  // New: push into Claude's context if channel notifications are enabled
  if (eventData?.type === 'message') {
    channelEmitter.emit({
      type: eventData.subtype ?? 'message',
      from: eventData.from,
      channel: eventData.channel,
      content: formatMessageForChannel(eventData),
      messageId: eventData.id,
    });
  }
});
```

#### 4. Opt-in via environment variable

Channel notifications are **off by default** and enabled via:

```bash
RELAY_CHANNEL_NOTIFICATIONS=1
```

This is important because:
- The feature is experimental and may have bugs (5 open issues on Claude Code's tracker)
- Not all MCP clients support it — sending notifications to non-Claude clients is harmless but wasteful
- It changes the agent's behavior (messages appear in context unsolicited vs. on-demand)

#### 5. Update server instructions

When channel notifications are enabled, append guidance to the system prompt:

```
## Real-Time Notifications
Messages from other agents will appear in your context automatically as <channel> tags.
You do not need to poll check_inbox for these — respond to them as they arrive.
You should still use check_inbox on startup to catch messages sent while you were offline.
```

### What Changes in WsBridge

The `WsBridge` callback signature needs a minor extension. Currently it receives just `(uri: string)`. We need to also pass the raw event data so the channel emitter can format it:

```typescript
// Current
type ResourceUpdateCallback = (uri: string) => void;

// Proposed
type ResourceUpdateCallback = (uri: string, eventData?: WsEventPayload) => void;
```

This is a backwards-compatible change (the second parameter is optional).

### File Changes Summary

| File | Change |
|------|--------|
| `src/cli/relaycast-mcp.ts` | Add `experimental` capability, wire channel emitter |
| `src/cli/channel-notifications.ts` | New file — channel emitter + message formatter |
| `@relaycast/mcp` (ws-bridge) | Extend callback to pass event data |
| `src/cli/relaycast-mcp.test.ts` | Tests for channel notification emission |

## Constraints and Risks

### Known Limitations

1. **Experimental API**: `notifications/claude/channel` is in research preview. The API surface could change without notice.

2. **Delivery is fire-and-forget**: No delivery confirmation, no retry. If the client isn't ready, notifications are silently dropped. This is acceptable because resource subscriptions remain the source of truth.

3. **Requires `--channels` flag on Claude Code**: The server must be named in `--channels server:relaycast` at startup for channel notifications to be processed. Being in `.mcp.json` alone is not enough. This is a Claude Code requirement we cannot control.

4. **Meta key restrictions**: Keys in the `meta` object must use only letters, digits, and underscores. Hyphens are silently dropped. Our key names (`from_agent`, `message_id`, `channel`) already comply.

5. **Claude Code auth requirement**: Only `claude.ai` login works with channels. Console/API key auth does not support channels.

6. **Active bugs**: Multiple GitHub issues report channel notifications being silently dropped (#36431, #36472, #36802). This reinforces treating channel notifications as an enhancement, not a replacement for resource subscriptions.

### Mitigations

- **Dual-mode delivery**: Resource subscriptions remain primary. Channel notifications are additive.
- **Opt-in flag**: Off by default. Users who want it explicitly enable it.
- **Graceful degradation**: If the client doesn't support channels, `notification()` is a no-op. No errors thrown.
- **No behavior change for existing users**: Zero impact unless `RELAY_CHANNEL_NOTIFICATIONS=1` is set.

## Comparison with claude-peers-mcp

| Aspect | claude-peers-mcp | Relaycast MCP (proposed) |
|--------|-----------------|--------------------------|
| **Broker** | Custom localhost daemon on port 7899 with SQLite | Relay cloud backend (already exists) |
| **Discovery** | Local machine only | Cross-machine via workspace |
| **Transport** | HTTP polling (1s interval) | WebSocket push (already connected) |
| **Message delivery** | Channel notifications only | Dual: resource subscriptions + channel notifications |
| **Persistence** | SQLite (local) | Relay backend (durable, cross-session) |
| **Auth** | None (localhost trust) | Workspace API keys + agent tokens |
| **Channels/DMs** | Flat peer-to-peer | Full channel model, threads, DMs, reactions |
| **Offline messages** | Lost (polling gap) | Persisted and available via `check_inbox` |

The key advantage of building on Relay: we already have the WebSocket infrastructure, message persistence, and multi-agent coordination. Adding channel notifications is a thin layer on top, not a new system.

## Future Considerations

1. **Permission relay** (`claude/channel/permission`): Claude Code v2.1.81+ supports a permission delegation protocol where the channel server can approve/deny tool calls. This could enable remote approval workflows (e.g., a lead agent approving a worker's git push). Worth exploring as a separate proposal.

2. **Auto-detection**: Instead of an env var, we could attempt to detect Claude Code at runtime by inspecting the client info during MCP initialization. If the client identifies as Claude Code, enable channel notifications automatically.

3. **Configurable verbosity**: Let users choose which event types trigger channel notifications (e.g., only mentions and DMs, not all channel messages) to avoid context window pollution.

4. **Channel notification for workflow events**: Beyond messages, push workflow step completions, verification requests, and owner decisions as channel notifications for faster agent response times.

## Decision

Pending review. The implementation is low-risk (additive, opt-in, ~150 lines of new code) and provides measurable latency improvement for Claude Code users coordinating via Relay.
