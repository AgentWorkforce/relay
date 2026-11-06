//! Hook-observed live sessions, backed by the runtime's held inode on every use.
use super::{proof, CopilotConfig};
use crate::relay::process::ProcessTable;
use crate::relay::sessions::DiscoveredSession;
use crate::relay::store::{is_uuid, SessionKind, Target};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;

#[derive(Serialize, Deserialize)]
struct Record {
    pid: i32,
    start: u64,
    title: String,
    cwd: Option<String>,
}
fn read(config: &CopilotConfig, sid: &str) -> Option<Record> {
    if !is_uuid(sid) {
        return None;
    }
    serde_json::from_slice(&std::fs::read(config.state().join(format!("{sid}.json"))).ok()?).ok()
}
pub fn session(
    config: &CopilotConfig,
    table: &dyn ProcessTable,
    uid: u32,
    sid: &str,
) -> Option<DiscoveredSession> {
    if !config.enabled() {
        return None;
    }
    let record = read(config, sid)?;
    let process = table.process(record.pid)?;
    if process.start != record.start
        || !proof::held(config, table, record.pid, uid)
            .iter()
            .any(|id| id == sid)
    {
        return None;
    }
    Some(DiscoveredSession {
        target: Target::new(SessionKind::Copilot, sid),
        title: record.title,
        directory: record.cwd,
        updated_at_ms: None,
        host: Some("VS Code".into()),
        live: true,
        holder: None,
    })
}
pub fn discover(
    config: &CopilotConfig,
    table: &dyn ProcessTable,
    uid: u32,
) -> Vec<DiscoveredSession> {
    if !proof::SUPPORTED || !config.enabled() {
        return Vec::new();
    }
    let Ok(entries) = std::fs::read_dir(config.state()) else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .filter_map(|e| {
            let path = e.path();
            if path.extension()?.to_str()? != "json" {
                return None;
            }
            session(config, table, uid, path.file_stem()?.to_str()?)
        })
        .collect()
}

/// Called only by the peer-authenticated session socket. The native runtime
/// directly launches this hook executable, whose payload names a held session.
pub fn hook_answer(
    config: &CopilotConfig,
    table: &dyn ProcessTable,
    uid: u32,
    pid: i32,
    payload: &Value,
) -> Option<Value> {
    let sid = payload["sessionId"].as_str().filter(|s| is_uuid(s))?;
    let event = payload["relayEvent"].as_str()?;
    if !matches!(event, "start" | "before" | "tool" | "stop") || !config.enabled() {
        return None;
    }
    // An idle poll exposes nothing and never discovers a session. Avoid the
    // expensive process/descriptor proof until there is a message to claim.
    if idle_stop(config, payload, sid, event) {
        return Some(json!({}));
    }
    if !super::settings::caller_is_hook(config, table, pid, event)
        || !proof::hook_holds(config, table, pid, uid, sid)
    {
        return None;
    }
    let runtime = table.process(table.process(pid)?.parent)?;
    config.prepare().ok()?;
    let old = read(config, sid);
    // Refuse a different live runtime, rather than let two hosts take turns
    // claiming a copied native identity.
    if other_live_runtime(config, table, uid, sid, old.as_ref(), runtime.pid) {
        return None;
    }
    let title = record_title(old.as_ref(), payload);
    let record = Record {
        pid: runtime.pid,
        start: runtime.start,
        title,
        cwd: payload["cwd"]
            .as_str()
            .filter(|s| Path::new(s).is_absolute())
            .map(str::to_owned),
    };
    let bytes = serde_json::to_vec(&record).ok()?;
    let path = config.state().join(format!("{sid}.json"));
    if std::fs::read(&path).ok().as_deref() != Some(&bytes) {
        crate::platform::fs::write_atomic(&path, &bytes).ok()?;
    }
    if matches!(event, "start" | "before") {
        return Some(json!({}));
    }
    if event == "stop" && payload["stopReason"].as_str() != Some("end_turn") {
        return Some(json!({}));
    }
    let kind = if event == "stop" {
        crate::relay::codex::turn_hook::HookEvent::Stop
    } else {
        crate::relay::codex::turn_hook::HookEvent::PostToolUse
    };
    let Some(binding) = payload["relayBinding"].as_str().filter(|s| !s.is_empty()) else {
        return Some(json!({}));
    };
    let answer = config.inbox.answer(&format!("{sid}:{binding}"), kind);
    if event == "tool" {
        return Some(
            answer["hookSpecificOutput"]["additionalContext"]
                .as_str()
                .map(|s| json!({"additionalContext":s}))
                .unwrap_or_else(|| json!({})),
        );
    }
    Some(answer)
}

fn idle_stop(config: &CopilotConfig, payload: &Value, sid: &str, event: &str) -> bool {
    event == "stop"
        && payload["relayBinding"]
            .as_str()
            .is_none_or(|binding| !config.inbox.has_offered(&format!("{sid}:{binding}")))
}

fn record_title(old: Option<&Record>, payload: &Value) -> String {
    old.map(|r| r.title.clone()).unwrap_or_else(|| {
        payload["initialPrompt"]
            .as_str()
            .unwrap_or("Copilot chat")
            .chars()
            .filter(|c| !c.is_control())
            .take(96)
            .collect()
    })
}

fn other_live_runtime(
    config: &CopilotConfig,
    table: &dyn ProcessTable,
    uid: u32,
    sid: &str,
    old: Option<&Record>,
    pid: i32,
) -> bool {
    old.is_some_and(|old| {
        old.pid != pid
            && table.process(old.pid).is_some_and(|p| p.start == old.start)
            && proof::held(config, table, old.pid, uid)
                .iter()
                .any(|id| id == sid)
    })
}
