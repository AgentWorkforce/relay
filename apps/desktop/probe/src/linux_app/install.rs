//! Where this install lives, read from the running executable.
//!
//! On Linux an install tree holds `usr/`:
//!
//! | Path | Is |
//! |---|---|
//! | [`APP`] `usr/bin/agent-relay-desktop` | The app |
//! | [`PROBE`] `usr/lib/agent-relay/agent-relay-probe` | The relay core |
//! | [`LAUNCHER_ENTRY`] `usr/share/applications/agent-relay.desktop` | The launcher entry |
//! | [`ICON`] `usr/share/icons/hicolor/scalable/apps/agent-relay.svg` | The icon |
//! | [`UNIT`] `usr/lib/systemd/user/agent-relay.service` | The systemd user unit |
//!
//! The system package installs the tree at `/`; a per-user install unpacks
//! it at `~/.local/lib/agent-relay/<version>/<tree>`. `scripts/build-linux.sh`
//! builds the tree, and `tests/linux_package.rs` checks it against these paths.
//!
//! On Windows a tree is an MSYS2 prefix holding the app, its core and the
//! GTK runtime beside each other (see `install/windows.rs`); a per-user install
//! unpacks it at `%LOCALAPPDATA%\Programs\AgentRelay\<version>\<tree>`, and
//! `scripts/build-windows.sh` builds it.

use std::ffi::OsString;
use std::io;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

#[cfg(windows)]
pub mod windows;

/// The core's file name, in a tree and beside a build's executables.
#[cfg(not(windows))]
pub const PROBE_NAME: &str = "agent-relay-probe";
#[cfg(windows)]
pub const PROBE_NAME: &str = "agent-relay-probe.exe";

/// The app, in a tree.
#[cfg(not(windows))]
pub const APP: &str = "usr/bin/agent-relay-desktop";
#[cfg(windows)]
pub const APP: &str = windows::APP;
/// The pre-rename app path, recognized only while repairing launcher entries
/// from older per-user installs. New packages never install this name.
#[cfg(not(windows))]
pub(crate) const LEGACY_APP: &str = "usr/bin/agent-relay";
/// The relay core, in a tree.
#[cfg(not(windows))]
pub const PROBE: &str = "usr/lib/agent-relay/agent-relay-probe";
#[cfg(windows)]
pub const PROBE: &str = windows::PROBE;
/// The launcher entry, in a tree.
pub const LAUNCHER_ENTRY: &str = "usr/share/applications/agent-relay.desktop";
/// The icon, in a tree.
pub const ICON: &str = "usr/share/icons/hicolor/scalable/apps/agent-relay.svg";
/// The systemd user unit, in a tree.
pub const UNIT: &str = "usr/lib/systemd/user/agent-relay.service";

/// How the app was installed, which decides how it updates.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InstallKind {
    /// A per-user install, which updates itself: the tarball under
    /// `~/.local/lib/agent-relay` on Linux, the zip under
    /// `%LOCALAPPDATA%\Programs\AgentRelay` on Windows.
    Tarball,
    /// The system package, which the package manager updates (Linux only).
    Deb,
    /// A build from a checkout.
    Source,
}

/// The running executable with every symlink resolved.
#[cfg(not(windows))]
pub fn current_exe() -> io::Result<PathBuf> {
    std::env::current_exe()?.canonicalize()
}

/// The running executable with every link resolved, as a plain `C:\` path
/// (never the `\\?\` form `canonicalize` returns, which registry commands,
/// shortcuts and the logon task would carry on).
#[cfg(windows)]
pub fn current_exe() -> io::Result<PathBuf> {
    Ok(windows::plain(&std::env::current_exe()?.canonicalize()?))
}

/// The kind of install `exe` belongs to.
#[cfg(not(windows))]
pub fn install_kind(exe: &Path) -> InstallKind {
    if exe.starts_with("/usr/bin") {
        InstallKind::Deb
    } else if exe.to_string_lossy().contains("/.local/lib/agent-relay/") {
        InstallKind::Tarball
    } else {
        InstallKind::Source
    }
}

/// The kind of install `exe` belongs to: a per-user install runs from under
/// `Programs\AgentRelay`; anything else is a build.
#[cfg(windows)]
pub fn install_kind(exe: &Path) -> InstallKind {
    if windows::per_user_root_of(exe).is_some() {
        InstallKind::Tarball
    } else {
        InstallKind::Source
    }
}

