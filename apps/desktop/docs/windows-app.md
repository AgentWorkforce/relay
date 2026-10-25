# Agent Relay for Windows: plan of attack

Goal: a Windows app with the same features, layout and wording as the macOS
and Linux apps, built and tested on Windows, shipped from the same release.

## Decision: one GTK app for Linux and Windows

The Linux app (`probe/src/linux_app`, GTK 4, ~32k lines of Rust) is already
a thin client of the relay core with the Mac's layout and wording, its own
light and dark palettes (`ui/theme.rs`) and an in-process fake core for
tests. GTK 4 is a first-class Windows toolkit (MSYS2 ships it prebuilt for
x64 and ARM64; GIMP, Inkscape and Zrythm ship it), so the Windows app is the
**same binary built on Windows**, not a rewrite in WPF or WinUI. Every page,
dialog, row and sentence ports unchanged; only the five modules that touch
the platform get a Windows implementation. The WPF placeholder in
`windows/` goes.

| Module | Linux | Windows |
|---|---|---|
| `linux_app/bridge`, `host`, `fake_core` | Unix socket | Named pipe, through the core's shared transport (below) |
| `linux_app/service.rs` | `agent-relay.service` systemd user unit | A per-user logon task (`schtasks`, no admin) running `agent-relay-desktop --headless`; same `UserService` trait and labels |
| `linux_app/ui/tray.rs` | StatusNotifierItem (`ksni`) | Notification-area icon (`tray-icon` crate, Shell_NotifyIcon); same `Tray` trait and `menu()` model |
| `linux_app/ui/desktop.rs` | `xdg-open`, `Gio.Notification`, terminal emulators | ShellExecute, WinRT toast notifications, Windows Terminal / cmd |
| `linux_app/install.rs`, `updates.rs` | `usr/` tree, tarball or `.deb`, `.desktop` launcher | `%LOCALAPPDATA%\Programs\AgentRelay\<version>\` tree, verified `.zip` from the same GitHub release, Start-menu shortcut and `agentrelay://` protocol under HKCU |
| `bin/agent-relay-desktop.rs` | `exec` into the core for `--headless` | spawn and wait |

The core (`agent-relay-probe relay serve`) is the real port. It is 200k
lines and Unix-bound in a few concentrated ways:

| Concern | Today | Windows |
|---|---|---|
| Bridge socket (`relay/daemon.rs`, `server.rs`, `peer.rs`, `paths.rs`, `cli.rs`) | `~/.agentworkforce/desktop/core.sock`, `SO_PEERCRED` | `relay/transport`: one `CoreListener`/`CoreStream` pair; Unix socket on Unix, `\.\pipe\agent-relay-<hash of path>` on Windows with a DACL limited to the current user, so the OS enforces same-user admission. The lock file keeps its path. |
| Agent-facing sockets (`relay/local.rs` session socket, `outbound.rs` relay-send) | Unix sockets | The same transport |
| `nix`, `libc`, `signal-hook`, `std::os::unix` (98 files) | signals, `exec`, process groups, 0600/0700 perms, `getuid` | `cfg(unix)` and Windows equivalents (`CREATE_NEW_PROCESS_GROUP`, `TerminateProcess`, `tokio::signal::ctrl_c`, permissions as no-ops inside the user profile) |
| Harnesses that are Unix-only tools (Muse, Devin host, Grok CLI, Hermes, OpenClaw gateway socket, OpenCode existing-session injection, Pi extension) | built in | `cfg(unix)`; the core reports them unavailable on Windows and the app's Settings rows say so. Claude Code and Codex (the Windows-native harnesses) work in full. |
| Keychain | `security-framework` on macOS, 0600 file on Linux | The Linux file path |
| Home | `$HOME` | `%USERPROFILE%` |

## Toolchain

MSYS2 CLANGARM64 (this machine) and CLANG64 (x64 CI): `pacman` gives GTK 4,
clang, pkgconf and a Rust toolchain for the `*-pc-windows-gnullvm` targets
without administrator rights. The app links GTK dynamically and ships the
GTK runtime (DLLs, GLib schemas, pixbuf loaders) beside it in the zip.

## Phases

0. Toolchain on this machine; `cargo check` of the core and the app for
   Windows to produce the error inventory; branch `feat/windows-app`.
1. In parallel, one agent each, strict file ownership:
   - **A** core transport: `relay/transport`, `paths`, `peer`, `server`,
     `daemon` listener, `cli` client, `local`, `outbound`, app `bridge`,
     `host`, `fake_core`, and the tests that open sockets.
   - **B1** core platform shims, first half: `probe/src/probe`, `cloud.rs`,
     `delivery`, `migration.rs`, `relay/{process,spawn,claude*,codex,
     login_item,detach,files,account,quota,outbox}`.
   - **B2** core platform shims, second half: `relay/{harness,muse,devin,
     grok,hermes,openclaw,opencode*,pi,existing_session,managed_sessions}`:
     gate Unix-only harnesses, keep their contract and wording.
   - **C** app platform modules: `service`, `tray`, `desktop`, `install`,
     `updates`, `prefs`, `bin/agent-relay-desktop.rs`, theme following Windows
     dark mode.
   - **D** packaging, CI, docs: `scripts/build-windows.sh` (under MSYS2),
     `windows/` (icon, README), CI `windows` job on x64 and ARM64 runners
     replacing the placeholder, release matrix, `docs/*`, `README.md`,
     `AGENTS.md`, `CHANGELOG.md`.
