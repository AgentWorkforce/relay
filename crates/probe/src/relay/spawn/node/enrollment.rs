//! The spawn node's enrollment as kept on disk (`spawn-node.json`, 0600):
//! the enrolled node with its token, or, before Relaycast first answers, the
//! id and name chosen for it (`Pending`), which is not an enrollment.

use super::{NodeConfig, NODE_FILE};
use crate::relay::store::random_hex;
use crate::relay::workspace::Secret;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// The enrolled node.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Enrollment {
    pub(super) node_id: String,
    pub(super) node_name: String,
    pub(super) token: Secret,
    pub(super) base_url: String,
    /// The workspace key's digest, so a node is never reused in another
    /// workspace.
    pub(super) workspace: String,
    /// The `Idempotency-Key` of a rotation not yet known to have succeeded.
    pub(super) rotation_key: Option<String>,
}

/// A node being enrolled for the first time: the id and name it is asked
/// for, saved before the first `POST /v1/nodes` so every attempt of the
/// series asks for the same node (a name refused is not asked for again).
/// Not this computer's node until Relaycast gives its token. No
/// `Idempotency-Key`: Relaycast replays only a rotation, proved by the
/// current token, and refuses a key without one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Pending {
    pub(super) node_id: String,
    pub(super) node_name: String,
    pub(super) base_url: String,
    pub(super) workspace: String,
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
        }
    }
}

/// What `spawn-node.json` holds. The token is absent while the node is
/// `Pending`; a record without one is never read as an enrollment, so an
/// id is never sent as this computer's node without its token as proof.
#[derive(Serialize, Deserialize)]
struct Record {
    #[serde(rename = "nodeID")]
    node_id: String,
    #[serde(rename = "nodeName")]
    node_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    token: Option<Secret>,
    #[serde(rename = "baseURL")]
    base_url: String,
    workspace: String,
    #[serde(
        rename = "rotationKey",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    rotation_key: Option<String>,
}

impl From<&Enrollment> for Record {
    fn from(enrollment: &Enrollment) -> Record {
        Record {
            node_id: enrollment.node_id.clone(),
            node_name: enrollment.node_name.clone(),
            token: Some(enrollment.token.clone()),
            base_url: enrollment.base_url.clone(),
            workspace: enrollment.workspace.clone(),
            rotation_key: enrollment.rotation_key.clone(),
        }
    }
}

impl From<&Pending> for Record {
    fn from(pending: &Pending) -> Record {
        Record {
            node_id: pending.node_id.clone(),
            node_name: pending.node_name.clone(),
            token: None,
            base_url: pending.base_url.clone(),
            workspace: pending.workspace.clone(),
            rotation_key: None,
        }
    }
}

impl Record {
    fn enrollment(self) -> Option<Enrollment> {
        Some(Enrollment {
            token: self.token?,
            node_id: self.node_id,
            node_name: self.node_name,
            base_url: self.base_url,
            workspace: self.workspace,
            rotation_key: self.rotation_key,
        })
    }

    fn pending(self) -> Option<Pending> {
        if self.token.is_some() {
            return None;
        }
        Some(Pending {
            node_id: self.node_id,
            node_name: self.node_name,
            base_url: self.base_url,
            workspace: self.workspace,
        })
    }
}

pub(super) fn fingerprint(key: &Secret) -> String {
    let digest = Sha256::digest(key.expose().as_bytes());
    digest[..8].iter().map(|b| format!("{b:02x}")).collect()
}

pub(super) fn node_file(config: &NodeConfig) -> PathBuf {
    config.app_data_dir.join(NODE_FILE)
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

fn record(app_data_dir: &Path) -> Option<Record> {
    serde_json::from_slice(&std::fs::read(app_data_dir.join(NODE_FILE)).ok()?).ok()
}

fn read_in(app_data_dir: &Path, base_url: &str, base: &str) -> Option<Enrollment> {
    let enrollment = record(app_data_dir)?.enrollment()?;
    (enrollment.base_url == base_url && named_for(&enrollment.node_name, base))
        .then_some(enrollment)
}

/// The node being enrolled for this workspace, origin and name (or an
/// alternate of it), when a first enrollment is under way.
pub(super) fn pending(config: &NodeConfig) -> Option<Pending> {
    let pending = record(&config.app_data_dir)?.pending()?;
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

/// The saved node, when it was enrolled with this workspace key.
pub(super) fn load(config: &NodeConfig) -> Option<Enrollment> {
    read(config).filter(|enrollment| enrollment.workspace == fingerprint(&config.workspace_key))
}

pub(super) fn save(path: &Path, enrollment: &Enrollment) -> std::io::Result<()> {
    write(path, &Record::from(enrollment))
}

pub(super) fn save_pending(path: &Path, pending: &Pending) -> std::io::Result<()> {
    write(path, &Record::from(pending))
}

/// Forgets the node: the next start enrolls a new one.
pub(super) fn forget(path: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        done => done,
    }
}

fn write(path: &Path, record: &Record) -> std::io::Result<()> {
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
