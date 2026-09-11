//! Crash-recoverable leases for a generated Cursor `.cursor/mcp.json`.

use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
};

use base64::Engine;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::ids::WorkerName;

#[derive(Debug, Clone)]
enum PreExisting {
    Absent { created_dir: bool },
    Present { contents: Vec<u8>, mode: u32 },
}

struct LeaseState {
    pre_existing: PreExisting,
    holders: HashSet<WorkerName>,
    _lock: LeaseLock,
}

/// A kernel-held lock on the requested cwd. Locking the existing cwd rather
/// than a lock file inside `.cursor` avoids leaving stale lock files/directories
/// behind and makes separate broker processes fail closed before they can
/// overwrite one another's placeholder config.
struct LeaseLock {
    _file: fs::File,
}

impl LeaseLock {
    fn acquire(root: &Path) -> io::Result<Self> {
        #[cfg(not(unix))]
        {
            let _ = root;
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "Cursor MCP leasing requires kernel directory locks on this platform",
            ));
        }
        #[cfg(unix)]
        {
            let file = fs::File::open(root)?;
            file.try_lock().map_err(|error| match error {
                fs::TryLockError::WouldBlock => io::Error::new(
                    io::ErrorKind::WouldBlock,
                    "another broker owns the Cursor MCP cwd lease",
                ),
                fs::TryLockError::Error(error) => error,
            })?;
            Ok(Self { _file: file })
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct Journal {
    entries: Vec<JournalEntry>,
}

#[derive(Debug, Serialize, Deserialize)]
struct JournalEntry {
    path: PathBuf,
    pre_existing: JournalPreExisting,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum JournalPreExisting {
    Absent { created_dir: bool },
    Present { contents_base64: String, mode: u32 },
}

/// Tracks leases and a recovery journal. The journal contains pre-existing
/// bytes and mode, which may themselves be sensitive user data; it is written
/// 0600 and never contains generated Relay credentials because generated Cursor
/// values are `${env:...}` placeholders.
#[derive(Default)]
pub(crate) struct CursorMcpLeaseRegistry {
    leases: HashMap<PathBuf, LeaseState>,
    path_by_worker: HashMap<WorkerName, PathBuf>,
    journal_path: Option<PathBuf>,
}

fn invalid_path(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message.into())
}

fn canonical_root(root: &Path) -> io::Result<PathBuf> {
    let metadata = fs::symlink_metadata(root)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(invalid_path(format!(
            "Cursor worker cwd is not a non-symlink directory: {}",
            root.display()
        )));
    }
    root.canonicalize()
}

fn validate_cursor_dir(root: &Path) -> io::Result<bool> {
    let cursor_dir = root.join(".cursor");
    match fs::symlink_metadata(&cursor_dir) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err(invalid_path(".cursor must not be a symlink"))
        }
        Ok(metadata) if !metadata.is_dir() => {
            Err(invalid_path(".cursor exists but is not a directory"))
        }
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

fn validate_target(path: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err(invalid_path(".cursor/mcp.json must not be a symlink"))
        }
        Ok(metadata) if !metadata.is_file() => Err(invalid_path(
            ".cursor/mcp.json exists but is not a regular file",
        )),
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

pub(crate) fn validate_cursor_root(root: &Path) -> io::Result<()> {
    let canonical = canonical_root(root)?;
    let cursor_exists = validate_cursor_dir(&canonical)?;
    let path = canonical.join(".cursor").join("mcp.json");
    if cursor_exists {
        let _ = validate_target(&path)?;
    }
    Ok(())
}

fn lease_path(root: &Path) -> io::Result<(PathBuf, PathBuf)> {
    let canonical = canonical_root(root)?;
    let cursor_exists = validate_cursor_dir(&canonical)?;
    let key = canonical.join(".cursor").join("mcp.json");
    if cursor_exists {
        let _ = validate_target(&key)?;
    }
    Ok((key, canonical))
}

#[cfg(unix)]
fn file_mode(path: &Path) -> io::Result<u32> {
    use std::os::unix::fs::PermissionsExt;
    Ok(open_read_nofollow(path)?.metadata()?.permissions().mode() & 0o777)
}

#[cfg(not(unix))]
fn file_mode(_path: &Path) -> io::Result<u32> {
    Ok(0)
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    open_write_nofollow(path)?.set_permissions(fs::Permissions::from_mode(mode & 0o777))
}

#[cfg(not(unix))]
fn set_mode(_path: &Path, _mode: u32) -> io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn sync_dir(path: &Path) -> io::Result<()> {
    fs::File::open(path)?.sync_all()
}

