//! Explicit core diagnostics, retained even when launchd discards stderr.
//! Do not capture child stdio, request bodies, messages or configuration here.
use fs2::FileExt;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

const CAP: u64 = 1024 * 1024;
const KEEP: usize = 3;
static LOG: OnceLock<Mutex<Log>> = OnceLock::new();

pub(crate) fn initialize(home: &Path, data: &Path) {
    let directory = directory(home, data, cfg!(target_os = "macos"));
    match Log::open(directory) {
        Ok(log) => {
            let _ = LOG.set(Mutex::new(log));
        }
        Err(_) => eprintln!("relay: core diagnostics could not be saved; stderr remains available"),
    }
}

fn directory(home: &Path, data: &Path, macos: bool) -> PathBuf {
    if macos {
        let name = if data
            .file_name()
            .is_some_and(|name| name == "com.agentrelay.desktop.dev")
        {
            "Agent Relay Dev"
        } else {
            "Agent Relay"
        };
        home.join("Library/Logs").join(name)
    } else {
        data.join("logs")
    }
}

/// Keep existing stderr consumers (including journald), and persist only the
/// explicitly emitted diagnostic after the shared credential redactor runs.
pub(crate) fn write(arguments: std::fmt::Arguments<'_>) {
    let message = arguments.to_string();
    let _ = writeln!(io::stderr().lock(), "{message}");
    if let Some(log) = LOG.get() {
        let _ = log
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .append(&message);
    }
}

struct Log {
    directory: PathBuf,
    cap: u64,
}

/// Explicitly unlock before closing: a concurrent fork on macOS can briefly
/// inherit this descriptor and keep a drop-only flock alive after we close it.
struct LogLock(File);

impl Drop for LogLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.0);
    }
}

impl Log {
    fn open(directory: PathBuf) -> io::Result<Self> {
        crate::relay::paths::socket_directory(&directory).map_err(io::Error::other)?;
        // Fail early if the destination cannot be opened, without preventing
        // the daemon from starting. Do not retain an open log across rotation.
        private_append(&directory.join("core.log"))?;
        Ok(Self {
            directory,
            cap: CAP,
        })
    }

    fn append(&mut self, message: &str) -> io::Result<()> {
        // Separate sockets can share an app data directory. Serialize rotation
        // across processes as well as the threads protected by LOG's mutex.
        let lock = private_append(&self.directory.join("core.log.lock"))?;
        // Diagnostics must not stall a request behind another core process.
        lock.try_lock_exclusive()?;
        let _lock = LogLock(lock);
        self.rotate()?;
        let mut file = private_append(&self.directory.join("core.log"))?;
        let message = crate::relay::harness::diagnostics::redact(message);
        writeln!(file, "{} {message}", crate::relay::state::now_ms())
    }

