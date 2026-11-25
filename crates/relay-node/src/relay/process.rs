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

use std::collections::{BTreeMap, BTreeSet};
use std::io::BufRead;
use std::path::{Path, PathBuf};

mod codex_hook;
mod codex_runtime;
mod command_line;
mod fake;
#[cfg(any(target_os = "macos", test))]
mod macos_args;
#[cfg(all(target_os = "macos", test))]
mod macos_args_bench;
#[cfg(target_os = "macos")]
mod macos_signing;
mod snapshot;
pub(crate) use codex_hook::{has_unambiguous_codex_hook_writer, with_codex_hook_rollout};
pub(crate) use codex_runtime::{codex_runtime_proofs, trusted_codex_host, CodexRuntimeProof};
pub use command_line::CommandLine;
pub use fake::{FakeProcess, FakeProcesses};
pub use snapshot::ProcessSnapshot;
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
    /// An authoritative view for caller authentication. Discovery snapshots
    /// may retain facts from before a native session opened its descriptor.
    /// Tables that already read current facts need no alternate view.
    fn uncached(&self) -> Option<&dyn ProcessTable> {
        None
    }
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
    /// and on macOS validly signed by OpenAI; on Linux in a folder Codex's
    /// installers put it (`process::linux::in_codex_install`), owned by root
    /// or this user and writable by no one else.
    fn is_trusted_codex(&self, executable: &Path) -> bool;
    /// Whether `executable` is a Grok CLI this user may trust: named `grok`
    /// or `grok-…`, owned by root or this user and writable by no one else
    /// (`trusted_grok_executable`). A `grok agent leader` is recognised by
    /// this, never by its argv alone.
    fn is_trusted_grok(&self, executable: &Path) -> bool {
        trusted_grok_executable(executable)
    }
    /// Whether the kernel's executable for `pid` is Claude Code
    /// (`trusted_claude_process`): a session record naming a process that is
    /// not Claude Code never names a caller.
    fn is_trusted_claude(&self, pid: i32) -> bool {
        trusted_claude_process(self, pid)
    }
    /// Whether `executable` is Cursor's own: on macOS validly signed by
    /// Cursor's developer (team `VDXQ22DGB9`) in an installed app; on Linux in a folder Cursor's
    /// packages install to (`process::linux::in_cursor_install`), owned by
    /// root or this user and writable by no one else. Nowhere else, unless
    /// a table says.
    fn is_trusted_cursor(&self, _executable: &Path) -> bool {
        false
    }
    /// An installed VS Code executable, including its bundled Copilot runtime.
    /// Unsupported process tables deny this proof.
    fn is_trusted_vscode(&self, _pid: i32, _executable: &Path) -> bool {
        false
    }
    fn is_trusted_vscode_bundle(&self, _bundle: &Path) -> bool {
        false
    }
    /// GitHub-signed Copilot desktop code, checked against its live process.
    fn is_trusted_copilot(&self, _pid: i32, _executable: &Path) -> bool {
        false
    }
    fn is_trusted_copilot_bundle(&self, _bundle: &Path) -> bool {
        false
    }
    /// The running host must still name the bundle whose seal was checked.
    fn is_trusted_copilot_host(&self, pid: i32, executable: &Path, bundle: &Path) -> bool {
        self.executable(pid).as_deref() == Some(executable)
            && self.is_trusted_copilot(pid, executable)
            && self.is_trusted_copilot_bundle(bundle)
            && self.executable(pid).as_deref() == Some(executable)
    }
    fn is_trusted_relay_helper(&self, _pid: i32, _executable: &Path) -> bool {
        false
    }
    /// The process's arguments and environment, from one read of it.
    fn command_line(&self, pid: i32) -> CommandLine;
    fn arguments(&self, pid: i32) -> Vec<String> {
        self.command_line(pid).arguments
    }
    /// One variable of the process's environment.
    fn environment_var(&self, pid: i32, key: &str) -> Option<String> {
        self.command_line(pid).var(key)
    }
    /// Whether the kernel let this user read the process's environment, so
    /// an absent `environment_var` means absent rather than unreadable.
    fn environment_readable(&self, pid: i32) -> bool {
        self.command_line(pid).environment.is_some()
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
    /// Kernel path of stdin when attached to a terminal; never inferred from cwd or title.
    fn terminal_path(&self, _pid: i32) -> Option<PathBuf> {
        None
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
/// `…/thread-writer-locks/<uuid>.lock`, lowercased. Windows file names are
/// case-insensitive, and the handle scan reports each as the volume stores
/// it, so there the folder and extension match in any case.
pub fn codex_thread_of_lock(path: &Path) -> Option<String> {
    let same = |found: &std::ffi::OsStr, expected: &str| {
        if cfg!(windows) {
            found
                .to_str()
                .is_some_and(|found| found.eq_ignore_ascii_case(expected))
        } else {
            found == expected
        }
    };
    if !same(path.extension()?, "lock") || !same(path.parent()?.file_name()?, "thread-writer-locks")
    {
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

/// Whether `path` is a program file this user may trust: owned by root or
/// this user and writable by no one else. Windows answers from the name
/// checks alone (see `platform::fs`).
fn trusted_program_file(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|metadata| {
        metadata.is_file()
            && crate::platform::fs::owned_by_root_or_current_user(&metadata)
            && crate::platform::fs::private_to_owner(&metadata, 0o022)
    })
}

/// Whether `executable` is a Grok CLI this user may trust: the kernel's
/// executable is named `grok` or `grok-…` (a versioned build) and is a
/// trusted program file.
pub fn trusted_grok_executable(executable: &Path) -> bool {
    executable
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name == "grok" || name.starts_with("grok-"))
        && trusted_program_file(executable)
}

/// The file that makes `pid` Claude Code, from the kernel's executable: the
/// executable itself when it is named `claude` (`claude.exe` on Windows) or
/// is a native-installer build `…/claude/versions/<version>`; or, under a
/// JavaScript runtime (`node`, `bun`), the script it runs, once resolved to
/// a file inside Anthropic's `@anthropic-ai/claude-code` package.
pub fn claude_program_file(
    executable: &Path,
    arguments: &[String],
    cwd: Option<&Path>,
) -> Option<PathBuf> {
    let name = executable.file_name()?.to_str()?;
    if crate::relay::claude_dirs::is_claude_name(name) {
        return Some(executable.to_path_buf());
    }
    let parent = executable.parent();
    let versions = parent
        .and_then(Path::file_name)
        .is_some_and(|folder| folder == "versions")
        && parent
            .and_then(Path::parent)
            .and_then(Path::file_name)
            .is_some_and(|folder| folder == "claude");
    if versions {
        return Some(executable.to_path_buf());
    }
    let runtime = Path::new(name)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .is_some_and(|stem| matches!(stem.to_ascii_lowercase().as_str(), "node" | "bun"));
    if !runtime {
        return None;
    }
    // The script is the first argument after the runtime that is not an
    // option; Claude Code's launchers pass none before it.
    let script = arguments.iter().skip(1).find(|a| !a.starts_with('-'))?;
    let script = Path::new(script);
    let script = if script.is_absolute() {
        script.to_path_buf()
    } else {
        cwd?.join(script)
    };
    let script = std::fs::canonicalize(script).ok()?;
    let components: Vec<_> = script
        .components()
        .map(|part| part.as_os_str().to_string_lossy().into_owned())
        .collect();
    components
        .windows(3)
        .any(|parts| {
            parts[0] == "node_modules" && parts[1] == "@anthropic-ai" && parts[2] == "claude-code"
        })
        .then_some(script)
}

/// Whether `pid` runs Claude Code by the kernel's view of it
/// (`claude_program_file`), and that program is a trusted program file.
///
/// An executable that can no longer be read (removed by an update while it
/// runs) does not count: such a session cannot name a caller until it is
/// restarted.
pub fn trusted_claude_process<T: ProcessTable + ?Sized>(table: &T, pid: i32) -> bool {
    let Some(executable) = table.executable(pid) else {
        return false;
    };
    let arguments = table.arguments(pid);
    let cwd = table.cwd(pid);
    claude_program_file(&executable, &arguments, cwd.as_deref())
        .is_some_and(|program| trusted_program_file(&program) && trusted_program_file(&executable))
}

/// Whether the nearest trusted Codex above `pid` (itself included) is an
/// `app-server` holding more than one thread's writer lock. Such a process
/// runs several chats, and nothing the kernel shows about a tool process it
/// started says which: `CODEX_THREAD_ID` is inherited environment that any
/// process under it can set to any of the others. So a caller there names
/// no session for sending, even though the claimed lock is held.
pub fn codex_selection_is_ambiguous(table: &dyn ProcessTable, pid: i32, uid: u32) -> bool {
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
            return table
                .arguments(current)
                .iter()
                .any(|arg| arg == "app-server")
                && codex_locked_threads(table, current).len() > 1;
        }
        current = process.parent;
    }
    false
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
    let app_server = table.arguments(pid).iter().any(|arg| arg == "app-server");
    vouches_from(&files, app_server, &thread)
}

