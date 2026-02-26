use std::{
    env,
    ffi::OsString,
    io::{Read, Write},
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
};

use anyhow::{Context, Result};
use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tokio::sync::mpsc;

pub struct PtySession {
    master: Box<dyn portable_pty::MasterPty>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send>>>,
    child_pid: Option<u32>,
    reaped: Arc<AtomicBool>,
    /// Counts consecutive watchdog checks where try_wait returned Ok(None)
    /// AND we had no PID to verify with kill(0). After a threshold, we
    /// assume the child is gone (macOS PTY quirk).
    no_pid_alive_checks: std::sync::atomic::AtomicU32,
}

fn canonicalize_display(path: &Path) -> String {
    std::fs::canonicalize(path)
        .ok()
        .and_then(|resolved| resolved.to_str().map(|s| s.to_string()))
        .unwrap_or_else(|| path.to_string_lossy().to_string())
}

fn resolve_command_path(command: &str) -> String {
    // Already a path (absolute or relative): use as-is but resolve symlinks when possible.
    if command.contains('/') || command.contains('\\') || command.starts_with('.') {
        return canonicalize_display(Path::new(command));
    }

    let path_env = env::var_os("PATH")
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            #[cfg(unix)]
            {
                OsString::from("/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin")
            }
            #[cfg(windows)]
            {
                OsString::from(r"C:\Windows\System32;C:\Windows")
            }
        });

    for dir in env::split_paths(&path_env) {
        let candidate = dir.join(command);
        if candidate.is_file() {
            return canonicalize_display(&candidate);
        }
    }

    command.to_string()
}

impl PtySession {
    pub fn spawn(
        command: &str,
        args: &[String],
        rows: u16,
        cols: u16,
    ) -> Result<(Self, mpsc::Receiver<Vec<u8>>)> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("failed to open pty")?;

        let resolved_command = resolve_command_path(command);
        let mut cmd = CommandBuilder::new(&resolved_command);
        cmd.cwd(std::env::current_dir().context("failed to get current directory")?);
        for arg in args {
            cmd.arg(arg);
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .context("failed to spawn wrapped command")?;
        let child_pid = child.process_id();

        let mut reader = pair
            .master
            .try_clone_reader()
            .context("failed to clone pty reader")?;
        let writer = pair
            .master
            .take_writer()
            .context("failed to take pty writer")?;

        let (tx, rx) = mpsc::channel(256);
        thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if tx.blocking_send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        Ok((
            Self {
                master: pair.master,
                writer: Arc::new(Mutex::new(writer)),
                child: Arc::new(Mutex::new(child)),
                child_pid,
                reaped: Arc::new(AtomicBool::new(false)),
                no_pid_alive_checks: std::sync::atomic::AtomicU32::new(0),
            },
            rx,
        ))
    }

    pub fn write_all(&self, bytes: &[u8]) -> Result<()> {
        let mut guard = self.writer.lock();
        guard.write_all(bytes)?;
        guard.flush()?;
        Ok(())
    }

    pub fn resize(&self, rows: u16, cols: u16) -> Result<()> {
        self.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("failed to resize pty")
    }

    /// Check if the child process has exited without blocking.
    /// Returns true if the child has exited (or was already reaped).
    ///
    /// Uses three detection mechanisms:
    /// 1. `try_wait()` (waitpid with WNOHANG)
    /// 2. `kill(pid, 0)` to check process existence (Unix only)
    /// 3. Consecutive no-PID fallback: if we never obtained a PID and try_wait
    ///    keeps returning Ok(None), after several checks we assume the child
    ///    is gone (works around a macOS PTY quirk where portable-pty's
    ///    `process_id()` returns None and try_wait never transitions).
    pub fn has_exited(&self) -> bool {
        // Number of consecutive no-PID Ok(None) checks before we declare
        // the child gone. At 5s watchdog interval this is ~30s.
        const NO_PID_THRESHOLD: u32 = 6;

        // Fast path: already known to be reaped.
        if self.reaped.load(Ordering::Relaxed) {
            return true;
        }

        // Try waitpid(WNOHANG) via portable-pty.
        // Also re-query process_id() in case it becomes available after spawn.
        let live_pid: Option<u32>;
        {
            let mut child = self.child.lock();
            match child.try_wait() {
                Ok(Some(_status)) => {
                    // Child exited and we successfully reaped it.
                    tracing::info!(
                        target = "agent_relay::worker::pty",
                        pid = ?self.child_pid,
                        "has_exited: try_wait returned Ok(Some) — child reaped"
                    );
                    self.reaped.store(true, Ordering::Relaxed);
                    return true;
                }
                Ok(None) => {
                    // Child still running according to waitpid.
                }
                Err(e) => {
                    // ECHILD or other error — child was already reaped by
                    // someone else (e.g. shutdown() or a signal handler).
                    tracing::info!(
                        target = "agent_relay::worker::pty",
                        pid = ?self.child_pid,
                        error = %e,
                        "has_exited: try_wait returned Err — treating as exited"
                    );
                    self.reaped.store(true, Ordering::Relaxed);
                    return true;
                }
            }
            // Re-query PID from the child object (may succeed now even if it
            // was None at spawn time on some platforms).
            live_pid = child.process_id().or(self.child_pid);
        }

        // Fallback: use kill(pid, 0) to check if the process still exists.
        // This catches the case where waitpid is confused but the process
        // is truly gone.
        #[cfg(unix)]
        if let Some(pid) = live_pid {
            // We have a PID, so reset the no-PID counter.
            self.no_pid_alive_checks.store(0, Ordering::Relaxed);

            // SAFETY: kill with signal 0 doesn't send a signal, just checks existence.
            let ret = unsafe { libc::kill(pid as libc::pid_t, 0) };
            if ret == -1 {
                let errno = std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
                if errno == libc::ESRCH {
                    // No such process — child is gone.
                    tracing::info!(
                        target = "agent_relay::worker::pty",
                        pid = pid,
                        "has_exited: kill(0) returned ESRCH — process gone"
                    );
                    self.reaped.store(true, Ordering::Relaxed);
                    return true;
                }
            }

            tracing::trace!(
                target = "agent_relay::worker::pty",
                pid = pid,
                "has_exited: child appears alive"
            );
            return false;
        }

        // No PID available (portable-pty returned None both at spawn and now).
        // try_wait said Ok(None), but on macOS this can be unreliable when the
        // child was spawned through a PTY and the PID is unknown.
        // Increment the counter; after NO_PID_THRESHOLD consecutive checks we
        // assume the child is gone.
        #[cfg(unix)]
        {
            let count = self.no_pid_alive_checks.fetch_add(1, Ordering::Relaxed) + 1;
            tracing::debug!(
                target = "agent_relay::worker::pty",
                consecutive_checks = count,
                threshold = NO_PID_THRESHOLD,
                "has_exited: no PID available, try_wait says Ok(None)"
            );
            if count >= NO_PID_THRESHOLD {
                tracing::warn!(
                    target = "agent_relay::worker::pty",
                    consecutive_checks = count,
                    "has_exited: no PID and try_wait stuck at Ok(None) for {} checks — assuming child exited",
                    count
                );
                self.reaped.store(true, Ordering::Relaxed);
                return true;
            }
        }

        #[cfg(not(unix))]
        {
            tracing::trace!(
                target = "agent_relay::worker::pty",
                pid = ?live_pid,
                "has_exited: child appears alive"
            );
        }

        false
    }

