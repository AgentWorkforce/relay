//! Which RelayHistory an install delivers to: the saved origin it trusts, and
//! how a sign-in moves it to the History Cloud names for the workspace.

use crate::probe::{bridge, collector, user_error, Config};
use crate::{cloud, destination};
use anyhow::Result;

/// What a sign-in does with the saved installation, given the RelayHistory
/// destination Cloud just named for this workspace.
pub(super) enum SavedDestination {
    /// Nothing saved: a fresh install.
    Fresh,
    /// The saved installation delivers to that destination already.
    Same(Config),
    /// The saved installation delivers to another History for the same
    /// workspace, so this sign-in moves it.
    Moved(Config),
}

/// Cloud names the workspace's History on every sign-in, and this sign-in has
/// just authenticated with Cloud, so it may adopt a changed origin: the
/// workspace registered its own History, or went back to the default.
/// Nothing else moves a destination; background renewal refuses another
/// stage as `WrongDestination`. Another organization or workspace is still
/// refused.
pub(super) fn saved_destination(
    existing: Option<Config>,
    account: &str,
    history_url: &str,
) -> Result<SavedDestination> {
    Ok(match existing {
        None => SavedDestination::Fresh,
        Some(config) if config.delivery_account != account => {
            return Err(user_error(
                "Saved history belongs to a different destination. It was not replaced.",
            ))
        }
        Some(config) if config.history_url == history_url => SavedDestination::Same(config),
        Some(config) => SavedDestination::Moved(config),
    })
}

/// The origin to record as Cloud-named: set only when Cloud named a stage
/// outside the defaults, the workspace's own RelayHistory.
pub(super) fn cloud_named_origin(history_url: &str, site: &str) -> Option<String> {
    cloud::history_origin(history_url, site)
        .is_err()
        .then(|| history_url.to_string())
}

/// A delivery generation for `account`, adopting one an interrupted setup
/// committed before its `config.json` was written. `baseline` brings the
/// exclusion table in line with the sharing choice first, as a fresh install
/// does; a moved install keeps the exclusions its person already chose.
pub(super) fn start_generation(
    conn: &rusqlite::Connection,
    account: &str,
    sharing_mode: bridge::SharingMode,
    include_existing: bool,
    baseline: bool,
) -> Result<String> {
    let job_config = crate::delivery::DeliveryJobConfig {
        destination_id: "relayhistory".into(),
        instance_id: "teams-probe".into(),
        account_id: account.to_string(),
        mapping_version: destination::MAPPING_VERSION.into(),
        selection: collector::selection(include_existing),
        limits: Default::default(),
    };
    // A generation outlives an interrupted setup: create_job commits
    // before config.json is written. Adopt that job instead of recording
    // a second baseline behind a generation nothing can reach.
    let adopted = crate::delivery::list_jobs(conn)?.into_iter().find(|job| {
        job.state != "cancelled"
            && job.config.destination_id == job_config.destination_id
            && job.config.instance_id == job_config.instance_id
            && job.config.account_id == job_config.account_id
    });
    Ok(match adopted {
        Some(job) => {
            if job.config.selection != job_config.selection {
                return Err(user_error("A delivery generation with a different sharing choice already exists. Cancel it explicitly before reconnecting."));
            }
            // Every field of a generation is immutable, not only the
            // identity: an older mapping version or different limits
            // would be rejected at dispatch, so refuse them up front.
            if job.config != job_config {
                return Err(user_error("A delivery generation with a different mapping version or limits already exists. Cancel it explicitly before reconnecting."));
            }
            job.job_id
        }
        None => {
            if sharing_mode == bridge::SharingMode::Selected {
                // Deny by default: the new History receives only what its
                // person selects for it.
                crate::delivery::create_session_job(conn, &job_config, collector::now())?.job_id
            } else {
                if baseline {
                    // No generation to inherit a baseline from, so the
                    // exclusion table has to be brought in line with this
                    // choice first.
                    collector::record_baseline(conn, include_existing)?;
                }
                crate::delivery::create_job(conn, &job_config, collector::now())?.job_id
            }
        }
    })
}

