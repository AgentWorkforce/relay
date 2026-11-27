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

fn read_summaries(config: &AntigravityConfig) -> HashMap<String, Summary> {
    let db = config.summaries_db();
    if !db.is_file() {
        return HashMap::new();
    }
    let Ok(conn) = Connection::open_with_flags(&db, OpenFlags::SQLITE_OPEN_READ_ONLY) else {
        return HashMap::new();
    };
    let _ = conn.busy_timeout(Duration::from_millis(500));
    let Ok(mut stmt) = conn.prepare(
        "SELECT conversation_id, title, workspace_uris, parent_conversation_id FROM conversation_summaries",
    ) else {
        return HashMap::new();
    };
    let Ok(rows) = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
        ))
    }) else {
        return HashMap::new();
    };
    let mut out = HashMap::new();
    for row in rows.flatten() {
        let (id, title, workspace_uris, parent) = row;
        out.insert(
            id,
            Summary {
                title: non_blank(&title),
                directory: first_workspace_dir(&workspace_uris),
                is_subagent: !parent.trim().is_empty(),
            },
        );
    }
    out
}

fn read_summary(config: &AntigravityConfig, sid: &str) -> Option<Summary> {
    let db = config.summaries_db();
    if !db.is_file() {
        return None;
    }
    let conn = Connection::open_with_flags(&db, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    let _ = conn.busy_timeout(Duration::from_millis(500));
    let (title, workspace_uris, parent): (String, String, String) = conn
        .query_row(
            "SELECT title, workspace_uris, parent_conversation_id FROM conversation_summaries WHERE conversation_id = ?1",
            [sid],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .ok()??;
    Some(Summary {
        title: non_blank(&title),
        directory: first_workspace_dir(&workspace_uris),
        is_subagent: !parent.trim().is_empty(),
    })
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
    let summaries = read_summaries(config);
    let mut seen = HashSet::new();
    let mut sessions = Vec::new();
    for pid in table.all_pids() {
        let Some(runtime) = proof::runtime(table, pid, uid) else {
            continue;
        };
        for sid in proof::held(config, table, runtime.pid, uid) {
            if !seen.insert(sid.clone()) {
                continue;
            }
            let summary = summaries.get(&sid);
            if summary.is_some_and(|s| s.is_subagent) {
                continue;
            }
            let record = read_record(config, &sid).ok().flatten();
            sessions.push(build_row(&sid, summary, record.as_ref()));
        }
    }
    Some(sessions)
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
            if runtime.start == rec.start
                && proof::held(config, table, runtime.pid, uid)
                    .iter()
                    .any(|id| id == sid)
            {
                let summary = read_summary(config, sid);
                return Some(build_row(sid, summary.as_ref(), Some(rec)));
            }
        }
    }
    for pid in table.all_pids() {
        let Some(runtime) = proof::runtime(table, pid, uid) else {
            continue;
        };
        if proof::held(config, table, runtime.pid, uid)
            .iter()
            .any(|id| id == sid)
        {
            let summary = read_summary(config, sid);
            return Some(build_row(sid, summary.as_ref(), record.as_ref()));
        }
    }
    None
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
    let old = read_record(config, sid).ok().flatten();
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
pub fn hook_answer(
    config: &AntigravityConfig,
    table: &dyn ProcessTable,
    uid: u32,
    pid: i32,
    payload: &Value,
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
    let holds = proof::held(config, table, runtime.pid, uid)
        .iter()
        .any(|id| id == sid);
    if !holds || table.process(pid) != Some(hook) || table.process(runtime.pid) != Some(runtime) {
        return None;
    }
    observe(config, sid, runtime, payload)?;
    take_answer(config, payload, sid, event)
}

fn take_answer(
    config: &AntigravityConfig,
    payload: &Value,
    sid: &str,
    event: &str,
) -> Option<Value> {
    if event == "start" {
        return Some(json!({}));
    }
    if event == "stop" && payload["terminationReason"].as_str() != Some("NO_TOOL_CALL") {
        return Some(json!({}));
    }
    let Some(binding) = payload["relayBinding"].as_str().filter(|s| !s.is_empty()) else {
        return Some(json!({}));
    };
    let thread = format!("{sid}:{binding}");
    let kind = if event == "stop" {
        crate::relay::codex::turn_hook::HookEvent::Stop
    } else {
        crate::relay::codex::turn_hook::HookEvent::PostToolUse
    };
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
