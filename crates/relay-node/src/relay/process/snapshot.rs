//! One time-bounded view of the process table that the core's scans share.
//!
//! Discovery and liveness walk every process on the computer, and one pass
//! asks about the same process many times (its owner, executable, argv,
//! environment, open files, its ancestors'). A `ProcessSnapshot` reads each
//! fact about a process at most once per window and hands every scan in that
//! window the same answer, so concurrent provider passes cost one walk.
//!
//! Questions whose answer must be current, whether a process is gone or a
//! zombie, and whether it owns a listener, always go to the kernel.

use super::{CommandLine, OpenedFile, ProcessInfo, ProcessTable, StartClock};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// A `ProcessTable` over `inner` whose reads are kept for `window`.
pub struct ProcessSnapshot {
    inner: Arc<dyn ProcessTable>,
    window: Duration,
    current: Mutex<Option<Arc<Generation>>>,
}

/// Every read taken since `taken`.
struct Generation {
    taken: Instant,
    pids: OnceLock<Vec<i32>>,
    processes: Mutex<HashMap<i32, Arc<Facts>>>,
}

/// One process's facts, each read on first use. A reader that arrives while
/// another reads the same fact waits for that read rather than repeating it.
#[derive(Default)]
struct Facts {
    process: OnceLock<Option<ProcessInfo>>,
    executable: OnceLock<Option<PathBuf>>,
    command_line: OnceLock<CommandLine>,
    open_files: OnceLock<Vec<PathBuf>>,
    opened_files: OnceLock<Vec<OpenedFile>>,
    cwd: OnceLock<Option<PathBuf>>,
    has_terminal: OnceLock<bool>,
}

impl ProcessSnapshot {
    /// How long one view of the process table is kept: long enough that the
    /// provider passes of one discovery round share it, short enough that a
    /// process started or ended is seen by the next round.
    pub const WINDOW: Duration = Duration::from_secs(2);

    /// This computer's processes, shared through a snapshot.
    pub fn system() -> Arc<dyn ProcessTable> {
        Arc::new(ProcessSnapshot::new(Arc::new(
            super::SystemProcesses::default(),
        )))
    }

    pub fn new(inner: Arc<dyn ProcessTable>) -> ProcessSnapshot {
        ProcessSnapshot::with_window(inner, ProcessSnapshot::WINDOW)
    }

    pub fn with_window(inner: Arc<dyn ProcessTable>, window: Duration) -> ProcessSnapshot {
        ProcessSnapshot {
            inner,
            window,
            current: Mutex::new(None),
        }
    }

    fn generation(&self) -> Arc<Generation> {
        let mut current = self
            .current
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        match &*current {
            Some(generation) if generation.taken.elapsed() < self.window => generation.clone(),
            _ => {
                let generation = Arc::new(Generation {
                    taken: Instant::now(),
                    pids: OnceLock::new(),
                    processes: Mutex::new(HashMap::new()),
                });
                *current = Some(generation.clone());
                generation
            }
        }
    }

    fn facts(&self, pid: i32) -> Arc<Facts> {
        self.generation()
            .processes
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .entry(pid)
            .or_default()
            .clone()
    }

    /// Forgets `pid`, so the next read of it asks the kernel.
    fn forget(&self, pid: i32) {
        if let Some(generation) = &*self
            .current
            .lock()
            .unwrap_or_else(|error| error.into_inner())
        {
            generation
                .processes
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(&pid);
        }
    }
}

impl ProcessTable for ProcessSnapshot {
    fn process(&self, pid: i32) -> Option<ProcessInfo> {
        self.facts(pid)
            .process
            .get_or_init(|| self.inner.process(pid))
            .clone()
    }

    fn process_gone(&self, pid: i32) -> bool {
        let gone = self.inner.process_gone(pid);
        if gone {
            self.forget(pid);
        }
        gone
    }

    fn zombie(&self, pid: i32) -> bool {
        self.inner.zombie(pid)
    }

    fn all_pids(&self) -> Vec<i32> {
        self.generation()
            .pids
            .get_or_init(|| self.inner.all_pids())
            .clone()
    }

    fn executable(&self, pid: i32) -> Option<PathBuf> {
        self.facts(pid)
            .executable
            .get_or_init(|| self.inner.executable(pid))
            .clone()
    }

    fn is_trusted_codex(&self, executable: &Path) -> bool {
        self.inner.is_trusted_codex(executable)
    }

    fn is_trusted_cursor(&self, executable: &Path) -> bool {
        self.inner.is_trusted_cursor(executable)
    }

