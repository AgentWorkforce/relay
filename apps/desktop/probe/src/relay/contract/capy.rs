//! Starting Capy threads through Agent Relay Cloud.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, JsonSchema, Serialize)]
pub struct CapyProjectsParams {
    /// Continue a truncated Cloud project listing.
    pub cursor: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, JsonSchema, Deserialize)]
pub struct CapyProjects {
    pub projects: Vec<CapyProject>,
    pub truncated: bool,
    #[serde(alias = "nextCursor")]
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, JsonSchema, Deserialize)]
pub struct CapyProject {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CapyPullRequestAuthor {
    User,
    Capy,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, JsonSchema, Serialize)]
pub struct CapyThreadSpawnParams {
    /// A durable id for this UI operation. Cloud makes the provider request
    /// id from this, the workspace and the signed-in person.
    pub client_request_id: String,
    pub project_id: String,
    pub task: String,
    pub model: Option<String>,
    pub pull_request_author: Option<CapyPullRequestAuthor>,
    /// A relay agent name to receive the result or blocker.
    pub report_to: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, JsonSchema, Serialize)]
pub struct CapyThreadSpawnGetParams {
    pub thread_id: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CapyBindingState {
    Pending,
    Bound,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, JsonSchema, Deserialize)]
pub struct CapyBinding {
    pub state: CapyBindingState,
    /// Present only once `state` is `bound`.
    pub agent: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, JsonSchema, Deserialize)]
pub struct CapyThreadSpawn {
    pub thread_id: String,
    pub title: Option<String>,
    pub status: String,
    pub binding: CapyBinding,
}
