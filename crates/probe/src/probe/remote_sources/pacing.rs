//! How fast remote sessions are downloaded, so catching up on someone's
//! cloud history never takes over their machine or their provider account.
//!
//! A person's claude.ai history can be hundreds of sessions and hundreds of
//! megabytes (256 sessions came to about 330 MB). The sweep therefore:
//!
//! - downloads at most [`PASS_SESSIONS`] sessions or [`PASS_TIME`] per pass,
//!   newest first, so the backlog fills in over many passes and a pass never
//!   holds up local uploads for minutes;
//! - stops calling a connector the provider throttled (HTTP 429) or that is
//!   failing (HTTP 5xx), for a wait that doubles up to an hour;
//! - waits before trying a failing session again, doubling up to a day, and
//!   parks a session that cannot be read (denied, too large, gone) until the
//!   provider lists it as changed;
//! - stops downloading while the disk has less than [`MIN_FREE_BYTES`] free
//!   or remote downloads have grown the database by [`GROWTH_CAP`].
//!
//! The state lives beside the database in `history.remote-pacing`, a small
//! JSON file; a missing or unreadable one starts afresh.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Sessions one sweep downloads at most.
pub const PASS_SESSIONS: usize = 20;
/// How long one sweep downloads at most; the session in flight finishes.
pub const PASS_TIME: Duration = Duration::from_secs(60);
/// Below this much free disk, nothing is downloaded.
pub const MIN_FREE_BYTES: u64 = 2 << 30;
/// How much remote downloads may grow the database before they stop.
pub const GROWTH_CAP: u64 = 2 << 30;
const FIRST_WAIT_MS: i64 = 5 * 60_000;
const SESSION_WAIT_MAX_MS: i64 = 24 * 3_600_000;
const CONNECTOR_WAIT_MAX_MS: i64 = 3_600_000;

/// The plain reasons a sweep held downloads back, as the remote diagnostic
/// records them.
pub const LOW_DISK: &str =
    "Cloud sessions are not downloaded while the disk has less than 2 GB free";
pub const GROWN: &str = "Cloud sessions downloaded so far reached the 2 GB limit";

/// How a connector call failed, as far as pacing is concerned.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failure {
    /// The provider throttled or failed (HTTP 429, 5xx): leave the
    /// connector alone for a while.
    Throttled,
    /// This session cannot be read as it is (denied, too large, gone).
    Permanent,
    /// Anything else: try this session again later.
    Transient,
}

/// Classify a connector failure from its full message, before provider
/// detail is erased to a code.
pub fn classify(message: &str) -> Failure {
    if message.contains("HTTP 429") || message.contains("HTTP 5") {
        return Failure::Throttled;
    }
    let permanent_codes = [
        "SESSION_NOT_FOUND",
        "EVIDENCE_PARTIAL",
        "INVALID_ARGUMENT",
        "PERMISSION_DENIED",
    ];
    if permanent_codes.iter().any(|code| message.starts_with(code))
        || message.contains("was denied")
        || message.contains("size limit")
    {
        return Failure::Permanent;
    }
    Failure::Transient
}

/// A connector failure whose message carries only its code, with what
/// pacing needs to know about it.
#[derive(Debug)]
pub struct ConnectorFailure {
    pub code: &'static str,
    pub connector: String,
    pub failure: Failure,
}

impl std::fmt::Display for ConnectorFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {} operation failed", self.code, self.connector)
    }
}

impl std::error::Error for ConnectorFailure {}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
struct SessionWait {
    failures: u32,
    retry_ms: i64,
    /// Parked: not tried again until the listing shows other activity.
    #[serde(default)]
    parked: bool,
    #[serde(default)]
    activity_ms: Option<i64>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
struct ConnectorWait {
    strikes: u32,
    until_ms: i64,
}

/// The pacing state one sweep reads and writes.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pacing {
    #[serde(default)]
    sessions: BTreeMap<String, SessionWait>,
    #[serde(default)]
    connectors: BTreeMap<String, ConnectorWait>,
    /// How much remote downloads have grown the database, in bytes.
    #[serde(default)]
    pub grown_bytes: u64,
    /// Sessions still to download after the last pass.
    #[serde(default)]
    pub waiting: usize,
    /// Why the last pass held downloads back, if it did.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub held_back: Option<String>,
}

fn path(db: &Path) -> PathBuf {
    db.with_extension("remote-pacing")
}

fn doubled(first: i64, failures: u32, max: i64) -> i64 {
    first
        .saturating_mul(1i64 << failures.saturating_sub(1).min(20))
        .min(max)
}

fn session_key(source: &str, session_id: &str) -> String {
    format!("{source}:{session_id}")
}

