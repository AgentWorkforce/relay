# Agent Relay for Linux

Core diagnostics are saved in the app data directory's `logs/core.log`
(`~/.local/share/com.agentrelay.desktop/logs/core.log` by default, respecting
`XDG_DATA_HOME` and `--app-data-dir`). Credentials are redacted; the log rotates
at 1 MiB with three backups. The systemd user service also sends these
diagnostics to the journal (`journalctl --user -u agent-relay.service`).
Logging failures do not prevent core operation. Raw child output and request
or message bodies are not captured.

The same GTK app also runs on Windows; Windows readers, see
[windows/README.md](../windows/README.md) for installing, building and what differs.

Existing Pi sessions can receive Relay messages without a Pi upgrade or
restart. The core installs the extension; run `/reload` once in Pi, then enable
**Receives messages** in the session table. Delivery waits for idle and confirms
the message in Pi’s history. See [Pi delivery](../docs/pi-existing-session-injection.md).

Pi queues preserve arrival order while busy, and channel batch answers reply to
the last post. A failed extension installation remains visible in status details
and Settings → Relay on both platforms; fix the conflict or permissions and
restart Agent Relay to retry, then run `/reload` in Pi.

Spawn recovery and startup diagnostics run in the shared core on both platforms.
Known spawn origins survive legacy store merges; Codex origins omitted by an old
writer can be restored from matching local receipts and Relaycast identity.
Failed launches preserve redacted harness reasons in durable completion receipts,
core logs and hosted status, including through older brokers that accept only
plain error strings. Ended intents retire after acknowledged cleanup. CLI failure
logs include argv, observed exit status and a bounded output tail; Codex's
app-server RPC has no per-launch exit status. OpenCode warns when model startup remains
unverified; Grok reports clearly missing default credentials as unavailable.

Replicas launches use Agent Relay Cloud through the same shared contract on
Linux and macOS: environment listing, durable spawn/status, and release.
Spawning remains an agent operation; no GTK-only button or background service
is added. The [existing operator bridge](../integrations/replicas/README.md)
can remain while the Cloud integration rolls out.

Cursor Cloud agents use that same shared core on Linux, macOS and Windows.
They are identified as `cursor-cloud`, separate from the removed local
`cursor-agent` target. Agent operations can list models and agents, launch,
inject follow-ups, inspect results, archive and restore; Cloud holds the Cursor
credential and routes Relay messages into the provider's native follow-up API.
There is no GTK-only launch form. See [Cursor Cloud agents](../docs/cursor-cloud.md).

Native spawning includes Muse through a detached Relay-owned terminal host.
Its startup task is a CLI argument and later messages use a courier restricted
to that owned process; Relay never types into the terminal. Muse sessions
started elsewhere are not listed or messaged. Muse's sandbox is on by default. The core
publishes the same harness settings and wording for the GTK and macOS apps.
The shared core records Muse's detached host before launching its child so a
restart during startup can recover or stop the exact owned process group.

Spawned Muse and Devin expose a per-launch MCP tool for Relay messages. It uses
the authenticated local session socket and accepts only the recipient, message
text, and optional reply parent. Shell sandboxing stays enabled by default;
Relay replies do not require granting shell access to the socket.

The native GTK desktop app for Agent Relay. It is a thin client of the relay
core, the `agent-relay-probe relay serve` daemon bundled with it
([relay core](../docs/relay-core.md)): every screen renders the core's state,
and every action is a bridge call. Sign-in, uploads, delivery into sessions,
messaging, the fleet, telemetry and launch at login all run in the core.

The app follows the Mac app's local-first layout (see
[workspace layout](../docs/workspace-layout.md)). Startup opens the session list
for this computer: one table for running agents and historical sessions. A single
header holds the Agent Relay logo and canonical wordmark, **Search or filter sessions…**,
the icon-only **Table display** control, and the avatar menu with **Settings…** and **Log out…**.
**Ctrl+,** opens Settings. The search panel offers **Receives messages** and
**Does not receive messages** as mutually exclusive filters, displayed as readable
chips. They match confirmed registrations (including offline sessions) or their
absence and preserve other filters, grouping, and sorting. Removing the chip
includes both message states again. Sessions stay current automatically.

- **Filters:** activity, message reception, harness, upload status and updated dates live in one
  popover. Choosing Active adds `is:active` to the visible search; running
  sessions have an Active label in their row. Combine `title: Foo`,
  `project:cloud`, `harness:codex`, `upload:uploaded`, and
  `updated:>=2026-10-01`. Quoted phrases, exclusions and inclusive date ranges
  (`updated:2026-10-01..2026-10-11`) work too. Dates use UTC. Search help lists
  the syntax, and Clear resets search and filters together. All filters apply
  to the same list. The header logo returns from a conversation,
  preserving the query and grouping. As on macOS, Filters stays open while
  combining choices and during background refreshes; Done, Escape, or a click
  outside dismisses it. Group by closes after choosing a grouping. Both apps
  share fixtures for search results and menu edits to the query.
