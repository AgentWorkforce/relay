# Workspace layout

The shared core's `probe/src/relay/diagnostics.rs` retains explicit,
credential-redacted diagnostics in rotating `core.log` files. macOS uses
`~/Library/Logs/Agent Relay` (or `Agent Relay Dev`); Linux and Windows use
the resolved app data directory's `logs` folder. Rotation happens during
operation at 1 MiB with three backups; stderr remains available to terminal
and systemd journal consumers. Raw child stdio and request/message bodies
are not captured.

Existing Pi sessions appear in the session table after loading the bundled
extension with `/reload`. Enable **Receives messages** to register one. Messages
wait for Pi to be idle, and completed final answers return through Relay on
both platforms. See [Pi delivery](pi-existing-session-injection.md).

Pi queues preserve arrival order while busy, and channel batch answers reply to
the last post. A failed extension installation remains visible in status details
and Settings → Relay on both platforms; fix the conflict or permissions and
restart Agent Relay to retry, then run `/reload` in Pi.

Spawn recovery and startup diagnostics run in the shared core on both platforms.
Known spawn origins survive legacy store merges; Codex origins omitted by an old
writer can be restored from matching local receipts and Relaycast identity.
Failed launches report structured, redacted harness reasons and retire ended
intents after acknowledged cleanup. OpenCode warns when model startup remains
unverified; Grok reports clearly missing default credentials as unavailable.

Replicas spawning is an agent operation through Cloud, like Capy. The shared
core exposes environment listing, durable spawn/status, and release methods
([contract](relay-core.md)); both desktop clients receive the same cloud roster.
There are no new session-table controls. The existing local
[operator bridge](../integrations/replicas/README.md) can remain during migration.

Cursor Cloud is also an agent operation through Cloud, not a local spawn
target and not the discontinued `cursor-agent` CLI integration. The shared core
exposes model and agent listing, idempotent launch, status and results,
follow-up injection, and reversible archive/unarchive methods. Agent Relay
Cloud keeps the per-user Cursor key, registers the hosted session with
`session_kind: cursor-cloud`, and translates Relay DMs into Cursor's native
steer-or-queue follow-up. Both apps show the Cursor mark and **Cursor Cloud**
wording for those remote roster rows; neither app adds a platform-only form.
See [Cursor Cloud agents](cursor-cloud.md).

Spawned-agent settings render the core's harness descriptors on both platforms.
Muse appears when its trusted CLI is available, with its sandbox on by default
and the same full-access wording on macOS and Linux.
The shared core records Muse's detached host before launching its child so a
restart during startup can recover or stop the exact owned process group.
Muse sessions started outside Agent Relay are not listed or messaged.

Native Codex spawns remain messageable after Codex unloads an idle thread:
the shared core resumes the registered, unarchived thread before starting
the follow-up turn. Ordinary stopped sessions still wait for their host.

Spawned Muse and Devin expose a per-launch MCP tool for Relay messages. It uses
the authenticated local session socket and accepts only the recipient, message
text, and optional reply parent. Shell sandboxing stays enabled by default;
Relay replies do not require granting shell access to the socket.

The macOS, Linux and Windows windows open directly to the session list on this computer.
One 64-point header contains the 24-point Agent Relay mark and 19-point canonical wordmark, **Search or filter sessions…**, the icon-only **Table display** control,
and the signed-in person's avatar menu. The
avatar menu contains **Settings…**, **Log out…**, and **Update available** when
applicable. Open Settings with **⌘,** on macOS or **Ctrl+,** on Linux and Windows. The logo returns to Sessions. There is no persistent navigation rail.
Native window controls and dragging remain platform-owned.

| Region | Contents |
| --- | --- |
| Global header | Sessions logo, search, Table display icon, avatar menu |
| Table | Session (including Active indicator), Project, Updated, Receives messages, Upload (status icon and switch) |
| Status bar | Upload state, local session count, update download button when available, pause/resume, and **Live Agents on Relay: N** |

Selecting **Live Agents on Relay** opens Sessions with `is:active is:on-relay`, replacing
previous search filters and returning from any open transcript.

When Capy is detected (`/Applications/Capy.app` or `~/Applications/Capy.app`
on macOS, or the `~/.capy` directory Capy's device connector creates on a
paired computer on either platform), a **Capy detected** card sits above the
session table: "Put your Capy threads on Agent Relay so other agents can
message them and their conversations appear in Sessions. Capy asks you to
approve the Agent Relay plugin once." **Set up in Capy** copies a prompt that
links Capy to the `setting-up-capy-on-agent-relay` skill, which has Capy
propose the Agent Relay plugin and run the setup, opens
https://capy.ai, and shows **Prompt copied. Paste it into a Capy thread.**
**Not now** hides the card for good (`capySetupDismissed` in UserDefaults on
macOS and `desktop.json` on Linux). Detection runs at launch.

When the core reports Devin's hooks off (`devin_direct_delivery` false: Devin
has run here and Agent Relay's hooks are not in
`~/.config/devin/config.json`), a **Devin found** card sits above the session
table on both apps: "Put the Devin sessions you open on the relay, so they
appear here and can be messaged, the way Claude Code and Codex sessions are?
This adds Agent Relay's hooks to ~/.config/devin/config.json." **Turn On**
sends `settings.set` with `devin_direct_delivery: true`; the core's error, if
any, shows under the card, which goes once the hooks are on. **Not now** hides
it for good (`devinSetupDismissed` in UserDefaults on macOS and `desktop.json`
on Linux); the Settings row still turns the hooks on later. The core never
adds the hooks on its own.

The single 64-point header and table share 24-point horizontal gutters.
The search panel's **Messages** section offers **Receives messages** and
**Does not receive messages**. These mutually exclusive choices add readable
chips to the search bar; removing the chip includes both message states again. They match
confirmed local registrations (including offline sessions) or their absence,
independently of activity, and combine with all other filters without changing
grouping or sorting. There are no separate session navigation tabs. Other computers
and teammates remain available in Cloud. Search is hidden in Settings and while
reading a transcript. Settings has a contextual 244-point sidebar. **Back to sessions** sits in the
global header immediately after the wordmark, in the same position as on a transcript.

Group by offers None (default), Harness, Project, Status, and Week. Week groups
start on Monday in UTC, matching Cloud. Status means the actual upload state;
the desktop does not infer Cloud's work-completion status from process liveness.
Search matches local titles, projects, paths, harnesses, IDs, and relay names,
including the earlier name of a renamed agent: `agent:` finds it by either.
A partial or exact agent name or address finds its session; a term written
`@reviewer` searches agent names and addresses only.
Project uses the Git repository name when local metadata is available, so
linked worktrees and nested directories stay grouped with their repository.
Broker controller directories under the configured relay home are
infrastructure, not projects, and display **—**; unrelated directories keep
their folder name as a fallback.
The shared core resolves project metadata off the async runtime, with at most
four dedicated filesystem workers. Local session lists, upload history and
previews share a 32,768-directory FIFO cache with a five-minute TTL, including
missing names and timed-out lookups. Each lookup has a 250 ms deadline covering
both worker admission and all filesystem operations (including canonicalization
and Git marker checks); lists resolve concurrently rather than paying that
budget for every row. A deadline returns the folder name without filesystem
access. Hung reads keep their worker slot until they actually return, so repeated
refreshes cannot exhaust async workers or create unbounded blocking threads.
Late results cannot replace the cached fallback, and dedicated workers do not
hold up runtime shutdown. Both desktop clients use this same core behavior.
Session labels prefer RelayHistory's harness-provided catalog title, with the
existing prompt-based fallback when no title is available, on both platforms.

