//! TelemetryOperation telemetry to PostHog: a closed vocabulary of operations,
//! outcomes and failure codes, so message and session text, searches, paths,
//! URLs, credentials and helper output never become analytics properties.
//! No autocapture, no GeoIP.
//!
//! The core owns the whole pipeline: the opt-out, the identity, rate limits,
//! error deduplication and a bounded in-memory queue drained by one sender
//! thread. Delivery is best effort: no disk queue, no retries of operation
//! events, and a failed send is never itself reported.
//!
//! Identity:
//!
//! | State | `distinct_id` | Person and groups |
//! |---|---|---|
//! | No install attached | `desktop:<installation id>` | `$process_person_profile: false` |
//! | Install attaches | one `$identify` from `desktop:<installation id>` (`$anon_distinct_id`) to Cloud `users.id` | merges the installation's earlier events into the user |
//! | Attached | Cloud `users.id` | `$groups: {organization, workspace}` |
//!
//! The merge is recorded only after PostHog accepts `$identify`, so a failed
//! one is sent again with the next event. A merged installation id belongs
//! to its user: a relaunch keeps using it until discovery decides, and
//! sign-out, opt-out, discovery finding no install and another user all
//! replace it.
//!
//! Storage:
//!
//! | | Opt-out (`{"analytics_enabled": bool}`) | Installation id (a UUID) | Merged user |
//! |---|---|---|---|
//! | Linux | `$XDG_CONFIG_HOME/com.agentrelay.desktop/preferences.json` | `$XDG_CACHE_HOME/com.agentrelay.desktop/installation-id` | `…/analytics-identified` beside it |
//! | macOS | `<app data dir>/preferences.json` | `<app data dir>/installation-id` | `<app data dir>/analytics-identified` |
//!
//! The opt-out sits in config so clearing caches never re-enables analytics.
//! Telemetry is on unless the preference says `false`.

mod envelope;
mod posthog;
pub use posthog::PostHogProject;

use crate::relay::agents::SettingsExtension;
use crate::relay::app_store::APP_ID;
use crate::relay::uploader::SharingMode;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime};

/// The `settings.get`/`settings.set` key for the opt-out.
pub const SETTING: &str = "analytics_enabled";
const PREFERENCES_FILE: &str = "preferences.json";
const IDENTITY_FILE: &str = "installation-id";
const IDENTIFIED_FILE: &str = "analytics-identified";
/// TelemetryOperation events per rolling minute; exceptions ride along uncounted.
const EVENTS_PER_WINDOW: u32 = 100;
const WINDOW: Duration = Duration::from_secs(60);
/// How long an identical failure is reported only as an operation event.
const EXCEPTION_DEDUPE: Duration = Duration::from_secs(60);
/// Events waiting for the sender; newer events are dropped beyond this.
const QUEUE_LIMIT: usize = 200;
const MAX_SESSION_COUNT: i64 = 100_000;
const SEND_TIMEOUT: Duration = Duration::from_secs(10);

macro_rules! vocabulary {
    ($(#[doc = $doc:literal])* $name:ident { $($variant:ident = $text:literal),* $(,)? }) => {
        $(#[doc = $doc])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
        pub enum $name { $($variant),* }

        impl $name {
            pub const ALL: &'static [$name] = &[$($name::$variant),*];

            pub fn as_str(self) -> &'static str {
                match self { $($name::$variant => $text),* }
            }

            pub fn parse(text: &str) -> Option<$name> {
                match text { $($text => Some($name::$variant),)* _ => None }
            }
        }

        impl serde::Serialize for $name {
            fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.serialize_str(self.as_str())
            }
        }

        impl<'de> serde::Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let text = String::deserialize(deserializer)?;
                $name::parse(&text).ok_or_else(|| {
                    serde::de::Error::unknown_variant(&text, &[$($text),*])
                })
            }
        }

        impl schemars::JsonSchema for $name {
            fn schema_name() -> std::borrow::Cow<'static, str> {
                stringify!($name).into()
            }

            fn json_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
                let docs: &[&str] = &[$($doc),*];
                let description = docs.join("\n").trim().to_string();
                let mut schema = schemars::json_schema!({"type": "string", "enum": [$($text),*]});
                if !description.is_empty() {
                    schema.insert("description".into(), description.into());
                }
                schema
            }
        }
    };
}

vocabulary!(
    /// What the person (or the app on their behalf) did.
    TelemetryOperation {
        AppLaunch = "app_launch",
        ConnectionLink = "connection_link",
        DiscoverInstall = "discover_install",
        SignIn = "sign_in",
        BrowserApproval = "browser_approval",
        HistorySetup = "history_setup",
        RefreshStatus = "refresh_status",
        StartUploader = "start_uploader",
        RefreshSessions = "refresh_sessions",
        PauseUploader = "pause_uploader",
        ResumeUploader = "resume_uploader",
        RetryUploads = "retry_uploads",
        CompactJournal = "compact_journal",
        IncludeSessions = "include_sessions",
        ExcludeSessions = "exclude_sessions",
        SharingMode = "sharing_mode",
        UploadHealth = "upload_health",
        LaunchAtLogin = "launch_at_login",
        Disconnect = "disconnect",
        Settings = "settings",
        OpenLogs = "open_logs",
    }
);

vocabulary!(
    TelemetryOutcome {
        Started = "started",
        Succeeded = "succeeded",
        Failed = "failed",
        Cancelled = "cancelled",
        RequiresAction = "requires_action",
    }
);

vocabulary!(
    /// Why an operation failed, as a code; never the error's text.
    TelemetryFailure {
        HelperMissing = "helper_missing",
        HelperFailed = "helper_failed",
        MalformedOutput = "malformed_output",
        HistoryConnection = "history_connection",
        TimedOut = "timed_out",
        Unexpected = "unexpected",
        InvalidConnection = "invalid_connection",
        WorkspaceConflict = "workspace_conflict",
        UploadDelivery = "upload_delivery",
        UploadTransient = "upload_transient",
        UploadRateLimited = "upload_rate_limited",
        UploadAuthenticationRequired = "upload_authentication_required",
        UploadPermissionDenied = "upload_permission_denied",
        UploadInvalidPayload = "upload_invalid_payload",
        UploadReceiverRejected = "upload_receiver_rejected",
        UploadUnsupportedEvidence = "upload_unsupported_evidence",
        UploadMappingVersionMismatch = "upload_mapping_version_mismatch",
        UploadDeliveryConflict = "upload_delivery_conflict",
        UploadStalled = "upload_stalled",
        UploadCycle = "upload_cycle",
        ConnectionMissing = "connection_missing",
        SystemSetting = "system_setting",
        BrowserOpen = "browser_open",
        ScheduleInspection = "schedule_inspection",
    }
);

impl TelemetryOperation {
    /// Background polls: a repeated failure of one of these is dropped
    /// entirely while its exception is deduplicated, so polling never floods
    /// product analytics. Explicit attempts always count.
    fn is_polling(self) -> bool {
        matches!(
            self,
            TelemetryOperation::RefreshStatus
                | TelemetryOperation::RefreshSessions
                | TelemetryOperation::StartUploader
                | TelemetryOperation::UploadHealth
        )
    }
}

