//! Delivery into a Devin Cloud session — the remote counterpart of
//! `devin::send`'s local routes, through the `devin-cloud` connector's own
//! authenticated transport: `POST /v3/organizations/{org}/sessions/
//! devin-{id}/messages`, the documented v3 send route. It needs
//! `ManageOrgSessions`, the broader scope, and it resumes a suspended
//! session — so a cloud session is reachable even when nothing local runs.
//!
//! The Devin CLI sign-in never reaches the relay: the connector resolves
//! the bearer from the same `credentials.toml` the history connector reads.

#[cfg(feature = "history")]
use crate::cloud::devin_credential::DevinCredentialAnswer;
#[cfg(feature = "history")]
use crate::cloud::{self, devin_credential};
#[cfg(feature = "history")]
use crate::relay::devin::DevinConfig;
#[cfg(feature = "history")]
use crate::relay::inject::InjectOutcome;
#[cfg(feature = "history")]
use crate::relay::sessions::DiscoveredSession;
#[cfg(feature = "history")]
use crate::relay::store::{SessionKind, Target};
#[cfg(feature = "history")]
use ai_hist::{CatalogQuery, SessionScope, SessionStore, Source, StoreOptions};
#[cfg(feature = "history")]
use history_provider_sources::remote::{
    remote_connector_statuses_at, send_remote_message_at, send_remote_message_with,
    RemoteCredential, DEVIN_CLOUD_CONNECTOR,
};
#[cfg(feature = "history")]
use std::path::{Path, PathBuf};

/// The `host` a remote catalog row carries in the discovery listing — the
/// app holding the session is Devin's own cloud service, not anything on
/// this machine. It marks the rows the connector's sign-in, not a local
/// process, activates and delivers into.
pub const CLOUD_HOST: &str = "Devin Cloud";

/// Whether `session_id` names a Devin Cloud session: the bare 32-hex id the
/// v3 API reports, or the `devin-`-prefixed form. Local CLI sessions carry
/// names like `real-gallium` — never hex — so this is also the guard that
/// keeps a stopped *local* session off the cloud route.
pub fn is_cloud_session_id(session_id: &str) -> bool {
    let hex = session_id.strip_prefix("devin-").unwrap_or(session_id);
    hex.len() == 32 && hex.bytes().all(|b| b.is_ascii_hexdigit())
}

#[cfg(feature = "history")]
/// Whether this machine's Devin sign-in lets the connector reach cloud
/// sessions — a local credential check, never a request.
fn connector_ready(config: &DevinConfig) -> bool {
    remote_connector_statuses_at(&config.home)
        .into_iter()
        .any(|status| status.connector == DEVIN_CLOUD_CONNECTOR && status.configured)
}

// ---------------------------------------------------------------------------
// workspace credential — the Cloud-held sign-in a bare machine sends with
// ---------------------------------------------------------------------------

#[cfg(feature = "history")]
/// How long a workspace-credential answer is trusted before it is re-fetched:
/// long enough that a discovery pass and a send share one fetch, short enough
/// that a rotated key or a removed connection is noticed promptly.
const CREDENTIAL_CACHE_TTL_MS: u64 = 5 * 60 * 1000;

#[cfg(feature = "history")]
/// The cache file inside a probe install directory holding the workspace's
/// last Devin credential answer — `devin-credential.json`.
const CREDENTIAL_CACHE_FILE: &str = "devin-credential.json";

#[cfg(feature = "history")]
/// The Cloud binding an install's `config.json` records — where to fetch the
/// workspace's Devin credential. Absent fields mark an install that never
/// completed sign-in; it binds nothing.
struct InstallBinding {
    dir: PathBuf,
    api_url: String,
    workspace_id: String,
}

#[cfg(feature = "history")]
impl InstallBinding {
    /// The identity a cached credential answer is pinned to.
    fn key(&self) -> String {
        format!("{}|{}", self.api_url, self.workspace_id)
    }
}

#[cfg(feature = "history")]
/// The probe installs' Cloud bindings, in the same order `discover` reads
/// their catalogs: every live install, sorted.
fn cloud_bindings(probe_root: &Path) -> Vec<InstallBinding> {
    installs(probe_root)
        .into_iter()
        .filter_map(|dir| {
            let raw = std::fs::read_to_string(dir.join("config.json")).ok()?;
            let config: serde_json::Value = serde_json::from_str(&raw).ok()?;
            let site_url = config["site_url"].as_str()?.trim().to_string();
            let workspace_id = config["workspace_id"].as_str()?.trim().to_string();
            if site_url.is_empty() || workspace_id.is_empty() {
                return None;
            }
            let api_url = cloud::cloud_api_url(Some(&format!("{site_url}/cloud"))).ok()?;
            Some(InstallBinding {
                dir,
                api_url,
                workspace_id,
            })
        })
        .collect()
}

#[cfg(feature = "history")]
/// The probe install directories under `probe_root` — the same scan
/// `discover` runs.
fn installs(probe_root: &Path) -> Vec<PathBuf> {
    let mut installs: Vec<PathBuf> = std::fs::read_dir(probe_root)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir() && path.join("config.json").exists())
        .collect();
    installs.sort();
    installs
}

#[cfg(feature = "history")]
#[derive(serde::Serialize, serde::Deserialize)]
struct CredentialCache {
    /// The binding this answer came from — an install re-signed into another
    /// workspace must never be served the former workspace's key.
    #[serde(default)]
    binding: Option<String>,
    /// `Some` when the workspace answered a Devin credential; `None` records
    /// "checked, nothing connected" — and a failed fetch — so both are
    /// rate-limited the same way rather than re-asked every pass.
    credential: Option<CachedCredential>,
    fetched_at_ms: u64,
}

#[cfg(feature = "history")]
#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct CachedCredential {
    api_key: String,
    org_id: String,
    #[serde(default)]
    base_url: Option<String>,
}

#[cfg(feature = "history")]
/// The credential fetch's outcome for one install.
enum FetchedCredential {
    /// The workspace has Devin connected — this credential sends.
    Connected(CachedCredential),
    /// The workspace answered and has no Devin connection.
    NotConnected,
    /// No usable answer: no Cloud sign-in, a refused bearer, or an
    /// unreachable Cloud. A stale cached credential still serves for sends
    /// (it, not the bearer, is the send material), so callers keep it.
    Unavailable,
}

