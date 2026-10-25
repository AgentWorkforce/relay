//! Codex threads as live processes on this computer.
//!
//! A thread is backed by a process when a trusted Codex owned by this user
//! holds its writer lock or runs `resume <thread>`, or when a command below
//! one carries a `CODEX_THREAD_ID` that Codex vouches for
//! (`process::codex_caller_thread`). A writer lock is liveness only: a
//! shared app-server may hold several; a claimed thread still needs its lock.

use crate::relay::process::{
    codex_caller_thread, codex_locked_threads, codex_process_vouches_for_thread, is_codex_tui,
    resume_argument, ProcessTable,
};
use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};

/// A live process backing a Codex thread.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CodexProcessSession {
    pub thread: String,
    pub pid: i32,
    pub start: u64,
    /// Whether the process identifies a relay-send caller as this thread;
    /// false for a writer lock, which only shows the thread is live.
    pub authorizes_callers: bool,
}

/// Trust verdicts for one pass: signature checks are slow and every Codex
/// process normally runs the same executable.
#[derive(Default)]
struct Trust(HashMap<PathBuf, bool>);

impl Trust {
    fn trusted(&mut self, table: &dyn ProcessTable, executable: &Path) -> bool {
        if let Some(known) = self.0.get(executable) {
            return *known;
        }
        let trusted = table.is_trusted_codex(executable);
        self.0.insert(executable.to_path_buf(), trusted);
        trusted
    }
}

/// The live processes backing any of `threads` (lowercase thread ids).
pub fn process_sessions(
    table: &dyn ProcessTable,
    uid: u32,
    threads: &BTreeSet<String>,
) -> Vec<CodexProcessSession> {
    let mut found = Vec::new();
    if threads.is_empty() {
        return found;
    }
    let mut trust = Trust::default();
    for pid in table.all_pids() {
        let Some(process) = table.process(pid).filter(|p| p.uid == uid) else {
            continue;
        };
        let session = |thread: &str, authorizes_callers| CodexProcessSession {
            thread: thread.to_string(),
            pid,
            start: process.start,
            authorizes_callers,
        };
        if let Some(thread) = table
            .environment_var(pid, "CODEX_THREAD_ID")
            .map(|id| id.to_lowercase())
            .filter(|id| threads.contains(id))
        {
            if codex_caller_thread(table, pid, uid).as_deref() == Some(thread.as_str()) {
                found.push(session(&thread, true));
                continue;
            }
        }
        let Some(executable) = table.executable(pid) else {
            continue;
        };
        if !trust.trusted(table, &executable) {
            continue;
        }
        for thread in codex_locked_threads(table, pid).intersection(threads) {
            found.push(session(thread, false));
        }
        // The same older Codex can still be an authorizing `resume`.
        let arguments = table.arguments(pid);
        if let Some(thread) = resume_argument(&arguments)
            .map(str::to_lowercase)
            .filter(|id| threads.contains(id))
        {
            found.push(session(&thread, true));
        }
    }
    found
}

/// Whether a Codex that drains `codex queue` runs `thread` now: the
/// interactive TUI, or the app-server Conductor runs for one of its
/// sessions. A shared app-server's writer lock is not enough.
pub fn terminal_thread_is_live(table: &dyn ProcessTable, uid: u32, thread: &str) -> bool {
    let thread = thread.to_lowercase();
    if !crate::relay::store::is_uuid(&thread) {
        return false;
    }
    process_sessions(table, uid, &BTreeSet::from([thread]))
        .iter()
        .any(|session| drains_queue(table, uid, session.pid))
}

/// Whether `pid` is a trusted Codex that runs queued messages for the
/// threads it holds: the TUI, or a Conductor session's app-server.
pub fn drains_queue(table: &dyn ProcessTable, uid: u32, pid: i32) -> bool {
    is_terminal_codex(table, pid)
        || is_conductor_codex(table, uid, pid)
        || is_paseo_codex(table, uid, pid)
}

