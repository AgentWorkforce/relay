//! OpenIDEA starts a stdio Codex app-server for each task, stopping it
//! after the task has been idle and resuming its thread on the next turn.
//! The app-server's writer locks, not the host alone, identify live threads.

use crate::relay::process::{ProcessTable, MAX_ANCESTRY};
use std::path::Path;

/// OpenIDEA's executable on this platform, as reported by the kernel.
/// Windows executable names are case-insensitive; macOS uses the bundle
/// path and Linux the installed executable's name.
pub fn is_app(executable: &Path) -> bool {
    if cfg!(target_os = "macos") {
        return executable.ends_with("OpenIDEA.app/Contents/MacOS/openidea");
    }
    let Some(name) = executable.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    if cfg!(windows) {
        name.eq_ignore_ascii_case("openidea.exe")
    } else {
        name == "openidea"
    }
}

/// Whether this user's OpenIDEA started `pid`, possibly through a launcher.
/// Another Codex between the candidate and the app means the candidate was
/// started by that chat's tools, rather than by OpenIDEA. Missing processes,
/// another user, and an ancestry that cannot be resolved all fail closed.
pub fn under_app(table: &dyn ProcessTable, uid: u32, pid: i32) -> bool {
    let mut current = pid;
    for _ in 0..MAX_ANCESTRY {
        let Some(process) = table.process(current).filter(|p| p.uid == uid) else {
            return false;
        };
        if current != pid {
            if let Some(executable) = table.executable(current) {
                if is_app(&executable) {
                    return true;
                }
                if table.is_trusted_codex(&executable) {
                    return false;
                }
            }
        }
        if process.parent <= 1 {
            return false;
        }
        current = process.parent;
    }
    false
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::relay::process::{FakeProcess, FakeProcesses};
    use std::path::PathBuf;

    pub fn app() -> PathBuf {
        if cfg!(target_os = "macos") {
            "/Applications/OpenIDEA.app/Contents/MacOS/openidea".into()
        } else if cfg!(windows) {
            r"C:\Program Files\OpenIDEA\openidea.exe".into()
        } else {
            "/opt/openidea/openidea".into()
        }
    }

    #[test]
    fn the_platform_executable_names_the_host() {
        assert!(is_app(&app()));
        assert!(!is_app(Path::new("/tmp/not-openidea")));
        assert!(!is_app(&app().join("helper")));
        assert!(!is_app(Path::new("/")));
        #[cfg(target_os = "macos")]
        {
            assert!(is_app(Path::new(
                "/Users/me/Applications/OpenIDEA.app/Contents/MacOS/openidea"
            )));
            assert!(!is_app(Path::new("/usr/local/bin/openidea")));
            assert!(!is_app(Path::new(
                "/Applications/Other.app/Contents/MacOS/openidea"
            )));
        }
        #[cfg(windows)]
        {
            assert!(is_app(Path::new(r"C:\Apps\OpenIDEA\OpenIDEA.EXE")));
            assert!(is_app(Path::new("C:/Apps/OpenIDEA/openidea.exe")));
            assert!(!is_app(Path::new(r"C:\Apps\openidea.exe.backup")));
        }
        #[cfg(not(any(target_os = "macos", windows)))]
        {
            assert!(is_app(Path::new("/usr/bin/openidea")));
            assert!(!is_app(Path::new("/usr/bin/OpenIDEA")));
            assert!(!is_app(Path::new("/usr/bin/openidea.exe")));
        }
    }

    #[test]
    fn ancestry_requires_this_users_host_without_an_intervening_codex() {
        let table = FakeProcesses::default();
        let process = |parent, uid, executable| FakeProcess {
            parent,
            uid,
            start: 1,
            executable,
            ..FakeProcess::default()
        };
        table.insert(10, process(1, 501, Some(app())));
        table.insert(20, process(10, 501, Some("/bin/sh".into())));
        table.insert(30, process(20, 501, Some("/opt/codex".into())));
        assert!(under_app(&table, 501, 30));
        assert!(!under_app(&table, 501, 10), "not its own ancestor");
        assert!(!under_app(&table, 502, 30));
        table.insert(10, process(1, 502, Some(app())));
        assert!(!under_app(&table, 501, 30), "another user's host");
        table.insert(10, process(1, 501, Some(app())));
        table.trust("/opt/codex");
        table.insert(40, process(30, 501, Some("/bin/sh".into())));
        table.insert(50, process(40, 501, Some("/opt/codex".into())));
        assert!(!under_app(&table, 501, 50), "a nested tool run");
        table.remove(20);
        assert!(!under_app(&table, 501, 30), "an unreadable ancestor");
        table.insert(20, process(30, 501, None));
        assert!(!under_app(&table, 501, 30), "an ancestry cycle");
    }
}
