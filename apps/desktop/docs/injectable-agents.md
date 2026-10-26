# Injectable agents and fleet workers

The **Agents** tab covers both halves of "agents on this machine":

- **Fleet workers** — agents spawned onto this machine: an agent asks Cloud's
  `list_relay_spawn_targets` where it may spawn and starts one with
  `spawn_relay_agent`, with no command line to install (the desktop's own
  spawn node takes it; see [native-spawn.md](native-spawn.md)). The legacy
  `agent-relay node agent spawn` and `agent-relay fleet spawn` commands land
  on an `agent-relay` broker here too.
  They already have Relaycast names; the tab shows them live and can release
  them. See [Fleet workers](#fleet-workers).
- **Injectable agents** — sessions that are **already running** on a Mac made
  addressable by name on Relaycast, without launching them through
  `agent-relay node agent spawn` or a PTY wrapper.

## What the user does

1. Open the **Agents** tab (the first tab). It lists the fleet workers this
   Mac's broker is running, plus every Codex thread (desktop app and
   terminal), every live Claude Code terminal session, every Claude
   desktop-app session, and every live Devin CLI session on this machine.
2. Pick a name (a default like `codex-relay-3f72` is suggested) and click the
   radio button. The app registers a Relaycast agent with that name.
3. Anyone in the workspace can now `DM @codex-relay-3f72` or @mention it. The
   message shows up in that session as a user turn, labelled:

   ```
   [via Agent Relay — from @alice to @codex-relay-3f72 · ref 1a2b3c4d5e6f]

   Can you check the failing test?
   ```

Turning the radio button off deletes the agent and frees the name.

The chevron on a registered row opens its tools:

- **Rename.** One name per session. A rename, or a session asking for a new name
  in `POST /register`, replaces the name: the new one is the only name shown on
  rosters and the only sender — direct messages, replies (whichever name the
  message was sent to), automatic answers and channel posts all go out under it.
  The name the session was registered with is kept only to forward messages
  already sent to it, so nothing sent while renaming is lost: rosters hide it by
  `renamed_to` in its Relaycast metadata (published again until Relaycast has
  it, and once after start for agents renamed by an earlier version), and it is
  not announced or heartbeated as present, though Relaycast may still see it
  active while it forwards. It keeps the webhook URL and integrations. A channel
  the session posts in or subscribes to under its new name is left under the
  old one, so each post arrives once; leaving a channel leaves under both. Renaming
  again replaces the new name the same way: the replaced one is hidden and keeps
  forwarding for 24 hours, so a late reply still arrives, then is released.
  Renaming back to a name still forwarding (or to the first name) makes it the
  shown name again. Every name is released when the agent leaves the relay.
- **Test message.** Sends a DM through Relaycast from a small `desktop-tester-…`
  agent the app registers once per workspace, so the test takes exactly the path a
  teammate's message takes.
- **Webhook.** Creates a channel `hook-<name>` that only this agent joins and binds a
  Relaycast inbound webhook to it (`POST /v1/webhooks`). Anything POSTed to
  `https://cast.agentrelay.com/v1/hooks/<id>` with `Authorization: Bearer wh_live_…`
  (JSON `{"text": "…"}`) becomes a message in that channel. The app injects every
  delivery from the agent's own hook channel, even though ordinary channel posts are
  not injected. **Revoke** deletes the webhook and its channel, as does turning the
  agent off.

  ```sh
  curl -X POST https://cast.agentrelay.com/v1/hooks/wh_… \
    -H 'Authorization: Bearer wh_live_…' -H 'Content-Type: application/json' \
    -d '{"text":"Build failed on main","source":"ci"}'
  ```

## How it works

```
sender ─DM @name─▶ Relaycast deliveries ─push wake / 5s poll─▶ Agent Relay.app ─▶ codex queue --thread <id>
                                                                   ├▶ Claude Code inbox socket
                                                                   └▶ claude --print --cloud <id>
                          ◀──────────────────ack────────────────────┘
```

- **Registration:** `POST /v1/agents` with the workspace key,
  `auto_join_general` from the **New agents join #general** setting (off
  unless turned on), and metadata naming the session. The agent token
  is kept in `~/Library/Application Support/com.agentrelay.desktop/injectable-agents.json`
  (mode 0600), the same way the `agent-relay` CLI keeps workspace keys.
  Agent Relay Dev keeps its own copy under `com.agentrelay.desktop.dev`.
- **Store file:** every save holds an exclusive lock on
  `injectable-agents.json.lock`, re-reads the file and merges this process's
  changes onto whatever another process wrote since it last read it, so two
  running copies of the app never erase each other's agents; an agent removed
  by one copy stays removed. A store that does
  not decode is moved to `injectable-agents.json.unreadable-<timestamp>` and
  the Agents view says so; one that cannot be read at all blocks saving.
- **Durability:** Relaycast writes a delivery row for each message addressed to
  the agent and redrives it until it is acked or expires (1 hour). The app reads
  `GET /v1/deliveries`, injects, then `POST …/ack`, acknowledging only after
  the record that prevents a second injection is on disk.
- **Push:** each agent keeps its direct node socket open (`POST /v1/agent/node-token`,
  then `wss://…/v1/node/ws`, `node.register`, `node.heartbeat` every 15 s). Each
  mint rotates the agent's node token, so the token is reused on every reconnect
  until the socket refuses it (401/403), mints are taken one at a time 250 ms
  apart and wait out a 429, and a new workspace label (the name Relaycast reports
  once the key is verified) keeps every socket rather than reconnecting all of
  them. That is
  the only realtime route to an agent in Relaycast v5 (`/v1/ws` is now a workspace
  observer stream). A pushed direct message or thread reply is injected straight
  from the frame; a channel post only wakes a queue read, because only the queue
  says whether it was an @mention. Either way the delivery is acked over HTTP after
  injection, because `delivery.ack` on the socket is terminal. A 30 s poll is the
  safety net.
- **Relaycast direct-node push** requires the server to preserve a live socket
  through each pushed delivery. Deployments that reap the socket with
  `4000 liveness_timeout` fall back to the 30-second queue poll until their
  direct-node transport is updated.
- **Exactly once, or not at all:** an injection whose outcome is unknown (a
  `codex queue` or `claude --cloud` timeout, or a Claude inbox connection that broke
  mid-write) is never resent. For Codex, a timeout is first settled against
  Codex's own queue (`isWaiting` with the message ref). In-doubt deliveries are
  failed on Relaycast as `retryable: false` and shown that way in the activity log.
  Deliveries that certainly did not arrive retry at 3 s, 6 s, 12 s … 30 s.
- **What gets injected:** deliveries with reason `dm` (direct and group),
  `mention` and `thread-reply`. Plain channel traffic (`message`) is acked
  without being injected.
