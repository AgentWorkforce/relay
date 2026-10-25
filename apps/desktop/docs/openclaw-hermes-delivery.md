# OpenClaw and Hermes delivery

Relay Desktop delivers relay messages to two always-on personal agents that
run their own gateway on the person's computer: OpenClaw
(`probe/src/relay/openclaw.rs`) and Hermes Agent (`probe/src/relay/hermes.rs`).
Neither is a terminal session, so neither is reached by keystrokes or a
session file. Agent Relay is a local client of each gateway, on loopback only.

Both routes are on wherever the agent is set up: Settings shows **OpenClaw
agents** (`openclaw_gateway`) and **Hermes** (`hermes_agent`) with **Turn
Off**, which leaves a marker under the app's data directory so the default is
not applied again. `AGENT_RELAY_ENABLE_OPENCLAW=0` and
`AGENT_RELAY_ENABLE_HERMES=0` turn the routes off for the core. An agent is
listed, and joins the relay without the auto-activate opt-in, only while its
gateway answers this user's loopback credentials.

## One session per sender

Relay traffic never lands in the person's own chats. Each sender gets a
session of its own on the agent, keyed by a hash of the Relaycast workspace
and the sender's address, so a rename keeps the conversation and two
workspaces never share one:

| | Direct message | Channel post |
|---|---|---|
| OpenClaw | `agent:<agent>:relay:dm:<sender>-<hash>` | `agent:<agent>:relay:channel:<channel>` |
| Hermes | `relay-dm-<sender>-<hash>` | `relay-channel-<channel>-<hash>` |

The agent's final answer is sent back to the sender automatically, through the
core's reply loop; tool progress and commentary are never sent. An agent that
chooses not to answer (`NO_REPLY` on OpenClaw, an empty or failed run on
Hermes) sends nothing.

## OpenClaw

The Gateway (`openclaw gateway`, `ws://127.0.0.1:18789` by default) is reached
as an operator client offering protocols 3 and 4, as OpenClaw's own apps do
(2026.5.7 and earlier speak only 3, 2026.5.12 and later only 4; nothing Agent
Relay uses is new in 4). Port and secret come from
`~/.openclaw/openclaw.json` (`OPENCLAW_CONFIG_PATH`, `OPENCLAW_STATE_DIR`), read
on each connection and never stored; `${VAR}` values and
`OPENCLAW_GATEWAY_TOKEN`/`OPENCLAW_GATEWAY_PASSWORD` resolve from the core's
environment. A config whose `gateway.mode` is `remote` is not contacted.

Every OpenClaw from **2026.3.13** on is supported, and Agent Relay never asks
for or performs an upgrade. What each request carries follows what the
Gateway reports in `hello-ok` (`server.version`, `features.methods`,
`snapshot.uptimeMs`; `probe/src/relay/openclaw/features.rs`): OpenClaw's
schemas are closed, so a field an older release does not know would fail the
whole request. A version that is not a release (a source build) counts as the
oldest release its protocol and methods allow; a prerelease counts as the
release before it.

- **Handshake.** The core keeps its own Ed25519 device key
  (`<app data>/openclaw/device.json`, 0600). It answers `connect.challenge`
  with the v3 device signature, as client `cli`/`cli` named "Agent Relay",
  with scopes `operator.read`, `operator.write` and `operator.admin`. Loopback
  connects with the shared token are approved without a pairing prompt; admin
  is needed for `suppressCommandInterpretation` and session tool limits.
- **Limits** (2026.8.1 and later). Relay sessions are answer-only. Every send
  restates the sender's session limits:
  `sessions.create {key, agentId, permissionMode: "read-only"}` (and
  `displayName` from 2026.9.1; creates or adopts; no command execution, no
  writes), then `sessions.patch {key, toolOverrides: {mcpServers}}` turning
  off every GBrain MCP server in `openclaw.json` except `gbrain_relay` (see
  GBrain below).
- **No limits before 2026.8.1.** An older Gateway has neither a read-only
  mode nor per-session MCP settings. A relay sender still gets a session of
  its own (`chat.send` creates it), but with the agent's usual tools; the
  message is delivered, not refused. Settings says so on the **OpenClaw
  agents** row while it is on (`openclaw_unlimited_version` in
  `settings.get`): "OpenClaw <version> can't limit relay sessions, so anyone
  on the relay who messages your agents gets a session with your agent's
  usual tools. Updating OpenClaw to 2026.8.1 or later makes them
  answer-only." Trusted senders are unaffected: they reach the main session
  on every version.
