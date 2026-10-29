//! Explicit fake credentials for an isolated selected-loop test. Unmatched
//! databases retain Host::system's Claude-disabled test default.
pub(crate) use super::claude_cloud::tests::{credentials, FakeKeychain};
use super::*;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

struct Context {
    keychain: claude_cloud::Keychain,
    clock: Arc<VirtualClock>,
}
type Hosts = HashMap<(PathBuf, PathBuf), Context>;

/// A monotonic virtual clock tied to the same exact synthetic home/database.
/// Network and member loops keep their wall timeouts; only the remote worker's
/// own started/finished/deadline clock is advanced by the fixture.
pub(crate) struct VirtualClock(Mutex<ClockState>);
struct ClockState {
    now: Instant,
    armed: Option<(u64, Instant)>,
    sequence: u64,
    last_read: Option<Instant>,
}
impl VirtualClock {
    fn new() -> Self {
        Self(Mutex::new(ClockState {
            now: Instant::now(),
            armed: None,
            sequence: 0,
            last_read: None,
        }))
    }
    pub(crate) fn now(&self) -> Instant {
        let mut state = self.0.lock().unwrap_or_else(|p| p.into_inner());
        state.last_read = Some(state.now);
        state.now
    }
    pub(crate) fn arm(&self, due: Instant) {
        let mut state = self.0.lock().unwrap_or_else(|p| p.into_inner());
        state.sequence = state.sequence.saturating_add(1);
        state.armed = Some((state.sequence, due));
    }
    pub(crate) fn disarm(&self) {
        self.0.lock().unwrap_or_else(|p| p.into_inner()).armed = None;
    }
    pub(crate) fn armed(&self) -> Option<(u64, Instant)> {
        self.0.lock().unwrap_or_else(|p| p.into_inner()).armed
    }
    pub(crate) fn last_read(&self) -> Option<Instant> {
        self.0.lock().unwrap_or_else(|p| p.into_inner()).last_read
    }
    pub(crate) fn advance(&self, expected_sequence: u64, to: Instant) -> bool {
        let mut state = self.0.lock().unwrap_or_else(|p| p.into_inner());
        let Some((sequence, due)) = state.armed else {
            return false;
        };
        if sequence != expected_sequence || to < state.now || to > due {
            return false;
        }
        state.now = to;
        true
    }
}
fn hosts() -> &'static Mutex<Hosts> {
    static HOSTS: OnceLock<Mutex<Hosts>> = OnceLock::new();
    HOSTS.get_or_init(Mutex::default)
}
fn paths(home: &Path, db: &Path) -> (PathBuf, PathBuf) {
    (
        home.canonicalize().unwrap_or_else(|_| home.into()),
        db.canonicalize().unwrap_or_else(|_| db.into()),
    )
}

pub(crate) struct Guard((PathBuf, PathBuf));
impl Guard {
    pub(crate) fn clock(&self) -> Option<Arc<VirtualClock>> {
        hosts()
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(&self.0)
            .map(|host| host.clock.clone())
    }
}
impl Drop for Guard {
    fn drop(&mut self) {
        hosts()
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&self.0);
    }
}

/// The caller joins its owned workers before dropping this scoped override.
#[cfg(test)]
pub(crate) fn install(
    home: &Path,
    db: &Path,
    fake: Arc<claude_cloud::tests::FakeKeychain>,
) -> Guard {
    assert_eq!(
        std::env::var_os("AGENT_RELAY_PROBE_TEST_HOME"),
        Some(home.as_os_str().to_owned())
    );
    assert!(db.starts_with(home));
    let base = std::env::var("RELAYHISTORY_CLAUDE_API_BASE_URL").unwrap();
    assert!(base.starts_with("http://127.0.0.1:"));
    if let Ok(base) = std::env::var("RELAYHISTORY_DEVIN_API_BASE_URL") {
        assert!(base.starts_with("http://127.0.0.1:"));
    }
    let key = paths(home, db);
    let previous = hosts().lock().unwrap_or_else(|p| p.into_inner()).insert(
        key.clone(),
        Context {
            keychain: claude_cloud::Keychain::new(fake),
            clock: Arc::new(VirtualClock::new()),
        },
    );
    assert!(previous.is_none());
    Guard(key)
}

pub(super) fn keychain(home: &Path, db: &Path) -> Option<claude_cloud::Keychain> {
    hosts()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(&paths(home, db))
        .map(|host| host.keychain.clone())
}

/// Unmatched test databases still use the production Instant clock.
pub(crate) fn clock_for_current_home(db: &Path) -> Option<Arc<VirtualClock>> {
    let home = crate::home().ok()?;
    hosts()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(&paths(&home, db))
        .map(|host| host.clock.clone())
}

#[test]
fn virtual_clock_only_advances_within_the_current_armed_deadline() {
    let clock = VirtualClock::new();
    let now = clock.now();
    assert!(!clock.advance(0, now));
    clock.arm(now + Duration::from_secs(1));
    let (sequence, due) = clock.armed().unwrap();
    assert!(!clock.advance(sequence, due + Duration::from_nanos(1)));
    assert!(clock.advance(sequence, due - Duration::from_nanos(1)));
    assert!(!clock.advance(sequence, now));
    assert!(clock.advance(sequence, due));
    clock.disarm();
    assert!(!clock.advance(sequence, due));
    clock.arm(clock.now() + Duration::from_secs(1));
    assert!(clock.armed().unwrap().1 > clock.now());
    assert!(!clock.advance(sequence, clock.armed().unwrap().1));
}
