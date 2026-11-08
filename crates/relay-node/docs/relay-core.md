# Relay core

The relay core is the messaging runtime: it finds the coding sessions on this
computer, puts them on the relay, delivers messages into them and sends
theirs. It is Rust, it builds the `agent-relay-node` binary, and it runs as one
long-lived daemon per user:

```sh
agent-relay-node serve [--socket PATH] [--app-data-dir PATH] [--exit-on-stdin-eof] [--headless [--cli-managed]]
```

A relative `--socket` lives beside the default socket and a relative
`--app-data-dir` beside the default data directory, so a launchd property
list names them without `~`.

The Agent Relay site a core talks to is fixed when it is built, from
`AGENT_RELAY_SITE_URL` (`https://agentrelay.com` when unset; an https origin,
or `http://localhost[:port]` or `http://127.0.0.1[:port]` for a site served on
this computer, which is http only), and the scheme of the links it opens from
`AGENT_RELAY_URL_SCHEME` (`agentrelay` when unset; never a web scheme such as
`https`). A value the core could not then trust or parse fails the build. No option, request or
environment variable changes either at run time; a build for another site is
another build.

Clients render the core's state and send it commands over one bridge contract.
`relay init` runs the core headless, and the desktop apps build their own
binary on this crate's library, adding what they need through its plugins
(see "Plug-in points"). A client makes no Relaycast requests, spawns no harness
and reads no agent credentials.

```text
 clients: `relay init`, `agent-relay-node call`, a desktop app
                 │ JSON-RPC 2.0 NDJSON over ~/.agentworkforce/desktop/core.sock
                 │ (on Windows, a named pipe named for that path)
                 ▼
 ┌──────────────────────── agent-relay-node serve ────────────────────────┐
 │ workspace discovery · Relaycast (relaycast SDK) · push channels        │
 │ session discovery · delivery and injection · relay-send socket         │
 │ harness setup · spawning · fleet · Relay Connect                       │
 │ the plugins a build adds                                               │
 └────────────────────────────────────────────────────────────────────────┘
        │ relaycast SDK            │ loopback broker   │ codex/claude
        ▼                          ▼                   ▼
  cast.agentrelay.com        /api/spawned        queue · inbox · CLI
```

## What stays in a client

Code that draws pixels or calls a platform UI API stays in the client:
windows, tray and menu bar, clipboard, opening a browser, notifications and
self-update. The core supplies typed state, never display strings, and emits
`notify` events with their text. A deep link (`agentrelay://`) reaches the
client from the platform; `links.parse` validates it.

## Transport

The bridge is JSON-RPC 2.0, one JSON object per line (NDJSON), on a per-user
Unix socket (on Windows, a named pipe; see **Windows** below):

- **Path:** `~/.agentworkforce/desktop/core.sock`. `AGENT_RELAY_CORE_SOCKET`
  or `--socket` names another; Agent Relay Dev uses `core.dev.sock` and
  `--app-data-dir com.agentrelay.desktop.dev`.
- **Permissions:** the socket is 0600. A directory the daemon creates for it
  is 0700; an existing one (and a symlink naming it) must be this user's and
  writable by no one else, and is never re-permissioned.
- **Admission:** the kernel reports each peer's uid (`SO_PEERCRED` on Linux,
  `getpeereid` + `LOCAL_PEERPID` on macOS). Only this user's processes are
  served; another user's connection is closed without a reply. This is the
  same trust boundary as the 0600 agent store, and no method returns a key or
  token. `call` likewise speaks only to a daemon run by this user.
- **Windows:** the socket path is only a key. The pipe is
  `\\.\pipe\agent-relay-<16 hex digits>` (the start of the SHA-256 of the
  path), created with a DACL that grants only the current user, refusing
  remote clients and a name another process already holds; the lock file
  keeps its path beside it. Clients check that the server is this user's.
  File modes are no-ops inside the user profile.
- **Frames:** UTF-8 lines, not counting the newline. Requests are limited to
  1 MiB; a longer request gets an `invalid_request` error and the connection
  closes. Reply and event readers accept up to 16 MiB per line and reject
  larger frames. These transport limits do not replace smaller method-specific
  page limits.
- **Backpressure:** each connection queues at most 32 outgoing lines. A
  client that stops reading stops being read, and its events lag (below)
  rather than accumulate.

A socket rather than the hosted child's stdio: on Linux the daemon runs under
systemd with no UI attached, and a GTK app attaches and detaches; on both
platforms more than one client (the app, `call`, support tooling) must
reach the same daemon. One transport serves every case.

## Lifecycle

- **Single instance.** `serve` takes an exclusive `flock` on
  `<socket>.lock` (0600) for its whole life. A second daemon for the same
  socket exits 1 with `Agent Relay core is already running for this socket.`;
  its host connects to the running one instead. Holding the lock, the daemon
  replaces a leftover socket file, but never deletes a path that is not a
  socket.
- **The relay CLI.** `relay init` attaches to whichever core answers on the
  socket and starts one only when none does:
  `agent-relay-node serve --headless --cli-managed`. `--cli-managed`
  keeps the app's login entry and turns on no defaults by itself (neither the
  agent-led defaults at start nor the integration defaults of each refresh
  pass); the CLI turns on the delivery settings the person chose through
  `settings.set` and turns them off again on `relay init --uninstall`.
- **Shutdown.** SIGTERM, SIGINT, `daemon.shutdown`, or stdin closing (with
  `--exit-on-stdin-eof`). The daemon publishes the `shutdown` event to every
  greeted client, stops push channels, closes connections, and removes its
  socket only if the inode is still its own.
- **Upgrades.** A client that finds a daemon on another bridge version may
  call `daemon.shutdown` without a handshake; whatever hosts the core starts
  the new binary.

## Protocol

Request: `{"jsonrpc":"2.0","id":1,"method":"status.get","params":{}}`.
A request without `id` is a notification: executed, never answered; an `id`
of `null` is answered with `null`. Batches
are not supported. A connection's requests are answered in order; a client
that must not wait behind a slow call opens a second connection.

Response: `{"jsonrpc":"2.0","id":1,"result":{…}}` or
`{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"…","data":{"kind":"…","retryable":false}}}`.

Every connection sends `hello` first; any other method (except
`daemon.shutdown`) before it fails with `handshake_required`.

### Contract source

The contract is defined once, in Rust: `src/relay/contract` registers
every method with its parameter and result types and every topic with its
payload type; `relay::protocol` holds the envelopes, `ErrorKind` and `Topic`.
The server answers a method only through the registry's typed `answer`, so a
handler cannot return anything but its registered type, and parameters are
read before a handler runs. The Swift client's types are generated from the
registry, never written by hand:

`contract/CoreContract.swift` holds plain `Codable` structs and enums, the
method names (`CoreMethod`), `CoreEvent`, and one typed `CoreClient` call per
pooled method.

`scripts/generate-contract.sh` regenerates it (`cargo run --bin
relay-contract-codegen`). CI runs it and fails on `git diff --exit-code`;
`cargo test` also fails when the file is stale, when a registered method
reaches no handler, when the method names in this document's method tables
differ from the registry, when its error table differs from `ErrorKind` (kinds,
codes and retryability), and when its topic table names other topics. The
tables' parameter, result and payload descriptions are prose, checked by
review. Every enum a client reads accepts a value it does not know, because a
core of another version than the client (normal mid-update, until the client
retires it with `daemon.shutdown`) can send one: Swift reads it as the enum's named
fallback (`x-fallback`) when it has one, else as `unknown(value)`.

A Rust client uses the registry's own types, so every registered type serializes and deserializes, and a test checks
that whatever a reader requires its writer always writes.
`relay::contract::reader` reads results and events from the same schema the
generators use: a field it does not know is ignored, an unknown enum value
reads as the enum's `x-fallback`, and a value of an enum without one is
dropped at the nearest optional field, list element or map entry. The core
still refuses unknown values in parameters.

### Errors

`data.kind` is the stable code clients branch on; `message` is a sentence safe
to show a person. Messages never carry provider bodies, keys or tokens.

| kind                      | code   | retryable | Meaning                                                                                                     |
| ------------------------- | ------ | --------- | ----------------------------------------------------------------------------------------------------------- |
| `parse_error`             | -32700 | no        | The line is not JSON (`id` is null)                                                                         |
| `invalid_request`         | -32600 | no        | Not JSON-RPC 2.0, or the line is too long                                                                   |
| `method_not_found`        | -32601 | no        | No such method                                                                                              |
| `invalid_params`          | -32602 | no        | Parameters do not match the method                                                                          |
| `internal`                | -32603 | no        | A defect in the core, or a Relaycast response it cannot read                                                |
| `handshake_required`      | -32000 | no        | `hello` first                                                                                               |
| `bridge_version_mismatch` | -32000 | no        | Client and daemon speak different bridge versions                                                           |
| `not_signed_in`           | -32000 | no        | No workspace key is known                                                                                   |
| `refused`                 | -32000 | no        | The core refuses on principle (for example a non-https origin)                                              |
| `relaycast_unreachable`   | -32000 | yes       | Relaycast could not be reached or failed on its side (5xx)                                                  |
| `relaycast_refused`       | -32000 | no        | Relaycast refused the request as made (other 4xx, such as 400 or 422)                                             |
| `unauthorized`            | -32000 | no        | Relaycast rejected the credential                                                                           |
| `rate_limited`            | -32000 | yes       | Relaycast is temporarily rate limiting                                                                      |
| `plan_limit_exceeded` | -32000 | no | The workspace's plan cap (devices, agents or humans) is reached; `data.plan_limit` carries `{"limit","max","current","plan"}` when Relaycast sent them |
| `not_found`               | -32000 | no        | Relaycast, or this computer, has no such resource (an address no agent is at, an agent not registered here) |
| `conflict`                | -32000 | no        | A conflicting change (a name taken in the workspace or by another session here)                             |
| `shutting_down`           | -32000 | yes       | The daemon is stopping                                                                                      |
| `busy`                    | -32000 | yes       | Another change to the same agent or session is still running                                                |
| `store_failed`            | -32000 | no        | The agent store could not be saved, so nothing changed                                                      |
| `fleet_unavailable`       | -32000 | yes       | Whether this computer's relay already manages the session could not be read, so it is not registered now    |
| `cloud_failed`            | -32000 | yes       | Agent Relay Cloud (or relayfile) could not be reached or failed                                             |
| `cloud_refused`           | -32000 | no        | Agent Relay Cloud refused the request; `message` is its own text when it sent one                           |

