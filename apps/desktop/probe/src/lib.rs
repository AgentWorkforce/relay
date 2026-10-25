//! The Agent Relay probe: sign-in, the upload queue and its worker, the
//! RelayHistory transport, and the relay core daemon (`relay`).
//! `agent-relay-probe` (src/probe) is its only binary.
/// The desktop release, or a Git-identified development build. The internal
/// Cargo package version is never presented as a separate product release.
pub const VERSION: &str = env!("RELAY_DESKTOP_VERSION");
pub const BUILD_REVISION: &str = env!("RELAY_DESKTOP_REVISION");
pub const HISTORY_VERSION: &str = env!("RELAY_HISTORY_VERSION");

pub mod cloud;
pub mod delivery;
pub mod destination;
pub mod linux_app;
pub mod migration;
pub mod platform;
pub mod relay;
fn parse_iso_ms(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|date| date.timestamp_millis())
}