Title editing lives only in the open session's transcript header on macOS,
Linux and Windows. The sessions table shows clickable titles without rename
controls or title-preload requests. A quiet, always-visible **Rename** button
with an edit icon makes the header title editable in place. The text keeps its
font, alignment and height; there is no input border or background box.

Enter or **Done** saves; Escape or **Cancel editing** discards the draft.
Moving focus outside the whole editor saves after a short debounce, so moving
between the text and its controls does not submit prematurely. Returning focus,
cancelling, submitting or leaving the session retires that pending save.
Unchanged titles do not issue a write, and typing makes no network requests.

The sparkle button, **Use generated title**, fills the draft with the saved
pipeline title and returns focus to the text. Opening a session preloads its
existing summary, cached by harness and session identity with bounded reads.
Preloading and using the suggestion never request a new generation. The sparkle
appears while editing once a saved title is available; applying the suggestion
does not save it until the person commits or leaves the editor.

The shared core reports native support through `sessions.title.capability`;
`sessions.title.set` changes the original harness title only where a supported
route is available. An unavailable Rename button explains the harness or session
limitation in its tooltip. There is no fallback label stored only in Relay.
Saves update the displayed title optimistically. A failure rolls back the title,
shows a warning with the full error in its tooltip, and reopens the rejected
draft for correction and retry.
Interrupted requests are retired on reconnect, and account changes clear cached
suggestions and pending edits. Confirmed titles remain visible while discovery
catches up, for at most one minute before refreshing authoritative state, so
later title changes in the harness are not hidden indefinitely. A title change
does not rename the session's Relay messaging address.

Running agents and historical sessions share one table. **Filters → Activity →
Active** adds `is:active` to search; no separate cards duplicate the same sessions.
All filters apply together to the whole list. Active means local discovery reports
`live`, independent of upload selection or relay registration. Inactive means no
live local process was discovered; it does not imply the work was completed.

Search accepts free text, `title: Foo`, `title:"Fix login"`, `project:cloud`,
`harness:codex` (or `source:`), `path:`, `id:`, and `agent:`. Combine qualifiers
with spaces (AND), quote phrases, and prefix a term with `-` to exclude it.
`is:active`, `is:inactive`, `is:on-relay`, and `is:off-relay` filter activity/registration;
`upload:uploaded`, `upload:local`, `upload:in-progress`, and `upload:discovering` filter
upload state. Specific upload states such as `paused` and `queued` also work.

Dates refer to the session's Updated time in UTC. `updated:2026-10-11` covers
that whole day; `updated:>=2026-10-01` and `<`, `>`, `<=` comparisons work too.
`updated:2026-10-01..2026-10-11` includes both days; either end can be `*` or
empty. `after:` and `before:` exclude the named day. Invalid dates show a syntax
hint. The menu offers Today, Last 7 days, and Last 30 days, and edits the visible
query so constraints stay inspectable. Clear removes the whole query. The help
popover documents the syntax. Search covers loaded history; older sessions load automatically as you approach
the end of the list, including when filters leave the viewport underfilled.
Sessions stay current through core events and background polling; there is no
manual refresh or pagination control. Both platforms keep Filters open while you combine
choices; Done, Escape, or clicking outside dismisses it. Background refreshes
preserve the open menu and focused control. Group by closes after a selection.
Shared fixtures exercise both search matching and how menu choices edit the
query, including replacing source aliases and clearing date constraints.

History (`uploader.sessions.list`) joins local relay discovery (`sessions.list`)
by the core's upload key. A session appears once when both lists contain it.
The key is the harness and the session's own id (`codex:…`, `claude:…`,
`grok:…`, `opencode:…`, `muse:…`, `devin:…`), so a running Codex, Claude Code,
Grok, OpenCode, Muse or Devin session on the relay is the same row as its
transcript, and its transcript shows its real messaging state. Claude app,
OpenClaw, Hermes and Pi relay rows have no key and are listed on their own.
Discovered sessions awaiting upload indexing remain visible, labeled Indexing.
Ended registrations remain visible so they can be taken off the relay. No roster
or fleet records enter this table. Multi-machine and workspace browsing is
available in Cloud at `/cloud/dashboard/sessions`.

The table lists top-level sessions. Grok sessions explicitly marked as
subagents stay in local history but do not appear as separate rows, even when
Grok has not recorded their parent. The shared core applies this rule on both
macOS and Linux, including after refreshing previously cached sessions.
An independently selected Grok subagent is removed from the selection before
uploads resume after upgrading; a child with a recorded parent still shares
through that parent.

Two history layouts arrive with RelayHistory 0.45.0 on both apps. Grok Bot
(the Anysphere desktop app, distinct from the Grok CLI) is a `grok-bot` source:
each bot is one session read from the app's local transcript store, which keeps
roughly the last 200 entries or 7 days per bot, so only that tail is recovered.
A Codex thread whose rollout file Codex has pruned is recovered from Codex's own
SQLite history and keeps its replies, commands and file changes; its catalog row,
not a transcript file, says when it changed, so selected mode follows it the way
it follows a session in a shared database.

RelayHistory adds OpenClaw (an `openclaw` source) on both apps: each
OpenClaw agent's sessions (its main chat, Telegram and other channel chats,
Agent Relay conversations, cron and subagent runs) are read from under
`~/.openclaw` (or `OPENCLAW_STATE_DIR`), and follow the session-sharing mode
like every other source. RelayHistory 0.47.0 reads every OpenClaw from 2026.3:
the agent's `openclaw-agent.sqlite` from 2026.8.1, and the `sessions/*.jsonl`
transcripts with `sessions.json` before that. A session OpenClaw has imported
from its JSONL store into the database is read once. From RelayHistory 0.49.0
an OpenClaw session is one conversation key, as OpenClaw's own session list
shows it: every reset and every isolated cron or heartbeat run of that key is
part of it (one row per cron job, not one per run), and heartbeat polls are
not prompts. Session IDs from the agent database are `<agent>:<key>` (for
example `main:main`, `main:cron:<job>`).

RelayHistory 0.48.0 adds two sources on both apps, which follow the
session-sharing mode like every other source. Antigravity (an `antigravity`
source) reads each conversation under the App, CLI and IDE brain directories
(`~/.gemini/antigravity/brain`, `~/.gemini/antigravity-cli/brain`,
`~/.gemini/antigravity-ide/brain`), preferring a conversation's full transcript
over its truncated compact file; user and assistant text become messages and
every native step is kept as a marker (it records no tool-call IDs, model or
usage). Oh My Pi (an `omp` source) reads its sessions under
`~/.omp/agent/sessions` (or its profile and XDG data directories), with
messages, tool calls and results and observed usage; a session in a directory
Pi and Oh My Pi share is read once.

Each row has a **Receives messages** orb and a read-only **Upload** status.
Select rows with the left checkboxes to reveal bulk actions above the table.
The orb is gray when off/offline, yellow while registering or connecting, and
green only once the session is running and its push channel is live. Clicking
it opts into receiving messages or immediately shows offline while unregistering;
connecting can be cancelled. Hover and accessibility labels explain the state,
action, or why a session cannot receive messages. Receiving messages also enables
transcript upload under the core's existing policy, for every session with an
upload key.
Registered Grok CLI sessions join their local transcript and use Grok's title.

Bulk upload requests update optimistically per session and keep other rows usable.
Repeated clicks are serialized per session and settle on the latest choice;
different sessions proceed independently. Failed changes roll back only the
affected row and show its error. Listings from before a selection change are
ignored and refreshed. Signing out discards pending UI state and late replies.
Deleting cloud copies requires confirmation and stops future uploads while preserving local history.

