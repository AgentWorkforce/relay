//! The session's inbox: staging a message, the hook's claim and tombstone,
//! and settling a claim the hook never finished from Cursor's transcript.

use super::{held, is_session_id, CursorConfig, LABEL};
use crate::relay::existing_session::platform;
use crate::relay::inject::InjectOutcome;
use crate::relay::process::ProcessTable;
use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// The inbox subdirectory a message moves into just before the hook prints
/// it. A file still here after the hook ended is the one case delivery
/// cannot settle by itself.
pub(super) const CLAIMED_DIR: &str = "claimed";

/// The inbox subdirectory a message moves into once the hook's answer is
/// written: the proof `send` replays instead of staging it again.
pub(super) const DRAINED_DIR: &str = "drained";

/// How long a tombstone is kept: well beyond the hour Relaycast keeps
/// redriving a delivery, so `send` still finds it however many messages
/// were handed over meanwhile, even while the core was not asking.
pub(super) const DRAINED_FOR: Duration = Duration::from_secs(24 * 60 * 60);

/// How long a claim may stay unsettled while its hook can still be
/// running: Agent Relay's hook entries give Cursor a 10 second timeout.
pub(super) const CLAIM_GRACE: Duration = Duration::from_secs(30);

/// How much of the end of Cursor's transcript is read for a claim.
pub(super) const TRANSCRIPT_TAIL: u64 = 8 << 20;

/// How long a staged message stays wanted without delivery asking about it
/// again: the age of its `<name>.lease` beside it. Delivery asks every few seconds while the agent is on the relay;
/// once it stops (the session was taken off the relay, or the core is not
/// running) the hook drops the file rather than hand it over. Relaycast
/// keeps an unacknowledged delivery, so a core that asks again stages it
/// again.
pub(super) const LEASE: Duration = Duration::from_secs(120);

/// `<session>.<message>.msg`: one name per delivery, whatever its id is.
pub(super) fn message_file(session_id: &str, message_id: &str) -> String {
    let nonce: String = message_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '-'
            }
        })
        .take(120)
        .collect();
    // Sanitizing can make distinct ids share a name (`a/b`, `a:b`): a hash
    // of the raw id keeps the file one per message.
    let nonce = if nonce != message_id || nonce.is_empty() {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        message_id.hash(&mut hasher);
        format!("{nonce}-{:x}", hasher.finish())
    } else {
        nonce
    };
    format!("{session_id}.{nonce}.msg")
}

const STAGED: &str =
    "in the session's inbox; Cursor shows it at the session's next tool call or when its turn ends";

/// Queues `text` for the session in its inbox file, renamed into place once
/// written and synced, so a hook never reads half a message. `Accepted`
/// keeps the delivery runtime asking until the hook has handed it over
/// (`Delivered`, from the tombstone) or a claim is in doubt.
pub fn send(
    config: &CursorConfig,
    table: &dyn ProcessTable,
    uid: u32,
    session_id: &str,
    message_id: &str,
    text: &str,
) -> InjectOutcome {
    if let Some(reason) = platform::unsupported(LABEL) {
        return InjectOutcome::Refused(reason);
    }
    if !is_session_id(session_id) {
        return InjectOutcome::Refused("invalid Cursor CLI session id".into());
    }
    let name = message_file(session_id, message_id);
    let inbox = config.inbox();
    // A message only moves forward, staged → claimed → drained, so looking
    // in that order cannot miss one the hook moves between two looks.
    let target = inbox.join(&name);
    if target.exists() {
        renew(&target);
        return InjectOutcome::Accepted(STAGED.into());
    }
    let claimed = inbox.join(CLAIMED_DIR).join(&name);
    if claimed.exists() {
        return settle_claim(config, session_id, &claimed);
    }
    if inbox.join(DRAINED_DIR).join(&name).exists() {
        return InjectOutcome::Delivered;
    }
    if held(config, table, uid, session_id).is_none() {
        return InjectOutcome::Waiting("that Cursor CLI session is not running".into());
    }
    if let Err(error) = std::fs::create_dir_all(&inbox) {
        return InjectOutcome::Retry(format!("could not open the session's inbox: {error}"));
    }
    let _ = platform::set_mode(&inbox, 0o700);
    let staging = inbox.join(format!(".{name}.tmp"));
    use platform::OpenOptionsExt;
    let write = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&staging)
        .and_then(|mut file| {
            platform::set_mode(&staging, 0o600)?;
            file.write_all(text.as_bytes())?;
            file.sync_all()
        });
    if let Err(error) = write {
        return InjectOutcome::Retry(format!("could not write the session's inbox: {error}"));
    }
    renew(&target);
    match std::fs::rename(&staging, &target) {
        Ok(()) => match std::fs::File::open(&inbox).and_then(|dir| dir.sync_all()) {
            Ok(()) => InjectOutcome::Accepted(STAGED.into()),
            Err(error) => InjectOutcome::Retry(format!(
                "could not sync the session's inbox directory: {error}"
            )),
        },
        Err(_) if target.exists() => InjectOutcome::Accepted(STAGED.into()),
        Err(error) => {
            InjectOutcome::Retry(format!("could not place the session's inbox file: {error}"))
        }
    }
}

