//! Credential-free release claims preserve exact identity after the local registration is gone.
use super::*;
use crate::platform::fs::{owned_by_current_user, private_dir, private_to_owner, sync_dir};
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;

static WRITING: Mutex<()> = Mutex::new(());

pub(super) fn release(
    folder: &Path,
    workspace: &Workspace,
    caller_id: &str,
    params: &SpawnReleaseParams,
    exact: bool,
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
    private(&folder, true)?;
    let path = folder.join(format!("{digest}.json"));
    private(&path, false)?;
    let identity = json!([
        params.node_id,
        params.node_name,
        params.name,
        params.expected_agent_id
    ]);
    match std::fs::read(&path) {
        Ok(bytes) => {
            let previous: Value = serde_json::from_slice(&bytes).map_err(|_| malformed())?;
            return if previous == identity {
                Ok(())
            } else {
                Err(refused())
            };
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(refused()),
    }
    if !exact {
        return Err(refused());
    }
    let persist = || -> std::io::Result<()> {
        std::fs::create_dir_all(folder.parent().unwrap_or(Path::new("/nonexistent")))?;
        match private_dir(&mut std::fs::DirBuilder::new()).create(&folder) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e),
        }
        private(&folder, true).map_err(|_| {
            std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "private release claim directory required",
            )
        })?;
        let mut temporary = tempfile::NamedTempFile::new_in(&folder)?;
        temporary.write_all(&serde_json::to_vec(&identity)?)?;
        temporary.as_file().sync_all()?;
        temporary.persist_noclobber(path).map_err(|e| e.error)?;
        sync_dir(&folder)
    };
    persist().map_err(|_| {
        RpcError::new(
            ErrorKind::StoreFailed,
            "The native release identity could not be saved.",
        )
    })
}

fn private(path: &Path, directory: bool) -> Result<(), RpcError> {
    match std::fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Ok(metadata)
            if owned_by_current_user(&metadata)
                && private_to_owner(&metadata, 0o077)
                && (if directory {
                    metadata.is_dir()
                } else {
                    metadata.is_file()
                }) =>
        {
            Ok(())
        }
        _ => Err(refused()),
    }
}
