//! Claude Code's native `custom-title` record, the same append-only format
//! used by Anthropic's rename_session / renameSession SDK API. No session is
//! resumed and no hooks, tools or model inference run to change its title.
//! https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/sessions.py
use super::{supported, unsupported};
use crate::relay::claude::{ClaudeConfig, TerminalSession};
use crate::relay::contract::agents::SessionTitleCapability;
use crate::relay::existing_session::platform::MetadataExt;
use crate::relay::store::is_uuid;
use std::collections::BTreeSet;
use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;

fn transcript(config: &ClaudeConfig, id: &str) -> Result<PathBuf, String> {
    if !is_uuid(id) {
        return Err(
            "This Claude cloud session does not expose native title editing to Relay.".into(),
        );
    }
    let mut found = BTreeSet::new();
    for folder in config
        .dirs
        .watched(&config.home)
        .into_iter()
        .filter(|folder| folder.shared)
    {
        let Ok(root) = folder.path.join("projects").canonicalize() else {
            continue;
        };
        let Ok(projects) = fs::read_dir(&root) else {
            continue;
        };
        for project in projects.flatten() {
            // Only one-level project folders, never arbitrary symlink targets.
            if !project.file_type().is_ok_and(|kind| kind.is_dir()) {
                continue;
            }
            let path = project.path().join(format!("{id}.jsonl"));
            let Ok(meta) = fs::symlink_metadata(&path) else {
                continue;
            };
            if !meta.is_file() || !crate::platform::fs::owned_by_current_user(&meta) {
                continue;
            }
            if let Ok(real) = path.canonicalize() {
                if real.starts_with(&root) {
                    found.insert(real);
                }
            }
        }
    }
    if found.len() > 1 {
        return Err(
            "This Claude session appears in multiple config folders; rename it in Claude.".into(),
        );
    }
    found
        .into_iter()
        .next()
        .ok_or_else(|| "This Claude session has no writable local transcript.".into())
}

#[derive(Clone)]
struct ObservedTitle {
    device: u64,
    inode: u64,
    length: u64,
    complete_end: u64,
    modified: (i64, i64),
    title: Option<String>,
}

pub(crate) fn display_title(config: &ClaudeConfig, session: &TerminalSession) -> String {
    native_title(config, &session.session_id).unwrap_or_else(|| session.display_name())
}

/// Live Claude registry names can lag the SDK's native metadata mutation.
/// Recover the latest native record anywhere in the transcript on a cold read;
/// subsequent append-only reads inspect only bytes after the last complete line.
/// This cache contains observed native metadata, never a persisted Relay alias.
pub(crate) fn native_title(config: &ClaudeConfig, id: &str) -> Option<String> {
    use std::sync::{Mutex, OnceLock};
    static OBSERVED: OnceLock<Mutex<std::collections::HashMap<PathBuf, ObservedTitle>>> =
        OnceLock::new();
    let path = transcript(config, id).ok()?;
    let mut file = crate::platform::fs::no_follow(OpenOptions::new().read(true))
        .open(&path)
        .ok()?;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file() || metadata.uid() != crate::relay::peer::current_uid() {
        return None;
    }
    let cache = OBSERVED.get_or_init(|| Mutex::new(Default::default()));
    let previous =
        cache.lock().ok()?.get(&path).cloned().filter(|previous| {
            previous.device == metadata.dev() && previous.inode == metadata.ino()
        });
    let modified = (metadata.mtime(), metadata.mtime_nsec());
    if let Some(previous) = &previous {
        if metadata.len() == previous.length && modified == previous.modified {
            return previous.title.clone();
        }
    }
    // A changed or truncated file needs a complete scan. For growth, revisit
    // any previously unfinished final record as well as every appended byte.
    let incremental = previous
        .as_ref()
        .filter(|previous| metadata.len() > previous.length && modified >= previous.modified);
    let start = incremental.map_or(0, |previous| previous.complete_end);
    let (latest, complete_end) = scan_native_title(&mut file, id, start, metadata.len()).ok()?;
    let title = latest.or_else(|| incremental.and_then(|previous| previous.title.clone()));
    let mut observed = cache.lock().ok()?;
    if let Some(newer) = observed
        .get(&path)
        .filter(|entry| entry.device == metadata.dev() && entry.inode == metadata.ino())
    {
        // A slower reader must not replace an observation made after it began.
        if newer.modified > modified {
            return newer.title.clone();
        }
    }
    if observed.len() >= 256 && !observed.contains_key(&path) {
        observed.clear();
    }
    observed.insert(
        path,
        ObservedTitle {
            device: metadata.dev(),
            inode: metadata.ino(),
            length: metadata.len(),
            complete_end,
            modified,
            title: title.clone(),
        },
    );
    title
}

