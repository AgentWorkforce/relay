//! Opt-in, read-only quota observations from a pinned CodexBar CLI.
//!
//! This module never reads provider credentials. The helper receives no token
//! on argv/stdin and is only started for lanes explicitly enabled by the caller.
//! A failed or old observation is always unknown, never a placement guarantee.

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const CODEXBAR_VERSION: &str = "0.75.0";
pub const MAX_OBSERVATION_AGE: Duration = Duration::from_secs(180);
pub const REFRESH_INTERVAL: Duration = Duration::from_secs(120);

/// A single explicitly authorized credential path and source strategy.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum QuotaLane {
    ClaudeOAuth,
    CodexOAuth,
    CodexRpc,
    OpenCodeGoApi,
    GrokRpc,
    MuseCodeOAuth,
}

impl QuotaLane {
    pub fn provider(self) -> &'static str {
        match self {
            Self::ClaudeOAuth => "claude",
            Self::CodexOAuth | Self::CodexRpc => "codex",
            Self::OpenCodeGoApi => "opencodego",
            Self::GrokRpc => "grok",
            Self::MuseCodeOAuth => "muse",
        }
    }

    fn source_mode(self) -> &'static str {
        match self {
            Self::ClaudeOAuth | Self::CodexOAuth | Self::MuseCodeOAuth => "oauth",
            Self::CodexRpc | Self::GrokRpc => "cli",
            Self::OpenCodeGoApi => "api",
        }
    }

    fn accepts_source(self, source: &str) -> bool {
        matches!(
            (self, source),
            (
                Self::ClaudeOAuth | Self::CodexOAuth | Self::MuseCodeOAuth,
                "oauth"
            ) | (Self::CodexRpc, "codex-cli")
                | (Self::GrokRpc, "grok-cli")
                | (Self::OpenCodeGoApi, "api")
        )
    }
}

