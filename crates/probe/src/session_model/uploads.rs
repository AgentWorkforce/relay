//! Session uploads in words: the sharing modes, `uploader.status` as the
//! header and tray say it, each session's upload state, the Sessions
//! filters and the reading → collecting → uploading stages.

use super::{capitalized, grouped, search_matches, session_project, sessions_noun};
use crate::relay::contract::account::{UploadSession, UploadShareStatus, UploaderStatus};
use crate::relay::state::CaptureProgress;
use crate::relay::uploader::{SharingMode, Stage};

mod stages;
pub use stages::{StageAction, StageState, UploadStage};
mod session_state;
pub use session_state::SessionUploadState;

/// The order Settings offers the sharing modes in.
pub const SHARING_DISPLAY_ORDER: [SharingMode; 3] =
    [SharingMode::Selected, SharingMode::New, SharingMode::All];

/// How Settings words a sharing mode.
pub trait SharingModeText {
    fn title(self) -> &'static str;
    fn explanation(self) -> &'static str;
    /// The question asked before switching to it.
    fn confirmation_title(self) -> &'static str;
    /// The button that confirms the switch.
    fn confirmation_action(self) -> &'static str;
}

impl SharingModeText for SharingMode {
    fn title(self) -> &'static str {
        match self {
            SharingMode::All => "Automatically upload all sessions, past and future",
            SharingMode::New => "Automatically upload new sessions",
            SharingMode::Selected => "Only sessions I choose",
        }
    }

    fn explanation(self) -> &'static str {
        match self {
            SharingMode::All => "Every existing and future local coding session uploads automatically, without selecting it first.",
            SharingMode::New => "Upload new sessions automatically. Existing sessions stay local unless you choose to share them.",
            SharingMode::Selected => "New sessions stay local until you turn on Upload session. Once enabled, those sessions keep uploading changes until you turn it off.",
        }
    }

    fn confirmation_title(self) -> &'static str {
        match self {
            SharingMode::Selected => "Upload only sessions you choose?",
            SharingMode::New => "Automatically upload new sessions?",
            SharingMode::All => "Automatically upload all sessions?",
        }
    }

    fn confirmation_action(self) -> &'static str {
        match self {
            SharingMode::Selected => "Use selected sessions only",
            SharingMode::New => "Enable automatic uploads",
            SharingMode::All => "Upload all past and future sessions",
        }
    }
}

/// `uploader.status` in words. The core decides the stage; this only
/// names it.
#[derive(Clone, Debug, PartialEq)]
pub struct StatusView {
    pub stage: Stage,
    pub headline: String,
    pub detail: Option<String>,
    pub acknowledged: u64,
    pub pending: u64,
    pub quarantined: u64,
    pub paused: bool,
    pub sharing_mode: SharingMode,
    pub upgrading: bool,
    /// The install's directory, which holds `collector.log`.
    pub directory: Option<String>,
    pub journal_full: bool,
    /// A problem that is not retried on its own stopped uploads.
    pub stopped: bool,
    /// Retrying is what the person can do about the stop. A sign-in failure
    /// is fixed by signing in, not by retrying.
    pub can_retry: bool,
    pub shared_sessions: u64,
    pub total_sessions: u64,
    pub last_upload_ms: Option<i64>,
}

