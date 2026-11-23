//! The workspace's leaders: agents whose direct messages spawned agents and
//! teammate-input Claude Code sessions on this computer take as native
//! input (`delivery::session_text`), as Agent Relay Cloud lists them at
//! `GET /v1/workspace/leaders`.
//!
//! The list is read on first need and kept per workspace; a lookup after
//! [`REFRESH_AFTER`] reads it again, waiting at most
//! [`report_back::REQUESTER_WAIT`]. A read that fails keeps the last list
//! (none, before the first) for at most [`KEEP_FOR`] after the last read
//! that succeeded; after that no one is a leader until a read succeeds. A
//! refusal (401, 403 or 404) drops the list at once. Senders are matched by
//! immutable agent id alone, never by name. No event reaches the node when
//! the list changes (`workspace.leaders.updated` is server telemetry), so it
//! is also read again as each spawned agent starts (at most once per
//! [`REREAD_AFTER`]); otherwise a change shows within [`REFRESH_AFTER`].
//!
//! Leaders are approvers only with **Approvals from workspace leaders**
//! (`spawn_leader_approvals`) on, off unless the machine owner turns it on,
//! and native input from spawning agents on, in a build with an account. A
//! leader's 1:1 direct message, from a listed leader's agent id (never a
//! name or a pattern), then approves or denies an open, approvable request
//! of an agent spawned here, registered in this computer's workspace and
//! not taken over, as the machine owner could: neither
//! `spawn_requester_approvals` nor the spawn's approval profile
//! (`interactive` included) limits it.
//! Only a list read successfully within [`REFRESH_AFTER`] serves
//! ([`Cache::verified`]): one that is older is read again, and when that
//! read fails or is refused no one is an approver; the list failed reads
//! keep for [`KEEP_FOR`] never is. A leader never chooses an option,
//! answers a form, input or local verification, answers for the session
//! itself, or answers as the spawning agent (which keeps its own rules), and
//! its answer is never recorded as the machine owner's.

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

/// How long the last list stays in use after the last read that succeeded,
/// while later reads fail.
pub const KEEP_FOR: Duration = Duration::from_secs(10 * 60);

/// A read for a starting agent this soon after the last read is skipped.
pub const REREAD_AFTER: Duration = Duration::from_secs(5);

const PATH: &str = "/v1/workspace/leaders";

/// The setting that lets workspace leaders answer spawned sessions' requests.
pub const SETTING: &str = "spawn_leader_approvals";

/// Why approvals from workspace leaders ([`SETTING`]) are not
/// available on a gate-only install, as `GET /settings` lists it and a
/// change that turns it on is refused. Such a workspace has no workspace
/// key and its sessions keep none, so neither the leader list nor a
/// session's workspace can be checked here; the node's own credential is
/// never sent for it (it goes to Control alone).
pub const GATE_ONLY: &str = "Approvals from workspace leaders are not available on this computer: it reaches its workspace only through relaygate, where Agent Relay cannot read the workspace's leaders or check that a session is in the workspace.";

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

/// What a read of the list came to.
#[derive(Debug)]
enum Read {
    List(WorkspaceLeaders),
    /// Relaycast refused the read (401, 403) or has no list (404): no one
    /// is a leader.
    Refused,
    /// The read could not be made or answered: the last list is kept.
    Failed,
}

/// Whether an HTTP `status` refuses the read, rather than failing it.
fn refusal(status: Option<u16>) -> bool {
    matches!(status, Some(401 | 403 | 404))
}

