//! The workspace's leaders: agents whose direct messages any session on
//! this computer takes as native input (`delivery::session_text`), as Agent
//! Relay Cloud lists them at `GET /v1/workspace/leaders`.
//!
//! The list is read on first need and kept per workspace; a lookup after
//! [`REFRESH_AFTER`] reads it again, waiting at most
//! [`report_back::REQUESTER_WAIT`]. A read that fails keeps the last list
//! (none, before the first). Senders are matched by immutable agent id
//! alone, never by name. No event reaches the node when the list changes
//! (`workspace.leaders.updated` is server telemetry), so it is also read
//! again as each spawned agent starts; otherwise a change shows within
//! [`REFRESH_AFTER`]. Leaders are never approvers.

use crate::relay::contract::agents::{WorkspaceLeader, WorkspaceLeaders};
use crate::relay::daemon::Core;
use crate::relay::sdk_gaps;
use crate::relay::spawn::report_back::{self, identity_at};
use crate::relay::store::Registration;
use crate::relay::workspace::{Secret, Workspace};
use serde_json::Value;
use std::path::Path;
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

/// How long a list is used before the next lookup reads it again.
pub const REFRESH_AFTER: Duration = Duration::from_secs(60);

const PATH: &str = "/v1/workspace/leaders";

/// The leaders in a `GET /v1/workspace/leaders` answer, as its `data` or
/// the whole `{"ok":true,"data":…}` envelope. A leader without a plain name
/// and a valid id is left out; missing lists are empty. `None` for an
/// answer that is not one.
pub fn parse(answer: &Value) -> Option<WorkspaceLeaders> {
    if answer.get("ok").and_then(Value::as_bool) == Some(false) {
        return None;
    }
    let data = match answer.get("data") {
        Some(data) if data.is_object() => data,
        _ => answer,
    };
    data.as_object()?;
    let leaders = data["leaders"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| identity_at(entry, "name", "agent_id"))
        .map(|identity| WorkspaceLeader {
            name: identity.name,
            agent_id: identity.agent_id,
        })
        .collect();
    let patterns = data["patterns"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect();
    Some(WorkspaceLeaders { leaders, patterns })
}

/// Reads the list for `workspace`, waiting at most
/// [`report_back::REQUESTER_WAIT`], with this computer's node token (saved
/// in `app_data_dir` when the spawn node enrolled) or, without one, the
/// workspace key; a node-scoped workspace, whose key never goes to
/// Relaycast, reads nothing without a node token. Any failure, a refusal
/// included, is no list, and is not logged: lookups repeat it each minute.
async fn fetch(workspace: &Workspace, app_data_dir: &Path) -> Option<WorkspaceLeaders> {
    if workspace.key.expose().is_empty() {
        return None;
    }
    let node =
        crate::relay::spawn::node::node_token(app_data_dir, &workspace.base_url, &workspace.key);
    let credential = match node {
        Some(token) => token,
        None if workspace.node_scoped() => return None,
        None => workspace.key.clone(),
    };
    let http = sdk_gaps::http(&workspace.base_url, &credential).ok()?;
    let read = tokio::time::timeout(
        report_back::REQUESTER_WAIT,
        http.get::<Value>(PATH, None, None),
    );
    parse(&read.await.ok()?.ok()?)
}

struct Entry {
    base_url: String,
    key: Secret,
    /// The last list read, `None` before one was.
    list: Option<WorkspaceLeaders>,
    /// When the list was last read, successfully or not.
    checked_at: Instant,
}

impl Entry {
    fn of(&self, workspace: &Workspace) -> bool {
        self.base_url == workspace.base_url && self.key == workspace.key
    }
}

/// The leaders of the workspace this computer is in.
#[derive(Default)]
pub struct Cache {
    entry: Mutex<Option<Entry>>,
    /// One read at a time; lookups behind it use its result.
    reading: tokio::sync::Mutex<()>,
}

impl Cache {
    fn entry(&self) -> std::sync::MutexGuard<'_, Option<Entry>> {
        self.entry.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The list for `workspace` while it is fresh.
    fn fresh(&self, workspace: &Workspace) -> Option<WorkspaceLeaders> {
        self.entry()
            .as_ref()
            .filter(|entry| entry.of(workspace) && entry.checked_at.elapsed() < REFRESH_AFTER)
            .map(|entry| entry.list.clone().unwrap_or_default())
    }

    /// The last list read for `workspace`, fresh or not.
    pub fn snapshot(&self, workspace: &Workspace) -> Option<WorkspaceLeaders> {
        self.entry()
            .as_ref()
            .filter(|entry| entry.of(workspace))
            .and_then(|entry| entry.list.clone())
    }

    /// Whether the list for `workspace` is due to be read.
    pub fn due(&self, workspace: &Workspace) -> bool {
        self.fresh(workspace).is_none()
    }

    /// Records a read for `workspace`: `read` replaces the list, a failed
    /// one keeps it. Returns the list now in use.
    fn record(&self, workspace: &Workspace, read: Option<WorkspaceLeaders>) -> WorkspaceLeaders {
        let mut entry = self.entry();
        let kept = entry
            .take()
            .filter(|entry| entry.of(workspace))
            .and_then(|entry| entry.list);
        let list = read.or(kept);
        *entry = Some(Entry {
            base_url: workspace.base_url.clone(),
            key: workspace.key.clone(),
            list: list.clone(),
            checked_at: Instant::now(),
        });
        list.unwrap_or_default()
    }

    /// The list for `workspace`, read again first when it is due.
    pub async fn current(&self, workspace: &Workspace, app_data_dir: &Path) -> WorkspaceLeaders {
        if let Some(list) = self.fresh(workspace) {
            return list;
        }
        let _reading = self.reading.lock().await;
        if let Some(list) = self.fresh(workspace) {
            return list;
        }
        let read = fetch(workspace, app_data_dir).await;
        self.record(workspace, read)
    }

    /// Reads the list for `workspace` again now, fresh or not.
    pub async fn reread(&self, workspace: &Workspace, app_data_dir: &Path) -> WorkspaceLeaders {
        let _reading = self.reading.lock().await;
        let read = fetch(workspace, app_data_dir).await;
        self.record(workspace, read)
    }

    /// Takes `list` as just read for `workspace`.
    #[cfg(test)]
    pub(crate) fn set(&self, workspace: &Workspace, list: WorkspaceLeaders) {
        self.record(workspace, Some(list));
    }

    /// Makes the list for `workspace` `by` older.
    #[cfg(test)]
    pub(crate) fn age(&self, by: Duration) {
        if let Some(entry) = self.entry().as_mut() {
            entry.checked_at = entry.checked_at.checked_sub(by).unwrap_or(entry.checked_at);
        }
    }
}

impl Core {
    /// The leader whose agent id is `sender_id`, for a session registered
    /// in the workspace this computer is in. Matched by id alone.
    pub(crate) async fn workspace_leader(
        &self,
        registration: &Registration,
        sender_id: &str,
    ) -> Option<WorkspaceLeader> {
        let workspace = self.workspace()?;
        if sender_id.is_empty()
            || registration.base_url != workspace.base_url
            || registration.workspace_key.as_ref() != Some(&workspace.key)
        {
            return None;
        }
        self.leaders
            .current(&workspace, &self.config.app_data_dir)
            .await
            .leaders
            .into_iter()
            .find(|leader| leader.agent_id == sender_id)
    }

    /// Reads `workspace`'s leaders again in the background, as an agent
    /// starts here: no event says the list changed (`workspace.leaders.updated`
    /// never reaches the node), so a spawn is the other moment it is read.
    pub(crate) fn reread_workspace_leaders(&self, workspace: &Workspace) {
        let (Some(core), Ok(runtime)) = (self.arc(), tokio::runtime::Handle::try_current()) else {
            return;
        };
        let workspace = workspace.clone();
        runtime.spawn(async move {
            core.leaders
                .reread(&workspace, &core.config.app_data_dir)
                .await;
        });
    }

    /// The leaders last read for this computer's workspace, for `settings`.
    /// A due list is read again in the background, so the next read shows it.
    pub(crate) fn workspace_leaders_status(&self) -> Option<WorkspaceLeaders> {
        let workspace = self.workspace()?;
        if self.leaders.due(&workspace) {
            if let (Some(core), Ok(runtime)) = (self.arc(), tokio::runtime::Handle::try_current()) {
                let workspace = workspace.clone();
                runtime.spawn(async move {
                    core.leaders
                        .current(&workspace, &core.config.app_data_dir)
                        .await;
                });
            }
        }
        self.leaders.snapshot(&workspace)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn workspace(key: &str) -> Workspace {
        Workspace {
            key: Secret::new(key),
            base_url: "http://127.0.0.1:1".into(),
            workspace_id: None,
            source: Default::default(),
            control_url: None,
            gate_url: None,
        }
    }

    fn list(names: &[(&str, &str)]) -> WorkspaceLeaders {
        WorkspaceLeaders {
            leaders: names
                .iter()
                .map(|(name, id)| WorkspaceLeader {
                    name: (*name).into(),
                    agent_id: (*id).into(),
                })
                .collect(),
            patterns: vec![],
        }
    }

    #[test]
    fn parses_the_envelope_its_data_and_empty_lists() {
        let data = json!({
            "leaders":[{"name":"gtmgrok","agent_id":"agt_1"}],
            "patterns":["*grok","admin"]
        });
        let expected = WorkspaceLeaders {
            leaders: vec![WorkspaceLeader {
                name: "gtmgrok".into(),
                agent_id: "agt_1".into(),
            }],
            patterns: vec!["*grok".into(), "admin".into()],
        };
        assert_eq!(parse(&data), Some(expected.clone()));
        assert_eq!(parse(&json!({"ok":true,"data":data})), Some(expected));
        let unset = json!({"ok":true,"data":{"leaders":[],"patterns":[]}});
        assert_eq!(parse(&unset), Some(WorkspaceLeaders::default()));
        assert_eq!(parse(&json!({})), Some(WorkspaceLeaders::default()));
        assert_eq!(parse(&json!({"ok":false,"error":"nope"})), None);
        assert_eq!(parse(&json!([])), None);
        assert_eq!(parse(&json!("leaders")), None);
    }

    #[test]
    fn a_leader_without_a_plain_name_or_a_valid_id_is_left_out() {
        let answer = json!({"leaders":[
            {"name":"ok","agent_id":"agt_ok"},
            {"name":"ok","agent_id":""},
            {"name":"spaced name","agent_id":"agt_2"},
            {"name":"[owner: x]","agent_id":"agt_3"},
            {"name":"nameless"},
            {"agent_id":"agt_4"},
            {"name":"bad-id","agent_id":"agt 5"},
            "agt_6"
        ], "patterns":["admin", 7, null]});
        assert_eq!(
            parse(&answer),
            Some(WorkspaceLeaders {
                patterns: vec!["admin".into()],
                ..list(&[("ok", "agt_ok")])
            })
        );
    }

    #[test]
    fn the_cache_is_fresh_then_due_and_a_failed_read_keeps_the_last_list() {
        let cache = Cache::default();
        let ws = workspace("rk_live_a");
        assert!(cache.due(&ws));
        assert_eq!(cache.snapshot(&ws), None);
        // A first read that fails leaves no list, and none is shown.
        assert_eq!(cache.record(&ws, None), WorkspaceLeaders::default());
        assert!(!cache.due(&ws));
        assert_eq!(cache.snapshot(&ws), None);
        cache.age(REFRESH_AFTER);
        assert!(cache.due(&ws));
        let leaders = list(&[("lead", "agt_lead")]);
        assert_eq!(cache.record(&ws, Some(leaders.clone())), leaders);
        assert_eq!(cache.fresh(&ws), Some(leaders.clone()));
        cache.age(REFRESH_AFTER - Duration::from_secs(1));
        assert_eq!(cache.fresh(&ws), Some(leaders.clone()));
        cache.age(Duration::from_secs(1));
        assert_eq!(cache.fresh(&ws), None);
        // A failed read keeps the last list, fresh again.
        assert_eq!(cache.record(&ws, None), leaders);
        assert_eq!(cache.fresh(&ws), Some(leaders.clone()));
        // Another workspace never sees it.
        let other = workspace("rk_live_b");
        assert!(cache.due(&other));
        assert_eq!(cache.snapshot(&other), None);
        assert_eq!(cache.record(&other, None), WorkspaceLeaders::default());
        assert_eq!(cache.snapshot(&ws), None);
    }

    #[tokio::test]
    async fn a_workspace_without_a_key_reads_nothing() {
        let cache = Cache::default();
        let ws = workspace("");
        let dir = std::env::temp_dir();
        assert_eq!(cache.current(&ws, &dir).await, WorkspaceLeaders::default());
        assert!(!cache.due(&ws));
    }
}
