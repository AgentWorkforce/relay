//! Indexed transport receipts, not session evidence. Completed delivery IDs
//! remain fenced without occupying the live worker's pending-message memory.
use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use std::path::{Path, PathBuf};

/// A live host's durable delivery fence.
pub(super) struct Journal {
    connection: Connection,
    path: Option<PathBuf>,
}

impl Drop for Journal {
    fn drop(&mut self) {
        if let Some(path) = &self.path {
            let _ = std::fs::remove_file(path);
        }
    }
}

impl Journal {
    /// Creates a private receipt database owned by this journal's lifetime.
    pub(super) fn create(path: &Path) -> Result<Self> {
        use std::os::unix::fs::OpenOptionsExt;
        let created = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)?;
        drop(created);
        let result = (|| {
            let connection = Connection::open_with_flags(
                path,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE
                    | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )?;
            Self::initialize(connection, Some(path.to_owned()))
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(path);
        }
        result
    }
    fn initialize(connection: Connection, path: Option<PathBuf>) -> Result<Self> {
        connection.busy_timeout(std::time::Duration::from_secs(1))?;
        connection.execute_batch("CREATE TABLE deliveries (id TEXT PRIMARY KEY NOT NULL, hash TEXT NOT NULL, status TEXT NOT NULL)")?;
        Ok(Self { connection, path })
    }
    /// Creates an in-memory receipt database for protocol tests.
    #[cfg(test)]
    pub(super) fn memory() -> Result<Self> {
        Self::initialize(Connection::open_in_memory()?, None)
    }
    /// Makes subsequent writes fail for fail-closed protocol tests.
    #[cfg(test)]
    pub(super) fn fail_writes(&self) {
        self.connection
            .execute_batch("PRAGMA query_only=ON")
            .unwrap();
    }
    /// Returns the saved payload hash and terminal state for a delivery ID.
    pub(super) fn lookup(&self, id: &str) -> Result<Option<(String, String)>> {
        Ok(self
            .connection
            .query_row(
                "SELECT hash,status FROM deliveries WHERE id=?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?)
    }
    /// Permanently fences a newly accepted delivery ID and payload hash.
    pub(super) fn admit(&self, id: &str, hash: &str) -> Result<()> {
        self.connection.execute(
            "INSERT INTO deliveries(id,hash,status) VALUES(?1,?2,'accepted')",
            params![id, hash],
        )?;
        Ok(())
    }
    /// Records the latest durable state for an admitted delivery.
    pub(super) fn status(&self, id: &str, status: &str) -> Result<()> {
        anyhow::ensure!(
            self.connection.execute(
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
    fn disk_receipts_are_private_while_live_and_removed_on_close() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("receipts.db");
        let journal = Journal::create(&path).unwrap();
        journal.admit("old", "hash").unwrap();
        journal.status("old", "delivered").unwrap();
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
        drop(saved);
        drop(journal);
        assert!(
            !path.exists(),
            "an ended host must release its receipt database"
        );
    }
}
