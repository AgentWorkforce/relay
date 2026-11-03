//! Whether particular sessions upload, read from the install's store for
//! just those sessions.
use super::*;
#[cfg(feature = "history")]
use crate::delivery;
#[cfg(feature = "history")]
use std::time::Duration;

/// A session's identity, for a core with no upload queue to name it.
#[cfg(not(feature = "history"))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionIdentity {
    pub source: String,
    pub session_id: String,
}

/// One session's place in the install's uploads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Inclusion {
    /// A person can select it: the store holds it and it is no other
    /// session's subagent.
    pub selectable: bool,
    /// The install uploads it: it is not withheld, and a selected-sessions
    /// job counts it among its members.
    pub included: bool,
}

/// A core without the `history` feature keeps no store to read.
#[cfg(not(feature = "history"))]
pub fn inclusion(
    _directory: &Path,
    _sessions: &[SessionIdentity],
) -> Result<(SharingMode, Vec<Inclusion>)> {
    anyhow::bail!("session history is not built into this core")
}

/// What the install shares, and each of `sessions`' [`Inclusion`], in order.
#[cfg(feature = "history")]
pub fn inclusion(
    directory: &Path,
    sessions: &[SessionIdentity],
) -> Result<(SharingMode, Vec<Inclusion>)> {
    let config = read_config(directory)?;
    let conn = delivery::open_db_readonly(&directory.join("history.db"))?;
    conn.busy_timeout(Duration::from_secs(5))?;
    let scoped = delivery::is_session_job(&conn, &config.job_id)?;
    let read = sessions
        .iter()
        .map(|identity| {
            Ok(Inclusion {
                selectable: delivery::is_selectable(&conn, identity)?,
                included: delivery::is_shareable(&conn, identity)?
                    && (!scoped
                        || delivery::job_session_included(&conn, &config.job_id, identity)?),
            })
        })
        .collect::<Result<_>>()?;
    Ok((mode(&config), read))
}