/// The install tree `exe` (`<tree>/usr/bin/<name>`) runs from: the directory
/// holding `usr/`.
#[cfg(not(windows))]
pub fn install_tree(exe: &Path) -> Option<&Path> {
    exe.parent()?.parent()?.parent()
}

/// The install tree `exe` (`<tree>\bin\agent-relay-desktop.exe`) runs from: the
/// directory holding `bin\`.
#[cfg(windows)]
pub fn install_tree(exe: &Path) -> Option<&Path> {
    exe.parent()?.parent()
}

/// The install tree a packaged core (`<tree>/`[`PROBE`]) runs from.
pub fn probe_tree(probe: &Path) -> Option<&Path> {
    probe.ancestors().nth(Path::new(PROBE).components().count())
}

/// `~/.local/lib/agent-relay`, which holds one directory per version: the
/// one `exe` runs under, else the one under `home`.
#[cfg(not(windows))]
pub fn install_root(exe: &Path, home: &Path) -> PathBuf {
    exe.ancestors()
        .find(|path| {
            let names: Vec<_> = path.iter().rev().take(3).collect();
            names == ["agent-relay", "lib", ".local"]
        })
        .map(Path::to_path_buf)
        .unwrap_or_else(|| home.join(".local/lib/agent-relay"))
}

/// `%LOCALAPPDATA%\Programs\AgentRelay`, which holds one directory per
/// version: the one `exe` runs under, else this account's.
#[cfg(windows)]
pub fn install_root(exe: &Path, home: &Path) -> PathBuf {
    windows::per_user_root_of(exe).unwrap_or_else(|| {
        windows::local_app_data(&|name| std::env::var_os(name), home).join(windows::ROOT)
    })
}

/// The relay core this app runs: `RELAY_DESKTOP_PROBE` when set, else the
/// `agent-relay-probe` beside `exe` (a cargo build puts both binaries in one
/// directory), else the one in `exe`'s install tree. `env` reads one
/// environment variable.
pub fn bundled_probe(exe: &Path, env: &dyn Fn(&str) -> Option<OsString>) -> Option<PathBuf> {
    if let Some(configured) = env("RELAY_DESKTOP_PROBE") {
        let configured = configured.to_string_lossy().trim().to_owned();
        if !configured.is_empty() {
            return Some(PathBuf::from(configured));
        }
    }
    let beside = exe.parent().map(|directory| directory.join(PROBE_NAME));
    let packaged = install_tree(exe).map(|tree| tree.join(PROBE));
    [beside, packaged]
        .into_iter()
        .flatten()
        .find(|path| is_executable(path))
}

/// [`bundled_probe`] for this process.
pub fn current_bundled_probe() -> Option<PathBuf> {
    let exe = current_exe().ok()?;
    bundled_probe(&exe, &|name| std::env::var_os(name))
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    path.metadata()
        .is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
}

/// Windows has no execute bit: a program is a file named `.exe`.
#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
        && path.metadata().is_ok_and(|metadata| metadata.is_file())
}

#[cfg(test)]
#[cfg(unix)]
mod tests {
    use super::*;
    use std::fs;

    const TARBALL_EXE: &str =
        "/home/a/.local/lib/agent-relay/2026.10.7/AgentRelay-linux-x64/usr/bin/agent-relay-desktop";

    fn no_env(_: &str) -> Option<OsString> {
        None
    }

