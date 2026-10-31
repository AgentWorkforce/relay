//! `history flush`: a hosted sandbox's teardown upload. Cloud has already
//! exchanged a push-only `rth_*` session server-side and hands it to this
//! command on stdin or in a file; the command captures every local session
//! into a store of its own, then drains it through the same delivery worker,
//! receiver and destination the collector uses, until the queue is empty or
//! the deadline passes. It makes no Agent Relay Cloud request, inspects no
//! legacy scheduler, and never stores a refresh token.
//!
//! stdout carries exactly one JSON summary line, with no paths, tokens or
//! content. Exit codes: 0 every record acknowledged; 3 records still queued at
//! the deadline; 2 a session refused locally or by the receiver; 4 the
//! generation is blocked or conflicts; 64 invalid arguments; 1 anything else.
use super::{collector, history, private_directory};
use agent_relay_probe::{
    cloud,
    delivery::{self, worker},
    destination,
};
use anyhow::{Context, Result};
use clap::Args;
use serde::Deserialize;
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicI64, Ordering},
        mpsc, Arc,
    },
    time::{Duration, Instant},
};

const STATE_MARKER: &str = ".agent-relay-history-flush";
const STATE_MARKER_CONTENT: &[u8] = b"agent-relay-history-flush-v1\n";
const STATE_LOCK: &str = ".agent-relay-history-flush.lock";
const WATCHDOG_GRACE: Duration = Duration::from_millis(250);

#[derive(Args)]
pub struct Flush {
    /// Read the session JSON from stdin.
    #[arg(
        long,
        conflicts_with = "session_file",
        required_unless_present = "session_file"
    )]
    session_stdin: bool,
    /// Read the session JSON from this file, which is then removed.
    #[arg(long)]
    session_file: Option<PathBuf>,
    /// Where the flush keeps its own store. Created private.
    #[arg(long)]
    state_dir: PathBuf,
    /// Wall-clock budget for the whole flush, capture included.
    #[arg(long, value_parser = clap::value_parser!(u64).range(1..=86_400))]
    deadline_secs: u64,
    /// A name for this flush's delivery worker, for the host's own records.
    #[arg(long)]
    label: Option<String>,
}

/// The `/v1/cli/login` response Cloud pushes. Any other field, a refresh
/// token included, is ignored.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PushedSession {
    base_url: String,
    access_token: String,
    access_token_expires_at: String,
    org_id: String,
    workspace_id: String,
    scopes: Vec<String>,
}

/// How a flush ended: its exit code and the summary's `exit_reason`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Exit {
    Drained,
    Deadline,
    InvalidArguments,
    InvalidSession,
    Unauthorized,
    Blocked,
    Failed,
}
impl Exit {
    fn code(self) -> i32 {
        match self {
            Exit::Drained => 0,
            Exit::Failed => 1,
            Exit::InvalidSession | Exit::Unauthorized => 2,
            Exit::Deadline => 3,
            Exit::Blocked => 4,
            Exit::InvalidArguments => 64,
        }
    }
    fn reason(self) -> &'static str {
        match self {
            Exit::Drained => "drained",
            Exit::Deadline => "deadline",
            Exit::InvalidArguments => "invalid_arguments",
            Exit::InvalidSession => "invalid_session",
            Exit::Unauthorized => "unauthorized",
            Exit::Blocked => "blocked",
            Exit::Failed => "failed",
        }
    }
}

#[derive(Default)]
struct Counts {
    acknowledged_records: AtomicI64,
    pending_records: AtomicI64,
    sessions_captured: AtomicI64,
}
impl Counts {
    fn of(&self, status: &delivery::DeliveryStatus) {
        self.acknowledged_records
            .store(status.acknowledged_records, Ordering::SeqCst);
        self.pending_records.store(
            status
                .pending_records
                .saturating_add(status.unqueued_changes),
            Ordering::SeqCst,
        );
    }
}

/// Shapes an `rth_*` access or refresh token always has.
fn looks_like_token(value: &str) -> bool {
    value.contains("rth_at_") || value.contains("rth_rt_")
}

