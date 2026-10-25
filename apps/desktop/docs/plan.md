# Relay Desktop — plan and contracts

Relay Desktop is the native companion app that makes connecting a computer to
Agent Relay Teams a two-click job: install the app, sign in with Google, done.
It installs and supervises the native `agent-relay-probe` (built from
[`probe/`](../probe/)), shows upload progress in the menu bar, and lets
the user pause uploads, choose which past sessions to share, and control
launch-at-login.

This document is the source of truth shared by the four pieces of work:

1. **Probe "desktop bridge"** (`probe/src/probe/`): machine-readable commands
   the app drives. Section 3.
2. **macOS and Linux apps** (`macos/`, `linux/`): native menu/tray apps over
   the same bridge, assembled by `scripts/`. Sections 2, 4, 5.
3. **Packaging + CI/CD** (`scripts/`, `.github/workflows/`) and the **Windows
   placeholder** (`windows/`). Section 6.
4. **agentrelay.com** download page/buttons pointing at this repo's GitHub
   Releases. Section 7.

## 1. What exists today

- `agent-relay-probe` (Rust, clap) signs a computer in to Agent Relay Cloud with
  the OAuth **device flow** (`POST {site}/cloud/api/v1/auth/device/start`, poll
  `/device/token`), obtains workspace-scoped RelayHistory (`rth_*`) credentials
  through Cloud's workspace bridge, captures local coding sessions (Claude Code,
  Codex, Cursor, …) into `history.db`, and runs durable delivery to
  `https://history.agentrelay.com/v1/delivery/batches`.
- State lives in `~/.agentworkforce/probe/<sha256(site,account,workspace)>/`:
  `config.json`, `history.db`, `collector.lock` (OS lock = "running"),
  `runtime.json` (`startup_id`, `pid`, `ready`), `stop.json`, `collector.log`
  (rotated at 10 MB to `collector.log.1`..`.3`),
  plus `stages/` auth under that dir (`RELAYHISTORY_HOME`).
- Commands: `cloud install [--include-existing|--new-sessions-only] [--foreground]
  [--once] [--force-login]`, `stop`, `status`, hidden `run --directory --startup-id`.
  `status`/`stop` take `--site-url --account --workspace`.
- Sharing choice today is binary and immutable: *all* (existing + future) or
  *new only* (baseline exclusion of every session known at setup; later
  discovered sessions are delivered).
- Delivery model (`crates/ai-hist/src/delivery.rs`): one active *job*
  (generation) per (destination, instance, account). Exclusions are per
  `(source, session_id)` rows in `delivery_exclusions`. Adding an exclusion is
  cheap. **Removing** an exclusion that a live job selects fails with
  `DELIVERY_GENERATION_REQUIRED`: the job must be cancelled and a fresh
  generation created (bootstrap rescans local history; the server is
  idempotent on record revisions, so re-sending already-acknowledged rows is
  safe, just work). `pause_job`/`resume_job` exist but the collector currently
  treats any non-`active` state as an error.
- The probe ships only inside the desktop app: CI and releases build `probe/`
  for each target with `scripts/build-probe.sh`, stamped with the desktop
  release version.
- Google sign-in happens on Cloud's web pages. Agent Relay Teams signs users up
  via `https://agentrelay.com/cloud/api/auth/google/start?next=…`; the device
  approval URL the probe returns is on `https://agentrelay.com` and Cloud asks
  the user to sign in (Google) before approving the device. The desktop app
  never handles Google credentials itself: "Sign in with Google" starts the
  device flow and opens the approval URL in the default browser.

## 2. User experience (macOS and Linux)

- **First launch:** a full window inspired by Skip, with a dark left splash and
  a light right sign-in panel. Choose all, new-only, or selected sessions
  (selected is the default), then **Sign in with Google**. The probe emits an
  approval URL for browser sign-in, saves credentials and sets up RelayHistory.
  After `ready` and successful process completion, the same window shows Sessions.
  Errors appear inline, and cancelled attempts cannot overwrite later logins.
- **Main window:** available from the Dock and **Open Agent Relay…** in the menu
  bar. Sidebar pages are Sessions, Settings and Account. Closing it keeps the
  collector and menu-bar controls running.
  - *Sessions*: real record progress plus per-session upload state, search,
    individual **Upload**, checkboxes and **Upload selected**, **Upload all**,
    and all/new/selected policy controls. Selection persists on errors. A
    **Load more** button extends the initial 500-row list. **Stop sharing**
    stops future uploads without deleting already uploaded history.
  - *Settings*: launch-at-login and sharing policy, with confirmation before
    changing the policy.
  - *Account*: account/workspace/site, probe and app versions, log file, and
    logout. Failed disconnects retain the connected state and show the error.
- **Menu bar / system tray:** current status, progress, pause/resume, open window, settings,
  and quit. The app polls status and sessions every five seconds while a window
  or panel is open, and status every thirty seconds otherwise.
- **Resilience:** the app registers as a login item (default on, via
  `SMAppService`, toggle in Settings). On every launch and every 60 s it checks
  `status --json`; if `running == false` and not logged out it calls `start`.
  The probe process is detached (`setsid`), so it survives the app quitting; the
  app is a supervisor, not a parent.

## 3. Probe desktop bridge (contract v1)

All new behaviour is added to `agent-relay-probe` in
`probe/src/probe/{main.rs,collector.rs}` (+ new modules as needed). Existing commands and flags keep working unchanged. Every `--json`
output is a single JSON object on stdout (NDJSON for `cloud install --json`,
one object per line), UTF-8, no trailing prose. Human-readable output is
unchanged when `--json` is absent. Errors: exit code 1, one safe sentence on
stderr (the existing `UserError`/`CloudAuthError` rules — never bodies,
credentials, URLs from responses, or session content). Every JSON object
carries `"bridge_version": 1`.

