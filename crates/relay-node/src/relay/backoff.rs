//! Shared pacing for background Relaycast calls.
//!
//! A limit is scoped to one Relaycast workspace, not its origin or one agent
//! token. A desktop can use its team workspace (including the signed-in
//! person) and several Relay Connect rooms at the same origin.

use crate::relay::workspace::Secret;
use relaycast::RelayError;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const PLAN_RECHECK: Duration = Duration::from_secs(15 * 60);
const FAR_RETRY_AFTER: Duration = PLAN_RECHECK;
const TRANSIENT_BASE: Duration = Duration::from_secs(2);
const TRANSIENT_CAP: Duration = Duration::from_secs(15 * 60);
const PROBE_LEASE: Duration = Duration::from_secs(30);

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BackoffNotice {
    PlanLimit { reset_at_ms: i64 },
}

/// A non-secret identity for one Relaycast workspace plus its activity label.
/// Credentials are hashed so the shared gate can group agent-token calls by
/// their workspace key without retaining or printing that key.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkspaceScope {
    key: String,
    label: String,
}

impl WorkspaceScope {
    pub fn credential(base_url: &str, credential: &Secret, label: impl Into<String>) -> Self {
        Self::new("credential", base_url, credential.expose(), label)
    }

    pub fn id(base_url: &str, workspace_id: &str, label: impl Into<String>) -> Self {
        Self::new("id", base_url, workspace_id, label)
    }

    fn new(kind: &str, base_url: &str, identity: &str, label: impl Into<String>) -> Self {
        let digest = Sha256::digest(
            serde_json::to_vec(&("relaycast-backoff:v1", kind, base_url, identity))
                .unwrap_or_default(),
        );
        Self {
            key: format!("{digest:x}"),
            label: label.into(),
        }
    }

    /// The credential scope, irrespective of its presentation label.
    pub(crate) fn same_credentials(&self, other: &Self) -> bool {
        self.key == other.key
    }

    pub fn label(&self) -> &str {
        &self.label
    }

    pub(crate) fn key(&self) -> &str {
        &self.key
    }

    fn write_admission(&self) -> Self {
        Self {
            key: format!("{}:write-admission", self.key),
            label: self.label.clone(),
        }
    }
}

