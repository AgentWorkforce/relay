//! Installation receipts are local to one core and read without touching disk.
use super::*;
use crate::relay::store::Target;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

const MAX_ROOTS: usize = 128;
const MAX_TARGETS: usize = 4096;
const RETRY: Duration = Duration::from_secs(30);

#[derive(Default)]
pub(crate) struct Installations {
    state: Mutex<State>,
    refresh: Mutex<()>,
    /// When each session's plugin last polled the core: the only evidence
    /// that a running session has loaded the plugin, as against the files
    /// merely being installed.
    polls: Mutex<BTreeMap<Target, Instant>>,
}

/// How recently a session's plugin must have polled to count as loaded. It
/// polls every two seconds; this leaves room for a slow tick.
pub(crate) const PLUGIN_SEEN: Duration = Duration::from_secs(30);
#[derive(Clone, Default)]
struct State {
    socket: PathBuf,
    roots: BTreeMap<PathBuf, Attempt>,
    targets: BTreeSet<Target>,
    known: BTreeMap<Target, PathBuf>,
    revoked: BTreeSet<Target>,
    initialized: bool,
    uncertain: Option<String>,
    consent_file_seen: bool,
    /// Whether this core has ended the native generation an earlier core
    /// may have left, which happens once, on its first pass, claimed or not.
    stale_ended: bool,
}
#[derive(Clone)]
struct Attempt {
    at: Instant,
    error: Option<String>,
}
pub(super) struct Refresh {
    pub changed: BTreeSet<Target>,
    pub errors: Vec<String>,
    pub attempted: bool,
    pub initial: bool,
    pub revoked: BTreeSet<Target>,
}
impl Installations {
    /// Refreshes serialize separately; admission never waits for disk/fsync.
    pub(super) fn lock_refresh(&self) -> MutexGuard<'_, ()> {
        self.refresh.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// True once per core: the first pass ends an earlier core's native
    /// generation before anything else, whether or not this computer's
    /// ownership is verified yet.
    pub(super) fn end_stale_generation_once(&self) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        !std::mem::replace(&mut state.stale_ended, true)
    }

    /// The plugin in the session for `target` polled just now.
    pub(crate) fn note_poll(&self, target: &Target) {
        let mut polls = self.polls.lock().unwrap_or_else(|e| e.into_inner());
        polls.insert(target.clone(), Instant::now());
        if polls.len() > MAX_TARGETS {
            let stale: Vec<_> = polls
                .iter()
                .filter(|(_, at)| at.elapsed() > PLUGIN_SEEN)
                .map(|(target, _)| target.clone())
                .collect();
            for target in stale {
                polls.remove(&target);
            }
        }
    }

    /// Whether the session for `target` has a loaded plugin: it polled
    /// within `PLUGIN_SEEN`.
    pub(crate) fn plugin_seen(&self, target: &Target) -> bool {
        self.polls
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(target)
            .is_some_and(|at| at.elapsed() <= PLUGIN_SEEN)
    }

    pub(super) fn initialized(&self) -> bool {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .initialized
    }

    pub(super) fn roots(&self) -> Vec<PathBuf> {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .roots
            .keys()
            .cloned()
            .collect()
    }

    pub(super) fn consent_file(&self, present: bool) -> Result<(), String> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if !present && state.consent_file_seen {
            return Err("Claude login sharing settings disappeared; restore them before continuing mobile setup.".into());
        }
        state.consent_file_seen |= present;
        Ok(())
    }

    pub(crate) fn contains(&self, target: &Target) -> bool {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.uncertain.is_none()
            && state.targets.contains(target)
            && !state.revoked.contains(target)
    }

    /// Existing receipts survive a changing proof snapshot in one atomic read;
    /// callers still verify current owner authority independently.
    pub(crate) fn retains_receipt(&self, target: &Target) -> bool {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.initialized
            && !state.revoked.contains(target)
            && state.known.get(target).is_some_and(|root| {
                state
                    .roots
                    .get(root)
                    .is_some_and(|attempt| attempt.error.is_none())
            })
    }

    pub(super) fn acknowledge_revoked(&self, revoked: &BTreeSet<Target>) {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .revoked
            .retain(|target| !revoked.contains(target));
    }

    pub(super) fn uncertain(&self, error: String) -> Refresh {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let attempted = state.uncertain.as_ref() != Some(&error);
        state.uncertain = Some(error.clone());
        Refresh {
            changed: state.targets.clone(),
            errors: vec![error],
            attempted,
            initial: !state.initialized,
            revoked: state.revoked.clone(),
        }
    }

    /// Caller holds lock_refresh. Copy/commit locks stay short even if a root
    /// is slow or unavailable. Readers see the last completed snapshot.
    pub(super) fn refresh(
        &self,
        roots: Vec<PathBuf>,
        targets: BTreeMap<Target, PathBuf>,
        socket: &Path,
        force: bool,
        now: Instant,
    ) -> Refresh {
        self.refresh_with(roots, targets, socket, force, now, install)
    }

    fn refresh_with(
        &self,
        roots: Vec<PathBuf>,
        mut targets: BTreeMap<Target, PathBuf>,
        socket: &Path,
        force: bool,
        now: Instant,
        install: impl Fn(&Path, &Path) -> Result<(), String>,
    ) -> Refresh {
        let mut next = self.state.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let before = next.targets.clone();
        let initial = !next.initialized;
        let was_uncertain = next.uncertain.take().is_some();
        next.initialized = true;
        let socket_changed = next.socket != socket;
        if socket_changed {
            next.roots.clear();
            next.socket = socket.into();
        }
        let roots: BTreeSet<_> = roots.into_iter().collect();
        next.roots.retain(|root, _| roots.contains(root));
        // Until durable revocations are acknowledged, do not accumulate new
        // provenance behind a failing journal. Existing scopes remain bounded.
        if !next.revoked.is_empty() {
            targets.retain(|target, _| next.known.contains_key(target));
        }
        let mut errors = Vec::new();
        let mut attempted = false;
        if roots.len() > MAX_ROOTS || targets.len() > MAX_TARGETS {
            errors
                .push("Too many Claude login folders or sessions for mobile continuation.".into());
            next.revoked.extend(next.known.keys().cloned());
            next.known.clear();
            next.targets.clear();
        } else {
            // Fence definitive sharing/root changes before a slow new login's
            // install. Unaffected admitted sessions keep their cached access.
            revoke_changed(&mut next, &roots, &targets, socket_changed);
            evict_missing(&mut next, &targets);
            {
                let mut live = self.state.lock().unwrap_or_else(|e| e.into_inner());
                live.revoked.extend(next.revoked.iter().cloned());
                live.targets.retain(|target| {
                    targets.contains_key(target) && !next.revoked.contains(target)
                });
            }
            attempted = install_roots(&mut next, &roots, socket, force, now, &install, &mut errors);
            revoke_changed(&mut next, &roots, &targets, socket_changed);
            evict_missing(&mut next, &targets);
            next.targets = targets
                .iter()
                .filter_map(|(target, root)| {
                    next.roots
                        .get(root)
                        .filter(|attempt| attempt.error.is_none())
                        .map(|_| target.clone())
                })
                .collect();
            for (target, root) in targets {
                if next.targets.contains(&target) {
                    next.known.insert(target, root);
                }
            }
        }
        let mut changed: BTreeSet<_> = before
            .symmetric_difference(&next.targets)
            .cloned()
            .collect();
        changed.extend(next.revoked.iter().cloned());
        if was_uncertain {
            changed.extend(next.targets.iter().cloned());
        }
        let refresh = Refresh {
            changed,
            errors,
            attempted,
            initial,
            revoked: next.revoked.clone(),
        };
        *self.state.lock().unwrap_or_else(|e| e.into_inner()) = next;
        refresh
    }
}