#[cfg(feature = "history")]
fn credential_cache_path(install: &Path) -> PathBuf {
    install.join(CREDENTIAL_CACHE_FILE)
}

#[cfg(feature = "history")]
fn read_credential_cache(install: &Path) -> Option<CredentialCache> {
    let raw = std::fs::read_to_string(credential_cache_path(install)).ok()?;
    serde_json::from_str(&raw).ok()
}

#[cfg(feature = "history")]
/// Write the cache owner-only — the same sensitivity class as the Devin
/// CLI's `credentials.toml` this feature replaces.
fn write_credential_cache(install: &Path, cache: &CredentialCache) {
    let path = credential_cache_path(install);
    let Ok(raw) = serde_json::to_string(cache) else {
        return;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        // `mode` only applies at creation — an existing permissive file must
        // be tightened before the key is written into it.
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&path)
        {
            let _ = file.set_permissions(std::fs::Permissions::from_mode(0o600));
            let _ = std::io::Write::write_all(&mut file, raw.as_bytes());
        }
    }
    #[cfg(not(unix))]
    {
        let _ = std::fs::write(&path, raw);
    }
}

#[cfg(feature = "history")]
fn remove_credential_cache(install: &Path) {
    let _ = std::fs::remove_file(credential_cache_path(install));
}

#[cfg(feature = "history")]
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|age| age.as_millis() as u64)
        .unwrap_or_default()
}

#[cfg(feature = "history")]
/// The workspace's Devin credential for this install — the cached answer
/// when it is fresh (or the only thing available), else a fetch through the
/// install's Cloud binding. `force` re-fetches regardless of freshness — the
/// send path's answer to an expired cached key.
fn workspace_credential(binding: &InstallBinding, force: bool) -> FetchedCredential {
    // A cache answered for another binding is the former workspace's
    // credential — never served, however fresh.
    let cache = read_credential_cache(&binding.dir)
        .filter(|entry| entry.binding.as_deref() == Some(binding.key().as_str()));
    let stale = cache
        .as_ref()
        .is_none_or(|entry| now_ms().saturating_sub(entry.fetched_at_ms) > CREDENTIAL_CACHE_TTL_MS);
    if !force && !stale {
        return match cache.and_then(|entry| entry.credential) {
            Some(credential) => FetchedCredential::Connected(credential),
            None => FetchedCredential::NotConnected,
        };
    }
    let stale_credential = cache.and_then(|entry| entry.credential);
    let Some(bearer) = cloud::renewal_bearer(&binding.api_url) else {
        // No request was made, so nothing is rate-limited here — the stale
        // answer still serves a send, but a forced refresh (a key Devin just
        // rejected) never re-serves it.
        return if force {
            FetchedCredential::Unavailable
        } else {
            match stale_credential {
                Some(credential) => FetchedCredential::Connected(credential),
                None => FetchedCredential::Unavailable,
            }
        };
    };
    match devin_credential::devin_workspace_credential(
        &binding.api_url,
        &bearer,
        &binding.workspace_id,
    ) {
        Ok(DevinCredentialAnswer::Connected(credential)) => {
            let credential = CachedCredential {
                api_key: credential.api_key,
                org_id: credential.org_id,
                base_url: credential.base_url,
            };
            write_credential_cache(
                &binding.dir,
                &CredentialCache {
                    binding: Some(binding.key()),
                    credential: Some(credential.clone()),
                    fetched_at_ms: now_ms(),
                },
            );
            FetchedCredential::Connected(credential)
        }
        Ok(DevinCredentialAnswer::NotConnected) => {
            write_credential_cache(
                &binding.dir,
                &CredentialCache {
                    binding: Some(binding.key()),
                    credential: None,
                    fetched_at_ms: now_ms(),
                },
            );
            FetchedCredential::NotConnected
        }
        // A refused or unreachable fetch is rate-limited like a negative
        // answer — a down Cloud must not be hit on every discovery pass —
        // and keeps the stale credential for ordinary sends (it is the
        // server's last word, and a stale key may still be the live one). A
        // forced refresh re-asking after Devin rejected the key must not
        // re-serve it.
        Ok(DevinCredentialAnswer::Refused) | Ok(DevinCredentialAnswer::Unreachable) | Err(_) => {
            write_credential_cache(
                &binding.dir,
                &CredentialCache {
                    binding: Some(binding.key()),
                    credential: stale_credential.clone(),
                    fetched_at_ms: now_ms(),
                },
            );
            if force {
                FetchedCredential::Unavailable
            } else {
                match stale_credential {
                    Some(credential) => FetchedCredential::Connected(credential),
                    None => FetchedCredential::Unavailable,
                }
            }
        }
    }
}

#[cfg(feature = "history")]
/// Whether any install's workspace has Devin connected — the discovery-side
/// half of "a send path exists", so a machine with no local Devin sign-in
/// still lists its cloud sessions live. Stale caches refresh inline, bounded
/// by `CREDENTIAL_CACHE_TTL_MS`.
fn install_credential_ready(binding: &InstallBinding) -> bool {
    matches!(
        workspace_credential(binding, false),
        FetchedCredential::Connected(_)
    )
}

