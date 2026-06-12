# Fleet Delivery — Agents, Nodes, and Reliable Messaging

**Status**: Draft
**Date**: 2026-06-06
**Last updated**: 2026-06-11 (Topology B amendments)
**Author**: Design session (Will + Claude)

---

## 1. Vision

Run agents across many machines. Each machine (a **node**) can run a specific set of compute — some can spawn Claude agents, some Codex, some both. Relaycast is the control plane: agents are equal peers in a flat messaging fabric, nodes advertise what they can spawn, and Relaycast routes messages to agents wherever they live and places new agents onto nodes that can run them.

The goal is the simplest deployable unit that maximizes the environments a node can run in, with messaging that survives flaky networks and agent restarts.

## 2. The frame: two planes

Everything below lives on one of two planes. Keeping them separate is what keeps the model simple.

- **Messaging fabric — flat, all equal `agents`.** Every agent is a peer: a stable identity that sends, receives, and may expose actions. No agent is above or routed "through" another.
- **Compute layer — `nodes`.** A node is a machine where some agents run. It has a **broker** runtime and a set of **capabilities** (what it can spawn). Agents sharing a node is a deployment fact, not a relationship in the fabric.

There is **no "participant" umbrella and no agent subtype.** "Orchestrate vs communicate" is not a type distinction — it's just whether an agent is colocated on a node-with-broker or self-connected (see _location_, §5).

**Topology B: the broker owns the wire.** The Rust broker holds the node's single Relaycast control WebSocket. `fleet serve` is the operator-facing launcher plus a crash-isolated TypeScript handler sidecar supervised by that broker. The sidecar contains the node script and handler code; the broker owns delivery, process supervision, and the remote control protocol. If the sidecar dies, the broker can stay connected and keep delivering to existing PTY agents, but node action handlers are unavailable until the sidecar reconnects (§9).

## 3. Core concepts

| Concept             | What it is                                                                                                                | Plane          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------- |
| **Agent**           | a peer in the fabric: identity, send/receive, exposed actions                                                             | messaging      |
| **Node**            | a named machine that runs agents and advertises capabilities                                                              | compute        |
| **Broker**          | a node's Rust runtime/delivery engine; owns the node control connection — **infra, not a peer** (not in the agent roster) | compute        |
| **Handler sidecar** | the TypeScript process launched by `fleet serve` that runs node action handlers, supervised by the broker                 | compute        |
| **Location**        | where Relaycast routes an agent's **inbound**                                                                             | routing detail |
| **Capability**      | what a node can spawn (e.g. `spawn:codex`)                                                                                | compute        |
| **Action**          | something an agent or node exposes/invokes in the fabric                                                                  | messaging      |
| **Trigger**         | a declarative message match that invokes an action engine-side                                                            | messaging      |

The broker is node infrastructure with a control connection to Relaycast. A colocated PTY agent receiving via its broker is the same kind of plumbing as a NIC delivering to a process — a location, not a hierarchy. A node can own action handlers without becoming an agent; node-native handlers are addressed through the action registry and dispatched over the node control connection.

## 4. Identities & naming

- **Agent**: stable `agent_id` + workspace-unique **name** (the addressable handle). One **active location** per agent name (a second live claimant is rejected; migration is explicit).
- **Node**: workspace-unique **name**, operator-set at startup (default: hostname), optionally backed by a stable internal id so a name can move to a replacement machine. Same uniqueness rule as agents: one live owner.
- The node's broker is the **token authority** for agents it spawns: it asks Relaycast to mint the agent identity + token before the child process starts, injects the token into the child environment, and binds its location. If local spawn fails after registration, the broker immediately deregisters the agent.
- A node is never entered into the agent roster. If an action is node-native, the action record points at the node (`handler_node_id`) rather than a handler agent.

## 5. Delivery model — keep + delete

Most of this already exists; the work is mostly removal.

**Outbound (all agents): direct & stateless.** An agent sends with its own token straight to Relaycast (PTY agents via their MCP send tools; SDK agents via their own send). Sends are request/response — **no persistent connection required for sending**, and the broker is never in the send path.

**Inbound: delivered to the agent's location.** Location has exactly two shapes — a field, not a type:

