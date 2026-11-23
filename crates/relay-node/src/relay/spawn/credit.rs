//! Crediting a spawned agent to the person whose computer runs it, so
//! rosters group it under them as they group the sessions this computer
//! registers (`owner_hash`; `people::decode_roster` reads `is_self` from it).
//!
//! Relaycast creates a spawned agent itself, from the node's
//! `agent.register` (or `agent.recover`) on the node socket, and stamps only
//! `metadata.fleet`: the frame carries no metadata, so the record names no
//! owner. Once the spawn is saved, the core adds the same owner metadata a
//! session registration carries (`AgentOwner::metadata`) with Relaycast's
//! merging update, under the workspace key, as presence updates are made.
//!
//! The owner is the person the node is claimed for (`Core::node_owner`), not
//! the spawn's requester: the agent runs on this computer, under this
//! computer's harness sign-ins, and Agent Relay's own roster counts it as
//! the node owner's. Relaycast vouches for no requester person (the spawn's
//! requester is an agent), and a teammate allowed to spawn here does not
//! make the agent theirs. This is a roster label only: it grants nothing
//! (`spawn::owner_of`, the delivery owner, stays as the spawn bound it).
//!
//! An owner is never transferred: a record that already names one is left
//! as it is, and an agent credited here keeps its binding
//! (`Store::agent_owners`) whoever signs in later. Nothing is written while
//! the claim is unanswered or another account's; the spawned agents are
//! looked at again on every lifecycle pass, so an agent spawned before this
//! (or before the claim settled) is credited once it can be.

use crate::relay::agents::roster_publication::rejected_keys::KeyProof;
use crate::relay::cloud_session::AgentOwner;
use crate::relay::daemon::Core;
use crate::relay::store::Registration;
use crate::relay::workspace::Secret;
use crate::relay::{client, sdk_gaps, workspace};
use serde_json::Value;

/// What crediting one agent came to.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Credit {
    /// Its record names this owner now: published, or already there.
    Credited,
    /// Left as it is for good: its record names someone else, it is gone,
    /// or there is no workspace key to write with.
    Left,
    /// Not now: no owner to name yet, or Relaycast could not be asked or
    /// refused the write. Tried again on a later pass.
    Later,
}

impl Core {
    /// Credits `registration`'s agent in the background, unless it is
    /// credited, settled for this run or being credited already.
    pub(crate) fn credit_spawned_soon(&self, registration: &Registration) {
        let Some(core) = self.arc() else { return };
        let agent_id = registration.agent_id.clone();
        if self.store.read(|s| s.agent_owners.contains_key(&agent_id)) {
            return;
        }
        {
            let ledger = self.ledger();
            let mut state = ledger.lock();
            if state.uncredited.contains(&agent_id) || !state.crediting.insert(agent_id.clone()) {
                return;
            }
        }
        let name = registration.name.clone();
        tokio::spawn(async move {
            let credit = core.credit_spawned(&name, &agent_id).await;
            let ledger = core.ledger();
            let mut state = ledger.lock();
            state.crediting.remove(&agent_id);
            if credit == Credit::Left {
                state.uncredited.insert(agent_id);
            }
        });
    }

