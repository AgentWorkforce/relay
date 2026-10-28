use super::*;

/// Connections owned by one delivery thread for its lifetime. Validation and
/// migration happen on open and after a schema or database-file replacement,
/// rather than once per drain. SQLite sees other writers' committed data on
/// every statement; no read transaction is retained between passes.
pub struct DrainSession {
    path: std::path::PathBuf,
    identity: crate::delivery::DatabaseIdentity,
    schema_version: i64,
    connections: Option<Connections>,
}
struct Connections {
    conn: Connection,
    keepalive: Mutex<Connection>,
    store: Option<ai_hist::SessionStore>,
}

impl DrainSession {
    pub fn open(path: &Path) -> Result<Self> {
        Self::open_with(path, |_| Ok(()))
    }

    fn open_with(
        path: &Path,
        mut after_open: impl FnMut(Option<&Connection>) -> Result<()>,
    ) -> Result<Self> {
        crate::delivery::create_parent(path)?;
        // Establish identity before either SQLite open, even for a new file.
        // A replacement fails closed; reopening while an old WAL connection
        // remains alive is not a safe way to recover a changed database.
        let identity = crate::delivery::DatabaseIdentity::open_or_create(path)?;
        after_open(None)?;
        anyhow::ensure!(
            identity == crate::delivery::DatabaseIdentity::read(path)?,
            "history was replaced while opening delivery"
        );
        let conn = crate::delivery::open_db(path)?;
        after_open(Some(&conn))?;
        anyhow::ensure!(
            identity == crate::delivery::DatabaseIdentity::read(path)?,
            "history was replaced while opening delivery"
        );
        let keepalive = crate::delivery::open_connection(path)?;
        anyhow::ensure!(
            identity == crate::delivery::DatabaseIdentity::read(path)?,
            "history was replaced while opening delivery"
        );
        let schema_version = conn.pragma_query_value(None, "schema_version", |r| r.get(0))?;
        Ok(Self {
            path: path.to_owned(),
            identity,
            schema_version,
            connections: Some(Connections {
                conn,
                keepalive: Mutex::new(keepalive),
                store: None,
            }),
        })
    }

    pub fn connection(&mut self) -> Result<&Connection> {
        let changed = match self.connections.as_ref() {
            Some(connections) => {
                let version: i64 =
                    connections
                        .conn
                        .pragma_query_value(None, "schema_version", |r| r.get(0))?;
                version != self.schema_version
                    || self.identity != crate::delivery::DatabaseIdentity::read(&self.path)?
            }
            None => true,
        };
        if changed {
            // Close old WAL/SHM handles before opening the replacement path.
            // On failure the next call retries from a closed, safe state.
            self.connections = None;
            *self = Self::open(&self.path)?;
        }
        Ok(&self
            .connections
            .as_ref()
            .context("delivery connection not open")?
            .conn)
    }

    pub fn drain(
        &mut self,
        receivers: &dyn Receivers,
        options: &DrainOptions,
        clock: &(dyn Fn() -> i64 + Sync),
        cancelled: &(dyn Fn() -> bool + Sync),
    ) -> Result<DrainResult> {
        let drain_started = Instant::now();
        self.connection()?;
        validate_options(options)?;
        let connections = self
            .connections
            .as_mut()
            .context("delivery connection not open")?;
        let conn = &connections.conn;
        let keepalive = connections
            .keepalive
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        // The shared busy policy retries for about thirty seconds, which is right
        // for a sync that must not give up and exactly wrong for a keepalive: a
        // renewal that waits thirty seconds to protect a lease shorter than that
        // has already lost the thing it was protecting, and it made the decision
        // inside a busy handler that has never heard of the deadline. Bound it so
        // contention comes back to the renewal loop, which does know.
        keepalive.busy_timeout(Duration::from_millis(keepalive_busy_timeout_ms(
            options.lease_ms,
        )))?;
        drop(keepalive);
        let keepalive = &connections.keepalive;
        // Only the ids: each chosen job's status is read once, when the drain
        // ends.
        let listed = job_ids(&conn)?;
        let selection = options.job_ids.as_deref();
        if let Some(ids) = selection {
            if ids.iter().any(|id| !listed.contains(id)) {
                bail!("INVALID_ARGUMENT: unknown delivery job selection");
            }
        }
        let jobs: Vec<String> = listed
            .into_iter()
            .filter(|job_id| chosen(selection, job_id))
            .collect();
        // The budget covers delivery, so the clock starts once the drain's own
        // maintenance is done: on a loaded host, setup alone can outlast a short
        // budget and leave the drain no time to deliver anything.
        let mut worker = Worker {
            conn,
            keepalive: &keepalive,
            receivers,
            options,
            clock,
            cancelled,
            started: Instant::now(),
            attempts: 0,
            prepare_steps: 0,
            issues: Vec::new(),
            failure: None,
            metrics: DrainMetrics::default(),
            store: &mut connections.store,
            shared_turns: jobs.len() > 1,
        };
        // Round-robin jobs: one failed destination never consumes another's cursor.
        let mut progressed = true;
        while progressed && worker.budget() && !cancelled() {
            progressed = false;
            for job_id in &jobs {
                if !worker.budget() || cancelled() {
                    break;
                }
                match worker.step(job_id) {
                    Ok(Step::Progressed) => progressed = true,
                    Ok(Step::Idle) => {}
                    Ok(Step::Unregistered) => {
                        worker.issue(job_id, DrainIssueCode::DestinationNotRegistered, None)
                    }
                    // A receiver verdict never reaches here: it is classified and
                    // recorded under the lease. Only local state errors escape.
                    Err(error) => {
                        let (code, detail) = if preparation_failed(&error) {
                            (
                                DrainIssueCode::PreparationFailed,
                                "preparing an upload batch failed",
                            )
                        } else {
                            (
                                DrainIssueCode::DeliveryStateFailed,
                                "delivery state operation failed",
                            )
                        };
                        worker.issue(job_id, code, Some(detail.into()));
                        worker.failure.get_or_insert(error);
                    }
                }
            }
        }
        let statuses = jobs
            .iter()
            .map(|job_id| status(&worker.conn, job_id))
            .collect::<Result<_>>()?;
        // Receipts the drain settled are released as its closing work, so a
        // spent batch budget does not skip it; only a host stop ends it early.
        compact(&worker.conn, &|| !cancelled())?;
        let mut metrics = worker.metrics;
        metrics.elapsed_ms = millis(drain_started.elapsed());
        Ok(DrainResult {
            attempts: worker.attempts,
            statuses,
            issues: worker.issues,
            failure: worker
                .failure
                .map(|error| LocalFailure(std::sync::Arc::new(error))),
            metrics,
        })
    }
}

