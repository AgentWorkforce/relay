//! The Agent Relay account and the probe's uploader.

use crate::relay::state::AccountStatus;
use crate::relay::uploader::{SharingMode, Stage};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// `account.status`, `account.sign_in` and the `sign_in` topic: the account
/// plus the link waiting for the person, if any.
#[derive(Clone, Debug, Default, PartialEq, Serialize, JsonSchema, Deserialize)]
pub struct SignInReport {
    #[serde(flatten)]
    pub account: AccountStatus,
    #[serde(flatten)]
    pub link: SignInLink,
}

/// The page a sign-in waits on; every field is null when none is.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, JsonSchema, Deserialize)]
pub struct SignInLink {
    pub verification_url: Option<String>,
    /// What the UI opens: the link with the code filled in.
    pub verification_url_complete: Option<String>,
    pub user_code: Option<String>,
    /// ISO-8601.
    pub expires_at: Option<String>,
    /// Seconds between device-approval polls.
    pub interval: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize)]
pub struct ConnectWorkspaceParams {
    /// The Agent Relay (Cloud) workspace, a UUID.
    pub workspace_id: String,
}

/// `uploader.status`: the probe's status plus the stage the core derives.
#[derive(Clone, Debug, PartialEq, Serialize, JsonSchema, Deserialize)]
pub struct UploaderStatus {
    pub running: bool,
    pub paused: bool,
    pub sharing_mode: SharingMode,
    /// Saved upload membership/exclusion changes, independent of counts and
    /// delivery progress. Absent while upgrading or with an older probe.
    #[serde(default)]
    pub upload_policy_revision: Option<i64>,
    /// The install's directory, which holds `collector.log`.
    pub directory: Option<String>,
    /// A newer collector is replacing the running one.
    pub collector_replacing: bool,
    /// The running collector is an older build.
    pub collector_outdated: bool,
    pub delivery: UploadDelivery,
    pub sessions: SessionCounts,
    pub stage: Stage,
    /// The probe's sentence for the stage, when it has one.
    pub stage_message: Option<String>,
    /// The collector should be (re)started.
    pub needs_start: bool,
    /// The last cycle found the local journal full; `uploader.compact`
    /// frees it.
    pub journal_full: bool,
    /// The collector is upgrading local history.
    pub upgrading: bool,
    /// Records have waited `delivery::SUSTAINED_FAILURE_MS` with no
    /// acknowledgement, whatever the failure, while the collector runs
    /// unpaused and is not being replaced or upgrading. The stage is then
    /// `needs_attention`, except that a receiver conflict keeps `conflict`
    /// and a failed cycle with no delivery failure keeps `offline`.
    pub stalled: bool,
}

/// The upload job's delivery counters.
#[derive(Clone, Debug, Default, PartialEq, Serialize, JsonSchema, Deserialize)]
pub struct UploadDelivery {
    /// Every session's backlog has been read once.
    pub bootstrap_complete: bool,
    pub pending_records: u64,
    pub acknowledged_records: u64,
    pub skipped_records: u64,
    /// Receiver-proven conflicts retained for inspection and repair.
    pub quarantined_records: u64,
    pub unqueued_changes: u64,
    pub last_acknowledged_ms: Option<i64>,
    /// Why delivery is failing, as a sentence.
    pub failure: Option<String>,
    /// Why delivery is failing, as a code.
    pub failure_code: Option<DeliveryFailureCode>,
    /// While `failure_code` is `authentication_required`: why renewing the
    /// upload sign-in from Agent Relay's own failed.
    pub renewal_failure: Option<RenewalFailureCode>,
    /// A failure that is not retried on its own stopped uploads; they wait
    /// for `uploader.retry`, a sign-in or an update.
    #[serde(default)]
    pub stopped: bool,
}

/// The allowlisted classes of a delivery failure.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryFailureCode {
    Transient,
    RateLimited,
    AuthenticationRequired,
    PermissionDenied,
    InvalidPayload,
    ReceiverRejected,
    UnsupportedEvidence,
    MappingVersionMismatch,
    DeliveryConflict,
}

