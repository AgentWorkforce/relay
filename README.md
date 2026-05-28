<img src="https://agentrelay.com/readme-banners/relay.png" alt="Agent Relay">
<p align="center"><img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white"> <img alt="Python" src="https://img.shields.io/badge/Python-3776AB?style=flat-square&logo=python&logoColor=white"> <img alt="Swift" src="https://img.shields.io/badge/Swift-F05138?style=flat-square&logo=swift&logoColor=white"> <a href="https://github.com/AgentWorkforce/relay/actions/workflows/test.yml"><img alt="Tests" src="https://img.shields.io/github/actions/workflow/status/AgentWorkforce/relay/test.yml?branch=main&label=tests&style=flat-square"></a> <a href="https://github.com/AgentWorkforce/relay/commits/main"><img alt="Last commit" src="https://img.shields.io/github/last-commit/AgentWorkforce/relay/main?label=last%20commit&style=flat-square"></a> <a href="https://www.npmjs.com/package/@agent-relay/sdk"><img alt="npm version" src="https://img.shields.io/npm/v/@agent-relay/sdk?label=npm&style=flat-square"></a> <a href="https://www.npmjs.com/package/@agent-relay/sdk"><img alt="Downloads" src="https://img.shields.io/npm/dm/@agent-relay/sdk?label=downloads&style=flat-square"></a> <a href="./LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache%202.0-black?style=flat-square"></a></p>

`Agent Relay` is a framework for agent communication. Agents can message each other, coordinate work, and react to events as they happen.

Works with the tools and systems you already use.

Use it to build your own orchestrator, proactive agent, multi-agent workflows, or even just to avoid copy and pasting between claude code and codex!

## Overview

Agent Relay allows you to take advantage of:

- **Real-time messaging** <br/> Let Claude, Codex, Gemini, OpenCode, application agents, and human operators talk in the same workspace in real time.
- **Durable delivery** <br/>Track channel posts, direct messages, threads, read state, and delivery progress.
- **Action routing**<br/> Register and invoke typed commands so agents can ask other services or agents to perform work with structured inputs.

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
const complaintTriager = await claude.create({ model: 'sonnet' });
const engineer = await codex.create({ model: 'gpt-5.5' });
const taskManager = await myCustomHarness();

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

## How it works

Once registered, agents are put "on the relay" and get an identity

- `name`, `handle`, and stable `id`
- status such as `active`, `idle`, `blocked`, `waiting`, or `offline`
- channel memberships, direct-message inbox, and pending deliveries
- actions it can call and actions it provides
- transcripts of tool calls, file edits and other outputs

Messages are durable records first, and real-time events second.

Sending a message writes it to the Relay workspace, assigns it an id, resolves its target, records mentions and thread state, and creates delivery work for the target agents. WebSockets are how connected agents, apps, dashboards, and harness adapters hear about that write immediately.

That means message sending can happen a few different ways:

- **SDK:** apps and agents that embed `@agent-relay/sdk` call `relay.messages.send(...)`, `reply(...)`, `dm(...)`
- **MCP tools:** agents that cannot or should not embed the SDK call tools such as `send_message`, `reply`, `join_channel`, or `mark_read`
- **HTTP, webhooks, and actions:** services can create messages from API handlers, webhooks, action handlers, or UI callbacks.

While webSockets are the fast path for live coordination, they are not the only path. If an agent is connected, it can receive `message.created`, `delivery.*`, `action.*`, and `harness.*` events in real time. If it is offline or a harness does not support live subscriptions, the message remains in its inbox until the agent reconnects, polls, or a delivery adapter injects it.

### Agent Harnesses

A harness is any runtime boundary that can implement the Agent Relay runtime adapter: Claude Code or Codex in a terminal, an OpenCode server, an OpenClaw or Hermes agent, a browser app, or your own hosted agent.

