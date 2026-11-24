//! Pi and Oh My Pi callers. Agent Relay's extension holds its session's
//! private registry, `<runtime>/<instance>/session.json`, open in the harness
//! process for as long as the session is bound, and the harness's tools run
//! as that process's descendants. So, like a Devin lock, the file the nearest
//! such process holds names the caller.
use super::*;
use crate::relay::process::ProcessInfo;

/// Whether `pid` is a process of this user's that holds an extension
/// registry of either flavor open: a Pi or Oh My Pi harness running Agent
/// Relay's extension, whatever it can prove.
pub(super) fn is_holder(config: &LocalConfig, table: &dyn ProcessTable, pid: i32) -> bool {
    let open = table.open_files(pid);
    [&config.pi, &config.omp]
        .iter()
        .any(|extension| crate::relay::pi::holds_registry(extension, &open))
}

/// The caller, when the walk up from it reaches `current`, a process of this
/// user's holding an extension registry open: the one session that process
/// is the proven live holder of, in its own flavor's runtime, or nobody. A
/// holder proving no binding (its flavor off, its registry stale or
/// another's, a session two processes claim) or several never lends a caller
/// an outer session's identity. `None` lets the walk go on.
///
/// A Pi or Oh My Pi without the extension holds no registry and is passed
/// like any other program: nothing the kernel shows tells it from a script,
/// and no Agent Relay session runs in it.
pub(super) fn caller(
    config: &LocalConfig,
    table: &dyn ProcessTable,
    current: i32,
    process: ProcessInfo,
) -> Option<Result<Target, CallerMiss>> {
    if process.uid != config.uid || !is_holder(config, table, current) {
        return None;
    }
    let mut found: Vec<Target> = [&config.pi, &config.omp]
        .into_iter()
        .flat_map(|extension| {
            crate::relay::pi::held_by(extension, table, config.uid, process)
                .into_iter()
                .map(|binding| Target::new(extension.flavor.kind(), binding.session_id()))
        })
        .collect();
    // Still the same process after its files were read.
    let same = table.process(current) == Some(process);
    Some(match found.len() {
        1 if same => Ok(found.remove(0)),
        _ => Err(CallerMiss::Unattributed),
    })
}