#[cfg(not(unix))]
fn sync_dir(_path: &Path) -> io::Result<()> {
    Ok(())
}

fn sync_file(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        open_read_nofollow(path)?.sync_all()
    }
    #[cfg(not(unix))]
    {
        fs::File::open(path)?.sync_all()
    }
}

fn sync_entry_parent(path: &Path) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| invalid_path("durable entry has no parent"))?;
    sync_dir(parent)?;
    if let Some(grandparent) = parent.parent() {
        sync_dir(grandparent)?;
    }
    Ok(())
}

fn validate_credential_parent(parent: &Path) -> io::Result<()> {
    match fs::symlink_metadata(parent) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(invalid_path("credential parent must not be a symlink"));
        }
        Ok(metadata) if !metadata.is_dir() => {
            return Err(invalid_path("credential parent must be a directory"));
        }
        Ok(_) => {}
        Err(error) => return Err(error),
    }
    Ok(())
}

#[cfg(unix)]
fn open_read_nofollow(path: &Path) -> io::Result<fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
}

#[cfg(unix)]
fn open_write_nofollow(path: &Path) -> io::Result<fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    fs::OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
}

fn read_regular_file(path: &Path) -> io::Result<Vec<u8>> {
    #[cfg(unix)]
    {
        let mut file = open_read_nofollow(path)?;
        let mut contents = Vec::new();
        file.read_to_end(&mut contents)?;
        Ok(contents)
    }
    #[cfg(not(unix))]
    {
        fs::read(path)
    }
}

