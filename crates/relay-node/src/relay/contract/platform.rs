//! Platform services: launch at login.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize)]
pub struct LoginItemParams {
    pub enabled: bool,
}

/// Whether the core starts at login (Linux; macOS answers `refused`).
#[derive(Clone, Debug, Serialize, JsonSchema, Deserialize)]
pub struct LoginItemState {
    pub enabled: bool,
}
