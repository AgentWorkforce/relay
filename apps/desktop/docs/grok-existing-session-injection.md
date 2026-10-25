# Grok existing-session injection

The Rust desktop core can deliver one message into a Grok session owned by an
exact resident ACP leader. Two separate routes produce that leader binding.
The managed bridge, default-off, launches the leader itself. The already-open
route, on by default, binds the leader Grok itself spawns for a TUI running in
leader mode, with immutable proof. Neither route adopts a TUI by title or
sends terminal keystrokes.

A plain `grok` TUI opens no socket at all, so nothing can be delivered to it.
It does record itself in `<grok home>/active_sessions.json` while it runs,
and that record is how the desktop lists it. With `[cli] use_leader = true`
in Grok's `config.toml` (the desktop's *Grok sessions* setting writes exactly
that line), or `grok --leader`, the TUI spawns a shared `grok agent leader`
on `<grok home>/leader.sock`, and a second ACP client can load and prompt
the TUI's own session through it. The injected turn renders in the TUI.

The route binds all of the following before a send: Relay workspace and owner,
local uid, Grok session ID, canonical working directory, model, Grok executable,
leader pid and kernel start identity, and Unix socket path/device/inode. The
kernel and filesystem evidence is checked before `session/load` and again
immediately before `session/prompt`.

The transport starts an isolated ACP stdio proxy against that exact leader,
initializes protocol version 1, loads the exact session, and sends one
`session/prompt`. It treats neither `activity=working` nor an open request as a
receipt. Within the receipt window, delivery is confirmed after an
`agent_message_chunk` plus both the prompt-complete notification and caller
result identify the same prompt, end with `end_turn`, and retain the pinned
model. A working turn outlives that window: when the leader's
`_x.ai/queue/changed` has named our exact prompt text under a server prompt
id, the message is in the session and the turn runs on without the caller,
so that too is delivery, with that prompt id as the receipt. Only a prompt
the queue never showed stays in doubt.

Grok 1.0.46 does not deduplicate a caller-supplied prompt ID. A disconnected
caller also does not cancel the model turn. Therefore the desktop fsyncs a
private pending record before sending, serializes each bound session, replays a
confirmed receipt without contacting Grok, and permanently leaves an uncertain
send in doubt. It never blindly resends. Mid-turn injection is refused by the
same per-session serialization boundary.

`_x.ai/mcp/servers_updated` can contain environment values. The ACP decoder
drops that notification wholesale before any diagnostic surface can observe
it. Provider frames, stderr, prompts, credentials, paths, and raw errors are
never copied into activity diagnostics.

Live disposable proof against Grok 1.0.46 established:

- a second ACP client can load and prompt the holder's resident session;
- model consumption is the prompt-scoped agent message chunk;
- completion requires the matching `prompt_complete` and JSON-RPC result;
- repeated text and repeated caller prompt IDs create new turns, so retry is
  unsafe;
- concurrent prompts overlap at the provider, so the adapter must serialize;
- client death does not cancel a consumed turn;
- leader death after consumption produces no reliable receipt and remains in
  doubt.

The binding producer is `sessions.managed.launch`, gated by
`AGENT_RELAY_ENABLE_MANAGED_GROK=1`. It accepts no socket, pid, credential or
prebuilt binding. It launches the leader on a probe-private socket with a
random marker, performs kernel/socket peer verification and `session/load`
readback, then persists the record. The picker and registration use only that
record and repeat live authority checks. Hosted and disposable live validation
remains required before the PR is made ready; the flag remains off by default.

## Already-open leaders

The second route is on unless `AGENT_RELAY_ENABLE_EXISTING_GROK=0`. It does
not depend on the managed flag. Its sessions have their own target kind,
`grok-open`. Managed sessions keep `grok`. A registration's kind therefore
names its route for good: a `grok-open` agent is never delivered through a
managed leader, and a `grok` agent never through an already-open one. This
holds even after its own binding is lost and the other route has bound the
same session id. Its bindings and receipts live in the app data
directory under `existing-grok-sessions/`. They are never written to the
managed registry, and never to the `agent-relay` CLI's home.

