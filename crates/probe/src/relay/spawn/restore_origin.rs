//! Recover Codex spawn origins omitted by an older store writer. A name
//! alone is never proof: require the current Relaycast agent id, this node,
//! its server-stamped invocation, and the matching local successful receipt.
//! Other harnesses need their original process/takeover evidence, so are
//! deliberately not reconstructed from an old receipt that lacks it.

use super::completions::Scope;
use super::node::NodeInfo;
use crate::relay::daemon::Core;
use crate::relay::harness::codex;
use crate::relay::sdk_gaps;
use crate::relay::store::{Registration, SessionKind, SpawnOrigin};
use serde_json::Value;
use std::time::Duration;

impl Core {
    pub(super) async fn restore_spawn_origins(&self, node: &NodeInfo) {
        let Some(workspace) = self.workspace() else {
            return;
        };
        let scope = Scope::workspace(&workspace);
        let candidates: Vec<_> = self.store.read(|store| {
            store
                .registrations
                .iter()
                .filter(|r| {
                    r.spawn.is_none()
                        && r.missing_since.is_some()
                        && r.archived_at.is_none()
                        && r.target.kind == SessionKind::Codex
                        && scope.matches_registration(r)
                })
                .cloned()
                .collect()
        });
        if candidates.is_empty() || !self.config.app_data_dir.join("spawn-completions").is_dir() {
            return;
        }
        let Ok(http) = sdk_gaps::http(&workspace.base_url, &workspace.key) else {
            return;
        };
        let Ok(Ok(roster)) =
            tokio::time::timeout(Duration::from_secs(10), sdk_gaps::list_agents(&http, "all"))
                .await
        else {
            return;
        };
        for row in candidates {
            let Some(origin) = roster.iter().find_map(|remote| {
                restorable(&row, remote, node, &scope, &self.config.app_data_dir)
            }) else {
                continue;
            };
            let spawner = self.plugins.spawner.clone();
            let target = row.target.clone();
            let alive = tokio::task::spawn_blocking(move || spawner.alive(&target, None))
                .await
                .unwrap_or(false);
            if !alive {
                continue;
            }
            let restored = self.store.update(|store| {
                if let Some(current) = store.registrations.iter_mut().find(|r| **r == row) {
                    current.spawn = Some(origin);
                    current.missing_since = None;
                    return true;
                }
                false
            });
            if restored == Ok(true) {
                self.kept(&row.name);
            }
        }
    }
}

pub(super) fn restorable(
    row: &Registration,
    remote: &Value,
    node: &NodeInfo,
    scope: &Scope,
    app_data: &std::path::Path,
) -> Option<SpawnOrigin> {
    let invocation = matching_invocation(row, remote, node)?;
    let receipt = scope.load(app_data, invocation).ok()??;
    receipt.confirms(&row.name, codex::ID).then(|| SpawnOrigin {
        node_id: node.node_id.clone(),
        node_name: node.node_name.clone(),
        invocation_id: invocation.to_owned(),
        harness: codex::ID.name().into(),
        requester: None,
        process: None,
        owner: None,
        taken_over_at: None,
        task_unconfirmed: receipt.verification(),
    })
}

fn matching_invocation<'a>(
    row: &Registration,
    remote: &'a Value,
    node: &NodeInfo,
) -> Option<&'a str> {
    if remote["id"].as_str() != Some(&row.agent_id)
        || remote["name"].as_str() != Some(&row.name)
        || remote.pointer("/metadata/fleet/node_id")?.as_str() != Some(&node.node_id)
    {
        return None;
    }
    remote.pointer("/metadata/fleet/invocation_id")?.as_str()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay::spawn::intents;
    use crate::relay::store::Target;
    use serde_json::json;

    #[test]
    fn remote_evidence_must_match_the_immutable_agent_and_this_node() {
        let node = NodeInfo {
            node_id: "node_1".into(),
            node_name: "desk".into(),
        };
        let mut row = intents::tests::intent("worker").registration(
            "agent_1",
            Target::new(SessionKind::Codex, "thread"),
            None,
            ("node_1", "desk"),
        );
        row.spawn = None;
        let remote = json!({"id":"agent_1","name":"worker",
            "metadata":{"fleet":{"node_id":"node_1","invocation_id":"inv_worker"}}});
        assert_eq!(
            matching_invocation(&row, &remote, &node),
            Some("inv_worker")
        );
        for (pointer, value) in [
            ("/id", "replacement"),
            ("/name", "someone-else"),
            ("/metadata/fleet/node_id", "another-node"),
        ] {
            let mut wrong = remote.clone();
            *wrong.pointer_mut(pointer).unwrap() = json!(value);
            assert!(matching_invocation(&row, &wrong, &node).is_none());
        }
    }
}
