# Agent instructions

## Keep the macOS app and the GTK app (Linux and Windows) in sync

The macOS app (`macos/`, SwiftUI) is the reference design. The GTK app
(`agent-relay-desktop` with the probe's `gtk` feature: `probe/src/linux_app`, GTK 4)
serves both Linux and Windows: it is one program built for each, and it must
offer the same features, layout and wording as the Mac on both.
Both apps are thin clients of the same relay core, so nearly every user-facing
change is UI work on both sides over contract methods that already exist.

When a change touches the user-facing app on one platform, make the matching
change on the other in the same PR:

| macOS | Linux and Windows |
|---|---|
| `macos/Sources/RelayDesktop/WorkspaceShell.swift`, `Navigation.swift` | `probe/src/linux_app/ui/shell.rs` |
| `AgentsView.swift`, `AgentRows.swift`, `RelayModel.swift` | `probe/src/linux_app/ui/agents_page.rs`, `ui/relay.rs` |
| `TeamView.swift` | `probe/src/linux_app/ui/team_page.rs` |
| `MainWindowView.swift` (sessions), `SessionsTable.swift`, `UploadStagesView.swift` | `probe/src/linux_app/ui/sessions_page.rs` |
| `AgentsView.swift` (`MessageSheet`, `ActivitySheet`) | `probe/src/linux_app/ui/messages.rs` |
| `SettingsView.swift`, `AboutView.swift`, `IncomingModel.swift` | `probe/src/linux_app/ui/settings_page.rs` |
| `SignInView.swift`, `AppModel.swift` (sign-in, links) | `probe/src/linux_app/ui/app.rs` |
| `MenuPanelView.swift` | `probe/src/linux_app/ui/tray.rs` |
| `AppUpdater.swift`, `RelayDesktopCore/AppUpdate.swift` | `probe/src/linux_app/updates.rs` and About in `ui/settings_page.rs` |
| `RelayDesktopCore/*` presentation logic (presence, upload states and stages, wording, filters, diagnostics) and `shared/RelaySessionOverview` | `probe/src/linux_app/models/` |

Rules:

- Port behavior and wording, not just layout: user-visible sentences should
  match the Mac's word for word unless the platform differs (menu bar vs
  tray, LaunchAgent vs systemd user service vs logon task, DMG vs
  tarball/`.deb` vs zip).
- A core method the Mac app starts calling must be called by the GTK app
  too (and the reverse). Regenerate the Swift contract with
  `scripts/generate-contract.sh` after changing `probe/src/relay/contract`.
- When a feature cannot or should not exist on one platform, say so and why
  in the PR description.
- Platform-specific modules get a Windows counterpart. Code in
  `probe/src/linux_app` or the core that touches the operating system
  (sockets, signals, processes, the background service, the tray, opening
  links and notifications, the install tree and updates, file modes) keeps
  the same trait, contract and wording on Windows, behind `cfg(windows)`. A
  feature that cannot exist on Windows (a harness that is a Unix-only tool)
  is reported unavailable by the core, not hidden, and the PR says why.
- Add or update tests on both sides:
  `swift test --package-path macos` and
  `cargo test --manifest-path probe/Cargo.toml --features gtk --test linux_app_gtk`
  (with `--lib linux_app` for the wording and state). On Windows, run the same
  in an MSYS2 CLANG64 or CLANGARM64 shell, plus
  `cargo test --manifest-path probe/Cargo.toml --features gtk --test linux_app_hosting`;
  CI runs them on x64 and arm64 (see `windows/README.md`).
- Update `docs/workspace-layout.md`, `linux/README.md` and `windows/README.md`
  when the layout or a feature changes.

## Release notes

Every PR that changes what someone using the app or core sees or relies on
adds a bullet under `## Unreleased` in `CHANGELOG.md`, in the same PR. Write it
for the person using Agent Relay, in the style of the bullets already there: a
bold one-line outcome, then what changed and what they do differently, naming
macOS and Linux where they differ. Build-only, CI-only, test-only and iOS-only
changes don't need one. The Release workflow refuses to run while
`## Unreleased` has no bullet, so a missing note blocks the next release.

## Primary buttons

Every blue action must use `AgentRelayPrimaryButtonStyle` on macOS and the
`primary` CSS class on GTK, including actions inside popovers and dialogs.
These are the canonical Agent Relay brand button: deep blue, white label, dark
border, and a tight bottom-left corner in both appearances, without shadow/glow.
Only sizing may vary at call sites. Do not use `.borderedProminent`, workspace
accent fills, local primary styles, or per-screen color/corner overrides.
Change the shared style on both platforms when the brand treatment changes.

## Linux background service behavior

The Linux app starts the `agent-relay.service` systemd user unit only when the
person enabled it: its `--headless` mode applies the agent-led defaults and
removes the app's login entry. Never stop, kill or disable that unit as part of
setup, repair or testing; restart it if it must pick up a change. The same
holds for the Windows **Agent Relay (<account>)** logon task.