Methods registered `Availability::Account` are in the contract of every build,
so clients see one contract. A core built without an account answers them with
`method_not_found`, as for an unknown name, and `hello` leaves them out.
`status.get`'s `daemon.history_version` is null unless a build reports one. The
workspace the `agent-relay` CLI selects is used without signing in, and
`POST /setup/sharing` answers `setup_unavailable`.

Provider `plan_limit_exceeded` responses (including HTTP 429) are reported
as `plan_limit_exceeded`, with a safe instruction to upgrade the workspace plan
or wait for its quota reset before retrying. Registration and rename failures
retain that explanation alongside the operation context. Ordinary
HTTP 429 throttling remains retryable. Background workspace quota pacing is
unchanged; raw provider response bodies are never shown.

### Versioning

`bridge_version` is `2`. Adding methods, optional parameters, result fields,
topics or error kinds does not change it; clients ignore what they do not
know and feature-detect with `hello.methods`. Removing or renaming anything,
or changing a meaning, increments it. A mismatch means a stale daemon, handled
as above.

### State and events

`sessions.list` overlays current registration and push state onto the last
completed live-discovery pass; reading it never launches discovery.

A client renders one snapshot, returned by `status.get` and by `subscribe`:

```json
{
  "revision": 7,
  "daemon": {
    "version": "2026.10.1",
    "bridge_version": 2,
    "pid": 4242,
    "started_at_ms": 1790683200000,
    "socket": "/Users/a/.agentworkforce/desktop/core.sock"
  },
  "machine": { "host_name": "Alice's MacBook Pro.local", "machine_prefix": "alice-s-macbook-pro" },
  "workspace": {
    "state": "found",
    "base_url": "https://cast.agentrelay.com",
    "workspace_id": "rw_7ccfea89",
    "workspace_name": "Acme",
    "verification": "verified",
    "checked_at_ms": 1790683201000
  },
  "push": {
    "codex-api-3f72": { "state": "live" },
    "claude-web-9a1b": { "state": "waiting", "retry_in_ms": 3712 }
  },
  "agents": { "store_error": null, "delivery_error": null },
  "account": { "state": "signed_out" }
}
```

- `workspace.state`: `missing` | `found`.
  `verification`: `pending` | `verified` | `rejected` | `unreachable`. The key
  itself is never in the snapshot.
- `push.<agent>.state`: `connecting` | `live` | `waiting` (with `retry_in_ms`).
  The signed-in person's own identity has a channel too once messaging is
  used, keyed `@<name>` (agent names never contain `@`).
- `agents.store_error`: why the agent store could not be read (it was set
  aside) or saved. `agents.delivery_error`: the first agent whose delivery
  queue could not be read, and why.
- `account`: `state` is `signed_out` on a core without an account. A build's
  account fills it and the `sign_in` topic. No token is ever in the snapshot.

Events are notifications on the connection that subscribed:

```json
{"jsonrpc":"2.0","method":"event","params":{"topic":"status","seq":12,"data":{…snapshot…}}}
```