/// Read complete records backwards in fixed-size chunks. Conversation/tool
/// records can be enormous, so skip oversized lines without buffering them;
/// native title metadata (at most 200 title characters) fits comfortably here.
fn scan_native_title(
    file: &mut (impl Read + Seek),
    id: &str,
    start: u64,
    end: u64,
) -> std::io::Result<(Option<String>, u64)> {
    const CHUNK: usize = 32 * 1024;
    let mut chunk = [0; CHUNK];
    let mut records = ReverseRecords::new(start);
    let mut position = end;
    while position > start {
        let length = ((position - start).min(CHUNK as u64)) as usize;
        position -= length as u64;
        file.seek(SeekFrom::Start(position))?;
        file.read_exact(&mut chunk[..length])?;
        for (index, byte) in chunk[..length].iter().enumerate().rev() {
            if let Some(title) = records.push(*byte, position + index as u64, id) {
                return Ok((Some(title), records.complete_end));
            }
        }
    }
    Ok((records.finish(id), records.complete_end))
}

struct ReverseRecords {
    line: Vec<u8>,
    oversized: bool,
    in_record: bool,
    complete_end: u64,
}

impl ReverseRecords {
    fn new(start: u64) -> Self {
        Self {
            line: Vec::new(),
            oversized: false,
            in_record: false,
            complete_end: start,
        }
    }

    fn push(&mut self, byte: u8, offset: u64, id: &str) -> Option<String> {
        const MAX_RECORD: usize = 128 * 1024;
        if !self.in_record {
            if byte == b'\n' {
                self.complete_end = offset + 1;
                self.in_record = true;
            }
            return None;
        }
        if byte == b'\n' {
            return self.finish(id);
        }
        if !self.oversized {
            if self.line.len() == MAX_RECORD {
                self.line.clear();
                self.oversized = true;
            } else {
                self.line.push(byte);
            }
        }
        None
    }

    fn finish(&mut self, id: &str) -> Option<String> {
        let title = if self.in_record && !self.oversized {
            self.line.reverse();
            native_title_record(&self.line, id)
        } else {
            None
        };
        self.line.clear();
        self.oversized = false;
        title
    }
}

fn native_title_record(line: &[u8], id: &str) -> Option<String> {
    let record: serde_json::Value = serde_json::from_slice(line).ok()?;
    if record["type"] != "custom-title"
        || record
            .get("sessionId")
            .is_some_and(|value| value.as_str() != Some(id))
    {
        return None;
    }
    super::validate_title(record["customTitle"].as_str()?).ok()
}

pub fn capability(config: &ClaudeConfig, id: &str) -> SessionTitleCapability {
    match transcript(config, id) {
        Ok(_) => supported(),
        Err(reason) => unsupported(reason),
    }
}

