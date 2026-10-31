//! The kernel's view of this computer's processes: parent, owner and start
//! time, executable, arguments, environment, open files and working
//! directory.
//!
//! Session discovery and relay-send caller identification read processes
//! through a `ProcessTable`, so the rules are tested against a fake table
//! and no test starts a session. `SystemProcesses` reads `/proc` on Linux,
//! `libproc` / `sysctl(KERN_PROCARGS2)` on macOS, where a Codex
//! executable is trusted only with OpenAI's valid code signature, and the
//! kernel's process and handle tables plus each process's PEB on Windows
//! (`process/windows.rs`).

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::io::BufRead;
use std::path::{Path, PathBuf};

#[cfg(any(target_os = "macos", test))]
mod macos_args;
#[cfg(all(target_os = "macos", test))]
mod macos_args_bench;
#[cfg(any(target_os = "macos", test))]
mod signature_cache;

/// How far up a process tree a caller is followed.
pub const MAX_ANCESTRY: usize = 64;

#[cfg(unix)]
fn terminal_device(path: &Path) -> bool {
    let text = path.to_string_lossy();
    text.starts_with("/dev/tty") || text.starts_with("/dev/pts/")
}

#[cfg(target_os = "linux")]
fn linux_has_terminal(stdin: Option<&Path>, tty_number: Option<&str>) -> bool {
    // An inspectable fd 0 decides alone: a process can retain a controlling
    // terminal while its stdin is a pipe (`echo ... | claude`). The stat
    // fallback is only for procfs/container configurations that hide fd 0.
    match stdin {
        Some(path) => terminal_device(path),
        None => tty_number.is_some_and(|tty| tty != "0"),
    }
}

/// One process as the kernel reports it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProcessInfo {
    pub pid: i32,
    pub parent: i32,
    pub uid: u32,
    /// The kernel's start time: clock ticks since boot on Linux (field 22 of
    /// `/proc/<pid>/stat`), microseconds since the Unix epoch on macOS. Two
    /// reads of one pid with the same value are the same process.
    pub start: u64,
}

/// What a process start time counts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StartClock {
    /// Linux: clock ticks since boot. Claude Code records the same number.
    Ticks,
    /// macOS: microseconds since the epoch. Claude Code records a UTC
    /// `ctime`-style string with whole seconds.
    Micros,
    /// Windows: microseconds since the epoch, from the process's creation
    /// time. What Claude Code records there is matched in each form it
    /// could take (see `windows_start_matches`).
    Windows,
}

pub trait ProcessTable: Send + Sync {
    fn process(&self, pid: i32) -> Option<ProcessInfo>;
    /// Whether the kernel positively reports that `pid` no longer exists.
    /// A failed or incomplete process lookup is not evidence of death.
    fn process_gone(&self, _pid: i32) -> bool {
        false
    }
    /// Whether `pid` has exited but not been reaped (a zombie). It keeps its
    /// pid and start time until its parent collects it, which a container
    /// whose init never reaps may never do, so it must not read as running.
    fn zombie(&self, _pid: i32) -> bool {
        false
    }
    fn all_pids(&self) -> Vec<i32>;
    /// The kernel's executable for `pid` (not argv[0], which is forgeable).
    fn executable(&self, pid: i32) -> Option<PathBuf>;
    /// Whether `executable` is a Codex this user may trust: named `codex`,
    /// and on macOS validly signed by OpenAI; on Linux owned by root or this
    /// user and writable by no one else.
    fn is_trusted_codex(&self, executable: &Path) -> bool;
    fn arguments(&self, pid: i32) -> Vec<String>;
    /// One variable of the process's environment.
    fn environment_var(&self, pid: i32, key: &str) -> Option<String>;
    /// Whether the kernel let this user read the process's environment, so
    /// an absent `environment_var` means absent rather than unreadable.
    fn environment_readable(&self, _pid: i32) -> bool {
        false
    }
    /// The paths of the files the process has open.
    fn open_files(&self, pid: i32) -> Vec<PathBuf>;
    /// Each open file with the birth time of the inode the process holds.
    /// The default stats `open_files` paths. System tables override it so a
    /// path replaced after the descriptor was opened cannot change the age.
    fn opened_files(&self, pid: i32) -> Vec<OpenedFile> {
        self.open_files(pid)
            .into_iter()
            .map(|path| OpenedFile {
                birth_ns: file_birth_ns(&path),
                path,
            })
            .collect()
    }
    fn cwd(&self, pid: i32) -> Option<PathBuf>;
    /// Whether the kernel reports a listening TCP socket on this exact
    /// process. Provider adapters use this in addition to argv and
    /// authentication so a stale or port-stealing process cannot inherit a
    /// credentialed loopback route.
    fn owns_tcp_listener(&self, _pid: i32, _host: &str, _port: u16) -> bool {
        false
    }
    /// Whether the process is attached to a terminal. Pipe-driven agent
    /// commands also publish session records, but they are not interactive
    /// sessions a person can keep working in.
    fn has_terminal(&self, _pid: i32) -> bool {
        false
    }
    fn start_clock(&self) -> StartClock;
}

/// One file a process has open. `birth_ns` belongs to that open inode.
#[derive(Clone, Debug)]
pub struct OpenedFile {
    pub path: PathBuf,
    pub birth_ns: Option<i128>,
}

/// Whether Claude Code's recorded `procStart` names this very process, so a
/// recycled pid is never mistaken for the session.
pub fn claude_start_matches(clock: StartClock, recorded: &str, process: &ProcessInfo) -> bool {
    match clock {
        StartClock::Ticks => recorded.trim() == process.start.to_string(),
        StartClock::Micros => claude_start_seconds(recorded)
            .is_some_and(|seconds| process.start / 1_000_000 == seconds),
        StartClock::Windows => windows_start_matches(recorded, process.start),
    }
}

/// Whether a recorded `procStart` names a Windows process that started at
/// `start` microseconds since the epoch. Claude Code's Windows form is not
/// pinned down, so each form it could take is matched at the precision it
/// carries: the macOS `ctime` string or an RFC 3339 time (whole seconds or
/// milliseconds), or a number of seconds, milliseconds or microseconds
/// since the epoch, or a raw `FILETIME` (100 ns since 1601). Anything else
/// matches nothing, as on the other platforms.
pub fn windows_start_matches(recorded: &str, start: u64) -> bool {
    /// Microseconds from 1601-01-01 to the Unix epoch.
    const FILETIME_EPOCH_MICROS: u64 = 11_644_473_600_000_000;
    let recorded = recorded.trim();
    if let Some(seconds) = claude_start_seconds(recorded) {
        return start / 1_000_000 == seconds;
    }
    if let Ok(time) = chrono::DateTime::parse_from_rfc3339(recorded) {
        let whole_seconds = time.timestamp_subsec_millis() == 0
            && u64::try_from(time.timestamp()).is_ok_and(|seconds| start / 1_000_000 == seconds);
        let millis = u64::try_from(time.timestamp_millis()).is_ok_and(|ms| start / 1_000 == ms);
        return whole_seconds || millis;
    }
    let Ok(number) = recorded.parse::<u64>() else {
        return false;
    };
    number == start / 1_000_000
        || number == start / 1_000
        || number == start
        || number / 10 == start.saturating_add(FILETIME_EPOCH_MICROS)
}

/// Claude Code's macOS `procStart`, `Wed Sep 30 10:00:00 2026` in UTC, as
/// whole seconds since the epoch.
pub fn claude_start_seconds(text: &str) -> Option<u64> {
    let parts: Vec<&str> = text.split_whitespace().collect();
    let [_weekday, month, day, time, year] = parts.as_slice() else {
        return None;
    };
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let month = MONTHS.iter().position(|m| m == month)? as u32 + 1;
    let day: u32 = day.parse().ok()?;
    let year: i32 = year.parse().ok()?;
    let mut clock = time.split(':').map(|part| part.parse::<u32>().ok());
    let (hour, minute, second) = (clock.next()??, clock.next()??, clock.next()??);
    if clock.next().is_some() {
        return None;
    }
    let date = chrono::NaiveDate::from_ymd_opt(year, month, day)?;
    let at = date.and_hms_opt(hour, minute, second)?;
    u64::try_from(at.and_utc().timestamp()).ok()
}

