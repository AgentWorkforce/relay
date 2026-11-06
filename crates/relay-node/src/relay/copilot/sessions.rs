//! Hook-observed live sessions, backed by the runtime's held inode on every use.
use super::{proof, CopilotConfig};
use crate::relay::process::{ProcessInfo, ProcessTable};
use crate::relay::sessions::DiscoveredSession;
use crate::relay::store::{is_uuid, SessionKind, Target};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io;
use std::path::Path;

#[derive(Serialize, Deserialize)]
struct Record {
    pid: i32,
    start: u64,
    title: String,
    cwd: Option<String>,
    #[serde(default)]
    context_after: u64,
}
fn read(config: &CopilotConfig, sid: &str) -> io::Result<Option<Record>> {
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
pub(super) fn context_after(config: &CopilotConfig, sid: &str) -> Option<u64> {
    Some(read(config, sid).ok()??.context_after)
}
fn discovered(sid: &str, record: Record) -> DiscoveredSession {
    DiscoveredSession {
        target: Target::new(SessionKind::Copilot, sid),
        title: record.title,
        directory: record.cwd,
        updated_at_ms: None,
        host: Some("VS Code".into()),
        live: true,
        holder: None,
    }
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
    let record = read(config, sid).ok()??;
    let process = table.process(record.pid)?;
    if process.start != record.start
        || !proof::held(config, table, record.pid, uid)
            .iter()
            .any(|id| id == sid)
    {
        return None;
    }
    Some(discovered(sid, record))
}
/// An unavailable state directory/record must not retire the previous domain.
pub fn discover(
    config: &CopilotConfig,
    table: &dyn ProcessTable,
    uid: u32,
) -> Option<Vec<DiscoveredSession>> {
    if !proof::SUPPORTED || !super::settings::installed_state(config).ok()? {
        return Some(Vec::new());
    }
    let entries = match std::fs::read_dir(config.state()) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Some(Vec::new()),
        Err(_) => return None,
    };
    let mut held = HashMap::new();
    let mut sessions = Vec::new();
    for entry in entries {
        let path = entry.ok()?.path();
        if path.extension().is_none_or(|ext| ext != "json") {
            continue;
        }
        let Some(sid) = path
            .file_stem()
            .and_then(|s| s.to_str())
            .filter(|s| is_uuid(s))
        else {
            continue;
        };
        let Some(record) = read(config, sid).ok()? else {
            continue;
        };
        let Some(process) = table.process(record.pid) else {
            continue;
        };
        if process.start != record.start {
            continue;
        }
        let ids = held
            .entry((process.pid, process.start))
            .or_insert_with(|| proof::held(config, table, process.pid, uid));
        if ids.iter().any(|id| id == sid) {
            sessions.push(discovered(sid, record));
        }
    }
    Some(sessions)
}
fn record_lock(config: &CopilotConfig, sid: &str) -> io::Result<std::fs::File> {
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
        return Err(io::Error::other("Copilot state lock is not private"));
    }
    fs2::FileExt::lock_exclusive(&lock)?;
    Ok(lock)
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
    let hook = table.process(pid).filter(|p| p.uid == uid)?;
    let runtime = table
        .process(hook.parent)
        .filter(|p| p.uid == uid && !table.zombie(p.pid))?;
    if !super::settings::caller_is_hook(config, table, pid, event) {
        return None;
    }
    // A previously verified runtime's incarnation is enough to stop orphaned
    // empty polls. A descriptor/signature scan still precedes every data claim.
    if idle_stop(config, payload, sid, event) {
        if read(config, sid)
            .ok()?
            .is_some_and(|record| record.pid == runtime.pid && record.start == runtime.start)
        {
            return (table.process(pid) == Some(hook)).then(|| json!({}));
        }
        // Recover a missed SessionStart or stale incarnation with full native proof below.
    }
    if !proof::hook_holds(config, table, pid, uid, sid)
        || table.process(pid) != Some(hook)
        || table.process(runtime.pid) != Some(runtime)
    {
        return None;
    }
    observe(config, table, uid, sid, runtime, payload)?;
    take_answer(config, payload, sid, event)
}

fn take_answer(config: &CopilotConfig, payload: &Value, sid: &str, event: &str) -> Option<Value> {
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
fn observe(
    config: &CopilotConfig,
    table: &dyn ProcessTable,
    uid: u32,
    sid: &str,
    runtime: ProcessInfo,
    payload: &Value,
) -> Option<()> {
    let _lock = record_lock(config, sid).ok()?;
    // Re-read while locked: two live runtimes cannot both create first claims.
    let old = read(config, sid).ok()?;
    if other_live_runtime(config, table, uid, sid, old.as_ref(), runtime.pid)
        || table.process(runtime.pid) != Some(runtime)
        || table.zombie(runtime.pid)
    {
        return None;
    }
    let record = Record {
        pid: runtime.pid,
        start: runtime.start,
        context_after: if payload["relayEvent"] == "start"
            || old
                .as_ref()
                .is_none_or(|r| r.pid != runtime.pid || r.start != runtime.start)
        {
            match std::fs::metadata(config.sessions().join(sid).join("events.jsonl")) {
                Ok(metadata) if metadata.is_file() => metadata.len(),
                Err(error) if error.kind() == io::ErrorKind::NotFound => 0,
                _ => return None,
            }
        } else {
            old.as_ref().map_or(0, |r| r.context_after)
        },
        title: record_title(old.as_ref(), payload),
        cwd: payload["cwd"]
            .as_str()
            .filter(|s| Path::new(s).is_absolute())
            .map(str::to_owned),
    };
    let bytes = serde_json::to_vec(&record).ok()?;
    let unchanged = old
        .as_ref()
        .and_then(|r| serde_json::to_vec(r).ok())
        .as_deref()
        == Some(bytes.as_slice());
    if !unchanged {
        crate::platform::fs::write_atomic(&config.state().join(format!("{sid}.json")), &bytes)
            .ok()?;
    }
    Some(())
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

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    #[test]
    fn competing_first_records_are_serialized_before_acceptance() {
        let (_home, config, table, _) = proof::tests::fixture();
        let sid = "1069773c-0824-4fad-b7f9-d3dc3c4ed148";
        let mut second = table.processes.lock().unwrap().get(&102).unwrap().clone();
        let lock = config.sessions().join(sid).join("inuse.202.hold");
        std::fs::write(&lock, "").unwrap();
        second.open_files = vec![lock];
        second.start = 202;
        table.insert(202, second);
        let first = table.process(102).unwrap();
        let second = table.process(202).unwrap();
        let barrier = std::sync::Barrier::new(2);
        let payload = json!({"initialPrompt":"First writer"});
        let accepted = std::thread::scope(|scope| {
            let run = |runtime| {
                barrier.wait();
                observe(&config, &table, 501, sid, runtime, &payload).is_some()
            };
            let a = scope.spawn(move || run(first));
            let b = scope.spawn(move || run(second));
            usize::from(a.join().unwrap()) + usize::from(b.join().unwrap())
        });
        assert_eq!(accepted, 1);
    }
}
