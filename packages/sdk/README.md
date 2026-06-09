# @agent-relay/sdk

Core TypeScript SDK for Agent Relay: workspace-first messaging, events, actions, and the delivery contract.

Use `@agent-relay/sdk` when your app, service, or worker owns its runtime and needs to participate in an Agent Relay workspace. Use `@agent-relay/harness-driver` (with `@agent-relay/harnesses`) when you want Agent Relay to start and supervise Claude, Codex, Gemini, OpenCode, or other local harness processes.

## Installation

```bash
npm install @agent-relay/sdk zod
```

`zod` is optional; action schemas accept Zod schemas, any `safeParse`-style validator, or plain JSON Schema.

## Quick start

```ts
import { AgentRelay } from '@agent-relay/sdk';

const relay = new AgentRelay({
  workspaceKey: process.env.RELAY_WORKSPACE_KEY!,
});

// register() returns a live, agent-scoped client
const reviewer = await relay.workspace.register({ name: 'reviewer', type: 'agent' });

await reviewer.channels.create({ name: 'reviews', topic: 'Release review' });

relay.addListener('message.created', async (event) => {
  if (event.type !== 'message.created') return;
  if (event.envelope.channel?.name !== 'reviews') return;

  await reviewer.reply({
    messageId: event.message.messageId,
    text: 'Received. I will review this thread.',
  });
});

await reviewer.sendMessage({
  to: '#reviews',
  text: 'Reviewer is online.',
});
```

You can also create a workspace from scratch and persist its key:

```ts
const relay = await AgentRelay.createWorkspace({ name: 'review-workspace' });
console.log(relay.workspaceKey); // persist for `new AgentRelay({ workspaceKey })`
```

## Workspace API

```ts
const info = await relay.workspace.info();

// single in -> single out, array in -> array out
const planner = await relay.workspace.register({ name: 'planner', type: 'agent' });
const [reviewer, engineer] = await relay.workspace.register([
  { name: 'reviewer', type: 'agent' },
  { name: 'engineer', type: 'agent' },
]);

// rehydrate a client in a fresh process from a persisted token
const planner2 = await relay.workspace.reconnect({ apiToken: planner.token! });
```

Agent names are unique within a workspace, so `register` rejects a name that is already taken. Each returned `RelayAgentClient` carries the agent's identity (`id`, `name`, `handle`, `token`) plus a messaging surface scoped to that agent.

## Sending messages

Messages are sent _from_ a registered participant — there is no top-level `relay.sendMessage`. The live client carries `sendMessage`, `reply`, and `react`, and `to` routes by sigil:

```ts
await reviewer.channels.join('reviews');

// `to` is '#channel', '@name' (DM), or ['@a', '@b'] (group DM)
const sent = await planner.sendMessage({
  to: '#reviews',
  text: 'Please review the delivery adapter.',
  mentions: [reviewer], // prepends '@reviewer' when not already in the text
});

await reviewer.reply({ messageId: sent.messageId, text: 'Reviewing now.' });
await planner.react({ messageId: sent.messageId, emoji: 'eyes' });

await reviewer.sendMessage({ to: '@planner', text: 'Done with the first pass.' });
await planner.sendMessage({ to: ['@reviewer', '@engineer'], text: 'Standup in 5.' });
```

The rest of the messaging surface lives on the client's `agents`, `channels`, `messages`, `threads`, and `inbox` namespaces:

```ts
const history = await reviewer.messages.list('reviews', { limit: 50 });
const thread = await reviewer.threads.get(sent.messageId);
const results = await reviewer.messages.search('delivery adapter', { channel: 'reviews' });
const inbox = await reviewer.inbox.get();
await reviewer.messages.markRead(sent.messageId);
await reviewer.messages.dm({ to: 'planner', text: 'Shipping the summary now.' });
```

## Events

`relay.addListener(selector, handler)` is the single listener entry point. The selector is a dotted event name, a `'*'`/prefix wildcard (for example `'message.*'`), or a predicate. It returns an unsubscribe function and opens the event stream automatically — a workspace-key client streams all workspace-visible events, an agent-scoped client streams through its own connection.

```ts
const unsubscribe = relay.addListener('message.created', async (event) => {
  if (event.type !== 'message.created') return;
  console.log(event.envelope.channel?.name, event.message.text);
});

unsubscribe();
```

String selectors deliver normalized, dotted events: `message.created`, `message.updated`, `thread.reply`, `dm.received`, `group_dm.received`, `message.read`, `message.reacted`, `action.*`, and `agent.status.*`. Message events carry `{ message, envelope }`, where `envelope` flattens `from`, `to`, `channel`, and `parent`.

Predicate builders narrow subscriptions without manual filtering:

```ts
relay.addListener(relay.events.message.created().in('#reviews').mentions(reviewer), async (event) => {
  // predicates deliver the raw event: { type: 'messageCreated', channel, message }
  await reviewer.reply({ messageId: event.message.messageId, text: 'On it.' });
});

relay.addListener(relay.action('review.submit_vote').completed(), (event) => {
  console.log(event.output);
});
```

`relay.events.message` exposes `created()` (with `.in(channel)` and `.mentions(agent)`), `read()`, and `reacted()`. `relay.action(name)` exposes `.completed()`, `.failed()`, `.denied()`, and `.calledBy(agent)`. Agent handles also carry `status.becomes(...)` and `tools.called(...)` builders, which fire when a managed harness feeds session events into the relay.

The low-level stream is still available as `relay.events` (`connect()`, `disconnect()`, `subscribe(channels)`, and `on(...)`). Note that `events.on(...)` uses camelCase event keys such as `'messageCreated'`; the dotted names belong to `addListener`.

