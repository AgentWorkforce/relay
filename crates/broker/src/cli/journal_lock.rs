//! Hidden helper: hold an exclusive kernel advisory lock on a stable lock
//! file for the CLI's pending-cleanup journal.
//!
//! Why this exists: the Node CLI needs a cross-process mutex whose release is
//! guaranteed by the KERNEL on process death (flock(2) on Unix, LockFileEx on
//! Windows — both behind std's `File::try_lock`). Node has no built-in flock
//! and a native addon crashes the Bun standalone build, so the CLI spawns
//! this already-required broker binary instead.
//!
//! Contract (line-oriented, spawned by the CLI's cleanup journal):
//!   agent-relay-broker journal-lock --file <path> --timeout-ms <n>
//! - The lock file is a STABLE inode: created 0600 once, never unlinked or
//!   renamed. Its content is a version marker only.
//! - On acquisition the helper prints `locked\n` to stdout, then blocks until
//!   stdin reaches EOF (parent closed it, or parent died) and exits 0 — the
//!   kernel releases the lock with the process either way.
//! - Exit 4 (+ `timeout` on stderr): another live holder out-waited us.
//! - Exit 3 (+ `sentinel` on stderr): the file holds unrecognized content
//!   from an older format; it is preserved untouched (fail closed).
//! - Exit 2 is clap's usage-error code — also what an OLDER broker without
//!   this subcommand exits with, so the CLI detects version skew distinctly.
//! - Exit 1: any other error. No secrets ever appear on stdout/stderr/argv —
//!   the only argument is the lock file path.

use std::fs::TryLockError;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
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

#[derive(Debug, clap::Args, Clone)]
pub(crate) struct JournalLockCommand {
    /// Stable lock file to hold the exclusive kernel lock on.
    #[arg(long)]
    pub(crate) file: PathBuf,

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

    // Hold until the parent releases (stdin EOF) or dies (stdin EOF too). Any
    // interim bytes are consumed and ignored. The kernel drops the lock with
    // this process regardless of HOW it exits.
    let mut sink = Vec::new();
    let _ = std::io::stdin().lock().read_to_end(&mut sink);
    drop(file); // explicit unlock+close before a clean exit
    Ok(())
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

    fn temp_lock_path(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("journal-lock-{}-{}", name, std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("pending-cleanups.json.lock")
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
}