/// Why the probe could not renew the upload sign-in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RenewalFailureCode {
    /// No Agent Relay sign-in with time left.
    NoCloudSession,
    /// Cloud refused the person or workspace, or issued no usable session.
    CloudRefused,
    /// Cloud did not answer, was rate limiting or was failing.
    CloudUnreachable,
    /// Cloud issued a session for another destination.
    WrongDestination,
}

/// How many local sessions there are, and how many are shared.
#[derive(Clone, Debug, Default, PartialEq, Serialize, JsonSchema, Deserialize)]
pub struct SessionCounts {
    pub total: u64,
    pub shared: u64,
    pub excluded: u64,
}

impl UploaderStatus {
    /// Reads the probe's `status --json` answer, with the derived fields
    /// (`uploader::with_derived`) and the install's `directory` merged in.
    pub fn from_probe(status: &Value) -> UploaderStatus {
        let flag = |value: &Value| value.as_bool().unwrap_or(false);
        let count = |value: &Value| value.as_i64().unwrap_or(0).max(0) as u64;
        let text = |value: &Value| value.as_str().map(str::to_string);
        let delivery = &status["delivery"];
        let sessions = &status["sessions"];
        UploaderStatus {
            running: flag(&status["running"]),
            paused: flag(&status["paused"]),
            sharing_mode: serde_json::from_value(status["sharing_mode"].clone())
                .unwrap_or(SharingMode::Selected),
            upload_policy_revision: status["upload_policy_revision"].as_i64(),
            directory: text(&status["directory"]),
            collector_replacing: flag(&status["collector_replacing"]),
            collector_outdated: flag(&status["collector_outdated"]),
            delivery: UploadDelivery {
                bootstrap_complete: flag(&delivery["bootstrap_complete"]),
                pending_records: count(&delivery["pending_records"]),
                acknowledged_records: count(&delivery["acknowledged_records"]),
                skipped_records: count(&delivery["skipped_records"]),
                quarantined_records: count(&delivery["quarantined_records"]),
                unqueued_changes: count(&delivery["unqueued_changes"]),
                last_acknowledged_ms: delivery["last_acknowledged_ms"].as_i64(),
                failure: crate::relay::uploader::failure_message(&delivery["failure"]),
                failure_code: serde_json::from_value(delivery["failure_code"].clone()).ok(),
                renewal_failure: serde_json::from_value(delivery["renewal_failure"].clone()).ok(),
                stopped: delivery["state"] == "blocked",
            },
            sessions: SessionCounts {
                total: count(&sessions["total"]),
                shared: count(&sessions["shared"]),
                excluded: count(&sessions["excluded"]),
            },
            stage: serde_json::from_value(status["stage"].clone()).unwrap_or(Stage::Offline),
            stage_message: text(&status["stage_message"]),
            needs_start: flag(&status["needs_start"]),
            journal_full: flag(&status["journal_full"]),
            upgrading: flag(&status["upgrading"]),
            stalled: flag(&status["stalled"]),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct UploaderStarted {
    pub running: bool,
    /// `false` when it was already running.
    pub started: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct UploaderPaused {
    pub paused: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct UploadsRetried {
    /// `false` when uploads were not stopped, so nothing changed.
    pub retried: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct JournalCompacted {
    pub removed_records: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct UploaderDisconnected {
    pub disconnected: bool,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize)]
pub struct SharingParams {
    pub mode: SharingMode,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct SharingChanged {
    pub sharing_mode: SharingMode,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize)]
pub struct PreviewParams {
    /// At most 100.
    pub limit: Option<usize>,
    /// Re-read local history rather than the probe's cache.
    #[serde(default)]
    pub refresh: bool,
}

/// `uploader.sessions.list`'s result.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct UploadSessions {
    pub sharing_mode: SharingMode,
    pub sessions: Vec<UploadSession>,
}

/// `uploader.sessions.preview`'s result, before any install exists.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct UploadPreview {
    pub sessions: Vec<UploadSession>,
}

/// One local session the uploader lists.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct UploadSession {
    /// Locally observed profile artwork supplied by RelayHistory.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar: Option<SessionAvatar>,
    pub source: String,
    pub session_id: String,
    /// The provider's profile/catalog title, else prompt, assistant text, or id.
    pub title: String,
    pub cwd: Option<String>,
    /// Stable local project identity. An empty value means the cwd is relay
    /// infrastructure; absence is kept for compatibility with older cores.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    pub git_branch: Option<String>,
    pub first_activity_ms: Option<i64>,
    pub last_activity_ms: Option<i64>,
    /// Started by an agent rather than a person.
    pub is_agent: bool,
    /// The app a person chats with the session in, when it is not the
    /// provider's own: `conductor` or `paseo`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    /// Latest model observed in a bounded transcript read, otherwise catalog models.
    #[serde(default)]
    pub models: Option<Vec<String>>,
    /// Explicit reasoning effort reported by the harness; absent means unknown.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    pub included: bool,
    pub status: UploadShareStatus,
}

/// Provider-native profile settings; desktop clients own rendering and motion.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, JsonSchema, Serialize)]
pub struct SessionAvatar {
    pub shape: Option<String>,
    pub color: Option<String>,
    pub image_data_url: Option<String>,
}

/// Where one session's upload stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-fallback" = "unknown"))]
pub enum UploadShareStatus {
    NotShared,
    Uploading,
    Queued,
    /// Not yet proven uploaded or waiting.
    Checking,
    Uploaded,
    Shared,
    #[serde(other)]
    Unknown,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize)]
pub struct SessionKeysParams {
    /// `source:session_id` keys.
    pub session_keys: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct SessionsUpdated {
    pub updated: usize,
}

/// Exact typed consent is validated by the core, helper, and Cloud service.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
pub struct ResetSessionsParams {
    pub confirmation: String,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
pub struct SessionsReset {
    pub reset: bool,
}

/// A bounded scan of matching catalog candidates in the requested global order.
/// Upload-state predicates are evaluated after bounded badge enrichment; an
/// empty page can still have a continuation. Cursors are revision-pinned.
#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct SessionQueryParams {
    #[serde(default)]
    pub query: String,
    #[serde(default)]
    pub presentation: Option<SessionQueryPresentation>,
    #[serde(default)]
    pub sort: String,
    #[serde(default)]
    pub ascending: bool,
    pub cursor: Option<String>,
    pub known_revision: Option<u64>,
    pub limit: Option<usize>,
    #[serde(default)]
    pub hidden: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct SessionQueryPage {
    /// Snapshot archive classification for only the rows returned on this page.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived_keys: Option<Vec<String>>,
    #[serde(default)]
    pub verification_pending: bool,
    #[serde(default)]
    pub unchanged: bool,
    pub sessions: Vec<UploadSession>,
    pub local_sessions: Vec<super::agents::LocalSession>,
    pub next_cursor: Option<String>,
    pub revision: u64,
    /// A request never inspects more than 200 candidates or returns over 256 KiB.
    pub candidates_scanned: usize,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct SessionFacetParams {
    pub cursor: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SessionFacetsPage {
    pub harnesses: Vec<String>,
    pub projects: Vec<String>,
    pub next_cursor: Option<String>,
    pub revision: u64,
}

/// Small client presentation inputs shared by global order and row display.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SessionQueryPresentation {
    #[serde(default)]
    pub idle_names: Vec<String>,
    #[serde(default)]
    pub relay_states: std::collections::BTreeMap<String, bool>,
    #[serde(default)]
    pub upload_states: std::collections::BTreeMap<String, bool>,
    #[serde(default)]
    pub preparing: Vec<String>,
}

impl SessionQueryParams {
    pub fn preparing(&self, key: &str) -> bool {
        self.presentation
            .as_ref()
            .is_some_and(|p| p.preparing.iter().any(|id| id == key))
    }
}
