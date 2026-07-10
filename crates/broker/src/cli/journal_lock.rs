//! Hidden helper: hold an exclusive kernel advisory lock on a stable lock
//! file for the CLI's pending-cleanup journal, and perform the journal's
//! durable replacement WHILE the lock is held.
//!
//! Why this exists: the Node CLI needs a cross-process mutex whose release is
//! guaranteed by the KERNEL on process death (flock(2) on Unix, LockFileEx on
//! Windows — both behind std's `File::try_lock`). Node has no built-in flock
//! and a native addon crashes the Bun standalone build, so the CLI spawns
//! this already-required broker binary instead.
//!
//! The COMMIT also lives here: the parent never writes the journal itself,
//! so lock ownership provably spans the read-modify-write through the atomic
//! replacement.
//!
//! Contract (spawned by the CLI's cleanup journal):
//!   agent-relay-broker journal-lock --file <lock> --journal-file <journal> --timeout-ms <n>
//! - The lock file is a STABLE inode: created 0600 once, never unlinked or
//!   renamed. Its content is a version marker only.
//! - On acquisition the helper prints the exact framed line `locked\n` to
//!   stdout, then reads stdin to EOF (errors propagated):
//!     - EMPTY input: the parent aborted — release without touching the
//!       journal, exit 0.
//!     - Otherwise the input must be ONE complete framed envelope:
//!       `ARJL1\n<payload-byte-length>\n<sha256-hex-of-payload>\n<payload>`
//!       with no trailing bytes. Only after the exact length AND digest
//!       validate is the payload committed — temp file (0600) + fsync +
//!       atomic rename over the journal + parent-directory fsync — then
//!       exit 0. A parent dying mid-write yields a partial frame + clean
//!       EOF; that (or any malformed/trailing frame) exits 5 with the
//!       journal byte-for-byte untouched, so a truncated payload can
//!       NEVER replace good contents.
//! - Exit 4 (+ `timeout` on stderr): another live holder out-waited us.
//! - Exit 3 (+ `sentinel` on stderr): the file holds unrecognized content
//!   from an older format; it is preserved untouched (fail closed).
//! - Exit 2 is clap's usage-error code — also what an OLDER broker without
//!   this subcommand exits with, so the CLI detects version skew distinctly.
//! - Exit 1: any other error. No secrets ever appear on stdout/stderr/argv —
//!   the only argument is the lock file path.

use std::fs::TryLockError;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};

/// Contents of a v2 stable lock file. Anything else fails closed.
pub(crate) const LOCK_MARKER: &str = "agent-relay-cleanup-lock v2\n";

const RETRY_INTERVAL: Duration = Duration::from_millis(100);

// Exit codes deliberately avoid 1 (generic error) and 2 (clap usage error —
// which is also what an OLDER broker without this subcommand exits with, so
// the CLI can detect version skew distinctly).
pub(crate) const EXIT_SENTINEL: i32 = 3;
pub(crate) const EXIT_TIMEOUT: i32 = 4;
pub(crate) const EXIT_FRAME: i32 = 5;

/// Frame magic + version. Bump on any envelope change.
const FRAME_MAGIC: &[u8] = b"ARJL1\n";

#[derive(Debug, clap::Args, Clone)]
pub(crate) struct JournalLockCommand {
    /// Stable lock file to hold the exclusive kernel lock on.
    #[arg(long)]
    pub(crate) file: PathBuf,

    /// Journal file to atomically replace with the stdin payload (if any)
    /// while the lock is held.
    #[arg(long)]
    pub(crate) journal_file: PathBuf,

    /// How long to wait for a live holder before giving up (exit code 4).
    #[arg(long, default_value_t = 5_000)]
    pub(crate) timeout_ms: u64,
}

enum LockOutcome {
    Held,
    Timeout,
    Sentinel,
}