- **Listing.** `sessions.list` reads Grok's own `active_sessions.json`
  (`GROK_HOME`, else `~/.grok`) and lists each record whose pid is alive and
  this user's as a `grok-open` row, titled from Grok's `summary.json` when it
  has one, else from the directory. A Grok session Paseo starts is not in
  that file: Paseo runs `grok agent stdio` under its daemon. That process is
  listed too, as `grok-open` with host `paseo`, when it is this user's
  packaged Paseo helper's descendant, its `PASEO_AGENT_ID` record names one
  Grok session id for `PASEO_AGENT_CWD`, and the session directory exists in
  that process's own Grok home (`GROK_HOME`, else `~/.grok` of its `HOME`),
  not the probe's. A session already listed from its
  binding, or claimed by the managed registry, is not listed twice; when the
  managed registry cannot be read, no unbound row is listed. A TUI row is
  live only while an already-open leader of this user is running. A Paseo row
  is live only while that stdio client is attached to a leader that is
  running: the `--leader-socket` it names, or `leader.sock` in its own Grok
  home. A client started with `--no-leader` is listed and is not deliverable,
  so a message is not sent to a different leader. A session already bound to
  a leader is refused the same way while that detached client is still
  running. Otherwise both apps show a row with no leader as needing leader
  mode. A bound row stays live while the TUI registry still lists it, or
  while that Paseo client is still attached to a running leader.
