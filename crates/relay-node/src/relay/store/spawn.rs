//! What the store keeps of spawning: where each spawned agent came from,
//! and the settings per harness (`relay::spawn::settings` reads and checks
//! them).
//!
//! Codex and Claude keep their settings in fields of their own
//! (`spawnFullAccessCodex`, `spawnBillingClaude`, …), as they did before
//! there were other harnesses, so a store written now still reads the same
//! in an older core. Every harness added since is kept in `spawnHarnesses`,
//! by id. Nothing else here names a harness.

use super::*;
use std::path::{Path, PathBuf};

/// More local history than the wire limit keeps valid older folders available
/// when newer checkouts are removed.
const RECENT_FOLDER_HISTORY: usize = 40;

/// Where a spawned agent came from, and the process it runs as.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpawnOrigin {
    #[serde(rename = "nodeID")]
    pub node_id: String,
    /// Relaycast addresses an agent on a spawn node as `name@<node name>`.
    #[serde(rename = "nodeName")]
    pub node_name: String,
    #[serde(rename = "invocationID")]
    pub invocation_id: String,
    /// The harness's id (`relay::harness`), such as `codex`.
    pub harness: String,
    /// The agent that asked for the spawn, as Relaycast recorded it: its
    /// name and immutable id (`spawn::report_back`). A name alone is not
    /// enough, as another agent can take it later. When Cloud invokes the
    /// spawn for a desktop identity (a person's chat) through a launcher,
    /// this is that desktop identity, and `launcher` is the invoker.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requester: Option<SpawnRequester>,
    /// The participant that invoked the spawn on the requester's behalf
    /// (Relaycast's `caller_id`/`caller_name`), kept only when it is not the
    /// requester: Agent Relay Cloud invokes through a per-user launcher.
    /// Its direct messages count as the requester's. Absent on records from
    /// before it was kept.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launcher: Option<SpawnRequester>,
    /// The working folder the agent runs in, as the spawn resolved it (the
    /// request's, or the machine default): what every answer to the spawn
    /// reports as `worker_cwd`. Absent on records from before it was kept.
    #[serde(rename = "workerCwd", default, skip_serializing_if = "Option::is_none")]
    pub worker_cwd: Option<String>,
    /// A spawned Claude's own process; a Codex thread runs in Codex's
    /// app-server daemon and has none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process: Option<crate::relay::spawn::launch::SpawnedProcess>,
    /// Who the agent was spawned for, bound once at the spawn to its
    /// immutable agent id and never changed after. Only ever set from
    /// evidence Agent Relay itself vouches for, never from the spawn's
    /// input, its task or Relaycast metadata; absent (unknown) otherwise,
    /// and an unknown owner gets no owner input (`spawn::owner_of`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<SpawnOwner>,
    /// When the person took it over (`agents.take_over`): its headless
    /// process was stopped and its session is theirs to run in an
    /// interactive client, under the same name. `process` is then whichever
    /// process runs the session (`Spawner::session`), and releasing the
    /// agent leaves that process alone.
    #[serde(
        rename = "takenOverAt",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub taken_over_at: Option<String>,
    /// The verification Cloud records when the harness was not seen to take
    /// the spawn's first task (`spawn_task_unconfirmed`); absent when it
    /// was. A spawn answered again from this registration, before or after
    /// release, carries the same warning as its first answer.
    #[serde(
        rename = "taskUnconfirmed",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub task_unconfirmed: Option<String>,
    /// Registered at relaygate with its launch's one-time credential (a
    /// gate-only install): it acts there only with the `rg_` token that
    /// answered, which is kept in memory alone (`Store::launch_gates`).
    /// After a restart that token is gone and the credential is spent, so
    /// the agent acts with no other token and needs a relaunch. Holds no
    /// secret.
    #[serde(
        rename = "gateLaunch",
        default,
        skip_serializing_if = "std::ops::Not::not"
    )]
    pub gate_launch: bool,
}

impl SpawnOrigin {
    /// The immutable ids of the ones who asked for this spawn: its
    /// requester and, when another invoked it for them, the launcher. Never
    /// an empty id; never a name.
    pub fn asker_ids(&self) -> impl Iterator<Item = &str> {
        self.requester
            .iter()
            .chain(self.launcher.iter())
            .map(|asker| asker.agent_id.as_str())
            .filter(|id| !id.is_empty())
    }