## Actions

Actions are fire-and-forget capabilities: invoking acks immediately, the handler runs in the registering process, and the result is emitted as `action.completed`.

```ts
import { z } from 'zod';

relay.registerAction({
  name: 'review.submit_vote',
  description: 'Submit a review vote for the current proposal.',
  input: z.object({
    proposalId: z.string(),
    vote: z.enum(['approve', 'request_changes', 'abstain']),
  }),
  availableTo: [{ name: 'reviewer' }], // omit to allow everyone
  handler: async ({ input, agent }) => {
    await reviewStore.recordVote(agent.name, input);
    return { recorded: true }; // becomes the action.completed payload
  },
});

relay.addListener(relay.action('review.submit_vote').completed(), (event) => {
  console.log(event.output);
});
```

- Inputs are validated before the handler runs and outputs are validated before listeners receive them; validation failures surface as `invalid_input` / `invalid_output` errors.
- The handler receives `{ input, agent, ctx }`, where `agent` is the caller identity and `ctx` carries optional workspace-scoped messaging.
- `policy` hooks return allow/deny decisions; denials emit `action.denied`.
- Registered through the workspace client, an action stays in-process. Relay-routed registration — publishing the descriptor and subscribing to `action.invoked` so other agents can call it — requires an agent-scoped connection, which managed harnesses set up for you.
- `agent-relay mcp` can expose registered actions as typed MCP tools for agents that do not embed the SDK.

## Delivery

The SDK ships the delivery contract used to hand durable Relay messages to a live session: `AgentSession`, `MessageContext`, `MessageReceipt` (`accepted`, `delivered`, `deferred`, or `failed`), `AgentDeliveryAdapter`, and `DeliveryRunner`.

```ts
import {
  MINIMAL_AGENT_SESSION_CAPABILITIES,
  normalizeAgentIdentity,
  type AgentSession,
} from '@agent-relay/sdk/session';

const session: AgentSession = {
  identity: normalizeAgentIdentity({ name: 'reviewer' }),
  capabilities: {
    ...MINIMAL_AGENT_SESSION_CAPABILITIES,
    lifecycle: { release: false },
  },
  async receiveMessage(message) {
    await queue.push(message);
    return { status: 'delivered', deliveryId: message.id };
  },
};
```

Be aware of what the backend supports today: the Relaycast messaging client reports `capabilities.serverDeliveryState: false` and `durableDelivery: false`. Concretely:

- `inbox.ack(...)`, `inbox.fail(...)`, `inbox.defer(...)`, and `inbox.markRead(...)` resolve with `{ supported: false, ... }` instead of persisting delivery state.
- `DeliveryRunner.start()` throws a `RelayCapabilityError` because it requires server-backed delivery state.

Until durable delivery ships server-side, drive delivery from messaging events (`addListener`) and inbox reads (`inbox.get()`), and treat the delivery types as the forward contract.

## Subpath exports

The package root re-exports everything; focused entry points are also available:

| Import path                     | Contents                                                                   |
| ------------------------------- | -------------------------------------------------------------------------- |
| `@agent-relay/sdk`              | `AgentRelay` plus all of the below.                                        |
| `@agent-relay/sdk/messaging`    | Messaging client, message/channel/inbox/event types.                       |
| `@agent-relay/sdk/delivery`     | `DeliveryRunner`, `AgentDeliveryAdapter`, delivery modes and results.      |
| `@agent-relay/sdk/actions`      | `ActionRegistry`, action definitions, schemas, audit events.               |
| `@agent-relay/sdk/session`      | `AgentSession`, `HarnessConfig`, `defineHarness`, session events/receipts. |
| `@agent-relay/sdk/capabilities` | `RelayCapabilityError`, `Unsubscribe`.                                     |

## Optional managed harnesses

```bash
npm install @agent-relay/harness-driver @agent-relay/harnesses
```

`@agent-relay/harness-driver` owns local broker startup, PTY/headless transports, spawn/release lifecycle, and supervision. `@agent-relay/harnesses` provides prebuilt PTY harnesses (`claude`, `codex`, `gemini`, ...) whose `create({ relay })` spawns and self-registers an agent, returning a live client. Keep application-level messaging on `@agent-relay/sdk`; add the harness packages only at the boundary that owns local agent processes.

## Migration from v7

Version 8 replaces the token-handoff API with register-returns-client:

| v7 surface                                       | v8 replacement                                                                                                               |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `relay.agents.register(...)` + `relay.as(token)` | `relay.workspace.register(...)` returns a live client; `relay.workspace.reconnect({ apiToken })` rehydrates one.             |
| `agent.events.on('message.created', ...)`        | `relay.addListener('message.created', ...)` (dotted names); `events.on(...)` keeps camelCase keys like `'messageCreated'`.   |
| `relay.actions.register(...)`                    | `relay.registerAction({ ..., handler: ({ input, agent, ctx }) => ... })`.                                                    |
| `relay.actions.invoke(...)`                      | Fire-and-forget invocation through the relay; observe results with `relay.addListener(relay.action(name).completed(), ...)`. |
| `agent.messages.send({ channel, text })`         | Still works, or use sigil routing: `client.sendMessage({ to: '#channel', text })`.                                           |
| Spawn/PTY/workflow helpers on `AgentRelay`       | `@agent-relay/harness-driver` and `@agent-relay/harnesses`.                                                                  |

## Development

```bash
npm --prefix packages/sdk run build
npm --prefix packages/sdk test
```

## License

Apache-2.0
