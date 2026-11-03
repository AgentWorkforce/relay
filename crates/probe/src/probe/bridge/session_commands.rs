use super::super::transcript;
use super::{SessionList, SessionMutation, SessionPreview, SessionReset};
use clap::Subcommand;

#[derive(Subcommand)]
pub enum SessionCommand {
    List(SessionList),
    /// Read a local conversation without uploading it.
    Read(transcript::ReadSession),
    /// Count real user prompts for automatic naming; never uploads evidence.
    NamingCheckpoint(transcript::NamingCheckpoint),
    /// Local-only shallow catalog; never reads delivery batches or sends data.
    Preview(SessionPreview),
    Include(SessionMutation),
    Exclude(SessionMutation),
    /// Delete the cloud copy and stop future uploads; local history is retained.
    Delete(SessionMutation),
    /// Reset sessions; --local starts over locally without deleting cloud sessions.
    Reset(SessionReset),
}

impl SessionCommand {
    pub(super) fn requires_reader(&self) -> bool {
        matches!(
            self,
            Self::Read(_) | Self::List(_) | Self::Preview(_) | Self::NamingCheckpoint(_)
        )
    }
}

pub(super) fn preview(options: SessionPreview) -> anyhow::Result<()> {
    use super::{emit, preview_response, rank_sessions, recency_candidate_limit, Preview};
    use crate::delivery;
    let directory = super::super::home()?.join(".agentworkforce/session-preview");
    super::super::private_directory(&directory)?;
    let db = directory.join("catalog.db");
    let candidate_limit = recency_candidate_limit(options.limit as usize);
    if options.refresh {
        // A separate local metadata cache cannot wait behind the capture writer
        // or accidentally add unselected sessions to a delivery generation.
        super::super::history::discover(&db, Some(candidate_limit), || false)?;
    }
    let rows = if db.exists() {
        // The preview's own cache holds catalog metadata only, so it
        // is small, and no collector migrates it: it migrates here.
        let store = match super::super::history::open_read(&db) {
            Err(error) if delivery::is_upgrade_pending(&error) => {
                super::super::history::open(&db)?;
                super::super::history::open_read(&db)?
            }
            opened => opened?,
        };
        let sessions =
            super::super::history::catalog(&store, ai_hist::SessionScope::Local, candidate_limit)?;
        rank_sessions(sessions, options.limit as usize, &store)
            .into_iter()
            .map(Preview::from)
            .collect()
    } else {
        Vec::new()
    };
    let response = preview_response(&rows);
    super::super::save_json(&directory.join("sessions.json"), &response)?;
    emit(response);
    Ok(())
}
