# Agent Relay for macOS (`macos/`)

The native window and menu-bar app: a thin SwiftUI client of the relay core
(`agent-relay-probe relay serve`, [`docs/relay-core.md`](../docs/relay-core.md)).
The core owns sign-in, the uploader, agents, delivery and every Relaycast and
Cloud call; launchd runs it as a LaunchAgent the app registers. The app renders
the core's snapshot, re-fetches what it invalidates, sends it commands, and
keeps what only a Mac app can do: windows and the menu bar, the clipboard,
opening the browser on a sign-in link, notifications, launch at login, and
self-update.

## Layout

```
macos/
  Package.swift                 swift-tools 5.9, macOS 13, no dependencies
  Info.plist.template           __VERSION__ / __BUILD__ are filled in by CI
  RelayDesktop.entitlements     hardened runtime, no sandbox
  Sources/RelayDesktopCore/     the bridge client and view-model helpers, unit tested
    CoreBridge.swift            NDJSON JSON-RPC client: hello, calls, subscriptions
    CoreContract.swift          the bridge contract's types
    CoreService.swift           where the core runs (the LaunchAgent), behind a protocol
    LegacyMigration.swift       one-time moves of what earlier builds kept
    StatusDisplay.swift         uploader stage -> what a person reads
    SessionUploadState.swift    upload state per session row, filters, summary
    UploadStages.swift          the reading / collecting / uploading checklist
    RelayPresence.swift         a session's relay switch state; the roster under people
    Filters.swift               search on My agents, Team and My sessions
    SessionNavigation.swift     Cloud links for uploaded sessions
    AppUpdate.swift             release metadata for self-update
    SVGPath.swift               M/L/C/Z path parser + the Agent Relay mark
    RelativeTime.swift          "3 minutes ago"
  Sources/RelayDesktop/         the app (SwiftUI + AppKit)
    RelayDesktopApp.swift       main Window + MenuBarExtra
    AppModel.swift              the bridge client: connection, account, uploader, settings
    RelayModel.swift            sessions, agents, fleet, roster, people, messages
    ChatModel.swift             Skip chat and projects over `chat.*`
    ContractorsModel.swift      team access over `contractors.*`
    IncomingModel.swift         incoming messages over `incoming.*`
    LaunchAgentService.swift    SMAppService.agent for the core
    LoginItem.swift             SMAppService.mainApp (open the app at login)
    AppUpdater.swift, AppUpdateInstaller.swift  self-update
    *View.swift, AgentRows.swift, SessionsTable.swift, BrandMark.swift, ...  the UI
  Tests/RelayDesktopTests/      bridge client and view models against FakeCore,
                                an in-process fake of the core's socket
```

## Running it locally

`swift run` has no bundle and so no LaunchAgent; start a core on the default
socket in one terminal and the app in another, both from the repository root:

```sh
cargo run --manifest-path probe/Cargo.toml -- relay serve   # terminal 1
swift run --package-path macos RelayDesktop                  # terminal 2
```

- Closing the window keeps the menu-bar app; quitting the app leaves the core
  running.
- Agent Relay Dev never opens the app at login: Settings hides the toggle, and
  launching it removes a login item it registered earlier. Its core's
  LaunchAgent does run at login; **Settings › Background service › Stop and
  Quit** removes it.
- Launch at login and the LaunchAgent need a signed `.app` bundle
  (`scripts/build-app.sh`, ad-hoc is enough locally).
- Production builds register the LaunchAgent only from `/Applications` or
  `~/Applications`. Launching a copy on a mounted DMG can leave BTM pointing
  at the ejected volume; move the app first.
- If macOS loses the bundled agent's container path and launchd reports
  `spawn failed` with exit 78 for `Contents/Helpers/...`, the app switches to
  `~/Library/LaunchAgents/com.agentrelay.desktop.core.local.plist`, whose
  `Program` is the helper's absolute path. It is reloaded after app updates
  and removed when Background service is stopped.
- App logs: `log stream --predicate 'subsystem == "com.agentrelay.desktop"'`.
  Core diagnostics: `~/Library/Logs/Agent Relay/core.log` (Agent Relay Dev
  uses `~/Library/Logs/Agent Relay Dev/core.log`). These credential-redacted
  diagnostics include Connect failures, even under the bundled or fallback
  LaunchAgent. The core rotates at 1 MiB and keeps `core.log.1` through
  `core.log.3`; a record may exceed the cap by at most its bounded line size.
  Logging failures do not prevent the core from starting or serving requests.
  Raw child stdout/stderr and request or message bodies are not captured.
  Live core state: `agent-relay-probe relay call status.get --json`.

Tests never start a core, broker or harness:

```sh
cd macos
swift test
```

For end-to-end development, point a compatible local Agent Relay service stack
at this checkout with `DEV_DESKTOP_DIR`. Agent Relay Dev uses its own bundle ID,
socket (`~/.agentworkforce/desktop/core.dev.sock`) and data directory
(`~/Library/Application Support/com.agentrelay.desktop.dev`), leaving production
connections untouched.

## How the bundle is assembled

`scripts/build-app.sh` (in the repository root) does the assembly:

1. `swift build -c release --arch arm64|x86_64` in `macos/`
2. copies `RelayDesktop` to `Agent Relay.app/Contents/MacOS/`
3. copies the core for that architecture to `Contents/Helpers/Agent Relay Helper`
   (`agent-relay-probe` under the name Activity Monitor shows; its signature
   keeps the identifier `agent-relay-probe`), and once it is signed hard-links
   it as `Contents/Helpers/Agent Relay Helper (Sessions)`, the name the core
   starts its session collector (`run`) under
   (0755) with `Contents/Resources/agent-relay-probe.sha256` and
   `Contents/Resources/probe-version.txt`
4. writes the core's LaunchAgent to
   `Contents/Library/LaunchAgents/com.agentrelay.desktop.core.plist`
   (`BundleProgram` the helper, `relay serve`, `RunAtLoad`, `KeepAlive`)
5. renders `Contents/Resources/AppIcon.icns` and fills in `Contents/Info.plist`
6. signs with the hardened runtime using `RelayDesktop.entitlements`, or ad-hoc
   when no signing identity is configured.

`--debug` builds the debug configuration instead and signs with the keychain's
Apple Development identity when there is one (ad-hoc otherwise), so Keychain
access survives rebuilds; it never uses Developer ID credentials.
`scripts/dev-reload.sh` rebuilds such a bundle in place: it replaces the
executable and resource bundles and re-signs with the bundle's existing
identity. The core's binary and LaunchAgent stay as built.
