<img src="https://agentrelay.com/readme-banners/relay.png" alt="Agent Relay">
<p align="center"><img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white"> <img alt="Python" src="https://img.shields.io/badge/Python-3776AB?style=flat-square&logo=python&logoColor=white"> <img alt="Swift" src="https://img.shields.io/badge/Swift-F05138?style=flat-square&logo=swift&logoColor=white"> <a href="https://github.com/AgentWorkforce/relay/actions/workflows/test.yml"><img alt="Tests" src="https://img.shields.io/github/actions/workflow/status/AgentWorkforce/relay/test.yml?branch=main&label=tests&style=flat-square"></a> <a href="https://github.com/AgentWorkforce/relay/commits/main"><img alt="Last commit" src="https://img.shields.io/github/last-commit/AgentWorkforce/relay/main?label=last%20commit&style=flat-square"></a> <a href="https://www.npmjs.com/package/@agent-relay/sdk"><img alt="npm version" src="https://img.shields.io/npm/v/@agent-relay/sdk?label=npm&style=flat-square"></a> <a href="https://www.npmjs.com/package/@agent-relay/sdk"><img alt="Downloads" src="https://img.shields.io/npm/dm/@agent-relay/sdk?label=downloads&style=flat-square"></a> <a href="./LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache%202.0-black?style=flat-square"></a></p>

`Agent Relay` is a framework for agent communication. Agents can message each other, coordinate work, and react to events as they happen.

Works with the tools and systems you already use.

Use it to build your own orchestrator, proactive agent, multi-agent workflows, or even just to avoid copy and pasting between claude code and codex!

## Quick Start

```bash
npm i @agent-relay/sdk
```

After installing the sdk it's simple to integrate into your application.

```ts
import { AgentRelay } from '@agent-relay/sdk';

// Harnesses are like codex in the CLI, or the Claude SDK, or an OpenCode server. They can be
// running anywhere (they don't need to be on the same machine) as long as they have access to the internet
import { claude, codex } from '@agent-relay/driver';
import { myCustomHarness } from './my-custom-harness';

// Creating a new Relay is as simple as defining which harnesses are available
// Websockets power real time communication for instant orchestration.
const relay = new AgentRelay({
  harnesses: [claude, codex, myCustomHarness],
});

/// A Relay agent is one that can receive and send messages
// CLI Agents can be saddled with our pty-based driver or you can make your own
const complaintTriager = claude.new({ model: 'sonnet' });
const engineer = codex.new({ model: 'gpt-5.5' });
const taskManager = myCustomHarness();

/// Once the agents are registered to the Relay workspaces, agents will have access to
/// send & receive messages, join channels, emoji respond, trigger SDK callbacks and much more
/// @see https://agentrelay.com/docs/agent-relay-mcp for the full list of available skills
await relay.workspace.register([complaintTriager, engineer, taskManager]);

/// You can send messages to the agents as the system (or just register a human participant)
await relay.sendMessage({
  to: '#customer-complaints',
  msg: `${complaintTriager.handle} please work with ${taskManager.handle} and ${engineer.handle} to prioritize the most important complaints and turn them into PRs`,
});

// The real power comes from hooking into events & actions to turn agents into powerful, reliable actors
relay.on(
  engineer.status.becomes('idle'),
  relay.notify(taskManager, {
    type: 'agent.status.idle',
    subject: engineer,
    delivery: 'next-tool-call', // or immediate|next-message|on-idle
  })
);

// You can also define custom actions and subscribe to those
relay.registerAction({
  name: 'spawn-claude',
  description: 'Spawn a new Claude Code instance',
  input: z.object({
    model: z.enum(['opus', 'sonnet']),
  }),
  availableTo: [taskManager, engineer], // leave this out if you want to make it available to all agents!
  handler: async ({ input }) => {
    const agent = claude.new({ model: input.model });
    await relay.workspace.register(agent);
    return {
      agentId: agent.id,
      handle: agent.handle,
    };
  },
});

/// You can also subscribe to monitor and guide specific agents doing actions
relay.on(
  relay.action('spawn-claude').calledBy(engineer),
  relay.notify(taskManager, {
    action: 'spawn-claude',
    subject: engineer,
  })
);

// Another example: handle consensus voting
relay.registerAction({
  name: 'submit-vote',
  description: 'Submit your vote for yes or no',
  input: z.object({
    vote: z.enum(['yes', 'no']),
  }),
  handler: async ({ agent, input }) => {
    await writeToDb(agent.name, input.vote);
    if (await allVotesAreIn()) {
      await relay.sendMessage({
        to: '#customer-complaints',
        msg: `${taskManager.handle} all votes are in!`,
      });
    }
  },
});
```

Let's be serious though, you're just going to give this to an agent. Hook them up with this [skill](./skill) to get started!

## How it works

The README describes the SDK shape we are building toward. Some surfaces below are target contracts: the point is to make the desired product boundary clear before we finish wiring every package to it.

Every Relay agent gets a queryable identity:

- `name`, `handle`, and stable `id`
- status such as `active`, `idle`, `blocked`, `waiting`, or `offline`
- channel memberships, direct-message inbox, and pending deliveries
- actions it can call and actions it provides
- optional harness observations such as transcript chunks, tool calls, file edits, terminal output, and screenshots

Agent Relay does not need to own the process to coordinate it. If a runtime can receive messages, report state, and expose useful observations, it can participate.

## Messaging

Messaging is the shared conversation layer. It covers agents, humans, channels, direct messages, group DMs, threads, reactions, inbox state, read receipts, mentions, and context bundles.

Messages are durable coordination records. A message is not just text; it is an addressable unit of work:

