//! Enrolling the spawn node (`POST /v1/nodes`): a new node, a rotation
//! under the node's own id, the saved node kept under a new workspace key,
//! and an alternate name when another node holds this one.

use super::enrollment::{
    alternate, fingerprint, forget, fresh_id, load, node_file, pending, pending_file, read, save,
    save_pending, Enrollment, Pending,
};
use super::NodeConfig;
use crate::relay::contract::plan::PlanLimitExceeded;
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
    /// Relaycast has a node under the id asked for a new one: another's
    /// (`node_id_conflict`), or one an earlier attempt enrolled whose
    /// answer with its token was lost (`node_token_proof_required` without
    /// proof). Either way its token is nothing here holds.
    IdTaken,
    /// Relaycast no longer takes the node's token as proof of it
    /// (`node_token_proof_required` with the token sent): a rotation it
    /// refuses the same way every time. A 401 is never that: it is the
    /// workspace key refused (`unauthorized`, `workspace_expired`), which
    /// the node waits out with its enrollment kept.
    ProofRefused(String),
    /// Relaycast refused the rotation's `Idempotency-Key`
    /// (`node_rotation_idempotency_*`): a new key is tried once.
    KeyRefused(String),
    /// Anything else; trying again may succeed.
    Failed(String),
    /// Every name tried was taken: trying again would loop.
    NoName(String),
    /// The plan's device cap is reached.
    PlanLimit(PlanLimitExceeded),
}

impl Refused {
    pub(super) fn reason(self) -> String {
        match self {
            Refused::NameTaken => {
                "Agent Relay did not enroll this computer: another node holds its name.".into()
            }
            Refused::IdTaken => {
                "Agent Relay did not enroll this computer: another node holds its id.".into()
            }
            Refused::ProofRefused(reason)
            | Refused::KeyRefused(reason)
            | Refused::Failed(reason)
            | Refused::NoName(reason) => reason,
            Refused::PlanLimit(limit) => limit.message(),
        }
    }
}

fn save_failed(error: std::io::Error) -> Refused {
    Refused::Failed(format!(
        "Could not save this computer's spawn node: {error}"
    ))
}

/// `POST /v1/nodes` for `node_id` as `name`; with `rotation`, a rotation
/// proved by the current token and replayed by Relaycast under its key.
/// A new node sends neither: Relaycast refuses an `Idempotency-Key`
/// without the token (`node_rotation_idempotency_requires_current_token`),
/// as it replays only rotations.
pub(super) async fn enroll(
    config: &NodeConfig,
    node_id: &str,
    name: &str,
    rotation: Option<(&Secret, &str)>,
) -> Result<Enrollment, Refused> {
    let http = sdk_gaps::http(&config.base_url, &config.workspace_key)
        .map_err(|error| Refused::Failed(error.to_string()))?;
    let body = wire::enroll_body(node_id, name, &config.version);
    let proof = rotation.is_some();
    let options = rotation.map(|(token, key)| RequestOptions {
        headers: Some(vec![(
            "X-Relaycast-Node-Token".into(),
            token.expose().to_string(),
        )]),
        idempotency_key: Some(key.to_string()),
    });
    let data: Value = http
        .post("/v1/nodes", Some(body), options)
        .await
        .map_err(|error| {
            if let Some(limit) = PlanLimitExceeded::from_relaycast(&error) {
                return Refused::PlanLimit(limit);
            }
            let failed =
                || Refused::Failed(format!("Agent Relay did not enroll this computer: {error}"));
            match error.code() {
                Some("node_name_conflict") => Refused::NameTaken,
                // With proof, `node_id_conflict` cannot happen: the id is
                // this node's own, proven. It would fall to `Failed` and
                // the same id be tried again.
                Some("node_id_conflict" | "node_token_proof_required") if !proof => {
                    Refused::IdTaken
                }
                Some("node_token_proof_required") => Refused::ProofRefused(format!(
                    "Agent Relay no longer accepts this computer's node token: {error}"
                )),
                Some(code) if proof && code.starts_with("node_rotation_idempotency") => {
                    Refused::KeyRefused(failed().reason())
                }
                _ => failed(),
            }
        })?;
    let token = data["token"]
        .as_str()
        .filter(|token| !token.is_empty())
        .ok_or_else(|| {
            Refused::Failed("Agent Relay enrolled this computer without a node token.".into())
        })?;
    let enrollment = Enrollment {
        node_id: data["id"].as_str().unwrap_or(node_id).to_string(),
        node_name: name.to_string(),
        token: Secret::new(token.to_string()),
        base_url: config.base_url.clone(),
        workspace: fingerprint(&config.workspace_key),
        rotation_key: None,
    };
    save(&node_file(config), &enrollment).map_err(save_failed)?;
    Ok(enrollment)
}

