# Scoped credentials for spawned agents

Status: proposed; design only. Do not remove workspace credentials from workers without Khaliq's approval and the server-side authorization evidence described below.

## Problem and security boundary

The broker currently gives ordinary agent workers the workspace's administrative credential through `AGENT_RELAY_WORKSPACE_KEY`, `RELAY_WORKSPACE_KEY`, and `RELAY_API_KEY`. In multi-workspace mode it also gives them `RELAY_WORKSPACES_JSON`; each entry includes an `api_key`. A worker that only needs collaboration can therefore perform workspace- or node-administration operations that are outside its role.

The intended boundary is:

- The node process retains node identity and workspace administration credentials.
- Each remote worker receives only its own `RELAY_AGENT_TOKEN`, identity metadata, and a route.
- Local-only workers receive no Relaycast credential.
- A worker credential may send and receive as that agent and maintain its presence, but must not create workspaces, create or rename nodes, mint observer links, rotate other identities, or obtain a workspace credential.

This proposal covers all bearer-capable workspace material, including the multi-workspace JSON, rather than removing only one alias.

## Evidence from current consumers

The following is based on the current `main` implementation.

| Surface | Current behavior | Is the agent token sufficient today? |
| --- | --- | --- |
| Broker registration | `crates/broker/src/runtime/session.rs` and `relaycast/auth.rs` require workspace credentials to establish the broker's workspace sessions. | No, and this stays in the broker. |
| Worker admission | `runtime/api.rs` and `runtime/fleet.rs` pre-register or bind the worker and inject its token as `RELAY_AGENT_TOKEN`. | Yes for the worker's identity; registration remains broker-owned. |
| MCP startup | `agent-relay-mcp.ts` skips workspace-key bootstrap when it sees a valid agent token or `RELAY_SKIP_BOOTSTRAP`. | Yes for startup. |
| MCP messages, inbox, DMs, channel reads/writes, reactions, realtime | MCP uses `createAgentClient`; the SDK's thin agent client and realtime client authenticate with the agent token. | Yes. |
| MCP `list_agents` and the agents resource | Both call the workspace client through `getRelay()`. | No in the current client path. The server and SDK need an agent-scoped roster read. |
| MCP `query_nodes` | Constructs a workspace-key `AgentRelay` client. | No in the current path. It needs an explicitly authorized agent-scoped node inventory read. |
| MCP `spawn` | Invokes the `spawn` action with the agent token. | Yes, subject to server action authorization. |
| MCP `add_agent` | Calls workspace-scoped `agents.spawn`. | No. It should converge on the token-scoped `spawn` action or be unavailable to scoped workers. |
| Workspace/observer/identity administration tools | Create/set workspace, observer token minting, and recovery paths intentionally use the workspace client. | No, by design. Scoped workers must not gain these operations. |
| `agent-relay message dm send` | The send is agent-scoped, but exact recipient resolution separately reads the workspace roster and treats an unresolved recipient as failure. | Partly. Sending works; recipient resolution must become agent-scoped before removing the key. |
| Other CLI message/channel commands | `createAgentRelay` already prefers an explicit or ambient agent token over persisted/ambient workspace credentials. | Mostly; add conformance coverage for every command exposed to workers. |
| Harness driver | It uses a workspace key to start a broker. A worker launched by that broker does not need the driver's key. | Not applicable to the worker; the driver remains a broker-side boundary. |
| `AGENT_RELAY_LOCAL_ONLY` | `worker.rs` strips workspace, agent, node, and multi-workspace credentials and does not inject the MCP collaboration surface. | Yes; preserve this credential-free behavior. |
| Multi-workspace worker | `runtime/init.rs` and `wrap.rs` serialize every workspace membership with its workspace key. | No. One agent token is bound to one workspace; multi-workspace needs one scoped identity per workspace or a server-side federated session. |

## What breaks if the workspace credentials are removed now

Messaging, inbox reads, channel participation, direct delivery, realtime notifications, and action-based spawn continue to have an agent-token path. The following regressions remain:

1. MCP `list_agents` and `relay://agents` fail because `getRelay()` refuses to operate without a workspace key.
2. MCP `query_nodes` and direct `add_agent` fail for the same reason.
3. CLI DM send can enqueue through the agent client but cannot prove exact recipient resolution, so the command reports failure.
4. Token invalidation recovery currently has workspace-key fallbacks for re-registration or release. A worker without the key needs broker-mediated rotation/rebind rather than an administrative fallback.
5. Multi-workspace routing loses every secondary workspace because the current transport is a list of workspace keys, not scoped agent credentials.
6. Some generated MCP configurations still explicitly embed `RELAY_API_KEY`; every CLI-specific generator and snapshot must be changed together.

Removing the key before these gaps are closed would produce partially working agents and encourage unsafe fallbacks. It must not be done as a one-line environment change.

## Migration path

### Phase 1: prove the scoped authorization contract

Add server and SDK conformance tests that use only an agent token. The allowed matrix must include:

