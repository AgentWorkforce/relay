//! What the core keeps of each spawned Grok, and what Grok itself writes
//! about the session's turns.
//!
//! One private folder, `<app data>/spawned-agents/grok` (mode 0700), holds a
//! record per session (`<session id>.json`, mode 0600): the leader binding
//! delivery proves before every message, and the Grok home the session is
//! kept in. The leader's marker is not in it: only the leader's own
//! environment holds that, and the binding's credential reference is a
//! digest of it.

use crate::relay::existing_session::platform::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use crate::relay::existing_session::Binding;
use crate::relay::grok::GrokConfig;
use crate::relay::state::WorkState;
use crate::relay::store::is_uuid;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

/// A spawned Grok session, as the core recorded it once its leader was
/// proven.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpawnedGrok {
    pub binding: Binding,
    /// The Grok home the leader was started with, where Grok keeps the
    /// session (`sessions/<folder>/<session id>/`).
    pub grok_home: PathBuf,
}

impl SpawnedGrok {
    /// The leader process, by pid and start time.
    pub fn leader(&self) -> crate::relay::spawn::launch::SpawnedProcess {
        crate::relay::spawn::launch::SpawnedProcess {
            pid: self.binding.leader_pid,
            start: self.binding.leader_start,
        }
    }

    /// The session's turn events, which Grok appends to as it works.
    pub fn events(&self) -> PathBuf {
        let grok = GrokConfig {
            home: self.grok_home.clone(),
        };
        grok.session_dir(
            &self.binding.cwd.to_string_lossy(),
            &self.binding.session_id,
        )
        .join("events.jsonl")
    }
}

/// Makes `folder` if needed, and refuses one another user could read.
pub fn private_folder(folder: &Path) -> std::io::Result<()> {
    if let Some(parent) = folder.parent() {
        fs::create_dir_all(parent)?;
    }
    match fs::DirBuilder::new().mode(0o700).create(folder) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }
    let metadata = fs::symlink_metadata(folder)?;
    if !metadata.is_dir()
        || metadata.uid() != crate::relay::peer::current_uid()
        || metadata.mode() & 0o077 != 0
    {
        return Err(std::io::Error::new(
            ErrorKind::PermissionDenied,
            "the spawned Grok folder is not private",
        ));
    }
    Ok(())
}

/// Where the record of `session` is; `None` for anything that is not a
/// session id, so no other file is ever named.
fn path(folder: &Path, session: &str) -> Option<PathBuf> {
    is_uuid(session).then(|| folder.join(format!("{session}.json")))
}

/// Writes the record whole, replacing any earlier one.
pub fn write(folder: &Path, record: &SpawnedGrok) -> std::io::Result<()> {
    let path = path(folder, &record.binding.session_id)
        .ok_or_else(|| std::io::Error::new(ErrorKind::InvalidInput, "not a Grok session id"))?;
    let bytes = serde_json::to_vec(record).map_err(std::io::Error::other)?;
    let temporary = path.with_extension("json.tmp");
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&temporary)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    fs::rename(&temporary, &path)
}

/// The record of `session`, when the core made one.
pub fn read(folder: &Path, session: &str) -> Option<SpawnedGrok> {
    let bytes = fs::read(path(folder, session)?).ok()?;
    serde_json::from_slice::<SpawnedGrok>(&bytes)
        .ok()
        .filter(|record| record.binding.session_id == session)
}

/// Removes the record of `session`, if there is one.
pub fn remove(folder: &Path, session: &str) {
    if let Some(path) = path(folder, session) {
        let _ = fs::remove_file(path);
    }
}

/// What the end of a session's `events.jsonl` says: the last turn event
/// decides. `turn_ended` means no turn runs (idle); a permission asked and
/// not yet answered means it waits; any other turn event means a turn runs.
/// Session events between turns (MCP servers starting, say) say nothing.
/// `None` when no turn event is readable.
pub fn work_state(tail: &[u8]) -> Option<WorkState> {
    tail.split(|byte| *byte == b'\n')
        .rev()
        .filter_map(|line| serde_json::from_slice::<Value>(line).ok())
        .find_map(|event| turn_state(&event))
}

fn turn_state(event: &Value) -> Option<WorkState> {
    match event["type"].as_str()? {
        "turn_ended" => Some(WorkState::Idle),
        "permission_requested" => Some(WorkState::Waiting),
        "phase_changed" if event["phase"] == "permission_prompt" => Some(WorkState::Waiting),
        "turn_started"
        | "loop_started"
        | "first_token"
        | "phase_changed"
        | "tool_call_started"
        | "tool_call_completed"
        | "permission_resolved" => Some(WorkState::Working),
        _ => None,
    }
}