pub(crate) fn run_journal_lock(cmd: JournalLockCommand) -> Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&cmd.file)
        .with_context(|| format!("open journal lock file {}", cmd.file.display()))?;

    match acquire(&mut file, Duration::from_millis(cmd.timeout_ms))? {
        LockOutcome::Timeout => {
            eprintln!("timeout");
            std::process::exit(EXIT_TIMEOUT);
        }
        LockOutcome::Sentinel => {
            eprintln!("sentinel");
            std::process::exit(EXIT_SENTINEL);
        }
        LockOutcome::Held => {}
    }

    println!("locked");
    std::io::stdout().flush().context("flush lock handshake")?;

    // The parent reads/mutates under OUR held lock, then hands back the
    // complete serialized journal as a framed envelope on stdin. EOF with no
    // bytes = abort. Any read error is propagated, and a frame that fails
    // validation (torn write, digest mismatch, trailing bytes) must never be
    // committed.
    let mut input = Vec::new();
    std::io::stdin()
        .lock()
        .read_to_end(&mut input)
        .context("read journal frame from parent")?;
    match parse_frame(&input) {
        Ok(None) => {}
        Ok(Some(payload)) => replace_journal(&cmd.journal_file, payload)?,
        Err(reason) => {
            eprintln!("frame: {reason}");
            std::process::exit(EXIT_FRAME);
        }
    }
    drop(file); // explicit unlock+close before a clean exit
    Ok(())
}

/// Validate one framed envelope. `Ok(None)` = empty input (abort);
/// `Ok(Some(payload))` = exact-length, digest-verified payload; `Err` = any
/// short/malformed/trailing frame.
fn parse_frame(input: &[u8]) -> std::result::Result<Option<&[u8]>, String> {
    use sha2::{Digest, Sha256};

    if input.is_empty() {
        return Ok(None);
    }
    let rest = input
        .strip_prefix(FRAME_MAGIC)
        .ok_or_else(|| "bad magic".to_string())?;
    let length_end = rest
        .iter()
        .position(|&b| b == b'\n')
        .ok_or_else(|| "missing length".to_string())?;
    let declared: usize = std::str::from_utf8(&rest[..length_end])
        .ok()
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| "bad length".to_string())?;
    let rest = &rest[length_end + 1..];
    let digest_end = rest
        .iter()
        .position(|&b| b == b'\n')
        .ok_or_else(|| "missing digest".to_string())?;
    let declared_digest =
        std::str::from_utf8(&rest[..digest_end]).map_err(|_| "bad digest".to_string())?;
    let payload = &rest[digest_end + 1..];
    if payload.len() != declared {
        return Err(format!(
            "length mismatch: declared {declared}, received {}",
            payload.len()
        ));
    }
    let actual_digest = format!("{:x}", Sha256::digest(payload));
    if actual_digest != declared_digest {
        return Err("digest mismatch".to_string());
    }
    Ok(Some(payload))
}

/// Durable atomic replacement performed UNDER the held lock: exclusively
/// created temp file (0600) + fsync + rename over the journal +
/// parent-directory fsync, so a committed update survives host/power crashes
/// and a failed one leaves the journal byte-for-byte unmodified (any temp
/// residue from a failure path is cleaned up before returning).
fn replace_journal(journal: &Path, payload: &[u8]) -> Result<()> {
    let dir = journal
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    let (tmp, mut temp) = create_exclusive_temp(journal)?;

    let result = (|| -> Result<()> {
        temp.write_all(payload).context("write journal payload")?;
        temp.sync_all().context("fsync journal temp file")?;
        drop(temp);
        std::fs::rename(&tmp, journal)
            .with_context(|| format!("rename journal into place at {}", journal.display()))?;
        sync_dir(&dir)
    })();
    if result.is_err() {
        // Failure-path hygiene: never leave a temp file behind.
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// Directory fsync makes the rename itself durable. The OPEN always
/// propagates — a missing directory is a real failure on every platform.
/// Only a SYNC failure on a successfully opened directory handle is
/// tolerated, and only on Windows (its known inability to fsync directory
/// handles surfaces as a permission/handle error); the payload fsync has
/// already run there. Every other I/O error propagates.
fn sync_dir(dir: &Path) -> Result<()> {
    let handle = std::fs::File::open(dir)
        .with_context(|| format!("open journal directory {}", dir.display()))?;
    match handle.sync_all() {
        Ok(()) => Ok(()),
        Err(err)
            if cfg!(windows)
                && matches!(
                    err.kind(),
                    std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::InvalidInput
                ) =>
        {
            Ok(())
        }
        Err(err) => Err(err).with_context(|| format!("fsync journal directory {}", dir.display())),
    }
}

/// Collision-resistant EXCLUSIVE temp creation: `create_new` refuses to
/// follow symlinks or truncate an existing file, and an EEXIST collision
/// retries with a different unpredictable suffix (pid + monotonic-ish nanos
/// + counter) instead of reusing a guessable name.
fn create_exclusive_temp(journal: &Path) -> Result<(PathBuf, std::fs::File)> {
    let base = journal
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("pending-cleanups.json");
    for attempt in 0..16u32 {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0);
        let candidate = journal.with_file_name(format!(
            "{base}.tmp-{}-{nanos:08x}-{attempt}",
            std::process::id()
        ));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&candidate) {
            Ok(file) => return Ok((candidate, file)),
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(err) => {
                return Err(err)
                    .with_context(|| format!("open journal temp file {}", candidate.display()));
            }
        }
    }
    anyhow::bail!(
        "could not create an exclusive journal temp file next to {}",
        journal.display()
    )
}

