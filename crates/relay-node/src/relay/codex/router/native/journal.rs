//! Native mode survives retries, restarts, opt-out, and window replacement.
use crate::relay::outbox::{create_private_dir, write_atomic};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::Path;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(super) enum State {
    Unsent,
    /// This message had already entered a peer transport; observe it only.
    Peer,
    InDoubt,
    Started,
    Refused,
}

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Entry {
    pub thread: String,
    pub message_id: String,
    pub text_hash: String,
    pub owner: Option<String>,
    pub state: State,
}

#[derive(Default, Serialize, Deserialize)]
pub(super) struct Journal {
    entries: Vec<Entry>,
}

impl Journal {
    pub fn entry(&mut self, thread: &str, id: &str) -> Option<&mut Entry> {
        self.entries
            .iter_mut()
            .find(|entry| entry.thread == thread && entry.message_id == id)
    }

    pub fn validate_scope(&self, thread: &str, id: &str) -> Result<(), String> {
        if self.entries.len() > 1
            || self
                .entries
                .first()
                .is_some_and(|entry| entry.thread != thread || entry.message_id != id)
        {
            return Err("The native Codex receipt belongs to another message.".into());
        }
        Ok(())
    }

    pub fn claim(&mut self, thread: &str, id: &str, text_hash: &str) -> Result<Entry, String> {
        self.validate_scope(thread, id)?;
        if let Some(entry) = self.entry(thread, id) {
            if entry.text_hash != text_hash {
                return Err("The native Codex message no longer matches its saved receipt.".into());
            }
            return Ok(entry.clone());
        }
        let entry = Entry {
            thread: thread.into(),
            message_id: id.into(),
            text_hash: text_hash.into(),
            owner: None,
            state: State::Unsent,
        };
        self.entries.push(entry.clone());
        Ok(entry)
    }
}

fn private_file(path: &Path, create: bool) -> std::io::Result<std::fs::File> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.is_file() => {
            return Err(std::io::Error::other(
                "Native Codex receipt is not a regular file.",
            ))
        }
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error),
        _ => {}
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(create).create(create);
    crate::platform::fs::private(&mut options);
    let file = crate::platform::fs::no_follow(&mut options).open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || !crate::platform::fs::owned_by_current_user(&metadata)
        || !crate::platform::fs::private_to_owner(&metadata, 0o077)
    {
        return Err(std::io::Error::other(
            "Native Codex receipt is not private.",
        ));
    }
    Ok(file)
}

/// Never recover malformed receipts as an empty journal: an uncertain native
/// write must not become a second native turn or an ordinary peer delivery.
pub(super) fn edit<T>(
    path: &Path,
    action: impl FnOnce(&mut Journal) -> Result<T, String>,
) -> Result<T, String> {
    let parent = path.parent().ok_or("Invalid native Codex receipt path.")?;
    create_private_dir(parent).map_err(|_| "Could not create native Codex receipt storage.")?;
    let lock = private_file(&path.with_extension("lock"), true)
        .map_err(|_| "Could not open native Codex receipt lock.")?;
    lock.lock_exclusive()
        .map_err(|_| "Could not lock native Codex receipts.")?;
    let mut journal = match private_file(path, false) {
        Ok(file) => {
            let mut bytes = Vec::new();
            file.take(16 * 1024 + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| "Could not read native Codex receipts.")?;
            if bytes.len() > 16 * 1024 {
                return Err("The native Codex receipt is oversized.".into());
            }
            let saved: Journal = serde_json::from_slice(&bytes)
                .map_err(|_| "Could not decode native Codex receipts.")?;
            if saved.entries.len() != 1 {
                return Err("The native Codex receipt is incomplete.".into());
            }
            saved
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Journal::default(),
        Err(_) => return Err("Could not read native Codex receipts.".into()),
    };
    let before =
        serde_json::to_vec(&journal).map_err(|_| "Could not encode native Codex receipts.")?;
    let result = action(&mut journal)?;
    let after =
        serde_json::to_vec(&journal).map_err(|_| "Could not encode native Codex receipts.")?;
    if before != after {
        write_atomic(path, &after).map_err(|_| "Could not persist native Codex receipts.")?;
    }
    Ok(result)
}
