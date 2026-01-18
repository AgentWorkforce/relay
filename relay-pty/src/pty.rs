//! PTY (pseudo-terminal) management for spawning and communicating with agents.
//!
//! Provides a clean interface for:
//! - Creating a PTY and spawning a child process
//! - Reading output from the child
//! - Writing input to the child (user input and injected messages)
//! - Handling terminal resize (SIGWINCH)

use anyhow::{Context, Result};
use nix::fcntl::{fcntl, FcntlArg, OFlag};
use nix::libc;
use nix::pty::{openpty, OpenptyResult, Winsize};
use nix::sys::signal::{self, Signal};
use nix::sys::wait::{waitpid, WaitPidFlag, WaitStatus};
use nix::unistd::{dup2, execvp, fork, read, setsid, write, ForkResult, Pid};
use std::ffi::CString;
use std::os::fd::{AsRawFd, BorrowedFd, OwnedFd, RawFd};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use tracing::{debug, error, info};

/// Original terminal settings stored outside Pty for thread-safety
static mut ORIGINAL_TERMIOS: Option<libc::termios> = None;

/// PTY handle for communicating with the child process
pub struct Pty {
    /// Master file descriptor
    master_fd: OwnedFd,
    /// Child process ID
    child_pid: Pid,
    /// Whether the child is still running
    running: Arc<AtomicBool>,
}

// Pty is Send because OwnedFd is Send, Pid is Copy, and AtomicBool is Send+Sync
unsafe impl Send for Pty {}

impl Pty {
    /// Create a new PTY and spawn the given command
    /// Optional rows/cols override terminal detection (for headless mode)
    pub fn spawn(command: &[String], rows: Option<u16>, cols: Option<u16>) -> Result<Self> {
        if command.is_empty() {
            anyhow::bail!("Command cannot be empty");
        }

        // Get terminal size: use provided values, or detect, or use defaults
        let winsize = match (rows, cols) {
            (Some(r), Some(c)) => Winsize {
                ws_row: r,
                ws_col: c,
                ws_xpixel: 0,
                ws_ypixel: 0,
            },
            _ => get_terminal_size().unwrap_or(Winsize {
                ws_row: 24,
                ws_col: 80,
                ws_xpixel: 0,
                ws_ypixel: 0,
            }),
        };

        // Open PTY pair
        let OpenptyResult { master, slave } =
            openpty(&winsize, None).context("Failed to open PTY")?;

        // Fork
        match unsafe { fork() }.context("Failed to fork")? {
            ForkResult::Parent { child } => {
                // Close slave in parent
                drop(slave);

                // Set master to non-blocking
                let flags = fcntl(master.as_raw_fd(), FcntlArg::F_GETFL)?;
                let flags = OFlag::from_bits_truncate(flags);
                fcntl(
                    master.as_raw_fd(),
                    FcntlArg::F_SETFL(flags | OFlag::O_NONBLOCK),
                )?;

                info!("Spawned child process with PID {}", child);

                Ok(Self {
                    master_fd: master,
                    child_pid: child,
                    running: Arc::new(AtomicBool::new(true)),
                })
            }
            ForkResult::Child => {
                // Close master in child
                drop(master);

                // Create new session
                setsid().ok();

                // Set controlling terminal
                unsafe {
                    libc::ioctl(slave.as_raw_fd(), libc::TIOCSCTTY as libc::c_ulong, 0);
                }

                // Redirect stdin/stdout/stderr to slave
                let slave_raw = slave.as_raw_fd();
                dup2(slave_raw, libc::STDIN_FILENO).ok();
                dup2(slave_raw, libc::STDOUT_FILENO).ok();
                dup2(slave_raw, libc::STDERR_FILENO).ok();

                // Close original slave fd if it's not 0, 1, or 2
                if slave_raw > 2 {
                    drop(slave);
                }

                // Execute command
                let cmd = CString::new(command[0].as_str()).unwrap();
                let args: Vec<CString> = command
                    .iter()
                    .map(|s| CString::new(s.as_str()).unwrap())
                    .collect();

                execvp(&cmd, &args).expect("Failed to exec");
                #[allow(unreachable_code)]
                {
                    unreachable!("execvp should never return")
                }
            }
        }
    }

    /// Get the master file descriptor
    pub fn master_fd(&self) -> RawFd {
        self.master_fd.as_raw_fd()
    }

    /// Get the child process ID
    pub fn child_pid(&self) -> Pid {
        self.child_pid
    }

