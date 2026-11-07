//! Bounded native control records release a waiting stop hook after cancellation.
//! This never ingests history or claims a delivery. The native input timestamp
//! anchors this invocation, so an earlier abort cannot cancel a later wait.
use super::CopilotConfig;
use serde_json::{json, Value};
use std::fs::{File, Metadata, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;

const LIMIT: u64 = 64 << 10;

fn path(config: &CopilotConfig, sid: &str) -> Option<PathBuf> {
    crate::relay::store::is_uuid(sid).then(|| config.sessions().join(sid).join("events.jsonl"))
}

#[cfg(unix)]
fn identity(metadata: &Metadata) -> Option<Value> {
    use std::os::unix::fs::MetadataExt;
    Some(json!([metadata.dev(), metadata.ino()]))
}

// Messaging is unavailable on Windows today. Keep the control reader portable;
// creation time is its file incarnation, as for the Codex rollout reader.
#[cfg(windows)]
fn identity(metadata: &Metadata) -> Option<Value> {
    let created = metadata
        .created()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?;
    Some(json!([created.as_secs(), created.subsec_nanos()]))
}

pub(crate) fn snapshot(config: &CopilotConfig, sid: &str) -> Option<Value> {
    let metadata = std::fs::symlink_metadata(path(config, sid)?).ok()?;
    metadata.is_file().then_some(())?;
    Some(json!({"identity":identity(&metadata)?,"length":metadata.len()}))
}

fn open(path: &std::path::Path) -> Option<File> {
    std::fs::symlink_metadata(path)
        .ok()?
        .is_file()
        .then_some(())?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    options.open(path).ok()
}

fn bytes(config: &CopilotConfig, sid: &str, stamp: &Value) -> Option<Vec<u8>> {
    let path = path(config, sid)?;
    let mut file = open(&path)?;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file()
        || identity(&metadata)? != stamp["identity"]
        || metadata.len() < stamp["length"].as_u64()?
    {
        return None;
    }
    let bytes = read_tail_at(&mut file, metadata.len())?;
    let after = std::fs::symlink_metadata(path).ok()?;
    if !after.is_file() || identity(&after)? != stamp["identity"] || after.len() < metadata.len() {
        return None;
    }
    Some(bytes)
}

fn read_tail_at(file: &mut File, length: u64) -> Option<Vec<u8>> {
    let start = length.saturating_sub(LIMIT);
    let trim = if start > 0 {
        file.seek(SeekFrom::Start(start - 1)).ok()?;
        let mut previous = [0];
        file.read_exact(&mut previous).ok()?;
        previous[0] != b'\n'
    } else {
        false
    };
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = Vec::new();
    // Appends after the metadata snapshot belong to the next poll. Reading
    // past that bound must not turn an ordinary append into cancellation.
    file.take(length - start).read_to_end(&mut bytes).ok()?;
    if trim {
        let first = bytes.iter().position(|b| *b == b'\n')?;
        bytes.drain(..=first);
    }
    Some(bytes)
}

fn anchor(event: &Value, sid: &str, timestamp: u64) -> bool {
    event["type"] == "hook.start"
        && event["data"]["hookType"] == "agentStop"
        && event["data"]["input"]["sessionId"] == sid
        && event["data"]["input"]["timestamp"].as_u64() == Some(timestamp)
        && event["data"]["input"]["stopReason"] == "end_turn"
}

fn scan(bytes: &[u8], sid: &str, timestamp: u64) -> Option<bool> {
    let mut anchored = false;
    // An incomplete last record can be an ordinary concurrent journal append.
    for line in bytes
        .split_inclusive(|b| *b == b'\n')
        .filter(|l| l.ends_with(b"\n"))
    {
        let event: Value = match serde_json::from_slice::<Value>(line) {
            Ok(value) if value.is_object() && value["type"].is_string() => value,
            _ if anchored => return Some(true),
            _ => continue,
        };
        if !anchored {
            anchored = anchor(&event, sid, timestamp);
            continue;
        }
        if matches!(
            event["type"].as_str(),
            Some("abort" | "user.message" | "session.error")
        ) || (event["type"] == "hook.start" && event["data"]["hookType"] == "agentStop")
        {
            return Some(true);
        }
    }
    anchored.then_some(false)
}

/// Unverifiable/replaced/truncated journals release the waiter quietly. Returning
/// true is only a refusal to claim a message, never authority to send or read one.
pub(crate) fn cancelled(config: &CopilotConfig, sid: &str, payload: &Value) -> bool {
    (|| {
        let timestamp = payload["timestamp"].as_u64()?;
        let bytes = bytes(config, sid, &payload["relayJournal"])?;
        scan(&bytes, sid, timestamp)
    })()
    .unwrap_or(true)
}

#[cfg(test)]
mod tests;