/// `staged`'s lease: its modification time is the lease, its contents the
/// time the message was staged, in nanoseconds, which is its place in the
/// queue. File times are too coarse on Linux to order two messages staged
/// a moment apart.
fn lease(staged: &Path) -> PathBuf {
    let mut path = staged.as_os_str().to_owned();
    path.push(".lease");
    PathBuf::from(path)
}

/// Renews `staged`'s lease (`LEASE`), keeping its place in the queue.
fn renew(staged: &Path) {
    let lease = lease(staged);
    let renewed = std::fs::File::options()
        .write(true)
        .open(&lease)
        .and_then(|file| file.set_modified(SystemTime::now()));
    if renewed.is_err() {
        let now = SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default();
        let _ = std::fs::write(&lease, now.as_nanos().to_string());
    }
}

/// When `staged` was staged, from its lease; `None` without one.
fn staged_at(staged: &Path) -> Option<u128> {
    std::fs::read_to_string(lease(staged))
        .ok()?
        .trim()
        .parse()
        .ok()
}

/// A claim whose hook did not tombstone it: still in hand while the hook
/// may be running; afterwards delivered when Cursor's transcript records
/// it as a user turn (a `stop` follow-up), else in doubt. A `postToolUse`
/// context is never written to the transcript, so a hook that died after
/// printing one leaves it in doubt rather than shown twice.
pub(super) fn settle_claim(
    config: &CursorConfig,
    session_id: &str,
    claimed: &Path,
) -> InjectOutcome {
    let age = std::fs::metadata(claimed)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
        .unwrap_or_default();
    if age < CLAIM_GRACE {
        return InjectOutcome::Accepted("Cursor's hook is handing it to the session".into());
    }
    let recorded = std::fs::read_to_string(claimed)
        .ok()
        .is_some_and(|text| transcript_records(config, session_id, &text));
    if recorded {
        drain(&[claimed.to_path_buf()]);
        return InjectOutcome::Delivered;
    }
    InjectOutcome::InDoubt(
        "Cursor's hook took this message but its transcript does not show it; it is not sent again"
            .into(),
    )
}

/// Every transcript Cursor keeps for `session_id`, in any project.
pub(super) fn transcripts(config: &CursorConfig, session_id: &str) -> Vec<PathBuf> {
    std::fs::read_dir(config.data_dir.join("projects"))
        .map(|projects| {
            projects
                .flatten()
                .map(|project| {
                    project
                        .path()
                        .join("agent-transcripts")
                        .join(session_id)
                        .join(format!("{session_id}.jsonl"))
                })
                .filter(|path| path.is_file())
                .collect()
        })
        .unwrap_or_default()
}

/// Whether a user turn in the session's transcript carries `text`'s first
/// line: its attribution, which names the message's own ref.
pub(super) fn transcript_records(config: &CursorConfig, session_id: &str, text: &str) -> bool {
    let Some(marker) = text.lines().map(str::trim).find(|line| !line.is_empty()) else {
        return false;
    };
    transcripts(config, session_id).iter().any(|path| {
        let Ok(mut file) = std::fs::File::open(path) else {
            return false;
        };
        use std::io::{Read, Seek, SeekFrom};
        let length = file.metadata().map(|meta| meta.len()).unwrap_or(0);
        if file
            .seek(SeekFrom::Start(length.saturating_sub(TRANSCRIPT_TAIL)))
            .is_err()
        {
            return false;
        }
        let mut tail = Vec::new();
        if file.read_to_end(&mut tail).is_err() {
            return false;
        }
        String::from_utf8_lossy(&tail).lines().any(|line| {
            let Ok(entry) = serde_json::from_str::<Value>(line) else {
                return false;
            };
            entry["role"] == "user"
                && entry["message"]["content"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|part| part["text"].as_str())
                    .any(|part| part.contains(marker))
        })
    })
}

/// The probe subcommand Cursor runs for Agent Relay's hooks.
pub const HOOK_SUBCOMMAND: &str = "relay cursor-hook";

/// The hook events Agent Relay installs: a tool call mid-turn, and the end
/// of a turn.
pub const HOOK_EVENTS: [&str; 2] = ["postToolUse", "stop"];

/// One queued message, still in the inbox.
pub(super) struct Pending {
    path: PathBuf,
    text: String,
}