- **Sessions:** local history joined to local relay discovery, with a **Receives messages** status orb
  and an **Upload** toggle. Cloud-style striped rows group by
  None, Harness, Project, Status, or Week, with tinted headers and counts.
  Labels prefer RelayHistory's harness-provided catalog title, falling back to
  prompt text when no title is available, matching macOS.
  Project names come from local Git repository metadata when available, so
  linked worktrees and nested directories group under the repository name.
  Relay broker controller roots show no project instead of the machine-node
  folder; other non-repository directories retain their folder-name fallback.
  Search and harness/upload-status filters narrow the loaded list; older history
  loads invisibly as you approach the end of the list. Discovered sessions awaiting
  upload indexing remain visible, labeled Indexing. Other machines and teammates are viewed in Cloud.
  As on macOS, a running Codex, Claude Code, Grok, OpenCode, Muse or Devin
  session on the relay is one row with its transcript, joined by the core's
  upload key, so its transcript shows its real messaging state; putting one on
  the relay also uploads it. Registered Grok CLI sessions use Grok's title.
  Claude app, OpenClaw, Hermes and Pi relay rows are listed on their own.
  As on macOS, Grok sessions explicitly marked as subagents stay in local
  history but do not appear as separate rows, even without a recorded parent;
  refreshing the catalog also corrects previously cached sessions.
  Previously selected Grok subagents are removed from independent upload
  selection before delivery; children with recorded parents share with them.
  As on macOS, Grok Bot (the desktop app, a `grok-bot` source separate from the
  Grok CLI) lists one session per bot from the app's local transcript tail
  (about the last 200 entries or 7 days), and a Codex thread whose rollout file
  was pruned is recovered from Codex's SQLite history; such a thread moves with
  its catalog row, like a session in a shared database.
  OpenClaw (an `openclaw` source, RelayHistory 0.49.0) lists each OpenClaw
  agent's sessions, its main chat, channel chats, Agent Relay conversations,
  cron and subagent chats, read from `~/.openclaw` (or `OPENCLAW_STATE_DIR`) on
  every OpenClaw from 2026.3 (its agent database from 2026.8.1, its JSONL
  session store before), one row per conversation: every heartbeat or cron run
  of a key is part of that row, and follows the session-sharing mode as on the
  Mac. Antigravity (an `antigravity` source) and Oh My Pi (an `omp` source)
  are listed too, from `~/.gemini/antigravity*/brain` and `~/.omp/agent/sessions`,
  as on the Mac.
- **Session titles:** open a session and choose the quiet **Rename** button
  beside its transcript-header title, matching macOS and Windows. The title
  edits in place with the same typography and no input border or background.
  The table has no rename controls and does not preload title suggestions.
  Enter or **Done** saves; Escape or **Cancel editing** cancels. Moving focus
  outside the entire editor saves after a short debounce, allowing movement
  between its text and buttons without submitting. Unchanged titles do not
  write, and typing does not send requests. **Use generated title** fills the
  draft and refocuses it without saving. Opening the session preloads its saved
  pipeline title, with bounded reads and a cache scoped to harness and session;
  neither preloading nor the sparkle button starts generation. The sparkle
  appears while editing once a saved title is available. Native support comes from
  `sessions.title.capability`, and saving calls `sessions.title.set` to update
  the original harness. Unsupported sessions explain the limitation in the
  Rename tooltip. Saves appear immediately and roll back with an error on
  failure, preserving the rejected draft for retry. Reconnecting retires
  interrupted title requests; changing accounts clears cached suggestions and
  edits. Leaving the session cancels delayed saves. A confirmed optimistic title
  expires after at most one minute and refreshes from the source, so later
  harness changes remain visible. Editing never sends an agent prompt or
  changes the Relay messaging name.
- **Capy detected:** where Capy's device connector has created `~/.capy`, a
  card above the session table offers to put Capy threads on Agent Relay, as
  on the Mac (which also looks for `Capy.app`). **Set up in Capy** copies the
  setup prompt and opens https://capy.ai, then says **Prompt copied. Paste it
  into a Capy thread.**; **Not now** hides the card for good
  (`capySetupDismissed` in `desktop.json`). Capy threads run on Capy's
  servers, so nothing is installed locally: the Capy thread proposes the Agent
  Relay plugin and the person approves it once.
- **Devin found:** while the core reports Devin's hooks off
  (`devin_direct_delivery` false), a card above the session table offers to
  add them, as on the Mac. **Turn On** sends the setting and shows the core's
  error under the card if it fails; the card goes once the hooks are on.
  **Not now** hides it for good (`devinSetupDismissed` in `desktop.json`).
- Starting Capy threads is an agent operation, so the account and Agents/Team
  overflow menus omit **Start Capy thread…**, as on macOS. The relay core keeps
  its Capy project, spawn and binding-status methods available to agents. The
  workspace Capy key stays in Cloud.
- Detailed upload stages and journal compaction live under **Settings → Session
  sharing → Upload details**. The status bar keeps upload state and pause/resume.
  When a problem that is not retried on its own stops uploads, session rows read
  **Upload stopped** and the upload stage offers **Retry uploads**.
  **Live Agents on Relay: N** opens Sessions with `is:active is:on-relay`, replacing
  previous search filters and returning from any open transcript.