/// A trusted Codex app-server owned by Paseo. Paseo keeps one such server
/// per active agent, and it consumes queued turns for the writer lock it
/// holds just as Conductor's per-session app-server does.
pub fn is_paseo_codex(table: &dyn ProcessTable, uid: u32, pid: i32) -> bool {
    let Some(process) = table.process(pid).filter(|p| p.uid == uid) else {
        return false;
    };
    table
        .executable(pid)
        .is_some_and(|exe| table.is_trusted_codex(&exe))
        && table.arguments(pid).iter().any(|a| a == "app-server")
        && crate::relay::paseo::under_daemon(table, uid, pid)
        && table.process(pid) == Some(process)
}

/// Threads hosted by Paseo among a shared `process_sessions` scan. A
/// non-authorizing entry is a writer lock found only after that process's
/// Codex executable was trusted, so this classification does not repeat the
/// slow executable and signature checks for every thread.
pub fn paseo_threads(
    table: &dyn ProcessTable,
    uid: u32,
    sessions: &[CodexProcessSession],
) -> BTreeSet<String> {
    sessions
        .iter()
        .filter(|session| {
            !session.authorizes_callers
                && table
                    .process(session.pid)
                    .is_some_and(|process| process.uid == uid && process.start == session.start)
                && table
                    .arguments(session.pid)
                    .iter()
                    .any(|argument| argument == "app-server")
                && crate::relay::paseo::under_daemon(table, uid, session.pid)
        })
        .map(|session| session.thread.clone())
        .collect()
}

/// The executable of the Conductor Codex app-server that holds `thread`,
/// already verified as a trusted Codex: the `codex` to queue that thread's
/// messages with. Conductor bundles its own Codex, which may be the only one
/// installed, and that app-server is the one that drains the queue.
pub fn conductor_executable(table: &dyn ProcessTable, uid: u32, thread: &str) -> Option<PathBuf> {
    let thread = thread.to_lowercase();
    if !crate::relay::store::is_uuid(&thread) {
        return None;
    }
    process_sessions(table, uid, &BTreeSet::from([thread]))
        .iter()
        .filter(|session| !session.authorizes_callers)
        .find(|session| is_conductor_codex(table, uid, session.pid))
        .and_then(|session| table.executable(session.pid))
}

/// Whether `pid` is the trusted Codex app-server Conductor runs for one of
/// its sessions: started over stdio by this user's Conductor sidecar, it
/// holds that session's thread and, once a turn ends, runs the thread's
/// queued messages as the TUI does. Conductor shows them in its chat.
pub fn is_conductor_codex(table: &dyn ProcessTable, uid: u32, pid: i32) -> bool {
    let Some(process) = table.process(pid).filter(|p| p.uid == uid) else {
        return false;
    };
    let trusted = table
        .executable(pid)
        .is_some_and(|exe| table.is_trusted_codex(&exe));
    if !trusted || !table.arguments(pid).iter().any(|a| a == "app-server") {
        return false;
    }
    crate::relay::conductor::is_sidecar(table, uid, process.parent)
        && table.process(pid) == Some(process)
}

/// Whether `pid` is a trusted Codex running interactively: the TUI that
/// takes turns and drains `codex queue`, not its app-server, `exec` or
/// `queue` commands, and not a command running below it.
pub fn is_terminal_codex(table: &dyn ProcessTable, pid: i32) -> bool {
    table
        .executable(pid)
        .is_some_and(|exe| table.is_trusted_codex(&exe))
        && is_codex_tui(table, pid)
}

/// Whether a command run in `thread` now could be identified on the
/// relay-send socket (`process::codex_caller_thread`): the same voucher as
/// that socket, including a root CLI that also holds proven subagent locks,
/// or (older Codex, no locks) `resume <thread>`.
pub fn reply_capable(table: &dyn ProcessTable, uid: u32, thread: &str) -> bool {
    let thread = thread.to_lowercase();
    if !crate::relay::store::is_uuid(&thread) {
        return false;
    }
    let mut trust = Trust::default();
    table.all_pids().into_iter().any(|pid| {
        if table.process(pid).filter(|p| p.uid == uid).is_none() {
            return false;
        }
        if !table
            .executable(pid)
            .is_some_and(|exe| trust.trusted(table, &exe))
        {
            return false;
        }
        let locked = codex_locked_threads(table, pid);
        if !locked.is_empty() {
            return codex_process_vouches_for_thread(table, pid, &thread);
        }
        resume_argument(&table.arguments(pid)).map(str::to_lowercase) == Some(thread.clone())
    })
}

