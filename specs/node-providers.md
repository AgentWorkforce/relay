# Node Providers — Language-Neutral Capability Hosting

**Status**: Draft
**Date**: 2026-07-07
**Author**: Design session (Will + Claude)

---

## 1. Problem

A node's capability plane is owned by the wrong process, in the wrong language,
behind a private protocol.

Today, `relay node up` produces this topology:

```text
CLI process (TS)
 ├─ spawns → agent-relay-broker (Rust)
 │            └─ WS client → cast.agentrelay.com /v1/node/ws   [fleet-wire]
 └─ in-process "fleet sidecar" (TS, capability handlers)
              └─ WS client → localhost broker /api/fleet/ws    [SdkToBroker/BrokerToSdk]
```

The broker owns the node's cloud identity — token, registration, heartbeats,
delivery dedup, invoke routing — while the handlers live in a TS sidecar that
can only reach the network by tunneling through the broker. Consequences:

- **Two hand-mirrored protocols.** fleet-wire is defined in Zod
  (`relaycast/packages/types/src/fleet-wire.ts`) and duplicated in serde
  (`crates/broker/src/fleet_wire.rs`); the sidecar wire is defined in Rust
  (`crates/broker/src/protocol.rs`) and duplicated in TS
  (`packages/harness-driver/src/protocol.ts`). Every capability feature
  touches four codebases.
- **TS-only handlers.** Defining capabilities in Python or Swift means porting
  the broker's private sidecar protocol, not implementing an engine surface.
  `sdk-py` has no capability surface at all.
- **Split-brain advertisement.** The engine routes invokes from
  `node.register`'s capability list; the broker gates dispatch on the separate
  in-memory `register_handlers` set. They align by convention only — drift
  yields `handler_unavailable` on invokes the engine already dispatched.
- **Dead spawn path.** The sidecar registers `spawn:*` handlers the broker
  never calls (it intercepts spawn/release itself); the engine skips `spawn:*`
  when materializing actions. Two spawn implementations for one declared
  capability.
- **Circular supervision.** The CLI spawns the broker; the broker can spawn
  and restart the sidecar (`NodeSupervision.argv`). No single root of "the
  node" on a machine.
- **Broker required for everything.** A capability that has nothing to do with
  agents still cannot run unless the Rust PTY runtime is up.

The broker is conflating two roles: PTY/harness runtime (genuinely wants Rust)
and node agent (a websocket protocol client, safe in any language). This spec
separates them.

---

## 2. Model

| Term           | Definition                                                                                                                                                                        |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Node**       | An enrolled context in a workspace — usually a project root, sometimes an application. The unit others target: "invoke `run-etl` on `data-pipeline`". Multiple nodes per machine. |
| **Provider**   | A process attached to a node. Connects directly to the engine, registers a subset of the node's capabilities, executes their invokes. The broker is one provider among several.   |
| **Capability** | An action with a handler hosted by a provider. Node-scoped, always.                                                                                                               |
| **Machine**    | An attribute on the node record (grouping in fleet views, physical-co-location input to placement). Never a capability scope.                                                     |

Rules:

- Node identity is unchanged: derived from machine id, cwd, and workspace id,
  exactly as `derive_node_id` computes it today (the workspace component keeps
  the same directory distinct across workspaces). A project is a node; an app
  that hosts capabilities enrolls as its own node. There is no "default node"
  and no machine-scoped capability.
- All providers on a node share the node's `nt_live_` token (0600 enrollment
  file — filesystem permissions are the local trust boundary). Each provider
  declares an identity at connect: `{ name, instance_id }`.
- A node is online when ≥1 provider is connected. A capability is live iff its
  owning provider's connection is up and the provider's heartbeat still lists
  it in `handlers_live`.
- Registrations come in two kinds. **`action`** — an invokable handler: the
  engine materializes it and dispatches invokes to the registering provider.
  **`capacity`** — what the node can run: `spawn:<harness>` and `release`,
  registered by the broker provider, used for placement and delegation, never
  materialized as actions. Providers with `action` registrations define what
  a node can _do_; the broker's `capacity` registrations define what it can
  _run_.
- Duplicate **action** name within a node → registration rejected with an
  error frame; the provider fails loudly at startup. The same provider
  re-registering (reconnect) is an idempotent replace. Multiple providers
  advertising `spawn:claude` capacity is not a conflict — it is more
  capacity. `max_agents` and load are enforced per provider; the node-level
  figure is the aggregate.

