# agent-relay

A thin operator console for an agent workforce: connect your agent tools with `relay init`, message and coordinate the agents in a workspace, and place workers on fleet nodes or Cloud sandboxes. Each command is a shallow wrapper over a backing package (`@agent-relay/sdk`, `@agent-relay/cloud`).

## Install

Requires Node.js 22 or newer.

```bash
npm install -g agent-relay
```

## Common commands

```bash
agent-relay init                   # set up Relay, your agent tools, and the Agent Relay core
agent-relay status                 # workspace + cloud login
agent-relay mcp                    # MCP stdio server

agent-relay message post --channel general --text "hello"
agent-relay workspace list
```

## Agents on this machine

`relay init` installs and starts the Agent Relay core, which injects messages
into running Claude Code, Codex, OpenCode, Grok, Pi, Devin and Cursor sessions
and spawns, lists and releases agents on this machine. Spawn agents through the
Agent Relay MCP spawn tools (or the desktop app).

The local Rust broker and the commands that drove it were retired:
`node up|down|status|metrics|deadletters|redeliver`, `node tail`, and every
`node agent …` subcommand (and the same verbs on the deprecated `local` alias)
now print a removal notice that points to `relay init`. `fleet status` was
retired the same way.

The `node` group still carries the local workflow commands:

```bash
agent-relay node workflow run workflows/my-workflow.ts
agent-relay node workflow logs <run-id> --follow
agent-relay node workflow sync <run-id>
```

### Workspace selection

Commands resolve the workspace through one precedence ladder. The first source
that resolves wins:

| #   | Source                          | Where it comes from                                                           |
| --- | ------------------------------- | ----------------------------------------------------------------------------- |
| 1   | Command-line flag               | `--workspace-key` / `--wk`                                                    |
| 2   | Environment                     | `RELAY_WORKSPACE_KEY`, then `AGENT_RELAY_WORKSPACE_KEY`, then `RELAY_API_KEY` |
| 3   | Repository pin                  | `<project>/.agentworkforce/relay/workspace-key.json`                          |
| 4   | Machine-global active workspace | the `active` entry in `~/.agentworkforce/relay/workspaces.json`               |

The repository pin always beats the machine-global active workspace, so
`agent-relay workspace switch <name>` never silently re-homes a checkout that
already pinned one.

`workspace create`, `join`, and `switch` select a named workspace globally and
pin it to the current project. A changed selection records the old name, so an
accidental create can be undone:

```bash
agent-relay workspace restore
```

To change only the workspace this project uses, without changing the
machine-global active workspace, use:

```bash
agent-relay workspace rebind default
```

## Fleet agents

The `fleet` command group lists and controls agents across all live nodes in
the active project workspace:

```bash
agent-relay fleet nodes
agent-relay fleet nodes list --pretty
agent-relay fleet nodes list --name sf-mini --capability spawn:codex --pretty

# Exact-node placement uses the same agent-scoped Fleet action as the MCP tool.
agent-relay fleet spawn codex \
  --name api-worker \
  --task "Use https://agentrelay.com/skill, ACK over Relay, then wait for details." \
  --cwd /absolute/path/to/checkout \
  --node sf-mini

# Resume a known Claude/Codex CLI session on its origin node.
agent-relay fleet spawn codex \
  --name api-worker \
  --task "Resume over Relay and continue the prior task." \
  --node sf-mini \
  --session-ref <actual-codex-thread-id>

# Opt into automatic eligible-node placement.
agent-relay fleet spawn codex --name api-worker --task "Review the current diff." --auto-place

# Provision a fresh E2B node, require the current Relayfile workspace to mount
# at /workspace, wait for readiness, then spawn Codex there.
agent-relay fleet spawn codex \
  --sandbox \
  --sandbox-provider e2b \
  --name e2b-worker \
  --task "Review the current workspace and wait for follow-up."


agent-relay message dm send api-worker "Detailed task instructions"
# wait is the default: it queues for the recipient's next safe idle boundary and
# can remain unread while that recipient is busy. steer requests immediate
# injection and may interrupt active work. A send ID confirms enqueue only;
# use `message inbox get_readers <id>` to confirm that the recipient consumed it.
agent-relay message dm send api-worker "Please check Relay now." --mode steer
# Attach files (repeatable --file) to a DM, a channel post, or a group DM.
agent-relay message dm send api-worker "Repro screenshot" --file ./shot.png
agent-relay message file upload ./shot.png --channel ops --text "Build is red"
# Save an attachment you received (its file_id) and print the local path.
agent-relay message file download <file_id>
agent-relay message inbox check --limit 20
agent-relay fleet release api-worker --reason "Work accepted"
```

