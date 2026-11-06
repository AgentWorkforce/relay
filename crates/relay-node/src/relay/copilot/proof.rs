//! VS Code's bundled Copilot SDK runtime and the native session descriptors it
//! actually holds. A PID filename alone is never evidence of a live session.
use super::CopilotConfig;
use crate::relay::process::{file_birth_ns, ProcessInfo, ProcessTable};
use crate::relay::store::is_uuid;
use std::path::{Path, PathBuf};

/// macOS currently supplies the installed Microsoft signature proof. Other
/// platforms report messaging unavailable while still allowing MCP setup.
pub const SUPPORTED: bool = cfg!(target_os = "macos");

fn contents(path: &Path) -> Option<PathBuf> {
    path.ancestors()
        .find(|p| p.file_name().is_some_and(|n| n == "Contents"))
        .filter(|p| {
            p.parent()
                .is_some_and(|p| p.file_name().is_some_and(|n| n == "Visual Studio Code.app"))
        })
        .map(Path::to_path_buf)
}

/// A trusted native runtime under VS Code's own utility host and main process.
/// CLI copies, Node scripts, extension tools and recycled PIDs do not pass.
pub fn runtime(table: &dyn ProcessTable, pid: i32, uid: u32) -> Option<ProcessInfo> {
    let process = table.process(pid)?;
    if process.uid != uid || table.zombie(pid) {
        return None;
    }
    let exe = table.executable(pid)?;
    let root = contents(&exe)?;
    let relative = exe
        .strip_prefix(root.join("Resources/app/node_modules.asar.unpacked/@github"))
        .ok()?;
    let parts: Vec<_> = relative.iter().map(|s| s.to_string_lossy()).collect();
    if parts.len() != 4
        || !parts[0].starts_with("copilot-sdk-darwin-")
        || parts[1] != "prebuilds"
        || !parts[2].starts_with("darwin-")
        || parts[3] != "copilot-runtime"
    {
        return None;
    }
    trusted_runtime(table, process, &exe, &root)
}

fn trusted_runtime(
    table: &dyn ProcessTable,
    process: ProcessInfo,
    exe: &Path,
    root: &Path,
) -> Option<ProcessInfo> {
    let args = table.arguments(process.pid);
    if !args.iter().any(|a| a == "--headless")
        || !args.iter().any(|a| a == "--stdio")
        || args.iter().any(|a| a.starts_with("--inspect"))
        || !table.is_trusted_vscode(process.pid, exe)
    {
        return None;
    }
    let host = table.process(process.parent)?;
    let host_exe = table.executable(host.pid)?;
    if host.uid != process.uid
        || host_exe != root.join("Frameworks/Code Helper.app/Contents/MacOS/Code Helper")
        || !table.is_trusted_vscode(host.pid, &host_exe)
        || !table
            .arguments(host.pid)
            .iter()
            .any(|a| a == "--type=utility")
    {
        return None;
    }
    let main = trusted_main(table, host.parent, process.uid, root)?;
    (table.process(main.pid) == Some(main)
        && table.process(host.pid) == Some(host)
        && table.process(process.pid) == Some(process))
    .then_some(process)
}

fn trusted_main(table: &dyn ProcessTable, pid: i32, uid: u32, root: &Path) -> Option<ProcessInfo> {
    let main = table.process(pid)?;
    let main_exe = table.executable(main.pid)?;
    if main.uid != uid
        || main_exe != root.join("MacOS/Code")
        || !table.is_trusted_vscode(main.pid, &main_exe)
        || !table.environment_readable(main.pid)
        || table
            .environment_var(main.pid, "ELECTRON_RUN_AS_NODE")
            .is_some()
        || table.arguments(main.pid).iter().any(|a| {
            a.starts_with("--type=")
                || a.starts_with("--inspect")
                || a.starts_with("--remote-debugging")
        })
    {
        return None;
    }
    table
        .is_trusted_vscode_bundle(root.parent()?)
        .then_some(main)
}

/// Native IDs from descriptors, with the current directory entry's inode birth
/// checked against the open inode. A copied path or replaced hold is rejected.
pub fn held(config: &CopilotConfig, table: &dyn ProcessTable, pid: i32, uid: u32) -> Vec<String> {
    let Some(process) = runtime(table, pid, uid) else {
        return Vec::new();
    };
    let roots = [
        config.sessions(),
        std::fs::canonicalize(config.sessions()).unwrap_or_else(|_| config.sessions()),
    ];
    let filename = format!("inuse.{pid}.hold");
    let mut sessions = Vec::new();
    for file in table.opened_files(pid) {
        if file.path.file_name().is_none_or(|n| n != filename.as_str()) {
            continue;
        }
        let Some(dir) = file.path.parent() else {
            continue;
        };
        let Some(sid) = dir
            .file_name()
            .and_then(|s| s.to_str())
            .filter(|s| is_uuid(s))
        else {
            continue;
        };
        if !roots
            .iter()
            .any(|root| dir.parent() == Some(root.as_path()))
        {
            continue;
        }
        if file.birth_ns.is_some() && file.birth_ns == file_birth_ns(&file.path) {
            sessions.push(sid.to_owned());
        }
    }
    sessions.sort();
    sessions.dedup();
    if table.process(pid) == Some(process) && !table.zombie(pid) {
        sessions
    } else {
        Vec::new()
    }
}