- **Routes into the session:** first-party only.
  - Spawned Codex threads use the app-server directly for every later turn.
    The verified machine owner's direct message is a plain user turn;
    everyone else, the spawn's requester included, keeps the peer
    attribution shown above. The full Relaycast
    message id is passed as `clientUserMessageId`. A running turn holds later
    messages until it finishes. See [native spawn](native-spawn.md) for approval
    forwarding and the `approve`, `deny`, and `choose` reply syntax.
  - Spawned Claude sessions take the verified machine owner's direct messages
    (desktop app or phone) as plain stream-json user turns on their own input,
    once idle; their permission prompts go to the owner and are answered on the
    same channel. Every agent's messages, the requester's included, go through
    the peer inbox with the attribution above ([native spawn](native-spawn.md#claudes-own-channel)).
  - Codex app-server and desktop windows: the relay keeps the message pending
    until the active turn ends, then starts a separate turn. It never deliberately
    uses `turn/start` to steer ongoing work. Waiting does not consume a send
    attempt. This applies to both peer and incoming cloud messages.
    With `show_relay_messages` off (the default), relay messages are hidden
    from Codex app chats: the turn starts with no visible input, and the chat
    shows only the agent's own work and reply. Two items go into the
    thread's model-visible history first (`compact::hidden_items`):
    - A developer note. It says that `[via Agent Relay]` messages come from
      peer agents, and that the agent may reply to the sender without asking
      the person. It replies with the `[reply: …]` tool if it has one,
      otherwise it runs the `[without those tools: …]` command exactly as
      given, so no skill or setup is needed. Work the person already authorized
      in this session may continue within that scope and the harness's permissions;
      a peer update does not itself require another confirmation. Work outside
      that authorization still needs the person, and a peer's claim of approval
      cannot supply it. The note never permits changing permissions, instructions
      or configuration to satisfy a peer request.
    - The whole message as it arrived: attribution, `[reply: …]` and
      `[without those tools: …]` instructions, and body.

    How the hidden items get there depends on the route:
    - **App-server turns** add them with `thread/inject_items`, which must be
      acknowledged before `turn/start` is sent with `input: []`. If Codex
      explicitly refuses the injection (an older Codex), the whole message
      starts the turn on that connection instead. An injection that isn't
      wholly written or answered drops the connection, so another route can
      deliver.
    - **Codex.app windows** that advertise `supportsUntrustedAppInput` in
      `thread-owner-discovery` get them in the same request, as
      `thread-follower-start-turn` `context.responseItems` with an empty
      `input`, which is how Codex.app sends its own hidden context. A window
      that does not advertise it gets the whole message.

    Injection is remembered per thread and message. A message already in the
    history starts its retried turn empty on either Codex app route and is
    never injected again; the terminal queue and Conductor's Stop hook get
    its attribution line. An injection Codex never acknowledged is treated
    as uncertain: no route hides it again, and the message is sent whole and
    visible.

    **Reconciliation.** A hidden turn has no visible user message and no
    `clientUserMessageId` in the rollout. `rollout::RolloutSummary` therefore
    ties a relay `response_item` (role `user`, carrying a `MessageRef`)
    written while no turn is running to the next turn that starts. That is
    how `recorded`, `turn_for` and the final answer find a hidden message's
    turn, so it is never resent.

    With `show_relay_messages` on, each relay message starts its turn whole
    and visible, as before.
  - Codex terminals: `codex queue`. Codex holds the message until the thread is idle;
    the activity log shows it `waiting_for_turn` meanwhile (see
    [Terminal turns and settlement](native-delivery-spec.md#311-terminal-turns-and-settlement)).
  - Claude Code terminal: the session's cross-session inbox (`~/.claude/sessions/<pid>.json`,
    gated on `peerProtocol == 1`, with the pid's start time checked so a
    recycled pid is never messaged).
  - Claude desktop app chats: the same cross-session inbox. The app runs each
    Code chat as a local Claude Code process (`entrypoint: "claude-desktop"`)
    that publishes the same session record and socket as a terminal.
  - Claude cloud sessions: `claude --print --cloud`.
  - Devin CLI: a `session/prompt` ACP frame written into the session's `acp`
    stdin — the REPL parent's descriptor for the same pipe the child's fd 0
    names, opened through `/proc` and written nonblocking in one
    `PIPE_BUF`-bounded line. That is an immediate user turn, so even a
    session idle at the prompt wakes. The pipe route is Linux-only (macOS has
    no `/proc`) and only reaches a terminal `devin` REPL → `acp` child:
    Devin Desktop spawns one `devin acp` that multiplexes every session over
    socketpairs, which `/proc` could not reopen anyway. So on macOS, and for
    Devin Desktop sessions on any OS, delivery is queue-only while the
    session is idle — the staged message lands at the next hook boundary and
    does not wake the session. When the pipe is unreachable or the
    frame won't fit, delivery stages a file into the session's inbox
    directory (`~/.local/share/devin/relay/inbox.d/<session>.<message>.msg`),
    written to a `.tmp` name and synced, then atomically renamed into place
    so a hook boundary never reads a partial message. Agent Relay's
    lifecycle hooks in `~/.config/devin/config.json` (`devin_direct_delivery`,
    on by default where Devin has run) drain it into the conversation at
    `SessionStart`, `UserPromptSubmit`, `PostToolUse` and `Stop` — a session
    started before the hooks were on needs a restart to fire them.
  - Devin cloud sessions (`devin-*` ids, including ones shown in Devin
    Desktop or placed on a local outpost pool) inject through the v3
    organization session-message API and are immediate; only local
    `devin-local` sessions share the pipe/inbox route.
- **Which workspace:** the signed-in account's, the same workspace uploads go
  to. At sign-in the app uses the sign-in token once to call
  `GET /cloud/api/v1/workspaces/{workspace UUID}/resolve`, which returns
  `relaycastApiKey`, `workspaceId` and the Relaycast URL; the key is kept in the
  store's `cloud` and is the only workspace key messaging uses. The token itself
  is not stored. Installs that signed in earlier use **Connect workspace**, which
  opens Cloud's CLI login directly: a browser already signed in to Agent Relay
  returns at once. Environment keys, the `agent-relay` CLI's workspace files and
  pasted keys are not read.
  `RELAYCAST_URL` overrides the origin, but only a bare https origin is accepted.
- **Sign-in state in the path:** Cloud's return from Google currently keeps only
  the first parameter of `next`, which dropped `state` and made every return look
  forged. The callback is now `http://127.0.0.1:PORT/callback/<state>`, and the
  receiver accepts the state from the path, so it survives either way.
- **Removing an agent** always uses the workspace key it was registered with,
  never the currently selected workspace. The switch stays on (with an error)
  if Relaycast can't be reached, so a name is never orphaned silently.

### What reaches the session, and what gets an automatic answer

- **Integration events** in the agent's own events channel are injected, except
  noise that a whole-repository subscription otherwise delivers constantly:
  `_index.json` rewrites, generic `update` record syncs (they repeat a typed
  event), `*.edited` churn (mostly bots updating their own comments) and `push`.
  Typed events such as `pull_request.opened`, `pull_request_review.submitted` and
  `issue_comment.created` arrive; skipped ones are acknowledged and shown in the
  activity log.
- **Channel posts** reach an agent only from a channel it subscribed to.
  Direct messages stay the default way agents coordinate; a channel is for a
  larger swarm. Registered agents join `#general` only when **Settings ›
  Relay › New agents join #general** (`auto_join_general`) was on when they
  were registered (agents already registered keep their channels), and
  Relaycast delivers an ordinary post (delivery reason `message`) only to the
  channel's members other than its author, so a post arriving means the
  agent opted in (hosted MCP `subscribe_relay_channel`, or
  `POST /channels/subscribe` on the session socket). The agent's own posts
  are acknowledged without injection. Every post of one channel read in the
  same pass of the agent's queue becomes **one** injection, at most 20 posts
  and about 48 KB of post text and files (below the 64 KB prompt limit of
  the OpenCode and Grok routes; the rest go in the next injection), so a busy
  channel costs one turn per pass rather than one per message; DMs,
  @mentions and thread replies are still injected one at a time. Before a
  prompt is handed over it is written, with its posts and ids, to
  `channel-injections.json` in the app data directory. Until it settles,
  every retry, also after a restart, hands over that exact prompt again; a
  post that arrives meanwhile goes in its own. Once that prompt settles,
  every post in it is recorded, also one the confirming read did not
  return, so it is acknowledged when it appears rather than injected again. The ids are the recipient's
  own delivery ids, so two agents given the same posts never share a
  route's receipt. A post whose channel name cannot be read yet waits in the
  queue rather than carry commands for the wrong channel. A Claude Code
  session in Conductor also gets the note asking it to quote the post. The
  attribution says it is a post in a channel the agent subscribed to, and the
  reply lines say how to answer in the post's thread, to DM the author only
  if it is private, and how to unsubscribe:

  ```
  [via Agent Relay — 2 posts in #swarm, a channel you subscribed to, to @api · messages m1, m2 · ref 1a2b3c4d5e6f]
  [reply: in #swarm with post_relay_channel channel="swarm" thread_id="m2" (agent-relay-sessions MCP); DM the author with send_relay_message only if it is private; unsubscribe_relay_channel channel="swarm" stops these posts]
  [without those tools: curl -s -X POST --unix-socket … 'http://relay/send?channel=swarm&thread_id=m2' --data-binary 'your reply']

  --- @alice (alice@laptop) · message m1 ---
  Schema is merged.

  --- @bob · message m2 ---
  Rebasing now.
  ```

  Relay Connect sessions still skip channel posts.
- **Reply instructions follow what the session can use.** A session that
  registered itself with `"mcp":"agent-relay-sessions"` is shown only the
  hosted MCP's tools (`send_relay_message`, `post_relay_channel`, …); one that
  said `"mcp":"none"`, and every Relay Connect guest, only the session socket's
  commands. A session that said neither (the Agents-list switch, automatic
  activation, an older agent) is shown the tools and one socket line as the
  fallback. A session the socket cannot reach keeps the automatic final answer
  unless it declared the MCP. Cloud knows when a hosted MCP session links to a
  desktop identity (`join_relay` with `desktop_address`), which would prove the
  tools are loaded, but the desktop identity sync only sends identities up, so
  the desktop cannot use that yet.
- **Automatic replies** go only to people and agents (DMs, @mentions, thread
  replies), never to plain channel posts, whose reply lines ask the session to
  answer itself. Integration events and webhook posts never get one: in the events
  channel a thread reply is written back to the provider, so an automatic answer
  would become a GitHub comment nobody asked for. Replying to a provider must be
  deliberate.

## Integrations are on by default

Each setting that connects an installed agent tool to the relay is on unless
the person turns it off: Claude Code direct delivery (`direct_delivery`)
wherever Claude Code has run and the organization has not pinned
`crossSessionInbound`, and Grok leader mode (`grok_leader`) wherever Grok is
installed. A settings extension names these keys with `default_on`; at startup and on every
workspace refresh the core turns each one on once and records it in
`integrationDefaultsApplied` in the injectable-agents store. A key is recorded
once it is on, whether the core or the person turned it on, and when the
person changes it in Settings, so turning one off stays off, across
restarts and updates. A tool installed later gets its default on the next
pass. A change that fails, such as a config file that is unsafe to edit, is
reported in activity and tried again later rather than recorded. Every change
keeps the tool's file as before (other keys, mode, symlinks) and copies the
original once to a `.relay-desktop-backup` file.

## Claude Code and `crossSessionInbound`

Claude Code **holds** a message from a sender that does not attest its
permission mode when the receiving session skips permission prompts. That
includes messages from this app. The user sees *"Held message from another
session"* and has to approve it.

The documented setting that controls this is `crossSessionInbound` in the
user's Claude settings (`accept` | `hold` | `refuse`).

It is on by default (see above). Signing in applies the default through the
core's write-only `direct_delivery_default` setting, without showing a setup
checkbox. Agent-led `/setup` applies the same default. The default never
overrides an explicit choice: it writes only when the user's own settings file
does not contain the `crossSessionInbound` key. Existing values (`"hold"`
included) and managed settings are left alone. The default is applied once per
install; a failed write is retried at the next sign-in. Direct-delivery
preferences remain available in Settings.

The Agents tab shows a
banner whenever a Claude Code session is present, and **Deliver directly…**
sets `"crossSessionInbound": "accept"` in `~/.claude/settings.json` after
confirmation. Other keys are kept, symlinks are followed, the file mode is
kept, and the original is saved once as `settings.json.relay-desktop-backup`.
**Ask again** writes Claude Code's own default, `"hold"`, so the choice is kept in Claude's settings and the on-by-default pass never reverses it. If managed settings (`/Library/Application
Support/ClaudeCode/managed-settings.json`) pin a value, the banner says so and
offers nothing, because a user setting cannot override managed policy.

Because direct delivery is on by default (see above), the banner appears only
when the person has turned it off.

The app never fakes a permission-mode attestation to get past the hold.
Claude Code keeps its own label and its no-escalation guardrail text around
every relayed message.

For users who prefer to set it by hand:

```json
// ~/.claude/settings.json
{
  "crossSessionInbound": "accept"
}
```

## Verified end to end (2026-09-22)

On a signed-in Mac running this build (ad-hoc signed bundle, arm64):

| Session | Name | Result |
| --- | --- | --- |
| Claude Code 2.1.280 terminal session | `@claude-relay-desktop-ade8` | DM injected. With the default setting it was held for approval; after **Deliver directly…** a second DM arrived with no prompt. |
| Codex CLI 0.156.1 terminal thread | `@codex-relay-3f72` | DM injected as a turn. Codex replied as instructed. |
| Unregister | `@codex-relay-a83b` | Radio off → agent deleted on Relaycast (404). |
| Restart | both | Registrations and tokens survived an app restart and kept delivering. |
| Visible Codex TUI in Terminal.app | `@codex-relay-3566` | Each DM appeared exactly once as a labelled turn and was answered (`GUAVA-58`, `PAPAYA-94`, `KIWI-…`). |
| Push timing (with the upstream bug) | both | Claude 3.9–4.3 s, Codex 5.8–11 s. One Codex delivery took 28 s because `codex queue` stalled on Codex's own log-database contention; it was settled through Codex's queue with no duplicate. |

Every delivery was acked and none was injected twice.

## Fleet workers

Workers a broker spawned already register themselves on Relaycast under their
fleet name — nothing needs enabling. The Agents tab lists them in a **Fleet
workers** section with provider (Codex, Claude, Devin, …), live state, node,
channels, pending message count, and last activity; **Release…** stops a
worker through its broker.

### The durable contract

The app reads the same files and HTTP surface the `agent-relay` CLI itself
uses — never terminal scraping or process lists:

```
~/.agentworkforce/relay/node-claims/<node>.<generation>.json ─▶ node id + state_dir
<state_dir>/connection.json {url, api_key}                   ─▶ broker endpoint
GET    {url}/api/spawned            (X-API-Key)              ─▶ live workers
DELETE {url}/api/spawned/{name}     {expected_generation}    ─▶ release
```

- **Discovery:** the newest claim generation per node names the broker's
  state dir; a node whose newest generation is a tombstone (`released: true`)
  was released and contributes nothing. A bare `<relayHome>/connection.json`
  covers a broker using the relay home itself. `$AGENT_RELAY_HOME` overrides
  the home. `fleet-enrollments.json` supplies the node's workspace id for
  display scoping; its `nodeToken` is never read.
- **Credential placement:** the broker API key is only ever sent to a bare
  loopback `http(s)` origin. A connection file pointing anywhere else —
  remote host, credentials in the URL, a path — is refused, so a hand-edited
  file cannot leak the key.
- **Listing:** `GET /api/spawned` returns `{"agents": […]}` with `name`,
  `cli`/`provider` (codex, claude, devin, cursor, opencode, …), `model`,
  `runtime_kind`, `sessionId`, `channels`, `generation`, `current_state`
  (`working` | `idle` | `blocked_on_send`), `ready`, `last_activity_at` /
  `last_activity_ms`, and `pending_messages`. Every field but `name` is
  optional in the decoder so older/newer brokers still list.
- **Lifecycle:** `ready:false` → *starting*; `current_state` → *working*,
  *idle*, or *waiting* (`blocked_on_send`); a worker that disappears from a
  good read has *ended* and leaves the list. One the app itself released is
  shown as *ended* until the broker confirms it is gone. Worker identity is
  stable across refreshes: `node id | name`.
- **Release:** `DELETE /api/spawned/{name}` sends the `generation` the UI
  last saw, so a same-named replacement worker can never be released by
  accident.
- **Refresh and errors:** the fleet section refreshes on the same 5 s poll
  that backs the injectable safety net, plus the manual Refresh button. Each
  broker is fetched concurrently with a short deadline; a broker that cannot
  be reached shows an error line — it is never presented as "no workers".
- **Dedupe:** a fleet worker *is* its provider session — a Codex worker's
  `sessionId` is its Codex thread. Sessions the fleet already owns are not
  also offered an injectable name; the fleet name is the canonical address.

### Auto-activation safety

Agent-led setups keep auto-activation on by default, but discovery is not
enough to qualify a session. Automatic registration requires a conversational
process: SDK/print/structured-I/O Claude runs, `codex exec`, local fleet
workers, and configured temporary-directory sessions are skipped. The default
temporary roots can be replaced with the colon-separated
`AGENT_RELAY_AUTO_ACTIVATE_EXCLUDED_DIRS` environment variable.

Codex threads, interactive Claude Code sessions (and the Claude chats
Conductor, Paseo and Claude's desktop app run), already-open Grok sessions and
live Devin CLI sessions qualify. A Claude desktop app chat is recorded as an
interactive `claude-desktop` session and descends from this user's
`Claude.app`, with no other Claude session in between, so a `claude -p` run a
chat starts stays automation. One with no project runs in a generated scratch
folder and is named by its title instead (`claude-ping-…`).
Live Devin sessions are the exception to the opt-in: they register even
when `auto_activate` has never been set, because a live `devin` process
holding the session lock is already the caller proof the other kinds wait
for a boundary to establish — and it is the same kernel proof registration
and delivery use. An explicit `auto_activate: false` is still honored — it
turns Devin auto-activation off too. A Grok TUI session qualifies
only while a leader of this user runs, the one route into it; registering it
binds and proves that leader first (`bind_open_grok`), and a binding that does
not prove is refused, so nothing is sent. When its own leader stops, its
stored binding no longer proves (`LocalSessions::grok_open_reachable`): once
that leader is proven dead, as when Grok restarts it, delivery rebinds the
session to the running leader (`rebind_open_grok`), so it stays eligible.
While the old leader is not proven dead, delivery waits and does not rebind,
so the session is not eligible even when another leader of this user runs,
and it leaves after the grace period below. OpenCode and Claude cloud sessions
stay opt-in: a cloud session runs remotely, so no local process proves it is a
person's chat or that this computer may reach it. Muse sessions do not enter
this existing-session path; only Relay-owned native spawns register.

Registration is capped at five new identities per minute and twenty active
auto-managed identities. The app records which identities it created this
way. If one is no longer eligible, it is unregistered after a five-minute
grace period; manually toggled and session-self-registered identities remain
until their owner removes them. Any identity whose session has ended is marked
idle on Relaycast and stops being heartbeated, pushed to, or handed to Cloud
in the desktop identity sync, and its queue is not read, since a read with
its token would show it active. So it leaves the active roster on every
device, and the apps list only running sessions; it is back the moment its
session runs again, with its name and the messages Relaycast still holds for
it (Relaycast redrives a delivery for an hour).

An archived session is different: it is not coming back, so its agent leaves
the relay at once however it was added, and its name and address are
released (webhook and integration channel included). Archive is read only
from the provider's own record, never inferred from a session being absent:
a Codex thread whose row in `state_5.sqlite` has `archived` set, an OpenCode
session whose `time_archived` is set, and a Claude app session that refuses a
send with "is archived" (the only way its archive shows). The registration is
marked `archivedAt` in the store until Relaycast confirms the removal, so a
failed removal is retried on every pass and it is never heartbeated
meanwhile. Each one is recorded in the store's `archivedSessions` (newest
first, the last 50: name, address, target, title, when), returned by
`agents.list` as `archived`, and shown under *Archived* on the Agents page on
macOS and Linux. Unarchiving the session does not restore the old name; it can
be put on the relay again like any other session.

### Messaging a fleet worker

Fleet workers answer their `@name` directly — DM or @mention them from the
workspace; delivery goes through the broker's own pending-queue, not through
this app. The tab therefore offers **Copy @name** rather than a delivery
toggle, and shows each worker's broker-side `pending` count so a stuck queue
is visible. Releasing is the only fleet mutation and always carries the
generation check.

Relay Connect is the narrow exception because its accountless participant
credential belongs to the provider session rather than to the fleet worker's
normal Relaycast name. For a local fleet-spawned Codex guest, a trusted
same-user terminal Codex beneath the broker worker must hold exactly the
requested thread's writer lock. The broker may still be starting and omit its
`sessionId`; the lock and immutable process tree remain the authority. Queue
writes, reads and support probes bind the process's isolated
`CODEX_SQLITE_HOME`, while rollouts remain under its `CODEX_HOME`; neither path
may fall back to the desktop user's default queue. Ordinary Codex targets have
no fleet-shaped SQLite home and therefore never wait on a stale broker.

A missing, replaced, or mismatched process is refused, an uncertain write is
marked in doubt, and a transient not-ready result stays pending while the
probe retries locally with durable bounded backoff. Later messages cannot
overtake that pending head. A head Codex has accepted into its thread queue no
longer holds later messages back: they join the same first-in, first-out
queue at once, even while the guest runs a long turn, and each reports
`handed_off`, `waiting_for_turn` or, once the rollout records it, `visible`.
If Codex has not accepted the message after one
hour (configurable with `AGENT_RELAY_CONNECT_HANDOFF_TIMEOUT_SECONDS`), the
probe makes one final local attempt and only then records `unavailable`. Once
the exact message is accepted into Codex's per-thread queue, observation never
writes it again and it is never age-expired. If it disappears from a readable
queue without reaching the rollout, a 45-second recording grace ends in a
sender-visible `in_doubt` outcome; later handoffs, already queued behind it,
are unaffected. The
probe otherwise follows the queue and rollout until delivery, a verified
target loss, or the Connect ends, expires, or is left. Ending the Connect stops
observation but does not remove an exact handoff Codex already accepted into
its thread queue. Pending attempts and recent final outcomes appear in `GET
/connect/status`, so no delivery can remain silently pending.

### Linux parity

The relay core serves the same fleet contract and injectable sessions on
Linux, for terminal Claude Code and Codex. Discovery scans same-user
processes, so SSH and tmux do not need special registration. The headless
service is the core itself (`agent-relay-probe relay serve --headless` under a
systemd user unit), so the socket, push/poll delivery, and uploader
supervision keep running after logout with no display.

## Conductor sessions (macOS)

[Conductor](https://conductor.build) runs Claude Code and Codex sessions in
workspaces, worktrees under `~/conductor/workspaces/<repository>/<name>`.
They are ordinary sessions of those tools: their transcripts are in
`~/.claude/projects` and `~/.codex/sessions`, so they upload like any other,
and the app lists them with a Conductor badge on the provider's icon
(`host: "conductor"` on `sessions.list` and upload rows, from the directory).

- **Codex** (verified 2026-10-09 with Conductor's bundled Codex 0.159.3).
  Conductor's sidecar (`com.conductor.app/bin/.internal/conductor-runtime
  sidecar`) starts one OpenAI-signed `codex app-server --listen stdio://` per
  session, which holds the thread's writer lock and sets `CODEX_THREAD_ID` in
  the agent's shell. So a command the agent runs is identified on the send
  socket as that thread, like a terminal Codex, and `POST /register` works.
  That app-server runs the thread's `codex queue` messages once a turn ends,
  as the TUI does, so it counts as live (`processes::is_conductor_codex`) and
  relay messages go through `codex queue`.
- Conductor's chat does not show a relay turn: Conductor records only the
  turns it starts. The agent has it in its history (asked, it quotes the
  message and its reply), and the exchange is in the app's activity. Posting
  through Conductor's chat needs Conductor's API (`POST
  /v0/sessions/{id}/messages`, an API key, local workspaces unverified) or its
  private app-to-sidecar socket; neither is used.
- Conductor stops an idle session's Codex. Until the person next uses that
  chat, the session is not live and relay messages wait in the queue.
- **Showing relayed messages in Conductor's Codex chats** (setting
  `codex_stop_hook`, row *Conductor Codex chats*, on by default where
  Conductor has run). Conductor listens to a Codex thread only for a turn it
  started (`followGoalContinuations` aside) and stops at `turn/completed`, so
  a `codex queue` turn never shows. Codex runs Stop hooks as a turn is about
  to end, and `{"decision":"block","reason":…}` makes it go on **in the same
  turn** (verified with Codex 0.159.3; Conductor showed the reply live). So
  Agent Relay adds its own entry to `~/.codex/hooks.json`
  (`agent-relay-probe relay codex-stop-hook`) and trusts it through Codex's
  app-server (`hooks/list`, then `config/value/write` of `hooks.state`), as
  Codex's own review does; other hooks are left as they are, and Conductor's
  `-c hooks=` launch override still runs it.
  - A message for a Conductor chat that is **working** is held
    (`codex::stop_hook::StopHookInbox`, "Waiting — handed over when the
    Conductor chat's turn ends") and handed over by the hook, with the quote
    note. Codex records it as a `HookPrompt` in that turn, which
    `rollout::recorded` and `final_answer` read.
  - One for an **idle** chat goes through `codex queue` at once, as before,
    and is noted; at the first stop of the chat's next turn the hook asks the
    agent to show those messages and its answers, without acting on them
    again.
  - A held message whose turn ended without the hook taking it goes to the
    queue; one the hook took is never queued again.
  - The hook sends only the thread, turn and `stop_hook_active` to
    `POST /codex/stop-hook`, which answers only a caller below the trusted
    Codex holding that thread's writer lock. Any failure answers `{}`.
  - Linux has no row: Conductor is a Mac app. Conductor builds with Codex 0.144 wrote no writer
  locks, and their agents were refused with `not_a_relay_session`.
- Codex sessions Conductor starts carry originator `codex_sdk_ts`. In a
  Conductor workspace they are a person's sessions, not "Agent run"s.
- Conductor prefixes each Codex thread's first message, which Codex keeps as
  its title, with a `<system_instruction>` block; the listed title skips it.
- **Claude Code** (verified 2026-10-09): listed, badged and delivered through
  the Claude Code peer socket like any Claude Code session. Conductor keeps
  the session's stream open, so it shows the agent's reply turn, but not the
  relayed message, as only Conductor's own send path creates a chat message.
  So a relayed message into a Claude Code session in a Conductor workspace
  carries one more header line (`Injector::host_note`,
  `conductor::QUOTE_NOTE`) asking the agent to start its reply by quoting the
  message. Codex sessions get no such line: Conductor shows none of a turn it
  did not start (it listens to a Codex thread only for its own turn).
- With automatic activation on, Conductor's Claude chats go on the relay like
  terminal ones. Conductor runs every chat as a `stream-json` Agent SDK run
  without a terminal, which `claude::is_interactive_terminal` takes for
  automation; `claude::is_conductor_chat` lets one through when its `cwd` is a
  Conductor workspace and its nearest Conductor-runtime ancestor is this
  user's sidecar (`conductor::under_sidecar`), with a launcher such as a
  `claude_code_executable_path` script allowed in between. Other SDK and
  `claude -p` runs stay off. Codex chats were already eligible.
- **Several Claude logins.** Account switchers for Conductor keep a second
  login as `CLAUDE_CONFIG_DIR=~/.claude-<name>`, and Claude Code records that
  login's sessions, and their peer keys, in `~/.claude-<name>/sessions`.
  `ClaudeConfig::registries` reads the configured registry and the
  `sessions/` of every sibling `.claude` and `.claude-*` folder, each once by
  its real path, and a session's key is read from its own registry
  (`TerminalSession::registry`). So a chat moved to another login is listed,
  reachable and auto-activated like any other; transcripts already go to the
  shared `projects/`.
- **Opt-in activation** (setting `claude_session_hook`, row *Claude Code
  activation*, off unless turned on, on both macOS and Linux). For a person
  who does not want `auto_activate` everywhere. Turning it on writes one
  SessionStart command hook into each Claude login's `settings.json` the
  desktop knows about (`ClaudeSettings::login_settings`: the configured login
  and each other login). The command is `agent-relay-probe relay
  claude-session-hook`. At session start it calls `GET /setup/status` with
  `X-Agent-Relay-Observe: 1`, which does not apply the agent-led defaults
  (a normal status read still does). Only when `session.registered` is false
  and sessions may register themselves does it tell the session how to
  `POST /register` (with `"mcp":"agent-relay-sessions"` when it has those
  tools, `"mcp":"none"` when it does not). A session already on the relay is
  given a short preamble instead, also in a `claude -p` or Agent SDK run since
  it asks nothing: its relay name and address, how to list peers and send
  (by its declared MCP access, as above), and the norm — DM peers whose work
  your task affects without waiting to be asked; use channels only for larger
  swarms; subscribe to a channel to get its posts. Codex has no SessionStart
  hook here, so it gets no preamble. When "Let sessions put themselves on the relay" is off,
  it says so and does not offer a command that would be refused. It never
  registers the session. Turning it off removes only that hook and writes
  `{}` back when that was the file's only content, so a pre-existing file
  or a symlink target is not deleted. A second install does not rewrite an
  up-to-date file. A login the desktop does not yet list (a config dir other
  than `.claude` / `.claude-*`) is left alone until `other_logins` includes it.
- Conductor is a Mac app, so the Linux app has no Conductor sessions to badge.

## Limits and follow-ups

- Automatic replies require a readable local transcript; Claude app/cloud is
  excluded. See the final-answer guarantees below.
- Two copies of the app on one Mac would both poll the same agents.
- Codex threads are listed from `~/.codex/state_5.sqlite` (40 most recent,
  not archived, no sub-agents).
- Fleet workers are listed per local broker. Workers on *other* fleet nodes
  are not shown: Cloud's `list_relay_spawn_targets` lists every node and its
  capacity for choosing where to spawn (the legacy `agent-relay fleet agent
  list` aggregates remote nodes from heartbeat summaries, which can be
  degraded: counts without live names), so the app deliberately scopes to
  what the local broker authoritatively reports.
- The macOS app cannot run its Swift build/tests on Linux; they run in CI
  on macOS runners.

## Sending from a session (macOS and Linux)

### Exact endpoint addresses

Relaycast publishes a canonical `agent@machine` address for every hosted
agent. The macOS Agents composer and Linux Workspace/Messages UI accept that
address and send it in the `address` field of `POST /v1/dm`; they never reduce
it to the agent name. Linux shows and copies the address returned by
`GET /v1/agents`. A plain name or `@name` remains a compatible workspace-wide
send. `agentrelay://message?to=alice%40laptop` opens the endpoint composer
without carrying message text or credentials.

The desktop checks only that the input has an `agent@machine` reading. It does
not guess how a string containing several `@` characters splits: Relaycast is
the authority and either resolves the one live endpoint or returns
`ambiguous_address`. A missing or released endpoint, stale generation, or wrong
machine returns `address_not_found`; the desktop shows that error and never
retries by name. A hosted endpoint that still exists but is temporarily offline
is different: Relaycast durably queues the message and returns HTTP 201. The
desktop reports that success and does not manufacture a 404. Automatic final
answers likewise use the sender's `agent_address` from the delivery. Persisted
name-only replies from older builds still send by name.

Person-identity tokens cannot read the workspace-key-only agent directory. To
recover exact-address history, both desktop apps use only the token-visible DM
conversation list and message history. A cached conversation id is only a hint:
before reading it, the desktop requires server history to attribute the exact
immutable `agent_address` to the same immutable `agent_id` listed as that 1:1
conversation's participant. Missing evidence, a released/reused name, or a
different machine generation fails closed instead of exposing another
endpoint's history. The clients search the complete visible conversation list
and page backward through a candidate's history, so an older proof does not
expire merely because 50 newer messages were sent. A first outbound message
alone cannot prove which immutable recipient accepted it—the send receipt does
not contain the recipient id—so exact-address history stays closed until a
recipient-authored history row supplies that proof. A proof miss is cached
briefly, then rechecked so a reply acknowledged by another client cannot hide
history indefinitely; local send, push, acknowledged delivery, and the macOS
manual refresh invalidate it sooner. This avoids a full DM-history scan on every UI
poll. Already-proven history is
an archive rather than a liveness signal: releasing the endpoint makes new
sends return 404, while a replacement generation cannot inherit the archived
conversation because its immutable id and address no longer match.

A session the app registered has no Relaycast token: the app holds it. The
desktop serves a private Unix socket (mode 0600, in a 0700 directory), and a
session sends through it with nothing but a recipient and text. Linux uses
`$XDG_RUNTIME_DIR/agent-relay/relay.sock`; macOS uses
`~/Library/Application Support/com.agentrelay.desktop/run/relay.sock` and
falls back to a short per-user directory under `$TMPDIR` when the application
support path would exceed macOS's `sockaddr_un.sun_path` limit:

```sh
curl -s --unix-socket "$XDG_RUNTIME_DIR/agent-relay/relay.sock" \
  'http://relay/send?address=alice@laptop' --data-binary 'On it.'

# macOS
curl -s --unix-socket "$HOME/Library/Application Support/com.agentrelay.desktop/run/relay.sock" \
  'http://relay/send?address=alice@laptop' --data-binary 'On it.'
```

`?to=<name>` works too. A JSON body names exactly one destination with
`"address"`, `"to"`, or `"channel"`; `?channel=<name>` is the equivalent
text-body form. A leading `#` on the channel is optional.
The JSON body may also carry `"files"`: up to five absolute paths to regular,
readable files of at most 25 MB each. The app uploads each one to Relaycast as
the calling session's agent (`POST /v1/files/upload`, a `PUT` of the bytes,
`POST /v1/files/{id}/complete`), with a content type from its extension
(`png`, `jpg`/`jpeg`, `gif`, `webp`, `pdf`, `txt`, `json`, `md`, else
`application/octet-stream`), then sends the message with their ids as
`attachments`. Relaycast replies carry no attachments, so `files` with
`reply_to` is refused. A bad path is refused with `invalid_files`
(400), a file over 25 MB with `file_too_large` (413), and a failed upload with
`attachment_upload_failed`; nothing is sent in any of those cases. The answer
lists what was attached:

```sh
curl -s --unix-socket "$XDG_RUNTIME_DIR/agent-relay/relay.sock" http://relay/send \
  --data-binary '{"to":"alice","text":"The failing screen.","files":["/tmp/shot.png"]}'
# {"ok":true,"data":{"from":"codex-api","to":"alice","message_id":"…",
#   "attachments":[{"file_id":"…","filename":"shot.png","content_type":"image/png","size_bytes":156774}]}}

# Post the same file to a channel instead of a DM.
curl -s --unix-socket "$XDG_RUNTIME_DIR/agent-relay/relay.sock" http://relay/send \
  --data-binary '{"channel":"screenshots","text":"Linux proof.","files":["/tmp/shot.png"]}'

# Subscribe to a channel's posts (DELETE to stop), and reply in a post's thread.
curl -s -X POST --unix-socket "$XDG_RUNTIME_DIR/agent-relay/relay.sock" \
  'http://relay/channels/subscribe?channel=swarm'
curl -s --unix-socket "$XDG_RUNTIME_DIR/agent-relay/relay.sock" http://relay/send \
  --data-binary '{"channel":"swarm","thread_id":"m2","text":"On it."}'
```

A channel thread reply takes `channel`, `thread_id` and `text` only (no files,
no `reply_to`). `thread_id` must be a plain id, and a thread of a post this
session was shown **in that channel**: a message shown in a DM or another
channel does not open it. A later injection that fails does not close a
thread an earlier prompt opened.

A message that arrives with attachments is injected even when it has no text.
Before it is put into the session, each file is saved, within 20 seconds in
all, to `<app data>/attachments/<file_id>/<name>` (the name reduced to a safe
basename; files over 25 MB are not fetched; a file saved earlier is reused
when its size matches what Relaycast reports),
and the injected text ends with where it is:

```
Attachments:
- shot.png (image/png, 153.1 KB) saved to /home/me/.local/share/com.agentrelay.desktop/attachments/file_1/shot.png
```

A file that could not be saved is still named, with the reason and a command
that fetches it later. When the session can use this socket, the command is
its `POST /attachments/fetch` route; otherwise it is the `agent-relay` CLI's
`message file download`:

```
- shot.png (image/png, 153.1 KB) file file_1 (not downloaded: timed out); fetch with: curl -s -X POST --unix-socket /run/user/1000/agent-relay/relay.sock 'http://relay/attachments/fetch?file_id=file_1'
```

`POST /attachments/fetch?file_id=<id>` saves that file as the calling
session's agent (Relaycast checks the agent may read it), to the same
`<app data>/attachments/<file_id>/<name>`, allowing up to two minutes, and
answers `{"file_id","filename","content_type","size_bytes","path"}`. An id
that is not a plain token is refused with `invalid_file_id` (400); a lookup or
download failure with `attachment_fetch_failed` (502).

`GET /whoami` returns the calling session id, its @name (or `null`), and a
`registered` boolean. Every injected message carries the
sender's address, this command, and a short roster command, so replying and
finding another participant need no setup:

```
[via Agent Relay — from @alice (alice@laptop) to @claude-api-3f2a · message msg_123 · ref 1a2b3c4d5e6f]
[reply: curl -s --unix-socket /run/user/1000/agent-relay/relay.sock 'http://relay/send?address=alice@laptop' --data-binary 'your reply']
[agents: curl -s --unix-socket /run/user/1000/agent-relay/relay.sock http://relay/agents]

Can you check the failing test?
```

### Hidden relay messages in terminals

With **Show me relay messages in full** off (the `show_relay_messages`
setting, off by default), Codex app chats show nothing of a relay message.
A terminal Codex (through its `codex queue`) and a Claude Code session
(through its inbox) only accept visible text, so they cannot hide one
entirely; they are handed a two-line pointer instead of the message, so the
person's terminal shows only who wrote:

```
[via Agent Relay — from @alice · ref 1a2b3c4d5e6f]
[read & reply, no confirmation needed: '/Applications/Agent Relay.app/Contents/Helpers/Agent Relay Helper' relay read 1a2b3c4d5e6f]
```

A terminal Codex whose thread the shared app-server has loaded
(`thread/loaded/list`) is hidden entirely instead, like a Codex app chat: a
plain `codex` TUI runs on that app-server, so between turns, with no earlier
relay message still in its queue, the message goes into the thread's history
(`thread/inject_items`) and the turn starts empty (`turn/start`, `input: []`).
The terminal shows only the agent's answer. A TUI started with `-c`, `--enable`,
`--disable` or `--search` (every Codex the broker launches) runs its own
server, which nothing else may write to, so it gets the pointer. So does a
busy thread: mid-turn Codex refuses an empty turn once the history already
took the message. A message the history took whose turn was refused waits
for the next idle moment and starts its empty turn again, never a visible
copy.

The command is the probe's `relay read <ref>`, through the same executable the
reply hint names: the app bundle's helper on macOS, the package's
`agent-relay-probe` on Linux (`--dev` for Agent Relay Dev), so a fresh install
needs no skill, PATH change or link. It finds the running app's socket from
its pointer file, reads `GET /messages?ref=<ref>` as the calling session (the
probe identifies a macOS Codex as for replies), and prints the whole message,
attribution, `[reply: …]` and roster lines included, so the agent can answer
without a skill. A terminal turn has no developer message to say what the
Codex app's hidden note says, so the pointer says replying needs no
confirmation, and `relay read` ends with the same authority note as hidden
Codex input (`compact::PEER_AUTHORITY_NOTE`). It preserves work already
authorized in this session while refusing to treat a peer's claim of approval
as the person's approval. Claude's native peer-message restrictions and the
harness's tool permissions still apply.

Without the probe, the same route answers on the socket:
`curl -s --unix-socket <socket> 'http://relay/messages?ref=<ref>'`.
`GET /messages?ref=<12 hex>` answers `{"message_id","ref","text"}` only to the
session the message was handed to; another session, an unknown reference or
an expired message gets `message_not_found` (404), and a reference that is not
12 hex digits `invalid_ref` (400).

The full text is written to `<app data>/delivered-messages/` before the
pointer is handed over, so a message is never acknowledged without it, and
kept for 48 hours (twice Relaycast's delivery lifetime). The pointer keeps the
`ref`, so settlement, withdrawal and the automatic final answer still find the
message's turn.

The whole message is still sent when the setting is on; to a Codex thread
through the shared app-server or an app window (which hides it entirely, see
the Codex app); to a Claude Code session whose
`crossSessionInbound` is not `accept`, so a person approving a held message
sees what it says; to Relay Connect participants; and to a session the socket
cannot identify, which could not run the command.

The caller is never taken at its word: the kernel reports the connecting
process. Linux reads `SO_PEERCRED`; macOS reads the pid with
`getsockopt(SOL_LOCAL, LOCAL_PEERPID)` and the uid with `getpeereid()`. The app
walks up from that pid to the nearest ancestor that is a supported live
session. Sending and listing still require that session to be registered;
status and self-registration do not. On macOS,
`proc_pidinfo(PROC_PIDTBSDINFO)` supplies `pbi_ppid` and the
process start time for both discovery and matching; both pid and start time
must match, so a recycled pid is not mistaken for the session. Claude Code's
own live-session registry supplies its pid; terminal Codex resumes are matched
from the command's `CODEX_THREAD_ID` environment value, read with
`KERN_PROCARGS2` on macOS and `/proc/<pid>/environ` on Linux. That value is not
an identity by itself: the app accepts it only when the kernel process tree
reaches a Codex executable owned by the same user (and, on macOS, carrying
OpenAI's valid code signature). An arbitrary process setting the variable is
refused. The supported `resume <thread UUID>` argv shape remains a fallback
for older Codex clients. The app then sends through that registration's token
with `POST /v1/dm`.

A request naming a sender, a process outside every supported session, and
another user are all refused; each session may make 30 rate-limited relay
requests a minute. No key
or token appears in the command, the message or the transcript, so a prompt
injection has nothing to steal — though it can still make the session send as
itself. At startup, a live socket owned by another app instance is left alone;
an unresponsive stale socket is replaced. Startup is serialized across app
instances, and cleanup only removes the same user-owned socket inode that the
app inspected or created; a non-socket entry at that path is never deleted.

Limits: the process must descend from the session (Claude Code and Codex run
their tools as children; a daemonized helper would not qualify); a session in
a container needs the socket mounted. A shared Codex app-server can own several
threads. The exact thread comes from the command's `CODEX_THREAD_ID`, and the
nearest trusted Codex ancestor must hold that thread's writer lock. A sibling
session under the same daemon could set another loaded thread's ID and be
accepted; current process evidence has no per-thread token or process group
that distinguishes those siblings. A process outside trusted Codex ancestry,
or one claiming a lock the ancestor does not hold, is refused. The injected
reply hint on macOS Codex without a `resume <thread>` ancestor uses the
probe's own `relay socket-request` command.
Manual `/usr/bin/curl` commands from a daemon-backed Codex thread can still
receive `not_a_relay_session`: macOS hides their thread environment from the
probe. The reply command is shown only while that registration has a live process-backed
session (a trusted Codex process has the exact thread's writer lock open) or
Codex reports the exact thread from `thread/loaded/list` over `codex app-server
proxy`. A Claude Code session whose registry entry has no recorded start time,
or a session that is not running, gets the message without a reply command it
could never use.

### Session roster contract

`GET /agents` uses the same kernel-derived caller admission and per-session rate
limit as `POST /send`. The roster credential is the workspace key saved with
that caller's registration, so changing the app's selected workspace cannot
expose the new workspace to an older live session. The app fetches Relaycast's
`GET /v1/agents?status=active` roster with its workspace credential and caches
it for about 30 seconds. One Relaycast read per roster runs at a time, and a
request waits on it for at most 5 seconds. When the read takes longer, or fails
with a 5xx status, the last roster that was read answers with
`"stale": true` while the read finishes in the background for the next
request. With no earlier roster to fall back on, the request fails with `504`
and the code `relaycast_slow`; retry in a moment. Relaycast's 4xx refusals are
reported as they are, never replaced by a stale roster. Presence for sessions
on this computer comes from what the delivery loop already records, so the
answer never waits on session discovery. A successful response is:

```json
{"ok":true,"data":{"agents":[{"name":"alice","address":"alice@laptop","kind":"agent","where":"other_desktop","status":"active","last_seen_ms":1790683200000,"description":"Reviews releases","is_self":false}],"fetched_at_ms":1790683200000,"stale":false}}
```

Each row contains only `name`, the published canonical `address` (or `null`),
`kind` (`agent`, `human`, or `service`), `where` (`this_computer`, `cloud`, or
`other_desktop`), `status` (`active` or `idle`), `last_seen_ms`, a one-line
`description`, and `is_self`. Tokens, keys, and raw metadata are never returned.
The optional query parameters are `q` (name/description search), `where`, and
`include_idle=1`; idle entries are hidden otherwise. With no workspace the
error code is `not_signed_in`. Other errors use the socket's common
`{"ok":false,"error":{"code":"…","message":"…"}}` shape.

### Session self-registration contract

`POST /register` lets the kernel-identified calling session put only itself on
the relay. Its JSON body is optional; `name` requests a preferred @name,
`description` supplies the one-line roster description, and `mcp` says
whether the session can use Agent Relay Cloud's hosted MCP: include
`"mcp":"agent-relay-sessions"` if you have those tools, or `"mcp":"none"` if
you do not. It is stored with the registration (registering again updates it),
reported by `GET /whoami` and `GET /setup/status` (`session.mcp`:
`declared`, `unknown` or `socket_only`), and picks the reply instructions
injected messages carry. It invokes the same
registration path as the Agents-list switch: a Relaycast agent, canonical
`agent@direct` address, push and queued inbound delivery, and the same private
on-disk token. No credential is returned:

```json
{"ok":true,"data":{"name":"review-bot","address":"review-bot@direct","already_registered":false}}
```

Calling it again returns the existing identity with `already_registered:true`.
`DELETE /register` removes that calling session through the same path as the
Agents-list switch and is also safe to repeat. Both operations share the
socket's per-session rate limit. Unknown callers, another user's processes,
unsupported session kinds, and request fields that try to name a different
session are refused.

The **Let sessions put themselves on the relay** setting defaults on. When it
is off, `POST /register` returns `not_allowed` and points to that setting;
leaving remains available. A self-registered row says **added by the session**
in the Agents list and the user can remove it there at any time. Workspace keys
and agent tokens remain inside the desktop app.

### Session settings contract

An agent reads and changes every setting the app's Settings shows, through the
same core calls the app makes (`settings.get`, `settings.set`). The list is
derived from the bridge contract, so a setting added for the apps is an
agent's too, described by its doc comment:

```sh
# Every setting: key, type, current value, whether it is available and can be
# changed, what it does, what a change takes (`accepts`, the write schema; the
# folder list reads as folders but is changed with paths), and allowed values
# where the type does not say.
curl -s --unix-socket "$XDG_RUNTIME_DIR/agent-relay/relay.sock" http://relay/settings
# Change one or more; the answer lists what changed and the settings after.
curl -s -X PATCH --unix-socket "$XDG_RUNTIME_DIR/agent-relay/relay.sock" \
  http://relay/settings --data-binary '{"auto_join_general":true}'
# The same from a session curl cannot identify (macOS Codex):
agent-relay-probe relay settings                      # print them
agent-relay-probe relay settings auto_join_general=true spawn_max_agents=4
```

Only this user's live sessions may call it, as for `/send` and `/register`,
and it shares their per-session rate limit. A setting a tool owns (Grok
leader mode, say) is absent until that tool has run here: it is listed with
`available: false` and its reason, and cannot be changed. Unknown keys,
wrong types and values a setting refuses answer `400 invalid_settings` with
the core's sentence. A request is all or nothing: tools' settings are
changed first and Agent Relay's own (spawning among them) only once every
tool accepted, so a refusal never leaves the spawn node reconfigured; tools'
settings changed before a refusal are put back, and one that cannot be is
recorded and named in the refusal with why. Changes are made one writer at a time, the app's
included, so each is recorded with its own values before and after. Any
setting may be changed, with no confirmation; each change is recorded with
the agent's name (or its session when it is not on the relay), the time, the
setting and its value before and after. **Settings › Relay › Changed by
agents** lists the latest on macOS and Linux, the activity log has a line for
each, and both apps read their settings again at once (`invalidated`
`settings`). A change the person makes in the app is not listed. The output
carries no credentials: the workspace key and agent tokens are not settings.
Settings that live only in the app (appearance, which app opens a session)
are not in the list.

The pre-registration setup routes use this same kernel-derived caller trust.
They expose sign-in state and public device-approval metadata, never Cloud or
Relaycast credentials. See [Agent-driven setup](agent-driven-setup.md) for the
route contract, headless install, defaults, and webhook/integration setup.

On start the app writes its current socket path plus a newline to
`~/.agentworkforce/desktop/relay-socket`. The directory is mode 0700 and the
pointer is mode 0600; clean shutdown removes the pointer only when it still
names that app's socket. Clients discover the socket in this order:

1. `AGENT_RELAY_SOCKET`.
2. `~/.agentworkforce/desktop/relay-socket`.
3. Platform defaults: macOS application data `run/relay.sock`, including its
   short-path fallbacks; on Linux,
   `$XDG_RUNTIME_DIR/agent-relay/relay.sock` (or the app data `run/relay.sock`
   fallback when no runtime directory exists).

## Automatic final answers

The tools panel's **Reply with final answer** switch defaults on for Codex and
Claude Code terminal sessions. Confirmed injections are tracked by their message
ref; after local completion, the registered agent token sends a DM to the sender
or a reply to the channel's original thread. Answers are capped at 4,000
characters, with `[truncated]` appended. Raw webhook events are excluded unless
already threaded. Claude app/cloud sessions have no local transcript and cannot
auto-reply (with **Claude Code cloud sessions** on, their claude.ai transcript
is listed and uploaded, through the `claude-web` connector at most every five
minutes, which is too late to answer from). Skipped, in-doubt and self-authored deliveries never create replies.

Pending replies and dispatch claims survive restart. A claim is saved before
sending and retained permanently for that registration/message. Relaycast also
receives an idempotency key, but its middleware retention is only 24 hours, so
an uncertain send is **not retried**. This prevents duplicates at the cost of a
possible missed answer if the app crashes between saving the claim and sending.
The activity log reports uncertain sends. This is at-most-once dispatch, not a
guarantee of remote delivery. One app instance per store is required.

Claude's private transcript is read conservatively: a matching attributed user
message, assistant text, and either explicit end-of-turn or current idle status
with no outstanding tool calls are required. Malformed or unfamiliar content
fails closed. A later user prompt cannot be mistaken for the original turn.
Disabling the reply switch cancels pending answers; turning an agent off abandons them.


## Relayfile integrations

In the agent's tools panel, **Integrations → Subscribe** takes a provider and a
resource; there is no workspace to choose. GitHub accepts `acme/api` for the whole
repository and `acme/api#42` for one pull request; use
`/github/repos/acme/api/pulls/**` for all pull requests. Other
providers currently require an explicit path glob, such as
`/slack/channels/C123456/**`. Native-name lookup for those providers uses the
daemon's active workspace and cannot be pinned by its API, so the app declines
to guess. Wildcard fallback resolution also requires an explicit path glob.

Connect the provider in Agent Relay before subscribing. The desktop talks to
relayfile-cloud directly with a short-lived delegated credential, minted by
the relay core on both platforms; it never uses or changes an operator's own
Relayfile daemon.
Provider-access and API errors are returned to the identified calling session.

**Workspace:** Agent Relay's unified workspace registry maps the Cloud workspace
UUID to one canonical service id across Relaycast, Relayfile, and RelayAuth
(`relaycastWorkspaceId`, `relayfileWorkspaceId`, and `relayauthWorkspaceId`
from `/cloud/api/v1/workspaces/{cloudWorkspaceId}/resolve` are equal, e.g.
`rw_7ccfea89`), and
integration events are posted into the agent's own Relaycast channel. So the app
uses the agent's Relaycast workspace id (`GET /v1/workspace` with the agent's
key), falling back to the account's `relayfileWorkspaceId` from `/resolve` when
offline. A user who has no workspace gets one from `/resolve` (it provisions the
unified workspace) when they sign in or click **Connect workspace**. If relayfile
on the Mac is signed in to a different workspace, the returned-id check fails
with a message saying so. Every subscription stores the id it used. Provider status,
writeback-secret lookup, cloud webhook creation, listing and deletion use that
ID; returned workspace IDs are checked. Relaycast requests use the agent's saved
workspace key and origin, even if the app's selected workspace later changes.
Delegated credentials remain in the desktop and private child environments;
secrets never go in command-line arguments or logs. GitHub/Linear/Slack/Jira
writeback is handled by relayfile.

Setup obtains the identity-bound `agent-events-<agentId>` channel and verifies
its sole member, resolves the resource, obtains the signed inbound target and
writeback secret, creates the relayfile-cloud webhook and Relaycast `thread.reply`
subscription, and writes the normal relayfile binding. This appears in
`agent-relay integration subscribe --list`. Only the recorded channel ID bypasses
the plain-channel injection filter. Event text retains `Relayfile path: …`;
metadata paths are appended when available. Final answers reply to the event's
thread and the outbound subscription writes them back to the provider.

The app journals setup before external creates and keeps deterministic resource
names/unique callback URLs. Lost responses can be recovered by listing those
exact resources. A failed or interrupted setup stays visible as **Clean up**
while the daemon retries cleanup every minute; it never silently discards its
record on a failed delete. Only the same unfinished resource is temporarily
refused, so cleanup trouble on one pull request cannot block another. Existing
ready bindings are refused rather than replaced. A numeric GitHub pull-request
binding is removed after its delivered `pull_request.closed` event, which covers
both closed and merged pull requests. Use one app instance and do not
concurrently change the same resource through the CLI:
the daemon's bind/unbind API has no compare-and-swap precondition.

**Unsubscribe** removes the cloud webhook, outbound subscription, auxiliary
inbound webhook and matching local binding. After the last binding it leaves
the channel and stops treating it as an event source. The empty, identity-bound
channel shell remains because Relaycast only supports permanent archival and
cannot revive it on a later subscribe; removing/renaming the agent archives it.
The signed inbound target itself is stateless and has no separate delete API.
Removal requires unsubscribing all integrations first, including unfinished
attempts, so cleanup credentials and identity cannot be lost. A rename leaves
integrations with the original name, so it is not refused for them.

Validation: `swift build` passes. New XCTest coverage includes fixture parsing,
routing and agent authentication, persistence, channel isolation and recovery
URLs. On a Command Line Tools-only Mac, the pure tests and HTTP/socket checks
can be run in a scratch Swift harness; the full suite requires XCTest in CI.
No live provider subscriptions or other agents' sessions were used for testing.
