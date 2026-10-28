//! Sessions hosted by Paseo. Paseo starts each agent beneath its packaged
//! desktop daemon: a Codex app-server, `grok agent stdio` for Grok, or
//! `muse serve` for Muse. Grok's TUI registry does not record the stdio
//! process, and Muse's runtime registry does not record the serve process,
//! so each session id is the one Paseo stored for that agent.

use crate::relay::process::{ProcessTable, MAX_ANCESTRY};
use crate::relay::store::is_uuid;
use serde_json::Value;
use std::path::{Path, PathBuf};

pub const HOST: &str = "paseo";

pub fn is_helper(executable: &Path) -> bool {
    let path = executable.to_string_lossy();
    (path.starts_with("/Applications/Paseo.app/")
        || (path.starts_with("/Users/") && path.contains("/Applications/Paseo.app/")))
        && path.ends_with("/Paseo Helper.app/Contents/MacOS/Paseo Helper")
}

/// Whether `pid` descends from this user's packaged Paseo helper. The
/// bundle path, rather than the mutable process title, is the host proof.
pub fn under_daemon(table: &dyn ProcessTable, uid: u32, pid: i32) -> bool {
    under_daemon_excluding(table, uid, pid, &|_| false)
}

/// `under_daemon`, stopping when another provider session lies between the
/// candidate and Paseo. This keeps a Claude SDK/print run started by a Paseo
/// chat from inheriting the chat's host identity.
pub fn under_daemon_excluding(
    table: &dyn ProcessTable,
    uid: u32,
    pid: i32,
    provider_session: &dyn Fn(i32) -> bool,
) -> bool {
    let mut current = pid;
    for _ in 0..MAX_ANCESTRY {
        let Some(process) = table.process(current).filter(|p| p.uid == uid) else {
            return false;
        };
        if current != pid
            && table
                .executable(current)
                .is_some_and(|executable| is_helper(&executable))
        {
            return true;
        }
        if current != pid && provider_session(current) {
            return false;
        }
        if process.parent <= 1 {
            return false;
        }
        current = process.parent;
    }
    false
}

/// One session Paseo recorded for an agent: its provider session id, and the
/// title Paseo shows when that title is short enough to list.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecordedSession {
    pub session_id: String,
    pub title: Option<String>,
}

/// The Grok session id Paseo recorded for `agent_id` working in `cwd`.
/// The record is `<paseo_home>/agents/<directory>/<agent_id>.json`: a regular
/// file, provider `grok`, whose `cwd` is this directory, naming one UUID
/// session id. A symlink is not a record, and two records that disagree
/// name nothing.
pub fn grok_session_id(paseo_home: &Path, agent_id: &str, cwd: &str) -> Option<String> {
    recorded_session(paseo_home, agent_id, cwd, "grok").map(|session| session.session_id)
}

/// The Muse session Paseo recorded for `agent_id` working in `cwd`. The
/// record is the same file as [`grok_session_id`], with provider `muse`.
pub fn muse_agent(paseo_home: &Path, agent_id: &str, cwd: &str) -> Option<RecordedSession> {
    recorded_session(paseo_home, agent_id, cwd, "muse")
}

/// The session Paseo recorded for `agent_id` in `cwd` when the record's
/// provider is `provider`.
fn recorded_session(
    paseo_home: &Path,
    agent_id: &str,
    cwd: &str,
    provider: &str,
) -> Option<RecordedSession> {
    let agent_id = agent_id.trim();
    if !is_uuid(agent_id) || !Path::new(cwd).is_absolute() {
        return None;
    }
    let Ok(entries) = std::fs::read_dir(paseo_home.join("agents")) else {
        return None;
    };
    let mut found = None;
    for entry in entries.flatten() {
        let directory = entry.path();
        if !std::fs::symlink_metadata(&directory).is_ok_and(|meta| meta.is_dir()) {
            continue;
        }
        let file = directory.join(format!("{agent_id}.json"));
        if !std::fs::symlink_metadata(&file).is_ok_and(|meta| meta.is_file()) {
            continue;
        }
        let Some(session) = read_agent(&file, cwd, provider) else {
            continue;
        };
        match &found {
            None => found = Some(session),
            // The same id recorded twice is one session. A second title does
            // not change the first, and a second id names nothing.
            Some(existing) if existing.session_id == session.session_id => {}
            Some(_) => return None,
        }
    }
    found
}

