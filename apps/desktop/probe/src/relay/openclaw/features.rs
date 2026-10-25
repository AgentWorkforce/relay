//! What the connected Gateway can do, read from its `hello-ok`: its
//! release (`server.version`), the protocol it agreed (3 before 2026.5.12,
//! 4 since) and its methods (`features.methods`, on every release since
//! 2026.3.13). Agent Relay supports every OpenClaw from 2026.3.13 on and
//! never sends a field the Gateway's closed schemas would reject.
use super::*;

/// An OpenClaw release, `YYYY.M.D`. A prerelease (`2026.8.1-beta.1`) sorts
/// before its release, so it is never credited with that release's
/// features.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Release(u32, u32, u32, bool);

impl Release {
    pub const fn new(year: u32, month: u32, day: u32) -> Release {
        Release(year, month, day, true)
    }

    pub fn parse(text: &str) -> Option<Release> {
        let text = text.trim().trim_start_matches('v');
        let (core, prerelease) = match text.split_once('-') {
            Some((core, _)) => (core, true),
            None => (text.split('+').next().unwrap_or(text), false),
        };
        let mut parts = core.split('.').map(|part| part.parse::<u32>().ok());
        let (Some(Some(year)), Some(Some(month)), Some(Some(day)), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return None;
        };
        (year >= 2000).then_some(Release(year, month, day, !prerelease))
    }
}

impl std::fmt::Display for Release {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let Release(year, month, day, release) = self;
        write!(
            f,
            "{year}.{month}.{day}{}",
            if *release { "" } else { "-pre" }
        )
    }
}

/// The releases where what Agent Relay uses changed.
pub(super) mod since {
    use super::Release;
    /// `sessions.create` (before it `chat.send` creates a session itself),
    /// and `sessions.list` rows with a run `status`.
    pub const SESSIONS_CREATE: Release = Release::new(2026, 3, 22);
    /// `sessions.list` rows say `hasActiveRun`.
    pub const LISTED_ACTIVE_RUN: Release = Release::new(2026, 5, 2);
    /// The first release that speaks protocol 4 (and only 4).
    pub const PROTOCOL_4: Release = Release::new(2026, 5, 12);
    /// A `chat.send` user turn carries `idempotencyKey: "<runId>:user"`.
    pub const USER_TURN_KEY: Release = Release::new(2026, 5, 26);
    /// `chat.history` says `sessionInfo.hasActiveRun`.
    pub const HISTORY_ACTIVE_RUN: Release = Release::new(2026, 6, 1);
    /// `chat.send` takes `suppressCommandInterpretation`.
    pub const SUPPRESS_COMMANDS: Release = Release::new(2026, 6, 5);
    /// Session limits: `permissionMode: "read-only"` and
    /// `toolOverrides.mcpServers`.
    pub const SESSION_LIMITS: Release = Release::new(2026, 8, 1);
    /// `sessions.create` takes `displayName`.
    pub const DISPLAY_NAME: Release = Release::new(2026, 9, 1);
}

/// The release from which a Gateway limits relay sessions, as the apps
/// name it.
pub const LIMITS_FROM: &str = "2026.8.1";

/// How a Gateway tells that a session is still running a turn.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ActiveRun {
    /// `chat.history`'s `sessionInfo.hasActiveRun`.
    History,
    /// The session's `sessions.list` row.
    Listed,
    /// Neither: the session's history and `agent.wait` on its last run.
    Waited,
}

/// What Agent Relay may use on the connected Gateway.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Features {
    /// `server.version`, as the Gateway reported it.
    pub version: String,
    /// The protocol the Gateway agreed to.
    pub protocol: u64,
    pub sessions_create: bool,
    /// Whether a relay sender's session can be made answer-only.
    pub session_limits: bool,
    pub display_name: bool,
    pub suppress_commands: bool,
    pub user_turn_key: bool,
    /// `sessions.list` rows say `status: "running"` (from 2026.3.22).
    pub listed_status: bool,
    /// The agent timeout a run has unless `openclaw.json` sets one: ten
    /// minutes on 2026.3.13, 48 hours from 2026.3.22.
    pub default_timeout_s: u64,
    pub active_run: ActiveRun,
    /// When the Gateway started, from its uptime at connect: a turn sent
    /// before then is no longer running.
    pub started_at_ms: Option<u64>,
}

pub(super) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default()
}

impl Features {
    /// What a `hello-ok` offers. A version that is not a release (a source
    /// build) counts as the oldest release consistent with the protocol and
    /// methods it reports.
    pub fn from_hello(hello: &Value) -> Features {
        let version = hello["server"]["version"]
            .as_str()
            .unwrap_or_default()
            .trim()
            .to_string();
        let protocol = hello["protocol"].as_u64().unwrap_or(3);
        let methods = hello["features"]["methods"].as_array();
        let has = |method: &str| {
            methods.is_none_or(|methods| methods.iter().any(|listed| listed == method))
        };
        let release = Release::parse(&version).unwrap_or(if protocol >= 4 {
            since::PROTOCOL_4
        } else if has("sessions.create") {
            since::SESSIONS_CREATE
        } else {
            Release::new(2026, 3, 13)
        });
        let at = |since: Release| release >= since;
        let active_run = if at(since::HISTORY_ACTIVE_RUN) {
            ActiveRun::History
        } else if at(since::LISTED_ACTIVE_RUN) && has("sessions.list") {
            ActiveRun::Listed
        } else {
            ActiveRun::Waited
        };
        Features {
            version,
            protocol,
            sessions_create: at(since::SESSIONS_CREATE) && has("sessions.create"),
            session_limits: at(since::SESSION_LIMITS)
                && has("sessions.create")
                && has("sessions.patch"),
            display_name: at(since::DISPLAY_NAME),
            suppress_commands: at(since::SUPPRESS_COMMANDS),
            user_turn_key: at(since::USER_TURN_KEY),
            listed_status: at(since::SESSIONS_CREATE) && has("sessions.list"),
            default_timeout_s: if at(since::SESSIONS_CREATE) {
                48 * 60 * 60
            } else {
                600
            },
            active_run,
            started_at_ms: hello["snapshot"]["uptimeMs"]
                .as_u64()
                .map(|uptime| now_ms().saturating_sub(uptime)),
        }
    }

    /// The version as the apps name it.
    pub fn named_version(&self) -> String {
        if self.version.is_empty() {
            "on this computer".into()
        } else {
            self.version.clone()
        }
    }
}

/// The last Gateway this core connected to, shared by every clone of an
/// [`OpenClawConfig`] so Settings can say what it can do without
/// connecting, and tell the apps when that changes.
#[derive(Clone, Default)]
pub struct Seen {
    features: Arc<Mutex<Option<Features>>>,
    changed: Arc<Mutex<Option<crate::relay::settings_watch::SettingsChanged>>>,
}

impl Seen {
    /// Records the Gateway just connected to; a change in what Settings
    /// shows of it (its version, or whether it can limit relay sessions)
    /// publishes a Settings invalidation.
    pub(super) fn record(&self, features: &Features) {
        let shown = |f: &Features| (f.version.clone(), f.session_limits);
        let before = {
            let mut seen = self
                .features
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            seen.replace(features.clone())
        };
        if before.as_ref().map(shown) != Some(shown(features)) {
            self.notify();
        }
    }

    pub fn get(&self) -> Option<Features> {
        self.features
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    pub(super) fn on_change(&self, changed: crate::relay::settings_watch::SettingsChanged) {
        *self
            .changed
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(changed);
    }

    fn notify(&self) {
        let changed = self
            .changed
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        if let Some(changed) = changed {
            changed();
        }
    }
}
