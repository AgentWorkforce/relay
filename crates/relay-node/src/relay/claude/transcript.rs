//! Finding a terminal Claude Code session's transcript on disk.

use super::{
    is_uuid, project_folder, sorted_entries, terminal_session, ClaudeConfig, TerminalSession,
};
use crate::relay::process::ProcessTable;
use std::path::{Path, PathBuf};

/// How much of a transcript's start `cleared_at` reads. The `/clear`
/// command is its first prompt, after a line or two of state.
const HEAD_BYTES: u64 = 64 * 1024;

/// When the conversation in `transcript` was started by `/clear`: its first
/// prompt is the command, as Claude Code records it in the new
/// conversation's transcript.
///
/// ```text
/// {"type":"user","isMeta":true,"message":{"content":"<local-command-caveat>…"},…}
/// {"type":"user","message":{"content":"<command-name>/clear</command-name>…"},"timestamp":"…",…}
/// ```
pub fn cleared_at(transcript: &Path) -> Option<i64> {
    use std::io::Read;
    let mut head = Vec::new();
    std::fs::File::open(transcript)
        .ok()?
        .take(HEAD_BYTES)
        .read_to_end(&mut head)
        .ok()?;
    let first = head
        .split(|b| *b == b'\n')
        .filter_map(|line| serde_json::from_slice::<serde_json::Value>(line).ok())
        .find(|entry| entry["type"] == "user" && entry["isMeta"] != true)?;
    first["message"]["content"]
        .as_str()?
        .trim_start()
        .starts_with("<command-name>/clear</command-name>")
        .then(|| first["timestamp"].as_str().and_then(crate::parse_iso_ms))
        .flatten()
}

/// The terminal session's transcript `projects/<folder>/<id>.jsonl`, and the
/// session itself while it runs. `None` for an id that is not a UUID or a
/// transcript that is not on disk.
pub fn path(
    config: &ClaudeConfig,
    table: &dyn ProcessTable,
    session_id: &str,
) -> Option<(PathBuf, Option<TerminalSession>)> {
    // The id names a file; only a UUID may.
    if !is_uuid(session_id) {
        return None;
    }
    let file = format!("{session_id}.jsonl");
    let live = terminal_session(config, table, session_id);
    // The session's own login first: a second login may keep transcripts in
    // its own `projects/`.
    let own = live
        .as_ref()
        .and_then(|s| s.registry.as_deref())
        .and_then(Path::parent)
        .map(|login| login.join("projects"))
        .unwrap_or_else(|| config.projects());
    let mut all = vec![own.clone()];
    for projects in config
        .registries()
        .iter()
        .filter_map(|r| r.parent())
        .map(|l| l.join("projects"))
    {
        let real = |path: &Path| std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        if all.iter().all(|known| real(known) != real(&projects)) {
            all.push(projects);
        }
    }
    let by_cwd = live
        .as_ref()
        .and_then(|s| s.cwd.as_deref())
        .map(|cwd| own.join(project_folder(cwd)).join(&file))
        .filter(|path| path.is_file());
    let path = by_cwd.or_else(|| {
        all.iter()
            .flat_map(|projects| sorted_entries(projects))
            .map(|folder| folder.join(&file))
            .find(|path| path.is_file())
    })?;
    Some((path, live))
}
