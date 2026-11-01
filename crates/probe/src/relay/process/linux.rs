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

    fn arguments(&self, pid: i32) -> Vec<String> {
        fs::read(proc(pid).join("cmdline"))
            .map(|bytes| split_nul(&bytes))
            .unwrap_or_default()
    }

    fn environment_readable(&self, pid: i32) -> bool {
        fs::read(proc(pid).join("environ")).is_ok()
    }

    fn environment_var(&self, pid: i32, key: &str) -> Option<String> {
        let bytes = fs::read(proc(pid).join("environ")).ok()?;
        split_nul(&bytes).into_iter().find_map(|entry| {
            let (name, value) = entry.split_once('=')?;
            (name == key).then(|| value.to_string())
        })
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
