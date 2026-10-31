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
    /// enough, as another agent can take it later.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requester: Option<SpawnRequester>,
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

#[cfg(test)]
mod tests {
    use super::*;

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
