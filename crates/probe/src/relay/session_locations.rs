//! Keep verified session origins locally, independently of disposable history indexes.
//! Window focusing stays in the UI process so macOS attributes Automation permission
//! to the app the person clicked, not a background service.
use crate::relay::{
    contract::session_locations::*,
    local::LocalConfig,
    process::{ProcessInfo, ProcessTable, MAX_ANCESTRY},
    sessions::DiscoveredSession,
};
use rusqlite::{params, Connection};
use std::collections::{BTreeSet, HashSet};

pub fn unavailable() -> SessionLocationReport {
    SessionLocationReport {
        supported: false,
        running: false,
        current: vec![],
        previous: vec![],
        desktop_link: None,
        reason: Some("Exact window navigation is currently available on macOS only.".into()),
    }
}

fn database(config: &LocalConfig) -> Result<Option<Connection>, String> {
    let Some(root) = &config.probe_root else {
        return Ok(None);
    };
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let db = Connection::open(root.join("session-locations.sqlite3")).map_err(|e| e.to_string())?;
    db.busy_timeout(std::time::Duration::from_secs(2))
        .map_err(|e| e.to_string())?;
    db.execute_batch("CREATE TABLE IF NOT EXISTS locations(source TEXT NOT NULL, session_id TEXT NOT NULL, pid INTEGER NOT NULL, start TEXT NOT NULL, location TEXT NOT NULL, PRIMARY KEY(source,session_id,pid,start));").map_err(|e| e.to_string())?;
    Ok(Some(db))
}

fn save(
    db: &Connection,
    source: &str,
    id: &str,
    locations: &[SessionLocation],
) -> Result<(), String> {
    for location in locations {
        let json = serde_json::to_string(location).map_err(|e| e.to_string())?;
        db.execute("INSERT INTO locations VALUES (?1,?2,?3,?4,?5) ON CONFLICT(source,session_id,pid,start) DO UPDATE SET location=excluded.location", params![source,id,location.pid,location.process_start.to_string(),json]).map_err(|e| e.to_string())?;
    }
    // Bound each session's navigation history without discarding other sessions.
    db.execute("DELETE FROM locations WHERE source=?1 AND session_id=?2 AND rowid NOT IN (SELECT rowid FROM locations WHERE source=?1 AND session_id=?2 ORDER BY json_extract(location,'$.observed_at_ms') DESC LIMIT 20)", params![source,id]).map_err(|e| e.to_string())?;
    Ok(())
}

