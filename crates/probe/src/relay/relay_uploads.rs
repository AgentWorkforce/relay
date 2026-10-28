//! Sessions on the relay are uploaded.
//!
//! Every registered session the uploader lists but does not upload yet is
//! included, once: a session whose inclusion was refused, or that someone
//! stopped uploading afterwards, is not asked for again until it leaves the
//! relay and returns. Checked whenever the agents change and on every
//! uploader supervision tick. With sharing `all` everything uploads already;
//! an install a newer probe runs is left alone.

use crate::relay::daemon::Core;
use crate::relay::state::Listing;
use crate::relay::uploader::{Target, Uploader};
use serde_json::Value;
use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};

/// What has been asked for, per attached install.
#[derive(Default)]
pub struct RelayUploads {
    requested: Mutex<(Option<Target>, BTreeSet<String>)>,
    /// The registered sessions the last pass found shared with the
    /// workspace (`shared`): what an agent is doing is published only for
    /// these (`relay::activity`).
    shared: Mutex<BTreeSet<String>>,
    /// One pass at a time.
    running: tokio::sync::Mutex<()>,
}

/// The registered keys `listed` shares with the workspace: those the
/// uploader includes, and under sharing `all` every one not excluded by
/// itself.
pub fn shared(registered: &BTreeSet<String>, listed: &Value) -> BTreeSet<String> {
    let all = listed["sharing_mode"].as_str() == Some("all");
    let mut included = BTreeSet::new();
    let mut excluded = BTreeSet::new();
    for session in listed["sessions"].as_array().into_iter().flatten() {
        let (Some(source), Some(id)) = (session["source"].as_str(), session["session_id"].as_str())
        else {
            continue;
        };
        let key = format!("{source}:{id}");
        if session["included"] == Value::Bool(true) {
            included.insert(key);
        } else if session["included"] == Value::Bool(false) {
            excluded.insert(key);
        }
    }
    registered
        .iter()
        .filter(|key| included.contains(*key) || (all && !excluded.contains(*key)))
        .cloned()
        .collect()
}

/// The keys to include now: registered, listed, not uploaded, never asked
/// for while on the relay. `requested` keeps only keys still registered.
pub fn pending(
    registered: &BTreeSet<String>,
    listed: &Value,
    requested: &mut BTreeSet<String>,
) -> Vec<String> {
    requested.retain(|key| registered.contains(key));
    if listed["sharing_mode"].as_str() == Some("all") {
        return Vec::new();
    }
    let mut keys = Vec::new();
    for session in listed["sessions"].as_array().into_iter().flatten() {
        let (Some(source), Some(id)) = (session["source"].as_str(), session["session_id"].as_str())
        else {
            continue;
        };
        let key = format!("{source}:{id}");
        if registered.contains(&key)
            && session["included"] != Value::Bool(true)
            && !requested.contains(&key)
            && !keys.contains(&key)
        {
            keys.push(key);
        }
    }
    keys
}

fn belongs_to_upload_workspace(
    registered_key: Option<&crate::relay::workspace::Secret>,
    registered_origin: &str,
    upload_key: &crate::relay::workspace::Secret,
    upload_origin: &str,
) -> bool {
    registered_key == Some(upload_key) && registered_origin == upload_origin
}

