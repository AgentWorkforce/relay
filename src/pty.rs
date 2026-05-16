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

use alacritty_terminal::event::VoidListener;
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line, Point};
use alacritty_terminal::term::{Config, Term};
use alacritty_terminal::vte::ansi::Processor;
use anyhow::{Context, Result};
use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tokio::sync::mpsc;

/// Cell dimensions for a parsed VT grid. Implements
/// `alacritty_terminal::grid::Dimensions` so `Term::new` / `Term::resize`
/// accept it directly without pulling in the test-helper `TermSize`.
#[derive(Clone, Copy, Debug)]
struct GridSize {
    columns: usize,
    screen_lines: usize,
}

impl Dimensions for GridSize {
    fn total_lines(&self) -> usize {
        self.screen_lines
    }
    fn screen_lines(&self) -> usize {
        self.screen_lines
    }
    fn columns(&self) -> usize {
        self.columns
    }
}

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
    /// VT100 grid kept in sync with PTY output. The reader thread
    /// advances `processor` on every chunk; queries (`screen_text`,
    /// `cursor_position`, `cell_at`) read `term` under the same lock.
    term: Arc<Mutex<Term<VoidListener>>>,
    /// Held on the struct only to extend the parser's lifetime to that
    /// of the session — the reader thread owns a clone that does the
    /// actual `advance()` calls. Future readers (e.g. a control-plane
    /// thread that wants to feed bytes synthetically) would lock this.
    #[allow(dead_code)]
    processor: Arc<Mutex<Processor>>,
}

