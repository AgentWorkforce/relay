//! Opt-in delivery to an existing provider session through a supported API or
//! native protocol. This boundary is shared by the macOS and Linux desktop
//! core. Discovery and registration do not expose a provider until its session
//! binding can be proved; terminal keystrokes are never a fallback. Grok has
//! two separate default-off routes: a probe-managed leader, and an already-open
//! leader registered with immutable proof (`enablement`).

use crate::relay::store::random_hex;
use fs2::FileExt;
use platform::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

mod binding;
mod coordinator;
pub use binding::{Binding, Eligibility, Gate, Provider, Transport};
pub use coordinator::Coordinator;

pub mod devin;
pub mod enablement;
pub mod grok;
pub mod muse;
pub mod muse_open;
pub mod paseo_muse;
pub(crate) mod platform;

pub(crate) fn printable(value: &str, max: usize) -> bool {
    (1..=max).contains(&value.len()) && value.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
}

/// A journal temp file exists only between its create and its rename inside
/// one record replacement. One older than this was left by a crash.
pub(crate) const STALE_JOURNAL_TEMP_AGE: Duration = Duration::from_secs(60 * 60);

/// Removes journal temp files, `.<64 hex>-<32 hex>.tmp`, last modified before
/// `cutoff`. Only regular files of this uid with exactly that name shape are
/// removed; records, locks and every other entry stay. An orphan temp never
/// holds journal state: the record it would have replaced is authoritative.
/// Best effort: a file that cannot be removed waits for the next sweep.
pub(crate) fn sweep_stale_journal_temps(directory: &Path, cutoff: SystemTime) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    let uid = platform::getuid();
    for entry in entries.flatten() {
        if !entry.file_name().to_str().is_some_and(is_journal_temp_name) {
            continue;
        }
        let path = entry.path();
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.is_file()
            && metadata.uid() == uid
            && metadata.modified().is_ok_and(|modified| modified < cutoff)
        {
            let _ = fs::remove_file(&path);
        }
    }
}

fn is_journal_temp_name(name: &str) -> bool {
    let lower_hex = |value: &str, length: usize| {
        value.len() == length
            && value
                .bytes()
                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    };
    name.strip_prefix('.')
        .and_then(|rest| rest.strip_suffix(".tmp"))
        .and_then(|rest| rest.split_once('-'))
        .is_some_and(|(digest, nonce)| lower_hex(digest, 64) && lower_hex(nonce, 32))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failure {
    Disabled,
    UnsupportedRoute,
    IdentityMismatch,
    AuthenticationUnavailable,
    EndpointUnavailable,
    ProviderRefused,
    TimedOut,
    PriorAttemptUncertain,
    RequestConflict,
    JournalUnavailable,
}

/// Only fixed diagnostic codes cross into activity logs. HTTP bodies, raw
/// errors, credentials and prompt text cannot be rendered through `Failure`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    Delivered { receipt_id: String },
    Retry(Failure),
    Waiting(Failure),
    InDoubt(Failure),
    Refused(Failure),
}

pub struct Request<'a> {
    pub binding: &'a Binding,
    pub delivery_id: &'a str,
    pub message_id: &'a str,
    pub text: &'a str,
    pub timeout: Duration,
}

