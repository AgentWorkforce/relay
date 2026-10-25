# OpenCode existing-session injection

Agent Relay uses OpenCode's authenticated native server API. It never types
into a TUI. The implementation is `relay::opencode_existing` and is shared by
the macOS and Linux probe core.

An eligible binding names all of these values:

- the Agent Relay workspace;
- the OpenCode session, project, optional workspace, and canonical directory;
- a loopback `http://` listener with an explicit hostname and port;
- the server PID, kernel start time, and local UID.
- the canonical server executable, signed-in owner, and a probe marker hash
  reference (never the marker or Basic secret).

Before every injection the probe checks that the same kernel process still
exists, is the current user, and still has matching `opencode serve
--hostname … --port …` arguments. Basic auth comes from that exact process's
`OPENCODE_SERVER_USERNAME` and `OPENCODE_SERVER_PASSWORD`; credentials are not
stored in the binding, response bodies, journal, receipts, or diagnostics.
The authenticated session response must exactly match every bound identity.
Stale, wrong-owner, wrong-workspace, wrong-session, non-loopback, unauthenticated,
or busy routes fail closed before a prompt is sent.

OpenCode 1.18.34 documents `POST /session/:id/prompt_async`, but its 204 response
only means the HTTP request was accepted. Agent Relay supplies a deterministic
OpenCode `messageID` and treats the message as delivered once the transcript
holds that exact user message and text. The receipt is
`opencode:<that message id>`. The turn it starts is not waited for, so a turn
longer than the receipt window is still delivered, not left in doubt. The
answer is read back separately as the finished assistant message whose
`parentID` equals the injected ID; an unrelated assistant response can never
be taken for it.

The journal is written and synced before the POST, moved to `accepted` after
the 204, and moved to `completed` once the exact user message is read back. A
read that fails or finds nothing yet is retried until the deadline; only a
message that never appears, or appears different, leaves the delivery in doubt.
Each route is serialized. A crash, disconnect, timeout, post-acceptance
cancellation, malformed response, or uncertain provider failure remains
in-doubt and is never resent. Cancellation before the POST is a certain
refusal. Agent Relay does not call OpenCode's session-wide abort endpoint,
because that could cancel a human's concurrent turn.

The default-off `sessions.managed.launch` path, enabled only with
`AGENT_RELAY_ENABLE_MANAGED_OPENCODE=1`, starts `opencode serve` on a random
literal loopback port with random Basic authentication and a probe marker. The
caller cannot supply any of those values. Authenticated readback obtains the
provider project/workspace and exact session before the immutable record is
written. Picker, registration and `LocalInjector` re-read and re-verify that
record; arbitrary existing servers remain unavailable (a plain TUI is reached
through the plugin below).

A spawned OpenCode agent (`spawn:opencode`, see `native-spawn.md`) starts its
server the same way (`relay/opencode_serve.rs`) and seals its binding in the
same registry, marked as spawned (`ManagedSessions::adopt`). Such a binding is
delivered to whatever the flag says, is never a picker row, cannot be taken
over by a managed launch, and is removed when the spawn ends the agent.

On restart, a pending or accepted delivery is never posted again. The adapter
uses readback of its deterministic user message; only an exact match completes
the delivery, while missing, unavailable or ambiguous evidence remains
quarantined in doubt for operator resolution.

## Plain OpenCode sessions: the plugin route

A plain `opencode` TUI opens no port. OpenCode 1.18.3 and 1.18.35 run the
TUI's server in a worker reached by an in-process fetch
(`http://opencode.internal`), and listen on TCP only when the command line
carries `--port`, `--hostname` or `--mdns`. The config keys `server.port` and
`server.mdns` are not consulted for that decision, and nothing records a port
or a password. So no setting in `opencode.json` can make an open TUI reachable,
and the authenticated-server route above never sees one.

OpenCode does load every `*.js` file in its global config directory's
`plugins/` (`~/.config/opencode/plugins`, or under `XDG_CONFIG_HOME`) into
every process it starts, the TUI included, and hands the plugin a client of
that in-process server. Agent Relay's plugin, `agent-relay.js`, is the route:

- **Install.** The plugin is on by default wherever OpenCode has run
  (`SettingsExtension::default_on`, applied once per computer), unless the
  plugins directory already holds a file of that name or the opt-out marker
  below. The *OpenCode sessions* setting (`settings.set` with
  `opencode_plugin`) writes the file and removes it. Turning it off also
  leaves `agent-relay.js.off` beside it, a trace in OpenCode's own directory
  that keeps the default from turning it on again; OpenCode loads only `*.js`
  and `*.ts`, so it ignores the marker. Turning it on clears it. Only a file carrying the
  plugin's `AGENT_RELAY_OPENCODE_PLUGIN=` marker is ever replaced or removed;
  any other file with that name is kept as `agent-relay.js.relay-desktop-backup`
  and put back when the setting goes off. At core start, an installed copy of
  our plugin that differs from this build's (an older `PLUGIN_VERSION`) is
  rewritten, so an update reaches computers that turned it on before; a
  missing file or anyone else's is left alone. The user's `opencode.json` is never
  edited. OpenCode processes started afterwards load it; ones already open are
  listed as needing a restart (see below).
- **Scope.** The plugin route is for a plain TUI, which runs one directory
  instance per process. A process that serves several directories (such as
  `opencode serve` with `--port`) is reached through the authenticated-server
  route above; in such a process the plugin socket reaches only one directory
  instance's sessions.
