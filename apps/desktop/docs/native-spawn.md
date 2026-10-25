# Native spawn: Agent Relay starting agents through the desktop

Status: v1 in `probe/src/relay/spawn` (Codex, Claude, OpenCode, Grok, Muse and Devin). On by
default (an unset `accept_spawns` reads as on); the person turns it off with
**Settings → Messages → Spawned agents → Accept spawns from Agent Relay**, and
an explicit off stays off.

## Why

Cloud's `spawn_relay_agent` used to land only on the `agent-relay` broker,
which starts every agent inside its PTY wrapper and types into it. With the
desktop installed, the desktop takes the spawn itself and starts the agent the
way its vendor intends to be driven, the way Paseo does:

| Harness | Headless launch | Later messages reach it by |
| --- | --- | --- |
| Codex | A thread on Codex's own app-server daemon: `codex app-server daemon start`, then `thread/start` + `turn/start` through `codex app-server proxy` | A dedicated app-server `turn/start` while idle, resuming an unloaded, unarchived spawn (`thread/resume`) first; its proxy stays connected through the turn for approvals and elicitations. Ordinary registered sessions still require a loaded host |
| Claude | `claude -p --input-format stream-json --output-format stream-json --verbose --session-id <uuid> --permission-prompt-tool stdio` in its own process session, its input a FIFO held open, and kept on disk, by a small shell that exits with it | The verified machine owner's DMs (desktop app or phone): a stream-json user line written into that FIFO while idle, its permission prompts answered by the owner on the same input. Every agent's, the requester's included: Claude Code's peer inbox socket, as for a terminal session (a stream-json process publishes `~/.claude/sessions/<pid>.json` with a `messagingSocketPath`). See [Claude's own channel](#claudes-own-channel) |
| OpenCode | An `opencode serve` of its own on a loopback port with fresh Basic credentials, started as probe-managed OpenCode sessions start theirs; a session created in the folder with the spawn's permission rules; the first message through `prompt_async` | The managed OpenCode route (`opencode_existing`): `prompt_async` under a deterministic message id behind a durable journal, waiting while the session is busy. See [OpenCode](#opencode) |
| Grok | A Grok leader of its own (`grok agent leader --leader-socket <private socket>`) in its own process session, and a session opened on it over ACP (`session/new`, then the task as one `session/prompt`) by a short-lived `grok agent --leader stdio` client | The managed Grok route's ACP transport: a client loads the session on that leader and prompts it, behind a delivery journal, once the leader is proven ([Grok CLI](#grok-cli)) |
| Muse | Muse's TUI on a detached Relay-owned PTY, with the task passed as its startup argument; the private `relay muse-spawn-host` helper only drains output and never types | A courier restricted to the exact Relay-owned process and registry session |
| Devin | A persistent private ACP host owns the CLI session and its exact child process | The same ACP session receives queued, deduplicated follow-up prompts |

Muse uses its TUI because `muse exec` is one-shot and `muse serve` does not
publish a peer-message endpoint. The host survives a core restart; an inherited
invocation marker plus Muse's registry recovers its real session. Before starting
Muse, the host saves a private ownership record so recovery can wait for its
registry or stop that exact host and its child group after a bounded sixty-second
readiness deadline. Cold startup can exceed twenty seconds before Muse publishes
its message-capable session.
The bound host record also permits cleanup if the registry disappears; an
unreadable registry alone does not prove process exit. Process ownership checks
include uid, executable, pid and kernel start identity.
Muse's sandbox stays on by default; full access explicitly selects `--yolo`.
The same core descriptor supplies both apps' labels and access controls; no
app-specific launch path exists. Muse sessions started outside Agent Relay are
not discovered, registered or messaged.

Spawned Muse and Devin expose a per-launch MCP tool for Relay messages. It uses
the authenticated local session socket and accepts only the recipient, message
text, and optional reply parent. Shell sandboxing stays enabled by default;
Relay replies do not require granting shell access to the socket.

The MCP server configuration is scoped to that launch; user settings are not
rewritten. Muse uses a required stdio server with explicit JSON-line framing.
Devin's ACP permission gate authorizes only the launch-pinned Relay send tool.
Neither transport accepts a caller identity, credential, socket, or HTTP-header
override from tool arguments. The core proves the caller from process ancestry.

Both routes were checked live (Codex CLI 0.159, daemon 0.162.1; Claude Code
2.1.296): a thread started through the proxy stays in `thread/loaded/list`
after the client goes, and a peer-socket message to a headless stream-json
Claude starts a turn.

For spawned Codex and Claude, only the machine owner is trusted: the person signed in to
Agent Relay on this computer (from the desktop app or their phone), whose
node claim is theirs, matched by their Relaycast identity's immutable agent
id (`spawn::drive`). The owner's direct message starts a plain user turn,
with its full message id as `clientUserMessageId` for deduplication and the
automatic answer. The spawn's requester and every other agent keep the
`[via Agent Relay]` peer framing; a requester's message is never a native
turn. Both wait until the current turn finishes. A spawned Claude takes the
owner's turns, and sends its requests to the owner, over its own input
([Claude's own channel](#claudes-own-channel)); taken over, an agent is the
person's own session again and gets peer framing from everyone. The other
harnesses keep their existing delivery routes.

The desktop keeps the Codex app-server proxy for each spawned turn and handles
its server-to-client requests. Every command, patch, permission, MCP
elicitation and tool question goes to the owner alone; no other agent, the
requester included, can answer one. Before sending, the desktop checks that
the owner's name still resolves to their immutable agent id. It sends a short
reference and a fixed summary, never raw commands or request parameters that
might contain keys. The owner replies `approve <ref>` or `deny <ref>` in the
DM within five minutes; a single non-secret tool question with choices can
be answered with `choose <ref> <number>`, showing only fixed safe choice
labels. The sender's immutable id is checked again on receipt, and the reply's
delivery record is saved before Codex is answered. The same text from anyone
else is delivered as an ordinary peer message and answers nothing. MCP forms
and device verification, secret or multi-question tool prompts, and tool
choices with unrecognized labels can only be refused over Relay because their
values cannot be safely expressed in a DM. Expired requests, and every request
while no verified owner is signed in, are refused.

Codex 0.163 can unload an idle thread after about 30 minutes. A message to a
spawned Codex resumes its exact, unarchived thread before starting the next
turn. Resume is by thread ID, without new configuration overrides
(`excludeTurns` keeps the reply to metadata); it does not resume ordinary
stopped sessions or start a missing daemon.

## Release scope

The desktop release ships these adapters in the macOS and Linux clients and
the bundled core. The six native-action routes have been exercised; Cloud's
hosted MCP spawn schema remains Codex/Claude-only until a separate Cloud
change. Relaycast's typed CLI enum also needs Muse/Devin entries for API/SDK
clients using it.

## The spawn node

The desktop enrolls one broker-role Relaycast node per workspace
(`POST /v1/nodes` with the workspace key; id and token in
`<app data>/spawn-node.json`, 0600) named `<machine prefix>-desktop`, so it never
collides with a broker node on the same computer. Spawned agents are addressed
`name@<machine prefix>-desktop`.

The node keeps its id for good, because its spawned agents are bound to it.
When Relaycast stops accepting the token, the node rotates it under the same
id with the current token as proof; a node Relaycast deleted is enrolled
again under that id. A rotation refused or unanswered leaves the enrollment
as it is and is tried again after the backoff, with the same
`Idempotency-Key` (kept in `spawn-node.json` until a rotation succeeds), so
a rotation whose answer was lost is replayed instead of refused. The node is
never re-enrolled under a new id to get past a refusal: Relaycast would
refuse the name anyway while the old node holds it, and the agents bound to
the old id would drop out of the inventory while they still run.

When a new id cannot be avoided (the enrollment file lost, or the machine
prefix changed), the node carries this workspace's spawned agents over:
each inventory first rebinds them to the current node, and Relaycast lets a
node claim, through its inventory, an agent whose old node is no longer
live. They keep running and keep their places.

```text
→ node.register   provider broker, capabilities spawn:codex, spawn:claude, spawn:opencode, spawn:grok, spawn:muse, spawn:devin, release (capacity)
→ inventory.sync  on connect and every 60 s: every spawned agent that runs
→ node.heartbeat  every 12 s, handlers_live: true (what makes Cloud offer the node)
← action.invoke spawn:<harness> {name, cli, task, worker_cwd?}
    → write the spawn's intent (spawn-intents.json)
    → agent.register {name, invocation_id}   Relaycast stamps metadata.fleet = {node_id, invocation_id}
    → launch headless; store the registration with its `spawn` origin and token; drop the intent
    → action.result {spawned: true, ready: true, name} (+ warning spawn_task_unconfirmed)
← action.invoke release {name, expected_agent_id}
    → stop Claude's process, archive Codex's thread or end OpenCode's server or Grok's leader, forget the agent
      → action.result {released: true, name}   (release_failed, agent kept, while its end is not confirmed)
← deliver {agent}  → wake that agent's delivery (read and ack over HTTP with its token)
```

Only the harnesses installed here are advertised. A launch that fails takes
the agent back off the node (`agent.deregister`) and answers `spawn_failed: …`.
Relaycast sending an invocation again answers as the first time did.

Terminal failures also have private, immutable `spawn-completions` receipts.
They are written before an ended intent is retired and replay the same redacted
reason after a core restart. Recovery saves and reports an explicit unavailable-
reason failure for older ended intents that have no receipt, rather than silently
forgetting them. A failed launch with a process still running remains cleanup
work; recovery never promotes that failed receipt to a successful agent.

On a broker that advertises `relay:spawn-error-details-v1`, the code and reason
travel as `error` and `error_details.message`. Older brokers receive
`error: "<code>: <redacted reason>"` without unsupported fields. Their invocation
endpoint preserves this string; Cloud reads both forms into hosted spawn status.
Failures also reach the persistent core log without an activity subscriber.
CLI diagnostics include argv, observed exit status and a bounded, redacted output
tail. An exit not yet observed is reported as unknown; Codex app-server thread
creation is RPC and has no per-launch process exit status. Never interpret missing
exit evidence as a successful launch.

Every `action.result` carries an `id` and is kept until Relaycast took it,
across the node's connections and restarts (the ledger holds them, not the
core's disk). Relaycast answers nothing to a result it applied, so one sent
on a live socket and not refused within 25 s counts as taken. It answers an
`error` frame with that `id` to one it could not apply: a passing refusal
(`d1_pressure`, "Node liveness retry pending", under load, or
`action_result_state_changed`) sends the same frame again after a jittered
backoff, `action_result_already_settled` counts as taken, and Relaycast's
other `action_result_*` refusals are final. A result whose socket ended
before Relaycast answered is sent again first on the next connection, for
the same node and within 10 minutes. After 8 sends a result is given up.
None of this reconnects the node. Each refusal is in the activity log, and
an `error` no request waits for is noted once per code every 10 minutes.

A spawned agent is an ordinary registration with a `spawn` origin: listed,
delivered to and removed like any other. It has no direct node of its own
(that would move it off the spawn node), is never auto-activated a second
time, and keeps the name it was spawned with.

Advertisements, places and agent lifecycle: [node-lifecycle.md](node-lifecycle.md).

## Whose computer it is

Agents choose where to spawn through Cloud's `list_relay_spawn_targets` and
`spawn_relay_agent`, which show each node's kind, owner, machine and whether
teammates may spawn there. Cloud refuses every spawn onto a desktop nobody
has claimed, and one onto someone else's desktop unless its owner allows
teammates (a missing `teammates` flag counts as not allowed). So until this
computer's spawn node is claimed, no agent can be spawned on it through Agent
Relay Cloud. The desktop gives Cloud what it needs, with no `agent-relay`
command line:

- **Claim.** Each time the node is about to register (at start, after every
  enrollment and token rotation, and before it advertises anything), at once
  after a sign-in or a workspace change, and every minute after, the core
  makes sure Cloud records the node as the signed-in
  person's: `POST /cloud/api/v1/fleet/nodes/claim` `{workspaceId, nodeToken}`
  with the person's own Cloud session (the route `agent-relay node claim` also
  calls). The node token proves the node, the session proves the person; any
active member of the workspace can claim their own node. The
  credential the request goes out with must be that person's: `GET
  /auth/whoami` first, then the claim, both with the one credential held for
  them, and a credential that is someone else's (an access
  token in the environment, another CLI login) claims nothing and says so. A
  node this person already owns stays theirs (the claim is idempotent). An
  answer that names an owner is kept in `<app data>/spawn-node-claim.json`
  (the token's digest, never the token; in memory too, should the file not
  be writable) so a restart does not ask again. Cloud is asked again only for
  a new token or another account, 15 minutes after it named another owner
  (across restarts too), or after a backoff following a failure: a minute,
  doubling to an hour, and an hour after Cloud's rate limit (429). An answer
  for a node since replaced is dropped. The claim never holds spawning up.
- **Owned by another account.** Cloud refuses the claim (`Another person owns
  this node`). The spawn status shows "This computer's spawn node belongs to
  another account. It takes no spawns until that account, or an owner of your
  workspace, releases it in Agent Relay." The node stays connected for the
  agents it already runs, but advertises no `spawn:<harness>` capability and
  refuses a spawn that still arrives (`spawn_target_unavailable`), until a
  later claim succeeds. This survives a restart.
- **Signed out.** Nothing is asked; the status notes it, and the claim is made
  once the person signs in. A claim made before signing out holds.
- **Other refusals and failures** are asked again after the backoff. The
  core itself never holds a spawn up on the claim; Cloud does.

Turning spawning off keeps the claim. Ownership is about the computer: the
node keeps its id across off and on, a node that is off is no spawn target
anyway, and releasing it would let another account claim this computer's node
in between.

The spawn status carries the claim as `spawn.claim {state, note}`, `state`
one of `pending`, `claimed`, `owned_by_other`, `signed_out`, `failed`.

**Settings → Messages → Spawned agents → Allow teammates to spawn here**
(`spawn_allow_teammates`, off by default) is advertised as `teammates`. Off:
only the node's owner can start agents on this computer. On: workspace owners
and admins can too. Cloud enforces it, and reads a desktop without the flag as
not allowed. Under the toggle, both apps show the claim: "Claimed by you in
Agent Relay Cloud.", "Claimed by another account in Agent Relay Cloud.", or
"Not claimed yet: no agent can be spawned on this computer through Agent
Relay Cloud until it is." followed by the reason (`spawn.claim.note`: signed
out, or Cloud's refusal) when there is one. A failed claim also shows a
**Retry** button (primary style on both apps; `spawn.claim.retry` asks Cloud
at once, whatever the backoff). The status line under **Accept spawns** reads
"Connected to Agent Relay as <node>. No agent can be spawned on this computer
through Agent Relay Cloud until its spawn node is claimed." until it is.

## Where Codex can be spawned

A spawned Codex thread runs on Codex's app-server daemon, which
`codex app-server daemon start` brings up when none runs. That only works for a
Codex that manages its daemon (`~/.codex/packages/app-server-daemon`, as recent
Codex and the Codex app set up), for Codex's standalone install
(`~/.codex/packages/standalone`, from its own installer), or where a daemon was
already set up (`~/.codex/app-server-control/app-server-control.sock`). Codex
0.154 installed only through npm or a version manager (mise, for example) has
none of these: `daemon start` fails with "managed standalone Codex install not
found". The node therefore offers `spawn:codex` only when one of those paths
exists (a file check, so a daemon stopping or starting does not re-register the
node), and a Codex spawn there is refused with `CODEX_NO_DAEMON`, which says to
install Codex with its own installer or open the Codex app.

## Claude's first message

A spawned Claude's first message is on its input (the FIFO) before it
starts, and stream-json has no receipt for input, so the launch reads the
evidence from Claude's own output, `<app data>/spawned-agents/<session>.jsonl`
(`harness::claude::task_taken`). The task counts as taken once that output
holds, for the spawn's own `session_id`, any of:

- `{"type":"system","subtype":"init"}`: Claude Code writes it at the start of
  each turn, after it has read a message, not at launch (a session with two
  turns has two);
- an `assistant` message (text, thinking or a tool call);
- a turn's `result`.

Nothing else is on its input before the spawn is answered (the agent is
delivered to only once its registration is stored), so the first of these
is the first message's. Events Claude may write before reading anything
(hooks, `rate_limit_event`), another session's events, lines that do not
parse and other output are not evidence.

The output is read after Claude publishes its session, until the same
20-second readiness window from the launch ends, or at once when its
process ends or another process has its pid. Seen: the spawn is answered
without a warning. Not seen: `spawn_task_unconfirmed` (`input`). The message
is never written again either way, so there is no duplicate first message.

## Claude's own channel

A spawned Claude's input and output are a channel of its own that outlives the
core (`harness::claude::channel`). Its input is the FIFO it was started on,
`<app data>/spawned-agents/<session>.input` (0600): the shell holding it open
keeps it on disk while Claude runs and removes it when Claude ends. Its output
is `<session>.jsonl` beside it.

- **Native turns.** A message from the verified owner (above) is written as one stream-json `user` line, the text only, never
  framed. Its `uuid` is `MessageRef::native_uuid` of the message's reference,
  which Claude Code keeps as the turn's id in its transcript, so the turn's
  final answer is still found for the automatic reply without a visible
  attribution. It is written only while Claude is idle: its own
  `session_state_changed` events (the launch sets
  `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`), else the last turn event of its
  output, say so, and a turn just written counts as running until its output
  shows it start. A pending permission request also holds turns back. Until
  then the message stays in Relaycast's queue ("Claude is finishing its
  current turn"), and the next pass tries again. A turn written counts as
  started only once Claude echoes that very line (`--replay-user-messages`),
  so a late event of the turn before cannot let a second one through. Its final answer goes back to
  the owner as an automatic reply, as a turn's does for any session that
  cannot reply itself.
- **Permission prompts.** `--permission-prompt-tool stdio` (in both access
  modes) sends what would ask to the core as `control_request` lines on the
  output instead of refusing it: `can_use_tool` (a tool's permission or an
  `AskUserQuestion`), `elicitation` (an MCP server's form or URL) and
  `request_user_dialog`. The core reads the output every half second, gives
  each request a short random reference and a fixed summary, and sends it to
  the signed-in machine owner after checking their name still resolves to
  their immutable id. The answer is written back as a `control_response` line on
  the input. Requests it cannot answer (hooks, SDK MCP servers) are refused at
  once.
- **Who may answer.** Only the verified machine owner, matched by immutable
  id, never the requester or another agent; with no verified owner a request
  goes unsent and expires denied. Only `approve` or `deny` answer a tool; the allowed tool runs with its input unchanged. A single
  `AskUserQuestion` with fixed, harmless labels can be answered with
  `choose <ref> <number>`; free-text questions, forms and dialogs can only be
  denied (cancelled). Summaries never include the command, path, form or
  question, since they may hold a credential.
- **Timeouts and loss.** A request not answered within five minutes is denied
  (a form or dialog cancelled); with no signed-in, claimed owner that is what
  every request comes to. An answer or denial stays due until it is written
  whole: a full pipe is waited on and written again on the next pass, and a
  line begun is finished rather than left half-written. When Claude ends, its input goes with it and
  its references are dropped; a later reply finds nothing. A core that starts
  again reads the output from its start and relays again, under a new
  reference, any request Claude still waits for (one it has not moved on from
  with a result or a new `running`/`idle` state). Answering one an earlier core
  already answered is ignored by Claude.
- **Older spawns.** A Claude spawned before this channel existed has no FIFO
  left on disk. It keeps the peer inbox for everyone, and its permission
  prompts are still refused.
- **Resuming and ended sessions.** A headless `claude -p` on stream-json input
  never unloads an idle session the way Codex's daemon unloads an idle thread:
  it keeps reading its input until that closes, so an idle spawned Claude takes
  the next native turn as it is, and a core that restarts reopens the same
  FIFO. A spawned Claude whose process has ended has finished its work and is
  never started again (`claude --resume` is not used): a message to it is
  acknowledged without being put anywhere, and a direct message's sender is
  told "@name's session has ended, so this message was not delivered."
- **Local trust.** The FIFO is 0600 in the app's data folder, so only the
  person's own account can write to it, as with Claude's peer socket and
  `~/.claude`. A process of that account could write turns or answers to it
  directly; an authenticated keeper process in front of it is not built.

Checked live with Claude Code 2.1.280 on Linux: a `can_use_tool` request for a
Bash command arrives on the output with `--permission-prompt-tool stdio`, waits
for an answer written to the FIFO eight seconds later, and the command runs
with `allow`; without the flag the same command is refused at once. The
`session_state_changed` events read `running`, `requires_action` and `idle`.
The flow is covered by fake-harness tests that start a stream-json fake through
the real launcher and FIFO.

## Reporting back to the requester

A spawned agent's own tools cannot reach the agent that asked for it (Claude's
`SendMessage` reaches only local teammates), and it may have no Agent Relay
MCP tools. So its first message says who asked and how to answer them
(`spawn::report_back`):

```text
[via Agent Relay — spawned as @w1 (w1@mac-desktop) · from @grokbot · ref 0123456789ab]
[report: printf '%s' 'your report' | curl -s --unix-socket '<socket>' 'http://relay/send?to=grokbot' --data-binary @-]
[agents: curl -s --unix-socket '<socket>' http://relay/agents]
@grokbot asked for this work. When you finish, or if you are blocked, send them your result with the report command. …

<task>
```

- The requester is the agent Relaycast recorded as the invocation's caller
  (`caller_name` and `caller_id` on `GET /v1/actions/spawn/invocations/<id>`,
  read with the workspace key while the agent registers, for at most 3 s),
  kept with the spawn's intent and its registration (`spawn.requester`). The
  `action.invoke` frame names no caller, and a name in the spawn's input is
  never used. Without one, the header has no `from` and the lines say how
  to message any agent by name.
  The requester is only told where to report: it stays a peer, with no native
  turns and no say over approvals (see above).
- The commands are the session socket's own (`outbound`, see
  [injectable agents](injectable-agents.md#sending-from-a-session-macos-and-linux)):
  no token or key is in the message; the socket names the agent by the
  process that connects. On macOS a spawned Codex, Grok or OpenCode is
  given the probe's `relay socket-request` instead of curl, as reply hints
  are. While the socket does not serve, or for an OpenCode without full
  access (its permissions refuse shell commands), only the header is sent.
- An agent can run the report command before its spawn has saved its
  registration (the launch is still being confirmed). While any spawn is
  starting, the socket waits up to 30 s for the session's registration
  before refusing it as not on the relay.
- The header's `ref` is the first message's reference. When the requester
  is known and the harness's final answer can be read (Claude, Codex), the
  spawn stores an automatic answer owed to them (`store::Reply`, a DM):
  once the first turn ends, its final reply is sent to the requester from
  the agent. Only those harnesses are told so; the others are told the
  requester receives only what they send. The answer is sent only while the
  requester's name still belongs to the agent that asked
  (`GET /v1/agents/<name>`, read with the workspace key, still has the
  recorded `caller_id` as its `id`):
  Relaycast names can be taken again, so one now held by another agent
  drops the answer, and an unreadable check is tried again later. A spawn
  kept after a restart (`recover`) is owed the same answer. A socket send to
  the requester by name before then claims it, so they never get both.
  Turning **Reply with final answer** off for the agent drops it.

## OpenCode

`spawn:opencode` is `probe/src/relay/harness/opencode.rs`. It drives OpenCode
the way Paseo does, through its HTTP server, and reuses what the managed
OpenCode route already has rather than a launcher of its own.

**Where it is offered.** The `opencode` command line is looked for in
`RELAY_DESKTOP_OPENCODE` (exactly that file), `~/.opencode/bin`,
`~/.local/bin`, `~/.bun/bin`, `/opt/homebrew/bin`, `/usr/local/bin` and then
`PATH`. Its version comes from `opencode --version`, asked once per installed
file (a new install or an update is asked again). Only OpenCode 1 is offered:
the managed route speaks OpenCode 1's server, OpenCode 2 changed that server
(Paseo keeps a second adapter for it), and versions before 1.0 lack parts of
it. Otherwise the node does not advertise `spawn:opencode`, and a spawn is
refused with `spawn_harness_unavailable` and one of these reasons:

- "OpenCode here did not report its version (opencode --version), …" when
  `--version` fails or prints no version, such as an npm install whose
  postinstall script never ran;
- "OpenCode 0.x.y is too old to spawn: …";
- "OpenCode 2.x.y cannot be spawned yet: …".

**Launch.**

1. `opencode serve --hostname 127.0.0.1 --port <free port>` starts in the
   spawn's folder, in a process session of its own (and in a transient
   systemd scope on Linux), with fresh random Basic credentials and a marker
   in its environment only. This is the start probe-managed OpenCode
   sessions use (`relay/opencode_serve.rs`), with output to
   `<app data>/spawned-agents/<spawn id>.log`. Its pid and start time go to
   `<spawn id>.server.json` at once, so a restart before step 3 ends it.
   The server also loads Agent Relay's OpenCode plugin (see
   [Replies](#opencode-replies)) through its own `OPENCODE_CONFIG_CONTENT`.
2. Once the exact process owns the listener, its credentials prove and it
   answers `GET /session/status`, `POST /session` creates the session with
   the spawn's permission rules. That request is sent once per server: one
   whose answer is lost may still have made a session, so the spawn fails
   rather than send it again. An OpenCode that does not keep the rules is
   refused and ended. A server started again on a fresh port (it lost the
   port race) gets a session of its own. The session is read back like a
   managed one (`opencode_existing::inspect_session`).
3. The binding (pid, start, port, credential reference, session, project) is
   sealed in the managed-session registry, marked as spawned
   (`ManagedSessions::adopt`), and the spawn records the session and server.
4. The first message is delivered as any later one is: `prompt_async` under
   a deterministic message id, journalled. A session not ready yet (busy, or
   not answering its status) is asked again for up to 30 seconds, as a later
   message would wait. Seen in the session: confirmed; sent but not seen in
   time: `spawn_task_unconfirmed` (`in_doubt`), never sent again; refused, or
   never ready: the spawn fails and the server is ended.

**Later messages** take the managed OpenCode route
(`LocalInjector::inject_managed`): the binding is proved again (the same
process, listener, credentials from the process's environment, the session's
identity) before each one, a busy session makes the message wait, and the
journal keeps a delivery to at most once. A spawned binding is routed whatever
`AGENT_RELAY_ENABLE_MANAGED_OPENCODE` says, is never a picker row, and cannot
be taken over by a managed launch.

**Permissions.** Nobody answers a spawned agent's prompt, so the session's
permission rules never ask. OpenCode applies the last matching rule, and a
session's rules after the person's configuration, so these decide:

- Full access (on by default): `*` is allowed.
- Off: `*` is refused; `read`, `edit`, `glob`, `grep`, `list`, `todoread`
  and `todowrite` are allowed. Files outside the folder
  (`external_directory`), shell commands, web access, subagents, skills and
  MCP tools are refused, and so are `.env` files (other than
  `.env.example`), which OpenCode itself would ask about.
- In both, the question tool is refused: it waits for the person.

**Watching it.** Alive while the server's exact process (pid and start time)
runs. `GET /session/status` says busy or retrying (working) or idle. Once the
server is gone, OpenCode's database says whether the session's last message
left a turn unfinished: a user message, or an assistant one not completed or
about to run its tools.

**Release** ends the server (SIGTERM to the exact process) and removes the
binding. Each spawned agent has a server of its own, so nothing else is
ended.

**Across restarts.** The server outlives the core (its own process session,
and a scope on Linux). The core finds the agent again by the session and
server the spawn recorded, and delivery re-proves the server from the
registry. Two windows cannot be recovered:

- A restart after the server started but before the session existed: the
  server is ended (its pending record) and the spawn reported ended.
- A restart after the session was recorded but before the first message was
  sent: the agent is kept, idle, without its task, as with Codex. The intent
  does not keep the task's text, so it is not sent again.

<a id="opencode-replies"></a>**Replies.** A spawned OpenCode's shell
commands answer on the relay-send socket as its session, through the managed
route's proof (`opencode::managed::caller`): the shell's session tag
(`AGENT_RELAY_OPENCODE_SESSION`) only selects the binding; the exact server
process, its marker and sealed credential reference, its executable, and an
attestation the plugin writes for that process
(`<runtime>/<pid>.managed.json`, holding the marker's hash) prove it.
OpenCode subagents share the server, so the server's ancestry alone never
names a caller.

The tag and the attestation come from Agent Relay's OpenCode plugin, so every
spawned server loads it (`relay/opencode/managed/spawned.rs`), whether or not the
person installed it in OpenCode's global `plugins/`:

- This build's plugin is written to
  `~/.agentworkforce/desktop/opencode/plugin/agent-relay-spawn.js` (folders
  `0700`, file `0600`, only rewritten when it differs). Its default export is
  also callable, since older OpenCode 1 loaders call every export with the
  plugin's input; it is otherwise the global plugin, at the same version. It
  is named in the
  server's `OPENCODE_CONFIG_CONTENT` as a `file://` plugin. OpenCode merges
  that inline configuration over the person's global and project
  configuration and appends its `plugin` list to theirs, so their own
  configuration, plugins and MCP servers still load. Nothing is written to
  `~/.config/opencode`.
- An `OPENCODE_CONFIG_CONTENT` the person already set is kept, with the
  plugin appended to its `plugin` list. One that is not a JSON object is left
  as it is and the server starts without the plugin; that agent replies
  through MCP only.
- When OpenCode's global `plugins/agent-relay.js` (under the server's own
  `XDG_CONFIG_HOME`) is already this build's plugin, it is not added again.
  Any other copy that loads too still runs once per process: the first copy
  claims it (`claimInstance` in `agent-relay.js`). The file name is distinct
  so OpenCode, which keeps one plugin per file name, never drops a person's
  file for it.
- In a server Agent Relay started (`AGENT_RELAY_MANAGED_SESSION_MARKER` set)
  the plugin only tags shells and writes the attestation; it opens no
  discovery or delivery socket. Turning the OpenCode plugin off in Settings
  removes the global copy only; spawned servers still load theirs.

## Harness adapters

Each harness is one adapter module in `probe/src/relay/harness/` behind the
`HarnessAdapter` trait (`probe/src/relay/harness.rs`), listed once in
`BUILTINS`. An adapter answers:

- its **descriptor**: a stable id (`codex`, `claude`, `grok`) that is the `spawn:<id>`
  capability and the settings key, a label, its full-access wording and
  default, and whether billing may be stated;
- **detect**: installed, not installed, or installed but unusable with a
  reason (`CODEX_NO_DAEMON`);
- an optional **spawn facet** (`SpawnFacet`): launch, find (a spawn a restart
  interrupted), alive, stop and observe, for the sessions it owns, and, for a
  harness whose spawned agents take messages by a route of their own (Grok),
  deliver. Delivery asks the spawner first for a registration with a `spawn`
  origin (`Spawner::deliver_registered`); every other agent, and a spawned one
  whose facet has no route of its own, goes through the session's usual route.
  optionally `handover()` for joining and taking its agents over (see
  [Joining and taking over](#joining-and-taking-over-a-spawned-agent)).

The spawn module stays unaware of harnesses: `RegistrySpawner` implements its
`Spawner` seam and `RegistryObserver` its `Observe` seam by asking the adapter
of the harness, or of the session, at hand. A harness id is an open string
checked against the registry, so `spawn:<id>` for an id this computer does not
know is refused with `spawn_harness_unsupported`, as before.

The core publishes every descriptor in `SpawnStatus.harness_descriptors`, and
both apps draw the per-harness full-access rows, their labels and wording from
it. Per-harness settings are `spawn_harnesses: {<id>: {full_access, billing}}`
in `settings.get` and `settings.set`; Codex and Claude keep their flat keys
(`spawn_full_access_codex`, `spawn_billing_claude`, …) and their store fields
as well, so older apps, agents and cores read them as before.

Adding a harness is one adapter module, one line in `BUILTINS` and its tests;
no shared `match` names harnesses.

## Grok CLI

`spawn:grok` drives xAI's Grok CLI (Grok Build) through a Grok leader and ACP,
the interface Paseo and Grok's IDE clients use (`grok agent stdio`), reusing
the probe's managed Grok route (`existing_session::grok`, `managed_sessions`)
rather than a terminal. Adapter: `probe/src/relay/harness/grok.rs`.

- **Where it is offered.** Grok is found where it installs itself,
  `~/.grok/bin/grok` (`$GROK_HOME/bin/grok`), else on `PATH`. Its version is
  read from the file Grok's installer names (`~/.grok/bin/grok` links to
  `~/.grok/downloads/grok-<version>-<platform>`), never by running it. Grok
  1.0.46, the first version Agent Relay's Grok route was proven against, or
  later is offered. An older Grok is not advertised, and a spawn there is
  refused with `spawn_harness_unavailable: Grok here is version 1.0.24, older
  than 1.0.46, the first that spawned Grok agents run on. Update it with
  `grok update`, then try again.` A Grok whose file name carries no version
  is offered; a launch it cannot do fails with the reason.
- **Launch.** Each spawned Grok gets a leader of its own:
  `grok agent leader --no-exit-on-disconnect --no-auto-update
  --relay-on-demand --leader-socket <socket>`, in the agent's folder, with the
  agents' environment and a random marker
  (`AGENT_RELAY_MANAGED_SESSION_MARKER`) that only that leader's environment
  holds. It keeps running with no client attached, does not replace itself
  with an update while it hosts the agent (a new leader would be a new
  process, and read as the agent's end), and does not connect to grok.com's
  relay. Its socket is `/tmp/agent-relay-managed-<uid>/grok-<id>.sock`, in
  the private (0700) folder the managed Grok route also uses, under `/tmp`
  because Grok's `workspace` sandbox still lets the leader write there. Once
  it listens, a short-lived `grok agent --always-approve
  --leader --leader-socket <socket> stdio` client sends `initialize` and
  `session/new` (`cwd`, `mcpServers: []`, `_meta.yoloMode: true`). The leader
  is then proven as delivery proves it (pid and start time, executable, argv,
  socket inode and peer, and the marker), and the session is recorded in
  `<app data>/spawned-agents/grok/<session id>.json` (0600, in a 0700 folder;
  the marker itself is never written, only a digest bound to it). Only then
  is the task sent, as one `session/prompt`. It counts as handed over once
  the leader's queue holds it in the session; a prompt Grok never showed is
  `spawn_task_unconfirmed` (`in_doubt`), and a refused one fails the spawn
  and ends the leader. The client then goes; the turn runs on in the leader.
- **Later messages.** Through the managed Grok route's ACP transport and
  journal (`<app data>/spawned-agents/grok/journal`): the leader is proven
  again, the session loaded and the message sent as one prompt. A confirmed
  receipt is never sent again, and a send that may have reached Grok stays in
  doubt. A leader that ended, or another process with its pid, takes nothing.
- **Full access.** On (the default): Grok's always-approve mode and no
  sandbox; the leader starts without `GROK_SANDBOX`, so Grok's own
  `[sandbox]` setting, normally off, applies. Off: still always-approve, as
  nobody could answer a prompt, but the leader runs in Grok's `workspace`
  sandbox (`GROK_SANDBOX=workspace`), which Grok enforces in the kernel
  (Seatbelt on macOS, Landlock on Linux): it reads anywhere and writes only
  in its folder, `~/.grok` and temporary folders, as Codex's
  `workspace-write`. Grok runs on without the sandbox where the kernel cannot
  apply it (Linux before 5.13), and where an organisation locks
  always-approve off (`disable_bypass_permissions_mode` in
  `requirements.toml`) a spawned Grok waits on the first tool that would ask.
- **Watching it.** Its leader by pid and start time, and the turn events Grok
  appends to the session's `events.jsonl`
  (`<grok home>/sessions/<folder>/<session id>/`): `turn_ended` last is idle,
  a permission asked and not yet answered is waiting, any other turn event is
  working. A leader that ended is the agent's end: completed when its last
  turn had ended, unknown when one was running.
- **Restarts.** The spawn's intent records the leader as soon as it starts,
  under the spawn's own session id, then the Grok session once it exists. A
  restart after that finds the agent by its record and keeps it; a restart in
  between ends the leader, which nothing could reach.
- **Release.** `SIGTERM` to the leader, only while it is still the process
  the record names; a second release does nothing more.
- **Replies.** A spawned Grok's tools can answer on the relay-send socket.
  Its session claim is accepted only under the exact recorded leader, proved
  through the kernel's process, executable, socket and private launch marker.
  Replies use the probe client where the OS hides a shell's environment; an
  inherited Codex tag never overrides the nearer Grok leader.
- **Limits.** A Grok whose own configuration sets a sandbox
  profile refuses leader mode for every client, so that profile must be off.
  The behaviour above (ACP `yoloMode`, the `workspace` sandbox for a leader,
  `events.jsonl`) is Grok 1.0.46's, as its documentation and session files
  show it; this spawn path was tested with fakes only, not against a live
  Grok.

## Joining and taking over a spawned agent

Opening a spawned agent in either app never starts a second process on its
session.

**Join.** A spawned agent's session opens in the app's transcript view, with
**Join** in its details on the agents page. While Agent Relay runs it, the
transcript is followed live (read again every 3 s for what was written since)
and a message box under it sends into the running agent through the relay
(`messages.send` to its address), the way any message to it is delivered.

- A spawned Claude's transcript is its own stream-json output
  (`agents.transcript`, read from `<app data>/spawned-agents/<session>.jsonl`
  by byte offset; `follow_cursor` is where the next read starts). It runs with
  `--replay-user-messages`, so what it is asked is in that output too.
- A spawned Codex thread's transcript is its session's (`sessions.transcript`).
  A read from a cursor that reaches the end of what the reader's cache holds
  refreshes the cache from the session's file and reads again, so following
  keeps showing new output however many pages the transcript spans.

**Take over (Claude).** **Take over in Terminal**, or **Take over in Claude**
on a Mac where Claude Desktop is preferred and installed, hands the session to
the person (`agents.take_over`):

1. The app asks first. Mid-turn it offers **Take Over After This Turn**: the
   core waits (up to 10 minutes) for the turn to end, and **Interrupt Now**,
   confirmed, stops it at once.
2. The core marks the agent taken over (`spawn.takenOverAt`), stops the
   headless process and waits until it is gone. If it does not stop, nothing
   is handed over.
3. The app then runs `claude --resume <id>` in the session's folder
   (`claude --desktop --resume` for Claude Desktop). `--resume` continues the
   session under the same id.

The agent keeps its name, address and place on the spawn node. Its process
is then whichever one Claude Code's registry lists for the session: each
observation pass follows the session to the client the person resumed it in,
so delivery reaches it. While nothing runs it (the client is still opening)
the agent shows as unknown, not ended, for 2 minutes. Releasing the agent
leaves the person's client running. `sessions.list` reports all this on the
registration as `spawn: {harness, can_take_over, taken_over}`; once taken
over, the session opens like any other.

**Codex.** A spawned Codex thread lives in the shared app server, so
**Open in Codex** (`codex://threads/<id>`) shows it live in the Codex app.
Terminal resume is never offered for it while Agent Relay hosts it, whatever
the opening preference; without the Codex app, the button says to install it.
A spawned Codex cannot be taken over (`agents.take_over` refuses).

**Others.** A spawned agent with no app to open it live and no take over
(Grok, OpenCode, Muse, Devin) has no open action while Agent Relay runs it:
it is joined only, never resumed in Terminal beside the process that runs it,
and the sidebar says so ("Agent Relay runs this session. Follow it and message
it here; it is not resumed in Terminal while Agent Relay runs it.").

Adapters opt in through the spawn facet's `handover()` (`HandoverFacet`:
`transcript` and `session`); without one, an agent's sessions open live in
its own app where it has one, and are otherwise only joined.

## Permissions

A headless Codex or Claude agent can ask remotely during a turn. **Codex: full access** and
**Claude: skip permission prompts**, on by default as with the broker, run
spawned agents with `sandbox: danger-full-access` and
`--dangerously-skip-permissions`. Turned off, Codex runs in its
`workspace-write` sandbox and Claude with `--permission-mode acceptEdits`;
Codex uses `approvalPolicy: on-request`, and Claude sends what would ask over
its own channel ([above](#claudes-own-channel)); with full access on, Claude
skips its permission prompts, and whatever still asks comes the same way. **OpenCode: full access** is the
same choice for OpenCode; see [OpenCode](#opencode) for its permission rules.
**Grok: full access**, also on by
default, runs Grok always-approving and without a sandbox; turned off, Grok
still never asks but runs in its `workspace` sandbox ([Grok CLI](#grok-cli)).

## The person's own MCP servers and credentials

For now a spawned agent gets the person's own MCP servers and connectors, and
with them whatever credentials their configuration carries, as the broker's
workers in `../relay` do:

- Claude is started without `--strict-mcp-config`, so it loads the person's
  user-level and project servers and their claude.ai connectors.
- Codex runs its thread on the person's own app-server with their own
  configuration, so the thread gets the same MCP servers as their own Codex
  sessions.
- OpenCode's server loads the person's global and project `opencode.json`,
  MCP servers included; only the session's permission rules are the spawn's.
- Grok's session is opened with no servers of Agent Relay's own
  (`mcpServers: []`), so Grok loads the ones the person configured
  (`grok mcp`, their config and trusted plugins), as for their own sessions.

Keeping spawned agents from those servers was investigated first and is not
used. Claude can be isolated with `--strict-mcp-config`. Codex cannot yet be
shown to stay away from them. Tested on Codex 0.159 with a real
`codex app-server`, an isolated `CODEX_HOME` and a dummy MCP server that
records requests (synthetic bearer headers only):

- `mcpServerStatus/list` without a thread connects to every configured server
  with its headers (3 requests), so it cannot be used to learn their names.
- `config/read` connects to nothing but returns the headers' values, and omits
  servers from the project's own `.codex/config.toml`.
- Turning the named servers off per thread (`thread/start` `config:
  {mcp_servers: {<name>: {enabled: false}}}`) works for those names, but a
  project-layer server still connects at thread start (6 requests), even with
  an isolated home that trusts no project.

The per-thread isolation and its pre-turn check (`app_server::start_thread`
with `McpIsolation`) stay in the code, tested but unused, for when spawned
agents should be isolated again.

## Working-folder access and Bun startup errors on macOS

Before registering or launching an agent, the core checks that its working
folder exists and can be read, including the first directory entry. Merely
checking `is_dir()` is insufficient: macOS privacy controls and Unix directory
permissions can allow metadata access while refusing directory reads. The check
runs on a blocking worker, with a ten-second response deadline, so an unavailable
drive or a stalled macOS privacy approval does not block the node's async runtime.
A timed-out worker may finish later, but cannot register or launch anything.
At most four checks can occupy blocking workers, and a timed-out check keeps
its slot until its filesystem call finishes; retries cannot fill the pool.

An access denial returns `spawn_invalid_input` with the working folder and the
OS error. On macOS it directs the person to **System Settings → Privacy & Security
→ Files and Folders** to allow Agent Relay access; on Linux it asks for read and
search permission for the account running Agent Relay. This is shared core
behavior in both desktop apps. No privacy grants are changed by the core.

Evidence from the October 17, 2026 installed macOS test build (v2026.10.47 plus
#534 and #499):

- Failed Claude session `db8db644-2551-466d-b751-f8593bf73cd3` recorded only Bun's
  `Unexpected` error and a current descriptor limit of 256. Its saved process
  identity was PID 85938; Grok's was PID 86048.
- The macOS kernel log at 15:16:06–11 UTC recorded approval-watchdog expirations
  for `kTCCServiceSystemPolicyRemovableVolumes` for those exact child PIDs. Core
  PID 84374 and collector PID 61692 also had repeated expirations. This is evidence
  of external-volume privacy approval failing, not a successful descriptor-quota
  diagnosis. The OpenCode log was empty, so it supplies no independent error detail.
- Read-only `lsof` inspection of the core found about 38 open descriptors, with
  the highest observed descriptor 54. The native-spawn branch's Claude shell/FIFO
  sequence and `setsid` setup were unchanged on main.
- Controlled launches of Claude 2.1.301, OpenCode 1.18.30 and Grok 1.0.46 succeeded
  with soft `RLIMIT_NOFILE=256`, a minimal launchd-style environment and a new
  process session. OpenCode's server and Grok's leader remained running until the
  test stopped them. Those checks did not use or restart the installed core.
- Denying `file-read*` for a scratch working folder with macOS `sandbox-exec`
  reproduced the exact Bun message in both Claude and OpenCode. Raising only the
  soft limit to 61,440 (this Mac's `kern.maxfilesperproc`) still exited with status
  1; it changed the text to generic `Unexpected` rather than fixing startup.

Bun's [upstream report on this diagnostic](https://github.com/oven-sh/bun/issues/40625)
explains the heuristic: some generic startup errors mention descriptor limits
without establishing descriptor exhaustion. Do not diagnose this message by its
limit number alone. Correlate the saved child PID and launch time with macOS
privacy logs, and compare an allowed working folder with the failing one.
Increasing `RLIMIT_NOFILE` does not grant folder access. Successful launches from
the installed app still require its macOS privacy approval to work; a terminal's
access does not establish that a launchd job has access.

## Lifetime

Spawned agents outlive the core, so updating or restarting it leaves them
running; the core finds them again from its store (pid and start time for
Claude and for Grok's leader, the thread for Codex) and lists them in its next
inventory.

- Codex threads live in Codex's own app-server daemon.
- A spawned Claude, and a spawned OpenCode's server or Grok's leader, run in a process
  session of their own, out of the core's launchd process group on macOS.
- On Linux under a systemd user manager everything the core starts would be
  in `agent-relay.service`'s cgroup, which a restart ends however it was
  detached. So a spawned Claude, a spawned OpenCode's server or Grok's leader, and a Codex
  daemon the core has to start, each run in a transient scope (`systemd-run --user --scope`,
  `agent-relay-spawn-<id>.scope`) outside it. Where no user manager runs, or
  it refuses the scope, they start as before.

A spawn in flight when the core stops is not lost. Registering the agent and
launching it take up to about half a minute before the registration is
stored, so each spawn first writes its intent to
`<app data>/spawn-intents.json` (0600: it holds the agent's token) and adds
to it as it learns: the agent id and token once Relaycast registered it, the
Claude session id chosen before launch, the Codex first-turn message id
(`spawn-<invocation>`), and the session and process as soon as the launch
starts them. The intent is dropped once the registration is stored or the
spawn has cleaned up after a failure. When the node connects, before its
first inventory, the core settles every intent left by a core that stopped:

- Never registered on Relaycast: nothing was launched; the intent is dropped.
- `agent.register` sent but never answered (the answer late or unreadable,
  or the spawn cancelled): Relaycast is asked for the agent by name
  (`GET /v1/agents/{name}`), and one stamped with the same invocation
  (`metadata.fleet.invocation_id`) is taken off the node (`agent.deregister`)
  as below. When Relaycast first holds none, it is asked once more after
  30 s, as a write it admitted can land after the connection closed. Any
  other agent of that name is left alone and the intent dropped; if Relaycast cannot be asked, the next connection asks again.
  Registering again cannot find it: Relaycast refuses a name already taken.
  A spawn whose register is not answered within 10 s keeps waiting up to
  30 s more, as Relaycast's node answers late under database pressure: an
  answer in that time launches the agent as usual, and a late `d1_pressure`
  refusal is sent again like one in time. A connection that closes ends its
  waits at once. A spawn that stops waiting while the core runs does the
  same as recovery once it has given its place back, after waiting 30 s
  more for the answer; recovery
  leaves the attempt to it meanwhile, and an agent found after the intent
  went is recorded again, ended, and still taken off. One whose
  invocation started again meanwhile is left to that retry: the retry's own
  intent, and an agent it saved, are never changed or taken off. A retry of
  the invocation whose register is refused because that agent holds the name
  takes it off the node and registers again, once.
- The agent is found still running (Claude by the process it started or the
  session it published; Codex by its thread, which the launch records as
  soon as Codex creates it, else by the first turn's message id among the
  threads created since the spawn began): it is kept, stored as the spawn
  would have stored it, on the node's connection like any spawned agent, and
  listed in the inventory. Activity: "Agent Relay kept @name, which it
  spawned before it restarted."
- Otherwise, or with spawns now off: whatever was found running is stopped
  (Claude's process ended, Codex's thread archived) and the agent is taken
  off the node (`agent.deregister`). Activity: "Agent Relay ended @name: it
  restarted while spawning it." The intent stays, marked ended, until
  Relaycast confirms the deregistration, so one lost with the connection or
  refused is sent again on the next; the agent is not stopped or reported
  twice.

Only a Codex thread created in the instant between Codex answering
`thread/start` and the core recording it, with no first turn yet, cannot be
found; it stays loaded, idle, until archived in Codex.

Draining or blue-green updates, and handing a running agent's ownership to a
new core, are not designed yet.

## Not yet

- Visible launch modes (the Codex app, a terminal window) and a per-harness
  choice between them.


## Optional spawn capacity

Desktop spawns have no agent-count limit by default. In Settings, **Max spawned
agents** is an optional cap (1–32); leave it empty for **No limit**. The old
default of 12 existed only when the stored setting was absent. Absent settings
now mean unlimited, while explicitly stored values—including 12—are preserved.
`settings.set` with `spawn_max_agents: 0` clears a cap. Save with **Save** or Enter; leaving the field or refreshing Settings does not apply an unfinished edit. Failed saves show the error and restore the confirmed cap.

The wire and node read API retain Relaycast's documented `max_agents: 0`
unlimited sentinel. Null is not accepted by existing Relaycast schemas, integer
storage, or SDKs, so this change does not introduce a nullable wire field or a
migration. Finite integers still enforce the cap atomically against active plus
reserved agents. Unlimited nodes still count active and reserved agents, but
never refuse a spawn because of those counts. Other admission checks still apply.
Live metadata reports `slots.free: null` for unlimited, and Cloud returns
`available_slots: null`. Slot utilization is unknown without a finite cap;
desktop reports `load: null, load_reported: false` and continues advertising
machine resource measurements. Placement uses measured load, not an invented
infinite number of free slots.

Ship Relaycast's measured-load support first, Cloud's placement changes second,
and the desktop default last. Existing integer-cap nodes work throughout;
no database migration is needed.
