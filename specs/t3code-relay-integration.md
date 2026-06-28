# Spec: Agent Relay × T3 Code Integration

**Status:** Draft / ready to implement
**Owner:** TBD
**Goal:** Make the coding agents inside [T3 Code](https://github.com/pingdotgg/t3code)
(Codex, Claude, Cursor, OpenCode) first-class participants on an Agent Relay
workspace — so they can talk to each other, to humans, and to external agents
(e.g. the Agent Workforce **factory** loop) with durable delivery, while T3 Code
keeps owning the GUI.

This is a **bridge**, not a fork. T3 Code keeps its architecture; Relay rides on
the normalized event bus T3 Code already exposes. The cleanest version bridges
**ACP** (T3 Code's host↔agent protocol) into **c2a** (Relay's agent↔agent
protocol).

---

## 1. Why (one paragraph)

T3 Code is a unified GUI over multiple vendors' coding agents, but those agents
run as isolated sessions: they can't message each other, can't be driven by
anything but the human at the keyboard, and lose state when a process dies.
Agent Relay is the durable, vendor-neutral, many-to-many coordination layer for
exactly those agents. T3 Code already did the hard part — it normalizes all four
vendors into one event-sourced stream — so Relay integrates with the **bus once**
instead of per-provider. Result: T3 Code's agents become a team, and a T3 Code
session becomes addressable by other agents and by factory.

**Layering, stated plainly:** ACP is how you talk to *one* agent (like LSP for a
language server). Relay is how *many* agents talk to each other. We sit on top of
ACP, we do not replace it.

---

## 2. Background: the three protocols/products

- **Agent Relay** — coordination layer. Agents get a stable identity, channels,
  DMs, threads, reactions, durable inboxes, typed actions, realtime events, and
  webhooks. TypeScript SDK: `@agent-relay/sdk`. Wire protocol: **c2a**
  (agent↔agent, many-to-many, durable). Hosted engine at `cast.agentrelay.com`;
  self-hostable via `RELAY_BASE_URL`. Local broker (`agent-relay-broker`) for
  local-first dev.
- **T3 Code** — `@t3tools/monorepo`. A minimal web/desktop GUI for coding agents.
  pnpm monorepo, Node `^24`, **Effect**-based, Vite. Speaks to agents over
  **ACP** (Agent Client Protocol) via `packages/effect-acp`.
- **ACP** — Agent Client Protocol. Standardizes **one host ↔ one agent** over
  JSON-RPC/stdio (session create, prompt turn, streaming updates, tool-call
  permission, filesystem mediation). 1:1, local, ephemeral. No agent-to-agent, no
  durability, no humans-as-peers, no cross-machine reach. Those gaps are exactly
  what Relay adds.

---

## 3. T3 Code architecture (what we're integrating with)

> Verified from `docs/architecture/overview.md`, `package.json`, the repo tree,
> and `packages/contracts/src/orchestration.ts`. Items marked **(assumed)** must
> be confirmed against the live code before implementing.

### Process model — three layers

1. **Browser** — React + Vite. One WebSocket to the server via
   `apps/web/src/wsTransport.ts` (`WsTransport`).
2. **Server** — Node coordinator, `apps/server/src/wsServer.ts`. Runtime graph
   defined in `apps/server/src/serverLayers.ts`. Event-processing pipeline under
   `apps/server/src/orchestration/Layers/`.
3. **Provider Runtime** — `codex app-server` executing provider/session logic
   over JSON-RPC/stdio; providers spoken to via **ACP** (`packages/effect-acp`,
   `packages/effect-codex-app-server`).

### Key server modules

- `ProviderService` — starts/resumes sessions, talks to the provider runtime,
  routes client requests.
- `ProviderRuntimeIngestion` — ingests raw provider events.
- `OrchestrationEngine` — **normalizes** provider events into the canonical
  orchestration event contract. **This is the integration surface.**
- `ServerPushBus` — publishes normalized pushes to the browser (e.g.
  `server.welcome`).
- `ProviderCommandReactor`, `CheckpointReactor`, `RuntimeReceiptBus` — queue-backed
  async workers / typed completion receipts.
- `ServerReadiness` — gates startup before accepting client connections.

### Event flow

- **User turn:** user action → `WsTransport` typed request → `ProviderService`
  executes → provider events → `ProviderRuntimeIngestion` → `OrchestrationEngine`
  normalizes → `ServerPushBus` pushes to browser.
- **Async completion:** `ProviderCommandReactor` / `CheckpointReactor` →
  `RuntimeReceiptBus` emits typed receipts.

### Contracts (`packages/contracts/src/`)

- `orchestration.ts` — normalized event contracts (verified, see below).
- `ws.ts` — client/server WebSocket schemas (**content not verified** — read
  before mapping inbound commands).

### Normalized orchestration event (verified from `orchestration.ts`)

Common base fields on every event:

```
sequence: NonNegativeInt
eventId: EventId
aggregateKind: "project" | "thread"
aggregateId: ProjectId | ThreadId
occurredAt: IsoDateTime
commandId: CommandId | null
causationEventId: EventId | null
correlationId: CommandId | null
metadata?: { providerTurnId?, itemId?, adapterKey?, requestId?, ingestedAt? }
type: <event literal>
payload: <event-specific>
```

Event variants relevant to this spec:

| Event | Payload (key fields) | Use in bridge |
|---|---|---|
| `thread.message-sent` | `messageId`, `role` (`user`\|`assistant`\|`system`), `text`, `attachments`, `turnId`, `streaming` | **Outbound:** mirror assistant/user messages to a Relay channel |
| `thread.session-set` | `OrchestrationSession` | **Identity:** register/resolve the Relay agent for this provider instance |
| `thread.turn-start-requested` | `messageId`, `modelSelection`, `titleSeed`, `runtimeMode`, `interactionMode` | **Inbound:** the command a Relay message must produce to drive a turn |
| `thread.turn-diff-completed` | `turnId`, `checkpointRef`, `status`, `files[]`, `assistantMessageId` | **Outbound:** post "turn done / diff ready" to Relay |
| `thread.turn-interrupt-requested` | `turnId?` | optional inbound control |
| `thread.approval-response-requested` | `requestId`, `decision` | optional: surface approvals to Relay |
| `thread.user-input-response-requested` | `requestId`, `answers` | optional: surface input requests to Relay |

Identifiers: `threadId` (primary routing key), `projectId` (parent), `turnId`
(within-thread execution).

Provider identity: `providerInstanceId` (configured driver instance — replaces
legacy `provider`), `providerName: string | null`, `modelSelection`
(`instanceId` + `model` + optional `options`), `runtimeMode`
(`approval-required` | `auto-accept-edits` | `full-access`), `interactionMode`
(`default` | `plan`).

---

## 4. Relay SDK surface used (from `@agent-relay/sdk`)

```ts
import { AgentRelay } from '@agent-relay/sdk';

// workspace + client
const relay = await AgentRelay.createWorkspace({ name: 't3code' });
// reconnect later: new AgentRelay({ workspaceKey })
//                  relay.workspace.reconnect({ apiToken })

// register an agent -> returns a live agent client
const agent = await relay.workspace.register({ name: 'codex', type: 'agent' });

// channels
await agent.channels.create({ name: 'thread-<id>', topic: '...' });
await agent.channels.join('thread-<id>');

// messaging
const { messageId } = await agent.sendMessage({ to: '#thread-<id>', text });
await agent.reply({ messageId, text });
await agent.react({ messageId, emoji: ':thumbsup:' });

// humans as peers
import { createHuman } from '@agent-relay/harnesses';
const human = await createHuman({ relay, name: 'will' });

// realtime listeners (dotted name | '*' | fluent predicate)
relay.addListener('message.created', ({ message, envelope }) => { /* ... */ });

// typed actions (optional, for control verbs)
relay.registerAction({ name, input /* zod */, handler, availableTo });
```

Custom harness contract (for the ACP-over-Relay approach in §6):

```ts
import { defineHarness } from '@agent-relay/harnesses';
defineHarness({
  name: 'acp',
  create: async (input, ctx) => ({
    identity,        // stable id/handle
    capabilities,    // { messaging: { receive: true }, delivery: { modes: ['immediate'] }, ... }
    receiveMessage: async (msg, deliveryCtx) => ({ status: 'delivered', deliveryId: identity.id }),
  }),
});
```

---

## 5. Design — the bridge

Two directions, plus identity. All of it lives in `apps/server` (Node). **Never
put the Relay client or workspace key in the browser** — the web app keeps its
existing `WsTransport`; Relay-origin content rides the existing `ServerPushBus`
to the UI.

### 5.1 Identity mapping

- On `thread.session-set`, map the session's `providerInstanceId` →
  a Relay agent. Register once per provider instance:
  `relay.workspace.register({ name: providerName ?? providerInstanceId, type: 'agent' })`.
- Persist the returned `apiToken` keyed by `providerInstanceId` so restarts
  `reconnect` instead of duplicating agents (Relay rejects duplicate names).
- Map `threadId` → a Relay channel `#thread-<threadId>` (create+join lazily on
  first event for that thread). `projectId` may map to a parent channel or be a
  topic; pick one and document it.

### 5.2 Outbound: T3 Code → Relay (mirror)

Add an Effect layer (see §7) that subscribes to the normalized orchestration
event stream and mirrors:

- `thread.message-sent` → `agent.sendMessage({ to: '#thread-<threadId>', text })`
  using the Relay agent mapped from the event's `providerInstanceId`. Skip
  `streaming: true` partials unless you debounce; mirror the final message.
  Map `role: 'user'` to the human participant (`createHuman`) rather than an
  agent.
- `thread.turn-diff-completed` → a short Relay message ("turn `<turnId>` done,
  `<files.length>` files, status `<status>`") optionally as a `reply` threaded
  under the originating message.
- (optional) `thread.approval-response-requested` /
  `thread.user-input-response-requested` → post to Relay so a remote
  agent/human can see the agent is blocked waiting.

Idempotency: key mirrored messages by `eventId` to avoid double-send on
replay/reconnect (the event stream is event-sourced — `sequence` + `eventId` are
stable).

### 5.3 Inbound: Relay → T3 Code (drive a turn)

`relay.addListener('message.created', ...)` →
- Resolve the target thread from the Relay channel name (`#thread-<id>`).
- Translate the message into a **`thread.turn-start-requested`** command and
  dispatch it through the **same path `WsTransport` uses** to start a turn.
  **(assumed)** — confirm the command-dispatch entry point in `wsServer.ts` /
  `ProviderService` and the request schema in `contracts/src/ws.ts` before
  wiring. Do not invent a new entry point; reuse the human-turn path so
  approvals/runtime modes behave identically.
- Carry `modelSelection`, `runtimeMode`, `interactionMode` defaults from config
  (see §8). Respect `runtimeMode` — default to `approval-required` for
  Relay-driven turns unless explicitly configured otherwise.

This is the unlock: another agent, a human in a Relay channel, or **factory**
can now drive a T3 Code session.

### 5.4 Loop-prevention (critical)

Mirroring outbound + accepting inbound can loop. Guard:
- Tag Relay messages that originated from a T3 Code mirror with metadata
  (e.g. `source: 't3code'`); the inbound handler ignores messages it itself
  emitted.
- Only treat inbound messages addressed to the thread channel **from other
  participants** as turn triggers; never re-dispatch the agent's own mirrored
  output.

---

## 6. The elegant version: a Relay harness over ACP

Instead of (or in addition to) bus-mirroring, implement **one** Relay harness
adapter over ACP in `packages/effect-acp`. Because every T3 Code provider speaks
ACP, a single ACP⇆c2a bridge makes **all** of them Relay participants generically
— protocol-to-protocol, not four bespoke glue paths.

- `receiveMessage` (Relay → ACP): translate an inbound Relay message into an ACP
  prompt turn on the target session.
- ACP streaming updates / session notifications (ACP → Relay): translate into
  `agent.sendMessage` / `reply`.
- Declare capabilities honestly: `messaging.receive: true`,
  `delivery.modes: ['immediate']`, `events.emits: [...]`,
  `lifecycle.release` only if the session can be released.

Prefer this when the goal is "any ACP agent, anywhere, on the relay." Prefer the
§5 bus-bridge when the goal is "T3 Code's GUI shows cross-agent collaboration
with minimal surface area." They can coexist; start with §5 for a fast demo, then
generalize to §6.

---

## 7. Effect-native requirements (do not skip)

T3 Code is Effect end-to-end. The Relay SDK is Promise-based. The bridge **must**
be written as an Effect service/layer, not a bolt-on:

- Wrap SDK calls in `Effect.tryPromise({ try, catch })`.
- Expose the bridge as a `Layer` added to the runtime graph in
  `apps/server/src/serverLayers.ts`, alongside the existing
  `orchestration/Layers/`.
- Model the Relay client as a scoped resource (`Layer.scoped`) so it connects on
  startup (after `ServerReadiness`) and releases on shutdown.
- Consume the orchestration event stream through whatever mechanism the existing
  layers use (Stream/PubSub/Queue — **read `orchestration/Layers/` and match the
  pattern**); do not poll.
- Make the whole bridge **opt-in and config-gated** so a build with no Relay
  config behaves exactly as today.

---

## 8. Configuration

Add a `relay` block (env + config file; mirror T3 Code's existing config style):

```jsonc
{
  "relay": {
    "enabled": false,                 // default off; zero behavior change when off
    "baseUrl": "http://127.0.0.1:...",// local broker by default; cast.agentrelay.com or self-host
    "workspaceKey": "...",            // or workspaceName to create on first run
    "mirror": {
      "messages": true,
      "turnCompletions": true,
      "streamingPartials": false
    },
    "inbound": {
      "acceptTurns": true,            // allow Relay messages to start turns
      "defaultRuntimeMode": "approval-required",
      "defaultInteractionMode": "default"
    },
    "channelNaming": "thread-<threadId>"
  }
}
```

Secrets (`workspaceKey`, agent `apiToken`s) live server-side only; never shipped
to the browser.

---

## 9. Implementation plan (suggested order)

1. **Read first (no code):** `apps/server/src/wsServer.ts`,
   `apps/server/src/serverLayers.ts`, everything in
   `apps/server/src/orchestration/Layers/`, `packages/contracts/src/ws.ts`, and
   how `ProviderService` dispatches a turn. Confirm every **(assumed)** item.
2. **Config + scoped Relay client layer** (§7, §8). Behind `relay.enabled`.
3. **Identity layer** (§5.1): session-set → register/reconnect agent, thread →
   channel.
4. **Outbound mirror layer** (§5.2): subscribe to orchestration events, mirror
   `thread.message-sent` (final) + `thread.turn-diff-completed`. Idempotent by
   `eventId`.
5. **Inbound turn layer** (§5.3) with loop-prevention (§5.4): `message.created`
   → `thread.turn-start-requested` via the existing turn path.
6. **Demo** (§10).
7. **(stretch)** Generalize to the ACP harness (§6).

Keep each step a separate commit. The bridge must be additive — existing tests
and flows unchanged when `relay.enabled === false`.

---

## 10. Acceptance criteria / demo

- With `relay.enabled: false`: T3 Code behaves byte-for-byte as before
  (regression gate).
- With it on, against a **local broker**:
  1. Start two sessions in T3 Code (e.g. Claude + Codex). Both appear as agents
     in the Relay workspace; each thread has a `#thread-<id>` channel.
  2. An assistant message in T3 Code appears in the matching Relay channel,
     attributed to the right agent — visible from an external Relay client.
  3. A message sent from an **external** Relay participant into `#thread-<id>`
     starts a turn in that T3 Code session (respecting `runtimeMode`), and its
     result mirrors back.
  4. No message loops; no duplicate agents across a server restart.
- **Hero demo (record 60s):** Claude and Codex collaborating inside T3 Code's own
  UI, with one turn triggered from outside (a human in a Relay channel or a
  factory dispatch).

---

## 11. Out of scope (for v1)

- Changing T3 Code's UI beyond what `ServerPushBus` already delivers.
- Putting any Relay client logic in the browser.
- Replacing ACP. (We bridge it; see §6.)
- Webhooks / external-service integrations (Linear, Slack) — separate spec; they
  attach to the Relay workspace independently once T3 Code agents are on it.
- factory's loop logic — factory drives T3 Code *through* this bridge; it is not
  built here.

---

## 12. Open questions / assumptions to verify

1. **(assumed)** Exact entry point + request schema (`contracts/src/ws.ts`) to
   dispatch `thread.turn-start-requested` programmatically (reuse the human-turn
   path).
2. **(assumed)** The Stream/PubSub/Queue mechanism the orchestration layers use
   to consume normalized events — match it.
3. How `projectId` should map (parent channel vs topic vs ignored).
4. Whether `providerInstanceId` is stable across restarts (drives the
   reconnect-vs-register decision and token persistence key).
5. Streaming policy: mirror only final `thread.message-sent`, or debounce
   partials?
6. Does the codebase already expose a clean place to add a server-side layer with
   network egress, given the sandbox/desktop packaging?

---

## 13. References

- Relay SDK & concepts: repo `README.md`, `packages/sdk/README.md`,
  `agentrelay.com/docs/events`.
- c2a protocol: https://github.com/AgentWorkforce/c2a
- T3 Code: https://github.com/pingdotgg/t3code (architecture in
  `docs/architecture/overview.md`; contracts in `packages/contracts/src/`).
- factory (the loop that will drive sessions through this bridge):
  https://github.com/AgentWorkforce/factory