/// Reads the list for `workspace`, waiting at most
/// [`report_back::REQUESTER_WAIT`], with this computer's node token (saved
/// in `app_data_dir` when the spawn node enrolled) or, without one, the
/// workspace key; a node-scoped workspace, whose key never goes to
/// Relaycast, reads nothing without a node token. A failure is not
/// logged: lookups repeat it each minute.
async fn fetch(workspace: &Workspace, app_data_dir: &Path) -> Read {
    if workspace.key.expose().is_empty() {
        return Read::Failed;
    }
    let node =
        crate::relay::spawn::node::node_token(app_data_dir, &workspace.base_url, &workspace.key);
    let credential = match node {
        Some(token) => token,
        None if workspace.node_scoped() => return Read::Failed,
        None => workspace.key.clone(),
    };
    let Ok(http) = sdk_gaps::http(&workspace.base_url, &credential) else {
        return Read::Failed;
    };
    let read = tokio::time::timeout(
        report_back::REQUESTER_WAIT,
        http.get::<Value>(PATH, None, None),
    );
    match read.await {
        Ok(Ok(answer)) => parse(&answer).map_or(Read::Failed, Read::List),
        Ok(Err(error)) if refusal(error.status()) => Read::Refused,
        _ => Read::Failed,
    }
}

struct Entry {
    base_url: String,
    key: Secret,
    /// The last list read, `None` before one was or after a refusal.
    list: Option<WorkspaceLeaders>,
    /// When a read last succeeded.
    read_at: Option<Instant>,
    /// When the list was last read, successfully or not.
    checked_at: Instant,
}

impl Entry {
    fn of(&self, workspace: &Workspace) -> bool {
        self.base_url == workspace.base_url && self.key == workspace.key
    }

    /// The list, while it is within [`KEEP_FOR`] of the last read that
    /// succeeded.
    fn in_use(&self) -> Option<&WorkspaceLeaders> {
        self.list
            .as_ref()
            .filter(|_| self.read_at.is_some_and(|at| at.elapsed() < KEEP_FOR))
    }
}

/// The leaders of the workspace this computer is in.
#[derive(Default)]
pub struct Cache {
    entry: Mutex<Option<Entry>>,
    /// One read at a time; lookups behind it use its result, and a read
    /// for a starting agent never queues behind it.
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
            .map(|entry| entry.in_use().cloned().unwrap_or_default())
    }

    /// Whether the list for `workspace` was read, successfully or not,
    /// less than `within` ago.
    fn checked_within(&self, workspace: &Workspace, within: Duration) -> bool {
        self.entry()
            .as_ref()
            .is_some_and(|entry| entry.of(workspace) && entry.checked_at.elapsed() < within)
    }

    /// The list for `workspace` as a read that succeeded less than `within`
    /// ago gave it.
    fn read_within(&self, workspace: &Workspace, within: Duration) -> Option<WorkspaceLeaders> {
        self.entry()
            .as_ref()
            .filter(|entry| {
                entry.of(workspace) && entry.read_at.is_some_and(|at| at.elapsed() < within)
            })
            .and_then(|entry| entry.list.clone())
    }

    /// The list for `workspace` while a read that succeeded less than
    /// [`REFRESH_AFTER`] ago gives it, for approvals: an older one is read
    /// again first, unless a read was made less than [`REREAD_AFTER`] ago.
    /// `None` when there is no such read: the list failed reads keep
    /// ([`KEEP_FOR`]) never serves, and a refusal serves nothing.
    pub async fn verified(
        &self,
        workspace: &Workspace,
        app_data_dir: &Path,
    ) -> Option<WorkspaceLeaders> {
        if let Some(list) = self.read_within(workspace, REFRESH_AFTER) {
            return Some(list);
        }
        let _reading = self.reading.lock().await;
        if let Some(list) = self.read_within(workspace, REFRESH_AFTER) {
            return Some(list);
        }
        if self.checked_within(workspace, REREAD_AFTER) {
            return None;
        }
        let read = fetch(workspace, app_data_dir).await;
        self.record(workspace, read);
        self.read_within(workspace, REFRESH_AFTER)
    }

    /// The list in use for `workspace`, fresh or not.
    pub fn snapshot(&self, workspace: &Workspace) -> Option<WorkspaceLeaders> {
        self.entry()
            .as_ref()
            .filter(|entry| entry.of(workspace))
            .and_then(|entry| entry.in_use().cloned())
    }

    /// Whether the list for `workspace` is due to be read.
    pub fn due(&self, workspace: &Workspace) -> bool {
        self.fresh(workspace).is_none()
    }

    /// Records a read for `workspace`: a list replaces the list, a refusal
    /// drops it, a failed read keeps it (and when it last succeeded).
    /// Returns the list now in use.
    fn record(&self, workspace: &Workspace, read: Read) -> WorkspaceLeaders {
        let mut entry = self.entry();
        let now = Instant::now();
        let (list, read_at) = match read {
            Read::List(list) => (Some(list), Some(now)),
            Read::Refused => (None, None),
            Read::Failed => entry
                .take()
                .filter(|entry| entry.of(workspace))
                .map_or((None, None), |entry| (entry.list, entry.read_at)),
        };
        let recorded = Entry {
            base_url: workspace.base_url.clone(),
            key: workspace.key.clone(),
            list,
            read_at,
            checked_at: now,
        };
        let in_use = recorded.in_use().cloned().unwrap_or_default();
        *entry = Some(recorded);
        in_use
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

    /// Reads the list for `workspace` again now, fresh or not, unless it
    /// was read less than [`REREAD_AFTER`] ago or a read is in flight,
    /// whose result serves: a burst of starting agents makes one read, and
    /// a lookup never waits behind more than one.
    pub async fn reread(&self, workspace: &Workspace, app_data_dir: &Path) {
        if self.checked_within(workspace, REREAD_AFTER) {
            return;
        }
        let Ok(_reading) = self.reading.try_lock() else {
            return;
        };
        if self.checked_within(workspace, REREAD_AFTER) {
            return;
        }
        let read = fetch(workspace, app_data_dir).await;
        self.record(workspace, read);
    }

    /// Takes `list` as just read for `workspace`.
    #[cfg(test)]
    pub(crate) fn set(&self, workspace: &Workspace, list: WorkspaceLeaders) {
        self.record(workspace, Read::List(list));
    }

    /// Makes the list for `workspace`, and its last good read, `by` older.
    #[cfg(test)]
    pub(crate) fn age(&self, by: Duration) {
        if let Some(entry) = self.entry().as_mut() {
            entry.checked_at = entry.checked_at.checked_sub(by).unwrap_or(entry.checked_at);
            entry.read_at = entry.read_at.map(|at| at.checked_sub(by).unwrap_or(at));
        }
    }
}