/// One operation to record: `telemetry.record`'s parameters. Only these
/// codes and numbers are ever sent.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize, serde::Serialize, schemars::JsonSchema,
)]
pub struct TelemetryEvent {
    pub operation: TelemetryOperation,
    pub outcome: TelemetryOutcome,
    pub failure: Option<TelemetryFailure>,
    pub count: Option<i64>,
    pub mode: Option<SharingMode>,
}

impl TelemetryEvent {
    pub fn new(operation: TelemetryOperation, outcome: TelemetryOutcome) -> TelemetryEvent {
        TelemetryEvent {
            operation,
            outcome,
            failure: None,
            count: None,
            mode: None,
        }
    }

    pub fn failure(mut self, failure: TelemetryFailure) -> TelemetryEvent {
        self.failure = Some(failure);
        self
    }

    pub fn count(mut self, count: i64) -> TelemetryEvent {
        self.count = Some(count);
        self
    }

    pub fn mode(mut self, mode: SharingMode) -> TelemetryEvent {
        self.mode = Some(mode);
        self
    }
}

/// The attached install's Cloud identity: `users.id`, with the organization
/// and workspace as PostHog groups.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TelemetryAccount {
    pub user_id: String,
    pub organization_id: Option<String>,
    pub workspace_id: Option<String>,
}

/// Delivers one batch of PostHog events. Called on the telemetry thread,
/// never on the async runtime.
pub trait TelemetrySender: Send + Sync + 'static {
    fn send(&self, batch: Vec<Value>) -> Result<(), String>;
}

/// PostHog's capture endpoint (`/i/v0/e/`) on the configured release host over
/// blocking HTTPS, one event per
/// request.
pub struct PostHogSender {
    project: PostHogProject,
    agent: ureq::Agent,
}

impl PostHogSender {
    pub fn new(project: PostHogProject) -> PostHogSender {
        let agent = ureq::AgentBuilder::new()
            .redirects(0)
            .timeout(SEND_TIMEOUT)
            .build();
        PostHogSender { project, agent }
    }
}

impl TelemetrySender for PostHogSender {
    fn send(&self, batch: Vec<Value>) -> Result<(), String> {
        let mut outcome = Ok(());
        for event in batch {
            let mut body = json!({"api_key": self.project.api_key});
            if let (Value::Object(body), Value::Object(event)) = (&mut body, event) {
                body.extend(event);
            }
            let sent = match self
                .agent
                .post(&format!("{}/i/v0/e/", self.project.host()))
                .send_json(body)
            {
                Ok(_) => Ok(()),
                Err(ureq::Error::Status(status, _)) => Err(format!("PostHog answered {status}.")),
                Err(ureq::Error::Transport(_)) => Err("PostHog could not be reached.".into()),
            };
            if outcome.is_ok() {
                outcome = sent;
            }
        }
        outcome
    }
}

pub type Clock = Arc<dyn Fn() -> SystemTime + Send + Sync>;
/// A monotonic clock: rate limits never follow a wall-clock change.
pub type Ticks = Arc<dyn Fn() -> Instant + Send + Sync>;

/// What telemetry reads from its surroundings, fixed at start.
#[derive(Clone)]
pub struct TelemetryConfig {
    pub app_data_dir: PathBuf,
    pub home: PathBuf,
    pub env: BTreeMap<String, String>,
    /// The desktop release, reported as the app and library version.
    pub version: String,
    /// Where events go; `None` records nothing and creates no identity.
    pub project: Option<PostHogProject>,
    /// Event timestamps.
    pub clock: Clock,
    /// Rate windows and error deduplication.
    pub ticks: Ticks,
}

impl std::fmt::Debug for TelemetryConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TelemetryConfig")
            .field("app_data_dir", &self.app_data_dir)
            .field("home", &self.home)
            .field("env", &self.env.keys().collect::<Vec<_>>())
            .field("version", &self.version)
            .field("project", &self.project)
            .finish_non_exhaustive()
    }
}

impl TelemetryConfig {
    /// The release project (none in debug builds) and the system clock.
    pub fn new(
        app_data_dir: PathBuf,
        home: PathBuf,
        env: BTreeMap<String, String>,
        version: String,
    ) -> TelemetryConfig {
        TelemetryConfig {
            app_data_dir,
            home,
            env,
            version,
            project: PostHogProject::bundled(),
            clock: Arc::new(SystemTime::now),
            ticks: Arc::new(Instant::now),
        }
    }

    fn xdg(&self, variable: &str, fallback: &str) -> PathBuf {
        self.env
            .get(variable)
            .map(|value| value.trim())
            .filter(|value| Path::new(value).is_absolute())
            .map(PathBuf::from)
            .unwrap_or_else(|| self.home.join(fallback))
    }

    /// An earlier GTK app kept `preferences.json` in the cache directory;
    /// a choice made there (an opt-out) carries over once.
    fn import_cached_preferences(&self, preferences: &Path) {
        let cached = self
            .xdg("XDG_CACHE_HOME", ".cache")
            .join(APP_ID)
            .join(PREFERENCES_FILE);
        if preferences.exists() || !cached.is_file() {
            return;
        }
        if let Ok(bytes) = std::fs::read(&cached) {
            if write_file(preferences, &bytes).is_ok() {
                let _ = std::fs::remove_file(&cached);
            }
        }
    }

    fn preferences_path(&self) -> PathBuf {
        if cfg!(target_os = "macos") {
            return self.app_data_dir.join(PREFERENCES_FILE);
        }
        self.xdg("XDG_CONFIG_HOME", ".config")
            .join(APP_ID)
            .join(PREFERENCES_FILE)
    }

    fn identity_path(&self) -> PathBuf {
        if cfg!(target_os = "macos") {
            return self.app_data_dir.join(IDENTITY_FILE);
        }
        self.xdg("XDG_CACHE_HOME", ".cache")
            .join(APP_ID)
            .join(IDENTITY_FILE)
    }

    fn identified_path(&self) -> PathBuf {
        self.identity_path().with_file_name(IDENTIFIED_FILE)
    }
}

/// One queued request. `merges` names the user and installation id a
/// `$identify` links, recorded once PostHog accepts it.
struct Queued {
    event: Value,
    merges: Option<(String, String)>,
}

#[derive(Default)]
struct State {
    /// The person's choice, read once and changed only by `set_enabled`,
    /// under this lock so no event is queued after an opt-out returns.
    enabled: bool,
    queue: VecDeque<Queued>,
    sending: bool,
    shutdown: bool,
    window_start: Option<Instant>,
    window_count: u32,
    recent_errors: HashMap<(TelemetryOperation, TelemetryFailure), Instant>,
    identity: Option<String>,
    /// The attached install's account; events belong to it.
    account: Option<TelemetryAccount>,
    /// The user the installation id was merged into, as saved.
    identified: Option<String>,
    /// A `$identify` is queued or on the wire.
    identifying: bool,
}

struct Shared {
    state: Mutex<State>,
    changed: Condvar,
    /// Where the merged user is saved.
    identified: PathBuf,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }
}

/// The telemetry pipeline. Dropping the last handle stops its thread and
/// discards anything unsent.
pub struct Telemetry {
    config: TelemetryConfig,
    preferences: PathBuf,
    identity: PathBuf,
    os_version: String,
    shared: Arc<Shared>,
}

