use std::{
    env,
    ffi::{OsStr, OsString},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
        mpsc as std_mpsc, Arc,
    },
    thread,
    time::Duration,
};

use alacritty_terminal::event::{Event, EventListener};
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line, Point};
use alacritty_terminal::term::{Config, Term};
use alacritty_terminal::vte::ansi::Processor;
use anyhow::{Context, Result};
use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tokio::sync::{mpsc, oneshot};

#[cfg(unix)]
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
#[cfg(windows)]
use std::{
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    time::Instant,
};
#[cfg(windows)]
use windows_sys::Win32::{
    Foundation::{
        DuplicateHandle, DUPLICATE_SAME_ACCESS, ERROR_NOT_FOUND, ERROR_OPERATION_ABORTED, HANDLE,
    },
    System::{Threading::GetCurrentProcess, IO::CancelSynchronousIo},
};

/// Upper bound on queued PTY writes (both terminal-query replies from
/// alacritty AND user/injection writes from `PtySession::write_all`).
/// Bounded so a misbehaving child that floods query sequences while the
/// drainer is stuck on `write_all` cannot grow the queue without limit
/// and OOM the broker. 128 entries is well past any real burst — a
/// healthy interaction sees fewer than a handful of pending writes at
/// a time.
const WRITE_QUEUE_DEPTH: usize = 128;
#[cfg(windows)]
const OUTPUT_ORDERING_TIMEOUT: Duration = Duration::from_secs(1);

/// Why [`PtySession::submit_write`] refused to enqueue.
///
/// Typed — not a bare string — because the two cases mean opposite things to a
/// caller serving an interactive attach session. [`QueueFull`] says the child
/// is alive but momentarily not draining its stdin, so the write is the only
/// thing that failed and the caller should keep its transport open and retry.
/// [`DrainerExited`] says the PTY is gone. Callers recover the variant with
/// `anyhow::Error::downcast_ref::<PtyWriteSubmitError>()`; `submit_write` keeps
/// returning `anyhow::Result` so existing call sites are unaffected.
///
/// [`QueueFull`]: PtyWriteSubmitError::QueueFull
/// [`DrainerExited`]: PtyWriteSubmitError::DrainerExited
#[derive(Debug, thiserror::Error)]
pub enum PtyWriteSubmitError {
    /// The bounded drainer queue is full. Retryable: the drainer is blocked in
    /// `write_all` behind a child that has stopped reading its stdin, and drains
    /// as soon as it resumes.
    #[error("pty write queue full ({depth} writes pending; drainer wedged behind child not reading stdin)")]
    QueueFull {
        /// Queue capacity, which is also the number of writes pending.
        depth: usize,
    },

    /// The drainer thread is gone (PTY teardown). Not retryable.
    #[error("pty write queue is closed (drainer exited)")]
    DrainerExited,

    /// The Windows reader could not be interrupted promptly enough to admit
    /// a verified write. The write was not queued, so callers may retry it.
    #[cfg(windows)]
    #[error("timed out acquiring pty output ordering for verified write")]
    OrderingTimeout,

    /// The Windows reader thread could not be interrupted. The write was not
    /// queued, so callers may retry it after surfacing the platform failure.
    #[cfg(windows)]
    #[error("failed to interrupt pty reader for verified write: {0}")]
    OrderingWake(io::Error),
}

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
    /// User/injection write submitted via `PtySession::submit_write`. The
    /// submission is **non-blocking** (`try_send`): if the queue is full
    /// the caller gets an error instead of parking, so the async worker
    /// loop can keep draining PTY output and never deadlocks behind a
    /// wedged drainer. Ordering is preserved relative to other UserInputs
    /// and to any Replies already queued. The drainer reports the write
    /// result over a tokio `oneshot` so async callers can await it (or
    /// drop the receiver for fire-and-forget writes).
    UserInput {
        bytes: Vec<u8>,
        /// Per-atom pacing gap. `Duration::ZERO` writes the whole payload
        /// in one `write_all` (the historical behavior). A non-zero value
        /// selects **escape-aware paced** writing: the drainer emits one VT
        /// atom — a CSI/SS3/OSC control sequence, or one UTF-8 codepoint, or
        /// one plain byte — per `write_all`+`flush`, sleeping `pace` between
        /// atoms so bytes reach the child spread across multiple `read()`s
        /// instead of a single blob. The whole payload stays a single
        /// `WriteMsg`, so no reply or later write can splice between its
        /// atoms. The sleeps run on the drainer thread, never on an async
        /// task.
        pace: Duration,
        /// Optional second write that remains part of this FIFO entry. The
        /// drainer waits `delay` after the primary bytes are flushed, then
        /// writes and flushes `bytes` before acknowledging the command.
        ///
        /// This is intentionally not represented as a second `WriteMsg`: some
        /// TUIs need a real pause between pasted text and its submit key, while
        /// Relay still must prevent a terminal reply or human keystroke from
        /// splicing into that boundary.
        followup: Option<FollowupWrite>,
        ack: oneshot::Sender<io::Result<()>>,
    },
}

struct FollowupWrite {
    delay: Duration,
    bytes: Vec<u8>,
}

/// Length of the next indivisible write "atom" at the front of `bytes`.
///
/// A port of headless-terminal's `escapeSeqEnd`
/// ([montanaflynn/headless-terminal], `internal/session/session.go`). Paced
/// writing must never split a VT control sequence or a multi-byte UTF-8
/// codepoint across the inter-atom sleep — doing so would corrupt arrow keys,
/// modified function keys, OSC strings, or wide characters as they arrive at
/// the child. This returns how many leading bytes form the next atom:
///
/// - **CSI** (`ESC [` … final `0x40..=0x7e`): the whole control sequence,
///   including parameter (`0x30..=0x3f`) and intermediate (`0x20..=0x2f`)
///   bytes.
/// - **SS3** (`ESC O` + one final byte): 3 bytes.
/// - **OSC** (`ESC ]` … terminated by `BEL` or `ST` = `ESC \`): through the
///   terminator.
/// - **Other two-byte escapes** (e.g. `ESC ESC`): 2 bytes.
/// - **UTF-8 lead byte**: the full 2/3/4-byte codepoint.
/// - **Anything else** (ASCII, `\r`, control bytes, stray continuation
///   bytes): 1 byte.
///
/// A sequence truncated by the end of `bytes` returns the remaining length, so
/// the final atom is emitted as-is rather than looping forever. `bytes` must be
/// non-empty.
///
/// [montanaflynn/headless-terminal]: https://github.com/montanaflynn/headless-terminal
fn next_atom_end(bytes: &[u8]) -> usize {
    debug_assert!(
        !bytes.is_empty(),
        "next_atom_end requires a non-empty slice"
    );
    let len = bytes.len();
    if bytes[0] != 0x1b {
        return utf8_seq_len(bytes);
    }
    // Lone trailing ESC — can't classify without the next byte; emit as-is.
    if len < 2 {
        return 1;
    }
    match bytes[1] {
        // CSI: params/intermediates (0x20..=0x3f) then a final byte (0x40..=0x7e).
        b'[' => {
            let mut i = 2;
            while i < len && (0x20..=0x3f).contains(&bytes[i]) {
                i += 1;
            }
            if i < len {
                i += 1; // consume the final byte
            }
            i
        }
        // SS3: ESC O + exactly one final byte.
        b'O' => 3.min(len),
        // OSC: string terminated by BEL (0x07) or ST (ESC \).
        b']' => {
            let mut i = 2;
            while i < len {
                if bytes[i] == 0x07 {
                    return i + 1;
                }
                if bytes[i] == 0x1b && i + 1 < len && bytes[i + 1] == b'\\' {
                    return i + 2;
                }
                i += 1;
            }
            len
        }
        // Any other escape (ESC ESC, ESC <letter>, …) is a two-byte atom.
        _ => 2,
    }
}

/// Byte length of the UTF-8 codepoint (or single byte) at the front of `bytes`,
/// clamped to what is actually present. A stray continuation byte or invalid
/// lead byte yields 1 so paced writing always makes forward progress.
fn utf8_seq_len(bytes: &[u8]) -> usize {
    let lead = bytes[0];
    let width = if lead < 0x80 {
        1
    } else if lead >= 0xf0 {
        4
    } else if lead >= 0xe0 {
        3
    } else if lead >= 0xc0 {
        2
    } else {
        1 // continuation byte with no lead — emit alone
    };
    width.min(bytes.len())
}

/// Write `bytes` to `writer` one escape-aware atom at a time, flushing after
/// each and sleeping `pace` between atoms (never after the last). The sleep
/// runs on the calling (drainer) thread — the whole point is to hand the child
/// its input in small, well-timed pieces rather than one blob it may batch or
/// partially drop. Errors short-circuit, matching `write_all`.
fn write_paced<W: Write>(writer: &mut W, bytes: &[u8], pace: Duration) -> io::Result<()> {
    let mut i = 0;
    while i < bytes.len() {
        let end = i + next_atom_end(&bytes[i..]);
        writer.write_all(&bytes[i..end])?;
        writer.flush()?;
        i = end;
        if i < bytes.len() {
            thread::sleep(pace);
        }
    }
    Ok(())
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

/// Default number of consecutive no-PID `Ok(None)` liveness checks tolerated
/// before a child with no discoverable PID is declared exited.
///
/// The watchdog polls every ~5s, so `60` is ~5 minutes. This is deliberately
/// long: the previous value of `6` (~30s) could declare a *silently thinking*
/// child dead mid-task (an agent CLI can go >30s with no PTY output while it
/// reasons). Raising it is safe because a genuinely dead child is detected
/// promptly and independently by the PTY reader hitting EOF (which closes the
/// worker's `pty_rx` and emits `agent_exit`) — this counter is only a backstop
/// for the rare macOS case where `try_wait` is stuck at `Ok(None)` *and* no PID
/// is ever available *and* the reader hasn't closed. In that narrow window we
/// prefer a several-minute grace over a 30s false positive.
pub const DEFAULT_NO_PID_EXIT_THRESHOLD: u32 = 60;

/// One raw PTY read tagged at the producer, before it enters the async queue.
///
/// The sequence lets consumers distinguish output that was already read (but
/// still queued) when they submit input from output read after that submission.
/// Assigning it in the reader thread avoids a consumer-side `select!` race.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PtyOutput {
    bytes: Vec<u8>,
    sequence: u64,
}

