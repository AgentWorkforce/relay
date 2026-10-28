//! Incoming messages from Agent Relay Cloud's desktop mailbox: the durable
//! layer between the transport and the local Codex and Claude sessions.
//!
//! ```text
//! transport ─▶ CodexInbox / ClaudeInbox ─▶ [dedupe] ─▶ [policy] ─▶ [rate limit] ─▶ outbox (SQLite)
//!                   ▲                                                                 │
//!                   └──── acks (journal in the outbox, plus an optional sink) ◀── delivery worker
//!                                                                                     │
//!                                                     CodexDeliveryEffects / ClaudeDeliveryEffects
//! ```
//!
//! Everything is synchronous and rooted at paths the caller passes; one
//! account scope lives under `<app data>/incoming/<scope>/` as
//! `shares.json` (the sharing policy) and `codex-outbox.sqlite` (the Codex
//! outbox, which also holds the inbound cursor and the ack journal). Every
//! local effect (Codex's queue, app-server and window socket, session files,
//! the Claude command line) sits behind the effects traits, so the layer runs
//! the same against fakes in tests.
//!
//! | Module | Owns |
//! |---|---|
//! | `store` | `CodexOutbox`: states, dedupe, approvals, attempts, expiry, prune, the ack journal, the cursor |
//! | `sharing` | `CodexSharingPolicy`: `shares.json`, modes, interrupted-change recovery, decisions |
//! | `messages` | Wire types (`CodexInboundMessage`, `ClaudeInboundMessage`, `CodexInboundAck`), ids, message refs |
//! | `effects` | The local effects the deliveries call, and their errors |
//! | `codex_delivery` | `CodexDelivery`: the Codex pass and its routes |
//! | `claude_delivery` | `ClaudeDelivery`: the Claude pass |
//! | `inbox` | `CodexInbox` and `ClaudeInbox`: receive, dedupe, policy, rate limit, acks |

pub mod claude_delivery;
pub mod codex_delivery;
pub mod effects;
pub mod inbox;
pub mod messages;
pub mod sharing;
pub mod store;
mod worker;

#[cfg(test)]
mod tests;

pub use claude_delivery::ClaudeDelivery;
pub use codex_delivery::{CodexDelivery, CodexRoute};
pub use effects::{
    ClaudeBridgeError, ClaudeDeliveryEffects, CodexAppServerError, CodexBridgeError,
    CodexDeliveryEffects, CodexQueueError, CodexWindowDelivering, RolloutSummary, TurnOutcome,
    WindowSessionError,
};
pub use inbox::{ClaudeInbox, CodexInbox};
pub use messages::{AckStatus, ClaudeInboundMessage, CodexInboundAck, CodexInboundMessage, Sender};
pub use sharing::{
    CodexSharingDecision, CodexSharingPolicy, CodexThreadShare, FileRecoveryIntents, Mode,
    RecoveryIntents,
};
pub use store::{CodexOutbox, CodexOutboxMessage, NewMessage, OutboxState, PendingAck};

use std::fmt;
use std::fs;
use std::io::Write;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// The time source every outbox type reads, injectable so tests never wait
/// out a real window.
pub type Clock = Arc<dyn Fn() -> SystemTime + Send + Sync>;

/// The wall clock.
pub fn system_clock() -> Clock {
    Arc::new(SystemTime::now)
}

/// How long a message may wait for its thread or session before it expires.
pub const DEFAULT_LIFETIME: Duration = Duration::from_secs(24 * 60 * 60);

/// Why an outbox operation failed.
#[derive(Debug)]
pub enum OutboxError {
    /// The SQLite store refused or could not be read.
    Sqlite(String),
    /// A file could not be read or written.
    Io(String),
    /// A stored file exists but is not what this layer wrote.
    Corrupt(String),
    /// The cloud session is not authorized right now; nothing was stored.
    AuthenticationRequired,
    /// A local effect failed in a way that ends the pass.
    Effect(String),
}

impl fmt::Display for OutboxError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            OutboxError::Sqlite(reason) => write!(f, "outbox store: {reason}"),
            OutboxError::Io(reason) => write!(f, "outbox file: {reason}"),
            OutboxError::Corrupt(reason) => write!(f, "corrupt outbox file: {reason}"),
            OutboxError::AuthenticationRequired => f.write_str("authentication required"),
            OutboxError::Effect(reason) => f.write_str(reason),
        }
    }
}

impl std::error::Error for OutboxError {}

impl From<rusqlite::Error> for OutboxError {
    fn from(error: rusqlite::Error) -> Self {
        OutboxError::Sqlite(error.to_string())
    }
}

impl From<std::io::Error> for OutboxError {
    fn from(error: std::io::Error) -> Self {
        OutboxError::Io(error.to_string())
    }
}

impl From<serde_json::Error> for OutboxError {
    fn from(error: serde_json::Error) -> Self {
        OutboxError::Corrupt(error.to_string())
    }
}

pub type Result<T, E = OutboxError> = std::result::Result<T, E>;

/// Seconds since 1970, the representation the store and the ack journal use.
pub(crate) fn seconds(time: SystemTime) -> f64 {
    match time.duration_since(UNIX_EPOCH) {
        Ok(after) => after.as_secs_f64(),
        Err(before) => -before.duration().as_secs_f64(),
    }
}

/// The time `value` seconds from 1970, or `None` for a value no time can
/// have (not finite, or out of range): a damaged file reads as corrupt, not
/// as a crash.
pub(crate) fn from_seconds(value: f64) -> Option<SystemTime> {
    let magnitude = Duration::try_from_secs_f64(value.abs()).ok()?;
    if value >= 0.0 {
        UNIX_EPOCH.checked_add(magnitude)
    } else {
        UNIX_EPOCH.checked_sub(magnitude)
    }
}

/// Creates `dir` and any missing parents, private to this user. A `dir`
/// that already exists is used only when it is a real directory (not a
/// symlink) this user owns and no one else can write to; its permissions
/// are never changed, so a planted path cannot be re-permissioned.
pub(crate) fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, MetadataExt};
        builder.mode(0o700);
        builder.create(dir)?;
        let entry = fs::symlink_metadata(dir)?;
        if !entry.is_dir()
            || entry.uid() != crate::relay::peer::current_uid()
            || entry.mode() & 0o022 != 0
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                format!(
                    "{} must be a directory only you can write to",
                    dir.display()
                ),
            ));
        }
        Ok(())
    }
    #[cfg(not(unix))]
    builder.create(dir)
}

pub(crate) fn make_private_file(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

/// Replaces `path` with `body` atomically: a reader sees the old file or the
/// new one, never a mix. The file is private to this user.
pub(crate) fn write_atomic(path: &Path, body: &[u8]) -> std::io::Result<()> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let mut file = tempfile::NamedTempFile::new_in(parent)?;
    make_private_file(file.path())?;
    file.write_all(body)?;
    file.as_file().sync_all()?;
    file.persist(path).map_err(|error| error.error)?;
    // The rename is durable only once the directory is synced; callers rely
    // on it (a recovery intent must outlive a crash). Windows cannot open a
    // directory for syncing.
    #[cfg(unix)]
    fs::File::open(parent)?.sync_all()?;
    Ok(())
}
