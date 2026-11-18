//! Forking a Grok session: a spawned agent that starts as a copy of another
//! Grok session on this computer, in that session's folder, with its whole
//! conversation. Grok copies it itself (`_x.ai/session/fork`, which leaves
//! the source as it was); the new leader then loads the copy and gives it
//! its first task, as it would a new session.
//!
//! Grok keeps a session under `<grok home>/sessions/<its folder,
//! percent-encoded>/<id>/`, and the fork must name that folder, so the
//! source's is found first (`directory`): from the spawn record for an
//! agent this node started, else from the `summary.json` Grok writes beside
//! the session.

use super::leader::{answer, ForkFrom, OpenError};
use super::{record, GrokAdapter, DESCRIPTOR};
use crate::relay::existing_session::grok::{loaded_session_id, LeaderClient};
use crate::relay::existing_session::platform::{self, OpenOptionsExt};
use crate::relay::existing_session::Outcome;
use crate::relay::grok::{decode_component, GrokConfig};
pub(super) use crate::relay::spawn::fork::FOLDER_GONE;
use crate::relay::spawn::launch::{Launch, LaunchError};
use crate::relay::store::{is_uuid, SessionKind, Target};
use serde_json::{json, Value};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant};

/// Grok answers `_x.ai/session/fork` with JSON-RPC's "method not found"
/// when it predates forking.
const METHOD_NOT_FOUND: i64 = -32601;
/// And with "internal error" when it has no such session to copy.
const INTERNAL_ERROR: i64 = -32603;

pub(super) const TOO_OLD: &str = "spawn_fork_unavailable: Grok on this computer is too old to fork sessions. Update it with `grok update`, then try again.";
pub(super) const NOT_FOUND: &str =
    "spawn_fork_not_found: Grok on this computer has no saved session to copy";
pub(super) const FAILED: &str =
    "spawn_fork_unavailable: Grok on this computer could not copy the session";

/// How many of Grok's session folders are looked through for a session.
const MAX_FOLDERS: usize = 4096;
/// The largest `summary.json` read.
const SUMMARY_LIMIT: u64 = 1024 * 1024;
/// How long Grok is given to remove a copy a failed fork left.
const DISCARD_TIMEOUT: Duration = Duration::from_secs(3);

/// The session `launch` copies, if it is a fork: only a Grok session id,
/// which is what Grok files a session under.
pub(super) fn source(launch: &Launch) -> Result<Option<ForkFrom<'_>>, LaunchError> {
    let Some(session_id) = launch.fork.as_deref() else {
        return Ok(None);
    };
    let source = ForkFrom {
        session_id,
        cwd: &launch.directory,
    };
    check_source(source).map_err(|_| LaunchError::Fork(FAILED.into()))?;
    Ok(Some(source))
}

/// Refuses a source that cannot be a Grok session before anything is sent.
pub(super) fn check_source(source: ForkFrom) -> Result<(), OpenError> {
    if is_uuid(source.session_id) && source.cwd.is_absolute() {
        Ok(())
    } else {
        Err(OpenError::Fork(FAILED.into()))
    }
}

/// Copies `source` into a new session in `directory` and loads it on the
/// leader: the copy's id. Each call has its own `timeout`.
pub(super) fn copy(
    client: &mut LeaderClient,
    source: ForkFrom,
    directory: &Path,
    timeout: Duration,
) -> Result<String, OpenError> {
    // Checked after the leader answered, just before Grok is asked: a
    // folder that went since the lookup has no session left to copy.
    if !source.cwd.is_dir() || !directory.is_dir() {
        return Err(OpenError::Fork(FOLDER_GONE.into()));
    }
    let params = json!({
        "sourceSessionId": source.session_id,
        "sourceCwd": source.cwd,
        "newCwd": directory,
    });
    // Grok's own error text can name the session's files: only its code
    // is kept.
    let forked = match client.call("_x.ai/session/fork", params, Instant::now() + timeout) {
        Some(Ok(forked)) => forked,
        Some(Err(Some(METHOD_NOT_FOUND))) => return Err(OpenError::Fork(TOO_OLD.into())),
        Some(Err(Some(INTERNAL_ERROR))) => return Err(OpenError::Fork(NOT_FOUND.into())),
        Some(Err(_)) | None => return Err(OpenError::Fork(FAILED.into())),
    };
    let copied = forked["newSessionId"]
        .as_str()
        .filter(|id| is_uuid(id) && *id != source.session_id)
        .ok_or(OpenError::Fork(FAILED.into()))?
        .to_owned();
    // Loaded always-approving, like a new session: nobody answers a
    // spawned agent's prompts.
    let params = json!({
        "sessionId": copied, "cwd": directory, "mcpServers": [], "_meta": {"yoloMode": true},
    });
    let loaded = answer(client.request("session/load", params, Instant::now() + timeout));
    if loaded
        .ok()
        .and_then(|loaded| loaded_session_id(&loaded))
        .as_deref()
        != Some(copied.as_str())
    {
        discard(client, source, &copied, directory);
        return Err(OpenError::Fork(FAILED.into()));
    }
    Ok(copied)
}