pub fn set(config: &ClaudeConfig, id: &str, title: &str) -> Result<String, String> {
    let path = transcript(config, id)?;
    let mut file = crate::platform::fs::no_follow(OpenOptions::new().read(true).append(true))
        .open(&path)
        .map_err(|_| "Could not open the Claude session title for editing.".to_string())?;
    let metadata = file
        .metadata()
        .map_err(|_| "Could not read the Claude session.".to_string())?;
    if !metadata.is_file() || metadata.uid() != crate::relay::peer::current_uid() {
        return Err("The Claude session file changed. Try again.".into());
    }
    // A provider may currently be appending a record. Never complete or discard
    // that partial record on its behalf; retry after it finishes instead.
    if metadata.len() == 0 {
        return Err("This Claude session has no transcript yet.".into());
    }
    file.seek(SeekFrom::End(-1))
        .map_err(|_| "Could not read the Claude session.".to_string())?;
    let mut tail = [0];
    file.read_exact(&mut tail)
        .map_err(|_| "Could not read the Claude session.".to_string())?;
    if tail[0] != b'\n' {
        return Err("Claude is writing this session. Try again in a moment.".into());
    }
    let mut record = serde_json::to_vec(
        &serde_json::json!({"type":"custom-title","customTitle":title,"sessionId":id}),
    )
    .map_err(|_| "Could not encode the session title.".to_string())?;
    record.push(b'\n');
    // O_APPEND and one write preserve every existing conversation byte.
    let written = file
        .write(&record)
        .map_err(|_| "Could not save the Claude session title.".to_string())?;
    if written != record.len() {
        return Err("Claude did not save the complete session title. Try again.".into());
    }
    file.sync_data()
        .map_err(|_| "Could not finish saving the Claude session title.".to_string())?;
    Ok(title.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    const ID: &str = "019f8b15-1111-7111-8111-111111111111";
    fn setup() -> (tempfile::TempDir, ClaudeConfig, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let config = ClaudeConfig::from_env(&|_| None, root.path());
        let directory = config.home.join("projects/project");
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join(format!("{ID}.jsonl"));
        fs::write(&path, format!("{{\"type\":\"user\",\"sessionId\":\"{ID}\",\"message\":{{\"content\":\"original\"}}}}\n")).unwrap();
        (root, config, path)
    }
    #[test]
    fn appends_native_metadata_without_rewriting_conversation() {
        let (_root, config, path) = setup();
        let original = fs::read(&path).unwrap();
        assert!(capability(&config, ID).supported);
        set(&config, ID, "Fix login").unwrap();
        let changed = fs::read(&path).unwrap();
        assert!(changed.starts_with(&original));
        let record: serde_json::Value = serde_json::from_slice(&changed[original.len()..]).unwrap();
        assert_eq!(
            record,
            serde_json::json!({"type":"custom-title","customTitle":"Fix login","sessionId":ID})
        );
    }
    #[test]
    fn native_title_survives_append_growth_and_tracks_later_native_renames() {
        let (_root, config, path) = setup();
        assert_eq!(native_title(&config, ID), None);
        set(&config, ID, "First title").unwrap();
        assert_eq!(native_title(&config, ID).as_deref(), Some("First title"));
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(&vec![b' '; 300 * 1024]).unwrap();
        file.write_all(b"\n").unwrap();
        assert_eq!(native_title(&config, ID).as_deref(), Some("First title"));
        set(&config, ID, "Second title").unwrap();
        assert_eq!(native_title(&config, ID).as_deref(), Some("Second title"));
        file.write_all(&vec![b' '; 300 * 1024]).unwrap();
        file.write_all(b"\n").unwrap();
        assert_eq!(native_title(&config, ID).as_deref(), Some("Second title"));
        fs::write(&path, b"{}\n").unwrap();
        assert_eq!(native_title(&config, ID), None);
    }

    fn append_large_record(path: &std::path::Path) {
        let mut file = OpenOptions::new().append(true).open(path).unwrap();
        file.write_all(&vec![b' '; 300 * 1024]).unwrap();
        file.write_all(b"\n").unwrap();
    }

    #[test]
    fn cold_read_recovers_the_latest_title_in_the_middle_of_a_large_transcript() {
        let (_root, config, path) = setup();
        set(&config, ID, "Older title").unwrap();
        append_large_record(&path);
        set(&config, ID, "Middle title").unwrap();
        append_large_record(&path);
        assert_eq!(native_title(&config, ID).as_deref(), Some("Middle title"));
    }

    #[test]
    fn growth_finds_a_new_title_even_after_it_has_moved_beyond_the_tail_window() {
        let (_root, config, path) = setup();
        set(&config, ID, "First title").unwrap();
        assert_eq!(native_title(&config, ID).as_deref(), Some("First title"));
        append_large_record(&path);
        set(&config, ID, "Unobserved title").unwrap();
        append_large_record(&path);
        assert_eq!(
            native_title(&config, ID).as_deref(),
            Some("Unobserved title")
        );
    }

    #[test]
    fn partial_final_metadata_is_revisited_only_after_the_record_completes() {
        let (_root, config, path) = setup();
        set(&config, ID, "First title").unwrap();
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        let record = serde_json::to_vec(&serde_json::json!({
            "type": "custom-title", "customTitle": "Completed title", "sessionId": ID
        }))
        .unwrap();
        file.write_all(&record).unwrap();
        assert_eq!(native_title(&config, ID).as_deref(), Some("First title"));
        file.write_all(b"\n").unwrap();
        append_large_record(&path);
        assert_eq!(
            native_title(&config, ID).as_deref(),
            Some("Completed title")
        );
    }

    #[test]
    fn reverse_scan_assembles_title_records_across_chunk_boundaries() {
        let record = serde_json::to_vec(&serde_json::json!({
            "type": "custom-title", "customTitle": "Boundary title", "sessionId": ID
        }))
        .unwrap();
        let mut bytes = b"{}\n".to_vec();
        bytes.extend_from_slice(&record);
        bytes.push(b'\n');
        bytes.extend(std::iter::repeat_n(b' ', 32 * 1024 - 30));
        bytes.push(b'\n');
        let end = bytes.len() as u64;
        assert_eq!(
            scan_native_title(&mut std::io::Cursor::new(bytes), ID, 0, end).unwrap(),
            (Some("Boundary title".into()), end)
        );
    }

    // Symlinks need a privilege on Windows that the test runner lacks.
    #[cfg(unix)]
    #[test]
    fn refuses_unknown_duplicate_symlink_and_partial_transcripts() {
        let (_root, config, path) = setup();
        assert!(!capability(&config, "../../other").supported);
        let sibling = config.home.join("projects/other");
        fs::create_dir_all(&sibling).unwrap();
        let copy = sibling.join(format!("{ID}.jsonl"));
        fs::copy(&path, &copy).unwrap();
        assert!(set(&config, ID, "new").is_err());
        fs::remove_file(&copy).unwrap();
        fs::write(&path, b"{partial").unwrap();
        assert!(set(&config, ID, "new").is_err());
        assert_eq!(fs::read(&path).unwrap(), b"{partial");
        fs::remove_file(&path).unwrap();
        let outside = config.home.join("outside");
        fs::write(&outside, b"original\n").unwrap();
        std::os::unix::fs::symlink(&outside, &path).unwrap();
        assert!(!capability(&config, ID).supported);
    }
}
