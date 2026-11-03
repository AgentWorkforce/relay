//! Per-machine, explicitly selected hosted MCP integrations.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema)]
pub struct ToolsReport {
    pub onboarding_complete: bool,
    pub account_health: Option<String>,
    pub tools: Vec<ToolIntegration>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
pub struct ToolIntegration {
    pub id: String,
    pub name: String,
    pub detected: bool,
    pub supported: bool,
    pub selected: bool,
    pub state: String,
    pub status_label: String,
    pub detail: String,
    pub can_install: bool,
    pub can_repair: bool,
    pub can_uninstall: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
pub struct ToolsSelectParams {
    pub tool_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
pub struct ToolsManageParams {
    pub tool_id: String,
    pub action: String,
}