impl std::fmt::Debug for Telemetry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Telemetry")
            .field("config", &self.config)
            .finish_non_exhaustive()
    }
}

impl Telemetry {
    pub fn new(config: TelemetryConfig, sender: Arc<dyn TelemetrySender>) -> Arc<Telemetry> {
        let preferences = config.preferences_path();
        if cfg!(not(target_os = "macos")) {
            config.import_cached_preferences(&preferences);
        }
        let enabled = read_preferences(&preferences)
            .get(SETTING)
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let identified = config.identified_path();
        let shared = Arc::new(Shared {
            state: Mutex::new(State {
                enabled,
                identified: std::fs::read_to_string(&identified)
                    .ok()
                    .map(|text| text.trim().to_string())
                    .filter(|text| !text.is_empty()),
                ..State::default()
            }),
            changed: Condvar::new(),
            identified,
        });
        let worker = shared.clone();
        if let Err(error) = std::thread::Builder::new()
            .name("relay-telemetry".into())
            .spawn(move || drain(&worker, sender.as_ref()))
        {
            crate::relay::diagnostics::write(format_args!("relay: telemetry is off: {error}"));
        }
        Arc::new(Telemetry {
            preferences,
            identity: config.identity_path(),
            os_version: os_version(),
            config,
            shared,
        })
    }

    /// The release pipeline: `config.project` over PostHog, or nothing.
    pub fn production(config: TelemetryConfig) -> Arc<Telemetry> {
        let sender: Arc<dyn TelemetrySender> = match &config.project {
            Some(project) => Arc::new(PostHogSender::new(project.clone())),
            None => Arc::new(NoSender),
        };
        Telemetry::new(config, sender)
    }

    /// Whether the person allows analytics. On unless they turned it off.
    pub fn enabled(&self) -> bool {
        self.shared.lock().enabled
    }

    /// Whether this build may request Cloud profile synchronization. Development
    /// builds and alternate sites have no project and must stay silent too.
    pub fn profile_sync_enabled(&self) -> bool {
        self.config.project.is_some() && self.enabled()
    }

    /// Persists the choice. Turning analytics off discards queued events and
    /// forgets the installation id, so turning it back on starts a new one;
    /// while an install is attached, that one is merged into its user again.
    pub fn set_enabled(&self, enabled: bool) -> std::io::Result<()> {
        let mut preferences = read_preferences(&self.preferences);
        preferences.insert(SETTING.into(), Value::Bool(enabled));
        let mut bytes = serde_json::to_vec(&Value::Object(preferences)).expect("json");
        bytes.push(b'\n');
        write_file(&self.preferences, &bytes)?;
        {
            let mut state = self.shared.lock();
            state.enabled = enabled;
            if !enabled {
                state.queue.clear();
            }
        }
        if !enabled {
            let mut state = self.shared.lock();
            self.rotate(&mut state);
        }
        Ok(())
    }

    /// Sign-out: forgets the account and the installation id, so the next
    /// event starts a new anonymous identity.
    pub fn reset_identity(&self) {
        let mut state = self.shared.lock();
        state.account = None;
        self.rotate(&mut state);
    }

    /// Links later events to the attached install's user, or (with `None`,
    /// when discovery finds no install) to a fresh installation id. An
    /// installation id merged into a user belongs to that user: it is
    /// replaced before events go out unattached or for another user.
    pub fn attach(&self, account: Option<TelemetryAccount>) {
        let mut state = self.shared.lock();
        let previous = state
            .identified
            .clone()
            .or_else(|| state.account.as_ref().map(|a| a.user_id.clone()));
        if previous.is_some_and(|previous| account.as_ref().map(|a| &a.user_id) != Some(&previous))
        {
            self.rotate(&mut state);
        }
        state.account = account;
        if self.identify_if_needed(&mut state) {
            drop(state);
            self.shared.changed.notify_all();
        }
    }

    /// A new installation id, with nothing merged and nothing queued for the
    /// old one.
    fn rotate(&self, state: &mut State) {
        state.identity = None;
        state.identified = None;
        state.identifying = false;
        state.recent_errors.clear();
        state.queue.retain(|queued| queued.merges.is_none());
        for path in [&self.identity, &self.shared.identified] {
            if let Err(error) = std::fs::remove_file(path) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    crate::relay::diagnostics::write(format_args!("relay: could not remove a telemetry id: {error}"));
                }
            }
        }
    }

    /// Queues the `$identify` that merges the installation id into the
    /// attached user, unless it is merged or one is already on its way.
    fn identify_if_needed(&self, state: &mut State) -> bool {
        if self.config.project.is_none() || state.shutdown || !state.enabled || state.identifying {
            return false;
        }
        let Some(account) = state.account.clone() else {
            return false;
        };
        if state.identified.as_deref() == Some(account.user_id.as_str()) {
            return false;
        }
        let anonymous = self.identity(state);
        let mut properties = self.base_properties(Some(&account));
        properties.insert(
            "$anon_distinct_id".into(),
            format!("desktop:{anonymous}").into(),
        );
        state.identifying = true;
        state.queue.push_back(Queued {
            event: json!({
                "event": "$identify",
                "distinct_id": account.user_id,
                "timestamp": self.timestamp(),
                "properties": properties,
            }),
            merges: Some((account.user_id, anonymous)),
        });
        true
    }

    fn timestamp(&self) -> String {
        chrono::DateTime::<chrono::Utc>::from((self.config.clock)())
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
    }

    /// The bridge method `telemetry.record`.
    pub fn record(&self, event: TelemetryEvent) {
        if self.config.project.is_none() {
            return;
        }
        let date = (self.config.ticks)();
        let mut state = self.shared.lock();
        if state.shutdown || !state.enabled {
            return;
        }
        let window_open = state
            .window_start
            .is_some_and(|start| elapsed(start, date) < WINDOW);
        if !window_open {
            state.window_start = Some(date);
            state.window_count = 0;
        }
        if state.window_count >= EVENTS_PER_WINDOW {
            return;
        }
        let mut capture_exception = false;
        if let Some(failure) = event.failure {
            let fingerprint = (event.operation, failure);
            capture_exception = state
                .recent_errors
                .get(&fingerprint)
                .is_none_or(|last| elapsed(*last, date) >= EXCEPTION_DEDUPE);
            if !capture_exception && event.operation.is_polling() {
                return;
            }
            if capture_exception {
                state.recent_errors.insert(fingerprint, date);
            }
        }
        state.window_count += 1;
        self.identify_if_needed(&mut state);
        let account = state.account.clone();
        let distinct_id = match &account {
            Some(account) => account.user_id.clone(),
            None => format!("desktop:{}", self.identity(&mut state)),
        };
        let timestamp = self.timestamp();

        let mut object = self.base_properties(account.as_ref());
        object.insert("operation".into(), event.operation.as_str().into());
        object.insert("outcome".into(), event.outcome.as_str().into());
        if let Some(count) = event.count {
            object.insert(
                "session_count".into(),
                count.clamp(0, MAX_SESSION_COUNT).into(),
            );
        }
        if let Some(mode) = event.mode {
            object.insert("sharing_mode".into(), mode.as_str().into());
        }
        if let Some(failure) = event.failure {
            object.insert("error_code".into(), failure.as_str().into());
        }
        let mut properties = Value::Object(object);
        let envelope = |name: &str, properties: &Value| {
            json!({
                "event": name,
                "distinct_id": distinct_id,
                "timestamp": timestamp,
                "properties": properties,
            })
        };
        let mut events = vec![envelope("desktop_operation", &properties)];
        if let (Some(failure), true) = (event.failure, capture_exception) {
            let (operation, code) = (event.operation.as_str(), failure.as_str());
            let object = properties.as_object_mut().expect("object");
            object.insert("$exception_level".into(), "error".into());
            object.insert(
                "$exception_fingerprint".into(),
                format!("desktop:{operation}:{code}").into(),
            );
            object.insert(
                "$exception_list".into(),
                json!([{
                    "type": "DesktopOperationError",
                    "value": format!("{operation}: {code}"),
                    "mechanism": {"type": "handled", "handled": true, "synthetic": true},
                }]),
            );
            events.push(envelope("$exception", &properties));
        }
        for event in events {
            if state.queue.len() < QUEUE_LIMIT {
                state.queue.push_back(Queued {
                    event,
                    merges: None,
                });
            }
        }
        drop(state);
        self.shared.changed.notify_all();
    }

    /// Waits until everything queued has been handed to the sender, or the
    /// timeout passes. True when nothing is left.
    pub fn flush(&self, timeout: Duration) -> bool {
        let state = self.shared.lock();
        let (state, _) = self
            .shared
            .changed
            .wait_timeout_while(state, timeout, |state| {
                !state.shutdown && (state.sending || !state.queue.is_empty())
            })
            .unwrap_or_else(|poison| poison.into_inner());
        !state.sending && state.queue.is_empty()
    }

    /// The installation id, created on first use. An id that cannot be
    /// saved still serves this run.
    fn identity(&self, state: &mut State) -> String {
        if let Some(identity) = &state.identity {
            return identity.clone();
        }
        let identity = std::fs::read_to_string(&self.identity)
            .ok()
            .and_then(|text| parse_uuid(text.trim()))
            .unwrap_or_else(|| {
                let fresh = new_uuid();
                if let Err(error) = write_file(&self.identity, format!("{fresh}\n").as_bytes()) {
                    crate::relay::diagnostics::write(format_args!("relay: could not save the telemetry id: {error}"));
                }
                fresh
            });
        state.identity = Some(identity.clone());
        identity
    }
}

