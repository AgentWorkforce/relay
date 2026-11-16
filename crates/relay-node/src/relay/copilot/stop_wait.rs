//! Bounded native control records release a waiting stop hook after cancellation.
//! This never ingests history or claims a delivery. The native input timestamp
//! anchors this invocation, so an earlier abort cannot cancel a later wait.
use super::CopilotConfig;
use serde::Deserialize;
use serde_json::{json, Value};
use std::fs::{File, Metadata, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;

const LIMIT: u64 = 64 << 10;
// Startup may find a stop behind an already-flushed model batch. Subsequent
// reads start at that exact control record, not a moving history tail. Keep
// every read bounded even if the journal is damaged or grows unexpectedly.
const MAX_SCAN: u64 = 64 << 20;

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

/// Copilot queues hook lifecycle records for asynchronous persistence. Its
/// command can start before its own hook.start reaches events.jsonl. Wait for
/// that exact anchor before asking Core to check cancellation; an absent anchor
/// must never authorize a delivery. Keep the first file incarnation and the
/// greatest successfully read length throughout.
pub(crate) fn started_snapshot(config: &CopilotConfig, sid: &str, timestamp: u64) -> Option<Value> {
    let until = std::time::Instant::now() + std::time::Duration::from_secs(5);
    snapshot_after_start(config, sid, timestamp, || {
        if std::time::Instant::now() >= until {
            return false;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
        true
    })
}

fn snapshot_after_start(
    config: &CopilotConfig,
    sid: &str,
    timestamp: u64,
    mut retry: impl FnMut() -> bool,
) -> Option<Value> {
    let mut stamp = snapshot(config, sid)?;
    let mut search = stamp.clone();
    search["offset"] = json!(stamp["length"].as_u64()?.saturating_sub(MAX_SCAN / 2));
    loop {
        let (offset, tail) = bytes(config, sid, &search)?;
        // Retain every observed append, including an abort alongside a delayed
        // anchor. A later truncation must not erase that cancellation evidence.
        stamp["length"] = json!(offset.checked_add(tail.len() as u64)?);
        search["length"] = stamp["length"].clone();
        // Both an active and a cancelled anchor are ready for Core: it still
        // makes the cancellation decision, including any subsequent appends.
        if let Some((_, anchor)) = scan_at(&tail, sid, timestamp) {
            stamp["offset"] = json!(offset.checked_add(anchor)?);
            return Some(stamp);
        }
        // Scan the lookback only once. Resume at the last complete record so
        // an asynchronously persisted partial anchor is still read in full.
        if let Some(last) = tail.iter().rposition(|byte| *byte == b'\n') {
            search["offset"] = json!(offset.checked_add(last as u64 + 1)?);
        }
        if !retry() {
            return None;
        }
    }
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

fn bytes(config: &CopilotConfig, sid: &str, stamp: &Value) -> Option<(u64, Vec<u8>)> {
    let path = path(config, sid)?;
    let mut file = open(&path)?;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file()
        || identity(&metadata)? != stamp["identity"]
        || metadata.len() < stamp["length"].as_u64()?
    {
        return None;
    }
    let bytes = match stamp.get("offset") {
        Some(offset) => read_at(&mut file, metadata.len(), offset.as_u64()?)?,
        None => read_tail_at(&mut file, metadata.len())?,
    };
    let offset = metadata.len().checked_sub(bytes.len() as u64)?;
    let after = std::fs::symlink_metadata(path).ok()?;
    if !after.is_file() || identity(&after)? != stamp["identity"] || after.len() < metadata.len() {
        return None;
    }
    Some((offset, bytes))
}

fn read_at(file: &mut File, length: u64, start: u64) -> Option<Vec<u8>> {
    let size = length.checked_sub(start).filter(|size| *size <= MAX_SCAN)?;
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = Vec::new();
    file.take(size).read_to_end(&mut bytes).ok()?;
    // A short read is not a complete view of the metadata snapshot.
    (bytes.len() as u64 == size).then_some(bytes)
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
    // Appends after the metadata snapshot belong to the next poll. Reading
    // past that bound must not turn an ordinary append into cancellation.
    let mut bytes = read_at(file, length, start)?;
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

#[cfg(test)]
fn scan(bytes: &[u8], sid: &str, timestamp: u64) -> Option<bool> {
    scan_at(bytes, sid, timestamp).map(|(cancelled, _)| cancelled)
}

fn scan_at(bytes: &[u8], sid: &str, timestamp: u64) -> Option<(bool, u64)> {
    #[derive(Deserialize)]
    struct Kind {
        #[serde(rename = "type")]
        kind: String,
    }
    let mut anchored = None;
    let mut offset = 0;
    // An incomplete last record can be an ordinary concurrent journal append.
    for line in bytes
        .split_inclusive(|b| *b == b'\n')
        .filter(|l| l.ends_with(b"\n"))
    {
        let here = offset;
        offset += line.len() as u64;
        // Validate opaque model records without constructing their history
        // payloads. Only a hook.start needs its small control fields decoded.
        let object = line.iter().copied().find(|b| !b.is_ascii_whitespace()) == Some(b'{');
        let parsed = if object {
            serde_json::from_slice::<Kind>(line).ok()
        } else {
            None
        };
        let kind = match parsed {
            Some(value) => value.kind,
            _ if anchored.is_some() => return Some((true, anchored?)),
            _ => continue,
        };
        let event = (kind == "hook.start")
            .then(|| serde_json::from_slice::<Value>(line).ok())
            .flatten();
        if anchored.is_none() {
            if event.as_ref().is_some_and(|e| anchor(e, sid, timestamp)) {
                anchored = Some(here);
            }
            continue;
        }
        if matches!(kind.as_str(), "abort" | "user.message" | "session.error")
            || event
                .as_ref()
                .is_some_and(|e| e["data"]["hookType"] == "agentStop")
        {
            return Some((true, anchored?));
        }
    }
    anchored.map(|offset| (false, offset))
}

/// Unverifiable/replaced/truncated journals release the waiter quietly. Returning
/// true is only a refusal to claim a message, never authority to send or read one.
pub(crate) fn cancelled(config: &CopilotConfig, sid: &str, payload: &Value) -> bool {
    (|| {
        let timestamp = payload["timestamp"].as_u64()?;
        let (_, bytes) = bytes(config, sid, &payload["relayJournal"])?;
        scan_at(&bytes, sid, timestamp).map(|(cancelled, _)| cancelled)
    })()
    .unwrap_or(true)
}

#[cfg(test)]
mod tests;