impl Pacing {
    pub fn load(db: &Path) -> Pacing {
        std::fs::read(path(db))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, db: &Path) -> std::io::Result<()> {
        let target = path(db);
        let partial = target.with_extension("remote-pacing.partial");
        std::fs::write(&partial, serde_json::to_vec(self)?)?;
        std::fs::rename(partial, target)
    }

    /// What the remote diagnostic shows of this state.
    pub fn json(&self) -> serde_json::Value {
        serde_json::json!({
            "waiting": self.waiting,
            "grown_bytes": self.grown_bytes,
            "held_back": self.held_back,
            "connectors_waiting": self.connectors.iter()
                .filter(|(_, wait)| wait.until_ms > 0)
                .map(|(connector, _)| connector.clone())
                .collect::<Vec<_>>(),
            "sessions_waiting": self.sessions.values().filter(|w| !w.parked).count(),
            "sessions_parked": self.sessions.values().filter(|w| w.parked).count(),
        })
    }

    /// Whether `connector` may be called at `now_ms`.
    pub fn connector_open(&self, connector: &str, now_ms: i64) -> bool {
        self.connectors
            .get(connector)
            .is_none_or(|wait| wait.until_ms <= now_ms)
    }

    /// Whether a session may be tried at `now_ms`. A parked one waits for
    /// the listing to show other activity than when it was parked.
    pub fn session_open(
        &self,
        source: &str,
        session_id: &str,
        activity_ms: Option<i64>,
        now_ms: i64,
    ) -> bool {
        match self.sessions.get(&session_key(source, session_id)) {
            None => true,
            Some(wait) if wait.parked => wait.activity_ms != activity_ms,
            Some(wait) => wait.retry_ms <= now_ms,
        }
    }

    pub fn succeeded(&mut self, connector: &str, source: &str, session_id: &str) {
        self.sessions.remove(&session_key(source, session_id));
        self.connectors.remove(connector);
    }

    pub fn failed(
        &mut self,
        connector: &str,
        source: &str,
        session_id: &str,
        activity_ms: Option<i64>,
        failure: Failure,
        now_ms: i64,
    ) {
        match failure {
            Failure::Throttled => {
                let wait = self.connectors.entry(connector.to_string()).or_default();
                wait.strikes = wait.strikes.saturating_add(1);
                wait.until_ms =
                    now_ms + doubled(FIRST_WAIT_MS, wait.strikes, CONNECTOR_WAIT_MAX_MS);
            }
            Failure::Permanent => {
                self.sessions.insert(
                    session_key(source, session_id),
                    SessionWait {
                        failures: 1,
                        retry_ms: 0,
                        parked: true,
                        activity_ms,
                    },
                );
            }
            Failure::Transient => {
                let wait = self
                    .sessions
                    .entry(session_key(source, session_id))
                    .or_default();
                wait.parked = false;
                wait.failures = wait.failures.saturating_add(1);
                wait.retry_ms = now_ms + doubled(FIRST_WAIT_MS, wait.failures, SESSION_WAIT_MAX_MS);
            }
        }
    }
}

/// Free bytes on the volume holding `db`; `None` when it cannot be read.
pub fn free_bytes(db: &Path) -> Option<u64> {
    // Tests never depend on the disk they happen to run on; the guard
    // itself is tested with explicit values.
    if cfg!(test) {
        return None;
    }
    volume_free_bytes(db.parent()?)
}

#[cfg(unix)]
fn volume_free_bytes(directory: &Path) -> Option<u64> {
    let stats = nix::sys::statvfs::statvfs(directory).ok()?;
    Some((stats.blocks_available() as u64).saturating_mul(stats.fragment_size() as u64))
}