impl Drop for Telemetry {
    fn drop(&mut self) {
        let mut state = self.shared.lock();
        state.shutdown = true;
        state.queue.clear();
        drop(state);
        self.shared.changed.notify_all();
    }
}

impl SettingsExtension for Telemetry {
    fn get(&self) -> Map<String, Value> {
        let mut settings = Map::new();
        settings.insert(SETTING.into(), Value::Bool(self.enabled()));
        settings
    }

    fn set(&self, key: &str, value: &Value) -> Option<Result<(), String>> {
        if key != SETTING {
            return None;
        }
        let Some(enabled) = value.as_bool() else {
            return Some(Err("analytics_enabled must be true or false.".into()));
        };
        Some(
            self.set_enabled(enabled)
                .map_err(|_| "The analytics setting could not be saved.".to_string()),
        )
    }
}

struct NoSender;

impl TelemetrySender for NoSender {
    fn send(&self, _batch: Vec<Value>) -> Result<(), String> {
        Ok(())
    }
}

/// The sender thread: one request at a time. An accepted `$identify` saves
/// its merge, unless the identity moved on while it was on the wire; a
/// refused one is queued again by the next event.
fn drain(shared: &Shared, sender: &dyn TelemetrySender) {
    loop {
        let mut state = shared.lock();
        while state.queue.is_empty() && !state.shutdown {
            state = shared
                .changed
                .wait(state)
                .unwrap_or_else(|poison| poison.into_inner());
        }
        if state.shutdown {
            return;
        }
        // One event at a time, so an opt-out stops everything after the
        // request already on the wire.
        let Some(Queued { event, merges }) = state.queue.pop_front() else {
            continue;
        };
        state.sending = true;
        drop(state);
        let sent = sender.send(vec![event]).is_ok();
        let mut state = shared.lock();
        state.sending = false;
        if let Some((user, anonymous)) = merges {
            let current = state.account.as_ref().map(|a| a.user_id.as_str()) == Some(user.as_str())
                && state.identity.as_deref() == Some(anonymous.as_str())
                && state.identifying;
            if current {
                state.identifying = false;
                if sent {
                    if let Err(error) =
                        write_file(&shared.identified, format!("{user}\n").as_bytes())
                    {
                        crate::relay::diagnostics::write(format_args!("relay: could not save the telemetry merge: {error}"));
                    }
                    state.identified = Some(user);
                }
            }
        }
        drop(state);
        shared.changed.notify_all();
    }
}

fn elapsed(earlier: Instant, later: Instant) -> Duration {
    later.saturating_duration_since(earlier)
}

fn platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(windows) {
        "windows"
    } else {
        "linux"
    }
}

fn read_preferences(path: &Path) -> Map<String, Value> {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|value| match value {
            Value::Object(map) => Some(map),
            _ => None,
        })
        .unwrap_or_default()
}

fn write_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = path.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(parent)?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    std::io::Write::write_all(&mut temporary, bytes)?;
    temporary.persist(path).map_err(|error| error.error)?;
    Ok(())
}

/// A lowercase hyphenated UUID, or `None` for anything else.
fn parse_uuid(text: &str) -> Option<String> {
    let groups: Vec<&str> = text.split('-').collect();
    let shape = [8, 4, 4, 4, 12];
    (groups.len() == 5
        && groups.iter().zip(shape).all(|(group, length)| {
            group.len() == length && group.bytes().all(|byte| byte.is_ascii_hexdigit())
        }))
    .then(|| text.to_ascii_lowercase())
}