/// Move a saved installation to the History Cloud named on this sign-in.
///
/// The old generation is cancelled first, which drops its queued batches, so
/// nothing prepared or acknowledged for the old History reaches the new one;
/// a new generation then starts for the new History. Each step commits before
/// `config.json` names the new destination, and an interrupted move resumes on
/// the next sign-in: the old generation is already cancelled, and the new one
/// is adopted. The caller saves the returned configuration.
pub(super) fn move_destination(
    conn: &rusqlite::Connection,
    mut config: Config,
    history_url: &str,
    sharing_mode: bridge::SharingMode,
    include_existing: bool,
) -> Result<Config> {
    if crate::delivery::list_jobs(conn)?
        .iter()
        .any(|job| job.job_id == config.job_id && job.state != "cancelled")
    {
        crate::delivery::cancel_job(conn, &config.job_id)?;
    }
    config.job_id = start_generation(
        conn,
        &config.delivery_account,
        sharing_mode,
        include_existing,
        false,
    )?;
    config.cloud_history_origin = cloud_named_origin(history_url, &config.site_url);
    config.history_url = history_url.to_string();
    config.include_existing = include_existing;
    config.sharing_mode = Some(sharing_mode);
    Ok(config)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::probe::{read_config_file, save_json, CONFIG_VERSION};
    use std::fs;

    /// Signing in again adopts the History Cloud names for the workspace, in
    /// either direction, without carrying the old History's queue: the old
    /// generation is cancelled and a new one starts. Another workspace is still
    /// refused, and an interrupted move resumes on the same new generation.
    #[test]
    fn a_sign_in_moves_an_install_to_the_history_cloud_names() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("config.json");
        let conn = crate::delivery::open_db(&directory.path().join("history.db")).unwrap();
        let account = destination::account_id("org_1", Some("ws_1"));
        let default = "https://history.agentrelay.com";
        let custom = "https://history.hookdeck.example";
        let all = bridge::SharingMode::All;
        let old_job = start_generation(&conn, &account, all, true, true).unwrap();
        let config = Config {
            version: CONFIG_VERSION,
            site_url: "https://agentrelay.com".into(),
            account_id: "user_1".into(),
            account_email: None,
            account_name: None,
            account_avatar_url: None,
            org_id: "org_1".into(),
            workspace_id: "ws_1".into(),
            workspace_name: None,
            history_url: default.into(),
            cloud_history_origin: None,
            delivery_account: account.clone(),
            job_id: old_job.clone(),
            include_existing: true,
            sharing_mode: Some(all),
            acknowledge_uninspected_schedules: false,
        };
        let saved = |history_url: &str, account: &str| {
            saved_destination(Some(config.clone()), account, history_url)
        };
        assert!(saved(custom, &destination::account_id("org_1", Some("ws_2"))).is_err());
        assert!(matches!(
            saved(default, &account).unwrap(),
            SavedDestination::Same(_)
        ));
        let SavedDestination::Moved(old) = saved(custom, &account).unwrap() else {
            panic!("a changed origin is a move");
        };

        let moved = move_destination(&conn, old, custom, all, true).unwrap();
        assert_eq!(moved.history_url, custom);
        assert_eq!(moved.cloud_history_origin.as_deref(), Some(custom));
        assert_ne!(moved.job_id, old_job);
        let status = |job: &str| crate::delivery::status(&conn, job).unwrap();
        assert_eq!(status(&old_job).state, "cancelled");
        assert_ne!(status(&moved.job_id).state, "cancelled");
        assert_eq!(status(&moved.job_id).config.account_id, account);
        save_json(&path, &moved).unwrap();
        assert_eq!(read_config_file(&path).unwrap().history_url, custom);

        // Interrupted before config.json was written: the next sign-in finds
        // the old configuration and resumes on the generation already made.
        let SavedDestination::Moved(old) = saved(custom, &account).unwrap() else {
            panic!("still a move");
        };
        assert_eq!(
            move_destination(&conn, old, custom, all, true)
                .unwrap()
                .job_id,
            moved.job_id
        );

        // Back to the default History: the Cloud-named record goes with it.
        let back = move_destination(&conn, moved.clone(), default, all, true).unwrap();
        assert_eq!(back.history_url, default);
        assert_eq!(back.cloud_history_origin, None);
        assert_eq!(status(&moved.job_id).state, "cancelled");
        save_json(&path, &back).unwrap();
        assert!(read_config_file(&path).is_ok());
    }
    /// A saved configuration keeps a workspace's own RelayHistory origin only
    /// when setup recorded it from Cloud's answer; the same origin written in
    /// by hand is refused, and the default stage needs no record.
    #[test]
    fn a_saved_custom_history_origin_must_have_come_from_cloud() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("config.json");
        let config = |history_url: &str, cloud_history_origin: Option<&str>| Config {
            version: CONFIG_VERSION,
            site_url: "https://agentrelay.com".into(),
            account_id: "user_1".into(),
            account_email: None,
            account_name: None,
            account_avatar_url: None,
            org_id: "org_1".into(),
            workspace_id: "ws_1".into(),
            workspace_name: None,
            history_url: history_url.into(),
            cloud_history_origin: cloud_history_origin.map(String::from),
            delivery_account: destination::account_id("org_1", Some("ws_1")),
            job_id: "job".into(),
            include_existing: false,
            sharing_mode: None,
            acknowledge_uninspected_schedules: false,
        };
        let read = |config: &Config| {
            save_json(&path, config).unwrap();
            read_config_file(&path)
        };
        let custom = "https://history.hookdeck.example";
        assert!(read(&config("https://history.agentrelay.com", None)).is_ok());
        assert!(read(&config(custom, Some(custom))).is_ok());
        assert!(read(&config(custom, None)).is_err());
        assert!(read(&config(custom, Some("https://other.hookdeck.example"))).is_err());
        // The record does not widen the rule itself.
        for unsafe_origin in ["http://history.hookdeck.example", "https://10.0.0.5"] {
            assert!(read(&config(unsafe_origin, Some(unsafe_origin))).is_err());
        }
        // An install of the default stage writes no record.
        save_json(&path, &config("https://history.agentrelay.com", None)).unwrap();
        assert!(!fs::read_to_string(&path)
            .unwrap()
            .contains("cloud_history_origin"));
    }
}