Target topology:

```text
engine (cast.agentrelay.com)
 ├─ /v1/node/ws ← broker provider (Rust)     — spawn:*, release, agent delivery
 ├─ /v1/node/ws ← capability provider (TS)   — project agent-relay.ts actions
 ├─ /v1/node/ws ← capability provider (py)   — project agent-relay.py actions
 └─ /v1/node/ws ← app provider (Swift)       — its own node
```

No local hub. The engine is the hub; the sidecar protocol and the broker's
client-side dispatch bookkeeping (`HandlerDispatchState`) move server-side.

---

## 3. Engine changes (relaycast)

### 3.1 Wire protocol (`@relaycast/types` fleet-wire)

- `node.register` becomes provider-scoped: gains
  `provider: { name, instance_id }` and carries only that provider's
  capabilities. `name` is the provider's stable identity — persistence,
  capability-conflict checks, and routing key on it. `instance_id` is the
  connection epoch: re-registering with the same name and a new `instance_id`
  replaces the previous attachment (reconnect/restart); registering a name
  whose current instance is still connected and heartbeating is rejected
  (duplicate process). Registration response carries per-capability
  acceptance; a name conflict with another provider's invokable capability is
  a rejection.
- `node.deregister` carries the provider identity and removes that provider's
  attachment and persisted capability set.
- `FleetCapability.kind` distinguishes `action` from `capacity` (§2). The
  engine materializes actions only from `action`-kind entries; `capacity`
  entries feed placement and `ctx.spawnAgent` delegation.
- `node.heartbeat` is implicitly provider-scoped by connection;
  `handlers_live` refers to the sending provider's capabilities. Load fields
  (`active_agents`, `max_agents`) are provider-level.
- `action.invoke` / `action.result` shapes unchanged; routing changes (§3.3).
- `deliver` frames route to the provider whose connection registered the
  target agent (`agent.register` binds agent → provider).

### 3.2 State

- `nodes` row: unchanged, plus explicit `machine_id` column for grouping.
- Provider attachment state (connected providers, their capability sets,
  in-flight invocations) lives with the node socket owner — in
  relaycast-cloud, the per-node Durable Object holds N provider sockets
  instead of 1. Registered capabilities persist keyed by provider name so
  offline nodes still display their full manifest. A provider's registration
  fully replaces its previously persisted set; renamed or retired providers
  are removed by provider-scoped `node.deregister` or via the nodes REST API
  (`DELETE /v1/nodes/:node/providers/:name`).

### 3.3 Actions and invocation

- Materialized actions are **node-scoped**: unique key `(node, name)`, with
  `handlerProvider` recorded for dispatch. Two nodes may both define
  `run-etl`.
- Invocation is node-addressed:
  `POST /v1/nodes/:node/actions/:name/invoke` (agent token, as today).
  Dispatch resolves capability → provider → socket.
- A capability may opt into a workspace-global alias
  (`global: true` at definition); the alias claims the workspace-global name
  and collides loudly, like any other registration conflict. Aliases are
  invoked through the existing workspace-scoped
  `POST /v1/actions/:name/invoke`, which resolves to the owning node and
  provider; the node-addressed route works for the same capability
  regardless.
- Invoke targeting a capability whose provider is offline **fails fast** by
  default; a capability may opt into queueing (`queue: true`), reusing the
  existing offline-queue path keyed per provider.
- **Spawn shadowing.** A provider may register an `action` named
  `spawn:<harness>`; it shadows the node's native capacity for dispatch:
  inbound spawn invokes for that harness go to the handler, which transforms
  the spawn spec (CLI, env, cwd) and delegates via `ctx.spawnAgent`. This is
  how before/after policy around spawn works — before-logic ahead of the
  delegation call, after-logic behind it.
- **No recursion.** `ctx.spawnAgent` is a distinct engine surface addressed
  to the node's `capacity` executor (the broker provider); it bypasses action
  dispatch, so a shadow handler calling it cannot re-enter itself.
- **No silent bypass.** While a `spawn:<harness>` shadow action is
  registered, native capacity for that harness is unreachable from dispatch —
  even when the shadow's provider is offline. A shadow may enforce policy;
  falling back to the unwrapped spawn on failure would bypass it. The invoke
  fails fast or queues until the shadow is live again or explicitly
  deregistered.

