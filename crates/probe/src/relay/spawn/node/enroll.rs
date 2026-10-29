//! Enrolling the spawn node (`POST /v1/nodes`): a new node, a rotation
//! under the node's own id, the saved node kept under a new workspace key,
//! and an alternate name when another node holds this one.

use super::enrollment::{alternate, fingerprint, load, node_file, read, save, Enrollment};
use super::NodeConfig;
use crate::relay::sdk_gaps;
use crate::relay::spawn::wire;
use crate::relay::store::random_hex;
use crate::relay::workspace::Secret;
use relaycast::RequestOptions;
use serde_json::Value;

/// How many other names a node tries when another node holds its own.
pub(super) const ALTERNATES: usize = 3;

/// Why an enrollment failed.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Refused {
    /// Another node holds the name (`node_name_conflict`).
    NameTaken,
    /// Anything else; trying again may succeed.
    Failed(String),
    /// Every name tried was taken: trying again would loop.
    NoName(String),
}

impl Refused {
    pub(super) fn reason(self) -> String {
        match self {
            Refused::NameTaken => {
                "Agent Relay did not enroll this computer: another node holds its name.".into()
            }
            Refused::Failed(reason) | Refused::NoName(reason) => reason,
        }
    }
}

/// `POST /v1/nodes` as `name`. With `current`, a rotation proved by the
/// current token.
pub(super) async fn enroll(
    config: &NodeConfig,
    current: Option<&Enrollment>,
    name: &str,
) -> Result<Enrollment, Refused> {
    let http = sdk_gaps::http(&config.base_url, &config.workspace_key)
        .map_err(|error| Refused::Failed(error.to_string()))?;
    let node_id = current
        .map(|current| current.node_id.clone())
        .unwrap_or_else(|| format!("node_desktop_{}", random_hex(24)));
    let body = wire::enroll_body(&node_id, name, &config.version);
    let options = current.map(|current| RequestOptions {
        headers: Some(vec![(
            "X-Relaycast-Node-Token".into(),
            current.token.expose().to_string(),
        )]),
        idempotency_key: current.rotation_key.clone(),
    });
    let data: Value =
        http.post("/v1/nodes", Some(body), options)
            .await
            .map_err(|error| match error.code() {
                Some("node_name_conflict") => Refused::NameTaken,
                _ => Refused::Failed(format!("Agent Relay did not enroll this computer: {error}")),
            })?;
    let token = data["token"]
        .as_str()
        .filter(|token| !token.is_empty())
        .ok_or_else(|| {
            Refused::Failed("Agent Relay enrolled this computer without a node token.".into())
        })?;
    let enrollment = Enrollment {
        node_id: data["id"].as_str().unwrap_or(&node_id).to_string(),
        node_name: name.to_string(),
        token: Secret::new(token.to_string()),
        base_url: config.base_url.clone(),
        workspace: fingerprint(&config.workspace_key),
        rotation_key: None,
    };
    save(&node_file(config), &enrollment).map_err(|error| {
        Refused::Failed(format!(
            "Could not save this computer's spawn node: {error}"
        ))
    })?;
    Ok(enrollment)
}

/// Enrolls a new node (`current` none) or rotates `current`, under its
/// name, or under an alternate of the configured name when another node
/// holds it. A new node then takes `<name>-<4 hex>`: it can be another
/// computer of the same name in this workspace, or this computer's own node
/// from an install whose `spawn-node.json` is gone, whose token nothing here
/// holds to prove it. A rotation's node is renamed under its own id, so its
/// agents stay bound to it: the name is held by another node only when
/// Relaycast no longer has this one under it. The name is saved with the
/// node, so every restart reuses it. When every name tried is taken, the
/// node says so rather than trying again.
pub(super) async fn enroll_named(
    config: &NodeConfig,
    current: Option<&Enrollment>,
) -> Result<Enrollment, Refused> {
    let mut pending = current.cloned();
    let mut name = pending
        .as_ref()
        .map_or_else(|| config.node_name.clone(), |c| c.node_name.clone());
    for _ in 0..=ALTERNATES {
        match enroll(config, pending.as_ref(), &name).await {
            Err(Refused::NameTaken) => {}
            done => return done,
        }
        name = alternate(&config.node_name);
        if let Some(pending) = pending.as_mut() {
            // Another body: a new key, so Relaycast does not take it for a
            // replay of the refused one. Saved first with the name, as a
            // rotation's is, so one whose answer is lost is replayed as sent.
            pending.node_name = name.clone();
            pending.rotation_key = Some(random_hex(48));
            save(&node_file(config), pending).map_err(|error| {
                Refused::Failed(format!(
                    "Could not save this computer's spawn node: {error}"
                ))
            })?;
        }
    }
    Err(Refused::NoName(format!(
        "Agent Relay did not enroll this computer: other nodes in this workspace already use \"{}\" and every other name tried for it. Turn Accept spawns from Agent Relay off and on to try again.",
        config.node_name
    )))
}

/// This workspace's saved node, under its name or the alternate it took.
/// One enrolled with another workspace key is still this workspace's when
/// Relaycast lists its id under its name here:
/// a new key for the same workspace (signing in again) keeps the node,
/// whose name no new node could take while it stays enrolled. `None` when
/// there is no such node, so a new one is enrolled.
pub(super) async fn saved(config: &NodeConfig) -> Result<Option<Enrollment>, String> {
    if let Some(enrollment) = load(config) {
        return Ok(Some(enrollment));
    }
    let Some(kept) = read(config) else {
        return Ok(None);
    };
    let http = sdk_gaps::http(&config.base_url, &config.workspace_key)
        .map_err(|error| error.to_string())?;
    let holder = sdk_gaps::node_id_named(&http, &kept.node_name)
        .await
        .map_err(|error| {
            format!("Agent Relay did not say which node is this computer's: {error}")
        })?;
    if holder.as_deref() != Some(kept.node_id.as_str()) {
        return Ok(None);
    }
    let adopted = Enrollment {
        workspace: fingerprint(&config.workspace_key),
        ..kept
    };
    save(&node_file(config), &adopted)
        .map_err(|error| format!("Could not save this computer's spawn node: {error}"))?;
    Ok(Some(adopted))
}

/// A token Relaycast stopped accepting: rotated with the current one as
/// proof, under the node's own id. The node is never given up here, as its
/// spawned agents are bound to it: a node Relaycast no longer has is
/// enrolled again under the same id (renamed when another node took its
/// name meanwhile, `enroll_named`), and a refusal (a proof Relaycast no
/// longer takes) or no answer leaves the enrollment to try again after the
/// backoff. The rotation's key is kept until one succeeds, so a rotation
/// whose answer was lost is replayed rather than refused.
pub(super) async fn rotate(
    config: &NodeConfig,
    enrollment: &Enrollment,
) -> Result<Enrollment, Refused> {
    let mut pending = enrollment.clone();
    if pending.rotation_key.is_none() {
        pending.rotation_key = Some(random_hex(48));
        save(&node_file(config), &pending).map_err(|error| {
            Refused::Failed(format!(
                "Could not save this computer's spawn node: {error}"
            ))
        })?;
    }
    enroll_named(config, Some(&pending)).await
}
