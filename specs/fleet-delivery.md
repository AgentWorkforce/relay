# Fleet Delivery — Agents, Nodes, and Reliable Messaging

**Status**: Draft
**Date**: 2026-06-06
**Author**: Design session (Will + Claude)

---

## 1. Vision

Run agents across many machines. Each machine (a **node**) can run a specific set of compute — some can spawn Claude agents, some Codex, some both. Relaycast is the control plane: agents are equal peers in a flat messaging fabric, nodes advertise what they can spawn, and Relaycast routes messages to agents wherever they live and places new agents onto nodes that can run them.

The goal is the simplest deployable unit that maximizes the environments a node can run in, with messaging that survives flaky networks and agent restarts.

## 2. The frame: two planes

Everything below lives on one of two planes. Keeping them separate is what keeps the model simple.

- **Messaging fabric — flat, all equal `agents`.** Every agent is a peer: a stable identity that sends, receives, and may expose actions. No agent is above or routed "through" another.
- **Compute layer — `nodes`.** A node is a machine where some agents run. It has a **broker** runtime and a set of **capabilities** (what it can spawn). Agents sharing a node is a deployment fact, not a relationship in the fabric.

There is **no "participant" umbrella and no agent subtype.** "Orchestrate vs communicate" is not a type distinction — it's just whether an agent is colocated on a node-with-broker or self-connected (see *location*, §5).

## 3. Core concepts

| Concept | What it is | Plane |
|---|---|---|
| **Agent** | a peer in the fabric: identity, send/receive, exposed actions | messaging |
| **Node** | a named machine that runs agents and advertises capabilities | compute |
| **Broker** | a node's runtime/delivery engine — **infra, not a peer** (not in the agent roster) | compute |
| **Location** | where Relaycast routes an agent's **inbound** | routing detail |
| **Capability** | what a node can spawn (e.g. `spawn:codex`) | compute |
| **Action** | something an agent exposes/invokes in the fabric | messaging |

The broker is node infrastructure with a control connection to Relaycast. A colocated PTY agent receiving via its broker is the same kind of plumbing as a NIC delivering to a process — a location, not a hierarchy.

## 4. Identities & naming

- **Agent**: stable `agent_id` + workspace-unique **name** (the addressable handle). One **active location** per agent name (a second live claimant is rejected; migration is explicit).
- **Node**: workspace-unique **name**, operator-set at startup (default: hostname), optionally backed by a stable internal id so a name can move to a replacement machine. Same uniqueness rule as agents: one live owner.
- The node's broker is the **token authority** for agents it spawns: it asks Relaycast to mint the agent identity + token on spawn, hands the token to the agent, and binds its location.

## 5. Delivery model — keep + delete

Most of this already exists; the work is mostly removal.

**Outbound (all agents): direct & stateless.** An agent sends with its own token straight to Relaycast (PTY agents via their MCP send tools; SDK agents via their own send). Sends are request/response — **no persistent connection required for sending**, and the broker is never in the send path.

**Inbound: delivered to the agent's location.** Location has exactly two shapes — a field, not a type:
- **Self-connected** (event-loop programs — SDK agents): the agent's own WS + message handler. This *is* the delivery path.
- **Via its node** (raw PTY harnesses with no event loop): the node's broker receives and injects into the agent's stdin.
  - `steer` = inject + interrupt to a prompt now.
  - `wait` = write to the buffer; the harness reads at its next prompt (the PTY defers naturally).

**Invariant: an agent has exactly one location.** This is the whole cleanup — the old redundancy was a via-node agent *also* holding its own WS. One location → no double delivery, no special-casing.

**Delete (these only ever applied to PTY agents):**
- The per-agent Relaycast WS (`RealtimeResourceBridge`).
- The MCP **resource layer** (`relay://inbox`, `relay://channels/...`, subscribe/notify) — it assumes a reactive client; turn-based harnesses don't subscribe.
- The **inbox piggyback** (stapling inbox onto every tool result).