/// [`codex_process_vouches_for_thread`] from one observation of the
/// process's open files.
fn vouches_from(files: &[OpenedFile], app_server: bool, thread: &str) -> bool {
    let locked = files
        .iter()
        .filter_map(|file| codex_thread_of_lock(&file.path))
        .collect::<BTreeSet<_>>();
    if app_server || locked.len() == 1 {
        locked.contains(thread)
    } else {
        cli_multilock_vouches(&locked, thread, files)
    }
}

/// What a caller's `CODEX_THREAD_ID` names on the relay-send socket.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CodexTag {
    /// The nearest trusted Codex vouches for the thread.
    Named(String),
    /// The nearest trusted Codex is an app-server holding several chats'
    /// locks, the tagged thread's among them: the kernel cannot tell which
    /// chat ran the caller, so the app-server's own record of the command
    /// must (`codex::app_server::watch`).
    Shared {
        thread: String,
        /// The trusted app-server's executable, to ask it through.
        executable: std::path::PathBuf,
        /// The app-server, as read when its locks were.
        app_server: ProcessInfo,
        /// The caller, as read before the app-server was.
        caller: ProcessInfo,
    },
    /// The nearest trusted Codex is an app-server holding several chats'
    /// locks, but not the tagged thread's.
    Ambiguous,
    /// No thread: a missing or invalid tag, no trusted Codex above the
    /// caller, or one that does not vouch for the tag.
    Nobody,
}