    fn command_line(&self, pid: i32) -> CommandLine {
        self.facts(pid)
            .command_line
            .get_or_init(|| self.inner.command_line(pid))
            .clone()
    }

    fn arguments(&self, pid: i32) -> Vec<String> {
        self.facts(pid)
            .command_line
            .get_or_init(|| self.inner.command_line(pid))
            .arguments
            .clone()
    }

    fn environment_var(&self, pid: i32, key: &str) -> Option<String> {
        self.facts(pid)
            .command_line
            .get_or_init(|| self.inner.command_line(pid))
            .var(key)
    }

    fn environment_readable(&self, pid: i32) -> bool {
        self.facts(pid)
            .command_line
            .get_or_init(|| self.inner.command_line(pid))
            .environment
            .is_some()
    }

    fn open_files(&self, pid: i32) -> Vec<PathBuf> {
        let facts = self.facts(pid);
        if let Some(opened) = facts.opened_files.get() {
            return opened.iter().map(|file| file.path.clone()).collect();
        }
        facts
            .open_files
            .get_or_init(|| self.inner.open_files(pid))
            .clone()
    }

    fn opened_files(&self, pid: i32) -> Vec<OpenedFile> {
        self.facts(pid)
            .opened_files
            .get_or_init(|| self.inner.opened_files(pid))
            .clone()
    }

    fn cwd(&self, pid: i32) -> Option<PathBuf> {
        self.facts(pid)
            .cwd
            .get_or_init(|| self.inner.cwd(pid))
            .clone()
    }

    fn owns_tcp_listener(&self, pid: i32, host: &str, port: u16) -> bool {
        self.inner.owns_tcp_listener(pid, host, port)
    }

    fn terminal_path(&self, pid: i32) -> Option<PathBuf> {
        self.inner.terminal_path(pid)
    }

    fn has_terminal(&self, pid: i32) -> bool {
        *self
            .facts(pid)
            .has_terminal
            .get_or_init(|| self.inner.has_terminal(pid))
    }

