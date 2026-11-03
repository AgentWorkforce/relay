//! The uploader status the desktop shows, read from the install directory
//! and its store in a few constant-time reads.
use super::*;
use crate::delivery;
use serde_json::{json, Value};
use std::time::Duration;

/// What the desktop shows while local history waits for the collector to
/// upgrade it.
pub const UPGRADING: &str =
    "Agent Relay is upgrading local history. Uploads continue when it finishes.";

const CLAUDE_WEB_CONNECTOR: &str = "claude-web";

/// The last Claude cloud listing and unresolved download as a stable,
/// credential-free health value for `uploader.status`. The remote report
/// already contains only fixed connector codes and plain reasons; provider
/// detail never reaches it.
fn claude_cloud_health(directory: &Path) -> Value {
    let report = std::fs::read(
        directory
            .join("history.db")
            .with_extension("remote-enumerated"),
    )
    .ok()
    .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
    let Some(connector) = report
        .as_ref()
        .and_then(|report| report["connectors"].as_array())
        .and_then(|connectors| {
            connectors
                .iter()
                .find(|row| row["connector"] == CLAUDE_WEB_CONNECTOR)
        })
    else {
        return Value::Null;
    };
    let connector_state = connector["state"].as_str().unwrap_or_default();
    let mut reason = connector["reason"].as_str();
    let mut at_ms = connector["at_ms"].as_i64();
    let mut state = match connector_state {
        "listed" => "working",
        "unavailable" if reason == Some("Waiting for Keychain access to Claude Code's sign-in") => {
            "checking"
        }
        "unavailable" => "blocked",
        _ => "needs_attention",
    };
    // A session download that has not recovered, kept in the remote pacing
    // state by the sweep and by selected capture alike until that session
    // downloads: it outranks a listing that worked. A Keychain refusal is
    // blocked, as it is for a listing.
    let pacing = std::fs::read(directory.join("history.db").with_extension("remote-pacing"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
    let download_failure = pacing
        .as_ref()
        .and_then(|pacing| pacing["unresolved_failures"].as_object())
        .and_then(|failures| {
            failures
                .values()
                .filter(|failure| failure["connector"] == CLAUDE_WEB_CONNECTOR)
                .filter_map(|failure| {
                    Some((failure["reason"].as_str()?, failure["at_ms"].as_i64()))
                })
                .max_by_key(|(_, at_ms)| at_ms.unwrap_or(i64::MIN))
        });
    if let Some((failure, failed_at_ms)) = download_failure.filter(|_| state == "working") {
        state = if failure.contains("Keychain") {
            "blocked"
        } else {
            "needs_attention"
        };
        reason = Some(failure);
        at_ms = failed_at_ms.or(at_ms);
    }
    let keychain_error_code = reason.and_then(|reason| {
        let code = reason.split_once("Keychain error ")?.1;
        code.split_once(')')?.0.parse::<i32>().ok()
    });
    json!({
        "state": state,
        "reason": reason,
        "at_ms": at_ms,
        "last_success_ms": connector["last_success_ms"].as_i64(),
        "keychain_error_code": keychain_error_code,
    })
}

/// The install's store for reading, waiting briefly behind a writer.
fn read_db(directory: &Path) -> Result<rusqlite::Connection> {
    let conn = delivery::open_db_readonly(&directory.join("history.db"))?;
    conn.busy_timeout(Duration::from_secs(5))?;
    Ok(conn)
}

/// The install's identity, sharing mode, and whether its collector runs.
pub fn profile(directory: &Path, config: &Config, paused: bool) -> Result<Value> {
    Ok(
        json!({"directory":directory, "site_url":config.site_url, "account_id":config.account_id,
        "account_email":config.account_email, "account_name":config.account_name,
        "account_avatar_url":config.account_avatar_url,
        "workspace_id":config.workspace_id, "workspace_name":config.workspace_name, "org_id":config.org_id, "sharing_mode":mode(config),
        "running":running(directory)?, "paused":paused,
        "claude_cloud":claude_cloud_health(directory)}),
    )
}

/// Whether the install's delivery job is paused. Reads only the job's state,
/// which every build's store keeps.
pub fn paused(directory: &Path, config: &Config) -> Result<bool> {
    let conn = read_db(directory)?;
    let state: String = conn.query_row(
        "SELECT state FROM delivery_jobs WHERE id=?",
        [&config.job_id],
        |row| row.get(0),
    )?;
    Ok(state == "paused")
}

/// The install's uploader status: its profile, delivery job, session counts,
/// last cycle and collector claim.
pub fn status(directory: &Path) -> Result<Value> {
    let config = read_config(directory)?;
    // The collector keeps running when it cannot read the store and reports
    // why: an open that fails, or a damaged table. Status fails on the same
    // store, so it answers with that report, the one thing a person can act
    // on, rather than fail.
    store_status(directory, &config).or_else(|error| match current_cycle_report(directory) {
        Some(report) if report["ok"] == false => {
            let mut result = profile(directory, &config, false)?;
            // The job's own state, when it can still be read; unknown (null)
            // otherwise, never reported as running.
            result["paused"] = paused(directory, &config).map_or(Value::Null, Value::Bool);
            result["probe_version"] = json!(crate::VERSION);
            result["last_cycle"] = report;
            result["collector_outdated"] = json!(result["running"] == true && outdated(directory));
            result["collector_replacing"] = json!(replacement_in_progress(directory));
            result["upgrade_required_live"] = json!(newer_build_live(directory));
            Ok(result)
        }
        _ => Err(error),
    })
}

fn store_status(directory: &Path, config: &Config) -> Result<Value> {
    let conn = read_db(directory)?;
    let job = delivery::status(&conn, &config.job_id)?;
    // Status answers while the collector upgrades local history, so the
    // desktop can say so rather than report a failed read or a stale verdict.
    let upgrading = match delivery::ensure_current(&directory.join("history.db")) {
        Err(error) if delivery::is_upgrade_pending(&error) => true,
        checked => {
            checked?;
            false
        }
    };
    // The collector keeps the counts; until it first takes the census there
    // is nothing counted yet.
    let sessions = if upgrading {
        None
    } else {
        delivery::session_counts(&conn, &config.job_id)?
    }
    .unwrap_or(delivery::SessionCounts {
        total: 0,
        shared: 0,
        excluded: 0,
    });
    let mut result = profile(directory, config, job.state == "paused")?;
    result["probe_version"] = json!(crate::VERSION);
    result["upload_policy_revision"] = json!(match delivery::policy_revision(&conn) {
        Ok(revision) => Some(revision),
        Err(error) if delivery::is_upgrade_pending(&error) => None,
        Err(error) => return Err(error),
    });
    // How long the oldest unacknowledged batch has waited: the queue's lag.
    let oldest_pending_age_ms = job
        .oldest_pending_ms
        .map(|oldest| now().saturating_sub(oldest).max(0));
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
            if let Some(renewal) = renewal_failure(directory) {
                result["delivery"]["failure"] = json!(renewal_failure_message(renewal));
                result["delivery"]["renewal_failure"] = json!(renewal.code());
            }
        }
    }
    result["sessions"] = json!(sessions);
    let upgrading_report =
        json!({"at_ms":now(), "ok":false, "error_class":"upgrading", "message":UPGRADING});
    result["last_cycle"] = match current_cycle_report(directory) {
        // The live run reported a failure while the store still waits for its
        // upgrade: the upgrade failed, and its cause is what a person acts on.
        Some(report) if report["ok"] == false => report,
        _ if upgrading => upgrading_report,
        report => report.unwrap_or(Value::Null),
    };
    result["collector_outdated"] = json!(result["running"] == true && outdated(directory));
    result["collector_replacing"] = json!(replacement_in_progress(directory));
    result["upgrade_required_live"] = json!(newer_build_live(directory));
    Ok(result)
}

