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

To run as a Cloud-managed node, first redeem a one-time enrollment token, then start the node:

```bash
agent-relay cloud enroll --token ocl_node_enr_...
agent-relay node up
```

## Cloud multiplayer rooms

Cloud room membership is scoped to one Relay workspace. It does not expose the
workspace key, grant Fleet control, or grant integration write access.

```bash
# Owner: invite and manage people in this workspace.
agent-relay cloud room invite \
  --workspace rw_7ccfea89 \
  --email teammate@example.com \
  --role participant \
  --email-delivery
agent-relay cloud room invites --workspace rw_7ccfea89
agent-relay cloud room members --workspace rw_7ccfea89

# Manual fallback: create an owner-only token file and share it over a secure
# channel. The invitee keeps the token out of shell history and process arguments.
agent-relay cloud room invite \
  --workspace rw_7ccfea89 \
  --email teammate@example.com \
  --token-file ./teammate.room-invite
read -rs ROOM_INVITATION_TOKEN
printf '%s' "$ROOM_INVITATION_TOKEN" |
  agent-relay cloud room accept --token-stdin
unset ROOM_INVITATION_TOKEN

# Trusted clients such as Herdr establish one stable session per device.
# --json intentionally includes the scoped participant or observer credential;
# capture it in memory and do not log or persist it.
agent-relay cloud room session \
  --workspace rw_7ccfea89 \
  --device-id herdr-macbook \
  --json

# Explicitly ending or replacing the device session revokes the old scoped token.
agent-relay cloud room revoke-session \
  --workspace rw_7ccfea89 \
  --device-id herdr-macbook

# Participants use their scoped token for presence and chat; an ambient owner
# workspace key is never consulted when --token is present.
agent-relay agent presence \
  --token at_live_... \
  --base-url https://cast.agentrelay.com

# Owner: revoke access and active room sessions.
agent-relay cloud room remove-member <membership-id> --workspace rw_7ccfea89
```

Room membership grants chat only. Integration access is separately connected,
granted to one room member, and issued as a short-lived, revocable lease:

```bash
# Owner: inspect capability truth, connect a provider, then grant exact paths.
agent-relay cloud integration catalog --workspace rw_7ccfea89
agent-relay cloud integration connect linear --workspace rw_7ccfea89
agent-relay cloud integration grant \
  --workspace rw_7ccfea89 \
  --member <membership-id> \
  --provider linear \
  --path '/linear/issues/**' \
  --access write

# Member or Herdr: capture the delegated bundle explicitly. Caller identity is
# derived from Cloud auth; it is never accepted from command flags.
agent-relay cloud integration credential \
  --workspace rw_7ccfea89 \
  --device-id herdr-room-device \
  --access write \
  --output-file ./relayfile-credential.json

# Herdr uses the JSON form only for in-process capture, keeps the lease ID (not
# its token) as durable cleanup state, and revokes it on close or session reset.
agent-relay cloud integration revoke-credential <lease-id> \
  --workspace rw_7ccfea89
```

`local` remains as a deprecated hidden alias of `node` (it prints a one-time warning).

Node workflow runs use Relayflows for YAML, TypeScript, and Python workflow files.

Hosted equivalents live under `agent-relay cloud …`.

## Packages

- `@agent-relay/sdk`: messaging, delivery contracts, and actions.
- `@agent-relay/harness-driver`: optional managed harness runtime.
- `agent-relay`: CLI and MCP entry point.