/// macOS system curl hides CODEX_THREAD_ID. A trusted `resume <thread>`
/// ancestor can still identify its child from argv; a lock-backed Codex
/// without that argv needs the probe client to preserve the environment.
pub fn needs_probe_reply_client(table: &dyn ProcessTable, uid: u32, thread: &str) -> bool {
    let thread = thread.to_lowercase();
    if !crate::relay::store::is_uuid(&thread) {
        return false;
    }
    let mut trust = Trust::default();
    table.all_pids().into_iter().any(|pid| {
        if !table.process(pid).is_some_and(|process| process.uid == uid) {
            return false;
        }
        // The kernel's lock evidence is cheap; verifying an executable is
        // not, so only a process that holds the thread is verified.
        let locked = codex_locked_threads(table, pid);
        locked.contains(&thread)
            && resume_argument(&table.arguments(pid)).map(str::to_lowercase) != Some(thread.clone())
            && table
                .executable(pid)
                .is_some_and(|exe| trust.trusted(table, &exe))
    })
}

/// Every thread a trusted live Codex of this user has open: the writer
/// locks it holds and the thread it resumed.
pub fn open_threads(table: &dyn ProcessTable, uid: u32) -> BTreeSet<String> {
    let mut trust = Trust::default();
    let mut open = BTreeSet::new();
    for pid in table.all_pids() {
        if table.process(pid).filter(|p| p.uid == uid).is_none() {
            continue;
        }
        let Some(executable) = table.executable(pid) else {
            continue;
        };
        if !trust.trusted(table, &executable) {
            continue;
        }
        open.extend(codex_locked_threads(table, pid));
        if let Some(thread) = resume_argument(&table.arguments(pid))
            .map(str::to_lowercase)
            .filter(|id| crate::relay::store::is_uuid(id))
        {
            open.insert(thread);
        }
    }
    open
}

