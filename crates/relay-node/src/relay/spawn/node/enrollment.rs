//! The spawn node's enrollment as kept on disk (`spawn-node.json`, 0600),
//! and, beside it until Relaycast first answers, the id and name chosen for
//! a node being enrolled (`spawn-node.pending.json`), which is not an
//! enrollment.

use super::{NodeConfig, NODE_FILE, PENDING_FILE};
use crate::relay::store::random_hex;
use crate::relay::workspace::Secret;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// The enrolled node, as kept on disk. A record without a token (none is
/// ever written) is not an enrollment: an id is never sent as this
/// computer's node without its token as proof.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct Enrollment {
    #[serde(rename = "nodeID")]
    pub(super) node_id: String,
    #[serde(rename = "nodeName")]
    pub(super) node_name: String,
    pub(super) token: Secret,
    #[serde(rename = "baseURL")]
    pub(super) base_url: String,
    /// The workspace key's digest, so a node is never reused in another
    /// workspace.
    pub(super) workspace: String,
    /// The `Idempotency-Key` of a rotation not yet known to have succeeded.
    #[serde(
        rename = "rotationKey",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub(super) rotation_key: Option<String>,
}

/// A node being enrolled for the first time: the id and name it is asked
/// for, saved in its own file before the first `POST /v1/nodes` so every
/// attempt of the series asks for the same node (a name refused is not
/// asked for again), while an enrollment of another workspace key stays
/// in `spawn-node.json` until a new one replaces it. Not this computer's
/// node until Relaycast gives its token. No `Idempotency-Key`: Relaycast
/// replays only a rotation, proved by the current token, and refuses a
/// key without one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct Pending {
    #[serde(rename = "nodeID")]
    pub(super) node_id: String,
    #[serde(rename = "nodeName")]
    pub(super) node_name: String,
    #[serde(rename = "baseURL")]
    pub(super) base_url: String,
    pub(super) workspace: String,
    /// How many alternates of the name this series has taken, so the
    /// budget (`ALTERNATES`) holds across restarts.
    #[serde(default)]
    pub(super) alternates: usize,
}

/// An id for a node not yet enrolled.
pub(super) fn fresh_id() -> String {
    format!("node_desktop_{}", random_hex(24))
}

impl Pending {
    /// A new node of `name`, under a fresh id.
    pub(super) fn new(config: &NodeConfig, name: &str) -> Pending {
        Pending {
            node_id: fresh_id(),
            node_name: name.to_string(),
            base_url: config.base_url.clone(),
            workspace: fingerprint(&config.workspace_key),
            alternates: 0,
        }
    }
}

pub(super) fn fingerprint(key: &Secret) -> String {
    let digest = Sha256::digest(key.expose().as_bytes());
    digest[..8].iter().map(|b| format!("{b:02x}")).collect()
}

pub(super) fn node_file(config: &NodeConfig) -> PathBuf {
    config.app_data_dir.join(NODE_FILE)
}

pub(super) fn pending_file(config: &NodeConfig) -> PathBuf {
    config.app_data_dir.join(PENDING_FILE)
}

/// Hex digits after an alternate name: `<name>-3f9a`.
const SUFFIX: usize = 4;

/// Whether `name` is the node name `base` or an alternate of it, which a
/// node takes when another node holds `base` (`alternate`).
pub(super) fn named_for(name: &str, base: &str) -> bool {
    name == base
        || name
            .strip_prefix(base)
            .and_then(|rest| rest.strip_prefix('-'))
            .is_some_and(|suffix| {
                suffix.len() == SUFFIX
                    && suffix
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
}

/// A name for this computer's node beside the node holding `base`:
/// `<base>-<4 hex>`, read in Cloud's spawn targets as the same machine.
pub(super) fn alternate(base: &str) -> String {
    format!("{base}-{}", random_hex(SUFFIX))
}

fn read_in(app_data_dir: &Path, base_url: &str, base: &str) -> Option<Enrollment> {
    let enrollment: Enrollment =
        serde_json::from_slice(&std::fs::read(app_data_dir.join(NODE_FILE)).ok()?).ok()?;
    (enrollment.base_url == base_url && named_for(&enrollment.node_name, base))
        .then_some(enrollment)
}

/// The node being enrolled for this workspace, origin and name (or an
/// alternate of it), when a first enrollment is under way.
pub(super) fn pending(config: &NodeConfig) -> Option<Pending> {
    let pending: Pending =
        serde_json::from_slice(&std::fs::read(pending_file(config)).ok()?).ok()?;
    (pending.base_url == config.base_url
        && pending.workspace == fingerprint(&config.workspace_key)
        && named_for(&pending.node_name, &config.node_name))
    .then_some(pending)
}

/// The saved node of this origin and name (or an alternate of it),
/// enrolled with any workspace key.
pub(super) fn read(config: &NodeConfig) -> Option<Enrollment> {
    read_in(&config.app_data_dir, &config.base_url, &config.node_name)
}

/// The name this computer's node of `base` is enrolled under at `base_url`:
/// `base`, or the alternate it took.
pub(crate) fn enrolled_name(app_data_dir: &Path, base_url: &str, base: &str) -> String {
    read_in(app_data_dir, base_url, base)
        .map(|enrollment| enrollment.node_name)
        .unwrap_or_else(|| base.to_string())
}

/// The token of the node saved in `app_data_dir`, when it was enrolled at
/// `base_url` with `workspace_key`: what a node-scoped workspace asks
/// Relaycast with for the calls Control does not broker but a node token
/// may make. `None` when there is no such node.
pub(crate) fn node_token(
    app_data_dir: &Path,
    base_url: &str,
    workspace_key: &Secret,
) -> Option<Secret> {
    let enrollment: Enrollment =
        serde_json::from_slice(&std::fs::read(app_data_dir.join(NODE_FILE)).ok()?).ok()?;
    (enrollment.base_url == base_url
        && enrollment.workspace == fingerprint(workspace_key)
        && !enrollment.token.expose().is_empty())
    .then_some(enrollment.token)
}

/// The saved node, when it was enrolled with this workspace key.
pub(super) fn load(config: &NodeConfig) -> Option<Enrollment> {
    read(config).filter(|enrollment| enrollment.workspace == fingerprint(&config.workspace_key))
}

pub(super) fn save(path: &Path, enrollment: &Enrollment) -> std::io::Result<()> {
    write(path, enrollment)
}

pub(super) fn save_pending(path: &Path, pending: &Pending) -> std::io::Result<()> {
    write(path, pending)
}

/// Removes a record; none is fine.
pub(super) fn forget(path: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        done => done,
    }
}

fn write(path: &Path, record: &impl Serialize) -> std::io::Result<()> {
    use std::io::Write;
    let temporary = path.with_extension("json.tmp");
    let mut file = crate::platform::fs::private(
        std::fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true),
    )
    .open(&temporary)?;
    file.write_all(&serde_json::to_vec_pretty(record).map_err(std::io::Error::other)?)?;
    file.sync_all()?;
    std::fs::rename(temporary, path)
}
