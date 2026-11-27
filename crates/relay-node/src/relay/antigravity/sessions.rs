//! Live Antigravity session discovery and hook-authenticated state updates.
use super::{proof, AntigravityConfig};
use crate::relay::process::{ProcessInfo, ProcessTable};
use crate::relay::sessions::DiscoveredSession;
use crate::relay::store::{is_uuid, SessionKind, Target};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io;
use std::path::Path;
use std::time::Duration;

#[derive(Serialize, Deserialize, Default)]
struct Record {
    pid: i32,
    start: u64,
    title: String,
    cwd: Option<String>,
}

#[derive(Default)]
struct Summary {
    title: Option<String>,
    directory: Option<String>,
    is_subagent: bool,
}

fn read_record(config: &AntigravityConfig, sid: &str) -> io::Result<Option<Record>> {
    if !is_uuid(sid) {
        return Ok(None);
    }
    match std::fs::read(config.state().join(format!("{sid}.json"))) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(io::Error::other),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn read_summaries(config: &AntigravityConfig) -> Option<HashMap<String, Summary>> {
    let db = config.summaries_db();
    match std::fs::metadata(&db) {
        Ok(meta) if meta.is_file() => {}
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Some(HashMap::new()),
        Ok(_) | Err(_) => return None,
    }
    let conn = Connection::open_with_flags(&db, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    let _ = conn.busy_timeout(Duration::from_millis(500));
    let mut stmt = conn
        .prepare(
            "SELECT conversation_id, title, workspace_uris, parent_conversation_id FROM conversation_summaries",
        )
        .ok()?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .ok()?;
    let mut out = HashMap::new();
    for row in rows {
        let (id, title, workspace_uris, parent) = row.ok()?;
        out.insert(
            id,
            Summary {
                title: non_blank(&title),
                directory: first_workspace_dir(&workspace_uris),
                is_subagent: !parent.trim().is_empty(),
            },
        );
    }
    Some(out)
}

/// Returns `None` if `conversation_summaries.db` exists on disk (or its
/// metadata cannot be inspected) and cannot be read (fail closed so subagents
/// are not exposed), `Some(None)` if the DB is absent or no row exists for
/// `sid`, or `Some(Some(summary))` if found.
fn read_summary(config: &AntigravityConfig, sid: &str) -> Option<Option<Summary>> {
    let db = config.summaries_db();
    match std::fs::metadata(&db) {
        Ok(meta) if meta.is_file() => {}
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Some(None),
        Ok(_) | Err(_) => return None,
    }
    let conn = Connection::open_with_flags(&db, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    let _ = conn.busy_timeout(Duration::from_millis(500));
    let row: Option<(String, String, String)> = conn
        .query_row(
            "SELECT title, workspace_uris, parent_conversation_id FROM conversation_summaries WHERE conversation_id = ?1",
            [sid],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .ok()?;
    Some(row.map(|(title, workspace_uris, parent)| Summary {
        title: non_blank(&title),
        directory: first_workspace_dir(&workspace_uris),
        is_subagent: !parent.trim().is_empty(),
    }))
}

/// Collect child subagent conversation IDs recorded under any held parent's
/// `<brain>/<sid>/.system_generated/subagents/*.json` directory.
fn subagent_ids(config: &AntigravityConfig, held_sids: &[String]) -> HashSet<String> {
    let mut children = HashSet::new();
    for sid in held_sids {
        if !is_uuid(sid) {
            continue;
        }
        let dir = config.brain().join(sid).join(".system_generated/subagents");
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten().take(256) {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            if entry.metadata().is_ok_and(|m| m.len() > 64 * 1024) {
                continue;
            }
            let Ok(bytes) = std::fs::read(&path) else {
                continue;
            };
            let Ok(val) = serde_json::from_slice::<Value>(&bytes) else {
                continue;
            };
            if let Some(child_id) = val["conversationId"].as_str().filter(|s| is_uuid(s)) {
                children.insert(child_id.to_owned());
            }
        }
    }
    children
}

fn fresh_record(config: &AntigravityConfig, sid: &str, runtime: ProcessInfo) -> Option<Record> {
    read_record(config, sid)
        .ok()
        .flatten()
        .filter(|rec| rec.pid == runtime.pid && rec.start == runtime.start)
}

fn non_blank(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

fn first_workspace_dir(workspace_uris: &str) -> Option<String> {
    let parsed: Vec<String> = serde_json::from_str(workspace_uris).ok()?;
    parsed.into_iter().find_map(|uri| decode_file_uri(&uri))
}

fn decode_file_uri(uri: &str) -> Option<String> {
    let path = uri.strip_prefix("file://")?;
    let mut bytes = Vec::with_capacity(path.len());
    let raw = path.as_bytes();
    let mut i = 0;
    while i < raw.len() {
        if raw[i] == b'%' && i + 2 < raw.len() {
            if let Ok(hex) = std::str::from_utf8(&raw[i + 1..i + 3]) {
                if let Ok(byte) = u8::from_str_radix(hex, 16) {
                    bytes.push(byte);
                    i += 3;
                    continue;
                }
            }
        }
        bytes.push(raw[i]);
        i += 1;
    }
    let decoded = String::from_utf8(bytes).ok()?;
    (!decoded.is_empty()).then_some(decoded)
}

fn build_row(sid: &str, summary: Option<&Summary>, record: Option<&Record>) -> DiscoveredSession {
    let title = summary
        .and_then(|s| s.title.clone())
        .or_else(|| record.and_then(|r| non_blank(&r.title)))
        .unwrap_or_else(|| "Antigravity session".into());
    let directory = record
        .and_then(|r| r.cwd.clone())
        .or_else(|| summary.and_then(|s| s.directory.clone()));
    DiscoveredSession {
        target: Target::new(SessionKind::Antigravity, sid),
        title,
        directory,
        updated_at_ms: None,
        host: Some("Antigravity".into()),
        live: true,
        holder: None,
    }
}

/// Discover every live non-subagent Antigravity conversation held by a running
/// trusted `language_server` of `uid`.
pub fn discover(
    config: &AntigravityConfig,
    table: &dyn ProcessTable,
    uid: u32,
) -> Option<Vec<DiscoveredSession>> {
    if !proof::SUPPORTED {
        return Some(Vec::new());
    }
    let summaries = read_summaries(config)?;
    let mut seen = HashSet::new();
    let mut held_entries = Vec::new();
    for pid in table.all_pids() {
        let Some(runtime) = proof::runtime(table, pid, uid) else {
            continue;
        };
        for sid in proof::held(config, table, runtime.pid, uid) {
            if seen.insert(sid.clone()) {
                held_entries.push((runtime, sid));
            }
        }
    }
    let held_sids: Vec<String> = held_entries.iter().map(|(_, sid)| sid.clone()).collect();
    let children = subagent_ids(config, &held_sids);
    let mut sessions = Vec::new();
    for (runtime, sid) in held_entries {
        if children.contains(&sid) {
            continue;
        }
        let summary = summaries.get(&sid);
        if summary.is_some_and(|s| s.is_subagent) {
            continue;
        }
        let record = fresh_record(config, &sid, runtime);
        sessions.push(build_row(&sid, summary, record.as_ref()));
    }
    Some(sessions)
}

fn all_held_sids(config: &AntigravityConfig, table: &dyn ProcessTable, uid: u32) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut sids = Vec::new();
    for pid in table.all_pids() {
        let Some(runtime) = proof::runtime(table, pid, uid) else {
            continue;
        };
        for sid in proof::held(config, table, runtime.pid, uid) {
            if seen.insert(sid.clone()) {
                sids.push(sid);
            }
        }
    }
    sids
}

/// Look up one live Antigravity conversation by UUID without scanning every
/// process when its cached hook record already names its live holder.
pub fn session(
    config: &AntigravityConfig,
    table: &dyn ProcessTable,
    uid: u32,
    sid: &str,
) -> Option<DiscoveredSession> {
    if !proof::SUPPORTED || !is_uuid(sid) {
        return None;
    }
    let record = read_record(config, sid).ok().flatten();
    if let Some(ref rec) = record {
        if let Some(runtime) = proof::runtime(table, rec.pid, uid) {
            if runtime.start == rec.start {
                let held = proof::held(config, table, runtime.pid, uid);
                if held.iter().any(|id| id == sid) {
                    let all_sids = all_held_sids(config, table, uid);
                    if subagent_ids(config, &all_sids).contains(sid) {
                        return None;
                    }
                    let summary = read_summary(config, sid)?;
                    if summary.as_ref().is_some_and(|s| s.is_subagent) {
                        return None;
                    }
                    return Some(build_row(sid, summary.as_ref(), Some(rec)));
                }
            }
        }
    }
    let mut matched_runtime = None;
    let mut all_sids = Vec::new();
    let mut seen = HashSet::new();
    for pid in table.all_pids() {
        let Some(runtime) = proof::runtime(table, pid, uid) else {
            continue;
        };
        for held_sid in proof::held(config, table, runtime.pid, uid) {
            if held_sid == sid && matched_runtime.is_none() {
                matched_runtime = Some(runtime);
            }
            if seen.insert(held_sid.clone()) {
                all_sids.push(held_sid);
            }
        }
    }
    let runtime = matched_runtime?;
    if subagent_ids(config, &all_sids).contains(sid) {
        return None;
    }
    let summary = read_summary(config, sid)?;
    if summary.as_ref().is_some_and(|s| s.is_subagent) {
        return None;
    }
    let fresh = record
        .as_ref()
        .filter(|rec| rec.pid == runtime.pid && rec.start == runtime.start);
    Some(build_row(sid, summary.as_ref(), fresh))
}

fn record_lock(config: &AntigravityConfig, sid: &str) -> io::Result<std::fs::File> {
    config.prepare()?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(false);
    let lock = crate::platform::fs::no_follow(crate::platform::fs::private(&mut options))
        .open(config.state().join(format!("{sid}.lock")))?;
    let metadata = lock.metadata()?;
    if !metadata.is_file()
        || !crate::platform::fs::owned_by_current_user(&metadata)
        || !crate::platform::fs::private_to_owner(&metadata, 0o077)
    {
        return Err(io::Error::other("Antigravity state lock is not private"));
    }
    fs2::FileExt::lock_exclusive(&lock)?;
    Ok(lock)
}

fn observe(
    config: &AntigravityConfig,
    sid: &str,
    runtime: ProcessInfo,
    payload: &Value,
) -> Option<()> {
    let _lock = record_lock(config, sid).ok()?;
    let old = fresh_record(config, sid, runtime);
    let cwd = payload["cwd"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .or_else(|| {
            payload["workspacePaths"]
                .as_array()
                .and_then(|arr| arr.first())
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
        })
        .or_else(|| old.as_ref().and_then(|r| r.cwd.clone()));
    let title = payload["lastUserInput"]
        .as_str()
        .and_then(non_blank)
        .or_else(|| old.as_ref().and_then(|r| non_blank(&r.title)))
        .unwrap_or_else(|| {
            cwd.as_deref()
                .and_then(|p| Path::new(p).file_name())
                .and_then(|s| s.to_str())
                .map(|name| format!("Antigravity ({name})"))
                .unwrap_or_else(|| "Antigravity session".into())
        });
    let record = Record {
        pid: runtime.pid,
        start: runtime.start,
        title,
        cwd,
    };
    let bytes = serde_json::to_vec(&record).ok()?;
    crate::platform::fs::write_atomic(&config.state().join(format!("{sid}.json")), &bytes).ok()
}

/// Handle a peer-authenticated Antigravity lifecycle hook request from the
/// session socket (`POST /antigravity/hook`).
///
/// `still_current` fences workspace/identity-generation changes immediately
/// before claiming an inbox message, so a claimed offer is never discarded and
/// stranded in `InDoubt`.
pub fn hook_answer(
    config: &AntigravityConfig,
    table: &dyn ProcessTable,
    uid: u32,
    pid: i32,
    payload: &Value,
    still_current: &(dyn Fn() -> bool + Sync),
) -> Option<Value> {
    let table = table.uncached().unwrap_or(table);
    let sid = payload["conversationId"].as_str().filter(|s| is_uuid(s))?;
    let event = payload["relayEvent"].as_str()?;
    if !matches!(event, "start" | "pre" | "post" | "stop") || !config.enabled() {
        return None;
    }
    let hook = table.process(pid).filter(|p| p.uid == uid)?;
    if !super::settings::caller_is_hook(config, table, pid, event) {
        return None;
    }
    let runtime = proof::hook_runtime(table, pid, uid)?;
    if !proof::hook_environment_ok(config, table, pid, sid) {
        return None;
    }
    let held = proof::held(config, table, runtime.pid, uid);
    if !held.iter().any(|id| id == sid) {
        return None;
    }
    if held.len() > 1 {
        let helper = config.helper();
        if held.iter().any(|other| {
            other != sid && super::caller::inflight_hook_invocation(config, other, &helper, event)
        }) {
            return None;
        }
    }
    if table.process(pid) != Some(hook) || table.process(runtime.pid) != Some(runtime) {
        return None;
    }
    observe(config, sid, runtime, payload)?;
    take_answer(config, payload, sid, event, still_current)
}

fn take_answer(
    config: &AntigravityConfig,
    payload: &Value,
    sid: &str,
    event: &str,
    still_current: &(dyn Fn() -> bool + Sync),
) -> Option<Value> {
    if !still_current() {
        return None;
    }
    if event == "start" {
        return Some(json!({}));
    }
    if event == "stop" && payload["terminationReason"].as_str() != Some("NO_TOOL_CALL") {
        return Some(json!({"relayWait": false}));
    }
    let Some(binding) = payload["relayBinding"].as_str().filter(|s| !s.is_empty()) else {
        return Some(if event == "stop" {
            json!({"relayWait": false})
        } else {
            json!({})
        });
    };
    let thread = format!("{sid}:{binding}");
    let kind = if event == "stop" {
        crate::relay::codex::turn_hook::HookEvent::Stop
    } else {
        crate::relay::codex::turn_hook::HookEvent::PostToolUse
    };
    // Re-check workspace/generation immediately before claiming so we never
    // consume an offer and then reject it upstream.
    if !still_current() {
        return None;
    }
    let answer = config.inbox.answer(&thread, kind);
    if event == "stop" {
        let Some(reason) = answer["reason"].as_str().filter(|s| !s.is_empty()) else {
            return Some(json!({}));
        };
        return Some(json!({
            "decision": "continue",
            "reason": reason,
        }));
    }
    let Some(text) = answer["hookSpecificOutput"]["additionalContext"]
        .as_str()
        .filter(|s| !s.is_empty())
    else {
        return Some(json!({}));
    };
    if event == "post" {
        Some(json!({
            "injectSteps": [{"systemMessage": {"systemMessage": text}}],
            "terminationBehavior": "force_continue",
        }))
    } else {
        Some(json!({
            "injectSteps": [{"systemMessage": {"systemMessage": text}}],
        }))
    }
}
