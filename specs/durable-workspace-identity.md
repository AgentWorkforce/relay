# Durable Workspace Identity Across Node Restarts (AR-448)

**Status**: Adopted
**Date**: 2026-07-31
**Owner**: Khaliq Chief (platform)

---

## 1. Invariant

For any local `agent-relay` node, the canonical Agent Relay Cloud workspace
that Relaycast, Relayfile, and RelayAuth resolve is **durable across a full
stop → start of the node**. A resident agent (e.g. `khaliq-chief`) keeps the
same delivery address and inbox on restart; it does not become a
process-lifetime identity that peers must re-discover.

Formally, if start `N` resolves to workspace descriptor
`{ cloudWorkspaceId, relaycastWorkspaceId, relayfileWorkspaceId, relayauthWorkspaceId }`
and node id `node_X`, then start `N+1` on the same host, in the same working
directory, without an explicit `--workspace-key` override, MUST resolve to the
same descriptor and the same `node_X`.

## 2. The single source of truth

Workspace identity is pinned in two on-disk stores. Precedence (highest wins)
is enforced by
[`resolveWorkspaceKey`](../packages/cloud/src/project-workspace-key.ts):

| Rank | Source                                            | File / env                                                                   | Scope             |
| ---- | ------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------- |
| 1    | Explicit CLI flag                                 | `--workspace-key <key>`                                                      | Single invocation |
| 2    | Explicit env override                             | `RELAY_WORKSPACE_KEY` / `AGENT_RELAY_WORKSPACE_KEY` / `RELAY_API_KEY`        | Single invocation |
| 3    | **Project pin** (what `agent-relay node up` uses) | `<projectDataDir>/workspace-key.json`                                        | This checkout     |
| 4    | Machine-global active workspace                   | `~/.agentworkforce/relay/workspaces.json` (or `$AGENT_RELAY_HOME`-relocated) | This user account |

Both stores are written with `0o600` and their containing directories with
`0o700`. Neither store contains any secret beyond the workspace bearer key
itself; the resolved descriptor and every downstream service ID come from a
Cloud round-trip keyed on that single bearer.

`agent-relay workspace active --json` prints the resolved descriptor and is
the operator's proof point that all three services root to one canonical
`cloudWorkspaceId`. The output includes a machine-checkable `canonical: true`
flag plus a `planes` map — deploy gates can call
`agent-relay workspace active --json | jq .canonical` rather than re-comparing
per-plane ids themselves:

```json
{
  "name": "ops",
  "key": "rk_live_…",
  "cloudWorkspaceId": "rw_ops",
  "relaycastWorkspaceId": "rw_ops",
  "relayfileWorkspaceId": "rw_ops",
  "relayauthWorkspaceId": "rw_ops",
  "urls": {},
  "apiUrl": "https://cloud.agentrelay.com",
  "canonical": true,
  "planes": {
    "cloud": "rw_ops",
    "relaycast": "rw_ops",
    "relayfile": "rw_ops",
    "relayauth": "rw_ops"
  }
}
```

The raw `key` is masked by default (`rk_live_…`) so the descriptor is safe
to paste into a log, ticket, or Slack thread; pass `--reveal-secrets` when
programmatic callers need the full bearer.

## 3. Node identity is derived, not minted

The Rust broker derives its node id deterministically from
`(machine_seed, cwd, workspace_id)`
([`derive_node_id`](../crates/broker/src/node_control.rs)). The machine seed is
persisted at `~/.local/share/agent-relay/machine-id` on first ever start.
Consequences:

- Same host, same working directory, same workspace → **same `node_id`** on
  every start.
- Different working directories on the same host serving the same workspace
  → **distinct** ids (no collision).
- Same working directory, different workspaces → **distinct** ids (the second
  workspace does not clobber the first).

The node token used to authenticate `/v1/node/ws` is cached at
`~/.local/share/agent-relay/node-tokens/<node_id>.json` and re-used as long as
`(node_id, workspace_id, base_url)` all match; a mismatch discards the cache
and forces a fresh mint. This means a workspace switch — or an engine switch
— never carries a stale bearer forward.

## 4. Resident agent address stability

