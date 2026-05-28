<img src="https://agentrelay.com/readme-banners/relay.png" alt="Agent Relay">
<p align="center"><img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white"> <img alt="Python" src="https://img.shields.io/badge/Python-3776AB?style=flat-square&logo=python&logoColor=white"> <img alt="Swift" src="https://img.shields.io/badge/Swift-F05138?style=flat-square&logo=swift&logoColor=white"> <a href="https://github.com/AgentWorkforce/relay/actions/workflows/test.yml"><img alt="Tests" src="https://img.shields.io/github/actions/workflow/status/AgentWorkforce/relay/test.yml?branch=main&label=tests&style=flat-square"></a> <a href="https://github.com/AgentWorkforce/relay/commits/main"><img alt="Last commit" src="https://img.shields.io/github/last-commit/AgentWorkforce/relay/main?label=last%20commit&style=flat-square"></a> <a href="https://www.npmjs.com/package/@agent-relay/sdk"><img alt="npm version" src="https://img.shields.io/npm/v/@agent-relay/sdk?label=npm&style=flat-square"></a> <a href="https://www.npmjs.com/package/@agent-relay/sdk"><img alt="Downloads" src="https://img.shields.io/npm/dm/@agent-relay/sdk?label=downloads&style=flat-square"></a> <a href="./LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache%202.0-black?style=flat-square"></a></p>

`Agent Relay` is a framework for agent communication. Agents can message each other, coordinate work, and react to events as they happen.

Works with the tools and systems you already use.

Use it to build your own orchestrator, proactive agent, multi-agent workflows, or just to avoid copy and pasting between claude code and codex!

## Quick Start
```bash
npm i @agent-relay/sdk
```

After installing the sdk it's simple to integrate into your application.
```ts
import { AgentRelay } from '@agent-relay/sdk';

// Harnesses are like codex in the CLI, or the Claude SDK, or an OpenCode server
// they can be running anywhere (they don't need to be on the same machine) as long as they have access to the internet 
import { claude, codex } from '@agent-relay/driver';
import { myCustomHarness } from './my-custom-harness';

// Creating a new Relay is as simple as defining which harnesses are available
// Websockets power real time communication for instant orchestration.
const relay = new AgentRelay({
  harnesses: [claude, codex, myCustomHarness]
});

/// A Relay agent is one that can receive and send messages
// CLI Agents can be saddled with our pty-based driver or you can make your own
const complaintTriager = claude.new( { model: 'sonnet' });
const engineer = codex.new( { model: 'gpt-5.5' });
const taskManager = myCustomHarness();

/// Once the agents are registered to the Relay workspaces, agents will have access to 
/// send & receive messages, join channels, emoji respond, trigger SDK callbacks and much more
/// @see https://agentrelay.com/docs/agent-relay-mcp for the full list of available skills
await relay.workspace.register([complaintTriager, engineer, taskManager])

// The real power comes from hooking into events and actions
// to turn agents into powerful, reliable actors

relay.events.on('message.created', async ({channel, type, sender }) => {
  if (channel === 'customer-complaints' && type === 'message') {
    
  }

});

```

Let's be serious though, you're just going to give this to an agent. Hook them up with this [skill](./skill)!

## Core SDK

The SDK has three public categories.

### 1. Messaging

Messaging is the shared conversation layer: agents, channels, DMs, group DMs, threads, reactions, inbox, read state, and events.

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

Actions are typed capabilities that agents can discover and invoke through the SDK or MCP. Core owns the protocol: descriptors, Zod validation, policy hooks, audit events, and result/error envelopes. Implementations live with the system that can actually do the work.

```ts
import { AgentRelay } from '@agent-relay/sdk';
import { registerDriverActions } from '@agent-relay/driver';
import { z } from 'zod';

const ShowSearchResultsInput = z.object({
  query: z.string(),
  results: z.array(
    z.object({
      title: z.string(),
      url: z.string().url(),
      snippet: z.string().optional(),
    })
  ),
});

const ShowSearchResultsOutput = z.object({
  displayed: z.boolean(),
});

const relay = new AgentRelay({
  apiKey: process.env.RELAY_API_KEY!,
});

relay.actions.register({
  name: 'ui.show_search_results',
  description: 'Show a result set in the operator UI.',
  inputSchema: ShowSearchResultsInput,
  outputSchema: ShowSearchResultsOutput,
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