Commands use the workspace session pinned to the current project. Exact-node
spawn and messaging operations also need an agent identity: pass `--token` or
set `RELAY_AGENT_TOKEN` to the token returned by
`agent-relay agent register <lead-name>`. `fleet spawn --sandbox` needs a Cloud
login (`agent-relay cloud login`) but does not need an agent token: when one is
absent, it creates and removes a short-lived launcher identity automatically.

A targeted spawn waits for the node to confirm the launch, for six minutes by
default (`--confirm-timeout <ms>`, minimum 95000). Agents that take minutes to
register are confirmed inside that window rather than reported as unconfirmed.
If the window does expire, the error carries the invocation id: read that
dispatch instead of spawning again, because a retry under the same name
collides with a worker that may still be starting.

```bash
agent-relay fleet spawn-status inv_01J...
```

The reply's `placement.state` separates the outcomes: `ready` (launched and
confirmed), `failed` (the node reported a terminal failure), `accepted`
(launched, readiness unverified), and `unconfirmed_may_be_running` (the node
still has not reported — not evidence that nothing started). Polling never
dispatches another agent.

`fleet spawn` needs a placement: `--node`, `--auto-place`, or `--sandbox`.
Spawning on this machine without one went away with the local broker; the
command now says so and points to `relay init`, whose core spawns agents here.
Invocations with an explicit `--workspace-key`/`--wk`, `--token`,
`--base-url`, or `--persona` keep automatic fleet placement when no node or
sandbox is selected. Ambient credentials and persisted Cloud routing never turn
a flag-free spawn remote. Automatic placement and release need only the
workspace key.

The sandbox path provisions a fresh hosted instance. Inside a GitHub checkout,
Relay infers the Git root, repository identity, exact pushed `HEAD`, and caller-relative
directory. Cloud makes a depth-1 clone, fetches that exact SHA, verifies `HEAD`,
and starts the worker under `/srv/agent-workforce/<repo>`. Repository tasks start
without waiting for Relayfile context. `--checkout` explicitly selects the same
static mode. Outside Git, the default still requires the workspace Relayfile mount.

Use `--sandbox-relayfile` to require live context before dispatch. Without
`--checkout`, this retains the live repository mirror under
`/workspace/github/repos/<owner>/<repo>/contents`; with `--checkout`, it mounts
context separately from the Git clone. An explicit `--sandbox-relayfile-path`
also requires its selected context before startup. `--no-sandbox-relayfile`
explicitly disables mounting (combine with `--checkout` to clone repository files).
Use `--sandbox-provider daytona` or `--sandbox-provider e2b` to require an
operator-enabled provider; omit the flag to let Cloud's sandbox router choose.
If provisioning times out or the spawn
fails, Relay asks Cloud to delete the newly created sandbox. Runs without a
custom name use one `sbx_<UUID>` identity and the matching
`fleet-sandbox-<UUID>` node name. Legacy custom `--sandbox-name` values remain supported when no
`--sandbox-id` is supplied; in that mode Cloud receives no sandbox identity.
When replaying with `--sandbox-id <sbx_UUID>` (lowercase RFC 4122 UUID), pass
its matching deterministic `--sandbox-name` or let Relay derive it. If
provisioning ends with an unknown outcome, rerun the command with the warning's
`--sandbox-id` to replay the same Cloud identity instead of adopting another
fleet node.