| Topic         | data                                                                                                                                         | Notes                                                                                                                                                                                                            |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`      | The whole snapshot                                                                                                                           | After every change. Replace, never merge; ignore one whose `revision` is not newer than what is shown                                                                                                            |
| `activity`    | `{"level":"info"\|"warning"\|"error","message":"…","at_ms":…}`                                                                               | Append-only log lines                                                                                                                                                                                            |
| `shutdown`    | `{}`                                                                                                                                         | Sent to every greeted client, subscribed or not; the connection then closes                                                                                                                                      |
| `invalidated` | `{"what":"sessions"\|"agents"\|"roster"\|"fleet"\|"messages"\|"people"\|"activity"\|"uploader"\|"chat"\|"projects"\|"settings"}` | Re-fetch that collection (2a; `sessions`, `fleet` 2b — compared every 5 s —; `uploader`, `chat`, `projects`, `incoming` 2c; `settings` when an agent changed one through the session socket's `PATCH /settings`) |
| `sign_in`     | `status.account` plus `{"verification_url","verification_url_complete","user_code","expires_at","interval"}` (null when no link is waiting)  | After every sign-in step; the UI opens `verification_url_complete` when it appears                                                                                                                          |
| `notify`      | `{"title","body","link"}`                                                                                                                    | The UI shows a notification; `link` (nullable) opens on click, e.g. a provider's connect page                                                                                                               |

`seq` increases by one per event across all topics, so a client sees gaps
for topics it is not subscribed to. A client that falls more than 256 events
behind skips the backlog: if subscribed to `status`, it receives one fresh
`status` event in its place, and skipped `activity` lines are not resent.

### Methods

**Core**

| Method                 | Params                               | Result                                                                                                                                                    | Lands in |
| ---------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `hello`                | `{"bridge_version":2}`               | `{"bridge_version","daemon_version","pid","methods":[…],"topics":[…]}`                                                                                    | 1        |
| `diagnostics.requests` | —                                    | `{"entries":[RequestEntry]}`; local bounded request log, newest first, redacted request/response, status, timing and stable ID; memory only, no telemetry | 1        |
| `status.get`           | —                                    | The snapshot                                                                                                                                              | 1        |
| `subscribe`            | `{"topics":["status","activity",…]}` | `{"topics":[…],"status":{…snapshot…}}`                                                                                                                    | 1        |
| `unsubscribe`          | `{"topics":[…]}`                     | `{"topics":[…remaining]}`                                                                                                                                 | 1        |
| `workspace.refresh`    | —                                    | `status.workspace` after rediscovery (and verification when the key changed or was unverified)                                                            | 1        |
| `workspace.verify`     | —                                    | `status.workspace`; `GET /v1/workspace` with the key                                                                                                      | 1        |
| `daemon.shutdown`      | —                                    | `{"stopping":true}`; allowed before `hello`                                                                                                               | 1        |

**Agents on this computer**

| Method                                              | Params                                                                                                                                                                                         | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Lands in                                                                                                                                   |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `sessions.list`                                     | —                                                                                                                                                                                              | `{"sessions":[{"target":{"kind":"codex"\|"claude-terminal"\|"claude-cloud"\|"grok"\|"grok-open"\|"opencode","id"},"title","project","directory","live","updated_at_ms","registration":{"name","address","added_by_session","push","spawn"?:{"harness","can_take_over","taken_over"}}\|null,"suggested_name"}]}`; `spawn` is set on an agent Agent Relay spawned here (see `agents.take_over`); a registered session discovery no longer finds is listed with `live:false`; Grok/OpenCode rows come only from the verified probe-owned registry, plus `grok-open` rows from the already-open registry when `AGENT_RELAY_ENABLE_EXISTING_GROK=1`; a Grok session both registries claim is not listed under either kind                                                                                                                                                                                               | 2b                                                                                                                                         |
| `sessions.title.capability`                         | `{"source","session_id"}`                                                                                                                                                                      | `{"supported","reason"}` (`reason` is null when supported); native title-edit support for the exact catalog identity, including history-only rows; unsupported providers or unavailable sessions include an explanation. Available without an account.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | native session titles                                                                                                                      |
| `sessions.title.set`                                | `{"source","session_id","title"}`                                                                                                                                                              | `{"title"}` after the native provider acknowledges the metadata change; trims outer whitespace, accepts 1–200 characters without control characters, and applies provider-specific limits. Uses trusted discovery to resolve the catalog identity; accepts no client paths or endpoints. Publishes sessions/uploader invalidations on success. Available without an account. See native title support (relay-desktop `session-title-editing.md`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | native session titles                                                                                                                      |
| `sessions.managed.launch`                           | `{"kind":"grok"\|"opencode","executable","directory","session_id"}`                                                                                                                            | `{"target","title","directory"}` after the default-off probe has launched/supervised the endpoint and verified OS identity plus provider readback; endpoint, pid, socket and credentials are never accepted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | managed provider bridge                                                                                                                    |
| `sessions.existing.register`                        | `{"kind":"grok-open","session_id","directory"}`                                                                                                                                                | `{"target","title","directory"}` after the default-off probe (`AGENT_RELAY_ENABLE_EXISTING_GROK=1`) has found exactly one marker-free Grok leader of this user from the kernel, proved its executable, argv and socket peer, and read back model/version from a `session/load` of that session in `directory`; a session or leader the managed registry holds is refused; process, socket, endpoint and credentials are never accepted                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | already-open Grok route                                                                                                                    |
| `agents.list`                                       | —                                                                                                                                                                                              | `{"agents":[{"name","address","target","title","registered_at","added_by_session","reply_with_final_answer","webhook":{"id","url"}\|null,"integrations":[{"provider","resource","ready","event_types"?:[]}],"push","delivery_error"}]}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 2a                                                                                                                                         |
| `agents.register`                                   | `{"target":{"kind","id"},"name"?,"description"?}`                                                                                                                                              | `{"name","address","already_registered"}`; a session already registered answers `already_registered: true`; otherwise it must be one `sessions.list` finds live (`refused`); without `name`, its suggested name                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 2a                                                                                                                                         |
| `agents.unregister`                                 | `{"name"}`                                                                                                                                                                                     | `{}`; waits for a delivery in flight; refused while integrations remain                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 2a                                                                                                                                         |
| `agents.end` | `{"name"}` | `{}`; only for an agent this computer spawned and still owns. Holds its action and delivery locks, stops or archives the exact harness session and confirms it ended, then removes its relay name, webhook and integrations. A failed stop keeps the registration and relay resources for retry; a taken-over session is refused because its interactive process belongs to the person. | native spawn |
| `agents.rename`                                     | `{"name","new_name"}` (`name` may be either of the agent's names)                                                                                                                              | `{"name","address","released"}`: the session's new and only name, and the earlier name it replaced; renaming back to the registered name makes it current again                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 2a                                                                                                                                         |
| `agents.test_message`                               | `{"name","text"?}`                                                                                                                                                                             | `{"message_id"}`; sent as you when signed in, else as this computer's test sender                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 2a                                                                                                                                         |
| `agents.transcript`                                 | `{"name","cursor"?:{"ts_ms","id"}}`                                                                                                                                                            | `sessions.transcript`'s page plus `follow_cursor`, where what is written next starts: what a spawned agent whose `registration.spawn.can_take_over` is set has said, from its own output (a spawned Claude's stream-json log, `<app data>/spawned-agents/<session>.jsonl`), read from the byte offset in `cursor.id`; a line still being written waits for the next read. `refused` for an agent without a transcript of its own (a spawned Codex thread: read its session with `sessions.transcript`), `not_found` for an unknown name                                                                                                                                                                                                                                                                                                                                                                            | native spawn                                                                                                                               |
| `agents.take_over`                                  | `{"name","interrupt"?}`                                                                                                                                                                        | `{"name","target","directory","interrupted"}` once the spawned agent's headless process has stopped, so the session is the caller's to resume (`claude --resume <id>` in `directory`): exactly one process runs a session. Without `interrupt` it first waits up to 10 minutes for a running turn to end (`busy` after); a second call with `interrupt` while one waits makes it stop the agent at once, and both answer alike. The agent keeps its name, address and place; its process becomes whichever one runs the session, and releasing it leaves that process alone. Taking over one already taken over answers again without stopping anything; `refused` for a harness that cannot be taken over (Codex: open its thread in Codex)                                                                                                                                                                       | native spawn                                                                                                                               |
| `agents.reply_setting`                              | `{"name","enabled":true\|false\|null}`                                                                                                                                                         | `{}`; `null` answers automatically only when the session cannot reply itself                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 2a                                                                                                                                         |
| `agents.webhook.create`                             | `{"name"}`                                                                                                                                                                                     | `{"id","url","secret"\|null,"created"}`; the secret only to the call that created it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 2a                                                                                                                                         |
| `agents.webhook.revoke`                             | `{"name"}`                                                                                                                                                                                     | `{"already_deleted"}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 2a                                                                                                                                         |
| `agents.integrations.subscribe`                     | `{"name","provider","resource","event_types"?:[]}`                                                                                                                                                               | `{"subscribed":true,"provider","resource","path_glob","event_types"?:[]}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 2a                                                                                                                                         |
| `agents.integrations.unsubscribe` / `.clean_up`     | `{"name","provider","resource"}`                                                                                                                                                               | `{"subscribed":false,"provider","resource","already_unsubscribed"?}`; also finishes an unfinished subscription                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 2a                                                                                                                                         |
| `settings.get` / `settings.set`                     | `{"allow_self_registration"?, "auto_activate"?, "claude_session_hook"?, "direct_delivery"?, "direct_delivery_default"?, "devin_direct_delivery"?, "pi_extension"?, "pi_auto_activate"?, "opencode_auto_activate"?, "analytics_enabled"?, "contractor_access"?}` | All settings, plus the read-only `direct_delivery_managed` (the organization's `crossSessionInbound`, absent when it sets none); `direct_delivery_default` is write-only: `true` sets `accept` unless the user's own Claude settings already name `crossSessionInbound`, `false` changes nothing; `claude_session_hook` is off unless turned on and absent when no Claude login directory exists (the SessionStart hook never registers a session; with it come Claude `permissions.allow` rules for this probe's self-limiting commands on the session socket: `read`, `send`, `connect-send`, `fetch-attachment`, `agents`, `whoami` and `subscribe-channel`, recorded in `claude-permission-rules.json` and taken out with it); `devin_direct_delivery` adds or removes Agent Relay's lifecycle hooks in `~/.config/devin/config.json`, on by default where Devin has run, and absent where it has not; `pi_extension` installs or removes Agent Relay's extension in `~/.pi/agent/extensions` (only its own file), installed at start by a desktop core unless turned off and only on request by a `--cli-managed` one; while it is off no Pi session is listed and new messages to Pi are refused, even for a session that loaded the extension earlier, though a message already queued before it was turned off stays accepted and that loaded extension can still deliver it; absent where Pi has not run; `pi_auto_activate` and `opencode_auto_activate` (off unless turned on; `relay init` turns on the one for each tool chosen) let an open Pi or OpenCode session join by itself while `auto_activate` is on, which alone never activates those kinds; a setting the core runs without is `invalid_params`, and so are an unknown or read-only key and a non-boolean, which change nothing                                                                                                                                                    | 2a (store settings), 2b (`direct_delivery`, `claude_session_hook`, `devin_direct_delivery`), 2c (`analytics_enabled`, `contractor_access`) |
| `activity.list`                                     | `{"limit"?}`                                                                                                                                                                                   | `{"activity":[{"at_ms","agent","sender","preview","outcome":"injected"\|"skipped"\|"failed"\|"waiting"\|"in_doubt"\|"answered","detail","settlement":"handed_off"\|"waiting_for_turn"\|"visible"\|null}]}`, newest first; `settlement` is set on entries that place the message in the session (a queue handoff, a handoff behind the session's running turn, or the message recorded in the session) and includes Relay Connect deliveries under the participant's name                                                                                                                                                                                                                                                                                                                                                                                                                                           | 2a                                                                                                                                         |
| `claude_delivery.status`                            | —                                                                                                                                                                                              | `{"restricted","sessions":[{"id","agent","title","direct"}],"allowed_senders":[{"address","name"}],"held":[{"id","agent","session_id","sender","sender_name","text","held_at_ms"}]}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 2b                                                                                                                                         |
| `claude_delivery.restrict` / `.session` / `.sender` | `{"restricted"}` / `{"session_id","direct"}` / `{"sender","name","allowed"}`                                                                                                                   | `{}`; controls allowed-member enforcement, per-session Ask first, and the exact sender allowlist                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 2b                                                                                                                                         |
| `claude_delivery.approve` / `.dismiss`              | `{"id"}`                                                                                                                                                                                       | `{"changed"}`; `false` when the held delivery is gone                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 2b                                                                                                                                         |
| `openclaw.relay_tools.status`                       | —                                                                                                                                                                                              | `{"state":"unavailable"\|"not_connected"\|"waiting"\|"connected","detail"}`: whether the person's OpenClaw agents can use the hosted Agent Relay MCP. `waiting` while an `openclaw mcp login` Agent Relay started waits for the browser; otherwise what `openclaw mcp status --json` says of the `mcp.servers` entry at `<site>/cloud/api/v1/mcp/shared-sessions`, reused for 30 s. `detail` says why it is `unavailable` (OpenClaw off or not set up, a Gateway older than 2026.8.1 that cannot limit relay sessions — even when signed in —, a Gateway that cannot be reached to check (a core that has not met it shakes hands first), its CLI not found, no `mcp login`, an `agent_relay` entry at another address); an entry saved with `enabled: false` is `not_connected`, or why the last sign-in failed (`not_connected`). See OpenClaw and Hermes delivery (relay-desktop `openclaw-hermes-delivery.md`) | OpenClaw                                                                                                                                   |
| `openclaw.relay_tools.connect`                      | —                                                                                                                                                                                              | `{"state":"waiting"\|"connected","authorization_url"}`: adds `agent_relay` with `openclaw mcp add … --auth oauth --no-probe` unless an entry already has the URL (an `agent_relay` at another address is `refused`, never overwritten), then starts `openclaw mcp login <name>` and answers with the consent page to open; `connected` and no URL when OpenClaw was already signed in. A login already waiting answers with its page again. Failures are `refused` with the words to show                                                                                                                                                                                                                                                                                                                                                                                                                          | OpenClaw                                                                                                                                   |

**Workspace directory and messaging**

| Method                                       | Params                                                                                                                               | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Lands in |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| `roster.list`                                | `{"where"?, "include_idle"?, "q"?}`                                                                                                  | `{"agents":[{"name","address","kind","where":"this_computer"\|"cloud"\|"other_desktop","status":"active"\|"idle","liveness":"live"\|"idle"\|"offline","last_seen_ms","description","host","owner_hash","session_id","is_self","provider","activity"?:{"turn"?:"working"\|"idle","repo"?,"branch"?,"doing"?,"updated_ms"?}}],"unread_statuses":[…],"fetched_at_ms"}`; without `include_idle`, the running agents (`live`, `idle`), one Relaycast read per running status; with it, every agent; a status whose read fails leaves out only its agents and is listed in `unread_statuses` (every read failing fails the list); see People and their agents (relay-desktop `agents-people.md`) | 2a       |
| `roster.get`                                 | `{"to"\|"address","message_id"?}`                                                                                                    | `{"known","agent":{…roster.list's agent}\|null,"message":"queued"\|"delivered"\|"picked_up"\|"no_such_agent"\|null}`: one recipient (`GET /v1/agents/{name}`) and, with `message_id`, its row in Relaycast's `pending_deliveries`; `known: false` (and nothing else) when the key's workspace is not the one your messages go to                                                                                                                                                                                                                                                                                                                                                           | 2a       |
| `spawn.targets`                              | —                                                                                                                                    | Typed online node identities, known spawn capabilities and capacity; no credentials or delivery configuration                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 2b       |
| `spawn.invoke`                               | `{"caller_name"?,"node_id","node_name","name","harness","task","directory","idempotency_key"}`                                        | Typed native invocation receipt; exact advertised target, which must be this computer's own spawn node (status and release can only bind a worker spawned here), and absolute folder required                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 2b       |
| `spawn.status`                               | `{"caller_name"?,"action":"spawn"\|"release","invocation_id"}`                                                                        | Typed native invocation status; agent_id/name/node are enriched only from an exact same-workspace local spawn invocation, whether or not the worker still runs; raw input/output and provider error text are omitted                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 2b       |
| `spawn.release`                              | `{"caller_name"?,"node_id","node_name","name","expected_agent_id","idempotency_key"}`                                                 | Typed exact-release receipt; first release proves a local spawn by its exact saved identity (a crashed or ended worker included), private credential-free claims permit identical replay after removal; `released` is true only when the provider reported the exact agent released, never inferred from `status`                                                                                                                                                                                                                                                                                                                                                                            | 2b       |
| `spawn.claim.retry`                          | —                                                                                                                                    | Asks Agent Relay Cloud at once to record this computer's spawn node as the signed-in person's, whatever the backoff after a failed claim (`status.spawn.claim`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 2b       |
| `fleet.list`                                 | —                                                                                                                                    | `{"brokers":[{"node_id","name","workspace_id"?,"error"?,"workers":[{"id":"<node>\|<name>","name","provider","provider_label","model","runtime_kind","session_id","channels","generation","state":"starting"\|"working"\|"idle"\|"waiting"\|"unknown","pending_messages","last_activity_ms","target":{"kind","id"}\|null}]}]}`; a broker that cannot be read has an `error`, never an empty list                                                                                                                                                                                                                                                                                            | 2b       |
| `fleet.release`                              | `{"node_id","name","generation"}`                                                                                                    | `{}`; generation-checked (`conflict` when the broker's worker is another generation, `not_found` when gone)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 2b       |
| `messages.conversations`                     | —                                                                                                                                    | `{"identity","conversations":[{"id","peer":{"name","agent_id"},"last_message","unread_count"}]}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 2a       |
| `messages.history`                           | `{"endpoint","before"?}`                                                                                                             | `{"identity","messages":[{"id","sender","sender_id","sender_address","text","created_at","thread_id","mine"}]}` in reading order (replies beneath their parent); exact-address history fails closed without immutable proof                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 2a       |
| `messages.send`                              | `{"to"\|"address","text","reply_to"?}`                                                                                               | `{"message_id","conversation_id","to","recipient":{…roster.get's answer for this message}}`, read just after the send; no agent at the name or address is `not_found`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 2a       |
| `people.list`                                | —                                                                                                                                    | `{"people":[{"name","avatar_url","identity_hash","is_self"}]}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 2a       |

`people.list` returns the avatar's https URL rather than a cached file: a
client loads public images itself, and Cloud's email, role and join date are
dropped in the core. `identity_hash` joins a person to `roster.list`'s
`owner_hash`.

**Platform services**

| Method                      | Params                                                                                                           | Result                                                                                                                                                                                                                                                                                              | Lands in |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `links.parse`               | `{"url"}`                                                                                                        | `{"kind":"connect","site_url","account_id","workspace_id"}` or `{"kind":"message","endpoint","address"}`, else `invalid_params` (a connect link for another site says which); the link's scheme and site are the build's own (`AGENT_RELAY_URL_SCHEME`, `AGENT_RELAY_SITE_URL` when the core was built)       | 2a       |

## The relay-send socket

Sessions reach the core through a second socket with a different trust model:
`$XDG_RUNTIME_DIR/agent-relay/relay.sock` on Linux (`<app data>/run/relay.sock`
without a runtime directory), `<app data>/run/relay.sock` on macOS (short `$TMPDIR`, then
`/tmp`, fallbacks when that path is too long for a Unix socket; Agent Relay Dev
uses `agent-relay-dev` in each), advertised in
`~/.agentworkforce/desktop/relay-socket` (`relay-socket.dev` for Agent Relay
Dev). It speaks the HTTP routes for injectable agents and agent-driven
setup and identifies the caller by
kernel pid and process ancestry, not just uid. The core serves both sockets;
the bridge socket is for UIs, the relay-send socket for sessions
(`relay::outbound`).

- **Caller.** `SessionDirectory::caller(pid)` names the session from kernel
  evidence alone. A present `CODEX_THREAD_ID` decides alone: it is accepted
  only when the nearest trusted Codex ancestor (same user; on macOS OpenAI's
  valid signature, on Linux owned by root or the user and writable by no one
  else) holds that thread's writer lock. An ordinary Codex must hold only
  that lock, or hold it as the oldest rollout inode that process still has
  open, while every other lock is a newer team/subagent rollout whose header
  names this thread as parent. Replacing the path, or rewriting the header,
  cannot promote a newer inode to the root. A
  descendant still cannot claim one of those subagent locks; that takes a
  nearer ancestor that holds the subagent lock on its own, or an
  `app-server`, which may hold several but must hold the claimed one. An invalid ID is
  refused rather than tried as anything else. Without it, the nearest
  ancestor that is a live Claude Code session with its recorded start time,
  or a trusted Codex running `resume <thread>`; the walk ends at the first
  Codex either way. A registry record is read up to the end of its first
  JSON value. An ancestor that is a running Claude Code session whose
  `<pid>.json` does not parse (a `<pid>.<hash>.key` records its start
  time) ends the walk with `session_file_unreadable` (409), naming the
  file. A Devin ancestor decides alike: it is the session whose
  `<devin>/cli/session_locks/<session>.lock` it holds open, or nobody — a
  `devin` command that is not a session never lends a caller an outer
  session's identity, and a lock file's recorded pid counts only while that
  pid still holds the lock. A process inside no supported session is
  `not_a_relay_session`; another user's is `not_this_user`.
- **Codex hooks.** PostToolUse and Stop bind a nonempty hook `turn_id` to
  the requested thread's active turn in its locally resolved, kernel-held
  rollout, alongside the trusted writer and captured file-birth checks.
  A missing turn ID, unavailable birth-time evidence, or an unresolved rollout
  leaves offers and registration guidance pending; the hook client returns
  `{}`. Rollout lookup uses the core's configured `CODEX_HOME` (default
  `~/.codex`) and `CODEX_SQLITE_HOME`, so a different home set only on a hook
  process is not discovered by this route. SessionStart has no turn ID and
  runs only when the trusted writer holds that thread alone. Multi-chat
  app-server/IDE sessions and CLI roots with live subagents skip the SessionStart
  preamble and early auto-activation; those actions are not replayed later.
  A later verified PostToolUse can still supply registration guidance.
  These are local context-binding checks, not authentication against a
  malicious process running as the same user.
- **Routes.** `POST /send` and `GET /agents` need the caller's registration;
  `GET /whoami`, `POST`/`DELETE /register` and the setup routes do not.
  Every route except `/whoami` counts against the session's 30 requests a
  minute. `/agents` reads with the key saved on the caller's own
  registration and caches the roster 30 s.
- **Unresolved recipients.** See "Messaging etiquette and unresolved
  recipients" below.
- **Attachments.** `POST /send` targets one `"to"`, `"address"`, or `"channel"`
  and takes optional `"files"` (absolute paths,
  at most five, each a regular file of at most 25 MB, from the session's
  project or the temporary folder, nothing hidden or under a credentials
  folder: `relay::files::confine`), uploaded with the caller's agent token
  before the message is sent with their ids. Inbound, a delivery's
  `attachments` are saved under `<app data>/attachments/` before injection
  and listed after the message text (`relay::files`): `0600`, quarantined on
  macOS, within 500 MB in all, 100 MB and 50 MB an hour per sender, and
  removed after 7 days (`relay::files::store`).
- **Reply commands.** An injected message carries the `[reply: …]` command
  only while the socket serves and a process that could be identified as the
  session runs it: a live Claude Code session with its recorded start time, or
  a trusted Codex holding that thread's writer lock alone (or as the root
  session whose other locks are proven subagents), a trusted shared
  app-server holding the claimed lock, or an older Codex resuming it. Hints
  for macOS Codex threads without a `resume <thread>` ancestor invoke this
  core's own client because the system curl binary does not expose
  `CODEX_THREAD_ID` to process inspection: the self-limiting commands
  (`send`, `agents`, `whoami`, `read`, `fetch-attachment`, `connect-send`,
  `subscribe-channel`;
  `relay::session_cli`), each of which fixes its own method and route, so
  the Codex and Claude rules that allow them reach nothing else.
- **Codex hook upgrades.** Setup records Codex's hook approval on disk, then
  reconciles an already-running shared daemon for that exact Codex home. It
  checks the owner's user, executable, start time and home before connecting
  with that daemon's own connect-only proxy. A normal empty-edit
  `config/batchWrite` with `reloadUserConfig: true` and Codex's authoritative
  config version reloads existing approved state when a loaded chat is stale.
  Approval of the current disk definition is checked separately, so an old
  loaded command or hash can be replaced without authorizing a new definition.
  For a matching shared daemon, live readiness requires enabled, trusted
  Relay hooks on a stable set of loaded chats; an
  acknowledgment alone is insufficient, no new trust hashes are authorized,
  and configuration bytes must remain unchanged. This uses Codex's normal
  loaded-thread configuration refresh, which can refresh its other already
  approved runtime settings too. No shared daemon is started just to probe or
  refresh it. Standalone CLI setup retains disk approval when no matching
  daemon is running. Its existing ready flag then means disk-approved hook
  setup, not verified live delivery or a live-chat inspection; ordinary CLI
  hooks remain available. Private stdio/custom-socket servers are not treated as
  the shared owner. An ambiguous or unverifiable live owner, different-home
  response, unavailable status API or failed verification leaves hook
  delivery unready rather than silently claiming a successful upgrade.
- **Registration.** Every registration (`agents.register`, auto-activation,
  `POST /register`) reads fleet ownership fresh
  (`SessionDirectory::fleet_owned`) and refuses (`fleet_unavailable`; HTTP 503
  on the socket) when any broker or claim cannot be read.
- **Setup.** Of the setup routes (`GET /setup/status`, `POST /setup/sign-in`,
  `/setup/sharing`, `/setup/auto-activate`, `/setup/direct-delivery`), status,
  sign-in and sharing go through the account's methods (`server::call`); a
  core without an account answers `setup_unavailable` and reports sign-in from
  the workspace alone. Auto-activation and direct delivery are the core's own
  settings. Status waits on no network call: it answers from the workspace's
  last verification while Relaycast's verification of a newly found key runs in
  the background. A status read that sends `X-Agent-Relay-Observe: 1` returns
  the same body and does not apply the setup defaults; the Claude SessionStart
  hook uses it so a nudge cannot turn automatic activation on. The body
  includes `allow_self_registration`, `claude_prompt_to_join_allowed` (whether
  the SessionStart hook may ask an unregistered chat to join) and, for a
  registered session, `session.link_address` (the registered address
  `join_relay` links, which stays put when the session is renamed). Webhooks and integrations are
  the agent runtime's (`agents.webhook.*`, `agents.integrations.*`): Linux
  subscribes through relayfile-cloud in process, as macOS does, rather than
  running the `agent-relay` CLI and a private relayfile daemon.
- **Lifecycle.** Starting is serialized by `.relay.sock.lock` beside the
  socket. A live socket another app serves is left alone (the core says so in
  `activity` and serves only the bridge); a stale one of this user's is
  replaced; anything that is not a socket is never deleted. Stopping removes
  the socket and the pointer only while each is still this core's.

### Messaging etiquette and unresolved recipients

Every place the core teaches an agent to message another states the same
etiquette (`hosted_mcp::ETIQUETTE`): message only when you need something from
the other agent or it needs something from you, with no status updates or
small talk; one task per session, so new work goes only to an agent that is
not on another task, and a busy agent's person is asked to start a new
session instead; and the point first, then the context the recipient cannot
see (repo, branch, files). It is part of the Claude SessionStart preamble's
norm (`hosted_mcp::NORM`), the credential-free startup text for spawned
sessions (`harness_setup::local_socket_instructions`, `harness-setup.md`), and
the description of the `send_relay_message` tool Devin and Muse sessions get
(`harness::relay_mcp`).

When Relaycast finds no agent for a direct send's recipient (`agent_not_found`
or `address_not_found`), the core reads the workspace roster, idle agents
included (the socket's cached `GET /agents?include_idle=1` read for a session;
`roster.list`'s running statuses for you), and Cloud's members, when that is
the signed-in workspace (read only if the signed-in account and workspace are
the same before and after the read, so another account's member names never
appear), and says why (`recipients::unresolved`). An
`ambiguous_address` (an address Relaycast reads more than one way) is passed
on as it is:

| Asked for                                                                                    | Socket error (HTTP)         | `messages.send` kind | Says                                                  |
| -------------------------------------------------------------------------------------------- | --------------------------- | -------------------- | ----------------------------------------------------- |
| A short name that more than one agent's name contains                                        | `ambiguous_recipient` (400) | `invalid_params`     | every candidate's full address                        |
| A short name exactly one agent's name contains, or an address whose agent now runs elsewhere | Relaycast's code (404)      | `not_found`          | "Did you mean" its full address                       |
| A person (their name, first name, or name joined with `-`)                                   | `recipient_is_person` (400) | `invalid_params`     | that it is a person, and their agents' full addresses |
| Anything else                                                                                | Relaycast's code (404)      | `not_found`          | to list agents first (`GET /agents` on the socket)    |

Matching ignores case. A name shared by several people (two people with the
same first name) lists each of them with their agents. An `agent@machine`
address is never a person's and is not matched loosely: its candidates are the
agents named exactly by one of its readings (an `@` may sit in either part),
wherever they run now. A roster that cannot be read leaves the last row. Channel posts
are not explained this way. The
`send_relay_message` tool shows the socket's message for a refused send; any
other failure stays generic.

## Workspace discovery

The daemon uses one Relaycast workspace at a time (`relay::workspace`), from
the first of two sources that names one:

1. **The `agent-relay` CLI** (`relay::workspace::cli`), read and never
   written, by the CLI's own precedence: a workspace-key variable in the
   daemon's environment (`RELAY_WORKSPACE_KEY` > `AGENT_RELAY_WORKSPACE_KEY` >
   `RELAY_API_KEY`); then the project pin
   `<project>/.agentworkforce/relay/workspace-key.json` when
   `AGENT_RELAY_PROJECT` names the project (the daemon has no working
   directory to search from); then the active entry of
   `$AGENT_RELAY_HOME/workspaces.json` (default `~/.agentworkforce/relay`).
   Its origin follows the CLI too: a project's persisted Relaycast route
   (only Agent Relay's own gateways), else `RELAY_BASE_URL`, else the key's
   binding in `relaycast-origins.json`
   (`relay::workspace::origin_binding`: the PBKDF2-SHA256 fingerprint shared
   with the CLI and the broker), else `https://armadillo.agentrelay.com` for an
   armadillo-issued `ar_ws_…` key, else
   `https://cast.agentrelay.com`, because any other key with no binding predates
   `relay init --hosted` creating workspaces on armadillo. A bound
   key goes only to its bound server, so `relay init`'s local server
   (`http://127.0.0.1:8787`), armadillo and self-hosted servers (any http(s)
   base URL, path prefix included) work with no sign-in. A malformed bindings file, an
   unreadable `workspaces.json` or a malformed `RELAY_BASE_URL` fails closed:
   the daemon has no workspace and says why in its activity, rather than
   sending the key to the hosted default or falling back to the account's.
2. **The account's workspace** (`cloud` in the agent store, at its own origin),
   written by a build's account, used only when the CLI names nothing.
   `RELAYCAST_URL`
   overrides its origin when it is a bare https origin (http and a port only
   for `localhost`/`127.0.0.1`; no user info, path, query or fragment);
   anything else leaves `https://cast.agentrelay.com`.

A build made for its own site (`AGENT_RELAY_SITE_URL` other than
`https://agentrelay.com`, `links::is_site_build`) uses only that site's values
and never falls back to Agent Relay's public gateways. The account's workspace
must carry a bare https origin from the site's workspace resolve
(`urls.relaycastUrl`); `RELAYCAST_URL` is ignored, and a missing or invalid
origin is refused with a reason naming the site. A CLI key needs a recorded
server in `relaycast-origins.json` or `RELAY_BASE_URL`: an unbound key, an
unseen `ar_ws_…` key included, is refused with a reason naming the bindings
file and the site. A persisted project route, of any kind, must name the
site's own Relaycast origin (the one its sign-in recorded). Each refusal is
reported in the daemon's activity, and the daemon has no workspace until it is
fixed.

Neither source's key is sent to the other's origin: `RELAYCAST_URL` applies
only to the account's key, and CLI bindings only to the CLI's. Only
`rk_…` and `ar_ws_…` keys of at least 12 characters without whitespace qualify. A refused
key is recovered through the account (`AccountPlugin::recover_workspace_key`)
only when it came from the sign-in; a key the CLI named is the CLI's to rotate, and a
rotated `workspaces.json` entry is picked up by the next rediscovery. When the
CLI names a workspace, messaging uses it. The daemon rediscovers every 30 s and on
`workspace.refresh`, and verifies a new key with `GET /v1/workspace`.

The machine prefix is the host name with `.local` dropped, diacritics folded,
non-`[a-z0-9]` runs as one dash, at most 40 characters, else `computer`; each
direct node is `<prefix>-<agent id>`, and a registration keeps the prefix it
was issued.

## The agent store

`relay::store` owns `injectable-agents.json` in the app data directory
(`~/Library/Application Support/com.agentrelay.desktop` on macOS,
`$XDG_DATA_HOME/com.agentrelay.desktop`, default `~/.local/share/…`, on
Linux). One format on every platform.

```json
{
  "registrations": [{"name", "agentID", "target": {"kind", "id"}, "title", "baseURL",
                     "registeredAt": "2026-09-30T10:00:00Z", "workspaceKey", "machinePrefix",
                     "addedBySession", "webhook": {"id","url","token","channelName","channelID"},
                     "replyWithFinalAnswer", "integrationChannelID", "integrationChannelName",
                     "integrations": [{"id","provider","resource","workspaceID","pathGlob",
                                       "inboundURL","writebackURL","cloudSubscriptionID","subscriptionID","ready"}]}],
  "tokens": {"<agent name>": "at_live_…"},
  "cloud": {"key","baseURL","workspaceID","accountWorkspaceID","name","relayfileWorkspaceID"},
  "cloudSession": {"accessToken","accessTokenExpiresAt","refreshToken","refreshTokenExpiresAt","siteURL"},
  "allowSelfRegistration", "autoActivate", "agentLedDefaultsApplied",
  "pendingCleanups": [{"kind":"agent"|"channel","name","baseURL","workspaceKey"}],
  "testSenders": {"<key ref>": {"name","token"}},
  "replies": [{"agentID","messageID","destination":{"thread":{"_0":"<parent>"}},"claimed","senderName","senderAddress","channelID","routingVersion"}],
  "replyRoutes": [{"agentID","messageID"}],
  "injectedDeliveryIDs": [], "inDoubtDeliveryIDs": []
}
```

- Written 0600 by swapping a complete temporary file into place, under an
  exclusive `flock` on `injectable-agents.json.lock`. Every writer folds its
  changes onto what another wrote since it last read the file (a three-way
  merge per registration, token, delivery id, reply and cleanup; a removal
  wins over an edit; two registrations of one session keep the writer's and
  queue the other agent for removal).
- A file that does not decode is moved aside as
  `injectable-agents.json.unreadable-<time>` and reported in
  `status.agents.store_error`; one that cannot be read blocks every save.
- Older stores are migrated when read and written back once: one with
  (Unix-seconds `registeredAt`; the account's `workspaceID`,
  `workspaceName`, `relayfileWorkspaceID` at the top level; `webhooks`,
  `integrations` and `replyParents` keyed by session; cached `senders` and
  `conversations`), and one with `workspaceKeySource`. A key the
  sign-in fetched moves from `workspaceKey` to `cloud`; a pasted
  `workspaceKey` is dropped; registrations without a `machinePrefix`
  get the prefix they were reachable at; unattributed legacy thread replies
  are dropped. No registration or token is lost. Cached person identities and
  conversation hints are fetched again on use.

## Delivery

`relay::delivery` puts each message addressed to one of this computer's
agents into its session (through the `Injector`) and settles it:

- Your relay identity (for messaging) belongs to one signed-in person in
  one Cloud workspace on one site; when the account changes, it and
  everything read with it are forgotten.
- Pushed `deliver` frames for DMs and thread replies are handled from the
  frame; anything else, and every socket that comes up or goes down, reads
  the queue. Each agent's work runs in order, one delivery at a time. The
  queue safety net runs every five minutes while that agent's push channel
  is live. Without push it starts at 3 s and backs off consecutive empty
  reads to 6, 12, then 15 s; a nonempty read resets the fast cadence. Socket
  reconnects/disconnects and injection retries still request immediate reads.
  Every successful queue read refreshes Relaycast presence, so the core sends
  a separate REST heartbeat only after 30 s without a successful queue read,
  confirmed WebSocket presence update, or heartbeat attempt. Failed reads
  never postpone presence. Node WebSocket heartbeats run every 15 s and carry
  unique request IDs within the connection. Servers supporting direct-node
  presence reply with `data.agent_presence: true` and the bound `agent_id`
  after renewing both the agent roster and its 60 s presence record. Only a
  matching, successful acknowledgement of the latest request, younger than
  one socket heartbeat interval, counts; the core credits its send time and
  verifies that the registration's origin and credential still match.
  Older servers, lost acknowledgements and disconnected sockets retain REST
  fallback every 30 s. Hosted Relaycast (`https://cast.agentrelay.com`) does
  not yet acknowledge socket presence, but there a live socket keeps the node
  online and an agent shows active for five minutes after its last
  authenticated request, so a REST heartbeat only renews that window, at the
  cost of a database write. With a live push socket to hosted Relaycast the
  fallback runs every 2 minutes. Other servers keep 30 s: they may hold a
  60 s presence record that a socket does not renew.
  REST heartbeats
  run one at a time per workspace, at least 100 ms apart; up to four
  independent workspaces progress concurrently. Queue polling continues
  on its own cadence through a slow heartbeat cohort, including Connect
  inboxes. The cohort's duration counts toward the next supervisor poll
  rather than adding a full sleep when it finishes. A `workspace_busy`
  write-admission response backs off background writes without pausing
  roster or delivery reads. Plan and rate limits, and
  `503 database_overloaded` (or any 503 naming a Retry-After), still pause
  both reads and writes for that workspace, honoring Retry-After and backing
  off exponentially while the refusals continue.
  For an otherwise idle registered session with healthy push, this reduces
  periodic REST requests from roughly 5,760/day (queue + heartbeat each 30 s)
  to 288/day (queue each 300 s, no REST presence heartbeats) when the server
  acknowledges WebSocket presence, excluding startup, reconnects, messages
  and retries. Hosted Relaycast, which does not acknowledge it yet, gets up
  to 1,008/day (queue each 300 s + heartbeat each 120 s), down from
  3,168/day; other servers without acknowledgements keep up to 3,168/day.
  An empty fallback queue settles
  near 5,760 reads/day instead of 28,800, and those reads replace redundant
  heartbeats. These are cadence estimates, not a claim about historical
  workspace usage. Relay Connect guest inboxes retain their existing polling
  policy; this schedule applies to registered sessions.
- Injected: DMs, mentions, thread replies, and anything in the agent's own
  webhook or integration channel (minus integration noise: index rewrites,
  generic updates, edits, pushes). Everything else, and the agent's own
  messages, is acknowledged without injecting.
- A delivery is acknowledged only after the record that it was injected is
  on disk. One that may have arrived (`in_doubt`) is never sent again: it is
  recorded with the injected ids and in a list
  of its own, bounded apart, reported failed (not retryable), and failed again, never acknowledged, if redelivered. A failed injection is
  retried after `min(30, 3 × 2^(n−1))` s; one with nowhere to go yet waits
  5 s without counting as a failure. One the session's route refuses for
  good (`InjectOutcome::Refused`: an archived or unknown Claude app session,
  an id that names no Codex thread or Claude session) is failed on Relaycast
  as not retryable, never acknowledged, and not tried again. A Claude app
  session refusing because it is archived also marks its agent archived.
  Pending refusal settlements preserve the session's refusal reason, are journaled independently of presence and
  retried without reading an archived agent's queue or injecting again. The
  archived agent leaves only after its non-retryable failure is confirmed. The bounded refusal history preserves FIFO
  eviction across concurrent saves; unsettled refusals remain protected in
  the pending settlement journal until confirmed. Refusals also keep the
  established injected markers, including a versioned local refusal marker
  in `injectedDeliveryIDs`: a legacy writer dropping both new fields and
  `inDoubtDeliveryIDs` while the core is stopped cannot turn a refusal into
  reinjection or acknowledgement after restart. Explicit removal retires
  unresolvable pending settlements while keeping the handled history;
  automatic archive removal checks for pending refusals under the delivery
  lock and keeps credentials until the non-retryable failure is confirmed.
  Compatibility entries reserve an independent 1,000-refusal window beside
  the 1,000 ordinary injections; pending refusals stay protected until settled.
  Versioned pending markers restore that journal if an older writer omits
  it, including archived agents. Refusals while a released alias drains can
  use its retiring credential and are retired after its delivery line drains.
- Removing an agent waits for its delivery in flight, through its name and
  its alias; nothing is injected for it after the removal returns, and both
  names leave Relaycast together.
- One name per session. A rename (or `POST /register` with a new name from a
  registered session) records the new name as `alias` in the registration,
  with its own Relaycast agent id and token, and makes it the session's only
  name: `/send` (direct messages, `reply_to` replies, channel posts and
  subscriptions), automatic final answers, `/whoami`, `agents.list` and
  `sessions.list` addresses all use it. The registered agent stays only to
  forward what was sent to it: its push channel and queue reads continue, but
  it is neither heartbeated nor announced present, it is updated to `idle`
  with `renamed_to` metadata (queued in `pendingNameMarkers` and retried until
  Relaycast confirms it, and backfilled once after start), and rosters skip
  it by that marker, whatever presence Relaycast shows. Answers owed and reply routes stay keyed to the registered
  agent and go out under the current name. Webhooks and integrations stay on
  the registered agent. A channel post refused with `not_channel_member`
  joins the current name and is sent once more; joining or leaving a channel
  under the current name also leaves it under the forwarding one, and a post
  sent under either name is never injected back into the session. Renaming again moves the
  previous alias to the registration's `retiredAliases` (with its token and
  `retiredAt`) in the same save: it keeps its push channel and queue reads,
  gets a `renamed_to` marker, and is not heartbeated. The periodic pass
  releases one 24 hours after `retiredAt`, under the session's lock and the
  alias's delivery lock (so a delivery to it in flight, and any refusal it
  journals, finish first), rechecking expiry and refusals under both: it
  leaves the store and is queued as a pending cleanup in one save, with the
  key `key_for` resolves (a legacy registration's included), so its Relaycast
  removal is retried until it is gone. Joining or leaving a channel under the
  current name leaves it under every forwarding name, retired ones included.
  A retired alias's channel memberships are not handed on when it is
  released; the session joins under its current name the next time it posts
  or subscribes there. Renaming to a name still in
  `retiredAliases` takes it up again without registering a new agent.
  Removing the agent removes every alias. A registration replaced or dropped
  in a merge queues its aliases' removal. Another session cannot take a name
  held as an alias, current or retired.
- Automatic final answers: a message whose session was not given a reply
  command (or whose agent always answers) gets the session's final answer,
  read from its transcript once the turn is over. The answer is claimed in
  the store before it is sent, with a stable idempotency key, and a socket
  send claims it first; either way there is never a second answer. Provider
  events and webhook posts never get one.

## Plug-in points

The core is built with `daemon::Plugins`; each defaults to a no-op until
its stage lands.

| Trait                            | File                                   | Supplies                                                                                                        | Default                                                       | Lands in |
| -------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | -------- |
| `inject::Injector`               | `src/relay/inject.rs`            | `inject` (`Delivered`, `Retry`, `Waiting`, `InDoubt`, `Refused`), `reply_hint`, `final_answer` per session kind | `NoInjector`: every delivery waits                            | 2b       |
| `sessions::SessionDirectory`     | `src/relay/sessions.rs`          | Sessions on this computer, fleet-managed ones excluded                                                          | `NoSessions`                                                  | 2b       |
| `cloud_session::CloudAccess`     | `src/relay/cloud_session.rs`     | The signed-in account and authenticated `<site>/cloud/api/v1` requests                                          | `SignedOut`                                                   | 2c       |
| `agents::SettingsExtension`      | `src/relay/agents.rs`            | Settings owned elsewhere (`direct_delivery`, `analytics_enabled`, `contractor_access`)                          | none                                                          | 2b, 2c   |
| `outbound::RelaySend`            | `src/relay/outbound.rs`          | The relay-send socket's path, pointer and Claude Code's direct-delivery setting (`setup::DirectDelivery`)       | `None`: not served                                            | 2b       |
| `daemon::Plugins::account`       | `src/relay/daemon/plugins.rs`    | Sign-in and telemetry, from the build that has them                                                             | none: account, uploader and telemetry methods are not offered | 2c       |
| `daemon::Plugins::session_policy` | `src/relay/daemon/plugins.rs`   | Which sessions join by themselves, may be asked to join, and publish activity                                   | every session may join by itself; none is asked; none publishes | 4      |
| `session_sources::SessionSources` | `src/relay/session_sources.rs`  | Remote sessions (Devin Cloud, Claude Code on the web) a build lists and delivers into; Hermes's homes           | none: only this computer's sessions                           | 2b       |

`serve` builds its plugins with `local::plugins`: `LocalSessions`
(Codex and Claude discovery over a `process::ProcessTable`, fleet-owned
sessions left out), `LocalInjector`, `ClaudeSettings` and the relay-send
socket at its platform path; a build's `daemon::PluginBuilder` adds what it
has. Tests build the core with fakes of each.

`CloudAccess::request` takes paths relative to `<site>/cloud/api/v1`
(`/members`, `/workspaces/{id}/messaging/identity/credential`), so a caller
cannot double the `/cloud` prefix.

## Relaycast

Every Relaycast call goes through the published `relaycast` crate (10.0.0). Its API errors keep the full error body, so the request log records Relaycast's `plan`, `upgrade_available` and `upgrade_url` on a busy answer.
The one exception is `relay::sdk_gaps`, a minimal typed client for surface
the SDK does not cover the way the core needs; each item there is an
upstream request and is deleted once the SDK has it.

| Endpoint                                                            | Auth  | SDK                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/agents`                                                   | `rk_` | `RelayCast::register_agent` — **gap**: `CreateAgentRequest` has no `direct_machine_prefix` or `auto_join_general` (`sdk_gaps::register_agent`)                                                                                                                                     |
| `DELETE /v1/agents/{name}`                                          | `rk_` | `RelayCast::delete_agent`                                                                                                                                                                                                                                                          |
| `GET /v1/agents?status=`                                            | `rk_` | `RelayCast::list_agents` — **gap**: `Agent` has no `address` (`sdk_gaps::list_agents`)                                                                                                                                                                                             |
| `GET /v1/agents/{name}`                                             | `rk_` | `RelayCast::get_agent` — **gap**: `Agent` has no `address` (`sdk_gaps::get_agent`)                                                                                                                                                                                                 |
| `POST /v1/agents/heartbeat`                                         | `at_` | `AgentClient::heartbeat`                                                                                                                                                                                                                                                           |
| `GET /v1/agent`                                                     | `at_` | `AgentClient::me`                                                                                                                                                                                                                                                                  |
| `GET /v1/workspace`                                                 | `rk_` | `RelayCast::workspace_info` — **gap**: `Workspace` requires `api_key_hash`, which the server no longer sends (`sdk_gaps::workspace_identity`)                                                                                                                                      |
| `POST /v1/agent/node-token`                                         | `at_` | **gap**: no public method (`sdk_gaps::mint_node_token`, over the SDK's `HttpClient`)                                                                                                                                                                                               |
| `WS /v1/node/ws`                                                    | `nt_` | **gap**: `WsClient` acks every `deliver` on the socket (terminal, before injection), omits `machine_id` from `node.register`, heartbeats every 30 s instead of 15 s, signals `Open` before the registration reply, and cannot send `origin_surface` (`sdk_gaps::open_node_socket`) |
| `GET /v1/deliveries`                                                | `at_` | `AgentClient::deliveries` — **gap**: `DeliveryMessage` has no `agent_address` or `metadata` (relayfile path) (`sdk_gaps::deliveries`)                                                                                                                                              |
| `POST /v1/deliveries/{id}/ack` / `fail`                             | `at_` | `AgentClient::ack_delivery` / `fail_delivery`                                                                                                                                                                                                                                      |
| `POST /v1/channels`, `…/join`, `…/leave`, `GET /v1/channels/{name}` | `at_` | `AgentClient::ensure_joined_channel`, `join_channel`, `leave_channel`, `get_channel`                                                                                                                                                                                               |
| `DELETE /v1/channels/{name}`                                        | `rk_` | `AgentClient::archive_channel`, built with the workspace key                                                                                                                                                                                                                       |
| `POST` / `GET` / `DELETE /v1/webhooks`                              | `rk_` | `RelayCast::create_webhook`, `list_webhooks`, `delete_webhook`                                                                                                                                                                                                                     |
| `POST` / `GET` / `DELETE /v1/subscriptions`                         | `rk_` | `RelayCast::create_subscription`, `list_subscriptions`, `delete_subscription`                                                                                                                                                                                                      |
| `POST /v1/agents/{name}/subscription-channel`                       | `rk_` | **gap**: no method (`sdk_gaps::subscription_channel`)                                                                                                                                                                                                                              |
| `POST /v1/integrations/relayfile/inbound-target`                    | `rk_` | **gap**: no method (`sdk_gaps::relayfile_inbound_target`)                                                                                                                                                                                                                          |
| `POST /v1/dm`                                                       | `at_` | `AgentClient::dm` for a name — **gap**: `SendDmRequest` has no `address` (exact `agent@machine` endpoint) (`sdk_gaps::dm_address`)                                                                                                                                                 |
| `POST /v1/messages/{id}/replies`                                    | `at_` | `AgentClient::reply`                                                                                                                                                                                                                                                               |
| `GET /v1/dm/conversations`                                          | `at_` | `AgentClient::dm_conversations` — **gap**: participants are flattened to names, losing the immutable `agent_id` exact-address proof needs (`sdk_gaps::dm_conversations`)                                                                                                           |
| `GET /v1/dm/{id}/messages`                                          | `at_` | `AgentClient::dm_messages` — **gap**: `MessageWithMeta` has no `agent_address` or `thread_id` (`sdk_gaps::dm_messages`)                                                                                                                                                            |
| `GET /v1/messages/{id}`                                             | `at_` | `AgentClient::message` — same gap (`sdk_gaps::message`)                                                                                                                                                                                                                            |
| `GET /v1/workspace`                                                 | `rk_` | `RelayCast::workspace_info`                                                                                                                                                                                                                                                        |

Every gap is still a call through the SDK's own `HttpClient` (auth,
envelopes, retries and errors are the SDK's).

Cross-cutting SDK gaps: `RelayCast` and `AgentClient` cannot set the origin
client/version (only `HttpClient` can; the gaps send `relay-desktop` and the
build's version), and `HttpClient` follows redirects, where the core sends
credentials only to the validated origin and refuses redirects. The default host for a key with no bound server is
`https://cast.agentrelay.com`, or armadillo for an `ar_ws_…` key; `relay init --hosted` binds its keys to
`https://armadillo.agentrelay.com`.

## Push

`relay::push` keeps one direct node socket per registered agent: mint a node
token with the agent token, open `/v1/node/ws`, send `node.register` with the
registration's machine address, heartbeat every 15 s. Correlated presence
acknowledgements replace REST heartbeats as described above; node liveness
alone never suppresses them. The reply to
`register-…` makes the channel `live` and wakes a queue read; a `deliver`
frame wakes with the frame; an ended socket wakes a queue read and reconnects
after `min(30, 2^min(n,5)) × U(0.5, 1)` seconds with a fresh token. The
socket never acknowledges: the delivery runtime acks over HTTP once the
message is in the session. `Core::sync_push` keeps exactly one channel per
agent and restarts one whose origin, token or machine address changed.

## Modules

| Module                                                     | Owns                                                                                                                                                                                                                           |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `relay::protocol`                                          | Envelopes, events, error kinds, `BRIDGE_VERSION`                                                                                                                                                                               |
| `relay::contract`                                          | The method and topic registry with every parameter, result and event type; Swift generation (`codegen`, `relay-contract-codegen`); the Rust client's tolerant reading (`reader`)                                               |
| `relay::server`                                            | Accept loop, peer admission, handshake, dispatch, event forwarding                                                                                                                                                             |
| `relay::daemon`                                            | `serve`, single-instance lock, socket lifecycle, `Core`, shutdown                                                                                                                                                        |
| `relay::state`                                             | The snapshot and the event hub                                                                                                                                                                                                 |
| `relay::paths` / `relay::peer`                             | Socket and lock paths; kernel peer credentials                                                                                                                                                                                 |
| `relay::workspace` / `relay::app_store` / `relay::machine` | Discovery, origin validation, the store's workspace fields, the machine prefix                                                                                                                                                 |
| `relay::client`                                            | Relaycast clients over the SDK                                                                                                                                                                                                 |
| `relay::sdk_gaps`                                          | Relaycast surface the SDK lacks                                                                                                                                                                                                |
| `relay::push`                                              | Direct node sockets                                                                                                                                                                                                            |
| `relay::cli`                                               | `call METHOD [--params JSON]`; `socket-request` (any documented route, for people and debugging; no rule allows it) and `subscribe <pull request>`, the session-socket clients                                                                                                   |
| `relay::methods`                                           | The bridge methods for agents, messaging, people, links and settings                                                                                                                                                      |
| `relay::store`                                             | The agent store: format, migration, flock, three-way merge, set-aside of unreadable files                                                                                                                                 |
| `relay::agents`                                            | Names, registration, rename, removal, webhooks, test sender, settings, cleanups                                                                                                                                           |
| `relay::delivery`                                          | Policy, injected text, the per-agent line of work, ack/fail, in-doubt, final answers                                                                                                                                      |
| `relay::messaging` / `relay::people`                       | Person identity, DMs, exact-address proof; members, avatars and the roster                                                                                                                                                |
| `relay::integrations`                                      | Relayfile subscriptions                                                                                                                                                                                                   |
| `relay::links`                                             | Message endpoints and deep links                                                                                                                                                                                          |
| `relay::inject`                                            | The `Injector` trait                                                                                                                                                                                                      |
| `relay::sessions`                                          | The `SessionDirectory` trait, with `caller` and `fleet_owned`                                                                                                                                                        |
| `relay::process`                                           | The kernel's process table (`/proc`; `libproc`, `KERN_PROCARGS2` and code signatures on macOS) and the Codex caller rules                                                                                                 |
| `relay::codex`                                             | Codex threads, rollouts, `codex queue`, the app-server proxy, the desktop app's IPC socket, the injection router                                                                                                          |
| `relay::claude`                                            | Claude Code's session registry, peer inbox, Claude app sessions and `claude --print --cloud`, transcripts                                                                                                                 |
| `relay::local`                                             | `LocalSessions`, `LocalInjector` and the plugins `serve` runs with                                                                                                                                                  |
| `relay::local_methods`                                     | `sessions.list`, `fleet.list`, `fleet.release`, the sessions/fleet watcher                                                                                                                                                |
| `relay::outbound`                                          | The relay-send socket and its routes                                                                                                                                                                                      |
| `relay::setup`                                             | Agent-led setup routes and defaults                                                                                                                                                                                       |
| `relay::fleet`                                             | Broker discovery and `/api/spawned`                                                                                                                                                                                       |
| `relay::claude_settings`                                   | `crossSessionInbound`                                                                                                                                                                                                     |
| `relay::claude_delivery_policy`                            | Per-session and per-sender Claude Code delivery consent plus the durable Ask-first queue                                                                                                                                  |
| `relay::cloud_session`                                     | The `CloudAccess` trait; session refresh and `whoami`                                                                              |
| `relay::cloud_http` / `relay::cloud_login`                 | One redirect-free, bounded Cloud request; device sign-in for Relay Connect hosts                                                                                                                                    |
| `relay::spawn`                                             | The spawn node: Relaycast `spawn:codex`/`spawn:claude`/`release` capacity, headless launches, spawned agents' registrations (native-spawn.md (relay-desktop `native-spawn.md`))                                                |
| `relay::usage`                                             | What the core reports about its own operations to a build's account                                                  |

## Verification

`cargo test` runs the core against an in-process fake Relaycast (HTTP routes,
the node socket and relayfile-cloud's routes on one loopback port, keeping
agents, queues, channels, webhooks, subscriptions and DMs) with fake sessions,
a fake injector and a fake Cloud, and drives the real daemon binary with a
cleared environment. Session discovery and caller identification run against
a fake process table (`process::FakeProcesses`); the Codex and Claude routes
against in-process fakes of `codex queue`, the app-server proxy, the Codex
app's IPC socket and Claude Code's peer inbox; the fleet against a fake broker;
the relay-send socket over a real Unix socket with fake callers. No broker, PTY
runtime or agent harness is started by any test, and no test can find a real
`codex` or `claude`.

```sh
agent-relay-node serve &
agent-relay-node call status.get --json
agent-relay-node call workspace.refresh --json
agent-relay-node call agents.list --json
agent-relay-node call roster.list --json
agent-relay-node call sessions.list --json
agent-relay-node call fleet.list --json
curl -s --unix-socket "$(cat ~/.agentworkforce/desktop/relay-socket)" http://relay/whoami
agent-relay-node call daemon.shutdown --json
```

A Connect inbox read that remains pending across heartbeat intervals does not
stop later presence cohorts or pending refusal settlement attempts. Each timer
refreshes the current registrations before scheduling due work; cohorts remain
single-flight and retain per-workspace pacing.

Native spawn controls use the same authenticated, same-user core bridge as the apps.
The named caller must remain a non-archived local registration with a stored token
and an exact origin/workspace-key match to the active workspace. The core never
returns that token. Invoke and release require a persisted caller-chosen
idempotency key (at least 16 ASCII letters, digits, underscores or hyphens).
The fixed native routes go through the SDK diagnostic HTTP boundary; there is no
caller-controlled URL, header, credential, arbitrary action or HTTP method.
Release claims under `spawn-control-releases/` store only immutable target
identities; their filenames scope keys to workspace and caller without storing
credentials. The control bridge adds no user-facing layout or platform-specific UI.

```sh
agent-relay-node call spawn.targets --json
agent-relay-node call spawn.status --params '{"caller_name":"my-local-agent","action":"spawn","invocation_id":"invocation_id_from_receipt"}' --json
```

## Exact provider event subscriptions

The session socket accepts an optional `event_types` list on
`POST /integrations/subscribe`; the bridge method
`agents.integrations.subscribe` accepts the same list alongside `name`.
For example, to receive new Jira comments in the calling registered session:

```json
{"provider":"jira","resource":"/jira/issues/*/comments/*.json","event_types":["comment_created"]}
```

Jira native aliases (`comment_created`, `jira:issue_created`) normalize to
`comment.created` and `issue.created`. Names must be exact; wildcards, empty names,
non-string elements and lists longer than 32 entries are refused. Omitted or empty
lists retain all events under the path. Creation, `/setup/status`, and
`agents.list` expose the effective normalized filter. A repeated request is
already subscribed only when both the path and the effective filter match.
Changing the filter on an existing resource requires unsubscribing that resource
first; `DELETE /integrations/subscribe` takes provider/resource only.

The core checks RelayFile's event-filter capability before creating a filtered
webhook and requires the creation response to confirm the effective list. An
older server is refused before it can create a broad subscription. Deploy
RelayFile's filter support before adopting this core. Delivery is filtered using
trusted provider event metadata at RelayFile, before Relaycast or chat injection;
comment edits/deletions and generic file syncs cannot turn a new-comment-only
subscription into extra chat turns.

Filtered GitHub pull-request subscriptions must explicitly include
`pull_request.closed` so terminal cleanup can finish; incompatible filters fail
before setup. Recovery through `agents.integrations.clean_up` accepts copied
`event_types` metadata; ordinary unsubscribe is by provider and resource.
After the last unsubscribe, the reserved channel identity remains as a routing
tombstone so leftover queued events stay on integration admission and are skipped
without a matching ready subscription. A later subscription verifies channel
membership again before becoming ready.
Explicitly requested push/edit events bypass broad-subscription
noise suppression only for a matching ready resource. Unfiltered subscriptions
keep the existing noise rules. Jira aliases are case-insensitive and limited to
the issue, comment, and sprint lifecycle events registered by `jira-relay`:
`issue.created/updated/deleted`, `comment.created/updated/deleted`, and
`sprint.created/updated/started/closed/deleted`. Native underscore names and the
`jira:` prefix are aliases; other Jira actions fail with a specific validation
message. An unconfirmed webhook is journaled and deleted immediately; events
received during setup stay queued until its result is committed. Pending, failed or
rejected filtered subscriptions cannot authorize delivery on the shared event
channel.
