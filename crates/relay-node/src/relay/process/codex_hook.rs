//! Hook authorization independent of inherited session environment. A consuming
//! hook must name the active turn of a rollout its trusted ancestor holds.

use super::*;

/// Capture the trusted writer ancestry, rejecting a separately established
/// caller thread that contradicts the requested target. An inherited ancestor
/// id needs an existing held-rollout parent-chain proof; a missing caller id
/// remains eligible for the independent held-rollout/active-turn proof.
fn writer_chain(
    table: &dyn ProcessTable,
    pid: i32,
    uid: u32,
    thread: &str,
) -> Option<Vec<ProcessInfo>> {
    let mut chain = Vec::new();
    let mut current = pid;
    for _ in 0..MAX_ANCESTRY {
        if current <= 1 {
            return None;
        }
        let process = table.process(current).filter(|p| p.uid == uid)?;
        chain.push(process);
        if table
            .executable(current)
            .is_some_and(|exe| table.is_trusted_codex(&exe))
        {
            let caller_agrees = codex_caller_thread(table, pid, uid).is_none_or(|caller| {
                caller.eq_ignore_ascii_case(thread)
                    || held_descendant_of(table, current, thread, &caller)
            });
            return (caller_agrees
                && has_codex_writer_for_caller(table, pid, uid, thread)
                && unchanged(table, &chain))
            .then_some(chain);
        }
        current = process.parent;
    }
    None
}

/// Confirm that every captured ancestor still has the same owner/start time.
fn unchanged(table: &dyn ProcessTable, chain: &[ProcessInfo]) -> bool {
    chain
        .iter()
        .all(|process| table.process(process.pid) == Some(*process))
}

/// SessionStart has no turn id. A shared multi-thread writer cannot prove
/// which chat will receive its context, even when inherited environment agrees.
pub(crate) fn has_unambiguous_codex_hook_writer(
    table: &dyn ProcessTable,
    pid: i32,
    uid: u32,
    thread: &str,
) -> bool {
    let Some(chain) = writer_chain(table, pid, uid, thread) else {
        return false;
    };
    let Some(writer) = chain.last() else {
        return false;
    };
    let locks = codex_locked_threads(table, writer.pid);
    locks.len() == 1 && locks.contains(&thread.to_lowercase()) && unchanged(table, &chain)
}

/// Match a kernel-held rollout's captured birth timestamp and canonical path.
fn holds_rollout(table: &dyn ProcessTable, writer: i32, path: &Path, birth: i128) -> bool {
    table.opened_files(writer).iter().any(|file| {
        file.birth_ns == Some(birth) && file.path.canonicalize().ok().as_deref() == Some(path)
    })
}

/// Index birth-validated rollout paths from one kernel open-file snapshot.
fn held_rollouts(files: &[OpenedFile], locked: &BTreeSet<String>) -> BTreeMap<PathBuf, i128> {
    files
        .iter()
        .filter_map(|file| {
            let thread = rollout_thread_of_path(&file.path)?;
            let birth = file.birth_ns?;
            if !locked.contains(&thread) || file_birth_ns(&file.path) != Some(birth) {
                return None;
            }
            Some((file.path.canonicalize().ok()?, birth))
        })
        .collect()
}

/// An inherited ancestor id may name a descendant hook only when the existing
/// parser proves every parent link inside this writer's held thread locks.
/// Use one kernel file snapshot before header reads and one afterward, never
/// a full OS file scan per rollout. Reverse, unrelated and stale proofs deny.
fn held_descendant_of(table: &dyn ProcessTable, writer: i32, thread: &str, ancestor: &str) -> bool {
    let before = table.opened_files(writer);
    let locked = before
        .iter()
        .filter_map(|file| codex_thread_of_lock(&file.path))
        .collect::<BTreeSet<_>>();
    let thread = thread.to_lowercase();
    let ancestor = ancestor.to_lowercase();
    if !locked.contains(&thread) || !locked.contains(&ancestor) {
        return false;
    }
    let rollouts = held_rollouts(&before, &locked);
    let paths: Vec<PathBuf> = rollouts.keys().cloned().collect();
    let proofs = open_rollout_proofs(&paths);
    if !subagent_chain_reaches(&thread, &ancestor, &locked, &proofs)
        || !proofs.contains_key(&ancestor)
    {
        return false;
    }
    let after = table.opened_files(writer);
    let after_locks = after
        .iter()
        .filter_map(|file| codex_thread_of_lock(&file.path))
        .collect::<BTreeSet<_>>();
    let after_rollouts = held_rollouts(&after, &after_locks);
    locked.is_subset(&after_locks)
        && rollouts
            .iter()
            .all(|(path, birth)| after_rollouts.get(path) == Some(birth))
}

/// Read only a locally resolved rollout, while the same trusted writer holds
/// its inode and requested thread lock on both sides of the read. Neither a
/// hook-supplied transcript path nor ambient THREAD/SESSION ids authorize it.
pub(crate) fn with_codex_hook_rollout(
    table: &dyn ProcessTable,
    pid: i32,
    uid: u32,
    thread: &str,
    rollout: &Path,
    read: impl FnOnce(&Path) -> bool,
) -> bool {
    let Some(chain) = writer_chain(table, pid, uid, thread) else {
        return false;
    };
    let Some(writer) = chain.last() else {
        return false;
    };
    let Some(path) = rollout.canonicalize().ok() else {
        return false;
    };
    if !rollout_thread_of_path(&path).is_some_and(|id| id.eq_ignore_ascii_case(thread)) {
        return false;
    }
    let Some(birth) = file_birth_ns(&path) else {
        return false;
    };
    holds_rollout(table, writer.pid, &path, birth)
        && read(&path)
        && file_birth_ns(&path) == Some(birth)
        && holds_rollout(table, writer.pid, &path, birth)
        && has_codex_writer_for_caller(table, pid, uid, thread)
        && unchanged(table, &chain)
}

#[cfg(test)]
#[path = "codex_hook/scaling.rs"]
mod scaling;