fn emit(exit: Exit, counts: &Counts, started: Instant) {
    let line = serde_json::json!({
        "ok": exit == Exit::Drained,
        "acknowledged_records": counts.acknowledged_records.load(Ordering::SeqCst),
        "pending_records": counts.pending_records.load(Ordering::SeqCst),
        "sessions_captured": counts.sessions_captured.load(Ordering::SeqCst),
        "elapsed_ms": u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        "exit_reason": exit.reason(),
    })
    .to_string();
    let stdout = std::io::stdout();
    let mut stdout = stdout.lock();
    let _ = writeln!(stdout, "{line}");
    let _ = stdout.flush();
}

/// Refuse a token anywhere on a `history` command line, before the argument
/// parser can echo it back in a usage error.
pub fn refuse_token_on_argv() {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.iter().any(|arg| arg == "history")
        && args
            .iter()
            .any(|arg| looks_like_token(&arg.to_string_lossy()))
    {
        eprintln!(
            "A credential was passed on the command line. Pass the session on stdin or in a file."
        );
        emit(Exit::InvalidSession, &Counts::default(), Instant::now());
        std::process::exit(Exit::InvalidSession.code());
    }
}

/// Whether the argv names the hidden hosted teardown command. This is checked
/// before clap exits so even usage errors retain its one-line JSON contract.
pub fn requested_on_argv() -> bool {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    args.iter()
        .position(|arg| arg == "history")
        .is_some_and(|history| args[history + 1..].iter().any(|arg| arg == "flush"))
}

pub fn invalid_arguments() -> ! {
    emit(Exit::InvalidArguments, &Counts::default(), Instant::now());
    std::process::exit(Exit::InvalidArguments.code())
}

pub fn run(options: Flush) -> ! {
    let started = Instant::now();
    let deadline = started + Duration::from_secs(options.deadline_secs);
    let counts = Arc::new(Counts::default());
    let finished = Arc::new(AtomicBool::new(false));
    {
        let counts = Arc::clone(&counts);
        let finished = Arc::clone(&finished);
        std::thread::spawn(move || {
            std::thread::sleep(
                (deadline + WATCHDOG_GRACE).saturating_duration_since(Instant::now()),
            );
            if finished
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
            {
                emit(Exit::Deadline, &counts, started);
                std::process::exit(Exit::Deadline.code());
            }
        });
    }
    // Debug-only fault injection proves the watchdog independently of HTTP
    // timeouts. Release builds have no environment-controlled stall.
    #[cfg(debug_assertions)]
    if let Some(ms) = std::env::var("AGENT_RELAY_PROBE_FLUSH_STALL_AFTER_WATCHDOG_MS")
        .ok()
        .and_then(|value| value.parse().ok())
        .filter(|ms| *ms > 0)
    {
        std::thread::sleep(Duration::from_millis(ms));
    }
    let exit = match flush(&options, deadline, &counts) {
        Ok(exit) => exit,
        Err(error) => match error.downcast_ref::<Refused>() {
            Some(Refused(exit, message)) => {
                eprintln!("{message}");
                *exit
            }
            None => {
                // Never print the error itself: it can carry a response body.
                eprintln!(
                    "{}",
                    collector::local_failure_message(&error)
                        .unwrap_or("History flush could not finish. Credentials and session content were not logged.")
                );
                Exit::Failed
            }
        },
    };
    if finished
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        emit(exit, &counts, started);
        std::process::exit(exit.code())
    }
    // The watchdog won the right to emit the sole summary line. Do not let
    // this thread terminate the process before that line is flushed.
    loop {
        std::thread::park();
    }
}

/// A typed ending with a fixed, safe sentence.
#[derive(Debug)]
struct Refused(Exit, &'static str);
impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.1)
    }
}
impl std::error::Error for Refused {}
fn refused(exit: Exit, message: &'static str) -> anyhow::Error {
    Refused(exit, message).into()
}
fn invalid(message: &'static str) -> anyhow::Error {
    refused(Exit::InvalidSession, message)
}

/// Deserialize exactly one complete session object without waiting for EOF.
/// The host can retain its stdin writer while it waits for our summary; an
/// incomplete object is still bounded by the flush deadline.
fn parse_session(reader: impl Read) -> Result<PushedSession> {
    const LIMIT: u64 = 64 * 1024;
    let mut deserializer = serde_json::Deserializer::from_reader(reader.take(LIMIT + 1));
    PushedSession::deserialize(&mut deserializer)
        .map_err(|_| invalid("The session is not valid JSON of the expected shape."))
}

