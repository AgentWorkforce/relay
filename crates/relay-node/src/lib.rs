//! The Agent Relay core: the messaging runtime (`relay`) and Relay Connect
//! rooms. `agent-relay-node` (src/cli) is its binary.
#[cfg(all(feature = "embedded-build-info", feature = "production-binaries"))]
compile_error!("embedded-build-info is library-only; disable default features and initialize identity from the embedding executable");

/// The stamped release (AGENT_RELAY_PROBE_VERSION), or a Git-identified development build. The internal
/// Cargo package version is never presented as a separate product release.
#[cfg(not(feature = "embedded-build-info"))]
pub const VERSION: &str = env!("RELAY_DESKTOP_VERSION");
#[cfg(not(feature = "embedded-build-info"))]
pub const BUILD_REVISION: &str = env!("RELAY_DESKTOP_REVISION");

mod build_info;
pub use build_info::{build_revision, version};
#[cfg(feature = "embedded-build-info")]
pub use build_info::{install_build_info, BuildInfo};

/// The build-time check of `AGENT_RELAY_SITE_URL` and `AGENT_RELAY_URL_SCHEME`
/// (`build.rs`), tested here.
#[cfg(test)]
#[path = "../build_site.rs"]
mod build_site;

pub mod cli;
pub mod platform;
pub mod relay;
pub fn parse_iso_ms(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|date| date.timestamp_millis())
}