The minimum contract is to receive a message, i.e. take a Relay message plus delivery context and report what happened.
The full harness contract also declares lifecycle, delivery modes, observable events, and optional actions.

> [!NOTE]
> Usually CLI harnesses like Claude Code and Codex will use injection and hooks to receive messages and mcp to send messages. However, as long as your harness implements the Agent Relay interface you can take advantage of it. Agent Relay **does not need to own the process** to get a harness on the relay.

#### Define a harness

We support many of the common harnesses with our optional [`@agent-relay/harnesses`](/packages/harnesses) package, but you can also define them yourself.

At a minimum a harness just needs to be able to create a session that can receive messages and be released.

```ts
type HarnessConfig<TInput = void> = {
  name: string;
  create(input: TInput, ctx: HarnessCreateContext): Promise<AgentSession>;
};

type AgentSession = {
  identity: AgentIdentity;
  capabilities: AgentSessionCapabilities;
  receiveMessage(message: RelayMessage, ctx: MessageContext): Promise<MessageReceipt>;
  release(reason?: string): Promise<void>;
};
```

#### Agent Session Capabilities

Every harness may not be able to support all the possible features supported by Agent Relay. For example, Claude code's hooks are much more robust and enable more features than Codex.

The minimum capabilities required:

```ts
const capabilities: AgentSessionCapabilities = {
  messaging: { receive: true },
  delivery: { modes: ['immediate'] },
  events: { emits: ['status.changed'] },
  lifecycle: { release: true },
};
```

The full list of capabilities support by Agent Relay:

```ts
type AgentSessionCapabilities = {
  messaging: {
    receive: true;
    send?: boolean;
    attachments: Array<'text' | 'image'>;
  };

  delivery: {
    modes: Array<'immediate' | 'next-message' | 'next-tool-call' | 'on-idle' | 'manual'>;
    queue?: boolean;
  };

  events: {
    emits: AgentSessionEventType[];
  };

  actions?: {
    invoke?: boolean;
    expose?: boolean;
  };

  lifecycle: {
    release: true;
    pause?: boolean;
    resume?: boolean;
    fork?: boolean;
    snapshot?: boolean;
  };
};
```

#### Agent Session Events

The list of supported harness events are as follows

```ts
type AgentSessionEventType =
  | 'status.changed'
  | 'status.idle'
  | 'status.active'
  | 'status.blocked'
  | 'status.waiting'
  | 'status.offline'
  | 'tool.called'
  | 'tool.completed'
  | 'tool.failed'
  | 'tool.output'
  | 'message.received'
  | 'message.sent'
  | 'delivery.accepted'
  | 'delivery.delivered'
  | 'delivery.deferred'
  | 'delivery.failed'
  | 'action.invoked'
  | 'action.completed'
  | 'action.failed'
  | 'action.denied'
  | 'transcript.chunk'
  | 'file.changed'
  | 'command.started'
  | 'command.completed'
  | 'command.failed'
  | 'terminal.output'
  | 'terminal.screen'
  | 'usage.updated'
  | 'session.started'
  | 'session.released'
  | 'session.resumed'
  | 'session.forked'
  | 'log'
  | 'error';
```

### Message Delivery

Delivery context is how Relay tells a session why a message exists and when it should be delivered. Delivery modes are semantic. Relay does not need to know whether a harness uses a PTY, headless app server, SDK callback, webhook, or queue underneath.

```ts
type DeliveryMode = 'immediate' | 'next-message' | 'next-tool-call' | 'on-idle' | 'manual';

type MessageContext = {
  id: string;
  mode: DeliveryMode;
  reason: 'message' | 'mention' | 'dm' | 'thread-reply' | 'action-result' | 'notification';
  priority?: 'normal' | 'urgent';
  deadline?: Date | string;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
};

type MessageReceipt =
  | { status: 'accepted'; deliveryId: string; retryable?: boolean; metadata?: Record<string, unknown> }
  | { status: 'delivered'; deliveryId: string; metadata?: Record<string, unknown> }
  | {
      status: 'deferred';
      deliveryId?: string;
      availableAt: Date | string;
      reason?: string;
      metadata?: Record<string, unknown>;
    }
  | {
      status: 'failed';
      deliveryId?: string;
      reason: string;
      retryable?: boolean;
      metadata?: Record<string, unknown>;
    };
```

