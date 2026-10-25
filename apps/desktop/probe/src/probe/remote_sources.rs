//! Remote source connectors: provider-native cloud sessions enumerated and
//! hydrated in-process through `history-provider-sources`' public request
//! surface, then landed through `SessionStore`'s transport-free source
//! intake. Provider credentials never reach the probe's own state — each
//! connector resolves them from the provider's own CLI sign-in:
//!
//! - `devin-cloud` (Devin cloud sessions) through the helper's request
//!   surface, exactly as the SDK's helper process does;
//! - `claude-web` (Claude Code cloud sessions on claude.ai) through the same
//!   connector driven with an explicit home, so the login can come from the
//!   macOS Keychain (see [`super::claude_cloud`]).
//!
//! Connectors fail apart: one that cannot list or read never stops another
//! one or the local pass it rides, and a connector whose last listing failed
//! is left alone until the next listing is due.
mod claude_cloud;
mod claude_records;
mod diagnostic;
mod hydrate;
mod pacing;
mod sweep;
mod withhold;

use agent_relay_probe::relay::claude_dirs;
use ai_hist::{
    NormalizedSourceEvidence, ObservationKey, SessionLocation, SessionStore,
    SourceEvidenceSubmission, SourceObservation, SourceObservationBatch,
};
use anyhow::{Context, Result};
use claude_records::*;
pub use diagnostic::{report_enumeration, report_sweep};
use history_provider_sources::discover::DiscoveryEnv;
use history_provider_sources::remote::{
    remote_connector_statuses_at, CLAUDE_WEB_CONNECTOR, DEVIN_CLOUD_CONNECTOR,
};
use hydrate::*;
pub use hydrate::{hydrate, hydrate_reader};
use pacing::{ConnectorFailure, Failure, Pacing};
use serde_json::Value;
use std::cell::OnceCell;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::Duration;
pub use sweep::sweep;
#[cfg(test)]
use sweep::*;
use withhold::*;

/// The connectors probe composes, connector id → the catalog source its
/// evidence lands under. A connector joins this list only when probe can
/// explain its reach to a person.
const CONNECTORS: &[(&str, &str)] = &[
    (DEVIN_CLOUD_CONNECTOR, "devin"),
    (CLAUDE_WEB_CONNECTOR, "claude"),
];

/// One connector instance per connector today — the provider CLIs sign in
/// one account at a time.
const INSTANCE: &str = "default";

/// Remote enumeration is a provider API round trip. It rides the shallow
/// inventory's cadence but runs at most this often per database.
const ENUMERATE_INTERVAL: Duration = Duration::from_secs(300);

/// The codes a connector failure keeps, as the helper's request surface
/// keeps them; the provider's own detail never leaves the connector.
const ERROR_CODES: &[&str] = &[
    "INVALID_ARGUMENT",
    "CONNECTOR_NOT_CONFIGURED",
    "AUTHENTICATION_EXPIRED",
    "PERMISSION_DENIED",
    "SESSION_NOT_FOUND",
    "EVIDENCE_PARTIAL",
    "CONNECTOR_FAILURE",
];

/// Where connector calls run: the person's home, the probe data folder a
/// private Claude login may be written under, and the Keychain it may come
/// from (shared by every host in the process, so its one pending read is).
pub(crate) struct Host<'a> {
    home: &'a Path,
    data_dir: PathBuf,
    keychain: claude_cloud::Keychain,
    /// Whether Claude Code's login may be used. Never in tests through the
    /// system host: a test whose store reads the real home would list and
    /// read this machine's claude.ai sessions.
    claude: bool,
}

impl<'a> Host<'a> {
    fn system(home: &'a Path, db: &Path) -> Self {
        Self {
            home,
            data_dir: db
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| home.join(".agentworkforce/probe")),
            keychain: claude_cloud::system_keychain(),
            claude: !cfg!(test),
        }
    }
}

/// Whether one connector can run here.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Reach {
    Ready,
    /// Signed in, but not usable: reported, never run.
    Unusable(&'static str),
    /// Not signed in: absent, the way a `--all` selection treats it —
    /// nothing is run, asked for or reported.
    Absent,
}

/// Whether the person shares Claude Code's own `~/.claude` folder — the
/// login `claude-web` lists cloud sessions with. A folder turned off in
/// Settings keeps that account's cloud sessions off the relay too.
fn claude_login_shared(home: &Path) -> bool {
    let env = |key: &str| std::env::var(key).ok();
    claude_dirs::cloud_sessions_shared(&env, home)
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn reach(host: &Host, connector: &str) -> Reach {
    match connector {
        CLAUDE_WEB_CONNECTOR => {
            if !host.claude || !claude_login_shared(host.home) {
                return Reach::Absent;
            }
            match claude_cloud::choose(host.home, host.keychain.source(), now_ms()) {
                claude_cloud::Login::File | claude_cloud::Login::Keychain => Reach::Ready,
                claude_cloud::Login::Expired => Reach::Unusable(claude_cloud::EXPIRED),
                claude_cloud::Login::Unreadable => Reach::Unusable(claude_cloud::UNREADABLE),
                claude_cloud::Login::Missing => Reach::Absent,
            }
        }
        _ => {
            let configured = remote_connector_statuses_at(host.home)
                .into_iter()
                .any(|status| status.connector == connector && status.configured);
            if configured {
                Reach::Ready
            } else {
                Reach::Absent
            }
        }
    }
}

fn reaches(host: &Host) -> Vec<(&'static str, &'static str, Reach)> {
    CONNECTORS
        .iter()
        .map(|(id, source)| (*id, *source, reach(host, id)))
        .collect()
}

/// The connectors that may run now: ready, and — when `db` is given —
/// whose last listing on `db` did not fail inside the current interval.
fn ready(host: &Host, db: Option<&Path>) -> Vec<(&'static str, &'static str)> {
    let held = db.map(held_back).unwrap_or_default();
    reaches(host)
        .into_iter()
        .filter(|(id, _, reach)| *reach == Reach::Ready && !held.contains(*id))
        .map(|(id, source, _)| (id, source))
        .collect()
}

/// One pass's connector calls. The Claude login is prepared once, on first
/// use — one Keychain read per pass however many sessions it reads — and
/// removed when the pass ends. A Keychain read still unanswered leaves
/// Claude not ready for the whole pass.
struct Pass<'h, 'a> {
    host: &'h Host<'a>,
    /// Who the pass runs for: a capture pass, or a person opening a session.
    ask: claude_cloud::Ask,
    claude: OnceCell<Result<claude_cloud::CredentialHome, &'static str>>,
}

/// A Claude login that cannot be used, as the plain reason the diagnostic
/// records.
#[derive(Debug)]
struct Unready(&'static str);

impl std::fmt::Display for Unready {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}

impl std::error::Error for Unready {}

/// Whether `error` is Claude's Keychain login not ready for this pass: its
/// read still waiting for an answer, or a quiet read refused because the
/// person has not chosen Always Allow. Either way, try again later: neither
/// a failure nor a reason to hold the connector back or to count a session
/// as captured, so access granted in Settings is used on the next pass.
pub fn keychain_not_ready(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        matches!(
            cause.downcast_ref::<Unready>(),
            Some(Unready(reason))
                if *reason == claude_cloud::KEYCHAIN_WAITING
                    || *reason == claude_cloud::KEYCHAIN_DENIED
        )
    })
}

/// The error a hydration returns while Claude's Keychain read waits.
#[cfg(test)]
pub fn keychain_waiting_error() -> anyhow::Error {
    Unready(claude_cloud::KEYCHAIN_WAITING).into()
}

impl<'h, 'a> Pass<'h, 'a> {
    fn new(host: &'h Host<'a>) -> Self {
        Self {
            host,
            ask: claude_cloud::Ask::Pass,
            claude: OnceCell::new(),
        }
    }