/// The executable of a trusted live Codex of this user to run `app-server
/// proxy` with: the app-server daemon's own when it runs (its native
/// binary speaks its proxy protocol), else any. `None` when no Codex runs,
/// and so no app-server hosts a thread.
pub fn running_executable(table: &dyn ProcessTable, uid: u32) -> Option<PathBuf> {
    let mut trust = Trust::default();
    let mut first = None;
    for pid in table.all_pids() {
        if table.process(pid).filter(|p| p.uid == uid).is_none() {
            continue;
        }
        let Some(executable) = table.executable(pid) else {
            continue;
        };
        if !trust.trusted(table, &executable) {
            continue;
        }
        if table.arguments(pid).iter().any(|a| a == "app-server") {
            return Some(executable);
        }
        first.get_or_insert(executable);
    }
    first
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::relay::process::{FakeProcess, FakeProcesses, ProcessInfo, StartClock};
    use std::sync::Mutex;

    pub const UID: u32 = 501;
    pub const SESSION: &str = "11111111-2222-3333-4444-555555555555";
    pub const OTHER: &str = "66666666-7777-8888-9999-000000000000";

    pub fn codex() -> PathBuf {
        PathBuf::from("/opt/codex/bin/codex")
    }

    pub fn lock(thread: &str) -> PathBuf {
        PathBuf::from(format!(
            "/Users/test/.codex/thread-writer-locks/{thread}.lock"
        ))
    }

    pub fn process(parent: i32, start: u64) -> FakeProcess {
        FakeProcess {
            parent,
            uid: UID,
            start,
            ..FakeProcess::default()
        }
    }

    pub fn codex_process(start: u64, arguments: &[&str]) -> FakeProcess {
        FakeProcess {
            executable: Some(codex()),
            arguments: arguments.iter().map(|a| a.to_string()).collect(),
            ..process(1, start)
        }
    }

    pub fn trusted_table() -> FakeProcesses {
        let table = FakeProcesses::default();
        table.trust(codex());
        table
    }

    fn threads(ids: &[&str]) -> BTreeSet<String> {
        ids.iter().map(|id| id.to_string()).collect()
    }

    fn session(
        thread: &str,
        pid: i32,
        start: u64,
        authorizes_callers: bool,
    ) -> CodexProcessSession {
        CodexProcessSession {
            thread: thread.into(),
            pid,
            start,
            authorizes_callers,
        }
    }

    // OutboundTests.testCodexDiscoveryRequiresRealExecutableAndResumeShape and
    // test_discovers_same_user_codex_resumes_in_tmux_or_ssh_process_trees.
    #[test]
    fn discovery_requires_a_real_executable_and_the_resume_shape() {
        let table = trusted_table();
        table.insert(
            600,
            codex_process(123, &["codex", "--flag", "resume", SESSION]),
        );
        assert_eq!(
            process_sessions(&table, UID, &threads(&[SESSION])),
            [session(SESSION, 600, 123, true)]
        );
        // Another user's Codex.
        assert!(process_sessions(&table, UID + 1, &threads(&[SESSION])).is_empty());
        table.insert(
            600,
            FakeProcess {
                executable: Some("/bin/sh".into()),
                ..codex_process(123, &["codex", "resume", SESSION])
            },
        );
        assert!(process_sessions(&table, UID, &threads(&[SESSION])).is_empty());
        table.insert(600, codex_process(123, &["codex", SESSION]));
        assert!(process_sessions(&table, UID, &threads(&[SESSION])).is_empty());
    }

    // OutboundTests.testPlainCodexProcessDiscoversItsOpenThreadWriterLock and
    // test_plain_codex_session_is_eligible_for_reply_hint.
    #[test]
    fn a_plain_codex_process_is_live_for_its_writer_locks() {
        let table = trusted_table();
        table.insert(
            600,
            FakeProcess {
                open_files: vec![lock(SESSION), lock(OTHER)],
                ..codex_process(123, &["codex"])
            },
        );
        let sessions = process_sessions(&table, UID, &threads(&[SESSION, OTHER]));
        assert_eq!(sessions.len(), 2);
        assert!(sessions.contains(&session(SESSION, 600, 123, false)));
        assert!(sessions.contains(&session(OTHER, 600, 123, false)));
        // Two locks: the process cannot identify a caller.
        assert_eq!(codex_caller_thread(&table, 600, UID), None);
    }

    // OutboundTests.testWriterLockDoesNotHideLegacyResumeAuthorization.
    #[test]
    fn a_writer_lock_does_not_hide_legacy_resume_authorization() {
        let table = trusted_table();
        table.insert(
            600,
            FakeProcess {
                open_files: vec![lock(SESSION)],
                ..codex_process(123, &["codex", "resume", SESSION])
            },
        );
        table.insert(700, process(600, 124));
        let sessions = process_sessions(&table, UID, &threads(&[SESSION]));
        assert!(sessions.contains(&session(SESSION, 600, 123, false)));
        assert!(sessions.contains(&session(SESSION, 600, 123, true)));
        assert_eq!(
            codex_caller_thread(&table, 700, UID).as_deref(),
            Some(SESSION)
        );
    }

    // OutboundTests.testCodexDiscoveryAcceptsThreadEnvironmentOnlyBelowTrustedAncestor.
    #[test]
    fn a_thread_environment_counts_only_below_a_trusted_ancestor() {
        // codex 600 -> shell 700 -> curl 800
        let table = trusted_table();
        table.insert(
            600,
            FakeProcess {
                open_files: vec![lock(SESSION)],
                ..codex_process(10, &["codex"])
            },
        );
        table.insert(700, process(600, 11));
        table.insert(
            800,
            FakeProcess {
                environment: [("CODEX_THREAD_ID".to_string(), SESSION.to_string())].into(),
                ..process(700, 12)
            },
        );
        let sessions = process_sessions(&table, UID, &threads(&[SESSION]));
        assert_eq!(sessions.len(), 2);
        assert!(sessions.contains(&session(SESSION, 600, 10, false)));
        assert!(sessions.contains(&session(SESSION, 800, 12, true)));
        table.trusted_codex.lock().unwrap().clear();
        assert!(process_sessions(&table, UID, &threads(&[SESSION])).is_empty());
    }

    // OutboundTests.testCodexDiscoveryRefusesUnknownOrMismatchedThreadEnvironment.
    #[test]
    fn an_unknown_or_mismatched_thread_environment_is_refused() {
        let table = trusted_table();
        table.insert(600, codex_process(10, &["codex", "resume", SESSION]));
        table.insert(
            800,
            FakeProcess {
                environment: [("CODEX_THREAD_ID".to_string(), OTHER.to_string())].into(),
                ..process(600, 12)
            },
        );
        assert_eq!(
            process_sessions(&table, UID, &threads(&[SESSION, OTHER])),
            [session(SESSION, 600, 10, true)],
            "resume remains discoverable"
        );
    }

    /// A table that counts trust checks.
    struct Counting {
        inner: FakeProcesses,
        checks: Mutex<Vec<PathBuf>>,
    }

    impl ProcessTable for Counting {
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
            self.checks.lock().unwrap().push(executable.to_path_buf());
            self.inner.is_trusted_codex(executable)
        }
        fn arguments(&self, pid: i32) -> Vec<String> {
            self.inner.arguments(pid)
        }
        fn environment_var(&self, pid: i32, key: &str) -> Option<String> {
            self.inner.environment_var(pid, key)
        }
        fn open_files(&self, pid: i32) -> Vec<PathBuf> {
            self.inner.open_files(pid)
        }
        fn cwd(&self, pid: i32) -> Option<PathBuf> {
            self.inner.cwd(pid)
        }
        fn start_clock(&self) -> StartClock {
            self.inner.start_clock()
        }
    }

    // OutboundTests.testCodexDiscoveryVerifiesEachExecutablePathOnce.
    #[test]
    fn each_executable_path_is_verified_once_per_pass() {
        let second = "11111111-2222-3333-4444-555555555556";
        let table = Counting {
            inner: trusted_table(),
            checks: Mutex::default(),
        };
        table
            .inner
            .insert(600, codex_process(123, &["codex", "resume", SESSION]));
        table
            .inner
            .insert(601, codex_process(124, &["codex", "resume", second]));
        assert_eq!(
            process_sessions(&table, UID, &threads(&[SESSION, second])).len(),
            2
        );
        assert_eq!(*table.checks.lock().unwrap(), [codex()]);
    }

    // CodexIncomingRoutes.terminalLive (OutboundProcessDiscovery.terminalCodexThreadIsLive)
    // and _codex_tui_process.
    #[test]
    fn only_an_interactive_codex_drains_the_queue() {
        let table = trusted_table();
        table.insert(
            600,
            FakeProcess {
                open_files: vec![lock(SESSION)],
                ..codex_process(10, &["codex", "app-server"])
            },
        );
        assert!(!terminal_thread_is_live(&table, UID, SESSION));
        table.insert(
            601,
            codex_process(11, &["codex", "exec", "resume", SESSION]),
        );
        assert!(!terminal_thread_is_live(&table, UID, SESSION));
        table.insert(602, codex_process(12, &["codex", "resume", SESSION]));
        assert!(terminal_thread_is_live(&table, UID, SESSION));
        assert!(terminal_thread_is_live(
            &table,
            UID,
            &SESSION.to_uppercase()
        ));
        assert!(!terminal_thread_is_live(&table, UID, OTHER));
        assert!(!terminal_thread_is_live(&table, UID, "not-a-thread"));
        // A command below the TUI is live for its thread, but only the TUI
        // itself drains the queue.
        table.remove(602);
        table.insert(
            603,
            FakeProcess {
                open_files: vec![lock(OTHER)],
                ..codex_process(13, &["codex"])
            },
        );
        table.insert(
            604,
            FakeProcess {
                environment: [("CODEX_THREAD_ID".to_string(), OTHER.to_string())].into(),
                ..process(603, 14)
            },
        );
        assert!(terminal_thread_is_live(&table, UID, OTHER));
    }

    #[test]
    fn a_conductor_sessions_app_server_drains_the_queue() {
        let runtime = PathBuf::from(
            "/Users/test/Library/Application Support/com.conductor.app/bin/.internal/conductor-runtime",
        );
        let table = trusted_table();
        table.insert(
            500,
            FakeProcess {
                executable: Some(runtime.clone()),
                arguments: vec![runtime.display().to_string(), "logger".into()],
                ..process(1, 5)
            },
        );
        let server = |parent| FakeProcess {
            open_files: vec![lock(SESSION)],
            ..FakeProcess {
                parent,
                ..codex_process(
                    10,
                    &[
                        "codex",
                        "--config",
                        "x=1",
                        "app-server",
                        "--listen",
                        "stdio://",
                    ],
                )
            }
        };
        // Below a runtime that is not the sidecar, an app-server is shared.
        table.insert(600, server(500));
        assert!(!terminal_thread_is_live(&table, UID, SESSION));
        let sidecar = |uid| FakeProcess {
            executable: Some(runtime.clone()),
            arguments: vec![runtime.display().to_string(), "sidecar".into()],
            uid,
            ..process(1, 6)
        };
        table.insert(501, sidecar(UID));
        table.insert(600, server(501));
        assert!(is_conductor_codex(&table, UID, 600));
        assert!(terminal_thread_is_live(&table, UID, SESSION));
        assert!(!terminal_thread_is_live(&table, UID, OTHER));
        assert_eq!(conductor_executable(&table, UID, SESSION), Some(codex()));
        assert_eq!(conductor_executable(&table, UID, OTHER), None);
        // Only a trusted Codex, of this user's, below this user's sidecar.
        table.insert(501, sidecar(UID + 1));
        assert!(!terminal_thread_is_live(&table, UID, SESSION));
        table.insert(501, sidecar(UID));
        table.insert(
            600,
            FakeProcess {
                executable: Some(PathBuf::from("/tmp/codex")),
                ..server(501)
            },
        );
        assert!(!terminal_thread_is_live(&table, UID, SESSION));
        // Conductor's `exec` runs are never live hosts.
        table.insert(
            600,
            FakeProcess {
                open_files: vec![lock(SESSION)],
                ..FakeProcess {
                    parent: 501,
                    ..codex_process(10, &["codex", "exec", "resume", SESSION])
                }
            },
        );
        assert!(!terminal_thread_is_live(&table, UID, SESSION));
    }

    #[test]
    fn a_paseo_sessions_app_server_drains_the_queue_and_names_its_host() {
        let helper = PathBuf::from(
            "/Applications/Paseo.app/Contents/Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper",
        );
        let table = trusted_table();
        table.insert(
            500,
            FakeProcess {
                executable: Some(helper),
                ..process(1, 5)
            },
        );
        table.insert(
            550,
            FakeProcess {
                executable: Some(PathBuf::from("/opt/homebrew/bin/node")),
                ..process(500, 6)
            },
        );
        table.insert(
            600,
            FakeProcess {
                open_files: vec![lock(SESSION)],
                parent: 550,
                ..codex_process(10, &["codex", "app-server", "--enable", "goals"])
            },
        );
        assert!(is_paseo_codex(&table, UID, 600));
        assert!(terminal_thread_is_live(&table, UID, SESSION));
        let sessions = process_sessions(&table, UID, &threads(&[SESSION, OTHER]));
        assert_eq!(paseo_threads(&table, UID, &sessions), threads(&[SESSION]));

        table.insert(
            500,
            FakeProcess {
                executable: Some(PathBuf::from(
                    "/tmp/Paseo.app/Contents/Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper",
                )),
                ..process(1, 5)
            },
        );
        assert!(!terminal_thread_is_live(&table, UID, SESSION));
    }

    // CodexBridge.openThreadIDs (the process half).
    #[test]
    fn open_threads_are_the_locks_and_resumes_of_trusted_codex() {
        let table = trusted_table();
        table.insert(
            600,
            FakeProcess {
                open_files: vec![lock(SESSION)],
                ..codex_process(10, &["codex", "app-server"])
            },
        );
        table.insert(
            601,
            codex_process(11, &["codex", "resume", &OTHER.to_uppercase()]),
        );
        table.insert(
            602,
            FakeProcess {
                executable: Some("/tmp/codex".into()),
                open_files: vec![lock("22222222-2222-3333-4444-555555555555")],
                ..process(1, 12)
            },
        );
        assert_eq!(open_threads(&table, UID), threads(&[SESSION, OTHER]));
        assert!(open_threads(&table, UID + 1).is_empty());
    }

    // test_app_server_uses_live_binary_when_path_cli_is_missing and
    // _running_codex_binary.
    #[test]
    fn the_proxy_runs_the_live_daemons_executable() {
        let table = trusted_table();
        assert_eq!(running_executable(&table, UID), None);
        table.insert(600, codex_process(10, &["codex", "resume", SESSION]));
        assert_eq!(running_executable(&table, UID), Some(codex()));
        table.trust("/daemon/codex");
        table.insert(
            601,
            FakeProcess {
                executable: Some("/daemon/codex".into()),
                ..codex_process(11, &["codex", "app-server"])
            },
        );
        assert_eq!(
            running_executable(&table, UID),
            Some(PathBuf::from("/daemon/codex"))
        );
        assert_eq!(running_executable(&table, UID + 1), None);
    }

    // Review (local.rs reply hint): only a Codex that can vouch for its
    // commands makes a reply command possible.
    #[test]
    fn a_trusted_writer_or_legacy_resume_can_reply() {
        let table = trusted_table();
        // A shared app-server with two threads loaded.
        table.insert(
            600,
            FakeProcess {
                open_files: vec![lock(SESSION), lock(OTHER)],
                ..codex_process(10, &["codex", "app-server"])
            },
        );
        assert!(reply_capable(&table, UID, SESSION));
        assert!(reply_capable(&table, UID, OTHER));
        assert!(needs_probe_reply_client(&table, UID, SESSION));
        assert!(!needs_probe_reply_client(
            &table,
            UID,
            "33333333-3333-4333-8333-333333333333"
        ));
        table.insert(600, codex_process(10, &["codex", "app-server"]));
        // A TUI holding just this thread's lock.
        table.insert(
            601,
            FakeProcess {
                open_files: vec![lock(SESSION)],
                ..codex_process(11, &["codex"])
            },
        );
        assert!(reply_capable(&table, UID, &SESSION.to_uppercase()));
        assert!(needs_probe_reply_client(&table, UID, SESSION));
        table.insert(
            601,
            FakeProcess {
                open_files: vec![lock(SESSION)],
                ..codex_process(11, &["codex", "resume", SESSION])
            },
        );
        assert!(!needs_probe_reply_client(&table, UID, SESSION));
        assert!(!reply_capable(&table, UID + 1, SESSION));
        assert!(!reply_capable(&table, UID, OTHER));
        // An older Codex without locks, resumed on the thread.
        table.insert(602, codex_process(12, &["codex", "resume", OTHER]));
        assert!(reply_capable(&table, UID, OTHER));
        assert!(!needs_probe_reply_client(&table, UID, OTHER));
        // A resume whose process holds another thread's lock cannot vouch.
        table.insert(
            602,
            FakeProcess {
                open_files: vec![lock("22222222-2222-3333-4444-555555555555")],
                ..codex_process(12, &["codex", "resume", OTHER])
            },
        );
        assert!(!reply_capable(&table, UID, OTHER));
        assert!(!reply_capable(&table, UID, "not-a-thread"));
    }

    // Review (process.rs:208): a command below an `exec` Codex is not an
    // interactive session.
    #[test]
    fn a_command_below_codex_is_not_itself_a_terminal_codex() {
        let table = trusted_table();
        table.insert(
            600,
            FakeProcess {
                open_files: vec![lock(SESSION)],
                ..codex_process(10, &["codex", "exec"])
            },
        );
        table.insert(
            601,
            FakeProcess {
                arguments: vec!["zsh".into()],
                environment: [("CODEX_THREAD_ID".to_string(), SESSION.to_string())].into(),
                ..process(600, 11)
            },
        );
        let sessions = process_sessions(&table, UID, &threads(&[SESSION]));
        assert_eq!(sessions.len(), 2);
        assert!(sessions.iter().all(|s| !is_terminal_codex(&table, s.pid)));
        assert!(!terminal_thread_is_live(&table, UID, SESSION));
    }
}