/// The hook executable must be the runtime's direct child. Ordinary tool shells
/// and an MCP process multiplexing several sessions cannot name a caller.
pub fn hook_holds(
    config: &CopilotConfig,
    table: &dyn ProcessTable,
    pid: i32,
    uid: u32,
    sid: &str,
) -> bool {
    let Some(hook) = table.process(pid).filter(|p| p.uid == uid) else {
        return false;
    };
    held(config, table, hook.parent, uid)
        .iter()
        .any(|id| id == sid)
        && table.process(pid) == Some(hook)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::relay::process::{FakeProcess, FakeProcesses, OpenedFile};
    const SID: &str = "1069773c-0824-4fad-b7f9-d3dc3c4ed148";
    const ROOT: &str = "/Applications/Visual Studio Code.app/Contents";
    pub(crate) fn fixture() -> (tempfile::TempDir, CopilotConfig, FakeProcesses, PathBuf) {
        let home = tempfile::tempdir().unwrap();
        let config = CopilotConfig::from_env(&|_| None, home.path());
        let lock = config.sessions().join(SID).join("inuse.102.hold");
        std::fs::create_dir_all(lock.parent().unwrap()).unwrap();
        std::fs::write(&lock, "").unwrap();
        let table = FakeProcesses::default();
        table
            .trusted_vscode_bundles
            .lock()
            .unwrap()
            .insert(Path::new(ROOT).parent().unwrap().into());
        table
            .trusted_relay_helpers
            .lock()
            .unwrap()
            .insert("/opt/agent-relay-desktop-probe".into());
        for (pid, parent, suffix, args) in [
            (100, 1, "MacOS/Code", vec![]),
            (101, 100, "Frameworks/Code Helper.app/Contents/MacOS/Code Helper", vec!["--type=utility"]),
            (102, 101, "Resources/app/node_modules.asar.unpacked/@github/copilot-sdk-darwin-arm64/prebuilds/darwin-arm64/copilot-runtime", vec!["--headless", "--stdio"]),
        ] {
            let executable = Path::new(ROOT).join(suffix);
            table.trusted_vscode.lock().unwrap().insert(executable.clone());
            table.insert(pid, FakeProcess { parent, uid: 501, start: pid as u64, executable: Some(executable), arguments: args.into_iter().map(str::to_owned).collect(), ..Default::default() });
        }
        table
            .processes
            .lock()
            .unwrap()
            .get_mut(&102)
            .unwrap()
            .open_files
            .push(lock.clone());
        table.insert(
            103,
            FakeProcess {
                parent: 102,
                uid: 501,
                start: 103,
                ..Default::default()
            },
        );
        (home, config, table, lock)
    }
    #[test]
    fn native_held_descriptor_proves_exact_session_only_to_direct_hook() {
        let (_home, config, table, _) = fixture();
        assert_eq!(held(&config, &table, 102, 501), [SID]);
        assert!(hook_holds(&config, &table, 103, 501, SID));
        assert!(!hook_holds(&config, &table, 103, 999, SID));
        assert!(!hook_holds(
            &config,
            &table,
            103,
            501,
            "69e50b90-b873-4de0-a36d-c9152a45e772"
        ));
        table.insert(
            104,
            FakeProcess {
                parent: 103,
                uid: 501,
                start: 104,
                ..Default::default()
            },
        );
        assert!(!hook_holds(&config, &table, 104, 501, SID));
    }
    #[test]
    fn a_named_lock_or_replaced_inode_is_not_a_live_hold() {
        let (_home, config, table, lock) = fixture();
        let old_birth = file_birth_ns(&lock).unwrap();
        table
            .processes
            .lock()
            .unwrap()
            .get_mut(&102)
            .unwrap()
            .opened_files = Some(vec![OpenedFile {
            path: lock.clone(),
            birth_ns: Some(old_birth - 1),
        }]);
        assert!(held(&config, &table, 102, 501).is_empty());
        table
            .processes
            .lock()
            .unwrap()
            .get_mut(&102)
            .unwrap()
            .opened_files = None;
        table
            .processes
            .lock()
            .unwrap()
            .get_mut(&102)
            .unwrap()
            .open_files
            .clear();
        assert!(lock.exists());
        assert!(held(&config, &table, 102, 501).is_empty());
    }
    #[test]
    fn a_signed_executable_with_an_invalid_enclosing_bundle_is_rejected() {
        let (_home, config, table, _) = fixture();
        table.trusted_vscode_bundles.lock().unwrap().clear();
        assert!(held(&config, &table, 102, 501).is_empty());
    }
    #[test]
    fn unsigned_runtime_or_node_parent_is_rejected() {
        let (_home, config, table, _) = fixture();
        table
            .processes
            .lock()
            .unwrap()
            .get_mut(&100)
            .unwrap()
            .environment
            .insert("ELECTRON_RUN_AS_NODE".into(), "1".into());
        assert!(held(&config, &table, 102, 501).is_empty());
        table
            .processes
            .lock()
            .unwrap()
            .get_mut(&100)
            .unwrap()
            .environment
            .clear();
        table.trusted_vscode.lock().unwrap().clear();
        assert!(held(&config, &table, 102, 501).is_empty());
    }
}

#[cfg(all(test, target_os = "macos"))]
#[test]
#[ignore = "manual live VS Code runtime proof; pass RELAY_COPILOT_PROOF_PID"]
fn live_installed_vscode_runtime_holds_native_sessions() {
    let pid = std::env::var("RELAY_COPILOT_PROOF_PID")
        .unwrap()
        .parse()
        .unwrap();
    let home = crate::relay::paths::home().unwrap();
    let config = CopilotConfig::from_env(&|_| None, &home);
    let table = crate::relay::process::SystemProcesses::default();
    assert!(!held(&config, &table, pid, crate::relay::peer::current_uid()).is_empty());
}
