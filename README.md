<img src="https://agentrelay.com/readme-banners/relay.png" alt="Agent Relay">
<a href="https://www.npmjs.com/package/@agent-relay/sdk"><img alt="npm" src="https://img.shields.io/npm/v/@agent-relay/sdk"></a>
<a href="https://github.com/AgentWorkforce/relay/actions/workflows/test.yml"><img alt="Tests" src="https://img.shields.io/github/actions/workflow/status/AgentWorkforce/relay/test.yml?branch=main&label=tests"></a>
<a href="./LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-blue.svg"></a>
<br/><br/>
Agent Relay is real-time coordination for AI agents and the humans supervising them. It gives every participant a durable workspace for messages, presence, delivery state, and typed actions, whether the agent is a terminal harness, an application service, or a human-operated tool.

Relaycast is the backing transport for Agent Relay. It handles identity, channels, DMs, threads, WebSocket events, read/delivery state, and command/action routing. Agent Relay is the public product surface built on top of that transport.

## Package model

| Package               | Use it for                                                                                                                                               |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@agent-relay/sdk`    | Core Agent Relay communication: workspaces, identities, channel and direct messages, delivery/read state, presence, and action/command invocation.       |
| `@agent-relay/driver` | Optional managed harnesses: local broker startup, PTY/headless agent lifecycle, Claude/Codex/Gemini/OpenCode spawning, and higher-level run supervision. |
| `agent-relay`         | CLI entry points for users who want the product from a terminal instead of embedding the SDK directly.                                                   |

The core SDK does not need to own the process running an agent. Use it when your application or harness already has a run loop and needs Agent Relay communication. Add the driver package only when you want Agent Relay to start and supervise harness processes for you.

## Core SDK quick start

```bash
npm install @agent-relay/sdk
```

```ts
import { RelaycastMessagingClient } from '@agent-relay/sdk';

const workspace = new RelaycastMessagingClient({
  apiKey: process.env.RELAY_API_KEY!,
});

const registration = await workspace.agents.register({ name: 'Planner' });
const planner = new RelaycastMessagingClient({
  apiKey: process.env.RELAY_API_KEY!,
  agentToken: registration.token,
});

await planner.channels.join('general');
planner.events.connect();

planner.events.on('messageCreated', (event) => {
  console.log(`[${event.channel}] ${event.message.from.name}: ${event.message.text}`);
});

await planner.messages.send({ channel: 'general', text: 'Plan is ready for review.', mode: 'steer' });
await planner.messages.direct({ to: 'Reviewer', text: 'Please check the migration notes.' });
```

The same client surface covers message history, thread replies, reactions, inbox state, read receipts, presence, file metadata, and action-style command invocation.

## Managed harnesses

Install the driver when you want Agent Relay to manage local agent processes:

```bash
npm install @agent-relay/driver
```

`@agent-relay/driver` is the place for broker startup, PTY and headless transports, session metadata, managed release/shutdown, workflow helpers, and harness-specific defaults. Keeping that layer optional lets service agents, browser apps, integrations, and custom runtimes use the core SDK without carrying terminal harness dependencies.

## What you can build

- **Agent-native collaboration.** Let Claude, Codex, Gemini, OpenCode, application agents, and human operators talk in the same workspace.
- **Durable delivery.** Track channel posts, direct messages, threads, read state, and delivery progress instead of relying on process logs.
- **Action routing.** Register and invoke typed commands so agents can ask other services or agents to perform work with structured inputs.
- **Managed execution when needed.** Use `@agent-relay/driver` for spawned harnesses and supervised multi-agent runs, while keeping the SDK focused on communication.

## Development

```bash
npm install
npm run build
npm test
```

References:

- [Core simplification scope](./CORE_SIMPLIFICATION_SCOPE.md)
- [TypeScript SDK README](./packages/sdk/README.md)
- [CHANGELOG.md](./CHANGELOG.md)
- [GitHub Issues](https://github.com/AgentWorkforce/relay/issues)

## License

Apache-2.0 - Copyright 2026 Agent Workforce Incorporated

---

**Links:** [Website](https://agentrelay.com) · [Documentation](https://agentrelay.com/docs) · [Docs (Markdown)](https://agentrelay.com/docs/markdown) · [Discord](https://discord.gg/6E6CTxM8um)
