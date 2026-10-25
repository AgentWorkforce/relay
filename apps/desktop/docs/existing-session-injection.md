# Existing-session injection adapters

The desktop's delivery runtime is the Rust `agent-relay-probe` core on macOS
and Linux. `probe/src/relay/existing_session.rs` provides an explicit adapter
boundary for sessions running outside the Relay broker. OpenCode is exposed
only through the probe-owned managed-launch path described below. Grok has
that path too, and an on-by-default route to the leader a Grok TUI runs on in
leader mode. The managed rollout gate defaults to empty, so current Claude
and Codex delivery is unchanged.

| Provider | Eligible route after explicit enablement | Current exposure |
|---|---|---|
| Devin | Local CLI session: the `devin` process's held `session_locks/<id>.lock` proves identity. Delivery writes a `session/prompt` frame into the session's `acp` stdin pipe through `/proc` when reachable — an immediate user turn that wakes an idle session (Linux terminal sessions only; macOS has no `/proc`, and Devin Desktop's `acp` talks over a socketpair, so those sessions queue until the next boundary) — else stages a file into `relay/inbox.d`, which Agent Relay's managed lifecycle hooks in `~/.config/devin/config.json` (`devin_direct_delivery`) drain into the conversation at the next hook boundary. Cloud sessions (`devin-*`), including sessions displayed in Devin Desktop and outpost-placed sessions running on a local machine: official v3 organization session-message API | Local discovery, caller identification, registration, pipe/inbox delivery and managed hooks; cloud adapter for `devin-*` sessions |
| OpenCode | Probe-launched authenticated loopback server | Default-off managed picker and injector |
| Grok | Probe-launched ACP leader and private Unix socket; or the leader a `grok --leader` TUI spawns | Default-off managed picker and injector; on-by-default `grok-open` listing, binding on add, and injector |
| OpenClaw | Loopback operator client of the person's OpenClaw Gateway; one session per relay sender ([openclaw-hermes-delivery](openclaw-hermes-delivery.md)) | On wherever OpenClaw is set up (`openclaw_gateway`) |
| Hermes | Hermes's loopback API server, `/v1/runs` with durable keyed admission; one session per relay sender | On wherever Hermes has run (`hermes_agent`); listed while the API answers |
| Pi | Bundled extension loaded with `/reload` in an existing persistent UI session; private per-runtime inbox ([Pi delivery](pi-existing-session-injection.md)) | Default-on installation where Pi exists, live discovery, pinned registration, history-confirmed delivery and final answers |
| Any legacy TUI | None | Rejected |

The [Devin v3 OpenAPI contract](https://docs.devin.ai/v3-openapi.yaml)
documents `GET /v3/organizations/{org_id}/sessions/{devin_id}` and
`POST /v3/organizations/{org_id}/sessions/{devin_id}/messages` with a `message`
body. The POST has no documented idempotency key. The adapter therefore checks
the exact organization, session and owner with the same bearer before POST;
the caller creates and syncs an in-doubt journal record before any POST. A
timeout or uncertain response stays in doubt and is never resent. Only an
exact successful session response produces a receipt. Redirects and ambient
HTTP proxies are disabled; errors exposed to the desktop are fixed codes,
never response bodies or credentials.

The v3 route cannot address local `devin-local` sessions (the `windsurf`
backend a terminal `devin` or Devin Desktop runs): they are not registered
in the organization session list — `GET .../sessions?origins=desktop|cli`
and `session_ids=<local id>` both return empty for them — and no public API
maps a local session id onto a remote one. Those sessions therefore remain
pipe/inbox-only. This is an upstream boundary, not a gap Agent Relay can
close: a first-party channel (a `devin acp` inbox socket like Claude Code's
per-session peer inbox, an `inbox.d` watch, or a `devin prompt --session`
command) would make idle local sessions wakeable everywhere.

[OpenCode's server contract](https://opencode.ai/docs/server/) documents an
HTTP session prompt route and optional basic authentication. An arbitrary
OpenCode TUI chooses a random server port, so a title or transcript ID alone
does not establish an authorized endpoint. Keystrokes into legacy terminals
are never a fallback.

`sessions.managed.launch` is available only on the core's private local RPC
socket (0700 parent, 0600 socket, kernel peer-UID check). Its request contains
only provider kind, executable, directory and requested provider session ID.
It does not accept an endpoint, PID, socket, provider workspace, credential,
credential reference or prebuilt binding, and unknown fields are rejected.
The route is separately default-off for each provider:

- `AGENT_RELAY_ENABLE_MANAGED_GROK=1`
- `AGENT_RELAY_ENABLE_MANAGED_OPENCODE=1`

When enabled, the probe canonicalizes a trusted executable and directory,
launches the provider endpoint with a random probe-only marker (and random
OpenCode Basic authentication), verifies PID/start/UID/executable/arguments,
verifies the socket peer or literal loopback endpoint, and loads/reads the exact
provider session. Only then does it atomically persist a private immutable
binding of provider, Relaycast workspace, signed-in owner, UID, session,
endpoint/socket and process identity, plus a hash reference to the marker. Raw
markers and Basic credentials are never written. The picker lists only enabled,
live records from that registry; registration repeats the workspace/owner/UID
check, and `LocalInjector` refuses a route absent from it. Restart reloads and
re-verifies the same records. Editing, replacing, making unreadable or making
non-private any record hides it and disables injection rather than adopting a
replacement process.

Grok also has a second route, for the leader Grok spawns when a TUI runs in
leader mode (or one the person started). It is on unless
`AGENT_RELAY_ENABLE_EXISTING_GROK=0`, and has its own registry and journal.
Live Grok TUI sessions are listed from Grok's own `active_sessions.json`, and
a Grok session Paseo drives with `grok agent stdio` is listed from that
process and the session id Paseo recorded for it. Adding one binds the leader
that client is attached to. A client started with `--no-leader` is listed and
is not bound, so the message is not delivered to a different Grok process. The
already-open authority accepts only a leader *without*
the managed marker, so it cannot adopt a managed leader. A session that both
routes claim is neither listed nor delivered to. See
[Grok existing-session injection](grok-existing-session-injection.md#already-open-leaders).

The requested executable path itself must have the exact leaf name `grok` or
`opencode` before canonicalization. A correctly named symlink may resolve to a
trusted installation, but wrapper names and versioned shims such as
`opencode-1.18` are deliberately rejected.

Before enabling a provider, the core must bind the Relaycast workspace and
registration to an immutable provider session, endpoint, owner and local
credential reference. The provider adapter must recheck those values before
sending. The journal uses a private 0700 directory, 0600 records and locks,
`O_NOFOLLOW`, an exclusive per-session lock, a synced pending record before
sending, and a synced receipt before returning `Delivered`. Future Relaycast
wiring must acknowledge only after that return. A corrupt or unreadable record
fails closed. For OpenCode, an in-doubt record is reconciled only by readback
of the exact deterministic user message and correlated terminal assistant
response. For Grok, which has no idempotent prompt/readback contract, an
in-doubt record stays quarantined for operator resolution. Neither path
automatically resends.

## OpenCode port selection

`opencode serve` binds its own listener from `--hostname` and `--port`; it
has no interface for adopting an inherited socket. The probe therefore asks
the kernel for a free `127.0.0.1` port, releases it, and passes the number to
`opencode serve`. Between that release and OpenCode's bind, another local
process can take the port:

- Such a squatter never receives the Basic credential. Every authenticated
  request first proves that the exact recorded OpenCode PID owns the
  listening socket on that port.
- A launch whose OpenCode process exits before its endpoint verifies is
  retried on a fresh port. A launch makes at most three attempts, and all of
  them share one 60-second deadline. An attempt whose process stays alive
  but never verifies uses the remaining deadline, and the launch then fails.
- A squatter can therefore make a launch fail, never take over its route.

## Registry and runtime files

- The registry is versioned. A v1 registry, whose Grok records carry two
  `provider` keys and cannot be decoded, is moved aside as
  `bindings.json.bak-<time>-<random>`. Before it is moved, each provider it
  names is sent `SIGTERM` if the kernel still reports that exact PID, start
  time and uid, because with no v2 record nothing can reach or relaunch it.
  The signal is best effort and its exit is not awaited: a launch of the same
  session immediately after the quarantine can briefly run beside the exiting
  provider, and a provider that ignores `SIGTERM` keeps running unrecorded.
  Waiting for exit before quarantining is not done yet. The
  provider's own session data stays, and a launch loads it again.
- Any other unreadable registry — a digest mismatch, a truncated file, an
  unknown version — stays in place and fails closed: the picker is empty,
  launch and injection report the registry unavailable.
- Grok leader sockets live in the registry's `run/` directory, or, when that
  path is too long for a Unix socket, in `/tmp/agent-relay-managed-<uid>/`.
  Each Grok launch sweeps both. A `grok-<id>.sock` and the lock Grok keeps
  beside it are removed only when no record with a possibly-live leader names
  them, they are older than ten minutes, and the socket is absent or refuses
  connections.
- Delivery journals write each record through a temp file,
  `.<digest>-<random>.tmp`, renamed into place. Opening a journal removes
  such temp files older than one hour; a crash between write and rename
  leaves the record they would have replaced authoritative.

## Open decision: registrations after a managed relaunch

A managed registration stores its target and the authority it verified, not
the provider process. Delivery resolves the target's live binding at send
time, so after a permitted relaunch (old provider positively gone; same
workspace, owner and uid) the registration follows the new provider. The
already-open Grok route instead pins each registration to the exact binding
it verified (`routeBinding`); after a rebind that agent is refused until it
is removed and added again.

Recommendation: pin managed registrations the same way. The relaunch rule
already guarantees the same authority, so following it is not an authority
escalation; the cost of following is that queued messages for a provider
that died are delivered into a fresh process whose conversation context may
differ from what the sender saw. Pinning makes that boundary visible and
gives both Grok routes one rule, at the cost of an explicit re-add after
every relaunch. This awaits a product decision; the current behaviour is
follow-the-relaunch.

## Operational limits

- A record is eligible for removal and relaunch only when the kernel
  positively reports that its exact provider PID/start identity is gone and
  the new request repeats the exact Relaycast workspace, signed-in owner and
  UID authority. Lookup/readback failures do not make the binding replaceable;
  a different authority cannot inherit the provider session. Removal precedes
  provider startup, so a failed relaunch leaves no live record rather than
  restoring stale authority.
- Picker liveness re-runs provider verification (including a Grok ACP client
  inspection) with a five-second bound; verification is not cached yet.
- A crash after a journal claim but before a provider can prove acceptance is
  reported as in-doubt and quarantined. This prevents a duplicate send, but
  an operator must reconcile or remove the private receipt before retrying.
- The Grok Unix peer check proves the owning UID and the pid holding the
  socket's listening end (`SO_PEERCRED` on Linux, `LOCAL_PEERPID` on
  macOS), and the binding separately proves the exact leader
  PID/start/executable and socket inode. An old leader that outlived the
  replacement of its socket file therefore no longer proves a binding.
- Shutdown signals the reverified provider leader. Descendant process-group
  cleanup is provider-owned and is not yet enforced by the probe.
- The registry SHA-256 digest detects corruption; it is not a keyed
  authenticity primitive. Security comes from the private directory/file
  permissions plus live kernel, credential-marker and provider readback
  verification.
