# @agent-relay/fleet

Fleet node SDK for Agent Relay. Define a **node** — a named host that advertises typed
**capabilities** (actions and spawners) and reacts to channel messages via **triggers** — then
serve it with the `agent-relay fleet` CLI.

Use `@agent-relay/fleet` when you want to expose local capabilities (run a command, spawn a
harness, answer a request) to a relay workspace as a long-lived node. Use `@agent-relay/sdk`
for plain agent messaging and `@agent-relay/harness-driver` to start and supervise local
harness processes directly.

Full docs: [agentrelay.com/docs](https://agentrelay.com/docs).

## Installation

```bash
npm install @agent-relay/fleet zod
```

## Quick start

```ts
import { defineNode, action, spawn, onMessage } from '@agent-relay/fleet';
import { z } from 'zod';

export default defineNode({
  name: 'builder',
  capabilities: {
    'run:test': action({ input: z.object({ suite: z.string() }) }, async ({ input }) => {
      // ...run the suite...
      return { ok: true, suite: input.suite };
    }),
    'spawn:claude': spawn({ harness: 'claude' }),
  },
  triggers: [
    // When a message matching the pattern lands in #deploys, invoke run:test.
    onMessage({ channel: '#deploys', match: /[Ss]hip/ }, 'run:test'),
  ],
});
```

Serve it with the CLI:

```bash
agent-relay node up --config ./builder.node.ts
# or drop the file at the project root as agent-relay.ts and run `agent-relay node up` (auto-discovered)
agent-relay fleet nodes      # list registered nodes
agent-relay fleet status     # show node + capability health
```

### Serving a node programmatically

`@agent-relay/fleet` also ships the node runtime, so you can start a node in
process without the CLI:

```ts
import { defineNode, serveNode, startServeNode } from '@agent-relay/fleet';

const definition = defineNode({
  name: 'builder',
  capabilities: {
    /* … */
  },
});
const connection = { url: 'http://127.0.0.1:8787' }; // broker HTTP API base URL (apiKey optional)

// startServeNode returns a RunningNode { stop(), done } for supervised use…
const running = startServeNode({ definition, connection });
// …await running.done to block until the node stops, or call running.stop().
await running.stop();

// serveNode runs the node to completion (resolves when it stops / aborts).
await serveNode({ definition, connection });
```

### Logging

The node runtime emits structured events — each capability it registers and every
action that hits it (invoked / completed / failed, with a duration) — through a
`logger` you inject. The shape matches `@agent-relay/utils`' `createLogger`, and
every event carries a structured `extra` bag (`{ capability, action, invocationId,
ms, … }`) so file and JSON sinks can key on the fields:

```ts
import { createLogger } from '@agent-relay/utils';

await serveNode({ definition, connection, logger: createLogger('fleet') });
```

Via the CLI, `agent-relay node up` surfaces this without code:

```bash
agent-relay node up --config ./builder.node.ts --log-file ./node.log
agent-relay node up --config ./builder.node.ts --log-level debug   # include per-capability lines
agent-relay node up --config ./builder.node.ts --log-json          # one JSON object per line
```

Capability registration logs at `debug`; action invocations at `info`; failures at
`warn`. When no logger (and no `--log-*` flag) is set, the node stays quiet and only
surfaces warnings.

## Concepts

- **Node** — a named host registered with the workspace. `defineNode` validates the manifest
  up front and returns a `FleetNodeDefinition`.
- **Capability** — a typed operation keyed by name. Build one with `action(...)` (a handler
  with an optional Zod input schema) or `spawn(...)` (a capability that launches a harness).
- **Trigger** — a rule that invokes a capability in response to a channel message. Create one
  with `onMessage({ channel?, match?, mention? }, actionName)`.

## Triggers and `match`

`match` accepts a string (substring/exact match) or a `RegExp`. The pattern is serialized to
the relay and matched broker-side.

> **Regex flags are not supported yet.** `defineNode` **rejects** a trigger whose `match` is a
> flagged `RegExp` (e.g. `/ship/i`, `/ship/m`) rather than silently dropping the flag — a
> silently stripped flag would change matching semantics without warning. Until flag support
> lands, encode case-insensitivity with character classes:
>
> ```ts
> onMessage({ match: /[Ss]hip/ }, 'run:test'); // ✅ case-insensitive via character class
> onMessage({ match: /ship/i }, 'run:test'); // ❌ throws at defineNode validation
> ```

## License

Apache-2.0