    /// Check if child is still running
    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    /// Get a clone of the running flag
    pub fn running_flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.running)
    }

    /// Check if stdin is a TTY
    pub fn is_tty() -> bool {
        unsafe { libc::isatty(libc::STDIN_FILENO) != 0 }
    }

    /// Set raw mode on stdin for transparent terminal passthrough.
    /// Returns Ok(false) if stdin is not a TTY (headless mode).
    /// Returns Ok(true) if raw mode was successfully set.
    pub fn set_raw_mode() -> Result<bool> {
        let stdin_fd = libc::STDIN_FILENO;

        // Check if stdin is a TTY - if not, skip raw mode (headless mode)
        if !Self::is_tty() {
            debug!("stdin is not a TTY, skipping raw mode (headless mode)");
            return Ok(false);
        }

        unsafe {
            // Save original settings
            let mut termios: libc::termios = std::mem::zeroed();
            if libc::tcgetattr(stdin_fd, &mut termios) != 0 {
                anyhow::bail!("Failed to get terminal attributes");
            }
            ORIGINAL_TERMIOS = Some(termios);

            // Set raw mode
            let mut raw = termios;
            raw.c_lflag &= !(libc::ECHO | libc::ICANON | libc::ISIG | libc::IEXTEN);
            raw.c_iflag &= !(libc::IXON | libc::ICRNL);
            raw.c_oflag &= !(libc::OPOST);

            if libc::tcsetattr(stdin_fd, libc::TCSANOW, &raw) != 0 {
                anyhow::bail!("Failed to set raw mode");
            }
        }

        debug!("Terminal set to raw mode");
        Ok(true)
    }

    /// Restore original terminal settings
    pub fn restore_terminal() {
        unsafe {
            if let Some(ref termios) = ORIGINAL_TERMIOS {
                libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, termios);
                debug!("Terminal restored");
            }
        }
    }

    /// Resize the PTY
    pub fn resize(&self, rows: u16, cols: u16) -> Result<()> {
        let winsize = Winsize {
            ws_row: rows,
            ws_col: cols,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };

        unsafe {
            if libc::ioctl(self.master_fd.as_raw_fd(), libc::TIOCSWINSZ, &winsize) < 0 {
                anyhow::bail!("Failed to resize PTY");
            }
        }

        debug!("PTY resized to {}x{}", cols, rows);
        Ok(())
    }

    /// Write data to the PTY (send to child)
    pub fn write_data(&self, data: &[u8]) -> Result<usize> {
        match write(&self.master_fd, data) {
            Ok(n) => Ok(n),
            Err(nix::errno::Errno::EAGAIN) => Ok(0),
            Err(e) => Err(e.into()),
        }
    }

    /// Read data from the PTY (output from child)
    pub fn read_data(&self, buf: &mut [u8]) -> Result<usize> {
        match read(self.master_fd.as_raw_fd(), buf) {
            Ok(n) => Ok(n),
            Err(nix::errno::Errno::EAGAIN) => Ok(0),
            Err(nix::errno::Errno::EIO) => {
                // EIO typically means the child closed the terminal
                self.running.store(false, Ordering::SeqCst);
                Ok(0)
            }
            Err(e) => Err(e.into()),
        }
    }

    /// Check child status without blocking
    pub fn check_child(&self) -> Option<i32> {
        match waitpid(self.child_pid, Some(WaitPidFlag::WNOHANG)) {
            Ok(WaitStatus::Exited(_, code)) => {
                self.running.store(false, Ordering::SeqCst);
                Some(code)
            }
            Ok(WaitStatus::Signaled(_, sig, _)) => {
                self.running.store(false, Ordering::SeqCst);
                Some(128 + sig as i32)
            }
            Ok(WaitStatus::StillAlive) => None,
            Ok(_) => None,
            Err(_) => {
                self.running.store(false, Ordering::SeqCst);
                Some(-1)
            }
        }
    }

    /// Send a signal to the child process
    pub fn signal(&self, sig: Signal) -> Result<()> {
        signal::kill(self.child_pid, sig)?;
        Ok(())
    }
}

impl Drop for Pty {
    fn drop(&mut self) {
        Pty::restore_terminal();

        // Kill child if still running
        if self.is_running() {
            let _ = self.signal(Signal::SIGTERM);
        }
    }
}

/// Get current terminal size
fn get_terminal_size() -> Option<Winsize> {
    let mut winsize = Winsize {
        ws_row: 0,
        ws_col: 0,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };

    unsafe {
        if libc::ioctl(libc::STDOUT_FILENO, libc::TIOCGWINSZ, &mut winsize) == 0 {
            Some(winsize)
        } else {
            None
        }
    }
}

/// Async PTY wrapper for use with tokio
///
/// This creates background threads for reading/writing since PTY operations
/// are blocking even in non-blocking mode (need to poll).
pub struct AsyncPty {
    /// Channel for incoming data from PTY
    output_rx: mpsc::Receiver<Vec<u8>>,
    /// Channel for outgoing data to PTY
    input_tx: mpsc::Sender<Vec<u8>>,
    /// Running flag
    running: Arc<AtomicBool>,
    /// Child PID
    child_pid: Pid,
    /// Master FD (for resize)
    master_fd: RawFd,
    /// Owned PTY for lifecycle management
    pty: Option<Pty>,
}

