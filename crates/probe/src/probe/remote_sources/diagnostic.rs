//! `remote-diagnostic.json`: what the last remote pass did, beside the local
//! capture's own record. Each connector's listing (listed, failed or
//! unavailable, with a plain reason) and the sweep's pacing ride along —
//! never provider detail or credentials.
use super::sweep::SweepOutcome;
use super::*;
use std::time::Instant;

fn record(
    directory: &Path,
    stage: &str,
    started: Instant,
    (captured, failed): (usize, usize),
    error: Option<&anyhow::Error>,
    connectors: Value,
    pacing: Value,
) {
    let diagnostic = serde_json::json!({"operation":"capture","stage":stage,
        "elapsed_ms":started.elapsed().as_millis(),"sessions_captured":captured,
        "failures":failed,"error_class":error.map(super::super::collector::capture_error_class),
        "connectors":connectors,"pacing":pacing});
    let _ = super::super::save_status_json(&directory.join("remote-diagnostic.json"), &diagnostic);
    if error.is_some() || failed > 0 {
        eprintln!("{diagnostic}");
    }
}

/// Record a sweep that ran or failed; a skipped one leaves the last record.
pub fn report_sweep(db: &Path, started: Instant, remote: &Result<Option<SweepOutcome>>) {
    let Some(directory) = db.parent() else {
        return;
    };
    let counts = match remote {
        Ok(None) => return,
        Ok(Some(outcome)) => (
            outcome.hydrated,
            outcome.failed + outcome.enumeration.as_ref().map_or(0, Enumeration::failed),
        ),
        Err(_) => (0, 1),
    };
    let pacing = remote
        .as_ref()
        .ok()
        .and_then(Option::as_ref)
        .map_or(Value::Null, |o| o.pacing.clone());
    let listing = last_enumeration(db).json();
    record(
        directory,
        "remote_sweep",
        started,
        counts,
        remote.as_ref().err(),
        listing,
        pacing,
    );
}

/// Record an enumeration that ran or failed; a skipped one leaves the last.
pub fn report_enumeration(db: &Path, started: Instant, remote: &Result<Option<Enumeration>>) {
    let Some(directory) = db.parent() else {
        return;
    };
    let (counts, listing) = match remote {
        Ok(None) => return,
        Ok(Some(report)) => ((report.rows(), report.failed()), report.json()),
        Err(_) => ((0, 1), Value::Null),
    };
    record(
        directory,
        "remote_enumeration",
        started,
        counts,
        remote.as_ref().err(),
        listing,
        Value::Null,
    );
}