The live source profile includes tracked dotfiles, lockfiles, generated and
binary files, large files within Relayfile's import limit, symlinks, and
executable permissions. Relayfile never places `.git` in this tree. If a
repository entry cannot be represented safely, spawn fails with the entry and
corrective action instead of reporting a partial working tree.

Both live and checkout modes require a clean working tree whose exact `HEAD` is
reachable from a configured GitHub remote. This prevents a remote worker from
silently starting at a different revision. Commit and push local work before
retrying when Relay reports dirty files or an unreachable commit.

In default repository mode or with `--checkout`, sandbox provisioning clones the attested `HEAD` under
`/srv/agent-workforce/<repo>`. The checkout must have no tracked changes or
untracked source files, and the exact commit must be reachable from an origin
remote. Relay's generated `.agentworkforce/relay/workspace-key.json`,
`connection.json`, and `runtime.json` metadata are permitted. Dirty checkouts and
commits known to be ahead of their origin upstream fail locally. Detached commits
must appear in an origin remote-tracking branch, and Cloud independently fetches
and verifies the exact SHA before dispatch. An unreachable commit produces a
push-and-retry error. The temporary isolated
Relaycast credential stays in the machine store under
`~/.agentworkforce/relay`; the project file stores only a non-secret reference.

From a clean repository already pinned to a Relay workspace, the checkout-first
path is:

```bash
agent-relay fleet spawn codex \
  --name cloud-zero-config \
  --task "Inspect this repository and report its current commit" \
  --sandbox
agent-relay fleet agent list
agent-relay fleet release cloud-zero-config
```

Invoking the command from `packages/web` starts the worker at
`/srv/agent-workforce/<repo>/packages/web`, with `.git` available and `HEAD`
pinned to the requested revision.

Attach optional context later using `cloudWorkspaceId` and `sandboxId` from the
spawn response (this uses Cloud sign-in):

```bash
agent-relay fleet relayfile attach \
  --cloud-workspace-id <Cloud-workspace-UUID> \
  --sandbox-id <sbx_UUID> \
  --path '/linear' '/.skills'
```

Omit `--path` for the full workspace. For a dev sandbox, add
`--cloud-api-url https://dev.agentrelay.com/cloud`. The command waits at most
five minutes by default, reports the separate mount path, and does not restart
the worker or retry a failed attachment. Pending detached preparation is polled
against the same sandbox within that shared deadline. Tell an already running worker the
returned path when its task needs that context. The mount uses its own directory;
it never overlays the Git checkout. Attachment failure leaves the repository task
running.

For a live repository mirror that must be ready before the task starts, add
`--sandbox-relayfile` to spawn. Its decoded tree contains no `.git`; its source
metadata sits beside `contents` under `.relayfile`. Use
`--checkout --sandbox-relayfile` for a Git checkout plus required live context.

In checkout mode, invoking spawn from `packages/web` places the worker in that
same relative directory in the remote clone. In both modes, private repositories
use the pinned workspace's connected GitHub access; a repository-access error
means that connection must be granted access to the repository. No GitHub token
or workspace key needs to be copied into the task, mount, or checkout.

With `--checkout --sandbox-relayfile`, the Git checkout and Relayfile mirror are
separate trees. Checkout-only mode has no Relayfile mirror or workspace skills. In
the ordinary live mode, source files are decoded from Relayfile records without
placing `.git` in the mirror. When a live mount is requested at startup, workspace `.skills` are exposed through the agent
CLIs' usual skill directories, and the worker's task context identifies the
mirror and exact source revision.

