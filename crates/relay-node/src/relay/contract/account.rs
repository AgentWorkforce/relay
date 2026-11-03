//! The Agent Relay account and its session uploader.

use crate::relay::state::AccountStatus;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// The install an uploader command acts on: the site, and the account and
/// workspace signed in there.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Target {
    pub site_url: String,
    pub account_id: Option<String>,
    pub workspace_id: Option<String>,
}

/// Which local sessions are uploaded.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
#[derive(clap::ValueEnum)]
#[schemars(extend("x-fallback" = "selected"))]
pub enum SharingMode {
    All,
    New,
    Selected,
}

impl SharingMode {
    pub fn as_str(self) -> &'static str {
        match self {
            SharingMode::All => "all",
            SharingMode::New => "new",
            SharingMode::Selected => "selected",
        }
    }
}

/// The upload state a person is shown: `not_running`, `paused`,
/// `needs_attention`, `conflict`, `offline`, `preparing`, `uploading` or
/// `up_to_date`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-fallback" = "offline"))]
pub enum Stage {
    NotRunning,
    Paused,
    NeedsAttention,
    Conflict,
    Offline,
    Preparing,
    Uploading,
    UpToDate,
}

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

/// Pinned destination for the credential-only hosted MCP header helper.
#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize)]
pub struct McpHeadersParams {
    pub site_url: String,
    pub workspace_id: String,
    pub account_id: String,
}

/// Sensitive response available only through the same-user local core socket.
/// Never included in status, subscriptions, diagnostics or telemetry.
#[derive(Clone, Deserialize, JsonSchema, Serialize)]
pub struct McpHeaders {
    pub headers: std::collections::BTreeMap<String, String>,
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
    /// The last Claude Code cloud-session listing. Absent before one has
    /// run or with an older probe.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude_cloud: Option<ClaudeCloudHealth>,
}

/// Health of the Claude Code cloud-session source, credential-free.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ClaudeCloudHealth {
    pub state: ClaudeCloudHealthState,
    /// Plain-language cause and next step when not working.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// When this source was last checked, in Unix milliseconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at_ms: Option<i64>,
    /// Its most recent successful listing, retained across later failures.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_success_ms: Option<i64>,
    /// The macOS OSStatus from a failed Keychain read, when one caused it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keychain_error_code: Option<i32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-fallback" = "checking"))]
pub enum ClaudeCloudHealthState {
    Working,
    Checking,
    Blocked,
    NeedsAttention,
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
    /// What the collector's last inspection of older ai-hist upload
    /// schedules found, when it was not clear: why `legacy_uploader_active`
    /// holds uploads, or why the inspection could not finish. Left out
    /// when empty, so an app reads its absence from an older core as none.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub legacy_schedule_jobs: Vec<LegacyScheduleJob>,
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
    /// An older managed ai-hist uploader is scheduled on this computer.
    /// Retried: uploads resume by themselves once it is removed.
    LegacyUploaderActive,
}

/// What the last inspection of older ai-hist upload schedules found, as
/// fixed labels; never a path or scheduler output.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum LegacyScheduleJob {
    /// `~/Library/LaunchAgents/com.ai-hist.push.plist` exists.
    LaunchdPlist,
    /// launchd has `com.ai-hist.push` loaded.
    LaunchdLoaded,
    /// The crontab has the `# ai-hist push (managed)` line.
    ManagedCron,
    LaunchdPlistStatusUnknown,
    LaunchdStatusUnknown,
    CronStatusUnknown,
    HomeUnavailable,
    LegacyInstallerUnsupported,
}

impl LegacyScheduleJob {
    /// The fixed label.
    pub fn as_str(self) -> &'static str {
        match self {
            LegacyScheduleJob::LaunchdPlist => "launchd-plist",
            LegacyScheduleJob::LaunchdLoaded => "launchd-loaded",
            LegacyScheduleJob::ManagedCron => "managed-cron",
            LegacyScheduleJob::LaunchdPlistStatusUnknown => "launchd-plist-status-unknown",
            LegacyScheduleJob::LaunchdStatusUnknown => "launchd-status-unknown",
            LegacyScheduleJob::CronStatusUnknown => "cron-status-unknown",
            LegacyScheduleJob::HomeUnavailable => "home-unavailable",
            LegacyScheduleJob::LegacyInstallerUnsupported => "legacy-installer-unsupported",
        }
    }
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
    /// The client that started the session, as the harness records it:
    /// Codex's `originator`, Claude's `entrypoint` (`claude-desktop` for a
    /// Claude app chat, `cli` for the terminal).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub originator: Option<String>,
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

/// How a sign-in gets its session.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, JsonSchema, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Flow {
    /// The browser through Cloud's login page, back to a loopback receiver.
    Browser,
    /// A device approval; a kept session is reused first.
    Device,
}

/// `account.sign_in`'s parameters.
#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct SignInRequest {
    pub site_url: Option<String>,
    pub workspace: Option<String>,
    pub sharing: SharingMode,
    #[serde(default)]
    pub acknowledge_uninspected_schedules: bool,
    pub flow: Option<Flow>,
    /// The browser identity provider; absent preserves the default login
    /// flow. Read by a core built with an account (the desktop's browser
    /// sign-in); this core's own device sign-in ignores it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<SignInProvider>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, JsonSchema, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SignInProvider {
    Google,
    Microsoft,
}

impl Flow {
    /// Desktop sign-in uses the browser and a PKCE loopback handoff on both platforms.
    /// Remote/headless callers can explicitly request the device flow.
    pub fn platform() -> Flow {
        Flow::Browser
    }
}
