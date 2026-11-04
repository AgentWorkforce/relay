//! Private detached terminal owner for a spawned Muse. PTY creation and
//! signal registration use safe library APIs. The host drains output, never
//! sends keystrokes, and explicitly terminates/reaps its owned child on stop.

use crate::relay::process::{ProcessTable, SystemProcesses};
use nix::fcntl::{fcntl, FcntlArg, OFlag};
use nix::sys::signal::{killpg, Signal};
use nix::unistd::Pid;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

struct Interrupts {
    stop: Arc<AtomicBool>,
    registrations: Vec<signal_hook::SigId>,
}

impl Interrupts {
    fn install() -> std::io::Result<Self> {
        let mut installed = Self {
            stop: Arc::new(AtomicBool::new(false)),
            registrations: Vec::new(),
        };
        for signal in [
            signal_hook::consts::SIGTERM,
            signal_hook::consts::SIGINT,
            signal_hook::consts::SIGHUP,
        ] {
            installed
                .registrations
                .push(signal_hook::flag::register(signal, installed.stop.clone())?);
        }
        Ok(installed)
    }
}

impl Drop for Interrupts {
    fn drop(&mut self) {
        for registration in self.registrations.drain(..) {
            signal_hook::low_level::unregister(registration);
        }
    }
}

struct ChildGroup {
    child: Box<dyn portable_pty::Child + Send + Sync>,
    reaped: bool,
}

impl ChildGroup {
    fn signal(&self, signal: Signal) {
        if !self.reaped {
            // The PTY library starts this direct child as a session leader.
            // An unreaped child cannot have its pid recycled beneath us.
            if let Some(pid) = self.child.process_id() {
                let _ = killpg(Pid::from_raw(pid as i32), signal);
            }
        }
    }
}

impl Drop for ChildGroup {
    fn drop(&mut self) {
        if !self.reaped {
            self.signal(Signal::SIGKILL);
            let _ = self.child.wait();
        }
    }
}

pub fn run(executable: &Path, log: &Path, arguments: &[String]) -> anyhow::Result<()> {
    let output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(log)?;
    let terminal = native_pty_system().openpty(PtySize {
        rows: 40,
        cols: 120,
        pixel_width: 0,
        pixel_height: 0,
    })?;
    let fd = terminal
        .master
        .as_raw_fd()
        .ok_or_else(|| anyhow::anyhow!("Muse's terminal does not expose its reader"))?;
    let flags = OFlag::from_bits_truncate(fcntl(fd, FcntlArg::F_GETFL)?);
    // Duplicated readers share these descriptor flags. A cancellable drain
    // must never block on a descendant that keeps the terminal open.
    fcntl(fd, FcntlArg::F_SETFL(flags | OFlag::O_NONBLOCK))?;
    let reader = terminal.master.try_clone_reader()?;
    let interrupts = Interrupts::install()?;
    super::hosts::begin(log)?;
    let mut command = CommandBuilder::new(executable);
    command.args(arguments);
    command.cwd(std::env::current_dir()?);
    let mut child = ChildGroup {
        child: terminal.slave.spawn_command(command)?,
        reaped: false,
    };
    drop(terminal.slave);
    // Keep the master open for this child's lifetime. The reader has a
    // separate descriptor; no writer or terminal input is ever created.
    let _master = terminal.master;
    let drain = Drain::new(reader, output);
    let processes = SystemProcesses::default();
    let mut stopping = None;
    let status = loop {
        // Never reap a naturally exited leader before ending its remaining
        // group. This kernel observation leaves our direct child unreaped,
        // reserving the group identity even if a grandchild ignores HUP/TERM.
        let exited = child
            .child
            .process_id()
            .is_some_and(|pid| processes.zombie(pid as i32));
        if exited {
            child.signal(Signal::SIGKILL);
        }
        if stopping.is_none() && (interrupts.stop.load(Ordering::Relaxed) || drain.is_finished()) {
            child.signal(Signal::SIGTERM);
            stopping = Some(Instant::now());
        }
        if stopping.is_some_and(|at| at.elapsed() >= Duration::from_secs(3)) {
            child.signal(Signal::SIGKILL);
        }
        // Keep the direct child unreaped through the grace period. That
        // reserves its group identity while stubborn grandchildren are killed.
        if exited || stopping.is_some_and(|at| at.elapsed() >= Duration::from_secs(3)) {
            if let Some(status) = child.child.try_wait()? {
                child.reaped = true;
                break status;
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    drop(drain);
    let _ = crate::relay::detach::record_exit(
        &log.with_extension("exit"),
        &status.exit_code().to_string(),
    );
    anyhow::ensure!(
        status.success(),
        "Muse exited without completing successfully"
    );
    Ok(())
}

struct Drain {
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Drain {
    fn new(reader: Box<dyn Read + Send>, output: File) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let cancelled = stop.clone();
        Self {
            stop,
            thread: Some(std::thread::spawn(move || drain(reader, output, cancelled))),
        }
    }
    fn is_finished(&self) -> bool {
        self.thread
            .as_ref()
            .is_none_or(|thread| thread.is_finished())
    }
}
impl Drop for Drain {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
fn drain(mut reader: Box<dyn Read + Send>, mut output: File, stop: Arc<AtomicBool>) {
    let mut buffer = [0u8; 8192];
    let mut stop_at = None;
    loop {
        if stop.load(Ordering::Relaxed) {
            let deadline =
                stop_at.get_or_insert_with(|| Instant::now() + Duration::from_millis(100));
            if Instant::now() >= *deadline {
                return;
            }
        }
        match reader.read(&mut buffer) {
            Ok(0) => return,
            Ok(n) => {
                if output.write_all(&buffer[..n]).is_err() {
                    return;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                if stop.load(Ordering::Relaxed) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            // Linux reports EIO rather than EOF after the final slave closes.
            Err(_) => return,
        }
    }
}

#[cfg(test)]
mod tests;