Releasing a worker does not delete its sandbox.
To resume its retained sandbox, repeat spawn with the reported
`--sandbox-id <id>`; when using `--checkout`, the retained clone must still have
the same clean HEAD.
A failed resume preserves retained work. For a live Relayfile sandbox, reusing
`--sandbox-id` intentionally re-materializes the exact clean, pushed `HEAD` from
the current checkout before the provider resumes, so a new commit becomes the
source tree for that retained sandbox. With `--checkout`, the retained static
clone remains pinned to its original revision and the current checkout must
still resolve to that same clean, pushed `HEAD`. Delete an unused sandbox in
Cloud Fleet to stop future provider usage; monthly accounting reservations
remain until their normal reset.

If the workspace is not pinned yet, use `agent-relay workspace rebind <name>`
with an existing stored workspace. A missing or mismatched stored route
credential requires rerunning sandbox provisioning for that workspace.
`--base-url`, `--workspace-id`, `--node`, provider selection, and the static
`--checkout` mode remain advanced overrides. For `--cwd`, local repo-relative
paths are accepted to infer the sandbox repository; absolute remote paths are
advanced overrides. Outside Git, plain `--sandbox` preserves the existing
full-workspace Relayfile mount at `/workspace`.

Pins created before workspace IDs were recorded are resolved automatically
through Cloud at spawn time. The key travels in an authenticated POST body,
never a URL. Nested packages share the repository pin; an existing subproject
pin or `AGENT_RELAY_PROJECT` remains an explicit workspace override.

Large workspaces can be scoped to only the live subtrees an agent needs. Pass
one or more explicit directory roots after `--sandbox-relayfile-path`; the
supplied list is the complete mount set — nothing else is added. To include the
inferred repository, list its `contents/**` root explicitly (for example
`/github/repos/Owner/repo/contents/**`); when the flag is omitted the inferred
repository, its source metadata, and `.skills` are mounted automatically. When
the list omits the repository root, the worker starts at the mount root
(`/workspace`) rather than the repository tree, and a repo-relative `--cwd` is
rejected.
Cloud validates the `/path/**` form and materializes those roots before the
agent starts:

```bash
agent-relay fleet spawn claude \
  --sandbox \
  --sandbox-relayfile-path '/live-review/run-123/**' \
  --name reviewer \
  --task 'Review the live draft under /workspace/live-review/run-123'
```

`--session-ref` is a real CLI resume, not a logical collaboration label. Pass
the actual Claude session ID or Codex thread ID and target its origin node.
`--cwd` must name an absolute directory that exists on the selected node. The
node rejects the spawn if that directory cannot be resolved; it never falls
back to the node process's own working directory.
Omit it to start a new CLI session. The project’s Agent Relay workspace remains
pinned independently until you explicitly create or select another workspace.

`agent-relay cloud whoami` also prints the current organization and workspace IDs.

## Cloud multiplayer rooms

Cloud room membership is scoped to one Relay workspace. Every v1 invite creates
a trusted full room participant: they receive their own revocable Relaycast
human credential and may use all ordinary agent-level collaboration actions.
The workspace key itself is never shared, so owner-key administration and Agent
Relay Cloud organization administration remain owner-only.

```bash
# Owner: invite and manage people in this workspace.
agent-relay cloud room invite \
  --workspace rw_7ccfea89 \
  --email teammate@example.com \
  --token-file ./teammate.room-invite
agent-relay cloud room invites --workspace rw_7ccfea89
agent-relay cloud room members --workspace rw_7ccfea89

# Share the owner-only token file over a secure channel. The invitee keeps the
# token out of shell history and process arguments.
# Tokens use the consumer-neutral relay_room_inv_ prefix followed by exactly
# 43 URL-safe characters.
read -rs ROOM_INVITATION_TOKEN
printf '%s' "$ROOM_INVITATION_TOKEN" |
  agent-relay cloud room accept --token-stdin
unset ROOM_INVITATION_TOKEN

# Trusted clients establish one stable session per device.
# --json intentionally includes the participant credential; capture it in
# memory and do not log or persist it.
agent-relay cloud room session \
  --workspace rw_7ccfea89 \
  --device-id client-macbook \
  --json

# Explicitly ending or replacing the device session revokes the old scoped token.
agent-relay cloud room revoke-session \
  --workspace rw_7ccfea89 \
  --device-id client-macbook

# Participants use their scoped token for agent-level Relaycast operations; an
# ambient owner workspace key is never consulted when --token is present.
agent-relay agent presence \
  --token at_live_... \
  --base-url https://cast.agentrelay.com

# Owner: revoke access and active room sessions.
agent-relay cloud room remove-member <membership-id> --workspace rw_7ccfea89
```