A resident agent's delivery address in the fabric is
`(cloudWorkspaceId, agent_name)`. Because §2 pins the workspace and §3 pins
the node, the address a peer used yesterday to reach `khaliq-chief` still
resolves today.

The broker's persisted agent state
([`BrokerState`](../crates/broker/src/broker.rs)) records
`{ name → { runtime, parent, channels, spec, restart_policy, initial_task, pid, started_at } }`
in the project data directory. The `pid` is process-lifetime and is reaped on
restart via `reap_dead_agents`, but the `name` — the routing address — is
authoritative and survives.

When a node enrolls with the Fleet API, the enrolled node id is written into
`workspace-key.json` as `enrolledNodeId`. The `agent-relay node up` path in
[`packages/cli/src/cli/commands/node.ts`](../packages/cli/src/cli/commands/node.ts)
resolves that enrollment on subsequent starts (never the ambiguous
"any enrollment in this workspace" fallback), so a Cloud-enrolled node keeps
its Cloud identity across restarts.

## 5. Redaction contract

`node status` and `node up` MUST NOT print:

- The raw workspace key.
- A URL that embeds it (e.g. the old `https://agentrelay.com/observer?key=…`
  banner).
- A raw node token or per-agent bearer.

Instead, both surfaces print a **mask** of the workspace key computed by
[`maskSecret`](../packages/cli/src/cli/lib/redact.ts): `rk_live_…0501` —
enough for an operator to diff "start N vs start N+1" without reconstructing
the credential. Correlating masks against `agent-relay workspace active --json`
reveals whether two nodes are on the same workspace.

The observer URL is deliberately not printed. Operators can build it from
`workspace active`; the CLI never puts the key on a display surface that
leaks into shell history or terminal recordings.

## 6. Migration behavior for existing local nodes

Existing brokers on this contract require no operator action:

1. **Pre-existing `workspace-key.json`** — resumed as-is. If it has no
   `enrolledNodeId`, the first `node up` after upgrade continues to serve the
   pinned workspace without enrollment (unchanged from prior behavior).
2. **Pre-existing machine seed but no cached node token** — a fresh token is
   minted on background reconnect. Node id stays the same because it derives
   from the seed + cwd + workspace, so peers reach the same address.
3. **Pre-existing cached node token with a different workspace or engine URL
   than the current resolve** — the cache is treated as invalid and re-minted.
   This mirrors today's behavior; no schema change is required.
4. **Startup banner change** — operators who scraped `Workspace Key: rk_live_…`
   for their tooling will find the same line but with the value masked. The
   canonical `agent-relay workspace active --json` output remains the
   programmatic surface for the full descriptor and gains `canonical` and
   `planes` fields; older scripts consuming the descriptor keep working.

## 7. Test coverage

| Concern                                                   | Test                                                                                                                            |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Workspace pin survives stop → start                       | [`packages/cli/src/cli/lib/durable-workspace-identity.test.ts`](../packages/cli/src/cli/lib/durable-workspace-identity.test.ts) |
| Enrolled node id is pinned across restarts                | same file                                                                                                                       |
| Mask is stable N vs N+1; rotated key visibly diffs        | same file                                                                                                                       |
| `workspace active --json` returns the four service IDs    | [`packages/cli/src/cli/commands/workspace.test.ts`](../packages/cli/src/cli/commands/workspace.test.ts)                         |
| `workspace active --json` includes `canonical` + `planes` | same file                                                                                                                       |
| `node status` prints mask, never key or observer          | [`packages/cli/src/cli/commands/core.test.ts`](../packages/cli/src/cli/commands/core.test.ts)                                   |
| `maskSecret` masks and prefix-preserves credentials       | [`packages/cli/src/cli/lib/redact.test.ts`](../packages/cli/src/cli/lib/redact.test.ts)                                         |
| Node id derivation is stable + workspace-scoped           | [`crates/broker/src/node_control.rs`](../crates/broker/src/node_control.rs)                                                     |

## 8. What this unblocks

Chiefs owned by different principals can share one company workspace: their
brokers resolve the same `cloudWorkspaceId` even if their local
`workspace-key.json` files hold different bearer keys, because the descriptor
is derived from what the Cloud resolves — not from the raw key. AR-448 is the
prerequisite that keeps _each Chief's_ identity stable while that sharing
happens.
