//! Crash-recoverable leases for a generated Cursor `.cursor/mcp.json`.

use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
};

use base64::Engine;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::ids::WorkerName;

#[derive(Debug, Clone)]
enum PreExisting {
    Absent {
        created_dir: bool,
    },
    Present {
        contents: Vec<u8>,
        mode: Option<u32>,
    },
}

struct LeaseState {
    pre_existing: PreExisting,
    holders: HashSet<WorkerName>,
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
    Absent {
        created_dir: bool,
    },
    Present {
        contents_base64: String,
        mode: Option<u32>,
    },
}

/// Tracks in-process leases and a credential-free-on-disk recovery journal.
/// The journal contains only pre-existing bytes and mode, never generated
/// Relay credentials: generated Cursor values are `${env:...}` placeholders.
#[derive(Default)]
pub(crate) struct CursorMcpLeaseRegistry {
    leases: HashMap<PathBuf, LeaseState>,
    path_by_worker: HashMap<WorkerName, PathBuf>,
    journal_path: Option<PathBuf>,
}

fn lease_path(root: &Path) -> PathBuf {
    let joined = root.join(".cursor").join("mcp.json");
    match root.canonicalize() {
        Ok(canonical) => canonical.join(".cursor").join("mcp.json"),
        Err(_) => joined,
    }
}

#[cfg(unix)]
fn file_mode(path: &Path) -> io::Result<u32> {
    use std::os::unix::fs::PermissionsExt;
    Ok(fs::metadata(path)?.permissions().mode() & 0o777)
}

#[cfg(not(unix))]
fn file_mode(_path: &Path) -> io::Result<u32> {
    Ok(0)
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(mode & 0o777))
}

#[cfg(not(unix))]
fn set_mode(_path: &Path, _mode: u32) -> io::Result<()> {
    Ok(())
}

/// Atomically write a generated credential-bearing config with owner-only
/// permissions. The temporary file is created as 0600, so no 0644 window is
/// observable between creation and the final rename.
pub(crate) fn write_credential_file(path: &Path, contents: &[u8]) -> io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "credential path has no parent")
    })?;
    fs::create_dir_all(parent)?;
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
        #[cfg(windows)]
        if path.exists() {
            fs::remove_file(path)?;
        }
        fs::rename(&temporary, path)?;
        #[cfg(unix)]
        set_mode(path, 0o600)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn restore_file(path: &Path, contents: &[u8], mode: Option<u32>) -> io::Result<()> {
    write_credential_file(path, contents)?;
    if let Some(mode) = mode {
        set_mode(path, mode)?;
    }
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
        let key = lease_path(root);
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

        let cursor_dir = root.join(".cursor");
        let dir_existed = cursor_dir.is_dir();
        let pre_existing = if key.exists() {
            PreExisting::Present {
                contents: fs::read(&key)?,
                mode: Some(file_mode(&key)?),
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
        self.leases.remove(path);
        self.path_by_worker.remove(worker);
        self.persist_journal()
    }

    fn restore(&self, path: &Path, pre_existing: &PreExisting) -> io::Result<()> {
        match pre_existing {
            PreExisting::Absent { created_dir } => {
                match fs::remove_file(path) {
                    Ok(()) => {}
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error),
                }
                if *created_dir {
                    if let Some(dir) = path.parent() {
                        let _ = fs::remove_dir(dir);
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
                Ok(()) => Ok(()),
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
            if let Err(error) = self.restore(&entry.path, &pre_existing) {
                tracing::warn!(path = %entry.path.display(), error = %error, "Cursor MCP lease recovery deferred");
                remaining.push(JournalEntry {
                    path: entry.path,
                    pre_existing: pre_existing.journal(),
                });
            }
        }
        if remaining.is_empty() {
            let _ = fs::remove_file(path);
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
}
