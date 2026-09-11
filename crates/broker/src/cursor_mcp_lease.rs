//! Per-worker lease over an injected Cursor `.cursor/mcp.json`.
//!
//! [`relay#1753`](https://github.com/AgentWorkforce/relay/issues/1753):
//! spawning a Cursor worker with Agent Relay MCP injection writes plaintext
//! credentials into `<cwd>/.cursor/mcp.json`. Releasing the worker used to
//! leave that file behind untouched — a worktree-local credential leak.
//!
//! This registry treats the injected config as a lease owned by whichever
//! [`WorkerRegistry`](crate::worker::WorkerRegistry) workers currently share a
//! `cwd`. The first worker to lease a given `.cursor/mcp.json` path captures
//! whatever was there beforehand (a pre-existing user config, or nothing).
//! Every subsequent worker sharing that cwd joins the same lease. Only when
//! the *last* holder releases does the registry restore the captured
//! pre-existing state — never a stale intermediate worker's credentials.
//!
//! Restoration is triggered from every lifecycle exit this issue calls out:
//! spawn failure, explicit release, task-exit/reap, orphan cleanup, broker
//! shutdown, and ambiguous-timeout recovery — because all of those paths
//! funnel through [`WorkerRegistry::release`](crate::worker::WorkerRegistry::release),
//! [`WorkerRegistry::cleanup_rejected_spawn`](crate::worker::WorkerRegistry::cleanup_rejected_spawn),
//! or [`WorkerRegistry::reap_exited`](crate::worker::WorkerRegistry::reap_exited).

use std::{
    collections::{HashMap, HashSet},
    fs, io,
    path::{Path, PathBuf},
};

use crate::ids::WorkerName;

/// What existed at the leased path before the first worker claimed it.
#[derive(Debug, Clone)]
enum PreExisting {
    /// Nothing was there. `created_dir` is true when this lease also had to
    /// create the parent `.cursor` directory, so restore can remove it again
    /// if — and only if — it is still empty (never delete a directory a user
    /// populated with something else in the meantime).
    Absent { created_dir: bool },
    /// The raw bytes that were on disk, preserved verbatim (not reparsed) so
    /// restore is byte-for-byte even if the file was invalid JSON or had
    /// unusual formatting/comments.
    Present(Vec<u8>),
}

struct LeaseState {
    pre_existing: PreExisting,
    holders: HashSet<WorkerName>,
}

/// Tracks in-process leases over injected `.cursor/mcp.json` files, keyed by
/// the canonicalized `.cursor/mcp.json` path. Lives on [`WorkerRegistry`] so
/// concurrent Cursor workers that share one `cwd` are correctly recognized as
/// sharing one lease instead of each capturing/restoring independently.
#[derive(Default)]
pub(crate) struct CursorMcpLeaseRegistry {
    leases: HashMap<PathBuf, LeaseState>,
    /// Reverse index so release call sites (which only know the worker name,
    /// not its cwd — e.g. a generic reap sweep) can find the lease to drop
    /// without threading `cwd` through every call site.
    path_by_worker: HashMap<WorkerName, PathBuf>,
}

fn lease_path(root: &Path) -> PathBuf {
    // Canonicalize `root` itself, not `.cursor` — the worker cwd is
    // guaranteed to already exist (broker `spawn()` validates that before
    // any harness config is built), whereas `.cursor` may not exist yet on a
    // from-scratch spawn. Canonicalizing whichever of the two happens to
    // exist would make two concurrent workers sharing one cwd resolve to
    // different keys purely based on acquire ordering (one arriving before
    // `.cursor` is created, the other after), which would let two "same
    // cwd" leases diverge and let one worker's release stomp another's
    // config. Falling back to the joined (non-canonical) path when `root`
    // itself can't be resolved keeps this a best-effort dedup, not a
    // correctness requirement.
    let joined = root.join(".cursor").join("mcp.json");
    match root.canonicalize() {
        Ok(canonical) => canonical.join(".cursor").join("mcp.json"),
        Err(_) => joined,
    }
}

