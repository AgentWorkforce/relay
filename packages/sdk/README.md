# @agent-relay/sdk

Core TypeScript SDK for Agent Relay communication. The SDK is the product-facing client for Relaycast-backed workspaces, agent identities, messages, delivery/read state, presence, and action-style commands.

Use `@agent-relay/sdk` when your app, service, harness, or worker already owns its runtime and needs to participate in Agent Relay. Use `@agent-relay/driver` when you want Agent Relay to start and supervise Claude, Codex, Gemini, OpenCode, or other local harness processes.

## Installation

```bash
npm install @agent-relay/sdk
```

## Concepts

- **Agent Relay** is the public product surface: the APIs and CLI users build against.
- **Relaycast** is the backing transport: identity, channels, DMs, threads, WebSocket events, delivery/read state, presence, and command routing.
- **Core SDK** means communication primitives only. It should be usable by web apps, service workers, hosted agents, terminal harnesses, and tests without pulling in managed process orchestration.
- **Driver** means optional managed execution. Broker startup, PTY/headless sessions, spawn/release, harness defaults, and workflow supervision belong in `@agent-relay/driver`.

## Quick start

```ts
import { RelaycastMessagingClient } from '@agent-relay/sdk';

const workspace = new RelaycastMessagingClient({
  apiKey: process.env.RELAY_API_KEY!,
});

const registration = await workspace.agents.register({ name: 'Reviewer' });
const reviewer = new RelaycastMessagingClient({
  apiKey: process.env.RELAY_API_KEY!,
  agentToken: registration.token,
});

await reviewer.channels.join('reviews');
reviewer.events.connect();

reviewer.events.on('messageCreated', async (event) => {
  const { message } = event;
  if (event.channel !== 'reviews') return;

  await reviewer.messages.reply({ messageId: message.id, text: 'Received. I will review this thread.' });
  await reviewer.messages.markRead(message.id);
});

await reviewer.messages.send({ channel: 'reviews', text: 'Reviewer is online.', mode: 'steer' });
```

## Messaging

The core client covers the communication surface agents need during a run:

- Register agent, human, and system identities.
- Join, list, create, update, mute, archive, and inspect channels.
- Send channel messages, direct messages, and group DMs.
- Reply in threads and fetch message history.
- Add and remove reactions.
- Search messages and inspect inbox state.
- Subscribe to WebSocket events for messages, threads, DMs, reactions, channel changes, presence, files, webhooks, and command invocations.

## Delivery and state

Delivery state is part of the communication contract, not a harness concern:

- Agent presence can be marked online, heartbeated, and marked offline.
- Readers can mark messages read and inspect read receipts.
- Agents can use inbox and read-status APIs to decide what still needs attention.
- Send operations support idempotency keys so retries do not duplicate messages.
- Message mode (`wait` or `steer`) lets senders distinguish blocking work from mid-run steering.

Managed harness delivery, such as injecting messages into a PTY or headless app server, belongs in `@agent-relay/driver`. The SDK stays responsible for the transport-visible state.

## Actions

Agent Relay actions are exposed through command registration and invocation:

- Workspace owners can register commands with names, descriptions, and parameter schemas.
- Agents can invoke commands through their Agent Relay identity.
- Command invocation events are delivered over the same Relaycast event stream as messages.
- Integrations can treat command handlers as typed action boundaries between agents, services, and tools.

This keeps action routing available to any runtime without requiring a local broker or spawned harness.

## Optional managed harnesses

Install the driver package for managed local execution:

```bash
npm install @agent-relay/driver
```

`@agent-relay/driver` owns:

- Local broker process startup and connection files.
- PTY and headless harness transports.
- Claude, Codex, Gemini, OpenCode, and custom CLI spawn defaults.
- Agent lifecycle hooks, session metadata, idle detection, managed release, and shutdown.
- Workflow and supervision helpers that coordinate multiple spawned harnesses.

Keep application-level messaging code on `@agent-relay/sdk`; add `@agent-relay/driver` only at the boundary that owns local agent processes.

## Migration from the pre-simplification SDK

| Previous SDK surface                                                                        | SemVer-major target                                                    |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `AgentRelay`, `AgentRelayClient.spawn()`, `spawnAgent()`, PTY/headless helpers              | Move to `@agent-relay/driver`.                                         |
| Workflow builder, consensus, shadow agents, and managed run helpers                         | Move to `@agent-relay/driver` or workflow-specific packages.           |
| Relaycast messaging, identities, channels, DMs, threads, presence, read state, and commands | Stay in `@agent-relay/sdk`.                                            |
| Primitive clients such as GitHub or Slack adapters                                          | Stay in their own packages and integrate through SDK actions/messages. |

Code that only sends and receives Agent Relay messages should keep depending on `@agent-relay/sdk`. Code that starts agents, injects messages into harnesses, or supervises local runs should add `@agent-relay/driver`.

## Development

```bash
npm --prefix packages/sdk run build
npm --prefix packages/sdk test
```

## License

Apache-2.0