impl Core {
    /// The workspace this computer is in, when `registration` is registered
    /// in it.
    fn leaders_workspace(&self, registration: &Registration) -> Option<Workspace> {
        self.workspace().filter(|workspace| {
            registration.base_url == workspace.base_url
                && registration.workspace_key.as_ref() == Some(&workspace.key)
        })
    }

    /// The leader whose agent id is `sender_id`, for a session registered
    /// in the workspace this computer is in. Matched by id alone.
    pub(crate) async fn workspace_leader(
        &self,
        registration: &Registration,
        sender_id: &str,
    ) -> Option<WorkspaceLeader> {
        let workspace = self.leaders_workspace(registration)?;
        if sender_id.is_empty() {
            return None;
        }
        self.leaders
            .current(&workspace, &self.config.app_data_dir)
            .await
            .leaders
            .into_iter()
            .find(|leader| leader.agent_id == sender_id)
    }

    /// The leaders of the workspace `registration` is registered in, when it
    /// is this computer's, as a read that succeeded within
    /// [`REFRESH_AFTER`] lists them ([`Cache::verified`]): the only list a
    /// leader's approval is taken from. Empty when there is none.
    pub(crate) async fn verified_workspace_leaders(
        &self,
        registration: &Registration,
    ) -> Vec<WorkspaceLeader> {
        self.verified_workspace_leaders_read(registration)
            .await
            .unwrap_or_default()
    }

    /// [`Self::verified_workspace_leaders`], telling a list that could not
    /// be had (`None`: no read succeeded within [`REFRESH_AFTER`], or one
    /// was refused) from one that has no such leader. A session not in
    /// this computer's workspace has none (`Some` of an empty list).
    pub(crate) async fn verified_workspace_leaders_read(
        &self,
        registration: &Registration,
    ) -> Option<Vec<WorkspaceLeader>> {
        let Some(workspace) = self.leaders_workspace(registration) else {
            return Some(Vec::new());
        };
        let list = self
            .leaders
            .verified(&workspace, &self.config.app_data_dir)
            .await?;
        Some(
            list.leaders
                .into_iter()
                .filter(|leader| !leader.agent_id.is_empty())
                .collect(),
        )
    }

