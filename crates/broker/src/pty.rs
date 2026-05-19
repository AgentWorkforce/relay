use std::{
    env,
    ffi::OsString,
    io::{self, Read, Write},
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc as std_mpsc, Arc,
    },
    thread,
};

use alacritty_terminal::event::{Event, EventListener};
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line, Point};
use alacritty_terminal::term::{Config, Term};
use alacritty_terminal::vte::ansi::Processor;
use anyhow::{Context, Result};
use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tokio::sync::mpsc;

/// Upper bound on queued PTY writes (both terminal-query replies from
/// alacritty AND user/injection writes from `PtySession::write_all`).
/// Bounded so a misbehaving child that floods query sequences while the
/// drainer is stuck on `write_all` cannot grow the queue without limit
/// and OOM the broker. 128 entries is well past any real burst — a
/// healthy interaction sees fewer than a handful of pending writes at
/// a time.
const WRITE_QUEUE_DEPTH: usize = 128;

/// Single FIFO command for the PTY write drainer. Both query-reply
/// writebacks (from `RelayEventListener`) and user-input/injection
/// writes (from `PtySession::write_all`) go through the same queue so
/// the drainer thread is the **only** thing that touches the writer.
/// That guarantees a global FIFO ordering across both producers — a
/// terminal-query reply can no longer splice between two consecutive
/// user writes (e.g. between an injection body and its trailing `\r`).
enum WriteMsg {
    /// Reply produced by alacritty's `EventListener` (DSR / DA1 / DA2 /
    /// CPR). Best-effort: dropped if the queue is full because the
    /// listener is invoked from the parser hot path and must not block.
    Reply(Vec<u8>),
    /// User/injection write from a `PtySession::write_all` caller. The
    /// caller's send is **blocking** so backpressure flows back through
    /// the worker; ordering is preserved relative to other UserInputs
    /// and to any Replies already queued.
    UserInput {
        bytes: Vec<u8>,
        ack: std_mpsc::Sender<io::Result<()>>,
    },
}

/// Forwards alacritty's terminal events back to the PTY's stdin so the
/// child process sees real responses to its query sequences (DSR, DA1,
/// DA2, CPR, …). alacritty fills in the response payloads using the
/// real grid state — so CPR replies carry the actual cursor position
/// rather than the old hand-rolled `1;1` placeholder.
///
/// `send_event` is invoked from inside `Processor::advance` while the
/// processor and term locks are held, so it must be non-blocking. We
/// hand the bytes off to the shared write queue via `try_send`; the
/// drainer thread is the single owner of the writer lock.
#[derive(Clone)]
pub struct RelayEventListener {
    tx: std_mpsc::SyncSender<WriteMsg>,
}

impl RelayEventListener {
    fn new(tx: std_mpsc::SyncSender<WriteMsg>) -> Self {
        Self { tx }
    }
}

impl EventListener for RelayEventListener {
    fn send_event(&self, event: Event) {
        // Only `PtyWrite` actually needs to round-trip to the child.
        // Title/colour/clipboard/etc. events are intentionally dropped —
        // the broker isn't a real UI, so there is nothing meaningful to
        // do with them.
        if let Event::PtyWrite(text) = event {
            // Non-blocking try_send: if the queue is full (drainer
            // backed up behind a blocked write_all) or the drainer has
            // exited (PTY teardown), drop the reply. Telemetry must be
            // infallible, but a queue overflow is worth flagging.
            match self.tx.try_send(WriteMsg::Reply(text.into_bytes())) {
                Ok(()) | Err(std_mpsc::TrySendError::Disconnected(_)) => {}
                Err(std_mpsc::TrySendError::Full(_)) => {
                    tracing::warn!(
                        depth = WRITE_QUEUE_DEPTH,
                        "pty write queue full; dropping terminal query response"
                    );
                }
            }
        }
    }
}

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

