//! Read native title metadata for discovered and bound Grok sessions.
use super::{ActiveSession, GrokConfig};
use crate::relay::process::ProcessTable;
use crate::relay::store::is_uuid;
use serde_json::Value;
use std::path::Path;

/// Reads Grok's own title metadata, without opening or loading a session.
/// The file is reread each discovery so renames made in either app stay visible.
pub(crate) fn native_title(config: &GrokConfig, cwd: &str, session_id: &str) -> Option<String> {
    use std::io::Read;
    if !is_uuid(session_id) || !Path::new(cwd).is_absolute() {
        return None;
    }
    let file =
        std::fs::File::open(config.session_dir(cwd, session_id).join("summary.json")).ok()?;
    const LIMIT: u64 = 1024 * 1024;
    if !file.metadata().ok()?.is_file() {
        return None;
    }
    let mut data = Vec::new();
    file.take(LIMIT + 1).read_to_end(&mut data).ok()?;
    if data.len() as u64 > LIMIT {
        return None;
    }
    let summary: Value = serde_json::from_slice(&data).ok()?;
    // Older summaries may lack info; when present it must name this session.
    if let Some(info) = summary.get("info") {
        if info["id"].as_str() != Some(session_id)
            || info["cwd"].as_str().map(Path::new) != Some(Path::new(cwd))
        {
            return None;
        }
    }
    [("generated_title", 200), ("session_summary", 120)]
        .into_iter()
        .find_map(|(key, limit)| {
            summary[key]
                .as_str()
                .map(str::trim)
                .filter(|text| {
                    !text.is_empty()
                        && text.chars().count() <= limit
                        && !text.chars().any(char::is_control)
                })
                .map(str::to_owned)
        })
}

/// Bound leaders can use a different Grok home than Relay. Read the native
/// metadata under that process's home only while its recorded identity holds.
pub(crate) fn binding_title(
    binding: &crate::relay::existing_session::Binding,
    table: &dyn ProcessTable,
) -> Option<String> {
    let process = table.process(binding.leader_pid)?;
    if process.uid != binding.owner_uid || process.start != binding.leader_start {
        return None;
    }
    let home = crate::relay::existing_session::grok::grok_home(table, binding.leader_pid)?;
    let title = native_title(
        &GrokConfig { home },
        binding.cwd.to_str()?,
        &binding.session_id,
    )?;
    (table.process(binding.leader_pid) == Some(process)).then_some(title)
}

/// A short name for lists: Grok's native title, else the directory or id.
pub(super) fn title(config: &GrokConfig, session: &ActiveSession) -> String {
    let generated = session
        .cwd
        .as_deref()
        .and_then(|cwd| native_title(config, cwd, &session.session_id));
    generated
        .or_else(|| {
            session
                .cwd
                .as_deref()
                .map(|cwd| cwd.trim_end_matches('/'))
                .and_then(|cwd| cwd.rsplit('/').next())
                .filter(|name| !name.is_empty())
                .map(str::to_string)
        })
        .unwrap_or_else(|| session.session_id.clone())
}