/// The session's staged messages, oldest first by staging time. One whose
/// lease ran out is removed instead: delivery no longer wants it handed
/// over.
pub(super) fn pending(config: &CursorConfig, session_id: &str) -> Vec<Pending> {
    if !is_session_id(session_id) {
        return Vec::new();
    }
    let prefix = format!("{session_id}.");
    let mut paths: Vec<PathBuf> = std::fs::read_dir(config.inbox())
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| {
                    path.is_file()
                        && path
                            .file_name()
                            .and_then(|name| name.to_str())
                            .is_some_and(|name| name.starts_with(&prefix) && name.ends_with(".msg"))
                })
                .collect()
        })
        .unwrap_or_default();
    let modified = |path: &Path| std::fs::metadata(path).and_then(|m| m.modified()).ok();
    paths.retain(|path| {
        // A message put back by `unclaim` has no lease: its own time counts.
        let renewed = modified(&lease(path)).or_else(|| modified(path));
        let fresh = renewed
            .and_then(|at| SystemTime::now().duration_since(at).ok())
            .is_some_and(|age| age < LEASE);
        if !fresh {
            let _ = std::fs::remove_file(path);
            let _ = std::fs::remove_file(lease(path));
        }
        fresh
    });
    paths.sort_by(|a, b| {
        (staged_at(a), modified(a))
            .cmp(&(staged_at(b), modified(b)))
            .then_with(|| a.cmp(b))
    });
    paths
        .into_iter()
        .filter_map(|path| {
            let text = std::fs::read_to_string(&path).ok()?.trim().to_string();
            (!text.is_empty()).then_some(Pending { path, text })
        })
        .collect()
}

/// What one hook call hands Cursor, and the claimed files it came from.
pub struct HookAnswer {
    pub output: Value,
    pub claimed: Vec<PathBuf>,
}

/// The session a hook `payload` names: `conversation_id`, which Cursor
/// also sends as `session_id`.
pub fn payload_session(payload: &Value) -> Option<&str> {
    payload["conversation_id"]
        .as_str()
        .or_else(|| payload["session_id"].as_str())
        .filter(|id| is_session_id(id))
}

/// Claims the session's pending messages and shapes them for `payload`'s
/// event: `additional_context` after a tool call, `followup_message` when a
/// turn completes. `None` says nothing and claims nothing: no message, an
/// event that does not inject, or a turn the person stopped or that failed,
/// whose follow-up would start a turn nobody asked for.
///
/// The caller has already proved the hook runs under the `cursor-agent`
/// that holds this session (`hook_caller_holds`).
pub fn hook_answer(config: &CursorConfig, payload: &Value) -> Option<HookAnswer> {
    let event = payload["hook_event_name"].as_str()?;
    if !HOOK_EVENTS.contains(&event) {
        return None;
    }
    if event == "stop" && payload["status"].as_str().is_some_and(|s| s != "completed") {
        return None;
    }
    let session_id = payload_session(payload)?;
    let claimed_dir = config.inbox().join(CLAIMED_DIR);
    let mut texts = Vec::new();
    let mut claimed = Vec::new();
    for message in pending(config, session_id) {
        let Some(name) = message.path.file_name() else {
            continue;
        };
        if std::fs::create_dir_all(&claimed_dir).is_err() {
            break;
        }
        let _ = platform::set_mode(&claimed_dir, 0o700);
        let to = claimed_dir.join(name);
        if std::fs::rename(&message.path, &to).is_err() {
            continue;
        }
        let _ = std::fs::remove_file(lease(&message.path));
        // The claim's age is how long its hook has had: from now.
        let _ = std::fs::File::options()
            .write(true)
            .open(&to)
            .and_then(|file| file.set_modified(SystemTime::now()));
        texts.push(message.text);
        claimed.push(to);
    }
    if claimed.is_empty() {
        return None;
    }
    // The claim must be on disk before Cursor can have the message.
    if std::fs::File::open(&claimed_dir)
        .and_then(|dir| dir.sync_all())
        .is_err()
    {
        unclaim(config, &claimed);
        return None;
    }
    let text = texts.join("\n\n");
    let output = match event {
        "stop" => json!({ "followup_message": text }),
        _ => json!({ "additional_context": text }),
    };
    Some(HookAnswer { output, claimed })
}

/// Moves claimed files back into the inbox: the answer was not written, so
/// Cursor has none of them and a later boundary may hand them over.
pub fn unclaim(config: &CursorConfig, claimed: &[PathBuf]) {
    for path in claimed {
        if let Some(name) = path.file_name() {
            let _ = std::fs::rename(path, config.inbox().join(name));
        }
    }
}

/// Tombstones claimed files once the answer they fed is written.
pub fn drain(claimed: &[PathBuf]) {
    for path in claimed {
        let Some((claimed_dir, name)) = path.parent().zip(path.file_name()) else {
            continue;
        };
        let Some(inbox) = claimed_dir.parent() else {
            continue;
        };
        let drained = inbox.join(DRAINED_DIR);
        if std::fs::create_dir_all(&drained).is_err() {
            continue;
        }
        let _ = platform::set_mode(&drained, 0o700);
        if std::fs::rename(path, drained.join(name)).is_ok() {
            let _ = std::fs::File::open(&drained).and_then(|dir| dir.sync_all());
        }
        prune_drained(&drained);
    }
}

/// Removes tombstones older than `DRAINED_FOR`, by when their message was
/// claimed.
pub(super) fn prune_drained(drained: &Path) {
    let Ok(entries) = std::fs::read_dir(drained) else {
        return;
    };
    for path in entries.flatten().map(|entry| entry.path()) {
        let expired = std::fs::metadata(&path)
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|at| SystemTime::now().duration_since(at).ok())
            .is_some_and(|age| age > DRAINED_FOR);
        if expired {
            let _ = std::fs::remove_file(path);
        }
    }
}
