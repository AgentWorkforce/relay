use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// A native session title, addressed by catalog source and original session id.
/// Paths and endpoints are resolved by the core, never supplied by a client.
#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SessionTitleIdentity {
    pub source: String,
    pub session_id: String,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SessionTitleSetParams {
    pub source: String,
    pub session_id: String,
    pub title: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize, JsonSchema, Serialize)]
pub struct SessionTitleCapability {
    pub supported: bool,
    /// A user-safe explanation when the native harness cannot be renamed.
    pub reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, JsonSchema, Serialize)]
pub struct SessionTitleUpdated {
    /// The canonical title acknowledged by the native harness.
    pub title: String,
}
