//! Which agent process is nearest above a caller, so a tag a nested
//! session inherited never names an outer one.
use super::*;

impl LocalSessions {
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
                    || (self.config.muse_spawn
                        && crate::relay::muse::is_muse_process(table, current))
                    || devin::is_devin_process(table, current);
                if agent {
                    return false;
                }
            }
            current = process.parent;
        }
        false
    }

    /// Whether the nearest agent process of this user's above `pid` (itself
    /// included) is a `devin` one, rather than a Claude Code session, a
    /// trusted Codex, a Grok leader, OpenCode or Muse. It is what stops an
    /// environment tag a nested Devin session inherited from an enclosing
    /// agent naming that outer session: its own lock decides instead.
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
                if devin::is_devin_process(table, current) {
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
                    || (self.config.muse_spawn
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