#[cfg(feature = "history")]
/// The send through the workspace credential: every install binding in turn,
/// since the session may belong to any of the orgs they cover. A
/// `SESSION_NOT_FOUND` just means this org does not own the session — the
/// next binding gets its try.
fn send_cloud_workspace(
    probe_root: Option<&Path>,
    session_id: &str,
    text: &str,
) -> Option<InjectOutcome> {
    let probe_root = probe_root?;
    // A binding's refusal is not terminal while another workspace's
    // credential may own the session — but once every bound workspace has
    // answered, the last refusal is the route's word rather than an endless
    // `Waiting` on a session nobody can reach.
    let mut refusal: Option<InjectOutcome> = None;
    for binding in cloud_bindings(probe_root) {
        let mut refreshed = false;
        loop {
            let FetchedCredential::Connected(credential) =
                workspace_credential(&binding, refreshed)
            else {
                break;
            };
            let result = send_remote_message_with(
                DEVIN_CLOUD_CONNECTOR,
                session_id,
                text,
                &RemoteCredential {
                    bearer: credential.api_key.clone(),
                    org_id: credential.org_id.clone(),
                    // The credential's own base URL first, then the
                    // connector's env override, then the default.
                    base_url: credential.base_url.clone().or_else(|| {
                        std::env::var("RELAYHISTORY_DEVIN_API_BASE_URL")
                            .ok()
                            .filter(|value| !value.is_empty())
                    }),
                },
            );
            match result {
                Ok(()) => return Some(InjectOutcome::Delivered),
                Err(error) => {
                    let code = error
                        .to_string()
                        .split(':')
                        .next()
                        .unwrap_or("")
                        .to_string();
                    match code.as_str() {
                        // The cached key died — a rotation or a removed
                        // connection. Re-fetch once; a fresh credential gets
                        // one retry, then the next binding.
                        "AUTHENTICATION_EXPIRED" if !refreshed => {
                            refreshed = true;
                            continue;
                        }
                        "AUTHENTICATION_EXPIRED" => {
                            remove_credential_cache(&binding.dir);
                        }
                        "SESSION_NOT_FOUND" => {
                            refusal = Some(InjectOutcome::Refused(
                                "no Devin Cloud session by that id".into(),
                            ));
                        }
                        "PERMISSION_DENIED" => {
                            refusal = Some(InjectOutcome::Refused(
                                "the workspace's Devin API key needs ManageOrgSessions to send"
                                    .into(),
                            ));
                        }
                        // A malformed request fails identically for every
                        // org — no other binding can carry it.
                        "INVALID_ARGUMENT" => {
                            return Some(InjectOutcome::Refused(
                                "the Devin Cloud send was malformed".into(),
                            ));
                        }
                        // Transport failures and 5xx share CONNECTOR_FAILURE —
                        // and a send the API has no idempotency key for may
                        // still have landed, so the runtime must not repeat it.
                        _ => {
                            return Some(InjectOutcome::InDoubt(
                                "the Devin Cloud API did not confirm the send; it may still have arrived"
                                    .into(),
                            ));
                        }
                    }
                    break;
                }
            }
        }
    }
    refusal
}

#[cfg(feature = "history")]
/// Devin Cloud sessions the probe installs' history catalogs know as
/// remote, as discovered rows. A row is `live` — deliverable, and what
/// keeps a registration present — while the connector's sign-in resolves;
/// a `devin` process need not run. The catalogs are the only listing a
/// never-local cloud session can have, and their absence (no install yet,
/// or a database pending upgrade) lists nothing rather than holding local
/// discovery up on it. Every live install is read — the org's sessions do
/// not belong to one relay workspace — and a session several installs
/// know is listed once.
pub fn discover(config: &DevinConfig, probe_root: &Path) -> Vec<DiscoveredSession> {
    // A live install carries a config.json — a decommissioned one's
    // catalog keeps stale rows nobody is refreshing.
    let installs = installs(probe_root);
    let connector_live = connector_ready(config);
    let bindings: std::collections::HashMap<PathBuf, InstallBinding> = cloud_bindings(probe_root)
        .into_iter()
        .map(|binding| (binding.dir.clone(), binding))
        .collect();
    let mut found: std::collections::BTreeMap<String, DiscoveredSession> =
        std::collections::BTreeMap::new();
    for install in installs {
        // A send path exists per install: this machine's own Devin sign-in
        // covers every row, else the install's own workspace credential —
        // another install's workspace says nothing about these rows.
        let live = connector_live || bindings.get(&install).is_some_and(install_credential_ready);
        for session in remote_sessions(&install.join("history.db"), live) {
            found.entry(session.target.id.clone()).or_insert(session);
        }
    }
    found.into_values().collect()
}

#[cfg(feature = "history")]
/// One install's remote Devin Cloud rows as discovered sessions.
fn remote_sessions(catalog_db: &Path, live: bool) -> Vec<DiscoveredSession> {
    let mut options = StoreOptions::default().db_path(catalog_db);
    options.read_only = true;
    let Ok(store) = SessionStore::open(options) else {
        return Vec::new();
    };
    let mut query = CatalogQuery::default();
    query.scope = SessionScope::Remote;
    query.sources = Some(vec![Source::Devin]);
    store
        .sessions(query)
        .filter_map(|row| row.ok())
        .filter(|row| {
            row.locations.iter().any(|location| location == "remote")
                && is_cloud_session_id(&row.session_id)
        })
        .map(|row| DiscoveredSession {
            target: Target::new(SessionKind::Devin, row.session_id.clone()),
            title: row.title.unwrap_or_else(|| row.session_id.clone()),
            directory: row.cwd,
            updated_at_ms: row.last_activity_ms,
            host: Some(CLOUD_HOST.to_string()),
            live,
            holder: None,
        })
        .collect()
}

#[cfg(feature = "history")]
/// What Devin records as the origin of a session an automation started,
/// such as a Devin review of a pull request.
const AUTOMATION_ORIGINATOR: &str = "automation";

#[cfg(feature = "history")]
/// The Devin Cloud sessions an automation started (Devin reviews), by id.
/// They never auto-activate: nobody is in them to talk to. Read from each
/// install's catalog, like `discover`.
pub fn started_by_automation(probe_root: &Path) -> std::collections::HashSet<String> {
    let mut found = std::collections::HashSet::new();
    for install in installs(probe_root) {
        let mut options = StoreOptions::default().db_path(install.join("history.db"));
        options.read_only = true;
        let Ok(store) = SessionStore::open(options) else {
            continue;
        };
        let mut query = CatalogQuery::default();
        query.scope = SessionScope::Remote;
        query.sources = Some(vec![Source::Devin]);
        found.extend(
            store
                .sessions(query)
                .filter_map(|row| row.ok())
                .filter(|row| row.originator.as_deref() == Some(AUTOMATION_ORIGINATOR))
                .map(|row| row.session_id),
        );
    }
    found
}

