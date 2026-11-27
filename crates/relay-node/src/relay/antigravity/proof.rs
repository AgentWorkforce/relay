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

/// The Antigravity `language_server` that directly invoked a managed command
/// hook process `pid` (our managed hook uses `exec`, so `sh` replaces itself
/// with the helper and `language_server` is its direct parent). Allowing a
/// shell parent would let a `run_command` pipeline invoke the helper and forge
/// another conversation's hook payload.
pub fn hook_runtime(table: &dyn ProcessTable, pid: i32, uid: u32) -> Option<ProcessInfo> {
    let hook = table
        .process(pid)
        .filter(|p| p.uid == uid && !table.zombie(p.pid))?;
    let rt = runtime(table, hook.parent, uid)?;
    (table.process(pid) == Some(hook)).then_some(rt)
}

/// Confirm the hook process environment and working directory match an
/// Antigravity `hooks.json` invocation rather than an agent `run_command` tool
/// invocation:
/// - the helper's environment must be readable (it is not an Apple SIP binary)
/// - `ANTIGRAVITY_SOURCE_METADATA` (set on `run_command` tool shells) must be
///   absent
/// - if `ANTIGRAVITY_CONVERSATION_ID` is present, it must match `sid`
/// - the hook's working directory must be `config.config_dir` (`hooks.json`
///   always executes with CWD set to the directory containing `hooks.json`)
pub fn hook_environment_ok(
    config: &AntigravityConfig,
    table: &dyn ProcessTable,
    pid: i32,
    sid: &str,
) -> bool {
    if !table.environment_readable(pid) {
        return false;
    }
    if table
        .environment_var(pid, "ANTIGRAVITY_SOURCE_METADATA")
        .is_some()
    {
        return false;
    }
    if let Some(tagged) = table.environment_var(pid, "ANTIGRAVITY_CONVERSATION_ID") {
        if tagged.trim() != sid {
            return false;
        }
    }
    let Some(cwd) = table.cwd(pid) else {
        return false;
    };
    let expected =
        std::fs::canonicalize(&config.config_dir).unwrap_or_else(|_| config.config_dir.clone());
    let actual = std::fs::canonicalize(&cwd).unwrap_or(cwd);
    actual == expected
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
    hook_environment_ok(config, table, pid, sid)
        && held(config, table, rt.pid, uid).iter().any(|id| id == sid)
        && table.process(rt.pid) == Some(rt)
}
