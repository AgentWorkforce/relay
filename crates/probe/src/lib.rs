//! The Agent Relay probe: sign-in, the upload queue and its worker, the
//! RelayHistory transport, and the relay core daemon (`relay`).
//! `agent-relay-probe` (src/probe) is its only binary.
/// The stamped release (AGENT_RELAY_PROBE_VERSION), or a Git-identified development build. The internal
/// Cargo package version is never presented as a separate product release.
pub const VERSION: &str = env!("RELAY_DESKTOP_VERSION");
pub const BUILD_REVISION: &str = env!("RELAY_DESKTOP_REVISION");
/// The RelayHistory (`ai-hist`) release the history feature is built on.
#[cfg(feature = "history")]
pub const HISTORY_VERSION: &str = env!("RELAY_HISTORY_VERSION");

/// [`HISTORY_VERSION`], or `None` for a core built without session history.
pub fn history_version() -> Option<&'static str> {
    #[cfg(feature = "history")]
    return Some(HISTORY_VERSION);
    #[cfg(not(feature = "history"))]
    return None;
}

pub mod cloud;
#[cfg(feature = "history")]
pub mod delivery;
pub mod delivery_status;
#[cfg(feature = "history")]
pub mod destination;
pub mod history_access;
pub mod install;
pub mod migration;
pub mod platform;
pub mod relay;
#[cfg(feature = "history")]
pub mod retention;
pub mod session_model;
fn parse_iso_ms(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|date| date.timestamp_millis())
}