There is no room-specific integration grant or credential service. Connect the
workspace provider through the existing Cloud integration API, then use the
normal Relayfile workflow for setup, mounts, reads, and writebacks:

```bash
# Owner: discover or connect a provider through Cloud.
agent-relay cloud integration catalog
agent-relay cloud integration connect linear --workspace rw_7ccfea89
agent-relay cloud integration connections --workspace rw_7ccfea89

# Member clients use Relayfile directly, including its OAuth/backend selection
# and durable writeback queue.
relayfile integration available
relayfile integration connect linear
RELAYFILE_LOCAL_DIR="$PWD/.integrations" relayfile setup
RELAYFILE_LOCAL_DIR="$PWD/.integrations" relayfile status
RELAYFILE_LOCAL_DIR="$PWD/.integrations" relayfile writeback status
```

Relay workers can subscribe to provider feedback using their own identity
(`RELAY_AGENT_NAME`), including workers that the desktop session socket rejects
with `not_a_relay_session`:

```bash
agent-relay integration subscribe github \
  --resource '/github/repos/AgentWorkforce/relay/pulls/123/**' \
  --to self --no-input
```

`--to self` resolves `RELAY_AGENT_NAME` and uses the existing server-side agent
subscription channel. It requires a connected provider, a compatible Relayfile
daemon, and workspace-owner credentials, supplied to the worker through its
environment. An agent token alone cannot provision subscriptions. This route does
not depend on desktop Claude/Codex session discovery. From outside the worker,
use `--to @worker-name` with the same workspace credentials; the recipient must
already exist (`--spawn`, which launched it through the local broker, was
removed). Events reach the worker through Relay's normal delivery; wait for
pushed feedback instead of polling `gh`.

`local` remains as a deprecated hidden alias of `node` for `local run|logs|sync` (it prints a one-time warning).

Node workflow runs use Relayflows for YAML and TypeScript workflow files.

Hosted equivalents live under `agent-relay cloud …`.

## Packages

- `@agent-relay/sdk`: messaging, delivery contracts, and actions.
- `agent-relay`: CLI and MCP entry point.

`@agent-relay/harness-driver`, `@agent-relay/harnesses`, `@agent-relay/fleet`
and the `@agent-relay/broker-<platform>` packages were retired with the broker.
Their published versions stay installable from npm; no new versions ship.

### Pending fleet spawns and name reuse

An accepted spawn whose result is still unknown returns `spawn_unconfirmed` with
`state: "pending"` (exit 8), plus its invocation ID and dispatch state when
known and any available liveness evidence. Check
`agent-relay fleet agent list --node <node>` before retrying. A heartbeat that
lists a worker with the requested name is reported as evidence but keeps the
spawn pending: heartbeats carry worker names, not invocation IDs, so that worker
may have been running before this spawn. Heartbeat snapshots can change between
listings; JSON output includes their timestamps and ages.

If no worker is running and you intend to reclaim the name, run
`agent-relay agent remove <name> --wait` before respawning. Waiting is opt-in;
`--wait-timeout <ms>` defaults to 30000, followed by one bounded membership read.
`fleet release <name> --delete-agent --wait` offers the same check and adds
`removal` evidence to its JSON. A remaining registration exits 8; unavailable
verification reads retain the asynchronous acknowledgement. A name collision
can also mean cleanup from a previous unsuccessful spawn is still in flight.