Every other control that changes the core follows the same pattern, on both
platforms: the intent is recorded in a pending slot before the call, the view
renders from it, the core's answer (or the status read after it) replaces it,
and a failure reverts to what the core reports and shows the existing per-row
error. A newer request supersedes an older one (the last click wins), so an
older answer changes nothing. This covers the upload policy (the chosen row
moves and stays usable, with a small spinner), pause and resume, retry and
compact (the stage reads *Retrying uploads…* / *Compacting the upload
journal…*), core settings switches (the shown settings are the confirmed ones
with pending changes written over them), renaming an agent and registering a
session under a name (a provisional registration without an address), sending a
message (an echo under *You* with the caption *Sending…* until the history lists
it; the box clears at once and is restored on failure), Incoming and Claude
delivery changes, launch at login, fleet release (*Released* until the next
listing) and, on macOS, contractor seat dismissal and grant revocation. Sign-in
and log-out carry a starting and a disconnecting state on both platforms.

Before sign-in the window is the split welcome: a dark panel with the Agent Relay
logo and wordmark vertically centered above the Codex, Claude, Cursor, OpenCode,
Grok, Muse, and Devin logos (Muse in blue), and a light sign-in panel with **Get your agents on the relay** followed by **Sign in with Google**.
During startup, **Rounding up your agents** stays on one line beside compact pulsing bars at the content's right edge.
The subtitle rotates every four seconds (unless reduced motion is enabled),
starting with a randomly chosen message. Sign-in appears as soon as
the service supplies its status; session discovery runs in the background.
After 20 seconds without a ready service, the panel offers **Try again** and
**Copy diagnostics** instead of continuing the animation.
Claude Code direct-delivery preferences live in Settings; the sign-in panel has
no checkbox or configuration text. First-run defaults preserve existing user
choices and managed settings.
Signing in shares nothing by itself: the install starts in **Only sessions I
choose**, so a session uploads once its Upload switch is turned on, and keeps
uploading as it changes. Automatic uploads of new sessions, or of all past and
future ones, are chosen in Settings › Session sharing.

## Settings

Settings is grouped by task: Preferences (General, including Appearance), Sessions
(Opening sessions, Session sharing, Messages), and Account & app
(Account, Updates, Diagnostics). Account contains only profile and
workspace details; log files and expandable diagnostic reports live in Diagnostics. Session deletion lives below the sharing policy and upload details.
Update availability uses a compact sidebar dot; the update action uses an explicit
white-on-deep-blue foreground/background pair. Settings use a 720-point reading
column, wrapping descriptions, reserved action widths, and quiet outline icons.
The avatar carries a small update indicator; the menu links directly to Updates.
Detailed upload stages and journal compaction live under **Session sharing →
Upload details**, keeping the startup view focused on session selection. When a
problem that is not retried on its own stops uploads, session rows read **Upload
stopped** (not **Waiting to retry**) and the upload stage offers **Retry uploads**.

General › Startup holds **Open at login** and **Keep agents connected after
quitting**. The second is on by default: quitting leaves the background service
delivering messages and running uploads, and the Mac's Quit control reads
"Quit Agent Relay (agents stay connected)". Turned off, quitting stops the
service until the app opens again, and Open at login reads "Your agents connect
when it opens." On Linux, turning it off while the systemd unit runs first asks
**Turn off the background service?** and turns the unit off.

