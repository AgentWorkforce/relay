//! `CodexSharingPolicy`: the local authorization gate between messages
//! arriving from the cloud and threads (or Claude sessions) on this computer.
//!
//! Nothing is deliverable by default. A thread accepts incoming messages
//! only once the local user shares it, and only within the bounds they
//! chose: `hold` asks before every message, and a thread whose sandbox is
//! off also needs `allows_unrestricted` before `auto` delivers without
//! asking. A buggy or compromised cloud cannot reach a thread this policy
//! has not opened, and revoking a share takes effect immediately.
//!
//! The policy persists to `shares.json` (the Swift app's `[CodexThreadShare]`
//! encoding: camelCase keys, `sharedAt` in seconds since 2001-01-01). Every
//! change first commits a fail-closed recovery intent — the SHA-256 of the
//! snapshot about to be written — both to `RecoveryIntents`, kept outside the
//! policy directory, and to `shares.json.pending`. On open, a surviving
//! intent is honored only when `shares.json` is exactly that snapshot;
//! anything else resets every share and reports
//! `recovered_interrupted_change`. A corrupt or unreadable policy fails
//! `open`; callers keep incoming delivery disabled.

use super::{create_private_dir, make_private_file, write_atomic, OutboxError, Result};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

/// How a shared thread treats incoming messages.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// Ask the local user first.
    Hold,
    /// Deliver without asking.
    Auto,
}

impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Hold => "hold",
            Mode::Auto => "auto",
        }
    }
}

/// One shared thread.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexThreadShare {
    #[serde(rename = "threadID")]
    pub thread_id: String,
    pub mode: Mode,
    /// Second, explicit opt-in needed for a thread whose sandbox is off.
    pub allows_unrestricted: bool,
    #[serde(with = "reference_date")]
    pub shared_at: SystemTime,
}

/// What the policy decides for a message headed for a thread.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CodexSharingDecision {
    /// Not shared (or shared and then revoked): nothing is delivered.
    Deny,
    /// Shared, but the local user approves each message first.
    Hold,
    /// Shared, and cleared to go straight in.
    Deliver,
}

/// Where a pending policy change's intent is kept, independent of the
/// policy directory so even a permissions failure there cannot revive old
/// grants after a relaunch. `set` must be durable when it returns.
pub trait RecoveryIntents: Send + Sync {
    fn get(&self, key: &str) -> io::Result<Option<String>>;
    fn set(&self, key: &str, value: &str) -> io::Result<()>;
    fn remove(&self, key: &str) -> io::Result<()>;
}

/// Intents as private files in one directory, one per key.
pub struct FileRecoveryIntents {
    directory: PathBuf,
}

impl FileRecoveryIntents {
    pub fn new(directory: impl Into<PathBuf>) -> Self {
        FileRecoveryIntents {
            directory: directory.into(),
        }
    }

    fn path(&self, key: &str) -> PathBuf {
        self.directory.join(digest(key.as_bytes()))
    }
}

impl RecoveryIntents for FileRecoveryIntents {
    fn get(&self, key: &str) -> io::Result<Option<String>> {
        match fs::read_to_string(self.path(key)) {
            Ok(value) => Ok(Some(value)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }

    fn set(&self, key: &str, value: &str) -> io::Result<()> {
        create_private_dir(&self.directory)?;
        write_atomic(&self.path(key), value.as_bytes())
    }

    fn remove(&self, key: &str) -> io::Result<()> {
        match fs::remove_file(self.path(key)) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
            _ => Ok(()),
        }
    }
}

struct Store {
    path: PathBuf,
    intents: Arc<dyn RecoveryIntents>,
}

impl Store {
    fn key(&self) -> String {
        format!("incoming-policy-incomplete:{}", self.path.display())
    }

    fn pending_path(&self) -> PathBuf {
        let mut name = self.path.as_os_str().to_owned();
        name.push(".pending");
        PathBuf::from(name)
    }

    /// Commits `shares` behind a fail-closed intent, kept in two
    /// independent places; a failure at any step leaves whichever intent
    /// was written for the next open to resolve.
    fn persist(&self, shares: &HashMap<String, CodexThreadShare>) -> Result<()> {
        let snapshot = serde_json::to_vec(&shares.values().collect::<Vec<_>>())?;
        let digest = digest(&snapshot);
        let intent = self.intents.set(&self.key(), &digest);
        let marker = self.write_marker(&digest);
        // The change is abandoned unless both intents are durable. Either one
        // alone resets every share on the next open, never restoring one
        // this change revoked.
        intent?;
        marker?;
        write_atomic(&self.path, &snapshot)?;
        make_private_file(&self.path)?;
        // The snapshot is committed. A cleanup failure cannot turn that into
        // a failed change: a surviving intent verifies this digest on open.
        self.cleanup();
        Ok(())
    }