`<target>` below means the existing `--site-url URL --account ID --workspace ID`
arguments (site defaults to `https://agentrelay.com`).

### 3.1 `agent-relay-probe installs --json`

Lists every probe directory under `~/.agentworkforce/probe/` whose
`config.json` parses. It is a pure read on the launch path: it never opens a
decommissioned directory's store and does no maintenance (see 3.12):

```json
{"bridge_version":1,"installs":[{"directory":"/Users/x/.agentworkforce/probe/ab12…","site_url":"https://agentrelay.com","account_id":"usr_…","workspace_id":"ws_…","org_id":"org_…","sharing_mode":"new","running":true,"paused":false}]}
```

### 3.2 `agent-relay-probe cloud install --json …`

Adds `--json` and a third sharing flag `--selected-sessions-only`
(`sharing_mode = "selected"`; mutually exclusive with the other two). With
`--json`, stdin is never read (a missing sharing flag on a fresh install is an
error), and stdout is NDJSON:

```json
{"bridge_version":1,"event":"approval","verification_uri":"https://agentrelay.com/…","user_code":"ABCD-EFGH"}
{"bridge_version":1,"event":"connected","account_id":"usr_…","workspace_id":"ws_…","org_id":"org_…","directory":"/Users/x/.agentworkforce/probe/ab12…"}
{"bridge_version":1,"event":"ready","running":true}
```

`user_code` is `null` when the URL already carries it. `--json` implies the
detached background start (never `--foreground`). Reconnecting an existing
directory works exactly as today (choice must match, else the error sentence).

### 3.3 `agent-relay-probe start <target> [--json]`

Starts the detached collector for an existing directory **without any Cloud
sign-in** (uses the stored `rth_*` session; refresh tokens last 90 days). If
already running, succeeds. JSON: `{"bridge_version":1,"running":true,"started":false}`.
(`started` is `true` only when this call launched a process.) Reuse
`collector::start_background`. The startup wait/"ready" handshake stays.

### 3.4 `agent-relay-probe status <target> --json`

```json
{"bridge_version":1,"probe_version":"0.19.0","running":true,"paused":false,
 "sharing_mode":"new","site_url":"https://agentrelay.com","account_id":"usr_…",
 "workspace_id":"ws_…","org_id":"org_…","directory":"…",
 "delivery":{"state":"active","bootstrap_complete":true,"pending_records":12,
   "pending_bytes":40960,"acknowledged_records":3401,"unqueued_changes":0,
   "suppressed_records":0,"skipped_records":0,"last_attempt_ms":1758300000000,
   "last_acknowledged_ms":1758300000000,"next_attempt_ms":0,"failure":null},
 "sessions":{"total":210,"shared":57,"excluded":153},
 "last_cycle":{"at_ms":1758300000000,"ok":true,"message":null}}
```

`paused` reflects the delivery job state `paused`. `last_cycle` is written to
`cycle.json` in the directory after every pass (`at_ms`, `ok`, `message` = the
safe sentence on failure), with `capture` and `delivery` carrying each side's
`ok`/`error_class`/`message` and the top-level fields holding the effective
verdict, capture fault first. A pass that only delivered observed nothing about
capture, so it carries the standing capture verdict. Status carries no
`retention`: uploads read the change feed and hold no journal, so the app
offers no **Compact now**.
`sessions.shared` counts session identities with no exclusion row. Without
`--json` the existing "Probe is running/stopped." text stays.

### 3.5 `agent-relay-probe pause <target> [--json]` / `resume <target> [--json]`

Call `delivery::pause_job` / `resume_job` on the configured job. The collector
loop treats a `paused` job as healthy: it still captures locally each cycle but
skips delivery and the heartbeat and does not log an error. JSON:
`{"bridge_version":1,"paused":true}`.

### 3.6 `agent-relay-probe sessions list <target> --json [--limit N]`

Sessions from the directory's `history.db`, newest `last_activity_ms` first,
default limit 500:

```json
{"bridge_version":1,"sharing_mode":"new","sessions":[
 {"source":"claude","session_id":"29284179-…","summary":"Repair authentication routing","title":"Fix auth rewrite…",
  "cwd":"/Users/x/code/app","git_branch":"main","first_activity_ms":…,
  "last_activity_ms":…,"included":false,"status":"not_shared"}]}
```

`summary` is the RelayHistory Cloud session-analysis title when one is available;
otherwise it is omitted and the desktop falls back to `title`. `title` =
`first_prompt` trimmed to 120 chars (fallback `last_assistant_text`, then the
session id). `included` = no exclusion row. `status` ∈
`uploading` (a record is in a leased batch), `uploaded` (included and every record of it acknowledged — if per-session
acknowledgement is not cheaply derivable, use `shared`), `queued`
(included, delivery pending), `not_shared` (excluded). The rows come from
`SessionStore::sessions`, the catalog read; the command never mutates.

### 3.7 `agent-relay-probe sessions include <target> --json --session SOURCE:ID …`
### `agent-relay-probe sessions exclude <target> --json --session SOURCE:ID …`

Both mutations use the stopped-collector regeneration path below. `exclude`
adds exclusion rows and removes explicit selections. `include` withdraws exclusions
for the named sessions; because a
live job selects them, it must **regenerate**: cancel the current job, remove
the exclusions, create a new job with the same `DeliveryJobConfig`, persist the
new `job_id` in `config.json`, and record the included identities in
`selected.json` so `selected` mode never re-excludes them. The collector must
not be mid-cycle: take the collector lock (stop the running collector first,
regenerate, then restart it, all inside this command) or, simpler, have the
command write a `regenerate.json` request that the collector applies between
cycles — pick one, document it, and make the command return only once the
change is durable. The implementation uses a replayable `sharing-change.json`
intent under `desktop.lock` plus the stopped collector lock, and preserves pause
state across regeneration. JSON: `{"bridge_version":1,"included":["claude:29284179-…"],"regenerated":true}`.