impl PtyOutput {
    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub fn sequence(&self) -> u64 {
        self.sequence
    }
}

impl std::ops::Deref for PtyOutput {
    type Target = [u8];

    fn deref(&self) -> &Self::Target {
        self.as_bytes()
    }
}

impl AsRef<[u8]> for PtyOutput {
    fn as_ref(&self) -> &[u8] {
        self.as_bytes()
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
    /// AND we had no PID to verify with kill(0). After
    /// [`no_pid_exit_threshold`](Self::no_pid_exit_threshold) checks, we
    /// assume the child is gone (macOS PTY quirk). Reset on any observed
    /// child-side activity (PTY output, or a write the drainer has *confirmed*
    /// actually reached the PTY master).
    ///
    /// Shared with the write drainer thread (`Arc`) so a confirmed write — not
    /// a mere enqueue — resets the counter. Resetting on enqueue would let a
    /// wedged drainer plus periodic input postpone the no-PID fallback forever
    /// even though no byte is reaching the child.
    no_pid_alive_checks: Arc<AtomicU32>,
    /// Consecutive no-PID `Ok(None)` checks tolerated before declaring a
    /// child with no discoverable PID exited. See [`has_exited`](Self::has_exited)
    /// for the full rationale. Configurable so tests (and future tuning)
    /// aren't pinned to the wall-clock default.
    no_pid_exit_threshold: u32,
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
    /// Monotonic count of raw PTY bytes the reader thread has parsed into
    /// the grid. Incremented under the same `(processor, term)` lock that
    /// advances the parser, so a reader that snapshots the grid under that
    /// lock observes exactly the offset corresponding to the grid state.
    ///
    /// This is the "stream offset" that correlates a visible-screen
    /// snapshot with the `worker_stream` byte stream: the broker reports
    /// this value alongside a snapshot so an attaching client can drop the
    /// buffered stream chunks the snapshot already reflects and apply only
    /// the ones that came after.
    consumed_offset: Arc<AtomicU64>,
    /// Sequence assigned as soon as the reader obtains a PTY output chunk,
    /// before grid parsing or async queue admission. Consumers sample this
    /// producer watermark when submitting input so output that was already
    /// queued cannot be mistaken for the input's echo.
    output_sequence: Arc<AtomicU64>,
    /// Linearizes producer sequence assignment with verified input queue
    /// admission. Without this lock, output could be assigned a new sequence
    /// after a caller sampled the watermark but before its write was queued.
    output_order: Arc<Mutex<()>>,
    /// Duplicated native handle for the reader thread. Windows verified writes
    /// use it to interrupt an idle synchronous ConPTY read before acquiring
    /// `output_order`; the handle never exposes the PTY itself.
    #[cfg(windows)]
    reader_cancel: ReaderCancel,
}

#[cfg(windows)]
struct ReaderCancel {
    thread_handle: OwnedHandle,
}

#[cfg(windows)]
impl ReaderCancel {
    fn duplicate(reader_thread: &thread::JoinHandle<()>) -> io::Result<Self> {
        let process = unsafe { GetCurrentProcess() };
        let mut duplicate: HANDLE = std::ptr::null_mut();
        let ok = unsafe {
            DuplicateHandle(
                process,
                reader_thread.as_raw_handle() as HANDLE,
                process,
                &mut duplicate,
                0,
                0,
                DUPLICATE_SAME_ACCESS,
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self {
            // SAFETY: `DuplicateHandle` returned a new owned thread handle.
            thread_handle: unsafe { OwnedHandle::from_raw_handle(duplicate.cast()) },
        })
    }

    fn interrupt_read(&self) -> io::Result<()> {
        let ok = unsafe { CancelSynchronousIo(self.thread_handle.as_raw_handle() as HANDLE) };
        if ok != 0 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(ERROR_NOT_FOUND as i32) {
            // The reader is between synchronous calls. It will release (or
            // reacquire) the ordering lock promptly, so retrying is safe.
            return Ok(());
        }
        Err(error)
    }
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

/// Resolve `path` into a spawn-ready string while preserving shim behaviour.
///
/// Provider CLIs installed via version managers (mise, asdf, rtx/rtx-cli,
/// direnv, pkgx, chruby, jenv, pyenv, rbenv, nodenv, tfenv, volta, ...) are
/// exposed as symlinked shims that all point at the version-manager binary.
/// Those shims dispatch to the real tool based on `argv[0]` (the shim's own
/// basename). If we `canonicalize` the shim we collapse it to the manager
/// binary (`/opt/homebrew/bin/mise`) — the child then sees `argv[0] = "mise"`
/// and the manager parses provider-specific flags like
/// `--dangerously-bypass-approvals-and-sandbox` as its own arguments, which
/// aborts the worker before it ever starts.
///
/// The safe rule: if canonicalization would change the executable's basename,
/// treat the input as a shim and keep the caller-facing path so argv[0] stays
/// intact. Otherwise fall back to the canonical path (still helps
/// posix_spawnp on hosts with quirky PATH handling).
fn canonicalize_display(path: &Path) -> String {
    let requested_name = path.file_name();
    match std::fs::canonicalize(path) {
        Ok(resolved) => {
            let resolved_name = resolved.file_name();
            if let (Some(orig), Some(target)) = (requested_name, resolved_name) {
                if orig != target {
                    return absolutize_shim_path(path)
                        .and_then(|p| p.to_str().map(|s| s.to_string()))
                        .unwrap_or_else(|| path.to_string_lossy().to_string());
                }
            }
            resolved
                .to_str()
                .map(|s| s.to_string())
                .unwrap_or_else(|| path.to_string_lossy().to_string())
        }
        Err(_) => path.to_string_lossy().to_string(),
    }
}

/// Return an absolute path for `path` without following the final component's
/// symlink (so `argv[0]` remains the shim's basename). Falls back to the raw
/// path if the parent cannot be canonicalized.
fn absolutize_shim_path(path: &Path) -> Option<PathBuf> {
    if path.is_absolute() {
        return Some(path.to_path_buf());
    }
    let parent = path.parent().unwrap_or(Path::new("."));
    let file_name = path.file_name()?;
    let canonical_parent = if parent.as_os_str().is_empty() {
        std::fs::canonicalize(".").ok()?
    } else {
        std::fs::canonicalize(parent).ok()?
    };
    Some(canonical_parent.join(file_name))
}

fn default_path_env() -> OsString {
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
}

fn resolve_command_path(command: &str) -> String {
    let path_env = env::var_os("PATH")
        .filter(|value| !value.is_empty())
        .unwrap_or_else(default_path_env);
    resolve_command_path_with(command, path_env.as_os_str())
}

/// Testable core: resolves `command` against an explicit `path_env` instead of
/// reading `std::env::var("PATH")`, so unit tests can exercise shim-preserving
/// behaviour without racing on the process-wide PATH.
fn resolve_command_path_with(command: &str, path_env: &OsStr) -> String {
    // Already a path (absolute or relative): use as-is but resolve symlinks when possible.
    if command.contains('/') || command.contains('\\') || command.starts_with('.') {
        return canonicalize_display(Path::new(command));
    }

    for dir in env::split_paths(path_env) {
        let candidate = dir.join(command);
        if candidate.is_file() {
            return canonicalize_display(&candidate);
        }
    }

    command.to_string()
}

/// Drain the shared write FIFO into the PTY writer.
///
/// `no_pid_alive_checks` is the watchdog's silence counter (shared with the
/// [`PtySession`]). It is reset to `0` only when a user-input write is
/// *confirmed* flushed to the PTY master — proof the write path (drainer → PTY)
/// is actually live. Resetting on enqueue instead would let a wedged drainer
/// plus periodic input starve the no-PID fallback indefinitely.
fn drain_write_queue<W: Write>(
    mut writer: W,
    write_rx: std_mpsc::Receiver<WriteMsg>,
    no_pid_alive_checks: Arc<AtomicU32>,
) {
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
            WriteMsg::UserInput {
                bytes,
                pace,
                followup,
                ack,
            } => {
                if bytes.is_empty() && followup.as_ref().is_none_or(|part| part.bytes.is_empty()) {
                    let _ = ack.send(Ok(()));
                    continue;
                }
                let primary_result = if bytes.is_empty() {
                    Ok(())
                } else if pace.is_zero() {
                    writer.write_all(&bytes).and_then(|_| writer.flush())
                } else {
                    write_paced(&mut writer, &bytes, pace)
                };
                let result = primary_result.and_then(|_| {
                    let Some(part) = followup else {
                        return Ok(());
                    };
                    if part.bytes.is_empty() {
                        return Ok(());
                    }
                    thread::sleep(part.delay);
                    writer.write_all(&part.bytes).and_then(|_| writer.flush())
                });
                match result {
                    Ok(()) => {
                        // Confirmed child-side activity: the bytes reached the
                        // PTY master. Only now is it safe to reset the no-PID
                        // silence counter.
                        no_pid_alive_checks.store(0, Ordering::Relaxed);
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

/// Enqueue user input without treating queue admission as child activity.
/// Keeping the watchdog counter in this helper's interface makes the invariant
/// directly testable: only [`drain_write_queue`] may reset it after a confirmed
/// write and flush.
fn enqueue_user_write(
    write_tx: &std_mpsc::SyncSender<WriteMsg>,
    _no_pid_alive_checks: &AtomicU32,
    bytes: Vec<u8>,
    pace: Duration,
    followup: Option<FollowupWrite>,
) -> Result<oneshot::Receiver<io::Result<()>>> {
    let (ack_tx, ack_rx) = oneshot::channel::<io::Result<()>>();
    match write_tx.try_send(WriteMsg::UserInput {
        bytes,
        pace,
        followup,
        ack: ack_tx,
    }) {
        Ok(()) => Ok(ack_rx),
        Err(std_mpsc::TrySendError::Full(_)) => {
            Err(anyhow::Error::new(PtyWriteSubmitError::QueueFull {
                depth: WRITE_QUEUE_DEPTH,
            }))
        }
        Err(std_mpsc::TrySendError::Disconnected(_)) => {
            Err(anyhow::Error::new(PtyWriteSubmitError::DrainerExited))
        }
    }
}

/// Read one output chunk and assign its producer sequence while holding the
/// same ordering lock used by verified write admission.
///
/// The callback is deliberately inside the critical section, immediately
/// after the bytes have been copied from the PTY and before they are tagged.
/// Production passes a no-op; deterministic tests pause there to prove a
/// submitter cannot sample a boundary in the old read-complete/pre-tag gap.
fn read_and_tag_output<R, F>(
    reader: &mut R,
    buf: &mut [u8],
    output_order: &Mutex<()>,
    output_sequence: &AtomicU64,
    after_read: F,
) -> io::Result<Option<(usize, u64)>>
where
    R: Read + ?Sized,
    F: FnOnce(usize),
{
    let _order_guard = output_order.lock();
    let n = reader.read(buf)?;
    after_read(n);
    if n == 0 {
        return Ok(None);
    }
    let sequence = output_sequence
        .fetch_add(1, Ordering::AcqRel)
        .saturating_add(1);
    Ok(Some((n, sequence)))
}

#[cfg(unix)]
fn wait_for_pty_readable(fd: &OwnedFd) -> io::Result<()> {
    let mut descriptor = libc::pollfd {
        fd: fd.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    loop {
        let ready = unsafe { libc::poll(&mut descriptor, 1, -1) };
        if ready > 0 {
            return Ok(());
        }
        if ready == 0 {
            continue;
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

#[cfg(unix)]
fn duplicate_poll_fd_cloexec(fd: libc::c_int) -> io::Result<OwnedFd> {
    let duplicate = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 0) };
    if duplicate >= 0 {
        // SAFETY: `F_DUPFD_CLOEXEC` returned a new descriptor owned here.
        return Ok(unsafe { OwnedFd::from_raw_fd(duplicate) });
    }

    let atomic_error = io::Error::last_os_error();
    if atomic_error.raw_os_error() != Some(libc::EINVAL) {
        return Err(atomic_error);
    }

    // Older kernels can reject F_DUPFD_CLOEXEC even when libc exposes it.
    // Fall back to dup+fcntl, taking ownership immediately so every later
    // error path closes the duplicate instead of leaking it.
    let duplicate = unsafe { libc::dup(fd) };
    if duplicate < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `dup` returned a new descriptor owned here. `OwnedFd` closes it
    // if either fcntl below fails.
    let duplicate = unsafe { OwnedFd::from_raw_fd(duplicate) };
    let flags = unsafe { libc::fcntl(duplicate.as_raw_fd(), libc::F_GETFD) };
    if flags < 0 {
        return Err(io::Error::last_os_error());
    }
    if unsafe {
        libc::fcntl(
            duplicate.as_raw_fd(),
            libc::F_SETFD,
            flags | libc::FD_CLOEXEC,
        )
    } < 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(duplicate)
}

#[cfg(windows)]
fn read_was_cancelled(error: &io::Error) -> bool {
    error.raw_os_error() == Some(ERROR_OPERATION_ABORTED as i32)
}

impl PtySession {
    fn enqueue_write_with_output_boundary(
        &self,
        bytes: Vec<u8>,
        pace: Duration,
        followup: Option<FollowupWrite>,
    ) -> Result<(oneshot::Receiver<io::Result<()>>, u64)> {
        #[cfg(unix)]
        let _order_guard = self.output_order.lock();

        #[cfg(windows)]
        let _order_guard = {
            let deadline = Instant::now() + OUTPUT_ORDERING_TIMEOUT;
            loop {
                if let Some(guard) = self.output_order.try_lock() {
                    break guard;
                }
                self.reader_cancel
                    .interrupt_read()
                    .map_err(PtyWriteSubmitError::OrderingWake)?;
                if Instant::now() >= deadline {
                    return Err(anyhow::Error::new(PtyWriteSubmitError::OrderingTimeout));
                }
                thread::yield_now();
            }
        };

        let boundary = self.output_sequence.load(Ordering::Acquire);
        let ack = enqueue_user_write(
            &self.write_tx,
            &self.no_pid_alive_checks,
            bytes,
            pace,
            followup,
        )?;
        Ok((ack, boundary))
    }

    pub fn spawn(
        command: &str,
        args: &[String],
        rows: u16,
        cols: u16,
    ) -> Result<(Self, mpsc::Receiver<PtyOutput>)> {
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

        #[cfg(unix)]
        let poll_fd = {
            let master_fd = pair
                .master
                .as_raw_fd()
                .context("pty master does not expose a pollable descriptor")?;
            duplicate_poll_fd_cloexec(master_fd)
                .context("failed to duplicate pty descriptor for readiness polling")?
        };

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

        // Watchdog silence counter, shared with the drainer so a confirmed
        // write (not a mere enqueue) resets it.
        let no_pid_alive_checks = Arc::new(AtomicU32::new(0));

        // Drainer: single owner of the writer. Receives `WriteMsg`s
        // from the queue and pushes them to the PTY. Lives on a
        // std::thread so it doesn't need a tokio runtime. Exits when
        // every sender is dropped — i.e. when the listener inside
        // `term` is dropped (term goes away at PtySession drop) AND
        // the `write_tx` clone on the struct is dropped (same time).
        let drainer_no_pid = no_pid_alive_checks.clone();
        thread::spawn(move || drain_write_queue(writer, write_rx, drainer_no_pid));

        let (tx, rx) = mpsc::channel(256);
        let term_clone = term.clone();
        let processor_clone = processor.clone();
        let consumed_offset = Arc::new(AtomicU64::new(0));
        let consumed_offset_reader = consumed_offset.clone();
        let output_sequence = Arc::new(AtomicU64::new(0));
        let output_sequence_reader = output_sequence.clone();
        let output_order = Arc::new(Mutex::new(()));
        let output_order_reader = output_order.clone();
        let reader_thread = thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                #[cfg(unix)]
                if wait_for_pty_readable(&poll_fd).is_err() {
                    break;
                }

                let tagged = read_and_tag_output(
                    &mut *reader,
                    &mut buf,
                    &output_order_reader,
                    &output_sequence_reader,
                    |_| {},
                );

                #[cfg(windows)]
                let tagged = match tagged {
                    Err(error) if read_was_cancelled(&error) => continue,
                    other => other,
                };

                let (n, sequence) = match tagged {
                    Ok(Some(tagged)) => tagged,
                    Ok(None) | Err(_) => break,
                };

                {
                    // Lock order: processor THEN term. `resize`
                    // takes the same order; matching prevents
                    // deadlock and ensures bytes are never
                    // parsed against stale dimensions. Parsing and the
                    // bounded output send stay outside `output_order`, so
                    // backpressure cannot block verified write admission.
                    //
                    // The listener inside `term` may send bytes
                    // onto the writeback channel while we hold
                    // these locks — that send is non-blocking
                    // (std::mpsc), so no deadlock with the
                    // writer lock taken by the drainer thread.
                    let mut processor_guard = processor_clone.lock();
                    let mut term_guard = term_clone.lock();
                    processor_guard.advance(&mut *term_guard, &buf[..n]);
                    // Publish the grid's consumed byte offset while
                    // still holding the term lock, so a concurrent
                    // snapshot reader (which also locks `term`) reads
                    // the offset that matches the grid it renders.
                    consumed_offset_reader.fetch_add(n as u64, Ordering::Release);
                }
                if tx
                    .blocking_send(PtyOutput {
                        bytes: buf[..n].to_vec(),
                        sequence,
                    })
                    .is_err()
                {
                    break;
                }
            }
        });

        #[cfg(windows)]
        let reader_cancel = ReaderCancel::duplicate(&reader_thread)
            .context("failed to duplicate pty reader thread handle")?;
        // Detach the reader after retaining only the Windows cancellation
        // handle. PTY/session ownership controls its lifetime as before.
        drop(reader_thread);

        Ok((
            Self {
                master: pair.master,
                write_tx,
                child: Arc::new(Mutex::new(child)),
                child_pid,
                reaped: Arc::new(AtomicBool::new(false)),
                no_pid_alive_checks,
                no_pid_exit_threshold: DEFAULT_NO_PID_EXIT_THRESHOLD,
                term,
                processor,
                consumed_offset,
                output_sequence,
                output_order,
                #[cfg(windows)]
                reader_cancel,
            },
            rx,
        ))
    }

    /// Submit bytes to the PTY write drainer **without blocking**. Ordering
    /// is preserved relative to other `submit_write` calls and to any
    /// pending terminal-query replies — everything funnels through the same
    /// FIFO, so bytes reach the PTY in submission order. Callers that need
    /// two writes kept adjacent (e.g. an injection body and its trailing
    /// `\r`) must submit them back-to-back with no intervening submission
    /// from another task; because both land on the FIFO in order, no reply
    /// or later write can splice between them.
    ///
    /// Returns a `oneshot::Receiver` that resolves once the drainer has
    /// written and flushed the bytes (or hit an I/O error). Await it when
    /// the write result matters (input acks); drop it for fire-and-forget
    /// writes (auto-responses, injection keystrokes).
    ///
    /// This is the async-safe replacement for the old blocking `write_all`.
    /// The critical property: submission uses `try_send`, so a full queue —
    /// which happens when the child stops reading its stdin and the drainer
    /// wedges in `writer.write_all` — surfaces as an immediate `Err` instead
    /// of parking the caller. That keeps the single-task worker select loop
    /// free to keep draining PTY output, breaking the deadlock where a
    /// blocked write stalled the loop, which stalled the reader thread,
    /// which stalled the child, permanently.
    ///
    /// Returns `Err` if the queue is momentarily full (retryable) or the
    /// drainer has exited (PTY teardown).
    pub fn submit_write(&self, bytes: Vec<u8>) -> Result<oneshot::Receiver<io::Result<()>>> {
        // NB: do *not* reset the no-PID watchdog counter here. A successful
        // enqueue only proves the queue had room, not that any byte reached the
        // child. The drainer resets it after the write is confirmed flushed.
        enqueue_user_write(
            &self.write_tx,
            &self.no_pid_alive_checks,
            bytes,
            Duration::ZERO,
            None,
        )
    }

    /// Submit bytes for **escape-aware paced** delivery to the child. Identical
    /// to [`submit_write`] except the drainer emits one VT atom / UTF-8
    /// codepoint per write, sleeping `pace` between atoms (see
    /// [`WriteMsg::UserInput`]). A `pace` of [`Duration::ZERO`] is exactly
    /// [`submit_write`] — a single bulk write — so callers can carry a
    /// configurable rate and disable pacing by passing zero.
    ///
    /// Pacing spreads a payload the child would otherwise receive as one blob
    /// across multiple reads, which avoids a class of CLIs batching or dropping
    /// leading characters when input arrives faster than they read it. The
    /// entire payload remains one queue entry, so its atoms — and a trailing
    /// `\r` appended to it — stay adjacent on the FIFO with nothing splicing
    /// between them. The trade-off: while a paced write is in flight the drainer
    /// is busy for roughly `atoms * pace`, delaying any queued terminal-query
    /// replies for that window. Injection happens while the child waits on
    /// input (not mid-query), so keep `pace` small and the payloads bounded.
    ///
    /// [`submit_write`]: PtySession::submit_write
    pub fn submit_write_paced(
        &self,
        bytes: Vec<u8>,
        pace: Duration,
    ) -> Result<oneshot::Receiver<io::Result<()>>> {
        enqueue_user_write(&self.write_tx, &self.no_pid_alive_checks, bytes, pace, None)
    }

    /// Queue a paced input atomically with the receive-time output watermark.
    ///
    /// The returned boundary is the latest producer sequence that precedes
    /// this queue admission. Output carrying a sequence at or below it cannot
    /// be evidence that this write reached the child, even if that output was
    /// still waiting in the async receive queue when the write was submitted.
    pub fn submit_write_paced_with_output_boundary(
        &self,
        bytes: Vec<u8>,
        pace: Duration,
    ) -> Result<(oneshot::Receiver<io::Result<()>>, u64)> {
        self.enqueue_write_with_output_boundary(bytes, pace, None)
    }

    /// Submit a paced primary payload followed by a delayed second write as
    /// one indivisible FIFO command.
    ///
    /// The follow-up is written and flushed only after the primary payload is
    /// confirmed flushed and `followup_delay` has elapsed. No terminal reply,
    /// later input, or other producer can splice bytes into that pause. This is
    /// useful for TUIs that distinguish a pasted multiline body from a submit
    /// key only when the key arrives in a later read.
    pub fn submit_write_paced_with_followup(
        &self,
        bytes: Vec<u8>,
        pace: Duration,
        followup_delay: Duration,
        followup_bytes: Vec<u8>,
    ) -> Result<oneshot::Receiver<io::Result<()>>> {
        enqueue_user_write(
            &self.write_tx,
            &self.no_pid_alive_checks,
            bytes,
            pace,
            Some(FollowupWrite {
                delay: followup_delay,
                bytes: followup_bytes,
            }),
        )
    }

    /// Queue a compound paced write atomically with its receive-time output
    /// watermark. See [`submit_write_paced_with_output_boundary`].
    pub fn submit_write_paced_with_followup_and_output_boundary(
        &self,
        bytes: Vec<u8>,
        pace: Duration,
        followup_delay: Duration,
        followup_bytes: Vec<u8>,
    ) -> Result<(oneshot::Receiver<io::Result<()>>, u64)> {
        self.enqueue_write_with_output_boundary(
            bytes,
            pace,
            Some(FollowupWrite {
                delay: followup_delay,
                bytes: followup_bytes,
            }),
        )
    }

    /// Submit bytes and await the drainer's write result. Convenience
    /// wrapper over [`submit_write`] for async callers that want to
    /// confirm the write landed on the PTY.
    ///
    /// Prefer [`submit_write`] with a retained receiver when you must not
    /// block the select loop between submission and confirmation — awaiting
    /// here parks the calling task (though not other OS threads) until the
    /// drainer acks.
    ///
    /// [`submit_write`]: PtySession::submit_write
    pub async fn write_and_confirm(&self, bytes: Vec<u8>) -> Result<()> {
        let ack_rx = self.submit_write(bytes)?;
        match ack_rx.await {
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

    pub fn child_pid(&self) -> Option<u32> {
        let child = self.child.lock();
        child.process_id().or(self.child_pid)
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

    /// Like [`with_term`], but also hands the closure the grid's consumed
    /// byte offset, read while the term lock is held. The reader thread
    /// bumps this offset under the *same* lock immediately after advancing
    /// the parser, so the value the closure sees corresponds exactly to the
    /// grid state it observes — no chunk parsed into the grid is missing
    /// from the count, and none is counted ahead of the grid.
    ///
    /// [`with_term`]: PtySession::with_term
    pub fn with_term_and_offset<R>(
        &self,
        f: impl FnOnce(&Term<RelayEventListener>, u64) -> R,
    ) -> R {
        let term = self.term.lock();
        let offset = self.consumed_offset.load(Ordering::Acquire);
        f(&term, offset)
    }

    /// Monotonic count of raw PTY bytes parsed into the grid so far. Used to
    /// correlate a visible-screen snapshot with the `worker_stream` byte
    /// stream. Prefer [`with_term_and_offset`] when the value must line up
    /// with a grid render.
    ///
    /// [`with_term_and_offset`]: PtySession::with_term_and_offset
    pub fn consumed_offset(&self) -> u64 {
        self.consumed_offset.load(Ordering::Acquire)
    }

    /// Check if the child process has exited without blocking.
    /// Returns true if the child has exited (or was already reaped).
    ///
    /// Uses three detection mechanisms:
    /// 1. `try_wait()` (waitpid with WNOHANG)
    /// 2. `kill(pid, 0)` to check process existence (Unix only)
    /// 3. Consecutive no-PID fallback: if we never obtained a PID and try_wait
    ///    keeps returning Ok(None), after `no_pid_exit_threshold` checks
    ///    (default ~5 minutes) we assume the child is gone (works around a
    ///    macOS PTY quirk where portable-pty's `process_id()` returns None and
    ///    try_wait never transitions). The counter resets on any child-side
    ///    activity — PTY output *or* a submitted write — so a long silent
    ///    "thinking" pause never trips it. Genuine exits are caught far sooner
    ///    by the PTY reader hitting EOF, so this long grace has no downside.
    pub fn has_exited(&self) -> bool {
        // Number of consecutive no-PID Ok(None) checks before we declare the
        // child gone. Defaults to ~5 minutes at the 5s watchdog interval (see
        // `DEFAULT_NO_PID_EXIT_THRESHOLD`) so a silently-thinking child is not
        // killed mid-task; genuine exits are caught promptly by the PTY reader
        // EOF path, independent of this counter.
        #[cfg(unix)]
        let no_pid_threshold = self.no_pid_exit_threshold;

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
                        target: "agent_relay::worker::pty",
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
                        target: "agent_relay::worker::pty",
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
                        target: "agent_relay::worker::pty",
                        pid = pid,
                        "has_exited: kill(0) returned ESRCH — process gone"
                    );
                    self.reaped.store(true, Ordering::Relaxed);
                    return true;
                }
            }

            tracing::trace!(
                target: "agent_relay::worker::pty",
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
                target: "agent_relay::worker::pty",
                consecutive_checks = count,
                threshold = no_pid_threshold,
                "has_exited: no PID available, try_wait says Ok(None)"
            );
            if count >= no_pid_threshold {
                tracing::warn!(
                    target: "agent_relay::worker::pty",
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
                target: "agent_relay::worker::pty",
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

    /// Override the no-PID exit threshold (default
    /// [`DEFAULT_NO_PID_EXIT_THRESHOLD`]). Primarily for tests and future
    /// runtime tuning; lower values make the no-PID watchdog fire sooner.
    pub fn set_no_pid_exit_threshold(&mut self, threshold: u32) {
        self.no_pid_exit_threshold = threshold.max(1);
    }

    /// Current no-PID exit threshold (consecutive no-activity checks tolerated).
    pub fn no_pid_exit_threshold(&self) -> u32 {
        self.no_pid_exit_threshold
    }

    /// Current consecutive no-PID liveness-check count (test/diagnostic hook).
    #[cfg(test)]
    pub(crate) fn no_pid_alive_checks(&self) -> u32 {
        self.no_pid_alive_checks.load(Ordering::Relaxed)
    }

    /// Seed the no-PID counter (test hook) to simulate accumulated silent
    /// checks without waiting on a real watchdog interval.
    #[cfg(test)]
    pub(crate) fn set_no_pid_alive_checks(&self, n: u32) {
        self.no_pid_alive_checks.store(n, Ordering::Relaxed);
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
                                    target: "agent_relay::worker::pty",
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
    #[cfg(unix)]
    use super::{duplicate_poll_fd_cloexec, resolve_command_path, resolve_command_path_with};
    use super::{
        read_and_tag_output, GridSize, Mutex, PtyOutput, PtySession, PtyWriteSubmitError,
        DEFAULT_NO_PID_EXIT_THRESHOLD,
    };
    use crate::snapshot::Snapshot;
    use alacritty_terminal::event::VoidListener;
    use alacritty_terminal::term::{Config, Term};
    use alacritty_terminal::vte::ansi::Processor;
    #[cfg(unix)]
    use std::os::fd::AsRawFd;
    use std::{
        collections::VecDeque,
        env,
        io::{self, Cursor, Read},
        sync::atomic::{AtomicU64, Ordering},
    };
    use tokio::{
        sync::mpsc,
        time::{timeout, Duration},
    };

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
    async fn consumed_offset_tracks_total_bytes_parsed_into_grid() {
        let (pty, mut rx) = PtySession::spawn("echo", &["offset-line".into()], 24, 80).unwrap();
        // Drain the channel to EOF (echo exits), summing the raw bytes the
        // reader thread handed us — that must equal the grid's consumed
        // offset once the reader has parsed everything.
        let mut total: u64 = 0;
        while let Ok(Some(chunk)) = timeout(Duration::from_secs(2), rx.recv()).await {
            total += chunk.len() as u64;
        }
        // The reader increments the offset under the term lock right after
        // advancing; give it a beat to finish the last chunk.
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(total > 0, "echo should have produced output");
        assert_eq!(
            pty.consumed_offset(),
            total,
            "grid consumed offset must equal the total raw bytes streamed to the reader"
        );
        // `capture_with_offset` reports the same value, read under the lock.
        let (_snap, snap_offset) = Snapshot::capture_with_offset(&pty);
        assert_eq!(
            snap_offset, total,
            "snapshot offset must match consumed offset"
        );
        let _ = pty.shutdown();
    }

    #[tokio::test]
    async fn verified_write_boundary_includes_output_still_queued_for_consumer() {
        #[cfg(unix)]
        let script = "printf 'same-echo\\n'; IFS= read -r line; printf '%s\\n' \"$line\"";
        #[cfg(unix)]
        let (pty, mut rx) = PtySession::spawn("sh", &["-c".into(), script.into()], 24, 80).unwrap();
        #[cfg(unix)]
        let submitted = b"same-echo\n".to_vec();

        #[cfg(windows)]
        let (pty, mut rx) = PtySession::spawn(
            "cmd.exe",
            &[
                "/D".into(),
                "/Q".into(),
                "/V:ON".into(),
                "/C".into(),
                "echo same-echo&set /P line=&echo !line!".into(),
            ],
            24,
            80,
        )
        .unwrap();
        // Enter is carriage return on a Windows ConPTY input stream.
        #[cfg(windows)]
        let submitted = b"same-echo\r".to_vec();
        #[cfg(unix)]
        let harness_timeout = Duration::from_secs(2);
        // Windows hosted runners can be cold; cmd.exe is intentionally used
        // instead of PowerShell, but retain a bounded startup allowance.
        #[cfg(windows)]
        let harness_timeout = Duration::from_secs(10);

        // Do not drain rx. Wait until the intended initial marker has reached
        // the parsed grid, rather than accepting an unrelated startup VT
        // chunk merely because it incremented `output_sequence`.
        timeout(harness_timeout, async {
            while !pty.screen_text().contains("same-echo") {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("initial same-echo marker should reach the parsed grid");

        // On Windows, the reader holds `output_order` across its blocking
        // ConPTY ReadFile. Requiring the lock to be unavailable proves this
        // submission exercises CancelSynchronousIo rather than slipping into
        // the short gap before the reader starts its next read.
        #[cfg(windows)]
        timeout(harness_timeout, async {
            while pty.output_order.try_lock().is_some() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("Windows reader should block in ReadFile while awaiting input");

        // The child is idle in `read` here. Verified submission must wake an
        // idle Windows ConPTY reader (and must not be serialized behind Unix
        // readiness polling), while retaining the synchronous API.
        let submitted_at = std::time::Instant::now();
        let (ack, boundary) = pty
            .submit_write_paced_with_output_boundary(submitted, Duration::ZERO)
            .expect("queue verified write");
        assert!(
            submitted_at.elapsed() < Duration::from_secs(1),
            "verified write admission stalled behind an idle PTY read"
        );
        ack.await
            .expect("write drainer should reply")
            .expect("write should reach child");

        let mut saw_stale = false;
        let mut saw_fresh = false;
        while let Ok(Some(chunk)) = timeout(harness_timeout, rx.recv()).await {
            let text = String::from_utf8_lossy(chunk.as_bytes());
            if text.contains("same-echo") {
                if chunk.sequence() <= boundary {
                    saw_stale = true;
                } else {
                    saw_fresh = true;
                }
            }
            if saw_stale && saw_fresh {
                break;
            }
        }

        assert!(
            saw_stale,
            "the forced pre-submission chunk must be at or below the returned boundary"
        );
        assert!(
            saw_fresh,
            "the child echo read after submission must be above the returned boundary"
        );
        let _ = pty.shutdown();
    }

    #[test]
    fn completed_read_is_tagged_before_verified_write_can_sample_boundary() {
        let output_order = Arc::new(Mutex::new(()));
        let output_sequence = Arc::new(AtomicU64::new(0));
        let (copied_tx, copied_rx) = std_mpsc::channel();
        let (release_tx, release_rx) = std_mpsc::channel();

        let reader_order = output_order.clone();
        let reader_sequence = output_sequence.clone();
        let reader = std::thread::spawn(move || {
            let mut source = Cursor::new(b"same-echo".to_vec());
            let mut buf = [0u8; 32];
            read_and_tag_output(
                &mut source,
                &mut buf,
                &reader_order,
                &reader_sequence,
                |n| {
                    assert_eq!(n, b"same-echo".len());
                    copied_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                },
            )
            .unwrap()
            .unwrap()
        });
        copied_rx.recv().unwrap();

        let (write_tx, write_rx) = std_mpsc::sync_channel(WRITE_QUEUE_DEPTH);
        let no_pid = Arc::new(AtomicU32::new(0));
        let submit_order = output_order.clone();
        let submit_sequence = output_sequence.clone();
        let (submit_started_tx, submit_started_rx) = std_mpsc::channel();
        let (submitted_tx, submitted_rx) = std_mpsc::channel();
        let submitter = std::thread::spawn(move || {
            submit_started_tx.send(()).unwrap();
            let _guard = submit_order.lock();
            let boundary = submit_sequence.load(Ordering::Acquire);
            let ack = enqueue_user_write(
                &write_tx,
                &no_pid,
                b"same-echo\n".to_vec(),
                Duration::ZERO,
                None,
            )
            .unwrap();
            submitted_tx.send((boundary, ack)).unwrap();
        });
        submit_started_rx.recv().unwrap();
        assert!(
            submitted_rx
                .recv_timeout(std::time::Duration::from_millis(50))
                .is_err(),
            "verified submission overtook bytes already copied by the reader"
        );

        release_tx.send(()).unwrap();
        let (stale_len, stale_sequence) = reader.join().unwrap();
        assert_eq!(stale_len, b"same-echo".len());
        let (boundary, _ack) = submitted_rx
            .recv_timeout(std::time::Duration::from_secs(1))
            .expect("submitter proceeds after stale output is tagged");
        submitter.join().unwrap();
        assert!(stale_sequence <= boundary);

        let mut fresh = Cursor::new(b"same-echo".to_vec());
        let mut fresh_buf = [0u8; 32];
        let (_, fresh_sequence) = read_and_tag_output(
            &mut fresh,
            &mut fresh_buf,
            &output_order,
            &output_sequence,
            |_| {},
        )
        .unwrap()
        .unwrap();
        assert!(fresh_sequence > boundary);
        assert!(matches!(
            write_rx.recv().unwrap(),
            WriteMsg::UserInput { .. }
        ));
    }

    #[cfg(unix)]
    #[test]
    fn polling_descriptor_is_created_close_on_exec() {
        let source = std::fs::File::open("/dev/null").unwrap();
        let duplicate = duplicate_poll_fd_cloexec(source.as_raw_fd()).unwrap();
        assert_ne!(duplicate.as_raw_fd(), source.as_raw_fd());

        let flags = unsafe { libc::fcntl(duplicate.as_raw_fd(), libc::F_GETFD) };
        assert!(flags >= 0, "F_GETFD failed: {}", io::Error::last_os_error());
        assert_ne!(
            flags & libc::FD_CLOEXEC,
            0,
            "polling descriptor must not leak into unrelated child processes"
        );
    }

    #[test]
    fn output_channel_backpressure_does_not_hold_verified_write_ordering() {
        struct ChunkReader(VecDeque<Vec<u8>>);
        impl Read for ChunkReader {
            fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
                let Some(chunk) = self.0.pop_front() else {
                    return Ok(0);
                };
                buf[..chunk.len()].copy_from_slice(&chunk);
                Ok(chunk.len())
            }
        }

        let output_order = Arc::new(Mutex::new(()));
        let output_sequence = Arc::new(AtomicU64::new(0));
        let (output_tx, mut output_rx) = mpsc::channel(1);
        let (second_tagged_tx, second_tagged_rx) = std_mpsc::channel();
        let reader_order = output_order.clone();
        let reader_sequence = output_sequence.clone();
        let reader = std::thread::spawn(move || {
            let mut source = ChunkReader(VecDeque::from([b"one".to_vec(), b"two".to_vec()]));
            let mut buf = [0u8; 8];
            for expected in [b"one".as_slice(), b"two".as_slice()] {
                let (n, sequence) = read_and_tag_output(
                    &mut source,
                    &mut buf,
                    &reader_order,
                    &reader_sequence,
                    |_| {},
                )
                .unwrap()
                .unwrap();
                if sequence == 2 {
                    second_tagged_tx.send(()).unwrap();
                }
                output_tx
                    .blocking_send(PtyOutput {
                        bytes: buf[..n].to_vec(),
                        sequence,
                    })
                    .unwrap();
                assert_eq!(&buf[..n], expected);
            }
        });

        second_tagged_rx
            .recv_timeout(std::time::Duration::from_secs(1))
            .expect("second chunk is tagged before bounded output send blocks");
        let admitted_at = std::time::Instant::now();
        let boundary = {
            let _guard = output_order.lock();
            output_sequence.load(Ordering::Acquire)
        };
        assert_eq!(boundary, 2);
        assert!(
            admitted_at.elapsed() < std::time::Duration::from_millis(100),
            "output channel backpressure held the verified-write ordering lock"
        );

        let first = output_rx.blocking_recv().unwrap();
        let second = output_rx.blocking_recv().unwrap();
        reader.join().unwrap();
        assert_eq!((first.sequence(), first.as_bytes()), (1, b"one".as_slice()));
        assert_eq!(
            (second.sequence(), second.as_bytes()),
            (2, b"two".as_slice())
        );
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

    use super::{
        enqueue_user_write, FollowupWrite, RelayEventListener, WriteMsg, WRITE_QUEUE_DEPTH,
    };
    use std::sync::atomic::AtomicU32;
    use std::sync::mpsc as std_mpsc;
    use std::sync::Arc;
    use std::time::Duration as StdDuration;
    use tokio::sync::oneshot;

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

        let (ack_tx_1, _ack_rx_1) = oneshot::channel::<std::io::Result<()>>();
        tx.send(WriteMsg::UserInput {
            bytes: b"injection-body".to_vec(),
            pace: Duration::ZERO,
            followup: None,
            ack: ack_tx_1,
        })
        .unwrap();
        tx.send(WriteMsg::Reply(b"\x1b[0n".to_vec())).unwrap();
        let (ack_tx_2, _ack_rx_2) = oneshot::channel::<std::io::Result<()>>();
        tx.send(WriteMsg::UserInput {
            bytes: b"\r".to_vec(),
            pace: Duration::ZERO,
            followup: None,
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

    #[tokio::test]
    async fn user_input_ack_reports_write_failure() {
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
        let drainer = std::thread::spawn(move || {
            super::drain_write_queue(AlwaysFailWriter, rx, Arc::new(AtomicU32::new(0)))
        });

        let (ack_tx, ack_rx) = oneshot::channel::<std::io::Result<()>>();
        tx.send(WriteMsg::UserInput {
            bytes: b"should-fail\n".to_vec(),
            pace: Duration::ZERO,
            followup: None,
            ack: ack_tx,
        })
        .expect("queue accepts user input");

        let ack = tokio::time::timeout(Duration::from_millis(200), ack_rx)
            .await
            .expect("drainer must ack user input writes")
            .expect("ack sender not dropped");
        assert!(ack.is_err(), "drainer write failure must be surfaced");

        drop(tx);
        drainer.join().expect("drainer thread joins cleanly");
    }

    #[tokio::test]
    async fn user_input_ack_reports_flush_failure() {
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
        let drainer = std::thread::spawn(move || {
            super::drain_write_queue(FlushFailWriter, rx, Arc::new(AtomicU32::new(0)))
        });

        let (ack_tx, ack_rx) = oneshot::channel::<std::io::Result<()>>();
        tx.send(WriteMsg::UserInput {
            bytes: b"flush-should-fail\n".to_vec(),
            pace: Duration::ZERO,
            followup: None,
            ack: ack_tx,
        })
        .expect("queue accepts user input");

        let ack = tokio::time::timeout(Duration::from_millis(200), ack_rx)
            .await
            .expect("drainer must ack user input writes")
            .expect("ack sender not dropped");
        assert!(ack.is_err(), "drainer flush failure must be surfaced");

        drop(tx);
        drainer.join().expect("drainer thread joins cleanly");
    }

    /// `submit_write` must deliver bytes to the child and resolve its ack
    /// receiver with `Ok(())` once the drainer has flushed them. Uses `cat`,
    /// which echoes stdin straight back to stdout.
    #[tokio::test]
    async fn submit_write_delivers_and_acks() {
        let (pty, mut rx) = PtySession::spawn("cat", &[], 24, 80).unwrap();
        let ack = pty
            .submit_write(b"round-trip\n".to_vec())
            .expect("submit_write enqueues");
        ack.await
            .expect("drainer acks")
            .expect("write to cat succeeds");

        let mut collected = Vec::new();
        while let Ok(Some(chunk)) = timeout(Duration::from_secs(2), rx.recv()).await {
            collected.extend_from_slice(&chunk);
            if String::from_utf8_lossy(&collected).contains("round-trip") {
                break;
            }
        }
        assert!(
            String::from_utf8_lossy(&collected).contains("round-trip"),
            "cat should echo the submitted bytes, got: {:?}",
            String::from_utf8_lossy(&collected)
        );
        let _ = pty.shutdown();
    }

    /// Regression for the write-path deadlock: when the child stops reading
    /// its stdin (here `cat`'s output PTY buffer backs up because we never
    /// drain `rx`), the write queue fills and the drainer wedges. The old
    /// blocking `write_all` parked the caller forever; `submit_write` must
    /// instead surface a full-queue `Err` promptly so the worker loop stays
    /// responsive. If `submit_write` ever blocked, the outer `timeout` would
    /// fire and fail the test.
    #[tokio::test]
    async fn submit_write_never_blocks_when_child_stops_reading() {
        // `sleep` never reads its stdin, so the kernel PTY input buffer fills
        // and the drainer wedges in `writer.write_all`. We also never drain
        // `_rx`. This is exactly the deadlock scenario from the bug report.
        let (pty, _rx) = PtySession::spawn("sleep", &["30".into()], 24, 80).unwrap();

        let flooded = timeout(Duration::from_secs(5), async {
            loop {
                // Large chunks fill the kernel PTY buffer quickly, then the
                // bounded write queue, at which point submit_write returns Err.
                if pty.submit_write(vec![b'x'; 8192]).is_err() {
                    return true;
                }
                tokio::task::yield_now().await;
            }
        })
        .await;

        assert_eq!(
            flooded,
            Ok(true),
            "submit_write must return an error when the queue fills, never block"
        );
        let _ = pty.shutdown();
    }

    /// relay#1597 MUST-FIRE: the full-queue rejection must be recoverable as a
    /// *typed* variant, not only as prose.
    ///
    /// The broker turns this into the wire code an attach client uses to decide
    /// whether its input stream is dead (`pty_write_queue_full`) or merely
    /// refused one write. Matching on the message text there would silently
    /// start closing healthy sessions the first time this wording changed, so
    /// the type is the contract. Revert `enqueue_user_write` to
    /// `anyhow::anyhow!("pty write queue full …")` and the downcast goes None.
    #[tokio::test]
    async fn full_write_queue_reports_a_typed_queue_full_error() {
        let (pty, _rx) = PtySession::spawn("sleep", &["30".into()], 24, 80).unwrap();

        let err = timeout(Duration::from_secs(5), async {
            loop {
                if let Err(err) = pty.submit_write(vec![b'x'; 8192]) {
                    return err;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("submit_write must fail promptly, never block");

        match err.downcast_ref::<PtyWriteSubmitError>() {
            Some(PtyWriteSubmitError::QueueFull { depth }) => {
                assert_eq!(*depth, WRITE_QUEUE_DEPTH);
            }
            other => panic!("expected a typed QueueFull error, got {other:?}"),
        }
        // The operator-facing text still has to explain itself.
        let rendered = err.to_string();
        assert!(
            rendered.contains("pty write queue full") && rendered.contains("128"),
            "queue-full error lost its explanation: {rendered}"
        );
        let _ = pty.shutdown();
    }

    // ---- No-PID watchdog hardening (#1247) ----

    /// The default grace before a no-PID child is declared dead must be
    /// several minutes, not the old ~30s that could kill a silently-thinking
    /// agent mid-task. At the 5s watchdog interval, require >= 3 minutes.
    #[test]
    fn default_no_pid_threshold_is_several_minutes() {
        let seconds = DEFAULT_NO_PID_EXIT_THRESHOLD as u64 * 5;
        assert!(
            seconds >= 180,
            "no-PID grace is only {seconds}s; a silent 'thinking' pause could exceed it"
        );
    }

    /// A living child that produces no output for a long stretch must not be
    /// declared exited by the watchdog. (`sleep` is silent for its whole run.)
    #[tokio::test]
    async fn silent_child_is_not_declared_exited() {
        let (pty, _rx) = PtySession::spawn("sleep", &["30".into()], 24, 80).unwrap();
        // Even simulating many accumulated silent checks — up to just below the
        // threshold — the child is still considered alive.
        pty.set_no_pid_alive_checks(pty.no_pid_exit_threshold() - 1);
        assert!(
            !pty.has_exited(),
            "a silent but living child must not be declared exited"
        );
        let _ = pty.shutdown();
    }

    /// A genuinely exited child must still be detected promptly regardless of
    /// the (now much longer) no-PID grace — try_wait/kill(0) catch it.
    #[tokio::test]
    async fn real_exit_is_still_detected() {
        let (pty, _rx) = PtySession::spawn("sh", &["-c".into(), "exit 0".into()], 24, 80).unwrap();
        let detected = timeout(Duration::from_secs(5), async {
            loop {
                if pty.has_exited() {
                    break true;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await;
        assert_eq!(detected, Ok(true), "a real child exit must be detected");
        let _ = pty.shutdown();
    }

    /// A *confirmed* write is child-side activity and must reset the no-PID
    /// silence counter, so an interactive session receiving input but emitting
    /// no output for a while is never declared dead. The reset is driven by the
    /// drainer once the bytes flush — awaiting the ack proves that path.
    #[tokio::test]
    async fn write_resets_no_pid_counter() {
        let (pty, _rx) = PtySession::spawn("cat", &[], 24, 80).unwrap();
        pty.set_no_pid_alive_checks(pty.no_pid_exit_threshold() - 1);
        let ack = pty
            .submit_write(b"hello\n".to_vec())
            .expect("submit_write enqueues");
        // The drainer resets the counter on confirmed write success, so wait
        // for the ack before asserting.
        ack.await
            .expect("drainer acks the write")
            .expect("write succeeds");
        assert_eq!(
            pty.no_pid_alive_checks(),
            0,
            "a confirmed write must reset the no-PID silence counter"
        );
        let _ = pty.shutdown();
    }

    /// A mere *enqueue* must not reset the counter: if the drainer is wedged and
    /// never flushes, periodic input can't indefinitely defer the no-PID
    /// fallback. This drives the *real* [`drain_write_queue`] against a writer
    /// that blocks forever inside `write`, so the message is picked up but never
    /// confirmed — proving the reset is gated on a confirmed write, not on
    /// enqueue. (Asserting on a counter no drainer ever touches would pass
    /// unconditionally and catch nothing.)
    #[tokio::test]
    async fn enqueue_without_confirm_does_not_reset_no_pid_counter() {
        // Signals when the drainer has actually dequeued the message and
        // entered `write` — so the assertion below observes the genuine
        // "picked up but unconfirmed" state, not a race where the drainer
        // hasn't touched the message yet (which would pass vacuously).
        let (entered_tx, entered_rx) = std_mpsc::channel::<()>();
        struct BlockingWriter {
            entered: std_mpsc::Sender<()>,
        }
        impl std::io::Write for BlockingWriter {
            fn write(&mut self, _buf: &[u8]) -> std::io::Result<usize> {
                // Announce entry, then wedge: never return before the test
                // asserts, so the write can never be confirmed.
                let _ = self.entered.send(());
                std::thread::sleep(StdDuration::from_secs(60));
                Ok(0)
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }

        let counter = Arc::new(AtomicU32::new(5));
        let (tx, rx) = std_mpsc::sync_channel::<WriteMsg>(WRITE_QUEUE_DEPTH);
        let counter_for_drainer = counter.clone();
        let _drainer = std::thread::spawn(move || {
            super::drain_write_queue(
                BlockingWriter {
                    entered: entered_tx,
                },
                rx,
                counter_for_drainer,
            )
        });

        let ack = enqueue_user_write(
            &tx,
            counter.as_ref(),
            b"queued\n".to_vec(),
            Duration::ZERO,
            None,
        )
        .expect("submit path accepts the write");
        // Block until the drainer has dequeued the message and is wedged inside
        // `write` — the write is now genuinely picked up but not confirmed.
        entered_rx
            .recv_timeout(StdDuration::from_secs(5))
            .expect("drainer reaches write() with the queued message");
        // The wedged write leaves the ack pending — never confirmed.
        assert!(
            timeout(Duration::from_millis(50), ack).await.is_err(),
            "a wedged writer must leave the write unconfirmed"
        );
        // Because the write never confirmed+flushed, the drainer must not have
        // reset the silence counter. If `drain_write_queue` were changed to
        // reset on receipt instead of on confirmation, this would drop to 0.
        assert_eq!(
            counter.load(std::sync::atomic::Ordering::Relaxed),
            5,
            "an unconfirmed write must not reset the silence counter"
        );
    }

    /// The threshold is configurable and clamped to at least 1.
    #[tokio::test]
    async fn no_pid_threshold_is_configurable() {
        let (mut pty, _rx) = PtySession::spawn("sleep", &["30".into()], 24, 80).unwrap();
        pty.set_no_pid_exit_threshold(42);
        assert_eq!(pty.no_pid_exit_threshold(), 42);
        pty.set_no_pid_exit_threshold(0);
        assert_eq!(pty.no_pid_exit_threshold(), 1, "threshold clamps to >= 1");
        let _ = pty.shutdown();
    }

    // ---- Escape-aware paced injection (#801) ----

    #[test]
    fn next_atom_end_plain_ascii_and_control_are_one_byte() {
        assert_eq!(super::next_atom_end(b"hello"), 1);
        assert_eq!(super::next_atom_end(b"\r"), 1);
        assert_eq!(super::next_atom_end(b"\n"), 1);
    }

    #[test]
    fn next_atom_end_keeps_csi_sequence_atomic() {
        // Up arrow: ESC [ A.
        assert_eq!(super::next_atom_end(b"\x1b[A"), 3);
        // Modified key with params + separators: ESC [ 1 ; 5 A.
        assert_eq!(super::next_atom_end(b"\x1b[1;5A"), 6);
        // Only the sequence is one atom; trailing text is a separate atom.
        assert_eq!(super::next_atom_end(b"\x1b[0mX"), 4);
    }

    #[test]
    fn next_atom_end_keeps_ss3_sequence_atomic() {
        // SS3 (application cursor mode): ESC O A.
        assert_eq!(super::next_atom_end(b"\x1bOA"), 3);
        assert_eq!(super::next_atom_end(b"\x1bOFtail"), 3);
    }

    #[test]
    fn next_atom_end_keeps_osc_sequence_atomic() {
        // OSC set-title terminated by BEL (index 9 → length 10).
        assert_eq!(super::next_atom_end(b"\x1b]0;title\x07after"), 10);
        // OSC terminated by ST (ESC \).
        assert_eq!(super::next_atom_end(b"\x1b]0;t\x1b\\x"), 7);
    }

    #[test]
    fn next_atom_end_two_byte_escape() {
        // ESC ESC (steer prefix) is a two-byte atom.
        assert_eq!(super::next_atom_end(b"\x1b\x1b"), 2);
        // ESC <letter> that isn't [ / O / ] is also two bytes.
        assert_eq!(super::next_atom_end(b"\x1bMrest"), 2);
    }

    #[test]
    fn next_atom_end_multibyte_utf8_stays_whole() {
        assert_eq!(super::next_atom_end("é".as_bytes()), 2);
        assert_eq!(super::next_atom_end("€".as_bytes()), 3);
        assert_eq!(super::next_atom_end("😀".as_bytes()), 4);
    }

    #[test]
    fn next_atom_end_truncated_sequences_make_progress() {
        // Sequences cut off by end-of-buffer return the remainder so the pacer
        // emits them as-is rather than spinning forever.
        assert_eq!(super::next_atom_end(b"\x1b"), 1);
        assert_eq!(super::next_atom_end(b"\x1b["), 2);
        assert_eq!(super::next_atom_end(b"\x1bO"), 2);
        // Truncated 4-byte UTF-8 lead clamps to what's present.
        assert_eq!(super::next_atom_end(&[0xf0, 0x9f]), 2);
        // A stray continuation byte advances by one.
        assert_eq!(super::next_atom_end(&[0x9f, 0x98]), 1);
    }

    /// The core requirement from #801: a payload mixing CSI / SS3 / OSC escape
    /// sequences, a two-byte `ESC ESC`, and multi-byte UTF-8 must be written
    /// one whole atom per `write` call — never split mid-sequence — while
    /// reproducing the original bytes exactly and in order.
    #[test]
    fn write_paced_emits_atoms_without_splitting_sequences() {
        use std::sync::Mutex as StdMutex;

        // Records each `write` call separately. `write_all` calls `write` once
        // per atom because this writer consumes the whole slice each call, so a
        // recorded chunk == one atom handed to `write_paced`.
        struct RecordingWriter {
            chunks: Arc<StdMutex<Vec<Vec<u8>>>>,
        }
        impl std::io::Write for RecordingWriter {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                self.chunks.lock().unwrap().push(buf.to_vec());
                Ok(buf.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }

        // plain, CSI (with params), SS3, OSC+BEL, ESC ESC, plain, 😀, CR.
        let payload = b"hi\x1b[1;5A\x1bOB\x1b]0;t\x07\x1b\x1bX\xf0\x9f\x98\x80\r".to_vec();
        let chunks = Arc::new(StdMutex::new(Vec::new()));
        let mut writer = RecordingWriter {
            chunks: chunks.clone(),
        };
        // Zero pace keeps the test instant; it still walks the atom loop.
        super::write_paced(&mut writer, &payload, StdDuration::ZERO).unwrap();

        let chunks = chunks.lock().unwrap().clone();
        let flat: Vec<u8> = chunks.iter().flatten().copied().collect();
        assert_eq!(
            flat, payload,
            "paced write must reproduce the payload bytes in order"
        );
        let expected: Vec<Vec<u8>> = vec![
            b"h".to_vec(),
            b"i".to_vec(),
            b"\x1b[1;5A".to_vec(),
            b"\x1bOB".to_vec(),
            b"\x1b]0;t\x07".to_vec(),
            b"\x1b\x1b".to_vec(),
            b"X".to_vec(),
            "😀".as_bytes().to_vec(),
            b"\r".to_vec(),
        ];
        assert_eq!(
            chunks, expected,
            "each write call must be exactly one escape-aware atom"
        );
    }

    /// A paced `WriteMsg::UserInput` routed through the real drainer must
    /// deliver every byte and ack success, proving the pacing branch is wired
    /// end-to-end (not just the standalone helper).
    #[tokio::test]
    async fn drainer_paced_user_input_delivers_and_acks() {
        use std::sync::Mutex as StdMutex;
        struct CollectWriter {
            out: Arc<StdMutex<Vec<u8>>>,
        }
        impl std::io::Write for CollectWriter {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                self.out.lock().unwrap().extend_from_slice(buf);
                Ok(buf.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }

        let out = Arc::new(StdMutex::new(Vec::new()));
        let (tx, rx) = std_mpsc::sync_channel::<WriteMsg>(WRITE_QUEUE_DEPTH);
        let writer = CollectWriter { out: out.clone() };
        let drainer = std::thread::spawn(move || {
            super::drain_write_queue(writer, rx, Arc::new(AtomicU32::new(0)))
        });

        let (ack_tx, ack_rx) = oneshot::channel::<std::io::Result<()>>();
        tx.send(WriteMsg::UserInput {
            bytes: b"go\x1b[A\r".to_vec(),
            pace: StdDuration::from_millis(1),
            followup: None,
            ack: ack_tx,
        })
        .expect("queue accepts paced user input");

        let ack = tokio::time::timeout(Duration::from_secs(2), ack_rx)
            .await
            .expect("drainer acks paced write")
            .expect("ack sender not dropped");
        assert!(ack.is_ok(), "paced write must succeed");
        assert_eq!(
            out.lock().unwrap().as_slice(),
            b"go\x1b[A\r",
            "paced write must deliver every byte in order"
        );

        drop(tx);
        drainer.join().expect("drainer thread joins cleanly");
    }

    /// A delayed follow-up must be a distinct PTY write while remaining inside
    /// the same FIFO command. Claude Code needs this shape for multiline task
    /// submission: body first, then Enter after the paste boundary settles.
    #[tokio::test]
    async fn drainer_keeps_delayed_followup_atomic_and_acks_both_writes() {
        use std::sync::Mutex as StdMutex;

        struct RecordingWriter {
            chunks: Arc<StdMutex<Vec<Vec<u8>>>>,
        }
        impl std::io::Write for RecordingWriter {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                self.chunks.lock().unwrap().push(buf.to_vec());
                Ok(buf.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }

        let chunks = Arc::new(StdMutex::new(Vec::new()));
        let (tx, rx) = std_mpsc::sync_channel::<WriteMsg>(WRITE_QUEUE_DEPTH);
        let writer = RecordingWriter {
            chunks: chunks.clone(),
        };
        let drainer = std::thread::spawn(move || {
            super::drain_write_queue(writer, rx, Arc::new(AtomicU32::new(0)))
        });

        let (ack_tx, ack_rx) = oneshot::channel::<std::io::Result<()>>();
        tx.send(WriteMsg::UserInput {
            bytes: b"multiline\nbody".to_vec(),
            pace: StdDuration::ZERO,
            followup: Some(FollowupWrite {
                delay: StdDuration::from_millis(5),
                bytes: b"\r".to_vec(),
            }),
            ack: ack_tx,
        })
        .expect("queue accepts the compound write");
        tx.send(WriteMsg::Reply(b"terminal-reply".to_vec()))
            .expect("queue accepts a following terminal reply");

        let ack = tokio::time::timeout(Duration::from_secs(1), ack_rx)
            .await
            .expect("drainer acks the compound write")
            .expect("ack sender not dropped");
        assert!(
            ack.is_ok(),
            "both writes in the compound command must succeed"
        );

        drop(tx);
        drainer.join().expect("drainer thread joins cleanly");
        assert_eq!(
            chunks.lock().unwrap().as_slice(),
            [
                b"multiline\nbody".to_vec(),
                b"\r".to_vec(),
                b"terminal-reply".to_vec(),
            ],
            "the follow-up is a distinct write and no later FIFO item can splice before it"
        );
    }

    #[tokio::test]
    async fn delayed_followup_failure_rejects_the_compound_write() {
        struct FailSecondWriter {
            writes: usize,
        }
        impl std::io::Write for FailSecondWriter {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                self.writes += 1;
                if self.writes == 2 {
                    Err(std::io::Error::new(
                        std::io::ErrorKind::BrokenPipe,
                        "forced follow-up failure",
                    ))
                } else {
                    Ok(buf.len())
                }
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }

        let (tx, rx) = std_mpsc::sync_channel::<WriteMsg>(WRITE_QUEUE_DEPTH);
        let drainer = std::thread::spawn(move || {
            super::drain_write_queue(
                FailSecondWriter { writes: 0 },
                rx,
                Arc::new(AtomicU32::new(0)),
            )
        });
        let (ack_tx, ack_rx) = oneshot::channel::<std::io::Result<()>>();
        tx.send(WriteMsg::UserInput {
            bytes: b"body".to_vec(),
            pace: StdDuration::ZERO,
            followup: Some(FollowupWrite {
                delay: StdDuration::ZERO,
                bytes: b"\r".to_vec(),
            }),
            ack: ack_tx,
        })
        .expect("queue accepts the compound write");

        let ack = tokio::time::timeout(Duration::from_secs(1), ack_rx)
            .await
            .expect("drainer resolves the compound write")
            .expect("ack sender not dropped");
        assert!(
            ack.is_err(),
            "a failed submit key must reject the whole write"
        );

        drop(tx);
        drainer.join().expect("drainer thread joins cleanly");
    }

    /// Regression: mise/asdf/rtx expose provider CLIs (codex, claude, gemini)
    /// as symlinked shims that all point at the version-manager binary. Those
    /// shims dispatch on `argv[0]` (the shim's basename), so canonicalising
    /// the symlink to `.../bin/mise` makes the manager parse provider flags
    /// like `--dangerously-bypass-approvals-and-sandbox` as its own arguments
    /// and abort the worker before it starts.
    ///
    /// `resolve_command_path` must keep the shim path, so `CommandBuilder`
    /// spawns the child with `argv[0] = "codex"` and the flags reach the
    /// intended provider CLI.
    #[cfg(unix)]
    #[test]
    fn resolve_command_path_preserves_mise_style_shim_via_path_lookup() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().expect("tempdir");
        let manager_dir = tmp.path().join("mgr");
        let shim_dir = tmp.path().join("shims");
        std::fs::create_dir_all(&manager_dir).unwrap();
        std::fs::create_dir_all(&shim_dir).unwrap();

        let manager = manager_dir.join("mise");
        std::fs::write(&manager, b"#!/bin/sh\nexit 0\n").unwrap();

        let shim = shim_dir.join("codex");
        symlink(&manager, &shim).expect("symlink");

        // Passing PATH explicitly avoids racing on process-wide PATH mutation
        // between parallel test threads.
        let path_var = std::env::join_paths([&shim_dir, &manager_dir]).unwrap();
        let resolved = resolve_command_path_with("codex", path_var.as_os_str());

        assert!(
            resolved.ends_with("/codex"),
            "shim basename must survive resolution so argv[0] stays 'codex' \
             (mise/asdf dispatch on argv[0]); got {resolved:?}"
        );
        assert!(
            !resolved.ends_with("/mise"),
            "must NOT collapse the shim to the version-manager binary \
             (would cause mise to parse provider flags); got {resolved:?}"
        );
        // Preserving argv[0] on unix requires an absolute path so the child
        // spawn does not depend on the parent's PATH.
        assert!(
            std::path::Path::new(&resolved).is_absolute(),
            "resolved shim path must be absolute; got {resolved:?}"
        );
    }

    /// Same shim rule when the caller supplies an explicit path to the shim
    /// (rather than a bare command that we PATH-search).
    #[cfg(unix)]
    #[test]
    fn resolve_command_path_preserves_shim_when_given_explicit_shim_path() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().expect("tempdir");
        let manager_dir = tmp.path().join("mgr");
        let shim_dir = tmp.path().join("shims");
        std::fs::create_dir_all(&manager_dir).unwrap();
        std::fs::create_dir_all(&shim_dir).unwrap();

        let manager = manager_dir.join("asdf");
        std::fs::write(&manager, b"#!/bin/sh\nexit 0\n").unwrap();
        let shim = shim_dir.join("gemini");
        symlink(&manager, &shim).expect("symlink");

        let resolved = resolve_command_path(shim.to_str().unwrap());

        assert!(
            resolved.ends_with("/gemini"),
            "shim basename must survive when caller passes the shim path; got {resolved:?}"
        );
        assert!(
            !resolved.ends_with("/asdf"),
            "must NOT collapse the shim to the version-manager binary; got {resolved:?}"
        );
    }

    /// Non-shim symlinks (target basename matches the source basename — the
    /// common case where a bin dir is itself a symlink) should still be
    /// resolved, so we do not regress the posix_spawnp fix that motivated
    /// the original `canonicalize_display` behaviour.
    #[cfg(unix)]
    #[test]
    fn resolve_command_path_still_canonicalizes_same_name_symlinks() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().expect("tempdir");
        let real_dir = tmp.path().join("real");
        let link_dir = tmp.path().join("link");
        std::fs::create_dir_all(&real_dir).unwrap();

        let real_bin = real_dir.join("mytool");
        std::fs::write(&real_bin, b"#!/bin/sh\nexit 0\n").unwrap();
        // link/mytool is a symlink to real/mytool — same basename, so
        // canonicalising is safe (argv[0] is unchanged).
        std::fs::create_dir_all(&link_dir).unwrap();
        symlink(&real_bin, link_dir.join("mytool")).expect("symlink");

        let path_var = std::env::join_paths([&link_dir]).unwrap();
        let resolved = resolve_command_path_with("mytool", path_var.as_os_str());

        assert_eq!(
            std::path::PathBuf::from(resolved),
            std::fs::canonicalize(&real_bin).unwrap(),
            "same-name symlink should resolve to the canonical target"
        );
    }

    /// End-to-end proof through `PtySession::spawn`: point a shim named
    /// `codex-shim` at a fake mise that echoes `$0` and every argument, then
    /// verify the child actually receives `argv[0] = "codex-shim"` and the
    /// provider flag as its own argument (rather than the mise binary
    /// receiving the flag).
    ///
    /// Passes the shim to `PtySession::spawn` as an absolute path so this
    /// test does not race on process-wide PATH mutation with sibling tests.
    #[cfg(unix)]
    #[tokio::test]
    async fn pty_spawn_preserves_shim_argv0_for_mise_style_symlink() {
        use std::os::unix::fs::symlink;
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().expect("tempdir");
        let manager_dir = tmp.path().join("mgr");
        let shim_dir = tmp.path().join("shims");
        std::fs::create_dir_all(&manager_dir).unwrap();
        std::fs::create_dir_all(&shim_dir).unwrap();

        // Fake mise: prints argv[0] and all args, then exits.
        let manager = manager_dir.join("mise");
        std::fs::write(
            &manager,
            b"#!/bin/sh\nprintf 'argv0=%s\\n' \"$0\"\nfor a in \"$@\"; do printf 'arg=%s\\n' \"$a\"; done\n",
        )
        .unwrap();
        std::fs::set_permissions(&manager, std::fs::Permissions::from_mode(0o755)).unwrap();

        let shim = shim_dir.join("codex-shim");
        symlink(&manager, &shim).expect("symlink");

        let flag = "--dangerously-bypass-approvals-and-sandbox".to_string();
        let (pty, mut rx) = PtySession::spawn(
            shim.to_str().expect("shim path utf8"),
            std::slice::from_ref(&flag),
            24,
            80,
        )
        .expect("spawn shim");

        let mut collected = Vec::new();
        while let Ok(Some(chunk)) = timeout(Duration::from_secs(2), rx.recv()).await {
            collected.extend_from_slice(&chunk);
            let s = String::from_utf8_lossy(&collected);
            if s.contains("arg=--dangerously-bypass") {
                break;
            }
        }
        let _ = pty.shutdown();

        let output = String::from_utf8_lossy(&collected);
        assert!(
            output.contains("codex-shim"),
            "child argv[0] must be the shim basename, not the manager binary; got: {output}"
        );
        assert!(
            output.contains("arg=--dangerously-bypass-approvals-and-sandbox"),
            "provider flag must reach the shim as an argument (not be parsed by the manager); got: {output}"
        );
    }
}