fn history(db: &Connection, source: &str, id: &str) -> Result<Vec<SessionLocation>, String> {
    let mut query = db.prepare("SELECT location FROM locations WHERE source=?1 AND session_id=?2 ORDER BY json_extract(location,'$.observed_at_ms') DESC").map_err(|e| e.to_string())?;
    let rows = query
        .query_map(params![source, id], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .map(|row| {
            row.map_err(|e| e.to_string())
                .and_then(|json| serde_json::from_str(&json).map_err(|e| e.to_string()))
        })
        .collect();
    rows
}

pub fn report(
    config: &LocalConfig,
    table: &dyn ProcessTable,
    source: &str,
    id: &str,
) -> Result<SessionLocationReport, String> {
    if !cfg!(target_os = "macos") {
        return Ok(unavailable());
    }
    let owners = owners(config, table, source, &BTreeSet::from([id.to_owned()]));
    let running = !owners.is_empty();
    let current = locations(
        table,
        config.uid,
        owners.into_iter().map(|(_, process)| process),
    );
    let previous = if let Some(db) = database(config)? {
        save(&db, source, id, &current)?;
        history(&db, source, id)?
            .into_iter()
            .filter(|old| {
                !current
                    .iter()
                    .any(|now| now.pid == old.pid && now.process_start == old.process_start)
            })
            .collect()
    } else {
        vec![]
    };
    let desktop_link = (source == "claude")
        .then(|| claude_link(config, id))
        .flatten();
    Ok(SessionLocationReport {
        supported: true,
        running,
        current,
        previous,
        desktop_link,
        reason: None,
    })
}

/// Called by presentation discovery, so sessions need not be clicked to be remembered.
pub fn observe(config: &LocalConfig, table: &dyn ProcessTable, sessions: &[DiscoveredSession]) {
    if !cfg!(target_os = "macos") {
        return;
    }
    let mut db = match database(config) {
        Ok(Some(db)) => db,
        Ok(None) => return,
        Err(error) => {
            eprintln!("[session-locations] Could not open observation store: {error}");
            return;
        }
    };
    let tx = match db.transaction() {
        Ok(tx) => tx,
        Err(error) => {
            eprintln!("[session-locations] Could not begin observations: {error}");
            return;
        }
    };
    for source in ["codex", "claude", "grok"] {
        let ids: BTreeSet<_> = sessions
            .iter()
            .filter_map(|session| session.target.upload_key())
            .filter_map(|key| key.strip_prefix(&format!("{source}:")).map(str::to_owned))
            .collect();
        if ids.is_empty() {
            continue;
        }
        let owners = owners(config, table, source, &ids);
        for id in ids {
            let locations = locations(
                table,
                config.uid,
                owners
                    .iter()
                    .filter(|(key, _)| key == &id)
                    .map(|(_, process)| *process),
            );
            if locations.is_empty() {
                continue;
            }
            if let Err(error) = save(&tx, source, &id, &locations) {
                eprintln!("[session-locations] Could not retain observation: {error}");
            }
        }
    }
    if let Err(error) = tx.commit() {
        eprintln!("[session-locations] Could not commit observations: {error}");
    }
}

fn owners(
    config: &LocalConfig,
    table: &dyn ProcessTable,
    source: &str,
    ids: &BTreeSet<String>,
) -> Vec<(String, ProcessInfo)> {
    let candidates: Vec<(String, i32, Option<u64>)> = match source {
        "codex" => crate::relay::codex::processes::process_sessions(table, config.uid, ids)
            .into_iter()
            .filter(|s| {
                table
                    .process(s.pid)
                    .is_some_and(|p| p.start == s.start && !table.zombie(p.pid))
            })
            .map(|s| (s.thread, s.pid, Some(s.start)))
            .collect(),
        "claude" => crate::relay::claude::terminal_sessions(&config.claude, table)
            .into_iter()
            .filter(|s| ids.contains(&s.session_id))
            .filter_map(|s| {
                let process = table.process(s.pid)?;
                if process.uid != config.uid
                    || table.zombie(s.pid)
                    || !crate::relay::process::claude_start_matches(
                        table.start_clock(),
                        s.proc_start.as_deref()?,
                        &process,
                    )
                {
                    return None;
                }
                Some((s.session_id, s.pid, Some(process.start)))
            })
            .collect(),
        "grok" => crate::relay::grok::open_sessions(&config.grok, table, config.uid)
            .into_iter()
            .filter(|s| ids.contains(&s.session_id))
            .filter_map(|s| {
                let process = table.process(s.pid)?;
                // The TUI registry lacks procStart. Its observation must be newer
                // than this incarnation, or a recycled Grok PID could steal it.
                let opened = u64::try_from(s.opened_at_ms?).ok()?;
                if table.start_clock() != crate::relay::process::StartClock::Micros
                    || process.start / 1000 > opened
                {
                    return None;
                }
                Some((s.session_id, s.pid, Some(process.start)))
            })
            .collect(),
        _ => vec![],
    };
    candidates
        .into_iter()
        .filter_map(|(id, pid, expected)| {
            let process = table.process(pid).filter(|p| {
                p.uid == config.uid
                    && !table.zombie(pid)
                    && expected.is_none_or(|start| start == p.start)
            })?;
            Some((id, process))
        })
        .collect()
}

fn locations(
    table: &dyn ProcessTable,
    uid: u32,
    processes: impl Iterator<Item = ProcessInfo>,
) -> Vec<SessionLocation> {
    let mut locations = vec![];
    for process in processes {
        if table.process(process.pid) != Some(process) {
            continue;
        }
        if let Some(location) = from_process(table, uid, process.pid)
            .filter(|location| location.process_start == process.start)
        {
            // Tool children and their owner can prove the same pane.
            if !locations.iter().any(|old: &SessionLocation| {
                old.bundle_id == location.bundle_id && old.tty == location.tty
            }) {
                locations.push(location);
            }
        }
    }
    locations
}

fn application(exe: &std::path::Path) -> Option<(&'static str, &'static str)> {
    let path = exe.to_str()?;
    [
        (
            "/Ghostty.app/Contents/MacOS/ghostty",
            "Ghostty",
            "com.mitchellh.ghostty",
        ),
        (
            "/Terminal.app/Contents/MacOS/Terminal",
            "Terminal",
            "com.apple.Terminal",
        ),
        (
            "/iTerm.app/Contents/MacOS/iTerm2",
            "iTerm2",
            "com.googlecode.iterm2",
        ),
        (
            "/ChatGPT.app/Contents/MacOS/ChatGPT",
            "Codex",
            "com.openai.codex",
        ),
        (
            "/Codex.app/Contents/MacOS/Codex",
            "Codex",
            "com.openai.codex",
        ),
        (
            "/Claude.app/Contents/MacOS/Claude",
            "Claude",
            "com.anthropic.claudefordesktop",
        ),
        (
            "/Warp.app/Contents/MacOS/stable",
            "Warp",
            "dev.warp.Warp-Stable",
        ),
        (
            "/kitty.app/Contents/MacOS/kitty",
            "Kitty",
            "net.kovidgoyal.kitty",
        ),
        (
            "/WezTerm.app/Contents/MacOS/wezterm-gui",
            "WezTerm",
            "com.github.wez.wezterm",
        ),
        (
            "/Alacritty.app/Contents/MacOS/alacritty",
            "Alacritty",
            "org.alacritty",
        ),
        (
            "/Visual Studio Code.app/Contents/MacOS/Electron",
            "Visual Studio Code",
            "com.microsoft.VSCode",
        ),
        (
            "/Cursor.app/Contents/MacOS/Cursor",
            "Cursor",
            "com.todesktop.230313mzl4w4u92",
        ),
        ("/Zed.app/Contents/MacOS/zed", "Zed", "dev.zed.Zed"),
        ("/cmux.app/Contents/MacOS/cmux", "cmux", "com.cmuxterm.app"),
    ]
    .into_iter()
    .find(|(suffix, _, _)| path.ends_with(suffix))
    .map(|(_, name, bundle)| (name, bundle))
}

fn from_process(table: &dyn ProcessTable, uid: u32, pid: i32) -> Option<SessionLocation> {
    let owner = table
        .process(pid)
        .filter(|p| p.uid == uid && !table.zombie(pid))?;
    let tty = table
        .terminal_path(pid)
        .map(|p| p.to_string_lossy().into_owned());
    let mut current = pid;
    let mut seen = HashSet::new();
    for _ in 0..MAX_ANCESTRY {
        if !seen.insert(current) {
            return None;
        }
        let process = table
            .process(current)
            .filter(|p| p.uid == uid && !table.zombie(current))?;
        if let Some((name, bundle)) = table.executable(current).as_deref().and_then(application) {
            if table.process(pid) != Some(owner) || table.process(current) != Some(process) {
                return None;
            }
            // A GUI ancestor alone cannot identify a terminal pane.
            if !matches!(name, "Codex" | "Claude") && tty.is_none() {
                return None;
            }
            return Some(SessionLocation {
                application: name.into(),
                bundle_id: bundle.into(),
                pid,
                process_start: owner.start,
                tty,
                observed_at_ms: crate::relay::state::now_ms(),
            });
        }
        if process.parent <= 1 {
            return None;
        }
        current = process.parent;
    }
    None
}

#[cfg(test)]
mod tests;

/// Claude Desktop's local_* identity differs from its cliSessionId. Only the
/// provider's record establishes that mapping; titles and cwd never do.
fn claude_link(config: &LocalConfig, id: &str) -> Option<String> {
    let root = config
        .claude
        .app_sessions
        .as_ref()?
        .parent()?
        .join("claude-code-sessions");
    claude_desktop_id(&root, id).map(|local| format!("claude://code/continue?session={local}"))
}

fn claude_desktop_id(root: &std::path::Path, id: &str) -> Option<String> {
    fn entries(path: &std::path::Path) -> Vec<std::path::PathBuf> {
        std::fs::read_dir(path)
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .map(|e| e.path())
            .collect()
    }
    let mut matches = HashSet::new();
    for file in entries(root)
        .iter()
        .flat_map(|org| entries(org))
        .flat_map(|account| entries(&account))
    {
        if file.extension().is_none_or(|ext| ext != "json") {
            continue;
        }
        let Ok(metadata) = std::fs::symlink_metadata(&file) else {
            continue;
        };
        if !metadata.is_file() || metadata.len() > 1_048_576 {
            continue;
        }
        let Some(value) = std::fs::read(&file)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        else {
            continue;
        };
        if value["cliSessionId"].as_str() != Some(id) || value["isArchived"].as_bool() == Some(true)
        {
            continue;
        }
        let Some(local) = value["sessionId"].as_str() else {
            continue;
        };
        if local.strip_prefix("local_").is_some_and(|rest| {
            !rest.is_empty()
                && rest.len() <= 64
                && rest.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        }) {
            matches.insert(local.to_owned());
        }
    }
    (matches.len() == 1)
        .then(|| matches.into_iter().next())
        .flatten()
}