### 3.8 `agent-relay-probe sharing set <target> --mode all|new|selected --json`

Changes the sharing mode for an existing install: regenerate as in 3.7 with the
new baseline — `all` withdraws every exclusion; `new` excludes every session
known now except those in `selected.json`; `selected` does the same and,
additionally, the collector excludes every *newly discovered* session (after
the capture sweep, before delivery, each cycle) unless it is listed in
`selected.json`. Persist `sharing_mode` in `config.json` (keep the existing
`include_existing` bool for compatibility; `serde(default)` derives
`sharing_mode` from it when absent). JSON: `{"bridge_version":1,"sharing_mode":"selected","regenerated":true}`.

### 3.9 `agent-relay-probe disconnect <target> [--json]`

Stops the collector, cancels the delivery job, best-effort revokes the stored
`rth_*` session (`POST {history_url}/v1/auth/token/revoke`), removes the
stored auth files and `config.json`, keeps `history.db` (local data is the
user's, and its origin lets a reconnect resume). With every job cancelled it
releases the upload tables' rows (batches, members, session scopes; job rows,
the origin and exclusions stay), truncates the write-ahead log, and removes
`collector.log`, its rotated logs and the run reports. JSON:
`{"bridge_version":1,"disconnected":true}`. After this `installs` no longer
lists the directory.

### 3.10 `agent-relay-probe compact <target> --json`

Releases settled batch receipts. Pending and unacknowledged batches are
untouched, so it is safe while the collector runs. An install with no live
job releases every upload row, as `disconnect` does. JSON:
`{"bridge_version":1,"removed_records":42}`.

### 3.11 Tests and docs

Unit tests next to the existing probe tests (clap parsing of every new command,
JSON shapes, paused cycle is healthy, `selected` mode excludes new sessions,
include regenerates and keeps `selected.json`). CI tests the crate with
`cargo test --manifest-path probe/Cargo.toml --locked`.

### 3.12 `agent-relay-probe reclaim --json`

Releases what decommissioned installs (directories with no `config.json`) no
longer need, so `installs` can stay a pure read. The apps call it once per
launch, after discovery and without waiting for it. There is no client
deadline: opening a store an older build left can migrate it, which commits
only at the end, so a kill would redo the migration every launch. A failure is
ignored and the next launch continues. Setup reconnecting a decommissioned
directory waits (up to 10 minutes) for a pass holding its locks instead of
failing; a live install still fails fast.

- Each decommissioned install gets one bounded pass per call, under
  `desktop.lock` and `collector.lock` (a busy install is left for a later
  call): open the store as its owner, which rebuilds one still on the export
  journal, and release one page (10,000) of settled receipts.
- A pass that releases nothing writes `reclaimed_v1.json` beside the lock files,
  recording the size, modification time and inode of `history.db` and
  `history.db-wal`. Later calls skip the directory while a `stat` still matches,
  so the residue costs a directory-entry check rather than a database open.
- The marker invalidates itself: a reconnect or disconnect writes the store,
  which changes what it recorded, so setup never needs to clear it. Its only
  allowed failure is a wasted open (a checkpoint, say), never a skipped
  reclaim. A store written within the last 2 s is not marked, and neither is a
  pass that released anything, so a marker always follows a pass that found
  nothing.
- The name is versioned: when reclamation learns to release something new, the
  next name re-examines every directory the old marker skipped.

JSON: `{"bridge_version":1,"examined":3,"skipped":2,"reclaimed_records":10000,"remaining":1}`.
`examined` counts decommissioned installs with a store, `skipped` those whose
marker matched, `remaining` those a later call still has work for.

## 4. macOS app architecture (`macos/`)

- SwiftPM package `macos/Package.swift` (swift-tools 5.9): the app target
  `RelayDesktop`, the library `RelayDesktopCore` (bridge client and view-model
  helpers), and `RelayDesktopTests` (the bridge client and view models against
  an in-process fake core). Deployment target macOS 13 (Ventura): needed for
  `MenuBarExtra` and `SMAppService`. No third-party dependencies.
- Bundle identifier `com.agentrelay.desktop`, display name **Agent Relay**,
  `LSUIElement = false` (Dock and menu-bar access), `CFBundleShortVersionString` stamped by
  CI from the release version, `NSHumanReadableCopyright`.
- The app is a thin SwiftUI client of the relay core, which launchd runs as
  the LaunchAgent `Contents/Library/LaunchAgents/com.agentrelay.desktop.core.plist`
  (`Contents/Helpers/Agent Relay Helper relay serve`). The bundle layout, the
  modules and the lifecycle are in [`macos/README.md`](../macos/README.md) and
  [`relay-core.md`](relay-core.md).
- All user-facing strings in plain English, no jargon.
- Logging: `os.Logger(subsystem: "com.agentrelay.desktop", category: …)`.
- Every network call, history upload and inbound message included, is the
  core's; the app makes none.

### 4.1 Linux app architecture (`probe/src/linux_app`)

- A native GTK 4 application in Rust (`agent-relay`, the probe crate's `gtk`
  feature) with a StatusNotifierItem tray menu. Closing the window keeps the
  process and tray controls running.
- It is a thin client of the relay core ([relay-core.md](relay-core.md)):
  `linux_app::bridge` speaks the bridge with the contract registry's own
  types, `linux_app::models` holds the wording, relative times and filters,
  and `linux_app::ui` draws. Sign-in, uploads, delivery, messaging, fleet, telemetry and
  launch at login are core methods.