- **Self-connected** (event-loop programs — SDK agents): the agent's own WS + message handler. This _is_ the delivery path.
- **Via its node** (raw PTY harnesses with no event loop): the node's broker receives and injects into the agent's stdin.
  - `steer` = inject + interrupt to a prompt now.
  - `wait` = write to the buffer; the harness reads at its next prompt (the PTY defers naturally).

**Invariant: an agent has exactly one location.** This is the whole cleanup — the old redundancy was a via-node agent _also_ holding its own WS. One location → no double delivery, no special-casing.

**Delete (these only ever applied to PTY agents):**

- The per-agent Relaycast WS (`RealtimeResourceBridge`).
- The MCP **resource layer** (`relay://inbox`, `relay://channels/...`, subscribe/notify) — it assumes a reactive client; turn-based harnesses don't subscribe.
- The **inbox piggyback** (stapling inbox onto every tool result).

**Keep:** on-demand read/query tools (`check_inbox`, `list_messages`, `thread`, `search`, `list_channels`) as **stateless cloud-direct reads** with the agent token. Pulling on your own initiative doesn't need a persistent connection. The MCP server for PTY agents becomes outbound + reads only.

**Consistency bolt:** delivery acknowledgement marks a message delivered/read in Relaycast, so a cloud-backed `check_inbox` never re-surfaces something already delivered. One source of truth for _history_ (cloud), one for _delivery_ (the location); the ack bridges them.

