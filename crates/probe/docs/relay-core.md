# Relay core

> Imported from relay-desktop with the core (see `docs/probe-move.md` at the
> relay repository root). Paths written `probe/…` here mean `crates/probe/…`;
> the macOS, Linux and Windows apps (`macos/`, `probe/src/linux_app`,
> `windows/`) and the documents cited as "relay-desktop" stay in relay-desktop.

The relay core is the desktop's entire non-UI runtime. It is Rust, it lives
in the `agent-relay-probe` binary every desktop build already bundles and
signs, and it runs as one long-lived daemon per user:

```sh
agent-relay-probe relay serve [--socket PATH] [--app-data-dir PATH] [--site-url URL] [--exit-on-stdin-eof] [--headless [--cli-managed]]
```

A relative `--socket` lives beside the default socket and a relative
`--app-data-dir` beside the default data directory, so a launchd property
list names them without `~`.

The macOS app (SwiftUI) and the GTK app, which serves Linux and Windows
(the same `agent-relay` program built for each), are thin native UIs. They
render the core's state and send it commands over one bridge contract; they
make no Relaycast, Cloud or broker requests, spawn no harness, and read no
agent credentials. The Linux headless service and the Windows logon task are
the daemon itself.

```text
 ┌────── macOS app ──────┐ ┌────── Linux app ──────┐ ┌───── Windows app ─────┐
 │ SwiftUI · menu bar ·  │ │ GTK · tray ·          │ │ GTK · tray · toasts · │
 │ notifications ·       │ │ notifications ·       │ │ ShellExecute ·        │
 │ SMAppService ·        │ │ xdg-open · clipboard  │ │ clipboard             │
 │ self-update · browser │ │                       │ │                       │
 │ (core: LaunchAgent)   │ │ (core: systemd unit)  │ │ (core: logon task)    │
 └───────────┬───────────┘ └───────────┬───────────┘ └───────────┬───────────┘
             └─────────────────────────┼─────────────────────────┘
                                       │ JSON-RPC 2.0 NDJSON over ~/.agentworkforce/desktop/core.sock
                                       │ (on Windows, a named pipe named for that path)
                                       ▼
 ┌───────────────────────── agent-relay-probe relay serve ─────────────────────┐
 │ workspace discovery · Relaycast (relaycast SDK) · push channels · delivery  │
 │ injectable agents · relay-send socket · fleet · setup API · Cloud sign-in   │
 │ messaging · people · integrations · Cloud model endpoints                    │
 │ uploader supervision (the probe's own capture/upload, in process)           │
 └─────────────────────────────────────────────────────────────────────────────┘
        │ relaycast SDK            │ Cloud HTTP          │ loopback broker   │ codex/claude
        ▼                          ▼                     ▼                   ▼
  cast.agentrelay.com        agentrelay.com/cloud   /api/spawned       queue · inbox · CLI
```

## What stays in the UI

The rule: code that draws pixels or calls a platform UI API stays in the app;
everything else is in the core.

| Concern                                                         | Where                    | Why                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Views, menu bar / tray, windows, dialogs, clipboard             | UI                       | Pixels and platform UI APIs                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Opening a browser (sign-in approval, integration connect links) | UI                       | `NSWorkspace` / `xdg-open` / `ShellExecute`. The core emits the URL on the `sign_in` event; the loopback OAuth receiver, PKCE and device-code polling are core                                                                                                                                                                                                                                                                              |
| Notifications                                                   | UI                       | `UserNotifications` / `Gio.Notification` / Windows toast notifications. The core emits `notify` events with the text                                                                                                                                                                                                                                                                                                                        |
| macOS launch at login                                           | UI                       | `SMAppService` is a platform API: `.agent` registers the core's LaunchAgent, `.mainApp` opens the app at login when the person chooses. Linux autostart is a `.desktop` file and is core (`login_item.set`)                                                                                                                                                                                                                                 |
| Windows launch at login                                         | UI                       | The background service is a per-user logon task (Task Scheduler, through `schtasks`, no administrator rights) that runs `agent-relay.exe --headless`; the app registers it, off, for a per-user install and turns it on and off from Settings, as it does the systemd user unit on Linux                                                                                                                                                    |
| Self-update                                                     | UI                       | It replaces the files the daemon runs from and relaunches the app, so it cannot run inside the daemon. macOS installs the DMG; a Linux per-user install unpacks the verified tarball beside the running version and repoints the systemd user unit, and a `.deb` install downloads the verified package for the package manager; a Windows per-user install unpacks the verified zip beside the running version and repoints the logon task |
| Wording, relative times, search filters, layout of status       | UI                       | Presentation. The core supplies typed state (`uploader.stage`, `needs_start`, timestamps), never display strings                                                                                                                                                                                                                                                                                                                            |
| Deep-link delivery (`agentrelay://`)                            | UI receives, core parses | The platform hands the URL to the app; `links.parse` validates it                                                                                                                                                                                                                                                                                                                                                                           |
| PostHog telemetry                                               | Core                     | One schema for both apps. The core records the operations it runs (sign-in, uploader commands, disconnect); the UI calls `telemetry.record` for UI-only ones; queueing, rate limits, identity and opt-out (`settings.set {"analytics_enabled"}`) are core                                                                                                                                                                                   |
| Keychain (desktop mailbox credential)                           | Core                     | Not UI: `security-framework` on macOS, a 0600 file on Linux, the same file in the user profile on Windows                                                                                                                                                                                                                                                                                                                                   |
| Bridge endpoint                                                 | Core                     | A Unix socket on macOS and Linux; on Windows a named pipe, `\\.\pipe\agent-relay-<hash of the socket path>`, whose DACL admits only the current user (`relay::transport`)                                                                                                                                                                                                                                                                   |

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
  token. `relay call` likewise speaks only to a daemon run by this user.
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
platforms more than one client (the app, `relay call`, support tooling) must
reach the same daemon. One transport serves every case.

Startup applies the subscription's initial status before loading settings and
collections. The event stream stays live while those reads run in the background.
Both apps bound handshakes to 5 seconds and list/status reads to 30 seconds;
long-running commands retain an 11-minute budget for uploader startup. A timeout
ends that request's connection without replaying the command. A 20-second startup
watchdog exposes retry and diagnostics if the service has not become ready.

## Lifecycle

- **Single instance.** `relay serve` takes an exclusive `flock` on
  `<socket>.lock` (0600) for its whole life. A second daemon for the same
  socket exits 1 with `Agent Relay core is already running for this socket.`;
  its host connects to the running one instead. Holding the lock, the daemon
  replaces a leftover socket file, but never deletes a path that is not a
  socket.
- **macOS.** The core is a launchd LaunchAgent the app registers with
  `SMAppService.agent(plistName:)`: `Contents/Library/LaunchAgents/com.agentrelay.desktop.core.plist`
  runs `BundleProgram` `Contents/Helpers/Agent Relay Helper` (the
  `agent-relay-probe` binary, named for Activity Monitor) with `relay serve`,
  `RunAtLoad` and `KeepAlive`. The session collector the core starts runs as
  the hard link beside it, `Agent Relay Helper (Sessions)`, so Activity
  Monitor tells the two apart. It runs at login with no window, keeps
  delivering through app crashes, quits and updates, and launchd restarts it
  when it exits, as systemd does on Linux. The app registers the agent when it
  is not registered, and again for each new build (a new core binary or app
  executable, development reloads included), which retires the core
  registered before. launchd admits the core against a code requirement
  Background Task Management records for the agent: a team (Developer ID,
  Apple Development), which an update keeps, or for an ad-hoc signature the
  old binary's hash, which BTM keeps for a while after the bundle changes; so
  while an enabled core does not answer, the app registers it again (a
  bounded number of times) until the new hash is recorded. While macOS waits for
  approval the app opens **System Settings › General › Login Items**. It then
  connects with backoff while launchd starts the core. Agent Relay Dev
  registers `com.agentrelay.desktop.dev.core` with `--socket core.dev.sock
--app-data-dir com.agentrelay.desktop.dev --site-url <its site>`. The agent
  stays registered across sign-out: agents on this Mac's relay workspace need
  no Agent Relay sign-in. With **Settings › General › Keep agents connected
  after quitting** off (it is on by default), quitting the app unregisters it,
  which stops it until the app opens again; removing the app removes it. The
  app's own login item only brings back the menu bar and notifications, so it is the person's choice and off until they make it.
- **Linux.** The systemd user unit (`Restart=always`, `UMask=0077`) runs
  `/usr/lib/agent-relay/agent-relay-probe relay serve --headless`;
  `/usr/bin/agent-relay --headless` execs the same. Headless, the
  core removes the app-owned GUI autostart entry (systemd starts Agent Relay;
  the entry would start a second copy), never turns launch at login on after
  a sign-in, and applies the agent-led setup defaults at start. The GTK app
  connects to the socket; when no daemon answers it starts one as its child
  and starts it again with backoff when it exits unexpectedly. Quitting
  leaves that core running, as on the Mac, unless **Keep agents connected
  after quitting** is off: then the app stops it with `daemon.shutdown`, and
  turning the setting off first turns off the systemd unit with the person's
  agreement. A core an earlier run left running on another version is
  stopped and replaced.
- **The relay CLI.** `relay init` attaches to whichever core answers on the
  socket and starts one only when none does:
  `agent-relay-probe relay serve --headless --cli-managed`. `--cli-managed`
  keeps the app's login entry and turns on no defaults by itself (neither the
  agent-led defaults at start nor the integration defaults of each refresh
  pass); the CLI turns on the delivery settings the person chose through
  `settings.set` and turns them off again on `relay init --uninstall`. See
  `docs/probe-move.md` at the relay repository root.
- **Shutdown.** SIGTERM, SIGINT, `daemon.shutdown`, or stdin closing (with
  `--exit-on-stdin-eof`). The daemon publishes the `shutdown` event to every
  greeted client, stops push channels, closes connections, and removes its
  socket only if the inode is still its own.
- **Upgrades.** A client that finds a daemon on another bridge version may
  call `daemon.shutdown` without a handshake; launchd, systemd or the hosting
  app starts the new binary. The Mac app also stops a core whose
  `daemon_version` differs from the version its bundle carries (once per core
  pid), since an update replaces the binary under a running core.

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

The contract is defined once, in Rust: `probe/src/relay/contract` registers
every method with its parameter and result types and every topic with its
payload type; `relay::protocol` holds the envelopes, `ErrorKind` and `Topic`.
The server answers a method only through the registry's typed `answer`, so a
handler cannot return anything but its registered type, and parameters are
read before a handler runs. The Swift client's types are generated from the
registry, never written by hand:

