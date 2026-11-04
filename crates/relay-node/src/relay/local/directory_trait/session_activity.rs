//! What this computer's sessions are doing (`relay::activity`), from their
//! own records: Claude Code's registry status, task list and TodoWrite
//! calls, and Codex's rollout turns and `update_plan` calls.
use super::*;
use crate::relay::activity::{self, AgentTurn, SessionActivity};

/// Transcripts found before, by session: finding one can scan every
/// project folder, and a session's transcript does not move.
static TRANSCRIPTS: std::sync::LazyLock<std::sync::Mutex<HashMap<Target, PathBuf>>> =
    std::sync::LazyLock::new(Default::default);

fn remembered(target: &Target, find: impl FnOnce() -> Option<PathBuf>) -> Option<PathBuf> {
    let mut known = TRANSCRIPTS.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(path) = known.get(target).filter(|path| path.is_file()) {
        return Some(path.clone());
    }
    let path = find()?;
    if known.len() >= 512 {
        known.clear();
    }
    known.insert(target.clone(), path.clone());
    Some(path)
}

impl LocalSessions {
    pub(super) fn session_activity(
        &self,
        sessions: &[(Target, Option<String>)],
    ) -> HashMap<Target, SessionActivity> {
        let claude_live: HashMap<String, claude::TerminalSession> = if sessions
            .iter()
            .any(|(t, _)| t.kind == SessionKind::ClaudeTerminal)
        {
            claude::terminal_sessions(&self.config.claude, &*self.table)
                .into_iter()
                .map(|session| (session.session_id.clone(), session))
                .collect()
        } else {
            HashMap::new()
        };
        let mut found = HashMap::new();
        for (target, directory) in sessions {
            let mut seen = SessionActivity::default();
            let live_claude = claude_live.get(&target.id);
            let directory = directory
                .clone()
                .or_else(|| live_claude.and_then(|s| s.cwd.clone()));
            if let Some((repo, branch)) = directory
                .as_deref()
                .filter(|d| !d.is_empty())
                .and_then(|d| activity::repo_and_branch(Path::new(d)))
            {
                seen.repo = Some(repo);
                seen.branch = branch;
            }
            match target.kind {
                SessionKind::ClaudeTerminal => {
                    seen.turn = live_claude.and_then(|s| match s.status.as_deref() {
                        Some("busy") => Some(AgentTurn::Working),
                        _ if s.is_idle() => Some(AgentTurn::Idle),
                        _ => None,
                    });
                    // Claude Code's task list, kept beside its own login's registry.
                    let home = live_claude
                        .and_then(|s| s.registry.as_deref())
                        .and_then(Path::parent)
                        .unwrap_or(&self.config.claude.home);
                    let tasks = activity::claude_task(&home.join("tasks").join(&target.id));
                    seen.task = tasks
                        .or_else(|| {
                            let path = remembered(target, || {
                                claude::transcript::path(
                                    &self.config.claude,
                                    &*self.table,
                                    &target.id,
                                )
                                .map(|(path, _)| path)
                            })?;
                            activity::transcript_task(&path)
                        })
                        .flatten();
                }
                SessionKind::Codex => {
                    let path = remembered(target, || {
                        rollout::rollout_path(&self.config.codex, &target.id)
                    });
                    if let Some(path) = path {
                        seen.turn = RolloutSummary::read(&path).map(|summary| {
                            if summary.is_idle() {
                                AgentTurn::Idle
                            } else {
                                AgentTurn::Working
                            }
                        });
                        seen.task = activity::transcript_task(&path).flatten();
                    }
                }
                _ => {}
            }
            found.insert(target.clone(), seen);
        }
        found
    }
}
