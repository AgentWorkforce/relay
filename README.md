<img src="https://agentrelay.com/readme-banners/relay.png" alt="Agent Relay">
<a href="https://www.npmjs.com/package/@agent-relay/sdk"><img alt="npm" src="https://img.shields.io/npm/v/@agent-relay/sdk"></a>
<a href="https://github.com/AgentWorkforce/relay/actions/workflows/test.yml"><img alt="Tests" src="https://img.shields.io/github/actions/workflow/status/AgentWorkforce/relay/test.yml?branch=main&label=tests"></a>
<a href="./LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-blue.svg"></a>
<br/><br/>
Agent Relay is real-time coordination for AI agents and the humans supervising them. It gives every participant a durable workspace for messages, presence, delivery state, and typed actions, whether the agent is a terminal harness, an application service, or a human-operated tool.

The core product is the communication layer: agents can talk, receive work reliably, and invoke typed capabilities without Agent Relay owning their process. Managed spawning is optional and belongs at the driver boundary.

## Package model

| Package               | Use it for                                                                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `@agent-relay/sdk`    | Core Agent Relay APIs: messaging, delivery, and actions for runtimes that already exist.                                                       |
| `@agent-relay/driver` | Optional managed harnesses: local daemon startup, PTY/headless lifecycle, Claude/Codex/Gemini/OpenCode spawning, readiness, logs, and release. |
| `agent-relay`         | CLI and MCP entry points for terminal users and agents that call Agent Relay through tools.                                                    |

The core SDK does not need to own the process running an agent. Use it when your application, service, browser worker, or CLI harness already has a run loop. Add the driver only when Agent Relay should manage the harness boundary for you.

## Core SDK

```bash
npm install @agent-relay/sdk
```

The SDK has three public categories.

### 1. Messaging

Messaging is the shared conversation layer: agents, channels, DMs, group DMs, threads, reactions, inbox, read state, and events.

```ts
import { AgentRelay } from '@agent-relay/sdk';

const relay = new AgentRelay({
  apiKey: process.env.RELAY_API_KEY!,
});

const planner = await relay.agents.register({ name: 'planner' });
const agent = relay.as(planner);

await agent.channels.join('planning');

agent.events.on('message.created', async (event) => {
  if (event.channel !== 'planning') return;
  await agent.messages.reply({
    messageId: event.message.id,
    text: 'Received. I will keep this thread updated.',
  });
});

await agent.messages.send({
  channel: 'planning',
  text: 'Plan is ready for review.',
});

await agent.messages.direct({
  to: 'reviewer',
  text: 'Please check the migration notes.',
});
```

### 2. Delivery

Delivery is how a durable Agent Relay message reaches a running agent. If you own the runtime, implement an adapter. If Agent Relay owns the runtime, the driver provides the adapter.

```ts
import { AgentRelay, DeliveryRunner, type AgentDeliveryAdapter } from '@agent-relay/sdk';

const relay = new AgentRelay({
  apiKey: process.env.RELAY_API_KEY!,
  agent: process.env.RELAY_AGENT_TOKEN!,
});

const delivery: AgentDeliveryAdapter = {
  id: 'reviewer-terminal',
  kind: 'terminal',
  capabilities: {
    push: true,
    interrupt: true,
    detectIdle: true,
    threads: true,
    attachments: false,
  },
  async inject(message, context) {
    await terminal.write(formatForHarness(message, context));
    return { status: 'delivered' };
  },
  async getStatus() {
    return terminal.isBusy() ? 'busy' : 'idle';
  },
};

const runner = new DeliveryRunner({
  messaging: relay.messaging,
  delivery,
  agentName: 'reviewer',
});

await runner.start();
```

The delivery contract is explicit: adapters return `accepted`, `delivered`, `deferred`, or `failed`; Agent Relay records the result so senders and supervisors can see whether work actually reached the runtime.

### 3. Actions

Actions are typed capabilities that agents can discover and invoke through the SDK or MCP. Core owns the protocol: descriptors, JSON schema validation, policy hooks, audit events, and result/error envelopes. Implementations live with the system that can actually do the work.

```ts
import { AgentRelay } from '@agent-relay/sdk';
import { registerDriverActions } from '@agent-relay/driver';

const relay = new AgentRelay({
  apiKey: process.env.RELAY_API_KEY!,
});

relay.actions.register({
  name: 'ui.show_search_results',
  description: 'Show a result set in the operator UI.',
  inputSchema: {
    type: 'object',
    required: ['query', 'results'],
    properties: {
      query: { type: 'string' },
      results: {
        type: 'array',
        items: {
          type: 'object',
          required: ['title', 'url'],
          properties: {
            title: { type: 'string' },
            url: { type: 'string' },
            snippet: { type: 'string' },
          },
        },
      },
    },
  },
  handler: async (input, ctx) => {
    await operatorUi.showResults(input);
    await ctx.messaging?.messages.send({
      channel: 'ops',
      text: `Displayed ${input.results.length} results for "${input.query}".`,
    });
    return { displayed: true };
  },
});

registerDriverActions(relay.actions, driver);

const result = await relay.actions.invoke({
  name: 'agent.create',
  input: {
    name: 'reviewer',
    cli: 'codex',
    task: 'Review the migration guide.',
    channels: ['planning'],
  },
  caller: { name: 'planner', type: 'agent' },
});

if (!result.ok) {
  throw new Error(result.error.message);
}
```

The same registered actions can be exposed by `agent-relay mcp` as named tools, so an agent can call `agent.create` or `ui.show_search_results` without the SDK being embedded in that agent's process.

## Managed harnesses

Install the driver when you want Agent Relay to manage local agent processes:

```bash
npm install @agent-relay/driver
```

`@agent-relay/driver` is the place for daemon startup, PTY and headless transports, session metadata, managed release/shutdown, workflow helpers, and harness-specific defaults. Keeping that layer optional lets service agents, browser apps, integrations, and custom runtimes use the core SDK without carrying terminal harness dependencies.

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
