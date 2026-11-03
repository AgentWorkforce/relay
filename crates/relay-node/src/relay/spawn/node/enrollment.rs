//! The spawn node's enrollment as kept on disk (`spawn-node.json`, 0600).

use super::{NodeConfig, NODE_FILE};
use crate::relay::store::random_hex;
use crate::relay::workspace::Secret;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// The enrolled node, as kept on disk.
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

fn read_in(app_data_dir: &Path, base_url: &str, base: &str) -> Option<Enrollment> {
    let enrollment: Enrollment =
        serde_json::from_slice(&std::fs::read(app_data_dir.join(NODE_FILE)).ok()?).ok()?;
    (enrollment.base_url == base_url && named_for(&enrollment.node_name, base))
        .then_some(enrollment)
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
    use std::io::Write;
    let temporary = path.with_extension("json.tmp");
    let mut file = crate::platform::fs::private(
        std::fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true),
    )
    .open(&temporary)?;
    file.write_all(&serde_json::to_vec_pretty(enrollment).map_err(std::io::Error::other)?)?;
    file.sync_all()?;
    std::fs::rename(temporary, path)
}