impl AsyncPty {
    /// Create an async wrapper around the PTY
    pub fn new(pty: Pty) -> Self {
        let running = pty.running_flag();
        let child_pid = pty.child_pid();
        let master_fd = pty.master_fd();

        let (output_tx, output_rx) = mpsc::channel(64);
        let (input_tx, input_rx) = mpsc::channel(64);

        // Spawn reader thread (not async task, since PTY is sync)
        let reader_running = Arc::clone(&running);
        let reader_fd = master_fd;
        std::thread::spawn(move || {
            Self::reader_thread(reader_fd, reader_running, output_tx);
        });

        // Spawn writer thread
        let writer_running = Arc::clone(&running);
        let writer_fd = master_fd;
        std::thread::spawn(move || {
            Self::writer_thread(writer_fd, writer_running, input_rx);
        });

        Self {
            output_rx,
            input_tx,
            running,
            child_pid,
            master_fd,
            pty: Some(pty),
        }
    }

    fn reader_thread(fd: RawFd, running: Arc<AtomicBool>, tx: mpsc::Sender<Vec<u8>>) {
        let mut buf = [0u8; 4096];
        loop {
            if !running.load(Ordering::SeqCst) {
                break;
            }

            match nix::unistd::read(fd, &mut buf) {
                Ok(0) => {
                    // EOF
                    running.store(false, Ordering::SeqCst);
                    break;
                }
                Ok(n) => {
                    if tx.blocking_send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(nix::errno::Errno::EAGAIN) => {
                    // No data available, wait a bit
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                Err(nix::errno::Errno::EIO) => {
                    // Child closed
                    running.store(false, Ordering::SeqCst);
                    break;
                }
                Err(e) => {
                    error!("PTY read error: {}", e);
                    running.store(false, Ordering::SeqCst);
                    break;
                }
            }
        }
        debug!("Reader thread exiting");
    }

    fn writer_thread(fd: RawFd, running: Arc<AtomicBool>, mut rx: mpsc::Receiver<Vec<u8>>) {
        while let Some(data) = rx.blocking_recv() {
            if !running.load(Ordering::SeqCst) {
                break;
            }

            let mut written = 0;
            while written < data.len() {
                // Create a borrowed fd for write
                let borrowed = unsafe { BorrowedFd::borrow_raw(fd) };
                match write(borrowed, &data[written..]) {
                    Ok(n) => {
                        written += n;
                    }
                    Err(nix::errno::Errno::EAGAIN) => {
                        std::thread::sleep(std::time::Duration::from_millis(1));
                    }
                    Err(e) => {
                        error!("PTY write error: {}", e);
                        break;
                    }
                }
            }
        }
        debug!("Writer thread exiting");
    }

    /// Receive output from the PTY
    pub async fn recv(&mut self) -> Option<Vec<u8>> {
        self.output_rx.recv().await
    }

    /// Send input to the PTY
    pub async fn send(&self, data: Vec<u8>) -> Result<()> {
        self.input_tx
            .send(data)
            .await
            .map_err(|_| anyhow::anyhow!("PTY channel closed"))
    }

    /// Check if the child is running
    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    /// Resize the PTY
    pub fn resize(&self, rows: u16, cols: u16) -> Result<()> {
        let winsize = Winsize {
            ws_row: rows,
            ws_col: cols,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };

        unsafe {
            if libc::ioctl(self.master_fd, libc::TIOCSWINSZ, &winsize) < 0 {
                anyhow::bail!("Failed to resize PTY");
            }
        }

        Ok(())
    }

    /// Send a signal to the child process
    pub fn signal(&self, sig: Signal) -> Result<()> {
        signal::kill(self.child_pid, sig)?;
        Ok(())
    }

    /// Terminate the child process and reap it.
    pub fn shutdown(&mut self) -> Result<()> {
        self.running.store(false, Ordering::SeqCst);
        let _ = self.signal(Signal::SIGTERM);

        let start = Instant::now();
        let mut reaped = false;
        let mut sent_kill = false;

        while start.elapsed() < Duration::from_secs(2) {
            match waitpid(self.child_pid, Some(WaitPidFlag::WNOHANG)) {
                Ok(WaitStatus::Exited(_, _)) | Ok(WaitStatus::Signaled(_, _, _)) => {
                    reaped = true;
                    break;
                }
                Ok(WaitStatus::StillAlive) => {
                    std::thread::sleep(Duration::from_millis(50));
                }
                Ok(_) => {
                    reaped = true;
                    break;
                }
                Err(nix::errno::Errno::ECHILD) => {
                    reaped = true;
                    break;
                }
                Err(e) => return Err(e.into()),
            }
        }

        if !reaped {
            let _ = self.signal(Signal::SIGKILL);
            sent_kill = true;
        }

        if sent_kill {
            let _ = waitpid(self.child_pid, None);
        }

        self.pty.take();
        Ok(())
    }
}

impl Drop for AsyncPty {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_spawn_empty_command_fails() {
        let result = Pty::spawn(&[], None, None);
        assert!(result.is_err());
    }

    #[test]
    fn test_get_terminal_size() {
        // This test may fail in CI without a terminal
        let size = get_terminal_size();
        if let Some(ws) = size {
            assert!(ws.ws_row > 0 || ws.ws_col > 0);
        }
    }
}