impl StatusView {
    pub fn new(status: &UploaderStatus) -> StatusView {
        let delivery = &status.delivery;
        let stage = status.stage;
        let message = status
            .stage_message
            .as_deref()
            .filter(|message| !message.is_empty());
        let skipped = delivery.skipped_records;
        let quarantined = delivery.quarantined_records;
        let (headline, detail) = if stage == Stage::UpToDate
            && status.sharing_mode == SharingMode::Selected
            && status.sessions.total > 0
            && status.sessions.shared == 0
        {
            (
                "Choose sessions to upload".to_string(),
                Some(
                    "No sessions are enabled for upload. Select sessions below to get started."
                        .to_string(),
                ),
            )
        } else if status.collector_replacing && stage == Stage::Preparing {
            (
                "Replacing the uploader".to_string(),
                Some("The updated uploader will resume automatically when the current capture stops.".to_string()),
            )
        } else if status.upgrading && stage == Stage::Preparing {
            (
                "Upgrading local history".to_string(),
                Some(
                    message
                        .unwrap_or("Uploads continue when the upgrade finishes.")
                        .to_string(),
                ),
            )
        } else if stage == Stage::Preparing && !delivery.bootstrap_complete {
            (
                "Preparing uploads".to_string(),
                Some(
                    "Preparing enabled sessions. Upload completion has not been confirmed yet."
                        .to_string(),
                ),
            )
        } else {
            let detail = if stage == Stage::Conflict {
                Some(message.map(str::to_string).unwrap_or_else(|| {
                    format!("{quarantined} records quarantined after a receiver conflict. Other records can continue uploading.")
                }))
            } else if matches!(stage, Stage::UpToDate | Stage::Uploading) && skipped > 0 {
                let skipped_detail = if skipped == 1 {
                    "1 record was skipped during upload.".to_string()
                } else {
                    format!("{skipped} records were skipped during upload.")
                };
                match message {
                    Some(message) if stage == Stage::Uploading => {
                        Some(format!("{message} {skipped_detail}"))
                    }
                    _ => Some(skipped_detail),
                }
            } else {
                stage_detail(stage, message).map(str::to_string)
            };
            (stage_headline(stage).to_string(), detail)
        };
        StatusView {
            stage,
            headline,
            detail,
            acknowledged: delivery.acknowledged_records,
            pending: delivery.pending_records,
            quarantined,
            paused: status.paused,
            sharing_mode: status.sharing_mode,
            upgrading: status.upgrading,
            directory: status.directory.clone(),
            journal_full: status.journal_full,
            stopped: session_state::stopped(status),
            can_retry: session_state::can_retry(status),
            shared_sessions: status.sessions.shared,
            total_sessions: status.sessions.total,
            last_upload_ms: delivery.last_acknowledged_ms,
        }
    }

    /// Records sent plus records waiting.
    pub fn total(&self) -> u64 {
        self.acknowledged + self.pending
    }

    /// The share of records sent: `0` with none, `1` with none waiting.
    pub fn progress(&self) -> f64 {
        match (self.total(), self.pending) {
            (0, _) => 0.0,
            (_, 0) => 1.0,
            (total, _) => self.acknowledged as f64 / total as f64,
        }
    }
}

/// A stage's headline.
pub fn stage_headline(stage: Stage) -> &'static str {
    match stage {
        Stage::NotRunning => "Not running",
        Stage::Paused => "Paused",
        Stage::NeedsAttention => "Needs attention",
        Stage::Conflict => "Delivery conflict",
        Stage::Offline => "Offline — retrying",
        Stage::Preparing => "Checking for updates",
        Stage::Uploading => "Uploading…",
        Stage::UpToDate => "Up to date",
    }
}

/// A stage's detail, given the core's sentence for it.
fn stage_detail(stage: Stage, message: Option<&str>) -> Option<&str> {
    match stage {
        Stage::NotRunning => Some("Agent Relay is starting the uploader again."),
        Stage::Paused => Some("Nothing is uploaded until you resume."),
        Stage::NeedsAttention => Some(message.unwrap_or("Uploads need attention.")),
        Stage::Conflict => {
            Some(message.unwrap_or(
                "Receiver-proven records were quarantined. Inspect conflicts for repair.",
            ))
        }
        Stage::Offline => Some(message.unwrap_or("Agent Relay will try again shortly.")),
        Stage::Preparing => Some("Checking session changes in the background."),
        Stage::Uploading => message,
        Stage::UpToDate => Some("Monitoring for new session activity."),
    }
}

// One `uploader.sessions.list` row.

/// `SOURCE:ID`, the key the uploader takes.
pub fn session_key(session: &UploadSession) -> String {
    format!("{}:{}", session.source, session.session_id)
}

/// The local title on one line, else the id.
pub fn session_title(session: &UploadSession) -> String {
    let title = session
        .title
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if title.is_empty() {
        session.session_id.clone()
    } else {
        title
    }
}

/// The Sessions search field: title, id, project and source, ignoring
/// case; empty matches all.
pub fn session_matches(session: &UploadSession, query: &str) -> bool {
    let fields = [
        session_title(session),
        session.title.clone(),
        session_key(session),
        session_project(session),
        session.source.clone(),
    ];
    search_matches(query, fields.iter().map(String::as_str))
}

/// The Sessions sidebar's filters.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SessionFilter {
    All,
    Pending,
    Uploaded,
    Local,
}

