# Spawn node advertisements and agent lifecycle

Status: design and v1 implementation for the desktop's spawn node
(`probe/src/relay/spawn`). Builds on [native-spawn.md](native-spawn.md).

The hosted gateway can refuse control work with `d1_pressure` before admitting
any mutation. The desktop follows the broker's bounded retry policy: the exact
same registration frame and request id, up to five retries over 25 seconds,
with delays of 1, 2, 4, 8 and 8 seconds. An uncertain timeout or disconnect is
never retried as a registration. One-way action results carry correlation ids
and retry only after explicit pressure; a rejected result survives socket
reconnection so a successful worker is not left permanently dispatched.

## Plan

### What the node advertises

Two kinds of facts, kept apart on the wire:

| | Configured | Live |
| --- | --- | --- |
| What | Harnesses, billing mode per harness, full access per harness, repositories, maximum agents, whether teammates may spawn here, and what the node is (`node_kind` `desktop`, `machine`) | Slots (max, held, reserved, free, by work state), resources (CPUs, 1-minute load average, total and available memory), per-agent lifecycle, slots reclaimed with unfinished work |
| Set by | The person in Settings, or an agent through `settings.set` | Measured by the node |
| Changes | Rarely; stable between edits | Every heartbeat (12 s), stamped `observed_at` |
| Where | `node.register` and every `node.heartbeat`: top-level `max_agents`; `repo_keys` (register only, Relaycast turns them into `repo:<owner/name>` tags); `metadata.configured` on each `spawn:<harness>` capability | Every `node.heartbeat`: `active_agents`, `load` with `load_reported: true` for finite caps (unknown for unlimited); `metadata.live` on each `spawn:<harness>` capability (node-wide slots and resources) and on `release` (the agents it can release, and slots reclaimed) |

Relaycast's heartbeat and inventory frames are strict schemas, so capability
`metadata` (free JSON, replaced on every heartbeat and returned by the node
roster) is the only place for anything beyond `active_agents`, `load` and
`max_agents`. Tags and `repo_keys` only change at `node.register`, so a change
of repositories reconnects the node; a change of maximum agents or billing goes
out on the next heartbeat.

Configured settings (store keys, `settings.get`/`settings.set`):
`spawn_max_agents` (0 means no limit, the default; optional cap 1–32), billing per harness
(`spawn_harnesses.<id>.billing`, and for Codex and Claude also
`spawn_billing_codex` and `spawn_billing_claude`: `subscription`, `api` or
`unspecified`, default `unspecified`), `spawn_repositories` (owner/name keys,
default none), `spawn_allow_teammates` (default false).


Each `spawn:<harness>` capability's `metadata.configured`:

| Field | Value |
| --- | --- |
| `harness` | The harness id, such as `codex` or `claude` |
| `billing` | `subscription`, `api` or `unspecified` |
| `full_access` | The harness's full-access setting |
| `max_agents` | `spawn_max_agents` |
| `repositories` | `spawn_repositories` |
| `node_kind` | Always `desktop`: a person's computer, not a cloud or broker node |
| `machine` | This computer's name as agent metadata shows it (`host`: the host name without `.local`) |
| `teammates` | `spawn_allow_teammates`: workspace owners and admins may spawn here, not only the node's owner. Cloud enforces it |

### Owner claim