impl BackoffNotice {
    pub fn message(&self, workspace: &str) -> String {
        match self {
            Self::PlanLimit { reset_at_ms } => {
                let reset = chrono::DateTime::from_timestamp_millis(*reset_at_ms)
                    .map(|at| at.format("%Y-%m-%d %H:%M UTC").to_string())
                    .unwrap_or_else(|| "the plan reset".into());
                format!(
                    "Agent Relay plan limit reached for {workspace} until {reset}; messages are paused."
                )
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Limit {
    Plan { reset_at_ms: i64 },
    Transient,
}

#[derive(Clone, Debug)]
struct Entry {
    retry_at: Instant,
    probe_until: Option<Instant>,
    attempts: u32,
    limit: Limit,
}

/// Shared workspace quota pacing plus a write-only admission gate.
pub struct RelaycastBackoff {
    entries: Mutex<BTreeMap<String, Entry>>,
    jitter: fn() -> f64,
}

impl Default for RelaycastBackoff {
    fn default() -> Self {
        Self::new(random_jitter)
    }
}

impl RelaycastBackoff {
    fn new(jitter: fn() -> f64) -> Self {
        Self {
            entries: Mutex::new(BTreeMap::new()),
            jitter,
        }
    }

    /// Remaining time before one inexpensive recheck is allowed. Once a
    /// pause expires, the first caller atomically claims a bounded probe;
    /// siblings keep waiting instead of stampeding the same workspace.
    pub fn remaining(&self, workspace: &WorkspaceScope) -> Option<Duration> {
        self.remaining_keys(&[&workspace.key])
    }

    /// Write contention is separate from quotas: reads do not take a
    /// Relaycast write-admission lease, but writes must honor both gates.
    pub fn remaining_write(&self, workspace: &WorkspaceScope) -> Option<Duration> {
        self.remaining_keys(&[&workspace.key, &workspace.write_admission().key])
    }

    fn remaining_keys(&self, keys: &[&str]) -> Option<Duration> {
        let now = Instant::now();
        let mut entries = self.entries.lock().unwrap();
        // Check every gate before claiming any probe. A blocked write must
        // not consume the workspace's otherwise-available read recheck.
        if let Some(delay) = keys
            .iter()
            .filter_map(|key| entries.get(*key))
            .flat_map(|entry| [Some(entry.retry_at), entry.probe_until])
            .flatten()
            .filter_map(|until| until.checked_duration_since(now))
            .max()
        {
            return Some(delay);
        }
        for key in keys {
            if let Some(entry) = entries.get_mut(*key) {
                entry.probe_until = Some(now + PROBE_LEASE);
            }
        }
        None
    }

    /// Whether writes are paused now, without claiming the recheck that
    /// `remaining_write` hands the first caller after a pause.
    pub fn write_paused(&self, workspace: &WorkspaceScope) -> bool {
        let now = Instant::now();
        let entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        [&workspace.key, &workspace.write_admission().key]
            .iter()
            .filter_map(|key| entries.get(*key))
            .any(|entry| entry.retry_at > now)
    }

    pub fn allowed(&self, workspace: &WorkspaceScope) -> bool {
        self.remaining(workspace).is_none()
    }

    pub fn allowed_write(&self, workspace: &WorkspaceScope) -> bool {
        self.remaining_write(workspace).is_none()
    }

    pub fn record_write_success(&self, workspace: &WorkspaceScope) {
        self.record_success(workspace);
        self.record_success(&workspace.write_admission());
    }

    pub fn record_write_error(
        &self,
        workspace: &WorkspaceScope,
        error: &RelayError,
    ) -> Option<BackoffNotice> {
        let admission = workspace.write_admission();
        let busy = matches!(error, RelayError::Api { code, .. } if code == "workspace_busy")
            && matches!(
                classify(error, chrono::Utc::now().timestamp_millis()),
                Some((Limit::Transient, _))
            );
        if busy {
            self.record_success(workspace);
            self.record_error(&admission, error)
        } else {
            self.record_success(&admission);
            self.record_error(workspace, error)
        }
    }

    /// Records a successful recheck. An already-running request cannot clear
    /// a newer limit before the gate's retry time.
    pub fn record_success(&self, workspace: &WorkspaceScope) {
        let mut entries = self.entries.lock().unwrap();
        if entries
            .get(&workspace.key)
            .is_some_and(|entry| entry.retry_at <= Instant::now() && entry.probe_until.is_some())
        {
            entries.remove(&workspace.key);
        }
    }

    /// Records a server pacing response. Returns a notice only when a plan
    /// limit first becomes user-visible, so parallel agents do not spam the
    /// activity feed with the same workspace-wide failure.
    pub fn record_error(
        &self,
        workspace: &WorkspaceScope,
        error: &RelayError,
    ) -> Option<BackoffNotice> {
        let now_ms = chrono::Utc::now().timestamp_millis();
        let Some((limit, retry_after)) = classify(error, now_ms) else {
            // A completed recheck that is no longer a pacing response ends
            // the old limit even when this particular call failed for a
            // different reason.
            let mut entries = self.entries.lock().unwrap();
            if entries.get(&workspace.key).is_some_and(|entry| {
                entry.retry_at <= Instant::now() && entry.probe_until.is_some()
            }) {
                entries.remove(&workspace.key);
            }
            return None;
        };
        let mut entries = self.entries.lock().unwrap();
        let attempts = entries
            .get(&workspace.key)
            .map_or(1, |entry| entry.attempts.saturating_add(1));
        let delay = match limit {
            Limit::Plan { reset_at_ms } => {
                let until_reset =
                    Duration::from_millis(reset_at_ms.saturating_sub(now_ms).max(1) as u64);
                until_reset.min(PLAN_RECHECK)
            }
            Limit::Transient => {
                let exponent = attempts.min(9);
                let exponential =
                    TRANSIENT_BASE.mul_f64(2f64.powi((exponent - 1) as i32) * (self.jitter)());
                retry_after
                    .unwrap_or_default()
                    .max(exponential)
                    .min(TRANSIENT_CAP)
            }
        };
        let notify = matches!(limit, Limit::Plan { .. })
            && entries
                .get(&workspace.key)
                .is_none_or(|entry| !matches!(entry.limit, Limit::Plan { .. }));
        entries.insert(
            workspace.key.clone(),
            Entry {
                retry_at: Instant::now() + delay.max(Duration::from_millis(1)),
                probe_until: None,
                attempts,
                limit,
            },
        );
        notify.then(|| match limit {
            Limit::Plan { reset_at_ms } => BackoffNotice::PlanLimit { reset_at_ms },
            Limit::Transient => unreachable!(),
        })
    }
}

fn classify(error: &RelayError, now_ms: i64) -> Option<(Limit, Option<Duration>)> {
    let RelayError::Api {
        code,
        status,
        retry_after_ms,
        ..
    } = error
    else {
        return None;
    };
    let retry_after = retry_after_ms.map(Duration::from_millis);
    let plan = code == "plan_limit_exceeded"
        || (*status == 429 && retry_after.is_some_and(|delay| delay >= FAR_RETRY_AFTER));
    if plan {
        let reset_at_ms = retry_after_ms
            .filter(|delay| *delay > 0)
            .and_then(|delay| i64::try_from(delay).ok())
            .map(|delay| now_ms.saturating_add(delay))
            .unwrap_or_else(next_month_ms);
        return Some((Limit::Plan { reset_at_ms }, retry_after));
    }
    // `database_overloaded` is Relaycast's database queue refusing work. It
    // names a Retry-After; answering it with the next agent's request 100 ms
    // later only keeps the queue full.
    if *status == 429
        || (*status == 503 && retry_after.is_some())
        || matches!(
            code.as_str(),
            "rate_limit_exceeded" | "workspace_busy" | "database_overloaded"
        )
    {
        return Some((Limit::Transient, retry_after));
    }
    None
}

fn next_month_ms() -> i64 {
    use chrono::{Datelike, TimeZone};

    let now = chrono::Utc::now();
    let (year, month) = if now.month() == 12 {
        (now.year() + 1, 1)
    } else {
        (now.year(), now.month() + 1)
    };
    chrono::Utc
        .with_ymd_and_hms(year, month, 1, 0, 0, 0)
        .single()
        .map_or_else(|| now.timestamp_millis(), |at| at.timestamp_millis())
}

fn random_jitter() -> f64 {
    let mut bytes = [0u8; 4];
    if getrandom::getrandom(&mut bytes).is_err() {
        return 1.0;
    }
    0.5 + 0.5 * (u32::from_le_bytes(bytes) as f64 / u32::MAX as f64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn api(code: &str, status: u16, retry_after_ms: Option<u64>) -> RelayError {
        RelayError::Api {
            code: code.into(),
            message: "limited".into(),
            status,
            request_id: None,
            attempts: 1,
            retry_after_ms,
            details: None,
        }
    }

    #[test]
    fn classifies_plan_limits_and_far_retry_after_as_plan_pauses() {
        let now = 1_000;
        assert!(matches!(
            classify(&api("plan_limit_exceeded", 429, None), now),
            Some((Limit::Plan { reset_at_ms }, _)) if reset_at_ms > now
        ));
        assert_eq!(
            classify(&api("unknown", 429, Some(3_600_000)), now),
            Some((
                Limit::Plan {
                    reset_at_ms: 3_601_000
                },
                Some(Duration::from_secs(3_600))
            ))
        );
    }

    #[test]
    fn classifies_short_rate_limits_and_workspace_busy_as_transient() {
        assert_eq!(
            classify(&api("rate_limit_exceeded", 429, Some(4_000)), 0),
            Some((Limit::Transient, Some(Duration::from_secs(4))))
        );
        assert_eq!(
            classify(&api("workspace_busy", 503, None), 0),
            Some((Limit::Transient, None))
        );
        assert_eq!(
            classify(&api("database_overloaded", 503, Some(2_000)), 0),
            Some((Limit::Transient, Some(Duration::from_secs(2))))
        );
        assert_eq!(
            classify(&api("database_overloaded", 503, None), 0),
            Some((Limit::Transient, None))
        );
        assert_eq!(
            classify(&api("unknown", 503, Some(1_000)), 0),
            Some((Limit::Transient, Some(Duration::from_secs(1))))
        );
        assert_eq!(classify(&api("internal_error", 503, None), 0), None);
        assert_eq!(classify(&api("bad_request", 400, None), 0), None);
    }

    #[test]
    fn plan_limit_blocks_the_workspace_and_reports_once() {
        let gate = RelaycastBackoff::new(|| 1.0);
        let workspace = WorkspaceScope::id("https://relay.example", "workspace-a", "Acme");
        let error = api("plan_limit_exceeded", 429, Some(3_600_000));
        let notice = gate.record_error(&workspace, &error).unwrap();
        assert!(notice
            .message("Acme")
            .starts_with("Agent Relay plan limit reached for Acme until "));
        assert!(!gate.allowed(&workspace));
        assert!(gate.record_error(&workspace, &error).is_none());
    }

    #[test]
    fn plan_pause_does_not_block_another_workspace_on_the_same_origin() {
        let gate = RelaycastBackoff::new(|| 1.0);
        let workspace_a = WorkspaceScope::id("https://relay.example", "workspace-a", "A");
        let workspace_b = WorkspaceScope::id("https://relay.example", "workspace-b", "B");
        gate.record_error(
            &workspace_a,
            &api("plan_limit_exceeded", 429, Some(3_600_000)),
        );
        assert!(!gate.allowed(&workspace_a));
        assert!(gate.allowed(&workspace_b));
    }

    #[test]
    fn credentials_for_one_workspace_share_the_gate() {
        let gate = RelaycastBackoff::new(|| 1.0);
        let key_a = Secret::new("rk_live_workspace_a");
        let key_b = Secret::new("rk_live_workspace_b");
        let workspace_a = WorkspaceScope::credential("https://relay.example", &key_a, "A");
        let same_workspace =
            WorkspaceScope::credential("https://relay.example", &key_a, "renamed A");
        let workspace_b = WorkspaceScope::credential("https://relay.example", &key_b, "B");
        gate.record_error(
            &workspace_a,
            &api("plan_limit_exceeded", 429, Some(3_600_000)),
        );
        assert!(!gate.allowed(&same_workspace));
        assert!(gate.allowed(&workspace_b));
    }

    #[test]
    fn only_one_of_many_agents_claims_an_expired_workspace_probe() {
        let gate = RelaycastBackoff::new(|| 1.0);
        let workspace = WorkspaceScope::id("https://relay.example", "workspace-a", "A");
        gate.entries.lock().unwrap().insert(
            workspace.key.clone(),
            Entry {
                retry_at: Instant::now() - Duration::from_millis(1),
                probe_until: None,
                attempts: 1,
                limit: Limit::Transient,
            },
        );
        let admitted = (0..8).filter(|_| gate.allowed(&workspace)).count();
        assert_eq!(admitted, 1);
        gate.record_success(&workspace);
        assert!((0..8).all(|_| gate.allowed(&workspace)));
    }

    #[test]
    fn retry_after_is_not_shortened_by_transient_jitter() {
        let gate = RelaycastBackoff::new(|| 0.5);
        let workspace = WorkspaceScope::id("https://relay.example", "workspace-a", "A");
        gate.record_error(&workspace, &api("rate_limit_exceeded", 429, Some(10_000)));
        assert!(gate.remaining(&workspace).unwrap() >= Duration::from_secs(9));
    }

    #[test]
    fn busy_writes_pause_writes_but_leave_roster_and_delivery_reads_available() {
        let gate = RelaycastBackoff::new(|| 1.0);
        let workspace = WorkspaceScope::id("https://relay.example", "workspace-a", "A");
        gate.record_write_error(&workspace, &api("workspace_busy", 429, Some(10_000)));
        assert!(gate.allowed(&workspace));
        assert!(!gate.allowed_write(&workspace));
        gate.record_success(&workspace);
        assert!(
            !gate.allowed_write(&workspace),
            "a read cannot clear write contention"
        );

        let admission = workspace.write_admission();
        gate.entries
            .lock()
            .unwrap()
            .get_mut(&admission.key)
            .unwrap()
            .retry_at = Instant::now() - Duration::from_millis(1);
        assert_eq!((0..8).filter(|_| gate.allowed_write(&workspace)).count(), 1);
        gate.record_success(&workspace);
        assert!(
            !gate.allowed_write(&workspace),
            "a read cannot clear a write probe"
        );
        gate.record_write_success(&workspace);
        assert!(gate.allowed_write(&workspace));
    }

    #[test]
    fn quotas_from_writes_still_pause_reads_and_writes() {
        for error in [
            api("plan_limit_exceeded", 429, None),
            api("rate_limit_exceeded", 429, Some(10_000)),
            api("workspace_busy", 429, Some(3_600_000)),
        ] {
            let gate = RelaycastBackoff::new(|| 1.0);
            let workspace = WorkspaceScope::id("https://relay.example", "workspace-a", "A");
            gate.record_write_error(&workspace, &error);
            assert!(!gate.allowed(&workspace));
            assert!(!gate.allowed_write(&workspace));
        }
    }

    #[test]
    fn blocked_write_does_not_claim_an_expired_quota_probe() {
        let gate = RelaycastBackoff::new(|| 1.0);
        let workspace = WorkspaceScope::id("https://relay.example", "workspace-a", "A");
        gate.record_error(&workspace, &api("rate_limit_exceeded", 429, None));
        gate.entries
            .lock()
            .unwrap()
            .get_mut(&workspace.key)
            .unwrap()
            .retry_at = Instant::now() - Duration::from_millis(1);
        gate.record_error(
            &workspace.write_admission(),
            &api("workspace_busy", 429, Some(10_000)),
        );
        assert!(!gate.allowed_write(&workspace));
        assert!(
            gate.allowed(&workspace),
            "the read still owns the quota recheck"
        );
    }
}
