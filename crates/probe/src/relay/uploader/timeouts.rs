//! How long each probe command may run.
use std::time::Duration;
/// `installs` is a pure read, and launch must never wait on it for long.
pub const INSTALLS: Duration = Duration::from_secs(15);
pub const STATUS: Duration = Duration::from_secs(15);
/// The probe bounds a collector replacement at ten minutes; this leaves
/// it time to withdraw a timed-out stop request and say so.
pub const START: Duration = Duration::from_secs(10 * 60 + 30);
pub const PAUSE: Duration = Duration::from_secs(30);
/// Compaction is bounded by rows, not time; committed pages survive a
/// kill, so another attempt continues it.
pub const COMPACT: Duration = Duration::from_secs(180);
pub const PREVIEW: Duration = Duration::from_secs(3);
pub const PREVIEW_REFRESH: Duration = Duration::from_secs(15);
pub const SESSIONS: Duration = Duration::from_secs(30);
pub const DISCONNECT: Duration = Duration::from_secs(60);