/// [`codex_caller_thread`] for a caller carrying `CODEX_THREAD_ID`, with the
/// ambiguity of [`codex_selection_is_ambiguous`] decided from the same single
/// read of the nearest trusted Codex's open files as the thread's voucher,
/// so a chat opened between two reads can neither pass the gate nor be
/// picked.
pub fn codex_tagged_caller(table: &dyn ProcessTable, pid: i32, uid: u32) -> CodexTag {
    let Some(caller) = table.process(pid).filter(|p| p.uid == uid) else {
        return CodexTag::Nobody;
    };
    let Some(thread) = table
        .environment_var(pid, "CODEX_THREAD_ID")
        .map(|thread| thread.to_lowercase())
        .filter(|thread| crate::relay::store::is_uuid(thread))
    else {
        return CodexTag::Nobody;
    };
    let mut current = pid;
    for _ in 0..MAX_ANCESTRY {
        if current <= 1 {
            return CodexTag::Nobody;
        }
        let Some(process) = table.process(current).filter(|p| p.uid == uid) else {
            return CodexTag::Nobody;
        };
        if table
            .executable(current)
            .is_some_and(|exe| table.is_trusted_codex(&exe))
        {
            let files = table.opened_files(current);
            let app_server = table
                .arguments(current)
                .iter()
                .any(|arg| arg == "app-server");
            let locks = files
                .iter()
                .filter_map(|file| codex_thread_of_lock(&file.path))
                .collect::<BTreeSet<_>>();
            let same =
                table.process(current) == Some(process) && table.process(pid) == Some(caller);
            if !same {
                return CodexTag::Nobody;
            }
            if app_server && locks.len() > 1 {
                return match table.executable(current) {
                    Some(executable) if locks.contains(&thread) => CodexTag::Shared {
                        thread,
                        executable,
                        app_server: process,
                        caller,
                    },
                    _ => CodexTag::Ambiguous,
                };
            }
            return if vouches_from(&files, app_server, &thread) {
                CodexTag::Named(thread)
            } else {
                CodexTag::Nobody
            };
        }
        current = process.parent;
    }
    CodexTag::Nobody
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
/// falls through to an ancestor's arguments. Without it, the nearest trusted
/// Codex ancestor's `resume <thread>` names the thread, once that Codex also
/// vouches for it by the writer lock it holds
/// (`codex_process_vouches_for_thread`); a Codex too old to hold writer
/// locks names none.
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
                // argv is the process's own say; the writer lock it holds is
                // the kernel's. Both must name the thread.
                let thread = resume_argument(&arguments)
                    .map(str::to_lowercase)
                    .filter(|id| crate::relay::store::is_uuid(id))
                    .filter(|id| codex_process_vouches_for_thread(table, current, id));
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
    signatures: macos_signing::SignatureCache,
    #[cfg(target_os = "macos")]
    cursor_signatures: macos_signing::SignatureCache,
    #[cfg(target_os = "macos")]
    vscode_signatures: macos_signing::SignatureCache,
    #[cfg(target_os = "macos")]
    copilot_signatures: macos_signing::SignatureCache,
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
    mod terminal;
    use super::*;
    use std::ffi::{c_int, c_void};
    use std::mem::{size_of, zeroed};

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

        fn is_trusted_cursor(&self, executable: &Path) -> bool {
            self.cursor_signatures.trusted_cursor(executable)
        }

        fn is_trusted_vscode(&self, pid: i32, executable: &Path) -> bool {
            self.vscode_signatures.trusted_vscode(executable)
                && macos_signing::trusted_vscode_process(pid)
        }
        fn is_trusted_vscode_bundle(&self, bundle: &Path) -> bool {
            macos_signing::trusted_vscode_bundle(bundle)
        }
        fn is_trusted_copilot(&self, pid: i32, executable: &Path) -> bool {
            self.copilot_signatures.trusted_copilot(executable)
                && macos_signing::trusted_copilot_process(pid)
        }
        fn is_trusted_copilot_bundle(&self, bundle: &Path) -> bool {
            macos_signing::trusted_copilot_bundle(bundle)
        }
        fn is_trusted_copilot_host(&self, pid: i32, executable: &Path, bundle: &Path) -> bool {
            macos_signing::stable_copilot_bundle(bundle, executable, || {
                self.executable(pid).as_deref() == Some(executable)
                    && self.is_trusted_copilot(pid, executable)
                    && self.is_trusted_copilot_bundle(bundle)
                    && self.executable(pid).as_deref() == Some(executable)
            })
        }
        fn is_trusted_relay_helper(&self, pid: i32, _executable: &Path) -> bool {
            macos_signing::trusted_relay_helper(pid)
        }

        fn command_line(&self, pid: i32) -> CommandLine {
            let Some(buffer) = procargs(pid) else {
                return CommandLine::default();
            };
            let (arguments, environment) = super::macos_args::decode(&buffer, true);
            // A failed `KERN_PROCARGS2` read yields no arguments at all; a
            // successful one always has argv[0].
            let readable = !arguments.is_empty();
            CommandLine {
                arguments,
                environment: readable.then_some(environment),
            }
        }

        fn arguments(&self, pid: i32) -> Vec<String> {
            procargs(pid)
                .map(|buffer| super::macos_args::decode(&buffer, false).0)
                .unwrap_or_default()
        }

        fn environment_readable(&self, pid: i32) -> bool {
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
            self.terminal_path(pid).is_some()
        }

        fn terminal_path(&self, pid: i32) -> Option<PathBuf> {
            terminal::path(pid)
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
    fn command_line(&self, _: i32) -> CommandLine {
        CommandLine::default()
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

    #[test]
    fn a_resume_argument_names_its_thread_only_with_that_threads_lock() {
        let table = table();
        let resumed = |open_files: Vec<PathBuf>| FakeProcess {
            parent: 1,
            uid: UID,
            start: 10,
            executable: Some(codex()),
            arguments: vec!["codex".into(), "resume".into(), THREAD.into()],
            open_files,
            ..FakeProcess::default()
        };
        // The tool below carries no thread environment of its own.
        table.insert(
            200,
            FakeProcess {
                parent: 100,
                uid: UID,
                start: 20,
                executable: Some("/bin/zsh".into()),
                ..FakeProcess::default()
            },
        );
        table.insert(100, resumed(vec![lock(THREAD)]));
        assert_eq!(
            codex_caller_thread(&table, 200, UID).as_deref(),
            Some(THREAD)
        );
        // argv alone, or argv naming a thread whose lock another holds.
        table.insert(100, resumed(Vec::new()));
        assert_eq!(codex_caller_thread(&table, 200, UID), None);
        table.insert(100, resumed(vec![lock(OTHER)]));
        assert_eq!(codex_caller_thread(&table, 200, UID), None);
    }

    /// A table whose Codex lock list grows after its first read, as when a
    /// chat opens while a caller is being identified.
    struct GrowingLocks {
        inner: FakeProcesses,
        reads: std::sync::atomic::AtomicUsize,
        first: Vec<PathBuf>,
        later: Vec<PathBuf>,
    }

    impl ProcessTable for GrowingLocks {
        fn process(&self, pid: i32) -> Option<ProcessInfo> {
            self.inner.process(pid)
        }
        fn all_pids(&self) -> Vec<i32> {
            self.inner.all_pids()
        }
        fn executable(&self, pid: i32) -> Option<PathBuf> {
            self.inner.executable(pid)
        }
        fn is_trusted_codex(&self, executable: &Path) -> bool {
            self.inner.is_trusted_codex(executable)
        }
        fn command_line(&self, pid: i32) -> CommandLine {
            self.inner.command_line(pid)
        }
        fn open_files(&self, pid: i32) -> Vec<PathBuf> {
            if pid != 100 {
                return self.inner.open_files(pid);
            }
            let read = self.reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if read == 0 {
                self.first.clone()
            } else {
                self.later.clone()
            }
        }
        fn opened_files(&self, pid: i32) -> Vec<OpenedFile> {
            self.open_files(pid)
                .into_iter()
                .map(|path| OpenedFile {
                    path,
                    birth_ns: None,
                })
                .collect()
        }
        fn cwd(&self, pid: i32) -> Option<PathBuf> {
            self.inner.cwd(pid)
        }
        fn start_clock(&self) -> StartClock {
            self.inner.start_clock()
        }
    }

    #[test]
    fn the_ambiguity_gate_and_the_voucher_read_one_lock_observation() {
        let inner = table();
        inner.insert(
            100,
            FakeProcess {
                parent: 1,
                uid: UID,
                start: 10,
                executable: Some(codex()),
                arguments: vec!["codex".into(), "app-server".into()],
                ..FakeProcess::default()
            },
        );
        // The tool names the chat that opens only after the first read.
        inner.insert(
            200,
            FakeProcess {
                parent: 100,
                uid: UID,
                start: 20,
                executable: Some("/bin/zsh".into()),
                environment: [("CODEX_THREAD_ID".to_string(), OTHER.to_string())].into(),
                ..FakeProcess::default()
            },
        );
        let growing = GrowingLocks {
            inner,
            reads: Default::default(),
            first: vec![lock(THREAD)],
            later: vec![lock(THREAD), lock(OTHER)],
        };
        assert_eq!(codex_tagged_caller(&growing, 200, UID), CodexTag::Nobody);
        assert_eq!(growing.reads.load(std::sync::atomic::Ordering::SeqCst), 1);
        // Read again, both chats are held: never named from the tag alone;
        // the app-server must vouch for the command (`Shared`).
        assert_eq!(
            codex_tagged_caller(&growing, 200, UID),
            CodexTag::Shared {
                thread: OTHER.to_string(),
                executable: codex(),
                app_server: growing.process(100).unwrap(),
                caller: growing.process(200).unwrap(),
            }
        );
        // A single chat named by its own tag.
        let one = table();
        assert_eq!(
            codex_tagged_caller(&one, 200, UID),
            CodexTag::Named(THREAD.to_string())
        );
    }

    #[test]
    fn an_app_server_holding_several_chats_leaves_its_tools_ambiguous() {
        let table = table();
        assert!(!codex_selection_is_ambiguous(&table, 200, UID));
        let app_server = |open_files: Vec<PathBuf>| FakeProcess {
            parent: 1,
            uid: UID,
            start: 10,
            executable: Some(codex()),
            arguments: vec!["codex".into(), "app-server".into()],
            open_files,
            ..FakeProcess::default()
        };
        table.insert(100, app_server(vec![lock(THREAD)]));
        assert!(!codex_selection_is_ambiguous(&table, 200, UID));
        assert_eq!(
            codex_caller_thread(&table, 200, UID).as_deref(),
            Some(THREAD)
        );
        table.insert(100, app_server(vec![lock(THREAD), lock(OTHER)]));
        assert!(codex_selection_is_ambiguous(&table, 200, UID));
        // A CLI is judged by its own root/subagent proof instead.
        table.insert(
            100,
            FakeProcess {
                arguments: vec!["codex".into()],
                ..app_server(vec![lock(THREAD), lock(OTHER)])
            },
        );
        assert!(!codex_selection_is_ambiguous(&table, 200, UID));
        // Outside any trusted Codex there is nothing to choose among.
        table.trusted_codex.lock().unwrap().clear();
        assert!(!codex_selection_is_ambiguous(&table, 200, UID));
    }

    #[cfg(unix)]
    #[test]
    fn claude_code_is_known_by_its_executable_or_anthropics_package() {
        let args = |list: &[&str]| list.iter().map(|a| a.to_string()).collect::<Vec<_>>();
        for executable in [
            "/home/me/.local/share/mise/installs/claude/2.1.319/claude",
            "/home/me/.local/share/claude/versions/2.1.319",
            "/opt/homebrew/bin/claude",
        ] {
            assert_eq!(
                claude_program_file(Path::new(executable), &[], None).as_deref(),
                Some(Path::new(executable)),
                "{executable}"
            );
        }
        for executable in [
            "/bin/bash",
            "/usr/bin/python3",
            "/home/me/versions/2.1.319",
            "/home/me/claude/other/2.1.319",
        ] {
            assert_eq!(
                claude_program_file(Path::new(executable), &args(&["claude"]), None),
                None,
                "{executable}"
            );
        }
        // Under Node, the script it runs must resolve into the package.
        let root = tempfile::tempdir().unwrap();
        let package = root
            .path()
            .join("lib/node_modules/@anthropic-ai/claude-code");
        std::fs::create_dir_all(&package).unwrap();
        let cli = package.join("cli.js");
        std::fs::write(&cli, "").unwrap();
        let shim = root.path().join("claude");
        std::os::unix::fs::symlink(&cli, &shim).unwrap();
        let fake = root.path().join("node_modules/@anthropic-ai/other");
        std::fs::create_dir_all(&fake).unwrap();
        std::fs::write(fake.join("cli.js"), "").unwrap();
        let node = Path::new("/usr/bin/node");
        let cli = std::fs::canonicalize(&cli).unwrap();
        assert_eq!(
            claude_program_file(node, &args(&["node", shim.to_str().unwrap()]), None),
            Some(cli.clone())
        );
        assert_eq!(
            claude_program_file(
                node,
                &args(&["node", "lib/node_modules/@anthropic-ai/claude-code/cli.js"]),
                Some(root.path())
            ),
            Some(cli)
        );
        assert_eq!(
            claude_program_file(
                node,
                &args(&["node", fake.join("cli.js").to_str().unwrap()]),
                None
            ),
            None
        );
        assert_eq!(
            claude_program_file(node, &args(&["node", "/nonexistent/claude"]), None),
            None
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_trusted_program_file_is_writable_by_its_owner_alone() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let grok = root.path().join("grok");
        std::fs::write(&grok, "").unwrap();
        std::fs::set_permissions(&grok, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(trusted_grok_executable(&grok));
        let versioned = root.path().join("grok-1.0.46");
        std::fs::write(&versioned, "").unwrap();
        std::fs::set_permissions(&versioned, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(trusted_grok_executable(&versioned));
        // Writable by others, misnamed, or missing.
        std::fs::set_permissions(&grok, std::fs::Permissions::from_mode(0o775)).unwrap();
        assert!(!trusted_grok_executable(&grok));
        std::fs::set_permissions(&grok, std::fs::Permissions::from_mode(0o757)).unwrap();
        assert!(!trusted_grok_executable(&grok));
        let other = root.path().join("python3");
        std::fs::write(&other, "").unwrap();
        std::fs::set_permissions(&other, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(!trusted_grok_executable(&other));
        assert!(!trusted_grok_executable(&root.path().join("missing/grok")));

        // The same file rules hold for Claude Code, by the kernel's
        // executable a table reports.
        let claude = root.path().join("claude");
        std::fs::write(&claude, "").unwrap();
        std::fs::set_permissions(&claude, std::fs::Permissions::from_mode(0o755)).unwrap();
        let table = FakeProcesses::default();
        let at = |executable: &Path| FakeProcess {
            parent: 1,
            uid: UID,
            start: 1,
            executable: Some(executable.to_path_buf()),
            ..FakeProcess::default()
        };
        table.insert(300, at(&claude));
        assert!(trusted_claude_process(&table, 300));
        table.insert(300, at(&other));
        assert!(!trusted_claude_process(&table, 300));
        std::fs::set_permissions(&claude, std::fs::Permissions::from_mode(0o777)).unwrap();
        table.insert(300, at(&claude));
        assert!(!trusted_claude_process(&table, 300));
        table.insert(
            300,
            FakeProcess {
                executable: None,
                ..at(&claude)
            },
        );
        assert!(!trusted_claude_process(&table, 300));
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

    // relay#2239: Windows names are case-insensitive, and the handle scan
    // reports them as the volume stores them.
    #[test]
    fn writer_lock_names_match_case_as_their_platform_does() {
        let shouted = format!("/x/Thread-Writer-Locks/{}.LOCK", THREAD.to_uppercase());
        let expected = cfg!(windows).then(|| THREAD.to_string());
        assert_eq!(codex_thread_of_lock(Path::new(&shouted)), expected);
        #[cfg(windows)]
        assert_eq!(
            codex_thread_of_lock(Path::new(&format!(
                r"C:\Users\a\.codex\thread-writer-locks\{THREAD}.lock"
            )))
            .as_deref(),
            Some(THREAD)
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