    /// Whether `id` is the requester's or the launcher's immutable id.
    pub fn asked_by(&self, id: &str) -> bool {
        self.asker_ids().any(|asker| asker == id)
    }
}

/// The agent that asked for a spawn.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpawnRequester {
    pub name: String,
    #[serde(rename = "agentID")]
    pub agent_id: String,
}

/// The person a spawned agent was started for, as Cloud authenticated the
/// spawn (`SpawnOwner` in Cloud's relay spawn service).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpawnOwner {
    #[serde(rename = "workspaceID")]
    pub workspace_id: String,
    #[serde(rename = "userID")]
    pub user_id: String,
    #[serde(rename = "relayWorkspaceID")]
    pub relay_workspace_id: String,
    #[serde(rename = "actorID")]
    pub actor_id: String,
    #[serde(rename = "authorityHash")]
    pub authority_hash: String,
}

/// One harness's spawn settings as the person chose them; a missing value
/// is the harness's default.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct HarnessSpawnSettings {
    #[serde(
        rename = "fullAccess",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub full_access: Option<bool>,
    /// `subscription` or `api`; missing means not stated.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub billing: Option<String>,
}

impl Store {
    /// Keeps a successfully resolved spawn folder as bounded local history.
    /// Publication remains separately gated by the teammate-spawn setting.
    pub(crate) fn remember_spawn_folder(&mut self, folder: &str) {
        let Some(folder) = normalized_absolute(folder) else {
            return;
        };
        self.spawn_recent_folders.retain(|kept| kept != &folder);
        self.spawn_recent_folders.insert(0, folder);
        self.spawn_recent_folders.truncate(RECENT_FOLDER_HISTORY);
    }

    /// Absolute working-folder candidates, newest first. Durable history is
    /// authoritative; active origins only backfill stores written before the
    /// history field existed. Filesystem validation happens off the async
    /// heartbeat task before these are advertised.
    pub(crate) fn spawn_folder_candidates(&self) -> Vec<String> {
        let mut folders = Vec::new();
        let legacy_active = self
            .registrations
            .iter()
            .rev()
            .filter_map(|registration| registration.spawn.as_ref())
            .filter_map(|spawn| spawn.worker_cwd.as_deref());
        for folder in self
            .spawn_recent_folders
            .iter()
            .map(String::as_str)
            .chain(legacy_active)
        {
            let Some(folder) = normalized_absolute(folder) else {
                continue;
            };
            if !folders.contains(&folder) {
                folders.push(folder);
                if folders.len() == RECENT_FOLDER_HISTORY {
                    break;
                }
            }
        }
        folders
    }

    pub fn accepts_spawns(&self) -> bool {
        self.accept_spawns != Some(false)
    }

    /// The spawn settings kept for the harness `id`.
    pub fn spawn_harness(&self, id: &str) -> HarnessSpawnSettings {
        match id {
            "codex" => HarnessSpawnSettings {
                full_access: self.spawn_full_access_codex,
                billing: self.spawn_billing_codex.clone(),
            },
            "claude" => HarnessSpawnSettings {
                full_access: self.spawn_full_access_claude,
                billing: self.spawn_billing_claude.clone(),
            },
            _ => self.spawn_harnesses.get(id).cloned().unwrap_or_default(),
        }
    }

    /// Keeps `settings` for the harness `id`; nothing is kept for one with
    /// every value unset.
    pub fn set_spawn_harness(&mut self, id: &str, settings: HarnessSpawnSettings) {
        match id {
            "codex" => {
                self.spawn_full_access_codex = settings.full_access;
                self.spawn_billing_codex = settings.billing;
            }
            "claude" => {
                self.spawn_full_access_claude = settings.full_access;
                self.spawn_billing_claude = settings.billing;
            }
            _ if settings == HarnessSpawnSettings::default() => {
                self.spawn_harnesses.remove(id);
            }
            _ => {
                self.spawn_harnesses.insert(id.to_string(), settings);
            }
        }
    }
}

fn normalized_absolute(folder: &str) -> Option<String> {
    let path = Path::new(folder);
    if !path.is_absolute() {
        return None;
    }
    let normalized: PathBuf = path.components().collect();
    normalized.to_str().map(str::to_owned)
}