Relay settings retain workspace connection, Claude Code direct delivery, Grok
leader mode, OpenCode plugin configuration, **OpenClaw agents**
(`openclaw_gateway`; with an OpenClaw older than 2026.8.1, which cannot limit
relay sessions, the row says so: `openclaw_unlimited_version`), **Agent Relay
tools** under it while it is on (Connect signs OpenClaw in to the hosted Agent
Relay MCP in the browser, with **Open Again** while it waits;
`openclaw.relay_tools.*`), **Trusted senders** (`trusted_relay_senders`:
relay names or addresses whose messages reach the person's own OpenClaw and
Hermes), and **Hermes** (`hermes_agent`), both on wherever the
agent is set up and listed only while its local gateway answers
([openclaw-hermes-delivery.md](openclaw-hermes-delivery.md)), the Devin lifecycle hooks,
**Show me relay messages in full** (`show_relay_messages`, off by
default: relay messages are hidden from Codex app chats; a terminal Codex or
Claude Code session, which only accepts visible text, shows a two-line pointer
naming the sender and the command the agent runs to read the message; the
agent still gets each message in full and can reply: the setting only
changes what the person sees), **New agents join
#general** (`auto_join_general`, off by default; applies to agents registered
from then on), **Changed by agents** (shown once an agent has changed a
setting through `PATCH /settings`: the latest five, newest first, each with
the agent, the setting, its values before and after, and the time), and
incoming-message settings. With a signed-in Devin CLI the session inventory
additionally polls the org's Devin cloud sessions via the `devin-cloud`
connector (cadence-gated, five minutes) so remote sessions list beside local
ones; a connector failure surfaces as a diagnostic and never fails local
discovery. Those cloud sessions also appear in the sessions table, hosted
by *Devin Cloud*, and one auto-activates like a local session while the
sign-in resolves — a message to it is posted into the session through the
same connector's send route.
Claude Code cloud sessions on claude.ai are listed and uploaded the same way
once the person turns on **Claude Code cloud sessions** in *Claude Code
folders* (`claude_cloud_sessions`, off by default; an agent may turn it off
but not on), through relayhistory's `claude-web` connector, with the
claude.ai login of Claude Code in `~/.claude`: `~/.claude/.credentials.json`
while its token is current, otherwise (macOS) Claude Code's
`Claude Code-credentials` login Keychain item, handed to the connector as a
private 0600 file under the install's data folder for the length of one pass.
macOS's prompt to read that item appears only when the person acts: turning
the setting on (the row explains it and asks for **Always Allow**) or opening a
cloud session. Capture passes read the item quietly — with Keychain user
interaction off, so they never prompt — on a thread of their own, waiting at
most 3 seconds; without access Claude is reported unavailable (*Agent Relay
may not read Claude Code's sign-in from the Keychain…*) and every other source
carries on, and the next pass reads again. The credential is never
refreshed or changed; an expired one is not used (*Claude Code's sign-in has
expired; open Claude Code to refresh it*). Remote Control sessions that mirror
a local terminal are skipped (their local transcript is uploaded). Each
connector fails on its own: a Claude failure never stops Devin or local
discovery, is recorded per connector in `remote-diagnostic.json`, and the
connector is left alone until its next listing is due. Sharing **New sessions**
withholds a cloud session first listed after setup that started before it;
**Selected** uploads only the chosen ones. The cutoff is the install's first
upload job, so changing one session's sharing (which replaces the job) does not
move it. A cloud session goes with the `~/.claude` folder: turning that folder
off in **Claude Code folders** stops listing and uploading them, and while
`~/.claude` is not a folder listed there (Claude Code runs from another
`CLAUDE_CONFIG_DIR`) cloud sessions are neither listed nor uploaded.
Cloud history is downloaded at a pace that leaves the machine and the
provider account alone (one person's 256 claude.ai sessions came to about
330 MB): only sessions the install will upload are downloaded, newest first,
at most 20 or one minute per pass. A throttled or failing provider
(HTTP 429, 5xx) is left alone for a wait that doubles up to an hour; a
failing session waits up to a day, and one that cannot be read (denied, too
large, gone) is parked until the provider lists it as changed. Downloads stop
while the disk has less than 2 GB free or once they have grown the database
by 2 GB; `remote-diagnostic.json` says so under `pacing`, with how many
sessions are still waiting. The state is `history.remote-pacing` beside the
database.
Account settings retain identity and sign-out. General includes Appearance with Match system,
Light, and Dark. General only shows background-service controls when approval or
repair is needed; it never offers to stop the service. Message links and menu-bar/tray controls continue to work.

Messages settings also show **Claude Code folders**, with why each is watched:
the default, a sibling `~/.claude-<name>` login, one named in
`AGENT_RELAY_CLAUDE_CONFIG_DIRS` (colon-separated), one added with **Add Folder…**,
or one a running Claude Code session uses through `CLAUDE_CONFIG_DIR` (such as
`~/.seclaude`), which is added when seen. Each has a Shared switch. Turning a
folder off (`settings.set` with `claude_config_dir: {path, shared: false}`)
keeps its sessions off the relay and out of uploads (for the `~/.claude`
folder, its claude.ai cloud sessions too); choices, and the **Claude Code
cloud sessions** opt-in below the folders, are saved in
`~/.agentworkforce/relay/claude-config-dirs.json`.

Wherever a Claude login
directory exists, Messages includes a *Claude Code activation* row that adds or removes Agent Relay's
SessionStart hook, off by default (`settings.set` with `claude_session_hook`).
The hook is written into each Claude login's `settings.json` the desktop
knows about. When a session is not on the relay, the hook has Claude ask the
person whether to put it on the relay and under what name, and POST /register
only if they say yes. The person sees a short notice that nothing is
registered unless they say yes. The hook never registers the session. A
`claude -p`, Agent SDK or structured pipe run has nobody to answer, so the hook
stays quiet there. A session already on the relay gets a short preamble with
its relay name, how to reach peers and the messaging norm.

Messages settings also have **Spawned agents** on both apps (see
[native-spawn.md](native-spawn.md)). **Accept spawns from Agent Relay**
(`settings.set` with `accept_spawns`, on by default) makes this computer a
spawn target, `<machine prefix>-desktop`, that starts Codex, Claude, OpenCode, Grok, Muse and Devin headless
when their CLIs are installed. Devin runs on a
persistent private ACP host and can take another message while idle. Its full
access switch defaults off. A launch-specific MCP server permits only Agent Relay
sends through the authenticated local session socket; other approval requests are refused. The bundled
Devin app CLI still needs its own authenticated CLI session (`devin auth status`).
Both apps use the shared core's durable spawn failure receipts and redacted
startup diagnostics. Hosted status keeps the same reason across broker versions
and restarts; the core log also records failures without an activity subscriber.
A status line under it says whether Agent Relay can spawn here, is
connecting, or why not, and how many places are in use; it is a warning when
another account owns this computer's spawn node, which then takes no spawns
(see [native-spawn.md](native-spawn.md#whose-computer-it-is)). While it is on,
**Allow teammates to spawn here** (`spawn_allow_teammates`, off by default)
reads "Off: only you can start agents on this computer. On: workspace owners
and admins can too.", with the claim under it ("Claimed by you in Agent Relay
Cloud." or "Not claimed yet: no agent can be spawned on this computer through
Agent Relay Cloud until it is." with why, and a primary **Retry** button when
the claim failed), and
**Max spawned agents** is an optional number field (1–32). Empty means
**No limit**, the default; `spawn_max_agents: 0` clears the cap through the API.
The old untouched default of 12 was stored as absent and now becomes unlimited;
explicit caps, including 12, are preserved. When a cap is set, it limits how many
run at once: an idle agent keeps its place until it is released, and a spawn
beyond the cap is refused, never queued. Save with **Save** or Enter; leaving the field or refreshing Settings does not apply an unfinished edit. Failed saves show the error and restore the confirmed cap. A **full access** switch for each
harness the node offers chooses whether spawned agents run without their
sandbox; Codex and Claude approval requests go to the machine owner alone, as Relay
messages they answer. The rows, their labels and wording come from
the core (`SpawnStatus.harness_descriptors`), so both apps show the same ones;
each is `spawn_harnesses.<id>.full_access`, on by default for Codex, Claude, OpenCode and Grok
(also `spawn_full_access_codex` and `spawn_full_access_claude`; OpenCode has the
map key only). Billing and repository access are set with `settings.set` only
([node-lifecycle.md](node-lifecycle.md)).

A spawned agent's first message names the agent that asked for it (as
Relaycast recorded the invocation) and gives it this computer's session-socket
commands to report back and list agents, with no token in the message. A
spawned Claude or Codex that sends its requester nothing gets its first turn's
final answer sent to them, only while that name still belongs to the agent
that asked; other harnesses are told the requester receives only what they
send. A confined OpenCode, which may not run shell commands, gets no commands
([native-spawn.md](native-spawn.md#reporting-back-to-the-requester)).

Spawned OpenCode agents can reply through this computer's session socket: the
spawn loads Agent Relay's OpenCode plugin into their private server itself,
whether or not the person installed it globally, without touching OpenCode's
own configuration directory. The plugin only tags shells there; the core verifies the exact private server and
sealed session binding before accepting a reply. On macOS the reply hint uses
the Agent Relay helper so the kernel can read the shell's session tag.

Native layout review fixtures (test identity and simulated update):
[Sessions on macOS](images/settings-redesign/sessions-dark.png),
[Sessions on Linux](images/settings-redesign/sessions-linux-dark.png),
[General](images/settings-redesign/general-dark.png),
[Account](images/settings-redesign/account-dark.png),
[Updates at 900 points](images/settings-redesign/updates-dark.png), and
[Opening sessions in light mode](images/settings-redesign/opening-light.png).
Regenerate with `SETTINGS_RENDER_DIR=/tmp/relay-settings-renders swift test --package-path macos --filter SettingsLayoutTests`.

Messages settings also have **Claude Code message approvals** on both apps,
collapsed by default. Expand the section to manage session and member permissions.
Each Claude Code session can use direct delivery or **Ask first**. An optional
member restriction lets only explicitly allowed sender addresses arrive
directly; every other message is held locally with **Approve once**, **Always
allow** and **Dismiss** actions. These choices are enforced before the
session's inbox and are separate from Claude Code's login-wide
`crossSessionInbound` setting.


Codex app-server and desktop-window messages stay pending while the current
turn runs. After it finishes, delivery starts a separate turn; peer messages
and incoming cloud messages use the same idle check on macOS and Linux.
Waiting does not consume a send attempt. Live terminal sessions continue to
use Codex's own queue, which waits for the current turn to finish. Conductor's
existing Stop-hook delivery remains a separate host-specific route.

The shared probe recovers a rotated Cloud workspace key automatically when
Relaycast rejects it. It refreshes the app's retained Cloud session, resolves the
same workspace and origin, and verifies the replacement with one safe read before
saving it. Sign-out or a changed workspace cancels recovery; failed writes are never
replayed automatically. This behavior is shared by macOS and Linux.

## Interaction

The transcript replaces list-level search with its own back/refresh
controls. Search, switches, keyboard focus and scrolling remain native. Filters and
grouping use compact Cloud-style triggers with checkmarked popover choices. Disabled relay switches explain whether the session
must be started or a workspace connected. Unsupported upload rows explain that
no local transcript is available. Global errors remain in the status bar;
per-session relay errors appear beside the affected title.

Agents on the relay show their harness mark. A Capy thread (registered with
`session_kind: capy` by Agent Relay Cloud when the thread binds) shows the Capy mark, is
listed as running in the cloud, and is grouped under a Capy machine.

Starting Capy threads is an agent operation. Neither the account menu nor the
Agents and Team overflow menus expose **Start Capy thread…** on macOS or Linux.
The relay core retains the Capy project, spawn and binding-status methods for
agents; the workspace Capy key remains in Cloud.

## Other platforms

On macOS the main window hides the native title and title-bar background, letting
the page backgrounds extend behind the standard traffic-light controls. Content
keeps its native safe area so controls remain clear. Linux and Windows retain
the native title bar and controls; the macOS window style is platform-specific.

Linux and Windows provide the same local session table and Settings navigation
in GTK 4 (`probe/src/linux_app/ui`, one app built for both). Every platform
uses a 980 × 650 minimum window. Appearance is persisted in native preferences
on macOS, `~/.config/agent-relay/desktop.json` on Linux and
`%APPDATA%\agent-relay\desktop.json` on Windows.

A per-user Linux install (`~/.local/lib/agent-relay/<version>`) lists itself
in the desktop's app launcher through
`~/.local/share/applications/agent-relay.desktop`, which runs that install's
`agent-relay-desktop` by its full path; the npm Agent Relay CLI shares the
bare `agent-relay` name. Updates and every app start keep it on the running
version, `agent-relay-desktop --install-launcher` writes it for a scripted
install, and an install from the `.deb` removes it so the package's own entry
is listed. An entry the app did not write is kept. macOS needs none: the app
is a bundle in `/Applications`.

A per-user Windows install
(`%LOCALAPPDATA%\Programs\AgentRelay\<version>\AgentRelay-Windows-<arch>`)
lists itself in the Start menu through
`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Agent Relay.lnk` and handles
`agentrelay://` links through `HKEY_CURRENT_USER\Software\Classes\agentrelay`,
both kept on the running version the same way;
`agent-relay-desktop.exe --install-launcher` writes the shortcut for a scripted
install. The release's `AgentRelay-Windows-<arch>-Setup.exe` installs into
that same folder, writes the same shortcut and runs `--install-launcher`,
and its uninstaller removes every version, the shortcut, the handler and the
logon task. Projects remains hidden on macOS.

## Validation

Run `swift test --package-path macos` and
`xvfb-run -a cargo test --manifest-path probe/Cargo.toml --features gtk --test linux_app_gtk`,
and on Windows the same `cargo test` in an MSYS2 CLANG64 or CLANGARM64 shell
(see [windows/README.md](../windows/README.md)). The GTK tests need GTK 4 and a
display (Xvfb on Linux; Windows has its desktop session). The bridge tests use local
Unix sockets and never require a real account. Inspect both wide and
minimum-size native windows when modifying these regions.

Global background errors appear as an amber **Needs attention** warning at the
bottom left of the status bar. Hover to read the full message; on macOS, click
to open selectable details. They do not appear as banners in settings.

### Reading a local session

Click any session row to open its local conversation, whether or not it is uploaded.
Opening the reader uses `sessions.transcript` without enabling uploads or relay registration.
User messages, assistant Markdown, selectable code blocks, and collapsible thinking,
tool activity, and session context share a centered conversation column. Messages
load automatically through the full local transcript. Copy, refresh, and retry
controls remain available.

The editable session title replaces search in the shared header; there is no separate
transcript toolbar. Back to sessions sits between the wordmark and session title
in the shared header. Matching full-width Open and Refresh buttons live in the
compact right sidebar (a spawned session Agent Relay still runs may have no
Open; see below). The Messaging section groups Receive messages
with the agent name field and Rename button. Naming appears only when messaging
is enabled and a name is available, without scrolling at the minimum window size.
Copy name copies the session's name, even while a new name is being edited.
Helper text lives in tooltips; status and actionable errors remain visible; the
name field's tooltip explains renaming. Upload session includes its
local/uploading/uploaded status. Renaming changes the name other agents see on
Relaycast, leaving the session title unchanged. A session has one name: a rename
replaces it, so only the new name is shown and replies come from it, while the
earlier name only forwards messages sent to it, so nothing sent while renaming
is lost: the name the session was registered with until it leaves the relay, a
name a later rename replaced for 24 hours.
Turning Upload session off uses the
existing cloud-deletion confirmation. Back to sessions keeps the table’s search,
grouping, collapsed sections, and scroll position.

Group headers are buttons with chevrons and session counts. Click to collapse or
expand; collapsed state is independent for each grouping and survives list refreshes
and searches. Rows, headers, and controls have hover and keyboard focus feedback.
Actionable rows, buttons, menu triggers, and switches show a pointing-hand cursor.
Disabled controls use the arrow cursor and suppress action hover feedback; cursor
state follows sensitivity changes and is cleared when a hovered control disappears.

### Cloud styling

The desktop uses the effective Cloud workspace palette from
`cloud/packages/web/app/dashboard/_components/workspace-chrome.module.css`:
light canvas `#f9fafb`, dark canvas `#14191f`, primary `#2d6a9c` / `#74b8e2`,
and row hover `#e7eff7` / `#223e58`. These override the older airframe and
marketing palettes. macOS centralizes the tokens in `CloudTheme.swift`; GTK
uses the matching `LIGHT` / `DARK` palettes in `ui/theme.rs`. The macOS menu-bar panel
also uses these tokens for its canvas, text, hover, and status colors. Its session
rows and header/footer controls highlight immediately, without a fade, and pointer
motion within a control does not rewrite its hover state. The Linux
StatusNotifierItem menu is rendered by the desktop shell and follows the shell’s
theme; its protocol does not provide app-controlled menu colors.

Both appearances share Cloud’s 52px session rows, 28px compact filters,
6px group corners, subtle borders, bordered count badges, and muted zebra
stripes. Settings and local conversations use the same surfaces; code blocks
use Cloud’s dark code palette. Light, Dark, and Match system remain available.

Relay-owned model features use authenticated Cloud endpoints. The opt-in local
`credential-proxy serve` command and daemon proxy have been removed; independently
launched agent CLIs keep their existing authentication and environment.

Desktop sign-in reuses an eligible saved session, then the browser's Cloud
session, and opens Google only when needed. **Use another account** opens
Google's account chooser explicitly. Both macOS and Linux use this same
continuation and PKCE handoff without device-code confirmation. Local setup
clients can opt into it with `/setup/sign-in` and `{"flow":"browser"}`; older
and remote/headless setup clients retain device approval by default.

Conductor and Paseo sessions keep their provider badge and host label on macOS.
Live Codex sessions and top-level Claude Code chats hosted by Paseo use the
Paseo badge. Nested structured Claude runs remain automation and are not
auto-activated; host identity comes from the running process tree.

Local transcripts hide Codex external-context XML and display embedded image
copies from RelayHistory as images. The reader writes each copy into its private
image cache and sends only that path over the core bridge. Reading never changes
upload selection. PNG, JPEG, GIF and WebP copies up to 1 MiB are supported; other
image blocks show an explicit unavailable notice. Capture requires the pending
RelayHistory embedded-image release; the published 0.40.0 capture engine omits
these bytes. Cloud additionally needs the History image-preservation change and
transcript renderer deployed before shared copies appear there.

Session titles include a compact harness · model · reasoning subtitle on both
platforms, with the full value in a tooltip. A session on the relay leads that
line with its agent name (`@name`, its newest name once renamed, in the foreground
color); hovering it explains which names reach the session. Models come from the latest observed
Codex turn context or Claude assistant record in a bounded transcript tail,
falling back to RelayHistory's catalog model names. Reasoning shows the explicit
Codex turn setting when available. Missing metadata is labelled unknown, including
sessions without local transcripts. These reads share the existing one-second
metadata budget and never hydrate or upload a transcript.

Upload status sits beside the switch in the single Upload column. Local-only icons are muted; uploaded
checkmarks use subdued neutral color. Hover labels read “Local only”, “Uploading…”,
or “Uploaded” (other states retain their specific labels). Uploading animates an
upward accent fill, with a steady arrow for reduced motion. The sweep represents
activity, not a percentage: the core does not report per-session byte/record
completion. Accessibility keeps the status available without hovering.

Every visible session column header is clickable. The Upload header sorts by whether uploading is enabled.
Click the active header again to reverse direction; an arrow marks the current
sort. Updated defaults to newest first; text/status columns start A–Z and toggle
columns start with enabled sessions. Missing values stay last. Sorting applies
to loaded sessions and within groups, and persists while filtering, viewing a
transcript, refreshing, or loading additional history.

### Reopening a local session

Desktop destinations use a compact provider logo and open arrow in the transcript
header; the tooltip and accessibility label name the action (for example,
**Open in Claude**). Terminal and setup actions keep their text labels.

**View on web**, below the open action, opens an uploaded session's Cloud page
(`/cloud/dashboard/sessions/<session-id>`) in the browser. It is hidden until
the session finishes uploading.

A Claude Code session something else holds is not offered a handoff it
cannot have. Claude Desktop resumes a session in a process of its own, so
Claude Code refuses `claude --desktop --resume` while anything holds the
session ("Session … is open in another terminal. Run /desktop there
instead."); only the holder hands it over. The core reports what holds each
session it discovers (`holder`), read from the field that session's own
registry entry records — the one Claude Code's handoff reads — and the open
action follows it:

- A session a person is typing in keeps **Open in Terminal**, which resumes
  beside them, with the note "This session is open in a terminal. Run
  /desktop there to continue it in Claude."
- A session a headless process holds (`claude -p`, a structured pipe, an SDK
  run) has no open action: Claude Code refuses a Terminal resume for one too.
  Its note is "A headless Claude Code process is running this session. Run
  claude agents to find it, or stop it, to continue it here."

A chat hosted in another app (Conductor, Paseo, Claude Desktop) runs a
structured pipe and is still a session a person types in; its entry records
that, so it keeps its open action. The holder is read only from the session
as discovery lists it now, so one that has ended holds nothing.

**Open in Claude** returns once nothing holds the session. A holder that
takes the session between that check and the launch is reported with the same
note, in place of the CLI's own line naming the session id. Linux shows only
the headless note: its answer for a session a person is typing in would be
`/desktop`, which Claude Code offers on macOS and x64 Windows only.

A session Agent Relay spawned is never resumed beside the process that runs it
([native-spawn.md](native-spawn.md#joining-and-taking-over-a-spawned-agent)).
Its transcript is followed live with a note ("Live: new output appears as the
agent writes it.") and a message box (**Message @name**, **Send**) under it; an
agent's details on the agents page link to it with **Transcript: Join**. A
spawned Claude has **Take over in Claude** or **Take over in Terminal** in place
of the open action: it asks **Take over @name?** (mid-turn, offering **Take Over
After This Turn**, then **Interrupt Now** while it waits), stops the headless
agent and resumes the session where the opening preference says. A spawned
Codex thread has **Open in Codex** only, with a note that Agent Relay's Codex
app server runs it. Any other spawned agent (Grok, OpenCode, Muse, Devin) has no
open action while Agent Relay runs it; it is joined only, with the note "Agent
Relay runs this session. Follow it and message it here; it is not resumed in
Terminal while Agent Relay runs it." Linux takes over in Terminal: Claude
Desktop handoff is macOS-only.

Take-over confirmations remain bound to the original agent when switching
transcripts. Take-over failures stay with their session until another attempt,
so returning to a transcript restores its error without showing it on others.

**Settings → Opening sessions** stores a per-computer **Automatic** or
**Terminal** preference for Claude Code and Codex. Automatic opens the desktop
app when installed and otherwise resumes in Terminal. macOS checks Launch
Services (including apps outside `/Applications`) when the viewer opens, when
the app becomes active, and again at click time. Settings shows installation
status, **Check installed apps**, and Claude download/setup links. The transcript
header's **Opening settings** button links directly to this page.

Codex opens `codex://threads/<session-id>` when a handler is available. On macOS,
Claude Code opens through `claude --desktop --resume <session-id>` in the
original directory, with a hidden pseudo-terminal: Claude refuses this handoff
when standard output is redirected to a pipe. The launcher captures failures,
limits execution time, and keeps **Open in Terminal** available. Claude requires
CLI 2.1.285+ and subscription login; a session still open elsewhere must first
be closed there. A launch failure offers Terminal and Opening settings.

Terminal resume runs `claude --resume <session-id>`, `codex resume <session-id>`,
or `grok --resume <session-id>` in the session's original directory. The adjacent
**Copy resume command** includes that directory. Missing directories never fall
back to the app's own working directory. Unsupported sources and Claude cloud
sessions do not offer a local resume action. Opening sends no prompt and changes
no upload selection. Historical local Claude Code records do not reliably identify
terminal versus desktop origin, so routing uses the preference and installed apps,
not the `claude-terminal` delivery-kind name or an inferred origin.

macOS terminal resume opens a private, self-removing command file in Terminal.
Linux uses `xdg-terminal-exec`, the system terminal alternative, or a supported
installed terminal. Linux keeps Claude and Grok on Terminal because Anthropic
currently documents the Claude desktop handoff only for macOS and x64 Windows.
Linux supports the same saved preferences, with Codex handler detection and
terminal fallback. Launcher errors remain visible; CLI errors appear in Terminal.

### Session search panel

Open **Search or filter sessions…** or press **⌘F** on macOS / **Ctrl+F** on
Linux and Windows, or press **/** while outside a text field. The search panel groups suggestions under Harnesses, Status, Projects,
and Upload. Choosing a suggestion completes the current query token and keeps
earlier words and filters; typed qualifiers and menu choices use the same query.
Press Return to view results and Escape to close. Use ↑/↓ to navigate suggestions; Tab on macOS or Return on a focused Linux
option chooses a suggestion. Search covers loaded sessions; scrolling loads older history.

Search suggestions support multiple selections. Click or press Right Arrow to
toggle an option; selecting it again removes that value. For example,
`harness:codex harness:claude is:active` shows active sessions from either harness.
Repeated harness, project, status and upload qualifiers match any selected value;
different filter types intersect, and exclusions always apply. Existing search
words stay in the query when selecting a filter.


### Workspace sign-in and upload ownership

The avatar menu shows **Switch workspace…** only when Cloud confirms multiple
workspace memberships. Sign-in opens a workspace selector in the
browser only when the account has multiple workspaces; a single workspace uses
the default directly. Desktop credentials remain bound to that choice even when
the browser switches workspaces.
Uploads and messages use that one workspace and its key; Settings › Messages
shows it as **Workspace from your Agent Relay account**.

Signing out stops the collector and removes its credentials, while retaining the
workspace's sharing choices, pending batches, and acknowledged delivery progress.
Signing back into that same account and workspace restores its existing job;
acknowledged history is not replayed. A new workspace starts with selected-only
sharing. Session discovery lists recent history first without uploading it. When
automatic uploads are enabled, initial full indexing prioritizes the last 24
hours, then the rest of the week, then older sessions by latest activity.
Registrations retained from another relay workspace cannot automatically
select sessions for the new upload destination. Explicitly sharing a session in
another workspace remains a separate choice.

Selected search filters toggle off individually without removing other query
terms. The search bar's × tooltip reads "clear search"; the search panel's ×
closes the panel while preserving the query. Escape also closes the panel.

The session search bar fills the toolbar beside the Table display icon and uses 14px horizontal
and 9px vertical padding. Filter qualifiers appear as chips with a remove ×,
including exclusions and date constraints. Removing a chip keeps other filters
and text, without opening the search panel. Chips scroll horizontally as needed.

Local transcript messages show the signed-in person’s avatar beside “You”.
Consecutive tool calls and results collapse under “N tool calls”; expanding
the group reveals individually expandable calls and results. Counts include
only calls, and groups continue across loaded pages until a non-tool entry.

Workspace controls live in the avatar menu. Only an account with more than one
confirmed workspace shows **Switch workspace…** and a 26-point rounded workspace
avatar behind the 28-point user avatar, matching Cloud's stacked arrangement.
Unknown and single-workspace accounts show only the user avatar. Cloud's `whoami`
response supplies the distinct membership count and current organization avatar;
the core refreshes that metadata every five minutes without renewing credentials.
Older Cloud responses safely omit switching until the count is known.
**Switch workspace…** retains the confirmed sign-out/sign-in flow; it does not
move uploaded history or silently change accounts. Older sign-ins resolve the display name
from Cloud independently of Relaycast; until available, the label is “Workspace”
rather than an internal ID. A name is accepted only for the attached account and workspace.

Click anywhere in the session search bar, including padding, blank space, and
chip labels, to open search. Only the × controls remove filters or clear the
query. Chip labels do not remove filters, and scrolling chips does not open search.

Search editing is optimistic: the query, chips and checkmarks update immediately.
Session results are coalesced after an 80ms pause; obsolete requests are canceled
and only the latest query is applied. macOS filtering, sorting and grouping run off the UI
thread against a snapshot; cached groups keep query edits cheap. GTK defers table rendering to a later main-loop turn.
The previous result list remains visible while the next result set is prepared.

In search suggestions, ↑/↓ move the highlight. Right Arrow selects the highlighted
filter and keeps it highlighted; Left Arrow removes that filter and keeps the
highlight. Repeated Right or Left is idempotent. Text editing still uses arrow
keys normally until suggestion navigation starts. Clicking still toggles a filter.

Opposite search choices replace each other: Active versus Inactive, Not uploading
versus In progress, and Indexing versus other upload states. Compatible
choices (such as Codex + Claude or Uploaded + In progress) remain multi-select.
Choosing a positive value also clears its exact negative qualifier. Manually
combining opposite positive qualifiers shows a validation error.

On the relay is an independent condition and intersects Active/Inactive, rather
than broadening the activity filter.

After navigating suggestions with ↑/↓, Return completes and selects the highlighted
option, then submits and closes search. Its matching trailing fragment is replaced
by the full qualifier (for example, `clo` → `project:cloud`); earlier words and
filters remain. Return without suggestion navigation submits the typed text.

Right Arrow completes the highlighted suggestion in place of its matching typed
fragment, preserving the highlight and keeping search open for more filters.

Keyboard filter selection tracks the highlighted filter across rapid additions
and removals, even when completing text expands the suggestion list.

Selected search filters show a white checkmark inside a filled blue circle.

Turning Upload off asks **Delete cloud copy?** before changing the switch. Confirming
removes that machine's uploaded session and its delegated subagents, keeps local
history, and stops future uploads. Cancel leaves Upload on. A server consent fence
blocks late batches until Upload is explicitly enabled again; that action starts a
fresh backfill. Confirmations are scoped to the current account/workspace. Deletion
errors appear on the affected row, and other rows remain interactive.

The native deletion contract is `uploader.sessions.delete` (the older exclude method
still only stops delivery). This requires History's session-selection endpoint and
migration 0037; deploy the History change before releasing these desktop controls.
No client-side hiding substitutes for successful cloud deletion.


### Development session reset

Session reset is a probe CLI operation, not a desktop Settings control.
Use `agent-relay-probe sessions reset --local` with the install's site, account,
workspace, and `--confirmation 'RESET LOCAL SESSIONS'` to clear local session
state and rediscover existing conversations while retaining sign-in and cloud
history. See the root README's development reset instructions.

The Linux sign-in and app mark use the canonical `assets/agent-relay-mark.svg`
with the same light-blue front and dark-blue back as macOS.

Search expands over the search bar, centered on its anchor, and dismisses
when clicking outside. Escape and the close button also dismiss it.

### Session column preferences

Open the **Table display** columns icon to configure the local session table.
The panel starts with a full-width native **Group by** dropdown with arrow-key
navigation, Enter to select, and Escape to dismiss. Its list matches the field
width and has no popover arrow or repeated heading. This is followed by column
visibility and column order. Drag a
handle to move the full row, or use the up/down buttons. Dragging shows the
destination with a gap on macOS and an insertion line on GTK. Rows have a
consistent 40px height and 6px spacing. Canceling a drag preserves the order. Changes apply immediately
and persist on this machine. **Done** uses the compact brand-blue primary button;
**Reset to default** restores Session, Status, Project,
Updated, Messages, and Upload. Harness, Directory, Session ID, Model, Reasoning, and Created
are optional. At least one column stays visible. Headers and rows
scroll horizontally together when the chosen columns need more space. Drag a header’s
trailing divider to resize its column; body cells have no resize handles. All
headers support sorting and share a 36-point row height so dividers align. Widths
preview live and save on release, survive hiding and reordering, and reset with
**Reset to default**. Double-click a divider to reset just that column. Escape
cancels a drag; keyboard/accessibility adjustments are available on the divider.
Sessions can be hidden from their row menu or the selection toolbar. Hiding takes
an active session off the relay, then excludes it from future uploads while
preserving its existing cloud copy. Hidden sessions are omitted by default;
**Show hidden** in table settings reveals them with muted rows and disabled
relay/upload controls, including in the transcript sidebar. Visibility and the
checkbox persist on this machine. Unhide restores visibility without restarting
sharing. A failed sharing shutdown returns the session to the table with an error.

The Session column fills spare table width, including after reordering (the last visible
column fills it when Session is hidden). The default window is 1280 × 800, with
420-point Session, 100-point Status, 160-point Project, 120-point Updated,
126-point Messages, and 100-point Upload columns. Reset restores these widths
and the default window size (except in full screen). Messages and Upload are centered;
wider layouts scroll horizontally. Harness and Model sort alphabetically, and
Reasoning sorts by effort from none through ultra; missing metadata stays last.
Hovering a sortable header shows the direction its next click will use. Moving
away restores the current sort arrow (or hides it for an unsorted column). Hiding
Upload or Messages does not change either setting on a session.

Created and Updated show relative times (including “Just now”) and reveal the exact
UTC date and time, including seconds, on hover. Every column supports sorting;
Created defaults to newest first, Status uses the displayed activity state, and
Directory and Session ID sort alphabetically. Created uses the first recorded
session activity; missing metadata reads “—”. Harness includes its logo, and Upload stacks its status
icon above its label. Messages uses labeled controls: Off, Connecting…,
Receiving, Offline, and Turning off…, each with a state icon.

Hovering anywhere on a session row highlights the entire row. Clicking its text,
harness logo, or gaps opens the session; the checkbox and surrounding leading
padding select it instead. Message controls keep their own click behavior.

Session rows have a left selection checkbox and harness logo, then the title and known model · harness · reasoning details. Status is separate from the read-only Upload column. Selected rows are highlighted. Selecting sessions reveals the top bulk action bar with Messaging and Upload switches, followed by Hide with an eye-slash icon. Mixed on/off selections display as off; switching on enables the selected sessions, and switching off disables them. Turning uploads off retains the cloud-copy deletion confirmation.

Search expands from and collapses into its toolbar anchor with a 200 ms eased
transition. Reduced-motion preferences skip the animated close.

The compact header brand has no hover highlight or pointing-hand cursor. The search border is muted while closed. Account avatars are centered with padding, including single-workspace accounts. Available updates appear as an icon-only download button beside the upload status, without an update dot on the avatar.

The local session count appears beside the bottom-left status. When problems are present, click Needs attention to open Diagnostics with full, selectable and copyable error details. Distinct session and connection problems are collected together.


A discovered session awaiting an upload-catalog entry is labeled **Indexing**
in the list, sidebar, and upload filter. Missing catalog data alone does not
prove uploads are unavailable. Upload selection waits for the catalog entry;
known upload errors keep their specific explanation. Opening a session
excluded by Reset all sessions explains the reset and directs the person to
the source app, without recreating Relay’s cleared reader cache.

Each session group header has a checkbox that selects or deselects only the matching rows in that group, including when the group is collapsed. Other groups keep their selections. A partially selected group displays unchecked; clicking it selects the whole group.

### Request diagnostics

Settings → Diagnostics fills the available content width and shows recent Relaycast and Cloud requests from the background service, newest first, with request and response details, timestamps, duration, and a Failures only filter. Click anywhere on a request header to expand or collapse its details. The bottom-left dot and status text show overall app status: green when uploads are up to date with no problems, orange when a request fails or another problem needs attention. Clicking a request failure opens and highlights the exact entry in Diagnostics; it stays available when older requests roll out of the log. Viewed request failures do not notify again. Other current problems appear in Diagnostics with selectable, copyable details. Copy details briefly changes to Copied when the problem text is copied.

If the background service exits unexpectedly, the app shows **Reconnecting** while its service manager starts the replacement. Read-only requests interrupted by the exit wait up to five seconds and run again against the replacement. Changes are never sent again automatically, because the old service may have completed them before the connection closed; the app asks the person to check the result before trying again. A service that stays unavailable shows a recovery action. Once the new snapshot arrives, a transient read error no longer keeps the status orange.

An upgrade notice appears at the bottom right, at most once every 15 minutes per workspace, with **Review upgrade** (opens Cloud Billing) and dismiss. It reads **Agent Relay plan limit reached** when Relaycast reports the workspace's plan quota is used up. It reads **Workspace at capacity**, naming the plan, when a Free or Pro workspace had three or more writes answered with `workspace_busy` in the last five minutes. The plan comes from Relaycast's workspace (read during verification); busy answers on lanes no plan raises (connection tokens, heartbeats, node calls, delivery acknowledgements) do not count, and Relaycast's own `upgrade_available`, which the request log records from each busy answer, decides when present. A single busy write is ordinary contention and the app simply retries. Requests made for a Relay Connect room (the request log tags them with `connect`) are that room's workspace, not the team's, and never raise either notice.

The log lives only in memory for the current service run (up to 250 entries; large responses and bridge snapshots are bounded). Credentials and message content are redacted. Relaycast SDK rows contain decoded results or final error details, including HTTP status, request ID, and retry count where available. Successful HTTP statuses and individual SDK retry responses are not exposed by the SDK. Cloud rows include the actual HTTP status. Calls made with a Relay Connect room's credential are labeled Relay Connect instead of Agent Relay, because they use that room's workspace and its limits, not the team's. The log covers the core's Relaycast calls and Cloud HTTP transport, not WebSocket frames or separate upload transports.

Session lists use the daemon's shared snapshot: reopening the app reads cached
rows immediately while live-agent discovery and upload enrichment run in separate
background tasks. A cold daemon seeds rows from the collector's persisted catalog;
global upload status and history requests run independently in both desktop apps.

User-facing messages, help text, and diagnostic service labels use **Agent Relay**.
Relaycast remains an internal provider identifier.

The menu-bar panel and the Linux and Windows tray are an at-a-glance summary of this computer's
sessions, laid out as a plain menu. **Messages** counts sessions **Receiving
messages** (`is:active is:on-relay`) and **Local only** (`is:active
is:off-relay`); **Uploads** counts **Uploaded** (`upload:uploaded`) and **Not
uploaded** (`-upload:uploaded`). Each count is that search run over the rows
the session list shows, hidden sessions excluded unless shown, and choosing it
opens the session list with that search, so the list shows exactly the sessions
counted. **All sessions** opens the session list with no search; Settings… and
Quit Agent Relay follow.

The menu shows no banners. On the Mac each section title carries a status dot:
green when it is working, grey while paused or connecting, and the warning
orange when something stops it. Its wording shows on hover, and an orange dot
opens Settings → Diagnostics (the failed request, when there is one), like the
window's **Needs attention**. While something needs attention, the menu-bar
icon is drawn in that orange. Receiving messages and Uploaded are badges in the
brand blue while nonzero and nothing needs attention, the rest muted. The Linux
tray has no hover: its icon turns the same orange, **⚠ Needs attention** under
Messages opens Diagnostics, and the upload status is written beside Uploads.

After browser authentication, accounts with multiple workspaces choose a workspace in the welcome screen. No relay connection or upload setup starts until a workspace is selected. A single workspace continues automatically; Cancel returns to sign-in.

### Saved session views

A single bookmark button sits beside the search box and opens
**Saved views**. The bookmark, table settings, and account controls use compact
6-point gaps while retaining their existing hit areas. Its bookmark is filled whenever the current search and table
configuration matches a saved view; changing those settings returns it to an
outline. Choose **Save current view** in the dropdown, give it a unique name,
and optionally choose **Make default**. Select a saved name to restore it, use
the star to change the default, or the × to delete the view. Deleting a view leaves
the current table unchanged;
deleting its default removes the startup override. Views are local to this machine.

A view preserves the search text, grouping, sort direction and column, column
order/visibility/widths, and **Show hidden**. Date filters preserve their explicit
dates; saving a date range does not turn it into a rolling window. The default
loads at app startup. All controls have accessible names and keyboard focus;
Enter saves from the name field and Escape dismisses the popover. Delete remains
available without hover, with stronger emphasis on hover or keyboard focus.

Primary blue actions use the canonical Agent Relay button, including Save current
view, Save, Done, sign-in, settings, and upgrade. Both themes use brand blue
`#2d6a9c`, white text, a `#234969` border, and 10/10/10/3 corners (the tight corner
is bottom-left). Hover darkens to `#26557e` to keep white text accessible.
There is no shadow or glow. Keyboard focus and disabled states remain visible.
Use `AgentRelayPrimaryButtonStyle` on macOS and the `primary` class on GTK;
workspace accent colors are separate and must not define button fills.

Spawned Grok agents can reply through the relay-send socket without a separate
MCP setup. The core verifies the caller's exact recorded leader, session claim,
process ancestry and private marker before identifying the sender.

## iPhone and iPad

The mobile client has **Agents** and **Messages** tabs; Drive has no separate
tab. The phone header pins the Agent Relay logo to the leading edge, and iPad
keeps its logo in the left rail. Agent conversations follow the current relay
roster and disappear when their peer leaves or its presence expires. People's
conversations remain available offline. Message history stays on Relaycast.
Presence reconciles every 30 seconds, on foregrounding, and on tab changes.
Machine menus group equivalent hostname spellings and match every variant
when filtering. These changes are mobile-only; the desktop layout above is
unchanged.

### Relay agent names


New relay registrations use `harness-repo-task`, with up to two meaningful
words from the session title (for example `claude-cloud-plan-support`). Names
are chosen locally; filler words are skipped. A missing task title uses
`session`. Duplicate automatic names get `-2`, `-3`, and so on. Existing
registrations retain their names as titles change; explicitly chosen names
are respected. This behavior is shared by macOS, Linux and headless mode.

### Codex CLI discovery

Codex terminal message delivery resolves npm CLI launchers to their bundled native
executables, so the desktop or background service does not require Node on its
PATH. Nested and hoisted platform packages and legacy vendor layouts are supported.
On macOS, discovery also recognizes the CLI inside the newer
`Resources/codex-cli/CodexCLI.app` bundle layout.
