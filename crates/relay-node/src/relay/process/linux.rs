//! The process table on Linux, read from `/proc`.

use super::*;
use std::fs;
use std::os::unix::fs::MetadataExt;

fn proc(pid: i32) -> PathBuf {
    PathBuf::from(format!("/proc/{pid}"))
}

/// The fields of `/proc/<pid>/stat` after the command name, which may
/// itself contain spaces and parentheses.
pub fn stat_fields(stat: &str) -> Vec<&str> {
    stat.rfind(')')
        .map(|end| stat[end + 1..].split_whitespace().collect())
        .unwrap_or_default()
}

impl ProcessTable for SystemProcesses {
    fn process(&self, pid: i32) -> Option<ProcessInfo> {
        if pid <= 0 {
            return None;
        }
        let directory = proc(pid);
        let stat = fs::read_to_string(directory.join("stat")).ok()?;
        let uid = fs::metadata(&directory).ok()?.uid();
        let fields = stat_fields(&stat);
        Some(ProcessInfo {
            pid,
            parent: fields.get(1)?.parse().ok()?,
            uid,
            start: fields.get(19)?.parse().ok()?,
        })
    }

    fn process_gone(&self, pid: i32) -> bool {
        pid <= 0
            || fs::metadata(proc(pid))
                .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    }

    fn zombie(&self, pid: i32) -> bool {
        pid > 0
            && fs::read_to_string(proc(pid).join("stat"))
                .is_ok_and(|stat| matches!(stat_fields(&stat).first().copied(), Some("Z" | "X")))
    }

    fn all_pids(&self) -> Vec<i32> {
        fs::read_dir("/proc")
            .map(|entries| {
                entries
                    .flatten()
                    .filter_map(|e| e.file_name().to_str()?.parse().ok())
                    .collect()
            })
            .unwrap_or_default()
    }

    fn executable(&self, pid: i32) -> Option<PathBuf> {
        fs::canonicalize(proc(pid).join("exe")).ok()
    }

    fn is_trusted_codex(&self, executable: &Path) -> bool {
        let uid = crate::relay::peer::current_uid();
        executable.file_name().is_some_and(|name| name == "codex")
            && (codex_location_trusted(
                executable,
                crate::relay::paths::home().ok(),
                std::env::var_os("CODEX_HOME").map(PathBuf::from),
            ) || crate::relay::paths::home().ok().is_some_and(|home| {
                in_mise_installs(
                    executable,
                    &crate::relay::codex::mise_data_dir(&|key| std::env::var(key).ok(), &home),
                )
            }))
            && fs::metadata(executable)
                .is_ok_and(|m| (m.uid() == 0 || m.uid() == uid) && m.mode() & 0o022 == 0)
    }

    fn is_trusted_cursor(&self, executable: &Path) -> bool {
        let uid = crate::relay::peer::current_uid();
        let mounts = fs::read_to_string("/proc/self/mountinfo").unwrap_or_default();
        in_cursor_install(executable, &mounts)
            && fs::metadata(executable)
                .is_ok_and(|m| (m.uid() == 0 || m.uid() == uid) && m.mode() & 0o022 == 0)
    }

    /// The arguments and environment of one process: both are read between
    /// two reads of its start time, so a pid reused between the reads never
    /// mixes two processes' facts (retried, else answered empty).
    fn command_line(&self, pid: i32) -> CommandLine {
        let started = || self.process(pid).map(|info| info.start);
        for _ in 0..3 {
            let before = started();
            let line = CommandLine {
                arguments: self.arguments(pid),
                environment: fs::read(proc(pid).join("environ"))
                    .ok()
                    .map(|bytes| split_nul(&bytes)),
            };
            if before.is_some() && started() == before {
                return line;
            }
            if before.is_none() {
                break;
            }
        }
        CommandLine {
            arguments: Vec::new(),
            environment: None,
        }
    }

    fn arguments(&self, pid: i32) -> Vec<String> {
        fs::read(proc(pid).join("cmdline"))
            .map(|bytes| split_nul(&bytes))
            .unwrap_or_default()
    }

