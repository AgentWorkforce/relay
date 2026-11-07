//! Agent Relay's own tools for the person's OpenClaw agents: the hosted
//! Agent Relay MCP in `openclaw.json`, signed in through OpenClaw's own
//! `openclaw mcp login` (`relay::openclaw::relay_tools`).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Whether the person's OpenClaw agents can use Agent Relay's tools.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum OpenClawToolsState {
    /// OpenClaw is off or not set up, its command-line tool cannot be
    /// found, or it cannot sign in to MCP servers; `detail` says which.
    Unavailable,
    /// Not signed in yet (or the sign-in lapsed): Connect starts it.
    NotConnected,
    /// `openclaw mcp login` is waiting for the person to approve in the
    /// browser.
    Waiting,
    /// OpenClaw holds Agent Relay's MCP credentials.
    Connected,
}

/// `openclaw.relay_tools.status`.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
pub struct OpenClawToolsStatus {
    pub state: OpenClawToolsState,
    /// Why the tools are unavailable, or why the last sign-in failed, in
    /// words the apps show as they are.
    #[serde(default)]
    pub detail: Option<String>,
}

/// `openclaw.relay_tools.connect`: `waiting` with the page the person
/// approves on, or `connected` (no URL) when OpenClaw was already signed in.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
pub struct OpenClawToolsConnect {
    pub state: OpenClawToolsState,
    #[serde(default)]
    pub authorization_url: Option<String>,
}
