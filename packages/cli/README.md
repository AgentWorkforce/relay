# agent-relay

A thin operator console for a local agent workforce: stand up the broker, staff it with off-the-shelf agent CLIs, and watch/steer them from the terminal. Each command is a shallow wrapper over a backing package (`@agent-relay/sdk`, `@agent-relay/harness-driver`, `@agent-relay/cloud`).

## Install

Requires Node.js 22 or newer.

```bash
npm install -g agent-relay
```

## Common commands

```bash
agent-relay status                 # workspace + cloud login + local broker
agent-relay mcp                    # MCP stdio server

agent-relay message post --channel general --text "hello"
agent-relay workspace list
```

## This machine's node

The `node` command group manages the broker on your machine and the agents it runs:

```bash
agent-relay node up                          # serves an auto-discovered agent-relay.{ts,js,…} node file,
                                             # or the implicit local node from teams.json
agent-relay node up --config ./my-node.ts    # serve a specific defineNode(...) file
agent-relay node status
agent-relay node down

agent-relay node workflow run workflows/my-workflow.ts
agent-relay node workflow logs <run-id> --follow
agent-relay node workflow sync <run-id>

agent-relay node agent new claude            # spawn + attach
agent-relay node agent new codex --runtime native
agent-relay node agent spawn opencode --runtime pty
agent-relay node agent list
agent-relay node agent attach <name> --mode view
agent-relay node agent release <name>
```

`node agent spawn` and `node agent new` accept `--runtime auto|native|pty`. `auto` is the default and keeps experimental dual-runtime adapters on PTY. Claude Code, Codex, and OpenCode support explicit native or PTY selection; Pi and Deep Agents are experimental native-only harnesses and require `--runtime native`.

For AI SDK native harnesses, attach renders structured activity, text, tools, approvals, files, usage, and lifecycle events. Add `--json` for NDJSON, `--reasoning` for reasoning events, or `--diagnostics` for sidecar diagnostics. Native harness `drive` is line-oriented and acknowledged; native harness `passthrough` is unsupported because no terminal stream exists. PTY attach behavior is unchanged.

### Which workspace a broker joins

`agent-relay up` and `agent-relay node up` resolve the workspace through one
precedence ladder. The first source that resolves wins:

| #   | Source                          | Where it comes from                                                           |
| --- | ------------------------------- | ----------------------------------------------------------------------------- |
| 1   | Command-line flag               | `--workspace-key` / `--wk`                                                    |
| 2   | Environment                     | `RELAY_WORKSPACE_KEY`, then `AGENT_RELAY_WORKSPACE_KEY`, then `RELAY_API_KEY` |
| 3   | Repository pin                  | `<project>/.agentworkforce/relay/workspace-key.json`                          |
| 4   | Machine-global active workspace | the `active` entry in `~/.agentworkforce/relay/workspaces.json`               |
| 5   | New workspace                   | created only when nothing above resolves                                      |

Two rules follow from the order:

- **The repository pin always beats the machine-global active workspace.**
  Switching your active workspace (`agent-relay workspace use <name>`) never
  re-homes a checkout that already pinned one.
- **A new workspace is a last resort, not a default.** A fresh directory joins
  the machine's active workspace when one is selected. When nothing resolves and
  a workspace is created, startup says so explicitly.

Startup prints the winning source (a flag name, an environment variable, or a
file path — never key material):

```
Workspace source: repository pin (/repo/.agentworkforce/relay/workspace-key.json)
Workspace: joined rw_7ccfea89
```

A Cloud enrollment (`RELAY_NODE_TOKEN`, or a record in the Fleet enrollment
store) selects the node's _identity_, not its workspace, so it never appears on
this ladder. If a stored enrollment addresses a different workspace than the
repository pin, `node up` refuses to start and names both source files rather
than silently choosing one.

## Remote fleet agents

The `fleet` command group lists and controls agents across all live nodes in
the active project workspace:

```bash
agent-relay fleet nodes
agent-relay fleet nodes --name sf-mini --capability spawn:codex

# Exact-node placement uses the same agent-scoped Fleet action as the MCP tool.
agent-relay fleet spawn codex \
  --name api-worker \
  --task "Use https://agentrelay.com/skill, ACK over Relay, then wait for details." \
  --node sf-mini

# Resume a known Claude/Codex CLI session on its origin node.
agent-relay fleet spawn codex \
  --name api-worker \
  --task "Resume over Relay and continue the prior task." \
  --node sf-mini \
  --session-ref <actual-codex-thread-id>

# Omit --node for automatic eligible-node placement.
agent-relay fleet spawn codex --name api-worker --task "Review the current diff."

agent-relay message dm send api-worker "Detailed task instructions"
# Wake an idle worker immediately instead of queueing for its next tool boundary.
agent-relay message dm send api-worker "Please check Relay now." --mode steer
agent-relay message inbox check --limit 20
agent-relay fleet release api-worker --reason "Work accepted"
```

Commands use the workspace session pinned to the current project. Targeted
spawn and messaging operations also need an agent identity: pass `--token` or
set `RELAY_AGENT_TOKEN` to the token returned by
`agent-relay agent register <lead-name>`. Automatic placement and release need
only the workspace key.

`--session-ref` is a real CLI resume, not a logical collaboration label. Pass
the actual Claude session ID or Codex thread ID and target its origin node.
Omit it to start a new CLI session. The project’s Agent Relay workspace remains
pinned independently until you explicitly create or select another workspace.

To run as a Cloud-managed node, first redeem a one-time enrollment token, then start the node:

```bash
agent-relay cloud enroll --token ocl_node_enr_...
agent-relay node up
```

With a stored `agent-relay cloud login` you can mint the token yourself instead.
`cloud workspaces` lists the workspaces the login can use, and `--workspace`
takes a name, a Cloud workspace UUID, or a unified `rw_` ID:

```bash
agent-relay cloud workspaces
# 50587328-441d-4acb-b8f3-dbe1b3c5de99  chief  Chief HQ

agent-relay cloud enroll --workspace "Chief HQ"
agent-relay node up
```

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

`local` remains as a deprecated hidden alias of `node` (it prints a one-time warning).

Node workflow runs use Relayflows for YAML, TypeScript, and Python workflow files.

Hosted equivalents live under `agent-relay cloud …`.

## Packages

- `@agent-relay/sdk`: messaging, delivery contracts, and actions.
- `@agent-relay/harness-driver`: optional managed harness runtime.
- `agent-relay`: CLI and MCP entry point.
