//! Joining and taking over an agent Agent Relay spawned here
//! (`relay::spawn::handover`): following what it says from the app, and
//! handing its session to an interactive client.

use super::transcript::LocalTranscriptCursor;
use crate::relay::store::Target;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// What the apps may do with a session Agent Relay spawned, as
/// `sessions.list` reports it on its registration.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, JsonSchema, Deserialize)]
pub struct SessionSpawn {
    /// The harness's id, such as `claude`.
    pub harness: String,
    /// Agent Relay runs it headless and it can be handed to an interactive
    /// client (`agents.take_over`); until then its transcript is its own
    /// output (`agents.transcript`), and resuming it elsewhere is never
    /// offered. `false` for a harness whose sessions its own app opens live
    /// (Codex), and once taken over.
    pub can_take_over: bool,
    /// It was taken over: its headless process was stopped, and the session
    /// is the person's to run in an interactive client, under the same name.
    pub taken_over: bool,
}

/// `agents.transcript`'s parameters: a spawned agent by name, read from
/// `cursor` on (from the start without one).
#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize)]
pub struct AgentTranscriptParams {
    pub name: String,
    pub cursor: Option<LocalTranscriptCursor>,
}

/// `agents.take_over`'s parameters.
#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize)]
pub struct TakeOverParams {
    pub name: String,
    /// Stop it now, in the middle of a turn if one runs; without it the core
    /// waits for the turn to end first. A second call with `interrupt` while
    /// one waits makes that one stop it at once.
    #[serde(default)]
    pub interrupt: bool,
}

/// `agents.take_over`'s result: its headless process has stopped, and its
/// session is the person's to resume.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, JsonSchema, Deserialize)]
pub struct TakenOver {
    pub name: String,
    /// Its session, which resuming continues under the same id.
    pub target: Target,
    /// The folder the session ran in, to resume it there; `None` when it is
    /// not known.
    pub directory: Option<String>,
    /// A turn was running and was interrupted.
    pub interrupted: bool,
}