impl SessionFilter {
    /// The order the sidebar lists them in.
    pub const ALL: [SessionFilter; 4] = [
        SessionFilter::All,
        SessionFilter::Pending,
        SessionFilter::Uploaded,
        SessionFilter::Local,
    ];

    pub fn title(self) -> &'static str {
        match self {
            SessionFilter::All => "All sessions",
            SessionFilter::Pending => "In progress",
            SessionFilter::Uploaded => "Uploaded",
            SessionFilter::Local => "Not uploading",
        }
    }

    pub fn matches(self, state: SessionUploadState) -> bool {
        match self {
            SessionFilter::All => true,
            SessionFilter::Pending => state.is_pending(),
            SessionFilter::Uploaded => state == SessionUploadState::Uploaded,
            SessionFilter::Local => state == SessionUploadState::Local,
        }
    }
}

// Local capture while sessions are prepared (`status.account.progress`).

/// Whether local history is being read now.
pub fn capture_is_active(capture: &CaptureProgress) -> bool {
    matches!(capture.phase.as_str(), "scanning" | "capture_paused")
}

fn capture_is_paused(capture: &CaptureProgress) -> bool {
    capture.phase == "capture_paused"
}

pub fn capture_headline(capture: &CaptureProgress) -> &'static str {
    if capture_is_paused(capture) {
        "History preparation paused · Retrying"
    } else {
        "Reading local history"
    }
}

/// `Codex: 5 of 10 files processed · 2 sessions captured locally.`
pub fn capture_detail(capture: &CaptureProgress) -> String {
    let processed = grouped(capture.processed_files);
    let count = match capture.total_files {
        Some(total) => format!("{processed} of {} files processed", grouped(total)),
        None => format!("{processed} files processed"),
    };
    let source = if capture.source.is_empty() {
        "Local history".to_string()
    } else {
        capitalized(&capture.source)
    };
    format!(
        "{source}: {count} · {} sessions captured locally.",
        grouped(capture.sessions_captured)
    )
}

/// How far capture is, when it reports a bounded total.
pub fn capture_fraction(capture: &CaptureProgress) -> Option<f64> {
    let total = capture.total_files.filter(|total| *total > 0)?;
    Some((capture.processed_files as f64 / total as f64).clamp(0.0, 1.0))
}

/// Upload status beside what the person just asked for. A request is not
/// permission confirmed by the uploader, nor proof of delivery.
#[derive(Clone, Debug, PartialEq)]
pub struct UploadSummary {
    pub stage: Stage,
    pub headline: String,
    pub detail: String,
    /// `3 sessions enabled`, or `1 session chosen` while a request is open.
    pub selection: String,
}

impl UploadSummary {
    /// `requesting` is how many sessions the person just asked to upload.
    pub fn new(
        status: &StatusView,
        sessions: &[UploadSession],
        requesting: usize,
    ) -> UploadSummary {
        let included = sessions.iter().filter(|session| session.included).count();
        let enabled = (status.shared_sessions as usize).max(included);
        let selection = if requesting == 0 {
            format!(
                "{} {} enabled",
                grouped(enabled as u64),
                sessions_noun(enabled)
            )
        } else {
            format!(
                "{} {} chosen",
                grouped(requesting as u64),
                sessions_noun(requesting)
            )
        };
        let summary = |stage: Stage, headline: String, detail: String| UploadSummary {
            stage,
            headline,
            detail,
            selection: selection.clone(),
        };
        if matches!(
            status.stage,
            Stage::Paused
                | Stage::NotRunning
                | Stage::Offline
                | Stage::NeedsAttention
                | Stage::Conflict
        ) {
            let extra = if requesting == 0 {
                ""
            } else {
                " Your upload selection is being prepared."
            };
            return summary(
                status.stage,
                status.headline.clone(),
                format!("{}{extra}", status.detail.as_deref().unwrap_or("")),
            );
        }
        if requesting > 0 {
            return summary(
                Stage::Preparing,
                format!("Preparing {requesting} {}", sessions_noun(requesting)),
                "Uploading starts automatically after preparation. A large history can take a few minutes; you can leave this window open to follow progress.".to_string(),
            );
        }
        let pending = sessions.iter().any(|session| {
            session.included
                && !matches!(
                    session.status,
                    UploadShareStatus::Uploaded | UploadShareStatus::Checking
                )
        });
        let checking = sessions
            .iter()
            .filter(|session| session.included && session.status == UploadShareStatus::Checking)
            .count();
        let up_to_date = status.stage == Stage::UpToDate;
        if up_to_date && pending {
            return summary(
                Stage::Preparing,
                "Waiting for upload confirmation".to_string(),
                "Your sessions are enabled for upload. Each row will show Uploaded when the uploader confirms it is up to date.".to_string(),
            );
        }
        if up_to_date && checking > 0 {
            return summary(
                status.stage,
                "Confirming upload status".to_string(),
                format!(
                    "The uploader is up to date. Agent Relay is still confirming {} {}; each row updates when checked.",
                    grouped(checking as u64),
                    sessions_noun(checking)
                ),
            );
        }
        if up_to_date && enabled > 0 {
            return summary(
                status.stage,
                "Uploads up to date".to_string(),
                "New changes to enabled sessions upload automatically.".to_string(),
            );
        }
        summary(
            status.stage,
            status.headline.clone(),
            status.detail.clone().unwrap_or_else(|| {
                "Sending session data. Each row will show Uploaded when its upload is confirmed."
                    .to_string()
            }),
        )
    }
}