- **Producer.** Adding a row calls `agents.register`, which binds the session
  first when it has no binding, with the directory Grok recorded for it; this
  is the same work as `sessions.existing.register`, which still takes
  `{"kind":"grok-open", "session_id","directory"}` on the private local RPC
  socket. Neither accepts a pid, socket, executable, endpoint, credential or
  binding.
  - The probe looks for a candidate in the kernel's process table: a `grok
    agent leader` process of this user whose environment is readable and has
    no managed marker. Its socket is the one `--leader-socket` in its argv,
    or, for the leader a `grok --leader` TUI spawns, which names none,
    `leader.sock` under the `GROK_HOME` or `~/.grok` of the leader's own
    environment. Two `--leader-socket` arguments name no candidate.
  - Exactly one candidate must pass `ExistingLeaderAuthority`. When several
    do, the probe keeps the one on the socket the session's own client is
    attached to: the `--leader-socket` in that process's argv, else the
    default socket of that process's home. A Paseo client started with
    `--no-leader` is attached to none and is refused rather than bound to
    another leader. Leaders outlive their TUIs, so several open leaders are
    the common case after a few restarts. Anything still ambiguous is refused
    rather than guessed; with none, the refusal says to turn on leader mode.
  - The probe then runs `session/load` of that session in the canonical
    `directory` and reads back the model and version.
  - Only then does it store the binding, together with the signed-in
    workspace and owner.
  - The same bytes may be registered again. Any other binding for that
    session is refused, and the stored bytes stay as they were.
- **Authority.** `ExistingLeaderAuthority` runs the managed route's kernel,
  executable, argv, socket-inode and socket-peer checks. It also requires a
  readable environment without the managed marker, and an `existing:grok:`
  reference to that identity. If the kernel will not show an environment, the
  route treats the marker as unknown, never as absent. Only this authority
  lets an argv without `--leader-socket` prove a binding, and only for the
  default socket of the leader's own environment; the managed authority
  still requires the private socket it launched with.
- **Separation.** The managed authority refuses an `existing:` reference and
  any leader without its marker. Each Grok binding in the managed registry,
  live or not, claims both its session and its leader process. An
  already-open binding that touches either claim is neither listed nor
  registrable. Delivery to it is refused before either route is asked, and
  it does not identify callers. Neither binding is rewritten to settle the
  conflict. If either registry cannot be read, the route reports it
  unavailable rather than assuming it is free.
- **Listing matches delivery.** Each bound Grok row is listed exactly when
  delivery would use it; an unbound row from Grok's registry is listed so it
  can be added, and delivery to it is refused until adding has bound it. The
  bindings directory must be mode 0700, and
  delivery also requires that it can be enumerated. So a registry that can't
  be opened, locked or listed hides every row and makes delivery retry. One
  unreadable binding file hides only its own session, and that session's
  delivery retries. One transient gap remains: an I/O error partway through
  listing empties the picker for that read, while delivery may still
  succeed. It never hides a single session while serving it, and it clears
  on the next read.
- **Liveness and rebinding.** A binding that fails a check is hidden and not
  sent to. It is never deleted. Once its leader process is gone or replaced,
  that is final for the binding. The session can then be registered on a new
  leader, but only with the same workspace, owner and uid, as a managed
  relaunch requires. That is the only time a stored binding is replaced, and
  the replaced binding's reference is kept with the new one as its lineage
  (up to sixteen). Grok replaces its own leader, for instance after an update
  check, so delivery does this itself: a pinned `grok-open` agent whose
  stored leader is proven gone, for a session Grok's registry still lists in
  the stored directory, is rebound to the one open leader before the send.
  While no leader can be bound yet, the message waits; once Grok no longer
  lists the session, it is refused.
- **Agents are pinned to a binding.** `agents.register` stores the live
  binding's `existing:grok:` reference on the registration as
  `routeBinding`. Delivery requires that binding, or one whose lineage
  names it, and the check runs inside the same registry read as the send.
  So a registration follows its session across the rebindings the registry
  itself allowed, and never to a binding of another workspace, owner or uid.
  A registration with no pin is refused, and so is plain delivery that
  names no registration.
- **Delivery.** `LocalInjector` proves the binding again and sends through
  the shared `Coordinator`, with the same journal rules:
  - A confirmed receipt is replayed and is never sent again.
  - A send that may have reached Grok stays in doubt.
  - A registry or journal error before sending is retried.

  Delivery names the session explicitly in `session/load` and
  `session/prompt`, so one leader may hold several registered sessions.
- **Replies.** Grok gives every tool process its session's id as
  `GROK_SESSION_ID`, the way Codex gives `CODEX_THREAD_ID`. On the
  relay-send socket that variable decides the caller alone, once the process
  is proven to run under a `grok agent leader` of this user and Grok's
  live-session registry lists that session for a process of this user's. A
  tool without it under a leader is still nobody: the walk stops at the
  leader, recognised from its argv alone, instead of naming one of its
  sessions or the terminal around it. So a registered `grok-open` session
  receives the same reply and agents commands as a Claude Code or Codex
  session, and can answer on the socket as the agent it is registered as.
  On macOS the commands run the bundled `agent-relay-probe` rather than
  `curl`: macOS hides the environment of Apple's own binaries, `curl` and
  `zsh` included, from other processes, so `GROK_SESSION_ID` could not be read
  from `curl`, and the reply was refused as `not_a_relay_session`.
  The managed route's sessions get none, as nothing lists them. One
  exception comes from main: a process that inherited `CODEX_THREAD_ID` is
  resolved to that Codex thread before the walk. Self-registration and
  Connect stay limited to Codex and Claude Code.
- **Limits.** With more than one already-open Grok leader running and none
  of them on the session's TUI socket, nothing is registered. Close the
  extra leaders, or use the managed route.

## The leader-mode setting

`settings.get` serves `grok_leader` wherever Grok's home exists: whether the
user's `config.toml` sets `use_leader` to `true`, read from `[cli]` or a
top-level `cli.use_leader`. `settings.set` rewrites only that one line, or
adds it under `[cli]` (appending the table when there is none), keeping every
other byte, the file's mode and any symlink, and copying the original once to
`config.toml.relay-desktop-backup`. A file that names the key twice, or has
two `[cli]` tables, is reported as unsafe to change and left alone. Grok's
managed and requirements layers can pin `cli.use_leader`; the setting reads
and writes the user file only. Sessions already open keep running as they
are until restarted, and Grok refuses leader mode under a sandbox profile.

The setting is on by default wherever Grok is installed: the core turns it on
once and remembers that, so a person who turns it off keeps it off (see
[Integrations are on by default](injectable-agents.md#integrations-are-on-by-default)).