- **Socket.** Each process listens on `~/.agentworkforce/desktop/opencode/<pid>.sock`
  (mode 0600) after checking that the directory is this user's and mode 0700,
  so the kernel refuses any other user's connection. The path is short because
  a Unix socket path is limited to 104 bytes on macOS. A process the probe
  launched itself (`AGENT_RELAY_MANAGED_SESSION_MARKER`) skips the plugin.
- **Registry.** The process records the top-level sessions it holds in
  `<pid>.json` (mode 0600): ones it created or ran a turn in, and the one it
  was started on. Opening a session publishes no event and the plugin's
  worker does not see the TUI's arguments, so the plugin reads its own command
  line once the server is up: `--session <id>`/`-s` names the session,
  `--continue`/`-c` means the latest top-level session in its directory. A
  session picked inside the TUI is held from its next turn. Subagent sessions are never
  listed. The plugin removes both files on exit and sweeps records of dead
  pids; the probe believes a record only while its pid is alive, this user's,
  an `opencode`/`opencode.exe` executable, and its socket a socket of this
  user's in the private directory.
- **Allow-list.** The socket answers only `GET /session/status` (filtered to
  held sessions), `GET /session/<id>`, `GET /session/<id>/message`,
  `GET /session/<id>/message/<message id>`, and
  `POST /session/<id>/prompt_async` with exactly a `msg_relay_<32 hex>` id
  and one text part, and only for a session that process holds. Every request
  is rebuilt for the in-process server; nothing is forwarded verbatim, and
  everything else is 404.
- **Trust boundary.** The socket is this user's, like the relay-send socket.
  Bun's server exposes no peer credentials, so the plugin cannot tell the
  probe from another process of the same user, and does not try: such a
  process can already read OpenCode's session database and transcripts under
  `~/.local/share/opencode` and prompt any session with `opencode run
  --session`. The allow-list keeps what the socket adds to that small: read
  the sessions that process holds, and add one text prompt to one of them.
  Another user is refused by the kernel. The probe, which does read peer
  credentials, never talks to anything but the exact plugin process.

Delivery uses the same `relay::opencode_existing` injector, journal,
deterministic message id and receipt as the managed route. The binding's endpoint is `unix:<socket>`. Before every request the
probe proves the pid, its kernel start time, uid and trusted executable, the
socket directory's owner and mode, and the socket's exact inode, which the
credential reference pins, so a plugin that restarted is a different route.
On each connection it reads the kernel's peer credentials (`SO_PEERCRED`;
`LOCAL_PEERPID` and `getpeereid` on macOS) and refuses unless the peer is this
user and the pid the socket is named for. A session held by more than one live
process waits instead of guessing which one runs the turn.

Agents are added as `opencode-open` sessions, pinned to their session id, and
never auto-activated. `AGENT_RELAY_ENABLE_OPENCODE_OPEN=0` turns the route off.

**Replies.** OpenCode calls its plugins' `shell.env` hook with the session id
before it runs a shell for that session: the bash tool and a typed shell
command. The plugin sets `AGENT_RELAY_OPENCODE_SESSION` to that id, as Grok sets
`GROK_SESSION_ID`. On the relay-send socket, that variable names the caller only
after the probe walks up from the calling process to the nearest OpenCode
process of this user, and that process's plugin record holds the session. The
process must also still be the same afterwards. macOS shows no other process
the environment of an Apple binary such as `/usr/bin/curl` or `/bin/zsh`, so
there the reply and agents commands run the probe executable (`relay
socket-request`), whose environment can be read, as for a Codex app-server
thread. A caller under OpenCode whose variable cannot be read is the one
session that OpenCode process holds, and nobody when it holds several or none:
the walk never passes an OpenCode process to name an outer Claude Code or Codex
session. An agent started inside another inherits its session variables, so
the variable of the nearest agent above the caller decides: under OpenCode, an
inherited `CODEX_THREAD_ID` or `GROK_SESSION_ID` is ignored, and under a Codex,
Grok, Muse or Claude Code session started from an OpenCode shell, an inherited
OpenCode tag is ignored. So a registered session whose
plugin process holds it is given the same reply and agents commands as Claude
Code, Codex and Grok, and answers as the agent it is registered as. Where it
replies itself, the automatic answer read back from the transcript is the
fallback, as for those sessions.

**Needing a restart.** An OpenCode TUI of this user's that runs without the
plugin, because it started before the plugin was installed, is listed as a
row that is not live: the top-level session most recently updated in its
working directory, read from OpenCode's `opencode.db` (read-only). Adding it is
refused with a request to restart OpenCode.

Live proof on macOS, OpenCode 1.18.3 and 1.18.35: the plugin loaded in a plain
TUI from the global `plugins/` directory, the allow-list returned 404 for
`POST /session` and `GET /config`, and a `prompt_async` with a `msg_relay_` id
produced an assistant message whose `parentID` was that id, `finish=stop`, with
the answer text read back over the socket.

Live proof of the whole path on macOS, OpenCode 1.18.35, with this build run as
an isolated core: the plugin was turned on by default at core start; a plain
`opencode` was listed and added as an agent; a relay message landed in it and
its answer came back on the relay as the agent; a TUI restarted with
`--session` received the next message (a 41-second turn, settled about a
second after the POST, the answer sent when it finished); and a process killed
after OpenCode accepted a prompt, before replying, left the delivery in doubt,
with that message in the transcript exactly once and never posted again.
