//! Indexed transport receipts, not session evidence. Completed delivery IDs
//! remain fenced without occupying the live worker's pending-message memory.
use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;

pub(super) struct Journal(Connection);
impl Journal {
    pub(super) fn create(path: &Path) -> Result<Self> {
        use std::os::unix::fs::OpenOptionsExt;
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)?;
        let connection = Connection::open_with_flags(
            path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        Self::initialize(connection)
    }
    fn initialize(connection: Connection) -> Result<Self> {
        connection.busy_timeout(std::time::Duration::from_secs(1))?;
        connection.execute_batch("CREATE TABLE deliveries (id TEXT PRIMARY KEY NOT NULL, hash TEXT NOT NULL, status TEXT NOT NULL)")?;
        Ok(Self(connection))
    }
    #[cfg(test)]
    pub(super) fn memory() -> Result<Self> {
        Self::initialize(Connection::open_in_memory()?)
    }
    pub(super) fn lookup(&self, id: &str) -> Result<Option<(String, String)>> {
        Ok(self
            .0
            .query_row(
                "SELECT hash,status FROM deliveries WHERE id=?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?)
    }
    pub(super) fn admit(&self, id: &str, hash: &str) -> Result<()> {
        self.0.execute(
            "INSERT INTO deliveries(id,hash,status) VALUES(?1,?2,'accepted')",
            params![id, hash],
        )?;
        Ok(())
    }
    pub(super) fn status(&self, id: &str, status: &str) -> Result<()> {
        anyhow::ensure!(
            self.0.execute(
                "UPDATE deliveries SET status=?2 WHERE id=?1",
                params![id, status]
            )? == 1,
            "Delivery receipt unavailable"
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn disk_receipts_survive_connection_close_and_are_private() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("receipts.db");
        let journal = Journal::create(&path).unwrap();
        journal.admit("old", "hash").unwrap();
        journal.status("old", "delivered").unwrap();
        drop(journal);
        let saved = Connection::open(&path).unwrap();
        assert_eq!(
            saved
                .query_row("SELECT status FROM deliveries WHERE id='old'", [], |row| {
                    row.get::<_, String>(0)
                })
                .unwrap(),
            "delivered"
        );
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o077,
            0
        );
        assert!(
            Journal::create(&path).is_err(),
            "another host cannot silently adopt this ledger"
        );
    }
}