| Generated                                           | For   | Shape                                                                                                                                                                                                                                                                        |
| --------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `macos/Sources/RelayDesktopCore/CoreContract.swift` | macOS | Plain `Codable` structs and enums, the method names (`CoreMethod`), `CoreEvent`, and one typed `CoreClient` call per pooled method (`client.agentsList()`); `CoreClient` sends the connection-scoped methods (`hello`, `subscribe`, `unsubscribe`, `daemon.shutdown`) itself |

`scripts/generate-contract.sh` regenerates it (`cargo run --bin
relay-contract-codegen`). CI runs it and fails on `git diff --exit-code`;
`cargo test` also fails when the file is stale, when a registered method
reaches no handler, when the method names in this document's method tables
differ from the registry, when its error table differs from `ErrorKind` (kinds,
codes and retryability), and when its topic table names other topics. The
tables' parameter, result and payload descriptions are prose, checked by
review. Every enum a client reads accepts a value it does not know, because a
core of another version than the app (normal mid-update, until the app retires
it with `daemon.shutdown`) can send one: Swift reads it as the enum's named
fallback (`x-fallback`) when it has one, else as `unknown(value)`.

The Linux app's client (`linux_app::bridge`) uses the registry's own
types, so every registered type serializes and deserializes, and a test checks
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
| `relaycast_refused`       | -32000 | no        | Relaycast refused the request as made (other 4xx, such as 400 or 422, or plan quota exhaustion)             |
| `unauthorized`            | -32000 | no        | Relaycast rejected the credential                                                                           |
| `rate_limited`            | -32000 | yes       | Relaycast is temporarily rate limiting                                                                      |
| `not_found`               | -32000 | no        | Relaycast, or this computer, has no such resource (an address no agent is at, an agent not registered here) |
| `conflict`                | -32000 | no        | A conflicting change (a name taken in the workspace or by another session here)                             |
| `shutting_down`           | -32000 | yes       | The daemon is stopping                                                                                      |
| `busy`                    | -32000 | yes       | Another change to the same agent or session is still running                                                |
| `store_failed`            | -32000 | no        | The agent store could not be saved, so nothing changed                                                      |
| `fleet_unavailable`       | -32000 | yes       | Whether this computer's relay already manages the session could not be read, so it is not registered now    |
| `cloud_failed`            | -32000 | yes       | Agent Relay Cloud (or relayfile) could not be reached or failed                                             |
| `cloud_refused`           | -32000 | no        | Agent Relay Cloud refused the request; `message` is its own text when it sent one                           |
| `uploader_failed`         | -32000 | no        | The probe's uploader command failed or ran out of time; `message` is the probe's own sentence               |
| `history_unavailable`     | -32000 | no        | Needs session history, which this core was built without (relay's build); see below                         |

A core built without session history (`--no-default-features --features
production-binaries`, the build relay ships) keeps every method in the
contract, so the apps see one contract. It answers the history-only methods
(`relay::contract::HISTORY_METHODS`: every `uploader.*` method and
`sessions.transcript`) with `history_unavailable` before reading their
parameters, and a change to `history_retention_days` likewise (the setting
reads its default, 30). `status.get`'s `daemon.history_version` is null in
that build. Nothing is sent to Devin Cloud: a send to a cloud-shaped Devin id
keeps the local answer (`Waiting` while no local session holds it). Cloud
sign-in (`account.sign_in`) adopts the workspace but ends in `error` with the
same sentence, since its `cloud install` sets up the uploader; the workspace
the `agent-relay` CLI selects is used without signing in. Agent-led setup
closes its bootstrap without an uploader, and `POST /setup/sharing` answers
`setup_unavailable`.

Provider `plan_limit_exceeded` responses (including HTTP 429) are reported
as `relaycast_refused`, with a safe instruction to upgrade the workspace plan
or wait for its quota reset before retrying. Registration and rename failures
retain that explanation alongside the operation context in both apps. Ordinary
HTTP 429 throttling remains retryable. Background workspace quota pacing is
unchanged; raw provider response bodies are never shown.

### Versioning

`bridge_version` is `2`. Adding methods, optional parameters, result fields,
topics or error kinds does not change it; clients ignore what they do not
know and feature-detect with `hello.methods`. Removing or renaming anything,
or changing a meaning, increments it. The app and the core ship in one bundle
and one package, so a mismatch means a stale daemon, handled as above.

### State and events

Session tables read shared daemon snapshots. `sessions.list` overlays current
registration and push state onto the last completed live-discovery pass; opening
a window never launches discovery. A separate background pass refreshes the
history/upload list and emits `uploader` invalidations only when it changes.
`uploader.sessions.list` uses that memory snapshot, seeding a cold daemon from
the collector's durable catalog (`sessions list --catalog-only`) without opening
transcripts or parsing pending upload batches. Included cold rows show `checking`
until enrichment verifies upload state. Cache coverage follows the largest
requested page; account/workspace changes and mutations fence out older reads.
Failed background reads keep the previous snapshot. Global `uploader.status`
is also cached for presentation and refreshed on a separate background cadence;
collector supervision always reads fresh process state. Both clients fetch history
and global uploader status independently so neither live discovery nor upload
status delays cached rows. Cold installs still require their first inventory pass.

The UI renders one snapshot, returned by `status.get` and by `subscribe`:

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
  "account": {
    "state": "signed_in",
    "phase": null,
    "error": null,
    "action": null,
    "reused_login": null,
    "site_url": "https://agentrelay.com",
    "workspace_id": "0f8fad5b-d9cb-469f-a165-70867728950e",
    "workspace_name": "Acme",
    "person": { "id": "user_1", "name": "Ada", "email": "ada@example.com", "avatar_url": null },
    "progress": null
  }
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
- `account.state`: `signed_out` | `pending_approval` | `preparing` |
  `signed_in` | `denied` | `expired` | `error` (the last three with
  `error`). `phase` (while not settled):
  `checking_existing_login`, `reusing_existing_login`, `waiting_for_browser`,
  `waiting_for_device_approval`, `connecting_workspace`,
  `preparing_local_sessions`. `error` is a sentence; `action`
  The `selecting_workspace` phase exposes `workspace_choices` (id, name, organization_name) on the native welcome screen before provisioning.
  `acknowledge_uninspected_schedules` means `account.sign_in` with that flag
  set gets past it. `progress` is local capture while sessions are prepared:
  `{"phase","source","processed_files","total_files","sessions_captured"}`.
  `workspace_id` is the Agent Relay (Cloud) workspace; `person` is who the
  uploader is connected as. No token is ever in the snapshot.

Events are notifications on the connection that subscribed:

```json
{"jsonrpc":"2.0","method":"event","params":{"topic":"status","seq":12,"data":{…snapshot…}}}
```

| Topic         | data                                                                                                                                         | Notes                                                                                                                                                                                                            |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`      | The whole snapshot                                                                                                                           | After every change. Replace, never merge; ignore one whose `revision` is not newer than what is shown                                                                                                            |
| `activity`    | `{"level":"info"\|"warning"\|"error","message":"…","at_ms":…}`                                                                               | Append-only log lines                                                                                                                                                                                            |
| `shutdown`    | `{}`                                                                                                                                         | Sent to every greeted client, subscribed or not; the connection then closes                                                                                                                                      |
| `invalidated` | `{"what":"sessions"\|"agents"\|"roster"\|"fleet"\|"messages"\|"people"\|"activity"\|"uploader"\|"chat"\|"projects"\|"incoming"\|"settings"}` | Re-fetch that collection (2a; `sessions`, `fleet` 2b — compared every 5 s —; `uploader`, `chat`, `projects`, `incoming` 2c; `settings` when an agent changed one through the session socket's `PATCH /settings`) |
| `sign_in`     | `status.account` plus `{"verification_url","verification_url_complete","user_code","expires_at","interval"}` (null when no link is waiting)  | After every sign-in step; the UI opens `verification_url_complete` when it appears (2c)                                                                                                                          |
| `notify`      | `{"title","body","link"}`                                                                                                                    | The UI shows a notification; `link` (nullable) opens on click, e.g. a provider's connect page (2a)                                                                                                               |

`seq` increases by one per event across all topics, so a client sees gaps
for topics it is not subscribed to. A client that falls more than 256 events
behind skips the backlog: if subscribed to `status`, it receives one fresh
`status` event in its place, and skipped `activity` lines are not resent.

### Methods

`Lands in` names the stacked PR that implements a method; everything else in
this document describes the finished system.

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

**Workspace and account**

| Method                      | Params                                                                                                                               | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Lands in |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `account.status`            | —                                                                                                                                    | As the `sign_in` topic: `status.account` plus the waiting link's fields, null when none is waiting                                                                                                                                                                                                                                                                                                                                                                                                                                    | 2c       |
| `account.sign_in`           | `{"site_url"?, "workspace"?, "sharing":"all"\|"new"\|"selected", "acknowledge_uninspected_schedules"?, "flow"?:"browser"\|"device"}` | As `account.status`, at once; the attempt continues in the background and reports on `sign_in`. While one is running, or once signed in, answers where it stands; signed in with no session the core can call Cloud with as the person (the official CLI's it borrowed expired, or Cloud refused the kept one), it asks the person again (`flow` as above, the browser reusing a signed-in browser) and keeps the session, leaving the uploader's connection alone; an approval as another person than the connection's keeps nothing | 2c       |
| `account.select_workspace`  | `{"workspace_id":"<uuid>"}`                                                                                                          | `{}`; completes the native `selecting_workspace` phase using one of `account.workspace_choices`. Setup waits for this choice; cancellation leaves the workspace unconnected                                                                                                                                                                                                                                                                                                                                                           | 2c       |
| `account.sign_in.cancel`    | —                                                                                                                                    | `{}`; a sign-in that has not finished leaves nothing behind: the Cloud session and workspace key it kept go back to what they were (a reused kept session stays), and a connection its `cloud install` made is disconnected (as `account.sign_out` does), with nothing attaching it meanwhile                                                                                                                                                                                                                                         | 2c       |
| `account.sign_out`          | —                                                                                                                                    | `{}`; forgets and revokes the Cloud session, stops every uploader command, disconnects this computer's install, deactivates the mailbox; `uploader_failed` when the disconnect did not finish (the next sign-in retries it first)                                                                                                                                                                                                                                                                                                     | 2c       |
| `account.connect_workspace` | `{"workspace_id":"<uuid>"}`                                                                                                          | `status.workspace`; Cloud `/workspaces/{id}/resolve` with the kept session, else after a browser sign-in (instant in a signed-in browser)                                                                                                                                                                                                                                                                                                                                                                                             | 2c       |

Sign-in (`relay::account`):

1. **A session.** With `flow` omitted, clients reuse an eligible
   saved app or CLI session, otherwise open the browser's Cloud session. Cloud
   asks for Google sign-in only when the browser is signed out. The browser
   returns through a PKCE loopback receiver, without device-code confirmation.
   Explicit `flow: "browser"` requests bypass saved sessions and open Google's
   account chooser. The logged-out desktop **Sign in with Google** action
   always sends this explicit browser flow on macOS, Linux and Windows. `flow: "device"` reuses an
   eligible session first, otherwise requests device approval for remote or
   headless clients. `/setup/sign-in` preserves that device default for existing
   callers; `flow: "browser"` there opts into the normal desktop continuation.
   Cloud returns a short-lived handoff token traded at `/auth/desktop/session`
   with the verifier for a renewable session. A return for another attempt or
   site is turned away.
2. **Who and where.** `whoami`; the workspace is `workspace`, else Cloud's
   current one.
3. **Kept.** The session is kept (never the CLI's) in the agent store's
   `cloudSession`, on both platforms; the probe's RelayHistory renewal
   reads it there (after the official CLI's), in the data directory the
   core runs it with (`AGENT_RELAY_APP_DATA_DIR`). While the uploader
   reports a job blocked on `authentication_required`, supervision refreshes
   the kept session whenever it has under five minutes left, so that renewal
   finds a live one. A refresh Cloud fails backs off from one supervision
   period, doubling to 32. The Linux app's former `cloud-session.json` is
   imported once and removed.
4. **The account workspace.** `/workspaces/{id}/resolve` puts its Relaycast
   key in the store's `cloud`, the one workspace key messaging uses; a
   workspace that shares none is reported in activity, not fatal.
5. **The uploader.** `cloud install --json` runs with the session as
   `CLOUD_API_ACCESS_TOKEN`, so the probe connects without a second approval;
   its events become `phase` and `progress`. Done when `installs` lists the
   connection.

Every Cloud call as the person (`CloudAccess::request`) uses, in order,
`CLOUD_API_ACCESS_TOKEN`, the kept session, else, only when this app keeps
no session for the site, the official CLI's live one (it may be another
person); a kept session that cannot be renewed, or a CLI's that expired, fails the
call `not_signed_in`, which `account.sign_in` fixes without disconnecting.
The session overview methods say so: "Your Agent Relay sign-in expired. Sign
in again to view session summaries." A kept session Cloud refuses is refreshed once (refresh
tokens rotate on every use). Only a refused refresh token (400, 401, 403)
forgets it; a rate limit, timeout or outage keeps it for a later try.

**Uploader** — the probe's own commands, run as this binary

| Method                                                                                                                  | Params                                                                           | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Lands in             |
| ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- |
| `uploader.status`                                                                                                       | —                                                                                | `{"running","paused","sharing_mode","directory","collector_replacing","collector_outdated","delivery":{"bootstrap_complete","pending_records","acknowledged_records","skipped_records","unqueued_changes","last_acknowledged_ms","failure"},"sessions":{"total","shared","excluded"},"stage","stage_message","needs_start","journal_full","upgrading"}`, read from the probe's `status --json`; `stage` is `not_running`\|`paused`\|`needs_attention`\|`offline`\|`preparing`\|`uploading`\|`up_to_date`, `stage_message` the probe's sentence for that stage when it has one, `directory` the install's (it holds `collector.log`); `not_signed_in` when nothing is connected                                                                                                                                                             | 2c, 3 (`directory`)  |
| `uploader.start` / `uploader.pause` / `uploader.resume` / `uploader.retry` / `uploader.compact` / `uploader.disconnect` | —                                                                                | `{"running","started"}`, `{"paused"}`, `{"paused"}`, `{"retried"}`, `{"removed_records"}`, `{"disconnected"}`, from the `--json` commands. `uploader.retry` restarts a job a non-retryable verdict blocked, or wakes an active job waiting out a `transient` failure's backoff (its attempt count is kept); `retried` is `true` when it did either. A paused or cancelled job, a batch in flight and a `rate_limited` wait (the receiver asked for less traffic, including when a sibling batch of the same window then failed transiently) are left as they are and answer `false`. Both apps offer Retry for a stop and for a lasting `transient` failure (`stage` `needs_attention`), and send a Retry or Compact the core never received (the bridge's "starting"/"reconnecting" failure) once on their own when the core next answers | 2c                   |
| `uploader.sharing.set`                                                                                                  | `{"mode":"all"\|"new"\|"selected"}`                                              | `{"sharing_mode"}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 2c                   |
| `uploader.sessions.list`                                                                                                | `{"limit"?}`                                                                     | `{"sharing_mode","sessions":[…]}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 2c                   |
| `uploader.sessions.query`                                                                                               | `{"query"?,"sort"?,"ascending"?,"cursor"?,"known_revision"?,"limit"?,"hidden"?}` | `{"sessions":[…],"local_sessions":[…],"archived_keys"?,"next_cursor","revision","candidates_scanned","unchanged","verification_pending"}`; indexed local catalog query with at most 200 candidate rows and a 256 KiB page limit. Optional `archived_keys` contains snapshot classification for only returned rows (at most 200 keys), and counts toward the same encoded page budget. Follow `next_cursor` even after an empty page; `verification_pending` requests a retry without skipping unresolved upload proofs. Cursors retain a bounded recent snapshot and expire explicitly. `known_revision` may suppress a complete unchanged page; incomplete verification must be retried. Global Reasoning sorting is unavailable until that metadata is indexed.                                                                          | paged local sessions |
| `uploader.sessions.facets`                                                                                              | `{"cursor"?,"limit"?}`                                                           | `{"harnesses":[…],"projects":[…],"next_cursor","revision"}`; catalog-wide filter suggestions, independent of the visible session page. Each reply contains at most 200 values and 64 KiB including its cursor. Follow `next_cursor` to complete the suggestions; cursors track the catalog epoch and facet membership, so appends that leave both harness and project membership unchanged do not invalidate them.                                                                                                                                                                                                                                                                                                                                                                                                                         | paged local sessions |
| `uploader.sessions.preview`                                                                                             | `{"limit"?,"refresh"?}`                                                          | `{"sessions":[…]}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 2c                   |
| `uploader.sessions.delete`                                                                                              | `{"session_keys":[…]}`                                                           | `{"updated":n}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 2c                   |
| `uploader.sessions.reset`                                                                                               | `{"confirmation":"DELETE ALL SESSIONS"}`                                         | `{"reset":true}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 2c                   |
| `uploader.sessions.include` / `.exclude`                                                                                | `{"session_keys":[…]}`                                                           | `{"updated":n}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 2c                   |
| `uploader.sessions.delete`                                                                                              | `{"session_keys":[…]}`                                                           | `{"updated":n}`; confirmed deletion of this account’s uploaded copy and delegated subagents, retaining local history. A durable plan reconciles interrupted requests; re-inclusion explicitly clears the server deletion fence.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 2c                   |

The uploader commands are the probe's own `--json` commands, run as child
processes of this very binary, so there is no version skew. They stay
processes because that is what they are built as: each holds its install's
file locks for its life and releases them by exiting; its answer is one JSON
line on stdout and its error one safe sentence on stderr; `start` and
sharing changes launch or replace the detached collector; and a command past
its deadline, or still running at sign-out, is stopped by signal, which a
call into the daemon could not be. A store migration that aborts takes down
that command, never delivery. Deadlines: `installs` and `status` 15 s,
`pause`/`resume` 30 s, `sessions.list` 30 s, `sessions.preview` 3 s (15 s
with `refresh`), `disconnect` 60 s, `compact` 180 s, `start` 10.5 min;
sharing changes and `reclaim` none (killing one would leave uploads stopped,
or redo a migration). At start the daemon lists `installs` (bounded; nothing
waits on it), releases decommissioned installs with `reclaim` in the
background, keeps `~/.local/bin/agent-relay-probe` no older than itself
(never a copy another developer signed), and every 60 s starts the attached
collector again when it stopped or runs an older build, and records when a
running uploader starts or stops failing to deliver (`upload_health`).

Sessions on the relay are uploaded (`relay::relay_uploads`): whenever the
agents change, and on every supervision tick, each registered session the
uploader lists but does not upload is included, once. A session whose
inclusion was refused, or that someone stopped uploading, is not asked for
again until it leaves the relay and returns. With sharing `all` everything
uploads already; an install a newer probe runs is left alone.

**Agents on this computer**

| Method                                              | Params                                                                                                                                                                                         | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Lands in                                                                                                                                   |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `sessions.transcript`                               | `{"source","session_id","cursor"?:{"ts_ms","id"},"following"?:false}`                                                                                                                          | `{"entries":[{"id","role","kind","text","timestamp_ms","truncated"}],"next_cursor"}`; local-only paged conversation. First page hydrates one session in a private reader cache, independent of upload selection. Up to 100 events, 64 KiB per entry and 512 KiB serialized entries per page; oversized text is marked truncated. Requires the account plugin, not an upload.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 2c                                                                                                                                         |
| `sessions.list`                                     | —                                                                                                                                                                                              | `{"sessions":[{"target":{"kind":"codex"\|"claude-terminal"\|"claude-cloud"\|"grok"\|"grok-open"\|"opencode","id"},"title","project","directory","live","updated_at_ms","registration":{"name","address","added_by_session","push","spawn"?:{"harness","can_take_over","taken_over"}}\|null,"suggested_name"}]}`; `spawn` is set on an agent Agent Relay spawned here (see `agents.take_over`); a registered session discovery no longer finds is listed with `live:false`; Grok/OpenCode rows come only from the verified probe-owned registry, plus `grok-open` rows from the already-open registry when `AGENT_RELAY_ENABLE_EXISTING_GROK=1`; a Grok session both registries claim is not listed under either kind                                                                                                                                                                                               | 2b                                                                                                                                         |
| `sessions.title.capability`                         | `{"source","session_id"}`                                                                                                                                                                      | `{"supported","reason"}` (`reason` is null when supported); native title-edit support for the exact catalog identity, including history-only rows; unsupported providers or unavailable sessions include an explanation. Available without an account.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | native session titles                                                                                                                      |
| `sessions.title.set`                                | `{"source","session_id","title"}`                                                                                                                                                              | `{"title"}` after the native provider acknowledges the metadata change; trims outer whitespace, accepts 1–200 characters without control characters, and applies provider-specific limits. Uses trusted discovery to resolve the catalog identity; accepts no client paths or endpoints. Publishes sessions/uploader invalidations on success. Available without an account. See native title support (relay-desktop `session-title-editing.md`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | native session titles                                                                                                                      |
| `sessions.managed.launch`                           | `{"kind":"grok"\|"opencode","executable","directory","session_id"}`                                                                                                                            | `{"target","title","directory"}` after the default-off probe has launched/supervised the endpoint and verified OS identity plus provider readback; endpoint, pid, socket and credentials are never accepted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | managed provider bridge                                                                                                                    |
| `sessions.existing.register`                        | `{"kind":"grok-open","session_id","directory"}`                                                                                                                                                | `{"target","title","directory"}` after the default-off probe (`AGENT_RELAY_ENABLE_EXISTING_GROK=1`) has found exactly one marker-free Grok leader of this user from the kernel, proved its executable, argv and socket peer, and read back model/version from a `session/load` of that session in `directory`; a session or leader the managed registry holds is refused; process, socket, endpoint and credentials are never accepted                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | already-open Grok route                                                                                                                    |
| `agents.list`                                       | —                                                                                                                                                                                              | `{"agents":[{"name","address","target","title","registered_at","added_by_session","reply_with_final_answer","webhook":{"id","url"}\|null,"integrations":[{"provider","resource","ready"}],"push","delivery_error"}]}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 2a                                                                                                                                         |
| `agents.register`                                   | `{"target":{"kind","id"},"name"?,"description"?}`                                                                                                                                              | `{"name","address","already_registered"}`; a session already registered answers `already_registered: true`; otherwise it must be one `sessions.list` finds live (`refused`); without `name`, its suggested name                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 2a                                                                                                                                         |
| `agents.unregister`                                 | `{"name"}`                                                                                                                                                                                     | `{}`; waits for a delivery in flight; refused while integrations remain                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 2a                                                                                                                                         |
| `agents.rename`                                     | `{"name","new_name"}` (`name` may be either of the agent's names)                                                                                                                              | `{"name","address","released"}`: the session's new and only name, and the earlier name it replaced; renaming back to the registered name makes it current again                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 2a                                                                                                                                         |
| `agents.test_message`                               | `{"name","text"?}`                                                                                                                                                                             | `{"message_id"}`; sent as you when signed in, else as this computer's test sender                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 2a                                                                                                                                         |
| `agents.transcript`                                 | `{"name","cursor"?:{"ts_ms","id"}}`                                                                                                                                                            | `sessions.transcript`'s page plus `follow_cursor`, where what is written next starts: what a spawned agent whose `registration.spawn.can_take_over` is set has said, from its own output (a spawned Claude's stream-json log, `<app data>/spawned-agents/<session>.jsonl`), read from the byte offset in `cursor.id`; a line still being written waits for the next read. `refused` for an agent without a transcript of its own (a spawned Codex thread: read its session with `sessions.transcript`), `not_found` for an unknown name                                                                                                                                                                                                                                                                                                                                                                            | native spawn                                                                                                                               |
| `agents.take_over`                                  | `{"name","interrupt"?}`                                                                                                                                                                        | `{"name","target","directory","interrupted"}` once the spawned agent's headless process has stopped, so the session is the caller's to resume (`claude --resume <id>` in `directory`): exactly one process runs a session. Without `interrupt` it first waits up to 10 minutes for a running turn to end (`busy` after); a second call with `interrupt` while one waits makes it stop the agent at once, and both answer alike. The agent keeps its name, address and place; its process becomes whichever one runs the session, and releasing it leaves that process alone. Taking over one already taken over answers again without stopping anything; `refused` for a harness that cannot be taken over (Codex: open its thread in Codex)                                                                                                                                                                       | native spawn                                                                                                                               |
| `agents.reply_setting`                              | `{"name","enabled":true\|false\|null}`                                                                                                                                                         | `{}`; `null` answers automatically only when the session cannot reply itself                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 2a                                                                                                                                         |
| `agents.webhook.create`                             | `{"name"}`                                                                                                                                                                                     | `{"id","url","secret"\|null,"created"}`; the secret only to the call that created it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 2a                                                                                                                                         |
| `agents.webhook.revoke`                             | `{"name"}`                                                                                                                                                                                     | `{"already_deleted"}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 2a                                                                                                                                         |
| `agents.integrations.subscribe`                     | `{"name","provider","resource"}`                                                                                                                                                               | `{"subscribed":true,"provider","resource","path_glob"}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 2a                                                                                                                                         |
| `agents.integrations.unsubscribe` / `.clean_up`     | `{"name","provider","resource"}`                                                                                                                                                               | `{"subscribed":false,"provider","resource","already_unsubscribed"?}`; also finishes an unfinished subscription                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 2a                                                                                                                                         |
| `settings.get` / `settings.set`                     | `{"allow_self_registration"?, "auto_activate"?, "claude_session_hook"?, "direct_delivery"?, "direct_delivery_default"?, "devin_direct_delivery"?, "pi_extension"?, "pi_auto_activate"?, "opencode_auto_activate"?, "analytics_enabled"?, "contractor_access"?}` | All settings, plus the read-only `direct_delivery_managed` (the organization's `crossSessionInbound`, absent when it sets none); `direct_delivery_default` is write-only: `true` sets `accept` unless the user's own Claude settings already name `crossSessionInbound`, `false` changes nothing; `claude_session_hook` is off unless turned on and absent when no Claude login directory exists (the SessionStart hook never registers a session; with it come Claude `permissions.allow` rules for this probe's self-limiting commands on the session socket: `relay read`, `relay send`, `relay connect-send`, `relay fetch-attachment`, `relay agents`, `relay whoami` and `relay subscribe-channel`, recorded in `claude-permission-rules.json` and taken out with it); `devin_direct_delivery` adds or removes Agent Relay's lifecycle hooks in `~/.config/devin/config.json`, on by default where Devin has run, and absent where it has not; `pi_extension` installs or removes Agent Relay's extension in `~/.pi/agent/extensions` (only its own file), installed at start by a desktop core unless turned off and only on request by a `--cli-managed` one; while it is off no Pi session is listed and new messages to Pi are refused, even for a session that loaded the extension earlier, though a message already queued before it was turned off stays accepted and that loaded extension can still deliver it; absent where Pi has not run; `pi_auto_activate` and `opencode_auto_activate` (off unless turned on; `relay init` turns on the one for each tool chosen) let an open Pi or OpenCode session join by itself while `auto_activate` is on, which alone never activates those kinds; a setting the core runs without is `invalid_params`, and so are an unknown or read-only key and a non-boolean, which change nothing                                                                                                                                                    | 2a (store settings), 2b (`direct_delivery`, `claude_session_hook`, `devin_direct_delivery`), 2c (`analytics_enabled`, `contractor_access`) |
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
| `spawn.invoke`                               | `{"caller_name","node_id","node_name","name","harness","task","directory","idempotency_key"}`                                        | Typed native invocation receipt; exact advertised target, which must be this computer's own spawn node (status and release can only bind a worker spawned here), and absolute folder required                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 2b       |
| `spawn.status`                               | `{"caller_name","action":"spawn"\|"release","invocation_id"}`                                                                        | Typed native invocation status; agent_id/name/node are enriched only from an exact same-workspace local spawn invocation, whether or not the worker still runs; raw input/output and provider error text are omitted                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 2b       |
| `spawn.release`                              | `{"caller_name","node_id","node_name","name","expected_agent_id","idempotency_key"}`                                                 | Typed exact-release receipt; first release proves a local spawn by its exact saved identity (a crashed or ended worker included), private credential-free claims permit identical replay after removal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 2b       |
| `spawn.claim.retry`                          | —                                                                                                                                    | Asks Agent Relay Cloud at once to record this computer's spawn node as the signed-in person's, whatever the backoff after a failed claim (`status.spawn.claim`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 2b       |
| `fleet.list`                                 | —                                                                                                                                    | `{"brokers":[{"node_id","name","workspace_id"?,"error"?,"workers":[{"id":"<node>\|<name>","name","provider","provider_label","model","runtime_kind","session_id","channels","generation","state":"starting"\|"working"\|"idle"\|"waiting"\|"unknown","pending_messages","last_activity_ms","target":{"kind","id"}\|null}]}]}`; a broker that cannot be read has an `error`, never an empty list                                                                                                                                                                                                                                                                                            | 2b       |
| `fleet.release`                              | `{"node_id","name","generation"}`                                                                                                    | `{}`; generation-checked (`conflict` when the broker's worker is another generation, `not_found` when gone)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 2b       |
| `cursor_cloud.models.list`                   | `{}`                                                                                                                                 | Cursor Cloud models available through the workspace's Cloud-held credential                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 2a       |
| `cursor_cloud.repositories.list`             | `{}`                                                                                                                                 | Cached Cursor-accessible repositories, with freshness and stale-fallback state                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 2a       |
| `cursor_cloud.environments.list`             | `{"query"?,"owner"?,"named"?,"repo"?:[],"user_id"?,"cursor"?,"limit"?}`                                                              | Cursor Cloud environments and pagination cursor                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 2a       |
| `cursor_cloud.agents.list`                   | `{"cursor"?,"limit"?,"include_archived"?}`                                                                                           | Cursor Cloud's durable agents plus their Relay binding state and pagination cursor                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 2a       |
| `cursor_cloud.agents.spawn`                  | `{"client_request_id","task","name"?,"repositories"?,"model"?,"environment"?,"work_on_current_branch"?,"auto_create_pull_request"?}` | Creates a durable Cursor Cloud agent and initial run; Cloud makes `client_request_id` idempotent and begins its Relay binding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 2a       |
| `cursor_cloud.agents.get`                    | `{"agent_id"}`                                                                                                                       | Durable Cursor state (`ACTIVE`, `IDLE`, or `ARCHIVED`), latest run, repositories and Relay binding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 2a       |
| `cursor_cloud.runs.create`                   | `{"agent_id","client_request_id","task","delivery"?:"steer"\|"run"}`                                                                 | Injects a follow-up with `steer` by default (accepted by the running turn or queued next), or explicitly starts a run that refuses a busy agent                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 2a       |
| `cursor_cloud.runs.list`                     | `{"agent_id","cursor"?,"limit"?}`                                                                                                    | Paginated native runs for durable settlement and recovery                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 2a       |
| `cursor_cloud.runs.get`                      | `{"agent_id","run_id"}`                                                                                                              | Run state, final result, duration and pushed branches or pull requests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 2a       |
| `cursor_cloud.runs.cancel`                   | `{"agent_id","run_id"}`                                                                                                              | Cancels a live run without deleting the durable agent                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 2a       |
| `cursor_cloud.agents.archive` / `.unarchive` | `{"agent_id"}`                                                                                                                       | Reversible release/restore plus Relay binding state; the core never permanently deletes a Cursor Cloud agent                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 2a       |
| `replicas.environments.list`                 | `{}`                                                                                                                                 | Environments visible to the workspace's Cloud-held Replicas key                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 2a       |
| `replicas.spawn`                             | `{"client_request_id","environment_id","name","task","coding_agent"?,"model"?,"report_to"?}`                                         | Durable launch and relay binding; retain `spawn_id` and reuse the request id on retries                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 2a       |
| `replicas.spawn.get`                         | `{"spawn_id"}`                                                                                                                       | Continues preparation, helper installation and binding; reports uncertain outcomes explicitly                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 2a       |
| `replicas.release`                           | `{"spawn_id"}`                                                                                                                       | Revokes the relay binding and sleeps the replica, preserving its history                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 2a       |
| `capy.projects.list`                         | `{"cursor"?}`                                                                                                                        | `{"projects":[{"id","name"}],"truncated","next_cursor"}`; Capy projects visible to the workspace's Cloud-held key                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 2a       |
| `capy.threads.spawn`                         | `{"client_request_id","project_id","task","model","pull_request_author":"user"\|"capy"?,"report_to"?}`                               | `{"thread_id","title","status","binding":{"state":"pending"\|"bound","agent"?}}`; Cloud keeps the Capy key and makes retries with one client request id idempotent. `model` is required (Capy has no default): a missing or blank one is `invalid_params`, naming the field with an example such as `anthropic/claude-sonnet-5-5`, before Cloud is called                                                                                                                                                                                                                                                                                                                                  | 2a       |
| `capy.threads.get`                           | `{"thread_id"}`                                                                                                                      | The same thread and relay-binding status as `capy.threads.spawn`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 2a       |
| `messages.conversations`                     | —                                                                                                                                    | `{"identity","conversations":[{"id","peer":{"name","agent_id"},"last_message","unread_count"}]}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 2a       |
| `messages.history`                           | `{"endpoint","before"?}`                                                                                                             | `{"identity","messages":[{"id","sender","sender_id","sender_address","text","created_at","thread_id","mine"}]}` in reading order (replies beneath their parent); exact-address history fails closed without immutable proof                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 2a       |
| `messages.send`                              | `{"to"\|"address","text","reply_to"?}`                                                                                               | `{"message_id","conversation_id","to","recipient":{…roster.get's answer for this message}}`, read just after the send; no agent at the name or address is `not_found`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 2a       |
| `sessions.overview.get`                      | `{"session_id"}`                                                                                                                     | Cloud's saved session analysis, including request status and any generated brief                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 2a       |
| `sessions.overview.request`                  | `{"session_id"}`                                                                                                                     | Cloud's accepted summary request; the app reads status with `sessions.overview.get`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 2a       |
| `sessions.overview.events`                   | `{"session_id"}`                                                                                                                     | A bounded excerpt of the first uploaded session events, used to show the original user request when no generated brief exists                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 2a       |
| `people.list`                                | —                                                                                                                                    | `{"people":[{"name","avatar_url","identity_hash","is_self"}]}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 2a       |

`people.list` returns the avatar's https URL rather than a cached file: the
UI loads public images itself, and Cloud's email, role and join date are
dropped in the core. `identity_hash` joins a person to `roster.list`'s
`owner_hash`.

**Platform services**

| Method                      | Params                                                                                                           | Result                                                                                                                                                                                                                                                                                              | Lands in |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `links.parse`               | `{"url","site_url"?}`                                                                                            | `{"kind":"connect","site_url","account_id","workspace_id"}` or `{"kind":"message","endpoint","address"}`, else `invalid_params`; `site_url` is the site the app is built for (default: the signed-in site, else `https://agentrelay.com`)                                                           | 2a       |
| `telemetry.record`          | `{"operation","outcome","failure"?,"count"?,"mode"?,"surface"?,"agent_kind"?,"already_registered"?,"is_reply"?}` | `{}`; an unknown value is `invalid_params`. `update_install` success waits up to two seconds for the telemetry sender before replying, so a hosted core can be released after the reply. Desktop update callers bound each awaited telemetry RPC to three seconds; GTK awaits it off the UI thread. | 2c       |
| `login_item.set` (Linux)    | `{"enabled"}`                                                                                                    | `{}`; `refused` on macOS, where `SMAppService` is the app's                                                                                                                                                                                                                                         | 2c       |
| `login_item.status` (Linux) | —                                                                                                                | `{"enabled"}`; `refused` on macOS                                                                                                                                                                                                                                                                   | 3        |

Telemetry goes to PostHog through `/i/v0/e/` on the configured release host only
for the production site in a release build. Events use `desktop:<installation
id>` until an install attaches; then one `$identify` merges that id into
Cloud `users.id`, and later events carry the user and `$groups
{organization, workspace}` (`relay::telemetry`). Opt-out, the installation id
and the merged user live in `preferences.json`, `installation-id` and
`analytics-identified` (`$XDG_CONFIG_HOME`/`$XDG_CACHE_HOME`
`com.agentrelay.desktop` on Linux, as the GTK app kept them; the app data
directory on macOS). Linux turns on
launch at login at its first sign-in to the production site only
(`launch-at-login-configured` in the app data directory), so a person who
turns it off keeps it off.

Explicit agent registration/removal and message sending are tracked at their
shared bridge handlers, so both UIs produce the same attempts and outcomes.
`surface` and `agent_kind` accept only contract enums; the remaining usage
metadata is boolean or bounded numeric. Search text, recipients and message
content are never telemetry properties. Initial transcript reads are tracked.
Background readers set `following: true` even when no cursor is available,
excluding those reads from open telemetry. Pagination and background conversation
polling are also excluded. Upload completion is
an observed queued/uploading-to-uploaded transition count, with an in-memory
baseline scoped to the uploader attachment; it is not a durable delivery ledger.
The full operation inventory and success semantics are in README's desktop
analytics section.

**Legacy incoming mailbox** — retired Room transport; not installed by desktop startup

| Method                                 | Params                                                             | Result                                                                                                                                                                                                                                                                                                                                                                                     | Lands in |
| -------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| `incoming.status`                      | —                                                                  | `{"state":"stopped"\|"unavailable"\|"paused"\|"connecting"\|"connected"\|"polling"\|"needs_sign_in","error","threads":[{"id","project","title","open","shared","mode":"hold"\|"auto"\|null,"allows_unrestricted"}],"held":[{"id","thread_id","text","sender_name","enqueued_at_ms","expires_at_ms"}],"can_approve"}`; `error` is a sharing change that was recovered or could not be saved | 2c       |
| `incoming.share`                       | `{"thread_id","mode":"hold"\|"auto"\|null,"allows_unrestricted"?}` | `{}`; `null` stops sharing; a save that fails is `refused` and keeps incoming paused until a later change saves                                                                                                                                                                                                                                                                            | 2c       |
| `incoming.approve` / `incoming.reject` | `{"id"}`                                                           | `{"approved"}` / `{"rejected"}`; `false` when the message cannot be approved now (expired, gone, or incoming paused)                                                                                                                                                                                                                                                                       | 2c       |

Desktop startup leaves this legacy receiver uninstalled on both macOS and
Linux. Cloud removed the Room API in cloud#3039 and dropped its tables in
migration `0113_drop_room_tables.sql`; neither sign-in nor supervision should
request a Room session or restore an old Room binding. `incoming.status`
therefore reports `stopped`, with no threads or held messages.

Adding agents uses the account's resolved Relaycast workspace and each
agent's delivery queue. Person-to-agent chats use
`/workspaces/{id}/messaging/identity/credential`. These paths do not need the
retired receiver. Existing mailbox files are left on disk.

**Skip chat** — Cloud `…/workspaces/{id}/skip/{chat,projects,history}` (120 s each); only the macOS UI shows it

| Method                  | Params                               | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Lands in |
| ----------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| `chat.conversation`     | —                                    | `{"messages":[{"id","role":"user"\|"assistant","content","references":[{"session_id","source","title","url"}],"actions":[{"id","type":"send_message","agent_id","message","receipt":{"state":"sending"\|"sent"\|"unconfirmed","agent","detail","at_ms"}\|null}]}],"sending"}`; the saved conversation for the signed-in account                                                                                                                                                                                                | 2c       |
| `chat.send`             | `{"text"}` (1–12,000 characters)     | `{"answered","conversation"}`; sends the last 40 turns, the sessions here (and which are on the account's Relaycast workspace) and the saved project view; `answered` is false when the conversation was cleared or the person signed out meanwhile; `busy` while a question is out                                                                                                                                                                                                                                            | 2c       |
| `chat.clear`            | —                                    | The empty conversation; receipts for actions still in flight are dropped; `busy` while a question is out                                                                                                                                                                                                                                                                                                                                                                                                                       | 2c       |
| `chat.act`              | `{"action_id"}`                      | `{"action_id","receipt"}`; sends a proposed `send_message` as you to the registration whose target key is `agent_id`; the receipt is saved before dispatch, so it is never sent twice; `not_found` when the agent is not addressable, `refused` when it is on another Relaycast workspace                                                                                                                                                                                                                                      | 2c       |
| `chat.history`          | `{"session_id","source"?,"cursor"?}` | `{"events":[{"id","event_id","source","session_id","machine_id","ts","kind","actor_name","actor_role","content","content_truncated","tool_name","tool_status"}],"next_cursor"}`; `id` is unique across machines and kinds                                                                                                                                                                                                                                                                                                      | 2c       |
| `chat.projects`         | —                                    | `{"report":{"generated_at","briefing":{"headline","stuck","moving","ready"},"projects":[{"id","name","summary","state":"needs_you"\|"ready"\|"working"\|"idle"\|"done","next","repositories","last_active_at","sessions":[{"key","session_id","source","title","state","reason","nudge","last_active_at","push_key","receipt"}]}]}\|null,"stale","refreshing","durable":true\|false\|null}`; reads Cloud’s cached GET when available; `stale` also reflects a pending Cloud revision; older Cloud versions keep the local view | 2c       |
| `chat.projects.refresh` | —                                    | As `chat.projects`; explicitly requests a refresh. Accepts legacy immediate reports and durable pending responses, preserves the previous report while queued, and reads completion through `chat.projects`. Push receipts are kept for 15 days; `busy` while a refresh request is in flight                                                                                                                                                                                                                                   | 2c       |
| `chat.push`             | `{"push_keys":[…]}`                  | `{"results":[{"push_key","outcome":"sent"\|"unconfirmed"\|"already_pushed"\|"not_pushable"\|"not_on_this_computer"\|"account_workspace_not_connected"\|"other_workspace"\|"register_failed","detail"}],"projects":{…}}`; sends each ready session's nudge as you, registering a session not yet on the relay only when this computer's workspace is the account's                                                                                                                                                              | 2c       |

The conversation and project view are kept per account in
`<app data>/Conversations/<sha256(site/workspace)>.json` and
`.projects.json` (the macOS app's format); sign-out deletes them.

**Contractor access** — off unless `RELAY_DESKTOP_CONTRACTOR_ACCESS` or the `contractor_access` setting is on; while off, nothing asks Cloud

| Method                | Params                                   | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Lands in |
| --------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `contractors.status`  | —                                        | `{"enabled","availability":"dormant"\|"unloaded"\|"unsupported"\|"ready"\|"failed","failure","role":"owner"\|"member"\|"contractor"\|null,"grant","pending_seats":[{"user_id","name","avatar_url","identity_hash","role","joined_at_ms"}],"services":[{"id","name","sensitivity":"standard"\|"high","keywords"}],"grants":[{"id","user_id","display_name","description","scopes":[{"service","access"}],"granted_by","created_at_ms"}],"provisioning":{"grant_id","failed"}}` from the cache; owner-only lists are empty for others | 2c       |
| `contractors.refresh` | —                                        | As `contractors.status`, after Cloud `access/me` (and, for an owner, `/members`, `access/services`, `access/grants`); provisions or drops this person's own grant; `unsupported` while Cloud answers 404/405/501                                                                                                                                                                                                                                                                                                                    | 2c       |
| `contractors.propose` | `{"user_id","description"}`              | `{"scopes":[{"service","access":"none"\|"read"\|"write"}],"rationale","source":"cloud"\|"heuristic"}`, one row per catalogue service; owner only                                                                                                                                                                                                                                                                                                                                                                                    | 2c       |
| `contractors.approve` | `{"user_id","description","scopes":[…]}` | `{"grant"}`; only scopes that grant something are sent; owner only                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 2c       |
| `contractors.revoke`  | `{"grant_id"}`                           | `{}`; `busy` while the same revoke runs; owner only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 2c       |
| `contractors.dismiss` | `{"user_id"}`                            | As `contractors.status`; hidden per site and workspace on this computer                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 2c       |

A 403 is `refused`. Sign-in adopts the person's own grant; sign-out drops it.

## The relay-send socket

Sessions reach the core through a second socket with a different trust model:
`$XDG_RUNTIME_DIR/agent-relay/relay.sock` on Linux (`<app data>/run/relay.sock`
without a runtime directory), `<app data>/run/relay.sock` on macOS (short `$TMPDIR`, then
`/tmp`, fallbacks when that path is too long for a Unix socket; Agent Relay Dev
uses `agent-relay-dev` in each), advertised in
`~/.agentworkforce/desktop/relay-socket` (`relay-socket.dev` for Agent Relay
Dev). It speaks the HTTP routes in
injectable agents (relay-desktop `injectable-agents.md`) and
agent-driven setup (relay-desktop `agent-driven-setup.md`) and identifies the caller by
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
  probe's own client because the system curl binary does not expose
  `CODEX_THREAD_ID` to process inspection: the self-limiting commands
  (`relay send`, `agents`, `whoami`, `read`, `fetch-attachment`, `connect-send`,
  `subscribe-channel`;
  `relay::session_cli`), each of which fixes its own method and route, so
  the Codex and Claude rules that allow them reach nothing else.
- **Registration.** Every registration (`agents.register`, auto-activation,
  `POST /register`) reads fleet ownership fresh
  (`SessionDirectory::fleet_owned`) and refuses (`fleet_unavailable`; HTTP 503
  on the socket) when any broker or claim cannot be read.
- **Setup.** Of the setup routes (`GET /setup/status`, `POST /setup/sign-in`,
  `/setup/sharing`, `/setup/auto-activate`, `/setup/direct-delivery`),
  status, sign-in and sharing call `account.status`, `account.sign_in`
  (`flow:"device"`, `sharing:"selected"`), `uploader.status` and
  `uploader.sharing.set` through the core's own method dispatch
  (`server::call`); a core without them answers `setup_unavailable` and
  reports sign-in from the workspace alone. Auto-activation and direct
  delivery are the core's own settings. Status waits on no network call or
  uploader command: it answers from the last `uploader.status` answer and the
  workspace's last verification while a fresh read, the bootstrap's
  sharing step and Relaycast's verification of a newly found key run in the
  background. A status read that sends `X-Agent-Relay-Observe: 1` returns
  the same body and does not apply those defaults; the Claude SessionStart
  hook uses it so a nudge cannot turn automatic activation on. The body
  includes `allow_self_registration`. The bootstrap's sharing step only waits for the uploader to
  answer: it keeps the install's own mode (`selected` from a sign-in through
  setup or an app), so it never widens what an install shares. No setup lock is held across a network call; the
  bootstrap's sharing step and `POST /setup/sharing` share one lock of their
  own, which status never takes. Webhooks and integrations are
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
   self-hosted binding in `relaycast-origins.json`
   (`relay::workspace::origin_binding`: the PBKDF2-SHA256 fingerprint shared
   with the CLI and the broker), else `https://cast.agentrelay.com`. A bound
   key goes only to its bound server, so `relay init`'s local server
   (`http://127.0.0.1:8787`) and self-hosted servers (any http(s) base URL,
   path prefix included) work with no sign-in. A malformed bindings file, an
   unreadable `workspaces.json` or a malformed `RELAY_BASE_URL` fails closed:
   the daemon has no workspace and says why in its activity, rather than
   sending the key to the hosted default or falling back to the account's.
2. **The Cloud sign-in** (`cloud` in the agent store, at its own origin),
   written at sign-in together with the uploader's target, used only when the
   CLI names nothing: a desktop user who never ran the CLI. `RELAYCAST_URL`
   overrides its origin when it is a bare https origin (http and a port only
   for `localhost`/`127.0.0.1`; no user info, path, query or fragment);
   anything else leaves `https://cast.agentrelay.com`.

Neither source's key is sent to the other's origin: `RELAYCAST_URL` applies
only to the account's key, and CLI bindings only to the CLI's. Only
`rk_…` keys of at least 12 characters without whitespace qualify. A refused
key is recovered through Cloud (`account::workspace_recovery`) only when it
came from the sign-in; a key the CLI named is the CLI's to rotate, and a
rotated `workspaces.json` entry is picked up by the next rediscovery. When the
CLI names a workspace, messaging uses it while uploads still go to the signed-in
account's workspace. The daemon rediscovers every 30 s and on
`workspace.refresh`, and verifies a new key with `GET /v1/workspace`.

The machine prefix is the host name with `.local` dropped, diacritics folded,
non-`[a-z0-9]` runs as one dash, at most 40 characters, else `computer`; each
direct node is `<prefix>-<agent id>`, and a registration keeps the prefix it
was issued.

## The agent store

`relay::store` owns `injectable-agents.json` in the app data directory
(`~/Library/Application Support/com.agentrelay.desktop` on macOS,
`$XDG_DATA_HOME/com.agentrelay.desktop`, default `~/.local/share/…`, on
Linux). One format on both platforms: the macOS app's, plus
`inDoubtDeliveryIDs`, so the macOS app still reads what the core writes.

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
- Older stores are migrated when read and written back once: the Linux app's
  (Unix-seconds `registeredAt`; the account's `workspaceID`,
  `workspaceName`, `relayfileWorkspaceID` at the top level; `webhooks`,
  `integrations` and `replyParents` keyed by session; cached `senders` and
  `conversations`), and macOS 2026.09.5's `workspaceKeySource`. A key the
  sign-in fetched moves from `workspaceKey` to `cloud`; a pasted
  `workspaceKey` is dropped; registrations without a `machinePrefix`
  get the prefix they were reachable at; unattributed legacy thread replies
  are dropped. No registration or token is lost. The person identity and
  conversation hints the Linux app cached are fetched again on use.

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
  policy; this schedule applies to registered desktop sessions.
- Injected: DMs, mentions, thread replies, and anything in the agent's own
  webhook or integration channel (minus integration noise: index rewrites,
  generic updates, edits, pushes). Everything else, and the agent's own
  messages, is acknowledged without injecting.
- A delivery is acknowledged only after the record that it was injected is
  on disk. One that may have arrived (`in_doubt`) is never sent again: it is
  recorded with the injected ids (all a macOS app save keeps) and in a list
  of its own, bounded apart, reported failed (not retryable), and failed again, never acknowledged, if redelivered. A failed injection is
  retried after `min(30, 3 × 2^(n−1))` s; one with nowhere to go yet waits
  5 s without counting as a failure. One the session's route refuses for
  good (`InjectOutcome::Refused`: an archived or unknown Claude app session,
  an id that names no Codex thread or Claude session) is failed on Relaycast
  as not retryable, never acknowledged, and not tried again. A Claude app
  session refusing because it is archived also marks its agent archived.
  Pending refusal settlements preserve the session's refusal reason, are journaled independently of presence and
  retried without reading an archived agent's queue or injecting again. The
  archived agent leaves only after its non-retryable failure is confirmed
  (`docs/injectable-agents.md`). The bounded refusal history preserves FIFO
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
| `inject::Injector`               | `probe/src/relay/inject.rs`            | `inject` (`Delivered`, `Retry`, `Waiting`, `InDoubt`, `Refused`), `reply_hint`, `final_answer` per session kind | `NoInjector`: every delivery waits                            | 2b       |
| `sessions::SessionDirectory`     | `probe/src/relay/sessions.rs`          | Sessions on this computer, fleet-managed ones excluded                                                          | `NoSessions`                                                  | 2b       |
| `cloud_session::CloudAccess`     | `probe/src/relay/cloud_session.rs`     | The signed-in account and authenticated `<site>/cloud/api/v1` requests                                          | `SignedOut`                                                   | 2c       |
| `agents::SettingsExtension`      | `probe/src/relay/agents.rs`            | Settings owned elsewhere (`direct_delivery`, `analytics_enabled`, `contractor_access`)                          | none                                                          | 2b, 2c   |
| `outbound::RelaySend`            | `probe/src/relay/outbound.rs`          | The relay-send socket's path, pointer and Claude Code's direct-delivery setting (`setup::DirectDelivery`)       | `None`: not served                                            | 2b       |
| `daemon::Plugins::account`       | `probe/src/relay/account.rs`           | Sign-in, the uploader and telemetry (`account::with_account` adds the account, also as `cloud`)                 | none: account, uploader and telemetry methods are not offered | 2c       |
| `uploader::ProbeRunner`          | `probe/src/relay/uploader.rs`          | Running the probe's commands                                                                                    | `ProcessRunner` over this binary                              | 2c       |
| `contractor_access::Provisioner` | `probe/src/relay/contractor_access.rs` | `provision(grant)` / `deprovision()` for this person's own grant, one at a time, in order                       | `PendingSeatTokens`: holds nothing                            | 2c       |

`relay serve` builds its plugins with `local::plugins`: `LocalSessions`
(Codex and Claude discovery over a `process::ProcessTable`, fleet-owned
sessions left out), `LocalInjector`, `ClaudeSettings` and the relay-send
socket at its platform path; `account::with_account` adds the account,
uploader and telemetry. Tests build the core with fakes
of each.

`CloudAccess::request` takes paths relative to `<site>/cloud/api/v1`
(`/members`, `/workspaces/{id}/messaging/identity/credential`), so a caller
cannot double the `/cloud` prefix.

## Relaycast

Every Relaycast call goes through the published `relaycast` crate (10.0.0). Its API errors keep the full error body, so the request log records Relaycast's `plan`, `upgrade_available` and `upgrade_url` on a busy answer.
The one exception is `relay::sdk_gaps`, a minimal typed client for surface
the SDK does not cover the way the desktop needs; each item there is an
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
desktop's version), and `HttpClient` follows redirects,
where the desktop sends credentials only to the validated origin and refuses
redirects. The canonical host is `https://cast.agentrelay.com`.

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
| `relay::daemon`                                            | `relay serve`, single-instance lock, socket lifecycle, `Core`, shutdown                                                                                                                                                        |
| `relay::state`                                             | The snapshot and the event hub                                                                                                                                                                                                 |
| `relay::paths` / `relay::peer`                             | Socket and lock paths; kernel peer credentials                                                                                                                                                                                 |
| `relay::workspace` / `relay::app_store` / `relay::machine` | Discovery, origin validation, the store's workspace fields, the machine prefix                                                                                                                                                 |
| `relay::client`                                            | Relaycast clients over the SDK                                                                                                                                                                                                 |
| `relay::sdk_gaps`                                          | Relaycast surface the SDK lacks                                                                                                                                                                                                |
| `relay::push`                                              | Direct node sockets                                                                                                                                                                                                            |
| `relay::cli`                                               | `relay call METHOD [--params JSON]`; `relay socket-request` (any documented route, for people and debugging; no rule allows it) and `relay subscribe <pull request>`, the session-socket clients                                                                                                   |
| `relay::methods`                                           | The bridge methods for agents, messaging, people, links and settings (2a)                                                                                                                                                      |
| `relay::store`                                             | The agent store: format, migration, flock, three-way merge, set-aside of unreadable files (2a)                                                                                                                                 |
| `relay::agents`                                            | Names, registration, rename, removal, webhooks, test sender, settings, cleanups (2a)                                                                                                                                           |
| `relay::delivery`                                          | Policy, injected text, the per-agent line of work, ack/fail, in-doubt, final answers (2a)                                                                                                                                      |
| `relay::messaging` / `relay::people`                       | Person identity, DMs, exact-address proof; members, avatars and the roster (2a)                                                                                                                                                |
| `relay::integrations`                                      | Relayfile subscriptions (2a)                                                                                                                                                                                                   |
| `relay::links`                                             | Message endpoints and deep links (2a)                                                                                                                                                                                          |
| `relay::inject`                                            | The `Injector` trait (2a)                                                                                                                                                                                                      |
| `relay::sessions`                                          | The `SessionDirectory` trait (2a), with `caller` and `fleet_owned` (2b)                                                                                                                                                        |
| `relay::process`                                           | The kernel's process table (`/proc`; `libproc`, `KERN_PROCARGS2` and code signatures on macOS) and the Codex caller rules (2b)                                                                                                 |
| `relay::codex`                                             | Codex threads, rollouts, `codex queue`, the app-server proxy, the desktop app's IPC socket, the injection router (2b)                                                                                                          |
| `relay::claude`                                            | Claude Code's session registry, peer inbox, Claude app sessions and `claude --print --cloud`, transcripts (2b)                                                                                                                 |
| `relay::local`                                             | `LocalSessions`, `LocalInjector` and the plugins `relay serve` runs with (2b)                                                                                                                                                  |
| `relay::local_methods`                                     | `sessions.list`, `fleet.list`, `fleet.release`, the sessions/fleet watcher (2b)                                                                                                                                                |
| `relay::outbound`                                          | The relay-send socket and its routes (2b)                                                                                                                                                                                      |
| `relay::setup`                                             | Agent-led setup routes and defaults (2b)                                                                                                                                                                                       |
| `relay::fleet`                                             | Broker discovery and `/api/spawned` (2b)                                                                                                                                                                                       |
| `relay::claude_settings`                                   | `crossSessionInbound` (2b)                                                                                                                                                                                                     |
| `relay::claude_delivery_policy`                            | Per-session and per-sender Claude Code delivery consent plus the durable Ask-first queue (2b)                                                                                                                                  |
| `relay::outbox`                                            | The desktop mailbox's durable layer: the Codex outbox store (cursor, checkpoints, ack journal), Codex and Claude delivery workers, the sharing policy and inboxes (2b); its Cloud receiver is `relay::mailbox` (2c)            |
| `relay::cloud_session`                                     | The `CloudAccess` trait (2a); Cloud session calls: refresh, handoff exchange, revoke, `whoami`, workspace resolve; where the session is kept (2c)                                                                              |
| `relay::cloud_http` / `relay::cloud_login`                 | One redirect-free, bounded Cloud request; browser (loopback + PKCE) and device sign-in (2c)                                                                                                                                    |
| `relay::account` / `relay::account_methods`                | Sign-in, the kept session, the account workspace, sign-out, the daemon's `CloudAccess`; the 2c bridge methods (2c)                                                                                                             |
| `relay::uploader` / `relay::probe_copy`                    | The probe's commands, stages and collector supervision; the `~/.local/bin` copy (2c)                                                                                                                                           |
| `relay::relay_uploads`                                     | Sessions on the relay are uploaded (4)                                                                                                                                                                                         |
| `relay::mailbox` / `relay::incoming`                       | The desktop mailbox: activation, credential, socket and poll, acks, catalog; incoming messages to shared Codex threads (2c, over 2b's outboxes)                                                                                |
| `relay::cloud_chat`                                        | Skip chat: requests, the saved conversation and project view, pushes (2c)                                                                                                                                                      |
| `relay::contractor_access`                                 | Owner grants of scoped service access to contractor seats over `CloudAccess` (members via `relay::people`); this person's own grant to a `Provisioner`; the flag and per-workspace dismissals in `contractor-access.json` (2c) |
| `relay::spawn`                                             | The spawn node: Relaycast `spawn:codex`/`spawn:claude`/`release` capacity, headless launches, spawned agents' registrations (native-spawn.md (relay-desktop `native-spawn.md`))                                                |
| `relay::telemetry` / `relay::login_item`                   | PostHog: schema, opt-out, identity, rate limits, the send queue; Linux launch at login (2c)                                                                                                                                    |

## Port map

The stack: **1** this contract and the foundation; **2a** the agent runtime
core (store, agents, delivery, messaging, people, links, integrations);
**2b** the relay-send socket, fleet, the Codex and Claude injection bridges,
sessions, `claude_settings` and the setup API; **2c** Cloud sign-in and
Cloud access, uploader supervision, Skip chat,
contractor access, the account, telemetry and the login item; **3** Linux uses
only the bridge, headless is the daemon;
**4** macOS uses only the bridge and drops its duplicated Swift. Each of 2a,
2b and 2c ports its Swift and Linux tests.

### macOS (`macos/Sources`)

| Swift                                                                                                                                                                                                                                                                                                                                             | Rust                                                                                                                                                                                                                       | PR                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `RelayDesktopCore/InjectableAgents.swift` (`RelaycastWorkspace`, `validatedBaseURL`, `machinePrefix`)                                                                                                                                                                                                                                             | `relay::workspace`, `relay::app_store`, `relay::machine`                                                                                                                                                                   | 1                        |
| `RelayDesktop/RelaycastPushChannel.swift`                                                                                                                                                                                                                                                                                                         | `relay::push`, `relay::sdk_gaps`                                                                                                                                                                                           | 1                        |
| `RelayDesktop/RelaycastClient.swift`                                                                                                                                                                                                                                                                                                              | `relay::client`, `relay::sdk_gaps`, `relay::messaging`, `relay::people`                                                                                                                                                    | 1 (workspace), 2a (rest) |
| `RelayDesktopCore/InjectableAgents.swift` (names, targets, deliveries, policy, store, relayfile paths, integration events), `InjectableReplies.swift`, `InjectableIntegration.swift`, `InjectableStoreMerge.swift`                                                                                                                                | `relay::agents`, `relay::delivery`, `relay::store`, `relay::integrations`                                                                                                                                                  | 2a                       |
| `RelayDesktopCore/InjectableAgents.swift` (`CloudWorkspaceResolution`, `CloudSessionTokens`)                                                                                                                                                                                                                                                      | `relay::cloud_session`                                                                                                                                                                                                     | 2c                       |
| `RelayDesktop/InjectableAgents.swift` (registration, rename, webhooks, test sender, delivery, final answers, integrations, direct conversations)                                                                                                                                                                                                  | `relay::agents`, `relay::delivery`, `relay::integrations`, `relay::messaging`                                                                                                                                              | 2a                       |
| `RelayDesktop/InjectableAgents.swift` (discovery, fleet, setup routes, Claude inbound setting, Cloud session)                                                                                                                                                                                                                                     | `relay::sessions`, `relay::fleet`, `relay::setup`, `relay::claude_settings`, `relay::cloud_session`                                                                                                                        | 2b, 2c                   |
| `RelayDesktop/InjectableStoreFile.swift`                                                                                                                                                                                                                                                                                                          | `relay::store`                                                                                                                                                                                                             | 2a                       |
| `RelayDesktop/Outbound.swift`                                                                                                                                                                                                                                                                                                                     | `relay::outbound`                                                                                                                                                                                                          | 2b                       |
| `RelayDesktopCore/FleetAgents.swift`, `FleetBridge.swift`                                                                                                                                                                                                                                                                                         | `relay::fleet`                                                                                                                                                                                                             | 2b                       |
| `RelayDesktop/CodexBridge.swift`, `CodexQueueBridge.swift`, `CodexAppServerBridge.swift`, `CodexDelivery.swift`, `CodexInbox.swift`, `CodexIncomingRouter.swift`; Core `CodexIPCFraming.swift`, `CodexIPCMessages.swift`, `CodexOutbox.swift`, `CodexQueueCommand.swift`, `CodexRollout.swift`, `CodexSharing.swift`, `CodexInboundMessage.swift` | `relay::inject::codex`, `relay::sessions`                                                                                                                                                                                  | 2b                       |
| `RelayDesktop/ClaudeBridge.swift`, `ClaudeTerminalBridge.swift`, `ClaudeDelivery.swift`, `ClaudeInbox.swift`; Core `ClaudePeerFrames.swift`, `ClaudeSendCommand.swift`, `ClaudeTerminalSession.swift`, `ClaudeCloudSession.swift`, `ClaudeInboundMessage.swift`                                                                                   | `relay::inject::claude`, `relay::sessions`                                                                                                                                                                                 | 2b                       |
| Core `ClaudeInboundSetting.swift`                                                                                                                                                                                                                                                                                                                 | `relay::claude_settings`                                                                                                                                                                                                   | 2b                       |
| `RelayDesktop/AgentRelayCloud.swift`, `DesktopDeviceLogin.swift`, `DesktopOAuthReceiver.swift`                                                                                                                                                                                                                                                    | `relay::cloud_session`, `relay::cloud_login`, `relay::account` (person credential, relayfile credential and connect links: 2a, through `CloudAccess`)                                                                      | 2c                       |
| `RelayDesktop/DesktopCloudLogin.swift`, `DesktopCloudNetwork.swift`, `DesktopCloudReceiver.swift`, `DesktopCloudSession.swift`; Core `DesktopCloudContract.swift`                                                                                                                                                                                 | `relay::mailbox`, `relay::incoming`                                                                                                                                                                                        | 2c                       |
| `RelayDesktop/ProbeBridge.swift`, `ProbeInstaller.swift`, `Supervisor.swift`, `SessionPreview.swift`; Core `BridgeModels.swift`, `BridgeDecoder.swift`, `ProbeCommand.swift`, `ProbeRelease.swift`, `CaptureProgress.swift`, `NDJSON.swift`                                                                                                       | `relay::uploader`, `relay::probe_copy`. `ProbeBridge.locate`'s choice of a newer `~/.local/bin` probe is gone: the app runs its bundled helper as the daemon, and an install a newer probe runs reports `upgrade_required` | 2c                       |
| `RelayDesktop/WorkspacePeopleModel.swift` (fetch); Core `AgentPeople.swift`                                                                                                                                                                                                                                                                       | `relay::people`                                                                                                                                                                                                            | 2a                       |
| `RelayDesktop/CloudChatClient.swift`, `CloudChatModel.swift` (persistence, requests); Core `SkipProjects.swift`                                                                                                                                                                                                                                   | `relay::cloud_chat`                                                                                                                                                                                                        | 2c                       |
| `RelayDesktop/ContractorAccessModel.swift` (requests); Core `ContractorAccess.swift`, `ContractorAccessHTTPClient.swift`                                                                                                                                                                                                                          | `relay::contractor_access` (the members roster: `relay::people`, 2a)                                                                                                                                                       | 2c                       |
| `RelayDesktop/DesktopTelemetry.swift`                                                                                                                                                                                                                                                                                                             | `relay::telemetry`                                                                                                                                                                                                         | 2c                       |
| Core `AgentEndpoint.swift`, `DesktopConnection.swift`                                                                                                                                                                                                                                                                                             | `relay::links`                                                                                                                                                                                                             | 2a                       |
| Core `SessionUploadState.swift`, `UploadStages.swift`, `StatusDisplay.swift` (state derivations)                                                                                                                                                                                                                                                  | `relay::uploader` (typed `stage`, `needs_start`)                                                                                                                                                                           | 2c                       |
| `RelayDesktop/AppModel.swift`, `InjectableAgents.swift` (sessions on the relay are uploaded), `ProbeBridge.swift` (upload health)                                                                                                                                                                                                                 | `relay::relay_uploads`, `relay::account` (upload health); `AppModel.swift` is a bridge client                                                                                                                              | 4                        |

The macOS app after PR 4: `RelayDesktopApp.swift`; `AppModel.swift` (bridge
client: connection, account, uploader, settings) with `RelayModel.swift`,
`ChatModel.swift`, `ContractorsModel.swift` and `IncomingModel.swift` (view
state over their methods); every `*View.swift`, `AgentRows.swift`,
`SessionsTable.swift`, `BrandMark.swift`, `BrandWordmarkPaths.swift`,
`ChatMarkdownView.swift`, `AgentIconView.swift`; `LaunchAgentService.swift`
(the core's LaunchAgent), `LoginItem.swift`, `AppUpdater.swift`,
`AppUpdateInstaller.swift`, `AppInfo.swift`. Core: `CoreBridge.swift` (the
socket client), `CoreContract.swift` (the contract's types and typed calls, generated),
`ContractPresentation.swift` (identities, labels and derived values over them),
`CoreService.swift`, `LegacyMigration.swift`, and the wording and filters:
`StatusDisplay.swift`, `SessionUploadState.swift`, `UploadStages.swift`,
`RelayPresence.swift`, `Filters.swift`, `SessionNavigation.swift`,
`RelativeTime.swift`, `AppUpdate.swift`, `SVGPath.swift`.

One-time moves from earlier macOS builds (`LegacyMigration`): a diagnostics
opt-out and the contractor-access flag kept in UserDefaults reach the core
once as `settings.set`; Skip conversations move from
`~/Library/Application Support/AgentRelay/Conversations` to
`<app data>/Conversations` before the core reads them (an existing file stays
the core's); the anonymous id, the mailbox device id (the core issues a new
one once), dismissed contractor seats, incoming-policy recovery markers and
the login-item flag are then forgotten.

### Linux (`probe/src/linux_app`)

The Linux app is `agent-relay`, a binary of the probe crate built with its
`gtk` feature: `linux_app::ui` (the GTK 4 window and the StatusNotifierItem
tray), `linux_app::bridge` (the socket client), `linux_app::host` (child
hosting), `linux_app::service` (the systemd user unit), `linux_app::install`
and `linux_app::updates` (the install tree and its updates), `linux_app::prefs`
and `linux_app::models` (wording, relative times, filters). It reads the
registry's own types. The `.deb` depends on GTK 4 (4.6 or later) and librsvg
only. The window loads people's public https avatars itself, as a view
concern; nothing else in it touches the network, the stores or the probe.

### Windows (`probe/src/linux_app`, built for Windows)

The Windows app is the same `agent-relay` program, built natively with MSYS2's
clang toolchain and GTK 4 (`scripts/build-windows.sh`). The modules that touch
the platform have Windows counterparts behind the same traits and wording:
`linux_app::service` is the per-user **Agent Relay (<account>)** logon task, which runs
`agent-relay.exe --headless` (it spawns the core and waits, where Linux
`exec`s it); `linux_app::ui::tray` is a notification-area icon with the same
menu; `linux_app::ui::desktop` opens links with `ShellExecute` and shows
Windows toast notifications; `linux_app::install` and `linux_app::updates`
are the per-user tree under `%LOCALAPPDATA%\Programs\AgentRelay\<version>\`,
the verified release zip, the Start menu shortcut and the `agentrelay://`
handler under `HKEY_CURRENT_USER`. The zip carries the GTK runtime beside
`agent-relay.exe` and `agent-relay-probe.exe`. Harnesses that are Unix-only
tools (Muse, Devin, Grok CLI, Hermes, OpenClaw, OpenCode existing-session
injection, Pi) are compiled out on Windows and the core reports them
unavailable; Claude Code and Codex work in full. See
windows/README.md (relay-desktop `windows/README.md`).

## Verification

`cargo test` in `probe/` runs the core against an in-process fake Relaycast
(HTTP routes, the node socket and relayfile-cloud's routes on one loopback
port, keeping agents, queues, channels, webhooks, subscriptions and DMs) with
fake sessions, a fake injector and a fake Cloud, and drives the real daemon
binary with a cleared environment. Session discovery and caller
identification run against a fake process table (`process::FakeProcesses`);
the Codex and Claude routes against in-process fakes of `codex queue`, the
app-server proxy, the Codex app's IPC socket and Claude Code's peer inbox; the
fleet against a fake broker; the relay-send socket over a real Unix socket
with fake callers. On Linux CI, `probe/tests/linux_app_core_e2e.rs` drives the
built core through the app's bridge client (hosting, the snapshot, workspace
verification, launch at login, a device sign-in and its cancel,
`agent-relay --headless`) against fake Relaycast and Cloud in an empty home,
and the GTK app starts under Xvfb against `agent-relay-fake-core`. No broker,
PTY runtime or agent harness is started by any test, and no test can find a
real `codex` or `claude`.

```sh
agent-relay-probe relay serve &
agent-relay-probe relay call status.get --json
agent-relay-probe relay call workspace.refresh --json
agent-relay-probe relay call agents.list --json
agent-relay-probe relay call roster.list --json
agent-relay-probe relay call sessions.list --json
agent-relay-probe relay call fleet.list --json
curl -s --unix-socket "$(cat ~/.agentworkforce/desktop/relay-socket)" http://relay/whoami
agent-relay-probe relay call daemon.shutdown --json
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
agent-relay-probe relay call spawn.targets --json
agent-relay-probe relay call spawn.status --params '{"caller_name":"my-local-agent","action":"spawn","invocation_id":"invocation_id_from_receipt"}' --json
```
