# Workspace Identity — Durable Across Node Restarts

**Tracking**: AR-448
**Status**: the behavior described here is implemented on `main`. See
[§7 Coverage](#7-coverage) for exactly which parts are proven by tests and
which are not.

---

## 1. The invariant

> A local Relay node, and every resident agent on it, keeps the same workspace
> identity and the same delivery address across a full stop/start.

Three things have to hold for that to be true, and AR-448 originally accounted
for only the first two.

**One workspace per node, chosen — not minted.** A node start must join a
workspace that already existed, unless the operator explicitly asked for a new
one. This is [§2](#2-how-a-node-picks-its-workspace).

**One data-plane ID per workspace.** Relaycast, Relayfile, and RelayAuth must
all resolve the canonical workspace to the _same_ `rw_…` identity. The Cloud
workspace ID is deliberately excluded: it is the control-plane record that
points at the data plane, and it lives in a different ID space (a UUID). This is
[§4](#4-proving-the-data-plane-invariant).

**One work unit per agent name.** Re-registering a name must return the existing
agent — same ID, same address, same inbox — only when the caller can prove it is
the same work unit that holds that name. This is [§3](#3-who-may-reclaim-a-name),
and it is the half AR-448 did not originally account for.

The first two make the mailbox reachable. The third decides who is allowed to
pick it up.

**The durable lesson from AR-448 is that its own premise was too strong.** AR-448
was scoped on the assumption that workspace convergence is _sufficient_ for
address identity. It is **necessary and not sufficient**. Agent-identity
admission is a separate second half, and it landed a week later as its own fix
(`5c2ad8ee3`) rather than falling out of the workspace work. Anyone reasoning
about "will this agent keep its address" needs to check both halves; checking
only the workspace half is how a node that resolves the correct workspace can
still fail to come back as itself.

## 2. How a node picks its workspace

`agent-relay up` / `node up` resolves the workspace through one shared
precedence ladder — `resolveWorkspaceSelection` in
`packages/cloud/src/project-workspace-key.ts`. Every caller (SDK clients, the
CLI, the broker start path) walks the same ladder, so a repository cannot end up
in one workspace and its tooling in another:

1. **`flag`** — an explicit `--workspace-key` / `--wk`.
2. **`env`** — `RELAY_WORKSPACE_KEY` > `AGENT_RELAY_WORKSPACE_KEY` > `RELAY_API_KEY`.
3. **`project`** — the repository pin,
   `<project>/.agentworkforce/relay/workspace-key.json`, written by the previous
   successful start.
4. **`store`** — the machine-global active entry in
   `~/.agentworkforce/relay/workspaces.json`, set by
   `agent-relay workspace join|switch|create`.
5. **Nothing resolves** — the broker mints a workspace so it can come up at all.

Two rules make the ladder durable rather than merely ordered:

- **The repository pin always outranks the machine-global entry.** A global
  selection must never silently re-home a checkout that already pinned a
  workspace.
- **A Fleet enrollment (`RELAY_NODE_TOKEN`) selects the node's _identity_, never
  its workspace**, so it does not appear on the ladder at all. Letting it
  short-circuit the walk is what re-homed an enrolled node out of its
  repository's workspace and into a freshly minted one.

Step 4 is what makes a first start durable. Without it, a start with no
repository pin fell straight through to step 5: the broker minted a brand-new
workspace, the resident agent registered into it as a stranger, and every
message addressed to its previous address went nowhere. Nothing errored — the
node came up and the agent looked healthy.

After a successful start the resolved key is pinned to the project, so the next
start takes step 3 and does not consult the store at all.

Startup prints which step won — the flag name, the variable, or the file path,
never key material — and says explicitly whether it joined a workspace or
created one:

```
Workspace source: machine-global active workspace (~/.agentworkforce/relay/workspaces.json (active: "default"))
Workspace Key: rk_live_…de99
Workspace: joined rw_7ccfea89
```

## 3. Who may reclaim a name

Landing in the right workspace gets a registration to the right door. It does
not decide who is let through it.

Registration is a fail-closed admission gate: `admit_agent_registration` in
`crates/broker/src/relaycast/auth.rs`. A name collision is **rejected** by
default. Reclaim — returning the existing agent's ID and address with a freshly
rotated token — is permitted only when the request proves it is the same work
unit: a caller-supplied identity key must match the one stamped on the existing
agent's metadata at its creation, compared as a SHA-256 hash rather than a raw
value, because metadata is readable by anyone holding the same workspace key.

The broker's own startup registration proves it with `stable_node_identity_key`,
derived from the broker's persisted state directory. The same project/state
directory hashes identically across a kill and restart; a different checkout
hashes to something else.

**This narrows what AR-448 originally claimed.** The original work assumed that
converging two checkouts on one workspace also converged their resident
addresses — that a second checkout would simply pick up the same agent. Under
the gate it does not, and should not: two checkouts are two work units, and
handing the second one the incumbent's credentials is the duplicate-agent
failure the gate exists to stop. So:

| Situation                                                  | Outcome                        |
| ---------------------------------------------------------- | ------------------------------ |
| Same node restarts, same state dir, same name              | Reclaims its address and inbox |
| Different checkout, same workspace, same name              | Rejected — no credential hand-off |
| Any node, name not currently held                          | Registers fresh                |

An operator who genuinely needs to move a resident to a new checkout sets
`RELAY_AGENT_IDENTITY_KEY` to the original work unit's identity, which is the
documented, deliberate path rather than an accident of ordering.

## 4. Proving the data-plane invariant

`agent-relay workspace active` emits a `dataPlane` block on every call, so its
output is self-sufficient evidence rather than something a caller has to
recompute from the three plane IDs:

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

On a divergence, `unified` is `false`, `workspaceId` is **absent** — offering a
single ID would paper over the split the block exists to surface — and
`divergent` names the planes that disagree.

By default a divergence is reported on stderr and the command still exits 0, so
existing scripted callers keep their exit code. Pass `--require-unified` to turn
it into a hard gate; that is the form supervisors and setup doctors should use:

```
$ agent-relay workspace active --json --require-unified
```

The human output reports the same thing, including the Relaycast ID it
previously omitted:

```
$ agent-relay workspace active
Workspace: default
Cloud workspace ID: 50587328-441d-4acb-b8f3-dbe1b3c5de99
Relaycast workspace ID: rw_7ccfea89
Relayfile workspace ID: rw_7ccfea89
Relayauth workspace ID: rw_7ccfea89
Data-plane workspace ID: rw_7ccfea89 (unified)
```

## 5. Secrets

Status output and startup logs never print a raw workspace key, agent token,
node token, or a credential-bearing observer URL.

- Keys printed on purpose go through `maskSecret` — prefix plus last four
  characters.
- Error and log _text_ goes through `redactCredentialValues`, which catches
  credentials embedded in URL paths and query strings, where key-name redaction
  cannot help.
- Structured dumps go through `redactSecrets`, which replaces the value of any
  credential-named key.
- The ladder logs only which step won and its origin — a flag name, a variable
  name, or a file path. It never names the key.

Workspace IDs are identifiers, not credentials, and are printed in full.

## 6. Migration for existing local nodes

No action is required, and nothing is rewritten on upgrade.

- **A node with a repository pin** keeps using that pinned workspace. The store
  step sits below the pin in precedence and never overrides it.
- **A node with no repository pin** now joins the machine-global active
  workspace on its next start instead of minting. If that node had been drifting
  onto a new workspace each restart, this is the fix — but its resident agents
  move to the canonical workspace, and any address someone recorded from a
  previous throwaway workspace stops resolving. That address was already invalid
  after the next restart.
- **A machine with no active workspace set** behaves exactly as before: the
  broker mints one. Set one with `agent-relay workspace join <name> <key>` (or
  `switch`) to opt into durable identity.
- **A node pinned to a workspace you no longer want** re-pins on the next start
  after an explicit `--workspace-key`, since step 1 wins and the resolved key is
  written back to the pin.

To move an existing node onto the canonical workspace deliberately:

```
$ agent-relay workspace switch default
$ rm .agentworkforce/relay/workspace-key.json   # drop the stale repository pin
$ agent-relay node down && agent-relay node up
$ agent-relay workspace active --require-unified
```

Note that moving a checkout onto a workspace where its resident's name is
already held by a **different** work unit is a rejection, not a merge — see
[§3](#3-who-may-reclaim-a-name).

## 7. Coverage

These are unit tests over the CLI's own TypeScript and the broker's Rust. They
prove the CLI **selects** the right workspace across starts and that the broker
**decides** reclaim correctly. They do not prove that identity survives a real
stop/start of a live node — that is a live proof, and it is not automated here.

| Guarantee                                                        | Test                                                        |
| ---------------------------------------------------------------- | ----------------------------------------------------------- |
| Workspace and resident address are preserved across a restart    | `packages/cli/src/cli/lib/workspace-identity-restart.test.ts` |
| A first start with no pin joins the canonical workspace          | same                                                         |
| The resolved workspace is pinned, so start 2 resumes from the pin | same                                                        |
| An explicit `--workspace-key` re-pins durably                     | same                                                         |
| A second checkout joins the same canonical workspace              | same                                                         |
| A second checkout may **not** take the resident's name            | same                                                         |
| No canonical workspace ⇒ per-checkout drift (negative control)    | same                                                         |
| Single-start ladder precedence, each step                         | `packages/cli/src/cli/lib/broker-lifecycle.test.ts`          |
| Startup prints the winning source and leaks no credential         | same                                                         |
| The shared ladder itself                                          | `packages/cloud/src/project-workspace-key.test.ts`           |
| Data-plane convergence detection                                  | `packages/cloud/src/workspace-convergence.test.ts`           |
| `workspace active` emits convergence evidence                     | `packages/cli/src/cli/commands/workspace.test.ts`            |
| `--require-unified` exits non-zero on divergence                  | same                                                         |
| A restart reclaims its own registration; another node cannot      | `crates/broker/src/relaycast/auth.rs` (`#[cfg(test)]`)       |

**Not covered by any test:** the live proof that a resident agent keeps its
address and mailbox across a real `node down` / `node up`. It requires an
operator at the keyboard, because stopping the broker stops the resident agent
performing the check. It also depends on commit `5c2ad8ee3` (§3), which is on
`main` but not in any released broker — a live attempt on an older installed
broker fails for that reason rather than because the invariant is broken.