impl GridSize {
    /// Build a `GridSize` from PTY-style `(rows, cols)` while clamping
    /// each axis to at least 1 cell. alacritty's grid allocator panics
    /// (or worse, underflows) on a zero-dimension grid, and PTY
    /// resize requests of 0 do arrive in practice (window minimized,
    /// container without a TTY, race during teardown).
    fn from_pty(rows: u16, cols: u16) -> Self {
        Self {
            columns: (cols as usize).max(1),
            screen_lines: (rows as usize).max(1),
        }
    }
}

pub struct PtySession {
    master: Box<dyn portable_pty::MasterPty>,
    /// Single producer side of the FIFO write queue. All PTY writes —
    /// both query-reply writebacks from `RelayEventListener` and user
    /// input from `write_all` — funnel through here. The drainer thread
    /// is the only thing that ever locks the real writer.
    write_tx: std_mpsc::SyncSender<WriteMsg>,
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
    ///
    /// The `RelayEventListener` is plumbed into `Term::new` so that
    /// query responses (DSR/DA1/DA2/CPR) generated by alacritty are
    /// written back to the PTY's stdin — giving the child accurate
    /// responses based on the real grid state.
    term: Arc<Mutex<Term<RelayEventListener>>>,
    /// Shared with the reader thread, which holds the actual lock most
    /// of the time. Kept on the struct so `resize()` can take the same
    /// lock the reader uses — preventing the child's post-resize
    /// redraw from being parsed against stale grid dimensions.
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

fn drain_write_queue<W: Write>(mut writer: W, write_rx: std_mpsc::Receiver<WriteMsg>) {
    while let Ok(msg) = write_rx.recv() {
        match msg {
            WriteMsg::Reply(bytes) => {
                if bytes.is_empty() {
                    continue;
                }
                if writer.write_all(&bytes).is_err() {
                    break;
                }
                if writer.flush().is_err() {
                    break;
                }
            }
            WriteMsg::UserInput { bytes, ack } => {
                if bytes.is_empty() {
                    let _ = ack.send(Ok(()));
                    continue;
                }
                match writer.write_all(&bytes).and_then(|_| writer.flush()) {
                    Ok(()) => {
                        let _ = ack.send(Ok(()));
                    }
                    Err(err) => {
                        let _ = ack.send(Err(err));
                        break;
                    }
                }
            }
        }
    }
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

        let size = GridSize::from_pty(rows, cols);
        // Shared write queue used by both producers: query-reply
        // writebacks from alacritty's listener and user/injection
        // writes from `PtySession::write_all`. Routing everything
        // through one FIFO is what gives us global ordering — without
        // it, the writer mutex provides per-call mutual exclusion but
        // a reply can splice between two consecutive user writes.
        let (write_tx, write_rx) = std_mpsc::sync_channel::<WriteMsg>(WRITE_QUEUE_DEPTH);
        let listener = RelayEventListener::new(write_tx.clone());
        let term = Arc::new(Mutex::new(Term::new(Config::default(), &size, listener)));
        let processor = Arc::new(Mutex::new(Processor::new()));

        // Drainer: single owner of the writer. Receives `WriteMsg`s
        // from the queue and pushes them to the PTY. Lives on a
        // std::thread so it doesn't need a tokio runtime. Exits when
        // every sender is dropped — i.e. when the listener inside
        // `term` is dropped (term goes away at PtySession drop) AND
        // the `write_tx` clone on the struct is dropped (same time).
        thread::spawn(move || drain_write_queue(writer, write_rx));

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
                            // Lock order: processor THEN term. `resize`
                            // takes the same order; matching prevents
                            // deadlock and ensures bytes are never
                            // parsed against stale dimensions.
                            //
                            // The listener inside `term` may send bytes
                            // onto the writeback channel while we hold
                            // these locks — that send is non-blocking
                            // (std::mpsc), so no deadlock with the
                            // writer lock taken by the drainer thread.
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
                write_tx,
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

    /// Queue bytes for the PTY drainer to write. Ordering is preserved
    /// relative to other `write_all` calls and to any pending
    /// terminal-query replies — both go through the same FIFO.
    ///
    /// Blocks if the queue is full (drainer wedged behind a slow PTY
    /// write) and waits for the drainer to ack the write result. Returns
    /// `Err` if the drainer has exited (PTY teardown) or if the underlying
    /// PTY write/flush fails.
    pub fn write_all(&self, bytes: &[u8]) -> Result<()> {
        let (ack_tx, ack_rx) = std_mpsc::channel::<io::Result<()>>();
        self.write_tx
            .send(WriteMsg::UserInput {
                bytes: bytes.to_vec(),
                ack: ack_tx,
            })
            .map_err(|_| {
                anyhow::anyhow!("pty write queue is closed (drainer exited before enqueue)")
            })?;

        match ack_rx.recv() {
            Ok(Ok(())) => Ok(()),
            Ok(Err(err)) => Err(err).context("failed to write queued input to pty"),
            Err(_) => Err(anyhow::anyhow!(
                "pty write drainer exited before acknowledging queued write"
            )),
        }
    }

    pub fn resize(&self, rows: u16, cols: u16) -> Result<()> {
        // Keep resize and parser advancement serialized. The reader
        // thread locks (processor, term) before parsing chunks; resize
        // follows that order and holds both locks while updating PTY
        // and grid dimensions.
        let _processor_guard = self.processor.lock();
        let mut term_guard = self.term.lock();

        self.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("failed to resize pty")?;
        term_guard.resize(GridSize::from_pty(rows, cols));
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
    /// readiness checks.
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

    /// Run a closure against the live `Term`, holding the term lock for the
    /// duration. Used by `snapshot::Snapshot::capture` to walk the grid
    /// (cells + colours + flags) without exposing the underlying `Term` type
    /// through `PtySession`'s public API.
    ///
    /// Keep the closure short — it blocks the reader thread from advancing
    /// the VT parser while it runs.
    pub fn with_term<R>(&self, f: impl FnOnce(&Term<RelayEventListener>) -> R) -> R {
        let term = self.term.lock();
        f(&term)
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
        // Avoid blocking if the child was reaped between the check
        // above and here.
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
        let term = parse_into(4, 20, &[b"garbage", b"\x1b[2J\x1b[H", b"fresh"]);
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

    #[test]
    fn grid_size_clamps_zero_dimensions_to_one() {
        // alacritty panics on a zero-row or zero-column grid; PTY
        // resize events of 0 do happen (window minimized, container
        // without a TTY, teardown races). The clamp keeps us safe.
        let zero_rows = GridSize::from_pty(0, 80);
        assert_eq!(zero_rows.screen_lines, 1);
        assert_eq!(zero_rows.columns, 80);

        let zero_cols = GridSize::from_pty(24, 0);
        assert_eq!(zero_cols.screen_lines, 24);
        assert_eq!(zero_cols.columns, 1);

        let both_zero = GridSize::from_pty(0, 0);
        assert_eq!(both_zero.screen_lines, 1);
        assert_eq!(both_zero.columns, 1);
    }

    #[tokio::test]
    async fn resize_to_zero_does_not_panic() {
        // Regression for the "alacritty grid underflow on zero
        // dimensions" path the clamp closes.
        let (pty, _rx) = PtySession::spawn("sleep", &["1".into()], 24, 80).unwrap();
        assert!(pty.resize(0, 0).is_ok());
        let (rows, cols) = pty.grid_size();
        assert!(rows >= 1 && cols >= 1, "grid clamped to non-zero");
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

    // ---- RelayEventListener wiring tests ----
    //
    // These drive a free-standing `Term<RelayEventListener>` so we can
    // assert that alacritty itself answers DSR/CPR query sequences with
    // bytes that match real grid state — replacing the old hand-rolled
    // `TerminalQueryParser` that hardcoded `1;1` for CPR.

    use super::{RelayEventListener, WriteMsg, WRITE_QUEUE_DEPTH};
    use std::sync::mpsc as std_mpsc;
    use std::time::Duration as StdDuration;

    fn drive_listener(
        rows: u16,
        cols: u16,
        chunks: &[&[u8]],
    ) -> (std_mpsc::Receiver<WriteMsg>, Term<RelayEventListener>) {
        let size = GridSize {
            columns: cols as usize,
            screen_lines: rows as usize,
        };
        let (tx, rx) = std_mpsc::sync_channel::<WriteMsg>(WRITE_QUEUE_DEPTH);
        let listener = RelayEventListener::new(tx);
        let mut term = Term::new(Config::default(), &size, listener);
        let mut processor: Processor = Processor::new();
        for chunk in chunks {
            processor.advance(&mut term, chunk);
        }
        (rx, term)
    }

    fn drain_writeback(rx: &std_mpsc::Receiver<WriteMsg>) -> Vec<u8> {
        let mut out = Vec::new();
        // First reply is queued synchronously inside processor.advance,
        // but recv_timeout is enough since send is non-blocking.
        while let Ok(msg) = rx.recv_timeout(StdDuration::from_millis(50)) {
            // Listener can only produce Reply variants; UserInput would
            // come from a real PtySession::write_all caller, which these
            // tests don't construct.
            match msg {
                WriteMsg::Reply(bytes) => out.extend_from_slice(&bytes),
                WriteMsg::UserInput { .. } => unreachable!("listener never emits UserInput"),
            }
        }
        out
    }

    #[test]
    fn listener_answers_dsr_with_terminal_ok() {
        // ESC[5n is the Device Status Report query — alacritty must
        // reply with ESC[0n ("terminal OK").
        let (rx, _term) = drive_listener(24, 80, &[b"\x1b[5n"]);
        let writeback = drain_writeback(&rx);
        assert_eq!(
            writeback, b"\x1b[0n",
            "DSR ESC[5n must produce ESC[0n; got {writeback:?}"
        );
    }

    #[test]
    fn listener_answers_da1_with_vt102_ident() {
        // ESC[c is the Primary Device Attributes query — alacritty
        // identifies as a VT102 (ESC[?6c). This is startup-critical:
        // many CLIs hang at boot if DA1 goes unanswered. The exact
        // ident byte differs between terminals (xterm uses ?1;2c) —
        // we just need *some* well-formed DA1 reply to come back.
        let (rx, _term) = drive_listener(24, 80, &[b"\x1b[c"]);
        let writeback = drain_writeback(&rx);
        assert_eq!(
            writeback, b"\x1b[?6c",
            "DA1 ESC[c must produce a VT102 ident (ESC[?6c); got {writeback:?}"
        );
    }

    #[test]
    fn write_queue_preserves_fifo_across_user_and_reply() {
        // Both producers (`PtySession::write_all` → UserInput and the
        // alacritty listener → Reply) push onto the same channel. The
        // drainer's `recv` order is the order the bytes hit the PTY.
        // Interleave two of each kind in a known order and assert the
        // receiver pulls them back in that same order — no reordering,
        // no Reply splicing between two UserInputs.
        let (tx, rx) = std_mpsc::sync_channel::<WriteMsg>(WRITE_QUEUE_DEPTH);

        let (ack_tx_1, _ack_rx_1) = std_mpsc::channel::<std::io::Result<()>>();
        tx.send(WriteMsg::UserInput {
            bytes: b"injection-body".to_vec(),
            ack: ack_tx_1,
        })
        .unwrap();
        tx.send(WriteMsg::Reply(b"\x1b[0n".to_vec())).unwrap();
        let (ack_tx_2, _ack_rx_2) = std_mpsc::channel::<std::io::Result<()>>();
        tx.send(WriteMsg::UserInput {
            bytes: b"\r".to_vec(),
            ack: ack_tx_2,
        })
        .unwrap();
        tx.send(WriteMsg::Reply(b"\x1b[3;5R".to_vec())).unwrap();

        let observed: Vec<Vec<u8>> = (0..4)
            .map(|_| {
                let msg = rx
                    .recv_timeout(StdDuration::from_millis(50))
                    .expect("drainer receives in order");
                match msg {
                    WriteMsg::Reply(bytes) | WriteMsg::UserInput { bytes, .. } => bytes,
                }
            })
            .collect();

        assert_eq!(
            observed,
            vec![
                b"injection-body".to_vec(),
                b"\x1b[0n".to_vec(),
                b"\r".to_vec(),
                b"\x1b[3;5R".to_vec(),
            ],
            "FIFO order must be preserved across both message kinds",
        );
    }

    #[test]
    fn listener_answers_cpr_with_real_cursor_position() {
        // Move the cursor to row 3, col 5 (1-indexed CUP), then issue
        // a CPR query. alacritty should reply with the **real** cursor
        // position — `ESC[3;5R` — not the old hardcoded `1;1`.
        let (rx, term) = drive_listener(24, 80, &[b"\x1b[3;5H", b"\x1b[6n"]);

        // Sanity-check the grid actually moved the cursor.
        let point = term.grid().cursor.point;
        assert_eq!(point.line.0, 2, "row 3 (1-indexed) = line 2 (0-indexed)");
        assert_eq!(
            point.column.0, 4,
            "col 5 (1-indexed) = column 4 (0-indexed)"
        );

        let writeback = drain_writeback(&rx);
        assert_eq!(
            writeback, b"\x1b[3;5R",
            "CPR ESC[6n must reflect real cursor position; got {writeback:?}"
        );
    }

    #[test]
    fn user_input_ack_reports_write_failure() {
        struct AlwaysFailWriter;
        impl std::io::Write for AlwaysFailWriter {
            fn write(&mut self, _buf: &[u8]) -> std::io::Result<usize> {
                Err(std::io::Error::new(
                    std::io::ErrorKind::BrokenPipe,
                    "forced failure",
                ))
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }

        let (tx, rx) = std_mpsc::sync_channel::<WriteMsg>(WRITE_QUEUE_DEPTH);
        let drainer = std::thread::spawn(move || super::drain_write_queue(AlwaysFailWriter, rx));

        let (ack_tx, ack_rx) = std_mpsc::channel::<std::io::Result<()>>();
        tx.send(WriteMsg::UserInput {
            bytes: b"should-fail\n".to_vec(),
            ack: ack_tx,
        })
        .expect("queue accepts user input");

        let ack = ack_rx
            .recv_timeout(StdDuration::from_millis(200))
            .expect("drainer must ack user input writes");
        assert!(ack.is_err(), "drainer write failure must be surfaced");

        drop(tx);
        drainer.join().expect("drainer thread joins cleanly");
    }

    #[test]
    fn user_input_ack_reports_flush_failure() {
        struct FlushFailWriter;
        impl std::io::Write for FlushFailWriter {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                Ok(buf.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Err(std::io::Error::new(
                    std::io::ErrorKind::BrokenPipe,
                    "forced flush failure",
                ))
            }
        }

        let (tx, rx) = std_mpsc::sync_channel::<WriteMsg>(WRITE_QUEUE_DEPTH);
        let drainer = std::thread::spawn(move || super::drain_write_queue(FlushFailWriter, rx));

        let (ack_tx, ack_rx) = std_mpsc::channel::<std::io::Result<()>>();
        tx.send(WriteMsg::UserInput {
            bytes: b"flush-should-fail\n".to_vec(),
            ack: ack_tx,
        })
        .expect("queue accepts user input");

        let ack = ack_rx
            .recv_timeout(StdDuration::from_millis(200))
            .expect("drainer must ack user input writes");
        assert!(ack.is_err(), "drainer flush failure must be surfaced");

        drop(tx);
        drainer.join().expect("drainer thread joins cleanly");
    }
}
