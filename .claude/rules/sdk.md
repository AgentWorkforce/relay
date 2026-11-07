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

- Broker client: `HarnessDriverClient` in `@agent-relay/harness-driver`
  (`packages/harness-driver/src/client.ts`) — owns broker startup, spawn/release,
  PTY/headless transports, and `connection.json` discovery.
- Workflows: the `relayflows` package (`../relayflows`), which consumes the
  broker through `@agent-relay/sdk`.

Keep application-level messaging on `@agent-relay/sdk`; reach for
`@agent-relay/harness-driver` only at the boundary that owns local agent processes.

## Facade API

```typescript
import { AgentRelay } from '@agent-relay/sdk';

const relay = new AgentRelay({ workspaceKey });

// register() returns a live agent client; messages are sent from a participant
const reviewer = await relay.workspace.register({ name: 'Reviewer', type: 'agent' });
await reviewer.sendMessage({ to: '#general', text: 'hello' });

// one listener entry point: dotted event name, wildcard, or a predicate
relay.addListener('message.created', ({ message, envelope }) => {
  console.log(envelope.from?.handle, message.text);
});
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

- **Primary**: MCP tools. The canonical names are flat — `send_dm`,
  `check_inbox`, `post_message`, `list_agents`, `add_agent`, `remove_agent`.
  A client may decorate them with the configured server key, so Claude Code
  users typically see `mcp__agent-relay__send_dm` while Codex and opencode see
  the bare name.
- Do **not** use the older category-expanded forms
  (`mcp__relaycast__message_dm_send`, `relaycast.message.dm.send`,
  `message.post`). They are not registered by `agent-relay mcp`.

## No Storage Layer

- There is NO storage package
- No SQLite, JSONL, or storage adapters
- Relaycast handles all message persistence
