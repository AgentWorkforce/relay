//! The spawn node's enrollment as kept on disk (`spawn-node.json`, 0600).

use super::{NodeConfig, NODE_FILE};
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

pub(super) fn load(config: &NodeConfig) -> Option<Enrollment> {
    let enrollment: Enrollment =
        serde_json::from_slice(&std::fs::read(node_file(config)).ok()?).ok()?;
    (enrollment.base_url == config.base_url
        && enrollment.node_name == config.node_name
        && enrollment.workspace == fingerprint(&config.workspace_key))
    .then_some(enrollment)
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
