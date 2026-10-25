# Agent Relay Desktop

Native, temporary agent collaboration: see [Relay Connect](docs/native-connect.md).


The native companion app that connects a computer to
[Agent Relay Teams](https://agentrelay.com) in two clicks: install the app, sign
in with Google, done.

It bundles `agent-relay-probe`, the relay core: one Rust program that puts your
local coding sessions (Claude Code, Codex and friends) on the relay, delivers
messages to them, and captures and uploads them to your workspace. The app shows
that in the menu bar and lets you pause uploads, choose which past sessions to
share, and message your agents. You never have to touch a terminal.

macOS, Linux and Windows ship as full companion apps; the
[Windows app](windows/README.md) is the Linux GTK app built for Windows. The
native [iPhone and iPad app](ipad/native/README.md) connects directly to Cloud
and Relaycast.

## Start over with local sessions during development

Build the probe, list its configured installs, then reset the intended one:

```bash
cargo build --manifest-path probe/Cargo.toml --bin agent-relay-probe
probe/target/debug/agent-relay-probe sharing status --json
probe/target/debug/agent-relay-probe sessions reset --local \
  --site-url '<site_url>' --account '<account_id>' --workspace '<workspace_id>' \
  --confirmation 'RESET LOCAL SESSIONS'
```

Use the install’s site origin and IDs from `sharing status`. For local development,
use the launcher’s exact origin, including its port. This command keeps sign-in
and original Codex/Claude conversations, clears the target install’s upload journal
and selections, and restarts its collector with manual selection and no uploads
selected. Cloud sessions are unchanged. Existing conversations can be discovered,
read, and selected again; refresh the desktop session list after it finishes.

Reader/preview caches and the old reset exclusion list are shared across local
installs, so those are cleared machine-wide. Other installs’ upload journals and
selections are retained. Interrupted local resets replay locally before capture
resumes. A pending cloud reset must be completed before switching reset modes.

Without `--local`, `sessions reset` remains the destructive cloud-and-local reset
and requires `DELETE ALL SESSIONS`. Use `--local` for a development start-over;
the destructive reset deliberately excludes pre-existing sessions. Neither reset
is exposed in the desktop Settings UI.

## Download

| Mac | Download |
| --- | --- |
| Apple silicon (M1 and later) | [**AgentRelay-macOS-arm64.dmg**](https://github.com/AgentWorkforce/relay-desktop-releases/releases/latest/download/AgentRelay-macOS-arm64.dmg) |
| Intel | [**AgentRelay-macOS-x64.dmg**](https://github.com/AgentWorkforce/relay-desktop-releases/releases/latest/download/AgentRelay-macOS-x64.dmg) |

Linux releases include `.deb` packages and relocatable `.tar.gz` trees for
x64 and arm64. See [linux/README.md](linux/README.md) for dependencies,
source runs, and packaging.

| Linux | Debian package | Tarball |
| --- | --- | --- |
| x64 | [**AgentRelay-Linux-x64.deb**](https://github.com/AgentWorkforce/relay-desktop-releases/releases/latest/download/AgentRelay-Linux-x64.deb) | [`.tar.gz`](https://github.com/AgentWorkforce/relay-desktop-releases/releases/latest/download/AgentRelay-Linux-x64.tar.gz) |
| arm64 | [**AgentRelay-Linux-arm64.deb**](https://github.com/AgentWorkforce/relay-desktop-releases/releases/latest/download/AgentRelay-Linux-arm64.deb) | [`.tar.gz`](https://github.com/AgentWorkforce/relay-desktop-releases/releases/latest/download/AgentRelay-Linux-arm64.tar.gz) |

Windows releases are per-user installs for x64 and arm64 that carry the GTK
runtime: a Setup program, or a portable `.zip`. See
[windows/README.md](windows/README.md) for installing, the logon task,
building with MSYS2, and the harnesses Windows lacks.

| Windows | Installer | Portable |
| --- | --- | --- |
| x64 | [**AgentRelay-Windows-x64-Setup.exe**](https://github.com/AgentWorkforce/relay-desktop-releases/releases/latest/download/AgentRelay-Windows-x64-Setup.exe) | [`.zip`](https://github.com/AgentWorkforce/relay-desktop-releases/releases/latest/download/AgentRelay-Windows-x64.zip) |
| arm64 | [**AgentRelay-Windows-arm64-Setup.exe**](https://github.com/AgentWorkforce/relay-desktop-releases/releases/latest/download/AgentRelay-Windows-arm64-Setup.exe) | [`.zip`](https://github.com/AgentWorkforce/relay-desktop-releases/releases/latest/download/AgentRelay-Windows-arm64.zip) |

For unattended macOS installation, headless Ubuntu/systemd installation, and
the private session-socket setup API, see [Agent-driven setup](docs/agent-driven-setup.md).

Not sure which you have? Apple menu → **About This Mac**. "Chip" means Apple
silicon; "Processor" means Intel.

Those two URLs always resolve to the newest release. Every release also carries
version-pinned copies (`AgentRelay-<version>-macOS-arm64.dmg` and
`…-x64.dmg`, byte-identical to the stable names) and a `.sha256` for each image:

```sh
shasum -a 256 -c AgentRelay-macOS-arm64.dmg.sha256
```

Open the image, drag **Agent Relay** to Applications, and launch it.

### Welcome and uploads

On macOS the window is organized by whose relay you are looking at. The rail's
**Me** holds *My agents* (every live session on this Mac, its switch onto the
relay, fleet workers and your agents on other machines) and *My sessions*
(every session with its upload state and the controls to choose which upload).
**Team** shows each teammate's agents on the relay. **Settings** and your
account sit at the foot of the rail; Settings › Appearance chooses Match
system, Light or Dark. The layout is documented in
[`docs/workspace-layout.md`](docs/workspace-layout.md).

Agent Relay opens a full window as well as a menu-bar control. The welcome
screen uses a split layout, with sign-in on the right. Sign in with Google in
your browser; signing in does not select any sessions for upload. The relay core
keeps your Agent Relay session, connects the workspace, captures the local
session catalog and starts the background collector. The window then opens
My agents automatically.

**My agents** lists every session on this Mac; the menu-bar panel counts how
many sessions are receiving messages, local only, uploaded and not. Each row's switch puts the session on the relay, which gives it a name to
message and uploads it. Search filters the list; a row's chevron shows its
address, ids, folder and upload, plus a Cloud session overview and tools for rename, replies, webhooks and
integrations. **Message** in the top bar writes to any address; the **⋯** menu
holds refresh, recent messages and relay settings. Workspace and Claude Code
delivery settings live in **Settings › Relay & messages**.

My agents and Team can filter by machine. Agents on other machines and fleet
workers show their saved Cloud overview when available and can request a new
summary. A published agent description and the original user request from
uploaded History events remain visible while Cloud is generating a summary or
unavailable.

The default is **Only sessions I choose**. In **My sessions** (also the upload
status in the window's status bar or the menu-bar panel), check the rows you want
and click **Upload selected**. Checking a row alone does not start an upload.
Selected sessions continue uploading changes; other existing and newly discovered
sessions stay local. **Settings › Session sharing** is where automatic uploads
for new sessions or all past and future sessions require explicit confirmation.
Existing saved upload policies are preserved. Already uploaded remote data is not
deleted by stopping uploads.

My sessions displays actual per-session queued/uploading/uploaded states and
record-level progress. The open window refreshes every five seconds. Search
filters loaded sessions; **Load more** extends the initial 500-session page.

The session uploads table opens with the latest local titles from the uploader's
shallow catalog while full history capture continues. Preview rows remain
unselectable until the uploader confirms they are ready. The desktop shows
per-source files processed and sessions captured locally. The preview catalog,
local file counts and capture counts stay on the Mac; Cloud receives only
permitted-session delivery progress. Sessions on the relay are uploaded.
Settings controls opening at login, the background service and upload policy.
Settings and Account include About diagnostics: the desktop release (or Git
revision for development), running and bundled service versions, the compiled
RelayHistory (`ai-hist`) version, bridge protocol, service process, Relaycast
verification and live-channel state, and Cloud/Relaycast workspace IDs. Copy
diagnostics copies those displayed fields without credentials or session content.
Disconnected services mark their retained snapshot as stale. Account also lets
you log out.
Quitting the app leaves the relay core running: agents keep receiving messages
and uploads continue. Reopen the app from the Dock or Applications. Turn off
**Settings › General › Keep agents connected after quitting** to have quitting
stop the core until the app opens again.

### First run

When the release was built with Developer ID credentials it is signed and
notarized, and opens normally.

Local builds and PR CI builds produced without those credentials are **ad-hoc signed**. macOS then
refuses the first launch with *"Agent Relay" cannot be opened because it is from
an unidentified developer*. To open it once:

1. In Applications, **right-click** (or Control-click) **Agent Relay**.
2. Choose **Open**.
3. Choose **Open** again in the dialog.

macOS remembers the decision; later launches are normal. On macOS 15 you may
instead have to go to **System Settings → Privacy & Security** and click **Open
Anyway** under the message about Agent Relay.

## How the relay core is bundled and run

The relay core is [`probe/`](probe/), a Rust crate built from this repository by
CI and releases for every target and stamped with the desktop release version it
ships in. It reads local history through the published `ai-hist` crate.
`build-app.sh` lays it inside the bundle with the LaunchAgent that runs it:

```
Agent Relay.app/Contents/
  Info.plist
  PkgInfo
  MacOS/RelayDesktop                                  # the SwiftUI app
  Helpers/Agent Relay Helper                          # agent-relay-probe: the relay core, 0755
  Helpers/Agent Relay Helper (Sessions)               # a hard link to it: the session collector
  Library/LaunchAgents/com.agentrelay.desktop.core.plist
  Resources/AppIcon.icns
  Resources/agent-relay-probe.sha256                  # checksum of the bundled core
  Resources/probe-version.txt                         # the core's version
```

The app registers the LaunchAgent with `SMAppService.agent` on launch. launchd
runs `agent-relay-probe relay serve` at login with no window, keeps it alive,
and restarts it from the bundle after an update; the app is a client of its
socket, `~/.agentworkforce/desktop/core.sock`. Activity Monitor lists the core
as **Agent Relay Helper** and the session collector it starts as **Agent Relay
Helper (Sessions)**. The collector reads local sessions, lists them for *My
sessions* and uploads the ones being shared; it runs as a background process,
so it yields to everything else. When macOS asks for approval,
Settings and the sign-in screen open **System Settings › General › Login
Items**. With **Keep agents connected after quitting** off, quitting
unregisters the LaunchAgent, which stops the core until Agent Relay opens again. Agent Relay Dev has its own label
(`com.agentrelay.desktop.dev.core`), socket (`core.dev.sock`) and data directory
(`com.agentrelay.desktop.dev`). The bridge contract and the lifecycle are in
[`docs/relay-core.md`](docs/relay-core.md).

The core keeps `~/.local/bin/agent-relay-probe` no older than itself (never over
a copy another developer signed) so the command line runs the same uploader.
Packaging checks that the core serves `relay serve` and that the uploader
commands it runs support `--json`, `--selected-sessions-only` and
`sessions preview`; the check runs on hosts that match the build target.

Sign-in opens Google in your default browser and returns to a localhost
receiver the core runs; the app never handles Google credentials or tokens.

## Development

Requirements: macOS 13 or later, the Xcode command line tools, and a Rust
toolchain for the probe.

```sh
# The app on its own (SwiftPM, no Xcode project)
swift build --package-path macos
swift test  --package-path macos

# The probe and its tests
cargo test --manifest-path probe/Cargo.toml --locked
scripts/build-probe.sh --target aarch64-apple-darwin --version 0.0.0 --out probe-build

# A complete, ad-hoc signed bundle
scripts/build-app.sh --arch arm64 --version 0.0.0 --probe probe-build --out dist
# One-time setup for the styled, headless DMG packager (Python 3.10+)
python3 -m venv /tmp/relay-dmg-tools
/tmp/relay-dmg-tools/bin/python -m pip install -r scripts/dmg-requirements.txt
export PATH="/tmp/relay-dmg-tools/bin:$PATH"
scripts/package-dmg.sh --app 'dist/Agent Relay.app' --out dist/AgentRelay.dmg
```

`swift run` has no LaunchAgent to register, so it connects to a core you start
yourself on the same socket:

```sh
cargo run --manifest-path probe/Cargo.toml -- relay serve
```

Development reloads rebuild both the Swift executable and Rust helper, validate
the helper’s reset command, and re-sign the bundle with its existing identity.

Each new build (`build-app.sh`, or `scripts/dev-reload.sh` replacing the app
executables) registers its core again on launch and retires the one registered
before. launchd admits the core against a code requirement macOS records for
the agent: a Developer ID or Apple Development signature names a team, so an
update starts at once. An ad-hoc signature pins the old binary's hash, which
macOS keeps for a short while after the bundle changes; the app registers the
core again while it does not answer, and the new core starts within about a
minute.

Every script takes `--help`. In short:

| Script | What it does |
| --- | --- |
| `scripts/build-probe.sh` | Builds `probe/` for one Rust target, stamped with a version. Writes `agent-relay-probe`, `agent-relay-probe.sha256` and `probe-version.txt`. |
| `scripts/build-app.sh` | `swift build -c release --arch …`, assembles `Agent Relay.app`, renders the icon, fills in `Info.plist`, then signs (Developer ID → notarized, else ad-hoc). |
| `scripts/package-dmg.sh` | Creates a branded Retina `.dmg` with fixed app and Applications icon positions, using `dmgbuild` without Finder automation, and writes `FILE.dmg.sha256`. |
| `scripts/render-dmg-background.swift` | Composes the subdued relay-runner artwork with the source logo/wordmark, dashed drag arrow and install instruction at 1x and 2x. Run with an output directory to preview; `scripts/dmg-settings.py` places the native Finder icons in the matching 768×576 layout. This artwork is specific to the macOS DMG. |
| `scripts/render-icon.swift` | Standalone Swift script that draws the Agent Relay mark on a dark squircle into an `AppIcon.iconset`. Run by `build-app.sh`; `swift scripts/render-icon.swift OUT_DIR` to preview it. |

The Linux app (`agent-relay-desktop`, GTK 4) runs and tests with:

```sh
cargo build --manifest-path probe/Cargo.toml --features gtk --bin agent-relay-desktop --bin agent-relay-probe
probe/target/debug/agent-relay-desktop
xvfb-run -a cargo test --manifest-path probe/Cargo.toml --locked --features gtk --test linux_app_gtk
```

Build a release tree, tarball, and Debian package with
`scripts/build-linux.sh`, passing the app (`cargo build --manifest-path probe/Cargo.toml --release
--features gtk --bin agent-relay-desktop`) and a probe from `scripts/build-probe.sh`
(`x86_64-unknown-linux-gnu` or `aarch64-unknown-linux-gnu`). See
[`linux/README.md`](linux/README.md).

The Windows app is the same `agent-relay-desktop` program, built natively in an
[MSYS2](https://www.msys2.org) CLANG64 (x64) or CLANGARM64 (arm64) shell with
its Rust and GTK 4 packages:

```sh
cargo build --manifest-path probe/Cargo.toml --features gtk --bin agent-relay-desktop --bin agent-relay-probe
cargo test --manifest-path probe/Cargo.toml --locked --features gtk --test linux_app_gtk
scripts/build-windows.sh --version 0.0.0 --arch x64 --out dist/windows
```

`scripts/build-windows.sh` builds both programs and writes the portable tree,
the zip with the GTK runtime, and the bare-core zip. See
[`windows/README.md`](windows/README.md).

The relay core, its bridge contract and the apps' lifecycles live in
[`docs/relay-core.md`](docs/relay-core.md).

## Release process

1. Add user-facing bullets under `## Unreleased` in [`CHANGELOG.md`](CHANGELOG.md),
   user-facing changes for the release, then make sure `main` is green. The
   workflow requires at least one Unreleased bullet and copies those bullets
   into **What's new in this release**.
2. Dispatch the `Desktop Release` workflow with no inputs, or tag and push:

   ```sh
   gh workflow run 'Desktop Release' --repo AgentWorkforce/relay
   # or, to override the default version:
   # gh workflow run 'Desktop Release' --repo AgentWorkforce/relay -f version=2026.09.2
   # or:
   git tag desktop-v2026.09.1
   git push origin desktop-v2026.09.1
   ```

`.github/workflows/desktop-release.yml` then builds macOS, Linux and Windows for arm64
and x64 on native runners (`macos-15`, `macos-15-intel`, Ubuntu 22.04 on
Blacksmith for both Linux architectures, and `windows-latest` and
`windows-11-arm`; see [CI runner configuration](.github/README.md)),
requires macOS signing and notarization, and publishes to
[`AgentWorkforce/relay-desktop-releases`](https://github.com/AgentWorkforce/relay-desktop-releases).
Versions are CalVer (`YYYY.MM.N`, where `N` counts that month's releases
starting at 1). A `workflow_dispatch` run without a `version` input computes
the next `N` from the current month's published releases; pass `version`
(without the leading `v`) to override it, or push a `desktop-v…` tag for the same effect.
Overlapping release runs serialize on one concurrency group; if your run shows
Canceled because a newer release superseded it while pending, re-dispatch and
it allocates the next `N`.
The source stays in this repository. Each release contains these assets:

- `AgentRelay-2026.09.1-macOS-arm64.dmg` + `.sha256`
- `AgentRelay-2026.09.1-macOS-x64.dmg` + `.sha256`
- `AgentRelay-macOS-arm64.dmg` + `.sha256` (stable name, same bytes)
- `AgentRelay-macOS-x64.dmg` + `.sha256` (stable name, same bytes)
- `AgentRelay-2026.09.1-Linux-x64.deb` + `.sha256`
- `AgentRelay-2026.09.1-Linux-arm64.deb` + `.sha256`
- `AgentRelay-2026.09.1-Linux-x64.tar.gz` + `.sha256`
- `AgentRelay-2026.09.1-Linux-arm64.tar.gz` + `.sha256`
- stable `AgentRelay-Linux-<arch>.deb` / `.tar.gz` copies with `.sha256`
- `AgentRelay-2026.09.1-Windows-x64.zip` + `.sha256`
- `AgentRelay-2026.09.1-Windows-arm64.zip` + `.sha256`
- stable `AgentRelay-Windows-<arch>.zip` copies with `.sha256`
- `AgentRelay-2026.09.1-Windows-<arch>-Setup.exe` + `.sha256`: the per-user
  installer, with stable `AgentRelay-Windows-<arch>-Setup.exe` copies
- `AgentRelay-2026.09.1-Windows-<arch>-probe.zip` + `.sha256`: the bare
  Windows core (`agent_relay/helpers/agent-relay-probe.exe` and the DLLs it
  needs), with stable `AgentRelay-Windows-<arch>-probe.zip` copies
- `AgentRelay-2026.09.1-macOS-<arch>-probe.tar.gz` and
  `AgentRelay-2026.09.1-Linux-<arch>-probe.tar.gz` + `.sha256`: the standalone
  headless probe (`agent_relay/helpers/agent-relay-probe`), with stable
  `AgentRelay-<os>-<arch>-probe.tar.gz` copies. The Linux probe runs on glibc
  2.34 and newer; the release fails if either architecture's probe needs a
  newer glibc (`scripts/check-glibc-floor.sh`).

Installed builds check the public repository's latest stable release once per
day by default. When an update is available, the app shows a blue update button
and asks before quitting to install it. **Settings → Software updates** also
provides an immediate check. The app verifies the architecture-specific disk
image's published SHA-256 and the replacement app's signature before installing
and reopening Agent Relay.

## Repository secrets and variables

Configure these Actions secrets in the repository where builds run. Public
releases require five signing/notarization secrets plus `RELEASES_TOKEN`;
local builds and PR CI can still use ad-hoc signing. No secrets belong in the public
distribution repository.

| Name | Kind | Purpose |
| --- | --- | --- |
| `RELEASES_TOKEN` | secret | Fine-grained token restricted to `AgentWorkforce/relay-desktop-releases`, with Contents read/write. |
| `CSC_LINK` | secret | Developer ID Application certificate and private key, as a base64-encoded `.p12` (the same format as Pear). The signing identity is selected from the certificate. |
| `CSC_KEY_PASSWORD` | secret | Password for that `.p12`. |
| `APPLE_API_KEY_BASE64` | secret | App Store Connect API key as a base64-encoded `.p8`. |
| `APPLE_API_KEY_ID` | secret | App Store Connect API key ID. |
| `APPLE_API_ISSUER` | secret | App Store Connect API issuer ID. |
| `POSTHOG_API_KEY` | secret | PostHog project ingestion key embedded only in official release builds. |
| `POSTHOG_HOST` | secret | HTTPS PostHog ingestion origin embedded only in official release builds. |

The release workflow fails when a signing/notarization secret is missing. GitHub
does not allow one repository to read another repository's secrets, so the five
Apple values must be configured in the source repository.
The publishing token is passed only to the publish job; the default `GITHUB_TOKEN`
stays read-only. Initialize the distribution repo with its README on `main` and
make it public before the first release. A prerelease tag such as `v1.2.3-rc.1`
does not replace the stable `/releases/latest` download.

Create the fine-grained token in GitHub, then store it without putting its value in
a command line or transcript:

```sh
gh secret set RELEASES_TOKEN
```

The tag is created against the distribution repo’s `main`, not the source
commit. Release notes must describe the shipped app; source PR notes are not
automatically copied into the distribution repository. Nothing in these scripts or workflows prints a
secret value; the decoded `.p12` is written to a `0600` temporary file that is
deleted before the script exits, alongside the temporary signing keychain.

## Website

The download buttons on <https://agentrelay.com/download> point at the stable
asset names above, so a new release changes what they serve without any website
deploy.

### Desktop analytics and error tracking

The relay core sends explicit `desktop_operation` events and handled
`$exception` events to the same PostHog project as Cloud, for the production
site in a release build only. The app records the few operations only it
performs (launch, settings, logs, login item, connection links) through the
core. Official release builds receive the project ingestion key and HTTPS host
from protected GitHub Actions secrets. Forks, source builds, tests and
`--dev-site-url` bundles contain no PostHog project configuration and send
nothing. A PostHog ingestion key is not an administrative API credential, but
keeping it out of source prevents community builds from writing to the official
project.

The operation/outcome funnel distinguishes sign-in, browser approval, history
preparation and connection restoration. Further events cover helper startup and
polling failures, reported upload health failures/recovery, pause/resume, including/excluding sessions, sharing-mode changes,
logout, login-item settings and opening settings/logs. Successful polling does not
emit events. Session inclusion means the helper accepted an upload selection; it
does **not** assert that the upload reached Cloud. Native crashes and probe-internal errors that are not exposed in its status
contract are not captured by this client.

After sign-in, events are linked to your Agent Relay account. They never contain
message or session text, searches, paths, URLs, credentials or raw errors.
Opting out turns all of it off.

| State | `distinct_id` | Person and groups |
|---|---|---|
| No install attached | `desktop:<installation UUID>` | `$process_person_profile: false` |
| Install attaches | one `$identify` from `desktop:<installation UUID>` (`$anon_distinct_id`) to Cloud `users.id` | merges the installation's earlier events, sign-in setup included, into the user; a cancelled or unattached sign-in stays anonymous |
| Attached | Cloud `users.id` | `$groups: { organization: <organizations.id>, workspace: <workspaces.id> }` |

The installation UUID is random. Once merged it belongs to that person: a
relaunch keeps it until discovery decides, and sign-out, opt-out, discovery
finding no install and another person attaching replace it. The merge is recorded only once PostHog accepts `$identify`; a
refused one is sent again with the next event. Context is limited to fixed
operation/outcome/error codes, app/probe/OS versions, bounded session counts
(`session_count`) and sharing mode (`sharing_mode`), with `$geoip_disable`.
Error grouping uses operation + error code, so an unknown helper failure remains
`helper_failed`; Cloud supplies server-side diagnostics for the corresponding
failure category. No session replay or UI autocapture is enabled.

Session agents register on Relaycast with `cloud_user_id`, `cloud_workspace_id`
and `owner_hash` in their metadata, so the engine credits their messages to the
signed-in person. When an install attaches, agents registered before it, or
under another person, are updated through `PATCH /v1/agents/{name}`.

**Settings → Share diagnostics** disables both event types and drops queued
events. The core keeps the preference in the app data directory. Identical exception operation/error pairs
are limited to once per minute (repeated background polling failures are also
deduplicated in product events; explicit user attempts still count), with a
global limit of 100 operations per minute on a monotonic clock. One request is
in flight at a time; requests are best effort with finite timeouts, without disk
persistence, and never delay sign-in or upload actions.

The request format follows PostHog's [capture API](https://posthog.com/docs/api/capture)
and [exception schema](https://github.com/PostHog/posthog-js/blob/main/packages/core/src/error-tracking/types.ts).
The core's telemetry and account tests inspect requests with a recording
sender; they never send test events to PostHog.

### Desktop build identity

The probe is an internal component of the desktop release, not a separately
versioned product. Release builds stamp the same `YYYY.MM.N` version into the app
and probe. Plain Cargo builds report `<latest desktop release>-dev+<git revision>`; the manifest's
`0.0.0` is an unpublished package placeholder. Development builds take their numeric base
from the latest release heading in `CHANGELOG.md`; Git hashes identify builds
without being treated as chronological versions. `build.rs` reads the resolved
`ai-hist` version from `Cargo.lock` for runtime diagnostics. The macOS packaging
and reload scripts record the desktop Git revision in `build-revision.txt`.

## License

Agent Relay Desktop is licensed under the [Apache License 2.0](LICENSE).