/// The Codex thread a writer-lock path names:
/// `…/thread-writer-locks/<uuid>.lock`, lowercased.
pub fn codex_thread_of_lock(path: &Path) -> Option<String> {
    if path.extension()? != "lock" || path.parent()?.file_name()? != "thread-writer-locks" {
        return None;
    }
    let id = path.file_stem()?.to_str()?.to_lowercase();
    crate::relay::store::is_uuid(&id).then_some(id)
}

/// The threads whose writer locks `pid` holds open.
pub fn codex_locked_threads(
    table: &dyn ProcessTable,
    pid: i32,
) -> std::collections::BTreeSet<String> {
    table
        .open_files(pid)
        .iter()
        .filter_map(|path| codex_thread_of_lock(path))
        .collect()
}

/// The thread after the last `resume` in `arguments`.
pub fn resume_argument(arguments: &[String]) -> Option<&str> {
    let index = arguments.iter().rposition(|a| a == "resume")?;
    arguments.get(index + 1).map(String::as_str)
}

/// One open rollout, as evidence about a writer lock the same process holds.
///
/// A descendant can set `CODEX_THREAD_ID` to any lock its ancestor holds, so
/// holding the lock is not enough when there are several. The rollout the
/// trusted Codex itself has open is the evidence: a root session may be
/// claimed, and a subagent session may not, unless a nearer ancestor vouches
/// for that subagent on its own.
#[derive(Clone, Debug, PartialEq, Eq)]
enum RolloutProof {
    /// `session_meta` for this thread with no parent and no subagent spawn.
    Root,
    /// `thread_source: subagent`, and both parent fields name this parent.
    Subagent(String),
}

/// The thread id at the end of `rollout-…-<uuid>.jsonl`.
fn rollout_thread_of_path(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    let stem = name.strip_suffix(".jsonl")?;
    let split = stem.len().checked_sub(36)?;
    let (prefix, id) = stem.split_at(split);
    if !prefix.ends_with('-') {
        return None;
    }
    let id = id.to_lowercase();
    crate::relay::store::is_uuid(&id).then_some(id)
}