#[cfg(unix)]
fn secure_permissions(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn secure_permissions(_path: &Path) -> io::Result<()> {
    Ok(())
}

/// Write `contents` to `path` and enforce owner-only permissions. Used both
/// for the initial credential-bearing write and for lease restoration, so a
/// restored pre-existing config is at least as tightly permissioned as the
/// credential file it replaced.
pub(crate) fn write_credential_file(path: &Path, contents: &[u8]) -> io::Result<()> {
    fs::write(path, contents)?;
    secure_permissions(path)
}

impl CursorMcpLeaseRegistry {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Acquire (or join) the lease over `<root>/.cursor/mcp.json` for
    /// `worker`. Idempotent for a given worker/path pair. Must be called
    /// before the caller overwrites the file, so the pre-existing content is
    /// captured, never a config another Agent Relay worker already wrote.
    pub(crate) fn acquire(&mut self, root: &Path, worker: &WorkerName) -> io::Result<PathBuf> {
        let key = lease_path(root);
        if let Some(state) = self.leases.get_mut(&key) {
            state.holders.insert(worker.clone());
            self.path_by_worker.insert(worker.clone(), key.clone());
            return Ok(key);
        }

        let cursor_dir = root.join(".cursor");
        let dir_existed = cursor_dir.is_dir();
        let pre_existing = if key.exists() {
            PreExisting::Present(fs::read(&key)?)
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
        Ok(key)
    }

    /// Release `worker`'s hold on whatever lease it currently has (a no-op if
    /// it has none — every removal call site can call this unconditionally
    /// rather than re-deriving whether the worker was a Cursor worker).
    /// Restores the pre-existing state only when `worker` was the last
    /// remaining holder.
    pub(crate) fn release_worker(&mut self, worker: &WorkerName) -> io::Result<()> {
        let Some(path) = self.path_by_worker.remove(worker) else {
            return Ok(());
        };
        self.release_path(&path, worker)
    }

    fn release_path(&mut self, path: &Path, worker: &WorkerName) -> io::Result<()> {
        let Some(state) = self.leases.get_mut(path) else {
            return Ok(());
        };
        state.holders.remove(worker);
        if !state.holders.is_empty() {
            return Ok(());
        }
        let state = self.leases.remove(path).expect("checked above");
        match state.pre_existing {
            PreExisting::Absent { created_dir } => {
                match fs::remove_file(path) {
                    Ok(()) => {}
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error),
                }
                if created_dir {
                    if let Some(dir) = path.parent() {
                        // Only removes a genuinely empty directory; leaves it
                        // alone (and swallows the error) if the user or
                        // another process put something else there.
                        let _ = fs::remove_dir(dir);
                    }
                }
            }
            PreExisting::Present(contents) => {
                write_credential_file(path, &contents)?;
            }
        }
        Ok(())
    }

    /// True when any worker currently holds a lease (used by tests/shutdown
    /// bookkeeping to assert full drain).
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

    fn read(path: &Path) -> String {
        fs::read_to_string(path).unwrap()
    }

    #[test]
    fn clean_cwd_creates_then_removes_on_release() {
        let dir = tempdir().unwrap();
        let worker = WorkerName::new("w1");
        let mut registry = CursorMcpLeaseRegistry::new();
        let path = registry.acquire(dir.path(), &worker).unwrap();
        assert!(!path.exists(), "acquire must not create the file itself");

        fs::create_dir_all(path.parent().unwrap()).unwrap();
        write_credential_file(&path, b"{\"mcpServers\":{}}").unwrap();
        assert!(path.exists());

        registry.release_worker(&worker).unwrap();
        assert!(!path.exists(), "generated file must be removed on release");
        assert!(registry.is_empty());
    }

    #[test]
    fn pre_existing_exact_config_is_restored() {
        let dir = tempdir().unwrap();
        let cursor_dir = dir.path().join(".cursor");
        fs::create_dir_all(&cursor_dir).unwrap();
        let path = cursor_dir.join("mcp.json");
        let original = br#"{"mcpServers":{"filesystem":{"command":"fs"}}}"#;
        fs::write(&path, original).unwrap();

        let mut registry = CursorMcpLeaseRegistry::new();
        let worker = WorkerName::new("w1");
        registry.acquire(dir.path(), &worker).unwrap();
        // Simulate the injection overwrite.
        write_credential_file(
            &path,
            br#"{"mcpServers":{"filesystem":{"command":"fs"},"agent-relay":{"token":"secret"}}}"#,
        )
        .unwrap();

        registry.release_worker(&worker).unwrap();
        assert_eq!(
            read(&path).as_bytes(),
            original,
            "must restore exact pre-existing bytes"
        );
    }

    #[test]
    fn user_edits_between_acquire_and_release_are_overwritten_by_restore() {
        // The captured pre-existing snapshot — not whatever is on disk at
        // release time — is authoritative, so a credential leak cannot
        // survive as "the user's file now".
        let dir = tempdir().unwrap();
        let cursor_dir = dir.path().join(".cursor");
        fs::create_dir_all(&cursor_dir).unwrap();
        let path = cursor_dir.join("mcp.json");
        let original = br#"{"mcpServers":{"filesystem":{"command":"fs"}}}"#;
        fs::write(&path, original).unwrap();

        let mut registry = CursorMcpLeaseRegistry::new();
        let worker = WorkerName::new("w1");
        registry.acquire(dir.path(), &worker).unwrap();
        write_credential_file(
            &path,
            br#"{"mcpServers":{"agent-relay":{"token":"secret"}}}"#,
        )
        .unwrap();
        // External edit after injection, before release.
        fs::write(
            &path,
            br#"{"mcpServers":{"agent-relay":{"token":"secret"},"extra":true}}"#,
        )
        .unwrap();

        registry.release_worker(&worker).unwrap();
        assert_eq!(read(&path).as_bytes(), original);
    }

    #[test]
    fn two_concurrent_workers_same_cwd_release_in_order_keeps_config_until_last() {
        let dir = tempdir().unwrap();
        let path = dir.path().join(".cursor").join("mcp.json");
        let mut registry = CursorMcpLeaseRegistry::new();
        let w1 = WorkerName::new("w1");
        let w2 = WorkerName::new("w2");

        registry.acquire(dir.path(), &w1).unwrap();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        write_credential_file(
            &path,
            b"{\"mcpServers\":{\"agent-relay\":{\"token\":\"w1\"}}}",
        )
        .unwrap();
        registry.acquire(dir.path(), &w2).unwrap();
        write_credential_file(
            &path,
            b"{\"mcpServers\":{\"agent-relay\":{\"token\":\"w2\"}}}",
        )
        .unwrap();

        registry.release_worker(&w1).unwrap();
        assert!(path.exists(), "config must survive while a holder remains");

        registry.release_worker(&w2).unwrap();
        assert!(
            !path.exists(),
            "config must be removed once the last holder releases"
        );
        assert!(registry.is_empty());
    }

    #[test]
    fn two_concurrent_workers_same_cwd_release_in_reverse_order() {
        let dir = tempdir().unwrap();
        let path = dir.path().join(".cursor").join("mcp.json");
        let mut registry = CursorMcpLeaseRegistry::new();
        let w1 = WorkerName::new("w1");
        let w2 = WorkerName::new("w2");

        registry.acquire(dir.path(), &w1).unwrap();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        write_credential_file(&path, b"{}").unwrap();
        registry.acquire(dir.path(), &w2).unwrap();

        registry.release_worker(&w2).unwrap();
        assert!(path.exists(), "config must survive while w1 remains");

        registry.release_worker(&w1).unwrap();
        assert!(!path.exists());
        assert!(registry.is_empty());
    }

    #[test]
    fn spawn_failure_before_any_write_releases_cleanly() {
        let dir = tempdir().unwrap();
        let mut registry = CursorMcpLeaseRegistry::new();
        let worker = WorkerName::new("w1");
        registry.acquire(dir.path(), &worker).unwrap();
        // No write happened (simulated spawn failure right after acquire).
        registry.release_worker(&worker).unwrap();
        assert!(!dir.path().join(".cursor").join("mcp.json").exists());
        assert!(registry.is_empty());
    }

    #[test]
    fn explicit_release_of_unknown_worker_is_a_no_op() {
        let mut registry = CursorMcpLeaseRegistry::new();
        registry.release_worker(&WorkerName::new("ghost")).unwrap();
    }

    #[test]
    fn reap_after_task_exit_restores_pre_existing_config() {
        let dir = tempdir().unwrap();
        let cursor_dir = dir.path().join(".cursor");
        fs::create_dir_all(&cursor_dir).unwrap();
        let path = cursor_dir.join("mcp.json");
        fs::write(&path, b"{\"mcpServers\":{\"db\":{}}}").unwrap();

        let mut registry = CursorMcpLeaseRegistry::new();
        let worker = WorkerName::new("task-exit-worker");
        registry.acquire(dir.path(), &worker).unwrap();
        write_credential_file(&path, b"{\"mcpServers\":{\"db\":{},\"agent-relay\":{}}}").unwrap();

        // reap_exited() path: worker process exited, registry sweeps it.
        registry.release_worker(&worker).unwrap();
        assert_eq!(read(&path), "{\"mcpServers\":{\"db\":{}}}");
    }

    #[cfg(unix)]
    #[test]
    fn restrictive_mode_enforced_on_generated_and_restored_files() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempdir().unwrap();
        let mut registry = CursorMcpLeaseRegistry::new();
        let worker = WorkerName::new("w1");
        let path = registry.acquire(dir.path(), &worker).unwrap();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        write_credential_file(&path, b"{}").unwrap();
        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "generated credential file must be 0600");

        // Now exercise the restore-path permission enforcement too.
        drop(registry);
        let dir2 = tempdir().unwrap();
        let cursor_dir2 = dir2.path().join(".cursor");
        fs::create_dir_all(&cursor_dir2).unwrap();
        let path2 = cursor_dir2.join("mcp.json");
        fs::write(&path2, b"{\"mcpServers\":{}}").unwrap();
        fs::set_permissions(&path2, fs::Permissions::from_mode(0o644)).unwrap();

        let mut registry2 = CursorMcpLeaseRegistry::new();
        let worker2 = WorkerName::new("w2");
        registry2.acquire(dir2.path(), &worker2).unwrap();
        write_credential_file(&path2, b"{\"mcpServers\":{\"agent-relay\":{}}}").unwrap();
        registry2.release_worker(&worker2).unwrap();
        let restored_mode = fs::metadata(&path2).unwrap().permissions().mode() & 0o777;
        assert_eq!(
            restored_mode, 0o600,
            "restored config must also be locked to 0600"
        );
    }
}