- **Settings:** General (appearance, open at login, keep agents connected after quitting, privacy, and service recovery when needed), Updates (software updates),
  Diagnostics (log files and expandable, copyable diagnostic reports), Messages (connect the account workspace or
  paste a key, Claude Code direct delivery, Grok leader mode, the OpenCode plugin, OpenClaw agents (any OpenClaw from 2026.3.13; one older
  than 2026.8.1 cannot limit relay sessions, which the row says; with **Agent Relay tools** under it while it is on:
  **Connect** opens the hosted Agent Relay MCP's consent page in the browser, as on the Mac) and Hermes
  ([openclaw-hermes-delivery.md](../docs/openclaw-hermes-delivery.md)), the Devin hooks,
  self-registration, spawned agents, incoming messages to Codex threads), Session sharing and Account.
  **Spawned agents** lets Agent Relay start agents here, headless, as on the Mac
  ([native-spawn.md](../docs/native-spawn.md)), with the same **Allow teammates to spawn
  here** switch (and the claim under it), an optional **Max spawned agents**
  number field, and full-access switches, one for each harness the core describes
  and the node offers. Leave the cap empty for **No limit** (the default), or set
  1–32. The old untouched default of 12 becomes unlimited; explicitly saved caps
  remain. Clearing the field sends `spawn_max_agents: 0`, Relaycast’s documented
  unlimited sentinel, matching macOS. Save with **Save** or Enter; leaving the field or refreshing Settings does not apply an unfinished edit. Failed saves show the error and restore the confirmed cap.
  A spawned agent's first message names the agent that asked for it and how to
  report back over the session socket; a spawned Claude or Codex that sends
  nothing has its first turn's final answer sent to the requester
  ([native-spawn.md](../docs/native-spawn.md#reporting-back-to-the-requester)).
  A spawned Codex or Claude takes the signed-in machine owner's messages as
  plain user turns; other agents, its requester included, stay peer-framed.
  Its approvals (Codex's app-server requests, Claude's permission prompts)
  reach only the owner as Relay DMs; replies use a short reference and expire
  to denial. A spawned Claude that has ended is never resumed: a message to it
  is not delivered, and its sender is told the session has ended.
  Devin uses a persistent private ACP host, remains messageable while idle, and defaults
  to accept-edits. A launch-specific MCP server permits only Agent Relay sends
  through the authenticated local session socket; other approval requests are refused. It requires `devin auth login`
  when `devin auth status` reports signed out. Each runs in a systemd scope of its own, so restarting or updating
  `agent-relay.service` leaves it running. Codex is offered only when its
  app-server daemon can run here: a Codex installed only through npm or a
  version manager such as mise cannot start one, so install Codex with its own
  installer to spawn it (see native-spawn.md). Follow-up messages resume a
  native Codex spawn's unarchived thread if Codex unloaded it while idle;
  ordinary stopped sessions still wait for their host.
  OpenCode is offered for OpenCode 1,
  whose server the spawn drives; its server runs in a scope of its own too.
  Grok is offered from version
  1.0.46; an older one is refused with a reason that says to run `grok update`.
  Spawned OpenCode replies use the session socket: the spawn loads Agent
  Relay's OpenCode plugin into that private server itself, whether or not it
  is installed globally, and never writes to `~/.config/opencode`; the core
  verifies its process and sealed binding, and never identifies a managed
  caller from a session tag alone.
- Agents lists running sessions only, with the Mac's harness marks (Capy
  threads on the relay show the Capy mark, run in the cloud and group under
  Capy); a
  registered session whose process ended keeps its name and queued messages
  off the list until it runs again, and Grok sessions are listed from Grok's
  own live-session registry and bound to Grok's leader when added; with
  automatic activation on, one whose leader runs is added by itself, is
  rebound when Grok restarts its leader, and leaves after the grace period
  when it cannot be rebound. Claude Code
  direct delivery and Grok leader mode are on by default wherever those tools
  are installed and the person has not set them; turning one off here keeps it
  off.
  Live Devin CLI sessions are listed too: each `devin` process proves its
  session by the `session_locks/<id>.lock` it holds open, a session can
  register itself from inside its own process tree, and a relayed message is
  written as a `session/prompt` frame into a terminal session's `acp` stdin
  through `/proc` — immediate, even while the session sits idle — or, when no
  such pipe is reachable (a Devin Desktop session's `acp` speaks over a
  socketpair), staged into `~/.local/share/devin/relay/inbox.d/` for the next
  hook boundary. The *Devin sessions*
  row (`devin_direct_delivery`, offered in Sessions where Devin has run, never
  turned on by itself) adds or
  removes Agent Relay's lifecycle hooks in `~/.config/devin/config.json`;
  the hooks drain staged messages into the conversation at each boundary —
  a session started before they were on fires none and must be restarted.
  When the Devin CLI is signed in, the inventory also polls the org's Devin
  cloud sessions (at most every five minutes, through the `devin-cloud`
  connector) so they appear alongside the local ones. They are listed in
  the sessions table too, hosted by *Devin Cloud*: one auto-activates like
  a local session and stays live while the sign-in resolves. A relayed
  message to a cloud session — any Devin session not running locally — is
  posted into it through the connector, which needs the `ManageOrgSessions`
  scope; the send's result is reported once and never repeated, since the
  Devin API cannot deduplicate a reposted message.
  Claude Code cloud sessions on claude.ai are listed and uploaded the same
  way (the `claude-web` connector, at most every five minutes) once
  **Claude Code cloud sessions** is turned on under *Claude Code folders*,
  with the login in `~/.claude/.credentials.json`, never refreshed or
  changed; an expired one is not used. They go with the `~/.claude` folder's
  Shared switch. On the Mac the login can also come from Claude Code's
  Keychain item, so its row also explains macOS's prompt; Linux has none.
  Claude Code sessions on a second Claude login (`~/.claude-<name>`,
  `CLAUDE_CONFIG_DIR`) are listed too, and direct delivery applies to every
  login, as on the Mac. *Claude Code folders* in Settings › Relay lists every
  Claude Code config folder whose sessions are found and uploaded: the
  default, sibling logins, `AGENT_RELAY_CLAUDE_CONFIG_DIRS`, folders added with
  *Add Folder…*, and any `CLAUDE_CONFIG_DIR` a running Claude Code session
  uses (such as `~/.seclaude`). Turning a folder's switch off keeps its
  sessions off the relay and out of uploads. Wherever a Claude login directory
  exists, *Claude Code activation* (`claude_session_hook`, off by default)
  adds or removes the same SessionStart hook in each of those logins'
  `settings.json`. In an unregistered session the hook has Claude ask you
  whether to put it on the relay and under what name, and POST /register only
  if you say yes. A session already on the relay gets a short preamble with its
  relay name, how to reach peers and the messaging norm. The hook never
  registers it.
- Relay & messages includes the Mac's **Claude Code message approvals**, collapsed
  by default. Expand it to choose direct delivery or **Ask first** per session,
  manage the optional allowed-members restriction, and use held-message actions **Approve once**, **Always allow**
  and **Dismiss**. The core saves these choices before using Claude Code's
  inbox, independently of the login-wide `crossSessionInbound` setting.
- The Linux UI understands the shared `paseo` host value, labels it "Codex in
  Paseo" and carries Paseo's badge on the Codex mark. Current automatic Paseo
  process discovery is macOS-only because its proof is the packaged
  `Paseo.app` helper ancestry; this applies to both Codex and top-level Claude
  Code chats. No equivalent Linux package contract is known.
- Not on Linux: the Conductor badge on Codex and Claude Code sessions that run
  in a Conductor workspace. Conductor is a Mac app, so a Linux machine has no
  Conductor sessions; the core's Conductor handling (listing its Codex
  sessions as live, their titles, `host` on session rows) is shared and simply
  never applies here.
- Settings → Relay has **Show me relay messages in full**
  (`show_relay_messages`, off by default), as on the Mac: relay messages are
  hidden from Codex app chats, and a terminal Codex or Claude Code session,
  which only accepts visible text, shows a two-line pointer naming the sender
  and the packaged probe's `relay read <ref>`, which the agent runs to read
  the message. The agent still gets each message in full and can reply;
  the setting only changes what you see.
- Settings → Relay has **New agents join #general** (`auto_join_general`, off
  by default) and, once an agent has changed a setting on the session socket
  (`PATCH /settings`), **Changed by agents** with the latest changes, as on
  the Mac.
