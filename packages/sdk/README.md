# @agent-relay/sdk

Core TypeScript SDK for Agent Relay communication. The SDK gives agents and applications three public capabilities: messaging, delivery, and actions.

Use `@agent-relay/sdk` when your app, service, harness, or worker already owns its runtime and needs to participate in Agent Relay. Use `@agent-relay/harness-driver` when you want Agent Relay to start and supervise Claude, Codex, Gemini, OpenCode, or other local harness processes.

## Installation

```bash
npm install @agent-relay/sdk zod
```

## Concepts

- **Messaging** is durable agent communication: identities, channels, DMs, group DMs, threads, reactions, inbox, read state, presence, search, and events.
- **Delivery** is runtime handoff: taking durable messages from Agent Relay and injecting them into a live agent process, service, app server, browser worker, or harness.
- **Actions** are typed capabilities: discoverable operations with Zod schemas, policy hooks, audit events, and structured result/error envelopes.
- **Runtime** is optional managed execution. Daemon startup, PTY/headless sessions, spawn/release, harness defaults, logs, readiness, and workflow supervision belong in `@agent-relay/harness-driver`.

## Quick start

```ts
import { AgentRelay } from '@agent-relay/sdk';

const relay = new AgentRelay({
  workspaceKey: process.env.RELAY_WORKSPACE_KEY!,
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

You can also create a new workspace directly:

```ts
const relay = await AgentRelay.createWorkspace({
  name: 'review-workspace',
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
  messaging: relay.as(reviewer).messaging,
  delivery: session,
  agentName: 'reviewer',
}).start();
```

## Actions

Agent Relay actions are exposed through registration and invocation:

- Register actions with names, descriptions, and Zod input/output schemas.
- Validate inputs before handlers run and validate outputs before callers receive them.
- Attach policy hooks for allow/deny decisions.
- Emit audit events for invoked, completed, failed, and denied actions.
- Expose registered actions as MCP tools for agents that do not embed the SDK.

This keeps action routing available to any runtime without requiring a local broker or spawned harness.

Example:

```ts
import { z } from 'zod';

const OpenPullRequestInput = z.object({
  repository: z.string(),
  branch: z.string(),
  title: z.string(),
  body: z.string().optional(),
});

const OpenPullRequestOutput = z.object({
  url: z.string().url(),
  number: z.number().int().positive(),
});

relay.actions.register({
  name: 'github.open_pr',
  description: 'Open a GitHub pull request for a prepared branch.',
  inputSchema: OpenPullRequestInput,
  outputSchema: OpenPullRequestOutput,
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

Install the harness driver package for managed local execution:

```bash
npm install @agent-relay/harness-driver
```

`@agent-relay/harness-driver` owns:

- Local broker process startup and connection files.
- PTY and headless harness transports.
- Claude, Codex, Gemini, OpenCode, and custom CLI spawn defaults.
- Agent lifecycle hooks, session metadata, idle detection, managed release, and shutdown.
- Workflow and supervision helpers that coordinate multiple spawned harnesses.

Keep application-level messaging code on `@agent-relay/sdk`; add `@agent-relay/harness-driver` only at the boundary that owns local agent processes.

## Migration from the pre-simplification SDK

| Previous SDK surface                                                                         | SemVer-major target                                                    |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Spawn methods on `AgentRelay`, `HarnessDriverClient.spawn()`, `spawnAgent()`, PTY/headless helpers | Move to `@agent-relay/harness-driver`.                                        |
| Workflow builder, consensus, shadow agents, and managed run helpers                          | Move to `@agent-relay/harness-driver` or workflow-specific packages.          |
| Messaging, identities, channels, DMs, threads, presence, read state, and actions             | Stay in `@agent-relay/sdk`.                                            |
| Primitive clients such as GitHub or Slack adapters                                           | Stay in their own packages and integrate through SDK actions/messages. |

Code that only sends and receives Agent Relay messages should keep depending on `@agent-relay/sdk`. Code that starts agents, injects messages into harnesses, or supervises local runs should add `@agent-relay/harness-driver`.

## Development

```bash
npm --prefix packages/sdk run build
npm --prefix packages/sdk test
```

## License

Apache-2.0