fn needs_sane_term_override() -> bool {
    match env::var("TERM") {
        Ok(term) => {
            let trimmed = term.trim();
            trimmed.is_empty() || trimmed.eq_ignore_ascii_case("dumb")
        }
        Err(_) => true,
    }
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
                let home = env::var("HOME").unwrap_or_else(|_| String::from("/root"));
                OsString::from(format!(
                    "{home}/.local/bin:{home}/.opencode/bin:{home}/.claude/local:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin"
                ))
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
        if needs_sane_term_override() {
            cmd.env("TERM", "xterm-256color");
        }
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

        let size = GridSize {
            columns: cols as usize,
            screen_lines: rows as usize,
        };
        let term = Arc::new(Mutex::new(Term::new(
            Config::default(),
            &size,
            VoidListener,
        )));
        let processor = Arc::new(Mutex::new(Processor::new()));

        let (tx, rx) = mpsc::channel(256);
        let term_clone = term.clone();
        let processor_clone = processor.clone();
        thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        {
                            // Hold both locks together so the grid stays
                            // consistent with the bytes about to be sent.
                            let mut processor_guard = processor_clone.lock();
                            let mut term_guard = term_clone.lock();
                            processor_guard.advance(&mut *term_guard, &buf[..n]);
                        }
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
                term,
                processor,
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
            .context("failed to resize pty")?;
        let size = GridSize {
            columns: cols as usize,
            screen_lines: rows as usize,
        };
        self.term.lock().resize(size);
        Ok(())
    }

    /// Cursor position as **1-indexed `(row, col)`** matching how
    /// `WaitCondition::Cursor` and the public API talk about cells.
    pub fn cursor_position(&self) -> (u16, u16) {
        let term = self.term.lock();
        let point: Point = term.grid().cursor.point;
        // Clamp negative scrollback lines to 0 — we only care about the
        // visible viewport here.
        let row = (point.line.0.max(0) as u16).saturating_add(1);
        let col = (point.column.0 as u16).saturating_add(1);
        (row, col)
    }

    /// Render the visible grid as plain text — one row per line, trailing
    /// blank cells trimmed. Useful for snapshots, debug commands, and
    /// substring-match readiness checks that want the **rendered** screen
    /// rather than the raw byte stream.
    pub fn screen_text(&self) -> String {
        let term = self.term.lock();
        let grid = term.grid();
        let columns = grid.columns();
        let lines = grid.screen_lines();
        let mut out = String::with_capacity(lines * (columns + 1));
        for row_index in 0..lines {
            let line = Line(row_index as i32);
            for col in 0..columns {
                let cell = &grid[line][Column(col)];
                out.push(cell.c);
            }
            // Trim trailing spaces per row so empty cells don't pollute
            // pattern matching downstream.
            while out.ends_with(' ') {
                out.pop();
            }
            out.push('\n');
        }
        out
    }

    /// Character at a **1-indexed `(row, col)`** cell, or `None` if the
    /// coordinates are outside the visible grid.
    pub fn cell_at(&self, row: u16, col: u16) -> Option<char> {
        if row == 0 || col == 0 {
            return None;
        }
        let term = self.term.lock();
        let grid = term.grid();
        let line_idx = (row as usize) - 1;
        let col_idx = (col as usize) - 1;
        if line_idx >= grid.screen_lines() || col_idx >= grid.columns() {
            return None;
        }
        Some(grid[Line(line_idx as i32)][Column(col_idx)].c)
    }

    /// Current grid dimensions as `(rows, cols)`.
    pub fn grid_size(&self) -> (u16, u16) {
        let term = self.term.lock();
        let grid = term.grid();
        (grid.screen_lines() as u16, grid.columns() as u16)
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
    use super::{GridSize, PtySession};
    use alacritty_terminal::event::VoidListener;
    use alacritty_terminal::term::{Config, Term};
    use alacritty_terminal::vte::ansi::Processor;
    use std::env;
    use tokio::time::{timeout, Duration};

    /// Build a standalone Term + Processor pair the same way `spawn`
    /// does, so we can drive the parser with recorded byte streams
    /// without needing a real child process.
    fn parse_into(rows: u16, cols: u16, chunks: &[&[u8]]) -> Term<VoidListener> {
        let size = GridSize {
            columns: cols as usize,
            screen_lines: rows as usize,
        };
        let mut term = Term::new(Config::default(), &size, VoidListener);
        // Bind to the default `Processor<StdSyncHandler>` shape so the
        // compiler can infer `T` without a fully-qualified ascription.
        let mut processor: Processor = Processor::new();
        for chunk in chunks {
            processor.advance(&mut term, chunk);
        }
        term
    }

    /// Render the screen the same way `PtySession::screen_text` does
    /// but from a free-standing `Term` (used by the offline tests).
    fn render(term: &Term<VoidListener>) -> String {
        use alacritty_terminal::grid::Dimensions;
        use alacritty_terminal::index::{Column, Line};
        let grid = term.grid();
        let mut out = String::new();
        for row in 0..grid.screen_lines() {
            for col in 0..grid.columns() {
                out.push(grid[Line(row as i32)][Column(col)].c);
            }
            while out.ends_with(' ') {
                out.pop();
            }
            out.push('\n');
        }
        out
    }

    #[test]
    fn parser_writes_plain_text_to_grid() {
        let term = parse_into(4, 20, &[b"hello world"]);
        let screen = render(&term);
        assert!(screen.starts_with("hello world\n"));
    }

    #[test]
    fn parser_tracks_cursor_position() {
        // Move the cursor to row 3, col 5 (1-indexed CUP: ESC[3;5H).
        let term = parse_into(10, 40, &[b"\x1b[3;5H"]);
        let point = term.grid().cursor.point;
        // alacritty 0-indexes both axes; CUP at 3;5 lands at line 2, col 4.
        assert_eq!(point.line.0, 2);
        assert_eq!(point.column.0, 4);
    }

    #[test]
    fn parser_handles_carriage_return_overwrite() {
        // "hello\rworld" → "world" because \r returns to col 0 and
        // "world" overwrites "hello".
        let term = parse_into(4, 20, &[b"hello\rworld"]);
        assert!(render(&term).starts_with("world\n"));
    }

    #[test]
    fn parser_strips_csi_color_sequences_from_visible_text() {
        // Standard ANSI green wrapper around "OK" should leave only "OK"
        // in the cells — color attrs land on the cell, not in the char.
        let term = parse_into(4, 20, &[b"\x1b[32mOK\x1b[0m"]);
        let screen = render(&term);
        assert!(screen.starts_with("OK\n"), "got: {screen:?}");
    }

    #[test]
    fn parser_handles_clear_screen() {
        // Write text, then ESC[2J ESC[H to clear and home-cursor.
        let term = parse_into(
            4,
            20,
            &[b"garbage", b"\x1b[2J\x1b[H", b"fresh"],
        );
        let screen = render(&term);
        assert!(
            screen.starts_with("fresh\n"),
            "after clear+home, fresh should land at row 0: {screen:?}"
        );
    }

    #[test]
    fn parser_advances_across_chunks() {
        // The same total payload split across multiple chunks must
        // produce the same grid as one chunk — proves the Processor's
        // state survives between calls.
        let one_shot = parse_into(4, 20, &[b"\x1b[2;3Hxy"]);
        let split = parse_into(4, 20, &[b"\x1b[2", b";3Hx", b"y"]);
        assert_eq!(render(&one_shot), render(&split));
    }

    #[tokio::test]
    async fn live_pty_populates_grid_with_echo_output() {
        let (pty, mut rx) = PtySession::spawn("echo", &["hello-grid".into()], 24, 80).unwrap();
        // Drain the channel until we've seen the echoed text.
        let mut collected = Vec::new();
        while let Ok(Some(chunk)) = timeout(Duration::from_secs(2), rx.recv()).await {
            collected.extend_from_slice(&chunk);
            if String::from_utf8_lossy(&collected).contains("hello-grid") {
                break;
            }
        }
        // Reader thread parses asynchronously; give it a beat to drain.
        tokio::time::sleep(Duration::from_millis(50)).await;
        let screen = pty.screen_text();
        assert!(
            screen.contains("hello-grid"),
            "grid should contain echoed text, got: {screen:?}"
        );
        let _ = pty.shutdown();
    }

    #[tokio::test]
    async fn live_pty_grid_size_reflects_spawn_dimensions() {
        let (pty, _rx) = PtySession::spawn("sleep", &["1".into()], 24, 80).unwrap();
        assert_eq!(pty.grid_size(), (24, 80));
        pty.resize(40, 120).unwrap();
        assert_eq!(pty.grid_size(), (40, 120));
        let _ = pty.shutdown();
    }

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

    #[tokio::test]
    async fn spawn_overrides_dumb_term_for_pty_children() {
        let original_term = env::var_os("TERM");
        unsafe {
            env::set_var("TERM", "dumb");
        }

        let (pty, mut rx) =
            PtySession::spawn("sh", &["-c".into(), "printf '%s' \"$TERM\"".into()], 24, 80)
                .unwrap();

        let mut collected = Vec::new();
        while let Ok(Some(chunk)) = timeout(Duration::from_secs(2), rx.recv()).await {
            collected.extend_from_slice(&chunk);
            if String::from_utf8_lossy(&collected).contains("xterm-256color") {
                break;
            }
        }

        let _ = pty.shutdown();
        match original_term {
            Some(term) => unsafe {
                env::set_var("TERM", term);
            },
            None => unsafe {
                env::remove_var("TERM");
            },
        }

        assert_eq!(String::from_utf8_lossy(&collected), "xterm-256color");
    }
}