/// Reading, collecting and uploading as independent stages: local capture
/// can continue while enabled sessions upload.
pub fn upload_stages(
    catalog_ready: bool,
    loaded_sessions: usize,
    enabled_sessions: usize,
    preparing_history: bool,
    capture: Option<&CaptureProgress>,
    status: Option<&StatusView>,
    summary: Option<&UploadSummary>,
    pending: Option<StageAction>,
) -> [UploadStage; 3] {
    let journal_full = stages::journal_full(status, pending);
    // Stopped uploads wait for the person, so their stage offers the retry.
    let retry = status.is_some_and(|status| status.can_retry);
    let ready = |yes: StageState, no: StageState| if catalog_ready { yes } else { no };
    let reading = UploadStage {
        title: "Reading sessions",
        detail: if catalog_ready {
            format!("{} sessions loaded", grouped(loaded_sessions as u64))
        } else {
            "Finding local sessions…".to_string()
        },
        state: ready(StageState::Complete, StageState::Active),
        fraction: catalog_ready.then_some(1.0),
        action: None,
    };

    let collecting = |detail: String, state: StageState, fraction: Option<f64>| UploadStage {
        title: "Collecting transcripts",
        detail,
        state,
        fraction,
        action: None,
    };
    let summary_stage = summary.map(|summary| summary.stage);
    let collecting = match capture {
        _ if journal_full => collecting(
            "Paused · Upload journal full".to_string(),
            StageState::Blocked,
            None,
        ),
        Some(capture) if capture_is_active(capture) => {
            let paused = capture_is_paused(capture);
            collecting(
                format!(
                    "{}{}",
                    if paused { "Retrying · " } else { "" },
                    capture_detail(capture)
                ),
                if paused {
                    StageState::Blocked
                } else {
                    StageState::Active
                },
                capture_fraction(capture),
            )
        }
        _ if preparing_history || summary_stage == Some(Stage::Preparing) => collecting(
            "Preparing session content for upload…".to_string(),
            StageState::Active,
            None,
        ),
        _ => collecting(
            if catalog_ready {
                "Local history is ready"
            } else {
                "Waiting for local history"
            }
            .to_string(),
            ready(StageState::Complete, StageState::Waiting),
            catalog_ready.then_some(1.0),
        ),
    };

    let enabled = enabled_sessions.max(status.map_or(0, |status| status.shared_sessions as usize));
    let summary_detail = || summary.map(|summary| summary.detail.clone());
    let (state, detail, action) = if journal_full {
        // A full journal stalls capture and delivery; compacting works
        // whether or not uploads are paused, so it outranks the rest. The
        // core's attention sentence can be an unrelated delivery failure,
        // so the stage names the journal itself.
        (
            StageState::Blocked,
            "Upload journal full".to_string(),
            Some(StageAction::Compact),
        )
    } else {
        let (state, detail) = match summary_stage {
            Some(Stage::Paused) => (
                StageState::Paused,
                "Paused · Resume uploads to continue".to_string(),
            ),
            Some(Stage::NotRunning | Stage::Offline | Stage::NeedsAttention) => (
                StageState::Blocked,
                summary_detail().unwrap_or_else(|| "Waiting to retry".to_string()),
            ),
            Some(Stage::Conflict) => (
                StageState::Active,
                summary_detail().unwrap_or_else(|| "Delivery conflicts need review".to_string()),
            ),
            Some(Stage::Uploading) => (
                StageState::Active,
                format!(
                    "{} records waiting to send",
                    grouped(status.map_or(0, |status| status.pending))
                ),
            ),
            Some(Stage::UpToDate) if enabled > 0 && collecting.state != StageState::Complete => (
                StageState::Waiting,
                "Waiting for prepared session content".to_string(),
            ),
            Some(Stage::UpToDate) if enabled > 0 => (
                StageState::Complete,
                "Enabled sessions are up to date".to_string(),
            ),
            Some(Stage::Preparing) => (
                StageState::Waiting,
                "Waiting for prepared session content".to_string(),
            ),
            _ => (
                StageState::Waiting,
                if status.is_none() {
                    "Checking uploader…"
                } else {
                    "Select sessions to upload"
                }
                .to_string(),
            ),
        };
        (state, detail, retry.then_some(StageAction::Retry))
    };
    // Acknowledged records are lifetime totals, not progress for this
    // upload, so sending stays indeterminate until it completes.
    let uploading = UploadStage {
        title: "Uploading to server",
        detail,
        state,
        fraction: (state == StageState::Complete).then_some(1.0),
        action,
    };
    stages::show_pending([reading, collecting, uploading], pending)
}

