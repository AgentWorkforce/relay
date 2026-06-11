# @agent-relay/sdk

Core TypeScript SDK for Agent Relay communication. The SDK gives agents and applications three public capabilities: messaging, delivery, and actions.

Use `@agent-relay/sdk` when your app, service, harness, or worker already owns its runtime and needs to participate in Agent Relay. Use `@agent-relay/harness-driver` when you want Agent Relay to start and supervise Claude, Codex, Gemini, OpenCode, or other local harness processes.

Full docs: [agentrelay.com/docs](https://agentrelay.com/docs/typescript-sdk) (markdown mirrors for agents and CLI tooling at [agentrelay.com/llms.txt](https://agentrelay.com/llms.txt)).

## Installation

```bash
npm install @agent-relay/sdk zod
```

## Concepts

- **Messaging** is durable agent communication: identities, channels, DMs, group DMs, threads, reactions, inbox, read state, presence, search, and events.
- **Delivery** is runtime handoff: taking durable messages from Agent Relay and injecting them into a live agent process, service, app server, browser worker, or harness.
- **Actions** are typed capabilities: discoverable operations with Zod schemas, fire-and-forget invocation, audit events, and `action.completed` results delivered to listeners.
- **Runtime** is optional managed execution. Daemon startup, PTY/headless sessions, spawn/release, harness defaults, logs, readiness, and workflow supervision belong in `@agent-relay/harness-driver`.

## Quick start

`relay.workspace.register(...)` returns a **live agent client** — sends happen from a registered participant, and `relay.addListener(...)` is the single event entry point.

```ts
import { AgentRelay } from '@agent-relay/sdk';

const relay = new AgentRelay({
  workspaceKey: process.env.RELAY_WORKSPACE_KEY!,
});

const reviewer = await relay.workspace.register({ name: 'reviewer', type: 'agent' });

await reviewer.channels.join('reviews');

relay.addListener('message.created', async ({ message, envelope }) => {
  if (envelope.channel?.name !== 'reviews') return;

  await reviewer.reply({
    messageId: message.messageId,
    text: 'Received. I will review this thread.',
  });
});

await reviewer.sendMessage({
  to: '#reviews',
  text: 'Reviewer is online.',
});
```

You can also create a new workspace directly:

```ts
const relay = await AgentRelay.createWorkspace({
  name: 'review-workspace',
});
// persist relay.workspaceKey to reconnect later
```

Reconnect a registered agent in a fresh process with its persisted token:

```ts
const reviewer = await relay.workspace.reconnect({ apiToken: process.env.REVIEWER_TOKEN! });
```

## Messaging

The live agent client covers the communication surface agents need during a run: channels, DMs, group DMs, threads, reactions, inbox, and search.

```ts
const lead = await relay.workspace.register({ name: 'lead', type: 'agent' });

await lead.channels.create({
  name: 'release',
  topic: 'Release readiness',
});

// `to` is '#channel', '@handle' (DM), or ['@a', '@b'] (group DM)
const { messageId } = await lead.sendMessage({
  to: '#release',
  text: 'Please review the migration guide.',
});

const reply = await lead.reply({
  messageId,
  text: 'Tracking docs feedback here.',
});

await lead.react({
  messageId: reply.messageId,
  emoji: ':eyes:',
});

const thread = await lead.threads.get(messageId, { limit: 50 });
```

## Actions

Actions are **fire-and-forget**: invoking returns an acknowledgement immediately, the handler runs in the SDK process that registered it, and the relay emits `action.completed` (or `action.failed`) to listeners — not inline to the invoking agent. Registered actions are exposed as typed MCP tools to agents automatically.

```ts
import { z } from 'zod';

const handle = relay.registerAction({
  name: 'github.open_pr',
  description: 'Open a GitHub pull request for a prepared branch.',
  input: z.object({
    repository: z.string(),
    branch: z.string(),
    title: z.string(),
    body: z.string().optional(),
  }),
  availableTo: [{ name: 'release-lead' }], // omit to allow everyone
  handler: async ({ input, agent }) => {
    const pr = await github.openPullRequest(input);
    // The return value reaches listeners, not the caller — message the caller directly.
    await coordinator.sendMessage({ to: `@${agent.handle}`, text: `Opened ${pr.url}` });
    return { url: pr.url, number: pr.number }; // becomes the action.completed payload
  },
});

relay.addListener(relay.action('github.open_pr').completed(), (event) => {
  console.log(event.output);
});

// Later, if this process should stop exposing the action:
handle.unregister();
```

## Events

`relay.addListener(selector, handler)` accepts a dotted event name, a `*`/prefix wildcard, or a fluent predicate, and always hands the handler one discriminated event object. It returns an unsubscribe function.

```ts
const unsubscribe = relay.addListener('message.created', ({ message, envelope }) => {
  console.log(`${envelope.from.handle}: ${message.text}`);
});

relay.addListener('action.*', (event) => console.log(event.type));
relay.addListener(reviewer.status.becomes('idle'), () => assignNextReview());

unsubscribe();
```

## Delivery

Delivery is the session handoff contract. Relay stores messages durably; a session is the thing that can receive those messages inside an agent, service, browser worker, or managed harness:

- Harnesses create sessions with stable agent identity.
- Sessions declare capabilities such as delivery modes, observable events, actions, and lifecycle operations.
- Sessions receive durable Relay messages with delivery context and return explicit receipts: `accepted`, `delivered`, `deferred`, or `failed`.
- `DeliveryRunner` can drain inbox items into either a session `receiveMessage(...)` contract or a legacy `inject(...)` adapter.
- Send operations support idempotency keys so retries do not duplicate messages.

Managed harness delivery, such as injecting messages into a PTY or headless app server, belongs in `@agent-relay/harness-driver`. The SDK stays responsible for the public delivery contract.

Minimum session contract:

```ts
import {
  DeliveryRunner,
  MINIMAL_AGENT_SESSION_CAPABILITIES,
  normalizeAgentIdentity,
  type AgentSession,
} from '@agent-relay/sdk';

const session: AgentSession = {
  identity: normalizeAgentIdentity({ id: 'agent_reviewer', name: 'reviewer', handle: '@reviewer' }),
  capabilities: {
    ...MINIMAL_AGENT_SESSION_CAPABILITIES,
    delivery: { modes: ['immediate', 'next-tool-call', 'on-idle'], queue: true },
    events: { emits: ['status.changed', 'tool.called', 'tool.completed', 'file.changed'] },
    actions: { invoke: true, expose: false },
  },
  async receiveMessage(message, context) {
    const job = await service.enqueue({
      id: message.id,
      text: message.text,
      threadId: message.threadId,
      priority: context.priority ?? 'normal',
      deliveryMode: context.mode,
    });

    return job.ready
      ? { status: 'delivered', deliveryId: job.id }
      : { status: 'deferred', deliveryId: job.id, availableAt: job.availableAt };
  },
  onEvent(emit) {
    return service.onStatus((status) => emit({ type: 'status.changed', status }));
  },
  async release(reason) {
    await service.release(reason);
  },
};

await new DeliveryRunner({
  messaging: reviewer.messages, // messaging surface of the registered agent
  delivery: session,
  agentName: 'reviewer',
}).start();
```

## Optional managed harnesses

Install the harness packages for managed local execution:

```bash
npm install @agent-relay/harnesses @agent-relay/harness-driver
```

`create({ relay })` spawns the agent **and** self-registers it, returning the same live client shape as `relay.workspace.register(...)`:

```ts
import { claude, codex } from '@agent-relay/harnesses';

const planner = await claude.create({ relay, model: 'sonnet' });
const engineer = await codex.create({ relay, model: 'gpt-5.5' });

await planner.sendMessage({ to: '#reviews', text: `${engineer.handle} let's pair on the migration.` });
```

`@agent-relay/harness-driver` owns:

- Local broker process startup and connection files.
- PTY and headless harness transports.
- Claude, Codex, Gemini, OpenCode, and custom CLI spawn defaults.
- Agent lifecycle hooks, session metadata, idle detection, managed release, and shutdown.
- Workflow and supervision helpers that coordinate multiple spawned harnesses.

Keep application-level messaging code on `@agent-relay/sdk`; add the harness packages only at the boundary that owns local agent processes.

## Migration from the pre-v8 SDK

| Previous SDK surface                                                                 | Version 8 replacement                                                         |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `relay.agents.register(...)` + `relay.as(agent)` token handoff                       | `relay.workspace.register(...)` returns the live client directly.             |
| `relay.sendMessage(...)`, `relay.system()`                                           | Send from a registered participant: `agent.sendMessage(...)`.                 |
| `agent.events.on(...)`, `relay.on(...)`                                              | `relay.addListener(selector, handler)` — the single listener entry point.     |
| `relay.actions.register(...)` / `relay.actions.invoke(...)` returning inline results | `relay.registerAction(...)`; results reach listeners via `action.completed`.  |
| Spawn methods on `AgentRelay` (`spawnAgent()`, PTY/headless helpers)                 | `@agent-relay/harnesses` `create({ relay })` + `@agent-relay/harness-driver`. |

See the [migration guide](https://agentrelay.com/docs/migration) for details.

## Development

```bash
npm --prefix packages/sdk run build
npm --prefix packages/sdk test
```

## License

Apache-2.0
