# Node Providers — Language-Neutral Capability Hosting

**Status**: Draft
**Date**: 2026-07-07
**Author**: Design session (Will + Claude)

---

## 1. Problem

A node's capability plane is owned by the wrong process, in the wrong language,
behind a private protocol.

Today, `relay node up` produces this topology:

```
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

- Node identity is unchanged: machine id + cwd hash, minted at enrollment.
  A project is a node; an app that hosts capabilities enrolls as its own node.
  There is no "default node" and no machine-scoped capability.
- All providers on a node share the node's `nt_live_` token (0600 enrollment
  file — filesystem permissions are the local trust boundary). Each provider
  declares an identity at connect: `{ name, instance_id }`.
- A node is online when ≥1 provider is connected. A capability is live iff its
  owning provider's connection is up and the provider's heartbeat still lists
  it in `handlers_live`.
- Duplicate **invokable** capability name within a node → registration
  rejected with an error frame; the provider fails loudly at startup. The same
  provider re-registering (reconnect) is an idempotent replace.
- `spawn:*` capabilities are **placement capacity, not invokable actions**
  (engine already skips materializing them). Multiple providers advertising
  `spawn:claude` is capacity, not a conflict. `max_agents` and load are
  enforced per provider; the node-level figure is the aggregate.

Target topology:

```
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
  capabilities. The engine merges per node, keyed by provider name.
  Registration response carries per-capability acceptance; a name conflict
  with another provider's invokable capability is a rejection.
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
  offline nodes still display their full manifest.

### 3.3 Actions and invocation

- Materialized actions are **node-scoped**: unique key `(node, name)`, with
  `handlerProvider` recorded for dispatch. Two nodes may both define
  `run-etl`.
- Invocation is node-addressed:
  `POST /v1/nodes/:node/actions/:name/invoke` (agent token, as today).
  Dispatch resolves capability → provider → socket.
- A capability may opt into a workspace-global alias
  (`global: true` at definition); the alias claims the workspace-global name
  and collides loudly, like any other registration conflict.
- Invoke targeting a capability whose provider is offline **fails fast** by
  default; a capability may opt into queueing (`queue: true`), reusing the
  existing offline-queue path keyed per provider.

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

export default defineNode({
  name: 'data-pipeline',
  capabilities: {
    'run-etl': action({
      description: 'Run the ETL job',
      handler: async (input, ctx) => runEtl(input),
    }),
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
  provider and serves the project's capability definition
  (`agent-relay.{ts,…}` via `@agent-relay/fleet`, or the implicit default
  node) as a second provider — both connecting directly to the engine with
  the enrolled node token. Enrollment pickup (`cloud enroll` →
  `fleet-enrollments.json` → env) is unchanged.
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

## 6. What does not change

- Enrollment flow and tokens: `cloud enroll` / `ocl_node_enr_` / `nt_live_`.
- Node identity derivation (machine id + cwd hash); multiple nodes per
  machine.
- fleet-wire framing, heartbeat cadence, delivery dedup/ack semantics.
- The broker's PTY/injection/supervision kernel (`relay-pty`) and agent
  delivery path.
- Observer/workspace streams (`/v1/ws`).

---

## 7. Sequencing

Upstream-first, per the release-train choreography:

1. **relaycast**: fleet-wire provider fields; engine provider attachment,
   node-scoped actions, node-addressed invoke; NodeDO multi-socket in
   relaycast-cloud. Additive — a single registration with no `provider` field
   is treated as one anonymous provider, so the current broker keeps working
   during the transition.
2. **relaycast SDKs**: node provider client in TS, Python, Swift (Rust client
   is the broker's, updated in step 3). Run the parity audit.
3. **relay**: retarget `@agent-relay/fleet` serveNode to the engine; CLI
   `node up` wiring; broker demotion and protocol deletions.
4. **Downstream** (pear, workforce): adopt node-addressed invocation.

Pre-launch stance applies: the sidecar protocol and workspace-global action
addressing are removed without compatibility shims. Node-scoped action rows
replace workspace-global ones; existing invocation URLs change.

---

## 8. Open questions

- Derived per-provider tokens: worth minting at attach time for audit
  attribution even before revocation is needed?
- Does anything actually need workspace-global action aliases at launch, or
  can `global: true` wait until a consumer asks?
