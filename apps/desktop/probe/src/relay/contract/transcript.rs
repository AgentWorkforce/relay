//! Local transcript browsing. Reading never changes upload selection.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct LocalTranscriptParams {
    pub source: String,
    pub session_id: String,
    pub cursor: Option<LocalTranscriptCursor>,
    /// Background follow read, even when there is no cursor yet.
    #[serde(default)]
    pub following: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct LocalTranscriptCursor {
    pub ts_ms: i64,
    pub id: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct LocalTranscriptPage {
    pub entries: Vec<LocalTranscriptEntry>,
    pub next_cursor: Option<LocalTranscriptCursor>,
    /// Where what is written after this page starts: reading from it
    /// follows a transcript still being written. Only `agents.transcript`
    /// sets it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub follow_cursor: Option<LocalTranscriptCursor>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct LocalTranscriptEntry {
    pub id: String,
    pub role: String,
    /// text, thinking, tool_use, tool_result, or context.
    pub kind: String,
    pub text: String,
    /// A copy from embedded transcript bytes in the private reader cache.
    pub image_path: Option<String>,
    pub timestamp_ms: i64,
    pub truncated: bool,
}