2. Integrate: build both binaries here, run `--lib linux_app`, the GTK
   harness and the hosting tests on Windows, run the app against the real
   core on this machine, screenshot it.
3. Fix loop, review, PR.

## Done looks like

- `agent-relay-desktop.exe` opens the same window as Linux: sessions table, header,
  status bar, Settings panes, Agents, Team, Messages, tray menu, sign-in.
- The core runs as a logon task or as the app's child, on a named pipe, and
  Claude Code and Codex sessions on this computer list, upload and receive
  messages.
- `cargo test --features gtk --lib linux_app`, `--test linux_app_gtk` and
  `--test linux_app_hosting` pass on Windows; CI builds and tests on
  `windows-latest` and `windows-11-arm`; the release publishes
  `AgentRelay-Windows-x64.zip` and `AgentRelay-Windows-arm64.zip`.

## Building and packaging

Everything builds natively inside MSYS2, in the shell for the architecture:
CLANG64 on x64, CLANGARM64 on arm64, with
`mingw-w64-clang-{x86_64,aarch64}-{toolchain,rust,gtk4,pkgconf,librsvg,ntldd}`
plus `zip` and `unzip`. Rust targets `x86_64-pc-windows-gnullvm` and
`aarch64-pc-windows-gnullvm`, the MSYS2 toolchain's host triples.

`scripts/build-windows.sh --version V --arch x64|arm64 [--out DIR] [--app EXE --probe EXE]`
builds `agent-relay-desktop.exe` (with `gtk`) and `agent-relay-probe.exe` (without)
in release mode when `--app`/`--probe` are omitted, and assembles the tree the
app's `install::windows` module describes:

```
AgentRelay-Windows-<arch>/
  bin/agent-relay-desktop.exe, bin/agent-relay-probe.exe
  bin/*.dll                       the closure of both exes, the loaders and the helpers (ntldd -R), from the prefix's bin
  bin/gdbus.exe, bin/gspawn-win64-helper{,-console}.exe
  lib/gdk-pixbuf-2.0/2.10.0/      png, jpeg, gif, bmp, ico and svg loaders; loaders.cache (relative paths)
  share/glib-2.0/schemas/gschemas.compiled   compiled from GTK's own schemas only
  share/gtk-4.0/emoji/            emoji chooser translations
  share/icons/hicolor/            index.theme, apps/agent-relay.svg, symbolic/apps/agent-relay-symbolic.svg
  share/icons/Adwaita/            index.theme and symbolic/ only (no cursors, no icon-theme.cache)
  share/icons/agent-relay.ico     rendered from the SVG mark (rsvg-convert, PNG entries 16 to 256)
  NOTICES.txt                     each bundled package, its version, license, upstream and license texts (pacman)
```

