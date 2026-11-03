//! Refreshing the kept Cloud session safely.
//!
//! Cloud rotates the refresh token on every use and refuses the old one
//! afterwards, so a refresh made with a token someone else already rotated
//! is refused and, before this, cost the person their session. Every
//! process that keeps this store refreshes the session only while holding
//! an exclusive `flock` on `injectable-agents.json.session.lock`, after
//! adopting whatever another process wrote since (`StoreHandle::reload`),
//! and a rotation replaces every copy of the old pair the store keeps (the
//! live `cloudSession` and the copies pending desktop-identity clears hold),
//! so no copy is left holding a refresh token Cloud has already retired.

use super::{blocking, CloudSession, Contents, Store, StoreError, StoreFile, StoreHandle};
use fs2::FileExt;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

/// Held while the kept session is refreshed; released when dropped.
pub struct SessionRefreshLock {
    _file: fs::File,
}

impl Store {
    /// Replaces every copy of `old` with `next`: the kept session when it is
    /// still `old`, and any pending desktop-identity clear holding `old`'s
    /// refresh token (Cloud no longer honours it). `next` of `None` forgets
    /// the kept session only. `true` when the kept session was `old`.
    pub fn rotate_session(&mut self, old: &CloudSession, next: Option<&CloudSession>) -> bool {
        if let (Some(next), Some(refresh)) = (next, old.refresh_token.as_ref()) {
            for clear in self.desktop_identity_clears_pending.iter_mut().flatten() {
                if clear.session.refresh_token.as_ref() == Some(refresh) {
                    clear.session = next.clone();
                }
            }
        }
        if self.cloud_session.as_ref() != Some(old) {
            return false;
        }
        self.cloud_session = next.cloned();
        true
    }
}

impl StoreFile {
    /// `store` merged with the file's current contents, then `change`d, all
    /// under the store's lock; written back only when the file lacks it.
    /// Like `save`, it refuses a file it cannot read or decode rather than
    /// writing this process's copy over it.
    fn adopt<T>(
        &mut self,
        store: &Store,
        change: impl FnOnce(&mut Store) -> T,
    ) -> Result<(Store, T), StoreError> {
        if let Some(blocked) = &self.blocked {
            return Err(blocked.clone());
        }
        self.with_lock(|file| {
            let (mut merged, theirs) = match file.read() {
                Contents::Missing => (store.clone(), None),
                Contents::Store(theirs) => (
                    Store::merged(&file.baseline, store, &theirs.store),
                    Some(theirs.store),
                ),
                Contents::Undecodable => {
                    return Err(StoreError::ChangedUnreadable {
                        path: file.path.clone(),
                    })
                }
                Contents::Unreadable(reason) => {
                    return Err(StoreError::Unreadable {
                        path: file.path.clone(),
                        reason,
                    })
                }
            };
            let result = change(&mut merged);
            if theirs.as_ref() != Some(&merged) {
                file.write(&merged)?;
            }
            file.baseline = merged.clone();
            Ok((merged, result))
        })
    }

    fn session_lock_path(&self) -> PathBuf {
        let mut path = self.path.clone().into_os_string();
        path.push(".session.lock");
        PathBuf::from(path)
    }
}

impl StoreHandle {
    /// Adopts what other processes wrote since this one last read or wrote
    /// the file, such as a session they refreshed.
    pub fn reload(&self) -> Result<(), StoreError> {
        self.update_latest(|_| ())
    }

    /// Applies `change` to the store as the file holds it now (another
    /// process's latest session included) and saves, under one hold of the
    /// store's lock: a compare-and-swap on the kept session never decides on
    /// a stale copy, or writes over a session saved meanwhile. A failure
    /// leaves memory as it was and is reported like `update`'s.
    pub fn update_latest<T>(&self, change: impl FnOnce(&mut Store) -> T) -> Result<T, StoreError> {
        blocking(|| {
            let mut state = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            let error_before = state.error();
            let store = state.store.clone();
            let outcome = match state.file.adopt(&store, change) {
                Ok((adopted, result)) => {
                    state.saved(adopted);
                    Ok(result)
                }
                Err(error) => {
                    state.save_error = Some(error.clone());
                    Err(error)
                }
            };
            let error_after = state.error();
            drop(state);
            self.report(error_before, error_after);
            outcome
        })
    }

