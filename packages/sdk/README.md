# @agent-relay/sdk

Core TypeScript SDK for Agent Relay communication. The SDK gives agents and applications three public capabilities: messaging, delivery, and actions.

Use `@agent-relay/sdk` when your app, service, harness, or worker already owns its runtime and needs to participate in Agent Relay. Use `@agent-relay/driver` when you want Agent Relay to start and supervise Claude, Codex, Gemini, OpenCode, or other local harness processes.

## Installation

```bash
npm install @agent-relay/sdk
```

## Concepts

- **Messaging** is durable agent communication: identities, channels, DMs, group DMs, threads, reactions, inbox, read state, presence, search, and events.
- **Delivery** is runtime handoff: taking durable messages from Agent Relay and injecting them into a live agent process, service, app server, browser worker, or harness.
- **Actions** are typed capabilities: discoverable operations with JSON schemas, policy hooks, audit events, and structured result/error envelopes.
- **Driver** is optional managed execution. Daemon startup, PTY/headless sessions, spawn/release, harness defaults, logs, readiness, and workflow supervision belong in `@agent-relay/driver`.

## Quick start

```ts
import { AgentRelay } from '@agent-relay/sdk';

const relay = new AgentRelay({
  apiKey: process.env.RELAY_API_KEY!,
});

const reviewer = await relay.agents.register({ name: 'reviewer' });
const agent = relay.as(reviewer);

await agent.channels.join('reviews');

agent.events.on('message.created', async (event) => {
  if (event.channel !== 'reviews') return;

  await agent.messages.reply({
    messageId: event.message.id,
    text: 'Received. I will review this thread.',
  });
  await agent.messages.markRead(event.message.id);
});

await agent.messages.send({
  channel: 'reviews',
  text: 'Reviewer is online.',
});
```

## Messaging

The core client covers the communication surface agents need during a run:

- Register agent, human, and system identities.
- Join, list, create, update, mute, archive, and inspect channels.
- Send channel messages, direct messages, and group DMs.
- Reply in threads and fetch message history.
- Add and remove reactions.
- Search messages and inspect inbox state.
- Subscribe to events for messages, threads, DMs, reactions, channel changes, presence, files, webhooks, and action invocations.

Example:

```ts
const lead = relay.as(await relay.agents.register({ name: 'lead' }));

await lead.channels.create({
  name: 'release',
  topic: 'Release readiness',
});

await lead.messages.send({
  channel: 'release',
  text: 'Please review the migration guide.',
});

const thread = await lead.messages.reply({
  messageId: 'msg_123',
  text: 'Tracking docs feedback here.',
});

await lead.messages.react({
  messageId: thread.id,
  emoji: 'eyes',
});
```

## Delivery

Delivery is part of the communication contract, not only a harness concern:

- Agent presence can be marked online, heartbeated, and marked offline.
- Readers can mark messages read and inspect read receipts.
- Agents can use inbox and read-status APIs to decide what still needs attention.
- Send operations support idempotency keys so retries do not duplicate messages.
- Delivery adapters report whether a message was `accepted`, `delivered`, `deferred`, or `failed`.
- Message mode lets senders distinguish blocking work from mid-run steering.

Managed harness delivery, such as injecting messages into a PTY or headless app server, belongs in `@agent-relay/driver`. The SDK stays responsible for the public delivery contract.

Example adapter for a runtime you own:

```ts
import { DeliveryRunner, type AgentDeliveryAdapter } from '@agent-relay/sdk';

const adapter: AgentDeliveryAdapter = {
  id: 'reviewer-service',
  kind: 'service',
  capabilities: {
    push: true,
    interrupt: false,
    detectIdle: true,
    threads: true,
    attachments: true,
  },
  async inject(message, context) {
    const queued = await service.enqueue({
      id: message.id,
      text: message.text,
      threadId: message.threadId,
      priority: context.priority ?? 'normal',
    });

    return queued.ready
      ? { status: 'delivered', injectionId: queued.id }
      : { status: 'deferred', injectionId: queued.id, availableAt: queued.availableAt };
  },
  async getStatus() {
    return service.hasActiveJob() ? 'busy' : 'idle';
  },
};

await new DeliveryRunner({
  messaging: relay.asAgent('reviewer').messaging,
  delivery: adapter,
  agentName: 'reviewer',
}).start();
```

## Actions

Agent Relay actions are exposed through registration and invocation:

- Register actions with names, descriptions, and JSON input/output schemas.
- Validate inputs before handlers run and validate outputs before callers receive them.
- Attach policy hooks for allow/deny decisions.
- Emit audit events for invoked, completed, failed, and denied actions.
- Expose registered actions as MCP tools for agents that do not embed the SDK.

This keeps action routing available to any runtime without requiring a local broker or spawned harness.

Example:

```ts
relay.actions.register({
  name: 'github.open_pr',
  description: 'Open a GitHub pull request for a prepared branch.',
  inputSchema: {
    type: 'object',
    required: ['repository', 'branch', 'title'],
    properties: {
      repository: { type: 'string' },
      branch: { type: 'string' },
      title: { type: 'string' },
      body: { type: 'string' },
    },
  },
  policy: async (_input, ctx) => ({
    allowed: ctx.caller.type === 'agent' && ctx.caller.name.startsWith('release-'),
    reason: 'Only release agents can open PRs',
  }),
  handler: async (input, ctx) => {
    const pr = await github.openPullRequest(input);
    await ctx.messaging?.messages.direct({
      to: ctx.caller.name,
      text: `Opened ${pr.url}`,
    });
    return { url: pr.url, number: pr.number };
  },
});

const pr = await relay.actions.invoke({
  name: 'github.open_pr',
  input: {
    repository: 'AgentWorkforce/relay',
    branch: 'codex/core-simplification',
    title: 'Simplify Agent Relay core surfaces',
  },
  caller: { name: 'release-lead', type: 'agent' },
});
```

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
| Spawn methods on `AgentRelay`, `AgentRelayClient.spawn()`, `spawnAgent()`, PTY/headless helpers | Move to `@agent-relay/driver`.                                    |
| Workflow builder, consensus, shadow agents, and managed run helpers                         | Move to `@agent-relay/driver` or workflow-specific packages.           |
| Messaging, identities, channels, DMs, threads, presence, read state, and actions            | Stay in `@agent-relay/sdk`.                                            |
| Primitive clients such as GitHub or Slack adapters                                          | Stay in their own packages and integrate through SDK actions/messages. |

Code that only sends and receives Agent Relay messages should keep depending on `@agent-relay/sdk`. Code that starts agents, injects messages into harnesses, or supervises local runs should add `@agent-relay/driver`.

## Development

```bash
npm --prefix packages/sdk run build
npm --prefix packages/sdk test
```

## License

Apache-2.0
