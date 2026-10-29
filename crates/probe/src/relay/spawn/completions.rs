//! Terminal spawn receipts outlive their registration and the core. A late
//! replay after release must return that immutable receipt, never launch again.
//! Only public identity and output are stored; credentials and tasks are hashed
//! for filenames or omitted. Entries are loaded on demand, not kept in memory.

use super::actions::CompletedSpawn;
use super::invoke::SpawnError;
use super::wire::{self, HarnessId, SpawnRequest};
use crate::platform::fs::{private_dir, sync_dir};
use crate::relay::daemon::Core;
use crate::relay::store::Registration;
use crate::relay::workspace::{Secret, Workspace};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// Makes an open file readable and writable by this user only (`0600`).
/// Windows keeps the access list the private app data folder gives it.
fn make_private(file: &std::fs::File) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))
    }
    #[cfg(windows)]
    {
        let _ = file;
        Ok(())
    }
}

const DIRECTORY: &str = "spawn-completions";

/// Credentials identify workspaces even where discovery has no workspace id.
/// Only the irreversible digest reaches the filesystem, never the credential.
pub(super) struct Scope(String);

impl Scope {
    pub(super) fn workspace(workspace: &Workspace) -> Self {
        Self::new(&workspace.base_url, &workspace.key)
    }

    fn new(origin: &str, key: &Secret) -> Self {
        Self(digest(&[origin.trim_end_matches('/'), key.expose()]))
    }

    /// Copy a receipt only after recovery has established stable workspace identity.
    pub(super) fn adopt(&self, app_data: &Path, intent: &super::intents::Intent) -> io::Result<()> {
        let previous = Self::new(&intent.base_url, &intent.workspace_key);
        if previous.0 != self.0 {
            if let Some(mut receipt) = previous.load(app_data, &intent.invocation_id)? {
                receipt.scope = self.0.clone();
                self.publish(app_data, receipt)?;
            }
        }
        Ok(())
    }

    pub(super) fn matches_registration(&self, registration: &Registration) -> bool {
        registration
            .workspace_key
            .as_ref()
            .is_some_and(|key| Self::new(&registration.base_url, key).0 == self.0)
    }

    pub(super) fn lock_key(&self, invocation: &str) -> String {
        format!("invocation/{}/{}", self.0, digest(&[invocation]))
    }

    fn path(&self, app_data: &Path, invocation: &str) -> PathBuf {
        app_data
            .join(DIRECTORY)
            .join(format!("{}-{}.json", self.0, digest(&[invocation])))
    }

    pub(super) fn load(&self, app_data: &Path, invocation: &str) -> io::Result<Option<Completion>> {
        let bytes = match std::fs::read(self.path(app_data, invocation)) {
            Ok(bytes) => bytes,
            // Windows reports a path through a file as not found
            // (ERROR_PATH_NOT_FOUND) where Unix says ENOTDIR, so a receipt
            // folder that is a file must not read as "no receipt" there.
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return match std::fs::metadata(app_data.join(DIRECTORY)) {
                    Ok(folder) if !folder.is_dir() => {
                        Err(io::Error::other("the spawn receipt folder is not a folder"))
                    }
                    _ => Ok(None),
                };
            }
            Err(error) => return Err(error),
        };
        let record: Completion = serde_json::from_slice(&bytes)?;
        if record.version != 1
            || record.scope != self.0
            || record.invocation_id != invocation
            || (record.error.is_none()
                && (record.output["name"] != record.name || record.output["spawned"] != true))
            || (record.error.is_some() && !record.output.is_null())
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid spawn receipt",
            ));
        }
        Ok(Some(record))
    }

    pub(super) fn save(
        &self,
        app_data: &Path,
        request: &SpawnRequest,
        output: Value,
    ) -> io::Result<Completion> {
        let record = Completion {
            version: 1,
            scope: self.0.clone(),
            invocation_id: request.invocation_id.clone(),
            name: request.name.clone(),
            harness: request.harness,
            output,
            error: None,
        };
        self.publish(app_data, record)
    }

    pub(super) fn save_failure(
        &self,
        app_data: &Path,
        request: &SpawnRequest,
        error: SpawnError,
    ) -> io::Result<Completion> {
        self.publish(
            app_data,
            Completion {
                version: 1,
                scope: self.0.clone(),
                invocation_id: request.invocation_id.clone(),
                name: request.name.clone(),
                harness: request.harness,
                output: Value::Null,
                error: Some(error.redacted()),
            },
        )
    }

    fn publish(&self, app_data: &Path, record: Completion) -> io::Result<Completion> {
        if let Some(existing) = self.load(app_data, &record.invocation_id)? {
            return Ok(existing);
        }
        let path = self.path(app_data, &record.invocation_id);
        let directory = app_data.join(DIRECTORY);
        private_dir(std::fs::DirBuilder::new().recursive(true)).create(&directory)?;
        let mut file = tempfile::NamedTempFile::new_in(&directory)?;
        make_private(file.as_file())?;
        file.write_all(&serde_json::to_vec(&record)?)?;
        file.as_file().sync_all()?;
        match file.persist_noclobber(path) {
            Ok(_) => {
                sync_dir(&directory)?;
                Ok(record)
            }
            Err(error) if error.error.kind() == io::ErrorKind::AlreadyExists => {
                self.load(app_data, &record.invocation_id)?.ok_or_else(|| {
                    io::Error::new(io::ErrorKind::NotFound, "spawn receipt disappeared")
                })
            }
            Err(error) => Err(error.error),
        }
    }
}

