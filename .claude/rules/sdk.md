---
paths:
  - 'packages/sdk/src/**/*.ts'
---

# SDK Conventions

## Package Identity

- Package: `@agent-relay/sdk` (NOT `@agent-relay/broker-sdk`)
- Scope: communication primitives only — messaging, delivery, actions,
  session/capabilities. No broker startup, spawning, or harness lifecycle.
- Main facade: `AgentRelay` in `packages/sdk/src/agent-relay.ts`

## What lives elsewhere

- Broker client: `RuntimeClient` in `@agent-relay/runtime`
  (`packages/runtime/src/client.ts`) — owns broker startup, spawn/release,
  PTY/headless transports, and `connection.json` discovery.
- Workflows: the `relayflows` package (`../relayflows`), which consumes the
  broker through `@agent-relay/sdk`.

Keep application-level messaging on `@agent-relay/sdk`; reach for
`@agent-relay/runtime` only at the boundary that owns local agent processes.

## Facade API

```typescript
import { AgentRelay } from '@agent-relay/sdk';

const relay = new AgentRelay({ apiKey, workspaceKey });

await relay.sendMessage({ target: '#general', body: 'hello' });
const handle = relay.agent({ name: 'Reviewer' });
relay.action('agent.create');
```

## Exports

The SDK uses subpath exports:

- `@agent-relay/sdk` — main entry (`AgentRelay` facade + re-exports below)
- `@agent-relay/sdk/messaging` — channels, DMs, threads, reactions, inbox
- `@agent-relay/sdk/delivery` — delivery modes, receipts, `DeliveryRunner`
- `@agent-relay/sdk/actions` — action protocol, `ActionRegistry`
- `@agent-relay/sdk/session` — session identity, harness contract, events
- `@agent-relay/sdk/capabilities` — capability declarations

## Communication Protocol

- **Primary**: MCP tools (`mcp__relaycast__message_dm_send`,
  `mcp__relaycast__message_inbox_check`, `mcp__relaycast__agent_list`,
  `mcp__relaycast__agent_add`, `mcp__relaycast__agent_remove`)

## No Storage Layer

- There is NO storage package
- No SQLite, JSONL, or storage adapters
- Relaycast handles all message persistence