/// All lanes are off by default. The caller must enable each lane only after
/// the person approves the helper's access to that provider's stored login.
#[derive(Clone, Debug, Default)]
pub struct QuotaConfig {
    pub helper_path: PathBuf,
    pub enabled_lanes: BTreeSet<QuotaLane>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum QuotaState {
    Available,
    ApproachingLimit,
    Blocked,
    Unknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MeasurementKind {
    Quota,
    Spend,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BillingKind {
    Subscription,
    Api,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UnknownReason {
    HelperUnavailable,
    HelperVersion,
    Timeout,
    FetchFailed,
    InvalidOutput,
    UntrustedSource,
    Stale,
    NoQuota,
    UnidentifiedAccount,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct QuotaWindow {
    pub kind: String,
    pub used_percent: f64,
    pub remaining_percent: f64,
    pub reset_at: Option<String>,
}

/// Safe to advertise: no token, raw email, account ID, helper stderr, or
/// provider response is retained. A fingerprint is a correlation handle,
/// not an anonymity guarantee.
#[derive(Clone, Debug, Serialize)]
pub struct QuotaReading {
    pub lane: QuotaLane,
    pub provider: &'static str,
    pub account_fingerprint: Option<String>,
    pub state: QuotaState,
    pub reason: Option<UnknownReason>,
    pub observed_at: Option<String>,
    pub source: Option<String>,
    pub fresh: bool,
    pub measurement: MeasurementKind,
    pub billing: BillingKind,
    pub windows: Vec<QuotaWindow>,
}

impl QuotaReading {
    fn unknown(lane: QuotaLane, reason: UnknownReason) -> Self {
        Self {
            lane,
            provider: lane.provider(),
            account_fingerprint: None,
            state: QuotaState::Unknown,
            reason: Some(reason),
            observed_at: None,
            source: None,
            fresh: false,
            measurement: MeasurementKind::Quota,
            billing: BillingKind::Subscription,
            windows: Vec::new(),
        }
    }
}

/// Nonblocking heartbeat view. The background task is the only fetcher; a
/// heartbeat reads this cache without starting a helper or waiting on I/O.
#[derive(Clone, Default)]
pub struct QuotaCache {
    inner: Arc<RwLock<Vec<QuotaReading>>>,
}

impl QuotaCache {
    pub fn snapshot(&self, now: DateTime<Utc>) -> Vec<QuotaReading> {
        let mut readings = self
            .inner
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        for reading in &mut readings {
            if reading.fresh && !timestamp_is_fresh(reading.observed_at.as_deref(), now) {
                reading.state = QuotaState::Unknown;
                reading.reason = Some(UnknownReason::Stale);
                reading.fresh = false;
                reading.windows.clear();
            }
        }
        readings
    }

    fn replace(&self, readings: Vec<QuotaReading>) {
        let mut cached = self
            .inner
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for reading in readings {
            if let Some(existing) = cached.iter_mut().find(|row| row.lane == reading.lane) {
                *existing = reading;
            } else {
                cached.push(reading);
            }
        }
        cached.sort_by_key(|row| row.lane);
    }

    /// Start one 120-second poll loop. Callers must abort the handle on shutdown
    /// or before starting a replacement task after a settings change;
    /// disabling all lanes starts no task and leaves the cache empty.
    pub fn spawn_refresh(&self, config: QuotaConfig) -> Option<tokio::task::JoinHandle<()>> {
        self.inner
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .retain(|reading| config.enabled_lanes.contains(&reading.lane));
        if config.enabled_lanes.is_empty() {
            return None;
        }
        let cache = self.clone();
        Some(tokio::spawn(async move {
            let mut ticker = tokio::time::interval(REFRESH_INTERVAL);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut failures: BTreeMap<QuotaLane, u32> = BTreeMap::new();
            let mut next_due: BTreeMap<QuotaLane, DateTime<Utc>> = BTreeMap::new();
            loop {
                ticker.tick().await;
                let now = Utc::now();
                let due = config
                    .enabled_lanes
                    .iter()
                    .copied()
                    .filter(|lane| next_due.get(lane).is_none_or(|deadline| *deadline <= now))
                    .collect();
                let selected = QuotaConfig {
                    helper_path: config.helper_path.clone(),
                    enabled_lanes: due,
                };
                if selected.enabled_lanes.is_empty() {
                    continue;
                }
                let readings = collect(&selected, now).await;
                for reading in &readings {
                    let count = failures.entry(reading.lane).or_default();
                    if reading.state == QuotaState::Unknown {
                        *count = count.saturating_add(1);
                    } else {
                        *count = 0;
                    }
                    // The delay is bounded, so it always converts and
                    // lands in range; were it not, the lane is due now.
                    let due = chrono::Duration::from_std(retry_delay(*count))
                        .ok()
                        .and_then(|delay| now.checked_add_signed(delay))
                        .unwrap_or(now);
                    next_due.insert(reading.lane, due);
                }
                cache.replace(readings);
            }
        }))
    }
}

fn retry_delay(consecutive_failures: u32) -> Duration {
    let exponent = consecutive_failures.saturating_sub(1).min(6);
    Duration::from_secs(
        REFRESH_INTERVAL
            .as_secs()
            .saturating_mul(1u64 << exponent)
            .min(1800),
    )
}

fn timestamp_is_fresh(observed_at: Option<&str>, now: DateTime<Utc>) -> bool {
    observed_at
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .is_some_and(|t| {
            let age = now
                .signed_duration_since(t.with_timezone(&Utc))
                .num_seconds();
            age >= -30 && age <= MAX_OBSERVATION_AGE.as_secs() as i64
        })
}

#[derive(Deserialize)]
struct HelperRow {
    provider: String,
    source: String,
    usage: Option<HelperUsage>,
    error: Option<serde_json::Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HelperUsage {
    updated_at: Option<String>,
    identity: Option<HelperIdentity>,
    primary: Option<HelperWindow>,
    secondary: Option<HelperWindow>,
    tertiary: Option<HelperWindow>,
    extra_rate_windows: Option<Vec<HelperNamedWindow>>,
    data_confidence: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HelperIdentity {
    account_email: Option<String>,
    account_organization: Option<String>,
    account_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HelperWindow {
    used_percent: f64,
    resets_at: Option<String>,
    #[serde(default)]
    is_synthetic_placeholder: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HelperNamedWindow {
    id: String,
    window: HelperWindow,
    #[serde(default = "true_value")]
    usage_known: bool,
}

const fn true_value() -> bool {
    true
}

fn fingerprint(provider: &str, identity: &HelperIdentity) -> Option<String> {
    let email = identity
        .account_email
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_ascii_lowercase);
    let id = identity
        .account_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_ascii_lowercase);
    if email.is_none() && id.is_none() {
        return None;
    }
    let org = identity
        .account_organization
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let mut hash = Sha256::new();
    hash.update(b"agent-relay-quota-v1\0");
    hash.update(provider.as_bytes());
    hash.update(b"\0");
    hash.update(b"email\0");
    hash.update(email.as_deref().unwrap_or("").as_bytes());
    hash.update(b"\0");
    hash.update(b"id\0");
    hash.update(id.as_deref().unwrap_or("").as_bytes());
    hash.update(b"\0");
    hash.update(org.as_bytes());
    Some(format!("{:x}", hash.finalize()))
}

fn normalize_window(kind: &str, raw: HelperWindow, now: DateTime<Utc>) -> Option<QuotaWindow> {
    if raw.is_synthetic_placeholder
        || !raw.used_percent.is_finite()
        || !(0.0..=100.0).contains(&raw.used_percent)
    {
        return None;
    }
    let reset_at = raw
        .resets_at
        .and_then(|s| DateTime::parse_from_rfc3339(&s).ok())
        .map(|t| t.with_timezone(&Utc));
    if reset_at.is_some_and(|t| t <= now) {
        return None;
    }
    Some(QuotaWindow {
        kind: kind.to_owned(),
        used_percent: raw.used_percent,
        remaining_percent: 100.0 - raw.used_percent,
        reset_at: reset_at.map(|t| t.to_rfc3339()),
    })
}

/// Normalize recorded `codexbar usage --format json` rows. This is pure and
/// can be tested without starting the helper or touching account credentials.
pub fn normalize_helper_json(lane: QuotaLane, bytes: &[u8], now: DateTime<Utc>) -> QuotaReading {
    let Ok(rows) = serde_json::from_slice::<Vec<HelperRow>>(bytes) else {
        return QuotaReading::unknown(lane, UnknownReason::InvalidOutput);
    };
    let Some(row) = rows.into_iter().find(|r| r.provider == lane.provider()) else {
        return QuotaReading::unknown(lane, UnknownReason::InvalidOutput);
    };
    if row.error.is_some() {
        return QuotaReading::unknown(lane, UnknownReason::FetchFailed);
    }
    if !lane.accepts_source(&row.source) {
        return QuotaReading::unknown(lane, UnknownReason::UntrustedSource);
    }
    let Some(usage) = row.usage else {
        return QuotaReading::unknown(lane, UnknownReason::NoQuota);
    };
    let mut reading = QuotaReading::unknown(lane, UnknownReason::NoQuota);
    reading.source = Some(row.source);
    reading.account_fingerprint = usage
        .identity
        .as_ref()
        .and_then(|identity| fingerprint(lane.provider(), identity));
    let observed = usage
        .updated_at
        .as_deref()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|t| t.with_timezone(&Utc));
    reading.observed_at = observed.map(|t| t.to_rfc3339());
    reading.fresh = timestamp_is_fresh(reading.observed_at.as_deref(), now);
    if !reading.fresh || usage.data_confidence.as_deref() == Some("estimated") {
        reading.reason = Some(UnknownReason::Stale);
        return reading;
    }
    if reading.account_fingerprint.is_none() {
        reading.reason = Some(UnknownReason::UnidentifiedAccount);
        return reading;
    }
    let window_names = match lane {
        QuotaLane::GrokRpc => ["billing_period", "secondary", "tertiary"],
        QuotaLane::ClaudeOAuth | QuotaLane::OpenCodeGoApi | QuotaLane::MuseCodeOAuth => {
            ["five_hour", "weekly", "monthly"]
        }
        QuotaLane::CodexOAuth | QuotaLane::CodexRpc => ["session", "weekly", "tertiary"],
    };
    for (kind, window) in [
        (window_names[0], usage.primary),
        (window_names[1], usage.secondary),
        (window_names[2], usage.tertiary),
    ] {
        if let Some(window) = window.and_then(|w| normalize_window(kind, w, now)) {
            reading.windows.push(window);
        }
    }
    for extra in usage.extra_rate_windows.unwrap_or_default() {
        if extra.usage_known {
            if let Some(window) = normalize_window(&extra.id, extra.window, now) {
                reading.windows.push(window);
            }
        }
    }
    if reading.windows.is_empty() {
        return reading;
    }
    let remaining = reading
        .windows
        .iter()
        .map(|w| w.remaining_percent)
        .fold(f64::INFINITY, f64::min);
    reading.state = if remaining <= 0.0 {
        QuotaState::Blocked
    } else if remaining <= 15.0 {
        QuotaState::ApproachingLimit
    } else {
        QuotaState::Available
    };
    reading.reason = None;
    reading
}

mod helper;
pub use helper::collect;

#[cfg(test)]
mod tests;