- The main window has the same sign-in, Sessions, Agents, Workspace, Settings
  and Account flows. XDG autostart (`login_item.set`) replaces
  `SMAppService`; a registered desktop entry handles `agentrelay://` and
  `agentrelay-dev://` links, which the core parses (`links.parse`).
- The bundled architecture-specific helper is the core. The app connects to
  the running core, or hosts one with `--exit-on-stdin-eof`; the systemd user
  unit runs `relay serve --headless`. Development names another with
  `RELAY_DESKTOP_PROBE`.
- `scripts/build-probe.sh` builds the x64/arm64 glibc helper.
  `scripts/build-linux.sh` creates a relocatable tree, `.tar.gz`, and `.deb`.
  CI runs the unit and GTK tests under Xvfb against a fake core, a GTK startup
  test, and an end-to-end test of the real core binary driven by the app's
  bridge client, for both architectures, on Ubuntu 22.04 (GTK 4.6).

## 5. State machine (app)

```
launch ──installs──▶ none ─────────────────────▶ SignIn window
                 └─▶ found ─▶ status ─▶ running? ─no─▶ start ─▶ Attached
                                     └─yes──────────────────▶ Attached
Attached ─pause/resume/sharing/sessions─▶ Attached (refresh status)
Attached ─disconnect─▶ none ─▶ SignIn window
SignIn ─cloud install (approval → open browser → ready)─▶ Attached
```

Errors never crash the app: a failed command surfaces its stderr sentence in
the panel ("Needs attention") and the supervisor keeps polling.

## 6. Packaging and CI/CD

Scripts (bash, `set -euo pipefail`, shellcheck-clean), run on macOS runners:

- `scripts/build-probe.sh --target <triple> --version X.Y.Z --out DIR`
  - `cargo build --manifest-path probe/Cargo.toml --release --locked --bin agent-relay-probe --target <triple>`
    with `AGENT_RELAY_PROBE_VERSION` set, so `--version` and `status --json`
    report the desktop release; write the binary, a `.sha256` naming
    `agent-relay-probe`, and `probe-version.txt`. Run the bridge check when
    the target matches the host.
