//! The core's own methods and the event payloads.

use crate::relay::protocol::Topic;
use crate::relay::state::{Level, Listing, Status};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize)]
pub struct HelloParams {
    /// The bridge version the client speaks.
    pub bridge_version: u32,
}

#[derive(Clone, Debug, Serialize, JsonSchema, Deserialize)]
pub struct HelloResult {
    pub bridge_version: u32,
    pub daemon_version: String,
    pub pid: u32,
    /// Every method this core answers; clients feature-detect with it.
    pub methods: Vec<String>,
    pub topics: Vec<Topic>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize)]
pub struct TopicsParams {
    pub topics: Vec<Topic>,
}

#[derive(Clone, Debug, Serialize, JsonSchema, Deserialize)]
pub struct Subscribed {
    /// Every topic the connection is now subscribed to.
    pub topics: Vec<Topic>,
    /// The snapshot to render now; later `status` events carry a higher
    /// revision.
    pub status: Status,
}

#[derive(Clone, Debug, Serialize, JsonSchema, Deserialize)]
pub struct Unsubscribed {
    /// The topics that remain subscribed.
    pub topics: Vec<Topic>,
}

#[derive(Clone, Debug, Serialize, JsonSchema, Deserialize)]
pub struct Stopping {
    pub stopping: bool,
}

/// The `activity` topic: one line for the UI's log.
#[derive(Clone, Debug, PartialEq, Serialize, JsonSchema, Deserialize)]
pub struct ActivityLine {
    pub level: Level,
    pub message: String,
    pub at_ms: i64,
}

/// The `shutdown` topic: the connection closes after it.
#[derive(Clone, Debug, PartialEq, Serialize, JsonSchema, Deserialize)]
pub struct ShutdownNotice {}

/// The `invalidated` topic: re-fetch `what`.
#[derive(Clone, Debug, PartialEq, Serialize, JsonSchema, Deserialize)]
pub struct Invalidation {
    pub what: Listing,
}

/// The `notify` topic: a notification for the UI to show.
#[derive(Clone, Debug, PartialEq, Serialize, JsonSchema, Deserialize)]
pub struct CoreNotification {
    pub title: String,
    pub body: String,
    /// Opens on click, e.g. a provider's connect page.
    pub link: Option<String>,
}