The important pieces are:

| Piece                              | Required    | Purpose                                                                                           |
| ---------------------------------- | ----------- | ------------------------------------------------------------------------------------------------- |
| `HarnessConfig.name`               | Yes         | Stable harness identity for configuration, logs, and debugging.                                   |
| `HarnessConfig.init(...)`          | Optional    | Prepare shared resources before sessions are created.                                             |
| `HarnessConfig.create(...)`        | Yes         | Create a Relay session. The harness may spawn, attach, register, connect, or allocate underneath. |
| `AgentSession.identity`            | Yes         | Stable `id`, `name`, and `handle`; no status or capability state lives here.                      |
| `AgentSession.capabilities`        | Yes         | Declares what this created session can receive, emit, invoke, expose, and release.                |
| `AgentSession.receiveMessage(...)` | Yes         | Delivers a durable Relay message to the session and returns an explicit receipt.                  |
| `AgentSession.onEvent(...)`        | Recommended | Streams session observations into the Relay listener system.                                      |
| `AgentSession.release(...)`        | Yes         | Reverses what `create(...)` did: stop, detach, archive, or mark released.                         |

Session events are what make listeners and supervision work. The core event names should be stable, even if each harness has different raw logs:

```ts
type TranscriptChunk = {
  id: string;
  at: Date;
  role: 'agent' | 'user' | 'system' | 'tool';
  content: string;
  sequence: number;
  metadata?: Record<string, unknown>;
};

type AgentSessionEvent =
  | {
      type: 'status.changed';
      status: 'active' | 'idle' | 'blocked' | 'waiting' | 'offline';
      reason?: string;
    }
  | { type: 'tool.called'; run?: string; tool: string; input?: unknown }
  | { type: 'tool.completed'; run?: string; tool: string; output?: unknown; durationMs?: number }
  | { type: 'tool.failed'; run?: string; tool: string; error: string }
  | { type: 'transcript.chunk'; chunk: TranscriptChunk }
  | { type: 'file.changed'; path: string; operation: 'create' | 'update' | 'delete'; diff?: string }
  | { type: 'terminal.output'; stream?: 'stdout' | 'stderr' | 'combined'; text: string }
  | { type: 'error'; error: string; code?: string; retryable?: boolean };
```

Harnesses should redact secrets before emitting events, make duplicate delivery IDs idempotent, preserve event ordering per session, and return stable unsubscribe functions from every event subscription. That lets Agent Relay safely expose observations to other agents, humans, and MCP tools without requiring every runtime to behave the same way internally.

### Managed Harnesses

Agent Relay supports Claude Code, Codex and OpenCode. We're open to contributions for more managed harnesses!

## Learn More

Learn more about some of the key concepts:

- [Messaging](https://agentrelay.com/docs/messaging)
- [Delivery]()
- [Harness]()
- [Actions]()

## Messaging

Messaging is the shared conversation layer. It covers agents, humans, channels, direct messages, group DMs, threads, reactions, inbox state, read receipts, mentions, and attachments.

Messages are durable coordination records. A message is not just text; it is an addressable unit of work:

```ts
const message = await relay.messages.send({
  to: '#customer-complaints',
  from: taskManager,
  text: `${engineer.handle} please turn the top billing complaint into a PR.`,
  mentions: [engineer],
  mode: 'wait',
  attachments: [
    { type: 'link', url: 'https://linear.app/acme/issue/BILL-123' },
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
- What attachments were bundled with the request?

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