#[cfg(feature = "history")]
/// The remote send's answer, or `None` when the remote route does not
/// apply — the id names no cloud session, and neither this machine's Devin
/// sign-in nor a workspace credential could carry it — and the caller's
/// local answer stands.
pub fn send_cloud(
    config: &DevinConfig,
    probe_root: Option<&Path>,
    session_id: &str,
    text: &str,
) -> Option<InjectOutcome> {
    if !is_cloud_session_id(session_id) {
        return None;
    }
    match send_remote_message_at(&config.home, DEVIN_CLOUD_CONNECTOR, session_id, text) {
        Ok(()) => Some(InjectOutcome::Delivered),
        Err(error) => {
            let message = error.to_string();
            // The connector stamps a public code on its errors; everything
            // after it stays out of the relay's answer only where it could
            // carry endpoint or credential detail.
            let Some(code) = message.split(':').next() else {
                return Some(InjectOutcome::InDoubt(
                    "the Devin Cloud send's result is unknown".into(),
                ));
            };
            match code {
                // No local sign-in — or one Devin now rejects — does not end
                // the route: a workspace credential held by a probe install's
                // Cloud binding may still carry the send. When none answers,
                // the local answer stands: `None` keeps the caller's
                // `Waiting`, the rejected sign-in keeps its refusal.
                "CONNECTOR_NOT_CONFIGURED" => send_cloud_workspace(probe_root, session_id, text),
                "AUTHENTICATION_EXPIRED" => send_cloud_workspace(probe_root, session_id, text).or(
                    Some(InjectOutcome::Refused(
                        "the Devin sign-in was rejected; sign in again".into(),
                    )),
                ),
                // The local key answered for its own org — another
                // workspace's credential may own this session.
                "SESSION_NOT_FOUND" => send_cloud_workspace(probe_root, session_id, text).or(Some(
                    InjectOutcome::Refused("no Devin Cloud session by that id".into()),
                )),
                "PERMISSION_DENIED" => send_cloud_workspace(probe_root, session_id, text).or(Some(
                    InjectOutcome::Refused(
                        "the Devin API key needs ManageOrgSessions to send".into(),
                    ),
                )),
                "INVALID_ARGUMENT" => Some(InjectOutcome::Refused(
                    "the Devin Cloud send was malformed".into(),
                )),
                // Transport failures and 5xx share CONNECTOR_FAILURE — and a
                // send the API has no idempotency key for may still have
                // landed, so the runtime must not repeat it.
                _ => Some(InjectOutcome::InDoubt(
                    "the Devin Cloud API did not confirm the send; it may still have arrived"
                        .into(),
                )),
            }
        }
    }
}