/// How the first record of an open rollout describes `thread`.
///
/// Anything that is not a small `session_meta` for that exact thread is
/// `None`. A subagent record whose two parent fields disagree is `None`, so
/// it cannot explain an extra lock. The conversation after the first record
/// is never read.
fn rollout_proof(path: &Path, thread: &str) -> Option<RolloutProof> {
    const MAX_HEADER: u64 = 128 * 1024;
    let file = std::fs::File::open(path).ok()?;
    let mut reader = std::io::BufReader::new(std::io::Read::take(file, MAX_HEADER));
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    if line.len() as u64 >= MAX_HEADER || !line.ends_with('\n') {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(line.trim_end()).ok()?;
    if value.get("type")?.as_str()? != "session_meta" {
        return None;
    }
    let payload = value.get("payload")?;
    let id = payload.get("id")?.as_str()?.to_lowercase();
    if id != thread || !crate::relay::store::is_uuid(&id) {
        return None;
    }
    let recorded_parent = payload
        .get("parent_thread_id")
        .and_then(|value| value.as_str())
        .map(|value| value.to_lowercase());
    let spawn_parent = payload
        .pointer("/source/subagent/thread_spawn/parent_thread_id")
        .and_then(|value| value.as_str())
        .map(|value| value.to_lowercase());
    let subagent = payload
        .get("thread_source")
        .and_then(|value| value.as_str())
        == Some("subagent");
    if subagent {
        let parent = recorded_parent.filter(|parent| crate::relay::store::is_uuid(parent))?;
        if spawn_parent.as_ref() != Some(&parent) || parent == thread {
            return None;
        }
        return Some(RolloutProof::Subagent(parent));
    }
    if recorded_parent.is_some() || spawn_parent.is_some() {
        return None;
    }
    Some(RolloutProof::Root)
}

/// Proofs from rollouts this process has open, keyed by the thread the
/// filename names. Two open rollouts that disagree about one thread leave no
/// proof for it.
fn open_rollout_proofs(files: &[PathBuf]) -> BTreeMap<String, RolloutProof> {
    let mut proofs = BTreeMap::new();
    let mut conflicts = BTreeSet::new();
    for path in files {
        let Some(thread) = rollout_thread_of_path(path) else {
            continue;
        };
        let Some(proof) = rollout_proof(path, &thread) else {
            continue;
        };
        if conflicts.contains(&thread) {
            continue;
        }
        match proofs.get(&thread) {
            Some(existing) if existing != &proof => {
                proofs.remove(&thread);
                conflicts.insert(thread);
            }
            Some(_) => {}
            None => {
                proofs.insert(thread, proof);
            }
        }
    }
    proofs
}

/// Birth time of whatever a path lookup finds now, in nanoseconds.
/// Missing birth time fails closed. Callers that have a process fd must use
/// the birth captured with that fd instead of looking the path up again.
pub(crate) fn file_birth_ns(path: &Path) -> Option<i128> {
    #[cfg(target_os = "linux")]
    {
        linux_rollout_birth_ns(path)
    }
    #[cfg(target_os = "macos")]
    {
        macos_rollout_birth_ns(path)
    }
    #[cfg(windows)]
    {
        windows_rollout_birth_ns(path)
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    {
        let _ = path;
        None
    }
}

/// The creation time NTFS keeps for the path itself (a link is not
/// followed).
#[cfg(windows)]
fn windows_rollout_birth_ns(path: &Path) -> Option<i128> {
    let created = std::fs::symlink_metadata(path).ok()?.created().ok()?;
    let since = created.duration_since(std::time::UNIX_EPOCH).ok()?;
    i128::try_from(since.as_nanos()).ok()
}

#[cfg(target_os = "linux")]
fn linux_rollout_birth_ns(path: &Path) -> Option<i128> {
    use std::os::unix::ffi::OsStrExt;
    let mut bytes = path.as_os_str().as_bytes().to_vec();
    bytes.push(0);
    let mut stat = unsafe { std::mem::zeroed::<libc::statx>() };
    let rc = unsafe {
        libc::statx(
            libc::AT_FDCWD,
            bytes.as_ptr().cast::<libc::c_char>(),
            libc::AT_SYMLINK_NOFOLLOW,
            libc::STATX_BTIME,
            &mut stat,
        )
    };
    if rc != 0 || stat.stx_mask & libc::STATX_BTIME == 0 {
        return None;
    }
    Some(stat.stx_btime.tv_sec as i128 * 1_000_000_000 + stat.stx_btime.tv_nsec as i128)
}

/// Birth time of the inode `/proc/pid/fd/N` still refers to.
#[cfg(target_os = "linux")]
fn birth_of_proc_fd(proc_fd: &Path) -> Option<i128> {
    use std::os::unix::ffi::OsStrExt;
    let mut bytes = proc_fd.as_os_str().as_bytes().to_vec();
    bytes.push(0);
    let mut stat = unsafe { std::mem::zeroed::<libc::statx>() };
    let rc = unsafe {
        libc::statx(
            libc::AT_FDCWD,
            bytes.as_ptr().cast::<libc::c_char>(),
            0,
            libc::STATX_BTIME,
            &mut stat,
        )
    };
    if rc != 0 || stat.stx_mask & libc::STATX_BTIME == 0 {
        return None;
    }
    Some(stat.stx_btime.tv_sec as i128 * 1_000_000_000 + stat.stx_btime.tv_nsec as i128)
}

#[cfg(target_os = "macos")]
fn macos_rollout_birth_ns(path: &Path) -> Option<i128> {
    // Birth time is on the macOS extension, not `std::os::unix::fs::MetadataExt`.
    use std::os::macos::fs::MetadataExt;
    let meta = std::fs::symlink_metadata(path).ok()?;
    Some(meta.st_birthtime() as i128 * 1_000_000_000 + meta.st_birthtime_nsec() as i128)
}

/// The thread whose open rollout inode is strictly older than every other
/// held thread. Age is `birth_ns` from the open inode, not a fresh lookup
/// of the path. A tie, a lock with no rollout, or a rollout with no birth
/// time is `None`.
fn oldest_held_rollout(locked: &BTreeSet<String>, files: &[OpenedFile]) -> Option<String> {
    let mut born_at = BTreeMap::<String, i128>::new();
    for file in files {
        let Some(thread) = rollout_thread_of_path(&file.path) else {
            continue;
        };
        if !locked.contains(&thread) {
            continue;
        }
        let born = file.birth_ns?;
        born_at
            .entry(thread)
            .and_modify(|existing| *existing = (*existing).min(born))
            .or_insert(born);
    }
    if born_at.len() != locked.len() {
        return None;
    }
    let mut oldest: Option<(&String, i128)> = None;
    for (thread, born) in &born_at {
        match oldest {
            None => oldest = Some((thread, *born)),
            Some((_, when)) if *born < when => oldest = Some((thread, *born)),
            Some((_, when)) if *born == when => return None,
            _ => {}
        }
    }
    oldest.map(|(thread, _)| thread.clone())
}

/// Whether every lock other than `claimed` is a subagent whose parent chain
/// stays inside `locked` and ends at `claimed`. `claimed` must be the oldest
/// open rollout and that file must be the root session, not a rewritten
/// subagent header. A newer file cannot become the root by editing bytes.
fn cli_multilock_vouches(locked: &BTreeSet<String>, claimed: &str, files: &[OpenedFile]) -> bool {
    if locked.len() < 2 || !locked.contains(claimed) {
        return false;
    }
    if oldest_held_rollout(locked, files).as_deref() != Some(claimed) {
        return false;
    }
    let paths: Vec<PathBuf> = files.iter().map(|file| file.path.clone()).collect();
    let proofs = open_rollout_proofs(&paths);
    if proofs.get(claimed) != Some(&RolloutProof::Root) {
        return false;
    }
    locked
        .iter()
        .filter(|thread| thread.as_str() != claimed)
        .all(|thread| subagent_chain_reaches(thread, claimed, locked, &proofs))
}

/// Whether this Codex process itself vouches for `thread`. An ordinary CLI
/// must hold that lock alone, or hold it as the oldest root rollout while
/// every other lock is a subagent of it. An `app-server` must hold the
/// claimed lock. Callers still decide which process is the ancestor.
pub(crate) fn codex_process_vouches_for_thread(
    table: &dyn ProcessTable,
    pid: i32,
    thread: &str,
) -> bool {
    let thread = thread.to_lowercase();
    let files = table.opened_files(pid);
    let locked = files
        .iter()
        .filter_map(|file| codex_thread_of_lock(&file.path))
        .collect::<BTreeSet<_>>();
    let app_server = table.arguments(pid).iter().any(|arg| arg == "app-server");
    if app_server {
        locked.contains(&thread)
    } else if locked.len() == 1 {
        locked.contains(&thread)
    } else {
        cli_multilock_vouches(&locked, &thread, &files)
    }
}

fn subagent_chain_reaches(
    start: &str,
    claimed: &str,
    locked: &BTreeSet<String>,
    proofs: &BTreeMap<String, RolloutProof>,
) -> bool {
    let mut current = start.to_string();
    let mut seen = BTreeSet::new();
    while seen.insert(current.clone()) && seen.len() <= locked.len() {
        let Some(RolloutProof::Subagent(parent)) = proofs.get(&current) else {
            return false;
        };
        if !locked.contains(parent) {
            return false;
        }
        if parent == claimed {
            return true;
        }
        current = parent.clone();
    }
    false
}

/// Whether the nearest trusted Codex ancestor of `pid` holds the claimed
/// thread's writer lock. An ordinary Codex must hold that lock alone, or
/// hold it as the root session while every other lock is a team/subagent
/// rollout that names it as parent. A signed app-server can hold several,
/// so its `app-server` argv shape and the particular lock must both match.
/// `CODEX_THREAD_ID` alone proves nothing about an arbitrary process outside
/// that ancestry, and it cannot select a sibling lock of a multi-lock CLI.
pub fn has_codex_writer_for_caller(
    table: &dyn ProcessTable,
    pid: i32,
    uid: u32,
    thread: &str,
) -> bool {
    let thread = thread.to_lowercase();
    let mut current = pid;
    for _ in 0..MAX_ANCESTRY {
        if current <= 1 {
            return false;
        }
        let Some(process) = table.process(current).filter(|p| p.uid == uid) else {
            return false;
        };
        if table
            .executable(current)
            .is_some_and(|exe| table.is_trusted_codex(&exe))
        {
            let vouched = codex_process_vouches_for_thread(table, current, &thread);
            // File reads happen only for the multi-lock case. The process
            // must still be the one that held the locks.
            return vouched && table.process(current) == Some(process);
        }
        current = process.parent;
    }
    false
}

/// Whether `pid` (itself included) descends from a trusted Codex owned by
/// `uid`.
pub fn has_trusted_codex_ancestor(table: &dyn ProcessTable, pid: i32, uid: u32) -> bool {
    let mut current = pid;
    for _ in 0..MAX_ANCESTRY {
        if current <= 1 {
            return false;
        }
        let Some(process) = table.process(current).filter(|p| p.uid == uid) else {
            return false;
        };
        if table
            .executable(current)
            .is_some_and(|exe| table.is_trusted_codex(&exe))
        {
            return true;
        }
        current = process.parent;
    }
    false
}

/// The Codex thread a caller runs in, from the kernel's view alone.
///
/// A present `CODEX_THREAD_ID` is authoritative: it must be a thread id
/// whose writer lock the nearest trusted Codex ancestor holds (alone for a
/// CLI session, as that CLI's root when its other locks are proven
/// subagents, or among a signed app-server's locks), and the
/// caller must be the same process before and after the check; it never
/// falls through to an ancestor's arguments. Without it, older Codex is
/// matched by the nearest trusted Codex ancestor's `resume <thread>`.
pub fn codex_caller_thread(table: &dyn ProcessTable, pid: i32, uid: u32) -> Option<String> {
    let caller = table.process(pid).filter(|p| p.uid == uid)?;
    if let Some(thread) = table.environment_var(pid, "CODEX_THREAD_ID") {
        let thread = thread.to_lowercase();
        let valid = crate::relay::store::is_uuid(&thread)
            && has_codex_writer_for_caller(table, pid, uid, &thread)
            && table.process(pid) == Some(caller);
        return valid.then_some(thread);
    }
    let mut current = pid;
    for _ in 0..MAX_ANCESTRY {
        if current <= 1 {
            return None;
        }
        let process = table.process(current).filter(|p| p.uid == uid)?;
        if let Some(exe) = table.executable(current) {
            if table.is_trusted_codex(&exe) {
                let arguments = table.arguments(current);
                let thread = resume_argument(&arguments)
                    .map(str::to_lowercase)
                    .filter(|id| crate::relay::store::is_uuid(id));
                // The walk ends at the first Codex: a nested session never
                // takes an outer one's thread.
                return thread.filter(|_| table.process(current) == Some(process));
            }
        }
        current = process.parent;
    }
    None
}

/// Whether `pid` runs an interactive Codex (the TUI that drains `codex
/// queue`), not its app-server, `exec` or `queue` commands.
pub fn is_codex_tui(table: &dyn ProcessTable, pid: i32) -> bool {
    let arguments = table.arguments(pid);
    !arguments
        .iter()
        .any(|a| a == "app-server" || a == "exec" || a == "queue")
}

/// This computer's processes.
#[derive(Default)]
pub struct SystemProcesses {
    #[cfg(target_os = "macos")]
    signatures: macos::SignatureCache,
    #[cfg(windows)]
    windows: windows::Cache,
}

#[cfg(target_os = "linux")]
mod linux;

#[cfg(windows)]
mod windows;

#[cfg(target_os = "linux")]
fn split_nul(bytes: &[u8]) -> Vec<String> {
    bytes
        .split(|b| *b == 0)
        .filter(|part| !part.is_empty())
        .map(|part| String::from_utf8_lossy(part).into_owned())
        .collect()
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use std::ffi::{c_int, c_void};
    use std::mem::{size_of, zeroed};
    use std::os::unix::fs::MetadataExt;

    const PROC_ALL_PIDS: u32 = 1;
    const PROC_PIDVNODEPATHINFO: c_int = 9;
    const PROC_PIDFDVNODEPATHINFO: c_int = 2;
    const PROC_PIDFDSOCKETINFO: c_int = 3;
    const SOCKINFO_TCP: i32 = 2;
    const TSI_S_LISTEN: i32 = 1;

    // Darwin's public `socket_fdinfo` ABI. We deliberately read only the
    // documented scalar fields at their stable offsets; the buffer is larger
    // than the current structure on both supported macOS architectures.
    const SOCKET_INFO_SIZE: usize = 1024;
    const SOI_PROTOCOL: usize = 180;
    const SOI_FAMILY: usize = 184;
    const SOI_KIND: usize = 256;
    const TCP_LOCAL_PORT: usize = 268;
    const TCP_VFLAG: usize = 288;
    const TCP_LOCAL_ADDRESS: usize = 312;
    const TCP_STATE: usize = 344;

    fn i32_at(bytes: &[u8], offset: usize) -> Option<i32> {
        Some(i32::from_ne_bytes(
            bytes.get(offset..offset + 4)?.try_into().ok()?,
        ))
    }

    fn macos_listener(bytes: &[u8], host: &str, port: u16) -> bool {
        if i32_at(bytes, SOI_PROTOCOL) != Some(libc::IPPROTO_TCP)
            || !matches!(
                i32_at(bytes, SOI_FAMILY),
                Some(libc::AF_INET | libc::AF_INET6)
            )
            || i32_at(bytes, SOI_KIND) != Some(SOCKINFO_TCP)
            || i32_at(bytes, TCP_STATE) != Some(TSI_S_LISTEN)
        {
            return false;
        }
        let raw_port = i32_at(bytes, TCP_LOCAL_PORT).unwrap_or_default() as u32;
        if u16::from_be(raw_port as u16) != port {
            return false;
        }
        let vflag = bytes.get(TCP_VFLAG).copied().unwrap_or_default();
        match host {
            "127.0.0.1" => {
                vflag & 1 != 0
                    && bytes.get(TCP_LOCAL_ADDRESS + 12..TCP_LOCAL_ADDRESS + 16)
                        == Some(&[127, 0, 0, 1])
            }
            "::1" => {
                vflag & 2 != 0
                    && bytes.get(TCP_LOCAL_ADDRESS..TCP_LOCAL_ADDRESS + 16)
                        == Some(&[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])
            }
            _ => false,
        }
    }

    #[repr(C)]
    struct ProcFileInfo {
        fi_openflags: u32,
        fi_status: u32,
        fi_offset: i64,
        fi_type: i32,
        fi_guardflags: u32,
    }

    #[repr(C)]
    struct VnodeFdInfoWithPath {
        pfi: ProcFileInfo,
        pvip: libc::vnode_info_path,
    }

    fn path_of(info: &libc::vnode_info_path) -> Option<PathBuf> {
        // SAFETY: `vip_path` is MAXPATHLEN bytes laid out contiguously.
        let bytes: &[u8] = unsafe {
            std::slice::from_raw_parts(
                info.vip_path.as_ptr().cast::<u8>(),
                size_of::<[[libc::c_char; 32]; 32]>(),
            )
        };
        let end = bytes.iter().position(|b| *b == 0).unwrap_or(bytes.len());
        (end > 0).then(|| PathBuf::from(String::from_utf8_lossy(&bytes[..end]).into_owned()))
    }

    /// `KERN_PROCARGS2`: argc, the executable path, argv, then the
    /// environment, in one kernel-owned buffer.
    pub(super) fn procargs(pid: i32) -> Option<Vec<u8>> {
        let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
        let mut size: libc::size_t = 0;
        // SAFETY: a size query with a null buffer.
        let sized = unsafe {
            libc::sysctl(
                mib.as_mut_ptr(),
                3,
                std::ptr::null_mut(),
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        };
        if sized != 0 || size <= size_of::<c_int>() {
            return None;
        }
        let mut buffer = vec![0u8; size];
        // SAFETY: `buffer` holds `size` bytes.
        let read = unsafe {
            libc::sysctl(
                mib.as_mut_ptr(),
                3,
                buffer.as_mut_ptr().cast(),
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        };
        if read != 0 || size < size_of::<c_int>() {
            return None;
        }
        buffer.truncate(size);
        Some(buffer)
    }

    /// One file's identity: replacing or changing the file changes it.
    #[derive(Clone, Copy, PartialEq, Eq)]
    struct Identity {
        inode: u64,
        mtime: (i64, i64),
        ctime: (i64, i64),
    }

    fn identity(path: &Path) -> Option<Identity> {
        let m = std::fs::metadata(path).ok()?;
        Some(Identity {
            inode: m.ino(),
            mtime: (m.mtime(), m.mtime_nsec()),
            ctime: (m.ctime(), m.ctime_nsec()),
        })
    }

    /// Code-signature validation is slow; its result is kept while the path
    /// names the same unchanged file.
    #[derive(Default)]
    pub struct SignatureCache(super::signature_cache::Cache<Identity>);

    impl SignatureCache {
        fn trusted(&self, path: &Path) -> bool {
            self.0.trusted(path, identity, verify_codex_signature)
        }
    }

    /// OpenAI's Codex: identifier `codex`, team `2DC432GLL2`, strictly
    /// valid.
    fn verify_codex_signature(path: &Path) -> bool {
        use security_framework::os::macos::code_signing::{Flags, SecRequirement, SecStaticCode};
        let Some(url) = core_foundation_url(path) else {
            return false;
        };
        let Ok(code) = SecStaticCode::from_path(&url, Flags::NONE) else {
            return false;
        };
        let Ok(requirement) = "anchor apple generic and identifier \"codex\" and certificate leaf[subject.OU] = \"2DC432GLL2\""
            .parse::<SecRequirement>()
        else {
            return false;
        };
        code.check_validity(Flags::STRICT_VALIDATE, &requirement)
            .is_ok()
    }

    fn core_foundation_url(path: &Path) -> Option<core_foundation::url::CFURL> {
        core_foundation::url::CFURL::from_path(path, false)
    }

    /// The kernel's BSD record of `pid`: its parent, owner, start time and
    /// status. A zombie still has one until it is reaped.
    fn bsd_info(pid: i32) -> Option<libc::proc_bsdinfo> {
        if pid <= 0 {
            return None;
        }
        // SAFETY: a zeroed plain-data struct, sized for the call.
        let mut info: libc::proc_bsdinfo = unsafe { zeroed() };
        let expected = size_of::<libc::proc_bsdinfo>() as c_int;
        let read = unsafe {
            libc::proc_pidinfo(
                pid,
                libc::PROC_PIDTBSDINFO,
                0,
                (&mut info as *mut libc::proc_bsdinfo).cast::<c_void>(),
                expected,
            )
        };
        (read == expected).then_some(info)
    }

    impl ProcessTable for SystemProcesses {
        fn process(&self, pid: i32) -> Option<ProcessInfo> {
            let info = bsd_info(pid)?;
            (info.pbi_start_tvsec > 0).then(|| ProcessInfo {
                pid,
                parent: info.pbi_ppid as i32,
                uid: info.pbi_uid,
                start: info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec,
            })
        }

        fn zombie(&self, pid: i32) -> bool {
            // SZOMB, from <sys/proc.h>.
            bsd_info(pid).is_some_and(|info| info.pbi_status == 5)
        }

        fn process_gone(&self, pid: i32) -> bool {
            if pid <= 0 {
                return true;
            }
            // SAFETY: signal 0 performs an existence/permission check only.
            (unsafe { libc::kill(pid, 0) == -1 })
                && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
        }

        fn all_pids(&self) -> Vec<i32> {
            // SAFETY: a size query with a null buffer.
            let needed = unsafe { libc::proc_listpids(PROC_ALL_PIDS, 0, std::ptr::null_mut(), 0) };
            let capacity = (needed.max(0) as usize / size_of::<i32>()).max(1024) + 256;
            let mut pids = vec![0i32; capacity];
            let bytes = unsafe {
                libc::proc_listpids(
                    PROC_ALL_PIDS,
                    0,
                    pids.as_mut_ptr().cast(),
                    (capacity * size_of::<i32>()) as c_int,
                )
            };
            if bytes <= 0 {
                return Vec::new();
            }
            pids.truncate(bytes as usize / size_of::<i32>());
            pids.retain(|pid| *pid > 0);
            pids
        }

        fn executable(&self, pid: i32) -> Option<PathBuf> {
            let mut buffer = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
            // SAFETY: `buffer` is PROC_PIDPATHINFO_MAXSIZE bytes.
            let count =
                unsafe { libc::proc_pidpath(pid, buffer.as_mut_ptr().cast(), buffer.len() as u32) };
            (count > 0).then(|| {
                buffer.truncate(count as usize);
                PathBuf::from(String::from_utf8_lossy(&buffer).into_owned())
            })
        }

        fn is_trusted_codex(&self, executable: &Path) -> bool {
            executable.file_name().is_some_and(|name| name == "codex")
                && self.signatures.trusted(executable)
        }

        fn arguments(&self, pid: i32) -> Vec<String> {
            procargs(pid)
                .map(|buffer| super::macos_args::decode(&buffer, false).0)
                .unwrap_or_default()
        }

        fn environment_readable(&self, pid: i32) -> bool {
            // A failed `KERN_PROCARGS2` read yields no arguments at all; a
            // successful one always has argv[0].
            !self.arguments(pid).is_empty()
        }

        fn environment_var(&self, pid: i32, key: &str) -> Option<String> {
            let buffer = procargs(pid)?;
            super::macos_args::decode(&buffer, true)
                .1
                .into_iter()
                .find_map(|entry| {
                    let (name, value) = entry.split_once('=')?;
                    (name == key).then(|| value.to_string())
                })
        }

        fn opened_files(&self, pid: i32) -> Vec<OpenedFile> {
            // SAFETY: a size query with a null buffer.
            let bytes = unsafe {
                libc::proc_pidinfo(pid, libc::PROC_PIDLISTFDS, 0, std::ptr::null_mut(), 0)
            };
            if bytes <= 0 {
                return Vec::new();
            }
            let count = bytes as usize / size_of::<libc::proc_fdinfo>() + 16;
            // SAFETY: plain-data structs.
            let mut descriptors: Vec<libc::proc_fdinfo> =
                (0..count).map(|_| unsafe { zeroed() }).collect();
            let read = unsafe {
                libc::proc_pidinfo(
                    pid,
                    libc::PROC_PIDLISTFDS,
                    0,
                    descriptors.as_mut_ptr().cast(),
                    (count * size_of::<libc::proc_fdinfo>()) as c_int,
                )
            };
            if read <= 0 {
                return Vec::new();
            }
            descriptors.truncate(read as usize / size_of::<libc::proc_fdinfo>());
            descriptors
                .iter()
                .filter(|d| d.proc_fdtype == libc::PROX_FDTYPE_VNODE as u32)
                .filter_map(|d| {
                    // SAFETY: a zeroed plain-data struct, sized for the call.
                    let mut info: VnodeFdInfoWithPath = unsafe { zeroed() };
                    let expected = size_of::<VnodeFdInfoWithPath>() as c_int;
                    let read = unsafe {
                        libc::proc_pidfdinfo(
                            pid,
                            d.proc_fd,
                            PROC_PIDFDVNODEPATHINFO,
                            (&mut info as *mut VnodeFdInfoWithPath).cast(),
                            expected,
                        )
                    };
                    (read == expected).then(|| {
                        let path = path_of(&info.pvip)?;
                        let stat = &info.pvip.vip_vi.vi_stat;
                        let birth_ns = (stat.vst_birthtime > 0).then_some(
                            stat.vst_birthtime as i128 * 1_000_000_000
                                + stat.vst_birthtimensec as i128,
                        );
                        Some(OpenedFile { path, birth_ns })
                    })?
                })
                .collect()
        }

        fn open_files(&self, pid: i32) -> Vec<PathBuf> {
            self.opened_files(pid)
                .into_iter()
                .map(|file| file.path)
                .collect()
        }

        fn cwd(&self, pid: i32) -> Option<PathBuf> {
            // SAFETY: a zeroed plain-data struct, sized for the call.
            let mut info: libc::proc_vnodepathinfo = unsafe { zeroed() };
            let expected = size_of::<libc::proc_vnodepathinfo>() as c_int;
            let read = unsafe {
                libc::proc_pidinfo(
                    pid,
                    PROC_PIDVNODEPATHINFO,
                    0,
                    (&mut info as *mut libc::proc_vnodepathinfo).cast(),
                    expected,
                )
            };
            (read == expected)
                .then(|| path_of(&info.pvi_cdir))
                .flatten()
        }

        fn owns_tcp_listener(&self, pid: i32, host: &str, port: u16) -> bool {
            let bytes = unsafe {
                libc::proc_pidinfo(pid, libc::PROC_PIDLISTFDS, 0, std::ptr::null_mut(), 0)
            };
            if bytes <= 0 {
                return false;
            }
            let count = bytes as usize / size_of::<libc::proc_fdinfo>() + 16;
            let mut descriptors: Vec<libc::proc_fdinfo> =
                (0..count).map(|_| unsafe { zeroed() }).collect();
            let read = unsafe {
                libc::proc_pidinfo(
                    pid,
                    libc::PROC_PIDLISTFDS,
                    0,
                    descriptors.as_mut_ptr().cast(),
                    (count * size_of::<libc::proc_fdinfo>()) as c_int,
                )
            };
            if read <= 0 {
                return false;
            }
            descriptors.truncate(read as usize / size_of::<libc::proc_fdinfo>());
            descriptors
                .iter()
                .filter(|descriptor| descriptor.proc_fdtype == libc::PROX_FDTYPE_SOCKET as u32)
                .any(|descriptor| {
                    let mut info = [0u8; SOCKET_INFO_SIZE];
                    let read = unsafe {
                        libc::proc_pidfdinfo(
                            pid,
                            descriptor.proc_fd,
                            PROC_PIDFDSOCKETINFO,
                            info.as_mut_ptr().cast(),
                            info.len() as c_int,
                        )
                    };
                    read > TCP_STATE as c_int + 4
                        && macos_listener(&info[..read as usize], host, port)
                })
        }

        fn has_terminal(&self, pid: i32) -> bool {
            // A terminal stdin is a character device whose kernel path is a
            // tty. `proc_pidfdinfo` asks about exactly fd 0 without opening
            // or disturbing the other process.
            let mut info: VnodeFdInfoWithPath = unsafe { zeroed() };
            let expected = size_of::<VnodeFdInfoWithPath>() as c_int;
            let read = unsafe {
                libc::proc_pidfdinfo(
                    pid,
                    0,
                    PROC_PIDFDVNODEPATHINFO,
                    (&mut info as *mut VnodeFdInfoWithPath).cast(),
                    expected,
                )
            };
            if read != expected {
                return false;
            }
            path_of(&info.pvip).is_some_and(|path| terminal_device(&path))
        }

        fn start_clock(&self) -> StartClock {
            StartClock::Micros
        }
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
impl ProcessTable for SystemProcesses {
    fn process(&self, _: i32) -> Option<ProcessInfo> {
        None
    }
    fn all_pids(&self) -> Vec<i32> {
        Vec::new()
    }
    fn executable(&self, _: i32) -> Option<PathBuf> {
        None
    }
    fn is_trusted_codex(&self, _: &Path) -> bool {
        false
    }
    fn arguments(&self, _: i32) -> Vec<String> {
        Vec::new()
    }
    fn environment_var(&self, _: i32, _: &str) -> Option<String> {
        None
    }
    fn open_files(&self, _: i32) -> Vec<PathBuf> {
        Vec::new()
    }
    fn cwd(&self, _: i32) -> Option<PathBuf> {
        None
    }
    fn has_terminal(&self, _: i32) -> bool {
        false
    }
    fn start_clock(&self) -> StartClock {
        StartClock::Ticks
    }
}

/// A process in a `FakeProcesses` table.
#[derive(Clone, Debug, Default)]
pub struct FakeProcess {
    pub parent: i32,
    pub uid: u32,
    pub start: u64,
    pub executable: Option<PathBuf>,
    pub arguments: Vec<String>,
    pub environment: HashMap<String, String>,
    pub open_files: Vec<PathBuf>,
    /// When set, the held-inode data `opened_files` reports for those paths
    /// instead of statting them — a descriptor whose inode a later replace
    /// swapped still lists its old birth here.
    pub opened_files: Option<Vec<OpenedFile>>,
    pub cwd: Option<PathBuf>,
    pub tcp_listeners: Vec<(String, u16)>,
    pub has_terminal: bool,
    /// Exited but not reaped.
    pub zombie: bool,
}

/// A process table the tests write, so no test starts a real session.
/// Executables in `trusted_codex` count as trusted Codex.
#[derive(Default)]
pub struct FakeProcesses {
    pub processes: std::sync::Mutex<HashMap<i32, FakeProcess>>,
    pub trusted_codex: std::sync::Mutex<std::collections::HashSet<PathBuf>>,
    pub clock: Option<StartClock>,
    /// Processes whose environment the kernel would not let this user read.
    pub unreadable_environment: std::sync::Mutex<std::collections::HashSet<i32>>,
}

impl FakeProcesses {
    pub fn insert(&self, pid: i32, process: FakeProcess) {
        self.processes.lock().unwrap().insert(pid, process);
    }

    pub fn remove(&self, pid: i32) {
        self.processes.lock().unwrap().remove(&pid);
    }

    pub fn trust(&self, executable: impl Into<PathBuf>) {
        self.trusted_codex.lock().unwrap().insert(executable.into());
    }

    fn with<T>(&self, pid: i32, read: impl FnOnce(&FakeProcess) -> T) -> Option<T> {
        self.processes.lock().unwrap().get(&pid).map(read)
    }
}

impl ProcessTable for FakeProcesses {
    fn zombie(&self, pid: i32) -> bool {
        self.with(pid, |p| p.zombie).unwrap_or(false)
    }

    fn process(&self, pid: i32) -> Option<ProcessInfo> {
        self.with(pid, |p| ProcessInfo {
            pid,
            parent: p.parent,
            uid: p.uid,
            start: p.start,
        })
    }
    fn all_pids(&self) -> Vec<i32> {
        let mut pids: Vec<i32> = self.processes.lock().unwrap().keys().copied().collect();
        pids.sort_unstable();
        pids
    }
    fn executable(&self, pid: i32) -> Option<PathBuf> {
        self.with(pid, |p| p.executable.clone()).flatten()
    }
    fn is_trusted_codex(&self, executable: &Path) -> bool {
        executable.file_name().is_some_and(|name| name == "codex")
            && self.trusted_codex.lock().unwrap().contains(executable)
    }
    fn arguments(&self, pid: i32) -> Vec<String> {
        self.with(pid, |p| p.arguments.clone()).unwrap_or_default()
    }
    fn environment_var(&self, pid: i32, key: &str) -> Option<String> {
        if !self.environment_readable(pid) {
            return None;
        }
        self.with(pid, |p| p.environment.get(key).cloned())
            .flatten()
    }
    fn environment_readable(&self, pid: i32) -> bool {
        self.with(pid, |_| ()).is_some()
            && !self.unreadable_environment.lock().unwrap().contains(&pid)
    }
    fn open_files(&self, pid: i32) -> Vec<PathBuf> {
        self.with(pid, |p| p.open_files.clone()).unwrap_or_default()
    }
    fn opened_files(&self, pid: i32) -> Vec<OpenedFile> {
        self.with(pid, |p| p.opened_files.clone())
            .flatten()
            .unwrap_or_else(|| {
                self.open_files(pid)
                    .into_iter()
                    .map(|path| OpenedFile {
                        birth_ns: file_birth_ns(&path),
                        path,
                    })
                    .collect()
            })
    }
    fn cwd(&self, pid: i32) -> Option<PathBuf> {
        self.with(pid, |p| p.cwd.clone()).flatten()
    }
    fn owns_tcp_listener(&self, pid: i32, host: &str, port: u16) -> bool {
        self.with(pid, |process| {
            process
                .tcp_listeners
                .iter()
                .any(|listener| listener == &(host.to_string(), port))
        })
        .unwrap_or(false)
    }
    fn has_terminal(&self, pid: i32) -> bool {
        self.with(pid, |p| p.has_terminal).unwrap_or(false)
    }
    fn start_clock(&self) -> StartClock {
        self.clock.unwrap_or(StartClock::Ticks)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const UID: u32 = 501;
    const THREAD: &str = "019a0000-0000-7000-8000-000000000001";
    const OTHER: &str = "019a0000-0000-7000-8000-000000000002";

    #[test]
    fn the_current_process_owns_its_exact_loopback_listener_only() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let table = SystemProcesses::default();
        let pid = std::process::id() as i32;
        assert!(table.owns_tcp_listener(pid, "127.0.0.1", port));
        assert!(!table.owns_tcp_listener(pid, "127.0.0.1", port.saturating_add(1)));
        assert!(!table.owns_tcp_listener(pid, "localhost", port));
    }

    fn codex() -> PathBuf {
        PathBuf::from("/opt/codex/bin/codex")
    }

    fn lock(thread: &str) -> PathBuf {
        PathBuf::from(format!("/Users/a/.codex/thread-writer-locks/{thread}.lock"))
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn an_inspectable_pipe_on_stdin_overrides_a_controlling_terminal() {
        assert!(!linux_has_terminal(
            Some(Path::new("pipe:[1234]")),
            Some("34817")
        ));
        assert!(linux_has_terminal(Some(Path::new("/dev/pts/7")), Some("0")));
        assert!(linux_has_terminal(None, Some("34817")));
        assert!(!linux_has_terminal(None, Some("0")));
    }

    fn table() -> FakeProcesses {
        let table = FakeProcesses::default();
        table.trust(codex());
        table.insert(
            100,
            FakeProcess {
                parent: 1,
                uid: UID,
                start: 10,
                executable: Some(codex()),
                arguments: vec!["codex".into()],
                open_files: vec![lock(THREAD)],
                ..FakeProcess::default()
            },
        );
        table.insert(
            200,
            FakeProcess {
                parent: 100,
                uid: UID,
                start: 20,
                executable: Some("/bin/zsh".into()),
                environment: [("CODEX_THREAD_ID".to_string(), THREAD.to_string())].into(),
                ..FakeProcess::default()
            },
        );
        table
    }

    // OutboundTests.testDirectCodexResolutionUsesThePeerThreadEnvironment,
    // testCodexDiscoveryRefusesUnknownOrMismatchedThreadEnvironment and
    // test_codex_environment_requires_a_trusted_ancestor.
    #[test]
    fn a_codex_thread_id_is_accepted_only_under_its_sole_writer() {
        let table = table();
        assert_eq!(
            codex_caller_thread(&table, 200, UID).as_deref(),
            Some(THREAD)
        );
        // Another user's caller.
        assert_eq!(codex_caller_thread(&table, 200, UID + 1), None);
        // A child naming another thread.
        table
            .processes
            .lock()
            .unwrap()
            .get_mut(&200)
            .unwrap()
            .environment = [("CODEX_THREAD_ID".to_string(), OTHER.to_string())].into();
        assert_eq!(codex_caller_thread(&table, 200, UID), None);
        // A Codex that holds several locks (a shared app-server).
        table
            .processes
            .lock()
            .unwrap()
            .get_mut(&200)
            .unwrap()
            .environment = [("CODEX_THREAD_ID".to_string(), THREAD.to_string())].into();
        table
            .processes
            .lock()
            .unwrap()
            .get_mut(&100)
            .unwrap()
            .open_files = vec![lock(THREAD), lock(OTHER)];
        assert_eq!(codex_caller_thread(&table, 200, UID), None);
    }

    const CHILD: &str = "019a0000-0000-7000-8000-000000000003";

    fn rollout_path(dir: &Path, thread: &str) -> PathBuf {
        dir.join(format!("rollout-2026-10-11T00-00-00-{thread}.jsonl"))
    }

    fn write_rollout(dir: &Path, thread: &str, body: &str) -> PathBuf {
        let path = rollout_path(dir, thread);
        std::fs::write(&path, body).unwrap();
        path
    }

    /// Birth time on the temp filesystem is whole seconds, so a later
    /// rollout has to be created in a later second.
    fn born_after(earlier: &Path) {
        let first = file_birth_ns(earlier).expect("birth time");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        loop {
            std::thread::sleep(std::time::Duration::from_millis(1100));
            if file_birth_ns(earlier).expect("birth time") == first
                && std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos() as i128
                    > first + 1_000_000_000
            {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "birth time did not advance"
            );
        }
    }

    fn root_header(thread: &str) -> String {
        format!(
            "{}\n",
            serde_json::json!({
                "type": "session_meta",
                "payload": { "id": thread, "thread_source": "" }
            })
        )
    }

    fn subagent_header(thread: &str, parent: &str) -> String {
        format!(
            "{}\n",
            serde_json::json!({
                "type": "session_meta",
                "payload": {
                    "id": thread,
                    "parent_thread_id": parent,
                    "thread_source": "subagent",
                    "source": {
                        "subagent": {
                            "thread_spawn": { "parent_thread_id": parent }
                        }
                    }
                }
            })
        )
    }

    fn set_env(table: &FakeProcesses, pid: i32, thread: &str) {
        table
            .processes
            .lock()
            .unwrap()
            .get_mut(&pid)
            .unwrap()
            .environment = [("CODEX_THREAD_ID".to_string(), thread.to_string())].into();
    }

    // A root Codex tool child keeps its own thread when that Codex also holds
    // the team/subagent locks. The same child cannot name the subagent thread:
    // that lock is not a second root, and nothing nearer vouches for it.
    #[test]
    fn a_root_tool_child_keeps_its_thread_when_the_cli_also_holds_subagent_locks() {
        let dir = tempfile::tempdir().unwrap();
        let root_rollout = write_rollout(dir.path(), THREAD, &root_header(THREAD));
        born_after(&root_rollout);
        let child_rollout = write_rollout(dir.path(), OTHER, &subagent_header(OTHER, THREAD));
        let nested_rollout = write_rollout(dir.path(), CHILD, &subagent_header(CHILD, OTHER));
        let table = table();
        table
            .processes
            .lock()
            .unwrap()
            .get_mut(&100)
            .unwrap()
            .open_files = vec![
            lock(THREAD),
            lock(OTHER),
            lock(CHILD),
            root_rollout,
            child_rollout,
            nested_rollout,
        ];
        assert_eq!(
            codex_caller_thread(&table, 200, UID).as_deref(),
            Some(THREAD)
        );
        // Reply and attachment hints use this same voucher.
        assert!(crate::relay::codex::processes::reply_capable(
            &table, UID, THREAD
        ));
        assert!(!crate::relay::codex::processes::reply_capable(
            &table, UID, OTHER
        ));
        assert!(!crate::relay::codex::processes::reply_capable(
            &table, UID, CHILD
        ));

        set_env(&table, 200, OTHER);
        assert_eq!(codex_caller_thread(&table, 200, UID), None);
        set_env(&table, 200, CHILD);
        assert_eq!(codex_caller_thread(&table, 200, UID), None);

        // A nearer Codex that holds only the subagent lock is the independent
        // evidence that lets that subagent's own tool child authenticate.
        table.insert(
            150,
            FakeProcess {
                parent: 100,
                uid: UID,
                start: 15,
                executable: Some(codex()),
                arguments: vec!["codex".into()],
                open_files: vec![lock(OTHER)],
                ..FakeProcess::default()
            },
        );
        table
            .processes
            .lock()
            .unwrap()
            .get_mut(&200)
            .unwrap()
            .parent = 150;
        set_env(&table, 200, OTHER);
        assert_eq!(
            codex_caller_thread(&table, 200, UID).as_deref(),
            Some(OTHER)
        );
    }

    #[test]
    fn an_unproven_extra_lock_does_not_let_a_child_pick_either_thread() {
        let dir = tempfile::tempdir().unwrap();
        let root_rollout = write_rollout(dir.path(), THREAD, &root_header(THREAD));
        let table = table();
        table
            .processes
            .lock()
            .unwrap()
            .get_mut(&100)
            .unwrap()
            .open_files = vec![lock(THREAD), lock(OTHER), root_rollout];
        assert_eq!(codex_caller_thread(&table, 200, UID), None);
        set_env(&table, 200, OTHER);
        assert_eq!(codex_caller_thread(&table, 200, UID), None);

        // The extra file is a subagent header, but its spawn parent does not
        // match the recorded parent, so it explains nothing.
        let mismatched = write_rollout(
            dir.path(),
            OTHER,
            &format!(
                "{}\n",
                serde_json::json!({
                    "type": "session_meta",
                    "payload": {
                        "id": OTHER,
                        "parent_thread_id": THREAD,
                        "thread_source": "subagent",
                        "source": {
                            "subagent": {
                                "thread_spawn": { "parent_thread_id": CHILD }
                            }
                        }
                    }
                })
            ),
        );
        table
            .processes
            .lock()
            .unwrap()
            .get_mut(&100)
            .unwrap()
            .open_files
            .push(mismatched);
        set_env(&table, 200, THREAD);
        assert_eq!(codex_caller_thread(&table, 200, UID), None);

        // A header that names a different thread than its filename is ignored.
        let swapped = write_rollout(dir.path(), OTHER, &subagent_header(THREAD, THREAD));
        table
            .processes
            .lock()
            .unwrap()
            .get_mut(&100)
            .unwrap()
            .open_files
            .push(swapped);
        assert_eq!(codex_caller_thread(&table, 200, UID), None);
    }

    #[test]
    fn rewriting_rollout_headers_cannot_promote_a_newer_subagent() {
        let dir = tempfile::tempdir().unwrap();
        let root_rollout = write_rollout(dir.path(), THREAD, &root_header(THREAD));
        born_after(&root_rollout);
        let child_rollout = write_rollout(dir.path(), OTHER, &subagent_header(OTHER, THREAD));
        // The tool child swaps the headers. The newer file now claims to be
        // the root, and the older file claims to be its subagent.
        std::fs::write(&root_rollout, subagent_header(THREAD, OTHER)).unwrap();
        std::fs::write(&child_rollout, root_header(OTHER)).unwrap();
        let table = table();
        table
            .processes
            .lock()
            .unwrap()
            .get_mut(&100)
            .unwrap()
            .open_files = vec![lock(THREAD), lock(OTHER), root_rollout, child_rollout];
        set_env(&table, 200, OTHER);
        assert_eq!(codex_caller_thread(&table, 200, UID), None);
        assert!(!crate::relay::codex::processes::reply_capable(
            &table, UID, OTHER
        ));
        set_env(&table, 200, THREAD);
        assert_eq!(codex_caller_thread(&table, 200, UID), None);
        assert!(!crate::relay::codex::processes::reply_capable(
            &table, UID, THREAD
        ));
    }

    #[test]
    fn recorded_inode_birth_is_not_a_fresh_path_lookup() {
        let dir = tempfile::tempdir().unwrap();
        let root = write_rollout(dir.path(), THREAD, &root_header(THREAD));
        born_after(&root);
        let child = write_rollout(dir.path(), OTHER, &subagent_header(OTHER, THREAD));
        let root_birth = file_birth_ns(&root).unwrap();
        let child_birth = file_birth_ns(&child).unwrap();
        assert!(root_birth < child_birth);
        let locked = BTreeSet::from([THREAD.to_string(), OTHER.to_string()]);
        // The child path is still the newer file on disk. Recording the
        // root's birth on that path must not be corrected by stating it again.
        let swapped = [
            OpenedFile {
                path: root,
                birth_ns: Some(child_birth),
            },
            OpenedFile {
                path: child,
                birth_ns: Some(root_birth),
            },
        ];
        assert_eq!(
            oldest_held_rollout(&locked, &swapped).as_deref(),
            Some(OTHER)
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn replacing_a_rollout_path_keeps_the_open_inodes_birth() {
        let dir = tempfile::tempdir().unwrap();
        let older = dir.path().join("older-inode");
        let live = dir
            .path()
            .join(format!("rollout-2026-10-11T00-00-00-{THREAD}.jsonl"));
        std::fs::write(&older, "old\n").unwrap();
        born_after(&older);
        std::fs::write(&live, root_header(THREAD)).unwrap();
        let live_birth = file_birth_ns(&live).unwrap();
        let older_birth = file_birth_ns(&older).unwrap();
        assert!(older_birth < live_birth);
        let held = std::fs::File::open(&live).unwrap();
        std::fs::rename(&older, &live).unwrap();
        assert_eq!(file_birth_ns(&live).unwrap(), older_birth);
        let opened = SystemProcesses::default().opened_files(std::process::id() as i32);
        assert!(
            opened.iter().any(|file| file.birth_ns == Some(live_birth)),
            "open inode birth changed to the replaced path"
        );
        drop(held);
    }

    #[test]
    fn a_shared_app_server_vouches_only_for_a_held_thread() {
        let table = table();
        table
            .processes
            .lock()
            .unwrap()
            .get_mut(&100)
            .unwrap()
            .arguments = vec!["codex".into(), "app-server".into(), "daemon".into()];
        table
            .processes
            .lock()
            .unwrap()
            .get_mut(&100)
            .unwrap()
            .open_files = vec![lock(THREAD), lock(OTHER)];
        assert_eq!(
            codex_caller_thread(&table, 200, UID).as_deref(),
            Some(THREAD)
        );

        // The environment cannot claim a thread whose lock this daemon
        // does not hold, even though the ancestor has a valid signature.
        table
            .processes
            .lock()
            .unwrap()
            .get_mut(&100)
            .unwrap()
            .open_files = vec![lock(OTHER)];
        assert_eq!(codex_caller_thread(&table, 200, UID), None);
        table
            .processes
            .lock()
            .unwrap()
            .get_mut(&100)
            .unwrap()
            .open_files = vec![lock(THREAD), lock(OTHER)];

        // Missing and malformed IDs cannot select one of the daemon's locks.
        table
            .processes
            .lock()
            .unwrap()
            .get_mut(&200)
            .unwrap()
            .environment
            .clear();
        assert_eq!(codex_caller_thread(&table, 200, UID), None);
        table
            .processes
            .lock()
            .unwrap()
            .get_mut(&200)
            .unwrap()
            .environment = [("CODEX_THREAD_ID".to_string(), "not-a-thread".to_string())].into();
        assert_eq!(codex_caller_thread(&table, 200, UID), None);
        table
            .processes
            .lock()
            .unwrap()
            .get_mut(&200)
            .unwrap()
            .environment = [("CODEX_THREAD_ID".to_string(), THREAD.to_string())].into();
        table
            .processes
            .lock()
            .unwrap()
            .get_mut(&200)
            .unwrap()
            .parent = 1;
        assert_eq!(codex_caller_thread(&table, 200, UID), None);
    }

    // testCodexDiscoveryAcceptsThreadEnvironmentOnlyBelowTrustedAncestor.
    #[test]
    fn an_untrusted_ancestor_never_vouches() {
        let table = table();
        table.trusted_codex.lock().unwrap().clear();
        assert_eq!(codex_caller_thread(&table, 200, UID), None);
        // A trusted path not named codex does not count either.
        table.trust("/opt/codex/bin/not-codex");
        table
            .processes
            .lock()
            .unwrap()
            .get_mut(&100)
            .unwrap()
            .executable = Some("/opt/codex/bin/not-codex".into());
        assert_eq!(codex_caller_thread(&table, 200, UID), None);
    }

    // testCodexPeerResolutionFindsOnlyATrustedResumeAncestor and
    // test_codex_environment_refuses_unknown_thread_and_keeps_resume_fallback.
    #[test]
    fn older_codex_is_matched_by_resume() {
        let table = table();
        {
            let mut processes = table.processes.lock().unwrap();
            processes.get_mut(&200).unwrap().environment.clear();
            processes.get_mut(&100).unwrap().arguments =
                vec!["codex".into(), "resume".into(), THREAD.to_uppercase()];
        }
        assert_eq!(
            codex_caller_thread(&table, 200, UID).as_deref(),
            Some(THREAD)
        );
        table
            .processes
            .lock()
            .unwrap()
            .get_mut(&100)
            .unwrap()
            .arguments = vec!["codex".into(), "resume".into(), "not-a-uuid".into()];
        assert_eq!(codex_caller_thread(&table, 200, UID), None);
    }

    // Review: the resume walk ends at the first trusted Codex, so a Codex
    // nested inside a resumed one never takes the outer thread.
    #[test]
    fn the_resume_walk_ends_at_the_first_codex() {
        let table = table();
        {
            let mut processes = table.processes.lock().unwrap();
            processes.get_mut(&200).unwrap().environment.clear();
            processes.get_mut(&100).unwrap().arguments =
                vec!["codex".into(), "resume".into(), THREAD.into()];
        }
        table.insert(
            150,
            FakeProcess {
                parent: 100,
                uid: UID,
                start: 15,
                executable: Some(codex()),
                arguments: vec!["codex".into()],
                ..FakeProcess::default()
            },
        );
        table
            .processes
            .lock()
            .unwrap()
            .get_mut(&200)
            .unwrap()
            .parent = 150;
        assert_eq!(codex_caller_thread(&table, 200, UID), None);
    }

    #[test]
    fn writer_lock_paths_name_their_thread() {
        assert_eq!(codex_thread_of_lock(&lock(THREAD)).as_deref(), Some(THREAD));
        assert_eq!(
            codex_thread_of_lock(&lock(&THREAD.to_uppercase())).as_deref(),
            Some(THREAD)
        );
        assert_eq!(codex_thread_of_lock(Path::new("/x/other/abc.lock")), None);
        assert_eq!(
            codex_thread_of_lock(Path::new("/x/thread-writer-locks/not-a-uuid.lock")),
            None
        );
    }

    // testClaudeDiscoveryRequiresRegistryAndKernelStartTimesToMatch (the
    // time format) and test_a_recycled_pid_is_not_the_session.
    #[test]
    fn claude_start_times_match_by_platform() {
        assert_eq!(
            claude_start_seconds("Wed Sep 30 10:00:00 2026"),
            Some(1_790_762_400)
        );
        assert_eq!(
            claude_start_seconds("Wed Sep  3 10:00:00 2026"),
            claude_start_seconds("Wed Sep 3 10:00:00 2026")
        );
        assert_eq!(claude_start_seconds("yesterday"), None);
        let process = ProcessInfo {
            pid: 5,
            parent: 1,
            uid: UID,
            start: 1_790_762_400_123_456,
        };
        assert!(claude_start_matches(
            StartClock::Micros,
            "Wed Sep 30 10:00:00 2026",
            &process
        ));
        assert!(!claude_start_matches(
            StartClock::Micros,
            "Wed Sep 30 10:00:01 2026",
            &process
        ));
        let linux = ProcessInfo {
            start: 4242,
            ..process
        };
        assert!(claude_start_matches(StartClock::Ticks, "4242", &linux));
        assert!(!claude_start_matches(StartClock::Ticks, "4243", &linux));
    }

    #[test]
    fn windows_start_times_match_in_every_recorded_form() {
        // 2026-09-30T10:00:00.123456Z.
        let start = 1_790_762_400_123_456;
        for recorded in [
            "Wed Sep 30 10:00:00 2026",
            "2026-09-30T10:00:00Z",
            "2026-09-30T10:00:00.123Z",
            "1790762400",
            "1790762400123",
            "1790762400123456",
            // FILETIME: 100 ns intervals since 1601.
            "134352360001234567",
        ] {
            assert!(windows_start_matches(recorded, start), "{recorded}");
        }
        for recorded in [
            "Wed Sep 30 10:00:01 2026",
            "2026-09-30T10:00:00.124Z",
            "1790762401",
            "yesterday",
            "",
        ] {
            assert!(!windows_start_matches(recorded, start), "{recorded}");
        }
        let process = ProcessInfo {
            pid: 5,
            parent: 1,
            uid: UID,
            start,
        };
        assert!(claude_start_matches(
            StartClock::Windows,
            "1790762400123",
            &process
        ));
    }

    #[test]
    fn this_process_is_visible_to_the_system_table() {
        let table = SystemProcesses::default();
        let me = std::process::id() as i32;
        let info = table.process(me).expect("this process");
        assert_eq!(info.uid, crate::relay::peer::current_uid());
        assert_eq!(table.process(me), Some(info));
        assert!(table.all_pids().contains(&me));
        assert!(table.executable(me).is_some());
        assert!(!table.arguments(me).is_empty());
        assert_eq!(
            table.cwd(me).map(|p| p.canonicalize().unwrap()),
            Some(std::env::current_dir().unwrap().canonicalize().unwrap())
        );
    }

    #[cfg(any(target_os = "linux", target_os = "macos", windows))]
    #[test]
    fn open_files_include_a_file_this_process_holds() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("held.lock");
        let _file = std::fs::File::create(&path).unwrap();
        let open = SystemProcesses::default().open_files(std::process::id() as i32);
        let canonical = path.canonicalize().unwrap();
        assert!(
            open.iter()
                .any(|p| p.canonicalize().ok().as_ref() == Some(&canonical)),
            "{open:?}"
        );
    }
}