fn install_roots(
    state: &mut State,
    roots: &BTreeSet<PathBuf>,
    socket: &Path,
    force: bool,
    now: Instant,
    install: &impl Fn(&Path, &Path) -> Result<(), String>,
    errors: &mut Vec<String>,
) -> bool {
    let mut attempted = false;
    for root in roots {
        let due = force
            || state.roots.get(root).is_none_or(|attempt| {
                attempt.error.is_some() && now.saturating_duration_since(attempt.at) >= RETRY
            });
        if due {
            attempted = true;
            state.roots.insert(
                root.clone(),
                Attempt {
                    at: now,
                    error: install(root, socket).err(),
                },
            );
        }
        if let Some(error) = state
            .roots
            .get(root)
            .and_then(|attempt| attempt.error.clone())
        {
            errors.push(error);
        }
    }
    attempted
}

fn revoke_changed(
    state: &mut State,
    roots: &BTreeSet<PathBuf>,
    targets: &BTreeMap<Target, PathBuf>,
    socket_changed: bool,
) {
    let revoked = state
        .known
        .iter()
        .filter_map(|(target, old_root)| {
            let invalid = socket_changed
                || !roots.contains(old_root)
                || state
                    .roots
                    .get(old_root)
                    .is_none_or(|attempt| attempt.error.is_some())
                || targets.get(target).is_some_and(|root| root != old_root);
            invalid.then(|| target.clone())
        })
        .collect::<BTreeSet<_>>();
    state.revoked.extend(revoked.iter().cloned());
    state.known.retain(|target, _| !revoked.contains(target));
}

