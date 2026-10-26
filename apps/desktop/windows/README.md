# Agent Relay for Windows

Settings → Relay shows **Continue Claude from mobile (Experimental)** but keeps
it disabled on Windows. The shared core reports `mobile_claude_handoff_supported`
as false and refuses opt-in before installation. Claude's native HTTP connection
has not been verified with Windows named pipes, and there is no subprocess
fallback. macOS and Linux use a native Unix-socket connection authenticated as
Claude itself; tool subprocesses are refused. See [the shared flow and
limits](../docs/workspace-layout.md).

The Windows app is the Linux GTK 4 app built for Windows: the same
`agent-relay-desktop` program from [`probe/src/linux_app`](../probe/src/linux_app)
(the probe crate's `gtk` feature), with the same sessions table, header,
Settings panes, Agents, Team, Messages, tray menu and sign-in, word for word.
The logged-out screen offers **Sign in with Google**, without a separate
**Use another account** button. Sign-in always opens Google's account chooser
instead of reusing a saved app or CLI session.
It is a thin client of the relay core, `agent-relay-probe relay serve`,
bundled beside it; see [relay core](../docs/relay-core.md) and the
[Linux README](../linux/README.md) for what every screen does. Only the parts
that touch the operating system differ:

The shared core also exposes Cursor Cloud agent listing, launch, native
follow-up injection, run status, archive and restore on Windows exactly as on
macOS and Linux. Cursor credentials remain in Agent Relay Cloud; no local
`cursor-agent` executable or Windows-specific integration is required. See
[Cursor Cloud agents](../docs/cursor-cloud.md).

| | Linux | Windows |
| --- | --- | --- |
| Bridge to the core | Unix socket `~/.agentworkforce/desktop/core.sock` | Named pipe `\\.\pipe\agent-relay-<hash>`, open only to your Windows account |
| Background service | `agent-relay.service` systemd user unit | **Agent Relay (<your account>)** task in Task Scheduler, run at your logon (no administrator rights) |
| Tray | StatusNotifierItem | Notification-area icon |
| Notifications | Desktop notifications | Windows toast notifications |
| Install | `.deb` or `.tar.gz` | `Setup.exe` or `.zip`, per user |
| Launcher | `.desktop` entry | Start menu shortcut and the `agentrelay://` link handler |
| Settings shortcut | **Ctrl+,** | **Ctrl+,** |

Why GTK rather than WPF or WinUI is in [Windows app plan](../docs/windows-app.md).

As on macOS and Linux, the shared core's peer-message note lets work already
authorized in the receiving session continue within the harness's permissions.
A peer's approval claim grants nothing new, and Claude's native peer-message
restrictions still apply.

Session titles are edited only in the open session's header, using **Rename**.
The title stays as borderless text while editing. Enter or **Done** saves,
Escape cancels, and leaving the editor saves after a short focus-change delay.
The sparkle fills the draft with the saved pipeline title, preloaded when the
session opens. The sessions table has no edit controls or title-preload reads.
This is the same GTK implementation as Linux, with the same optimistic save,
rollback and native-harness capability checks; see **Session titles** in the
[Linux README](../linux/README.md).


## Download

| Windows | Installer | Portable |
| --- | --- | --- |
| x64 (Intel and AMD) | [**AgentRelay-Windows-x64-Setup.exe**](https://github.com/AgentWorkforce/relay-desktop-releases/releases/latest/download/AgentRelay-Windows-x64-Setup.exe) | [`.zip`](https://github.com/AgentWorkforce/relay-desktop-releases/releases/latest/download/AgentRelay-Windows-x64.zip) |
| arm64 (Snapdragon and other Arm PCs) | [**AgentRelay-Windows-arm64-Setup.exe**](https://github.com/AgentWorkforce/relay-desktop-releases/releases/latest/download/AgentRelay-Windows-arm64-Setup.exe) | [`.zip`](https://github.com/AgentWorkforce/relay-desktop-releases/releases/latest/download/AgentRelay-Windows-arm64.zip) |

Not sure which you have? **Settings › System › About › System type**.
Every release also carries version-pinned copies
(`AgentRelay-<version>-Windows-<arch>-Setup.exe`,
`AgentRelay-<version>-Windows-<arch>.zip`) and a `.sha256` for each, plus
`AgentRelay-<version>-Windows-<arch>-probe.zip`, the bare core
(`agent_relay\helpers\agent-relay-probe.exe` and the DLLs it needs) for
headless use.

## Install

Agent Relay installs per user, without administrator rights, under
`%LOCALAPPDATA%\Programs\AgentRelay\<version>\`.

**With the installer.** Double-click `AgentRelay-Windows-<arch>-Setup.exe`.
It asks for no administrator rights and no folder: it installs into
`%LOCALAPPDATA%\Programs\AgentRelay\<version>\AgentRelay-Windows-<arch>\`,
adds Agent Relay to the Start menu (and, if you tick it, the desktop),
registers `agentrelay://` links and starts the app. The installer is not
code-signed yet, so SmartScreen shows *Windows protected your PC*: choose
**More info** › **Run anyway** (see [Unsigned builds](#unsigned-builds)).
Running a newer Setup over an installed Agent Relay upgrades it in place: it
closes the open window, installs the new version beside the old one and moves
Launch at login and the logon task to it, as an in-app update does; if the
logon task cannot be moved, Setup says so and the service restarts from
Settings › **Background service**. For a scripted install, run
it with `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART`; it then does not start the
app.

**Portable, from the zip.** Unpack the zip under the same folder and start
the app once; it adds itself to the Start menu. In PowerShell:

```powershell
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
$release = Invoke-RestMethod https://api.github.com/repos/AgentWorkforce/relay-desktop-releases/releases/latest
$version = $release.tag_name.TrimStart('v')
$base = "https://github.com/AgentWorkforce/relay-desktop-releases/releases/download/v$version"
$zip = "$env:TEMP\AgentRelay-$version-Windows-$arch.zip"
Invoke-WebRequest "$base/AgentRelay-$version-Windows-$arch.zip" -OutFile $zip
$expected = (Invoke-RestMethod "$base/AgentRelay-$version-Windows-$arch.zip.sha256").Split(' ')[0]
if ((Get-FileHash $zip -Algorithm SHA256).Hash -ne $expected) { throw 'Checksum mismatch' }
$dest = "$env:LOCALAPPDATA\Programs\AgentRelay\$version"
Expand-Archive $zip $dest -Force
& "$dest\AgentRelay-Windows-$arch\bin\agent-relay-desktop.exe"
```

Either way, the install is this folder:

```
%LOCALAPPDATA%\Programs\AgentRelay\<version>\AgentRelay-Windows-<arch>\
  bin\agent-relay-desktop.exe  the app
  bin\agent-relay-probe.exe    the relay core
  bin\*.dll, gdbus.exe, …      the GTK 4 runtime from MSYS2
  lib\gdk-pixbuf-2.0\          image loaders, with SVG
  share\glib-2.0\schemas\      GTK's settings schemas
  share\gtk-4.0\               GTK's data
  share\icons\                 Adwaita symbolic icons, the Agent Relay icon and agent-relay.ico
  NOTICES.txt                  the bundled libraries and their licenses
  LICENSE.txt                  the Apache License 2.0 the app and core are released under
  agent-icons-LICENSE.txt      the license of the bundled agent icons
```

On first start a per-user install writes the Start menu shortcut
(`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Agent Relay.lnk`), the
`agentrelay://` link handler under `HKEY_CURRENT_USER\Software\Classes`, and
the **Agent Relay (<your account>)** logon task in Task Scheduler, turned off (one task per Windows account). Windows files the
app's notifications under the AppUserModelId `AgentWorkforce.AgentRelay`
(registered under `HKEY_CURRENT_USER\Software\Classes\AppUserModelId`). The
app's own preferences are in `%APPDATA%\agent-relay\desktop.json`. `agent-relay-desktop.exe
--install-launcher` writes the shortcut without opening the window. A copy
unpacked anywhere else runs, but is treated as a build: it does not update
itself or add a shortcut.

Agent Relay runs once per Windows account. Starting `agent-relay-desktop.exe` again
(the Start menu, a terminal, an `agentrelay://` link) hands its arguments to
the running app and exits within a second: the window comes back from the
tray with the link opened, and `--background` leaves it in the tray, with no
second tray icon. As on Linux this is GApplication's D-Bus uniqueness; the
bus is the bundled `bin\gdbus.exe`, which GLib starts
(`gdbus.exe _win32_run_session_bus`) the first time the app registers and
which keeps running while you are signed in to Windows.

**Settings › Background service** turns the logon task on, as it turns on the
systemd user service on Linux: Task Scheduler then runs `agent-relay-desktop.exe
--headless` when you sign in to Windows, which keeps your agents connected and
uploads running with no window, and the app connects to it. With it off, the
app runs the core itself.

**Updates.** A per-user install checks the public releases once a day.
Installing an update downloads the release's zip, checks its published
SHA-256, unpacks it beside the running version, points the logon task at it
(restarting the task if it runs) and relaunches. The previous version stays on
disk until the next update. After the installer, an update also keeps the
**Installed apps** entry and a desktop shortcut on the new version.

The first release whose app is named `agent-relay-desktop.exe` needs a
one-time manual upgrade from an older install: the old in-app updater requires
`bin\agent-relay.exe` in the downloaded zip, which the renamed package
deliberately no longer provides. Download and run the new Setup program (or
replace a portable install with the new zip). In-app updates work normally
again after that release. The installer preserves the app's data and sign-in.

**Uninstall.** If you used the installer, uninstall **Agent Relay** from
**Settings › Apps › Installed apps**. Its uninstaller
(`%LOCALAPPDATA%\Programs\AgentRelay\unins000.exe`) ends and deletes the
**Agent Relay (<your account>)** logon task, quits Agent Relay, and removes
every installed version (all of `%LOCALAPPDATA%\Programs\AgentRelay`,
including versions in-app updates added), the Start menu and desktop
shortcuts, the `agentrelay://` handler, the notification identity and the
**Launch at login** entry. It keeps your sign-in and data.

For a zip install: quit Agent Relay (tray icon › **Quit Agent Relay**), turn off
the task or run `schtasks /Delete /TN "Agent Relay (%USERNAME%)" /F`, then delete
`%LOCALAPPDATA%\Programs\AgentRelay`, the Start menu shortcut and
`HKEY_CURRENT_USER\Software\Classes\agentrelay` and
`HKEY_CURRENT_USER\Software\Classes\AppUserModelId\AgentWorkforce.AgentRelay`.
Your sign-in and the core's data are in `%USERPROFILE%\.agentworkforce`, and
the app's preferences in `%APPDATA%\agent-relay`.

### Unsigned builds

Releases, the installer included, are not code-signed yet. Microsoft Defender
SmartScreen may show *Windows protected your PC* when you open the installer
or on the first start: choose **More info** › **Run anyway**. **Smart App Control** blocks unsigned programs with no way to allow
one; it must be off (**Windows Security › App & browser control › Smart App
Control**) to run Agent Relay, or anything you build yourself, until releases
are signed. Signing the installer, executables and DLLs is planned (see
[the plan's status](../docs/windows-app.md#status)).

## What works on Windows

Core diagnostics are saved in the app data directory's `logs/core.log`
(`%USERPROFILE%\.local\share\com.agentrelay.desktop\logs\core.log` by default,
respecting `XDG_DATA_HOME` and `--app-data-dir`). This also works for the logon
task, which has no console. Credentials are redacted; the log rotates at 1 MiB
with three backups. Logging failures do not prevent core operation. Raw child
output and request or message bodies are not captured.

Everything the app shows works as on Linux, with these sessions: **Claude
Code** and **Codex** run natively on Windows and list, upload, receive
messages and spawn in full.

Harnesses that are Unix-only tools are unavailable on Windows, and their
Settings rows say so: **Muse**, **Devin**, **Grok CLI**, **Hermes**,
**OpenClaw**, **OpenCode** existing-session injection and **Pi**. The core
reports them unavailable rather than failing to start them.

Every control that changes the core shows the change the moment it is made
and goes back, with the reason beside it, if the core refuses, as on Linux
and the Mac; launch at login (the Run key) works the same way. See
*Controls answer at once* in `linux/README.md`.

Uploads recover the same way as on Linux and the Mac. Uploads that keep
failing on a server error or a dropped connection read **Waiting to retry**
while they wait out a backoff of at most five minutes, and the upload stage
offers **Retry uploads** too; a rate limit only waits. A Retry or Compact that
could not reach the background service is sent on its own once the service
answers again, and its message clears without a click.

## Building from source

The app and the core build with [MSYS2](https://www.msys2.org)'s clang
toolchain, which provides Rust, GTK 4 and its runtime without administrator
rights: **CLANG64** on x64, **CLANGARM64** on Arm. Install MSYS2, then in its
CLANG64 or CLANGARM64 shell:

```sh
# x64 (CLANG64); on Arm, replace clang-x86_64 with clang-aarch64
pacman -S --needed zip unzip \
  mingw-w64-clang-x86_64-{toolchain,rust,gtk4,pkgconf,librsvg,ntldd}
```

Check out with LF line endings, so the shell scripts run:

```sh
git clone -c core.autocrlf=false https://github.com/AgentWorkforce/relay.git
```

Build and run the app and its core:

```sh
cargo build --manifest-path probe/Cargo.toml --features gtk --bin agent-relay-desktop --bin agent-relay-probe
probe/target/debug/agent-relay-desktop.exe
```

The app looks for its core beside itself (`agent-relay-probe.exe`), or where
`RELAY_DESKTOP_PROBE` points. A debug build runs from the MSYS2 shell, which
puts the GTK DLLs on `PATH`; outside it, use the packaged tree.

Build the portable tree and the zips (the same as CI and releases):

```sh
scripts/build-windows.sh --version 0.0.0 --arch x64 --out dist/windows
```

Without `--app` and `--probe` it builds both in release mode with the Agent
Relay icon and version embedded (`AGENT_RELAY_WINDOWS_ICON`, read by
`probe/build.rs`), then writes `dist/windows/AgentRelay-Windows-<arch>/`,
`AgentRelay-<version>-Windows-<arch>.zip` and
`AgentRelay-<version>-Windows-<arch>-probe.zip`, each with a `.sha256`, and,
when [Inno Setup 6](https://jrsoftware.org/isinfo.php) is installed
(`winget install JRSoftware.InnoSetup`; the script finds `ISCC.exe` through
`$ISCC`, `PATH` or Inno Setup's install folder),
`AgentRelay-<version>-Windows-<arch>-Setup.exe` and its `.sha256`, compiled
from [`windows/installer/AgentRelay.iss`](installer/AgentRelay.iss).
`--installer` fails the build without Inno Setup (CI and releases pass it);
`--no-installer` skips it. It copies every DLL the programs and image loaders need from the MSYS2 prefix
(found with `ntldd -R`), compiles GTK's schemas, trims Adwaita to its
symbolic icons, renders `agent-relay.ico` from the SVG mark with
`rsvg-convert` (no binary is checked in; without `rsvg-convert` the tree has
no `.ico` and says so), and writes `NOTICES.txt` from pacman's package and
license data.

A locally built program is unsigned: Smart App Control must be off to run
it, or to run cargo's build scripts at all.

## Tests

In the CLANG64 or CLANGARM64 shell:

```sh
cargo build --manifest-path probe/Cargo.toml --locked --features gtk --bin agent-relay-desktop --bin agent-relay-fake-core
cargo test --manifest-path probe/Cargo.toml --locked --features gtk --lib linux_app
cargo test --manifest-path probe/Cargo.toml --locked --features gtk --test linux_app_gtk
cargo test --manifest-path probe/Cargo.toml --locked --features gtk --test linux_app_hosting
```

The GTK harness needs a desktop session (no virtual display, unlike `xvfb-run`
on Linux). CI runs these on `windows-latest` (x64) and `windows-11-arm`
(arm64), then builds the zips and the installer with
`scripts/build-windows.sh`, and installs and uninstalls with the installer
silently to check where it puts the files and what it removes.

### Session history

Settings › General › **Session history** shows the planned 7, 30 or 90 day and
Forever choices, as on macOS and Linux (`history_retention_days`; see
[workspace layout](../docs/workspace-layout.md)). The control stays disabled
until relayhistory exposes its retention interface. Agent Relay does not remove
older sessions automatically yet.

### Usage diagnostics

Windows uses the same optional PostHog usage events as macOS and Linux through
the shared core and GTK interface. Settings → Share diagnostics controls these
events, including agent registration, messaging, navigation and searches. Search
queries, message contents, names and session IDs are never sent. See the root
README’s Desktop analytics and error tracking section for the schema and limits.
Background transcript following never counts as a new open, even without a
cursor. Awaited update diagnostics have a three-second deadline and wait
asynchronously so an unresponsive core cannot freeze the window before restarting.

Native session titles are published as `session_title` roster metadata, refreshed after
renames and when existing registrations reconnect. A published objective keeps priority.
OpenClaw and Hermes gateway registrations identify an agent rather than one conversation;
their `session_scope: "agent"` prevents a misleading History summary link. Their relay
addresses and message delivery are unchanged.

On a supported Mac or Linux computer, first enable **Accept spawns from Agent
Relay** in Settings and wait for the computer to be claimed by your signed-in
account. Mobile Claude continuation uses that existing ownership proof. Enabling
continuation before the claim is ready is refused before any plugin or setting
change; a peer message cannot establish the claim.

On supported platforms, after your first mobile message, replies stay synced to your phone, including
replies to later messages you type in that same desktop conversation. They stay
bound to the verified owner and current control generation. Before mobile
engagement, desktop replies are not forwarded. Permission prompts for turns you
start on the desktop continue to use Claude's native desktop prompt.