    fn write_marker(&self, digest: &str) -> Result<()> {
        if let Some(parent) = self
            .path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            create_private_dir(parent)?;
        }
        Ok(write_atomic(&self.pending_path(), digest.as_bytes())?)
    }

    fn cleanup(&self) {
        let _ = fs::remove_file(self.pending_path());
        let _ = self.intents.remove(&self.key());
    }
}

/// The sharing policy; safe to use from any thread.
pub struct CodexSharingPolicy {
    shares: Mutex<HashMap<String, CodexThreadShare>>,
    store: Option<Store>,
    recovered_interrupted_change: bool,
}

impl Default for CodexSharingPolicy {
    fn default() -> Self {
        Self::in_memory()
    }
}

impl CodexSharingPolicy {
    /// A policy that is never saved.
    pub fn in_memory() -> Self {
        CodexSharingPolicy {
            shares: Mutex::new(HashMap::new()),
            store: None,
            recovered_interrupted_change: false,
        }
    }

    /// Opens the policy saved at `shares_json`, with recovery intents in
    /// `<shares_json's grandparent>/policy-recovery/` — for the layout
    /// `<app data>/incoming/<scope>/shares.json`, beside the scope
    /// directories rather than inside one.
    pub fn open(shares_json: impl AsRef<Path>) -> Result<Self> {
        let path = shares_json.as_ref();
        let scope_dir = path.parent().unwrap_or_else(|| Path::new("."));
        let intents_dir = scope_dir
            .parent()
            .unwrap_or(scope_dir)
            .join("policy-recovery");
        Self::open_with(path, Arc::new(FileRecoveryIntents::new(intents_dir)))
    }

    /// Opens the policy saved at `shares_json`, keeping recovery intents in
    /// `intents`.
    pub fn open_with(
        shares_json: impl AsRef<Path>,
        intents: Arc<dyn RecoveryIntents>,
    ) -> Result<Self> {
        let store = Store {
            path: shares_json.as_ref().to_path_buf(),
            intents,
        };
        let preference_intent = store.intents.get(&store.key())?;
        let pending = store.pending_path();
        let file_intent = if pending.exists() {
            Some(fs::read(&pending)?)
        } else {
            None
        };
        if preference_intent.is_some() || file_intent.is_some() {
            // A leftover intent is not necessarily a failed commit. Only the
            // exact intended snapshot may survive; anything else fails
            // closed to no grants.
            let expected = preference_intent
                .or_else(|| file_intent.and_then(|bytes| String::from_utf8(bytes).ok()));
            let snapshot = fs::read(&store.path).ok();
            match (expected, snapshot) {
                (Some(expected), Some(snapshot)) if digest(&snapshot) == expected => {
                    store.cleanup()
                }
                _ => {
                    store.persist(&HashMap::new())?;
                    return Ok(CodexSharingPolicy {
                        shares: Mutex::new(HashMap::new()),
                        store: Some(store),
                        recovered_interrupted_change: true,
                    });
                }
            }
        }
        let mut shares = HashMap::new();
        if store.path.exists() {
            let bytes = fs::read(&store.path)?;
            for share in serde_json::from_slice::<Vec<CodexThreadShare>>(&bytes)? {
                if shares.contains_key(&share.thread_id) {
                    return Err(OutboxError::Corrupt(format!(
                        "{} shares {} twice",
                        store.path.display(),
                        share.thread_id
                    )));
                }
                shares.insert(share.thread_id.clone(), share);
            }
        }
        Ok(CodexSharingPolicy {
            shares: Mutex::new(shares),
            store: Some(store),
            recovered_interrupted_change: false,
        })
    }