/// Both current writers may add or reorder history. Prefer our ordering,
/// retain their additions, then backfill the common base so an older writer
/// that omits this field cannot erase it.
pub(super) fn merge_recent_folders(base: &Store, ours: &Store, theirs: &Store) -> Vec<String> {
    let mut merged = Vec::new();
    let mut add = |folders: &[String]| {
        for folder in folders {
            if let Some(folder) = normalized_absolute(folder) {
                if !merged.contains(&folder) {
                    merged.push(folder);
                }
            }
        }
    };
    if ours.spawn_recent_folders != base.spawn_recent_folders {
        add(&ours.spawn_recent_folders);
    }
    if theirs.spawn_recent_folders != base.spawn_recent_folders {
        add(&theirs.spawn_recent_folders);
    }
    add(&base.spawn_recent_folders);
    merged.truncate(RECENT_FOLDER_HISTORY);
    merged
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn windows_absolute_folders_are_normalized_and_kept() {
        let mut store = Store::default();
        store.remember_spawn_folder(r"C:\Users\person\code\relay\");
        assert_eq!(
            store.spawn_folder_candidates(),
            [r"C:\Users\person\code\relay"]
        );
    }

    #[test]
    fn a_spawn_keeps_its_launcher_and_records_without_one_still_load() {
        let who = |name: &str, id: &str| SpawnRequester {
            name: name.into(),
            agent_id: id.into(),
        };
        let earlier = serde_json::json!({
            "nodeID": "node", "nodeName": "desk", "invocationID": "inv", "harness": "codex",
            "requester": {"name": "grokbot", "agentID": "agent_grokbot"}
        });
        let mut origin: SpawnOrigin = serde_json::from_value(earlier.clone()).unwrap();
        assert_eq!(origin.launcher, None);
        assert_eq!(origin.asker_ids().collect::<Vec<_>>(), ["agent_grokbot"]);
        // Written back unchanged: no launcher key appears.
        assert_eq!(serde_json::to_value(&origin).unwrap(), earlier);

        origin.requester = Some(who("person-chat", "agent_chat"));
        origin.launcher = Some(who("launcher", "agent_launch"));
        let encoded = serde_json::to_value(&origin).unwrap();
        assert_eq!(
            encoded["launcher"],
            serde_json::json!({"name": "launcher", "agentID": "agent_launch"})
        );
        let decoded: SpawnOrigin = serde_json::from_value(encoded).unwrap();
        assert_eq!(decoded, origin);
        assert!(decoded.asked_by("agent_chat") && decoded.asked_by("agent_launch"));
        assert!(!decoded.asked_by("launcher") && !decoded.asked_by("person-chat"));
        assert!(!decoded.asked_by(""));
    }

    #[test]
    fn codex_and_claude_keep_their_own_fields_and_others_the_map() {
        let mut store = Store::default();
        let chosen = HarnessSpawnSettings {
            full_access: Some(false),
            billing: Some("api".into()),
        };
        store.set_spawn_harness("claude", chosen.clone());
        assert_eq!(store.spawn_full_access_claude, Some(false));
        assert_eq!(store.spawn_billing_claude.as_deref(), Some("api"));
        assert!(store.spawn_harnesses.is_empty());
        assert_eq!(store.spawn_harness("claude"), chosen);
        assert_eq!(
            store.spawn_harness("codex"),
            HarnessSpawnSettings::default()
        );
        store.set_spawn_harness("opencode", chosen.clone());
        assert_eq!(store.spawn_harness("opencode"), chosen);
        let encoded = serde_json::to_value(&store).unwrap();
        assert_eq!(encoded["spawnFullAccessClaude"], false);
        assert_eq!(encoded["spawnBillingClaude"], "api");
        assert_eq!(
            encoded["spawnHarnesses"],
            serde_json::json!({"opencode": {"fullAccess": false, "billing": "api"}})
        );
        let decoded: Store = serde_json::from_value(encoded).unwrap();
        assert_eq!(decoded.spawn_harness("opencode"), chosen);
        // Back to the defaults: nothing kept.
        store.set_spawn_harness("opencode", HarnessSpawnSettings::default());
        assert!(serde_json::to_value(&store).unwrap()["spawnHarnesses"].is_null());
    }
}