    /// Reset the no-PID alive check counter. Call this when PTY output is
    /// received, proving the child is still alive regardless of PID availability.
    pub fn reset_no_pid_checks(&self) {
        self.no_pid_alive_checks.store(0, Ordering::Relaxed);
    }

    pub fn shutdown(&self) -> Result<()> {
        // If already reaped (by has_exited or try_wait), skip kill/wait
        // to avoid blocking forever on waitpid for a non-existent child.
        if self.reaped.load(Ordering::Relaxed) {
            return Ok(());
        }
        let mut child = self.child.lock();
        let _ = child.kill();
        // Use try_wait instead of wait to avoid blocking if the child
        // was already reaped between the check above and here.
        match child.try_wait() {
            Ok(Some(_)) | Err(_) => {
                // Child reaped or error (ECHILD) — done.
            }
            Ok(None) => {
                // Child still running after kill — wait with a timeout.
                // We give it 2 seconds; if it doesn't exit, move on.
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
                loop {
                    match child.try_wait() {
                        Ok(Some(_)) | Err(_) => break,
                        Ok(None) => {
                            if std::time::Instant::now() >= deadline {
                                tracing::warn!(
                                    target = "agent_relay::worker::pty",
                                    "shutdown: child did not exit within 2s after kill"
                                );
                                break;
                            }
                            std::thread::sleep(std::time::Duration::from_millis(50));
                        }
                    }
                }
            }
        }
        self.reaped.store(true, Ordering::Relaxed);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::PtySession;
    use tokio::time::{timeout, Duration};

    #[tokio::test]
    async fn spawn_echo_and_read() {
        let (pty, mut rx) = PtySession::spawn("echo", &["hello".into()], 24, 80).unwrap();
        let mut collected = Vec::new();
        while let Ok(Some(chunk)) = timeout(Duration::from_secs(2), rx.recv()).await {
            collected.extend_from_slice(&chunk);
            if String::from_utf8_lossy(&collected).contains("hello") {
                break;
            }
        }
        assert!(String::from_utf8_lossy(&collected).contains("hello"));
        let _ = pty.shutdown();
    }

    #[tokio::test]
    async fn resize_does_not_error() {
        let (pty, _rx) = PtySession::spawn("sleep", &["1".into()], 24, 80).unwrap();
        assert!(pty.resize(40, 120).is_ok());
        let _ = pty.shutdown();
    }

    #[tokio::test]
    async fn has_exited_detects_quick_exit() {
        let (pty, _rx) = PtySession::spawn("true", &[], 24, 80).unwrap();
        // `true` exits immediately. Give it a moment.
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert!(
            pty.has_exited(),
            "has_exited() should detect that `true` has exited; child_pid={:?}",
            pty.child_pid
        );
    }

    #[tokio::test]
    async fn has_exited_false_while_running() {
        let (pty, _rx) = PtySession::spawn("sleep", &["30".into()], 24, 80).unwrap();
        assert!(
            !pty.has_exited(),
            "has_exited() should return false while child is running"
        );
        let _ = pty.shutdown();
    }

    #[tokio::test]
    async fn has_exited_after_shutdown() {
        let (pty, _rx) = PtySession::spawn("sleep", &["30".into()], 24, 80).unwrap();
        let _ = pty.shutdown();
        assert!(
            pty.has_exited(),
            "has_exited() should return true after shutdown"
        );
    }

    #[tokio::test]
    async fn shutdown_terminates() {
        let (pty, mut rx) = PtySession::spawn("sleep", &["30".into()], 24, 80).unwrap();
        assert!(pty.shutdown().is_ok());
        // After shutdown, receiver should eventually close
        let result = timeout(Duration::from_secs(2), rx.recv()).await;
        assert!(result.is_ok()); // timeout didn't fire; channel closed
    }
}
