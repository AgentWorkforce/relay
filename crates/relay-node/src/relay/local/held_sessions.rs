//! The sessions a multi-session host above a caller holds, for a send token
//! (`relay::session_tokens`) to pick among. Only the nearest agent process
//! above the caller counts, and only when it is one of the hosts whose
//! callers are otherwise unattributed for holding several sessions: a Codex
//! app-server, an OpenCode process or managed OpenCode server, or a Cursor
//! window's extension host.
use super::*;

impl LocalSessions {
    /// The sessions the nearest agent process of this user's above `pid`
    /// (itself included) holds, when it is such a host and holds more than
    /// one; empty otherwise, and empty when the nearest agent is any other
    /// (a Claude Code session, a CLI Codex, Grok, Muse, Devin, Cursor CLI,
    /// Factory Droid or Copilot).
    pub(super) fn held_by_host(&self, pid: i32) -> Vec<Target> {
        let table = &*self.table;
        let uid = self.config.uid;
        let claude = claude::registry(&self.config.claude, table);
        let several = |held: Vec<Target>| if held.len() > 1 { held } else { Vec::new() };
        let mut current = pid;
        for _ in 0..MAX_ANCESTRY {
            if current <= 1 {
                return Vec::new();
            }
            let Some(process) = table.process(current) else {
                return Vec::new();
            };
            if process.uid == uid {
                if claude.sessions.iter().any(|s| s.pid == current)
                    || claude.unreadable.iter().any(|f| f.pid == current)
                {
                    return Vec::new();
                }
                if cursor_cli::editor::is_editor_host(table, current) {
                    let held = cursor_cli::editor::sessions(&self.config.cursor, table, uid)
                        .into_iter()
                        .filter(|session| session.host_pid == current)
                        .map(|session| Target::new(SessionKind::CursorCli, session.session_id))
                        .collect();
                    return several(held);
                }
                if crate::relay::opencode::is_opencode_process(table, current) {
                    return several(self.opencode_held(current));
                }
                let codex = table
                    .executable(current)
                    .is_some_and(|exe| table.is_trusted_codex(&exe));
                if codex {
                    let app_server = table
                        .arguments(current)
                        .iter()
                        .any(|argument| argument == "app-server");
                    if !app_server {
                        return Vec::new();
                    }
                    let held = codex_locked_threads(table, current)
                        .into_iter()
                        .map(|thread| Target::new(SessionKind::Codex, thread))
                        .collect();
                    return several(held);
                }
                let other_agent = !cursor_cli::editor::is_editor_worker(table, current)
                    && (grok_caller::is_verified_leader(table, current)
                        || crate::relay::existing_session::grok::is_leader(
                            &table.arguments(current),
                        )
                        || crate::relay::muse::is_muse_process(table, current)
                        || devin::is_devin_process(table, current)
                        || cursor_cli::is_cursor_process(table, current)
                        || crate::relay::hook_agents::is_copilot_process(table, current)
                        || crate::relay::droid::caller(
                            &crate::relay::droid::DroidConfig::from_local(&self.config),
                            table,
                            current,
                        )
                        .is_some());
                if other_agent {
                    return Vec::new();
                }
            }
            current = process.parent;
        }
        Vec::new()
    }

    /// The sessions the OpenCode process `holder` holds: a managed server's
    /// managed sessions, or an open OpenCode's plugin record while that
    /// route is on.
    fn opencode_held(&self, holder: i32) -> Vec<Target> {
        let table = &*self.table;
        if table
            .environment_var(holder, crate::relay::opencode_serve::MARKER)
            .is_some()
        {
            return self
                .managed
                .as_deref()
                .map(|managed| crate::relay::opencode::managed::served_by(managed, table, holder))
                .unwrap_or_default()
                .into_iter()
                .map(|binding| Target::new(SessionKind::OpenCode, binding.session_id))
                .collect();
        }
        if !self.config.opencode_open {
            return Vec::new();
        }
        crate::relay::opencode::open_processes(&self.config.opencode, table, self.config.uid)
            .into_iter()
            .filter(|process| process.pid == holder)
            .flat_map(|process| process.sessions)
            .map(|session| Target::new(SessionKind::OpenCodeOpen, session.session_id))
            .collect()
    }
}