    /// A pass a person asked for by opening a session.
    fn asked(host: &'h Host<'a>) -> Self {
        Self {
            ask: claude_cloud::Ask::Person,
            ..Self::new(host)
        }
    }

    fn claude_home(&self) -> Result<&Path> {
        match self.claude.get_or_init(|| {
            claude_cloud::prepare(
                self.host.home,
                &self.host.data_dir,
                &self.host.keychain,
                now_ms(),
                self.ask,
            )
        }) {
            Ok(prepared) => Ok(prepared.home()),
            Err(reason) => Err(Unready(reason).into()),
        }
    }

    /// The home a connector call runs under: a Claude login's private home,
    /// the person's own for every other connector.
    fn connector_home(&self, connector: &str) -> Result<&Path> {
        if connector == CLAUDE_WEB_CONNECTOR {
            self.claude_home()
        } else {
            Ok(self.host.home)
        }
    }

    /// One connector's listing, as source observations.
    fn discover(&self, connector: &str) -> Result<Vec<SourceObservation>> {
        let home = self.connector_home(connector)?;
        direct(connector, || {
            let provider = history_provider_sources::remote::provider(
                home,
                connector,
                INSTANCE,
                Some(10_000),
            )?;
            provider.check_available(home)?;
            // Enumeration takes the public engine context; this ephemeral
            // connection cannot touch the catalog.
            let conn = rusqlite::Connection::open_in_memory()?;
            let env = DiscoveryEnv::with_roots(
                &conn,
                home.to_path_buf(),
                home.join("unused-opencode.db"),
            );
            let mut observations = Vec::new();
            for candidate in provider.enumerate(&env, Some(10_000))? {
                if let Some(mut session) = provider.read_shallow(&env.scan(), None, &candidate)? {
                    session.source_stamp = Some(candidate.stamp.clone());
                    session.locations = vec!["remote".into()];
                    observations.push(SourceObservation {
                        session,
                        raw_locator: Some(candidate.locator),
                    });
                }
            }
            Ok(observations)
        })
    }

    /// One session's evidence through its connector.
    fn acquire(
        &self,
        connector: &str,
        observation: ai_hist::SessionObservation,
    ) -> Result<NormalizedSourceEvidence> {
        let home = self.connector_home(connector)?;
        direct(connector, || {
            anyhow::ensure!(
                observation.access_state == "available",
                "SESSION_NOT_FOUND: observation unavailable"
            );
            let provider =
                history_provider_sources::remote::provider(home, connector, INSTANCE, None)?;
            provider.check_available(home)?;
            let evidence = adopt_cloud_session_id(
                provider.acquire(home, &observation)?,
                &observation.key.session_id,
            );
            ai_hist::sources::normalize_source_evidence(
                provider.source(),
                &observation.key.session_id,
                evidence,
            )
        })
    }
}

/// A connector driven directly, its failure erased to the helper's code
/// plus a safe message, as the helper's request surface erases it.
fn direct<T>(connector: &str, run: impl FnOnce() -> Result<T>) -> Result<T> {
    run().map_err(|error| {
        let message = error.to_string();
        let code = ERROR_CODES
            .iter()
            .copied()
            .find(|code| message.starts_with(code) && message[code.len()..].starts_with(':'))
            .unwrap_or("CONNECTOR_FAILURE");
        // Pacing needs to tell a throttled provider from a session that
        // cannot be read; it learns that here, before the detail is erased.
        anyhow::Error::new(ConnectorFailure {
            code,
            connector: connector.to_string(),
            failure: pacing::classify(&format!("{error:#}")),
        })
    })
}

/// What one connector's listing did, as the remote diagnostic records it.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ConnectorReport {
    pub connector: String,
    /// `listed`, `failed` or `unavailable`.
    pub state: String,
    #[serde(default)]
    pub sessions: usize,
    /// A plain reason for `failed` and `unavailable`; never provider detail.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// What one enumeration pass did, per connector.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Enumeration {
    pub connectors: Vec<ConnectorReport>,
}

impl Enumeration {
    pub fn rows(&self) -> usize {
        self.connectors.iter().map(|c| c.sessions).sum()
    }

    pub fn failed(&self) -> usize {
        self.connectors
            .iter()
            .filter(|c| c.state == "failed")
            .count()
    }

    pub fn json(&self) -> Value {
        serde_json::to_value(&self.connectors).unwrap_or(Value::Null)
    }
}

/// The plain reason a connector failed. A Claude login that could not be
/// used says why; anything else keeps only its code.
fn failure_reason(connector: &str, error: &anyhow::Error) -> String {
    if let Some(Unready(reason)) = error.downcast_ref::<Unready>() {
        return (*reason).to_string();
    }
    let message = error.to_string();
    let code = ERROR_CODES
        .iter()
        .copied()
        .find(|code| message.starts_with(code))
        .unwrap_or("CONNECTOR_FAILURE");
    match (connector, code) {
        (CLAUDE_WEB_CONNECTOR, "AUTHENTICATION_EXPIRED") => claude_cloud::EXPIRED.to_string(),
        _ => format!("The provider request failed ({code})."),
    }
}

/// Enumerate each connector apart and land its rows in `store`'s catalog
/// under the connector's identity — the observation rows a later
/// [`hydrate`] fences against. A connector that fails is recorded and the
/// others still run.
fn enumerate_ready(pass: &Pass, store: &SessionStore) -> Result<Enumeration> {
    let mut report = Enumeration::default();
    for (connector, source, reach) in reaches(pass.host) {
        let entry = |state: &str, sessions: usize, reason: Option<String>| ConnectorReport {
            connector: connector.to_string(),
            state: state.to_string(),
            sessions,
            reason,
        };
        match reach {
            Reach::Absent => {}
            Reach::Unusable(reason) => {
                report
                    .connectors
                    .push(entry("unavailable", 0, Some(reason.to_string())))
            }
            Reach::Ready => match enumerate_one(pass, store, connector, source)? {
                Ok(rows) => report.connectors.push(entry("listed", rows, None)),
                // Not ready, like an unusable sign-in: reported, not held
                // back, so the next pass looks for the answer again.
                Err(error) if keychain_not_ready(&error) => report.connectors.push(entry(
                    "unavailable",
                    0,
                    Some(failure_reason(connector, &error)),
                )),
                Err(error) => report.connectors.push(entry(
                    "failed",
                    0,
                    Some(failure_reason(connector, &error)),
                )),
            },
        }
    }
    Ok(report)
}

/// One connector's listing landed in the catalog. The inner error is the
/// provider's, reported per connector; the outer one is this machine's
/// (the catalog or the delivery database) and fails the pass.
fn enumerate_one(
    pass: &Pass,
    store: &SessionStore,
    connector: &'static str,
    source: &str,
) -> Result<Result<usize>> {
    let observations = match pass.discover(connector) {
        Ok(observations) => observations,
        Err(error) => return Ok(Err(error)),
    };
    withhold_predating_setup(store, source, &observations)?;
    let summary = store.apply_source_observations(SourceObservationBatch::new(
        connector,
        INSTANCE,
        SessionLocation::Remote,
        observations,
    ))?;
    Ok(Ok(summary.discovered + summary.skipped_unchanged))
}

/// The marker recording when `db` last ran remote enumeration and what each
/// connector did. Its mtime is the interval gate.
fn marker(db: &Path) -> PathBuf {
    db.with_extension("remote-enumerated")
}

fn due(db: &Path) -> bool {
    let Ok(stamped) = std::fs::metadata(marker(db)).and_then(|meta| meta.modified()) else {
        return true;
    };
    stamped.elapsed().unwrap_or(ENUMERATE_INTERVAL) >= ENUMERATE_INTERVAL
}