pub(super) fn validate_options(options: &DrainOptions) -> Result<()> {
    range(options.max_batches as i64, "max_batches", 1, 10_000)?;
    range(
        options.max_prepare_steps as i64,
        "max_prepare_steps",
        1,
        10_000,
    )?;
    range(options.lease_ms, "lease_ms", 30, 86_400_000)?;
    range(
        options.request_timeout_ms,
        "request_timeout_ms",
        1,
        3_600_000,
    )?;
    range(
        options.max_in_flight as i64,
        "max_in_flight",
        1,
        MAX_IN_FLIGHT as i64,
    )?;
    if let Some(limit) = options.max_elapsed {
        range(
            i64::try_from(limit.as_millis()).unwrap_or(i64::MAX),
            "max_elapsed_ms",
            1,
            86_400_000,
        )?;
    }
    Ok(())
}
#[cfg(test)]
mod connection_tests {
    use super::*;

    struct Empty;
    impl Receivers for Empty {
        fn receiver(&self, _: &str, _: &str) -> Option<&dyn Receiver> {
            None
        }
    }

    #[test]
    fn replacing_the_path_between_opens_cannot_split_delivery_and_keepalive() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("history.db");
        let replacement = directory.path().join("replacement.db");
        crate::delivery::open_db(&path)
            .unwrap()
            .pragma_update(None, "user_version", 1)
            .unwrap();
        crate::delivery::open_db(&replacement)
            .unwrap()
            .pragma_update(None, "user_version", 2)
            .unwrap();
        let mut replaced = false;
        let error = DrainSession::open_with(&path, |conn| {
            // Windows cannot rename a SQLite-open file; exercise its race
            // before that open. Unix also proves replacement after main open
            // and before the keepalive opens, the reported split-brain case.
            let point = if cfg!(windows) {
                conn.is_none()
            } else {
                conn.is_some()
            };
            if point && !replaced {
                if let Some(conn) = conn {
                    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
                }
                let old = directory.path().join("old.db");
                std::fs::rename(&path, &old)?;
                for suffix in ["-wal", "-shm"] {
                    let source = directory.path().join(format!("history.db{suffix}"));
                    if source.exists() {
                        std::fs::rename(source, directory.path().join(format!("old.db{suffix}")))?;
                    }
                }
                std::fs::rename(&replacement, &path)?;
                replaced = true;
            }
            Ok(())
        })
        .err()
        .expect("replacement cannot return a mixed connection pair");
        assert!(replaced);
        assert!(error
            .to_string()
            .contains("replaced while opening delivery"));
    }

    #[test]
    fn repeated_empty_drains_reuse_open_and_revalidate_only_after_schema_change() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("history.db");
        let before = crate::delivery::DATABASE_OPENS.with(|count| count.get());
        let mut session = DrainSession::open(&path).unwrap();
        let options = DrainOptions::new("connection-test");
        for _ in 0..20 {
            let result = session
                .drain(&Empty, &options, &system_clock, &|| false)
                .unwrap();
            assert!(result.statuses.is_empty());
        }
        assert_eq!(
            crate::delivery::DATABASE_OPENS.with(|count| count.get()),
            before + 1,
            "twenty unchanged empty drains must not reopen/validate history"
        );
        let other = Connection::open(&path).unwrap();
        other
            .execute_batch("CREATE TABLE legacy_writer_upgrade(id INTEGER);")
            .unwrap();
        session
            .drain(&Empty, &options, &system_clock, &|| false)
            .unwrap();
        assert_eq!(
            crate::delivery::DATABASE_OPENS.with(|count| count.get()),
            before + 2,
            "a legacy writer's schema mutation must revalidate"
        );
        session
            .drain(&Empty, &options, &system_clock, &|| false)
            .unwrap();
        assert_eq!(
            crate::delivery::DATABASE_OPENS.with(|count| count.get()),
            before + 2
        );
    }
}

pub(super) fn drain_once(
    db_path: &Path,
    receivers: &dyn Receivers,
    options: &DrainOptions,
    clock: &(dyn Fn() -> i64 + Sync),
    cancelled: &(dyn Fn() -> bool + Sync),
) -> Result<DrainResult> {
    let started = Instant::now();
    validate_options(options)?;
    let mut result = DrainSession::open(db_path)?.drain(receivers, options, clock, cancelled)?;
    result.metrics.elapsed_ms = millis(started.elapsed());
    Ok(result)
}