    fn start_clock(&self) -> StartClock {
        self.inner.start_clock()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay::process::{FakeProcess, FakeProcesses};
    use std::collections::BTreeSet;

    const UID: u32 = 501;
    const THREAD: &str = "11111111-2222-3333-4444-555555555555";
    const OTHER: &str = "66666666-7777-8888-9999-000000000000";

    /// A fake table that counts the kernel reads a real one would make.
    #[derive(Default)]
    struct Counting {
        inner: FakeProcesses,
        scans: Mutex<usize>,
        command_lines: Mutex<HashMap<i32, usize>>,
        processes: Mutex<HashMap<i32, usize>>,
        open_files: Mutex<HashMap<i32, usize>>,
        opened_files: Mutex<HashMap<i32, usize>>,
    }

    fn count(counts: &Mutex<HashMap<i32, usize>>, pid: i32) {
        *counts.lock().unwrap().entry(pid).or_default() += 1;
    }

    impl ProcessTable for Counting {
        fn process(&self, pid: i32) -> Option<ProcessInfo> {
            count(&self.processes, pid);
            self.inner.process(pid)
        }
        fn process_gone(&self, pid: i32) -> bool {
            self.inner.process(pid).is_none()
        }
        fn all_pids(&self) -> Vec<i32> {
            *self.scans.lock().unwrap() += 1;
            self.inner.all_pids()
        }
        fn executable(&self, pid: i32) -> Option<PathBuf> {
            self.inner.executable(pid)
        }
        fn is_trusted_codex(&self, executable: &Path) -> bool {
            self.inner.is_trusted_codex(executable)
        }
        fn is_trusted_cursor(&self, executable: &Path) -> bool {
            self.inner.is_trusted_cursor(executable)
        }
        fn command_line(&self, pid: i32) -> CommandLine {
            count(&self.command_lines, pid);
            self.inner.command_line(pid)
        }
        fn open_files(&self, pid: i32) -> Vec<PathBuf> {
            count(&self.open_files, pid);
            self.inner.open_files(pid)
        }
        fn opened_files(&self, pid: i32) -> Vec<OpenedFile> {
            count(&self.opened_files, pid);
            self.inner.opened_files(pid)
        }
        fn cwd(&self, pid: i32) -> Option<PathBuf> {
            self.inner.cwd(pid)
        }
        fn start_clock(&self) -> StartClock {
            self.inner.start_clock()
        }
    }

    fn codex() -> PathBuf {
        PathBuf::from("/opt/codex/bin/codex")
    }

    fn lock(thread: &str) -> PathBuf {
        PathBuf::from(format!(
            "/Users/test/.codex/thread-writer-locks/{thread}.lock"
        ))
    }

    /// A Codex TUI holding THREAD, a tool command below it naming THREAD,
    /// an older Codex resuming OTHER, and unrelated processes.
    fn world() -> Arc<Counting> {
        let table = Counting::default();
        table.inner.trust(codex());
        table.inner.insert(
            1,
            FakeProcess {
                uid: UID,
                start: 1,
                executable: Some("/sbin/launchd".into()),
                arguments: vec!["launchd".into()],
                ..FakeProcess::default()
            },
        );
        table.inner.insert(
            600,
            FakeProcess {
                parent: 1,
                uid: UID,
                start: 10,
                executable: Some(codex()),
                arguments: vec!["codex".into()],
                open_files: vec![lock(THREAD)],
                has_terminal: true,
                ..FakeProcess::default()
            },
        );
        table.inner.insert(
            700,
            FakeProcess {
                parent: 600,
                uid: UID,
                start: 11,
                executable: Some("/bin/zsh".into()),
                arguments: vec!["zsh".into()],
                environment: [("CODEX_THREAD_ID".to_string(), THREAD.to_string())].into(),
                ..FakeProcess::default()
            },
        );
        table.inner.insert(
            800,
            FakeProcess {
                parent: 1,
                uid: UID,
                start: 12,
                executable: Some(codex()),
                arguments: vec!["codex".into(), "resume".into(), OTHER.into()],
                ..FakeProcess::default()
            },
        );
        for pid in 900..920 {
            table.inner.insert(
                pid,
                FakeProcess {
                    parent: 1,
                    uid: UID,
                    start: 20,
                    executable: Some("/usr/bin/other".into()),
                    arguments: vec!["other".into()],
                    ..FakeProcess::default()
                },
            );
        }
        Arc::new(table)
    }

    /// Every Codex scan discovery and liveness run in one round.
    fn scan_round(table: &dyn ProcessTable) {
        use crate::relay::codex::processes;
        let threads = BTreeSet::from([THREAD.to_string(), OTHER.to_string()]);
        let sessions = processes::process_sessions(table, UID, &threads);
        assert_eq!(sessions.len(), 3, "{sessions:?}");
        for session in &sessions {
            processes::drains_queue(table, UID, session.pid);
        }
        assert!(processes::open_threads(table, UID).contains(THREAD));
        assert!(processes::reply_capable(table, UID, THREAD));
        assert!(processes::reply_capable(table, UID, OTHER));
        assert!(processes::running_executable(table, UID).is_some());
        assert!(processes::thread_is_live(table, UID, OTHER));
    }

    #[test]
    fn a_round_of_scans_reads_each_process_once() {
        let counting = world();
        let snapshot = ProcessSnapshot::with_window(counting.clone(), Duration::from_secs(3600));
        scan_round(&snapshot);
        assert_eq!(*counting.scans.lock().unwrap(), 1, "one walk of the table");
        let reads = |counts: &Mutex<HashMap<i32, usize>>| {
            counts.lock().unwrap().values().copied().max().unwrap_or(0)
        };
        assert_eq!(reads(&counting.command_lines), 1, "argv and environment");
        assert_eq!(reads(&counting.processes), 1, "owner and parent");
        assert_eq!(reads(&counting.open_files), 1, "open file paths");
        assert_eq!(reads(&counting.opened_files), 1, "open file inodes");

        // The same round without a snapshot repeats them.
        let unshared = world();
        scan_round(unshared.as_ref());
        assert!(*unshared.scans.lock().unwrap() > 1);
        assert!(reads(&unshared.command_lines) > 1);
    }

    #[test]
    fn a_new_window_reads_the_kernel_again() {
        let counting = world();
        let snapshot = ProcessSnapshot::with_window(counting.clone(), Duration::ZERO);
        scan_round(&snapshot);
        scan_round(&snapshot);
        assert!(*counting.scans.lock().unwrap() > 2);
    }

    #[test]
    fn a_process_seen_gone_is_read_again() {
        let counting = world();
        let snapshot = ProcessSnapshot::with_window(counting.clone(), Duration::from_secs(3600));
        assert!(snapshot.process(800).is_some());
        counting.inner.remove(800);
        assert!(snapshot.process(800).is_some(), "kept within the window");
        assert!(snapshot.process_gone(800));
        assert!(snapshot.process(800).is_none());
    }
}
