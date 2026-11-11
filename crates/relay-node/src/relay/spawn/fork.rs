//! Forking: a spawn that starts as a copy of another agent's session on
//! this computer (`fork_from`), in that session's folder, with its whole
//! conversation, through the harness's own fork (`claude --resume
//! --fork-session`, Codex's `thread/fork`). The original session is left as
//! it was. Only the verified machine owner may fork, since the copy hands
//! the source's transcript to whoever asked.

use super::invoke::SpawnError;
use super::report_back;
use super::wire::{HarnessId, SpawnRequest};
use crate::relay::daemon::Core;
use crate::relay::harness::{claude, codex};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Harnesses whose spawns can start as a copy of a session.
pub fn supported(harness: HarnessId) -> bool {
    [claude::ID, codex::ID].contains(&harness)
}

/// The session a fork copies, by the harness's own id, and where it runs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ForkSource {
    pub session_id: String,
    pub directory: PathBuf,
}

/// How long finding the source session's folder may take: it reads the
/// harness's own records, which may be on a slow or sleeping volume.
const LOOKUP_TIMEOUT: Duration = Duration::from_secs(10);

// A timed-out lookup cannot be cancelled: its permit stays with the worker
// until the read finishes, so stalled volumes cannot pile up blocking threads
// (the same rule as the working-folder check in `invoke`).
static FORK_LOOKUPS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);

/// A fork runs where its source runs, so a requested folder must be that one.
fn folder_matches(asked: Option<&Path>, source: &Path) -> bool {
    asked.is_none_or(|asked| asked == source)
}

impl Core {
    pub(super) async fn fork_source(
        &self,
        request: &SpawnRequest,
        source: &str,
    ) -> Result<ForkSource, SpawnError> {
        let label = request.harness.label();
        if !supported(request.harness) {
            return Err(format!(
                "spawn_fork_unsupported: {label} cannot start as a copy of a session yet"
            )
            .into());
        }
        let workspace = self
            .workspace()
            .ok_or("spawn_failed: this computer has no Agent Relay workspace")?;
        let registration = self
            .store
            .read(|store| {
                store
                    .registrations
                    .iter()
                    .find(|r| {
                        r.name == source
                            && r.archived_at.is_none()
                            && r.base_url == workspace.base_url
                            && r.workspace_key.as_ref() == Some(&workspace.key)
                    })
                    .cloned()
            })
            .ok_or_else(|| {
                format!("spawn_fork_not_found: @{source} is not an agent on this computer")
            })?;
        let requester = report_back::requester(
            &workspace,
            &self.config.app_data_dir,
            &request.invocation_id,
        )
        .await;
        let owner = self.verified_owner(&registration).await;
        if requester.is_none()
            || owner.is_none()
            || requester.as_ref().map(|r| &r.agent_id) != owner.as_ref().map(|(_, id)| id)
        {
            return Err(
                "spawn_fork_refused: only this computer's verified owner can fork its sessions"
                    .into(),
            );
        }
        let spawner = self.plugins.spawner.clone();
        let (harness, target) = (request.harness, registration.target.clone());
        let lookup = async move {
            let permit = FORK_LOOKUPS.acquire().await.ok()?;
            tokio::task::spawn_blocking(move || {
                let _permit = permit;
                spawner.fork_directory(harness, &target)
            })
            .await
            .ok()
            .flatten()
        };
        let directory = tokio::time::timeout(LOOKUP_TIMEOUT, lookup)
            .await
            .ok()
            .flatten()
            .ok_or_else(|| {
                format!("spawn_fork_unavailable: {label} on this computer cannot copy @{source}'s session")
            })?;
        if !folder_matches(request.directory.as_deref(), &directory) {
            return Err(
                "spawn_invalid_input: a fork runs in the folder of the session it copies".into(),
            );
        }
        Ok(ForkSource {
            session_id: registration.target.id,
            directory,
        })
    }
}

/// The first turn of a fork: who it is now, then what the person asked.
pub fn first_task(source: &str, task: &str) -> String {
    let lead = format!(
        "This session is a fork of @{source}'s conversation, started from the Agent Relay app. \
         You are a new agent with your own name; @{source} keeps running separately. \
         Continue from where the conversation left off."
    );
    match task.trim() {
        "" => lead,
        task => format!("{lead}\n\n{task}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_claude_and_codex_fork() {
        assert!(supported(claude::ID));
        assert!(supported(codex::ID));
        assert!(!supported(crate::relay::harness::opencode::ID));
    }

    #[test]
    fn a_fork_runs_only_in_its_sources_folder() {
        let source = Path::new("/work/app");
        assert!(folder_matches(None, source));
        assert!(folder_matches(Some(source), source));
        assert!(!folder_matches(Some(Path::new("/work/other")), source));
    }

    #[test]
    fn the_first_turn_names_the_source_then_the_request() {
        let text = first_task("planner", " add tests ");
        assert!(text.contains("fork of @planner"));
        assert!(text.ends_with("\n\nadd tests"));
        assert!(!first_task("planner", "").contains("\n\n"));
    }
}