**Why the deleted layers existed (so we don't rebuild them):** the original design was MCP-idiom-first — inbox/channels as subscribable resources, the textbook way to surface stateful data. Turn-based harnesses didn't react to `resources/updated`, so the piggyback was bolted on, and stdin injection became the reliable push. Nothing was removed, leaving three overlapping inbound paths. **Lesson: design delivery around the agent's execution model (turn-based vs event-loop), not the protocol's idiom.**

## 6. Spawn & placement

**Spawn is not a Relaycast control protocol concept — it's a node capability**, expressed through the action mechanism as a handler defined in the node's TypeScript script. The "how spawning happens here" is a node-side harness definition (`definePtyHarness` / `StaticPtyHarnessDefinition`) wrapped by a spawn handler (`spawn(claude)`, `spawn(codex)`, etc.) in the sidecar. A node advertises the capabilities its script defines (e.g. `spawn:claude`, `spawn:codex`).

The spawn handler runs in the TypeScript sidecar. It resolves the harness into an `AgentSpec` and asks the broker to execute the existing local `spawn_agent` frame:

```
{ v: 2, type: "spawn_agent", request_id?: string, payload: { agent: AgentSpec, initial_task?: string, skip_relay_prompt?: boolean } }
```

The broker executes that existing frame, supervises the child, and performs the pre-spawn token-authority flow so the child starts with credentials. It does **not** resolve harness definitions or run spawn policy.

**Placement** takes an optional target:

```
spawn { capability, node?: <name> | "self", session_ref?, ttl_override? }

eligible = nodes where
    (node.name == target              if target given)
  ∧ capability ∈ node.capabilities
  ∧ node.live ∧ node.handlers_live ∧ capacity_available
place: target if given, else least-loaded(eligible)
```

- `node: "gpu-box-1"` → must place there. Capability mismatch → **hard fail**. Offline → bounded-queue (or fail-fast per override).
- `node: "self"` → same node as the requester (the common **colocation** case: shared working dir, local artifacts). An agent needn't know its node's name.
- `node` omitted → scheduler picks any eligible (least-loaded). If the dispatched node is lost or reports handler unavailability before completion, Relaycast may reschedule to another eligible node using the same `invocation_id`.
- None eligible → bounded-queue, then fail.
- `live ∧ ¬handlers_live` → ineligible for spawn/actions. The broker may still be able to deliver messages to already-running PTY agents, but it cannot run node handlers while the sidecar is down.

Targeted placement never migrates. A targeted `node: "gpu-box-1"` spawn hard-fails on capability mismatch and otherwise queues or fails according to the target policy while that node is offline or lacks live handlers; it must not silently move to a different node.

**Resume is a special case of origin-pinned targeted spawn.** "Resume agent X" = spawn with `node: <origin node>` + its `session_ref`. There is no separate resume concept — it is placement constrained to the origin node plus a session reference (see §8.2). Resume queues for the origin node or fails by policy; it does not reschedule elsewhere without cross-node session sync.

**Node roster:** because agents/humans/schedulers can target by name, Relaycast exposes a **node discovery query** (name, capabilities, liveness, load) — the compute-layer roster, parallel to the agent roster, and what a UI like Pear renders.

## 7. Reliable action invocation (spawn rides on this)

Actions have two handler locations:

- **Agent-native:** the handler is an agent identity in the fabric.
- **Node-native:** the handler is a node (`handler_node_id`). Relaycast dispatches `action.invoke` over the node's control connection, and the node returns `action.result`. The node is still not an agent.

Spawn is a node-native action and inherits the action system's async invocation machinery (`invocation_id`, ack, result) rather than a bespoke state machine. Exactly-once placement is impossible (dispatch, node dies before ack — did it start?), so the contract is **idempotency + at-least-once + reconcile**:

- `invocation_id` is the idempotency key. A node dedups invocations by it; a requester retrying with the same id never double-spawns.
- Invocation lifecycle: `pending → dispatched(node) → completed(agent_id)`.
- **Untargeted dispatch timeout / node lost / handler unavailable** before completion → **reschedule** to another eligible node with the same `invocation_id`.
- **Targeted dispatch timeout / node lost / handler unavailable** before completion → do not migrate; keep the invocation pinned to the named node and queue or fail according to the target policy.
- **Reconcile on reconnect:** a node re-announces its live agent inventory (with `agent_id`, name, `invocation_id`, `session_ref`) — see §9. If an untargeted invocation already completed elsewhere → the duplicate is released. **First to `completed` wins** for scheduler-placed invocations. A dead broker brings no agents back (its children died with it), so the untargeted dead-node case reschedules cleanly; duplicates only arise from a live-broker uplink blip and are reconciled away.

There are two action entry points:

- **Explicit invocation:** agents and tools call actions directly through the MCP/SDK action surface.
- **Declarative message→action triggers:** Relaycast stores trigger declarations (channel/mention/regex in v1), matches them after message commit, and invokes the target action with the message as input. Trigger evaluation is engine-side, not a sidecar subscription. Triggers need a loop guard so action-generated messages do not re-trigger themselves, plus per-trigger rate limits.

## 8. Durability — bounded-durable mailbox

**Decision: bounded-durable.** A message for an unreachable agent is held for a TTL and delivered when it's reachable again; dead-lettered after. Reliable without infinite state.

### 8.1 Message state machine (held in Relaycast)

```
queued ──deliver(seq)──▶ delivered ──ack──▶ acked (≈read)
   │
   └── TTL expiry ──▶ dead-letter
```

- **At-least-once + dedup by `msg_id`.** Per-agent ordering falls out of a monotonic per-location `seq`.
- Relaycast pushes `queued` messages to the agent's location with a per-session `seq`; the location injects/handles, then **cumulative ack** (`up_to_seq`) advances them to `acked`.

### 8.2 Identity continuity requires session continuity

Reclaiming a mailbox without resuming the actual session would dump a backlog on a context-less process — worse than dead-lettering. So an agent reclaims its identity + held mailbox **only by resuming its session** (= origin-targeted spawn + `session_ref`, §6):

- **`resumable`** is a per-harness capability; on spawn of a resumable harness the broker captures the `session_ref` and reports it to Relaycast.
- **Resume is node-local (v1):** harness session state lives on the origin node's disk, so resumable agents are **node-sticky**. If the origin node is permanently gone, the session is unrecoverable → identity terminal → mailbox dead-lettered. (Cross-node resume needs cloud-synced session state — deferred, §10.)
- No resumable capability / no recoverable session → respawn is a **new identity**; the old mailbox is dead-lettered (senders notified).

### 8.3 Mailbox resolution

| Situation                                                        | Resolution                                                      |
| ---------------------------------------------------------------- | --------------------------------------------------------------- |
| Location temporarily unreachable (uplink/WS blip; process alive) | Hold + deliver on reconnect. Applies to **all** agents.         |
| Process dead, resumable + session recoverable                    | Hold up to TTL; flush on origin-targeted resume (oldest-first). |
| Process dead, non-resumable OR session lost                      | **Dead-letter immediately** (notify senders).                   |

Consequence: persistence _across process death_ is a **resumable-only** property. Non-resumable agents are ephemeral-on-death (still resilient to transient blips while alive).

### 8.4 Where state lives

- **Relaycast** holds all durable state (source of truth): mailboxes, agent records (`resumable`, `session_ref`, origin node), locations, node registry. Must survive Relaycast restarts.
- **Broker** keeps only in-memory per-session state: `seq` cursor, dedup set, local pending-injection queue. **No disk needed for delivery durability.**
  - Uplink blip, broker alive → cursor/dedup survive → clean replay, no duplicates.
  - Broker process dies → its child agents die too → they respawn and _want_ redelivery → redelivery is correct, not duplicate.

### 8.5 One durable store

The per-agent mailbox **subsumes** any per-node replay buffer: node-disconnect replay is just "redeliver this node's agents' unacked mail on reconnect." The per-location `seq` + ack is the at-least-once transport on top of the mailbox.

### 8.6 Policy (defaults, all tunable)

- **TTL:** workspace default (~1h placeholder) + per-message override ("5m or drop" for time-sensitive; longer for durable tasks).
- **Dead-letter on expiry:** retain briefly + **emit `delivery_failed`/expired to the sender** (reuse existing event). Silent drop is the wrong default.
- **Mailbox overflow:** **reject-new** with sender feedback (so senders learn the agent is backed up) rather than drop-oldest.
- **Inbound to a down-but-resumable agent:** **lazy by default** (queue; resume via restart-policy or explicit respawn), **eager opt-in** ("wake on message").
- **Restart policy:** a resumable agent with auto-restart → broker auto-resumes the session on its node and flushes the mailbox.

## 9. Node lifecycle & control surface

A node's broker holds one control connection to Relaycast, serving two roles: **compute provider** (advertises capabilities, receives spawn/release action invocations, reports results) and **delivery relay** (receives inbound for the PTY agents located on it, injects, acks).

- **Register** (on connect): node name, stable node id, capabilities, version, `max_agents`, tags, and an optional resume cursor for replay. An absent `resume_cursor` is equivalent to `null`.
- **Heartbeat** (~10–15s): `load`, `active_agents`, and `handlers_live`. Relaycast TTL marks offline → stop placing there; mark its located agents unreachable. A live node with `handlers_live: false` stays eligible for delivery to existing located agents but is ineligible for action dispatch and placement.
- **Reconnect inventory sync:** after register, the broker re-announces its full live agent inventory (`agent_id`, name, `invocation_id`, `session_ref`). Relaycast reconciles **locations** and open **invocations** (§7) from it.
- **Deregister:** graceful on shutdown; else liveness TTL.
- **Sidecar supervision:** `fleet serve` starts the TypeScript sidecar and registers its manifest with the broker. The broker supervises the sidecar as a crash-isolated child and flips `handlers_live` on sidecar connect/disconnect. Sidecar failure should not kill the broker or existing PTY children.

**Narrow control surface** (the only Relaycast protocol the broker implements — _not_ the full `@relaycast/sdk`; channels/threads/reactions/search stay in the agent SDK) uses a flat, versioned JSON envelope:

```
{ v: 1, type: "<discriminant>", ...payload }
```

There is no `payload` wrapper on the Relaycast ↔ broker control WebSocket. The `v` field is always `1`; `type` is the message discriminant; every payload field is snake_case. The schema is strict: unknown fields are invalid, and `action.result` includes exactly one of `output` or `error`.

**Broker → Relaycast:**

- `node.register`
  ```
  { v: 1, type: "node.register", name: string, node_id: string, capabilities: string[], max_agents: number, tags: string[], version: string, resume_cursor?: string | null }
  ```
- `node.heartbeat`
  ```
  { v: 1, type: "node.heartbeat", load: number, active_agents: number, handlers_live: boolean }
  ```
- `node.deregister`
  ```
  { v: 1, type: "node.deregister" }
  ```
- `agent.register`
  ```
  { v: 1, type: "agent.register", name: string, invocation_id?: string, session_ref?: string, resumable?: boolean }
  ```
- `agent.deregister`
  ```
  { v: 1, type: "agent.deregister", name: string }
  ```
- `delivery.ack`
  ```
  { v: 1, type: "delivery.ack", agent: string, up_to_seq: number }
  ```
- `action.result` (success)
  ```
  { v: 1, type: "action.result", invocation_id: string, output: JsonValue }
  ```
- `action.result` (failure)
  ```
  { v: 1, type: "action.result", invocation_id: string, error: string }
  ```
- `inventory.sync`
  ```
  { v: 1, type: "inventory.sync", agents: Array<{ agent_id: string, name: string, invocation_id?: string, session_ref?: string }> }
  ```

**Relaycast → Broker:**

- `deliver`
  ```
  { v: 1, type: "deliver", agent: string, msg_id: string, seq: number, mode: "wait" | "steer", payload: JsonValue }
  ```
- `action.invoke`
  ```
  { v: 1, type: "action.invoke", invocation_id: string, action: string, input: JsonValue }
  ```
- `ping`
  ```
  { v: 1, type: "ping" }
  ```

**Local broker ↔ sidecar protocol** is separate from the Relaycast control surface:

It reuses the existing harness-driver local envelope:

```
{ v: 2, type: "<discriminant>", request_id?: string, payload: { ... } }
```

Local `payload` fields are also snake_case. The fleet extension adds:

- **Sidecar → Broker:** `register_node`
  ```
  {
    manifest: {
      name: string,
      node_id?: string,
      capabilities: Array<{ name: string, kind?: string, metadata?: Record<string, JsonValue> }>,
      max_agents?: number,
      tags?: string[],
      version?: string
    },
    supervision?: { argv: string[], cwd: string, env?: Record<string, string> }
  }
  ```
- **Sidecar → Broker:** `register_handlers`
  ```
  { names: string[] }
  ```
- **Broker → Sidecar:** `invoke_handler`
  ```
  { invocation_id: string, name: string, input: JsonValue }
  ```
- **Sidecar → Broker:** `handler_result` (success)
  ```
  { invocation_id: string, output: JsonValue }
  ```
- **Sidecar → Broker:** `handler_result` (failure)
  ```
  { invocation_id: string, error: string }
  ```
- **Sidecar → Broker:** existing `spawn_agent`
  ```
  { agent: AgentSpec, initial_task?: string, skip_relay_prompt?: boolean }
  ```

The local manifest is capability names and metadata only; handler code remains in the sidecar. The optional supervision block is separate restart metadata for the broker (`argv`, `cwd`, `env`) and must not contain handler code. Existing local process control remains explicit: a spawn handler constructs an `AgentSpec` and asks the broker to execute the existing `spawn_agent` frame.

The cross-repo contract should live as versioned TypeScript wire schemas (zod) mirrored by Rust serde structs, with golden JSON fixtures shared by the Relaycast engine and broker tests. The protocol is implemented twice; fixtures are the compatibility boundary.

## 10. Deferred / open

- **Cross-node session resume** via cloud-synced session state (lifts node-sticky in §8.2).
- **Same-node fast-path (perf):** local A→B delivery bypassing the cloud, and whether it's allowed when the uplink is down.
- **Node tags / fuzzy targeting** (`gpu` instead of an exact name) and **access control** on who can target / spawn on which nodes.
- **Exact tunables:** TTL, mailbox depth cap, heartbeat interval/TTL, dispatch timeout.
- **Mark-read mechanism:** broker auto-mark on delivery (preferred) vs explicit `mark_read` tool — keep explicit only if a product reason emerges.
- **Node token minting:** self-hosted first-register minting vs hosted enrollment should converge on one token format.
- **Sidecar supervision when omitted:** `register_node.supervision` lets the broker re-exec the sidecar. If a node script omits that block, the broker only tracks connect/disconnect and reflects availability through `handlers_live`.

## 11. Pre-implementation verification (for the §5 delete)

1. No agent/harness lacking an injectable stdin that relies on resources for inbound (a purely-programmatic MCP agent would need a self-connected location instead).
2. No external/third-party MCP client consuming `relay://` resources as an API.

## 12. Decisions log

- **Frame:** flat fabric of equal **agents** (peers) + a compute layer of named **nodes**; **broker is node infra, not a peer**. No "participant" umbrella, no agent subtype. Orchestrate/communicate is just an agent's **location** (via-node vs self-connected).
- **Topology B:** Rust broker owns the node's single Relaycast control WS; `fleet serve` launches a crash-isolated TypeScript handler sidecar supervised by the broker.
- **Delivery:** outbound is direct & stateless; inbound goes to the agent's single **location**. Invariant: one location per agent. Delete the per-agent Relaycast WS, MCP resource layer, and piggyback (PTY-only); keep cloud-direct read tools; delivery-ack marks read.
- **Spawn = node capability** via a node-native action handler in the TypeScript sidecar; broker only executes the existing `spawn_agent { agent: AgentSpec }` frame and performs process/token supervision.
- **Placement** is targeted (`name`/`self`) or any (least-loaded); eligibility requires `live ∧ handlers_live ∧ capacity_available`; targeted placement never migrates; **resume = origin-pinned targeted spawn + session_ref**. Node roster for discovery.
- **Reliable invocation:** idempotency (`invocation_id`) + at-least-once + reconcile; automatic reschedule with the same `invocation_id` applies only to scheduler-placed untargeted invocations, where first-to-`completed` wins. Targeted invocations stay pinned and queue or fail by policy.
- **Node-native actions:** an action handler can be a node (`handler_node_id`), dispatched over the control connection; the node is not in the agent roster.
- **Triggers:** actions can be invoked explicitly through MCP/SDK or by declarative message→action triggers matched by Relaycast after message commit.
- **Durability:** bounded-durable mailbox; at-least-once + dedup by `msg_id`; per-location `seq`; cumulative ack. Mailbox subsumes node replay; broker stateless across restarts; Relaycast is source of truth.
- **Identity continuity requires session continuity:** resume is node-local; resumable agents node-sticky; otherwise fresh identity + dead-letter old mailbox.
- **Policy:** dead-letter → notify sender; overflow → reject-new; down-but-resumable → lazy-resume by default (eager opt-in); one active location per agent name.

## 13. Phased implementation summary

1. **Protocol contract:** merge this spec, define Relaycast↔broker wire schemas, extend the local broker protocol, and lock Rust/TypeScript fixture round-trips.
2. **Relaycast engine nodes/actions:** add node registry, node control WS, node-native action dispatch, placement, trigger storage/matching, and node roster queries.
3. **Relaycast delivery cleanup:** evolve deliveries into the bounded mailbox state machine, route inbound by location, and remove the old PTY-only resource/piggyback paths after verification.
4. **Rust broker control plane:** implement the node WS client, heartbeat with `handlers_live`, delivery/ack, sidecar dispatch, sidecar supervision, inventory sync, and token-authority registration.
5. **Relay CLI/SDK:** add `@agent-relay/fleet`, `fleet serve`, `fleet nodes/status`, default local-up compatibility, `query_nodes`, and a first-class spawn action tool.
6. **Cloud adapters/dashboard:** implement the node connection registry in Cloudflare, node enrollment, dashboard node roster, and sandbox-as-node integration.
7. **Rollout:** feature-flag per workspace, verify old brokers keep working, run the two-node E2E matrix, then flip defaults and delete legacy delivery paths.

## 14. Open decisions appendix

- **Node token minting:** self-hosted workspaces can mint on first register with a workspace key; hosted workspaces likely use a relayauth enrollment flow. Both should issue the same token shape.
- **Sidecar supervision omission policy:** with `register_node.supervision`, the broker can re-exec the sidecar; without it, the broker only tracks handler availability through `handlers_live`.
- **Trigger v1 surface:** proposed v1 is channel + mention + regex, with schema room for richer matchers later.
- **Cloud workers convergence:** keep existing hosted `workers`/`workAssignments` separate in v1; converge only after fleet placement is proven.
- **Tunables:** mailbox TTL, depth cap, heartbeat interval, liveness TTL, and dispatch timeout should be chosen with the Phase 2 test matrix rather than fixed in this spec.