/// Asks Grok to remove `copied`, the copy of `source` it made in
/// `directory`, when the fork fails after the copy was made. Only a copy
/// Grok named, never the source. Best effort: the answer is not read,
/// because Grok reports success for a removal that did nothing too (an
/// unknown session, or another folder), and an older Grok does not know
/// the method.
pub(super) fn discard(client: &mut LeaderClient, source: ForkFrom, copied: &str, directory: &Path) {
    if !is_uuid(copied) || copied == source.session_id {
        return;
    }
    let params = json!({"sessionId": copied, "cwd": directory});
    let _ = client.call(
        "_x.ai/session/delete",
        params,
        Instant::now() + DISCARD_TIMEOUT,
    );
}

/// Removes the copy when its first task was not taken, as `launch` then
/// fails the spawn.
pub(super) fn settle(
    client: &mut LeaderClient,
    source: ForkFrom,
    copied: &str,
    directory: &Path,
    outcome: &Outcome,
) {
    if matches!(
        outcome,
        Outcome::Retry(_) | Outcome::Waiting(_) | Outcome::Refused(_)
    ) {
        discard(client, source, copied, directory);
    }
}

/// The folder `target`'s session ran in, when it is a Grok session the
/// leaders spawned here can copy: one in the Grok home they run with.
pub(super) fn directory(grok: &GrokAdapter, target: &Target) -> Option<PathBuf> {
    if platform::unsupported(DESCRIPTOR.label).is_some()
        || !matches!(target.kind, SessionKind::Grok | SessionKind::GrokOpen)
        || !is_uuid(&target.id)
    {
        return None;
    }
    let home = grok
        .leader_environment(true, "")
        .get("GROK_HOME")
        .map(|home| PathBuf::from(home.trim()))
        .filter(|home| home.is_absolute())
        .unwrap_or_else(|| grok.grok.home.clone());
    let directory = match record::read(&grok.folder, &target.id) {
        Some(spawned) if spawned.grok_home == home => spawned.binding.cwd,
        Some(_) => return None,
        None => saved_directory(&home, &target.id)?,
    };
    plain_absolute(&directory).then_some(directory)
}

/// The folder Grok's own summary of session `id` names, found under the
/// folder Grok filed it in. An older summary names none (it has no `info`):
/// the folder it is filed under, decoded, is then the session's. Folders and
/// files that are links are passed over, so nothing outside `home` is read.
pub(super) fn saved_directory(home: &Path, id: &str) -> Option<PathBuf> {
    if !is_uuid(id) {
        return None;
    }
    let sessions = home.join("sessions");
    if !real_directory(&sessions) {
        return None;
    }
    let config = GrokConfig {
        home: home.to_path_buf(),
    };
    std::fs::read_dir(&sessions)
        .ok()?
        .take(MAX_FOLDERS)
        .filter_map(Result::ok)
        .find_map(|entry| {
            let session = entry.path().join(id);
            if !real_directory(&entry.path()) || !real_directory(&session) {
                return None;
            }
            let summary = read_summary(&session.join("summary.json"))?;
            let cwd = match summary.as_object()?.get("info") {
                Some(info) => info["cwd"]
                    .as_str()
                    .filter(|_| info["id"] == id)?
                    .to_owned(),
                None => decode_component(entry.file_name().to_str()?)?,
            };
            // A summary filed under another folder than the one it names,
            // or a folder name Grok would not have written, is not where
            // Grok would look for the session.
            (config.session_dir(&cwd, id) == session && plain_absolute(Path::new(&cwd)))
                .then(|| PathBuf::from(cwd))
        })
}

fn real_directory(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_dir())
}

/// An absolute folder that does not climb out of itself.
fn plain_absolute(path: &Path) -> bool {
    path.is_absolute()
        && path
            .components()
            .all(|component| component != Component::ParentDir)
}

/// A regular file of at most `SUMMARY_LIMIT` bytes, as JSON; never through
/// a link, and never waiting on a pipe.
fn read_summary(path: &Path) -> Option<Value> {
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(platform::O_NOFOLLOW | platform::O_NONBLOCK)
        .open(path)
        .ok()?;
    if !file.metadata().ok()?.is_file() {
        return None;
    }
    let mut data = Vec::new();
    file.take(SUMMARY_LIMIT + 1).read_to_end(&mut data).ok()?;
    if data.len() as u64 > SUMMARY_LIMIT {
        return None;
    }
    serde_json::from_slice(&data).ok()
}

// Its fixtures are shell scripts and Unix sockets.
#[cfg(test)]
#[cfg(unix)]
mod tests;