/// The Cloud page of an uploaded session; the id is one path segment.
pub fn cloud_session_url(site_url: &str, session_id: &str) -> Option<String> {
    if session_id.is_empty() {
        return None;
    }
    let origin = super::origin(site_url)?;
    let segment: String = session_id
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                (byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect();
    Some(format!("{origin}/cloud/dashboard/sessions/{segment}"))
}

/// The Cloud page of a session that has finished uploading; Cloud has no page
/// for one that hasn't.
pub fn uploaded_session_url(site_url: &str, session: &UploadSession) -> Option<String> {
    (SessionUploadState::of(session, None) == SessionUploadState::Uploaded)
        .then(|| cloud_session_url(site_url, &session.session_id))
        .flatten()
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use serde_json::{json, Value};

    /// An `uploader.status` answer: an idle uploader with nothing queued,
    /// with `changes` merged in. A `delivery` or `sessions` given replaces the
    /// default one; its missing counters read as zero.
    pub fn status(changes: Value) -> UploaderStatus {
        let mut value = json!({
            "stage": "up_to_date", "stage_message": null, "running": true, "paused": false,
            "sharing_mode": "new", "upgrading": false, "directory": "/home/a/.agentworkforce/probe/x",
            "collector_replacing": false, "collector_outdated": false, "needs_start": false,
            "journal_full": false, "stalled": false,
            "delivery": {"bootstrap_complete": true, "pending_records": 0, "acknowledged_records": 12},
            "sessions": {"total": 3, "shared": 2},
        });
        merge(&mut value, changes);
        let mut delivery = json!({
            "bootstrap_complete": false, "pending_records": 0, "acknowledged_records": 0,
            "skipped_records": 0, "quarantined_records": 0, "unqueued_changes": 0,
        });
        merge(&mut delivery, value["delivery"].take());
        value["delivery"] = delivery;
        let mut sessions = json!({"total": 0, "shared": 0, "excluded": 0});
        merge(&mut sessions, value["sessions"].take());
        value["sessions"] = sessions;
        crate::relay::contract::reader::result::<crate::relay::contract::method::UploaderStatus>(
            value,
        )
        .unwrap()
    }

    pub fn merge(base: &mut Value, changes: Value) {
        if let (Some(base), Value::Object(changes)) = (base.as_object_mut(), changes) {
            for (key, value) in changes {
                base.insert(key, value);
            }
        }
    }

    pub fn view(changes: Value) -> StatusView {
        StatusView::new(&status(changes))
    }

    pub fn row(changes: Value) -> UploadSession {
        let mut value = json!({
            "source": "codex", "session_id": "s", "title": "", "cwd": null, "git_branch": null,
            "first_activity_ms": null, "last_activity_ms": null, "is_agent": false,
            "included": false, "status": "not_shared",
        });
        merge(&mut value, changes);
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn titles_are_single_line_and_projects_are_the_folder() {
        let session = row(json!({"source": "codex", "session_id": "s1",
                                 "title": "First line\n  second", "cwd": "/home/a/Projects/relay/"}));
        assert_eq!(session_title(&session), "First line second");
        assert_eq!(session_project(&session), "relay");
        assert_eq!(session_key(&session), "codex:s1");
        assert_eq!(session_title(&row(json!({"title": "  "}))), "s");
        assert_eq!(session_project(&row(json!({"cwd": "/"}))), "");
        assert_eq!(session_project(&row(json!({}))), "");
    }

    #[test]
    fn status_wording_and_search() {
        let checking = row(json!({"included": true, "status": "checking"}));
        assert_eq!(SessionUploadState::of(&checking, None).title(), "Checking…");
        // A status this build does not know reads as the registry's fallback.
        let future = crate::relay::contract::reader::result::<
            crate::relay::contract::method::UploaderSessionsPreview,
        >(json!({"sessions": [{
            "source": "codex", "session_id": "a", "title": "", "cwd": null, "git_branch": null,
            "first_activity_ms": null, "last_activity_ms": null, "is_agent": false,
            "included": true, "status": "new_thing"}]}))
        .unwrap();
        assert_eq!(
            SessionUploadState::of(&future.sessions[0], None).title(),
            "Status unavailable"
        );
        let session = row(json!({"source": "claude", "session_id": "a", "title": "Fix login"}));
        assert!(session_matches(&session, "LOGIN"));
        assert!(session_matches(&session, "claude"));
        assert!(session_matches(&session, "claude:a"));
        assert!(session_matches(&session, " "));
        assert!(!session_matches(&session, "deploy"));
    }

    #[test]
    fn each_stage_is_named() {
        for (stage, headline) in [
            ("not_running", "Not running"),
            ("paused", "Paused"),
            ("needs_attention", "Needs attention"),
            ("offline", "Offline — retrying"),
            ("uploading", "Uploading…"),
            ("up_to_date", "Up to date"),
        ] {
            assert_eq!(view(json!({"stage": stage})).headline, headline);
        }
        assert_eq!(
            view(json!({"stage": "needs_attention"})).detail.as_deref(),
            Some("Uploads need attention.")
        );
    }

    #[test]
    fn the_cores_sentence_is_the_detail() {
        let attention =
            view(json!({"stage": "needs_attention", "stage_message": "Free up disk space."}));
        assert_eq!(attention.detail.as_deref(), Some("Free up disk space."));
        let retrying = view(json!({"stage": "uploading",
                                   "stage_message": "Server is slow; retrying. 42 sent, 17 queued."}));
        assert_eq!(
            retrying.detail.as_deref(),
            Some("Server is slow; retrying. 42 sent, 17 queued.")
        );
        let with_skip = view(json!({
            "stage": "uploading", "stage_message": "Server is slow; retrying. 42 sent, 17 queued.",
            "delivery": {"acknowledged_records": 42, "pending_records": 17, "skipped_records": 1},
        }));
        assert_eq!(
            with_skip.detail.as_deref(),
            Some(
                "Server is slow; retrying. 42 sent, 17 queued. 1 record was skipped during upload."
            )
        );
    }

    #[test]
    fn preparing_says_why() {
        let upgrading = view(json!({"stage": "preparing", "upgrading": true}));
        assert_eq!(upgrading.headline, "Upgrading local history");
        assert!(upgrading.upgrading);
        let replacing = view(json!({"stage": "preparing", "collector_replacing": true}));
        assert_eq!(replacing.headline, "Replacing the uploader");
        let first = view(json!({"stage": "preparing", "delivery": {"bootstrap_complete": false}}));
        assert_eq!(first.headline, "Preparing uploads");
        assert_eq!(
            first.detail.as_deref(),
            Some("Preparing enabled sessions. Upload completion has not been confirmed yet.")
        );
        assert_eq!(
            view(json!({"stage": "preparing"})).headline,
            "Checking for updates"
        );
    }

    #[test]
    fn progress_and_skipped_records() {
        let view_ = view(json!({"stage": "uploading", "delivery": {
            "acknowledged_records": 3, "pending_records": 1, "skipped_records": 2}}));
        assert_eq!((view_.total(), view_.progress()), (4, 0.75));
        assert_eq!(
            view_.detail.as_deref(),
            Some("2 records were skipped during upload.")
        );
        assert_eq!(view(json!({"delivery": {}})).progress(), 0.0);
    }

    #[test]
    fn conflict_is_named_and_counted_while_other_records_continue() {
        let conflict = view(json!({"stage": "conflict", "delivery": {
            "pending_records": 2, "quarantined_records": 1}}));
        assert_eq!(conflict.headline, "Delivery conflict");
        assert_eq!(conflict.quarantined, 1);
        assert!(conflict
            .detail
            .unwrap()
            .starts_with("1 records quarantined after a receiver conflict."));
    }

    #[test]
    fn selected_mode_with_nothing_shared_asks_for_a_choice() {
        let choose =
            view(json!({"sharing_mode": "selected", "sessions": {"total": 4, "shared": 0}}));
        assert_eq!(choose.headline, "Choose sessions to upload");
        assert_eq!(
            choose.detail.as_deref(),
            Some("No sessions are enabled for upload. Select sessions below to get started.")
        );
        assert_eq!(choose.sharing_mode, SharingMode::Selected);
    }

    #[test]
    fn unknown_stage_reads_as_the_fallback_and_directory_is_kept() {
        let future = view(json!({"stage": "from_the_future"}));
        assert_eq!(future.stage, Stage::Offline);
        assert_eq!(future.headline, "Offline — retrying");
        assert_eq!(
            future.directory.as_deref(),
            Some("/home/a/.agentworkforce/probe/x")
        );
    }

    #[test]
    fn upload_activity_fills_upward_then_fades_without_claiming_percent() {
        assert_eq!(SessionUploadState::Local.icon_title(), "Local only");
        assert_eq!(SessionUploadState::Uploading.icon_title(), "Uploading…");
        assert_eq!(SessionUploadState::Uploaded.icon_title(), "Uploaded");
        assert_eq!(upload_activity_frame(0.0, false), (0.0, 0.85));
        assert_eq!(upload_activity_frame(0.75, false), (0.5, 0.85));
        assert_eq!(upload_activity_frame(1.5, false), (1.0, 0.85));
        assert!((upload_activity_frame(1.65, false).1 - 0.425).abs() < 0.001);
        assert!((upload_activity_frame(2.55, false).0 - 0.5).abs() < 0.001);
        for time in [0.0, 0.75, 1.5, 1.65, 2.55] {
            assert_eq!(upload_activity_frame(time, true), (1.0, 0.85));
        }
    }

    #[test]
    fn upload_states_and_filters() {
        let running = view(json!({}));
        let paused = view(json!({"paused": true}));
        let state = |changes: Value, status: &StatusView| {
            SessionUploadState::of(&row(changes), Some(status))
        };
        assert_eq!(
            state(json!({"status": "uploaded", "included": true}), &paused),
            SessionUploadState::Uploaded
        );
        assert_eq!(
            state(json!({"status": "not_shared"}), &running),
            SessionUploadState::Local
        );
        assert_eq!(
            state(json!({"status": "queued", "included": true}), &paused),
            SessionUploadState::Paused
        );
        assert_eq!(
            state(json!({"status": "shared", "included": true}), &running),
            SessionUploadState::Preparing
        );
        assert_eq!(
            state(
                json!({"status": "queued", "included": true}),
                &view(json!({"stage": "offline"}))
            ),
            SessionUploadState::Blocked
        );
        assert_eq!(
            SessionUploadState::Uploaded.symbol(),
            "checkmark.circle.fill"
        );
        assert_eq!(SessionUploadState::Queued.pipeline_progress(), Some(0.5));
        assert_eq!(SessionUploadState::Local.pipeline_progress(), None);
        assert!(SessionFilter::Pending.matches(SessionUploadState::Queued));
        assert!(!SessionFilter::Pending.matches(SessionUploadState::Checking));
        assert!(SessionFilter::Local.matches(SessionUploadState::Local));
        assert!(SessionFilter::All.matches(SessionUploadState::Unknown));
        assert_eq!(
            SessionFilter::ALL.map(SessionFilter::title),
            ["All sessions", "In progress", "Uploaded", "Not uploading"]
        );
    }

    #[test]
    fn upload_stages_offer_compacting_a_full_journal() {
        let full = view(json!({"journal_full": true}));
        let summary = UploadSummary::new(&full, &[], 0);
        let stages = upload_stages(true, 0, 0, false, None, Some(&full), Some(&summary), None);
        assert_eq!(
            stages.each_ref().map(|stage| stage.state),
            [
                StageState::Complete,
                StageState::Blocked,
                StageState::Blocked
            ]
        );
        assert_eq!(stages[2].action, Some(StageAction::Compact));
        let capture = CaptureProgress {
            phase: "scanning".into(),
            source: "codex".into(),
            processed_files: 5,
            total_files: Some(10),
            sessions_captured: 2,
        };
        let capturing = upload_stages(false, 0, 0, false, Some(&capture), None, None, None);
        assert_eq!(capturing[1].fraction, Some(0.5));
        assert!(capturing[1]
            .detail
            .contains("Codex: 5 of 10 files processed"));
        assert_eq!(capturing[2].detail, "Checking uploader…");
        assert_eq!(capture_headline(&capture), "Reading local history");
    }

    #[test]
    fn enabled_sessions_complete_once_history_is_ready() {
        let ready = view(json!({}));
        let summary = UploadSummary::new(&ready, &[], 0);
        let stages = upload_stages(true, 3, 0, false, None, Some(&ready), Some(&summary), None);
        assert_eq!(stages[2].state, StageState::Complete);
        assert_eq!(stages[2].fraction, Some(1.0));
        let waiting = upload_stages(false, 0, 0, false, None, Some(&ready), Some(&summary), None);
        assert_eq!(waiting[2].detail, "Waiting for prepared session content");
    }

    #[test]
    fn upload_summary_says_what_was_asked_for() {
        let ready = view(json!({}));
        let rows = [row(
            json!({"session_id": "a", "included": true, "status": "queued"}),
        )];
        assert_eq!(
            UploadSummary::new(&ready, &rows, 0).headline,
            "Waiting for upload confirmation"
        );
        let asked = UploadSummary::new(&ready, &rows, 1);
        assert_eq!(
            (
                asked.stage,
                asked.headline.as_str(),
                asked.selection.as_str()
            ),
            (Stage::Preparing, "Preparing 1 session", "1 session chosen")
        );
        let paused = UploadSummary::new(&view(json!({"stage": "paused"})), &rows, 2);
        assert_eq!(
            paused.detail,
            "Nothing is uploaded until you resume. Your upload selection is being prepared."
        );
    }

    #[test]
    fn sharing_modes_are_worded_in_settings_order() {
        assert_eq!(
            SHARING_DISPLAY_ORDER.map(SharingModeText::title),
            [
                "Only sessions I choose",
                "Automatically upload new sessions",
                "Automatically upload all sessions, past and future"
            ]
        );
        assert_eq!(
            SharingMode::All.confirmation_action(),
            "Upload all past and future sessions"
        );
    }

    #[test]
    fn cloud_links_take_the_id_as_one_segment() {
        assert_eq!(
            cloud_session_url("https://agentrelay.com/x?y", "a/b").as_deref(),
            Some("https://agentrelay.com/cloud/dashboard/sessions/a%2Fb")
        );
        assert_eq!(
            cloud_session_url("http://user:pw@localhost:8787", "s").as_deref(),
            Some("http://localhost:8787/cloud/dashboard/sessions/s")
        );
        assert!(cloud_session_url("ftp://x", "a").is_none());
        assert!(cloud_session_url("https://agentrelay.com", "").is_none());
    }

    #[test]
    fn only_uploaded_sessions_have_a_cloud_page() {
        let uploaded = row(json!({"session_id": "one", "included": true, "status": "uploaded"}));
        assert_eq!(
            uploaded_session_url("https://agentrelay.com", &uploaded).as_deref(),
            Some("https://agentrelay.com/cloud/dashboard/sessions/one")
        );
        let local = row(json!({"session_id": "one"}));
        assert!(uploaded_session_url("https://agentrelay.com", &local).is_none());
    }
}

/// A repeating upward activity sweep, not a measured delivery percentage.
pub fn upload_activity_frame(elapsed: f64, reduce_motion: bool) -> (f64, f64) {
    if reduce_motion {
        return (1.0, 0.85);
    }
    let phase = elapsed.max(0.0) % 1.8;
    let fill = (phase / 1.5).min(1.0);
    let opacity = 0.85
        * if phase <= 1.5 {
            1.0
        } else {
            (1.8 - phase) / 0.3
        };
    (fill, opacity)
}