- **Send.** `chat.send {sessionKey, message, idempotencyKey: <delivery id>,
  deliver: false}`, plus `suppressCommandInterpretation: true` from 2026.6.5.
  `deliver: false` keeps the answer off Telegram and every other channel.
  Command interpretation is suppressed on every line where the Gateway
  offers it; on every version the attribution line opens the message, so a
  peer's `/reset` is never where OpenClaw reads a command.
- **No duplicate turns.** The Gateway's idempotency is in memory only. Before
  each send the core reads `chat.history` (`sessionKey` and `limit` only, the
  fields every release accepts) for the delivery's own user turn: from
  2026.5.26 the one carrying `<delivery id>:user`, before that the one whose
  text holds the delivery's attribution line (it names the message and its
  reference). Found, the message already arrived: delivered, not sent again.
  A resend of the session's last run goes straight to `chat.send`, whose
  idempotency answers `in_flight` while that run is going.
- **Busy sessions.** A session still answering the sender's previous message
  (or, in the main session, a run the person started) makes the delivery
  wait rather than be merged into that turn. From 2026.6.1 `chat.history`
  says so (`sessionInfo.hasActiveRun`); from 2026.5.2 the session's
  `sessions.list` row does (`hasActiveRun`). From 2026.3.22 the row's
  `status: "running"` counts, but only for a run started since the Gateway
  started (the store keeps the status across a restart) and within the run
  cap. Before 2026.5.2 the core also asks `agent.wait {runId, timeoutMs: 0}`
  about the last run it started there, unless that turn is already answered
  in the history, the Gateway restarted since (its uptime), or it is older
  than the run cap (`agent.wait` forgets runs after ten minutes). The run cap
  is the agent timeout every such run has, plus five minutes, and at least
  30 minutes: `agents.defaults.timeoutSeconds` in `openclaw.json`, else the
  release's default (ten minutes on 2026.3.13, 48 hours from 2026.3.22). A
  `0` there (which OpenClaw's own schema rejects) is read as no cap; such a
  turn still ends on its answer in the history, a Gateway restart, or
  `agent.wait` reporting it done. A send the Gateway
  refused (or never received) does not count as the session's last run; one
  whose response was lost does.
- **2026.3.13 cannot see the person's own run.** Its `sessions.list` rows
  carry no run status and its history shows a turn only once it ends, so a
  trusted sender's message to the main session can join a turn the person
  started there. Relay senders' own sessions are unaffected: only this core
  starts runs in them.
- **Answer.** The assistant entry whose `__openclaw.runId` is the delivery id
  and that is marked `runTerminal`, where the Gateway marks one (released
  Gateways mark only mirrored entries). Otherwise, as OpenClaw's own TUI
  reads a run: the last assistant text that ends a run (any stop reason but
  `toolUse`) after the delivery's user turn and before the next one, read
  from the last 1,000 history entries (the most `chat.history` returns), only
  this run's where entries name their run (from 2026.8.1), once that turn is
  over by the checks above.

| OpenClaw | Protocol | Session limits | Session name | Commands as text | Turn found by | Busy check |
|---|---|---|---|---|---|---|
| 2026.3.13 | 3 | none: usual tools | — | attribution line | attribution line | `agent.wait` + history (not the person's own runs) |
| 2026.3.22 – 2026.5.1 | 3 | none: usual tools | — | attribution line | attribution line | `sessions.list` status, `agent.wait` + history |
| 2026.5.2 – 2026.5.7 | 3 | none: usual tools | — | attribution line | attribution line | `sessions.list` |
| 2026.5.12 – 2026.5.25 | 4 | none: usual tools | — | attribution line | attribution line | `sessions.list` |
| 2026.5.26 – 2026.5.28 | 4 | none: usual tools | — | attribution line | `:user` key | `sessions.list` |
| 2026.6.1 – 2026.6.4 | 4 | none: usual tools | — | attribution line | `:user` key | `chat.history` |
| 2026.6.5 – 2026.7.x | 4 | none: usual tools | — | every line | `:user` key | `chat.history` |
| 2026.8.1 – 2026.8.x | 4 | read-only, MCP limits | — | every line | `:user` key | `chat.history` |
| 2026.9.1 and later | 4 | read-only, MCP limits | `displayName` | every line | `:user` key | `chat.history` |

Checked against the npm releases' schemas, by a fake Gateway that plays each
release in `probe/src/relay/openclaw/tests/versions.rs`, and live against
installed Gateways with `probe/examples/openclaw_live.rs`.

Updating OpenClaw is optional; it makes relay sessions answer-only from
2026.8.1. Installs from before July 2026 must step through
`openclaw@2026.9.5` and run `openclaw doctor --fix` twice before moving to the
latest release, then `openclaw gateway install --force` to rewrite the service.

### Trusted senders

**Settings › Trusted senders** (`trusted_relay_senders`, shown while OpenClaw
or Hermes is on) lists relay names or exact addresses trusted like the person.
A message from one of them reaches the person's own agent: OpenClaw's main
session (`agent:<agent>:main`), with its context, memory and tools, never
limited by the relay; and the person's own Hermes (see below). Commands stay
text and answers still never reach other channels. Everyone else keeps a
session of their own, answer-only where OpenClaw can limit it (2026.8.1 and
later). A name matches the sender's relay name
without case; an entry with `@` matches only that exact address.

### Agent Relay tools

**Settings › Agent Relay tools** (under **OpenClaw agents**, while it is on)
gives the person's OpenClaw agents Agent Relay's own tools, through the hosted
Agent Relay MCP (`<site>/cloud/api/v1/mcp/shared-sessions`, the signed-in
account's site, `https://agentrelay.com` by default): list the relay's agents,
message them and spawn new ones. It is one click, as for Grok Bot and ChatGPT:
the person picks a workspace and agent name on the hosted MCP's consent page
and clicks Approve. Nothing is edited by hand and no terminal is needed.

- **Connect** (`openclaw.relay_tools.connect`) reuses an `mcp.servers` entry
  already at that URL, whatever its name; otherwise it runs `openclaw mcp add
  agent_relay --url <url> --transport streamable-http --auth oauth --no-probe`.
  An `agent_relay` entry at another address is the person's and is never
  overwritten: the row says to remove or rename it. It then starts `openclaw
  mcp login <name>`, reads the authorization URL it prints, and the app opens
  it in the browser the way sign-in opens its approval page. The login keeps
  running in the background, on its loopback callback, until the browser
  returns to it (OpenClaw gives up after 5 minutes). An OpenClaw that cannot
  start that callback asks for a pasted code, which the apps cannot offer:
  that is shown as a failed sign-in.
- **Status** (`openclaw.relay_tools.status`) is `waiting` while that login
  runs (the apps read it every 2 seconds while Settings shows, and **Open
  Again** opens the same page), else `authStatus.state` from `openclaw mcp
  status --json` for the entry: `authorized` is `connected`; anything else,
  or no entry, is `not_connected`. A read is reused for 30 seconds. OpenClaw
  keeps the credentials; no token field is read, logged or shown.
- **The CLI** is found without `PATH` (the core runs under launchd or
  systemd): the running Gateway's own executable and script (usually
  `node …/openclaw/dist/index.js`), else an `openclaw` in
  `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, `~/.npm-global/bin`,
  `~/.bun/bin`, `~/.volta/bin` or the npm prefix, then `PATH`. It runs with
  the `OPENCLAW_CONFIG_PATH` (and `OPENCLAW_STATE_DIR`) this core reads, and
  every call but the login has a 20-second limit. Each runs in a process
  group of its own and is stopped with SIGTERM to the group, then killed
  after 5 seconds: OpenClaw's launcher (2026.10.4) respawns the CLI as a
  detached child and forwards SIGTERM to it, so killing the launcher
  outright would leave `mcp login` holding its OAuth callback port
  (127.0.0.1:8989). Without the CLI, or with an OpenClaw that has no `mcp
  login`, the row says so instead of offering Connect.

Untrusted senders never get these tools: every answer-only session turns off
each MCP server whose name contains `agent_relay` (or `agentrelay`) and each
whose URL is the hosted Agent Relay MCP, whatever its name. Trusted senders
reach the person's main session, which has them. A Gateway older than
2026.8.1 cannot limit relay sessions (`openclaw_unlimited_version`), so there
the row is unavailable, even when OpenClaw is already signed in, and Connect
refuses: "OpenClaw <version> can't keep these tools away from people who
aren't trusted senders. Updating OpenClaw to 2026.8.1 or later lets you
connect them." A core that has not connected to the Gateway since it
started first shakes hands with it to learn this; when the Gateway cannot be
reached the row fails closed: "Agent Relay can't reach OpenClaw's Gateway to
check what it supports. Start OpenClaw, then try again." Every other reason
the handshake fails is named as OpenClaw's own row names it (a remote Gateway,
an unreadable `openclaw.json`, a secret-reference token, a refusal), or "OpenClaw's
Gateway is still starting. Try again in a moment."

- **A server turned off** (`enabled: false`) is not connected, signed in or
  not; Connect turns it on with `openclaw mcp configure <name> --enable`.
- **No `mcp login`.** Before offering Connect with no entry yet, the core
  reads `openclaw mcp login --help`; an OpenClaw without it is unavailable,
  and nothing is added to `openclaw.json`.
- **A running Gateway.** Released OpenClaw (through 2026.10.4) runs `mcp add`
  and `mcp login` while its Gateway runs. Later builds refuse them while the
  Gateway owns the state ("No local mutation was attempted"; their Gateway's
  `mcp.authLogin` serves only plugin connectors from a browser Control UI).
  Agent Relay never stops or restarts the Gateway; the row says to stop it,
  connect, and start it again.

## Hermes

Relay traffic goes to a Hermes profile of its own, `relay`
(`<HERMES_HOME or ~/.hermes>/profiles/relay`; `AGENT_RELAY_HERMES_PROFILE`
names another), never the person's main Hermes: its own memory, no messaging
channels, listed as **Hermes (relay)**. Its gateway serves the API on loopback
when the profile's `.env` sets `API_SERVER_ENABLED=true` and an
`API_SERVER_KEY` (`API_SERVER_PORT`, default 8642). The key is read on each
request and never stored; an `API_SERVER_HOST` other than loopback is refused.
Hermes is listed only while `GET /v1/capabilities` reports durable
`runs_idempotency`.

- **Send.** `POST /v1/runs {session_id, input, instructions}` with
  `Idempotency-Key: agent-relay-<delivery id>`. Hermes reserves the key
  durably, so a retry after a lost response, even across a restart, returns
  the same run. The instructions tell Hermes the text is another agent's
  message, not the person's instructions or slash commands, and to reply only
  to that sender.
- **Answer.** `GET /v1/runs/<id>`: the final `output` once the run is
  `completed` with `completed: true`.
- **Trusted senders** reach the person's own Hermes instead: the API server
  of the main home (`HERMES_HOME`, else `~/.hermes`), in a session per sender
  (`relay-trusted-<sender>-<hash>`), told the message is from someone trusted
  like the person. That needs `API_SERVER_ENABLED=true` and a key in the main
  home's `.env` (loopback only); while it is off, their messages wait rather
  than go to the relay profile.

Setting up the relay profile:

```sh
hermes profile create relay            # no --clone-channels: no Telegram etc.
hermes -p relay auth add <provider>    # its own login, or the root login
# profiles/relay/.env (mode 0600):
#   API_SERVER_ENABLED=true
#   API_SERVER_HOST=127.0.0.1
#   API_SERVER_PORT=8643               # a port of its own
#   API_SERVER_KEY=<random>
# profiles/relay/config.yaml:
#   gateway: { standalone: true }
#   platform_toolsets: { api_server: [] }   # answer-only
#   mcp_servers: { gbrain_relay: { url: …, headers: …, tools: { include: [recall, query] } } }
hermes -p relay gateway install
```

## GBrain

Relay sessions read the person's GBrain only through a scoped client, never
the local plugin. GBrain enforces it: a `memory-reader` grant (read scope,
write operations refused at dispatch) bound to the sources the person chose,
with `visibility: private` pages hidden from it.

```sh
gbrain serve --http                                     # if not already serving
gbrain auth create agent-relay --scopes read            # a bearer that does not expire
gbrain auth rescope --token agent-relay --sources <source>[,…]
```

A `gbrain mcp grant … --harness generic --profile memory-reader` client works
too, but it issues OAuth client credentials whose access tokens expire (an
hour by default, 90 days at most), while an MCP server entry's headers are
static; it would need rotating.

The server URL and bearer become an MCP server named `gbrain_relay`: in
`openclaw.json` under `mcp.servers` (an HTTP entry; never name an HTTP entry
`gbrain`, which merges with the bundle plugin's stdio server), and in the
Hermes relay profile's `mcp_servers`. Relay sessions turn every other GBrain
server off; with no `gbrain_relay`, they have no brain.

## Accepted risk (v1)

Relay sessions are answer-only but not sandboxed. OpenClaw's `read-only` mode
denies commands and writes, but on the Codex runtime it does not confine
reads to the session root, so a relay sender's turn can read the person's
files, `~/.openclaw/openclaw.json` (gateway token, API keys) included, and an
agent that can read files can reach GBrain's local data without its grants.
On OpenClaw older than 2026.8.1 relay sessions are not limited at all: a relay
sender gets a session of its own whose turns have the agent's usual tools
(commands, file writes and its MCP servers, under the person's credentials).
This is the product owner's decision, so that no one has to upgrade OpenClaw
to join the relay: such messages are delivered, not refused. Settings says
so on the **OpenClaw agents** row on macOS and Linux while it is on, naming
the version, and updating OpenClaw to 2026.8.1 or later makes those sessions
answer-only. Relay peers are trusted for v1; a per-agent setting letting peers have the
agent do work is deferred.

On the Codex runtime OpenClaw defers MCP tools: the model finds them through
tool search and may not look, so GBrain recall in a relay session is
best-effort.
