//! Native plugin attribution must see duplicate records before ordinary session
//! discovery coalesces them by PID. A stale record in another shared login must
//! never select whichever configuration folder happened to be enumerated first.
use crate::relay::claude::{self, ClaudeConfig, TerminalSession};
use crate::relay::process::ProcessTable;
use crate::relay::store::Target;
use std::collections::BTreeMap;
use std::path::PathBuf;

pub(super) fn read(config: &ClaudeConfig, table: &dyn ProcessTable) -> BTreeMap<Target, PathBuf> {
    config.dirs.remember_running(table);
    let mut sessions = Vec::new();
    for registry in config.registries() {
        let entries = match std::fs::read_dir(&registry) {
            Ok(entries) => entries,
            // A missing registry is normal for a login without running sessions.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return BTreeMap::new(),
        };
        for entry in entries {
            let Ok(entry) = entry else {
                return BTreeMap::new();
            };
            let path = entry.path();
            if !path.extension().is_some_and(|ext| ext == "json") {
                continue;
            }
            let session = std::fs::read(&path)
                .ok()
                .and_then(|bytes| TerminalSession::decode(&bytes));
            let Some(mut session) = session else {
                // A live partial rewrite could hide a duplicate session ID.
                // Suspend capability until discovery can prove attribution;
                // this empty snapshot does not revoke remembered generations.
                if let Some(pid) = path
                    .file_stem()
                    .and_then(|name| name.to_str())
                    .and_then(|name| name.parse::<i32>().ok())
                    .filter(|pid| *pid > 0)
                {
                    if table.process(pid).is_some() {
                        return BTreeMap::new();
                    }
                }
                continue;
            };
            if claude::is_alive(table, &session) {
                session.registry = Some(registry.clone());
                sessions.push(session);
            }
        }
    }
    crate::relay::claude_mobile_plugin::session_roots(config, &sessions)
}

#[cfg(test)]
mod tests;
