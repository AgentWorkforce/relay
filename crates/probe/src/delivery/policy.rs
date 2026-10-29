//! Constant-work invalidation of catalog consent projections.
use super::*;

pub(super) fn init(conn: &Connection) -> Result<()> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS delivery_policy_revision(singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL); INSERT OR IGNORE INTO delivery_policy_revision VALUES(1,0);")?;
    for table in [
        "delivery_session_members",
        "delivery_session_jobs",
        "delivery_exclusions",
    ] {
        for operation in ["INSERT", "DELETE", "UPDATE"] {
            let update = if operation == "UPDATE" {
                match table {
                    "delivery_session_members" => "UPDATE OF job_id,source,session_id,delegated",
                    "delivery_exclusions" => "UPDATE OF source,session_id",
                    _ => continue,
                }
            } else {
                operation
            };
            let condition = if operation == "UPDATE" {
                let columns: &[&str] = if table == "delivery_session_members" {
                    &["job_id", "source", "session_id", "delegated"]
                } else {
                    &["source", "session_id"]
                };
                format!(
                    " WHEN {}",
                    columns
                        .iter()
                        .map(|column| format!("OLD.{column} IS NOT NEW.{column}"))
                        .collect::<Vec<_>>()
                        .join(" OR ")
                )
            } else {
                String::new()
            };
            conn.execute_batch(&format!("CREATE TRIGGER IF NOT EXISTS {table}_policy_{operation} AFTER {update} ON {table}{condition} BEGIN UPDATE delivery_policy_revision SET revision=revision+1 WHERE singleton=1; END;"))?;
        }
    }
    Ok(())
}

pub fn revision(conn: &Connection) -> Result<i64> {
    if !conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='delivery_policy_revision')",
        [],
        |row| row.get::<_, bool>(0),
    )? {
        return Err(UpgradePending.into());
    }
    Ok(conn.query_row(
        "SELECT revision FROM delivery_policy_revision WHERE singleton=1",
        [],
        |row| row.get(0),
    )?)
}
