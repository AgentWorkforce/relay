use super::*;

#[cfg(test)]
thread_local! { static AFTER_COUNTERS: std::cell::RefCell<Option<Box<dyn FnMut()>>> = const { std::cell::RefCell::new(None) }; }

pub(super) fn origin(conn: &Connection) -> Result<Option<feed::Origin>> {
    match feed::Origin::read(conn) {
        Ok(origin) => Ok(Some(origin)),
        Err(_) if !schema::table_exists(conn, "delivery_origin")? || schema::has_journal(conn)? => {
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

pub(super) fn checked_head(
    conn: &Connection,
    store: &ai_hist::SessionStore,
) -> Result<ai_hist::Watermark> {
    match store.head_revision() {
        Ok(head) => Ok(head),
        Err(error) => {
            // A pre-feed store can open its catalog, but has no epoch yet.
            // Ask the existing public feed readiness check only on failure;
            // only the SDK's explicit readiness refusal is upgrade-pending.
            if let Some(path) = conn.path() {
                if let Err(upgrade) = feed::ensure_current(std::path::Path::new(path)) {
                    if is_upgrade_pending(&upgrade) {
                        return Err(upgrade);
                    }
                }
            }
            Err(error.into())
        }
    }
}

pub fn status(conn: &Connection, job_id: &str) -> Result<DeliveryStatus> {
    status_counting(conn, job_id, true)
}

/// [`status`] for a progress report, which reads `unqueued_changes` only to
/// tell whether a job that finished its bootstrap has work left. Before the
/// bootstrap completes the feed is not scanned and `unqueued_changes` is 0,
/// so a report every few seconds during a backlog does not read hundreds of
/// changes each time.
pub fn progress_status(conn: &Connection, job_id: &str) -> Result<DeliveryStatus> {
    status_counting(conn, job_id, false)
}

fn status_counting(conn: &Connection, job_id: &str, always: bool) -> Result<DeliveryStatus> {
    if conn.is_autocommit() {
        let snapshot = Transaction::new_unchecked(conn, TransactionBehavior::Deferred)?;
        let value = status_snapshot(&snapshot, job_id, always)?;
        snapshot.commit()?;
        Ok(value)
    } else {
        status_snapshot(conn, job_id, always)
    }
}

fn status_snapshot(conn: &Connection, job_id: &str, always: bool) -> Result<DeliveryStatus> {
    let mut job = job(conn, job_id)?;
    let scoped = is_session_job(conn, job_id)?;
    if scoped {
        job.caught_up = !conn.query_row("SELECT EXISTS(SELECT 1 FROM delivery_session_members WHERE job_id=? AND bootstrap_done=0)", [job_id], |r| r.get::<_, bool>(0))?;
    }
    let (pending_records, pending_bytes, quarantined_records) = counters::read(conn, job_id)?;
    #[cfg(test)]
    AFTER_COUNTERS.with(|hook| {
        if let Some(hook) = hook.borrow_mut().as_mut() {
            hook();
        }
    });
    let oldest_pending_ms: Option<i64> = conn.query_row(
        "SELECT MIN(created_ms) FROM delivery_batches WHERE job_id=? AND state IN ('pending','leased','retry_wait','blocked')",
        [job_id], |row| row.get(0),
    )?;
    let unqueued_changes = unqueued_count(conn, &job, scoped, always)?;
    // Read-only status can run beside an older collector before this build is
    // allowed to migrate its store. That legacy schema has no skip counter.
    let skipped = if schema::column_exists(conn, "delivery_jobs", "skipped_records")? {
        "skipped_records"
    } else {
        "0"
    };
    let query = format!("SELECT acknowledged_cursor,next_attempt_ms,last_attempt_ms,attempts,last_acknowledged_ms,acceptance_level,failure,{skipped},suppressed_records,acknowledged_records FROM delivery_jobs WHERE id=?");
    conn.query_row(&query, [job_id], |row| {
        Ok(DeliveryStatus {
            job_id: job.id.clone(),
            config: job.config.clone(),
            generation: job.generation,
            state: job.state.clone(),
            bootstrap_complete: job.caught_up,
            journal_cursor: job.cursor,
            acknowledged_cursor: row.get(0)?,
            pending_records,
            pending_bytes,
            oldest_pending_ms,
            unqueued_changes,
            next_attempt_ms: row.get(1)?,
            last_attempt_ms: row.get(2)?,
            attempts: row.get(3)?,
            last_acknowledged_ms: row.get(4)?,
            acceptance_level: row.get(5)?,
            failure: row.get(6)?,
            skipped_records: row.get(7)?,
            quarantined_records,
            suppressed_records: row.get(8)?,
            acknowledged_records: row.get(9)?,
        })
    })
    .map_err(Into::into)
}

fn unqueued_count(conn: &Connection, job: &Job, scoped: bool, always: bool) -> Result<i64> {
    if !always && !job.caught_up {
        return Ok(0);
    }
    // Only legacy upgrade errors can answer before the collector catches up.
    match feed::unqueued(conn, &job.config.selection, &job.id, job.cursor, scoped) {
        Ok(count) => Ok(count),
        Err(error) if always && is_upgrade_pending(&error) => Ok(0),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unreadable_feed_cannot_report_an_empty_backlog() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("history.db");
        let conn = open_db(&path).unwrap();
        let config = DeliveryJobConfig {
            destination_id: "fixture".into(),
            instance_id: "fixture".into(),
            account_id: "fixture".into(),
            mapping_version: "1".into(),
            selection: ExportSelection {
                all_sources: true,
                kinds: vec!["session".into()],
                ..Default::default()
            },
            limits: Default::default(),
        };
        let job = create_job(&conn, &config, 1).unwrap();
        conn.execute("DELETE FROM delivery_origin", []).unwrap();
        assert!(status(&conn, &job.job_id).is_err());
        conn.execute(
            "UPDATE delivery_jobs SET bootstrap_done=1 WHERE id=?",
            [&job.job_id],
        )
        .unwrap();
        assert!(progress_status(&conn, &job.job_id).is_err());
    }

    #[test]
    fn an_incomplete_feed_waits_for_upgrade_without_claiming_complete_progress() {
        for legacy in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let conn = open_db(&directory.path().join("history.db")).unwrap();
            let config = DeliveryJobConfig {
                destination_id: "fixture".into(),
                instance_id: "fixture".into(),
                account_id: "fixture".into(),
                mapping_version: "1".into(),
                selection: ExportSelection {
                    all_sources: true,
                    kinds: vec!["session".into()],
                    ..Default::default()
                },
                limits: Default::default(),
            };
            let job = create_job(&conn, &config, 1).unwrap();
            conn.execute(
                "UPDATE delivery_jobs SET bootstrap_done=1 WHERE id=?",
                [&job.job_id],
            )
            .unwrap();
            conn.execute("DELETE FROM change_feed_store", []).unwrap();
            if legacy {
                conn.execute(
                    "DELETE FROM schema_migrations WHERE name='change_feed_v2'",
                    [],
                )
                .unwrap();
            }
            assert!(status(&conn, &job.job_id).is_ok());
            assert!(is_upgrade_pending(
                &progress_status(&conn, &job.job_id).unwrap_err()
            ));
        }
    }

    #[test]
    fn counters_oldest_and_job_fields_share_a_snapshot_during_acknowledgment() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("history.db");
        let conn = open_db(&path).unwrap();
        let config = DeliveryJobConfig {
            destination_id: "destination".into(),
            instance_id: "instance".into(),
            account_id: "account".into(),
            mapping_version: "1".into(),
            selection: ExportSelection {
                all_sources: true,
                kinds: vec!["session".into()],
                ..Default::default()
            },
            limits: Default::default(),
        };
        let job = create_job(&conn, &config, 1).unwrap();
        conn.execute("INSERT INTO delivery_batches(id,job_id,state,payload,records,bytes,journal_end,created_ms) VALUES('batch',?,'pending',NULL,3,80,1,10)",[&job.job_id]).unwrap();
        let writer = open_connection(&path).unwrap();
        let job_id = job.job_id.clone();
        AFTER_COUNTERS.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(move || {
                writer
                    .execute_batch("BEGIN; UPDATE delivery_batches SET state='acknowledged';")
                    .unwrap();
                writer
                    .execute(
                        "UPDATE delivery_jobs SET acknowledged_records=3 WHERE id=?",
                        [&job_id],
                    )
                    .unwrap();
                writer.execute_batch("COMMIT;").unwrap();
            }))
        });
        let value = status(&conn, &job.job_id).unwrap();
        AFTER_COUNTERS.with(|hook| hook.borrow_mut().take());
        assert_eq!(
            (
                value.pending_records,
                value.oldest_pending_ms,
                value.acknowledged_records
            ),
            (3, Some(10), 0)
        );
        let value = status(&conn, &job.job_id).unwrap();
        assert_eq!(
            (
                value.pending_records,
                value.oldest_pending_ms,
                value.acknowledged_records
            ),
            (0, None, 3)
        );
    }
}