/// Atomically write a generated credential-bearing config with owner-only
/// permissions. The temporary file is created as 0600, so no 0644 window is
/// observable between creation and the final rename.
pub(crate) fn write_credential_file(path: &Path, contents: &[u8]) -> io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "credential path has no parent")
    })?;
    if !parent.exists() {
        fs::create_dir_all(parent)?;
    }
    validate_credential_parent(parent)?;
    let _ = validate_target(path)?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("mcp.json");
    let temporary = parent.join(format!(".{file_name}.{}.tmp", Uuid::new_v4().simple()));

    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(contents)?;
        file.sync_all()?;
        drop(file);
        validate_credential_parent(parent)?;
        #[cfg(windows)]
        if path.exists() {
            fs::remove_file(path)?;
        }
        fs::rename(&temporary, path)?;
        #[cfg(unix)]
        set_mode(path, 0o600)?;
        sync_file(path)?;
        sync_entry_parent(path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn restore_file(path: &Path, contents: &[u8], mode: u32) -> io::Result<()> {
    let _ = validate_target(path)?;
    write_credential_file(path, contents)?;
    set_mode(path, mode)?;
    sync_file(path)?;
    sync_entry_parent(path)?;
    Ok(())
}

impl PreExisting {
    fn journal(&self) -> JournalPreExisting {
        match self {
            Self::Absent { created_dir } => JournalPreExisting::Absent {
                created_dir: *created_dir,
            },
            Self::Present { contents, mode } => JournalPreExisting::Present {
                contents_base64: base64::engine::general_purpose::STANDARD.encode(contents),
                mode: *mode,
            },
        }
    }

    fn from_journal(value: JournalPreExisting) -> io::Result<Self> {
        match value {
            JournalPreExisting::Absent { created_dir } => Ok(Self::Absent { created_dir }),
            JournalPreExisting::Present {
                contents_base64,
                mode,
            } => Ok(Self::Present {
                contents: base64::engine::general_purpose::STANDARD
                    .decode(contents_base64.as_bytes())
                    .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?,
                mode,
            }),
        }
    }
}

impl CursorMcpLeaseRegistry {
    #[cfg(test)]
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Construct a registry and recover any leases left by a crashed broker.
    /// Recovery is safe because the journal never stores generated credentials.
    pub(crate) fn with_journal(path: PathBuf) -> Self {
        let mut registry = Self {
            journal_path: Some(path),
            ..Self::default()
        };
        if let Err(error) = registry.recover_journal() {
            tracing::error!(error = %error, "failed to recover Cursor MCP lease journal; retaining it for a later retry");
        }
        registry
    }

    pub(crate) fn acquire(&mut self, root: &Path, worker: &WorkerName) -> io::Result<PathBuf> {
        let (key, canonical) = lease_path(root)?;
        if let Some(existing) = self.path_by_worker.get(worker) {
            if existing == &key
                && self
                    .leases
                    .get(&key)
                    .is_some_and(|state| state.holders.contains(worker))
            {
                return Ok(key);
            }
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                format!("worker '{}' has pending Cursor MCP cleanup", worker),
            ));
        }
        if self.leases.contains_key(&key) {
            let was_new_holder = self
                .leases
                .get_mut(&key)
                .expect("lease checked above")
                .holders
                .insert(worker.clone());
            if !was_new_holder {
                return Ok(key);
            }
            self.path_by_worker.insert(worker.clone(), key.clone());
            if let Err(error) = self.persist_journal() {
                if let Some(state) = self.leases.get_mut(&key) {
                    state.holders.remove(worker);
                }
                self.path_by_worker.remove(worker);
                return Err(error);
            }
            return Ok(key);
        }

        let lock = LeaseLock::acquire(&canonical)?;
        // Re-check after taking the kernel lock so cooperating brokers cannot
        // race a parent/file replacement between validation and capture.
        let dir_existed = validate_cursor_dir(&canonical)?;
        let pre_existing = if validate_target(&key)? {
            PreExisting::Present {
                contents: read_regular_file(&key)?,
                mode: file_mode(&key)?,
            }
        } else {
            PreExisting::Absent {
                created_dir: !dir_existed,
            }
        };

        let mut holders = HashSet::new();
        holders.insert(worker.clone());
        self.leases.insert(
            key.clone(),
            LeaseState {
                pre_existing,
                holders,
                _lock: lock,
            },
        );
        self.path_by_worker.insert(worker.clone(), key.clone());
        if let Err(error) = self.persist_journal() {
            self.leases.remove(&key);
            self.path_by_worker.remove(worker);
            return Err(error);
        }
        Ok(key)
    }

    pub(crate) fn release_worker(&mut self, worker: &WorkerName) -> io::Result<()> {
        let Some(path) = self.path_by_worker.get(worker).cloned() else {
            return Ok(());
        };
        self.release_path(&path, worker)
    }

    pub(crate) fn has_pending_cleanup(&self, worker: &WorkerName) -> bool {
        let Some(path) = self.path_by_worker.get(worker) else {
            return false;
        };
        self.leases
            .get(path)
            .is_some_and(|state| !state.holders.contains(worker))
    }

    /// Retry only ownership entries whose final restore previously failed.
    /// Active holders are deliberately untouched; maintenance calls this on
    /// every reap tick so an in-process I/O failure is not stranded forever.
    pub(crate) fn retry_pending_cleanups(&mut self) {
        let workers: Vec<WorkerName> = self
            .path_by_worker
            .keys()
            .filter(|worker| self.has_pending_cleanup(worker))
            .cloned()
            .collect();
        for worker in workers {
            if let Err(error) = self.release_worker(&worker) {
                tracing::warn!(worker = %worker, %error, "Cursor MCP cleanup retry deferred");
            }
        }
    }

    fn release_path(&mut self, path: &Path, worker: &WorkerName) -> io::Result<()> {
        let Some(state) = self.leases.get_mut(path) else {
            self.path_by_worker.remove(worker);
            return Ok(());
        };
        state.holders.remove(worker);
        if !state.holders.is_empty() {
            self.path_by_worker.remove(worker);
            return self.persist_journal();
        }

        let pre_existing = match &state.pre_existing {
            PreExisting::Absent { created_dir } => PreExisting::Absent {
                created_dir: *created_dir,
            },
            PreExisting::Present { contents, mode } => PreExisting::Present {
                contents: contents.clone(),
                mode: *mode,
            },
        };
        self.restore(path, &pre_existing)?;
        let state = self.leases.remove(path).expect("lease checked above");
        self.path_by_worker.remove(worker);
        if let Err(error) = self.persist_journal() {
            // The file is restored, but journal removal was not durable. Keep
            // ownership in memory so the periodic retry can finish the
            // transaction instead of relying only on a future broker restart.
            self.leases.insert(path.to_path_buf(), state);
            self.path_by_worker
                .insert(worker.clone(), path.to_path_buf());
            return Err(error);
        }
        Ok(())
    }

    fn restore(&self, path: &Path, pre_existing: &PreExisting) -> io::Result<()> {
        match pre_existing {
            PreExisting::Absent { created_dir } => {
                match fs::symlink_metadata(path) {
                    Ok(metadata) if metadata.file_type().is_symlink() => {
                        return Err(invalid_path(
                            "refusing to remove a symlink at generated Cursor MCP path",
                        ));
                    }
                    Ok(metadata) if !metadata.is_file() => {
                        return Err(invalid_path(
                            "refusing to remove a non-regular generated Cursor MCP path",
                        ));
                    }
                    Ok(_) => {}
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error),
                }
                let removed = match fs::remove_file(path) {
                    Ok(()) => true,
                    Err(error) if error.kind() == io::ErrorKind::NotFound => false,
                    Err(error) => return Err(error),
                };
                if removed {
                    sync_entry_parent(path)?;
                }
                if *created_dir {
                    if let Some(dir) = path.parent() {
                        if fs::remove_dir(dir).is_ok() {
                            sync_entry_parent(dir)?;
                        }
                    }
                }
            }
            PreExisting::Present { contents, mode } => restore_file(path, contents, *mode)?,
        }
        Ok(())
    }

    fn journal_entries(&self) -> Vec<JournalEntry> {
        self.leases
            .iter()
            .map(|(path, state)| JournalEntry {
                path: path.clone(),
                pre_existing: state.pre_existing.journal(),
            })
            .collect()
    }

    fn persist_journal(&self) -> io::Result<()> {
        let Some(path) = &self.journal_path else {
            return Ok(());
        };
        if self.leases.is_empty() {
            match fs::remove_file(path) {
                Ok(()) => sync_entry_parent(path),
                Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
                Err(error) => Err(error),
            }
        } else {
            let body = serde_json::to_vec_pretty(&Journal {
                entries: self.journal_entries(),
            })
            .map_err(|error| io::Error::other(error.to_string()))?;
            write_credential_file(path, &body)
        }
    }

    fn recover_journal(&mut self) -> io::Result<()> {
        let Some(path) = self.journal_path.clone() else {
            return Ok(());
        };
        let body = match fs::read(&path) {
            Ok(body) => body,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        let journal: Journal = serde_json::from_slice(&body)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        let mut remaining = Vec::new();
        for entry in journal.entries {
            let pre_existing = PreExisting::from_journal(entry.pre_existing)?;
            if !entry.path.is_absolute() {
                return Err(invalid_path(
                    "Cursor MCP lease journal path must be absolute",
                ));
            }
            let root = entry
                .path
                .parent()
                .and_then(Path::parent)
                .ok_or_else(|| invalid_path("invalid Cursor MCP lease journal path"))?;
            let expected_path = root.join(".cursor").join("mcp.json");
            if entry.path != expected_path {
                return Err(invalid_path(
                    "Cursor MCP lease journal path is outside its cwd",
                ));
            }
            let canonical = canonical_root(root)?;
            if entry.path != canonical.join(".cursor").join("mcp.json") {
                return Err(invalid_path(
                    "Cursor MCP lease journal path is not canonical",
                ));
            }
            let _lock = match LeaseLock::acquire(root) {
                Ok(lock) => lock,
                Err(error) => {
                    tracing::warn!(path = %entry.path.display(), %error, "Cursor MCP lease recovery deferred because another broker owns the cwd");
                    remaining.push(JournalEntry {
                        path: entry.path,
                        pre_existing: pre_existing.journal(),
                    });
                    continue;
                }
            };
            if let Err(error) = validate_cursor_root(root) {
                tracing::warn!(path = %entry.path.display(), %error, "Cursor MCP lease recovery rejected an unsafe path");
                remaining.push(JournalEntry {
                    path: entry.path,
                    pre_existing: pre_existing.journal(),
                });
                continue;
            }
            if let Err(error) = self.restore(&entry.path, &pre_existing) {
                tracing::warn!(path = %entry.path.display(), error = %error, "Cursor MCP lease recovery deferred");
                remaining.push(JournalEntry {
                    path: entry.path,
                    pre_existing: pre_existing.journal(),
                });
            }
        }
        if remaining.is_empty() {
            match fs::remove_file(&path) {
                Ok(()) => sync_entry_parent(&path)?,
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
        } else {
            let body = serde_json::to_vec_pretty(&Journal { entries: remaining })
                .map_err(|error| io::Error::other(error.to_string()))?;
            write_credential_file(&path, &body)?;
        }
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn is_empty(&self) -> bool {
        self.leases.is_empty() && self.path_by_worker.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn read(path: &Path) -> Vec<u8> {
        fs::read(path).unwrap()
    }

    #[test]
    fn clean_cwd_creates_then_removes_on_release() {
        let dir = tempdir().unwrap();
        let worker = WorkerName::new("w1");
        let mut registry = CursorMcpLeaseRegistry::new();
        let path = registry.acquire(dir.path(), &worker).unwrap();
        write_credential_file(&path, b"{} ").unwrap();
        registry.release_worker(&worker).unwrap();
        assert!(!path.exists());
        assert!(!path.parent().unwrap().exists());
        assert!(registry.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn pre_existing_exact_config_and_mode_are_restored() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempdir().unwrap();
        let cursor_dir = dir.path().join(".cursor");
        fs::create_dir_all(&cursor_dir).unwrap();
        let path = cursor_dir.join("mcp.json");
        let original = br#"{ "mcpServers": { "filesystem": {} } }"#;
        fs::write(&path, original).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        let mut registry = CursorMcpLeaseRegistry::new();
        let worker = WorkerName::new("w1");
        registry.acquire(dir.path(), &worker).unwrap();
        write_credential_file(&path, b"generated").unwrap();
        registry.release_worker(&worker).unwrap();
        assert_eq!(read(&path), original);
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o640
        );
    }

    #[test]
    fn two_workers_share_one_lease_and_restore_after_last_release() {
        let dir = tempdir().unwrap();
        let path = dir.path().join(".cursor").join("mcp.json");
        let mut registry = CursorMcpLeaseRegistry::new();
        let w1 = WorkerName::new("w1");
        let w2 = WorkerName::new("w2");
        registry.acquire(dir.path(), &w1).unwrap();
        write_credential_file(&path, b"generated").unwrap();
        registry.acquire(dir.path(), &w2).unwrap();
        registry.release_worker(&w1).unwrap();
        assert!(path.exists());
        registry.release_worker(&w2).unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn journal_recovers_after_registry_restart() {
        let dir = tempdir().unwrap();
        let journal = dir.path().join("journal.json");
        let cursor = dir.path().join(".cursor");
        fs::create_dir_all(&cursor).unwrap();
        let path = cursor.join("mcp.json");
        let original = b"user config";
        fs::write(&path, original).unwrap();
        {
            let mut registry = CursorMcpLeaseRegistry::with_journal(journal.clone());
            let worker = WorkerName::new("w1");
            registry.acquire(dir.path(), &worker).unwrap();
            write_credential_file(&path, b"placeholders only").unwrap();
        }
        let recovered = CursorMcpLeaseRegistry::with_journal(journal.clone());
        assert!(recovered.is_empty());
        assert_eq!(read(&path), original);
        assert!(!journal.exists());
    }

    #[test]
    fn failed_restore_keeps_lease_for_a_later_retry() {
        let dir = tempdir().unwrap();
        let mut registry = CursorMcpLeaseRegistry::new();
        let worker = WorkerName::new("w1");
        let path = registry.acquire(dir.path(), &worker).unwrap();
        write_credential_file(&path, b"generated").unwrap();
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();

        assert!(registry.release_worker(&worker).is_err());
        assert!(!registry.is_empty(), "failed cleanup must remain retryable");

        fs::remove_dir(&path).unwrap();
        registry.release_worker(&worker).unwrap();
        assert!(registry.is_empty());
        assert!(!path.exists());
    }

    #[cfg(unix)]
    #[test]
    fn separate_registries_fail_closed_while_another_process_holds_cwd_lock() {
        let dir = tempdir().unwrap();
        let worker_one = WorkerName::new("w1");
        let worker_two = WorkerName::new("w2");
        let mut first = CursorMcpLeaseRegistry::new();
        let mut second = CursorMcpLeaseRegistry::new();

        first.acquire(dir.path(), &worker_one).unwrap();
        let error = second.acquire(dir.path(), &worker_two).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::WouldBlock);

        first.release_worker(&worker_one).unwrap();
        second.acquire(dir.path(), &worker_two).unwrap();
        second.release_worker(&worker_two).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_cursor_paths_are_rejected_before_capture_or_write() {
        use std::os::unix::fs::symlink;

        let cwd = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let worker = WorkerName::new("hostile");
        let outside_file = outside.path().join("mcp.json");
        fs::write(&outside_file, b"outside bytes").unwrap();
        symlink(outside.path(), cwd.path().join(".cursor")).unwrap();

        let mut registry = CursorMcpLeaseRegistry::new();
        assert!(registry.acquire(cwd.path(), &worker).is_err());
        assert_eq!(read(&outside_file), b"outside bytes");

        fs::remove_file(cwd.path().join(".cursor")).unwrap();
        fs::create_dir(cwd.path().join(".cursor")).unwrap();
        symlink(&outside_file, cwd.path().join(".cursor/mcp.json")).unwrap();
        assert!(registry.acquire(cwd.path(), &worker).is_err());
        assert_eq!(read(&outside_file), b"outside bytes");
    }
}