impl RelayUploads {
    /// The registered sessions shared with the workspace, as `source:id`
    /// keys, when the last pass looked.
    pub fn shared(&self) -> BTreeSet<String> {
        self.shared
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// One pass: includes what `pending` names and says so on `invalidated`.
    pub async fn sync(&self, core: &Core, uploader: &Uploader) {
        // One pass at a time; a pass already running sees the same state.
        let Ok(_one) = self.running.try_lock() else {
            return;
        };
        let Some(install) = uploader.install() else {
            // Signed out or detached: nothing is shared any more.
            self.shared.lock().unwrap_or_else(|e| e.into_inner()).clear();
            return;
        };
        // A newer build's claim suppresses inclusion only while its process
        // is live: a claim left behind by an exited collector, or a cached
        // one from before the runtime record was corrected, must not stop
        // every pass. Older probes do not report the live flag; their
        // installs keep the cached one.
        let upgrade_live = uploader
            .status()
            .await
            .ok()
            .and_then(|status| status["upgrade_required_live"].as_bool())
            .unwrap_or(install.upgrade_required);
        if upgrade_live {
            return;
        }
        let target = install.target;
        let registered: BTreeSet<String> = core.store.read(|store| {
            // Registrations outlive sign-out and retain their original key.
            // Only the authenticated upload workspace may auto-include them.
            let Some(cloud) = store.cloud.as_ref().filter(|cloud| {
                cloud.account_workspace_id.is_some()
                    && cloud.account_workspace_id == target.workspace_id
            }) else {
                return BTreeSet::new();
            };
            store
                .registrations
                .iter()
                .filter(|r| {
                    belongs_to_upload_workspace(
                        r.workspace_key.as_ref(),
                        &r.base_url,
                        &cloud.key,
                        &cloud.base_url,
                    )
                })
                .filter_map(|r| r.target.upload_key())
                .collect()
        });
        {
            let mut requested = self.requested.lock().unwrap();
            if requested.0.as_ref() != Some(&target) {
                *requested = (Some(target.clone()), BTreeSet::new());
            }
            if registered.is_empty() {
                requested.1.clear();
                self.shared
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .clear();
                return;
            }
        }
        let Ok(listed) = uploader.sessions_list(Some(LISTED)).await else {
            return;
        };
        if uploader.target().as_ref() != Some(&target) {
            return;
        }
        *self.shared.lock().unwrap_or_else(|e| e.into_inner()) = shared(&registered, &listed);
        let keys = {
            let mut requested = self.requested.lock().unwrap();
            if requested.0.as_ref() != Some(&target) {
                return;
            }
            let keys = pending(&registered, &listed, &mut requested.1);
            requested.1.extend(keys.iter().cloned());
            keys
        };
        if keys.is_empty() {
            return;
        }
        if uploader
            .sessions_change_for(&target, true, &keys)
            .await
            .is_ok()
        {
            self.shared
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .extend(keys.iter().cloned());
            core.hub.invalidated(Listing::Uploader);
        } else {
            // Not asked after all: the next pass tries again.
            let mut requested = self.requested.lock().unwrap();
            if requested.0.as_ref() == Some(&target) {
                for key in &keys {
                    requested.1.remove(key);
                }
            }
        }
    }
}

/// Every session the uploader lists, not one page: a registered session
/// can be older than the latest few hundred.
const LISTED: usize = 10_000;

/// Runs a pass whenever the agents change, for the daemon's life; the
/// supervision tick runs the others.
pub async fn watch(core: Arc<Core>, uploader: Arc<Uploader>, uploads: Arc<RelayUploads>) {
    use crate::relay::protocol::Topic;
    let mut events = core.hub.subscribe();
    loop {
        match events.recv().await {
            Ok(event) => {
                if event.topic == Topic::Invalidated && event.data["what"] == "agents" {
                    uploads.sync(&core, &uploader).await;
                }
            }
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                uploads.sync(&core, &uploader).await;
            }
            Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn automatic_uploads_do_not_follow_registrations_into_another_workspace() {
        use crate::relay::workspace::Secret;
        let original = Secret::new("rk_live_original");
        let other = Secret::new("rk_live_other");
        assert!(super::belongs_to_upload_workspace(
            Some(&original),
            "https://cast.agentrelay.com",
            &original,
            "https://cast.agentrelay.com"
        ));
        assert!(!super::belongs_to_upload_workspace(
            Some(&original),
            "https://cast.agentrelay.com",
            &other,
            "https://cast.agentrelay.com"
        ));
        assert!(!super::belongs_to_upload_workspace(
            None,
            "https://cast.agentrelay.com",
            &other,
            "https://cast.agentrelay.com"
        ));
        assert!(!super::belongs_to_upload_workspace(
            Some(&original),
            "https://other.example",
            &original,
            "https://cast.agentrelay.com"
        ));
    }

    use super::*;
    use serde_json::json;

    fn keys(values: &[&str]) -> BTreeSet<String> {
        values.iter().map(|v| v.to_string()).collect()
    }

    fn listed(mode: &str, sessions: Value) -> Value {
        json!({"sharing_mode": mode, "sessions": sessions})
    }

    #[test]
    fn includes_registered_sessions_the_uploader_lists_but_does_not_upload() {
        let registered = keys(&["codex:a", "claude:b", "codex:c"]);
        let sessions = json!([
            {"source": "codex", "session_id": "a", "included": false},
            {"source": "claude", "session_id": "b", "included": true},
            {"source": "codex", "session_id": "d", "included": false},
        ]);
        let mut requested = BTreeSet::new();
        assert_eq!(
            pending(&registered, &listed("new", sessions), &mut requested),
            vec!["codex:a"]
        );
    }

    #[test]
    fn only_included_registered_sessions_are_shared() {
        let registered = keys(&["codex:a", "claude:b"]);
        let sessions = json!([
            {"source": "codex", "session_id": "a", "included": false},
            {"source": "claude", "session_id": "b", "included": true},
            {"source": "codex", "session_id": "d", "included": true},
        ]);
        assert_eq!(
            shared(&registered, &listed("selected", sessions.clone())),
            keys(&["claude:b"])
        );
        // Under `all`, a session someone stopped uploading stays private.
        assert_eq!(shared(&registered, &listed("all", sessions)), keys(&["claude:b"]));
        assert_eq!(shared(&registered, &listed("all", json!([]))), registered);
    }

    #[test]
    fn asks_once_until_the_session_leaves_the_relay() {
        let sessions = json!([{"source": "codex", "session_id": "a", "included": false}]);
        let mut requested = keys(&["codex:a"]);
        let on = keys(&["codex:a"]);
        assert!(pending(&on, &listed("selected", sessions.clone()), &mut requested).is_empty());
        // Off the relay: forgotten, so returning asks again.
        assert!(pending(
            &BTreeSet::new(),
            &listed("selected", sessions.clone()),
            &mut requested
        )
        .is_empty());
        assert!(requested.is_empty());
        assert_eq!(
            pending(&on, &listed("selected", sessions), &mut requested),
            vec!["codex:a"]
        );
    }

    #[test]
    fn sharing_everything_needs_nothing() {
        let sessions = json!([{"source": "codex", "session_id": "a", "included": false}]);
        let mut requested = BTreeSet::new();
        assert!(pending(
            &keys(&["codex:a"]),
            &listed("all", sessions),
            &mut requested
        )
        .is_empty());
    }
}
