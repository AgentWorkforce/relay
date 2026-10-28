use super::*;

/// Historical projection seeding starts only after capture attempted its
/// watcher registration. Paused selected jobs deliberately do no member pass.
pub(super) fn wait_for_capture_driver(
    live: &crate::live::Shared,
    cancelled: &AtomicBool,
    paused_selected: bool,
) {
    while !paused_selected
        && !stopping(cancelled)
        && !matches!(live.verdict(), Some(Some(_)))
        && live
            .report()
            .is_none_or(|report| report["driver"].is_null())
    {
        live.wait(Instant::now() + Duration::from_millis(50), || {
            stopping(cancelled)
        });
    }
}

/// One bounded delivery pass through the shared core delivery worker — the
/// same loop the SDK drains with — carrying the RelayHistory receiver. The
/// worker owns leases and their keepalive, prepared-payload persistence, the
/// eligibility recheck before dispatch, retry classification and receipt
/// compaction;
/// the receiver owns only the legacy-scheduler/account/instance guards and the
/// transport. Returns the job status the drain left behind.
pub(super) fn deliver(
    session: &mut worker::DrainSession,
    config: &Config,
    cancelled: &AtomicBool,
) -> Result<delivery::DeliveryStatus> {
    let receiver = destination::RelayHistoryReceiver {
        base_url: Some(config.history_url.clone()),
        expected_account: Some(config.delivery_account.clone()),
        instance_id: Some(INSTANCE.into()),
        acknowledge_uninspected_schedules: config.acknowledge_uninspected_schedules,
        state: receiver_state().clone(),
    };
    deliver_on(session, config, &receiver, &|| stopping(cancelled))
}
#[cfg(test)]
pub(super) fn deliver_with_receiver(
    db_path: &Path,
    config: &Config,
    receiver: &dyn worker::Receiver,
    cancelled: &(dyn Fn() -> bool + Sync),
) -> Result<delivery::DeliveryStatus> {
    deliver_on(
        &mut worker::DrainSession::open(db_path)?,
        config,
        receiver,
        cancelled,
    )
}
fn deliver_on(
    session: &mut worker::DrainSession,
    config: &Config,
    receiver: &dyn worker::Receiver,
    cancelled: &(dyn Fn() -> bool + Sync),
) -> Result<delivery::DeliveryStatus> {
    let options = delivery_options(
        config.job_id.clone(),
        format!("probe-{}", std::process::id()),
    );
    let result = session.drain(
        &worker::SingleReceiver::new(DESTINATION, INSTANCE, receiver),
        &options,
        &worker::system_clock,
        cancelled,
    )?;
    let status = result
        .statuses
        .into_iter()
        .find(|job| job.job_id == config.job_id)
        .context("delivery job missing")?;
    PassMetrics::record(&result.metrics, &status);
    // Pause can arrive while a batch is in flight. It is a successful user
    // control action, even if it invalidated that batch's lease.
    if status.state == "paused" {
        return Ok(status);
    }
    if status.state != "active" {
        if status.failure.as_deref() == Some("delivery_conflict") {
            return Err(
                destination::TransportFailure(delivery::DeliveryFailure::DeliveryConflict).into(),
            );
        }
        return Err(user_error(
            "Delivery needs attention. Reconnect with --force-login if credentials have expired.",
        ));
    }
    // A recorded transport failure is not an issue: the job stays active and
    // the worker owns its backoff. Only an unusable local state is reported,
    // and waiting for a retry deadline is normal operation, not a fault.
    // The drain's own error keeps its cause: a locked, full or damaged store
    // is reported as such, and a batch that could not be prepared as that.
    if let Some(failure) = result.failure {
        return Err(failure.into_error());
    }
    if result
        .issues
        .iter()
        .any(|issue| issue.code == worker::DrainIssueCode::PreparationFailed)
    {
        return Err(anyhow::anyhow!("an upload batch could not be prepared")
            .context(delivery::PreparationFailed));
    }
    if !result.issues.is_empty() {
        return Err(user_error(
            "Session delivery is queued or needs attention. No unacknowledged data was discarded.",
        ));
    }
    Ok(status)
}

/// A blocked job holds the verdict of the probe build that reached it, and a
/// different build can judge the same exchange differently — a receipt it now
/// parses, say. The first run under each new build retries a blocked job once;
/// later runs of that build leave its own verdicts alone.
/// The database records the build atomically with the retry, including across
/// detached collectors and restarts when the legacy file marker is unwritable.
pub(super) fn retry_verdict_of_another_build(
    directory: &Path,
    job_id: &str,
    version: &str,
) -> Result<()> {
    let marker = directory.join("verdict-retry.json");
    let retried = fs::read(&marker)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        // Unscoped files cannot prove which generation used the retry. In
        // particular, disconnect/reconnect reuses this directory for a new job.
        .filter(|value| value["job_id"].as_str() == Some(job_id))
        .and_then(|value| value["probe_version"].as_str().map(str::to_owned));
    let conn = delivery::open_for_capture(&directory.join("history.db"))?;
    if delivery::retry_job_for_build(&conn, job_id, version, retried.as_deref()).is_err() {
        // This recovery is optional. Its transaction rolls back both the retry
        // and build record on failure, so collection can continue safely.
        let _ = writeln!(
            std::io::stderr(),
            "Automatic probe recovery was deferred. Collection will continue."
        );
        return Ok(());
    }
    // Maintain the older marker for probes that do not yet read retry_build.
    if save_json(
        &marker,
        &json!({ "job_id": job_id, "probe_version": version }),
    )
    .is_err()
    {
        // Keep diagnostics free of paths, credentials and raw filesystem errors.
        let _ = writeln!(
            std::io::stderr(),
            "Probe retry file could not be saved. Retry state is stored in the database."
        );
    }
    Ok(())
}
