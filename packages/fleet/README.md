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

Serve it:

```bash
agent-relay fleet serve ./builder.node.ts
agent-relay fleet nodes      # list registered nodes
agent-relay fleet status     # show node + capability health
```

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
