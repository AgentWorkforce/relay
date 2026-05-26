---
paths:
  - 'packages/sdk/src/**/*.ts'
---

# SDK Conventions

## Package Identity

- Package: `@agent-relay/sdk` (NOT `@agent-relay/broker-sdk`)
- Main client: `AgentRelayClient` in `packages/sdk/src/client.ts`
- Workflows: `packages/sdk/src/workflows/`

## Client API

```typescript
import { AgentRelayClient } from '@agent-relay/sdk';

// Remote broker
const client = new AgentRelayClient({ baseUrl, apiKey });

// Connect to an already-running local broker (reads connection.json)
const client = AgentRelayClient.connect({ cwd: '/my/project' });

// Spawn a local broker and connect
const client = await AgentRelayClient.spawn({ cwd: '/my/project' });

// client.spawnPty(), client.spawnProvider(), client.release(), client.sendMessage()
```

## Agent Class

- `.status` getter for current agent status
- `.onOutput()` for per-agent output streaming

## Workflows

Located in `packages/sdk/src/workflows/`:

- `builder.ts` — WorkflowBuilder API
- `runner.ts` / `coordinator.ts` — execution engine
- `templates.ts` — built-in templates (fan_out, pipeline, dag)
- `types.ts` — workflow type definitions
- `schema.json` — workflow validation schema

## Communication Protocol

- **Primary**: MCP tools (mcp**relaycast**message_dm_send, mcp**relaycast**message_inbox_check, mcp**relaycast**agent_list, mcp**relaycast**agent_add, mcp**relaycast**agent_remove)

## Exports

The SDK uses subpath exports:

- `@agent-relay/sdk` — main entry
- `@agent-relay/sdk/client` — client only
- `@agent-relay/sdk/protocol` — protocol types
- `@agent-relay/sdk/workflows` — workflow builder

## No Storage Layer

- There is NO storage package (removed)
- No SQLite, JSONL, or storage adapters
- Relaycast handles all message persistence
