//! The uploader status and saved consent revision from the existing store read.
use super::*;

pub(super) fn store_status(directory: &Path, config: &Config) -> Result<Value> {
    let conn = read_db(directory)?;
    let job = delivery::status(&conn, &config.job_id)?;
    let withheld = excluded(&conn)?;
    // Status answers while the collector upgrades local history, so the
    // desktop can say so rather than report a failed read or a stale verdict.
    let upgrading = match delivery::ensure_current(&directory.join("history.db")) {
        Err(error) if delivery::is_upgrade_pending(&error) => true,
        checked => {
            checked?;
            false
        }
    };
    let rows = if upgrading {
        Vec::new()
    } else {
        delivery::selectable_session_identities(&conn)?
    };
    let scoped = delivery::is_session_job(&conn, &config.job_id)?;
    let members: HashSet<_> = if scoped {
        delivery::job_sessions(&conn, &config.job_id)?
            .into_iter()
            .collect()
    } else {
        HashSet::new()
    };
    let shared = rows
        .iter()
        .filter(|r| !withheld.contains(*r) && (!scoped || members.contains(*r)))
        .count();
    let mut result = profile(directory, config, job.state == "paused")?;
    result["probe_version"] = json!(agent_relay_probe::VERSION);
    result["upload_policy_revision"] = json!(match delivery::policy_revision(&conn) {
        Ok(revision) => Some(revision),
        Err(error) if delivery::is_upgrade_pending(&error) => None,
        Err(error) => return Err(error),
    });
    // How long the oldest unacknowledged batch has waited: the queue's lag.
    let oldest_pending_age_ms = job
        .oldest_pending_ms
        .map(|oldest| collector::now().saturating_sub(oldest).max(0));
    result["delivery"] = serde_json::to_value(job)?;
    result["delivery"]["oldest_pending_age_ms"] = json!(oldest_pending_age_ms);
    // Do not expose job configuration or arbitrary receiver error strings.
    if let Some(delivery) = result["delivery"].as_object_mut() {
        delivery.remove("config");
    }
    if let Some(failure) = result["delivery"]["failure"].as_str() {
        let message = delivery_failure_message(failure);
        let code = delivery_failure_code(failure);
        result["delivery"]["failure"] = json!(message);
        if let Some(code) = code {
            result["delivery"]["failure_code"] = json!(code);
        }
        // A job waiting on sign-in says why renewing it failed.
        if code == Some("authentication_required") {
            if let Some(renewal) = collector::renewal_failure(directory) {
                result["delivery"]["failure"] = json!(collector::renewal_failure_message(renewal));
                result["delivery"]["renewal_failure"] = json!(renewal.code());
            }
        }
    }
    result["sessions"] = json!({"total":rows.len(), "shared":shared, "excluded":rows.len()-shared});
    let upgrading_report = json!({"at_ms":collector::now(), "ok":false, "error_class":"upgrading", "message":UPGRADING});
    result["last_cycle"] = match collector::current_cycle_report(directory) {
        // The live run reported a failure while the store still waits for its
        // upgrade: the upgrade failed, and its cause is what a person acts on.
        Some(report) if report["ok"] == false => report,
        _ if upgrading => upgrading_report,
        report => report.unwrap_or(Value::Null),
    };
    result["collector_outdated"] =
        json!(result["running"] == true && collector::outdated(directory));
    result["collector_replacing"] = json!(collector::replacement_in_progress(directory));
    result["upgrade_required_live"] = json!(collector::newer_build_live(directory));
    Ok(result)
}
