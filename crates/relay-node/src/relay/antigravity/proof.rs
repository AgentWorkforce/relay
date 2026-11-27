//! Antigravity's bundled `language_server` runtime and the open conversation
//! databases (`conversations/<uuid>.db`) it holds in the kernel.
use super::AntigravityConfig;
use crate::relay::process::{file_birth_ns, ProcessInfo, ProcessTable};
use crate::relay::store::is_uuid;
use std::path::{Path, PathBuf};

/// macOS currently supplies Google's installed code-signature proof.
pub const SUPPORTED: bool = cfg!(target_os = "macos");

fn contents(path: &Path) -> Option<PathBuf> {
    path.ancestors()
        .find(|p| p.file_name().is_some_and(|n| n == "Contents"))
        .filter(|p| {
            p.parent()
                .is_some_and(|p| p.file_name().is_some_and(|n| n == "Antigravity.app"))
        })
        .map(Path::to_path_buf)
}

/// Whether `pid` is a trusted Antigravity `language_server` running under
/// Antigravity's own signed desktop bundle.
pub fn runtime(table: &dyn ProcessTable, pid: i32, uid: u32) -> Option<ProcessInfo> {
    let process = table.process(pid)?;
    if process.uid != uid || table.zombie(pid) {
        return None;
    }
    let exe = table.executable(pid)?;
    let root = contents(&exe)?;
    if exe != root.join("Resources/bin/language_server") {
        return None;
    }
    let args = table.arguments(pid);
    let named_antigravity = args.windows(2).any(|pair| {
        (pair[0] == "--override_ide_name" && pair[1] == "antigravity")
            || (pair[0] == "--app_data_dir" && pair[1].starts_with("antigravity"))
    });
    if !named_antigravity
        || args.iter().any(|a| a.starts_with("--inspect"))
        || !table.is_trusted_antigravity(pid, &exe)
    {
        return None;
    }
    let main = trusted_main(table, process.parent, uid, &root)?;
    (table.process(main.pid) == Some(main) && table.process(process.pid) == Some(process))
        .then_some(process)
}

fn trusted_main(table: &dyn ProcessTable, pid: i32, uid: u32, root: &Path) -> Option<ProcessInfo> {
    let main = table.process(pid)?;
    let main_exe = table.executable(main.pid)?;
    if main.uid != uid
        || main_exe != root.join("MacOS/Antigravity")
        || !table.is_trusted_antigravity(main.pid, &main_exe)
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
        .is_trusted_antigravity_bundle(root.parent()?)
        .then_some(main)
}

pub fn is_antigravity_process(table: &dyn ProcessTable, pid: i32, uid: u32) -> bool {
    runtime(table, pid, uid).is_some()
}

/// Conversation UUIDs whose `<conversations>/<uuid>.db` file `pid` holds open,
/// verified against the current directory entry's inode birth time.
pub fn held(
    config: &AntigravityConfig,
    table: &dyn ProcessTable,
    pid: i32,
    uid: u32,
) -> Vec<String> {
    let Some(_) = runtime(table, pid, uid) else {
        return Vec::new();
    };
    let conv_dir = config.conversations();
    let roots = [
        conv_dir.clone(),
        std::fs::canonicalize(&conv_dir).unwrap_or(conv_dir),
    ];
    let mut sessions = Vec::new();
    for file in table.opened_files(pid) {
        let Some(name) = file.path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let Some(sid) = name.strip_suffix(".db").filter(|s| is_uuid(s)) else {
            continue;
        };
        if !roots
            .iter()
            .any(|root| file.path.parent() == Some(root.as_path()))
        {
            continue;
        }
        if file.birth_ns.is_some() && file.birth_ns == file_birth_ns(&file.path) {
            sessions.push(sid.to_owned());
        }
    }
    sessions.sort();
    sessions.dedup();
    sessions
}

/// The Antigravity `language_server` that invoked a command hook process `pid`
/// (either directly via `exec`, or through the `sh -c` shell Antigravity spawns).
pub fn hook_runtime(table: &dyn ProcessTable, pid: i32, uid: u32) -> Option<ProcessInfo> {
    let hook = table.process(pid).filter(|p| p.uid == uid)?;
    if let Some(rt) = runtime(table, hook.parent, uid) {
        return Some(rt);
    }
    let shell = table
        .process(hook.parent)
        .filter(|p| p.uid == uid && !table.zombie(p.pid))?;
    let shell_name = table
        .executable(shell.pid)
        .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))?;
    if !matches!(shell_name.as_str(), "sh" | "zsh" | "bash" | "dash") {
        return None;
    }
    let rt = runtime(table, shell.parent, uid)?;
    (table.process(shell.pid) == Some(shell)).then_some(rt)
}

pub fn hook_holds(
    config: &AntigravityConfig,
    table: &dyn ProcessTable,
    pid: i32,
    uid: u32,
    sid: &str,
) -> bool {
    let Some(rt) = hook_runtime(table, pid, uid) else {
        return false;
    };
    held(config, table, rt.pid, uid).iter().any(|id| id == sid) && table.process(rt.pid) == Some(rt)
}