/// The pushed session, consumed. Parsing happens on a detached reader so a
/// partial pipe or special file cannot outlive the command's wall deadline.
/// A session file is removed after the one framed object is read, whatever it
/// held.
fn read_session(options: &Flush, deadline: Instant) -> Result<PushedSession> {
    let path = options.session_file.clone();
    let (sent, received) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let result = match path {
            Some(path) => {
                let parsed = fs::File::open(&path)
                    .map_err(|_| invalid("The session file could not be read."))
                    .and_then(parse_session);
                let removed = fs::remove_file(path)
                    .map_err(|_| invalid("The session file could not be removed."));
                match (parsed, removed) {
                    (Ok(session), Ok(())) => Ok(session),
                    (Err(error), _) | (_, Err(error)) => Err(error),
                }
            }
            None => parse_session(std::io::stdin().lock()),
        };
        let _ = sent.send(result);
    });
    match received.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => Err(refused(
            Exit::Deadline,
            "The session input did not finish before the deadline.",
        )),
        Err(mpsc::RecvTimeoutError::Disconnected) => Err(invalid("The session could not be read.")),
    }
}

/// A session this command may send with, or a refusal before any request.
fn validate(session: PushedSession) -> Result<(PushedSession, String)> {
    if session.scopes != ["rth:sync"] {
        return Err(invalid(
            "The session must carry exactly the rth:sync scope.",
        ));
    }
    if !session.access_token.starts_with("rth_at_")
        || session.access_token.len() > 4096
        || !session
            .access_token
            .bytes()
            .all(|byte| byte.is_ascii_graphic())
    {
        return Err(invalid(
            "The session does not carry a RelayHistory access token.",
        ));
    }
    let identifier = |value: &str| {
        !value.is_empty() && value.len() <= 256 && value.bytes().all(|byte| byte.is_ascii_graphic())
    };
    if !identifier(&session.org_id) || !identifier(&session.workspace_id) {
        return Err(invalid(
            "The session does not name an organization and workspace.",
        ));
    }
    let expiry = chrono::DateTime::parse_from_rfc3339(&session.access_token_expires_at)
        .map_err(|_| invalid("The session expiry is not a timestamp."))?;
    if expiry.timestamp_millis() <= chrono::Utc::now().timestamp_millis() {
        return Err(invalid("The session has expired."));
    }
    let base_url = cloud::pushed_history_origin(&session.base_url)
        .map_err(|_| invalid("The session names an untrusted RelayHistory origin."))?;
    Ok((session, base_url))
}

/// Wall time of one delivery pass. Debug builds take an override, so a test
/// can span several passes without waiting out the release budget.
fn pass_budget() -> Duration {
    #[cfg(debug_assertions)]
    if let Some(ms) = std::env::var("AGENT_RELAY_PROBE_FLUSH_PASS_MS")
        .ok()
        .and_then(|value| value.parse().ok())
        .filter(|ms| *ms > 0)
    {
        return Duration::from_millis(ms);
    }
    collector::DRAIN_TIME_BUDGET
}

/// Claim a fresh private directory for this command, or resume one bearing
/// the exact marker this command created. Never chmod, traverse or overwrite
/// an arbitrary existing directory supplied by the caller.
fn prepare_state_directory(state: &Path) -> Result<()> {
    let created = match fs::symlink_metadata(state) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                anyhow::bail!("state path is not a real directory");
            }
            validate_private_owner(&metadata, true)?;
            false
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            private_directory(state)?;
            let metadata = fs::symlink_metadata(state)?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                anyhow::bail!("state path changed while it was created");
            }
            validate_private_owner(&metadata, true)?;
            true
        }
        Err(error) => return Err(error.into()),
    };

    let marker = state.join(STATE_MARKER);
    match fs::symlink_metadata(&marker) {
        Ok(metadata) => {
            if created || metadata.file_type().is_symlink() || !metadata.is_file() {
                anyhow::bail!("invalid history flush state marker");
            }
            validate_private_owner(&metadata, false)?;
            if metadata.len() != STATE_MARKER_CONTENT.len() as u64
                || fs::read(&marker)? != STATE_MARKER_CONTENT
            {
                anyhow::bail!("invalid history flush state marker");
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if !created && fs::read_dir(state)?.next().is_some() {
                anyhow::bail!("unmarked history flush state is not empty");
            }
            let mut options = fs::OpenOptions::new();
            options.create_new(true).write(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&marker)?;
            file.write_all(STATE_MARKER_CONTENT)?;
            file.sync_all()?;
            validate_private_owner(&fs::symlink_metadata(&marker)?, false)?;
        }
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

fn validate_private_owner(metadata: &fs::Metadata, directory: bool) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let expected_mode = if directory { 0o700 } else { 0o600 };
        if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o777 != expected_mode
        {
            anyhow::bail!("history flush state is not private to this user");
        }
    }
    #[cfg(not(unix))]
    let _ = (metadata, directory);
    Ok(())
}