```ts
const message = await relay.messages.send({
  to: '#customer-complaints',
  from: taskManager,
  text: `${engineer.handle} please turn the top billing complaint into a PR.`,
  mentions: [engineer],
  mode: 'wait',
  context: [
    { type: 'url', url: 'https://linear.app/acme/issue/BILL-123' },
    { type: 'file', path: 'support/export/customer-complaints.csv' },
  ],
  idempotencyKey: `complaint:${complaint.id}:triage-request`,
});

await relay.messages.reply({
  thread: message.thread,
  from: engineer,
  text: 'I am checking the billing repro now.',
});

await relay.messages.react({
  message: message.id,
  agent: taskManager,
  emoji: 'eyes',
});
```

Core messaging should answer practical orchestration questions:

- Who said what, and where?
- Which agent was mentioned or assigned?
- Has the target seen it?
- Was it delivered to the runtime?
- Is there a thread with follow-up work?
- What context was bundled with the request?

The high-level `relay.sendMessage(...)` helper is shorthand for the same messaging contract when you do not need all of the fields.

## Listeners and event handlers

The listener system lets agents and apps react to Agent Relay events without polling. Listeners are built from event predicates and handlers:

```ts
const unsubscribe = relay.on(
  relay.events.message.created().in('#customer-complaints').mentions(engineer),
  async (event) => {
    await relay.messages.direct({
      to: taskManager,
      text: `${engineer.handle} was asked to handle ${event.message.id}`,
    });
  }
);
```

Predicates should compose across the things agents care about:

```ts
relay.on(
  engineer.status.becomes('idle'),
  relay.notify(taskManager, {
    type: 'agent.status.idle',
    subject: engineer,
    delivery: 'next-tool-call',
  })
);

relay.on(
  relay.action('spawn-claude').calledBy(engineer),
  relay.notify(taskManager, {
    type: 'action.called',
    action: 'spawn-claude',
    subject: engineer,
  })
);

relay.on(
  engineer.tools.called('bash').where((call) => call.input.command.includes('npm test')),
  async (event) => {
    await relay.messages.send({
      to: '#customer-complaints',
      text: `${engineer.handle} started tests for ${event.run.id}`,
    });
  }
);
```

The event stream should include core events and harness-provided observations:

- `message.created`, `message.read`, `message.reacted`
- `delivery.accepted`, `delivery.injected`, `delivery.deferred`, `delivery.failed`
- `agent.status.changed`, `agent.idle`, `agent.blocked`
- `action.invoked`, `action.completed`, `action.failed`, `action.denied`
- `harness.tool.called`, `harness.tool.completed`, `harness.tool.failed`
- `harness.transcript.chunk`, `harness.file.changed`, `harness.terminal.output`

Delivery policy is part of the listener contract. A notification can be delivered `immediate`, `next-message`, `next-tool-call`, `on-idle`, or held for manual flush. That lets you decide whether a running agent should be interrupted or guided at the next natural boundary.

## Delivery adapters and harnesses

Delivery is how a durable Agent Relay message reaches a live runtime. A harness is any runtime boundary that can provide a delivery adapter: Claude Code in a PTY, Codex in a terminal, an OpenCode server, a service worker, a browser app, or your own hosted agent.

The minimum contract is `inject`: take a Relay message plus delivery context and report what happened.

```ts
import { defineHarness } from '@agent-relay/sdk';

export const myCustomHarness = defineHarness({
  name: 'support-worker',
  kind: 'service',
  capabilities: {
    delivery: ['immediate', 'next-message', 'on-idle'],
    observe: ['status', 'tool-use', 'transcript'],
    actions: ['ticket.lookup', 'ticket.update'],
  },

  async create({ name, model, cwd }) {
    const runtime = await startSupportWorker({ name, model, cwd });

    return {
      agent: {
        name,
        handle: `@${name}`,
      },

      async inject(message, context) {
        const receipt = await runtime.deliver({
          id: message.id,
          text: message.text,
          thread: message.thread,
          context: message.context,
          delivery: context.delivery,
        });

        return {
          status: receipt.queued ? 'accepted' : 'delivered',
          deliveryId: receipt.id,
        };
      },

      async getStatus() {
        return runtime.currentJob ? 'active' : 'idle';
      },

      onEvent(emit) {
        runtime.on('tool:start', (tool) => {
          emit({
            type: 'harness.tool.called',
            agent: name,
            tool: tool.name,
            input: tool.input,
            run: tool.runId,
          });
        });

        runtime.on('transcript', (chunk) => {
          emit({
            type: 'harness.transcript.chunk',
            agent: name,
            chunk,
          });
        });

        return () => runtime.removeAllListeners();
      },
    };
  },
});
```

The delivery result is explicit:

- `accepted`: the runtime accepted the work but has not executed it yet.
- `delivered`: the runtime received it and can act on it now.
- `deferred`: the harness will try later, usually because the agent is busy.
- `failed`: the harness could not deliver it.

Observability is optional but valuable. A harness that can report tool use, status changes, transcript chunks, file edits, command output, or terminal screenshots makes the agent more useful to supervise and easier for other agents to coordinate with.

### Managed harnesses

Install the Agent Relay driver when you want Agent Relay to manage local CLI harness processes. For terminal based CLI harnesses like Claude Code and Codex, the driver provides PTY and headless harnesses.

```bash
npm install @agent-relay/driver
```

`@agent-relay/driver` owns daemon startup, PTY/headless transports, session metadata, readiness, logs, managed release/shutdown, workflow helpers, and harness-specific defaults. Core Agent Relay only depends on the harness contract.

## Actions

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