    fn rotate(&self) -> io::Result<()> {
        let current = self.directory.join("core.log");
        if !fs::metadata(&current).is_ok_and(|file| file.len() >= self.cap) {
            return Ok(());
        }
        for generation in (1..=KEEP).rev() {
            let target = self.directory.join(format!("core.log.{generation}"));
            // Windows rename does not replace an existing destination.
            match fs::remove_file(&target) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
            let source = if generation == 1 {
                current.clone()
            } else {
                self.directory.join(format!("core.log.{}", generation - 1))
            };
            match fs::rename(source, target) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }
}

fn private_append(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    // Windows byte-range locking requires read or write access; append-only
    // handles do not grant either access right to LockFileEx.
    options.create(true).read(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(io::Error::other("core log must be a regular file"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connect_failures_survive_discarded_stderr() {
        use std::process::{Command, Stdio};
        let temp = tempfile::tempdir().unwrap();
        let status = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "relay::diagnostics::tests::emit_connect_failure"])
            .env("AGENT_RELAY_TEST_LOG_HOME", temp.path())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap();
        assert!(status.success());
        let directory = directory(
            temp.path(),
            &temp.path().join("data"),
            cfg!(target_os = "macos"),
        );
        let saved = fs::read_to_string(directory.join("core.log")).unwrap();
        assert!(saved.contains("relay connect roster failed code=connect_unreachable"));
        assert!(saved.contains("connect_ref=") && saved.contains("cause=http_503"));
        assert!(!saved.contains("private-connect-id"));
    }

    #[test]
    fn emit_connect_failure() {
        // This test runs in a child so the process-wide logger never changes
        // another test's destination or captures its output.
        let Some(home) = std::env::var_os("AGENT_RELAY_TEST_LOG_HOME") else {
            return;
        };
        let home = PathBuf::from(home);
        initialize(&home, &home.join("data"));
        crate::relay::connect::log_connect_failure(
            "roster",
            "private-connect-id",
            "connect_unreachable",
            "http_503",
        );
    }

    #[test]
    fn log_locations_separate_production_and_development() {
        let home = Path::new("/home/person");
        let data = home.join("data/com.agentrelay.desktop");
        assert_eq!(
            directory(home, &data, true),
            home.join("Library/Logs/Agent Relay")
        );
        assert_eq!(
            directory(
                home,
                &data.with_file_name("com.agentrelay.desktop.dev"),
                true
            ),
            home.join("Library/Logs/Agent Relay Dev")
        );
        assert_eq!(directory(home, &data, false), data.join("logs"));
    }

    #[test]
    fn rotation_keeps_three_backups_and_continues_writing_after_restart() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("logs");
        let mut log = Log::open(directory.clone()).unwrap();
        log.cap = 1;
        for n in 0..6 {
            log.append(&format!("record {n}")).unwrap();
        }
        assert!(fs::read_to_string(directory.join("core.log"))
            .unwrap()
            .ends_with("record 5\n"));
        for generation in 1..=KEEP {
            assert!(
                fs::read_to_string(directory.join(format!("core.log.{generation}")))
                    .unwrap()
                    .ends_with(&format!("record {}\n", 5 - generation))
            );
        }
        assert!(!directory.join("core.log.4").exists());
        let mut restarted = Log::open(directory.clone()).unwrap();
        restarted.append("after restart").unwrap();
        let current = fs::read_to_string(directory.join("core.log")).unwrap();
        assert!(current.contains("record 5\n") && current.ends_with("after restart\n"));
    }

    #[test]
    fn diagnostic_redaction_removes_credentials_and_line_breaks() {
        let message = "relay connect roster failed connect_ref=abcdef cause=http_503\nAuthorization: Bearer private-value token=hidden https://secret.example";
        let temp = tempfile::tempdir().unwrap();
        let mut log = Log::open(temp.path().join("logs")).unwrap();
        log.append(message).unwrap();
        let saved = fs::read_to_string(log.directory.join("core.log")).unwrap();
        assert!(saved.contains("connect_ref=abcdef cause=http_503"));
        for secret in ["private-value", "hidden", "secret.example"] {
            assert!(!saved.contains(secret));
        }
        assert_eq!(saved.lines().count(), 1);
    }

    #[test]
    fn an_oversized_existing_log_rotates_before_the_first_record() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("logs");
        let mut log = Log::open(directory.clone()).unwrap();
        fs::write(directory.join("core.log"), vec![b'x'; CAP as usize]).unwrap();
        log.append(&"é".repeat(5000)).unwrap();
        assert_eq!(
            fs::metadata(directory.join("core.log.1")).unwrap().len(),
            CAP
        );
        let saved = fs::read_to_string(directory.join("core.log")).unwrap();
        assert!(saved.len() < 2100);
        assert_eq!(saved.lines().count(), 1);
    }

    #[test]
    fn a_busy_log_is_skipped_and_the_next_record_can_be_saved() {
        let temp = tempfile::tempdir().unwrap();
        let mut log = Log::open(temp.path().join("logs")).unwrap();
        let lock = private_append(&log.directory.join("core.log.lock")).unwrap();
        lock.lock_exclusive().unwrap();
        // Model a descriptor inherited by a concurrent child process.
        let inherited = lock.try_clone().unwrap();
        let lock = LogLock(lock);
        assert!(log.append("busy").is_err());
        drop(lock);
        log.append("recovered").unwrap();
        drop(inherited);
        assert!(fs::read_to_string(log.directory.join("core.log"))
            .unwrap()
            .ends_with("recovered\n"));
    }

    #[cfg(unix)]
    #[test]
    fn files_are_private_and_symlinks_are_rejected() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let temp = tempfile::tempdir().unwrap();
        let mut log = Log::open(temp.path().join("logs")).unwrap();
        log.append("private").unwrap();
        assert_eq!(
            fs::metadata(&log.directory).unwrap().permissions().mode() & 0o777,
            0o700
        );
        let path = log.directory.join("core.log");
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let outside = temp.path().join("untouched");
        fs::write(&outside, "keep").unwrap();
        fs::remove_file(&path).unwrap();
        symlink(&outside, &path).unwrap();
        assert!(log.append("must fail").is_err());
        assert_eq!(fs::read_to_string(outside).unwrap(), "keep");
    }
}