- Not on Linux: putting Claude desktop app chats on the relay automatically.
  Claude's desktop app has no Linux build, so the shared check (a
  `claude-desktop` session under this user's `Claude.app`) never matches here.
- Not on Linux: the *Conductor Codex chats* row (`codex_stop_hook`), which
  adds Agent Relay's Codex Stop hook so relayed messages show in Conductor's
  Codex chats. The core reports it only where Conductor's data directory
  exists, which is never on Linux.
- Sign-in in the browser sharing only the sessions you choose, as on the Mac
  (nothing uploads until a session's Upload switch is on). The sign-in panel shows
  **Get your agents on the relay** followed by **Sign in with Google**, with
  direct-delivery preferences in Settings; Messages with
  several conversations, each saying whether its recipient runs (**Queue
  Anyway** for one that does not), what Relaycast holds for the last message
  sent and whether a reply is expected; Recent Messages; a tray menu counting sessions receiving messages and local only, and
  uploaded and not, each opening the session list with that search, with
  All sessions, Settings and Quit controls; `agentrelay://connect` and `agentrelay://message?to=agent%40machine`
  links.

Codex app-server and desktop-window messages stay pending while the current
turn runs. After it finishes, delivery starts a separate turn; peer messages
and incoming cloud messages use the same idle check on macOS and Linux.
Waiting does not consume a send attempt. Live terminal sessions continue to
use Codex's own queue, which waits for the current turn to finish. Conductor's
existing Stop-hook delivery remains a separate host-specific route.

## Controls answer at once

Every control that changes the core (the upload policy, pause and resume,
retry and compact, Settings switches, launch at login, renaming an agent or
putting a session on the relay under a name, sending a message, Codex thread
sharing and held-message approvals, Claude Code delivery choices, releasing a
fleet worker) shows the change the moment it is made, as on the Mac: the
intent is kept beside the core's last answer and drawn over it until the core
confirms it. A refused change goes back to what the core reports and its
reason shows beside the control; clicking again while a change is still
saving makes the last click win. `docs/workspace-layout.md` describes the
pattern and `probe/src/linux_app/models/pending.rs` holds the shared state.

## How it runs

`agent-relay-desktop` is a Rust binary: the probe crate's
`agent-relay-desktop` built with its
`gtk` feature (GTK 4.6 or later, no libadwaita, a StatusNotifierItem tray).

- **With a display:** `agent-relay-desktop` opens the app. It connects to the core on
  `~/.agentworkforce/desktop/core.sock` (`AGENT_RELAY_CORE_SOCKET` names
  another). When no core answers, it starts the `agent-relay.service` systemd
  user unit if the person enabled it; the unit keeps agents connected and
  uploads running after the app quits and starts it at login, as the Mac's
  LaunchAgent does, and Settings › General offers to turn it on if needed. An
  enabled unit owns the socket: when systemd cannot confirm its start, the app
  waits for it and never starts a second core beside it. Otherwise the app
  starts its core as its child. **Keep agents connected after quitting** (on
  by default, as on the Mac) leaves that core running when the app quits, and
  the next launch connects to it; one left running from before an update is
  stopped and replaced. Turned off, quitting stops the core with
  `daemon.shutdown`, and turning it off while the unit runs first asks to turn
  the unit off (`systemctl --user disable --now`), since that is the person's
  choice to stop agents when the app quits. `--background` starts in the tray.
- **Headless (SSH, tmux, servers):** the systemd user unit runs the core
  directly, with no GTK:

  ```sh
  systemctl --user enable --now agent-relay.service
  /usr/lib/agent-relay/agent-relay-probe relay call status.get --json
  ```

  `agent-relay-desktop --headless` runs the same core in the foreground. Headless
  startup applies the agent-led defaults: Claude Code direct delivery,
  automatic activation, and uploads of only the sessions you choose (sharing
  mode `selected`), so nothing uploads until a session is chosen. An install
  that already has a sharing mode keeps it.

However it runs, the core starts its session collector (`agent-relay-probe
run`), which reads local sessions, lists them and uploads the ones being
shared, at nice 19, so it yields to everything else; the core itself, and the
agents it starts, keep normal priority. Unlike the Mac's *Agent Relay Helper*
and *Agent Relay Helper (Sessions)*, both keep the name `agent-relay-probe` in
process lists: it is the installed file the service unit, the updater and
agents' commands name.

The app runs the first core of: `RELAY_DESKTOP_PROBE` (when non-blank),
`agent-relay-probe` beside its executable (a cargo build), and
`usr/lib/agent-relay/agent-relay-probe` in its install tree.

The window is `probe/src/linux_app/ui`; everything it runs on is the rest of
`probe/src/linux_app`:

| Module | What it is |
|---|---|
| `ui/app.rs` | The application: lifecycle, core events, sign-in, links, the tray's actions, dialogs |
| `ui/capy_spawn.rs` | The Cloud-backed Start Capy thread form, progress, binding follow-up and Message action |
| `ui/state.rs` | What the window shows, as data: the screen, navigation, the core's answers |
| `ui/shell.rs` | The global header, settings sidebar, page heading and status bar |
| `ui/relay.rs` | The listings every surface shares, and switching sessions on the relay |
| `ui/settings_page.rs` | Every Settings pane, the background service and software updates |
| `ui/pages.rs` | The four pages' roots in the page stack, and what a redraw keeps (an agent's tools, open conversations) |
| `ui/agents_page.rs` | My agents: sessions with their relay switch, details and per-agent tools, fleet workers, agents on other machines; the roster rows, overview card and banners Team reuses |
| `ui/sessions_page.rs` | Local session table, Cloud-style grouping and filters, relay/upload controls; upload diagnostics used by Settings |
| `ui/transcript.rs` | A local session's transcript and its sidebar |
| `ui/spawn_join.rs` | A spawned agent's live transcript and message box, and opening its session |
| `ui/spawn_take_over.rs` | Taking a spawned Claude over: stopping it headless and resuming it in Terminal |
| `ui/setup_cards.rs` | The Sessions page's Capy and Devin setup cards |
| `ui/core_settings.rs` | Reading and changing the core's settings for Settings and the setup cards |
| `ui/team_page.rs` | Team: a card per teammate with their running agents on the relay |
| `ui/messages.rs` | Messages (open conversations, the recipient's state, Queue Anyway, what Relaycast holds for the last message, whether a reply is expected) and Recent Messages |
| `ui/widgets.rs` | Shared rows, banners, settings rows, avatars, marks and dots |
| `ui/theme.rs` | The light and dark palettes and following the desktop's color scheme |
| `ui/tray.rs` | The tray menu, served as a StatusNotifierItem |
| `ui/desktop.rs` | Opening links (`xdg-open`), notifications, dialogs and quitting |
| `bridge.rs` | The bridge client: NDJSON JSON-RPC, the handshake, events, pooled calls, reconnecting |
| `host.rs` | Starting the core as the app's child when no other answers |
| `service.rs` | The `agent-relay.service` systemd user unit |
| `install.rs` | The install tree and which core the app runs |
| `updates.rs` | Checking for, verifying and installing releases; the app launcher entry |
| `prefs.rs` | The app's own preferences (`~/.config/agent-relay/desktop.json`) |
| `models/` | Wording, states and filters, ported from the Mac's `RelayDesktopCore` |
| `fake_core.rs` | An in-process fake of the core, for tests and `agent-relay-fake-core` |

GTK owns the main thread and every widget; the bridge and the tray run on a
tokio runtime, and each answer is awaited on the GLib main context, so the
window's state is touched only on the main thread. The artwork in
`probe/resources/linux` and `assets/agent-relay-wordmark.svg` is embedded in
the binary.

Updates: a per-user install under `~/.local/lib/agent-relay/<version>` updates
itself (download, SHA-256 check against the release, unpack beside the running
version, repoint the systemd unit, restart). A `.deb` install downloads the
verified package for the system package manager.

The first release whose app is named `agent-relay-desktop` needs a one-time
manual upgrade from an older per-user tarball install: the old in-app updater
requires `usr/bin/agent-relay` in the downloaded tree, which the renamed
package deliberately no longer provides. Install the new `.deb`, or download
and unpack the new tarball as described below. In-app updates work normally
again after that release. Existing `.deb` installs can upgrade through apt.

App launcher: a per-user install lists itself in the desktop's app launcher
with `~/.local/share/applications/agent-relay.desktop` (under
`$XDG_DATA_HOME` when set) and its icon. The entry runs the install's
`usr/bin/agent-relay-desktop` by its full path, because the npm Agent Relay
CLI is also named `agent-relay`. An update writes it for the new version, the
app refreshes it whenever a per-user install starts, and
`agent-relay-desktop --install-launcher` writes it without opening the window,
for a headless or scripted install. Started from the `.deb`, the app removes
the per-user entry a former per-user install left, which would hide the
package's own. An entry not written by the app is left alone.

The shared probe automatically recovers a rotated Cloud workspace key when
Relaycast rejects it: refresh the app's retained Cloud session, resolve the same
workspace and origin, and verify the replacement with one safe read before saving
it. Sign-out or a changed workspace cancels recovery. Failed writes are not replayed.
macOS uses this same core behavior.

## Headless install or update

On a server, or any machine without the app, one command installs the
GTK-free core for the current user and runs it as `agent-relay.service`; run
it again to update:

```sh
curl -fsSL https://github.com/AgentWorkforce/relay-desktop-releases/releases/latest/download/install.sh | bash
bash linux/install.sh --version 2026.10.34   # a given release
bash linux/install.sh --rollback             # back to the previous one
bash linux/install.sh --dry-run              # say what would change
```

It finds what is installed (its own `~/.local/lib/agent-relay/current`, the
app updater's per-user layout, or the `.deb`, which it leaves to apt), downloads
`AgentRelay-<version>-Linux-<arch>-probe.tar.gz`, checks it against the
release's `.sha256` and that the binary reports that version, and switches
`current` to it. It then restarts the service and waits for the core to
answer with the new version, switching back (and dropping the failed version)
if it does not, or if systemd refuses to start it. Moving over from the app
updater's layout keeps that core as a version, so `--rollback` can go back to
it. Three versions are kept. Settings, sign-in and agents live in
`$XDG_DATA_HOME/com.agentrelay.desktop` and are never touched; spawned agents
keep running through the restart. It never runs anything as root and does
not enable lingering: on a server it prints the `loginctl enable-linger`
command to run once. Releases carry a checksum, not a signature, so the
checksum proves the file is the published one, not who published it.
`scripts/test-linux-install.sh` runs it against a fake release server.

## Run from source

The app needs GTK 4 and `pkg-config`. Cargo builds the core beside it, which
it runs when no other core answers:

```sh
sudo apt install libgtk-4-dev pkg-config librsvg2-common
cargo build --manifest-path probe/Cargo.toml --features gtk --bin agent-relay-desktop --bin agent-relay-probe
probe/target/debug/agent-relay-desktop
```

`agent-relay-fake-core` stands in for the core, for a look at the app with no
account:

```sh
cargo build --manifest-path probe/Cargo.toml --features gtk --bin agent-relay-desktop --bin agent-relay-fake-core
AGENT_RELAY_CORE_SOCKET=/tmp/fake-core.sock RELAY_DESKTOP_PROBE="$PWD/probe/target/debug/agent-relay-fake-core" probe/target/debug/agent-relay-desktop
```

`--background` starts it in the tray. On macOS (`brew install gtk4
pkg-config`) it builds and runs for development, without a tray.

## Tests

`probe/src/linux_app` (the bridge client, core hosting, the systemd service,
preferences, updates and wording) and the `agent-relay-desktop` binary are tested with
the probe, against an in-process fake core and `agent-relay-fake-core`;
`linux_package` builds the package from stand-ins and installs it with the
updater:

```sh
cargo test --manifest-path probe/Cargo.toml --locked linux_app
cargo test --manifest-path probe/Cargo.toml --locked --test linux_app_hosting --test linux_package
```

The window's tests (`probe/tests/linux_app_gtk.rs`, the pages' cases in
`probe/tests/linux_app_gtk/pages.rs`) drive the real widgets against the
in-process fake core. GTK must run on the main thread, so the target has its
own `main` and runs each case in turn; it needs a display (`xvfb-run -a` on a
server):

```sh
cargo test --manifest-path probe/Cargo.toml --locked --features gtk --lib linux_app::ui
xvfb-run -a cargo test --manifest-path probe/Cargo.toml --locked --features gtk --test linux_app_gtk
```

`linux_app_core_e2e` drives a built core with the app's bridge client, and
runs `agent-relay-desktop --headless`, against fake Relaycast and Cloud in an empty
home; it runs when `RELAY_E2E_PROBE` names the core:

```sh
cargo build --manifest-path probe/Cargo.toml --locked --release --bin agent-relay-probe
RELAY_E2E_PROBE="$PWD/probe/target/release/agent-relay-probe" cargo test --manifest-path probe/Cargo.toml --locked --test linux_app_core_e2e
```

No test starts a broker, PTY runtime or agent harness, or reaches a real
Cloud, Relaycast or PostHog.

## Package

`scripts/build-linux.sh --version VERSION --app FILE --probe FILE` assembles a
relocatable filesystem tree from a built app (`--features gtk`) and core, and
produces a `.tar.gz` and, with `dpkg-deb` (or `ar`), a Debian package:

| Path | Is |
|---|---|
| `usr/bin/agent-relay-desktop` | The app; `agent-relay` is reserved for the CLI |
| `usr/lib/agent-relay/agent-relay-probe` | The relay core |
| `usr/lib/systemd/user/agent-relay.service` | The systemd user unit, running the core with `relay serve --headless` |
| `usr/share/applications/agent-relay.desktop` | The launcher entry, with both production and development link schemes |
| `usr/share/icons/hicolor/scalable/apps/agent-relay.svg` | The icon |
| `usr/share/doc/agent-relay/LICENSE` | The Apache License 2.0 the app and core are released under |
| `usr/share/doc/agent-relay/agent-icons-LICENSE.txt` | The license of the bundled agent icons |

Run `usr/bin/agent-relay-desktop` in place or copy the tree under `/`. The
package's `postinst` (`linux/agent-relay.postinst`) has each running systemd
user manager reload, so `agent-relay.service` restarts the installed core. The
package depends on `libgtk-4-1` (4.6 or later), `librsvg2-common` for the
artwork and glibc 2.34 or later. CI and releases build both architectures
natively on Ubuntu 22.04, the oldest GTK the app supports.

Relay-owned model features use authenticated Cloud endpoints. Independently
launched agent CLIs keep their own authentication and environment.

Desktop sign-in reuses an eligible saved session, then the browser's Cloud
session, and opens Google only when needed. **Use another account** opens
Google's account chooser explicitly. Both macOS and Linux use this same
continuation and PKCE handoff without device-code confirmation. Local setup
clients can opt into it with `/setup/sign-in` and `{"flow":"browser"}`; older
and remote/headless setup clients retain device approval by default.

Sessions not on the relay have a **new relay name** field in their details.
**Set Name & Retry** registers the session with the chosen name, including after
a workspace name conflict. Relay names are unique across the workspace.

Global background errors appear as an amber **Needs attention** warning at the
bottom left of the status bar. Hover to read the full message; on macOS, click
to open selectable details. They do not appear as banners in settings.

The welcome screen matches macOS: the Agent Relay logo and wordmark are vertically
centered above the Codex, Claude, Cursor, OpenCode, Grok, Muse, and Devin logos, with Muse
in blue. During startup, **Rounding up your agents** stays on one line beside compact pulsing bars at the content's right edge.
The subtitle rotates every four seconds (unless reduced motion is enabled),
starting with a randomly chosen message. Sign-in appears as soon as
the service supplies its status; session discovery runs in the background.
After 20 seconds without a ready service, the panel offers **Try again** and
**Copy diagnostics** instead of continuing the animation.

### Reading a local session

Click any session row to open its local conversation, whether or not it is uploaded.
Opening the reader uses `sessions.transcript` without enabling uploads or relay registration.
User messages, assistant Markdown, selectable code blocks, and collapsible thinking,
tool activity, and session context share a centered conversation column. Messages
load automatically through the full local transcript. Copy, refresh, and retry
controls remain available.

The session title replaces search in the shared header; there is no separate
transcript toolbar. Back to sessions sits between the wordmark and session title
in the shared header. Matching full-width Open and Refresh buttons live in the
compact right sidebar. The Messaging section groups Receive messages
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

The global header is 64px high with a 32px logo and 24px horizontal gutters,
matching macOS. Search and the Table display icon share that same row. Settings alone has a 244px
sidebar; Back to sessions sits in the global header immediately after the wordmark,
in the same position as on a transcript. Search is
hidden in Settings and transcripts. Both platforms retain native window controls.

The desktop uses the effective Cloud workspace palette from
`cloud/packages/web/app/dashboard/_components/workspace-chrome.module.css`:
light canvas `#f9fafb`, dark canvas `#14191f`, primary `#2d6a9c` / `#74b8e2`,
and row hover `#e7eff7` / `#223e58`. These override the older airframe and
marketing palettes. macOS centralizes the tokens in `CloudTheme.swift`; GTK
uses the matching `LIGHT` / `DARK` palettes in `ui/theme.rs`. The macOS menu-bar panel
also uses these tokens for its canvas, text, hover, and status colors. The Linux
StatusNotifierItem menu is rendered by the desktop shell and follows the shell’s
theme; its protocol does not provide app-controlled menu colors.

Both appearances share Cloud’s 52px session rows, 28px compact filters,
6px group corners, subtle borders, bordered count badges, and muted zebra
stripes. Settings and local conversations use the same surfaces; code blocks
use Cloud’s dark code palette. Light, Dark, and Match system remain available.

Local transcripts hide Codex external-context XML and render embedded image
copies from the private reader cache, matching macOS. Capture requires the
RelayHistory embedded-image release (0.40.0 does not retain image bytes).
PNG, JPEG, GIF and WebP copies up to 1 MiB are supported; reading a local image
does not select its session for upload.

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

The local transcript header includes a compact Codex logo and open arrow with an
**Open in Codex** tooltip and accessibility label (a registered
`codex://` handler, with terminal resume as a fallback), **Open in Terminal**
for Claude Code and Grok, and **Copy resume command**. Resume targets the
original session ID and working directory. A missing directory hides terminal
resume; unsupported sources and Claude cloud sessions have no local resume
action. The launcher tries `xdg-terminal-exec`, `x-terminal-emulator`,
GNOME Terminal, Konsole, Xfce Terminal, then xterm.

**View on web**, below the open action, opens an uploaded session's Cloud page
in the default browser. It is hidden until the session finishes uploading.

A session Agent Relay spawned is joined, never resumed beside its headless
process, as on the Mac ([native-spawn.md](../docs/native-spawn.md#joining-and-taking-over-a-spawned-agent),
`ui/spawn_join.rs`, `ui/spawn_take_over.rs`): its transcript is followed live
with a message box under it, and the agents page links to it with
**Transcript: Join**. A spawned Claude has **Take over in Terminal** in place of
the open action; it asks first (mid-turn, **Take Over After This Turn**, then
**Interrupt Now** while it waits), has the core stop the headless agent and
resumes `claude --resume <id>` in Terminal in its folder. Claude Desktop does
not take sessions over on Linux. A spawned Codex thread has **Open in Codex**
only: Terminal resume is not offered while Agent Relay's Codex app server
hosts it. Any other spawned agent (Grok, OpenCode, Muse, Devin) has no open
action while Agent Relay runs it; it is joined only, with the note "Agent Relay
runs this session. Follow it and message it here; it is not resumed in Terminal
while Agent Relay runs it."

Take-over confirmations remain bound to the original agent when switching
transcripts. Take-over failures stay with their session until another attempt,
so returning to a transcript restores its error without showing it on others.

### Session search panel

Open **Search or filter sessions…** or press **⌘F** on macOS / **Ctrl+F** on
Linux, or press **/** while outside a text field. The search panel groups suggestions under Harnesses, Status, Projects,
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

Claude's **Open in Claude** handoff is macOS-only in Relay Desktop: Anthropic
currently supports `claude --desktop --resume` on macOS and x64 Windows, not
Linux. Linux keeps **Open in Terminal** and **Copy resume command**. A Claude Code
session a headless process holds (`claude -p`, a structured pipe, an SDK run)
has no open action on either platform, because Claude Code refuses to resume a
session something else holds; the note beside it says to run `claude agents`
to find that process, or stop it.

Selected search filters toggle off individually without removing other query
terms. The search bar's × tooltip reads "clear search"; the search panel's ×
closes the panel while preserving the query. Escape also closes the panel.

The session search bar fills the toolbar beside the Table display icon and uses 14px horizontal
and 9px vertical padding. Filter qualifiers appear as chips with a remove ×,
including exclusions and date constraints. Removing a chip keeps other filters
and text, without opening the search panel. Chips scroll horizontally as needed.

**Settings → Opening sessions** provides per-computer **Automatic** and
**Terminal** preferences for Claude Code and Codex, installation status for the
Codex handler, Claude setup guidance, and **Check installed apps**. Automatic
uses the Codex app when a handler is installed and otherwise opens Terminal.
Claude and Grok use Terminal on Linux. The viewer links to this page through
**Opening settings**. Historical local sessions do not reliably distinguish
terminal versus desktop origin; these choices do not guess or rewrite origin.

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

Session controls update immediately: Upload changes serialize only for the same
session, so other rows remain usable and rapid clicks settle on the last choice.
Failures roll back that row and show its error; stale listings cannot undo an
accepted change. The Receives messages orb is gray when offline, yellow while
registering/connecting, and green only when the session and push channel are live.
Clicking it toggles message reception; connecting can be cancelled. Tooltips and
accessible names describe the state/action and explain unavailable controls.

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

If the background service exits unexpectedly, the app shows **Reconnecting** while systemd starts the replacement, or while the app restarts its hosted core when the service was not enabled. Read-only requests interrupted by the exit wait up to five seconds and run again against the replacement. Changes are never sent again automatically, because the old service may have completed them before the connection closed; the app asks the person to check the result before trying again. A service that stays unavailable shows a recovery action. Once the new snapshot arrives, a transient read error no longer keeps the status orange.

The log lives only in memory for the current service run (up to 250 entries; large responses and bridge snapshots are bounded). Credentials and message content are redacted. Relaycast SDK rows contain decoded results or final error details, including HTTP status, request ID, and retry count where available. Successful HTTP statuses and individual SDK retry responses are not exposed by the SDK. Cloud rows include the actual HTTP status. Calls made with a Relay Connect room's credential are labeled Relay Connect instead of Agent Relay, because they use that room's workspace and its limits, not the team's. The log covers the core's Relaycast calls and Cloud HTTP transport, not WebSocket frames or separate upload transports.

Session lists use the daemon's shared snapshot: reopening the app reads cached
rows immediately while live-agent discovery and upload enrichment run in separate
background tasks. A cold daemon seeds rows from the collector's persisted catalog;
global upload status and history requests run independently in both desktop apps.

User-facing messages, help text, and diagnostic service labels use **Agent Relay**.
Relaycast remains an internal provider identifier.

After browser authentication, the welcome screen offers **Choose your workspace** for accounts with multiple workspaces, matching macOS. A single workspace continues automatically. Cancel leaves setup unconnected.

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
