//! The legacy ai-hist scheduler guard a receiver applies: how long an
//! inspection is reused, and what a person is told while it holds uploads.
use super::ReceiverState;
use crate::migration::MigrationStatus;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// How long a conclusive legacy scheduler inspection is reused by one
/// receiver. Each inspection runs `launchctl` and `crontab` (two seconds each
/// at most); a receiver serves one collector pass, and reusing a verdict for
/// at most this long bounds how late a legacy uploader installed during a
/// pass is noticed, and how late its removal is. An inconclusive (`unknown`)
/// inspection is never reused: the next batch inspects again.
pub const SCHEDULER_GUARD_TTL: Duration = Duration::from_secs(60);

/// What a person does about an active older ai-hist uploader: the removal
/// steps ai-hist itself documents. Uploads resume on their own afterwards.
pub fn legacy_uploader_message() -> &'static str {
    if cfg!(target_os = "macos") {
        "An older ai-hist uploader is still scheduled on this Mac, so uploads are held to avoid sending history twice. Remove it: run `launchctl bootout gui/$(id -u)/com.ai-hist.push` and delete ~/Library/LaunchAgents/com.ai-hist.push.plist (and the “# ai-hist push (managed)” line from `crontab -e`, if present). Uploads resume on their own within a few minutes; queued records are preserved."
    } else {
        "An older ai-hist uploader is still scheduled on this computer, so uploads are held to avoid sending history twice. Remove it: delete the “# ai-hist push (managed)” line with `crontab -e`. Uploads resume on their own within a few minutes; queued records are preserved."
    }
}
/// What a person is told while the older-uploader check cannot finish.
pub const LEGACY_SCHEDULES_UNKNOWN_MESSAGE: &str = "Agent Relay could not finish checking for an older ai-hist uploader on this computer. It checks again shortly; queued records are preserved.";

/// A collector pass held by the older-uploader check: `active` or
/// `unknown`. Its text is the probe's install-time sentence; status reports
/// classify it by state, never by that text.
#[derive(Debug)]
pub struct LegacySchedulesHeld {
    pub state: &'static str,
    pub message: &'static str,
}
impl std::fmt::Display for LegacySchedulesHeld {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.message)
    }
}
impl std::error::Error for LegacySchedulesHeld {}

impl ReceiverState {
    /// The legacy scheduler state this receiver would apply now, inspected
    /// again once its last inspection is [`SCHEDULER_GUARD_TTL`] old, so a
    /// host that also checks it directly shares that one inspection.
    pub fn legacy_scheduler_state(&self) -> &'static str {
        self.legacy_schedules().state
    }
    /// [`ReceiverState::legacy_scheduler_state`] with the fixed job labels
    /// the inspection found.
    pub fn legacy_schedules(&self) -> MigrationStatus {
        let inspect = self.0.inspector.unwrap_or(crate::migration::status);
        self.schedules(inspect)
    }
    /// The last inspection this state made, without inspecting again: what
    /// a status report says about older upload schedules. `None` before the
    /// first inspection, and always for a hosted receiver.
    pub fn last_legacy_schedules(&self) -> Option<MigrationStatus> {
        if self.0.hosted {
            return None;
        }
        self.0
            .last_schedules
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
    /// State whose scheduler inspection is `inspect` instead of the real
    /// `launchctl` and `crontab` reads: for tests of the hosts that share it.
    #[doc(hidden)]
    pub fn inspecting_with(inspect: fn() -> MigrationStatus) -> Self {
        Self(Arc::new(super::ReceiverStateInner {
            inspector: Some(inspect),
            ..Default::default()
        }))
    }
    /// The legacy schedulers, inspected again once the last conclusive
    /// inspection is [`SCHEDULER_GUARD_TTL`] old. An `unknown` result is not
    /// kept: one failed `launchctl` or `crontab` read must not hold uploads
    /// for the whole time to live, so the next batch inspects again.
    pub(super) fn schedules(&self, inspect: impl FnOnce() -> MigrationStatus) -> MigrationStatus {
        if self.0.hosted {
            return MigrationStatus {
                state: "clear",
                jobs: Vec::new(),
            };
        }
        let mut cached = self.0.schedules.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((at, status)) = cached.as_ref() {
            if at.elapsed() < SCHEDULER_GUARD_TTL {
                return status.clone();
            }
        }
        let status = inspect();
        *cached = (status.state != "unknown").then(|| (Instant::now(), status.clone()));
        *self
            .0
            .last_schedules
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(status.clone());
        status
    }
}
