# Workspace Identity — Durable Across Node Restarts

**Status**: Implemented
**Date**: 2026-07-31
**Tracking**: AR-448

---

## 1. The invariant

> A local Relay node, and every resident agent on it, keeps the same workspace
> identity and the same delivery address across a full stop/start.

Two things have to hold for that to be true.

**One workspace per node, chosen — not minted.** A node start must join a
workspace that already existed, unless the operator has explicitly asked for a
new one.

**One data-plane ID per workspace.** Relaycast, Relayfile, and RelayAuth must
all resolve the canonical workspace to the *same* `rw_…` identity. The Cloud
workspace ID is deliberately excluded from the comparison: it is the
control-plane record that points at the data plane, and it lives in a different
ID space (a UUID).

When both hold, re-registering an agent name after a restart returns the
existing agent — same ID, same address, same inbox — because Relaycast finds
that name already in the workspace.

## 2. How a node picks its workspace

`agent-relay node up` (and the `local up` alias) resolves the workspace in this
order, highest priority first:

1. **Explicit selection** — `--workspace-key` / `--wk`, `RELAY_WORKSPACE_KEY`,
   `AGENT_RELAY_WORKSPACE_KEY`, `RELAY_API_KEY`, or a `RELAY_NODE_TOKEN` that
   already implies a workspace. The operator chose; nothing overrides it.
2. **Project pin** — `.agentworkforce/relay/workspace-key.json` in the
   checkout, written by the previous successful start.
3. **Machine-global canonical workspace** — the active entry in
   `$AGENT_RELAY_HOME/workspaces.json` (default
   `~/.agentworkforce/relay/workspaces.json`), set by
   `agent-relay workspace join|switch|create`.
4. **Mint a new workspace** — last resort. The broker creates a
   messaging-only workspace so it can come up at all.

Step 3 is what AR-448 added, and it is what makes identity durable. Without it,
a start with no project pin fell straight through to step 4: the broker minted a
brand-new workspace, the resident agent registered into it as a stranger, and
every message addressed to its previous address went nowhere. Nothing errored —
the node came up and the agent looked healthy.

After a successful start the resolved key is pinned to the project, so the next
start takes step 2 and does not need to consult the store at all.

## 3. Proving the invariant

```
$ agent-relay workspace active --json
{
  "name": "default",
  "key": "rk_live_…de99",
  "cloudWorkspaceId": "50587328-441d-4acb-b8f3-dbe1b3c5de99",
  "relaycastWorkspaceId": "rw_7ccfea89",
  "relayfileWorkspaceId": "rw_7ccfea89",
  "relayauthWorkspaceId": "rw_7ccfea89",
  "dataPlane": {
    "unified": true,
    "workspaceId": "rw_7ccfea89",
    "planes": {
      "relaycast": "rw_7ccfea89",
      "relayfile": "rw_7ccfea89",
      "relayauth": "rw_7ccfea89"
    },
    "divergent": []
  }
}
```

`dataPlane` is emitted on every call, so the JSON is self-sufficient evidence
rather than something a caller has to recompute from the three plane IDs. On a
divergence, `unified` is `false`, `workspaceId` is absent, and `divergent` names
the planes that disagree.

By default a divergence is reported on stderr and the command still exits 0.
Pass `--require-unified` to turn it into a hard gate — that is the form
supervisors and setup doctors should use:

```
$ agent-relay workspace active --json --require-unified
```

To check that a restart preserved identity, compare the workspace ID reported by
the node itself:

```
$ agent-relay node status
Status: RUNNING
Node: kjglaptop (node_abc)
Workspace: rw_7ccfea89
Workspace Key: rk_live_…de99
```

`Workspace:` is the durable identity; the key beneath it is a live credential
and is always masked.

## 4. Secrets

Status output and startup logs never print a raw workspace key, agent token,
node token, or a credential-bearing observer URL.

- Keys that are printed on purpose go through `maskSecret` — prefix plus last
  four characters.
- Error and log *text* goes through `redactCredentialValues`, which catches
  credentials embedded in URL paths and query strings, where key-name redaction
  cannot help.
- Structured dumps go through `redactSecrets`, which replaces the value of any
  credential-named key.
- The canonical-workspace fallback logs only that it used the machine-global
  workspace. It never names the key.

## 5. Migration for existing local nodes

No action is required, and nothing is rewritten on upgrade.

- **A node with a project pin** keeps using that pinned workspace. The new
  fallback sits below the pin in precedence and never overrides it.
- **A node with no project pin** now joins the machine-global canonical
  workspace on its next start instead of minting a fresh one. If that node had
  been drifting onto a new workspace each restart, this is the fix — but its
  resident agents move to the canonical workspace, and any address someone
  recorded from a previous throwaway workspace stops resolving. That address was
  already invalid after the next restart.
- **A machine with no canonical workspace set** behaves exactly as before:
  the broker mints one. Set one with `agent-relay workspace join <name> <key>`
  (or `switch`) to opt into durable identity.
- **A node pinned to a workspace you no longer want** re-pins on the next start
  after an explicit `--workspace-key`, since step 1 wins and the resolved key is
  written back to the project pin.

To move an existing node onto the canonical workspace deliberately:

```
$ agent-relay workspace switch default
$ rm .agentworkforce/relay/workspace-key.json   # drop the stale project pin
$ agent-relay node down && agent-relay node up
$ agent-relay node status                       # Workspace: <canonical rw_…>
```

## 6. Coverage

| Guarantee | Test |
|---|---|
| Workspace and resident address survive a stop/start | `packages/cli/src/cli/lib/workspace-identity-restart.test.ts` |
| First start with no pin joins the canonical workspace | same |
| The resolved workspace is pinned to the project | same |
| Explicit `--workspace-key` still wins | same |
| A second checkout shares the canonical workspace | same |
| Precedence: pin over canonical store | `packages/cli/src/cli/commands/core.test.ts` |
| No canonical workspace ⇒ unchanged legacy behavior | same |
| `node status` shows the workspace ID and leaks no credential | same |
| `workspace active` emits convergence evidence | `packages/cli/src/cli/commands/workspace.test.ts` |
| `--require-unified` exits non-zero on divergence | same |
| Convergence detection itself | `packages/cloud/src/workspace-convergence.test.ts` |
