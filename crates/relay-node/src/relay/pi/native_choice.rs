//! Durable owner-mode choice, separate from executable provider input. A lost
//! admission or a later opt-out must never reframe the same delivery as a peer.
use super::*;
use crate::relay::store::Registration;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Choice {
    version: u32,
    session_id: String,
    message_id: String,
    binding: Option<String>,
    text_hash: String,
}

fn uncertain() -> InjectOutcome {
    InjectOutcome::InDoubt("Pi's saved native delivery choice could not be verified.".into())
}

/// Reserve before capability and runtime lookup, under the same lock as peers.
/// A completed or already-admitted receipt wins over new reservation work.
pub(super) fn reserve(
    config: &PiConfig,
    uid: u32,
    registration: &Registration,
    message_id: &str,
    text: &str,
) -> Result<(), InjectOutcome> {
    let directory = pinned_directory(config, uid, registration)
        .ok_or_else(|| InjectOutcome::Refused("Pi's pinned runtime is unavailable.".into()))?;
    let _lock = delivery_lock(&directory).map_err(|_| uncertain())?;
    if let Some(outcome) = recorded_delivery(config, uid, registration, message_id, text, true) {
        return Err(outcome);
    }
    check(&directory, uid, registration, message_id, text, true)
}

/// Caller holds delivery.lock. Recheck at publication so a peer that began
/// preflight before the native reservation still cannot race it into the inbox.
pub(super) fn check(
    directory: &Path,
    uid: u32,
    registration: &Registration,
    message_id: &str,
    text: &str,
    native: bool,
) -> Result<(), InjectOutcome> {
    // This suffix cannot be consumed by either old or new Pi extensions.
    let path = directory.join(format!("{}.native-choice", key(message_id)));
    match fs::symlink_metadata(&path) {
        Ok(_) => {
            let saved: Choice = read(&path, uid).ok_or_else(uncertain)?;
            if !native
                || saved.version != 1
                || saved.session_id != registration.target.id
                || saved.message_id != message_id
                || saved.binding != registration.route_binding
                || saved.text_hash != key(text)
            {
                return Err(uncertain());
            }
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if !native {
                return Ok(());
            }
            let saved = Choice {
                version: 1,
                session_id: registration.target.id.clone(),
                message_id: message_id.into(),
                binding: registration.route_binding.clone(),
                text_hash: key(text),
            };
            let bytes = serde_json::to_vec(&saved).map_err(|_| uncertain())?;
            atomic_write(&path, &bytes).map_err(|_| uncertain())
        }
        Err(_) => Err(uncertain()),
    }
}

/// No live process lookup and no repair writes. Existence is sufficient to
/// forbid downgrade; decoding and payload checks remain the sender's job.
pub(super) fn exists(
    config: &PiConfig,
    uid: u32,
    registration: &Registration,
    message_id: &str,
) -> bool {
    let Some(directory) = pinned_directory(config, uid, registration) else {
        return false;
    };
    let choice = directory.join(format!("{}.native-choice", key(message_id)));
    if !fs::symlink_metadata(choice)
        .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    {
        return true;
    }
    let receipt = directory.join(format!("{}.json", key(message_id)));
    if fs::symlink_metadata(&receipt)
        .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    {
        return false;
    }
    // Only a positively valid v1 peer receipt permits ordinary peer routing.
    !read::<Delivery>(&receipt, uid).is_some_and(|record| {
        record.version == 1
            && record.session_id == registration.target.id
            && record.message_id == message_id
    })
}