/// `file`'s session when it is Paseo's record of a `provider` agent in `cwd`.
fn read_agent(file: &Path, cwd: &str, provider: &str) -> Option<RecordedSession> {
    let data = std::fs::read(file).ok()?;
    let value: Value = serde_json::from_slice(&data).ok()?;
    if value.get("provider").and_then(Value::as_str) != Some(provider) {
        return None;
    }
    let recorded = value.get("cwd").and_then(Value::as_str)?;
    if !same_directory(recorded, cwd) {
        return None;
    }
    // A present field that does not decode is not a missing field. Both
    // present ids must be the same UUID, or the record names nothing.
    let runtime = stored_session_id(&value, "/runtimeInfo/sessionId").ok()?;
    let persisted = stored_session_id(&value, "/persistence/sessionId").ok()?;
    let session_id = match (runtime, persisted) {
        (Some(runtime), Some(persisted)) if runtime == persisted => runtime,
        (Some(runtime), None) => runtime,
        (None, Some(persisted)) => persisted,
        _ => return None,
    };
    let title = value
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|title| !title.is_empty() && title.chars().count() <= 120)
        .map(str::to_string);
    Some(RecordedSession { session_id, title })
}

/// The id at `pointer`. `Ok(None)` when the field is absent or null.
/// `Err` when it is present and is not a UUID or a version-1 plugin
/// envelope, including a non-string. `Ok(Some)` when it decodes.
fn stored_session_id(value: &Value, pointer: &str) -> Result<Option<String>, ()> {
    match value.pointer(pointer) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(raw)) => session_id_of(raw).map(Some).ok_or(()),
        Some(_) => Err(()),
    }
}

/// The session id Paseo stored. Claude, Codex and Grok store the UUID
/// itself. Muse stores a version-1 plugin envelope,
/// `plugin:{"version":1,"data":{"sessionId":"<uuid>",...}}`, and the id is
/// the UUID inside it. Anything else names no session.
fn session_id_of(value: &str) -> Option<String> {
    let value = value.trim();
    if is_uuid(value) {
        return Some(value.to_string());
    }
    let payload = value.strip_prefix("plugin:")?;
    let envelope: Value = serde_json::from_str(payload).ok()?;
    if envelope.get("version").and_then(Value::as_u64) != Some(1) {
        return None;
    }
    let session_id = envelope
        .pointer("/data/sessionId")
        .and_then(Value::as_str)
        .map(str::trim)?;
    is_uuid(session_id).then(|| session_id.to_string())
}

