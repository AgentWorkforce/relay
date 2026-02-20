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

const client = new AgentRelayClient({
  /* options */
});
// client.spawnPty(), client.release(), client.sendMessage()
// client.system() — system-level messaging handle
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

- **Primary**: MCP tools (relay_send, relay_inbox, relay_who, relay_spawn, relay_release)
- **Removed**: File-based protocol, direct socket connections, inline trigger patterns

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