/// The last enumeration's report; empty when none ran or it is unreadable.
pub fn last_enumeration(db: &Path) -> Enumeration {
    std::fs::read(marker(db))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// Connectors whose last listing failed inside the current interval: not
/// run again — not even per-session reads — until the next listing is due,
/// so an expired sign-in costs one attempt per interval, not one per pass
/// or per session.
fn held_back(db: &Path) -> BTreeSet<String> {
    if due(db) {
        return BTreeSet::new();
    }
    last_enumeration(db)
        .connectors
        .into_iter()
        .filter(|c| c.state == "failed")
        .map(|c| c.connector)
        .collect()
}

/// Stamp the marker after a pass ran, whatever each connector did: its
/// failures are in the report and wait out the interval.
fn mark_enumerated(db: &Path, report: &Enumeration) -> Result<()> {
    if let Some(parent) = marker(db).parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(marker(db), serde_json::to_vec(report)?)?;
    Ok(())
}

/// Whether a discovery scoped to `sources` should drive remote connectors:
/// unscoped and connector-source selections, yes; a selection naming only
/// local providers skips the remote poll entirely — a Grok-only pass must
/// never pay or block on a Devin or claude.ai round trip.
pub fn scoped(sources: Option<&[ai_hist::Source]>) -> bool {
    sources.is_none_or(|list| {
        list.iter()
            .any(|source| CONNECTORS.iter().any(|(_, s)| *s == source.as_str()))
    })
}

/// Refresh remote catalog rows when due. `Ok(None)` when the interval has
/// not passed or no connector is signed in; `Ok(Some(report))` once
/// enumeration ran, whatever each connector did. Provider failures are in
/// the report, never an error — the caller records them as a diagnostic.
pub fn enumerate(
    db: &Path,
    home: &Path,
    stopped: impl Fn() -> bool,
) -> Result<Option<Enumeration>> {
    enumerate_with(&Host::system(home, db), db, stopped)
}

fn enumerate_with(
    host: &Host,
    db: &Path,
    stopped: impl Fn() -> bool,
) -> Result<Option<Enumeration>> {
    if stopped() || !due(db) || reaches(host).iter().all(|(_, _, r)| *r == Reach::Absent) {
        return Ok(None);
    }
    let store = super::history::open(db)?;
    let report = enumerate_ready(&Pass::new(host), &store)?;
    mark_enumerated(db, &report)?;
    Ok(Some(report))
}

/// Whether a catalogued session lives only remotely — `discover` lands such
/// rows with `locations == ["remote"]`, and the local providers cannot
/// hydrate them.
pub fn remote_only(
    store: &SessionStore,
    source: ai_hist::Source,
    session_id: &str,
) -> Result<bool> {
    let session = ai_hist::SessionRef::id(source, session_id);
    let rows = super::history::catalog_rows(store, &[session])?;
    Ok(rows
        .first()
        .and_then(|row| row.as_ref())
        .is_some_and(|row| {
            row.locations.iter().all(|l| l == "remote") && !row.locations.is_empty()
        }))
}

fn key(connector: &str, source: &str, session_id: &str) -> ObservationKey {
    ObservationKey {
        source: source.to_string(),
        session_id: session_id.to_string(),
        location: SessionLocation::Remote,
        connector_id: connector.to_string(),
        connector_instance: INSTANCE.to_string(),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use ai_hist::{SessionRef, ShallowSession, Source};

    /// Serializes tests that mutate process env.
    pub(crate) static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// `devin_auth_ready` accepts env overrides; tests asserting "no
    /// connector" must remove them or they silently depend on the host.
    pub(crate) struct EnvGuard(&'static str, Option<std::ffi::OsString>);

    impl EnvGuard {
        pub(crate) fn set(key: &'static str, value: impl AsRef<std::ffi::OsStr>) -> Self {
            let previous = std::env::var_os(key);
            std::env::set_var(key, value);
            Self(key, previous)
        }

        pub(crate) fn remove(key: &'static str) -> Self {
            let previous = std::env::var_os(key);
            std::env::remove_var(key);
            Self(key, previous)
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            match &self.1 {
                Some(value) => std::env::set_var(self.0, value),
                None => std::env::remove_var(self.0),
            }
        }
    }

    /// A home with no Devin CLI sign-in, guaranteed regardless of the
    /// machine's env — the connector also honors the RELAYHISTORY_DEVIN_*
    /// overrides and XDG home redirection, so a bare `home` alone is not
    /// enough on a signed-in host.
    fn bare_home() -> (tempfile::TempDir, Vec<EnvGuard>) {
        let home = tempfile::tempdir().unwrap();
        let guards = vec![
            EnvGuard::remove("RELAYHISTORY_DEVIN_API_KEY"),
            EnvGuard::remove("RELAYHISTORY_DEVIN_ORG_ID"),
            EnvGuard::remove("RELAYHISTORY_DEVIN_CREDENTIALS"),
            EnvGuard::remove("RELAYHISTORY_DEVIN_CONFIG"),
            EnvGuard::remove("RELAYHISTORY_DEVIN_API_BASE_URL"),
            EnvGuard::remove(claude_cloud::CREDENTIALS_ENV),
            // Claude's cloud sessions follow `~/.claude`, which must be the
            // watched default: no other Claude folder from this machine.
            EnvGuard::remove("CLAUDE_CONFIG_DIR"),
            EnvGuard::remove(agent_relay_probe::relay::claude_dirs::DIRS_ENV),
            EnvGuard::set("XDG_DATA_HOME", home.path().join("data")),
            EnvGuard::set("XDG_CONFIG_HOME", home.path().join("config")),
            EnvGuard::remove("AGENT_RELAY_HOME"),
            // The upload consent check reads `$HOME`'s Claude choices.
            EnvGuard::set("HOME", home.path()),
        ];
        // The person turned Claude Code cloud sessions on.
        claude_dirs_here(home.path())
            .set_cloud_sessions(true)
            .unwrap();
        (home, guards)
    }

    /// The Claude folder choices under `home`'s relay home.
    fn claude_dirs_here(home: &Path) -> agent_relay_probe::relay::claude_dirs::ClaudeDirs {
        let env = |_: &str| None;
        let relay = agent_relay_probe::relay::workspace::relay_home(&env, home);
        std::fs::create_dir_all(&relay).unwrap();
        agent_relay_probe::relay::claude_dirs::ClaudeDirs::from_env(&env, home, &relay)
    }

    /// A sign-in pointed at `api_url`, through the connector's own env
    /// overrides rather than a credentials file: tests in this binary run
    /// in parallel and other modules mutate `HOME`/`XDG_*`, which the
    /// file-layout fallback honors — an env-resolved sign-in is the only
    /// deterministic one. The tempdir stands in for `home` only.
    pub(crate) fn signed_in_home(api_url: &str) -> (tempfile::TempDir, Vec<EnvGuard>) {
        let home = tempfile::tempdir().unwrap();
        let guards = vec![
            EnvGuard::set("RELAYHISTORY_DEVIN_API_KEY", "test-key"),
            EnvGuard::set("RELAYHISTORY_DEVIN_ORG_ID", "org-test"),
            EnvGuard::set("RELAYHISTORY_DEVIN_API_BASE_URL", api_url),
            // No Claude login: a store opened on the real home (`sweep`
            // reads its roots) must not find this machine's, and an
            // override never falls back to the Keychain. Devin is the only
            // connector signed in.
            EnvGuard::set(
                claude_cloud::CREDENTIALS_ENV,
                home.path().join("no-claude-login.json"),
            ),
            EnvGuard::remove("AGENT_RELAY_HOME"),
            // The upload consent check reads `$HOME`'s Claude choices.
            EnvGuard::set("HOME", home.path()),
        ];
        // Claude Code cloud sessions are on wherever a test gives Claude a
        // login.
        claude_dirs_here(home.path())
            .set_cloud_sessions(true)
            .unwrap();
        (home, guards)
    }

    /// The session a stub serves: a bare 32-hex id, as the list endpoint
    /// reports it.
    pub(crate) const STUB_SESSION: &str = "0123456789abcdef0123456789abcdef";

    /// One canned Devin v3 response per request: the org session list and
    /// the message history for `STUB_SESSION`. The counter proves a caller
    /// never fetched, which an "unchanged" verdict alone cannot. The list's
    /// `updated_at` is mutable so a test can move the observation stamp —
    /// the only thing that reopens hydration's fetch fence.
    pub(crate) struct StubApi {
        listener: std::net::TcpListener,
        requests: std::sync::Arc<std::sync::atomic::AtomicUsize>,
        updated_at: std::sync::Arc<std::sync::atomic::AtomicI64>,
        /// Each request's line. The sign-in reaches this stub through
        /// process-wide env, so a discovery test running beside one that
        /// holds it may list from it too: assertions about downloads count
        /// message fetches, not every request.
        lines: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    }

    impl StubApi {
        pub(crate) fn start() -> Self {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let requests = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let updated_at = std::sync::Arc::new(std::sync::atomic::AtomicI64::new(1_700_000_060));
            let counting = requests.clone();
            let listing = updated_at.clone();
            let lines = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
            let logged = lines.clone();
            let server = Self {
                listener: listener
                    .try_clone()
                    .unwrap_or_else(|_| panic!("listener clone")),
                requests,
                updated_at,
                lines,
            };
            std::thread::spawn(move || {
                for stream in listener.incoming() {
                    let Ok(mut stream) = stream else { return };
                    counting.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    let mut request = String::new();
                    let mut buffer = [0u8; 4096];
                    use std::io::{Read, Write};
                    if let Ok(read) = stream.read(&mut buffer) {
                        request.push_str(&String::from_utf8_lossy(&buffer[..read]));
                    }
                    logged
                        .lock()
                        .unwrap()
                        .push(request.lines().next().unwrap_or("").to_string());
                    let body = if request.contains("/messages") {
                        format!(
                            r#"{{"items":[{{"event_id":"e1","source":"user","message":"catch bugs","created_at":1700000000}},{{"event_id":"e2","source":"devin","message":"found none","created_at":1700000060}}],"end_cursor":null,"has_next_page":false}}"#
                        )
                    } else {
                        format!(
                            r#"{{"items":[{{"session_id":"{STUB_SESSION}","created_at":1700000000,"updated_at":{},"title":"catch bugs","status":"active"}}],"end_cursor":null,"has_next_page":false}}"#,
                            listing.load(std::sync::atomic::Ordering::SeqCst)
                        )
                    };
                    let _ = write!(
                        stream,
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                }
            });
            server
        }

        pub(crate) fn url(&self) -> String {
            format!("http://{}", self.listener.local_addr().unwrap())
        }

        pub(crate) fn lines(&self) -> Vec<String> {
            self.lines.lock().unwrap().clone()
        }

        /// Session evidence downloads: message history requests.
        pub(crate) fn fetches(&self) -> usize {
            self.lines()
                .iter()
                .filter(|l| l.contains("/messages"))
                .count()
        }

        /// Session list requests.
        pub(crate) fn lists(&self) -> usize {
            self.lines()
                .iter()
                .filter(|l| !l.contains("/messages"))
                .count()
        }

        pub(crate) fn requests(&self) -> usize {
            self.requests.load(std::sync::atomic::Ordering::SeqCst)
        }

        fn bump_updated_at(&self) {
            self.updated_at
                .fetch_add(60, std::sync::atomic::Ordering::SeqCst);
        }
    }

    fn observation(session_id: &str) -> SourceObservation {
        SourceObservation {
            session: ShallowSession {
                source: "devin".into(),
                session_id: session_id.into(),
                first_prompt: Some("catch bugs".into()),
                source_stamp: Some("cloud:100:active:aa".into()),
                ..Default::default()
            },
            raw_locator: Some(format!("v3:sessions/{session_id}")),
        }
    }

    #[test]
    fn enumerate_is_inert_without_a_configured_connector() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let (home, _env) = bare_home();
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("history.db");
        assert_eq!(enumerate(&db, home.path(), || false).unwrap(), None);
        assert!(!marker(&db).exists());
        // Stopped wins over due.
        assert_eq!(enumerate(&db, home.path(), || true).unwrap(), None);
    }

    #[test]
    fn scoped_admits_only_connector_sources() {
        let devin = Source::parse("devin").unwrap();
        let grok = Source::parse("grok").unwrap();
        assert!(scoped(None));
        assert!(scoped(Some(&[devin])));
        assert!(scoped(Some(&[devin, grok])));
        assert!(!scoped(Some(&[grok])));
        assert!(!scoped(Some(&[])));
    }

    #[test]
    fn enumerate_reruns_only_after_the_interval() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("history.db");
        assert!(due(&db));
        std::fs::File::create(marker(&db)).unwrap();
        assert!(!due(&db));
        std::fs::File::options()
            .write(true)
            .open(marker(&db))
            .unwrap()
            .set_modified(std::time::SystemTime::now() - ENUMERATE_INTERVAL * 2)
            .unwrap();
        assert!(due(&db));
    }

    #[test]
    fn remote_only_tracks_catalog_provenance() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("history.db");
        let store = super::super::history::open(&db).unwrap();
        let remote = "sess-remote";
        store
            .apply_source_observations(SourceObservationBatch::new(
                DEVIN_CLOUD_CONNECTOR,
                INSTANCE,
                SessionLocation::Remote,
                vec![observation(remote)],
            ))
            .unwrap();
        let local = "sess-local";
        store
            .apply_source_observations(SourceObservationBatch::new(
                DEVIN_CLOUD_CONNECTOR,
                INSTANCE,
                SessionLocation::Local,
                vec![observation(local)],
            ))
            .unwrap();
        let source = Source::parse("devin").unwrap();
        assert!(remote_only(&store, source, remote).unwrap());
        assert!(!remote_only(&store, source, local).unwrap());
        assert!(!remote_only(&store, source, "sess-absent").unwrap());
    }

    #[test]
    fn hydrate_is_none_when_no_connector_is_ready() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let (home, _env) = bare_home();
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("history.db");
        let store = super::super::history::open(&db).unwrap();
        store
            .apply_source_observations(SourceObservationBatch::new(
                DEVIN_CLOUD_CONNECTOR,
                INSTANCE,
                SessionLocation::Remote,
                vec![observation("sess-remote")],
            ))
            .unwrap();
        // A remote-only row exists, but with no sign-in there is no connector
        // to hydrate it: `None`, not an error and not a claim of success.
        assert_eq!(
            hydrate(&store, home.path(), "devin", "sess-remote", || false).unwrap(),
            None
        );
    }

    /// `catalog_rows` covers the second arm of `remote_only`'s lookup: the
    /// remote path reads the same row `hydrate` was called on.
    #[test]
    fn remote_only_reads_the_requested_session() {
        let dir = tempfile::tempdir().unwrap();
        let store = super::super::history::open(&dir.path().join("history.db")).unwrap();
        store
            .apply_source_observations(SourceObservationBatch::new(
                DEVIN_CLOUD_CONNECTOR,
                INSTANCE,
                SessionLocation::Remote,
                vec![observation("a"), observation("b")],
            ))
            .unwrap();
        let source = Source::parse("devin").unwrap();
        let rows = super::super::history::catalog_rows(
            &store,
            &[SessionRef::id(source, "b"), SessionRef::id(source, "a")],
        )
        .unwrap();
        assert!(rows[0].as_ref().is_some_and(|row| row.session_id == "b"));
        assert!(rows[1].as_ref().is_some_and(|row| row.session_id == "a"));
    }

    /// How many session-event rows the catalog holds for `session_id` — the
    /// observable sign a remote hydration landed evidence.
    fn event_count(db: &Path, session_id: &str) -> i64 {
        events_of(db, "devin", session_id)
    }

    fn events_of(db: &Path, source: &str, session_id: &str) -> i64 {
        let conn =
            rusqlite::Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .unwrap();
        conn.query_row(
            "SELECT count(*) FROM session_events WHERE source = ?1 AND session_id = ?2",
            [source, session_id],
            |row| row.get(0),
        )
        .unwrap()
    }

    #[test]
    fn enumerate_then_hydrate_lands_remote_rows_and_evidence() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let api = StubApi::start();
        let (home, _env) = signed_in_home(&api.url());
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("history.db");

        assert_eq!(
            enumerate(&db, home.path(), || false)
                .unwrap()
                .map(|r| r.rows()),
            Some(1)
        );
        assert!(marker(&db).exists());
        let store = super::super::history::open(&db).unwrap();
        let source = Source::parse("devin").unwrap();
        assert!(remote_only(&store, source, STUB_SESSION).unwrap());

        assert_eq!(
            hydrate(&store, home.path(), "devin", STUB_SESSION, || false).unwrap(),
            Some(true)
        );
        assert!(event_count(&db, STUB_SESSION) >= 2);
        // The checkpoint now covers the observation's last change: the
        // fence answers before the connector — no fetch, not even an
        // "unchanged" apply.
        let fetched = api.fetches();
        assert_eq!(
            hydrate(&store, home.path(), "devin", STUB_SESSION, || false).unwrap(),
            Some(false)
        );
        assert_eq!(api.fetches(), fetched, "a covered row refetched");
    }

    #[test]
    fn sweep_hydrates_remote_only_rows() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let api = StubApi::start();
        let (home, _env) = signed_in_home(&api.url());
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("history.db");

        let outcome = sweep(
            &db,
            &{
                let store = super::super::history::open(&db).unwrap();
                let host = Host::system(home.path(), &db);
                enumerate_ready(&Pass::new(&host), &store).unwrap();
                store
            },
            || false,
        )
        .unwrap()
        .unwrap();
        assert_eq!(outcome.hydrated, 1);
        assert_eq!(outcome.failed, 0);
        assert!(event_count(&db, STUB_SESSION) >= 2);
    }

    #[test]
    fn sweep_downloads_nothing_excluded_from_upload() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let api = StubApi::start();
        let (_home, _env) = signed_in_home(&api.url());
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("history.db");
        let store = super::super::history::open(&db).unwrap();
        let host = Host::system(_home.path(), &db);
        enumerate_ready(&Pass::new(&host), &store).unwrap();
        mark_enumerated(&db, &Enumeration::default()).unwrap();
        agent_relay_probe::delivery::set_session_excluded(
            &agent_relay_probe::delivery::open_db(&db).unwrap(),
            &agent_relay_probe::delivery::SessionIdentity {
                source: "devin".into(),
                session_id: STUB_SESSION.into(),
            },
            true,
        )
        .unwrap();
        let fetched = api.fetches();

        let outcome = sweep(&db, &store, || false).unwrap().unwrap();
        assert_eq!((outcome.hydrated, outcome.failed), (0, 0));
        assert_eq!(api.fetches(), fetched, "an excluded session was downloaded");
        assert_eq!(outcome.pacing["waiting"], 0);
    }

    #[test]
    fn sweep_holds_downloads_back_at_the_growth_cap() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let api = StubApi::start();
        let (_home, _env) = signed_in_home(&api.url());
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("history.db");
        let store = super::super::history::open(&db).unwrap();
        let mut pacing = Pacing::default();
        pacing.grown_bytes = pacing::GROWTH_CAP;
        pacing.save(&db).unwrap();

        // The listing still runs; the download waits, and says why.
        let outcome = sweep(&db, &store, || false).unwrap().unwrap();
        assert_eq!(outcome.hydrated, 0);
        assert_eq!(outcome.pacing["held_back"], pacing::GROWN);
        assert_eq!(outcome.pacing["waiting"], 1);
        assert_eq!(event_count(&db, STUB_SESSION), 0);
    }

    #[test]
    fn sweep_skips_hydrated_rows_between_enumerations() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let api = StubApi::start();
        let (_home, _env) = signed_in_home(&api.url());
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("history.db");
        let store = super::super::history::open(&db).unwrap();

        // The first pass enumerates (no marker yet) and hydrates the row.
        let first = sweep(&db, &store, || false).unwrap().unwrap();
        assert_eq!(first.hydrated, 1);
        let fetched = api.fetches();

        // Enumeration is not due again and the row's evidence already
        // applied: the next pass must not pay a provider round trip for an
        // answer that can only be "unchanged".
        let second = sweep(&db, &store, || false).unwrap().unwrap();
        assert_eq!(second.hydrated, 0);
        assert_eq!(second.failed, 0);
        assert_eq!(api.fetches(), fetched, "a hydrated row refetched");

        // Re-enumerating an unchanged listing costs the list call only:
        // the observation's stamp didn't move, so its updated_ms stays
        // behind the checkpoint's and the fence still holds.
        std::fs::File::options()
            .write(true)
            .open(marker(&db))
            .unwrap()
            .set_modified(std::time::SystemTime::now() - ENUMERATE_INTERVAL * 2)
            .unwrap();
        let listed = api.lists();
        let third = sweep(&db, &store, || false).unwrap().unwrap();
        assert_eq!(third.failed, 0);
        assert!(api.lists() > listed, "the due enumeration never listed");
        assert_eq!(api.fetches(), fetched, "re-enumeration refetched evidence");

        // A moved listing — updated_at advanced — bumps the observation
        // and reopens the fence: the same pass lists and fetches.
        api.bump_updated_at();
        std::fs::File::options()
            .write(true)
            .open(marker(&db))
            .unwrap()
            .set_modified(std::time::SystemTime::now() - ENUMERATE_INTERVAL * 2)
            .unwrap();
        let listed = api.lists();
        let fourth = sweep(&db, &store, || false).unwrap().unwrap();
        assert_eq!(fourth.failed, 0);
        assert!(api.lists() > listed, "the due enumeration never listed");
        assert_eq!(
            api.fetches(),
            fetched + 1,
            "a moved observation never refetched; pacing {}; requests {:?}",
            fourth.pacing,
            api.lines()
        );
    }

    #[test]
    fn hydrate_reader_lands_a_placeholder_and_evidence() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let api = StubApi::start();
        let (_home, _env) = signed_in_home(&api.url());
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("history.db");
        // The reader cache starts empty — no observation, no catalog row.
        let store = super::super::history::open(&db).unwrap();
        assert_eq!(
            hydrate_reader(&store, "devin", STUB_SESSION, || false).unwrap(),
            Some(true)
        );
        assert!(event_count(&db, STUB_SESSION) >= 2);
        let source = Source::parse("devin").unwrap();
        assert!(remote_only(&store, source, STUB_SESSION).unwrap());
        // A second open refetches — the reader always serves fresh data.
        assert_eq!(
            hydrate_reader(&store, "devin", STUB_SESSION, || false).unwrap(),
            Some(true)
        );
    }

    // ---- claude-web: Claude Code cloud sessions on claude.ai ----

    use super::claude_cloud::tests::{credentials, FakeKeychain};
    use std::sync::atomic::Ordering;

    /// The cloud session the Claude stub lists and serves.
    const CLAUDE_SESSION: &str = "session_01abc";

    /// One session as `GET /v1/code/sessions` lists it.
    fn claude_listing(id: &str, created_at: &str) -> String {
        format!(
            r#"{{"id":"{id}","title":"fix the bug","created_at":"{created_at}","last_event_at":"{created_at}","environment_kind":"cloud"}}"#
        )
    }

    /// A claude.ai stand-in: the session list (with a Remote Control bridge
    /// row the connector must skip), the OAuth profile, and teleport events.
    /// `fail_list` answers the list with a 500.
    struct ClaudeStub {
        listener: std::net::TcpListener,
        requests: std::sync::Arc<std::sync::atomic::AtomicUsize>,
        authorized: std::sync::Arc<std::sync::atomic::AtomicUsize>,
        sessions: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    }

    impl ClaudeStub {
        fn start(fail_list: bool) -> Self {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let requests = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let authorized = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let sessions = std::sync::Arc::new(std::sync::Mutex::new(vec![claude_listing(
                CLAUDE_SESSION,
                "2023-11-14T22:13:20Z",
            )]));
            let server = Self {
                listener: listener.try_clone().unwrap(),
                requests: requests.clone(),
                authorized: authorized.clone(),
                sessions: sessions.clone(),
            };
            std::thread::spawn(move || {
                for stream in listener.incoming() {
                    let Ok(mut stream) = stream else { return };
                    requests.fetch_add(1, Ordering::SeqCst);
                    use std::io::{Read, Write};
                    let mut buffer = [0u8; 8192];
                    let read = stream.read(&mut buffer).unwrap_or(0);
                    let request = String::from_utf8_lossy(&buffer[..read]).to_string();
                    if request
                        .to_ascii_lowercase()
                        .contains("authorization: bearer test-token")
                    {
                        authorized.fetch_add(1, Ordering::SeqCst);
                    }
                    let (status, body) = if request.contains("teleport-events") {
                        (
                            200,
                            format!(
                                r#"{{"data":[{{"payload":{{"sessionId":"{CLAUDE_SESSION}","uuid":"u1","type":"user","timestamp":1,"message":{{"role":"user","content":"hello"}}}}}},{{"payload":{{"sessionId":"{CLAUDE_SESSION}","uuid":"a1","type":"assistant","timestamp":2,"message":{{"role":"assistant","content":[{{"type":"text","text":"done"}}]}}}}}}],"next_cursor":null}}"#
                            ),
                        )
                    } else if request.contains("/api/oauth/profile") {
                        (200, r#"{"organization":{"uuid":"org-test"}}"#.to_string())
                    } else if fail_list {
                        (500, "{}".to_string())
                    } else {
                        let mut rows = sessions.lock().unwrap().clone();
                        rows.push(
                            r#"{"id":"session_02bridge","title":"local","created_at":"2023-11-14T22:13:20Z","environment_kind":"bridge"}"#
                                .to_string(),
                        );
                        (
                            200,
                            format!(r#"{{"data":[{}],"next_cursor":null}}"#, rows.join(",")),
                        )
                    };
                    let _ = write!(
                        stream,
                        "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                }
            });
            server
        }

        fn url(&self) -> String {
            format!("http://{}", self.listener.local_addr().unwrap())
        }

        fn requests(&self) -> usize {
            self.requests.load(Ordering::SeqCst)
        }
    }

    /// A token that stays current for the test's length.
    #[test]
    fn cloud_records_take_the_listed_session_id() {
        use ai_hist::sources::AcquiredEvidence;
        let full = |ids: &[Option<&str>]| AcquiredEvidence::ClaudeFull {
            records: ids
                .iter()
                .map(|id| match id {
                    Some(id) => serde_json::json!({"type": "user", "sessionId": id}),
                    None => serde_json::json!({"type": "system"}),
                })
                .collect(),
            source_stamp: "teleport:x".into(),
            source_bytes: 1,
        };
        let ids = |evidence: AcquiredEvidence| match evidence {
            AcquiredEvidence::ClaudeFull { records, .. } => records
                .iter()
                .map(|r| {
                    r.get("sessionId")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .collect::<Vec<_>>(),
            _ => unreachable!(),
        };
        const INNER: &str = "0b6f2d0e-8a51-4a5c-9c3e-5d1f0a2b3c4d";
        // One container id throughout: the records are the listed session's.
        assert_eq!(
            ids(adopt_cloud_session_id(
                full(&[Some(INNER), None, Some(INNER)]),
                "cse_01A"
            )),
            [Some("cse_01A".into()), None, Some("cse_01A".into())]
        );
        // Resumed in a new container: another UUID, the same session.
        const RESUMED: &str = "7c1d9e2a-0b3f-4e5d-8a6b-9c0d1e2f3a4b";
        assert_eq!(
            ids(adopt_cloud_session_id(
                full(&[Some(INNER), Some(RESUMED)]),
                "cse_01A"
            )),
            [Some("cse_01A".into()), Some("cse_01A".into())]
        );
        // The listed id among container UUIDs: all take the listed id.
        assert_eq!(
            ids(adopt_cloud_session_id(
                full(&[Some("cse_01A"), Some(INNER)]),
                "cse_01A"
            )),
            [Some("cse_01A".into()), Some("cse_01A".into())]
        );
        // Named only in snake case: it takes the listed id as `sessionId`.
        let snake = AcquiredEvidence::ClaudeFull {
            records: vec![serde_json::json!({"type": "user", "session_id": INNER})],
            source_stamp: "teleport:x".into(),
            source_bytes: 1,
        };
        let AcquiredEvidence::ClaudeFull { records, .. } = adopt_cloud_session_id(snake, "cse_01A")
        else {
            unreachable!()
        };
        assert_eq!(
            records[0],
            serde_json::json!({"type": "user", "sessionId": "cse_01A"})
        );
        // A record naming another claude.ai session stays, to be refused.
        assert_eq!(
            ids(adopt_cloud_session_id(
                full(&[Some(INNER), Some("cse_01B")]),
                "cse_01A"
            )),
            [Some(INNER.into()), Some("cse_01B".into())]
        );
        // Already the listed id, or none at all: unchanged.
        assert_eq!(
            ids(adopt_cloud_session_id(
                full(&[Some("cse_01A"), None]),
                "cse_01A"
            )),
            [Some("cse_01A".into()), None]
        );
    }

    fn fresh_login() -> String {
        credentials(chrono::Utc::now().timestamp_millis() + 3_600_000)
    }

    fn host<'a>(
        home: &'a Path,
        db: &Path,
        keychain: &std::sync::Arc<impl claude_cloud::KeychainSource + 'static>,
    ) -> Host<'a> {
        Host {
            home,
            data_dir: db.parent().unwrap().to_path_buf(),
            keychain: claude_cloud::Keychain::new(keychain.clone()),
            claude: true,
        }
    }

    fn report_for<'r>(report: &'r Enumeration, connector: &str) -> Option<&'r ConnectorReport> {
        report.connectors.iter().find(|c| c.connector == connector)
    }

    fn backdate(db: &Path) {
        std::fs::File::options()
            .write(true)
            .open(marker(db))
            .unwrap()
            .set_modified(std::time::SystemTime::now() - ENUMERATE_INTERVAL * 2)
            .unwrap();
    }

    fn private_homes_left(db: &Path) -> usize {
        std::fs::read_dir(db.parent().unwrap().join("claude-cloud"))
            .map(|entries| entries.count())
            .unwrap_or(0)
    }

    #[test]
    fn scoped_admits_claude() {
        assert!(scoped(Some(&[Source::parse("claude").unwrap()])));
    }

    #[test]
    fn claude_cloud_sessions_list_and_hydrate_with_the_keychain_login() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let api = ClaudeStub::start(false);
        let (home, _env) = bare_home();
        let _base = EnvGuard::set("RELAYHISTORY_CLAUDE_API_BASE_URL", api.url());
        let keychain = FakeKeychain::holding(Some(&fresh_login()));
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("history.db");
        let host = host(home.path(), &db, &keychain);

        let report = enumerate_with(&host, &db, || false).unwrap().unwrap();
        let claude = report_for(&report, CLAUDE_WEB_CONNECTOR).unwrap();
        // The Remote Control bridge row mirrors a local session: skipped.
        assert_eq!((claude.state.as_str(), claude.sessions), ("listed", 1));
        assert!(report_for(&report, DEVIN_CLOUD_CONNECTOR).is_none());
        let store = super::super::history::open(&db).unwrap();
        let source = Source::parse("claude").unwrap();
        assert!(remote_only(&store, source, CLAUDE_SESSION).unwrap());
        assert!(!remote_only(&store, source, "session_02bridge").unwrap());

        let outcome = sweep_with(&host, &db, &store, || false).unwrap().unwrap();
        assert_eq!((outcome.hydrated, outcome.failed), (1, 0));
        assert!(events_of(&db, "claude", CLAUDE_SESSION) >= 2);
        // One Keychain read for both passes (its answer is kept a few
        // minutes), the token it held on every request, and no login left
        // on disk once each pass ended.
        assert_eq!(keychain.reads.load(Ordering::SeqCst), 1);
        assert_eq!(api.authorized.load(Ordering::SeqCst), api.requests());
        assert_eq!(private_homes_left(&db), 0);
        assert!(
            !home.path().join(".claude").exists(),
            "Claude Code's folder was written"
        );
    }

    #[test]
    fn a_failing_claude_listing_never_stops_devin() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let devin = StubApi::start();
        let claude = ClaudeStub::start(true);
        let (home, _env) = signed_in_home(&devin.url());
        // Its own temp home: the fake Keychain is the Claude login here.
        let _claude = EnvGuard::remove(claude_cloud::CREDENTIALS_ENV);
        let _base = EnvGuard::set("RELAYHISTORY_CLAUDE_API_BASE_URL", claude.url());
        let keychain = FakeKeychain::holding(Some(&fresh_login()));
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("history.db");
        let host = host(home.path(), &db, &keychain);

        let report = enumerate_with(&host, &db, || false).unwrap().unwrap();
        let listed = report_for(&report, DEVIN_CLOUD_CONNECTOR).unwrap();
        assert_eq!((listed.state.as_str(), listed.sessions), ("listed", 1));
        let failed = report_for(&report, CLAUDE_WEB_CONNECTOR).unwrap();
        assert_eq!(failed.state, "failed");
        assert!(failed
            .reason
            .as_deref()
            .unwrap()
            .contains("CONNECTOR_FAILURE"));
        assert_eq!(report.failed(), 1);
        assert_eq!(last_enumeration(&db), report);

        // Until the next listing is due, Claude is left alone — Devin's
        // rows still hydrate, and claude.ai sees no further request.
        let calls = claude.requests();
        assert_eq!(
            ready(&host, Some(&db)),
            vec![(DEVIN_CLOUD_CONNECTOR, "devin")]
        );
        let store = super::super::history::open(&db).unwrap();
        let outcome = sweep_with(&host, &db, &store, || false).unwrap().unwrap();
        assert_eq!((outcome.hydrated, outcome.failed), (1, 0));
        assert!(outcome.enumeration.is_none());
        assert_eq!(claude.requests(), calls);
        // Once due, Claude is tried again.
        backdate(&db);
        assert!(ready(&host, Some(&db)).contains(&(CLAUDE_WEB_CONNECTOR, "claude")));
    }

    #[test]
    fn an_unanswered_keychain_prompt_never_holds_up_a_pass() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let devin = StubApi::start();
        let claude = ClaudeStub::start(false);
        let (home, _env) = signed_in_home(&devin.url());
        let _claude = EnvGuard::remove(claude_cloud::CREDENTIALS_ENV);
        let _base = EnvGuard::set("RELAYHISTORY_CLAUDE_API_BASE_URL", claude.url());
        // macOS asks whether the helper may read Claude Code's sign-in, and
        // nobody answers.
        let (keychain, answer) = FakeKeychain::blocking();
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("history.db");
        let host = host(home.path(), &db, &keychain);
        let store = super::super::history::open(&db).unwrap();
        let bound = claude_cloud::PASS_WAIT + Duration::from_secs(10);

        // The pass waits briefly, reports Claude not ready, and Devin's
        // session is listed and downloaded all the same.
        let started = std::time::Instant::now();
        let outcome = sweep_with(&host, &db, &store, || false).unwrap().unwrap();
        assert!(started.elapsed() < bound, "the pass waited on the Keychain");
        assert_eq!((outcome.hydrated, outcome.failed), (1, 0));
        let report = outcome.enumeration.unwrap();
        let waiting = report_for(&report, CLAUDE_WEB_CONNECTOR).unwrap();
        assert_eq!(waiting.state, "unavailable");
        assert_eq!(
            waiting.reason.as_deref(),
            Some(claude_cloud::KEYCHAIN_WAITING)
        );
        assert_eq!(report.failed(), 0);
        let listed = report_for(&report, DEVIN_CLOUD_CONNECTOR).unwrap();
        assert_eq!((listed.state.as_str(), listed.sessions), ("listed", 1));
        assert_eq!(claude.requests(), 0);
        // Waiting is not a failure: Claude is not held back.
        assert!(ready(&host, Some(&db)).contains(&(CLAUDE_WEB_CONNECTOR, "claude")));

        // The next pass, with the prompt still up, raises no second one.
        backdate(&db);
        let started = std::time::Instant::now();
        let report = enumerate_with(&host, &db, || false).unwrap().unwrap();
        assert!(started.elapsed() < bound);
        assert_eq!(
            report_for(&report, CLAUDE_WEB_CONNECTOR).unwrap().state,
            "unavailable"
        );
        assert_eq!(keychain.reads.load(Ordering::SeqCst), 1);

        // Allowed at last: the pass after it lists Claude with the answer.
        answer.send(Some(fresh_login().into_bytes())).unwrap();
        host.keychain.wait_answered();
        backdate(&db);
        let report = enumerate_with(&host, &db, || false).unwrap().unwrap();
        let listed = report_for(&report, CLAUDE_WEB_CONNECTOR).unwrap();
        assert_eq!((listed.state.as_str(), listed.sessions), ("listed", 1));
        assert_eq!(keychain.reads.load(Ordering::SeqCst), 1);
        assert_eq!(private_homes_left(&db), 0);
    }

    #[test]
    fn a_keychain_login_without_access_is_unavailable_not_held_back() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let api = ClaudeStub::start(false);
        let (home, _env) = bare_home();
        let _base = EnvGuard::set("RELAYHISTORY_CLAUDE_API_BASE_URL", api.url());
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("history.db");
        let keychain = FakeKeychain::protected();
        let host = host(home.path(), &db, &keychain);
        let report = enumerate_with(&host, &db, || false).unwrap().unwrap();
        let claude = report_for(&report, CLAUDE_WEB_CONNECTOR).unwrap();
        assert_eq!(claude.state, "unavailable");
        assert_eq!(
            claude.reason.as_deref(),
            Some(claude_cloud::KEYCHAIN_DENIED)
        );
        assert_eq!(report.failed(), 0);
        // Not held back: once access is granted, the next pass uses it.
        assert!(ready(&host, Some(&db))
            .iter()
            .any(|(id, _)| *id == CLAUDE_WEB_CONNECTOR));
        assert_eq!(keychain.interactive_reads.load(Ordering::SeqCst), 0);
        assert_eq!(api.requests(), 0);
    }

    #[test]
    fn an_expired_claude_login_makes_no_request_and_is_reported() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let api = ClaudeStub::start(false);
        let (home, _env) = bare_home();
        let _base = EnvGuard::set("RELAYHISTORY_CLAUDE_API_BASE_URL", api.url());
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("history.db");

        // An expired Keychain item: read once, refused, held back.
        let keychain = FakeKeychain::holding(Some(&credentials(1)));
        let host_k = host(home.path(), &db, &keychain);
        let report = enumerate_with(&host_k, &db, || false).unwrap().unwrap();
        let claude = report_for(&report, CLAUDE_WEB_CONNECTOR).unwrap();
        assert_eq!(claude.state, "failed");
        assert_eq!(claude.reason.as_deref(), Some(claude_cloud::EXPIRED));
        assert!(ready(&host_k, Some(&db)).is_empty());
        assert_eq!(enumerate_with(&host_k, &db, || false).unwrap(), None);
        assert_eq!(keychain.reads.load(Ordering::SeqCst), 1);

        // An expired file with no Keychain (Linux): never run, reported.
        std::fs::create_dir_all(home.path().join(".claude")).unwrap();
        std::fs::write(
            home.path().join(".claude/.credentials.json"),
            credentials(1),
        )
        .unwrap();
        let host_f = host(
            home.path(),
            &db,
            &std::sync::Arc::new(claude_cloud::NoKeychain),
        );
        backdate(&db);
        let report = enumerate_with(&host_f, &db, || false).unwrap().unwrap();
        let claude = report_for(&report, CLAUDE_WEB_CONNECTOR).unwrap();
        assert_eq!(claude.state, "unavailable");
        assert_eq!(claude.reason.as_deref(), Some(claude_cloud::EXPIRED));
        assert_eq!(report.failed(), 0);
        assert_eq!(api.requests(), 0, "an expired login reached claude.ai");
    }

    #[test]
    fn claude_cloud_sessions_stay_off_until_turned_on() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let (home, _env) = bare_home();
        claude_dirs_here(home.path())
            .set_cloud_sessions(false)
            .unwrap();
        let keychain = FakeKeychain::holding(Some(&fresh_login()));
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("history.db");
        let host = host(home.path(), &db, &keychain);
        assert!(!ready(&host, None)
            .iter()
            .any(|(id, _)| *id == CLAUDE_WEB_CONNECTOR));
        assert_eq!(keychain.reads.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn a_claude_folder_turned_off_keeps_its_cloud_sessions_off() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let (home, _env) = bare_home();
        let _relay = EnvGuard::remove("AGENT_RELAY_HOME");
        let env = |key: &str| std::env::var(key).ok();
        let relay = agent_relay_probe::relay::workspace::relay_home(&env, home.path());
        std::fs::create_dir_all(&relay).unwrap();
        let mut recorded = agent_relay_probe::relay::claude_dirs::Recorded {
            cloud_sessions: true,
            ..Default::default()
        };
        recorded.folders.insert(
            home.path().join(".claude"),
            agent_relay_probe::relay::claude_dirs::FolderChoice { shared: false },
        );
        std::fs::write(
            relay.join(agent_relay_probe::relay::claude_dirs::FILE),
            serde_json::to_vec(&recorded).unwrap(),
        )
        .unwrap();
        let keychain = FakeKeychain::holding(Some(&fresh_login()));
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("history.db");
        let host = host(home.path(), &db, &keychain);
        assert_eq!(enumerate_with(&host, &db, || false).unwrap(), None);
        assert_eq!(keychain.reads.load(Ordering::SeqCst), 0);
    }

    /// An install in sharing mode `new`, whose upload job was created at
    /// `job_ms` (none yet when `None`).
    fn new_mode_install(directory: &Path, job_ms: Option<i64>) {
        let config = super::super::Config {
            version: 1,
            site_url: "https://agentrelay.com".into(),
            account_id: "account".into(),
            account_email: None,
            account_name: None,
            account_avatar_url: None,
            workspace_name: None,
            org_id: "org".into(),
            workspace_id: "workspace".into(),
            history_url: "https://history.agentrelay.com".into(),
            delivery_account: agent_relay_probe::destination::account_id("org", Some("workspace")),
            job_id: "job".into(),
            include_existing: false,
            sharing_mode: Some(super::super::bridge::SharingMode::New),
            acknowledge_uninspected_schedules: false,
        };
        super::super::save_json(&directory.join("config.json"), &config).unwrap();
        assert!(super::super::read_config(directory).is_ok());
        let conn = agent_relay_probe::delivery::open_db(&directory.join("history.db")).unwrap();
        if let Some(created) = job_ms {
            conn.execute(
                "INSERT INTO delivery_jobs(id,destination_id,instance_id,account_id,generation,config_json,state,created_ms) VALUES('job','d','i','a',1,'{}','active',?)",
                [created],
            )
            .unwrap();
        }
    }

    fn shareable(db: &Path, session_id: &str) -> bool {
        let conn = agent_relay_probe::delivery::open_db(db).unwrap();
        agent_relay_probe::delivery::is_shareable(
            &conn,
            &agent_relay_probe::delivery::SessionIdentity {
                source: "claude".into(),
                session_id: session_id.into(),
            },
        )
        .unwrap()
    }

    #[test]
    fn sharing_new_withholds_cloud_sessions_from_before_setup() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let api = ClaudeStub::start(false);
        // One session from before setup, one after (setup at 22:13:50).
        api.sessions
            .lock()
            .unwrap()
            .push(claude_listing("session_03after", "2023-11-14T22:14:20Z"));
        let (home, _env) = bare_home();
        let _base = EnvGuard::set("RELAYHISTORY_CLAUDE_API_BASE_URL", api.url());
        let keychain = FakeKeychain::holding(Some(&fresh_login()));
        let dir = tempfile::tempdir().unwrap();
        new_mode_install(dir.path(), Some(1_700_000_030_000));
        let db = dir.path().join("history.db");
        let host = host(home.path(), &db, &keychain);

        enumerate_with(&host, &db, || false).unwrap().unwrap();
        assert!(
            !shareable(&db, CLAUDE_SESSION),
            "a pre-setup cloud session is shared"
        );
        assert!(shareable(&db, "session_03after"));

        // Only a first sighting is withheld: a session the person then
        // includes stays included on the next listing.
        // (The stand-in job has no real configuration for the include
        // command to check, so the exclusion is withdrawn directly.)
        agent_relay_probe::delivery::open_db(&db)
            .unwrap()
            .execute(
                "DELETE FROM delivery_exclusions WHERE source='claude' AND session_id=?",
                [CLAUDE_SESSION],
            )
            .unwrap();
        backdate(&db);
        enumerate_with(&host, &db, || false).unwrap().unwrap();
        assert!(shareable(&db, CLAUDE_SESSION));
    }

    #[test]
    fn a_replaced_job_keeps_the_setup_cutoff() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let api = ClaudeStub::start(false);
        api.sessions
            .lock()
            .unwrap()
            .push(claude_listing("session_03after", "2023-11-14T22:14:20Z"));
        let (home, _env) = bare_home();
        let _base = EnvGuard::set("RELAYHISTORY_CLAUDE_API_BASE_URL", api.url());
        let keychain = FakeKeychain::holding(Some(&fresh_login()));
        let dir = tempfile::tempdir().unwrap();
        new_mode_install(dir.path(), Some(1_700_000_030_000));
        let db = dir.path().join("history.db");
        // Including or excluding one session replaces the job: a later one.
        agent_relay_probe::delivery::open_db(&db)
            .unwrap()
            .execute_batch(
                "UPDATE delivery_jobs SET state='cancelled' WHERE id='job';
                 INSERT INTO delivery_jobs(id,destination_id,instance_id,account_id,generation,config_json,state,created_ms) VALUES('job2','d','i','a',2,'{}','active',1800000000000)",
            )
            .unwrap();
        enumerate_with(&host(home.path(), &db, &keychain), &db, || false)
            .unwrap()
            .unwrap();
        assert!(!shareable(&db, CLAUDE_SESSION));
        assert!(
            shareable(&db, "session_03after"),
            "a session from after setup was withheld by the replaced job's time"
        );
    }

    #[test]
    fn sharing_new_withholds_everything_listed_before_the_job_exists() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let api = ClaudeStub::start(false);
        let (home, _env) = bare_home();
        let _base = EnvGuard::set("RELAYHISTORY_CLAUDE_API_BASE_URL", api.url());
        let keychain = FakeKeychain::holding(Some(&fresh_login()));
        let dir = tempfile::tempdir().unwrap();
        new_mode_install(dir.path(), None);
        let db = dir.path().join("history.db");
        enumerate_with(&host(home.path(), &db, &keychain), &db, || false)
            .unwrap()
            .unwrap();
        assert!(!shareable(&db, CLAUDE_SESSION));
    }
}
