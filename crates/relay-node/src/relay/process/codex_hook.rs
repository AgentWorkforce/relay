//! Hook authorization independent of inherited session environment. A consuming
//! hook must name the active turn of a rollout its trusted ancestor holds.

use super::*;

/// Capture the trusted writer ancestry, rejecting a separately established
/// caller thread that contradicts the requested target. A missing caller id
/// remains eligible for the independent held-rollout/active-turn proof.
fn writer_chain(
    table: &dyn ProcessTable,
    pid: i32,
    uid: u32,
    thread: &str,
) -> Option<Vec<ProcessInfo>> {
    if codex_caller_thread(table, pid, uid)
        .is_some_and(|caller| !caller.eq_ignore_ascii_case(thread))
    {
        return None;
    }
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
            return has_codex_writer_for_caller(table, pid, uid, thread).then_some(chain);
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

/// Read only a locally resolved rollout, while the same trusted writer holds
/// its inode and requested thread lock on both sides of the read. Neither a
/// hook-supplied transcript path nor ambient THREAD/SESSION ids authorize it.
pub(crate) fn with_codex_hook_rollout(
    table: &dyn ProcessTable,
    pid: i32,
    uid: u32,
    thread: &str,
    rollout: &Path,
    read: impl FnOnce() -> bool,
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
        && read()
        && file_birth_ns(&path) == Some(birth)
        && holds_rollout(table, writer.pid, &path, birth)
        && has_codex_writer_for_caller(table, pid, uid, thread)
        && unchanged(table, &chain)
}