    /// Why **Approvals from workspace leaders** cannot work on this
    /// computer, when it cannot ([`GATE_ONLY`]); `None` otherwise.
    pub(crate) fn leader_approvals_unavailable(&self) -> Option<&'static str> {
        self.workspace()
            .is_some_and(|workspace| workspace.is_gate_only())
            .then_some(GATE_ONLY)
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
        assert_eq!(cache.record(&ws, Read::Failed), WorkspaceLeaders::default());
        assert!(!cache.due(&ws));
        assert_eq!(cache.snapshot(&ws), None);
        cache.age(REFRESH_AFTER);
        assert!(cache.due(&ws));
        let leaders = list(&[("lead", "agt_lead")]);
        assert_eq!(cache.record(&ws, Read::List(leaders.clone())), leaders);
        assert_eq!(cache.fresh(&ws), Some(leaders.clone()));
        cache.age(REFRESH_AFTER - Duration::from_secs(1));
        assert_eq!(cache.fresh(&ws), Some(leaders.clone()));
        cache.age(Duration::from_secs(1));
        assert_eq!(cache.fresh(&ws), None);
        // A failed read keeps the last list, fresh again.
        assert_eq!(cache.record(&ws, Read::Failed), leaders);
        assert_eq!(cache.fresh(&ws), Some(leaders.clone()));
        // Another workspace never sees it.
        let other = workspace("rk_live_b");
        assert!(cache.due(&other));
        assert_eq!(cache.snapshot(&other), None);
        assert_eq!(
            cache.record(&other, Read::Failed),
            WorkspaceLeaders::default()
        );
        assert_eq!(cache.snapshot(&ws), None);
    }

    // Failed reads keep the list only for `KEEP_FOR` after the last read
    // that succeeded: they do not make it younger. After that no one is a
    // leader, until a read succeeds again.
    #[test]
    fn failed_reads_keep_the_list_only_for_a_while_after_the_last_good_read() {
        let cache = Cache::default();
        let ws = workspace("rk_live_a");
        let leaders = list(&[("lead", "agt_lead")]);
        cache.record(&ws, Read::List(leaders.clone()));
        for _ in 0..9 {
            cache.age(REFRESH_AFTER);
            assert_eq!(cache.record(&ws, Read::Failed), leaders);
        }
        // Nine minutes on, a failed read does not reset the clock.
        let half = (KEEP_FOR - REFRESH_AFTER * 9) / 2;
        cache.age(half);
        assert_eq!(cache.snapshot(&ws), Some(leaders.clone()));
        assert_eq!(cache.record(&ws, Read::Failed), leaders);
        assert_eq!(cache.fresh(&ws), Some(leaders.clone()));
        cache.age(half);
        // Expired while still fresh: the lookup sees no leaders.
        assert_eq!(cache.fresh(&ws), Some(WorkspaceLeaders::default()));
        assert_eq!(cache.snapshot(&ws), None);
        assert_eq!(cache.record(&ws, Read::Failed), WorkspaceLeaders::default());
        assert_eq!(cache.snapshot(&ws), None);
        assert_eq!(cache.record(&ws, Read::List(leaders.clone())), leaders);
        assert_eq!(cache.snapshot(&ws), Some(leaders));
    }

    // 401, 403 and 404 drop the list at once; anything else keeps it.
    #[test]
    fn a_refusal_drops_the_list_at_once() {
        for status in [401, 403, 404] {
            assert!(refusal(Some(status)), "{status}");
        }
        for status in [None, Some(400), Some(429), Some(500), Some(503)] {
            assert!(!refusal(status), "{status:?}");
        }
        let cache = Cache::default();
        let ws = workspace("rk_live_a");
        let leaders = list(&[("lead", "agt_lead")]);
        cache.record(&ws, Read::List(leaders.clone()));
        assert_eq!(
            cache.record(&ws, Read::Refused),
            WorkspaceLeaders::default()
        );
        assert_eq!(cache.snapshot(&ws), None);
        assert!(!cache.due(&ws));
        // A failed read after a refusal brings nothing back.
        cache.age(REFRESH_AFTER);
        assert_eq!(cache.record(&ws, Read::Failed), WorkspaceLeaders::default());
    }

    // A read for a starting agent is skipped within `REREAD_AFTER` of the
    // last read, and never waits behind one in flight.
    #[tokio::test]
    async fn a_reread_is_coalesced_and_never_queues() {
        let cache = Cache::default();
        let ws = workspace("rk_live_a");
        let dir = tempfile::tempdir().unwrap();
        let leaders = list(&[("lead", "agt_lead")]);
        cache.record(&ws, Read::List(leaders.clone()));
        cache.age(REREAD_AFTER - Duration::from_secs(1));
        cache.reread(&ws, dir.path()).await;
        assert!(!cache.checked_within(&ws, REREAD_AFTER - Duration::from_secs(1)));
        // A read in flight: the reread returns at once, reading nothing.
        cache.age(Duration::from_secs(1));
        let reading = cache.reading.lock().await;
        tokio::time::timeout(Duration::from_millis(500), cache.reread(&ws, dir.path()))
            .await
            .expect("a reread never waits for a read in flight");
        assert!(!cache.checked_within(&ws, REREAD_AFTER));
        drop(reading);
        // Due and free, it reads (here it fails, keeping the list).
        cache.reread(&ws, dir.path()).await;
        assert!(cache.checked_within(&ws, REREAD_AFTER));
        assert_eq!(cache.snapshot(&ws), Some(leaders));
    }

    #[tokio::test]
    async fn a_workspace_without_a_key_reads_nothing() {
        let cache = Cache::default();
        let ws = workspace("");
        let dir = std::env::temp_dir();
        assert_eq!(cache.current(&ws, &dir).await, WorkspaceLeaders::default());
        assert!(!cache.due(&ws));
    }

    // Approvals take only a list read successfully within `REFRESH_AFTER`:
    // never the list failed reads keep, and nothing after a refusal.
    #[tokio::test]
    async fn approvals_take_only_a_list_read_successfully_within_refresh_after() {
        let cache = Cache::default();
        let ws = workspace("rk_live_a");
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(cache.verified(&ws, dir.path()).await, None);
        let leaders = list(&[("lead", "agt_lead")]);
        cache.record(&ws, Read::List(leaders.clone()));
        assert_eq!(cache.verified(&ws, dir.path()).await, Some(leaders.clone()));
        cache.age(REFRESH_AFTER - Duration::from_secs(1));
        assert_eq!(cache.verified(&ws, dir.path()).await, Some(leaders.clone()));
        // Aged past it, it is read again (here the read fails): none, though
        // native input keeps the list.
        cache.age(Duration::from_secs(1));
        assert_eq!(cache.verified(&ws, dir.path()).await, None);
        assert!(cache.checked_within(&ws, REREAD_AFTER));
        assert_eq!(cache.snapshot(&ws), Some(leaders.clone()));
        assert_eq!(cache.current(&ws, dir.path()).await, leaders);
        // A failed read just made is not made again at once.
        cache.record(&ws, Read::Failed);
        assert_eq!(cache.verified(&ws, dir.path()).await, None);
        assert!(cache.read_within(&ws, KEEP_FOR).is_some());
        // A good read serves again; a refusal serves nothing.
        cache.record(&ws, Read::List(leaders.clone()));
        assert_eq!(cache.verified(&ws, dir.path()).await, Some(leaders));
        cache.record(&ws, Read::Refused);
        assert_eq!(cache.verified(&ws, dir.path()).await, None);
        // Another workspace never sees a list.
        assert_eq!(
            cache.verified(&workspace("rk_live_b"), dir.path()).await,
            None
        );
    }
}