/// Serialize every use of a marked state directory, including the in-memory
/// session, capture, drain and teardown. The lock file is persistent but
/// credential-free; the kernel releases its advisory lock on forced exit.
struct StateLock {
    _file: fs::File,
}

fn lock_state_directory(state: &Path) -> Result<StateLock> {
    let path = state.join(STATE_LOCK);
    let mut options = fs::OpenOptions::new();
    options.create(true).truncate(false).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        anyhow::bail!("history flush state lock is not a file");
    }
    validate_private_owner(&metadata, false)?;
    match fs2::FileExt::try_lock_exclusive(&file) {
        Ok(()) => Ok(StateLock { _file: file }),
        Err(error) if agent_relay_probe::platform::fs::lock_held(&error) => Err(refused(
            Exit::Failed,
            "Another history flush holds the state directory.",
        )),
        Err(error) => Err(error.into()),
    }
}

fn update_counts(db: &Path, job_id: &str, counts: &Counts) -> Result<()> {
    counts
        .sessions_captured
        .store(history::captured_sessions(db)?, Ordering::SeqCst);
    counts.of(&delivery::status(&delivery::open_db(db)?, job_id)?);
    Ok(())
}

fn flush(options: &Flush, deadline: Instant, counts: &Counts) -> Result<Exit> {
    let session = read_session(options, deadline)?;
    if Instant::now() >= deadline {
        return Err(refused(
            Exit::Deadline,
            "The session input finished after the deadline.",
        ));
    }
    if std::env::vars_os().any(|(_, value)| looks_like_token(&value.to_string_lossy())) {
        return Err(invalid("A credential was found in the environment. Pass the session on stdin or in a file only."));
    }
    let (session, base_url) = validate(session)?;
    let worker_id = match &options.label {
        None => format!("flush-{}", std::process::id()),
        Some(label)
            if !label.is_empty()
                && label.len() <= 64
                && label
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.')) =>
        {
            format!("flush-{label}-{}", std::process::id())
        }
        Some(_) => {
            return Err(refused(
                Exit::Failed,
                "--label may hold only letters, digits, '-', '_' and '.'.",
            ))
        }
    };

    // Everything this command writes is private to its user.
    #[cfg(unix)]
    unsafe {
        libc::umask(0o077);
    }
    let state = &options.state_dir;
    prepare_state_directory(state)
        .map_err(|_| refused(Exit::Failed, "The state directory could not be created."))?;
    let _state_lock = lock_state_directory(state)?;
    // A sandbox without a usable HOME still has its provider roots named by
    // the environment; nothing else is looked for outside the state directory.
    // On Windows, where HOME is usually unset, the profile (USERPROFILE) is
    // the usable home and is named as HOME for the provider roots.
    if std::env::var_os("HOME").is_none_or(|home| home.is_empty()) {
        let home = agent_relay_probe::platform::home_dir().unwrap_or_else(|| state.join("home"));
        std::env::set_var("HOME", home);
    }
    std::env::set_var("RELAYHISTORY_HOME", state);
    let account = destination::account_id(&session.org_id, Some(&session.workspace_id));
    let pushed_auth = cloud::StoredAuth {
        base_url: base_url.clone(),
        access_token: session.access_token,
        access_token_expires_at: Some(session.access_token_expires_at),
        refresh_token: None,
        org_id: Some(session.org_id.clone()),
        workspace_id: Some(session.workspace_id.clone()),
    };

    let db = state.join("history.db");
    // Create/adopt the generation before capture. If the deadline interrupts
    // a sweep after some records commit, its status can then count those
    // unqueued records instead of publishing a false zero summary.
    let job_id = job(&db, &account)?;
    let expired = move || Instant::now() >= deadline;
    match history::sync(
        &db,
        deadline.saturating_duration_since(Instant::now()),
        false,
        |_| {},
        expired,
    ) {
        Ok(true) => {}
        Ok(false) => {
            return Err(refused(
                Exit::Failed,
                "Another capture holds the state directory.",
            ))
        }
        Err(_) if expired() => {
            update_counts(&db, &job_id, counts)?;
            return Ok(Exit::Deadline);
        }
        Err(error) => return Err(error),
    }
    update_counts(&db, &job_id, counts)?;

    let receiver = destination::RelayHistoryReceiver {
        base_url: Some(base_url.clone()),
        expected_account: Some(account),
        instance_id: Some(collector::INSTANCE.into()),
        acknowledge_uninspected_schedules: false,
        state: destination::ReceiverState::hosted_with_session(base_url.clone(), pushed_auth),
    };
    let receivers =
        worker::SingleReceiver::new(collector::DESTINATION, collector::INSTANCE, &receiver);
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Ok(Exit::Deadline);
        }
        let result = worker::drain(
            &db,
            &receivers,
            &collector::deadline_options(
                job_id.clone(),
                worker_id.clone(),
                pass_budget(),
                deadline,
            ),
            &worker::system_clock,
            &expired,
        )?;
        let status = result
            .statuses
            .iter()
            .find(|status| status.job_id == job_id)
            .context("delivery job missing")?;
        counts.of(status);
        match status.state.as_str() {
            "active" => {}
            "blocked" if status.failure.as_deref() == Some("authentication_required") => {
                return Err(refused(
                    Exit::Unauthorized,
                    "RelayHistory refused the session.",
                ));
            }
            _ => {
                return Err(refused(
                    Exit::Blocked,
                    "Delivery is blocked. No unacknowledged data was discarded.",
                ))
            }
        }
        if let Some(failure) = result.failure {
            return Err(failure.into_error());
        }
        if !result.issues.is_empty() {
            return Err(refused(
                Exit::Failed,
                "Session delivery needs attention. No unacknowledged data was discarded.",
            ));
        }
        if status.bootstrap_complete && status.pending_records == 0 && status.unqueued_changes == 0
        {
            return Ok(Exit::Drained);
        }
        // A pass that moved nothing waits for the worker's retry deadline,
        // never past the flush's own.
        let wait = if status.next_attempt_ms > collector::now() {
            Duration::from_millis((status.next_attempt_ms - collector::now()) as u64)
        } else if result.metrics.batches_sent == 0 {
            Duration::from_millis(100)
        } else {
            Duration::ZERO
        };
        std::thread::sleep(wait.min(deadline.saturating_duration_since(Instant::now())));
    }
}

/// The flush's delivery generation, sharing everything: an earlier flush's
/// in the same state directory is resumed, one for another destination is a
/// conflict.
fn job(db: &Path, account: &str) -> Result<String> {
    let conn = delivery::open_db(db)?;
    let config = delivery::DeliveryJobConfig {
        destination_id: collector::DESTINATION.into(),
        instance_id: collector::INSTANCE.into(),
        account_id: account.into(),
        mapping_version: destination::MAPPING_VERSION.into(),
        selection: collector::selection(true),
        limits: Default::default(),
    };
    let jobs: Vec<_> = delivery::list_jobs(&conn)?
        .into_iter()
        .filter(|job| job.state != "cancelled")
        .collect();
    if let Some(job) = jobs.iter().find(|job| job.config == config) {
        if job.state == "blocked" {
            delivery::retry_job(&conn, &job.job_id)?;
        }
        return Ok(job.job_id.clone());
    }
    if !jobs.is_empty() {
        return Err(refused(
            Exit::Blocked,
            "The state directory holds another destination's delivery.",
        ));
    }
    collector::record_baseline(&conn, true)?;
    Ok(delivery::create_job(&conn, &config, collector::now())?.job_id)
}