/// A random (version 4) UUID.
fn new_uuid() -> String {
    let mut bytes = [0u8; 16];
    if getrandom::getrandom(&mut bytes).is_err() {
        let nanos = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
            ^ u128::from(std::process::id());
        bytes = nanos.to_le_bytes();
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// `major.minor.patch` on macOS, the kernel release on Linux.
fn os_version() -> String {
    #[cfg(target_os = "macos")]
    {
        let mut buffer = [0u8; 64];
        let mut length = buffer.len();
        // SAFETY: the name is NUL-terminated and `length` is the buffer's size.
        let status = unsafe {
            libc::sysctlbyname(
                c"kern.osproductversion".as_ptr(),
                buffer.as_mut_ptr().cast(),
                &mut length,
                std::ptr::null_mut(),
                0,
            )
        };
        if status != 0 {
            return String::new();
        }
        let text = &buffer[..length.min(buffer.len())];
        let text = text.split(|byte| *byte == 0).next().unwrap_or_default();
        String::from_utf8_lossy(text).into_owned()
    }
    #[cfg(windows)]
    {
        windows_version().unwrap_or_default()
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // SAFETY: `uname` fills a zeroed struct of the right type.
        let mut name: libc::utsname = unsafe { std::mem::zeroed() };
        if unsafe { libc::uname(&mut name) } != 0 {
            return String::new();
        }
        // SAFETY: `release` is NUL-terminated after a successful `uname`.
        let release = unsafe { std::ffi::CStr::from_ptr(name.release.as_ptr()) };
        release.to_string_lossy().chars().take(80).collect()
    }
}

/// `major.minor.build` on Windows (`10.0.26100`), from the registry values
/// `winver` shows; `GetVersionEx` reports the version the app was
/// manifested for instead.
#[cfg(windows)]
fn windows_version() -> Option<String> {
    use windows_sys::Win32::System::Registry::{
        RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_DWORD, RRF_RT_REG_SZ,
    };
    let wide = |text: &str| text.encode_utf16().chain([0]).collect::<Vec<u16>>();
    let key = wide(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion");
    let number = |name: &str| -> Option<u32> {
        let name = wide(name);
        let (mut value, mut size) = (0u32, std::mem::size_of::<u32>() as u32);
        // SAFETY: NUL-terminated names and a `u32` sized out buffer.
        let status = unsafe {
            RegGetValueW(
                HKEY_LOCAL_MACHINE,
                key.as_ptr(),
                name.as_ptr(),
                RRF_RT_REG_DWORD,
                std::ptr::null_mut(),
                (&mut value as *mut u32).cast(),
                &mut size,
            )
        };
        (status == 0).then_some(value)
    };
    let build = {
        let name = wide("CurrentBuildNumber");
        let mut buffer = [0u16; 32];
        let mut size = std::mem::size_of_val(&buffer) as u32;
        // SAFETY: NUL-terminated names and `size` bytes of out buffer.
        let status = unsafe {
            RegGetValueW(
                HKEY_LOCAL_MACHINE,
                key.as_ptr(),
                name.as_ptr(),
                RRF_RT_REG_SZ,
                std::ptr::null_mut(),
                buffer.as_mut_ptr().cast(),
                &mut size,
            )
        };
        if status != 0 {
            return None;
        }
        let units = (size as usize / 2).min(buffer.len());
        let text = String::from_utf16_lossy(&buffer[..units]);
        text.trim_end_matches('\0').to_string()
    };
    Some(format!(
        "{}.{}.{build}",
        number("CurrentMajorVersionNumber")?,
        number("CurrentMinorVersionNumber")?
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    trait RecordParams {
        fn record_params(&self, params: Value) -> Result<(), crate::relay::protocol::RpcError>;
    }

    /// `telemetry.record` as the bridge answers it.
    impl RecordParams for Telemetry {
        fn record_params(&self, params: Value) -> Result<(), crate::relay::protocol::RpcError> {
            self.record(crate::relay::contract::params(params)?);
            Ok(())
        }
    }

    /// Records every batch; refuses them unless told to accept.
    #[derive(Default)]
    struct FakeSender {
        batches: Mutex<Vec<Vec<Value>>>,
        accepts: std::sync::atomic::AtomicBool,
    }

    impl TelemetrySender for FakeSender {
        fn send(&self, batch: Vec<Value>) -> Result<(), String> {
            self.batches.lock().unwrap().push(batch);
            if self.accepts.load(std::sync::atomic::Ordering::SeqCst) {
                Ok(())
            } else {
                Err("offline".into())
            }
        }
    }

    impl FakeSender {
        fn events(&self) -> Vec<Value> {
            self.batches.lock().unwrap().concat()
        }

        fn named(&self, name: &str) -> usize {
            self.events()
                .iter()
                .filter(|event| event["event"] == name)
                .count()
        }
    }

    struct Fixture {
        _dir: tempfile::TempDir,
        home: PathBuf,
        sender: Arc<FakeSender>,
        now: Arc<Mutex<SystemTime>>,
        start: Instant,
        offset: Arc<Mutex<Duration>>,
    }

    impl Fixture {
        fn new() -> Fixture {
            let dir = tempfile::tempdir().unwrap();
            Fixture {
                home: dir.path().to_path_buf(),
                _dir: dir,
                sender: Arc::new(FakeSender::default()),
                now: Arc::new(Mutex::new(
                    SystemTime::UNIX_EPOCH + Duration::from_secs(100),
                )),
                start: Instant::now(),
                offset: Arc::default(),
            }
        }

        fn config(&self) -> TelemetryConfig {
            let now = self.now.clone();
            TelemetryConfig {
                app_data_dir: self.home.join("data"),
                home: self.home.clone(),
                env: BTreeMap::new(),
                version: "1.2.3".into(),
                project: PostHogProject::new("phc_test", "https://analytics.example.com"),
                clock: Arc::new(move || *now.lock().unwrap()),
                ticks: {
                    let (start, offset) = (self.start, self.offset.clone());
                    Arc::new(move || start + *offset.lock().unwrap())
                },
            }
        }

        fn telemetry(&self) -> Arc<Telemetry> {
            Telemetry::new(self.config(), self.sender.clone())
        }

        fn advance(&self, seconds: u64) {
            *self.now.lock().unwrap() += Duration::from_secs(seconds);
            *self.offset.lock().unwrap() += Duration::from_secs(seconds);
        }

        fn accept(&self) {
            self.sender
                .accepts
                .store(true, std::sync::atomic::Ordering::SeqCst);
        }

        fn identified(&self) -> Option<String> {
            std::fs::read_to_string(self.config().identified_path())
                .ok()
                .map(|text| text.trim().to_string())
        }

        fn events(&self, telemetry: &Telemetry) -> Vec<Value> {
            assert!(telemetry.flush(Duration::from_secs(5)));
            self.sender.events()
        }
    }

    #[test]
    fn an_opt_out_kept_in_the_cache_directory_carries_over_once() {
        let home = tempfile::tempdir().unwrap();
        let config = TelemetryConfig::new(
            home.path().join("data"),
            home.path().to_path_buf(),
            BTreeMap::new(),
            "1.0.0".into(),
        );
        let cached = home
            .path()
            .join(".cache")
            .join(APP_ID)
            .join(PREFERENCES_FILE);
        std::fs::create_dir_all(cached.parent().unwrap()).unwrap();
        std::fs::write(&cached, br#"{"analytics_enabled":false}"#).unwrap();
        let preferences = home
            .path()
            .join(".config")
            .join(APP_ID)
            .join(PREFERENCES_FILE);
        config.import_cached_preferences(&preferences);
        assert_eq!(read_preferences(&preferences)[SETTING], Value::Bool(false));
        assert!(!cached.exists());
        // A choice already in the config directory is never overwritten.
        std::fs::write(&cached, br#"{"analytics_enabled":true}"#).unwrap();
        config.import_cached_preferences(&preferences);
        assert_eq!(read_preferences(&preferences)[SETTING], Value::Bool(false));
    }

    #[test]
    fn errors_use_the_error_tracking_schema_and_only_codes() {
        let fixture = Fixture::new();
        let telemetry = fixture.telemetry();
        telemetry
            .record_params(
                json!({"operation": "sign_in", "outcome": "failed", "failure": "helper_failed"}),
            )
            .unwrap();
        let events = fixture.events(&telemetry);
        let names: Vec<_> = events.iter().map(|event| event["event"].clone()).collect();
        assert_eq!(names, [json!("desktop_operation"), json!("$exception")]);
        let exception = &events[1]["properties"];
        assert_eq!(
            exception["$exception_list"][0]["value"],
            "sign_in: helper_failed"
        );
        assert_eq!(
            exception["$exception_list"][0]["mechanism"]["handled"],
            true
        );
        assert_eq!(
            exception["$exception_fingerprint"],
            "desktop:sign_in:helper_failed"
        );
        assert_eq!(exception["$process_person_profile"], false);
        assert_eq!(exception["$geoip_disable"], true);
        assert_eq!(exception["error_code"], "helper_failed");
        assert_eq!(exception["platform"], platform());
        assert_eq!(exception["$app_version"], "1.2.3");
        let distinct = events[0]["distinct_id"].as_str().unwrap();
        assert!(parse_uuid(distinct.strip_prefix("desktop:").unwrap()).is_some());
        assert_eq!(events[0]["timestamp"], "1970-01-01T00:01:40Z");
    }

    #[test]
    fn repeated_user_failures_keep_attempt_counts() {
        let fixture = Fixture::new();
        let telemetry = fixture.telemetry();
        let event = TelemetryEvent::new(TelemetryOperation::SignIn, TelemetryOutcome::Failed)
            .failure(TelemetryFailure::HistoryConnection);
        telemetry.record(event);
        telemetry.record(event);
        fixture.events(&telemetry);
        assert_eq!(fixture.sender.named("desktop_operation"), 2);
        assert_eq!(fixture.sender.named("$exception"), 1);
    }

    #[test]
    fn cancellation_is_an_outcome_not_an_error() {
        let fixture = Fixture::new();
        let telemetry = fixture.telemetry();
        telemetry.record(TelemetryEvent::new(
            TelemetryOperation::SignIn,
            TelemetryOutcome::Cancelled,
        ));
        let events = fixture.events(&telemetry);
        assert_eq!(events.len(), 1);
        assert!(events[0]["properties"].get("error_code").is_none());
    }

    #[test]
    fn polling_dedupe_expires_and_operation_counts_are_bounded() {
        let fixture = Fixture::new();
        let telemetry = fixture.telemetry();
        let poll = TelemetryEvent::new(TelemetryOperation::RefreshStatus, TelemetryOutcome::Failed)
            .failure(TelemetryFailure::HelperFailed);
        for _ in 0..1000 {
            telemetry.record(poll);
        }
        assert_eq!(fixture.events(&telemetry).len(), 2);
        fixture.advance(61);
        telemetry.record(poll);
        assert_eq!(fixture.events(&telemetry).len(), 4);
        let include = TelemetryEvent::new(
            TelemetryOperation::IncludeSessions,
            TelemetryOutcome::Succeeded,
        )
        .count(i64::MAX)
        .mode(SharingMode::Selected);
        for _ in 0..1000 {
            telemetry.record(include);
        }
        let events = fixture.events(&telemetry);
        assert_eq!(events.len(), 103);
        let properties = &events.last().unwrap()["properties"];
        assert_eq!(properties["session_count"], 100_000);
        assert_eq!(properties["sharing_mode"], "selected");
        fixture.advance(60);
        telemetry.record(include.count(-5));
        let events = fixture.events(&telemetry);
        assert_eq!(events.len(), 104);
        assert_eq!(events.last().unwrap()["properties"]["session_count"], 0);
    }

    #[test]
    fn no_project_records_nothing_and_creates_no_identity() {
        let fixture = Fixture::new();
        let mut config = fixture.config();
        config.project = None;
        let telemetry = Telemetry::new(config.clone(), fixture.sender.clone());
        telemetry.record(TelemetryEvent::new(
            TelemetryOperation::AppLaunch,
            TelemetryOutcome::Started,
        ));
        assert!(fixture.events(&telemetry).is_empty());
        assert!(!config.identity_path().exists());
    }

    #[test]
    fn only_project_keys_over_https_configure_a_project() {
        assert!(PostHogProject::new("phx_personal", "https://example.com").is_none());
        assert!(PostHogProject::new("phc_test", "http://example.com").is_none());
        assert!(PostHogProject::new("phc_te st", "https://example.com").is_none());
        assert!(PostHogProject::new("phc_test", "https://example.com/path").is_none());
        assert!(PostHogProject::new("phc_test", "https://user@example.com").is_none());
        assert_eq!(
            PostHogProject::new("phc_test", "https://example.com/")
                .unwrap()
                .host(),
            "https://example.com"
        );
        assert!(
            PostHogProject::bundled().is_none(),
            "debug builds never send, even if release variables are present"
        );
    }

    #[test]
    fn opt_out_persists_drops_queued_events_and_rotates_identity() {
        let fixture = Fixture::new();
        let telemetry = fixture.telemetry();
        telemetry.record(TelemetryEvent::new(
            TelemetryOperation::SignIn,
            TelemetryOutcome::Started,
        ));
        let initial = fixture.events(&telemetry)[0]["distinct_id"].clone();
        let identity = fixture.config().identity_path();
        assert!(identity.exists());

        telemetry.set_enabled(false).unwrap();
        telemetry.record(TelemetryEvent::new(
            TelemetryOperation::SignIn,
            TelemetryOutcome::Succeeded,
        ));
        assert_eq!(fixture.events(&telemetry).len(), 1);
        assert!(!identity.exists());
        assert!(
            !fixture.telemetry().enabled(),
            "the choice survives a restart"
        );

        telemetry.set_enabled(true).unwrap();
        telemetry.record(TelemetryEvent::new(
            TelemetryOperation::SignIn,
            TelemetryOutcome::Started,
        ));
        let events = fixture.events(&telemetry);
        assert_ne!(events.last().unwrap()["distinct_id"], initial);
    }

    #[test]
    fn identity_is_stable_across_launches_and_rotates_on_sign_out() {
        let fixture = Fixture::new();
        let first = fixture.telemetry();
        first.record(TelemetryEvent::new(
            TelemetryOperation::AppLaunch,
            TelemetryOutcome::Started,
        ));
        let initial = fixture.events(&first)[0]["distinct_id"].clone();
        drop(first);
        let next = fixture.telemetry();
        next.record(TelemetryEvent::new(
            TelemetryOperation::AppLaunch,
            TelemetryOutcome::Started,
        ));
        assert_eq!(
            fixture.events(&next).last().unwrap()["distinct_id"],
            initial
        );
        next.reset_identity();
        next.record(TelemetryEvent::new(
            TelemetryOperation::SignIn,
            TelemetryOutcome::Started,
        ));
        assert_ne!(
            fixture.events(&next).last().unwrap()["distinct_id"],
            initial
        );
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn linux_storage_matches_the_gtk_app_and_survives_cache_cleanup() {
        let fixture = Fixture::new();
        let mut config = fixture.config();
        let (cache, settings) = (fixture.home.join("cache"), fixture.home.join("config"));
        config
            .env
            .insert("XDG_CACHE_HOME".into(), cache.display().to_string());
        config
            .env
            .insert("XDG_CONFIG_HOME".into(), settings.display().to_string());
        let id = "0f8fad5b-d9cb-469f-a165-70867728950e";
        write_file(
            &cache.join(APP_ID).join(IDENTITY_FILE),
            format!("{id}\n").as_bytes(),
        )
        .unwrap();
        let telemetry = Telemetry::new(config.clone(), fixture.sender.clone());
        telemetry.record(TelemetryEvent::new(
            TelemetryOperation::AppLaunch,
            TelemetryOutcome::Started,
        ));
        assert_eq!(
            fixture.events(&telemetry)[0]["distinct_id"],
            format!("desktop:{id}")
        );
        telemetry.set_enabled(false).unwrap();
        let saved = std::fs::read_to_string(settings.join(APP_ID).join(PREFERENCES_FILE)).unwrap();
        assert_eq!(saved, "{\"analytics_enabled\":false}\n");
        std::fs::remove_dir_all(&cache).ok();
        assert!(!Telemetry::new(config, fixture.sender.clone()).enabled());
    }

    #[test]
    fn payload_carries_no_identity_or_session_content() {
        let fixture = Fixture::new();
        let telemetry = fixture.telemetry();
        let error = telemetry
            .record_params(json!({"operation": "sign_in", "outcome": "failed",
                "failure": "token=secret user@example.com /Users/person/session.json"}))
            .unwrap_err();
        assert_eq!(
            error.data.kind,
            crate::relay::protocol::ErrorKind::InvalidParams
        );
        assert!(!error.message.contains("secret"));
        telemetry
            .record_params(
                json!({"operation": "include_sessions", "outcome": "succeeded",
                "count": 3, "mode": "new", "session_id": "private", "account": "a@b.c"}),
            )
            .unwrap();
        let body = serde_json::to_string(&fixture.events(&telemetry)).unwrap();
        for forbidden in [
            "secret",
            "user@example",
            "/Users",
            "private",
            "a@b.c",
            "phc_test",
        ] {
            assert!(!body.contains(forbidden), "{forbidden}");
        }
    }

    #[test]
    fn telemetry_params_reject_unknown_values() {
        let fixture = Fixture::new();
        let telemetry = fixture.telemetry();
        for params in [
            json!([]),
            json!({"outcome": "started"}),
            json!({"operation": "launch_rockets", "outcome": "started"}),
            json!({"operation": "sign_in", "outcome": "exploded"}),
            json!({"operation": "sign_in", "outcome": "failed", "failure": "nope"}),
            json!({"operation": "sign_in", "outcome": "started", "mode": "some"}),
            json!({"operation": "sign_in", "outcome": "started", "count": 1.5}),
            json!({"operation": "sign_in", "outcome": "started", "count": "3"}),
            json!({"operation": 1, "outcome": "started"}),
        ] {
            assert!(telemetry.record_params(params.clone()).is_err(), "{params}");
        }
        assert!(fixture.events(&telemetry).is_empty());
        let event = crate::relay::contract::params::<TelemetryEvent>(json!({
            "operation": "sign_in", "outcome": "requires_action",
            "failure": "schedule_inspection", "count": null, "mode": null,
        }))
        .unwrap();
        assert_eq!(
            event,
            TelemetryEvent::new(TelemetryOperation::SignIn, TelemetryOutcome::RequiresAction)
                .failure(TelemetryFailure::ScheduleInspection)
        );
        for operation in TelemetryOperation::ALL {
            assert_eq!(
                TelemetryOperation::parse(operation.as_str()),
                Some(*operation)
            );
        }
    }

    #[test]
    fn settings_extension_exposes_analytics_enabled() {
        let fixture = Fixture::new();
        let telemetry = fixture.telemetry();
        let settings: &dyn SettingsExtension = telemetry.as_ref();
        assert_eq!(settings.get()[SETTING], true);
        assert_eq!(settings.set("direct_delivery", &json!(false)), None);
        assert!(matches!(settings.set(SETTING, &json!("no")), Some(Err(_))));
        assert_eq!(settings.get()[SETTING], true);
        assert_eq!(settings.set(SETTING, &json!(false)), Some(Ok(())));
        assert_eq!(settings.get()[SETTING], false);
        assert!(!telemetry.enabled());
    }

    #[test]
    fn a_failing_sender_does_not_stop_later_batches() {
        let fixture = Fixture::new();
        let telemetry = fixture.telemetry();
        telemetry.record(TelemetryEvent::new(
            TelemetryOperation::AppLaunch,
            TelemetryOutcome::Started,
        ));
        fixture.events(&telemetry);
        telemetry.record(TelemetryEvent::new(
            TelemetryOperation::OpenLogs,
            TelemetryOutcome::Started,
        ));
        fixture.events(&telemetry);
        assert_eq!(fixture.sender.batches.lock().unwrap().len(), 2);
    }

    fn account() -> TelemetryAccount {
        TelemetryAccount {
            user_id: "user_123".into(),
            organization_id: Some("org_456".into()),
            workspace_id: Some("ws_789".into()),
        }
    }

    fn launch() -> TelemetryEvent {
        TelemetryEvent::new(TelemetryOperation::AppLaunch, TelemetryOutcome::Started)
    }

    #[test]
    fn profile_sync_requires_a_configured_project_and_local_opt_in() {
        let fixture = Fixture::new();
        let telemetry = fixture.telemetry();
        assert!(telemetry.profile_sync_enabled());
        telemetry.set_enabled(false).unwrap();
        assert!(!telemetry.profile_sync_enabled());
        telemetry.set_enabled(true).unwrap();
        assert!(telemetry.profile_sync_enabled());
        let mut config = fixture.config();
        config.project = None;
        assert!(!Telemetry::new(config, fixture.sender.clone()).profile_sync_enabled());
    }

    #[test]
    fn identity_envelope_is_versioned_without_copying_cloud_profile_fields() {
        let fixture = Fixture::new();
        fixture.accept();
        let telemetry = fixture.telemetry();
        telemetry.record(launch());
        fixture.events(&telemetry);
        telemetry.attach(Some(account()));
        telemetry.record(launch());
        let events = fixture.events(&telemetry);
        assert_eq!(
            events[0]["properties"]["identity_source"],
            "anonymous_generation"
        );
        for event in &events {
            let properties = &event["properties"];
            assert_eq!(properties["analytics_contract_version"], 2);
            assert_eq!(properties["emitter"], "relay-desktop.core");
            assert_eq!(properties["actor_kind"], "human");
            assert_eq!(properties["surface"], "desktop");
            for field in ["email", "name", "$set", "$set_once"] {
                assert!(properties.get(field).is_none(), "{field}");
            }
        }
        assert_eq!(events[1]["properties"]["identity_source"], "cloud_install");
        assert_eq!(events[2]["properties"]["identity_source"], "cloud_install");
    }

    #[test]
    fn an_attached_install_is_identified_once_and_owns_later_events() {
        let fixture = Fixture::new();
        fixture.accept();
        let telemetry = fixture.telemetry();
        telemetry.record(launch());
        let anonymous = fixture.events(&telemetry)[0]["distinct_id"].clone();
        assert!(anonymous.as_str().unwrap().starts_with("desktop:"));
        assert_eq!(
            fixture.events(&telemetry)[0]["properties"]["$process_person_profile"],
            false
        );

        telemetry.attach(Some(account()));
        telemetry.attach(Some(account()));
        telemetry.record(TelemetryEvent::new(
            TelemetryOperation::HistorySetup,
            TelemetryOutcome::Succeeded,
        ));
        let events = fixture.events(&telemetry);
        let names: Vec<_> = events.iter().map(|event| event["event"].clone()).collect();
        assert_eq!(
            names,
            [
                json!("desktop_operation"),
                json!("$identify"),
                json!("desktop_operation")
            ]
        );
        let identify = &events[1];
        assert_eq!(identify["distinct_id"], "user_123");
        assert_eq!(identify["properties"]["$anon_distinct_id"], anonymous);
        let groups = json!({"organization": "org_456", "workspace": "ws_789"});
        assert_eq!(identify["properties"]["$groups"], groups);
        assert!(identify["properties"]
            .get("$process_person_profile")
            .is_none());
        assert_eq!(events[2]["distinct_id"], "user_123");
        assert_eq!(events[2]["properties"]["$groups"], groups);
        assert!(events[2]["properties"]
            .get("$process_person_profile")
            .is_none());
        assert_eq!(fixture.identified().as_deref(), Some("user_123"));

        // The next launch keeps the merged id and sends no second `$identify`.
        drop(telemetry);
        let relaunched = fixture.telemetry();
        relaunched.record(launch());
        relaunched.attach(Some(account()));
        relaunched.record(launch());
        let events = fixture.events(&relaunched);
        assert_eq!(events[3]["distinct_id"], anonymous);
        assert_eq!(events[4]["distinct_id"], "user_123");
        assert_eq!(fixture.sender.named("$identify"), 1);
    }

    #[test]
    fn a_refused_identify_is_sent_again_and_only_an_accepted_one_is_saved() {
        let fixture = Fixture::new();
        let telemetry = fixture.telemetry();
        telemetry.attach(Some(account()));
        fixture.events(&telemetry);
        assert_eq!(fixture.sender.named("$identify"), 1);
        assert_eq!(fixture.identified(), None);
        fixture.accept();
        telemetry.record(launch());
        let events = fixture.events(&telemetry);
        assert_eq!(events[1]["event"], "$identify");
        assert_eq!(events[2]["distinct_id"], "user_123");
        assert_eq!(fixture.identified().as_deref(), Some("user_123"));
    }

    #[test]
    fn sign_out_and_opt_out_rotate_back_to_anonymous() {
        let fixture = Fixture::new();
        fixture.accept();
        let telemetry = fixture.telemetry();
        telemetry.attach(Some(account()));
        let first = fixture.events(&telemetry)[0]["properties"]["$anon_distinct_id"].clone();
        telemetry.reset_identity();
        assert_eq!(fixture.identified(), None);
        telemetry.record(launch());
        let signed_out = fixture.events(&telemetry)[1].clone();
        assert_ne!(signed_out["distinct_id"], first);
        assert_eq!(signed_out["properties"]["$process_person_profile"], false);

        telemetry.attach(Some(account()));
        telemetry.set_enabled(false).unwrap();
        assert_eq!(fixture.identified(), None);
        assert!(!fixture.config().identity_path().exists());
        telemetry.record(launch());
        let before = fixture.events(&telemetry).len();
        // Back on while still attached: a new installation id, merged again.
        telemetry.set_enabled(true).unwrap();
        telemetry.record(launch());
        let events = fixture.events(&telemetry);
        assert_eq!(events.len(), before + 2);
        let identify = &events[before];
        assert_eq!(identify["event"], "$identify");
        assert_ne!(identify["properties"]["$anon_distinct_id"], first);
        assert_ne!(
            identify["properties"]["$anon_distinct_id"],
            signed_out["distinct_id"]
        );
        assert_eq!(events[before + 1]["distinct_id"], "user_123");
    }

    #[test]
    fn another_user_never_merges_the_previous_users_installation_id() {
        let fixture = Fixture::new();
        fixture.accept();
        let telemetry = fixture.telemetry();
        telemetry.attach(Some(account()));
        fixture.events(&telemetry);
        telemetry.attach(Some(TelemetryAccount {
            user_id: "user_b".into(),
            organization_id: None,
            workspace_id: None,
        }));
        let events = fixture.events(&telemetry);
        assert_eq!(events[1]["distinct_id"], "user_b");
        assert_ne!(
            events[0]["properties"]["$anon_distinct_id"],
            events[1]["properties"]["$anon_distinct_id"]
        );
        assert!(events[1]["properties"].get("$groups").is_none());
        assert_eq!(fixture.identified().as_deref(), Some("user_b"));
    }

    #[test]
    fn a_relaunch_keeps_the_merged_id_until_discovery_finds_no_install() {
        let fixture = Fixture::new();
        fixture.accept();
        let first = fixture.telemetry();
        first.attach(Some(account()));
        let merged = fixture.events(&first)[0]["properties"]["$anon_distinct_id"].clone();
        drop(first);

        let relaunched = fixture.telemetry();
        relaunched.record(launch());
        assert_eq!(fixture.events(&relaunched)[1]["distinct_id"], merged);
        // Discovery finds no install: the user's id is not reused unattached.
        relaunched.attach(None);
        relaunched.attach(None);
        relaunched.record(launch());
        let events = fixture.events(&relaunched);
        assert_ne!(events[2]["distinct_id"], merged);
        assert_eq!(events[2]["properties"]["$process_person_profile"], false);
        assert_eq!(fixture.identified(), None);
        // Later events stay on that new anonymous id.
        relaunched.attach(None);
        relaunched.record(launch());
        assert_eq!(
            fixture.events(&relaunched)[3]["distinct_id"],
            events[2]["distinct_id"]
        );
    }

    #[test]
    fn another_user_after_a_relaunch_never_inherits_the_merged_id() {
        let fixture = Fixture::new();
        fixture.accept();
        let first = fixture.telemetry();
        first.attach(Some(account()));
        let merged = fixture.events(&first)[0]["properties"]["$anon_distinct_id"].clone();
        drop(first);

        let relaunched = fixture.telemetry();
        relaunched.attach(Some(TelemetryAccount {
            user_id: "user_b".into(),
            organization_id: None,
            workspace_id: None,
        }));
        let identify = fixture.events(&relaunched)[1].clone();
        assert_eq!(identify["distinct_id"], "user_b");
        assert_ne!(identify["properties"]["$anon_distinct_id"], merged);
        assert_eq!(fixture.identified().as_deref(), Some("user_b"));
    }

    #[test]
    fn the_rate_window_follows_the_monotonic_clock() {
        let fixture = Fixture::new();
        let telemetry = fixture.telemetry();
        for _ in 0..100 {
            telemetry.record(launch());
        }
        // A wall-clock change neither opens nor extends the window.
        *fixture.now.lock().unwrap() += Duration::from_secs(3_600);
        telemetry.record(launch());
        assert_eq!(fixture.events(&telemetry).len(), 100);
        *fixture.offset.lock().unwrap() += Duration::from_secs(61);
        telemetry.record(launch());
        let events = fixture.events(&telemetry);
        assert_eq!(events.len(), 101);
        assert_eq!(events[100]["timestamp"], "1970-01-01T01:01:40Z");
    }

    #[test]
    fn uuids_are_version_four() {
        let id = new_uuid();
        assert_eq!(parse_uuid(&id).as_deref(), Some(id.as_str()));
        assert_eq!(&id[14..15], "4");
        assert!(parse_uuid("not-a-uuid").is_none());
        assert_eq!(
            parse_uuid("0F8FAD5B-D9CB-469F-A165-70867728950E").as_deref(),
            Some("0f8fad5b-d9cb-469f-a165-70867728950e")
        );
    }
}
