//! A process table tests write, so no test starts a real session.

use super::{file_birth_ns, CommandLine, OpenedFile, ProcessInfo, ProcessTable, StartClock};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

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
/// Executables in `trusted_codex` count as trusted Codex, those in
/// `trusted_cursor` as Cursor's own.
#[derive(Default)]
pub struct FakeProcesses {
    pub processes: std::sync::Mutex<HashMap<i32, FakeProcess>>,
    pub trusted_codex: std::sync::Mutex<std::collections::HashSet<PathBuf>>,
    pub trusted_cursor: std::sync::Mutex<std::collections::HashSet<PathBuf>>,
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

    pub fn trust_cursor(&self, executable: impl Into<PathBuf>) {
        self.trusted_cursor
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(executable.into());
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
        // `codex`, or `codex.exe` on Windows.
        executable.file_stem().is_some_and(|name| name == "codex")
            && self.trusted_codex.lock().unwrap().contains(executable)
    }
    fn is_trusted_cursor(&self, executable: &Path) -> bool {
        self.trusted_cursor
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .contains(executable)
    }
    fn command_line(&self, pid: i32) -> CommandLine {
        let unreadable = self
            .unreadable_environment
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .contains(&pid);
        self.with(pid, |p| CommandLine {
            arguments: p.arguments.clone(),
            environment: (!unreadable).then(|| {
                p.environment
                    .iter()
                    .map(|(name, value)| format!("{name}={value}"))
                    .collect()
            }),
        })
        .unwrap_or_default()
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