fn acquire(file: &mut std::fs::File, timeout: Duration) -> Result<LockOutcome> {
    let deadline = Instant::now() + timeout;
    loop {
        match file.try_lock() {
            Ok(()) => break,
            Err(TryLockError::WouldBlock) => {
                if Instant::now() >= deadline {
                    return Ok(LockOutcome::Timeout);
                }
                std::thread::sleep(RETRY_INTERVAL);
            }
            Err(TryLockError::Error(err)) => {
                return Err(err).context("acquire journal lock");
            }
        }
    }

    // Under the lock: stamp a fresh file with the fsync'd v2 marker, heal a
    // crash-truncated marker (strict prefix), and fail closed on anything
    // else — an unrecognized pre-release sentinel is preserved, not adopted.
    let mut content = Vec::new();
    file.read_to_end(&mut content).context("read lock marker")?;
    let marker = LOCK_MARKER.as_bytes();
    if content.is_empty() {
        file.write_all(marker).context("write lock marker")?;
        file.sync_all().context("fsync lock marker")?;
    } else if content != marker {
        if !marker.starts_with(&content) {
            return Ok(LockOutcome::Sentinel);
        }
        file.set_len(0).context("truncate partial marker")?;
        file.seek(SeekFrom::Start(0)).context("rewind lock file")?;
        file.write_all(marker).context("heal lock marker")?;
        file.sync_all().context("fsync healed marker")?;
    }
    Ok(LockOutcome::Held)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("journal-lock-{}-{}", name, std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn temp_lock_path(name: &str) -> PathBuf {
        temp_dir(name).join("pending-cleanups.json.lock")
    }

    fn open(path: &PathBuf) -> std::fs::File {
        let mut options = std::fs::OpenOptions::new();
        options.read(true).write(true).create(true);
        options.open(path).unwrap()
    }

    #[test]
    fn stamps_and_heals_marker_and_reports_contention() {
        let path = temp_lock_path("marker");

        // Fresh file: acquires and stamps the exact marker.
        let mut first = open(&path);
        assert!(matches!(
            acquire(&mut first, Duration::from_millis(200)).unwrap(),
            LockOutcome::Held
        ));
        assert_eq!(std::fs::read(&path).unwrap(), LOCK_MARKER.as_bytes());

        // A second descriptor times out while the first holds the kernel lock.
        let mut second = open(&path);
        assert!(matches!(
            acquire(&mut second, Duration::from_millis(250)).unwrap(),
            LockOutcome::Timeout
        ));

        // Releasing the first lets the second in; a truncated marker heals.
        drop(first);
        std::fs::write(&path, &LOCK_MARKER.as_bytes()[..7]).unwrap();
        let mut third = open(&path);
        assert!(matches!(
            acquire(&mut third, Duration::from_millis(200)).unwrap(),
            LockOutcome::Held
        ));
        assert_eq!(std::fs::read(&path).unwrap(), LOCK_MARKER.as_bytes());
    }

    #[test]
    fn unrecognized_sentinel_fails_closed_and_is_preserved() {
        let path = temp_lock_path("sentinel");
        std::fs::write(&path, b"{\"pid\":123,\"host\":\"old\"}").unwrap();

        let mut file = open(&path);
        assert!(matches!(
            acquire(&mut file, Duration::from_millis(200)).unwrap(),
            LockOutcome::Sentinel
        ));
        assert_eq!(
            std::fs::read(&path).unwrap(),
            b"{\"pid\":123,\"host\":\"old\"}"
        );
    }
    #[test]
    fn parse_frame_validates_length_digest_and_framing() {
        use sha2::{Digest, Sha256};
        let payload = b"[{\"kind\":\"relay-webhook\"}]\n";
        let digest = format!("{:x}", Sha256::digest(payload));
        let mut frame = Vec::new();
        frame.extend_from_slice(FRAME_MAGIC);
        frame.extend_from_slice(format!("{}\n{}\n", payload.len(), digest).as_bytes());
        frame.extend_from_slice(payload);

        // Valid frame round-trips; empty input aborts.
        assert_eq!(parse_frame(&frame).unwrap(), Some(payload.as_slice()));
        assert_eq!(parse_frame(b"").unwrap(), None);

        // Truncated body (parent died mid-write): rejected.
        assert!(parse_frame(&frame[..frame.len() - 5]).is_err());
        // Trailing bytes: rejected.
        let mut trailing = frame.clone();
        trailing.extend_from_slice(b"x");
        assert!(parse_frame(&trailing).is_err());
        // Corrupted payload byte (digest mismatch): rejected.
        let mut corrupted = frame.clone();
        let last = corrupted.len() - 1;
        corrupted[last] ^= 0x01;
        assert!(parse_frame(&corrupted).is_err());
        // Wrong magic: rejected.
        assert!(parse_frame(b"NOPE\n1\nabc\nz").is_err());
    }

    #[test]
    fn sync_dir_propagates_missing_directory_errors_on_every_platform() {
        let missing =
            std::env::temp_dir().join(format!("journal-lock-no-such-dir-{}", std::process::id()));
        assert!(
            sync_dir(&missing).is_err(),
            "a missing directory must error everywhere; only a sync failure on \
             an OPENED Windows directory handle is tolerated"
        );
        // And a real, existing directory syncs cleanly (or is tolerated on
        // Windows).
        assert!(sync_dir(&temp_dir("syncdir-ok")).is_ok());
    }

    #[test]
    fn exclusive_temp_creation_yields_fresh_unique_restricted_files() {
        let dir = temp_dir("excltemp");
        let journal = dir.join("pending-cleanups.json");
        // create_new(true) neither follows symlinks nor truncates an existing
        // file — an occupied candidate errors with AlreadyExists and a new
        // unpredictable suffix is tried. Two consecutive creations therefore
        // yield distinct, freshly created, empty files.
        let (first_path, first) = create_exclusive_temp(&journal).unwrap();
        let (second_path, second) = create_exclusive_temp(&journal).unwrap();
        assert_ne!(first_path, second_path);
        assert_eq!(first.metadata().unwrap().len(), 0);
        assert_eq!(second.metadata().unwrap().len(), 0);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                first.metadata().unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        drop(first);
        drop(second);
        let _ = std::fs::remove_file(first_path);
        let _ = std::fs::remove_file(second_path);
    }

    #[cfg(unix)]
    #[test]
    fn exclusive_temp_creation_refuses_to_follow_a_symlink_at_the_candidate() {
        let dir = temp_dir("excl-symlink");
        let journal = dir.join("pending-cleanups.json");
        let target = dir.join("victim");
        std::fs::write(&target, b"precious").unwrap();
        // Occupy EVERY name create_exclusive_temp could pick this instant is
        // impossible (unpredictable suffixes), so validate the exact open
        // semantics instead: create_new on a path holding a symlink fails
        // rather than following/truncating the target.
        let link = dir.join("occupied");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        let err = options.open(&link).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(std::fs::read(&target).unwrap(), b"precious");
    }

    #[test]
    fn replace_journal_cleans_temp_files_when_the_swap_fails() {
        let dir = temp_dir("swapfail");
        // Renaming a file over an existing DIRECTORY fails on every platform.
        let journal = dir.join("pending-cleanups.json");
        std::fs::create_dir_all(&journal).unwrap();

        assert!(replace_journal(&journal, b"[]\n").is_err());
        let residue: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains(".tmp-"))
            .collect();
        assert!(residue.is_empty(), "temp residue: {residue:?}");
    }

    #[test]
    fn replace_journal_is_atomic_and_leaves_no_temp_residue() {
        let dir = temp_dir("replace");
        let journal = dir.join("pending-cleanups.json");
        std::fs::write(&journal, b"[]\n").unwrap();

        replace_journal(&journal, b"[{\"kind\":\"relay-webhook\"}]\n").unwrap();
        assert_eq!(
            std::fs::read(&journal).unwrap(),
            b"[{\"kind\":\"relay-webhook\"}]\n"
        );
        let residue: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains(".tmp-"))
            .collect();
        assert!(residue.is_empty(), "temp residue: {residue:?}");
    }
}
