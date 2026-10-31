//! Which agent process is nearest above a caller, so a tag a nested
//! session inherited never names an outer one.
use super::*;
use crate::relay::process::ProcessInfo;

impl LocalSessions {
    /// The caller's Claude Code session when `process`, met on the walk up
    /// from the caller, is a live one with its recorded start time: its
    /// conversation, or nobody when `below`, the walk's last step, is a
    /// process it started before `/clear` began that conversation (it
    /// belongs to the conversation that was cleared, which no longer runs)
    /// or the process changed after the registry was read. `None` when
    /// `process` is no Claude Code session.
    pub(super) fn claude_caller(
        &self,
        claude: &claude::Registry,
        process: ProcessInfo,
        below: Option<&ProcessInfo>,
    ) -> Option<Result<Target, CallerMiss>> {
        let table = &*self.table;
        let session = claude.sessions.iter().find(|s| {
            s.pid == process.pid
                && s.can_reply()
                && s.proc_start
                    .as_deref()
                    .is_some_and(|start| claude_start_matches(table.start_clock(), start, &process))
        })?;
        let cleared = below.is_some_and(|child| {
            claude::started_before_clear(&self.config.claude, table, session, child)
        });
        Some(
            (!cleared && table.process(process.pid) == Some(process))
                .then(|| Target::new(SessionKind::ClaudeTerminal, session.session_id.clone()))
                .ok_or(CallerMiss::NotASession),
        )
    }

    /// Whether the nearest agent process of this user's above `pid` (itself
    /// included) is OpenCode, rather than a Claude Code session, a trusted
    /// Codex, a Grok leader, Muse or Devin.
    pub(super) fn opencode_is_nearest(&self, pid: i32, claude: &claude::Registry) -> bool {
        let table = &*self.table;
        let mut current = pid;
        for _ in 0..MAX_ANCESTRY {
            if current <= 1 {
                return false;
            }
            let Some(process) = table.process(current) else {
                return false;
            };
            if process.uid == self.config.uid {
                if crate::relay::opencode::is_opencode_process(table, current) {
                    return true;
                }
                let agent = claude.sessions.iter().any(|s| s.pid == current)
                    || claude.unreadable.iter().any(|f| f.pid == current)
                    || table
                        .executable(current)
                        .is_some_and(|exe| table.is_trusted_codex(&exe))
                    || crate::relay::existing_session::grok::is_leader(&table.arguments(current))
                    || (self.config.muse_open
                        && crate::relay::muse::is_muse_process(table, current))
                    || devin::is_devin_process(table, current)
                    || crate::relay::cursor_cli::is_cursor_process(table, current);
                if agent {
                    return false;
                }
            }
            current = process.parent;
        }
        false
    }

    /// Whether the nearest agent process of this user's above `pid` (itself
    /// included) is a `devin` or `cursor-agent` one, rather than a Claude
    /// Code session, a trusted Codex, a Grok leader, OpenCode or Muse. It is
    /// what stops an environment tag a nested Devin or Cursor CLI session
    /// inherited from an enclosing agent naming that outer session: the file
    /// its own process holds decides instead.
    pub(super) fn devin_is_nearest(&self, pid: i32, claude: &claude::Registry) -> bool {
        let table = &*self.table;
        let mut current = pid;
        for _ in 0..MAX_ANCESTRY {
            if current <= 1 {
                return false;
            }
            let Some(process) = table.process(current) else {
                return false;
            };
            if process.uid == self.config.uid {
                if devin::is_devin_process(table, current)
                    || crate::relay::cursor_cli::is_cursor_process(table, current)
                {
                    return true;
                }
                let agent = claude.sessions.iter().any(|s| s.pid == current)
                    || claude.unreadable.iter().any(|f| f.pid == current)
                    || table
                        .executable(current)
                        .is_some_and(|exe| table.is_trusted_codex(&exe))
                    || crate::relay::existing_session::grok::is_leader(&table.arguments(current))
                    || (self.config.opencode_open
                        && crate::relay::opencode::is_opencode_process(table, current))
                    || (self.config.muse_open
                        && crate::relay::muse::is_muse_process(table, current));
                if agent {
                    return false;
                }
            }
            current = process.parent;
        }
        false
    }
}