pub trait Adapter: Send + Sync {
    fn provider(&self) -> Provider;
    /// The caller holds one route lock and a durable pending record. An
    /// uncertain result must never be represented as Retry or Waiting.
    fn inject(&self, request: &Request<'_>, command_id: &str) -> Outcome;
    /// Reconcile or idempotently replay the same durable command after an
    /// uncertain attempt. Providers without a durable command id must keep the
    /// attempt in doubt.
    fn replay(&self, _request: &Request<'_>, _command_id: &str) -> Outcome {
        Outcome::InDoubt(Failure::PriorAttemptUncertain)
    }
}

/// One file per delivery, created and fsynced before a provider side effect.
/// A crash can leave a message unsent and in doubt. Only adapters with a
/// provider-durable idempotency key may reconcile by replaying that exact key;
/// every other adapter remains in doubt. Per-session `flock` serializes two
/// desktop processes or threads.
pub struct Journal {
    directory: PathBuf,
}

#[derive(Debug, PartialEq, Eq)]
enum Claim {
    Send(String),
    Replay(String),
    Delivered(String),
    InDoubt,
    RequestConflict,
    /// No record was left and none existed before: nothing was ever sent for
    /// this delivery, so it is safe to try again.
    Unclaimed,
}

impl Journal {
    pub fn new(directory: impl AsRef<Path>) -> std::io::Result<Self> {
        let directory = directory.as_ref().to_path_buf();
        match fs::DirBuilder::new().mode(0o700).create(&directory) {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
        let metadata = fs::symlink_metadata(&directory)?;
        if !metadata.is_dir()
            || metadata.uid() != platform::getuid()
            || metadata.mode() & 0o077 != 0
        {
            return Err(std::io::Error::new(
                ErrorKind::PermissionDenied,
                "journal directory is not private",
            ));
        }
        if let Some(cutoff) = SystemTime::now().checked_sub(STALE_JOURNAL_TEMP_AGE) {
            sweep_stale_journal_temps(&directory, cutoff);
        }
        Ok(Self { directory })
    }

    fn hash(parts: &[&str]) -> String {
        let mut hasher = Sha256::new();
        for part in parts {
            hasher.update(part.as_bytes());
            hasher.update([0]);
        }
        format!("{:x}", hasher.finalize())
    }

    /// What a delivery's record is checked against. A Grok ACP binding is
    /// hashed without its leader identity: the registry may rebind a session
    /// to a replacement leader under the same workspace, owner and uid, and
    /// a record made before that must still replay its receipt or stay in
    /// doubt, never read as a different request.
    pub(super) fn request_hash(request: &Request<'_>) -> String {
        let binding = request.binding;
        if binding.provider == Provider::Grok && binding.transport == Transport::Acp {
            return Self::hash(&[
                binding.provider.code(),
                binding.transport.code(),
                &binding.workspace_id,
                &binding.session_id,
                &binding.owner_id,
                &binding.owner_uid.to_string(),
                binding.cwd.to_string_lossy().as_ref(),
                request.message_id,
                request.text,
            ]);
        }
        Self::full_request_hash(request)
    }

    /// The hash over every binding field, as records were written before
    /// Grok rebinding; still accepted as a Grok record's prior.
    pub(super) fn full_request_hash(request: &Request<'_>) -> String {
        let binding = request.binding;
        Self::hash(&[
            binding.provider.code(),
            binding.transport.code(),
            &binding.workspace_id,
            &binding.session_id,
            &binding.endpoint_id,
            &binding.owner_id,
            &binding.credential_reference,
            &binding.owner_uid.to_string(),
            &binding.auth_id,
            &binding.protocol_id,
            binding.cwd.to_string_lossy().as_ref(),
            &binding.model_id,
            &binding.agent_version,
            binding.executable.to_string_lossy().as_ref(),
            &binding.leader_pid.to_string(),
            &binding.leader_start.to_string(),
            binding.socket_path.to_string_lossy().as_ref(),
            &binding.socket_device.to_string(),
            &binding.socket_inode.to_string(),
            request.message_id,
            request.text,
        ])
    }

    /// Hash written by Grok receipt files after managed endpoint and
    /// credential identity were added, but before durable command IDs and
    /// Muse host identity extended the journal format.
    fn pre_command_grok_request_hash(request: &Request<'_>) -> String {
        let binding = request.binding;
        Self::hash(&[
            binding.provider.code(),
            binding.transport.code(),
            &binding.workspace_id,
            &binding.session_id,
            &binding.endpoint_id,
            &binding.owner_id,
            &binding.credential_reference,
            &binding.owner_uid.to_string(),
            binding.cwd.to_string_lossy().as_ref(),
            &binding.model_id,
            &binding.agent_version,
            binding.executable.to_string_lossy().as_ref(),
            &binding.leader_pid.to_string(),
            &binding.leader_start.to_string(),
            binding.socket_path.to_string_lossy().as_ref(),
            &binding.socket_device.to_string(),
            &binding.socket_inode.to_string(),
            request.message_id,
            request.text,
        ])
    }

    /// Hash used by Grok receipt files written before durable command IDs and
    /// the managed-host identity fields were added. Muse has never written
    /// this format, so accepting it is deliberately limited to Grok.
    fn legacy_grok_request_hash(request: &Request<'_>) -> String {
        let binding = request.binding;
        Self::hash(&[
            binding.provider.code(),
            binding.transport.code(),
            &binding.workspace_id,
            &binding.session_id,
            &binding.owner_id,
            &binding.owner_uid.to_string(),
            binding.cwd.to_string_lossy().as_ref(),
            &binding.model_id,
            &binding.agent_version,
            binding.executable.to_string_lossy().as_ref(),
            &binding.leader_pid.to_string(),
            &binding.leader_start.to_string(),
            binding.socket_path.to_string_lossy().as_ref(),
            &binding.socket_device.to_string(),
            &binding.socket_inode.to_string(),
            request.message_id,
            request.text,
        ])
    }

    fn route_hash(binding: &Binding) -> String {
        Self::hash(&[
            binding.provider.code(),
            &binding.workspace_id,
            &binding.owner_id,
            &binding.owner_uid.to_string(),
            &binding.endpoint_id,
            &binding.auth_id,
            &binding.protocol_id,
            binding.socket_path.to_string_lossy().as_ref(),
            &binding.socket_device.to_string(),
            &binding.socket_inode.to_string(),
            &binding.session_id,
        ])
    }

    fn record_path(&self, delivery_id: &str) -> PathBuf {
        self.directory
            .join(format!("{}.receipt", Self::hash(&[delivery_id])))
    }

    fn private_file(&self, path: &Path, create_new: bool) -> std::io::Result<File> {
        OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(create_new)
            .custom_flags(platform::O_NOFOLLOW)
            .mode(0o600)
            .open(path)
    }

    fn with_route_lock<T>(
        &self,
        binding: &Binding,
        body: impl FnOnce() -> T,
    ) -> std::io::Result<T> {
        let path = self
            .directory
            .join(format!("route-{}.lock", Self::route_hash(binding)));
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .custom_flags(platform::O_NOFOLLOW)
            .mode(0o600)
            .open(path)?;
        let metadata = file.metadata()?;
        if !metadata.is_file()
            || metadata.uid() != platform::getuid()
            || metadata.mode() & 0o077 != 0
        {
            return Err(std::io::Error::new(
                ErrorKind::PermissionDenied,
                "route lock is not private",
            ));
        }
        file.lock_exclusive()?;
        let result = body();
        // Once `body` has run, its outcome stands: an `Err` from this function
        // must only ever mean the provider was not contacted. Closing the
        // file below releases the `flock` even if this unlock fails.
        let _ = FileExt::unlock(&file);
        Ok(result)
    }

    #[cfg(unix)]
    fn sync_directory(&self) -> std::io::Result<()> {
        File::open(&self.directory)?.sync_all()
    }

    /// Windows cannot open a directory as a `File` to flush it; a rename
    /// there is already durable once the file it moves was synced.
    #[cfg(windows)]
    fn sync_directory(&self) -> std::io::Result<()> {
        Ok(())
    }

    fn claim(&self, request: &Request<'_>) -> std::io::Result<Claim> {
        let path = self.record_path(request.delivery_id);
        let hash = Self::request_hash(request);
        match self.private_file(&path, true) {
            Ok(mut file) => {
                let written = uuid_v7()
                    .ok_or_else(|| std::io::Error::other("uuid generation failed"))
                    .and_then(|command_id| {
                        write!(file, "pending\n{hash}\n{command_id}\n")?;
                        file.sync_all()?;
                        self.sync_directory()?;
                        Ok(command_id)
                    });
                match written {
                    Ok(command_id) => Ok(Claim::Send(command_id)),
                    // Nothing was sent. Removing the partial record keeps a
                    // later attempt from reading it as an uncertain one; if it
                    // cannot be removed, that attempt stays in doubt.
                    Err(error) => {
                        drop(file);
                        if fs::remove_file(&path).is_ok() && self.sync_directory().is_ok() {
                            Ok(Claim::Unclaimed)
                        } else {
                            Err(error)
                        }
                    }
                }
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                let file = OpenOptions::new()
                    .read(true)
                    .custom_flags(platform::O_NOFOLLOW)
                    .open(path)?;
                let metadata = file.metadata()?;
                if !metadata.is_file()
                    || metadata.uid() != platform::getuid()
                    || metadata.mode() & 0o077 != 0
                {
                    return Err(std::io::Error::new(
                        ErrorKind::PermissionDenied,
                        "receipt is not private",
                    ));
                }
                let mut contents = String::new();
                file.take(1024).read_to_string(&mut contents)?;
                Ok(Self::parse_receipt(&contents, request, &hash))
            }
            // `create_new` failed for another reason, so no earlier attempt
            // left a record either.
            Err(_) => Ok(Claim::Unclaimed),
        }
    }

    fn parse_receipt(contents: &str, request: &Request<'_>, hash: &str) -> Claim {
        let mut lines = contents.lines();
        let status = lines.next();
        let prior = lines.next();
        let prior_grok_hash = request.binding.provider == Provider::Grok
            && prior.is_some_and(|prior| {
                prior == Self::pre_command_grok_request_hash(request)
                    || prior == Self::legacy_grok_request_hash(request)
            });
        // A record written with the full binding hash before Grok
        // rebinding: the same request, read under its own rules.
        let prior = prior.map(|prior| {
            if request.binding.provider == Provider::Grok
                && prior == Self::full_request_hash(request)
            {
                hash
            } else {
                prior
            }
        });
        if prior_grok_hash {
            return match status {
                Some("delivered") => lines
                    .next()
                    .filter(|value| printable(value, 256))
                    .map_or(Claim::InDoubt, |receipt| Claim::Delivered(receipt.into())),
                // Legacy pending records have no durable provider
                // command ID, so they remain uncertain and are never
                // upgraded into a replayable record.
                Some("pending") => Claim::InDoubt,
                _ => Claim::InDoubt,
            };
        }
        if prior != Some(hash) {
            return if prior.is_none() {
                Claim::InDoubt
            } else {
                Claim::RequestConflict
            };
        }
        let command_id = lines.next().filter(|value| is_uuid_v7(value));
        match status {
            Some("delivered") => command_id
                .and_then(|_| lines.next())
                .filter(|value| printable(value, 256))
                .map_or(Claim::InDoubt, |receipt| Claim::Delivered(receipt.into())),
            Some("pending") => command_id
                .map(|value| Claim::Replay(value.to_owned()))
                .unwrap_or(Claim::InDoubt),
            _ => Claim::InDoubt,
        }
    }

    fn settle(
        &self,
        request: &Request<'_>,
        command_id: &str,
        outcome: &Outcome,
        replay: bool,
    ) -> std::io::Result<()> {
        let path = self.record_path(request.delivery_id);
        match outcome {
            Outcome::Delivered { receipt_id } if printable(receipt_id, 256) => {
                let temp = self.directory.join(format!(
                    ".{}-{}.tmp",
                    Self::hash(&[request.delivery_id, receipt_id]),
                    random_hex(32)
                ));
                let result = (|| {
                    let mut file = self.private_file(&temp, true)?;
                    write!(
                        file,
                        "delivered\n{}\n{command_id}\n{receipt_id}\n",
                        Self::request_hash(request),
                    )?;
                    file.sync_all()?;
                    fs::rename(&temp, &path)?;
                    self.sync_directory()
                })();
                if result.is_err() {
                    let _ = fs::remove_file(temp);
                }
                result
            }
            Outcome::Retry(_) | Outcome::Waiting(_) | Outcome::Refused(_) if !replay => {
                fs::remove_file(path)?;
                self.sync_directory()
            }
            Outcome::Retry(_)
            | Outcome::Waiting(_)
            | Outcome::Refused(_)
            | Outcome::InDoubt(_)
            | Outcome::Delivered { .. } => Ok(()),
        }
    }
}

fn uuid_v7() -> Option<String> {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis();
    let millis = u64::try_from(millis).ok()?;
    if millis > 0x0000_ffff_ffff_ffff {
        return None;
    }
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).ok()?;
    bytes[0..6].copy_from_slice(&millis.to_be_bytes()[2..8]);
    bytes[6] = (bytes[6] & 0x0f) | 0x70;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Some(format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
        bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
    ))
}

fn is_uuid_v7(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && [8, 13, 18, 23].iter().all(|index| bytes[*index] == b'-')
        && bytes[14] == b'7'
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b')
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| [8, 13, 18, 23].contains(&index) || byte.is_ascii_hexdigit())
}

#[cfg(test)]
#[cfg(unix)]
mod tests;
