use super::*;

/// A persistent user deny, independent of transient folder consent.
pub fn is_explicitly_excluded(conn: &Connection, identity: &SessionIdentity) -> Result<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM delivery_exclusions WHERE source=? AND session_id=?)",
        params![identity.source, identity.session_id],
        |row| row.get::<_, bool>(0),
    )?)
}

/// The combined explicit and folder consent rule for leaving the machine.
pub fn is_shareable(conn: &Connection, identity: &SessionIdentity) -> Result<bool> {
    Ok(!is_explicitly_excluded(conn, identity)?
        && !in_unshared_folder(conn, &identity.source, &identity.session_id)?)
}