    fn executable(path: &Path) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, "#!/bin/sh\n").unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test]
    fn install_kinds() {
        assert_eq!(
            install_kind(Path::new("/usr/bin/agent-relay-desktop")),
            InstallKind::Deb
        );
        assert_eq!(install_kind(Path::new(TARBALL_EXE)), InstallKind::Tarball);
        assert_eq!(
            install_kind(Path::new(
                "/src/relay-desktop/probe/target/debug/agent-relay-desktop"
            )),
            InstallKind::Source
        );
        assert_eq!(
            install_root(Path::new(TARBALL_EXE), Path::new("/elsewhere")),
            PathBuf::from("/home/a/.local/lib/agent-relay")
        );
        assert_eq!(
            install_root(
                Path::new("/usr/bin/agent-relay-desktop"),
                Path::new("/home/b")
            ),
            PathBuf::from("/home/b/.local/lib/agent-relay")
        );
        assert_eq!(
            probe_tree(Path::new(
                "/home/a/.local/lib/agent-relay/2026.10.7/AgentRelay-linux-x64/usr/lib/agent-relay/agent-relay-probe"
            )),
            install_tree(Path::new(TARBALL_EXE))
        );
        assert_eq!(
            probe_tree(Path::new("/usr/lib/agent-relay/agent-relay-probe")),
            Some(Path::new("/"))
        );
        assert_eq!(
            install_tree(Path::new(TARBALL_EXE)),
            Some(Path::new(
                "/home/a/.local/lib/agent-relay/2026.10.7/AgentRelay-linux-x64"
            ))
        );
    }

    #[test]
    fn the_probe_is_configured_beside_the_build_or_in_the_tree() {
        let directory = tempfile::tempdir().unwrap();
        let tree = directory.path().join("AgentRelay-linux-x64");
        let exe = tree.join("usr/bin/agent-relay-desktop");
        executable(&exe);
        assert_eq!(bundled_probe(&exe, &no_env), None);

        let packaged = tree.join("usr/lib/agent-relay/agent-relay-probe");
        executable(&packaged);
        assert_eq!(bundled_probe(&exe, &no_env), Some(packaged));

        let beside = tree.join("usr/bin/agent-relay-probe");
        executable(&beside);
        assert_eq!(bundled_probe(&exe, &no_env), Some(beside.clone()));

        fs::set_permissions(&beside, fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(
            bundled_probe(&exe, &no_env),
            Some(tree.join("usr/lib/agent-relay/agent-relay-probe"))
        );

        let configured =
            |name: &str| (name == "RELAY_DESKTOP_PROBE").then(|| "/opt/fake core".into());
        assert_eq!(
            bundled_probe(&exe, &configured),
            Some(PathBuf::from("/opt/fake core"))
        );
        let empty = |_: &str| Some(OsString::from(" "));
        assert_eq!(
            bundled_probe(&exe, &empty),
            Some(tree.join("usr/lib/agent-relay/agent-relay-probe"))
        );
    }
}

#[cfg(test)]
#[cfg(windows)]
mod windows_tests {
    use super::*;
    use std::fs;

    const ZIP_EXE: &str = r"C:\Users\a\AppData\Local\Programs\AgentRelay\2026.10.7\AgentRelay-Windows-arm64\bin\agent-relay-desktop.exe";

    fn no_env(_: &str) -> Option<OsString> {
        None
    }

    #[test]
    fn install_kinds() {
        assert_eq!(install_kind(Path::new(ZIP_EXE)), InstallKind::Tarball);
        assert_eq!(
            install_kind(Path::new(
                r"C:\src\relay-desktop\probe\target\debug\agent-relay-desktop.exe"
            )),
            InstallKind::Source
        );
        assert_eq!(
            install_root(Path::new(ZIP_EXE), Path::new(r"C:\elsewhere")),
            PathBuf::from(r"C:\Users\a\AppData\Local\Programs\AgentRelay")
        );
        assert_eq!(
            install_tree(Path::new(ZIP_EXE)),
            Some(Path::new(
                r"C:\Users\a\AppData\Local\Programs\AgentRelay\2026.10.7\AgentRelay-Windows-arm64"
            ))
        );
        assert_eq!(
            probe_tree(Path::new(
                r"C:\Users\a\AppData\Local\Programs\AgentRelay\2026.10.7\AgentRelay-Windows-arm64\bin\agent-relay-probe.exe"
            )),
            install_tree(Path::new(ZIP_EXE))
        );
    }

    #[test]
    fn the_probe_is_configured_beside_the_app() {
        let directory = tempfile::tempdir().unwrap();
        let tree = directory.path().join("AgentRelay-Windows-arm64");
        let exe = tree.join(APP);
        fs::create_dir_all(exe.parent().unwrap()).unwrap();
        fs::write(&exe, "MZ").unwrap();
        assert_eq!(bundled_probe(&exe, &no_env), None);
        let probe = tree.join(PROBE);
        fs::write(&probe, "MZ").unwrap();
        assert_eq!(bundled_probe(&exe, &no_env), Some(probe));
        let configured =
            |name: &str| (name == "RELAY_DESKTOP_PROBE").then(|| r"D:\fake core.exe".into());
        assert_eq!(
            bundled_probe(&exe, &configured),
            Some(PathBuf::from(r"D:\fake core.exe"))
        );
    }
}