Cloud reads a node's owner from its own records, which the desktop fills by
claiming its node for the signed-in person (`POST /fleet/nodes/claim` with the
node token and the person's Cloud session, once Cloud confirmed the session
is that person's) before the node registers, after a sign-in, and every
minute after, backing off after failures; the claim never holds spawning up. A node another account owns advertises no
`spawn:<harness>` capability and refuses spawns until a claim succeeds; the
status says "This computer's spawn node belongs to another account." Without a
sign-in nothing is asked. Turning spawning off keeps the claim. Details:
[native-spawn.md](native-spawn.md#whose-computer-it-is).

### Placement stays with the requester

The requesting agent reads the roster (`capabilities[].metadata`, `live`,
`last_heartbeat_at`, `max_agents`, `active_agents`) and names the exact node.
The node never queues, waits for a slot or reroutes. It validates and reserves
atomically, then answers with one of:

| Outcome | When |
| --- | --- |
| `spawned: true` | A slot was reserved, the agent registered and launched |
| `spawn_capacity_exceeded` | Every slot is held (retained idle agents included), and the last advertisement already said so |
| `capacity_changed` | The last heartbeat advertised free slots, but they were taken (or the maximum lowered) since: re-read the roster |
| `spawn_harness_unavailable` | The harness is not installed here (`retryable: false`) |
| `spawn_target_unavailable` | The core is stopping as the invoke arrives |
| `spawn_target_offline` | Never sent by the node, which answers only while connected; Relaycast/Cloud use it for a target that is not live |
| `spawn_disabled`, `spawn_agent_name_in_use`, `spawn_invalid_input`, `spawn_failed` | Plain `error` strings, as in v1 |

With the gate below open, the five agreed codes go out as `{"error": "<code>",
"error_details": {code, message, node, harness, active, reserved, max,
observed_at, retryable}}`, with unknown counts omitted. Every failure ends that
attempt: no queue, no hidden retry, no reroute; the caller keeps the task.

**The `error_details` gate.** Relaycast's strict `action.result` schema rejects
the extra field today, so the gate is set per connection. The node advertises
`{name: "relay:spawn-error-details-v1", kind: "capacity"}` at `node.register`.
It sends details only when the register reply's data carries the
server-authored `spawn_error_details_contract: "relay:spawn-error-details-v1"`.
`accepted_capabilities` can't serve as the gate, because Relaycast accepts
every name. In every other case only the plain code goes out as `error`. A
reconnect learns the gate again (`wire::error_details_agreed`,
`NodeLink.error_details`).

Relaycast itself reserves capacity for a targeted spawn from the last
heartbeat's `active_agents` and `max_agents` (503 `handler_unavailable` at
capacity); the node's own check is the authoritative one, because only the node
knows about spawns in flight and slots that just changed.

### Lifecycle: three independent pieces of evidence

Each spawned agent carries three timestamped observations. Each reads as
`unknown` once older than its time to live, never as its last value.

| Evidence | States | Source | Observed | Stale after |
| --- | --- | --- | --- | --- |
| Node reachability (machine ↔ Agent Relay) | `reachable`, `unreachable`, `unknown` | The node socket: last heartbeat written; the time it dropped | Every heartbeat | 45 s (Relaycast's own liveness window) |
| Process liveness | `running`, `exited`, `unknown` | Claude: its pid and start time. Codex: archived thread (exited), loaded in Codex's app-server (running), daemon answered without it or no Codex runs (exited), empty or failed answer (unknown) | Every 15 s | 60 s |
| Harness work state | `working`, `idle`, `waiting`, `completed`, `unknown` | Codex rollout: a turn started and not completed is `working`. Claude: registry `status` (`busy`, `idle`, `waiting`) else its stream-json log (last event `result` is idle, anything after it is working); an exit right after a `result` is `completed`. A Codex thread archived is `completed` | Every 15 s | 60 s |

Transitions:

```text
spawn ─▶ reserved ─▶ (registered + launched) ─▶ held: running/working
held: working ⇄ idle ⇄ waiting                 (harness evidence; slot kept)
held: any ─▶ unknown                            (evidence older than its TTL; slot kept)
held: running ─▶ exited (+ completed?)          (positive evidence only) ─▶ reclaimed
reclaimed ─▶ held                               (the session came back: Codex thread reloaded)
any ─▶ released                                 (explicit release: process stopped, registration removed)
Codex thread archived ─▶ completed              (existing archive path removes the registration)
```

### Slot accounting

- A slot is held from reservation until explicit release, or until the
  process is positively seen `exited` (crash, clean completion, or a Codex
  thread no longer loaded anywhere). `idle`, `waiting` and `unknown` keep it.
- `held` = spawned registrations that are not archived and not observed
  `exited`; `reserved` = spawns between the capacity check and the saved
  registration. A spawn is admitted when `max == 0` (no limit), or while
  `held + reserved < max` for an explicit cap.
- A reclaimed agent keeps its registration (missing, so it drops out of
  `inventory.sync` and Relaycast marks it offline with `agent.exited
  missing_from_inventory`) until it is released: its name stays taken and its
  unfinished work stays visible.
- Lowering a finite maximum below what is held stops nothing: new spawns are
  refused until enough are released.

### Restart reconciliation

The ledger is in memory. Spawns that were starting when the core stopped
are kept on disk instead and settled when the node connects, before its
first inventory: an agent still running is kept, anything else is stopped
and taken off the node ([native-spawn.md](native-spawn.md#lifetime)). After
the core restarts, the first activation pass
observes every spawned registration at once against the real harness sessions
(processes, Codex's daemon, rollouts and Claude logs) before anything is
reclaimed. Agents still running keep their slot; genuinely dead ones are
reclaimed with what they left unfinished: a turn in progress when they died
(Codex rollout turn without `task_complete`, Claude log without a final
`result`) and deliveries not yet acknowledged (their Relaycast queue). That is
reported in the activity log, in the agent's row and in `release` capability
metadata (`live.reclaimed`, the last 8). The node pushes `inventory.sync` and a
heartbeat at once when slots change, rather than waiting for the 60 s cycle.

### Removal

Only by explicit `release` (Relaycast `action.invoke release`, or removing the
agent in the app), or completion through the existing archive path (Codex
thread archived). A safe idle policy is defined but not turned on: release an
agent idle for longer than a set time only when its process is `running`, its
work `idle` (not `unknown`), no turn is running, no delivery is in flight on
its line and its Relaycast queue is empty.

### Where it lives

| Piece | File |
| --- | --- |
| Lifecycle rules (evidence, staleness, slots, admission, harness state readers) | `probe/src/relay/spawn/lifecycle.rs` |
| Harness observation (`Observe`, `RegistryObserver`) | `probe/src/relay/spawn/observe.rs`, each harness's adapter in `probe/src/relay/harness/` |
| Resource sampling | `probe/src/relay/spawn/resources.rs` |
| Per-core ledger (reservations, evidence, heartbeat time, reclaimed) and wiring | `probe/src/relay/spawn.rs`, `spawn/ledger.rs`, `spawn/reconcile.rs` |
| Spawns in flight on disk; settling them and carrying agents over to a new node id | `probe/src/relay/spawn/intents.rs`, `spawn/recover.rs`, each adapter's `SpawnFacet::find` |
| Frames and metadata | `probe/src/relay/spawn/wire.rs`, `probe/src/relay/spawn/node.rs` |
| Owner claim (`spawn-node-claim.json`) | `probe/src/relay/spawn/claim.rs` |
| Contract types (`SpawnSlots`, `SpawnedAgentState`, evidence) | `probe/src/relay/state.rs`, `contract/agents.rs` |

## Owner binding

`SpawnOrigin.owner` (`SpawnOwner {workspace_id, user_id, relay_workspace_id,
actor_id, authority_hash}`) binds the person to the agent's immutable
`agent_id` once, at the spawn, and is kept in the store across reconnects and
restarts. `spawn::owner_of(registration)` returns `Known(owner)` or `Unknown`;
unknown means peer-only (no owner input). The owner is never read from the
action input, the task, or Relaycast metadata (`metadata.fleet`,
`cloud_user_id`). A re-sent invocation answers as before. The same invocation
asking for another name or harness is refused (`spawn_invalid_input`), and so
is a name under another invocation (`spawn_agent_name_in_use`).

Today the owner is always unknown. Relaycast stamps `caller_id` only for
caller-aware `action` capabilities (`relay.action-caller: v1`), and spawn and
release are `capacity`. Even then `caller_id` names the invoking agent, not a
person. To bind an owner, the node needs one of:

1. A server-owned invoke field stamped by Relaycast from Cloud's authenticated
   spawn (not from the input), e.g. `owner: {workspace_id, user_id,
   relay_workspace_id, actor_id, authority_hash}`, plus a Relaycast signature
   or the node token's trust in the socket as the proof.
2. Or a Cloud endpoint the node can call with its node token and the
   `invocation_id` that returns the journaled `SpawnOwner`, with
   `authorityHash` to check.

## Quota hook

`wire::Live.quota` (`metadata.live.quota` on each `spawn:<harness>`) takes
`QuotaSignal {state, reason, observed_at, fresh, resets_at}`, the shape of
`relay::quota::QuotaReading` (lanes `CodexOAuth`/`CodexRpc` map to Codex,
`ClaudeOAuth` to Claude). A reading that is not fresh is sent as `unknown`.
`Core::harness_quota` is the one place to wire it. It must read only
`QuotaCache::snapshot(now)`, an instant read in which anything older than
180 s is unknown. It must never call `quota::collect`, because a helper run
takes up to 35 s and the heartbeat goes every 12 s. `QuotaCache::spawn_refresh`
keeps the cache fresh every 120 s and starts nothing while no lane is on. Until
a lane is approved, the field is `null`.

## Liveness and observation

Liveness comes from `Spawner::alive` (Claude pid and start time; Codex not
archived; Grok's leader pid and start time), refined by
`observe::RegistryObserver`, which asks each session's harness adapter
(`relay::harness`): Codex app-server loaded threads and rollouts; Claude's
registry `status` and its stream-json log under
`<app data>/spawned-agents/<session id>.jsonl` (`launch::SPAWN_LOGS`); the turn
events in a Grok session's `events.jsonl` (`turn_ended` last is idle, an
unanswered `permission_requested` waiting, any other turn event working). A
launcher that knows more first-hand (scope active or exited, exit status) can
answer first through `Spawner::observe`.

## Open questions

- A reclaimed Codex thread (not loaded anywhere) can still be resumed by a
  later delivery. Should the node resume it, or leave it reclaimed until
  released?
- The safe idle release policy is defined above but off. Should it ship, and
  with what idle time?
- Capability metadata that changes on every heartbeat makes Relaycast run its
  roster prune pass each beat. A dedicated live-signal field on
  `node.heartbeat` would avoid it.
- Places reclaimed with unfinished work reach the requester only through
  `release` metadata and `agent.exited missing_from_inventory`. Should
  `agent.exited` carry a reason and the unfinished work?
- Billing and repositories have no Settings UI yet. They are set through
  `settings.set` (`spawn_harnesses.<id>.billing`, or `spawn_billing_codex`
  and `spawn_billing_claude`; `spawn_repositories`).
- Spawned agents' rows do not show their lifecycle yet. It is in
  `agents.list` (`LocalAgent.spawn`).

## End-to-end matrix

Nothing below has been run. Every row needs a dedicated session named
`e2e-lifecycle-*` that is spawned for the test. No existing session is
messaged, stopped or touched. Rows marked **approval** need maintainer approval first.
Turning on **Accept spawns** on a machine enrolls a real Relaycast node
(`<prefix>-desktop`), so it is a step that needs approval on every machine
below.

Shared evidence: the node roster (`GET /v1/nodes`, publicNode:
`capabilities[].metadata.configured/live`, `live`, `last_heartbeat_at`,
`active_agents`, `max_agents`), `action.result` frames, the app's activity log
and `agents.list` → `spawn`.

| # | Scenario | Machine | Session | Steps | Expected evidence | Disruptive / approval |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | Enable the node | test-node-a (branch build installed) | — | Settings → Spawned agents → Accept spawns on; Maximum 2; `settings.set spawn_billing_codex=subscription` | Roster shows `test-node-a-desktop`: `spawn:codex`/`spawn:claude` with `metadata.configured` (billing, full_access, max 2) and `metadata.live` (`observed_at`, slots 0 of 2, resources); `max_agents` 2; `load_reported` | Enrolls a node: **approval** |
| 1 | Configured vs live | test-node-a | — | Change the maximum to 3, then billing; watch two heartbeats | `max_agents` and `configured` change on the next heartbeat with no reconnect; `live.observed_at` moves each beat. Changing repositories reconnects (new `instance_id`) and shows `repo:` tags | Settings only, after row 0 |
| 2 | Capacity outcomes | test-node-a (max 1) | `e2e-lifecycle-cap-1`, `-cap-2` | Spawn cap-1 targeting the node; spawn cap-2 immediately (within 12 s), then again after a heartbeat | cap-1 `spawned`; first cap-2 `capacity_changed`; second `spawn_capacity_exceeded`, both with `error_details` (active 1, max 1, retryable) and no queued or rerouted spawn. Relaycast may refuse first with 503 `handler_unavailable` | Starts one Codex thread: **approval** (row 0) |
| 3 | Idle retention | test-node-a | `e2e-lifecycle-idle` | Spawn with a one-line task; wait until it finishes; wait 5 min | Row: process `running`, work `idle`, holds place; `live.slots.held` 1, `idle` 1; `active_agents` 1; still in inventory | Low; after row 0 |
| 4 | Crash of a spawned agent | test-node-a | `e2e-lifecycle-crash` (Claude) | Spawn with a long task; while `working`, `kill -9` only that agent's pid (from `agents.list` → registration process) | Within 15 s: process `exited`, unfinished `turn_in_progress: true`, place freed, activity "…in the middle of a turn"; next inventory drops it and Relaycast emits `agent.exited missing_from_inventory`; `release.metadata.live.reclaimed` lists it | Kills only the test agent; **approval** |
| 5 | Stale heartbeat / node unreachable | test-node-a | `e2e-lifecycle-net` | With one idle agent, block only the node's WebSocket (pf rule on the Relaycast host) for 90 s, then lift it | Locally: node `unreachable` from the drop; process and work keep their own evidence. Relaycast: `live` false after 45 s and `active_agents_stale` true. On reconnect: register, inventory and heartbeat; node `reachable` | Briefly cuts this Mac's Relaycast traffic for every session: **approval**; prefer a VM |
| 6 | Explicit release | test-node-a | `e2e-lifecycle-release` | Spawn; then Cloud `release_relay_agent` with `expected_agent_id` | `{released: true}`; process stopped; registration and ledger gone; `held` decreases; a later spawn of the same name works | Low; after row 0 |
| 7 | Core restart recovery | test-node-a | `e2e-lifecycle-rs-alive` (Codex), `e2e-lifecycle-rs-dead` (Claude) | Spawn both; quit Agent Relay; `kill -9` only rs-dead; start Agent Relay | Before the first pass, both hold places (unknown). After it: rs-alive running (Codex daemon kept the thread), rs-dead reclaimed with unfinished work and pending deliveries counted; immediate inventory and heartbeat | Restarts this Mac's core, so every session's delivery pauses briefly: **approval** |
| 8 | Agents surviving a core update | test-node-a, then test-node-b | `e2e-lifecycle-upd` | Spawn; install the next branch build over `/Applications/Agent Relay.app`; relaunch | Same agent_id and registration; process `running` after the first pass; no new `agent.register`; owner still unknown | Installs a build: **approval** |
| 9 | Linux service restart | test-node-linux | `e2e-lifecycle-linux` (Claude), `-linux-codex` | Enable spawns; spawn both; `systemctl --user restart agent-relay.service` (never stop or disable it) | Today's cgroup ends both (native-spawn.md): both reclaimed with unfinished work after restart. With the systemd-scope launcher, both should survive and stay held | Restarts the test node's service: **approval** |
| 10 | Cross-machine placement | requester on test-node-c; targets test-node-a-desktop and test-node-b-desktop | `e2e-lifecycle-place-*` | A requester agent reads the roster, picks the node with free places and the repository, and spawns with `target_node` | The node named is the one used; a full node answers `spawn_capacity_exceeded` and the requester, not the node, chooses again | Enrolls two nodes: **approval** |

## Successful invocation receipts

A successful spawn saves its public output in a private `spawn-completions/`
receipt before answering the action. The receipt survives release and core
restart. A later invocation with the same workspace and invocation id returns
the original output, including an unconfirmed-task warning, without registering
or launching another agent. Rebinding that invocation to another name or
harness is refused. Replays are checked before current settings or capacity.

Receipts are loaded on demand; completed invocations do not accumulate in an
in-memory cache. Files have mode 0600 in a 0700 directory and contain no task,
working directory, agent token or workspace key. SHA-256 digests of the origin
and workspace credential scope their filenames; credential rotation changes
that scope when discovery has no persistent workspace id. A receipt that cannot
be read fails closed. A receipt that cannot be written after the agent was
launched and its registration saved does not turn the spawn into a failure: the
running agent is reported as spawned, and replays are answered from its
registration until a receipt is written. Release and removal in the app
(`agents.unregister`) save the receipt for such, older or recovered
registrations before removing their durable registration, and refuse while it
cannot be saved. The registration keeps the first task's unconfirmed-task
verification (`taskUnconfirmed`; `interrupted` for an agent kept after a
restart), so an answer from it carries the same warning as the first.

A spawn refuses before registering on Relaycast when its intent
(`spawn-intents.json`) cannot be written, and before launching when the
returned agent id and token cannot be. A launch whose session the intent could
not record, or whose worker panicked, is stopped, its intent marked ended and
the agent deregistered, so a restart never keeps it.

A release forgets the agent only once its end is confirmed: its process gone,
or its Codex thread archived (or already archived). Otherwise it answers
`release_failed: could not end @name: …`, and the registration, name and place
are kept so the release can be asked again.
