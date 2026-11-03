//! Local process observations. These are navigation hints, never delivery authority.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SessionLocation {
    pub application: String,
    pub bundle_id: String,
    pub pid: i32,
    pub process_start: u64,
    pub tty: Option<String>,
    pub observed_at_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SessionLocationReport {
    /// False on platforms without native window navigation.
    pub supported: bool,
    /// A verified owner exists even if its UI cannot be located.
    pub running: bool,
    /// Every verified location, including simultaneous owners. Never pick one arbitrarily.
    pub current: Vec<SessionLocation>,
    /// Last observed locations survive process exit and core restarts. Never focus these.
    pub previous: Vec<SessionLocation>,
    /// A provider-owned desktop identity mapped from this CLI session.
    pub desktop_link: Option<String>,
    pub reason: Option<String>,
}
