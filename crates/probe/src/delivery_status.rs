//! One upload install's directory, as every process reads it: its
//! `config.json`, the collector's claim and reports, and the status the
//! desktop shows. The collector, the probe's commands and the relay core all
//! read an install through this module, so the core answers status in
//! process rather than through a probe command.
//!
//! The rules for when upload delivery counts as stalled or failing, below,
//! are pure and shared by the upload queue (`delivery`, with the `history`
//! feature) and the relay core's uploader status, which builds without it.
use crate::relay::uploader::SharingMode;
#[cfg(feature = "history")]
use crate::{cloud, destination};
#[cfg(feature = "history")]
use anyhow::ensure;
use anyhow::Result;
#[cfg(feature = "history")]
use serde::{Deserialize, Serialize};
#[cfg(feature = "history")]
use std::fs;
use std::path::Path;

mod claims;
mod inclusion;
#[cfg(feature = "history")]
mod status;
#[cfg(feature = "history")]
pub use crate::delivery::SessionIdentity;
pub use claims::{
    collector_version, current_cycle_report, newer_build, newer_build_live, outdated, release,
    renewal_failure, renewal_failure_message, replacement_in_progress, running,
    stop_file_requested, Release, RENEWAL_REPORT, UPDATE_REQUIRED,
};
#[cfg(not(feature = "history"))]
pub use inclusion::SessionIdentity;
pub use inclusion::{inclusion, Inclusion};
#[cfg(all(test, feature = "history"))]
pub(crate) use status::tests as status_tests;
#[cfg(feature = "history")]
pub use status::{
    delivery_failure_code, delivery_failure_message, paused, profile, status, UPGRADING,
};

/// The `config.json` format this build reads and writes.
#[cfg(feature = "history")]
pub const CONFIG_VERSION: u32 = 1;

/// An install's `config.json`.
#[cfg(feature = "history")]
#[derive(Clone, Serialize, Deserialize)]
pub struct Config {
    pub version: u32,
    pub site_url: String,
    pub account_id: String,
    #[serde(default)]
    pub account_email: Option<String>,
    #[serde(default)]
    pub account_name: Option<String>,
    #[serde(default)]
    pub account_avatar_url: Option<String>,
    pub org_id: String,
    pub workspace_id: String,
    #[serde(default)]
    pub workspace_name: Option<String>,
    pub history_url: String,
    /// The workspace's own RelayHistory origin as Cloud named it during
    /// authenticated setup, when that is not the default stage. Only setup
    /// writes it, from the workspace-session answer; renewal re-checks it with
    /// Cloud on every pass, and a `history_url` outside the default stages is
    /// refused without it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cloud_history_origin: Option<String>,
    pub delivery_account: String,
    pub job_id: String,
    pub include_existing: bool,
    #[serde(default)]
    pub sharing_mode: Option<SharingMode>,
    #[serde(default)]
    pub acknowledge_uninspected_schedules: bool,
}

/// What `config` shares.
#[cfg(feature = "history")]
pub fn mode(config: &Config) -> SharingMode {
    config.sharing_mode.unwrap_or(if config.include_existing {
        SharingMode::All
    } else {
        SharingMode::New
    })
}

/// The install's configuration, validated.
#[cfg(feature = "history")]
pub fn read_config(directory: &Path) -> Result<Config> {
    read_config_file(&directory.join("config.json"))
}

/// A configuration file, validated: this build's format, canonical origins
/// and identifiers, and the delivery account its workspace names.
#[cfg(feature = "history")]
pub fn read_config_file(path: &Path) -> Result<Config> {
    let config: Config = serde_json::from_slice(&fs::read(path)?)?;
    ensure!(
        config.version == CONFIG_VERSION
            && cloud::site_origin(&config.site_url)? == config.site_url,
        "invalid config"
    );
    ensure!(
        trusted_history_url(&config)? == config.history_url,
        "invalid history origin"
    );
    validate_id(&config.account_id)?;
    validate_id(&config.workspace_id)?;
    ensure!(
        config.delivery_account
            == destination::account_id(&config.org_id, Some(&config.workspace_id)),
        "invalid account"
    );
    Ok(config)
}

/// The saved history origin, when it is a default stage or the workspace
/// origin Cloud named at setup. A custom origin anywhere else — written into
/// `config.json` by hand, say — is refused.
#[cfg(feature = "history")]
pub fn trusted_history_url(config: &Config) -> Result<String> {
    match cloud::history_origin(&config.history_url, &config.site_url) {
        Ok(origin) => Ok(origin),
        Err(error) => {
            ensure!(
                config.cloud_history_origin.as_deref() == Some(config.history_url.as_str()),
                error
            );
            cloud::workspace_history_origin(&config.history_url, &config.site_url)
        }
    }
}

/// An account or workspace identifier as an install directory may name it.
#[cfg(feature = "history")]
pub fn validate_id(value: &str) -> Result<()> {
    ensure!(
        !value.is_empty()
            && value.len() <= 128
            && value
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_'),
        "invalid identifier"
    );
    Ok(())
}

/// Now, in epoch milliseconds.
#[cfg(feature = "history")]
pub fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// A retryable transport failure becomes user-actionable only after it has
/// persisted across several attempts and delivery has made no recent progress.
pub const SUSTAINED_FAILURE_MS: i64 = 5 * 60 * 1_000;
pub const SUSTAINED_FAILURE_ATTEMPTS: i64 = 3;

pub fn retry_failure_is_sustained(
    attempts: i64,
    last_acknowledged_ms: Option<i64>,
    oldest_pending_ms: Option<i64>,
    now_ms: i64,
) -> bool {
    attempts >= SUSTAINED_FAILURE_ATTEMPTS
        && without_progress(last_acknowledged_ms, oldest_pending_ms, now_ms)
}

/// Queued records have had no acknowledgement for `SUSTAINED_FAILURE_MS`,
/// whatever the failure, or with none reported.
pub fn delivery_is_stalled(
    pending_records: i64,
    last_acknowledged_ms: Option<i64>,
    oldest_pending_ms: Option<i64>,
    now_ms: i64,
) -> bool {
    pending_records > 0 && without_progress(last_acknowledged_ms, oldest_pending_ms, now_ms)
}

/// No acknowledgement for `SUSTAINED_FAILURE_MS`. Idle time before new work
/// was queued is not stalled delivery, so when both exist this measures from
/// whichever happened later.
fn without_progress(
    last_acknowledged_ms: Option<i64>,
    oldest_pending_ms: Option<i64>,
    now_ms: i64,
) -> bool {
    let progress_at = [last_acknowledged_ms, oldest_pending_ms]
        .into_iter()
        .flatten()
        .max();
    progress_at.is_some_and(|at| now_ms.saturating_sub(at) >= SUSTAINED_FAILURE_MS)
}
