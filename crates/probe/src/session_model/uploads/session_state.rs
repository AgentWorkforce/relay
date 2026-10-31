//! A session row's upload state, and when uploads are stopped rather than
//! waiting to retry.
use super::StatusView;
use crate::relay::contract::account::{
    DeliveryFailureCode, UploadSession, UploadShareStatus, UploaderStatus,
};
use crate::relay::uploader::Stage;

/// A problem that is not retried on its own stopped uploads.
pub(super) fn stopped(status: &UploaderStatus) -> bool {
    status.stage == Stage::NeedsAttention && status.delivery.stopped
}

/// Retrying is what the person can do about the stop, or about a transient
/// failure that has lasted: Retry tries the receiver again at once instead of
/// after the backoff. A rate limit waits as the receiver asked, and a sign-in
/// failure is fixed by signing in, not by retrying.
pub(super) fn can_retry(status: &UploaderStatus) -> bool {
    let sign_in = Some(DeliveryFailureCode::AuthenticationRequired);
    let transient = status.stage == Stage::NeedsAttention
        && status.delivery.failure_code == Some(DeliveryFailureCode::Transient);
    (stopped(status) && status.delivery.failure_code != sign_in) || transient
}

/// A session row's upload state. Delivery is separate from permission to
/// upload: `shared` only proves permission.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SessionUploadState {
    Discovering,
    Local,
    Preparing,
    Queued,
    Uploading,
    Uploaded,
    Checking,
    Paused,
    Blocked,
    Stopped,
    Unknown,
}

impl SessionUploadState {
    pub fn of(session: &UploadSession, status: Option<&StatusView>) -> SessionUploadState {
        match session.status {
            UploadShareStatus::Uploaded => return SessionUploadState::Uploaded,
            UploadShareStatus::Unknown => return SessionUploadState::Unknown,
            _ => {}
        }
        if !session.included {
            return SessionUploadState::Local;
        }
        if let Some(status) = status {
            if status.paused {
                return SessionUploadState::Paused;
            }
            // A problem that is not retried on its own stopped every upload.
            if status.stopped {
                return SessionUploadState::Stopped;
            }
            if matches!(
                status.stage,
                Stage::NotRunning | Stage::NeedsAttention | Stage::Offline
            ) {
                return SessionUploadState::Blocked;
            }
        }
        match session.status {
            UploadShareStatus::Uploaded => SessionUploadState::Uploaded,
            UploadShareStatus::Uploading => SessionUploadState::Uploading,
            UploadShareStatus::Queued => SessionUploadState::Queued,
            UploadShareStatus::Shared => SessionUploadState::Preparing,
            UploadShareStatus::Checking => SessionUploadState::Checking,
            UploadShareStatus::NotShared | UploadShareStatus::Unknown => {
                SessionUploadState::Unknown
            }
        }
    }

    pub fn title(self) -> &'static str {
        match self {
            SessionUploadState::Discovering => "Indexing",
            SessionUploadState::Local => "Not uploading",
            SessionUploadState::Preparing => "Preparing",
            SessionUploadState::Queued => "Queued",
            SessionUploadState::Uploading => "Uploading…",
            SessionUploadState::Uploaded => "Uploaded",
            SessionUploadState::Checking => "Checking…",
            SessionUploadState::Paused => "Paused",
            SessionUploadState::Blocked => "Waiting to retry",
            SessionUploadState::Stopped => "Upload stopped",
            SessionUploadState::Unknown => "Status unavailable",
        }
    }

    /// Short icon label; pipeline milestones must not become fake percentages.
    pub fn icon_title(self) -> &'static str {
        if self == Self::Local {
            "Local only"
        } else {
            self.title()
        }
    }

    pub fn detail(self) -> &'static str {
        match self {
            SessionUploadState::Discovering => "Session discovered. Preparing it for upload selection.",
            SessionUploadState::Local => "Not selected for upload. This does not remove any copy uploaded previously.",
            SessionUploadState::Preparing => "Enabled for upload. Delivery has not been confirmed yet.",
            SessionUploadState::Queued => "Waiting for the uploader to send this session.",
            SessionUploadState::Uploading => "The uploader is sending a batch containing this session.",
            SessionUploadState::Uploaded => "The uploader reports this session is up to date.",
            SessionUploadState::Checking => "Enabled for upload. Agent Relay is still confirming whether this session is up to date.",
            SessionUploadState::Paused => "Enabled for upload. Resume uploads to continue.",
            SessionUploadState::Blocked => "Enabled for upload, but the uploader is stopped or retrying a problem. See the upload status in the header.",
            SessionUploadState::Stopped => "Enabled for upload, but a problem stopped uploads. Queued records are preserved; retry uploads from the upload status in the header.",
            SessionUploadState::Unknown => "Enabled for upload, but delivery status is not available yet.",
        }
    }

    /// The status pill's glyph, named for the Mac's SF Symbol.
    pub fn symbol(self) -> &'static str {
        match self {
            SessionUploadState::Discovering | SessionUploadState::Preparing => "clock",
            SessionUploadState::Local => "desktopcomputer",
            SessionUploadState::Queued => "tray.and.arrow.up",
            SessionUploadState::Uploading => "arrow.up.circle.fill",
            SessionUploadState::Uploaded => "checkmark.circle.fill",
            SessionUploadState::Checking => "arrow.triangle.2.circlepath",
            SessionUploadState::Paused => "pause.circle",
            SessionUploadState::Blocked | SessionUploadState::Stopped => "exclamationmark.circle",
            SessionUploadState::Unknown => "questionmark.circle",
        }
    }

    /// How far along the upload pipeline the session is; `None` outside it.
    pub fn pipeline_progress(self) -> Option<f64> {
        match self {
            SessionUploadState::Preparing => Some(0.25),
            SessionUploadState::Queued => Some(0.5),
            SessionUploadState::Uploading => Some(0.75),
            SessionUploadState::Uploaded => Some(1.0),
            SessionUploadState::Discovering
            | SessionUploadState::Local
            | SessionUploadState::Checking
            | SessionUploadState::Paused
            | SessionUploadState::Blocked
            | SessionUploadState::Stopped
            | SessionUploadState::Unknown => None,
        }
    }

    /// Waiting to upload; not yet confirmed is not waiting.
    pub fn is_pending(self) -> bool {
        !matches!(
            self,
            SessionUploadState::Discovering
                | SessionUploadState::Local
                | SessionUploadState::Uploaded
                | SessionUploadState::Checking
        )
    }
}
