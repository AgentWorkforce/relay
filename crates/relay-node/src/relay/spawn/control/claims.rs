//! Credential-free release claims preserve exact identity after the local registration is gone.
use super::*;
use sha2::{Digest, Sha256};
use std::path::Path;
use std::sync::Mutex;

mod storage;

static WRITING: Mutex<()> = Mutex::new(());

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Ownership {
    Unrestricted,
    Verified,
    ClaimOnly,
}

pub(super) fn release(
    folder: &Path,
    workspace: &Workspace,
    caller_id: &str,
    params: &SpawnReleaseParams,
    exact: bool,
    ownership: Ownership,
) -> Result<(), RpcError> {
    let _writing = WRITING.lock().unwrap_or_else(|e| e.into_inner());
    let scope = json!([
        workspace.base_url,
        workspace.key.expose(),
        caller_id,
        params.idempotency_key
    ]);
    let digest = format!("{:x}", Sha256::digest(scope.to_string().as_bytes()));
    let folder = folder.join("spawn-control-releases");
    let name = format!("{digest}.json");
    let verified_name = format!("{digest}.verified.json");
    let identity = json!([
        params.node_id,
        params.node_name,
        params.name,
        params.expected_agent_id
    ]);
    match storage::read(&folder, &name) {
        Ok(Some(bytes)) => {
            let previous: Value = serde_json::from_slice(&bytes).map_err(|_| malformed())?;
            let (previous_identity, previous_owner_verified) = match previous.as_object() {
                Some(previous) => (
                    previous.get("identity").cloned().unwrap_or(Value::Null),
                    previous
                        .get("owner_verified")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                ),
                None => (previous, false),
            };
            if previous_identity != identity {
                return Err(refused());
            }
            if ownership == Ownership::ClaimOnly
                && !previous_owner_verified
                && !verified(&folder, &verified_name, &identity)?
            {
                return Err(not_owner());
            }
            if ownership == Ownership::Verified && !previous_owner_verified {
                save_verification(&folder, &verified_name, &identity)?;
            }
            return Ok(());
        }
        Ok(None) => {}
        Err(_) => return Err(refused()),
    }
    if !exact {
        return Err(refused());
    }
    let claim = json!({
        "identity": identity,
        "owner_verified": ownership == Ownership::Verified,
    });
    let store_failed = || {
        RpcError::new(
            ErrorKind::StoreFailed,
            "The native release identity could not be saved.",
        )
    };
    let bytes = serde_json::to_vec(&claim).map_err(|_| store_failed())?;
    storage::persist(&folder, &name, &bytes).map_err(|_| store_failed())
}

fn verified(folder: &Path, name: &str, identity: &Value) -> Result<bool, RpcError> {
    match storage::read(folder, name) {
        Ok(Some(bytes)) => serde_json::from_slice::<Value>(&bytes)
            .map(|saved| saved == *identity)
            .map_err(|_| malformed()),
        Ok(None) => Ok(false),
        Err(_) => Err(refused()),
    }
}

fn save_verification(folder: &Path, name: &str, identity: &Value) -> Result<(), RpcError> {
    if verified(folder, name, identity)? {
        return Ok(());
    }
    let store_failed = || {
        RpcError::new(
            ErrorKind::StoreFailed,
            "The native release ownership proof could not be saved.",
        )
    };
    let bytes = serde_json::to_vec(identity).map_err(|_| store_failed())?;
    match storage::persist(folder, name, &bytes) {
        Ok(()) => Ok(()),
        Err(_) if verified(folder, name, identity).unwrap_or(false) => Ok(()),
        Err(_) => Err(store_failed()),
    }
}