- send, reply, DM, DM conversation reads, inbox, read receipts, reactions;
- channel list/join/leave and the intended channel-management subset;
- self identity and presence/realtime heartbeat;
- workspace roster read needed for exact recipient resolution;
- node inventory read and action invocation needed for `spawn`.

The denied matrix must include workspace creation, workspace credential recovery, node creation/rename, observer-token minting, other-agent token rotation, and any workspace-administration endpoint. A denial must remain a denial even if workspace identifiers or node identifiers are supplied.

This is the dependency on the companion server guard. The Relay change should not infer permissions from client behavior alone.

### Phase 2: remove workspace-only client dependencies

- Give the agent thin client an authorized roster-read method and use it for MCP `list_agents`, `relay://agents`, messaging recipient resolution, and CLI DM resolution.
- Give it a read-only node inventory method if the server contract permits it.
- Route both `spawn` and `add_agent` through the action invocation path. Do not preserve a direct workspace-scoped spawn fallback in workers.
- Keep create/set-workspace, observer minting, node administration, and identity recovery unavailable when the session has only an agent token.
- Replace workspace-key recovery with a local broker-mediated token rotation/rebind protocol. The worker authenticates to the broker as its existing identity; only the broker talks to the workspace administration plane.

### Phase 3: canary a single-workspace worker boundary

Introduce a broker feature flag, suggested name `AGENT_RELAY_SCOPED_WORKER_CREDENTIALS`.

When enabled for a non-local, single-workspace spawn with a successfully minted agent token:

- inject `RELAY_AGENT_TOKEN`, `RELAY_AGENT_NAME`, `RELAY_AGENT_TYPE`, `RELAY_STRICT_AGENT_NAME`, and the configured base URL;
- omit `AGENT_RELAY_WORKSPACE_KEY`, `RELAY_WORKSPACE_KEY`, `RELAY_API_KEY`, and `RELAY_WORKSPACES_JSON` from both the worker process and every generated MCP config;
- keep non-secret workspace identifiers only when a tested consumer needs them;
- refuse the spawn if the scoped token is missing or unusable. Do not silently fall back to a workspace credential while the flag is enabled.

Start disabled, enable in CI and a non-production canary, then invert the default only after the conformance matrix is green. The flag is the rollback: disabling it restores the existing delegation while a canary issue is investigated.

### Phase 4: multi-workspace workers

Do not pass `RELAY_WORKSPACES_JSON` in its current form. Choose one of:

1. Broker-mediated operations: the worker keeps one identity and asks the local broker to perform explicitly authorized cross-workspace routing.
2. Per-workspace scoped identities: provision one agent token per membership and expose them through a broker-owned credential service or a narrowly scoped descriptor, not workspace keys in an environment JSON blob.
3. A server-issued federated agent session whose grants name the permitted workspaces and operations.

Option 1 has the smallest exposed credential surface and is preferred. Until one is implemented and reviewed, multi-workspace brokers remain outside the scoped-credential canary rather than receiving an incomplete migration.

## Smallest safe implementation step

The smallest safe code step after approval is not to remove keys. It is to add the disabled single-workspace feature flag plus pure environment/config-construction tests, while leaving the default behavior unchanged. The flag should refuse to launch unless all of these are true:

- the worker has a server-minted agent token;
- the broker has exactly one workspace membership;
- the agent-token conformance suite passed for the target server version;
- generated MCP configuration contains no workspace credential aliases or multi-workspace credential JSON.

Only then should a separate PR enable the flag in a canary. This design PR intentionally makes no worker-key removal because the brief requires Khaliq's go and the current roster/node/admin gaps are material.

## Required tests and mutation checks

- Real worker process test: poison ambient, broker worker, harness, and result environments; assert the child sees the agent token but none of the workspace credential names.
- Snapshot or parser tests for every CLI MCP generator: the token is present, workspace credential names are absent.
- MCP tests without a workspace key for list agents, recipient resolution, send/receive, inbox, presence, query nodes, and action-based spawn.
- CLI tests for `message dm send` and the worker-supported command set using only `RELAY_AGENT_TOKEN`.
- Local-only regression: no Relaycast credentials or remote MCP tools.
- Negative authorization tests for all denied administration operations.
- Multi-workspace refusal test while the canary flag is enabled.
- Mutation checks: re-add each workspace alias or JSON bundle to the worker/config, replace agent-scoped roster resolution with the workspace client, and enable silent legacy fallback; each mutation must fail a named test.

## Rollback and observability

Rollback is to disable the feature flag; no credential format or persisted state is deleted. Log only credential source and variable names, never values. Canary telemetry should distinguish scoped-token success, explicit refusal, token-refresh request, and accidental legacy fallback. Any observed legacy fallback while the flag is enabled is a security failure and should stop rollout.

## Approval request

Approve only the disabled single-workspace canary implementation after the server-side allowed/denied matrix exists. Do not approve default-on behavior or multi-workspace removal as part of that first implementation.
