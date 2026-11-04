//! Joining and taking over a spawned Claude. Its transcript is its own
//! stream-json output (`<logs>/<session id>.jsonl`), which shows the turn as
//! it runs, before Claude Code writes its session file. Its session, before
//! and after a take over, is the one Claude Code's registry lists under the
//! session id: `claude --resume <id>` continues the session under that id,
//! in a new process.
//!
//! A transcript cursor's `id` is the byte offset of a line in the log, and
//! its `ts_ms` the first content block of that line still to read: a page
//! ends within an event whose entries do not fit in it.

use super::ClaudeAdapter;
use crate::relay::claude as claude_code;
use crate::relay::contract::transcript::{
    LocalTranscriptCursor, LocalTranscriptEntry, LocalTranscriptPage,
};
use crate::relay::harness::{HandoverFacet, RunningSession};
use crate::relay::spawn::launch::SpawnedProcess;
use crate::relay::store::Target;
use serde_json::Value;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// About how much of the log one page reads, and the most its entries
/// take serialized: the bridge accepts 1 MiB frames, and one entry, cut
/// at `ENTRY_CHARS`, always fits.
pub const PAGE_BYTES: u64 = 512 * 1024;
/// The most text one entry carries; longer is cut and marked truncated.
pub const ENTRY_CHARS: usize = 64 * 1024;

impl HandoverFacet for ClaudeAdapter {
    fn transcript(
        &self,
        target: &Target,
        cursor: Option<&LocalTranscriptCursor>,
    ) -> Result<LocalTranscriptPage, String> {
        read_page(&self.logs.join(format!("{}.jsonl", target.id)), cursor)
    }

    fn session(&self, target: &Target) -> Option<RunningSession> {
        let session = claude_code::terminal_session(&self.claude, self.table.as_ref(), &target.id)?;
        let process = self.table.process(session.pid).map(SpawnedProcess::of)?;
        Some(RunningSession {
            process,
            directory: session.cwd.map(PathBuf::from),
        })
    }
}

/// The entries of the complete lines from `cursor` on, about a page of
/// them. A line still being written is left for the next read;
/// `follow_cursor` is where that read starts.
pub fn read_page(
    log: &Path,
    cursor: Option<&LocalTranscriptCursor>,
) -> Result<LocalTranscriptPage, String> {
    let start = cursor.map_or(0, |cursor| u64::try_from(cursor.id).unwrap_or(0));
    let mut skip = cursor.map_or(0, |cursor| usize::try_from(cursor.ts_ms).unwrap_or(0));
    let unreadable = |error: std::io::Error| format!("could not read {}: {error}", log.display());
    let file = match std::fs::File::open(log) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(page(Vec::new(), None, (start, skip)))
        }
        Err(error) => return Err(unreadable(error)),
    };
    let written_ms = file
        .metadata()
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|at| at.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |at| i64::try_from(at.as_millis()).unwrap_or(i64::MAX));
    let mut reader = BufReader::new(file);
    reader.seek(SeekFrom::Start(start)).map_err(unreadable)?;
    let (mut offset, mut line) = (start, Vec::new());
    let mut entries = Entries::default();
    loop {
        if offset - start >= PAGE_BYTES {
            return Ok(page(entries.taken, Some((offset, 0)), (offset, 0)));
        }
        line.clear();
        let read = reader.read_until(b'\n', &mut line).map_err(unreadable)?;
        if read == 0 || line.last() != Some(&b'\n') {
            return Ok(page(entries.taken, None, (offset, skip)));
        }
        if let Ok(event) = serde_json::from_slice::<Value>(&line) {
            let shown = event_entries(offset, &event, written_ms);
            for (index, entry) in shown.into_iter().filter(|(index, _)| *index >= skip) {
                if !entries.take(entry) {
                    let next = (offset, index);
                    return Ok(page(entries.taken, Some(next), next));
                }
            }
        }
        offset += read as u64;
        skip = 0;
    }
}

/// The entries of one page, within `PAGE_BYTES` serialized.
#[derive(Default)]
struct Entries {
    taken: Vec<LocalTranscriptEntry>,
    bytes: u64,
}

impl Entries {
    /// Adds `entry` unless it would take the page past `PAGE_BYTES`; the
    /// first entry is always added, so every page reads something.
    fn take(&mut self, entry: LocalTranscriptEntry) -> bool {
        let size = serde_json::to_vec(&entry).map_or(0, |bytes| bytes.len() as u64);
        if !self.taken.is_empty() && self.bytes + size > PAGE_BYTES {
            return false;
        }
        self.bytes += size;
        self.taken.push(entry);
        true
    }
}

/// A page, with cursors at `(line offset, content block)` positions.
fn page(
    entries: Vec<LocalTranscriptEntry>,
    next: Option<(u64, usize)>,
    follow: (u64, usize),
) -> LocalTranscriptPage {
    let cursor = |(offset, block): (u64, usize)| LocalTranscriptCursor {
        ts_ms: i64::try_from(block).unwrap_or(i64::MAX),
        id: i64::try_from(offset).unwrap_or(i64::MAX),
    };
    LocalTranscriptPage {
        entries,
        next_cursor: next.map(cursor),
        follow_cursor: Some(cursor(follow)),
    }
}

/// The entries one stream-json event shows, each with its content block;
/// `offset` is where its line starts, which keeps every entry's id stable
/// across reads.
pub fn event_entries(
    offset: u64,
    event: &Value,
    written_ms: i64,
) -> Vec<(usize, LocalTranscriptEntry)> {
    let at = event["timestamp"]
        .as_str()
        .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
        .map_or(written_ms, |at| at.timestamp_millis());
    let entry = |index: usize, role: &str, kind: &str, text: String| {
        let truncated = text.chars().count() > ENTRY_CHARS;
        let entry = LocalTranscriptEntry {
            id: format!("{offset}.{index}"),
            role: role.into(),
            kind: kind.into(),
            text: if truncated {
                text.chars().take(ENTRY_CHARS).collect()
            } else {
                text
            },
            image_path: None,
            timestamp_ms: at,
            truncated,
        };
        (index, entry)
    };
    let role = match event["type"].as_str() {
        Some("assistant") => "assistant",
        Some("user") => "user",
        Some("result") if event["is_error"] == Value::Bool(true) => {
            let reason = event["result"]
                .as_str()
                .or_else(|| event["subtype"].as_str())
                .unwrap_or("unknown");
            let text = format!("The turn ended with an error: {reason}");
            return vec![entry(0, "assistant", "context", text)];
        }
        _ => return Vec::new(),
    };
    let content = &event["message"]["content"];
    if let Some(text) = content.as_str() {
        return vec![entry(0, role, "text", text.to_string())];
    }
    content
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
        .filter_map(|(index, block)| {
            let (kind, text) = block_text(block)?;
            Some(entry(index, role, kind, text))
        })
        .collect()
}

/// One content block's kind and text; `None` for one the apps do not show.
fn block_text(block: &Value) -> Option<(&'static str, String)> {
    let text = |key: &str| block[key].as_str().map(str::to_string);
    match block["type"].as_str()? {
        "text" => Some(("text", text("text")?)),
        "thinking" => Some(("thinking", text("thinking")?)),
        "tool_use" => {
            let name = block["name"].as_str().unwrap_or("tool");
            Some(("tool_use", format!("{name} {}", block["input"])))
        }
        "tool_result" => {
            let content = &block["content"];
            let text = content.as_str().map(str::to_string).unwrap_or_else(|| {
                content
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|part| part["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("\n")
            });
            Some(("tool_result", text))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests;