/// The bytes this user may still write on the volume (quotas included).
#[cfg(windows)]
fn volume_free_bytes(directory: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    let wide: Vec<u16> = directory
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut available = 0u64;
    // SAFETY: a NUL-terminated path and one valid out pointer; the totals
    // are optional and null.
    let read = unsafe {
        windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut available,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    (read != 0).then_some(available)
}

/// The database's size on disk with its write-ahead log.
pub fn stored_bytes(db: &Path) -> u64 {
    let size = |path: PathBuf| std::fs::metadata(path).map_or(0, |meta| meta.len());
    let mut wal = db.as_os_str().to_owned();
    wal.push("-wal");
    size(db.to_path_buf()) + size(PathBuf::from(wal))
}

/// Why downloads must wait now, if they must.
pub fn hold_back(pacing: &Pacing, free: Option<u64>) -> Option<&'static str> {
    if free.is_some_and(|free| free < MIN_FREE_BYTES) {
        return Some(LOW_DISK);
    }
    if pacing.grown_bytes >= GROWTH_CAP {
        return Some(GROWN);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000_000;

    #[test]
    fn failures_are_classified_for_pacing() {
        assert_eq!(
            classify("CONNECTOR_FAILURE: Claude teleport evidence failed (HTTP 429)"),
            Failure::Throttled
        );
        assert_eq!(
            classify("claude.ai session list failed (HTTP 503): busy"),
            Failure::Throttled
        );
        assert_eq!(
            classify("SESSION_NOT_FOUND: remote Claude session no longer exists"),
            Failure::Permanent
        );
        assert_eq!(
            classify("CONNECTOR_FAILURE: Claude teleport evidence was denied; the session may require trusted-device enrollment"),
            Failure::Permanent
        );
        assert_eq!(
            classify("Claude response exceeded the 16 MiB response-size limit"),
            Failure::Permanent
        );
        assert_eq!(
            classify("CONNECTOR_FAILURE: Claude record identity does not match requested session"),
            Failure::Transient
        );
    }

    #[test]
    fn a_failing_session_waits_longer_each_time_up_to_a_day() {
        let mut pacing = Pacing::default();
        let fail = |pacing: &mut Pacing, now| {
            pacing.failed(
                "claude-web",
                "claude",
                "cse_1",
                Some(1),
                Failure::Transient,
                now,
            )
        };
        fail(&mut pacing, NOW);
        assert!(!pacing.session_open("claude", "cse_1", Some(1), NOW + FIRST_WAIT_MS - 1));
        assert!(pacing.session_open("claude", "cse_1", Some(1), NOW + FIRST_WAIT_MS));
        fail(&mut pacing, NOW);
        assert!(!pacing.session_open("claude", "cse_1", Some(1), NOW + 2 * FIRST_WAIT_MS - 1));
        for _ in 0..30 {
            fail(&mut pacing, NOW);
        }
        assert!(pacing.session_open("claude", "cse_1", Some(1), NOW + SESSION_WAIT_MAX_MS));
        // Other sessions are untouched, and a success clears the wait.
        assert!(pacing.session_open("claude", "cse_2", None, NOW));
        pacing.succeeded("claude-web", "claude", "cse_1");
        assert!(pacing.session_open("claude", "cse_1", Some(1), NOW));
    }

    #[test]
    fn a_parked_session_waits_for_new_activity() {
        let mut pacing = Pacing::default();
        pacing.failed(
            "claude-web",
            "claude",
            "cse_1",
            Some(1),
            Failure::Permanent,
            NOW,
        );
        assert!(!pacing.session_open("claude", "cse_1", Some(1), NOW + 365 * SESSION_WAIT_MAX_MS));
        assert!(pacing.session_open("claude", "cse_1", Some(2), NOW));
    }

    #[test]
    fn a_throttled_connector_waits_up_to_an_hour() {
        let mut pacing = Pacing::default();
        pacing.failed(
            "claude-web",
            "claude",
            "cse_1",
            None,
            Failure::Throttled,
            NOW,
        );
        assert!(!pacing.connector_open("claude-web", NOW + FIRST_WAIT_MS - 1));
        assert!(pacing.connector_open("claude-web", NOW + FIRST_WAIT_MS));
        assert!(pacing.connector_open("devin-cloud", NOW));
        // The session itself is not blamed for the provider's throttling.
        assert!(pacing.session_open("claude", "cse_1", None, NOW));
        for _ in 0..30 {
            pacing.failed(
                "claude-web",
                "claude",
                "cse_1",
                None,
                Failure::Throttled,
                NOW,
            );
        }
        assert!(pacing.connector_open("claude-web", NOW + CONNECTOR_WAIT_MAX_MS));
    }

    #[test]
    fn downloads_hold_back_on_low_disk_or_growth() {
        let mut pacing = Pacing::default();
        assert_eq!(hold_back(&pacing, Some(MIN_FREE_BYTES)), None);
        assert_eq!(hold_back(&pacing, Some(MIN_FREE_BYTES - 1)), Some(LOW_DISK));
        assert_eq!(hold_back(&pacing, None), None);
        pacing.grown_bytes = GROWTH_CAP;
        assert_eq!(hold_back(&pacing, Some(u64::MAX)), Some(GROWN));
    }

    #[test]
    fn the_state_survives_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("history.db");
        assert_eq!(Pacing::load(&db), Pacing::default());
        let mut pacing = Pacing::default();
        pacing.failed(
            "claude-web",
            "claude",
            "cse_1",
            None,
            Failure::Transient,
            NOW,
        );
        pacing.grown_bytes = 7;
        pacing.save(&db).unwrap();
        assert_eq!(Pacing::load(&db), pacing);
        std::fs::write(path(&db), b"not json").unwrap();
        assert_eq!(Pacing::load(&db), Pacing::default());
    }
}