### 3.4 Auth

Shared node token now. Derived per-provider tokens (minted from the node
token, revocable individually) are a compatible later addition — nothing in
this design depends on them, and no local process ever arbitrates its
siblings' permissions.

---

## 4. SDK surface (parity: TS, Python, Swift, Rust)

Each relaycast SDK gains a **node provider client**: connect with a node
token, declare provider identity, register capabilities, receive
`action.invoke`, reply `action.result`. This is the same size of surface as
the existing agent-hosted action support (which Swift and TS already
implement), pointed at `/v1/node/ws` instead of `/v1/ws`.

TypeScript (authoring API is today's `@agent-relay/fleet`, retargeted):

```ts
import { defineNode, action } from '@agent-relay/fleet';
import { z } from 'zod';

export default defineNode({
  name: 'data-pipeline',
  capabilities: {
    'run-etl': action({ input: z.object({ date: z.string() }) }, async (input, ctx) => runEtl(input.date)),
  },
});
```

Python:

```python
from agent_relay.node import NodeProvider

node = NodeProvider.from_enrollment()  # reads node token + base URL

@node.capability("run-etl", description="Run the ETL job")
async def run_etl(input, ctx): ...

node.serve()
```

Swift:

```swift
let node = try NodeProvider.fromEnrollment()
node.capability("screenshot", description: "Capture the screen") { input, ctx in
    try await captureScreen(input)
}
try await node.serve()
```

Handler context (`ctx`) helpers — `sendMessage`, `spawnAgent` — are engine
REST/WS calls made with the node token. They carry no local-broker dependency:
a Python capability that spawns an agent does so through the engine's spawn
placement, which lands on a broker provider like any other spawn.

Spawn shadowing (§3.3) makes before/after policy a plain handler in any
language — here mutating the CLI command before the broker executes it:

```python
@node.capability("spawn:claude")  # shadows the node's native spawn:claude
async def spawn_claude(input, ctx):
    agent = input["agent"]
    agent["cli"] = f"claude --permission-mode plan {agent.get('args', '')}"
    result = await ctx.spawn_agent(agent)  # delegates to broker capacity
    await ctx.send_message(to="ops", text=f"spawned {result['name']}")
    return result
```

---

## 5. Relay changes

### 5.1 Broker demotion

The broker keeps exactly what needs Rust: the PTY runtime and its existing
`/v1/node/ws` connection, now as one provider. It registers `spawn:*`,
`release`, and the agent roster; it receives `deliver` frames for its agents;
it heartbeats its own load. Deleted from the broker:

- `/api/fleet/ws` route and all sidecar session handling
  (`listen_api.rs`, `runtime/fleet.rs` sidecar connect/frame/supervision).
- `HandlerDispatchState` and handler bookkeeping (`node_control.rs`) — the
  engine owns dispatch.
- Node frames in `protocol.rs` (`register_node`, `register_handlers`,
  `invoke_handler`, `handler_result`, `deregister_node`,
  `NodeSupervision`) and their TS mirrors in
  `packages/harness-driver/src/protocol.ts`.
- Sidecar spawn-supervision (`NodeSupervision.argv` child management). Process
  supervision of capability providers belongs to whatever starts them (the
  CLI, launchd, systemd) — not to a peer provider.

`fleet_wire.rs` remains (the broker still speaks fleet-wire) and gains the
provider fields from §3.1.

### 5.2 CLI

- `node up` brings the current context's node online: starts the broker
  provider and serves the project's capability definitions as further
  providers — all connecting directly to the engine with the enrolled node
  token. Discovery is per language: `agent-relay.{ts,…}` is served via
  `@agent-relay/fleet`; `agent-relay.py` is spawned as a `python` child
  process with the node token in its env, supervised (and restarted) by the
  CLI. When no definition file exists, the implicit definition derived from
  teams.json applies (a default definition for this context's node — not a
  machine-level node, which does not exist in this model). Standalone
  providers (launchd/systemd, long-running apps) connect on their own via
  `NodeProvider.from_enrollment()` and need no `node up` at all — providers
  have no start-order dependency on the broker or each other. Enrollment
  pickup (`cloud enroll` → `fleet-enrollments.json` → env) is unchanged.
- `fleet status` reads provider attachment from the engine instead of a local
  sidecar status file; `fleet nodes` gains machine grouping and per-provider
  liveness.
- The `capabilities` command group (agent-command routing) is a different
  concept sharing a name; renaming it is follow-up work, tracked separately.

### 5.3 Unification with agent-hosted actions

Both action systems become one model: an action is a handler hosted by a
connection — a node provider (this spec) or an agent's workspace connection
(existing `registerAction`). Registration, invocation, observer events, and
invocation rows are shared; only the hosting connection differs.

---

## 6. Documentation (agentrelay.com)

The public docs at `../agentrelay.com/web/content/docs/` describe the end
state when step 3 of the sequencing ships. A new `nodes-and-providers.mdx`
page carries the newcomer overview; `actions.mdx`,
`orchestrating-with-actions.mdx`, `cli-broker-lifecycle.mdx`,
`harness-driver.mdx`, and `reference-cli.mdx` are updated to match. The
overview, written for someone new to the system:

> A workspace contains agents — the participants that converse — and
> **nodes** — the places that do work. A node is an enrolled context on a
> machine: usually a project directory, sometimes an application. One
> machine can host several nodes, and the machine itself is just an
> attribute used for grouping and placement.
>
> Processes called **providers** attach to a node and give it abilities.
> Every provider connects directly to the engine with the node's token and
> registers what it offers. The broker provider (Rust) runs agents — it
> registers _capacity_: which harnesses it can spawn (`spawn:claude`) and
> how many. Capability providers — written in TypeScript, Python, or Swift
> — register _actions_: named handlers like `run-etl` or `screenshot` that
> anything in the workspace can invoke.
>
> An invoke is addressed to a node:
> `POST /v1/nodes/:node/actions/:name/invoke`. The engine routes it down
> the socket of the provider that registered the action, the handler runs
> on that machine, and the result returns to the caller. Liveness is
> per provider — if the Python process is down, its actions are
> unavailable while agents keep running, and vice versa.
>
> Spawning composes with actions: registering an action named
> `spawn:<harness>` wraps the node's native spawn, so a handler in any
> language can mutate the command, environment, or working directory
> before delegating to the broker — and audit or announce after.
>
> Getting a machine into the fleet is two commands: `relay cloud enroll`
> once per context (redeems a one-time token, persists the node
> credential), then `relay node up` in the project to bring its node
> online. Long-running apps skip `node up` and serve their own node
> directly through an SDK.

Docs follow the repo's declarative style: they describe this model as what
the system is, with no reference to the sidecar architecture it replaces.

---

## 7. What does not change

- Enrollment flow and tokens: `cloud enroll` / `ocl_node_enr_` / `nt_live_`.
- Node identity derivation (machine id, cwd, workspace id); multiple nodes
  per machine.
- fleet-wire framing, heartbeat cadence, delivery dedup/ack semantics.
- The broker's PTY/injection/supervision kernel (`relay-pty`) and agent
  delivery path.
- Observer/workspace streams (`/v1/ws`).

---

## 8. Sequencing

Upstream-first, per the release-train choreography:

1. **relaycast**: fleet-wire provider fields; engine provider attachment,
   node-scoped actions, node-addressed invoke; NodeDO multi-socket in
   relaycast-cloud. Additive — a registration with no `provider` field is
   keyed as the reserved synthetic provider
   `{ name: "default", instance_id: <connection id> }`, used uniformly for
   heartbeats, routing, and persistence, so the current broker keeps working
   during the transition.
2. **relaycast SDKs**: node provider client in TS, Python, Swift (Rust client
   is the broker's, updated in step 3). Run the parity audit.
3. **relay**: retarget `@agent-relay/fleet` serveNode to the engine; CLI
   `node up` wiring; broker demotion and protocol deletions.
4. **Downstream** (pear, workforce): adopt node-addressed invocation.
5. **Docs** (agentrelay.com): publish §6 alongside step 3.

Pre-launch stance applies: the sidecar protocol and workspace-global action
addressing are removed without compatibility shims. Node-scoped action rows
replace workspace-global ones; existing invocation URLs change.

---

## 9. Open questions

- Derived per-provider tokens: worth minting at attach time for audit
  attribution even before revocation is needed?
- Does anything actually need workspace-global action aliases at launch, or
  can `global: true` wait until a consumer asks?