    /// Waits for the session refresh lock: one refresh at a time across
    /// every process (and every task) keeping this store. `None` when the
    /// lock file cannot be opened or locked; nothing may refresh then.
    pub async fn lock_session_refresh(&self) -> Option<SessionRefreshLock> {
        let path = {
            let state = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            state.file.session_lock_path()
        };
        tokio::task::spawn_blocking(move || lock_file(&path).ok())
            .await
            .ok()
            .flatten()
            .map(|file| SessionRefreshLock { _file: file })
    }
}

/// `path`, created readable by this user only, held under an exclusive
/// `flock` until the file is closed or unlocked: the store's own lock and
/// the session refresh lock alike.
pub(super) fn lock_file(path: &Path) -> std::io::Result<fs::File> {
    let file = crate::platform::fs::private(
        fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false),
    )
    .open(path)?;
    loop {
        match file.lock_exclusive() {
            Ok(()) => return Ok(file),
            Err(error) if error.kind() == ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::{random_uuid, CloudWorkspace, DesktopIdentityClear};
    use super::*;
    use crate::relay::workspace::{Secret, DEFAULT_BASE_URL};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    fn session(access: &str, refresh: &str) -> CloudSession {
        CloudSession {
            access_token: Secret::new(access),
            access_token_expires_at: Some("2099-01-01T00:00:00Z".into()),
            refresh_token: Some(Secret::new(refresh)),
            refresh_token_expires_at: None,
            site_url: "https://agentrelay.com".into(),
        }
    }

    fn signed_in(kept: &CloudSession) -> Store {
        Store {
            desktop_sync_source_id: Some(random_uuid()),
            cloud_session: Some(kept.clone()),
            cloud: Some(CloudWorkspace {
                key: Secret::new("rk_live_cloudcloud"),
                base_url: DEFAULT_BASE_URL.into(),
                workspace_id: Some("rw_cast".into()),
                account_workspace_id: Some("workspace".into()),
                name: None,
                relayfile_workspace_id: None,
            }),
            ..Store::default()
        }
    }

    fn clears(store: &Store) -> Vec<DesktopIdentityClear> {
        store
            .desktop_identity_clears_pending
            .clone()
            .unwrap_or_default()
    }

    #[test]
    fn a_rotation_replaces_every_copy_of_the_retired_pair() {
        let old = session("access-1", "refresh-1");
        let mut store = signed_in(&old);
        // A workspace switch queues a clear holding the live pair.
        assert!(store.queue_desktop_identity_clear(false));
        let other = session("access-9", "refresh-9");
        store.cloud_session = Some(other.clone());
        assert!(store.queue_desktop_identity_clear(false));
        store.cloud_session = Some(old.clone());
        let next = session("access-2", "refresh-2");
        assert!(store.rotate_session(&old, Some(&next)));
        assert_eq!(store.cloud_session, Some(next.clone()));
        let pending = clears(&store);
        assert_eq!(pending[0].session, next);
        assert_eq!(pending[1].session, other);
        // A clear's own rotation reaches the kept session it shares.
        let after = session("access-3", "refresh-3");
        assert!(store.rotate_session(&next, Some(&after)));
        assert_eq!(store.cloud_session, Some(after.clone()));
        assert_eq!(clears(&store)[0].session, after);
    }

    #[test]
    fn a_rotation_of_a_session_no_longer_kept_changes_nothing_kept() {
        let kept = session("access-5", "refresh-5");
        let mut store = signed_in(&kept);
        let stale = session("access-1", "refresh-1");
        assert!(!store.rotate_session(&stale, None));
        assert_eq!(store.cloud_session, Some(kept));
    }

    #[test]
    fn reload_adopts_a_session_another_process_saved() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("injectable-agents.json");
        let ours = StoreHandle::open(path.clone(), "desk");
        let old = session("access-1", "refresh-1");
        ours.update(|s| s.cloud_session = Some(old.clone()))
            .unwrap();
        let theirs = StoreHandle::open(path.clone(), "desk");
        let next = session("access-2", "refresh-2");
        theirs
            .update(|s| s.rotate_session(&old, Some(&next)))
            .unwrap();
        assert_eq!(ours.read(|s| s.cloud_session.clone()), Some(old.clone()));
        ours.reload().unwrap();
        assert_eq!(ours.read(|s| s.cloud_session.clone()), Some(next.clone()));
        // Forgetting the stale copy now changes nothing on disk.
        assert!(!ours.update(|s| s.rotate_session(&old, None)).unwrap());
        let reopened = StoreHandle::open(path, "desk");
        assert_eq!(reopened.read(|s| s.cloud_session.clone()), Some(next));
    }

    #[test]
    fn a_rotation_never_writes_over_a_session_saved_meanwhile() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("injectable-agents.json");
        let refresher = StoreHandle::open(path.clone(), "desk");
        let old = session("access-1", "refresh-1");
        refresher
            .update(|s| s.cloud_session = Some(old.clone()))
            .unwrap();
        // Another process keeps a new sign-in while this one refreshes `old`.
        let signed_in = StoreHandle::open(path.clone(), "desk");
        let kept = session("access-7", "refresh-7");
        signed_in
            .update_latest(|s| s.cloud_session = Some(kept.clone()))
            .unwrap();
        let rotated = session("access-2", "refresh-2");
        let replaced = refresher
            .update_latest(|s| s.rotate_session(&old, Some(&rotated)))
            .unwrap();
        assert!(!replaced);
        assert_eq!(
            refresher.read(|s| s.cloud_session.clone()),
            Some(kept.clone())
        );
        let reopened = StoreHandle::open(path, "desk");
        assert_eq!(reopened.read(|s| s.cloud_session.clone()), Some(kept));
    }

    #[test]
    fn a_session_save_never_writes_over_a_file_it_cannot_decode() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("injectable-agents.json");
        let handle = StoreHandle::open(path.clone(), "desk");
        let errors = Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = errors.clone();
        handle.watch_errors(move |error| seen.lock().unwrap().push(error));
        handle
            .update_latest(|s| s.cloud_session = Some(session("access-1", "refresh-1")))
            .unwrap();
        // Another copy of Agent Relay writes a form this one cannot read.
        fs::write(&path, b"{ not a store").unwrap();
        let next = session("access-2", "refresh-2");
        let saved = handle.update_latest(|s| s.cloud_session = Some(next.clone()));
        assert!(matches!(saved, Err(StoreError::ChangedUnreadable { .. })));
        assert!(handle.reload().is_err());
        assert_eq!(fs::read(&path).unwrap(), b"{ not a store");
        // Memory keeps what disk last held, and the error is reported.
        assert_eq!(
            handle.read(|s| s.cloud_session.clone()),
            Some(session("access-1", "refresh-1"))
        );
        assert!(handle.error().is_some());
        assert!(matches!(errors.lock().unwrap().last(), Some(Some(_))));
    }

    #[test]
    fn a_session_save_after_a_failed_one_clears_the_reported_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("injectable-agents.json");
        let handle = StoreHandle::open(path.clone(), "desk");
        handle
            .update_latest(|s| s.cloud_session = Some(session("access-1", "refresh-1")))
            .unwrap();
        fs::write(&path, b"{ not a store").unwrap();
        assert!(handle.reload().is_err());
        assert!(handle.error().is_some());
        fs::remove_file(&path).unwrap();
        let next = session("access-2", "refresh-2");
        handle
            .update_latest(|s| s.cloud_session = Some(next.clone()))
            .unwrap();
        assert_eq!(handle.error(), None);
        let reopened = StoreHandle::open(path, "desk");
        assert_eq!(reopened.read(|s| s.cloud_session.clone()), Some(next));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn one_refresh_at_a_time_across_handles() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("injectable-agents.json");
        let first = StoreHandle::open(path.clone(), "desk");
        let second = Arc::new(StoreHandle::open(path, "desk"));
        let held = first.lock_session_refresh().await.unwrap();
        let acquired = Arc::new(AtomicBool::new(false));
        let waiter = {
            let (second, acquired) = (second.clone(), acquired.clone());
            tokio::spawn(async move {
                let lock = second.lock_session_refresh().await;
                acquired.store(true, Ordering::SeqCst);
                lock.is_some()
            })
        };
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(!acquired.load(Ordering::SeqCst));
        drop(held);
        assert!(waiter.await.unwrap());
    }
}