fn no_name(config: &NodeConfig) -> Refused {
    Refused::NoName(format!(
        "Agent Relay did not enroll this computer: other nodes in this workspace already use \"{}\" and every other name tried for it. Turn Accept spawns from Agent Relay off and on to try again.",
        config.node_name
    ))
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
    match current {
        Some(current) => rotate_named(config, current).await,
        None => enroll_new(config).await,
    }
}

/// A new node, asked for as the `Pending` one saved before its first
/// `POST /v1/nodes`: the same id on every attempt of the series, and the
/// name saved is the last one not refused, so a name another node holds is
/// never asked for again after a failure on its alternate; an alternate is
/// taken only after `NameTaken`, `ALTERNATES` of them in a series, counted
/// in the record so a restart does not start the count over. An id
/// Relaycast has a node under
/// (`IdTaken`) is replaced by a fresh one under the same name: Relaycast
/// replays no first enrollment, so one it completed whose answer was lost
/// is met that way on the next attempt, and the node left behind, holding
/// the name, is offline by construction. With Relaycast's replacement of
/// an offline holder (relaycast-cloud, behind a flag) the same name then
/// succeeds; without it the next answer is `NameTaken` and the alternate
/// follows, one request later and no alternate burned needlessly. Either
/// way the node left behind stays offline and harmless.
async fn enroll_new(config: &NodeConfig) -> Result<Enrollment, Refused> {
    let path = pending_file(config);
    let mut pending = match pending(config) {
        Some(pending) => pending,
        None => {
            let pending = Pending::new(config, &config.node_name);
            save_pending(&path, &pending).map_err(save_failed)?;
            pending
        }
    };
    let mut ids = 0;
    loop {
        match enroll(config, &pending.node_id, &pending.node_name, None).await {
            Err(Refused::NameTaken) if pending.alternates < ALTERNATES => {
                pending.alternates += 1;
                pending.node_name = alternate(&config.node_name);
            }
            Err(Refused::NameTaken) => {
                // Nothing enrolled to keep: the next start asks for a new
                // node.
                let _ = forget(&path);
                return Err(no_name(config));
            }
            Err(Refused::IdTaken) if ids < ALTERNATES => {
                ids += 1;
                pending.node_id = fresh_id();
            }
            Err(refused @ Refused::IdTaken) => return Err(Refused::Failed(refused.reason())),
            Ok(enrolled) => {
                let _ = forget(&path);
                return Ok(enrolled);
            }
            done => return done,
        }
        save_pending(&path, &pending).map_err(save_failed)?;
    }
}

/// A rotation of `current` under its own id (`enroll_named`). Its key is
/// kept until a rotation succeeds, so one whose answer was lost is replayed
/// rather than refused; one Relaycast refuses as a key is replaced once.
async fn rotate_named(config: &NodeConfig, current: &Enrollment) -> Result<Enrollment, Refused> {
    let path = node_file(config);
    let mut pending = current.clone();
    let mut key = match pending.rotation_key.clone() {
        Some(key) => key,
        None => {
            let key = random_hex(48);
            pending.rotation_key = Some(key.clone());
            save(&path, &pending).map_err(save_failed)?;
            key
        }
    };
    let mut names = 0;
    let mut rekeyed = false;
    loop {
        match enroll(
            config,
            &pending.node_id,
            &pending.node_name,
            Some((&pending.token, &key)),
        )
        .await
        {
            Err(Refused::NameTaken) if names < ALTERNATES => {
                // Another body: a new key, so Relaycast does not take it
                // for a replay of the refused one. Saved first with the
                // name, so one whose answer is lost is replayed as sent.
                names += 1;
                pending.node_name = alternate(&config.node_name);
            }
            Err(Refused::NameTaken) => return Err(no_name(config)),
            Err(Refused::KeyRefused(_)) if !rekeyed => rekeyed = true,
            Err(Refused::KeyRefused(reason)) => return Err(Refused::Failed(reason)),
            done => return done,
        }
        key = random_hex(48);
        pending.rotation_key = Some(key.clone());
        save(&path, &pending).map_err(save_failed)?;
    }
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
/// proof, under the node's own id. The node is not given up here, as its
/// spawned agents are bound to it: a node Relaycast no longer has is
/// enrolled again under the same id (renamed when another node took its
/// name meanwhile, `enroll_named`), and no answer leaves the enrollment to
/// try again after the backoff. A proof Relaycast no longer takes
/// (`Refused::ProofRefused`) is for the caller to count: it is refused the
/// same way every time.
pub(super) async fn rotate(
    config: &NodeConfig,
    enrollment: &Enrollment,
) -> Result<Enrollment, Refused> {
    enroll_named(config, Some(enrollment)).await
}