    fn open_files(&self, pid: i32) -> Vec<PathBuf> {
        self.opened_files(pid)
            .into_iter()
            .map(|file| file.path)
            .collect()
    }

    fn opened_files(&self, pid: i32) -> Vec<OpenedFile> {
        fs::read_dir(proc(pid).join("fd"))
            .map(|entries| {
                entries
                    .flatten()
                    .filter_map(|entry| {
                        let fd = entry.path();
                        let target = fs::read_link(&fd).ok()?;
                        if !target.is_absolute() {
                            return None;
                        }
                        // Follow `/proc/pid/fd/N` itself. That names the
                        // inode this descriptor holds, not a path that a
                        // descendant replaced afterward.
                        Some(OpenedFile {
                            birth_ns: birth_of_proc_fd(&fd),
                            path: target,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    fn cwd(&self, pid: i32) -> Option<PathBuf> {
        fs::read_link(proc(pid).join("cwd")).ok()
    }

    fn owns_tcp_listener(&self, pid: i32, host: &str, port: u16) -> bool {
        let sockets: std::collections::HashSet<u64> = fs::read_dir(proc(pid).join("fd"))
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|entry| fs::read_link(entry.path()).ok())
            .filter_map(|path| {
                let value = path.to_string_lossy();
                value
                    .strip_prefix("socket:[")?
                    .strip_suffix(']')?
                    .parse()
                    .ok()
            })
            .collect();
        if sockets.is_empty() {
            return false;
        }
        let wanted_address = match host {
            "127.0.0.1" => Some("0100007F"),
            "::1" => Some("00000000000000000000000001000000"),
            _ => None,
        };
        let Some(wanted_address) = wanted_address else {
            return false;
        };
        let wanted_port = format!("{port:04X}");
        let table = if host == "::1" { "tcp6" } else { "tcp" };
        fs::read_to_string(proc(pid).join("net").join(table))
            .ok()
            .is_some_and(|contents| {
                contents.lines().skip(1).any(|line| {
                    let fields: Vec<&str> = line.split_whitespace().collect();
                    let Some((address, found_port)) = fields.get(1).and_then(|v| v.split_once(':'))
                    else {
                        return false;
                    };
                    fields.get(3) == Some(&"0A")
                        && address == wanted_address
                        && found_port == wanted_port
                        && fields
                            .get(9)
                            .and_then(|inode| inode.parse::<u64>().ok())
                            .is_some_and(|inode| sockets.contains(&inode))
                })
            })
    }

    fn has_terminal(&self, pid: i32) -> bool {
        let stdin = fs::read_link(proc(pid).join("fd/0")).ok();
        let stat = fs::read_to_string(proc(pid).join("stat")).ok();
        let fields = stat.as_deref().map(stat_fields).unwrap_or_default();
        linux_has_terminal(stdin.as_deref(), fields.get(4).copied())
    }

    fn start_clock(&self) -> StartClock {
        StartClock::Ticks
    }
}

/// Where Cursor's Linux packages put it: the `.deb`/`.rpm` and snap roots,
/// or a mounted Cursor AppImage (a FUSE mount `/tmp/.mount_Cursor…` that
/// `mountinfo` lists). A user can mount their own FUSE file system there,
/// so the AppImage arm only keeps a copied binary in any other folder out.
/// That is accepted knowingly: a program already running as this user is
/// outside the editor route's threat model.
pub fn in_cursor_install(executable: &Path, mountinfo: &str) -> bool {
    const ROOTS: [&str; 5] = [
        "/usr/share/cursor",
        "/usr/lib/cursor",
        "/opt/cursor",
        "/opt/Cursor",
        "/snap/cursor",
    ];
    if ROOTS.iter().any(|root| executable.starts_with(root)) {
        return true;
    }
    mountinfo.lines().any(|line| {
        let Some((mount, fstype)) = line.split_once(" - ") else {
            return false;
        };
        let Some(point) = mount.split(' ').nth(4) else {
            return false;
        };
        let point = PathBuf::from(unescape_mount(point));
        fstype.starts_with("fuse")
            && point.parent() == Some(Path::new("/tmp"))
            && point
                .file_name()
                .and_then(|name| name.to_str())
                .and_then(|name| name.strip_prefix(".mount_"))
                .is_some_and(|name| name.to_ascii_lowercase().starts_with("cursor"))
            && executable.starts_with(&point)
    })
}

/// Where Codex's Linux installers put it: a system `bin` folder or package
/// root (npm's global `node_modules/@openai`, `/opt`, Linuxbrew, Nix, snap),
/// or one of the folders under this user's home that Codex's own updater,
/// npm/npx, the usual Node version managers, mise, asdf, pnpm, Bun, Cargo or
/// `~/.local/bin` install to. A `codex` anywhere else (a project folder, a
/// temporary folder) is not trusted.
///
/// The home folders are this user's to write, so this keeps a stray or
/// copied `codex` out rather than proving the binary's origin; a caller's
/// thread is also proven by the writer lock that Codex holds
/// (`codex_process_vouches_for_thread`).
pub fn in_codex_install(executable: &Path, home: Option<&Path>, codex_home: Option<&Path>) -> bool {
    const SYSTEM: [&str; 9] = [
        "/usr/bin/codex",
        "/usr/local/bin/codex",
        "/usr/lib/node_modules/@openai/",
        "/usr/local/lib/node_modules/@openai/",
        "/opt/",
        "/home/linuxbrew/.linuxbrew/",
        "/nix/store/",
        "/snap/",
        "/var/lib/snapd/snap/",
    ];
    const HOME: [&str; 18] = [
        ".codex/packages/",
        ".codex/bin/codex",
        ".local/bin/codex",
        ".local/lib/node_modules/@openai/",
        ".local/share/mise/installs/",
        ".local/share/pnpm/",
        ".local/share/fnm/",
        ".fnm/",
        ".nvm/versions/node/",
        ".volta/tools/",
        ".npm-global/",
        ".npm/_npx/",
        ".bun/install/global/",
        ".asdf/installs/",
        ".cargo/bin/codex",
        ".linuxbrew/",
        ".nix-profile/",
        ".local/state/nix/profiles/",
    ];
    // Compared as text so a root like `/opt/` never matches `/optional`, and
    // a file root (`…/bin/codex`) only itself.
    let Some(path) = executable.to_str() else {
        return false;
    };
    if !executable.is_absolute()
        || executable
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return false;
    }
    let under = |root: &str| {
        if root.ends_with('/') {
            path.starts_with(root)
        } else {
            path == root
        }
    };
    if SYSTEM.iter().any(|root| under(root)) {
        return true;
    }
    // A custom `CODEX_HOME`: Codex's own managed packages and binary there.
    if let Some(codex_home) = codex_home
        .and_then(Path::to_str)
        .filter(|path| path.starts_with('/'))
    {
        let codex_home = codex_home.trim_end_matches('/');
        if under(&format!("{codex_home}/packages/")) || under(&format!("{codex_home}/bin/codex")) {
            return true;
        }
    }
    let Some(home) = home
        .and_then(Path::to_str)
        .filter(|home| home.starts_with('/'))
    else {
        return false;
    };
    let home = home.trim_end_matches('/');
    HOME.iter().any(|root| under(&format!("{home}/{root}")))
}

/// [`in_codex_install`] with `home` and `codex_home` canonicalised, as the
/// kernel's executable path is, so a home reached through a symlink still
/// matches. A relative `CODEX_HOME` names nothing.
fn codex_location_trusted(
    executable: &Path,
    home: Option<PathBuf>,
    codex_home: Option<PathBuf>,
) -> bool {
    let canonical = |path: PathBuf| fs::canonicalize(&path).unwrap_or(path);
    // `~/.codex` itself may be a link elsewhere: its own packages and binary
    // are matched where it resolves to, as a custom `CODEX_HOME` is.
    let default_codex_home = home.as_ref().map(|home| canonical(home.join(".codex")));
    let home = home.map(canonical);
    let codex_home = codex_home.filter(|path| path.is_absolute()).map(canonical);
    in_codex_install(executable, home.as_deref(), codex_home.as_deref())
        || in_codex_install(executable, None, default_codex_home.as_deref())
}

/// Whether `executable` is under mise's own `installs` folder in `data_dir`
/// (`MISE_DATA_DIR`, else `$XDG_DATA_HOME/mise`, else `~/.local/share/mise`;
/// `codex::mise_data_dir`), canonicalised: where Agent Relay finds a Codex
/// mise installed, so that Codex can also name its session.
fn in_mise_installs(executable: &Path, data_dir: &Path) -> bool {
    let installs = fs::canonicalize(data_dir.join("installs")).unwrap_or(data_dir.join("installs"));
    installs.is_absolute()
        && !executable
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
        && executable.starts_with(&installs)
}

/// `mountinfo` writes a space, tab, newline and backslash as octal escapes.
fn unescape_mount(field: &str) -> String {
    field
        .replace("\\040", " ")
        .replace("\\011", "\t")
        .replace("\\012", "\n")
        .replace("\\134", "\\")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_home_or_codex_home_reached_through_a_symlink_still_matches() {
        let root = tempfile::tempdir().unwrap();
        let real = fs::canonicalize(root.path()).unwrap().join("real");
        let bin = real.join(".cargo/bin");
        fs::create_dir_all(&bin).unwrap();
        let codex = bin.join("codex");
        fs::write(&codex, "").unwrap();
        let link = root.path().join("home-link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert!(!in_codex_install(&codex, Some(&link), None));
        assert!(codex_location_trusted(&codex, Some(link.clone()), None));
        let packaged = real.join("custom/packages/standalone/bin");
        fs::create_dir_all(&packaged).unwrap();
        let managed = packaged.join("codex");
        fs::write(&managed, "").unwrap();
        let custom_link = root.path().join("codex-home-link");
        std::os::unix::fs::symlink(real.join("custom"), &custom_link).unwrap();
        assert!(codex_location_trusted(&managed, None, Some(custom_link)));
        assert!(!codex_location_trusted(
            &managed,
            None,
            Some(PathBuf::from("custom"))
        ));
    }

    #[test]
    fn a_codex_under_a_custom_mise_data_dir_matches() {
        let root = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(root.path()).unwrap();
        let data = root.join("mise-data");
        let bin = data.join("installs/npm-openai-codex/0.171.0/bin");
        fs::create_dir_all(&bin).unwrap();
        assert!(in_mise_installs(&bin.join("codex"), &data));
        assert!(!in_mise_installs(&root.join("elsewhere/codex"), &data));
        assert!(!in_mise_installs(&data.join("shims/codex"), &data));
    }

    #[test]
    fn a_dot_codex_that_links_elsewhere_still_matches() {
        let root = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(root.path()).unwrap();
        let home = root.join("home");
        let data = root.join("codex-data/packages/app-server-daemon/releases/1/bin");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&data).unwrap();
        let codex = data.join("codex");
        fs::write(&codex, "").unwrap();
        std::os::unix::fs::symlink(root.join("codex-data"), home.join(".codex")).unwrap();
        assert!(codex_location_trusted(&codex, Some(home.clone()), None));
        // Only its packages and binary, not anything under it.
        let other = root.join("codex-data/sessions");
        fs::create_dir_all(&other).unwrap();
        let stray = other.join("codex");
        fs::write(&stray, "").unwrap();
        assert!(!codex_location_trusted(&stray, Some(home), None));
    }

    #[test]
    fn codex_is_trusted_only_where_its_installers_put_it() {
        let home = Some(Path::new("/home/me"));
        for trusted in [
            "/usr/bin/codex",
            "/usr/local/bin/codex",
            "/usr/lib/node_modules/@openai/codex/vendor/x86_64-unknown-linux-musl/codex/codex",
            "/opt/codex/bin/codex",
            "/home/me/.codex/packages/app-server-daemon/releases/0.171.0-x86_64-unknown-linux-musl/bin/codex",
            "/home/me/.local/share/mise/installs/codex/0.154.0/bin/codex",
            "/home/me/.nvm/versions/node/v22.1.0/lib/node_modules/@openai/codex/vendor/x/codex/codex",
            "/home/me/.npm/_npx/0123abcd/node_modules/@openai/codex/vendor/x/codex/codex",
            "/home/me/.cargo/bin/codex",
            "/home/me/.local/bin/codex",
        ] {
            assert!(in_codex_install(Path::new(trusted), home, None), "{trusted}");
        }
        for untrusted in [
            "/tmp/codex",
            "/tmp/x/node_modules/@openai/codex/codex",
            "/dev/shm/codex",
            "/home/me/codex",
            "/home/me/project/codex",
            "/home/me/.local/bin/sub/codex",
            "/home/me/.cargo/bin/codex/codex",
            "/home/other/.cargo/bin/codex",
            "/optional/codex",
            "/usr/bin/../../tmp/codex",
            "codex",
        ] {
            assert!(
                !in_codex_install(Path::new(untrusted), home, None),
                "{untrusted}"
            );
        }
        // Without a home, only the system folders.
        assert!(in_codex_install(
            Path::new("/usr/local/bin/codex"),
            None,
            None
        ));
        assert!(!in_codex_install(
            Path::new("/home/me/.cargo/bin/codex"),
            None,
            None
        ));
        assert!(!in_codex_install(
            Path::new("/home/me/.cargo/bin/codex"),
            Some(Path::new("relative")),
            None
        ));
        // A custom CODEX_HOME's own packages and binary, and nothing else
        // there.
        let custom = Some(Path::new("/srv/codex-home"));
        assert!(in_codex_install(
            Path::new("/srv/codex-home/packages/app-server-daemon/releases/1/bin/codex"),
            None,
            custom
        ));
        assert!(in_codex_install(
            Path::new("/srv/codex-home/bin/codex"),
            None,
            custom
        ));
        assert!(!in_codex_install(
            Path::new("/srv/codex-home/sessions/codex"),
            None,
            custom
        ));
        assert!(!in_codex_install(
            Path::new("/srv/codex-home/packages/app-server-daemon/releases/1/bin/codex"),
            None,
            Some(Path::new("relative"))
        ));
    }

    #[test]
    fn cursor_is_trusted_only_where_its_packages_install_it() {
        let appimage = "812 30 0:77 / /tmp/.mount_CursorAb12Cd ro,nosuid,nodev - fuse.Cursor-1.7.0-x86_64.AppImage Cursor-1.7.0-x86_64.AppImage ro\n\
                        813 30 0:78 / /tmp/.mount_sleepXy ro - fuse.sleep sleep ro\n\
                        814 30 8:1 / /tmp/.mount_Cursorfake rw - ext4 /dev/sda1 rw\n";
        assert!(in_cursor_install(Path::new("/usr/share/cursor/cursor"), ""));
        assert!(in_cursor_install(Path::new("/opt/Cursor/cursor"), ""));
        assert!(in_cursor_install(
            Path::new("/tmp/.mount_CursorAb12Cd/usr/share/cursor/cursor"),
            appimage
        ));
        assert!(!in_cursor_install(Path::new("/tmp/cursor"), appimage));
        assert!(!in_cursor_install(
            Path::new("/home/me/bin/cursor"),
            appimage
        ));
        assert!(!in_cursor_install(
            Path::new("/usr/share/cursorfake/cursor"),
            ""
        ));
        // Not a Cursor AppImage, not a FUSE mount, or not mounted at all.
        assert!(!in_cursor_install(
            Path::new("/tmp/.mount_sleepXy/cursor"),
            appimage
        ));
        assert!(!in_cursor_install(
            Path::new("/tmp/.mount_Cursorfake/cursor"),
            appimage
        ));
        assert!(!in_cursor_install(
            Path::new("/tmp/.mount_CursorZz/cursor"),
            appimage
        ));
    }
}