fn same_directory(left: &str, right: &str) -> bool {
    let left = normalize_directory(left);
    let right = normalize_directory(right);
    if left == right {
        return true;
    }
    match (std::fs::canonicalize(&left), std::fs::canonicalize(&right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

/// `cwd` without a trailing slash. `/` and `//` stay `/`: stripping every
/// slash would make the root directory an empty string, which then matches
/// no record and no session directory.
pub(crate) fn normalize_directory(cwd: &str) -> String {
    let cwd = cwd.trim();
    let trimmed = cwd.trim_end_matches('/');
    if trimmed.is_empty() && cwd.starts_with('/') {
        "/".to_string()
    } else {
        trimmed.to_string()
    }
}

/// `PASEO_HOME` from `pid`, else `~/.paseo` of that process's own `HOME`.
/// Relative paths name nothing: the probe's environment decides no home.
pub fn home_of(table: &dyn ProcessTable, pid: i32) -> Option<PathBuf> {
    if let Some(home) = table.environment_var(pid, "PASEO_HOME") {
        let home = PathBuf::from(home.trim());
        return home.is_absolute().then_some(home);
    }
    let home = PathBuf::from(table.environment_var(pid, "HOME")?.trim());
    home.is_absolute().then(|| home.join(".paseo"))
}

// Paseo is a macOS app: its fixtures are Unix paths and symlinks. On
// Windows no process is its helper, so nothing is listed as Paseo's.
#[cfg(test)]
#[cfg(unix)]
mod tests {
    use super::*;
    use crate::relay::process::{FakeProcess, FakeProcesses};

    fn process(parent: i32, uid: u32, executable: Option<&str>) -> FakeProcess {
        FakeProcess {
            parent,
            uid,
            start: 1,
            executable: executable.map(Into::into),
            ..FakeProcess::default()
        }
    }

    #[test]
    fn only_this_users_packaged_paseo_helper_counts() {
        let helper = "/Applications/Paseo.app/Contents/Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper";
        let table = FakeProcesses::default();
        table.insert(10, process(1, 501, Some(helper)));
        table.insert(20, process(10, 501, Some("/opt/homebrew/bin/node")));
        table.insert(30, process(20, 501, Some("/opt/homebrew/bin/codex")));
        assert!(is_helper(Path::new(helper)));
        assert!(under_daemon(&table, 501, 30));
        assert!(!under_daemon(&table, 502, 30));
        table.insert(
            10,
            process(
                1,
                501,
                Some("/tmp/Paseo.app/Contents/Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper"),
            ),
        );
        assert!(!under_daemon(&table, 501, 30));
    }

    #[test]
    fn a_paseo_agent_record_names_one_grok_session_for_its_directory() {
        let temp = tempfile::tempdir().unwrap();
        let agent = "b90723ba-d4a3-4a9e-986d-a08ee7400fc4";
        let session = "01a12bc0-bad2-7a10-a329-bf8268fda492";
        let cwd = "/Users/me/Projects/cloud";
        let file = temp
            .path()
            .join("agents/cloud")
            .join(format!("{agent}.json"));
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(
            &file,
            serde_json::json!({
                "provider": "grok",
                "cwd": cwd,
                "runtimeInfo": {"sessionId": session},
                "persistence": {"sessionId": session},
            })
            .to_string(),
        )
        .unwrap();
        assert_eq!(
            grok_session_id(temp.path(), agent, cwd).as_deref(),
            Some(session)
        );
        assert_eq!(grok_session_id(temp.path(), agent, "/Users/me/other"), None);
        std::fs::write(
            &file,
            serde_json::json!({
                "provider": "codex",
                "cwd": cwd,
                "runtimeInfo": {"sessionId": session},
            })
            .to_string(),
        )
        .unwrap();
        assert_eq!(grok_session_id(temp.path(), agent, cwd), None);
        // A symlink is not the record, and two disagreeing records name nothing.
        std::fs::write(
            &file,
            serde_json::json!({
                "provider": "grok",
                "cwd": cwd,
                "runtimeInfo": {"sessionId": session},
                "persistence": {"sessionId": "01a12bc0-bad2-7a10-a329-bf8268fda493"},
            })
            .to_string(),
        )
        .unwrap();
        assert_eq!(grok_session_id(temp.path(), agent, cwd), None);
        std::fs::write(
            &file,
            serde_json::json!({
                "provider": "grok",
                "cwd": cwd,
                "runtimeInfo": {"sessionId": session},
            })
            .to_string(),
        )
        .unwrap();
        std::fs::rename(&file, temp.path().join("real.json")).unwrap();
        // Creating a symlink on Windows takes Developer Mode or an
        // administrator, so this part runs where it always can.
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(temp.path().join("real.json"), &file).unwrap();
            assert_eq!(
                grok_session_id(temp.path(), agent, cwd),
                None,
                "a symlink is not the record"
            );
        }
        // The root directory stays `/` after trailing slashes are stripped.
        let root = temp
            .path()
            .join("agents/root")
            .join(format!("{agent}.json"));
        std::fs::create_dir_all(root.parent().unwrap()).unwrap();
        std::fs::write(
            &root,
            serde_json::json!({
                "provider": "grok",
                "cwd": "/",
                "runtimeInfo": {"sessionId": session},
            })
            .to_string(),
        )
        .unwrap();
        assert_eq!(normalize_directory("/"), "/");
        assert_eq!(normalize_directory("//"), "/");
        assert_eq!(normalize_directory("/Users/me/"), "/Users/me");
        assert_eq!(
            grok_session_id(temp.path(), agent, "/").as_deref(),
            Some(session)
        );
        assert_eq!(
            grok_session_id(temp.path(), agent, "//").as_deref(),
            Some(session)
        );
    }

    #[test]
    fn a_paseo_agent_record_names_one_muse_session_for_its_directory() {
        let temp = tempfile::tempdir().unwrap();
        let agent = "b90723ba-d4a3-4a9e-986d-a08ee7400fc4";
        let session = "01a12c05-f04a-76d1-a7eb-b766828b8373";
        let cwd = "/Users/me/Projects/relay-desktop";
        let file = temp
            .path()
            .join("agents/relay-desktop")
            .join(format!("{agent}.json"));
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(
            &file,
            serde_json::json!({
                "provider": "muse",
                "cwd": cwd,
                "title": "paseo muse",
                "runtimeInfo": {"sessionId": session},
                "persistence": {"sessionId": session},
            })
            .to_string(),
        )
        .unwrap();
        assert_eq!(
            muse_agent(temp.path(), agent, cwd),
            Some(RecordedSession {
                session_id: session.into(),
                title: Some("paseo muse".into()),
            })
        );
        assert_eq!(grok_session_id(temp.path(), agent, cwd), None);
        assert_eq!(muse_agent(temp.path(), agent, "/Users/me/other"), None);
    }

    #[test]
    fn a_muse_session_id_inside_paseos_plugin_envelope_is_the_session() {
        let temp = tempfile::tempdir().unwrap();
        let agent = "ee221405-04be-46d3-b10d-2d32f150f116";
        let session = "01a12c74-e3fb-7a31-8781-6d074c96f3b9";
        let cwd = "/Users/me/Projects/relay-desktop";
        let envelope = |session_id: &str, model: &str| {
            format!(
                "plugin:{{\"version\":1,\"data\":{{\"sessionId\":\"{session_id}\",\"model\":\"{model}\",\"thinkingOption\":\"high\"}}}}"
            )
        };
        let file = temp
            .path()
            .join("agents/relay-desktop")
            .join(format!("{agent}.json"));
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(
            &file,
            serde_json::json!({
                "provider": "muse",
                "cwd": cwd,
                "title": "ping",
                "runtimeInfo": {"sessionId": envelope(session, "muse-spark-1.3")},
                "persistence": {"sessionId": envelope(session, "muse-spark-1.3")},
            })
            .to_string(),
        )
        .unwrap();
        assert_eq!(
            muse_agent(temp.path(), agent, cwd).unwrap().session_id,
            session
        );
        // The same id in a bare field and an envelope is still one session.
        std::fs::write(
            &file,
            serde_json::json!({
                "provider": "muse",
                "cwd": cwd,
                "runtimeInfo": {"sessionId": session},
                "persistence": {"sessionId": envelope(session, "other-model")},
            })
            .to_string(),
        )
        .unwrap();
        assert_eq!(
            muse_agent(temp.path(), agent, cwd).unwrap().session_id,
            session
        );
        std::fs::write(
            &file,
            serde_json::json!({
                "provider": "muse",
                "cwd": cwd,
                "runtimeInfo": {"sessionId": envelope(session, "muse-spark-1.3")},
                "persistence": {"sessionId": envelope("01a12c74-dc06-78d3-9b42-024867528860", "muse-spark-1.3")},
            })
            .to_string(),
        )
        .unwrap();
        assert_eq!(muse_agent(temp.path(), agent, cwd), None);
        // A present field that does not decode does not fall back to the
        // other field, even when that other field is a valid id.
        std::fs::write(
            &file,
            serde_json::json!({
                "provider": "muse",
                "cwd": cwd,
                "runtimeInfo": {"sessionId": envelope(session, "muse-spark-1.3")},
                "persistence": {"sessionId": "plugin:{\"version\":2,\"data\":{\"sessionId\":\"01a12c74-e3fb-7a31-8781-6d074c96f3b9\"}}"},
            })
            .to_string(),
        )
        .unwrap();
        assert_eq!(muse_agent(temp.path(), agent, cwd), None);
        std::fs::write(
            &file,
            serde_json::json!({
                "provider": "muse",
                "cwd": cwd,
                "runtimeInfo": {"sessionId": "not-a-uuid"},
                "persistence": {"sessionId": session},
            })
            .to_string(),
        )
        .unwrap();
        assert_eq!(muse_agent(temp.path(), agent, cwd), None);
        for session_id in [
            "plugin:not-json",
            "plugin:{\"version\":2,\"data\":{\"sessionId\":\"01a12c74-e3fb-7a31-8781-6d074c96f3b9\"}}",
            "plugin:{\"version\":1,\"data\":{\"sessionId\":\"not-a-uuid\"}}",
            "plugin:{\"data\":{\"sessionId\":\"01a12c74-e3fb-7a31-8781-6d074c96f3b9\"}}",
        ] {
            std::fs::write(
                &file,
                serde_json::json!({
                    "provider": "muse",
                    "cwd": cwd,
                    "runtimeInfo": {"sessionId": session_id},
                })
                .to_string(),
            )
            .unwrap();
            assert_eq!(muse_agent(temp.path(), agent, cwd), None, "{session_id}");
        }
    }
}
