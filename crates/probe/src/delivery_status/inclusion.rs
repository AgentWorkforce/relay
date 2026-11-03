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
    /// A saved user choice that automatic relay registration must not reverse.
    pub explicitly_excluded: bool,
    /// Cloud confirmed deletion under the person's explicit deletion consent.
    pub deleted_from_cloud: bool,
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
    // This journal is saved only after Cloud confirms deletion. A missing
    // journal means none; an unreadable or malformed one must fail closed.
    let tombstones: std::collections::BTreeMap<String, Vec<SessionIdentity>> =
        match std::fs::read(directory.join("deleted-uploads.json")) {
            Ok(bytes) => serde_json::from_slice(&bytes)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Default::default(),
            Err(error) => return Err(error.into()),
        };
    let deleted: std::collections::HashSet<_> = tombstones.into_values().flatten().collect();
    let read = sessions
        .iter()
        .map(|identity| {
            Ok(Inclusion {
                selectable: delivery::is_selectable(&conn, identity)?,
                explicitly_excluded: delivery::is_explicitly_excluded(&conn, identity)?,
                deleted_from_cloud: deleted.contains(identity),
                included: delivery::is_shareable(&conn, identity)?
                    && (!scoped
                        || delivery::job_session_included(&conn, &config.job_id, identity)?),
            })
        })
        .collect::<Result<_>>()?;
    Ok((mode(&config), read))
}