    /// Names the node's owner on the spawned agent `name` (Relaycast id
    /// `agent_id`) when its record names nobody. Held under the name's
    /// agent lock, which release and removal take, so the name cannot be
    /// freed and given to another agent between the read and the
    /// by-name write; and under its roster lock, so it is serialized with
    /// presence and marker updates.
    pub(crate) async fn credit_spawned(&self, name: &str, agent_id: &str) -> Credit {
        let agent_lock = self.agent_locks.get(name);
        let _held = agent_lock.lock().await;
        let roster_lock = self.roster_locks.get(name);
        let _publishing = roster_lock.lock().await;
        let registration = self.store.read(|s| {
            s.registration_named(name)
                .filter(|r| r.agent_id == agent_id && r.spawn.is_some() && r.gate.is_none())
                .cloned()
        });
        let Some(registration) = registration else {
            return Credit::Left;
        };
        if self.store.read(|s| s.agent_owners.contains_key(agent_id)) {
            return Credit::Credited;
        }
        let node_id = registration
            .spawn
            .as_ref()
            .map(|spawn| spawn.node_id.clone())
            .unwrap_or_default();
        let Some(owner) = self.node_owner(&node_id) else {
            return Credit::Later;
        };
        let Some(mut key) = self
            .key_for(&registration)
            .filter(|key| !key.expose().is_empty())
        else {
            return Credit::Left;
        };
        let mut lookup = self.read_record(&registration, &key).await;
        // A saved key rejected since a rotation is replaced, as for writes.
        if let Some(Err(error)) = &lookup {
            match self.prove_rejected_key(&registration, &key, error).await {
                KeyProof::Current(current) => {
                    key = current;
                    lookup = self.read_record(&registration, &key).await;
                }
                KeyProof::Unreachable => return Credit::Left,
                KeyProof::Unknown => {}
            }
        }
        let record = match lookup {
            Some(Ok(Some(record))) if record["id"].as_str() == Some(agent_id) => record,
            // Another agent holds the name now, or none does.
            Some(Ok(_)) => return Credit::Left,
            // Paused by the workspace's rate limit, or not answered.
            None | Some(Err(_)) => return Credit::Later,
        };
        match named_owner(&record) {
            Some(hash) if hash == owner_hash(&owner) => {
                self.bind_owner(agent_id, &owner);
                return Credit::Credited;
            }
            // Never transferred.
            Some(_) => return Credit::Left,
            None => {}
        }
        let workspace = self.relaycast_scope(&registration.base_url, &key);
        if !self.relaycast_write_allowed(&workspace) {
            return Credit::Later;
        }
        // The claim may have settled for someone else while the record was
        // read: only the owner the node is claimed for now is named.
        if self.node_owner(&node_id).as_ref() != Some(&owner) {
            return Credit::Later;
        }
        // A PATCH with no status activates the agent: send the one it has.
        let status = self.roster_status(&registration, name);
        let metadata = owner.metadata();
        let base = registration.base_url.as_str();
        let (result, _) = self
            .write_with_saved_key(&registration, &key, |key| {
                let metadata = metadata.clone();
                async move {
                    client::update_agent_metadata(base, &key, name, metadata, Some(status)).await
                }
            })
            .await;
        match result {
            Ok(()) => {
                self.bind_owner(agent_id, &owner);
                Credit::Credited
            }
            Err(_) => Credit::Later,
        }
    }

    /// `registration`'s Relaycast record, read with `key`; `None` while the
    /// workspace's shared rate-limit pause stands. The outcome feeds that
    /// pause.
    async fn read_record(
        &self,
        registration: &Registration,
        key: &Secret,
    ) -> Option<relaycast::Result<Option<Value>>> {
        let workspace = self.relaycast_scope(&registration.base_url, key);
        if !self.relaycast_poll_allowed(&workspace) {
            return None;
        }
        let route = workspace::workspace_route(
            &registration.base_url,
            key,
            registration.control_url.as_deref(),
        );
        let result = match sdk_gaps::route_http(&route) {
            Ok(http) => sdk_gaps::get_agent(&http, &registration.name).await,
            Err(error) => Err(error),
        };
        self.observe_relaycast_result(&workspace, &result);
        Some(result)
    }

    /// Keeps `agent_id`'s owner, so it is never asked again or changed.
    fn bind_owner(&self, agent_id: &str, owner: &AgentOwner) {
        let _ = self.store.update(|store| {
            store
                .agent_owners
                .entry(agent_id.to_string())
                .or_insert_with(|| owner.clone());
        });
    }
}

/// The owner a Relaycast agent record names, if any.
fn named_owner(record: &Value) -> Option<&str> {
    record["metadata"]["owner_hash"]
        .as_str()
        .filter(|hash| !hash.is_empty())
}

fn owner_hash(owner: &AgentOwner) -> String {
    crate::relay::people::identity_hash(&owner.user_id)
}