pub fn delivery_failure_message(failure: &str) -> &'static str {
    match failure {
        "legacy_uploader_active" => crate::destination::legacy_uploader_message(),
        "receiver_rejected" => {
            "The server rejected an upload. Uploads are paused until an update or retry; queued records are preserved."
        }
        "invalid_payload" => {
            "An upload could not be prepared safely. Uploads are stopped until a retry or update; queued records are preserved."
        }
        "authentication_required" => {
            "Uploads need you to sign in to Agent Relay again. Queued records are preserved."
        }
        "permission_denied" => {
            "The server refused permission to upload. Check this workspace connection."
        }
        "unsupported_evidence" | "mapping_version_mismatch" => {
            "The server does not support this upload yet. Queued records are preserved."
        }
        "delivery_conflict" => {
            "History delivery has a receiver conflict. Queued records are preserved for repair."
        }
        "rate_limited" => "The server asked uploads to slow down. Agent Relay will retry.",
        "transient" => "The upload service is temporarily unavailable. Agent Relay will retry.",
        _ => "The upload service is temporarily unavailable. Agent Relay will retry.",
    }
}

/// Only core-owned failure classes cross the status boundary. The sentence
/// stays suitable for display while the allowlisted code lets Relay derive a
/// truthful stage after restart, when no live cycle verdict is available.
pub fn delivery_failure_code(failure: &str) -> Option<&'static str> {
    match failure {
        "transient" => Some("transient"),
        "rate_limited" => Some("rate_limited"),
        "authentication_required" => Some("authentication_required"),
        "permission_denied" => Some("permission_denied"),
        "invalid_payload" => Some("invalid_payload"),
        "receiver_rejected" => Some("receiver_rejected"),
        "unsupported_evidence" => Some("unsupported_evidence"),
        "mapping_version_mismatch" => Some("mapping_version_mismatch"),
        "delivery_conflict" => Some("delivery_conflict"),
        "legacy_uploader_active" => Some("legacy_uploader_active"),
        _ => None,
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::delivery::{DeliveryJobConfig, DeliveryLimits, ExportSelection};

    /// An install directory with a configuration, a store, an all-sources
    /// job and the sessions `captured` (`source:id`).
    pub(crate) fn install(captured: &[&str]) -> tempfile::TempDir {
        let directory = tempfile::tempdir().unwrap();
        let conn = delivery::open_db(&directory.path().join("history.db")).unwrap();
        let job_id = delivery::create_job(
            &conn,
            &DeliveryJobConfig {
                destination_id: "relay-history".into(),
                instance_id: "status".into(),
                account_id: crate::destination::account_id("org", Some("workspace")),
                mapping_version: "1".into(),
                selection: ExportSelection {
                    all_sources: true,
                    kinds: vec!["session".into()],
                    ..ExportSelection::default()
                },
                limits: DeliveryLimits::default(),
            },
            1,
        )
        .unwrap()
        .job_id;
        for key in captured {
            let (source, session_id) = key.split_once(':').unwrap();
            conn.execute(
                "INSERT INTO sessions(source,session_id) VALUES (?,?)",
                [source, session_id],
            )
            .unwrap();
        }
        let config = Config {
            version: CONFIG_VERSION,
            site_url: "http://127.0.0.1:3100".into(),
            account_id: "user".into(),
            account_email: None,
            account_name: None,
            account_avatar_url: None,
            org_id: "org".into(),
            workspace_id: "workspace".into(),
            workspace_name: None,
            history_url: "http://127.0.0.1:3101".into(),
            cloud_history_origin: None,
            delivery_account: crate::destination::account_id("org", Some("workspace")),
            job_id,
            include_existing: true,
            sharing_mode: Some(SharingMode::All),
            acknowledge_uninspected_schedules: false,
        };
        fs::write(
            directory.path().join("config.json"),
            serde_json::to_vec(&config).unwrap(),
        )
        .unwrap();
        directory
    }

    #[test]
    fn status_reads_the_census_counts_and_never_walks_identities() {
        let directory = install(&["codex:a", "claude:b"]);
        // Before the collector's first pass there is nothing counted yet.
        let before = status(directory.path()).unwrap();
        assert_eq!(
            before["sessions"],
            json!({"total":0,"shared":0,"excluded":0})
        );
        assert_eq!(before["running"], false);
        assert_eq!(before["sharing_mode"], "all");
        let conn = delivery::open_db(&directory.path().join("history.db")).unwrap();
        delivery::refresh_session_census(&conn).unwrap();
        delivery::set_session_excluded(
            &conn,
            &delivery::SessionIdentity {
                source: "codex".into(),
                session_id: "a".into(),
            },
            true,
        )
        .unwrap();
        assert_eq!(
            status(directory.path()).unwrap()["sessions"],
            json!({"total":2,"shared":1,"excluded":1})
        );
        // A session captured after the pass counts once the next pass
        // follows the change feed to it; status alone never finds it.
        conn.execute(
            "INSERT INTO sessions(source,session_id) VALUES ('codex','c')",
            [],
        )
        .unwrap();
        assert_eq!(status(directory.path()).unwrap()["sessions"]["total"], 2);
        delivery::refresh_session_census(&conn).unwrap();
        assert_eq!(
            status(directory.path()).unwrap()["sessions"],
            json!({"total":3,"shared":2,"excluded":1})
        );
    }

    #[test]
    fn status_surfaces_claude_cloud_health_and_keeps_the_keychain_code() {
        let directory = install(&[]);
        fs::write(
            directory.path().join("history.remote-enumerated"),
            serde_json::to_vec(&json!({"connectors": [{
                "connector": "claude-web",
                "state": "unavailable",
                "reason": "Agent Relay is blocked from reading Claude Code's credential (Keychain error -25337). Turn Claude Code cloud sessions off and on again in Settings, then choose Always Allow",
                "at_ms": 1_800_000_060_000_i64,
                "last_success_ms": 1_800_000_000_000_i64
            }]}))
            .unwrap(),
        )
        .unwrap();

        let health = status(directory.path()).unwrap()["claude_cloud"].clone();
        assert_eq!(health["state"], "blocked");
        assert_eq!(health["keychain_error_code"], -25337);
        assert_eq!(health["last_success_ms"], 1_800_000_000_000_i64);
        assert!(health["reason"]
            .as_str()
            .unwrap()
            .contains("choose Always Allow"));

        // A listing that worked, with a session download that has not
        // recovered: the download's reason, kept in the pacing state by the
        // sweep and by selected capture alike.
        let listed = |directory: &Path| {
            fs::write(
                directory.join("history.remote-enumerated"),
                serde_json::to_vec(&json!({"connectors": [{
                    "connector": "claude-web",
                    "state": "listed",
                    "sessions": 2,
                    "at_ms": 1_800_000_120_000_i64,
                    "last_success_ms": 1_800_000_120_000_i64
                }]}))
                .unwrap(),
            )
            .unwrap();
        };
        let failed = |directory: &Path, reason: &str, at_ms: i64| {
            fs::write(
                directory.join("history.remote-pacing"),
                serde_json::to_vec(&json!({"unresolved_failures": {
                    "claude:abc": {
                        "connector": "claude-web",
                        "source": "claude",
                        "session_id": "abc",
                        "reason": reason,
                        "at_ms": at_ms
                    }
                }}))
                .unwrap(),
            )
            .unwrap();
        };
        listed(directory.path());
        let health = status(directory.path()).unwrap()["claude_cloud"].clone();
        assert_eq!(health["state"], "working");
        assert_eq!(health["reason"], Value::Null);

        failed(
            directory.path(),
            "Claude.ai cloud-session sync failed (CONNECTOR_FAILURE). Agent Relay will try again automatically",
            1_800_000_130_000_i64,
        );
        let health = status(directory.path()).unwrap()["claude_cloud"].clone();
        assert_eq!(health["state"], "needs_attention");
        assert_eq!(health["at_ms"], 1_800_000_130_000_i64);
        assert_eq!(health["last_success_ms"], 1_800_000_120_000_i64);
        assert!(health["reason"]
            .as_str()
            .unwrap()
            .contains("try again automatically"));

        // The same failure on a later retry is a new health event, so the
        // daemon logs the attempt while still deduplicating repeated reads.
        failed(
            directory.path(),
            "Claude.ai cloud-session sync failed (CONNECTOR_FAILURE). Agent Relay will try again automatically",
            1_800_000_140_000_i64,
        );
        let retried = status(directory.path()).unwrap()["claude_cloud"].clone();
        assert_ne!(retried, health);
        assert_eq!(retried["at_ms"], 1_800_000_140_000_i64);

        // A Keychain refusal during a download is blocked, with its code.
        failed(
            directory.path(),
            "Agent Relay is blocked from reading Claude Code's credential (Keychain error -25337). Turn Claude Code cloud sessions off and on again in Settings, then choose Always Allow",
            1_800_000_150_000_i64,
        );
        let health = status(directory.path()).unwrap()["claude_cloud"].clone();
        assert_eq!(health["state"], "blocked");
        assert_eq!(health["keychain_error_code"], -25337);
    }

    #[test]
    fn inclusion_reads_only_the_sessions_asked_about() {
        let directory = install(&["codex:a", "claude:b"]);
        let conn = delivery::open_db(&directory.path().join("history.db")).unwrap();
        let identity = |source: &str, id: &str| delivery::SessionIdentity {
            source: source.into(),
            session_id: id.into(),
        };
        delivery::set_session_excluded(&conn, &identity("claude", "b"), true).unwrap();
        let (mode, read) = crate::delivery_status::inclusion(
            directory.path(),
            &[
                identity("codex", "a"),
                identity("claude", "b"),
                identity("codex", "not-captured"),
            ],
        )
        .unwrap();
        assert_eq!(mode, SharingMode::All);
        assert_eq!(
            read,
            vec![
                crate::delivery_status::Inclusion {
                    selectable: true,
                    included: true,
                    explicitly_excluded: false,
                    deleted_from_cloud: false
                },
                crate::delivery_status::Inclusion {
                    selectable: true,
                    included: false,
                    explicitly_excluded: true,
                    deleted_from_cloud: false
                },
                crate::delivery_status::Inclusion {
                    selectable: false,
                    included: true,
                    explicitly_excluded: false,
                    deleted_from_cloud: false
                },
            ]
        );
    }

    #[test]
    fn the_cloud_deletion_journal_marks_its_sessions_and_fails_closed() {
        let directory = install(&["codex:a", "codex:b"]);
        let identity = |id: &str| delivery::SessionIdentity {
            source: "codex".into(),
            session_id: id.into(),
        };
        let sessions = [identity("a"), identity("b")];
        // No journal: nothing was deleted.
        let (_, read) = crate::delivery_status::inclusion(directory.path(), &sessions).unwrap();
        assert!(read.iter().all(|inclusion| !inclusion.deleted_from_cloud));
        // A confirmed deletion marks the family it names.
        let journal = directory.path().join("deleted-uploads.json");
        std::fs::write(
            &journal,
            serde_json::to_vec(&serde_json::json!({
                "codex:a": [{"source": "codex", "session_id": "a"}]
            }))
            .unwrap(),
        )
        .unwrap();
        let (_, read) = crate::delivery_status::inclusion(directory.path(), &sessions).unwrap();
        assert!(read[0].deleted_from_cloud);
        assert!(!read[1].deleted_from_cloud);
        // A journal that cannot be read is never taken as "nothing deleted".
        std::fs::write(&journal, b"not json").unwrap();
        assert!(crate::delivery_status::inclusion(directory.path(), &sessions).is_err());
    }
}