/// Successful output is stored verbatim, including unconfirmed-task warnings.
/// No raw task, directory, workspace key or agent token belongs in this record.
#[derive(Serialize, Deserialize)]
pub(super) struct Completion {
    version: u8,
    scope: String,
    invocation_id: String,
    name: String,
    harness: HarnessId,
    output: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<SpawnError>,
}

impl Completion {
    pub(super) fn failed(&self) -> bool {
        self.error.is_some()
    }

    /// Whether this spawn of `name` failed here.
    pub(super) fn failed_as(&self, name: &str) -> bool {
        self.failed() && self.name == name
    }

    pub(super) fn verification(&self) -> Option<String> {
        self.output
            .pointer("/warning/verification")
            .and_then(Value::as_str)
            .map(str::to_owned)
    }

    pub(super) fn confirms(&self, name: &str, harness: HarnessId) -> bool {
        self.error.is_none() && self.name == name && self.harness == harness
    }

    pub(super) fn replay(self, request: &SpawnRequest) -> Result<Value, SpawnError> {
        CompletedSpawn {
            name: self.name,
            harness: self.harness,
            result: self.error.map_or(Ok(self.output), Err),
        }
        .replay(request)
    }
}

fn digest(parts: &[&str]) -> String {
    let mut hash = Sha256::new();
    for part in parts {
        hash.update((part.len() as u64).to_be_bytes());
        hash.update(part.as_bytes());
    }
    format!("{:x}", hash.finalize())
}

/// The answer a spawn saved as `registration` gives when asked again,
/// with the unconfirmed-task warning its launch reported (or, kept after a
/// restart, could not rule out).
pub(super) fn spawned_output(registration: &Registration) -> Value {
    match registration
        .spawn
        .as_ref()
        .and_then(|spawn| spawn.task_unconfirmed.as_deref())
    {
        Some(verification) => wire::spawned_unconfirmed(&registration.name, verification),
        None => wire::spawned(&registration.name),
    }
}

impl Core {
    /// Older/recovered registrations have no receipt yet. Save one before
    /// release or removal can discard the only durable evidence of their
    /// invocation.
    pub(super) fn preserve_spawn_completion(&self, registration: &Registration) -> io::Result<()> {
        let Some(spawn) = registration.spawn.as_ref() else {
            return Ok(());
        };
        let invalid = || io::Error::new(io::ErrorKind::InvalidData, "spawn identity unavailable");
        let key = registration.workspace_key.as_ref().ok_or_else(invalid)?;
        let harness = HarnessId::from_name(&spawn.harness).ok_or_else(invalid)?;
        let request = SpawnRequest {
            invocation_id: spawn.invocation_id.clone(),
            harness,
            name: registration.name.clone(),
            task: String::new(),
            directory: None,
        };
        Scope::new(&registration.base_url, key)
            .save(
                &self.config.app_data_dir,
                &request,
                spawned_output(registration),
            )?
            .replay(&request)
            .map_err(|_| invalid())?;
        Ok(())
    }
}

#[cfg(test)]
mod tests;