Then `AgentRelay-<version>-Windows-<arch>.zip` (the tree as one top-level
folder) and `AgentRelay-<version>-Windows-<arch>-probe.zip`
(`agent_relay/helpers/agent-relay-probe.exe` and the DLLs it needs, the
Linux and macOS probe archives' layout), each with a `sha256sum`-format
`.sha256`. About 27 MB zipped and 66 MB unpacked, most of it GTK and its
GStreamer media dependency.

Last, with Inno Setup 6 (`ISCC.exe` from `$ISCC`, `PATH`, or Inno Setup's
machine or per-user folder; `--installer` makes it required, `--no-installer`
skips it), `AgentRelay-<version>-Windows-<arch>-Setup.exe` and its `.sha256`,
compiled from `windows/installer/AgentRelay.iss` with `/DVersion`, `/DArch`,
`/DSourceDir` (the tree) and `/DOutputDir`. The installer:

- installs per user with no UAC prompt (`PrivilegesRequired=lowest`) and no
  folder page, into `%LOCALAPPDATA%\Programs\AgentRelay\<version>\AgentRelay-Windows-<arch>`,
  the zip's layout, so in-app updates keep working after it; each version
  gets its own folder (`UsePreviousAppDir=no`), and Setup only installs on
  its architecture (`x64compatible` or `arm64`);
- writes the Start menu shortcut at the app's own path, an optional desktop
  shortcut (unticked), runs `agent-relay-desktop.exe --install-launcher` (handler and
  notification identity, also when silent) and starts the app;
- before installing, ends an open window of an older version under the
  install root (one instance per account, so it would swallow the new
  launch), leaves the background service running, and afterwards points the
  logon task, when there is one, at the new version, restarting it if it
  ran, as `updates::windows::repoint_task` does;
- keeps its uninstaller in `%LOCALAPPDATA%\Programs\AgentRelay` (outside any
  version folder) under a fixed `AppId`, so Installed apps lists one Agent
  Relay. An in-app update rewrites that entry's `DisplayVersion`,
  `InstallLocation` and `DisplayIcon` (`install::windows::UNINSTALL_KEY`)
  and a desktop shortcut into the install root, with the Start menu
  shortcut;
- on uninstall ends and deletes the `Agent Relay (<account>)` task, ends
  every program running from the install root, deletes the whole root (all
  versions), the shortcuts, the `agentrelay://` key when it runs this
  install, the AppUserModelId key and an app-owned `Run` value. Data in
  `%USERPROFILE%\.agentworkforce` and `%APPDATA%\agent-relay` stays.

It is not code-signed yet, so SmartScreen warns on first open; signing it
with the executables is a follow-up.

`bin/gdbus.exe` is what keeps the app to one instance: GApplication's D-Bus
uniqueness works on Windows as on Linux once GLib has started it as the
session bus (`gdbus.exe _win32_run_session_bus`, found beside libgio), and a
later launch forwards its command line over it and exits. Only the first
instance takes the hold that keeps a tray app running (in `startup`, not
before `run`), so the forwarding launch ends as soon as its call returns.

No binary asset is checked in: the `.ico` is rendered at build time, and the
script passes it to cargo as `AGENT_RELAY_WINDOWS_ICON`, which `probe/build.rs`
compiles with `windres` into an icon and `VERSIONINFO` resource linked into
every executable (Windows targets only; without the variable nothing changes).
Without `rsvg-convert` the tree has no `.ico` and the script says so.

CI (`.github/workflows/desktop-ci.yml`, job `windows`) runs on `windows-latest` (x64)
and `windows-11-arm` (arm64) with `msys2/setup-msys2`: it builds the package
with the script (`--installer`; Inno Setup is installed with choco or winget
where the runner lacks it), checks the core's bridge commands, runs the
packaged core with only `System32` on `PATH`, installs and uninstalls with
the Setup program silently and checks what it leaves, uploads the zips and
the installer, then runs
`--lib linux_app`, `--test linux_app_gtk` and `--test linux_app_hosting`.
Checkouts use LF line endings (`core.autocrlf false`; `.gitattributes` keeps
`*.sh` LF). The release workflow's `build-windows` job does the same at the
release version, and `publish` adds the versioned zips and installers, their
stable-named copies (`AgentRelay-Windows-<arch>.zip`,
`AgentRelay-Windows-<arch>-probe.zip`, `AgentRelay-Windows-<arch>-Setup.exe`)
and regenerated `.sha256` files to the release.

## Status

In this PR (packaging, CI and docs):

- `scripts/build-windows.sh`, the tree and both zips; `probe/build.rs` embeds
  the icon and version when asked.
- The WPF placeholder in `windows/` is gone; `windows/README.md` covers
  installing, the logon task, building with MSYS2, tests and the gaps.
- CI `windows` job on x64 and arm64 in place of the .NET placeholder build;
  the release builds, publishes and names the Windows zips and the per-user
  Setup program (`windows/installer/AgentRelay.iss`, Inno Setup 6).
- `README.md`, `docs/relay-core.md`, `docs/workspace-layout.md`,
  `linux/README.md`, `AGENTS.md`, `CHANGELOG.md` and the release notes name
  Windows.

Verified on this machine (Windows 11 on arm64, MSYS2 CLANGARM64): the script's
assembly end to end with stand-in executables (MSYS2's own `gtk4-demo.exe`
and `gdk-pixbuf-query-loaders.exe`): the DLL closure, a bundled program that
runs from the unpacked zip with only `System32` on `PATH` and finds all six
pixbuf loaders through the relative `loaders.cache`, a GTK program that starts
from the tree, the `.ico` (read by .NET's `System.Drawing.Icon`), `windres`
compiling the resource script, and the zips and checksums. Smart App Control
on this machine blocks cargo's build scripts, so the Rust build, the tests and
the real `agent-relay-desktop.exe` run first in CI.

Deferred:

- Code signing of the installer, executables and DLLs (Authenticode): until
  then SmartScreen warns on first open and Smart App Control must be off.
- A winget manifest for the Setup program (MSIX is not planned: the
  per-user Setup keeps the zip's layout, which the in-app updater relies on).
- A headless install script like `linux/install.sh` for Windows servers.
- Linking the core statically so the probe zip needs no DLLs.
- The Unix-only harnesses (Muse, Devin, Grok CLI, Hermes, OpenClaw, OpenCode
  existing-session injection, Pi) on Windows.
- Adwaita 51 has no `emblem-ok-symbolic`, `external-link-symbolic` or
  `utilities-system-monitor-symbolic`, which the app names, and
  `adwaita-icon-theme-legacy` does not carry them either (it holds only
  full-color PNGs, no symbolic icons); no MSYS2 package does. GTK falls back
  to a missing-icon image unless the app ships its own SVGs or uses names
  Adwaita 51 has (`object-select-symbolic`, `web-browser-symbolic` or
  `insert-link-symbolic`, for example).