#[cfg(all(test, feature = "history"))]
pub(crate) mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Env-mutating cases serialize: `RELAYHISTORY_DEVIN_*` and `XDG_*` are
    /// process-global, and a parallel test's values cannot leak between
    /// them. Other modules' env-mutating tests lock this same guard.
    pub(crate) static ENV_LOCK: Mutex<()> = Mutex::new(());

    pub(crate) struct EnvGuard(Vec<(&'static str, Option<std::ffi::OsString>)>);

    impl EnvGuard {
        fn remove(keys: &[&'static str]) -> Self {
            Self(
                keys.iter()
                    .map(|key| {
                        let previous = std::env::var_os(key);
                        std::env::remove_var(key);
                        (*key, previous)
                    })
                    .collect(),
            )
        }
        fn set(&mut self, key: &'static str, value: &str) {
            std::env::set_var(key, value);
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            for (key, previous) in &self.0 {
                match previous {
                    Some(value) => std::env::set_var(key, value),
                    None => std::env::remove_var(key),
                }
            }
        }
    }

    const ENVS: &[&str] = &[
        "RELAYHISTORY_DEVIN_API_KEY",
        "RELAYHISTORY_DEVIN_ORG_ID",
        "RELAYHISTORY_DEVIN_API_BASE_URL",
        "RELAYHISTORY_DEVIN_CREDENTIALS",
        "RELAYHISTORY_DEVIN_CONFIG",
        "CLOUD_API_ACCESS_TOKEN",
        "XDG_DATA_HOME",
        "XDG_CONFIG_HOME",
    ];

    /// Every env the credential lookup honors, cleared and restored on
    /// drop — the only deterministic "no sign-in" on a machine that may
    /// really be signed in (the file fallback honors `XDG_*`).
    pub(crate) fn unsigned_env() -> EnvGuard {
        EnvGuard::remove(ENVS)
    }

    /// The connector's env-override sign-in, restored on drop: the only
    /// deterministic one while parallel tests may point the file-layout
    /// fallback elsewhere. `XDG_*` are cleared too so a credentials file
    /// under another test's redirected home cannot pose as the sign-in.
    pub(crate) fn signed_in_env() -> EnvGuard {
        let mut env = unsigned_env();
        env.set("RELAYHISTORY_DEVIN_API_KEY", "test-key");
        env.set("RELAYHISTORY_DEVIN_ORG_ID", "org-test");
        env
    }

    const CLOUD_ID: &str = "4b50574f40324da6bd88e9cbd30501cf";

    fn config(home: &std::path::Path) -> DevinConfig {
        DevinConfig {
            data_dir: home.join("devin"),
            config_dir: home.join("config").join("devin"),
            home: home.to_path_buf(),
            development: false,
        }
    }

    /// A live install `<root>/<name>` — its `config.json` marks it — with
    /// a catalog database holding the given observations, landed the way
    /// the connector enumeration lands them.
    fn install_with(
        root: &std::path::Path,
        name: &str,
        observations: Vec<ai_hist::SourceObservation>,
    ) {
        let install = root.join(name);
        std::fs::create_dir_all(&install).unwrap();
        std::fs::write(install.join("config.json"), "{}").unwrap();
        let store = SessionStore::open(StoreOptions::default().db_path(install.join("history.db")))
            .unwrap();
        store
            .apply_source_observations(ai_hist::SourceObservationBatch::new(
                DEVIN_CLOUD_CONNECTOR,
                "default",
                ai_hist::SessionLocation::Remote,
                observations,
            ))
            .unwrap();
    }

    /// The cache entry a bound install's own credential fetch would leave —
    /// pinned to the binding so a re-signed install is never served it.
    fn bound_cache(
        site_url: &str,
        workspace: &str,
        credential: CachedCredential,
    ) -> CredentialCache {
        CredentialCache {
            binding: Some(format!(
                "{}|{}",
                cloud::cloud_api_url(Some(&format!("{site_url}/cloud"))).unwrap(),
                workspace
            )),
            credential: Some(credential),
            fetched_at_ms: now_ms(),
        }
    }

    /// `install_with` plus the Cloud binding a signed-in install's
    /// `config.json` carries — `site_url` and `workspace_id` mark where
    /// the workspace credential lives.
    fn bound_install(
        root: &std::path::Path,
        name: &str,
        observations: Vec<ai_hist::SourceObservation>,
        site_url: &str,
        workspace: &str,
    ) {
        install_with(root, name, observations);
        std::fs::write(
            root.join(name).join("config.json"),
            format!(r#"{{"site_url": "{site_url}", "workspace_id": "{workspace}"}}"#),
        )
        .unwrap();
    }

    fn remote_row(session_id: &str, title: &str) -> ai_hist::SourceObservation {
        ai_hist::SourceObservation {
            session: ai_hist::ShallowSession {
                source: "devin".into(),
                session_id: session_id.into(),
                title: Some(title.into()),
                cwd: Some("/work/repo".into()),
                last_activity_ms: Some(1_700_000_000_000),
                source_stamp: Some("cloud:100:active:aa".into()),
                ..Default::default()
            },
            raw_locator: Some(format!("v3:sessions/{session_id}")),
        }
    }

    /// A remote catalog row is a discovered cloud session — `host` names
    /// the service holding it (and keeps it out of local auto-activation),
    /// and `live` rides the local sign-in check: absent without one. Two
    /// installs knowing the same session list it once.
    #[test]
    fn discover_lists_catalog_remote_sessions() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let mut env = EnvGuard::remove(ENVS);
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("probe");
        install_with(&root, "a", vec![remote_row(CLOUD_ID, "Fix the flaky test")]);
        install_with(&root, "b", vec![remote_row(CLOUD_ID, "Fix the flaky test")]);
        let config = config(temp.path());
        let found = discover(&config, &root);
        assert_eq!(found.len(), 1);
        let session = &found[0];
        assert_eq!(session.target, Target::new(SessionKind::Devin, CLOUD_ID));
        assert_eq!(session.title, "Fix the flaky test");
        assert_eq!(session.directory.as_deref(), Some("/work/repo"));
        assert_eq!(session.host.as_deref(), Some(CLOUD_HOST));
        assert!(!session.live);
        env.set("RELAYHISTORY_DEVIN_API_KEY", "cog_test");
        env.set("RELAYHISTORY_DEVIN_ORG_ID", "org-test");
        assert!(discover(&config, &root)[0].live);
    }

    /// A machine with no probe root — or only an install nothing marks
    /// live, its `config.json` gone — lists nothing, and never blocks
    /// local discovery waiting on a catalog.
    #[test]
    fn discover_is_inert_without_a_live_install() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let _env = EnvGuard::remove(ENVS);
        let temp = tempfile::tempdir().unwrap();
        let config = config(temp.path());
        let root = temp.path().join("probe");
        assert!(discover(&config, &root).is_empty());
        // A catalog in an unmarked install directory is not read.
        let install = root.join("stale");
        std::fs::create_dir_all(&install).unwrap();
        let store = SessionStore::open(StoreOptions::default().db_path(install.join("history.db")))
            .unwrap();
        store
            .apply_source_observations(ai_hist::SourceObservationBatch::new(
                DEVIN_CLOUD_CONNECTOR,
                "default",
                ai_hist::SessionLocation::Remote,
                vec![remote_row(CLOUD_ID, "stale row")],
            ))
            .unwrap();
        assert!(discover(&config, &root).is_empty());
    }

    /// A catalog row reaches the listing only as a *cloud* session: a
    /// local-named Devin row — however it was catalogued — and a
    /// local-location row are both local discovery's own business.
    #[test]
    fn discover_keeps_only_remote_cloud_rows() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let _env = EnvGuard::remove(ENVS);
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("probe");
        install_with(&root, "a", vec![remote_row("real-gallium", "local named")]);
        let store =
            SessionStore::open(StoreOptions::default().db_path(root.join("a").join("history.db")))
                .unwrap();
        store
            .apply_source_observations(ai_hist::SourceObservationBatch::new(
                DEVIN_CLOUD_CONNECTOR,
                "default",
                ai_hist::SessionLocation::Local,
                vec![remote_row("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "local seen")],
            ))
            .unwrap();
        let config = config(temp.path());
        assert!(discover(&config, &root).is_empty());
    }

    /// A `devin-`-prefixed or bare 32-hex id is a cloud session; anything
    /// else — a local name, a short id, a non-hex char — is not, and a
    /// local name must never reach the cloud route.
    #[test]
    fn cloud_session_ids_are_the_api_shape_only() {
        assert!(is_cloud_session_id(CLOUD_ID));
        assert!(is_cloud_session_id(&format!("devin-{CLOUD_ID}")));
        for id in [
            "real-gallium",
            "4b50574f40324da6bd88e9cbd30501c",   // 31 chars
            "4b50574f40324da6bd88e9cbd30501cf0", // 33 chars
            "4b50574f40324da6bd88e9cbd30501cg",  // non-hex
            "devin-real-gallium",
            "",
        ] {
            assert!(!is_cloud_session_id(id), "{id}");
        }
    }

    /// Without a sign-in the cloud route simply does not exist — `None`
    /// keeps the caller's local `Waiting` answer. The env overrides are
    /// the only deterministic sign-in here: other tests mutate `XDG_*`,
    /// which a file-layout sign-in would honor.
    #[test]
    fn send_is_inert_without_a_configured_connector() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let _env = EnvGuard::remove(ENVS);
        let home = tempfile::tempdir().unwrap();
        let config = config(home.path());
        assert!(send_cloud(&config, None, CLOUD_ID, "hello").is_none());
        assert!(send_cloud(&config, None, "real-gallium", "hello").is_none());
    }

    /// A signed-in machine posting to a stub api.devin.ai: the documented
    /// route and `{"message": …}` body carry the relay's text, and a 200 is
    /// `Delivered` — never `Accepted`, which the runtime would retry into
    /// a duplicate the API cannot deduplicate.
    #[test]
    fn send_posts_the_documented_route_and_reports_delivered() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let mut env = EnvGuard::remove(ENVS);
        let home = tempfile::tempdir().unwrap();
        let api = StubApi::start(200);
        env.set("RELAYHISTORY_DEVIN_API_KEY", "cog_test");
        env.set("RELAYHISTORY_DEVIN_ORG_ID", "org-test");
        env.set("RELAYHISTORY_DEVIN_API_BASE_URL", &api.url());
        let config = config(home.path());
        assert_eq!(
            send_cloud(&config, None, CLOUD_ID, "hello cloud"),
            Some(InjectOutcome::Delivered)
        );
        let requests = api.requests();
        assert_eq!(requests.len(), 1);
        let request = &requests[0];
        assert!(request.starts_with(&format!(
            "POST /v3/organizations/org-test/sessions/devin-{CLOUD_ID}/messages "
        )));
        assert!(request.contains(r#""message":"hello cloud""#), "{request}");
    }

    /// Each refusal maps to the outcome a retry cannot change: a missing
    /// session, a rejected key, and a read-only key are `Refused`; a server
    /// failure is `InDoubt` because the send may still have landed.
    #[test]
    fn send_maps_api_failures_to_outcomes() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let mut env = EnvGuard::remove(ENVS);
        let home = tempfile::tempdir().unwrap();
        let config = config(home.path());
        env.set("RELAYHISTORY_DEVIN_API_KEY", "cog_test");
        env.set("RELAYHISTORY_DEVIN_ORG_ID", "org-test");
        for (status, refused) in [
            (404u16, true),
            (401, true),
            (403, true),
            (422, true),
            (500, false),
        ] {
            let api = StubApi::start(status);
            env.set("RELAYHISTORY_DEVIN_API_BASE_URL", &api.url());
            let outcome = send_cloud(&config, None, CLOUD_ID, "hello").expect("an outcome");
            if refused {
                assert!(
                    matches!(outcome, InjectOutcome::Refused(_)),
                    "HTTP {status}: {outcome:?}"
                );
            } else {
                assert!(
                    matches!(outcome, InjectOutcome::InDoubt(_)),
                    "HTTP {status}: {outcome:?}"
                );
            }
        }
    }

    /// With no local Devin sign-in, a bound install's workspace credential
    /// carries the send: the relay fetches it through the install's Cloud
    /// binding and posts it as the bearer on the documented route.
    #[test]
    fn send_falls_back_to_the_workspace_credential() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let _cloud_guard = crate::cloud::tests::ENV_LOCK
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let mut env = EnvGuard::remove(ENVS);
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("probe");
        let api = StubApi::start(200);
        let site = StubApi::start_with_body(
            200,
            format!(
                r#"{{"apiKey":"cog_workspace","orgId":"org-workspace","baseUrl":"{}"}}"#,
                api.url()
            ),
        );
        bound_install(&root, "a", Vec::new(), &site.url(), "ws_test");
        env.set("CLOUD_API_ACCESS_TOKEN", "ar-session-token");
        let config = config(temp.path());
        assert_eq!(
            send_cloud(&config, Some(&root), CLOUD_ID, "hello workspace"),
            Some(InjectOutcome::Delivered)
        );
        let credential_hits = site.requests();
        assert_eq!(credential_hits.len(), 1);
        assert!(
            credential_hits[0]
                .starts_with("GET /cloud/api/v1/workspaces/ws_test/devin/credential "),
            "{}",
            credential_hits[0]
        );
        assert!(credential_hits[0].contains("Bearer ar-session-token"));
        let sends = api.requests();
        assert_eq!(sends.len(), 1);
        assert!(sends[0].starts_with(&format!(
            "POST /v3/organizations/org-workspace/sessions/devin-{CLOUD_ID}/messages "
        )));
        assert!(sends[0].contains("Bearer cog_workspace"));
        // The fetched credential is cached for the next discovery pass.
        assert!(root.join("a").join(CREDENTIAL_CACHE_FILE).exists());
    }

    /// A workspace answering "no Devin connection" keeps the route inert —
    /// `None` leaves the caller's local `Waiting` answer standing.
    #[test]
    fn send_stays_waiting_when_no_workspace_credential_exists() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let _cloud_guard = crate::cloud::tests::ENV_LOCK
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let mut env = EnvGuard::remove(ENVS);
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("probe");
        let site = StubApi::start(404);
        bound_install(&root, "a", Vec::new(), &site.url(), "ws_test");
        env.set("CLOUD_API_ACCESS_TOKEN", "ar-session-token");
        let config = config(temp.path());
        assert!(send_cloud(&config, Some(&root), CLOUD_ID, "hello").is_none());
        assert_eq!(site.requests().len(), 1);
    }

    /// A fresh cached credential sends without re-fetching — the send path
    /// does not pay a Cloud round-trip per message.
    #[test]
    fn send_uses_the_cached_workspace_credential() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let _env = EnvGuard::remove(ENVS);
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("probe");
        let api = StubApi::start(200);
        let site = StubApi::start_with_body(
            200,
            r#"{"apiKey":"cog_workspace","orgId":"org-workspace"}"#.into(),
        );
        bound_install(&root, "a", Vec::new(), &site.url(), "ws_test");
        write_credential_cache(
            &root.join("a"),
            &bound_cache(
                &site.url(),
                "ws_test",
                CachedCredential {
                    api_key: "cog_cached".into(),
                    org_id: "org-cached".into(),
                    base_url: Some(api.url()),
                },
            ),
        );
        let config = config(temp.path());
        assert_eq!(
            send_cloud(&config, Some(&root), CLOUD_ID, "hello"),
            Some(InjectOutcome::Delivered)
        );
        assert!(site.requests().is_empty());
        assert!(api.requests()[0].contains("Bearer cog_cached"));
    }

    /// A rejected cached key gets one re-fetch and retry with the fresh
    /// credential before the send gives up — a key rotated in Cloud must
    /// not refuse the message.
    #[test]
    fn send_refreshes_an_expired_workspace_credential_once() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let _cloud_guard = crate::cloud::tests::ENV_LOCK
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let mut env = EnvGuard::remove(ENVS);
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("probe");
        let api = StubApi::start(401);
        let site = StubApi::start_with_body(
            200,
            format!(
                r#"{{"apiKey":"cog_fresh","orgId":"org-workspace","baseUrl":"{}"}}"#,
                api.url()
            ),
        );
        bound_install(&root, "a", Vec::new(), &site.url(), "ws_test");
        write_credential_cache(
            &root.join("a"),
            &bound_cache(
                &site.url(),
                "ws_test",
                CachedCredential {
                    api_key: "cog_rotated".into(),
                    org_id: "org-workspace".into(),
                    base_url: Some(api.url()),
                },
            ),
        );
        env.set("CLOUD_API_ACCESS_TOKEN", "ar-session-token");
        let config = config(temp.path());
        // Both sends 401: the retried fresh credential fails too. `None`
        // keeps the caller's `Waiting` — the message delivers once the
        // workspace connects a working key, so nothing is refused.
        assert!(send_cloud(&config, Some(&root), CLOUD_ID, "hello").is_none());
        // Stale key sent once, fetched once, fresh key sent once.
        assert_eq!(site.requests().len(), 1);
        let sends = api.requests();
        assert_eq!(sends.len(), 2);
        assert!(sends[0].contains("Bearer cog_rotated"));
        assert!(sends[1].contains("Bearer cog_fresh"));
    }

    /// A workspace credential marks remote rows `live` the same way a
    /// local Devin sign-in does — a machine with no CLI sign-in still
    /// lists its cloud sessions deliverable.
    #[test]
    fn discover_marks_remote_rows_live_on_a_workspace_credential() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let _cloud_guard = crate::cloud::tests::ENV_LOCK
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let mut env = EnvGuard::remove(ENVS);
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("probe");
        let site = StubApi::start_with_body(
            200,
            r#"{"apiKey":"cog_workspace","orgId":"org-workspace"}"#.into(),
        );
        bound_install(
            &root,
            "a",
            vec![remote_row(CLOUD_ID, "Fix the flaky test")],
            &site.url(),
            "ws_test",
        );
        env.set("CLOUD_API_ACCESS_TOKEN", "ar-session-token");
        let config = config(temp.path());
        let found = discover(&config, &root);
        assert_eq!(found.len(), 1);
        assert!(found[0].live);
    }

    /// One install's workspace credential must not mark another install's
    /// rows live: the bound install's sessions deliver, the unbound
    /// install's catalogued rows stay inert.
    #[test]
    fn discover_marks_only_the_connected_install_live() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let _cloud_guard = crate::cloud::tests::ENV_LOCK
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let mut env = EnvGuard::remove(ENVS);
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("probe");
        let site = StubApi::start_with_body(
            200,
            r#"{"apiKey":"cog_workspace","orgId":"org-workspace"}"#.into(),
        );
        let other = "11111111111111111111111111111111";
        bound_install(
            &root,
            "bound",
            vec![remote_row(CLOUD_ID, "workspace-owned")],
            &site.url(),
            "ws_test",
        );
        install_with(&root, "unbound", vec![remote_row(other, "foreign")]);
        env.set("CLOUD_API_ACCESS_TOKEN", "ar-session-token");
        let config = config(temp.path());
        let found = discover(&config, &root);
        assert_eq!(found.len(), 2);
        let live = |id: &str| found.iter().find(|row| row.target.id == id).unwrap().live;
        assert!(live(CLOUD_ID));
        assert!(!live(other));
    }

    /// A credential cached under a different binding — the install re-signed
    /// into another workspace — is never served; the new workspace is asked
    /// for its own answer.
    #[test]
    fn a_rebound_install_never_serves_the_former_workspaces_key() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let _cloud_guard = crate::cloud::tests::ENV_LOCK
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let mut env = EnvGuard::remove(ENVS);
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("probe");
        let api = StubApi::start(200);
        let site = StubApi::start_with_body(
            200,
            format!(
                r#"{{"apiKey":"cog_new_workspace","orgId":"org-new","baseUrl":"{}"}}"#,
                api.url()
            ),
        );
        bound_install(&root, "a", Vec::new(), &site.url(), "ws_new");
        // Pinned to the old binding — freshly written, but a different
        // workspace answered it.
        write_credential_cache(
            &root.join("a"),
            &CredentialCache {
                binding: Some("stale-binding".into()),
                credential: Some(CachedCredential {
                    api_key: "cog_former".into(),
                    org_id: "org-former".into(),
                    base_url: Some(api.url()),
                }),
                fetched_at_ms: now_ms(),
            },
        );
        env.set("CLOUD_API_ACCESS_TOKEN", "ar-session-token");
        let config = config(temp.path());
        assert_eq!(
            send_cloud(&config, Some(&root), CLOUD_ID, "hello"),
            Some(InjectOutcome::Delivered)
        );
        assert_eq!(site.requests().len(), 1);
        let sends = api.requests();
        assert_eq!(sends.len(), 1);
        assert!(sends[0].contains("Bearer cog_new_workspace"));
    }

    /// A failing credential endpoint is negative-cached like a clean
    /// "not connected": discovery passes do not re-hit a down Cloud every
    /// few seconds.
    #[test]
    fn a_failed_credential_fetch_is_rate_limited() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let _cloud_guard = crate::cloud::tests::ENV_LOCK
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let mut env = EnvGuard::remove(ENVS);
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("probe");
        let site = StubApi::start(500);
        bound_install(
            &root,
            "a",
            vec![remote_row(CLOUD_ID, "Fix the flaky test")],
            &site.url(),
            "ws_test",
        );
        env.set("CLOUD_API_ACCESS_TOKEN", "ar-session-token");
        let config = config(temp.path());
        assert!(!discover(&config, &root)[0].live);
        assert!(!discover(&config, &root)[0].live);
        assert_eq!(site.requests().len(), 1);
    }

    /// One workspace's credential reporting a session it does not own
    /// cannot refuse the send — the next bound workspace's credential may
    /// deliver it.
    #[test]
    fn send_tries_each_workspace_binding() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let _cloud_guard = crate::cloud::tests::ENV_LOCK
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let mut env = EnvGuard::remove(ENVS);
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("probe");
        let missing = StubApi::start(404);
        let owning = StubApi::start(200);
        let site_a = StubApi::start_with_body(
            200,
            format!(
                r#"{{"apiKey":"cog_a","orgId":"org-a","baseUrl":"{}"}}"#,
                missing.url()
            ),
        );
        let site_b = StubApi::start_with_body(
            200,
            format!(
                r#"{{"apiKey":"cog_b","orgId":"org-b","baseUrl":"{}"}}"#,
                owning.url()
            ),
        );
        bound_install(&root, "a", Vec::new(), &site_a.url(), "ws_a");
        bound_install(&root, "b", Vec::new(), &site_b.url(), "ws_b");
        env.set("CLOUD_API_ACCESS_TOKEN", "ar-session-token");
        let config = config(temp.path());
        assert_eq!(
            send_cloud(&config, Some(&root), CLOUD_ID, "hello"),
            Some(InjectOutcome::Delivered)
        );
        assert!(owning.requests()[0].contains("Bearer cog_b"));
    }

    /// Every bound workspace answering "no such session" is the route's
    /// word — `Refused`, not an endless `Waiting` retrying a session nobody
    /// owns.
    #[test]
    fn send_is_refused_when_no_bound_workspace_owns_the_session() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let _cloud_guard = crate::cloud::tests::ENV_LOCK
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let mut env = EnvGuard::remove(ENVS);
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("probe");
        let api = StubApi::start(404);
        let site = StubApi::start_with_body(
            200,
            format!(
                r#"{{"apiKey":"cog_a","orgId":"org-a","baseUrl":"{}"}}"#,
                api.url()
            ),
        );
        bound_install(&root, "a", Vec::new(), &site.url(), "ws_a");
        env.set("CLOUD_API_ACCESS_TOKEN", "ar-session-token");
        let config = config(temp.path());
        assert!(matches!(
            send_cloud(&config, Some(&root), CLOUD_ID, "hello"),
            Some(InjectOutcome::Refused(_))
        ));
    }

    /// A permissive pre-existing cache file is tightened before a fresh key
    /// lands in it — the file mode does not outlive its contents.
    #[cfg(unix)]
    #[test]
    fn the_credential_cache_is_written_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let temp = tempfile::tempdir().unwrap();
        let install = temp.path().join("a");
        std::fs::create_dir_all(&install).unwrap();
        let path = credential_cache_path(&install);
        std::fs::write(&path, "{}").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        write_credential_cache(
            &install,
            &CredentialCache {
                binding: None,
                credential: None,
                fetched_at_ms: 0,
            },
        );
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    /// A stub api.devin.ai answering one fixed status, recording the raw
    /// request line and body of each hit.
    struct StubApi {
        url: String,
        requests: std::sync::Arc<Mutex<Vec<String>>>,
    }

    impl StubApi {
        fn start(status: u16) -> Self {
            Self::start_with_body(status, "{}".into())
        }

        /// A stub answering `body` — the credential route's JSON needs more
        /// than the send route's empty object.
        fn start_with_body(status: u16, body: String) -> Self {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            let requests = std::sync::Arc::new(Mutex::new(Vec::new()));
            let seen = requests.clone();
            std::thread::spawn(move || {
                use std::io::{Read, Write};
                for stream in listener.incoming() {
                    let Ok(mut stream) = stream else { return };
                    let mut raw = Vec::new();
                    let mut chunk = [0u8; 8192];
                    // One read serves these tests — ureq sends a small
                    // request in a single write — but loop until the
                    // header/body boundary is seen anyway.
                    while !raw.windows(4).any(|w| w == b"\r\n\r\n") || !has_full_body(&raw) {
                        match stream.read(&mut chunk) {
                            Ok(0) | Err(_) => break,
                            Ok(read) => raw.extend_from_slice(&chunk[..read]),
                        }
                    }
                    seen.lock()
                        .unwrap()
                        .push(String::from_utf8_lossy(&raw).into_owned());

                    let _ = write!(
                        stream,
                        "HTTP/1.1 {status} Answered\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                }
            });
            Self { url, requests }
        }

        fn url(&self) -> String {
            self.url.clone()
        }

        fn requests(&self) -> Vec<String> {
            self.requests.lock().unwrap().clone()
        }
    }

    fn has_full_body(raw: &[u8]) -> bool {
        let text = String::from_utf8_lossy(raw);
        let Some((head, body)) = text.split_once("\r\n\r\n") else {
            return false;
        };
        let expected = head
            .lines()
            .find_map(|line| line.strip_prefix("Content-Length: "))
            .and_then(|value| value.trim().parse::<usize>().ok())
            .unwrap_or(0);
        body.len() >= expected
    }
}

// Without the `history` feature there is no session catalog to list Devin
// Cloud sessions from and no remote connector to send through: nothing is
// discovered and nothing is sent. Nothing marks an id as cloud-only either —
// a cloud-shaped id can name a stopped local Devin session — so the caller's
// local answer always stands: `Waiting` stays `Waiting`, as it does in a
// build with history when no Devin sign-in can carry the send.
#[cfg(not(feature = "history"))]
pub fn discover(
    _config: &crate::relay::devin::DevinConfig,
    _probe_root: &std::path::Path,
) -> Vec<crate::relay::sessions::DiscoveredSession> {
    Vec::new()
}

#[cfg(not(feature = "history"))]
pub fn started_by_automation(_probe_root: &std::path::Path) -> std::collections::HashSet<String> {
    std::collections::HashSet::new()
}

#[cfg(not(feature = "history"))]
pub fn send_cloud(
    _config: &crate::relay::devin::DevinConfig,
    _probe_root: Option<&std::path::Path>,
    _session_id: &str,
    _text: &str,
) -> Option<crate::relay::inject::InjectOutcome> {
    None
}

#[cfg(all(test, not(feature = "history")))]
mod no_history_tests {
    use super::*;

    /// Without session history nothing is sent to Devin Cloud, and no id is
    /// refused for its shape: a cloud-shaped id can name a stopped local
    /// session, so the caller's local answer stands.
    #[test]
    fn no_send_is_made_or_refused_and_nothing_is_discovered() {
        let home = tempfile::tempdir().unwrap();
        let config = crate::relay::devin::DevinConfig {
            data_dir: home.path().join("data"),
            config_dir: home.path().join("config"),
            home: home.path().into(),
            development: false,
        };
        for id in [
            "0123456789abcdef0123456789abcdef",
            "devin-0123456789abcdef0123456789abcdef",
            "real-gallium",
        ] {
            assert!(send_cloud(&config, None, id, "hi").is_none(), "{id}");
        }
        assert!(discover(&config, home.path()).is_empty());
    }
}
