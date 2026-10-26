//! The desktop's control actions on an install's upload job: pause, resume,
//! retry and compact. Each serializes with the other control actions only, so
//! it is safe while the collector runs.
use super::bridge::{control_db, control_lock, emit, open_control};
use super::{read_config, user_error, Target};
use agent_relay_probe::delivery;
use anyhow::{ensure, Result};
use clap::Subcommand;
use serde_json::{json, Value};
use std::path::Path;

#[derive(Subcommand)]
pub(super) enum Control {
    Pause(Target),
    Resume(Target),
    /// Retry uploads stopped by a problem, or waiting out a transient failure.
    Retry(Target),
    /// Release settled upload receipts.
    Compact(Target),
}

impl Control {
    pub(super) fn run(self) -> Result<()> {
        let value = match self {
            Control::Pause(target) => pause(&target.directory()?, true),
            Control::Resume(target) => pause(&target.directory()?, false),
            Control::Retry(target) => retry_value(&target.directory()?),
            Control::Compact(target) => compact_value(&target.directory()?),
        }?;
        emit(value);
        Ok(())
    }
}

/// A job change must wait for an interrupted sharing update's recovery.
fn sharing_settled(directory: &Path) -> Result<()> {
    ensure!(
        !directory.join("sharing-change.json").exists(),
        user_error("A sharing update is incomplete. Run start to recover it before retrying.")
    );
    Ok(())
}

pub(super) fn pause(directory: &Path, paused: bool) -> Result<Value> {
    let _control = control_lock(directory)?;
    let config = read_config(directory)?;
    sharing_settled(directory)?;
    let conn = control_db(directory)?;
    if paused {
        delivery::pause_job(&conn, &config.job_id)?;
    } else {
        delivery::resume_job(&conn, &config.job_id)?;
    }
    Ok(json!({"paused":paused}))
}

/// Retry a job a non-retryable verdict stopped (it otherwise waits for a new
/// build or sign-in), or wake an active job waiting out a transient failure's
/// backoff. A paused job, a rate-limited wait and a batch in flight are left
/// as they are (see `delivery::retry_requested`).
pub(super) fn retry_value(directory: &Path) -> Result<Value> {
    let _control = control_lock(directory)?;
    let config = read_config(directory)?;
    sharing_settled(directory)?;
    let conn = control_db(directory)?;
    let retried =
        delivery::retry_requested(&conn, &config.job_id, chrono::Utc::now().timestamp_millis())?;
    Ok(json!({"retried":retried}))
}

/// Settled receipts one compaction transaction removes.
const RECEIPT_PAGE: usize = 10_000;
/// Release every settled batch receipt. Queued and unacknowledged batches are
/// untouched.
pub(super) fn compact_value(directory: &Path) -> Result<Value> {
    let _control = control_lock(directory)?;
    read_config(directory)?;
    let conn = open_control(directory)?;
    let mut removed_records = 0;
    loop {
        let removed = delivery::compact_receipts(&conn, RECEIPT_PAGE)?;
        removed_records += removed;
        if removed < RECEIPT_PAGE {
            break;
        }
    }
    // With no live job, nothing can consume what upload state remains.
    delivery::release_decommissioned(&conn)?;
    delivery::reconcile_status_counters(&conn)?;
    Ok(json!({"removed_records":removed_records}))
}