**Keep:** on-demand read/query tools (`check_inbox`, `list_messages`, `thread`, `search`, `list_channels`) as **stateless cloud-direct reads** with the agent token. Pulling on your own initiative doesn't need a persistent connection. The MCP server for PTY agents becomes outbound + reads only.

**Consistency bolt:** delivery acknowledgement marks a message delivered/read in Relaycast, so a cloud-backed `check_inbox` never re-surfaces something already delivered. One source of truth for *history* (cloud), one for *delivery* (the location); the ack bridges them.

**Why the deleted layers existed (so we don't rebuild them):** the original design was MCP-idiom-first — inbox/channels as subscribable resources, the textbook way to surface stateful data. Turn-based harnesses didn't react to `resources/updated`, so the piggyback was bolted on, and stdin injection became the reliable push. Nothing was removed, leaving three overlapping inbound paths. **Lesson: design delivery around the agent's execution model (turn-based vs event-loop), not the protocol's idiom.**

## 6. Spawn & placement

**Spawn is not a protocol concept — it's a node capability**, expressed through the existing action mechanism (`actions.register('create', handler → driver.spawn)`). The "how spawning happens here" is a node-side harness definition (`definePtyHarness` / `StaticPtyHarnessDefinition`) — the script you provide when spinning up a node. A node advertises the capabilities it defines (e.g. `spawn:claude`, `spawn:codex`).

**Placement** takes an optional target:

```
spawn { capability, node?: <name> | "self", session_ref?, ttl_override? }

eligible = nodes where
    (node.name == target              if target given)
  ∧ capability ∈ node.capabilities
  ∧ node.live ∧ capacity_available
place: target if given, else least-loaded(eligible)
```

- `node: "gpu-box-1"` → must place there. Capability mismatch → **hard fail**. Offline → bounded-queue (or fail-fast per override).
- `node: "self"` → same node as the requester (the common **colocation** case: shared working dir, local artifacts). An agent needn't know its node's name.
- `node` omitted → scheduler picks any eligible (least-loaded).
- None eligible → bounded-queue, then fail.

**Resume is a special case of targeted spawn.** "Resume agent X" = spawn with `node: <origin node>` + its `session_ref`. There is no separate resume concept — it is placement constrained to the origin node plus a session reference (see §8.2).

**Node roster:** because agents/humans/schedulers can target by name, Relaycast exposes a **node discovery query** (name, capabilities, liveness, load) — the compute-layer roster, parallel to the agent roster, and what a UI like Pear renders.

## 7. Reliable action invocation (spawn rides on this)

Spawn inherits the action system's async invocation machinery (`invocationId`, ack, result) rather than a bespoke state machine. Exactly-once placement is impossible (dispatch, node dies before ack — did it start?), so the contract is **idempotency + at-least-once + reconcile**:

- `invocationId` is the idempotency key. A node dedups invocations by it; a requester retrying with the same id never double-spawns.
- Invocation lifecycle: `pending → dispatched(node) → completed(agent_id)`.
- **Dispatch timeout / node lost** before completion → **reschedule** to another eligible node with the same `invocationId`.
- **Reconcile on reconnect:** a node re-announces its live agent inventory (with `agent_id`, name, `invocationId`, `session_ref`) — see §9. If an invocation already completed elsewhere → the duplicate is released. **First to `completed` wins.** A dead broker brings no agents back (its children died with it), so the dead-node case reschedules cleanly; duplicates only arise from a live-broker uplink blip and are reconciled away.

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

| Situation | Resolution |
|---|---|
| Location temporarily unreachable (uplink/WS blip; process alive) | Hold + deliver on reconnect. Applies to **all** agents. |
| Process dead, resumable + session recoverable | Hold up to TTL; flush on origin-targeted resume (oldest-first). |
| Process dead, non-resumable OR session lost | **Dead-letter immediately** (notify senders). |

Consequence: persistence *across process death* is a **resumable-only** property. Non-resumable agents are ephemeral-on-death (still resilient to transient blips while alive).

### 8.4 Where state lives

- **Relaycast** holds all durable state (source of truth): mailboxes, agent records (`resumable`, `session_ref`, origin node), locations, node registry. Must survive Relaycast restarts.
- **Broker** keeps only in-memory per-session state: `seq` cursor, dedup set, local pending-injection queue. **No disk needed for delivery durability.**
  - Uplink blip, broker alive → cursor/dedup survive → clean replay, no duplicates.
  - Broker process dies → its child agents die too → they respawn and *want* redelivery → redelivery is correct, not duplicate.

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

- **Register** (on connect): node name, capabilities, version, `max_agents`, tags, and a resume cursor for replay.
- **Heartbeat** (~10–15s): `load`, `active_agents`. Relaycast TTL marks offline → stop placing there; mark its located agents unreachable.
- **Reconnect inventory sync:** after register, the broker re-announces its full live agent inventory (`agent_id`, name, `invocationId`, `session_ref`). Relaycast reconciles **locations** and open **invocations** (§7) from it.
- **Deregister:** graceful on shutdown; else liveness TTL.

**Narrow control surface** (the only Relaycast protocol the broker implements — *not* the full `@relaycast/sdk`; channels/threads/reactions/search stay in the agent SDK):

- **Broker → Relaycast:** `node.register`, `node.heartbeat`, `node.deregister`, `agent.register` (bind location), `agent.deregister`, `delivery.ack`, `action.result`, `inventory.sync`
- **Relaycast → Broker:** `action.invoke` (spawn/release are actions), `deliver`, `ping`

## 10. Deferred / open

- **Cross-node session resume** via cloud-synced session state (lifts node-sticky in §8.2).
- **Same-node fast-path (perf):** local A→B delivery bypassing the cloud, and whether it's allowed when the uplink is down.
- **Node tags / fuzzy targeting** (`gpu` instead of an exact name) and **access control** on who can target / spawn on which nodes.
- **Exact tunables:** TTL, mailbox depth cap, heartbeat interval/TTL, dispatch timeout.
- **Mark-read mechanism:** broker auto-mark on delivery (preferred) vs explicit `mark_read` tool — keep explicit only if a product reason emerges.

## 11. Pre-implementation verification (for the §5 delete)

1. No agent/harness lacking an injectable stdin that relies on resources for inbound (a purely-programmatic MCP agent would need a self-connected location instead).
2. No external/third-party MCP client consuming `relay://` resources as an API.

## 12. Decisions log

- **Frame:** flat fabric of equal **agents** (peers) + a compute layer of named **nodes**; **broker is node infra, not a peer**. No "participant" umbrella, no agent subtype. Orchestrate/communicate is just an agent's **location** (via-node vs self-connected).
- **Delivery:** outbound is direct & stateless; inbound goes to the agent's single **location**. Invariant: one location per agent. Delete the per-agent Relaycast WS, MCP resource layer, and piggyback (PTY-only); keep cloud-direct read tools; delivery-ack marks read.
- **Spawn = node capability** via the action system; **placement** is targeted (`name`/`self`) or any (least-loaded); **resume = origin-targeted spawn + session_ref**. Node roster for discovery.
- **Reliable invocation:** idempotency (`invocationId`) + at-least-once + reschedule + reconcile (first-to-`completed` wins); rides the action invocation machinery, no bespoke spawn state machine.
- **Durability:** bounded-durable mailbox; at-least-once + dedup by `msg_id`; per-location `seq`; cumulative ack. Mailbox subsumes node replay; broker stateless across restarts; Relaycast is source of truth.
- **Identity continuity requires session continuity:** resume is node-local; resumable agents node-sticky; otherwise fresh identity + dead-letter old mailbox.
- **Policy:** dead-letter → notify sender; overflow → reject-new; down-but-resumable → lazy-resume by default (eager opt-in); one active location per agent name.
