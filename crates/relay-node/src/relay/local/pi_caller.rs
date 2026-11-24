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
///
/// `below` is the walk's previous step, the holder's child the caller runs
/// under. One that started before the binding's registry was written began
/// under an earlier session of the same harness (before `/new`, `/resume`
/// or a reload), so it is nobody rather than the session open now, as a
/// Claude Code tool started before `/clear` is.
pub(super) fn caller(
    config: &LocalConfig,
    table: &dyn ProcessTable,
    current: i32,
    process: ProcessInfo,
    below: Option<&ProcessInfo>,
) -> Option<Result<Target, CallerMiss>> {
    if process.uid != config.uid || !is_holder(config, table, current) {
        return None;
    }
    let mut found: Vec<Target> = [&config.pi, &config.omp]
        .into_iter()
        .flat_map(|extension| {
            crate::relay::pi::held_by(extension, table, config.uid, process)
                .into_iter()
                .filter(|binding| !below.is_some_and(|child| started_before(table, child, binding)))
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

/// Whether `child` started before `binding`'s registry was written. A start
/// or write time that cannot be read decides nothing, as for `/clear`.
fn started_before(
    table: &dyn ProcessTable,
    child: &ProcessInfo,
    binding: &crate::relay::pi::Binding,
) -> bool {
    let Some(started) = crate::relay::claude::clear::start_epoch_ms(table.start_clock(), child)
    else {
        return false;
    };
    std::fs::metadata(binding.directory.join("session.json"))
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|written| written.duration_since(std::time::UNIX_EPOCH).ok())
        .and_then(|written| i64::try_from(written.as_millis()).ok())
        .is_some_and(|written| started < written)
}