- `scripts/build-app.sh --arch arm64|x64 --version X.Y.Z --probe DIR --out DIR`
  - `swift build -c release --arch <arm64|x86_64>` in `macos/`, assemble the
    bundle layout from §4, render `AppIcon.icns` (`scripts/render-icon.swift`
    draws the mark with CoreGraphics into 16…1024 px PNGs → `iconutil`),
    write `Info.plist` from `macos/Info.plist.template` (substituting version
    and build), then sign:
    - if `CSC_LINK` + `CSC_KEY_PASSWORD` are set: import the base64 `.p12`
      into a temporary keychain and select its Developer ID identity,
      `codesign --deep --options runtime --timestamp` the helper then the app
      (hardened runtime, entitlements file with nothing unusual), and if
      `APPLE_API_KEY_BASE64` + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER` are set,
      `xcrun notarytool submit --wait` the zipped app with the decoded `.p8`
      and `xcrun stapler staple`.
    - else ad-hoc sign (`codesign --force --deep -s -`) and print a clear
      notice that the artefact will trigger Gatekeeper's unidentified-developer
      prompt (README documents right-click → Open).
- `scripts/package-dmg.sh --app "…/Agent Relay.app" --out FILE.dmg` using
  `hdiutil` with an `/Applications` symlink; also emit `FILE.dmg.sha256`.

Workflows:

- `.github/workflows/desktop-ci.yml` — on `pull_request` and `push` to `main`: matrix
  `{macos-15 → arm64, macos-15-intel → x64}`: `swift build`, `swift test`,
  `build-probe.sh`,
  `build-app.sh` (ad-hoc signed), upload the `.app` zip as an artifact;
  `shellcheck` on `scripts/*.sh`; `windows` job on `windows-latest` running
  `dotnet build windows/RelayDesktop.Windows.csproj` (placeholder).
- `.github/workflows/desktop-release.yml` — on push of tag `desktop-v*` (and
  `workflow_dispatch`, with an optional `version` override of the `YYYY.MM.N`
  default): same build matrix, signed/notarized when
  secrets exist, then one job that downloads both DMGs and publishes a GitHub
  Release `v<version>` with assets:
  - `AgentRelay-<version>-macOS-arm64.dmg`, `AgentRelay-<version>-macOS-x64.dmg`
  - stable names for the website: `AgentRelay-macOS-arm64.dmg`,
    `AgentRelay-macOS-x64.dmg` (identical files), each with `.sha256`
  - `RelayDesktop-Windows-placeholder.zip` is **not** published (placeholder).
  Use `softprops/action-gh-release@v2` (or `gh release create`), generate
  release notes, `permissions: contents: write` only on that job. The probe
  is built from `probe/` at the release version, recorded in
  `Resources/probe-version.txt` and in the release body.
- Windows placeholder `windows/`: `RelayDesktop.Windows.csproj`
  (`net8.0-windows`, `UseWPF`), `App.xaml(.cs)`, `MainWindow.xaml(.cs)` showing
  the Agent Relay name and "Windows support is coming soon", plus
  `windows/README.md` describing the planned parity (tray icon, sign in, probe
  supervision via the same bridge). Must build with `dotnet build`.
- Top-level `README.md`: what the app does, download links (the stable release
  URLs), first-run/Gatekeeper note, how the probe is bundled and installed,
  development (`swift build`, `RELAY_DESKTOP_PROBE`), release process (dispatch
  for the `YYYY.MM.N` default, or tag `desktop-vYYYY.MM.N`), required secrets/vars table.

## 7. agentrelay.com

- New route `web/app/download/page.tsx` ("Download Agent Relay for Mac"):
  two buttons — *Download for Apple silicon* →
  `https://github.com/AgentWorkforce/relay-desktop-releases/releases/latest/download/AgentRelay-macOS-arm64.dmg`,
  *Download for Intel Mac* → `…/AgentRelay-macOS-x64.dmg`; a short "How to tell
  which Mac you have" note (Apple menu → About This Mac); "Windows: coming
  soon"; link to the release page and to the Teams sign-up. Metadata +
  `alternates.canonical`, add to `app/sitemap.ts`.
- URLs live in `web/lib/desktop-downloads.ts` with a vitest in `web/lib/test/`.
- "Download" link in `SiteNav` (desktop + mobile) and in the footer Products
  column. Reuse existing CSS modules/classes (`landing.module.css` CTA styles)
  rather than inventing a new design system.

## 8. Out of scope for this pass

Multiple workspaces per machine, Windows functionality, auto-update
(Sparkle), Homebrew cask, per-session upload progress bars, an in-app browser
for Google sign-in.

## 9. Cloud message receiver (multiplayer)

A second, independent pipe alongside the probe's history upload: the cloud
service delivers messages **into** a running Codex thread on this Mac, so a
web user can post into another user's local Codex session ("multiplayer").
The desktop side is the relay core's `relay::outbox` (messages, outbox store,
sharing policy, inbox and Codex delivery), `relay::mailbox` and
`relay::incoming`, with their tests;
the cloud side does not exist yet, so every endpoint below is **PROPOSED**.
This section is that contract.

```
cloud ──(websocket / poll)──▶ CodexInbox.receive ─▶ [dedupe] ─▶ [pause] ─▶ [rate limit] ─▶ [sharing policy]
                                                                                  │
                                                        deny ──────────────────▶ ack: rejected
                                                        hold ──▶ CodexOutbox(held) ─▶ ack: held_for_approval
                                                        deliver ▶ CodexOutbox(pending) ─▶ ack: queued
CodexDelivery worker ─▶ CodexBridge (Codex IPC socket) ─▶ ack: delivered ─▶ completed/aborted/failed/expired
```

The desktop transport, durable policy, application lifecycle and sharing controls
are now implemented.
The endpoint descriptions below remain proposed; no cloud service is deployed
by this repository.

### 9.1 Transport

The relay core (`relay::mailbox`) connects to the cloud over a WebSocket,
authenticated with the person's Agent Relay session, never a probe-issued
credential. It calls the Cloud room-session endpoint with that session, then
activates the returned per-device participant at
`{relaycastBaseUrl}/cloud/api/v1/desktop/session`. The returned mailbox origin,
scope, paths and expiry are persisted separately from probe identity. The
Cloud counterpart is deployed separately. Missing/expired credentials fail closed.

- PROPOSED: `wss://{site}/cloud/api/v1/desktop/messages?account_id=ID&workspace_id=ID`,
  one frame per `CodexInboundMessage` JSON object (§9.2) from the cloud.
  The desktop batches upstream acks over HTTP for both downstream transports,
  so HTTP acceptance, rather than a successful socket write, confirms them.
- **Polling fallback**, same message shape, for when the socket can't stay
  open (app backgrounded, network blocks websockets): PROPOSED
  `GET {site}/cloud/api/v1/desktop/messages?since=ID` returning a JSON array
  of `CodexInboundMessage`; acks post back with PROPOSED
  `POST {site}/cloud/api/v1/desktop/acks` (array of `CodexInboundAck`). The
  app picks whichever transport is up; both feed the same
  `CodexInbox.receive`, so behaviour is identical either way.
- **Reconnect:** exponential backoff (start ~1s, cap ~30s, jitter — match the
  probe's existing retry posture rather than inventing a new one). On
  (re)connect the app sends the id of the last message it durably queued
  (tracked alongside the outbox) as `since`; the cloud replays anything
  newer. Redelivery of an already-seen id is always safe: `CodexInbox.receive`
  re-acks the message's current state instead of re-enqueueing when
  `CodexOutbox` already has that id, and `CodexOutbox.enqueue` itself is
  `insert or ignore` on `id`. The cloud may therefore retry sends freely
  without a fresh handshake.

### 9.2 Downstream message shape (cloud → desktop)

Exactly `CodexInboundMessage` (`probe/src/relay/outbox/messages.rs`). Decoding is
lenient about unknown fields, so the cloud can add some later without
breaking older apps:

```json
{
  "id": "msg_9f2c…",
  "thread_id": "12345678-1234-1234-1234-123456789012",
  "text": "can you also check the retry path?",
  "sender": {"id": "usr_44…", "display_name": "Priya K", "email": "priya@example.com"},
  "created_at": "2026-09-19T18:04:02Z",
  "expires_at": "2026-09-20T18:04:02Z"
}
```

`id` is chosen by the cloud and is the durable outbox idempotency key.
Redelivery finds that existing row or its retained tombstone. The window-socket
route also supplies it as `clientUserMessageId`; the default queue route uses a
hashed attribution reference to find the turn in the rollout (§9.6).

`expires_at` is optional. The deadline is the earliest of that value,
`created_at + CodexDelivery.defaultLifetime` (24h), and `now + 24h`.
Using creation time prevents an old replay from receiving a fresh lifetime.
A message that
outlives its lifetime while waiting for a deliverable thread settles to the
`expired` ack (§9.3) rather than sitting forever.

Both `CodexInboundMessage` and its nested `Sender` declare explicit snake_case
`CodingKeys` (`thread_id`, `created_at`, `expires_at`, `sender.display_name`),
so the wire format is snake_case throughout and independent of any decoder
key strategy.

### 9.3 Upstream ack shape (desktop → cloud)

Exactly `CodexInboundAck` (`probe/src/relay/outbox/messages.rs`), one per message id.
The outbox journals each ack in the same SQLite transaction as its state
change. The receiver posts ordered batches of at most 100; a batch boundary
survives relaunch and lost responses, while newer transitions wait behind it.
Redelivery re-acks the stored current state without enqueueing again. Compact
final-status tombstones retain dedupe after message content is pruned:

```json
{"id": "msg_9f2c…", "status": "queued", "reply": null, "error": null, "at": "2026-09-19T18:04:02Z"}
```

`status` is one of:

| status            | meaning                                                           | what the web sender should show |
|-------------------|--------------------------------------------------------------------|----------------------------------|
| `queued`          | accepted, durably stored, will deliver once the thread is idle     | "waiting" |
| `held_for_approval`  | shared thread is in `hold` mode; waiting on the local user         | "waiting for approval" |
| `delivered`       | a Codex turn has started for it                                    | "running" |
| `completed`       | Codex finished the turn; `reply` carries its answer                 | "answered" (show `reply`) |
| `aborted`         | the turn was interrupted before finishing                          | "interrupted" |
| `failed`          | Codex refused it after retries (`error` says why)                  | "failed" (show `error`) |
| `expired`         | it waited past its lifetime for a thread that never became deliverable | "timed out" |
| `rejected`        | refused before queueing at all — not shared, full-access blocked, unknown thread, paused, rate limited (`error` says which) | "not delivered" (show `error`) |

`CodexInboundAck.Status` overrides the one multi-word case
(`case heldForApproval = "held_for_approval"`) so every wire value is
snake_case, consistent with the rest of this document.

### 9.4 Authorization and safety

A cloud message runs as a prompt inside an agent on the user's own machine,
under that thread's Codex permissions — and some Codex threads run with
`sandbox_policy: danger-full-access` (no sandbox at all,
`CodexBridge.isUnrestricted`). Treat every layer below as required, not
optional, because the failure mode is a stranger's text executing with the
local user's file/shell access:

- **(a) Explicit per-thread opt-in, enforced locally, fail-closed.**
  `CodexSharingPolicy` denies by default: `decide(threadID:isUnrestricted:)`
  returns `.deny` for any thread with no `CodexThreadShare` on file, full
  stop. Cloud-side workspace or channel membership is never sufficient by
  itself — a thread is only reachable once *this Mac's* user has shared it
  here, and `unshare` takes effect on the very next message. The app loads
  `CodexSharingPolicy(storeURL:)` from an account/workspace/site-scoped file.
  Grants are persisted atomically before becoming active; unreadable/corrupt
  policy prevents startup. Settings exposes the local opt-ins and approvals.
- **(b) A second opt-in for unrestricted threads.** `CodexThreadShare` has an
  `allowsUnrestricted` flag separate from sharing itself. In `auto` mode, a
  thread whose sandbox is off (`isUnrestricted == true`) is downgraded to
  `hold` unless `allowsUnrestricted` is also set — `isUnrestricted` defaults
  to `true`, the cautious answer, whenever the app can't read the thread's
  policy at all. Sharing a thread does not, by itself, grant unattended
  access to a full-access thread.
- **(c) Hold vs. auto per thread.** `CodexThreadShare.Mode`: `hold` asks the
  local user before every single message regardless of sender; `auto`
  delivers without asking, subject to (b).
- **(d) Sender attribution is prepended, not decorative.** Every delivered
  message is rewritten by `CodexInbox.attributed(_:)` before it reaches
  Codex: `"[via Agent Relay — from \(sender.displayName)]\n\n\(text)"`. Codex
  shows an injected message identically to one the user typed otherwise, so
  this line is the only thing that stops the local user — and the model —
  from reading a stranger's message as the user's own instruction.
- **(e) An instant pause control.** `CodexInbox.isPaused` is checked first,
  before rate limiting or the sharing policy: while paused, every inbound
  new message is rejected immediately with `"incoming messages are paused"`.
  The refusal is stored for dedupe/audit but never enters the delivery queue.
  The menu bar's **Pause uploads** control (§2) now gates inbound delivery
  immediately, including already-pending messages. Previously handed-over
  turns cannot be recalled; their outcomes still settle.
- **(f) Rate limits per sender and per thread.** `CodexInbox` enforces 30
  messages per `(senderID, threadID)` pair per 60s window
  (`CodexOutbox.enqueuedCount`, counting all states, not just delivered
  ones), ahead of the sharing-policy check — a rate-limited sender is
  rejected before the local sharing decision is even consulted.
- **(g) Audit trail.** `CodexOutbox` durably records, per message: sender id
  and name, the exact text, every state transition with timestamps
  (`enqueued_at`, `last_attempt_at`, `updated_at`), attempts, and the final
  `reply`/`last_error` — in
  `~/Library/Application Support/com.agentrelay.desktop/incoming/<scope>/codex-outbox.sqlite`.
  The transition journal also drives upstream acknowledgements. Unconfirmed
  rows remain until acknowledged; compact dedupe tombstones retain final IDs.
  Finished content is kept for `CodexDelivery.finishedRetention` (7 days) before
  pruning, so "who sent what, when, and what happened" is answerable locally
  for at least a week without any cloud round-trip.

### 9.5 Thread catalog (desktop → cloud)

For the web UI to have anything to address, the app reports its shareable
threads. `CodexBridge.recentThreads(limit:)` already reads
`~/.codex/state_5.sqlite` for exactly this: `id`, `title` (first non-empty,
non-tag line of the thread's raw title, truncated to 60 chars), `directory`
(→ `projectName`, its last path component), `updatedAt`, restricted to
`source = 'vscode'` rows (only threads a Codex window can own — a CLI-run
thread has no window to receive a message, so it's excluded), newest first,
default limit 20. `CodexBridge.openThreadIDs(among:)` separately reports
which of those are *currently* owned by an open Codex window, i.e.
deliverable right now versus merely known.

The desktop periodically posts a replacement snapshot to PROPOSED
`POST {site}/cloud/api/v1/desktop/threads`, listing `id`, `project`
(`projectName`), `title`, `open`, `shared`, and `mode` (`hold|auto`). Only
explicitly shared UUID threads leave the Mac, including an empty snapshot when
all shares are revoked. The owner's local Settings catalog includes unshared
threads for opting in. The cloud must also enforce catalog/member authorization;
local sharing is rechecked even if the cloud's snapshot is stale.

### 9.6 Delivery route: Codex's own queue (default)

`CodexDelivery.route` defaults to `.queue`: messages go in with the public
command `codex queue --thread <uuid> --message=<text>`
(`CodexQueueBridge`, `CodexQueueCommand`). Codex keeps a durable per-thread
queue (`~/.codex/queue_1.sqlite`, app-server methods `thread/queue/*`) that the
desktop app's bundled server and every terminal `codex` share; whichever has the
thread loaded runs the message as a user turn once the thread is idle. Verified
live 2026-09-20 against a desktop-app thread (open in a window) and a terminal
thread. The window-routing socket of §9 (`CodexBridge`, private and
version-pinned) remains as `.windowSocket`, used only when no `codex` binary
with `queue` is found.

- **Which binary:** `RELAY_DESKTOP_CODEX`, then the one inside the desktop app
  (`/Applications/ChatGPT.app/Contents/Resources/codex` — the same build that
  reads the queue for app threads), then `~/.local/bin`, Homebrew.
- **Finding the turn again:** Codex assigns its own `client_id` to a queued
  message and does not record the queue item id, so the attribution line carries
  a reference — `[via Agent Relay — from Alice · ref 1a2b3c4d5e6f]`, twelve hex
  digits of SHA-256(message id) (`RelayMessageRef`). `CodexRolloutSummary.turnByMessageRef`
  maps it to the turn; outcome and reply then settle exactly as before.
- **States:** after `codex queue` succeeds the message stays `sending`, acked
  `queued`; it becomes `delivered` only when the session file shows the turn
  started, then `completed`/`aborted`. A `sending` message still present in
  Codex's queue is left alone (never re-sent); if the queue can't be read that
  counts as still waiting. Past its expiry it is acked `failed`.
- **Never re-send on doubt.** Codex takes a message off its queue a moment
  before the session file records it, so "in neither place" must persist for
  45 s (`missingGrace`) before a message counts as lost and is retried; an
  expired message is failed, never retried; a timed-out `codex queue` is waited
  on until it has really exited. Only a `codex` that answers `queue --help` is
  used (checked once per build; a probe that times out is not remembered and
  is asked again); otherwise the window socket delivers. Each send records the
  route it took (`route` column), and a send in doubt is settled by *that*
  route's rules — a message sitting in Codex's queue is never re-sent through
  the socket just because the `codex` binary has since gone.
- **Thread ids must be UUIDs** (`CodexQueueCommand.isThreadID`): `codex queue`
  also matches session *names*, which a cloud-supplied value must never do.
- **Open:** whether a thread that is not loaded anywhere ever runs a queued
  message (it presumably waits and fires when next opened — the CLI has no
  `delete`, only the app-server API does, so an expired message can linger in
  Codex's queue); text travels in argv here, since `codex queue` has no stdin form.

## 10. Claude sessions (multiplayer)

The same receiver, for the Claude desktop app: a web teammate's message lands
in a Claude session the local user has open. Implemented in the relay core
(`relay::claude` and `relay::outbox`'s Claude delivery, with their tests) up to
the same `inbox.receive` / `inbox.sendAck` seam as §9.

### 10.1 Mechanism (researched 2026-09-19, Claude desktop 2.2553.1, CLI 2.1.27x)

What was found, so nobody re-walks the dead ends:

- **The desktop app exposes nothing local to inject into.** No listening
  socket or port. Its sessions that work on a local folder are **cloud
  sessions** (`session_…` / `cse_…` ids): the model loop runs on Anthropic's
  side, and the app only spawns `claude --attach-serve cse_…` locally to serve
  the folder's tools. Input never passes through this Mac. Plain chat
  conversations are server-side too.
- **The way in is Claude's own command line:**
  `claude --print --cloud <session id>` with the message on stdin "sends the
  prompt to an existing cloud session" under the user's existing Claude
  sign-in, prints `Sent to cloud session.` and exits 0 (~1.5 s). It works on a
  session that is already open, needs nothing launched specially, edits no
  config, and the app never touches Claude credentials. Verified live: the
  message appears in the desktop conversation as a user message and Claude
  answers it.
- **Session discovery:** the desktop app lists its folder sessions in
  `~/Library/Application Support/Claude/local-agent-mode-sessions/<account>/<org>/remote-session-spaces.json`
  (`{entries: [{sessionId, folders, memoryEnabled}]}`), read-only
  (`ClaudeBridge.sessions()`).
- Rejected: **channels** (`--channels`, research preview) — supported, but
  only for sessions *launched* with the flag, so never an already-open one,
  and would need the user's MCP config or a plugin install. **Deep links**
  (`claude://code/new?q=`, `claude://cowork/new?q=`) only start *new*
  sessions. **The sessions HTTP API** (`/v1/sessions/{id}/events`) would mean
  lifting the user's Claude OAuth token from another app's storage: not done,
  by design. **UI automation**: fragile, no delivery signal.
- Not covered yet: terminal `claude` sessions. They have a local peer inbox
  (`~/.claude/sessions/<pid>.json` → `messagingSocketPath`, NDJSON with a
  token from a 0600 key file), but it is a private, fast-moving protocol whose
  messages arrive as "from another session" (and may be held for local
  approval), not as user turns. A possible second backend behind
  `ClaudeDelivery.send`; deliberately left out of this pass.

### 10.2 What is shared with §9 and what differs

Reused unchanged: `CodexOutbox` (own database file `claude-outbox.sqlite`; its
`threadID` holds the Claude session id), `CodexSharingPolicy`, `CodexInboundAck`
(§9.3) and `CodexInboundMessage.Sender`. Claude analogues: `ClaudeInboundMessage`,
`ClaudeInbox` (same pipeline as `CodexInbox`: dedupe → session id check → pause →
rate limit 30/min per sender+session → sharing policy → queue, attribution
prefix, authorization re-checked at delivery) and `ClaudeDelivery`.

Differences, all from one fact — **Claude confirms the hand-off and nothing
after it** (the send mode refuses `--output-format stream-json`, and turn state
is only on the OAuth-protected events API):

- **The send uses the documented machine-readable result.**
  `claude --print --cloud <id> --output-format json` returns
  `{"ok":true,"session_id":…,"url":…}` or
  `{"ok":false,"session_id":…,"error":…}` (verified against the CLI
  2026-09-20). Argument and configuration errors print plain text with no
  JSON, and an older `claude` may not know the flag, so its
  `Sent to cloud session.` line is still accepted as a fallback.
- **Acks end at `delivered`.** No `completed`, never a `reply`. The cloud must
  treat `delivered` as the terminal success status for Claude targets. (The
  outbox row is stored `completed` so the session's next message is freed.)
- **At-most-once.** A send cut short — timeout (60 s), or the app quitting
  mid-send — cannot be checked afterwards, so it is acked `failed` ("may or
  may not have reached the session") rather than re-sent: a teammate's prompt
  running twice is worse than not running. Only failures Claude itself
  reported before accepting are retried (3 attempts, exponential backoff).
  Archived/unknown session and "not enabled for your account" fail at once.
- **No idle gate.** Per-session order is preserved (one send at a time, in
  queue order); a backlog drains immediately and Claude's side queues turns.
- **No `claude` command line installed:** messages stay `pending`, attempts
  unspent, until it appears or they expire.
- **`isUnrestricted` is always true.** The app cannot see a cloud session's
  permission mode, so per §9.4's fail-closed rule an `auto` share delivers
  without asking only with `allowsUnrestricted`; otherwise messages hold.

Ack and authorization rules the inbox keeps (each from PR #2 review):

- **`sending` acks as `queued`.** `delivered` is final to the cloud, so a
  redelivery that arrives mid-send must not claim it before Claude confirms.
- **Acks are ordered.** Storing a message wakes the worker; `ackLock` makes the
  first ack (`queued` / `held_for_approval`) and the worker's acks serial, so
  the cloud never sees `delivered` followed by `queued`.
- **State-dependent refusals are remembered.** Paused, rate-limited and
  not-shared refusals are stored as `rejected` rows
  (`CodexOutbox.recordRejected`), so a repeat of the id after the pause ends or
  the session is shared replays the rejection rather than delivering a message
  its sender was told was refused. They count toward the sender's rate window.
  An invalid session id is refused without a record: it can never become valid.
- **Delivery re-runs the whole sharing decision**, not just "is it shared":
  `deny` → `rejected`; `hold` → the message goes back to `held` and acks
  `held_for_approval` — unless the local user already approved that message
  (`approved_at`), which stays cleared to go.

The Codex receiver now also implements durable refusals, ordered acknowledgements
and full delivery authorization rechecks.

Safety specific to this route: the session id comes from the cloud and ends up
on a command line, so `ClaudeSessionID` admits only `session_`/`cse_` + 8–64
ASCII alphanumerics — at the inbox *and* again at delivery. Anything else could
be read as a flag, or as the description of a **new** cloud session. Message
text goes on stdin, never argv. The send runs from a neutral working directory
so no project settings or hooks load.

### 10.3 Downstream message shape (cloud → desktop)

PROPOSED, mirroring §9.2 with `session_id` in place of `thread_id`:

```json
{
  "id": "msg_…",
  "session_id": "session_01…",
  "text": "…",
  "sender": {"id": "u_…", "display_name": "Alice", "email": "alice@example.com"},
  "created_at": "2026-09-19T04:00:00Z",
  "expires_at": "2026-09-19T05:00:00Z"
}
```

Acks are §9.3 verbatim. How one websocket frame says "Codex" vs "Claude" is
for the transport to settle (PROPOSED: a `target: "codex" | "claude"` field on
the envelope; until then the presence of `session_id` vs `thread_id` is
unambiguous).

### 10.4 Session catalog (desktop → cloud)

PROPOSED, alongside §9.5: report `ClaudeBridge.sessions()` — `id`, `project`
(`displayName`, the first folder's last path component), `shared`/`mode` from
the sharing policy — under the same only-offer-shared-sessions rule.

### 10.5 Requirements and open items

- The `claude` command line, signed in to the same account as the desktop app
  (`ClaudeBridge.locateClaude()` checks `RELAY_DESKTOP_CLAUDE`, then
  `~/.local/bin`, `~/.claude/local`, Homebrew paths — a Finder-launched app
  has no shell `PATH`). Sending to existing cloud sessions is account-gated by
  Anthropic.
- Open: surfacing Claude sessions and held messages in the menu-bar UI;
  persisting shares (same gap as §9); a supported way to read turn outcome,
  which would restore `completed` + `reply`.