fn evict_missing(state: &mut State, targets: &BTreeMap<Target, PathBuf>) {
    let new = targets
        .keys()
        .filter(|target| !state.known.contains_key(*target))
        .count();
    let excess = (state.known.len() + new).saturating_sub(MAX_TARGETS);
    let evicted: Vec<_> = state
        .known
        .keys()
        .filter(|target| !targets.contains_key(*target))
        .take(excess)
        .cloned()
        .collect();
    for target in evicted {
        state.known.remove(&target);
        state.revoked.insert(target);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay::store::SessionKind;

    #[test]
    fn mobile_installation_suspension_requires_prior_proof_without_revocation() {
        let cache = Installations::default();
        let target = Target::new(SessionKind::ClaudeTerminal, "session");
        let unknown = Target::new(SessionKind::ClaudeTerminal, "unknown");
        let root = PathBuf::from("/root");
        let snapshot = [(target.clone(), root.clone())].into();
        assert!(!cache.retains_receipt(&target));
        cache.refresh_with(
            vec![root.clone()],
            snapshot,
            Path::new("/socket"),
            false,
            Instant::now(),
            |_, _| Ok(()),
        );
        assert!(cache.contains(&target));
        assert!(cache.retains_receipt(&target));
        cache.refresh_with(
            vec![root.clone()],
            BTreeMap::new(),
            Path::new("/socket"),
            false,
            Instant::now(),
            |_, _| Ok(()),
        );
        assert!(!cache.contains(&target));
        assert!(cache.retains_receipt(&target));
        assert!(!cache.retains_receipt(&unknown));
        cache.uncertain("unreadable sharing settings".into());
        assert!(cache.retains_receipt(&target));
        let revoked = cache.refresh_with(
            Vec::new(),
            BTreeMap::new(),
            Path::new("/socket"),
            false,
            Instant::now(),
            |_, _| Ok(()),
        );
        assert!(revoked.revoked.contains(&target));
        assert!(!cache.retains_receipt(&target));
        cache.acknowledge_revoked(&revoked.revoked);
        assert!(!cache.retains_receipt(&target));
    }

    #[test]
    fn mobile_installation_failure_and_socket_change_are_not_temporary_suspension() {
        for failed_install in [false, true] {
            let cache = Installations::default();
            let target = Target::new(SessionKind::ClaudeTerminal, "session");
            let root = PathBuf::from("/root");
            cache.refresh_with(
                vec![root.clone()],
                [(target.clone(), root.clone())].into(),
                Path::new("/socket"),
                false,
                Instant::now(),
                |_, _| Ok(()),
            );
            let socket = if failed_install {
                "/socket"
            } else {
                "/changed-socket"
            };
            let refresh = cache.refresh_with(
                vec![root],
                BTreeMap::new(),
                Path::new(socket),
                true,
                Instant::now(),
                |_, _| {
                    if failed_install {
                        Err("install failed".into())
                    } else {
                        Ok(())
                    }
                },
            );
            assert!(refresh.revoked.contains(&target));
            assert!(!cache.retains_receipt(&target));
        }
    }

    #[test]
    fn mobile_installation_reads_do_not_wait_for_slow_filesystem_work() {
        let cache = Installations::default();
        let target = Target::new(SessionKind::ClaudeTerminal, "session");
        let root = PathBuf::from("/a-root");
        let targets = [(target.clone(), root.clone())].into();
        cache.refresh_with(
            vec![root.clone()],
            targets,
            Path::new("/socket"),
            false,
            Instant::now(),
            |_, _| Ok(()),
        );
        let (started, began) = std::sync::mpsc::channel();
        let (release, released) = std::sync::mpsc::channel();
        let (read, received) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            let writer = &cache;
            let writer_target = target.clone();
            scope.spawn(move || {
                let _refresh = writer.lock_refresh();
                writer.refresh_with(
                    vec![root.clone()],
                    [(writer_target, root)].into(),
                    Path::new("/socket"),
                    true,
                    Instant::now(),
                    |_, _| {
                        started.send(()).unwrap();
                        released.recv().unwrap();
                        Ok(())
                    },
                );
            });
            began.recv_timeout(Duration::from_secs(2)).unwrap();
            scope.spawn(|| read.send(cache.contains(&target)).unwrap());
            let result = received.recv_timeout(Duration::from_secs(2));
            release.send(()).unwrap();
            assert_eq!(
                result.unwrap(),
                true,
                "admission reads cannot wait for plugin fsync"
            );
        });
    }

    #[test]
    fn mobile_installation_capacity_evicts_missing_scopes_without_lifetime_exhaustion() {
        let cache = Installations::default();
        let root = PathBuf::from("/root");
        let old: BTreeMap<_, _> = (0..MAX_TARGETS)
            .map(|id| {
                (
                    Target::new(SessionKind::ClaudeTerminal, format!("old-{id}")),
                    root.clone(),
                )
            })
            .collect();
        cache.refresh_with(
            vec![root.clone()],
            old,
            Path::new("/socket"),
            false,
            Instant::now(),
            |_, _| Ok(()),
        );
        let fresh = Target::new(SessionKind::ClaudeTerminal, "fresh");
        let targets = [(fresh.clone(), root.clone())].into();
        let refresh = cache.refresh_with(
            vec![root.clone()],
            targets,
            Path::new("/socket"),
            false,
            Instant::now(),
            |_, _| Ok(()),
        );
        assert!(refresh.errors.is_empty());
        assert_eq!(refresh.revoked.len(), 1);
        cache.acknowledge_revoked(&refresh.revoked);
        assert!(cache.contains(&fresh));
        let again = cache.refresh_with(
            vec![root.clone()],
            [(fresh.clone(), root)].into(),
            Path::new("/socket"),
            false,
            Instant::now(),
            |_, _| Ok(()),
        );
        assert!(again.revoked.is_empty() && cache.contains(&fresh));
    }
    #[test]
    fn mobile_installation_fences_revoked_scope_before_another_roots_slow_install() {
        let cache = Installations::default();
        let removed = Target::new(SessionKind::ClaudeTerminal, "removed");
        let retained = Target::new(SessionKind::ClaudeTerminal, "retained");
        let old_root = PathBuf::from("/old");
        let good_root = PathBuf::from("/good");
        let new_root = PathBuf::from("/new");
        cache.refresh_with(
            vec![old_root.clone(), good_root.clone()],
            [
                (removed.clone(), old_root),
                (retained.clone(), good_root.clone()),
            ]
            .into(),
            Path::new("/socket"),
            false,
            Instant::now(),
            |_, _| Ok(()),
        );
        let (started, began) = std::sync::mpsc::channel();
        let (release, released) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            let writer = &cache;
            let target = retained.clone();
            scope.spawn(move || {
                let _refresh = writer.lock_refresh();
                writer.refresh_with(
                    vec![good_root.clone(), new_root.clone()],
                    [(target, good_root)].into(),
                    Path::new("/socket"),
                    false,
                    Instant::now(),
                    |root, _| {
                        if root == new_root {
                            started.send(()).unwrap();
                            released.recv().unwrap();
                        }
                        Ok(())
                    },
                );
            });
            began.recv_timeout(Duration::from_secs(2)).unwrap();
            let blocked = !cache.contains(&removed);
            let available = cache.contains(&retained);
            release.send(()).unwrap();
            assert!(
                blocked,
                "a validated unshare is fenced before any installation fsync"
            );
            assert!(
                available,
                "unaffected sessions must not be blocked by unrelated installation"
            );
        });
    }
}
