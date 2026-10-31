//! Claude Code's `/clear`: a new conversation in the same process.
//!
//! `/clear` keeps the process, its pid, its inbox socket and its name, and
//! rewrites `<pid>.json` with a new session id. The registry then no longer
//! names the old conversation, so the process it ran in is remembered
//! here, and the new conversation's transcript, which opens with the
//! command, says when it happened.

use super::{terminal_sessions, transcript, ClaudeConfig, TerminalSession};
use crate::relay::process::{ProcessInfo, ProcessTable, StartClock};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

/// How long before a conversation was last seen running its process may
/// already have cleared it: the registry read that saw it can end after.
const SEEN_SLACK_MS: i64 = 2_000;

/// How many conversations `remember_processes` keeps.
const PROCESSES_KEPT: usize = 4_096;

/// The process each conversation was last seen running in: its pid and
/// recorded start, and when it was seen there. Claude Code's `/clear` starts a new conversation in the
/// same process and rewrites `<pid>.json` with the new id, so after it this
/// is what ties the old id to that process (`cleared`).
fn processes() -> &'static Mutex<HashMap<String, (i32, String, i64)>> {
    static SEEN: OnceLock<Mutex<HashMap<String, (i32, String, i64)>>> = OnceLock::new();
    SEEN.get_or_init(Default::default)
}

pub(super) fn remember_processes(sessions: &[TerminalSession]) {
    let now = crate::relay::state::now_ms();
    let mut seen = processes().lock().unwrap_or_else(|e| e.into_inner());
    for session in sessions {
        let Some(start) = &session.proc_start else {
            continue;
        };
        if seen.len() >= PROCESSES_KEPT && !seen.contains_key(&session.session_id) {
            seen.clear();
        }
        seen.insert(
            session.session_id.clone(),
            (session.pid, start.clone(), now),
        );
    }
}

/// A conversation Claude Code's `/clear` replaced: the conversation now
/// running in the process that ran it, and when it was cleared.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Cleared {
    pub session_id: String,
    pub at_ms: i64,
}

/// What replaced `session_id`, when it no longer runs because `/clear`
/// started a new conversation in its process: the same pid and recorded
/// start now run another session id, whose transcript opens with the
/// `/clear` command, run after `session_id` was last seen running there. A
/// process that ended, a pid recycled by another process, or `/resume` into
/// a conversation (even one that began with an earlier `/clear`) is not a
/// clear.
pub fn cleared(
    config: &ClaudeConfig,
    table: &dyn ProcessTable,
    session_id: &str,
) -> Option<Cleared> {
    let sessions = terminal_sessions(config, table);
    if sessions.iter().any(|s| s.session_id == session_id) {
        return None;
    }
    let (pid, start, seen_ms) = processes()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(session_id)
        .cloned()?;
    let now = sessions
        .into_iter()
        .find(|s| s.pid == pid && s.proc_start.as_deref() == Some(start.as_str()))?;
    let (path, _) = transcript::path(config, table, &now.session_id)?;
    let at_ms = transcript::cleared_at(&path)?;
    // The registry read that saw it may have finished just after the clear.
    if at_ms < seen_ms - SEEN_SLACK_MS {
        return None;
    }
    Some(Cleared {
        session_id: now.session_id,
        at_ms,
    })
}

/// Whether `child`, a process the running session `session` started,
/// started before `/clear` began that session's conversation: it belongs to
/// the conversation that was cleared, not this one.
pub fn started_before_clear(
    config: &ClaudeConfig,
    table: &dyn ProcessTable,
    session: &TerminalSession,
    child: &ProcessInfo,
) -> bool {
    let Some(started) = start_epoch_ms(table.start_clock(), child) else {
        return false;
    };
    transcript::path(config, table, &session.session_id)
        .and_then(|(path, _)| transcript::cleared_at(&path))
        .is_some_and(|cleared| started < cleared)
}

/// When `process` started, in milliseconds since the epoch. Linux counts
/// clock ticks since boot, read against the boot time in `/proc/stat`;
/// `None` where that cannot be read.
fn start_epoch_ms(clock: StartClock, process: &ProcessInfo) -> Option<i64> {
    match clock {
        StartClock::Micros | StartClock::Windows => i64::try_from(process.start / 1_000).ok(),
        StartClock::Ticks => linux_boot_ms_and_tick_rate().and_then(|(boot_ms, ticks)| {
            let since_boot = i64::try_from(process.start.checked_mul(1_000)? / ticks).ok()?;
            boot_ms.checked_add(since_boot)
        }),
    }
}

/// The boot time in milliseconds since the epoch, on Linux. Its process
/// start times count `USER_HZ` ticks, which Linux fixes at 100 a second.
#[cfg(target_os = "linux")]
fn linux_boot_ms_and_tick_rate() -> Option<(i64, u64)> {
    let stat = std::fs::read_to_string("/proc/stat").ok()?;
    let boot: i64 = stat
        .lines()
        .find_map(|line| line.strip_prefix("btime "))?
        .trim()
        .parse()
        .ok()?;
    Some((boot.saturating_mul(1_000), 100))
}

#[cfg(not(target_os = "linux"))]
fn linux_boot_ms_and_tick_rate() -> Option<(i64, u64)> {
    None
}