    /// Whether opening found an interrupted change and reset every share.
    pub fn recovered_interrupted_change(&self) -> bool {
        self.recovered_interrupted_change
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, CodexThreadShare>> {
        self.shares
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn persist(&self, shares: &HashMap<String, CodexThreadShare>) -> Result<()> {
        match &self.store {
            Some(store) => store.persist(shares),
            None => Ok(()),
        }
    }

    /// Shares `thread_id`, replacing any earlier share for it — the only way
    /// a thread becomes reachable. A failed save blocks every thread in this
    /// process.
    pub fn share(
        &self,
        thread_id: &str,
        mode: Mode,
        allows_unrestricted: bool,
    ) -> Result<CodexThreadShare> {
        let share = CodexThreadShare {
            thread_id: thread_id.to_string(),
            mode,
            allows_unrestricted,
            shared_at: SystemTime::now(),
        };
        let mut shares = self.lock();
        let mut updated = shares.clone();
        updated.insert(thread_id.to_string(), share.clone());
        if let Err(error) = self.persist(&updated) {
            shares.clear();
            return Err(error);
        }
        *shares = updated;
        Ok(share)
    }

    /// Revokes a thread's share, effective immediately. If the revocation
    /// cannot be saved, every thread is blocked in this process.
    pub fn unshare(&self, thread_id: &str) -> Result<()> {
        let mut shares = self.lock();
        shares.remove(thread_id);
        if let Err(error) = self.persist(&shares) {
            shares.clear();
            return Err(error);
        }
        Ok(())
    }

    /// The current share for `thread_id`, if it is shared.
    pub fn share_for(&self, thread_id: &str) -> Option<CodexThreadShare> {
        self.lock().get(thread_id).cloned()
    }

    /// Every thread currently shared, in no particular order.
    pub fn shared_thread_ids(&self) -> Vec<String> {
        self.lock().keys().cloned().collect()
    }

    /// What to do with a message headed for `thread_id`. Pass `true` for
    /// `is_unrestricted` when the thread's sandbox is off or unknown: it is
    /// the more restrictive input, and the policy fails closed on doubt.
    pub fn decide(&self, thread_id: &str, is_unrestricted: bool) -> CodexSharingDecision {
        match self.share_for(thread_id) {
            None => CodexSharingDecision::Deny,
            Some(share) => match share.mode {
                Mode::Hold => CodexSharingDecision::Hold,
                Mode::Auto if is_unrestricted && !share.allows_unrestricted => {
                    CodexSharingDecision::Hold
                }
                Mode::Auto => CodexSharingDecision::Deliver,
            },
        }
    }
}

fn digest(data: &[u8]) -> String {
    Sha256::digest(data)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Foundation's default `Date` encoding: seconds since 2001-01-01 UTC.
mod reference_date {
    use super::*;

    const REFERENCE: Duration = Duration::from_secs(978_307_200);

    pub fn serialize<S: Serializer>(time: &SystemTime, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_f64(super::super::seconds(*time) - REFERENCE.as_secs_f64())
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<SystemTime, D::Error> {
        let value = f64::deserialize(deserializer)?;
        super::super::from_seconds(value + REFERENCE.as_secs_f64())
            .ok_or_else(|| serde::de::Error::custom(format!("sharedAt {value} is out of range")))
    }

    #[cfg(test)]
    pub fn epoch() -> SystemTime {
        std::time::UNIX_EPOCH + REFERENCE
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::UNIX_EPOCH;

    // CodexSharingTests.testDeniesAnUnsharedThread.
    #[test]
    fn denies_an_unshared_thread() {
        let policy = CodexSharingPolicy::in_memory();
        assert!(policy.share_for("thread-1").is_none());
        assert_eq!(policy.decide("thread-1", false), CodexSharingDecision::Deny);
        assert_eq!(policy.decide("thread-1", true), CodexSharingDecision::Deny);
    }

    // CodexSharingTests.testHoldModeAlwaysAsksFirst.
    #[test]
    fn hold_mode_always_asks_first() {
        let policy = CodexSharingPolicy::in_memory();
        policy.share("thread-1", Mode::Hold, false).unwrap();
        assert_eq!(policy.decide("thread-1", false), CodexSharingDecision::Hold);
        assert_eq!(policy.decide("thread-1", true), CodexSharingDecision::Hold);
    }

    // CodexSharingTests.testAutoModeDeliversStraightAwayWhenSandboxed.
    #[test]
    fn auto_mode_delivers_straight_away_when_sandboxed() {
        let policy = CodexSharingPolicy::in_memory();
        policy.share("thread-1", Mode::Auto, false).unwrap();
        assert_eq!(
            policy.decide("thread-1", false),
            CodexSharingDecision::Deliver
        );
    }

    // CodexSharingTests.testAutoModeFallsBackToHoldOnAnUnrestrictedThreadByDefault.
    #[test]
    fn auto_mode_falls_back_to_hold_on_an_unrestricted_thread_by_default() {
        let policy = CodexSharingPolicy::in_memory();
        policy.share("thread-1", Mode::Auto, false).unwrap();
        assert_eq!(policy.decide("thread-1", true), CodexSharingDecision::Hold);
    }

    // CodexSharingTests.testAutoModeDeliversOnAnUnrestrictedThreadOnlyWithTheSecondOptIn.
    #[test]
    fn auto_mode_delivers_on_an_unrestricted_thread_only_with_the_second_opt_in() {
        let policy = CodexSharingPolicy::in_memory();
        policy.share("thread-1", Mode::Auto, true).unwrap();
        assert_eq!(
            policy.decide("thread-1", true),
            CodexSharingDecision::Deliver
        );
    }

    // CodexSharingTests.testUnsharingFailsClosedImmediately.
    #[test]
    fn unsharing_fails_closed_immediately() {
        let policy = CodexSharingPolicy::in_memory();
        policy.share("thread-1", Mode::Auto, true).unwrap();
        assert_eq!(
            policy.decide("thread-1", true),
            CodexSharingDecision::Deliver
        );
        policy.unshare("thread-1").unwrap();
        assert!(policy.share_for("thread-1").is_none());
        assert_eq!(policy.decide("thread-1", true), CodexSharingDecision::Deny);
    }

    // CodexSharingTests.testSharingAgainReplacesTheEarlierShare.
    #[test]
    fn sharing_again_replaces_the_earlier_share() {
        let policy = CodexSharingPolicy::in_memory();
        policy.share("thread-1", Mode::Auto, true).unwrap();
        policy.share("thread-1", Mode::Hold, false).unwrap();
        let share = policy.share_for("thread-1").unwrap();
        assert_eq!(share.mode, Mode::Hold);
        assert!(!share.allows_unrestricted);
        assert_eq!(policy.decide("thread-1", true), CodexSharingDecision::Hold);
    }

    // CodexSharingTests.testSharedThreadIDsReflectsEveryOpenThread.
    #[test]
    fn shared_thread_ids_reflects_every_open_thread() {
        let policy = CodexSharingPolicy::in_memory();
        assert!(policy.shared_thread_ids().is_empty());
        policy.share("thread-1", Mode::Hold, false).unwrap();
        policy.share("thread-2", Mode::Auto, false).unwrap();
        let mut ids = policy.shared_thread_ids();
        ids.sort();
        assert_eq!(ids, ["thread-1", "thread-2"]);
        policy.unshare("thread-1").unwrap();
        assert_eq!(policy.shared_thread_ids(), ["thread-2"]);
    }

    // CodexSharingTests.testDifferentThreadsAreDecidedIndependently.
    #[test]
    fn different_threads_are_decided_independently() {
        let policy = CodexSharingPolicy::in_memory();
        policy.share("thread-1", Mode::Auto, false).unwrap();
        assert_eq!(
            policy.decide("thread-1", false),
            CodexSharingDecision::Deliver
        );
        assert_eq!(policy.decide("thread-2", false), CodexSharingDecision::Deny);
    }

    // CodexSharingTests.testThreadShareRoundTripsThroughJSON.
    #[test]
    fn thread_share_round_trips_through_json() {
        let share = CodexThreadShare {
            thread_id: "thread-1".into(),
            mode: Mode::Auto,
            allows_unrestricted: true,
            shared_at: UNIX_EPOCH + Duration::from_secs(1_700_000_000),
        };
        let json = serde_json::to_value(&share).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "threadID": "thread-1",
                "mode": "auto",
                "allowsUnrestricted": true,
                "sharedAt": 1_700_000_000.0 - 978_307_200.0
            })
        );
        assert_eq!(
            serde_json::from_value::<CodexThreadShare>(json).unwrap(),
            share
        );
    }

    // shares.json written by the Swift app opens unchanged.
    #[test]
    fn opens_a_policy_the_swift_app_wrote() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("scope/shares.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            r#"[{"threadID":"t","mode":"hold","allowsUnrestricted":false,"sharedAt":780000000.5}]"#,
        )
        .unwrap();
        let policy = CodexSharingPolicy::open(&path).unwrap();
        assert!(!policy.recovered_interrupted_change());
        let share = policy.share_for("t").unwrap();
        assert_eq!(share.mode, Mode::Hold);
        assert_eq!(
            share.shared_at,
            reference_date::epoch() + Duration::from_secs_f64(780_000_000.5)
        );
        fs::write(
            &path,
            r#"[{"threadID":"t","mode":"hold","allowsUnrestricted":false,"sharedAt":1},{"threadID":"t","mode":"auto","allowsUnrestricted":false,"sharedAt":2}]"#,
        )
        .unwrap();
        assert!(matches!(
            CodexSharingPolicy::open(&path),
            Err(OutboxError::Corrupt(_))
        ));
    }

    // The saved policy is private to this user.
    #[cfg(unix)]
    #[test]
    fn the_saved_policy_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("incoming/scope/shares.json");
        CodexSharingPolicy::open(&path)
            .unwrap()
            .share("t", Mode::Hold, false)
            .unwrap();
        let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&path), 0o600);
        assert_eq!(mode(path.parent().unwrap()), 0o700);
        assert!(!path.with_extension("json.pending").exists());
    }

    // Review (PR #149): a `sharedAt` no time can have fails `open` instead of
    // crashing.
    #[test]
    fn an_out_of_range_shared_at_fails_open() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("scope/shares.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            r#"[{"threadID":"t","mode":"hold","allowsUnrestricted":false,"sharedAt":1e300}]"#,
        )
        .unwrap();
        assert!(matches!(
            CodexSharingPolicy::open(&path),
            Err(OutboxError::Corrupt(_))
        ));
    }
}
