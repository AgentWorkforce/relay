//! Sign-in and stored credentials for the probe: Agent Relay Cloud device
//! approval and bearer reuse, the workspace RelayHistory session exchange, the
//! stage-scoped `rth_*` auth files, and authenticated requests that refresh a
//! rejected access token under a cross-process lock.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use url::Url;

mod rotate_key;
pub use rotate_key::rotate_relay_workspace_key;

/// Locally stored service-local session (never the RelayAuth JWT). Written `0600`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct StoredAuth {
    /// Base URL of the relayhistory-cloud service, e.g. `http://localhost:8787`.
    pub base_url: String,
    pub access_token: String,
    /// Server-issued expiry (RFC 3339). Missing expiry requires refresh.
    #[serde(default)]
    pub access_token_expires_at: Option<String>,
    #[serde(default)]
    pub refresh_token: Option<String>,
    /// Local cache only — never authoritative; the server owns tenancy from the token.
    #[serde(default)]
    pub org_id: Option<String>,
    #[serde(default)]
    pub workspace_id: Option<String>,
}

/// `~/.agentworkforce/relayhistory/` (override with `RELAYHISTORY_HOME` — used by tests).
pub fn config_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("RELAYHISTORY_HOME") {
        return PathBuf::from(dir);
    }
    let home = home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".agentworkforce/relayhistory")
}

fn normalize_base_url(value: &str) -> Option<String> {
    let parsed = Url::parse(value.trim()).ok()?;
    if parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return None;
    }
    Some(parsed.to_string().trim_end_matches('/').to_string())
}

pub(crate) fn normalized_stage(value: &str) -> Result<String> {
    normalize_base_url(value).with_context(|| {
        format!(
            "invalid relayhistory base URL `{}`; expected an absolute URL without credentials, query, or fragment",
            value.trim()
        )
    })
}

/// Refuse to put a credential on the wire in cleartext.
///
/// `base_url` is whatever `login`/`admin-mint` stored, and it is replayed with the `rth_at_`
/// bearer attached by every authenticated request below — `push` on a 300s timer, `pair
/// check` per invocation, `coverage` per run. A single `http://` in `auth.json` therefore
/// leaks the token to anything on the path, repeatedly.
///
/// Loopback is exempt, and deliberately without an opt-in flag: an `http://127.0.0.1`
/// request never reaches a network, so there is nothing to intercept, and `wrangler dev` on
/// `http://localhost:8787` is the documented local flow. Requiring an env var there would
/// buy no security and break the one case where plaintext is actually safe.
///
/// Any other plaintext host needs the existing `RELAYHISTORY_ALLOW_UNTRUSTED_CLOUD_BASE_URL`
/// development opt-in — the same switch that already gates non-default Cloud origins —
/// rather than a second mechanism.
///
/// This is enforced centrally: `send_with_auth_refresh_checked_with_budget` (delivery and
/// any future authenticated request), `refresh_auth_with_agent` (the refresh token) and
/// `try_progress_access_token` (progress heartbeats) all check before a bearer is written,
/// so no call site can forget it.
pub(crate) fn require_secure_transport(base_url: &str) -> Result<()> {
    let normalized = normalized_stage(base_url)?;
    let url = normalized.as_str();
    if url.starts_with("https://") {
        return Ok(());
    }
    if let Some(rest) = url.strip_prefix("http://") {
        if authority_is_loopback(rest) || untrusted_cloud_base_url_allowed() {
            return Ok(());
        }
    }
    anyhow::bail!(
        "refusing to send the relayhistory bearer token in cleartext to `{url}` — use an \
         https:// endpoint. Plain http:// is accepted only for loopback (for example \
         http://127.0.0.1:8787, the `wrangler dev` address), or for another host when \
         RELAYHISTORY_ALLOW_UNTRUSTED_CLOUD_BASE_URL=1 is set for development."
    )
}

/// Does the authority of a URL — everything after `http://` — name this machine?
///
/// Parsed by hand rather than pulled in as a dependency, but the parts that matter for a
/// security decision are all handled: userinfo (`http://127.0.0.1@evil.com/`), the port, and
/// bracketed IPv6. A name that merely looks loopback-ish, like `127.0.0.1.evil.com`, fails
/// both the literal check and the IP parse, so it is rejected.
fn authority_is_loopback(rest: &str) -> bool {
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    // Userinfo is everything before the *last* `@`; the host is what follows it.
    let host_port = authority.rsplit('@').next().unwrap_or_default();
    let host = match host_port.strip_prefix('[') {
        Some(v6) => v6.split(']').next().unwrap_or_default(),
        None => host_port.split(':').next().unwrap_or_default(),
    };
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback())
}

/// The stage's auth file name: the first 16 hex digits of the SHA-256 of its
/// normalized URL. Existing installs' files are named this way, so the scheme
/// is fixed.
fn stage_key(base_url: &str) -> Result<String> {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(normalized_stage(base_url)?.as_bytes());
    Ok(format!("{digest:x}")[..16].to_owned())
}

fn stage_dir() -> PathBuf {
    config_dir().join("stages")
}

fn auth_path(base_url: &str) -> Result<PathBuf> {
    Ok(stage_dir().join(format!("{}.auth.json", stage_key(base_url)?)))
}

fn write_private(path: &std::path::Path, body: &str) -> Result<()> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| std::path::Path::new("."));
    fs::create_dir_all(parent)?;

    static NEXT_TMP_ID: AtomicU64 = AtomicU64::new(0);
    let file_name = path
        .file_name()
        .context("private state path has no file name")?
        .to_string_lossy();
    let tmp_path = parent.join(format!(
        ".{file_name}.tmp.{}.{}",
        std::process::id(),
        NEXT_TMP_ID.fetch_add(1, Ordering::Relaxed)
    ));

    let saved = (|| -> Result<()> {
        let mut options = fs::OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut tmp = options
            .open(&tmp_path)
            .with_context(|| format!("creating private state at {}", tmp_path.display()))?;
        tmp.write_all(body.as_bytes())?;
        tmp.sync_all()?;
        // `std::fs::rename` replaces an existing file on Unix, but not on
        // Windows. `replace_atomic` uses the platform replacement primitive so
        // every cursor/auth update has the same atomic overwrite semantics.
        atomicwrites::replace_atomic(&tmp_path, path)
            .with_context(|| format!("atomically replacing {}", path.display()))?;
        // A directory fsync makes the rename durable on filesystems that support it. Some
        // platforms reject directory sync, so it remains best effort after the file itself is
        // safely flushed and replaced.
        let _ = fs::File::open(parent).and_then(|dir| dir.sync_all());
        Ok(())
    })();
    if saved.is_err() {
        let _ = fs::remove_file(&tmp_path);
    }
    saved
}

fn read_auth(path: &std::path::Path) -> Result<StoredAuth> {
    let body = fs::read_to_string(path)?;
    serde_json::from_str(&body).with_context(|| format!("parsing {}", path.display()))
}

fn staged_auths() -> Result<Vec<StoredAuth>> {
    let dir = stage_dir();
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut auths = Vec::new();
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with(".auth.json"))
        {
            auths.push(read_auth(&path)?);
        }
    }
    Ok(auths)
}

fn same_stage(left: &str, right: &str) -> bool {
    matches!(
        (normalize_base_url(left), normalize_base_url(right)),
        (Some(left), Some(right)) if left == right
    )
}

/// Load one stored session. A caller that knows its destination must pass it explicitly.
/// Without a destination, only a single configured stage is accepted; choosing the last
/// successful login was the old behavior and could silently divert a scheduled push.
pub fn load_auth(base_url: Option<&str>) -> Result<Option<StoredAuth>> {
    if let Some(base_url) = base_url {
        let path = auth_path(base_url)?;
        if path.exists() {
            let auth = read_auth(&path)?;
            anyhow::ensure!(
                same_stage(&auth.base_url, base_url),
                "stored session stage does not match the requested --base-url"
            );
            return Ok(Some(auth));
        }
        return Ok(None);
    }

    let auths = staged_auths()?;
    match auths.len() {
        0 => Ok(None),
        1 => Ok(auths.into_iter().next()),
        count => anyhow::bail!(ambiguous_stage_error(count)),
    }
}

fn ambiguous_stage_error(count: usize) -> String {
    format!(
        "{count} relayhistory stages are configured; pass --base-url to select one. \
         Refusing to guess, because a global cloud session can skip records in another stage."
    )
}

/// The stage selected by the environment, if any. A non-empty value that does not
/// normalize is a mistake rather than a request for production: reject it, because
/// default_base_url() would silently substitute the production origin. Never echo
/// the value — normalize_base_url rejects URLs carrying embedded credentials, so a
/// rejected value is exactly the kind that may hold one.
///
/// access_token and load_selected_auth must share this: when they disagreed about what
/// counts as a selection, a malformed selector silently meant production.
fn env_selected_stage() -> Result<Option<String>> {
    match ["RELAYHISTORY_BASE_URL", "AI_HIST_BASE_URL"]
        .into_iter()
        .filter_map(|key| std::env::var(key).ok().map(|value| (key, value)))
        .find(|(_, value)| !value.trim().is_empty())
    {
        Some((key, value)) => Ok(Some(normalize_base_url(&value).with_context(|| {
            format!("{key} is not a usable base URL; unset it or set a full https:// origin")
        })?)),
        None => Ok(None),
    }
}

/// The selected stage, preserving the difference between "no selection" and
/// "production". Callers that must end up somewhere use resolve_base_url; callers
/// that pass the result to load_auth/load_selected_auth must use this, because turning
/// an absent selection into production suppresses the multi-stage refusal — the
/// caller would silently read production instead of being told to choose.
pub fn resolve_stage(base_url: Option<&str>) -> Result<Option<String>> {
    match base_url {
        Some(explicit) => Ok(Some(explicit.to_string())),
        None => env_selected_stage(),
    }
}

/// Replace parser errors before they surface: a serde_json failure can quote the
/// credential values it choked on, and this command's output is a secret.
fn sanitize_auth_error(error: anyhow::Error) -> anyhow::Error {
    if error.chain().any(|cause| cause.is::<serde_json::Error>()) {
        anyhow::anyhow!("could not parse the stored upload session; sign in to Agent Relay again")
    } else {
        error
    }
}

/// Best-effort renewal for idle progress reporting. Never wait for another
/// transport's refresh lock, and bound the refresh request including its body.
/// The rotated credential pair is persisted through the same atomic store.
pub fn try_progress_access_token(
    base_url: &str,
    timeout: std::time::Duration,
) -> Result<Option<String>> {
    let Some(mut auth) = load_selected_auth(Some(base_url))? else {
        return Ok(None);
    };
    // The caller posts this token to `base_url`; never hand it out for a cleartext stage.
    require_secure_transport(&auth.base_url)?;
    if !token_has_valid_lifetime(&auth) {
        let path = refresh_lock_path(base_url)?;
        let file = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(path)?;
        if let Err(error) = fs2::FileExt::try_lock_exclusive(&file) {
            if crate::platform::fs::lock_held(&error) {
                return Ok(None);
            }
            return Err(error.into());
        }
        let _lock = AuthRefreshLock { _file: file };
        auth = load_selected_auth(Some(base_url))?.context("progress credentials disappeared")?;
        if !token_has_valid_lifetime(&auth) {
            let agent = ureq::AgentBuilder::new()
                .redirects(0)
                .timeout(timeout)
                .build();
            auth = refresh_auth_with_agent(&auth, &agent)
                .map_err(|_| anyhow::anyhow!("progress credential renewal unavailable"))?;
            save_auth(&auth)?;
        }
    }
    Ok((token_has_valid_lifetime(&auth)
        && auth.access_token.starts_with("rth_at_")
        && auth
            .access_token
            .bytes()
            .all(|byte| byte.is_ascii_graphic()))
    .then_some(auth.access_token))
}

/// Whether the access token has at least a minute left before its stored
/// expiry. A session with no stored expiry never does.
pub(crate) fn token_has_valid_lifetime(auth: &StoredAuth) -> bool {
    let expiry = auth
        .access_token_expires_at
        .as_deref()
        .and_then(crate::parse_iso_ms);
    expiry.is_some_and(|expiry| {
        expiry >= chrono::Utc::now().timestamp_millis().saturating_add(60_000)
    })
}

/// Store a session atomically under its normalized stage URL.
pub fn save_auth(auth: &StoredAuth) -> Result<()> {
    let mut stored = auth.clone();
    stored.base_url = normalized_stage(&auth.base_url)?;
    write_private(
        &auth_path(&stored.base_url)?,
        &serde_json::to_string_pretty(&stored)?,
    )
}

/// Remove a stage's stored session and its refresh lock, for a host that
/// stored one only for the life of a command.
pub fn remove_auth(base_url: &str) -> Result<()> {
    for path in [auth_path(base_url)?, refresh_lock_path(base_url)?] {
        match fs::remove_file(&path) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error.into()),
            _ => {}
        }
    }
    Ok(())
}

pub(crate) struct AuthRefreshLock {
    _file: fs::File,
}

fn refresh_lock_path(base_url: &str) -> Result<PathBuf> {
    let auth = auth_path(base_url)?;
    let mut name = auth
        .file_name()
        .context("stage auth path has no file name")?
        .to_os_string();
    name.push(".refresh.lock");
    Ok(auth.with_file_name(name))
}

#[cfg(all(test, feature = "history"))]
fn acquire_refresh_lock(base_url: &str) -> Result<AuthRefreshLock> {
    acquire_refresh_lock_with_budget(base_url, None)
}

#[cfg(feature = "history")]
type RequestBudget<'a> = Option<&'a dyn Fn() -> Result<std::time::Duration>>;

#[cfg(feature = "history")]
fn acquire_refresh_lock_with_budget(
    base_url: &str,
    budget: RequestBudget<'_>,
) -> Result<AuthRefreshLock> {
    let path = refresh_lock_path(base_url)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&path)?;
    if let Some(remaining) = budget {
        loop {
            let wait = remaining()?;
            match fs2::FileExt::try_lock_exclusive(&file) {
                Ok(()) => break,
                Err(error) if crate::platform::fs::lock_held(&error) => {
                    std::thread::sleep(wait.min(std::time::Duration::from_millis(10)));
                }
                Err(error) => return Err(error.into()),
            }
        }
    } else {
        fs2::FileExt::lock_exclusive(&file)
            .with_context(|| format!("locking token refresh state at {}", path.display()))?;
    }
    Ok(AuthRefreshLock { _file: file })
}

#[cfg(feature = "history")]
fn is_unauthorized(error: &ureq::Error) -> bool {
    matches!(error, ureq::Error::Status(401, _))
}

#[cfg(feature = "history")]
/// Share one caller budget across lock acquisition, refresh and every retry.
/// A successful rotation is persisted even if cancellation arrives meanwhile.
///
/// The first attempt uses `auth` as given: the caller passes a session it has
/// just read from the store, or a copy whose access token is still live. A
/// rotation another process made meanwhile is still picked up, because a 401
/// reloads the stored pair under the refresh lock before refreshing.
pub(crate) fn send_with_auth_refresh_checked_with_budget(
    auth: &StoredAuth,
    send: impl Fn(
        &StoredAuth,
        Option<std::time::Duration>,
    ) -> std::result::Result<ureq::Response, Box<ureq::Error>>,
    map_error: impl Fn(ureq::Error) -> anyhow::Error,
    check: impl Fn(&StoredAuth) -> Result<()>,
    budget: RequestBudget<'_>,
) -> Result<ureq::Response> {
    let remaining = || budget.map(|remaining| remaining()).transpose();
    let send = |current: &StoredAuth| -> Result<ureq::Response> {
        // Keep raw HTTP errors until the shared unauthorized/refresh handling.
        send(current, remaining()?).map_err(|error| anyhow::Error::new(*error))
    };
    let mapped = |error: anyhow::Error| match error.downcast::<ureq::Error>() {
        Ok(error) => map_error(error),
        Err(error) => error,
    };
    remaining()?;
    // Every authenticated request funnels through here; refuse cleartext before any bearer
    // (stored, concurrently rotated or refreshed — all share this stage) is written.
    require_secure_transport(&auth.base_url)?;
    let attempted = auth.clone();
    check(&attempted)?;
    let mut unauthorized = match send(&attempted) {
        Ok(response) => return Ok(response),
        Err(error)
            if error
                .downcast_ref::<ureq::Error>()
                .is_some_and(is_unauthorized) =>
        {
            error
        }
        Err(error) => return Err(mapped(error)),
    };

    let _refresh_lock = acquire_refresh_lock_with_budget(&auth.base_url, budget)?;
    let current = load_auth(Some(&auth.base_url))?.unwrap_or_else(|| auth.clone());

    // A concurrent process may have completed rotation while this caller waited. Try its
    // persisted access token before touching the one-time refresh token again.
    check(&current)?;
    if current.access_token != attempted.access_token {
        match send(&current) {
            Ok(response) => return Ok(response),
            Err(error)
                if error
                    .downcast_ref::<ureq::Error>()
                    .is_some_and(is_unauthorized) =>
            {
                unauthorized = error
            }
            Err(error) => return Err(mapped(error)),
        }
    }

    if current
        .refresh_token
        .as_deref()
        .is_none_or(|token| token.trim().is_empty())
    {
        return Err(mapped(unauthorized));
    }
    let refreshed = if let Some(timeout) = remaining()? {
        let agent = ureq::AgentBuilder::new()
            .redirects(0)
            .timeout(timeout)
            .build();
        let refreshed = refresh_auth_with_agent(&current, &agent)?;
        save_auth(&refreshed).context("persisting refreshed relayhistory session")?;
        refreshed
    } else {
        refresh_and_save_auth(&current)?
    };
    check(&refreshed)?;
    send(&refreshed).map_err(mapped)
}

#[cfg(feature = "history")]
/// Send with a command-scoped session that must not consult or mutate the
/// shared auth store. Hosted teardown flushes receive a push-only bearer from
/// Cloud and a 401 is final for that bearer: reloading another user's stored
/// session or entering refresh coordination would cross the command boundary.
pub(crate) fn send_with_fixed_auth_checked_with_budget(
    auth: &StoredAuth,
    send: impl Fn(
        &StoredAuth,
        Option<std::time::Duration>,
    ) -> std::result::Result<ureq::Response, Box<ureq::Error>>,
    map_error: impl Fn(ureq::Error) -> anyhow::Error,
    check: impl Fn(&StoredAuth) -> Result<()>,
    budget: RequestBudget<'_>,
) -> Result<ureq::Response> {
    let remaining = || budget.map(|remaining| remaining()).transpose();
    remaining()?;
    require_secure_transport(&auth.base_url)?;
    check(auth)?;
    send(auth, remaining()?).map_err(|error| map_error(*error))
}

// Callers hold the stage refresh lock and reload the current pair before entering.
#[cfg(feature = "history")]
fn refresh_and_save_auth(auth: &StoredAuth) -> Result<StoredAuth> {
    let refreshed = refresh_auth(auth).context("refreshing relayhistory session")?;
    // Refresh tokens rotate and invalidate their predecessor. Persist the new pair atomically
    // before retrying so a crash or network failure cannot strand the client on the old token.
    save_auth(&refreshed).context("persisting refreshed relayhistory session")?;
    Ok(refreshed)
}

#[cfg(feature = "history")]
fn refresh_auth(auth: &StoredAuth) -> Result<StoredAuth> {
    refresh_auth_with_agent(auth, &ureq::AgentBuilder::new().build())
}

fn refresh_auth_with_agent(auth: &StoredAuth, agent: &ureq::Agent) -> Result<StoredAuth> {
    require_secure_transport(&auth.base_url)?;
    let refresh_token = auth
        .refresh_token
        .as_deref()
        .context("the stored upload session has no refresh token; sign in to Agent Relay again")?;
    let url = format!(
        "{}/v1/auth/token/refresh",
        auth.base_url.trim_end_matches('/')
    );
    let response = agent
        .post(&url)
        .set("Content-Type", "application/json")
        .send_json(serde_json::json!({ "refreshToken": refresh_token }))
        .map_err(map_http_err)?;
    let payload: serde_json::Value = response.into_json()?;
    Ok(StoredAuth {
        base_url: auth.base_url.clone(),
        access_token: field(&payload, "accessToken")?,
        access_token_expires_at: payload
            .get("accessTokenExpiresAt")
            .and_then(|v| v.as_str())
            .map(String::from),
        refresh_token: Some(field(&payload, "refreshToken")?),
        // Tenancy is issued by the service with the rotated token. Older
        // services omit these fields, so preserve the cached values rather
        // than erasing them during refresh.
        org_id: nonblank_field(&payload, "orgId").or_else(|| auth.org_id.clone()),
        workspace_id: nonblank_field(&payload, "workspaceId").or_else(|| auth.workspace_id.clone()),
    })
}

fn nonblank_field(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(String::from)
}

// ---------------------------------------------------------------------------
// Agent Relay Cloud identity
//
// Agent Relay Cloud sign-in: every Cloud bearer comes from `cloud_bearer`
// below, so the trust rules (which origins are Cloud, which credential file
// may be reused, what an approval link must match) exist once. The Cloud
// workspace bridge (`workspace_session`) exchanges that bearer for the
// workspace's RelayHistory stage and its `rth_*` session; Cloud authorizes
// workspace membership and picks the stage, so the probe only checks that
// what came back is a trusted history origin.
//
// Requests here are made with, and answered with, credentials, so this section
// keeps its own HTTP helpers: `map_http_err` echoes response bodies and must
// not be used below.
// ---------------------------------------------------------------------------

/// A Cloud sign-in outcome that is safe to show a person verbatim: a fixed
/// sentence that never carries a response body, credential or URL. Hosts that
/// otherwise reduce errors to a generic fallback may print this one.
#[derive(Debug)]
pub struct CloudAuthError(pub &'static str);
impl std::fmt::Display for CloudAuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for CloudAuthError {}
fn auth_error(message: &'static str) -> anyhow::Error {
    CloudAuthError(message).into()
}

const DEFAULT_CLOUD_API_URL: &str = "https://agentrelay.com/cloud";

const NON_INTERACTIVE_LOGIN: &str = "Agent Relay Cloud login requires an interactive terminal. Re-run in a terminal, or provide --token / CLOUD_API_ACCESS_TOKEN.";

/// The documented development opt-in, shared with `validate_cloud_exchange_base_url`.
fn untrusted_cloud_base_url_allowed() -> bool {
    std::env::var("RELAYHISTORY_ALLOW_UNTRUSTED_CLOUD_BASE_URL")
        .ok()
        .is_some_and(|value| value == "1" || value.eq_ignore_ascii_case("true"))
}

fn is_loopback_origin(url: &Url) -> bool {
    matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
}

/// The Agent Relay Cloud site this process will talk to, as a normalized origin.
///
/// Production is `https://agentrelay.com` exactly; loopback over http is the
/// documented local-development site. Any other https origin requires the same
/// explicit opt-in that lets a Cloud bearer reach a non-default RelayHistory.
pub fn site_origin(site: &str) -> Result<String> {
    let url = Url::parse(site.trim())?;
    let local = is_loopback_origin(&url);
    anyhow::ensure!(
        (local && url.scheme() == "http")
            || (!local
                && url.scheme() == "https"
                && ((url.host_str() == Some("agentrelay.com") && url.port().is_none())
                    || untrusted_cloud_base_url_allowed())),
        "untrusted site"
    );
    anyhow::ensure!(
        url.username().is_empty()
            && url.password().is_none()
            && url.path() == "/"
            && url.query().is_none()
            && url.fragment().is_none(),
        "site must be an origin"
    );
    Ok(url.origin().ascii_serialization())
}

/// Returns the normalized origin. Callers store and compare that, never the
/// raw value: a trailing slash survives the checks below and would then be
/// concatenated into request paths as `//v1/...`.
pub fn history_origin(raw: &str, site: &str) -> Result<String> {
    let url = Url::parse(raw.trim())?;
    let local = is_loopback_origin(&Url::parse(site.trim())?);
    anyhow::ensure!(
        (local && is_loopback_origin(&url) && url.scheme() == "http")
            || (!local
                && url.scheme() == "https"
                && url.host_str() == Some(PRODUCTION_HISTORY_HOST)
                && url.port().is_none()),
        "untrusted history origin"
    );
    history_url_origin(url)
}

const PRODUCTION_HISTORY_HOST: &str = "history.agentrelay.com";
/// The RelayHistory hosts a session Cloud pushed to a hosted sandbox may name:
/// production, and the `dev` stage that relayhistory-cloud deploys as
/// `dev.history.agentrelay.com` (`stageTarget` in its
/// `scripts/deploy-cloudflare.mjs`). Compiled in: a pushed session cannot
/// widen it, and no environment switch does either.
const PUSHED_HISTORY_HOSTS: &[&str] = &[PRODUCTION_HISTORY_HOST, "dev.history.agentrelay.com"];

/// [`history_origin`] for a session pushed with no Cloud site beside it
/// (`history flush`): one of [`PUSHED_HISTORY_HOSTS`] over https on its
/// default port, or loopback http, the same local development stage
/// `history_origin` accepts beside a loopback site.
pub fn pushed_history_origin(raw: &str) -> Result<String> {
    let url = Url::parse(raw.trim())?;
    anyhow::ensure!(
        (is_loopback_origin(&url) && url.scheme() == "http")
            || (url.scheme() == "https"
                && url
                    .host_str()
                    .is_some_and(|host| PUSHED_HISTORY_HOSTS.contains(&host))
                && url.port().is_none()),
        "untrusted history origin"
    );
    history_url_origin(url)
}

/// A trusted history URL's origin, refusing anything beyond one.
fn history_url_origin(url: Url) -> Result<String> {
    anyhow::ensure!(
        url.username().is_empty()
            && url.password().is_none()
            && url.path() == "/"
            && url.query().is_none()
            && url.fragment().is_none(),
        "invalid history URL"
    );
    Ok(url.origin().ascii_serialization())
}

/// The Cloud API root: explicit selection, else `CLOUD_API_URL`, else production.
/// Always `{trusted site origin}/cloud`, without a trailing slash.
pub fn cloud_api_url(explicit: Option<&str>) -> Result<String> {
    let selected = explicit
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(String::from)
        .or_else(|| {
            std::env::var("CLOUD_API_URL")
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        })
        .unwrap_or_else(|| DEFAULT_CLOUD_API_URL.to_string());
    Ok(format!("{}/cloud", cloud_site(&selected)?))
}

/// The site origin backing a Cloud API URL.
pub fn cloud_site(api_url: &str) -> Result<String> {
    let origin = api_url
        .trim()
        .trim_end_matches('/')
        .strip_suffix("/cloud")
        .context("Agent Relay Cloud API URL must be an origin followed by `/cloud`")?;
    site_origin(origin)
}

fn cloud_json_response(response: ureq::Response) -> Result<serde_json::Value> {
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(1_048_577)
        .read_to_end(&mut bytes)?;
    anyhow::ensure!(bytes.len() <= 1_048_576, "response too large");
    Ok(serde_json::from_slice(&bytes)?)
}

const CLOUD_UNREACHABLE: &str =
    "Could not reach Agent Relay Cloud. Check your connection and try again.";

/// Bounded, redirect-free Cloud request. The status is returned rather than
/// raised, and no response body ever reaches an error message.
fn cloud_request(
    method: &str,
    url: &str,
    bearer: Option<&str>,
    body: Option<serde_json::Value>,
) -> Result<(u16, serde_json::Value)> {
    let response =
        cloud_send(method, url, bearer, body).ok_or_else(|| auth_error(CLOUD_UNREACHABLE))?;
    let status = response.status();
    Ok((status, cloud_json_response(response)?))
}

/// [`cloud_request`]'s exchange: `None` when Cloud did not answer.
fn cloud_send(
    method: &str,
    url: &str,
    bearer: Option<&str>,
    body: Option<serde_json::Value>,
) -> Option<ureq::Response> {
    let agent = ureq::AgentBuilder::new()
        .redirects(0)
        .timeout(std::time::Duration::from_secs(15))
        .build();
    let mut request = agent.request(method, url);
    if let Some(bearer) = bearer {
        request = request.set("Authorization", &format!("Bearer {bearer}"));
    }
    match if let Some(body) = body {
        request.send_json(body)
    } else {
        request.call()
    } {
        Ok(response) => Some(response),
        Err(ureq::Error::Status(_, response)) => Some(response),
        Err(_) => None,
    }
}

/// What the user must open to approve this computer. `user_code` is present
/// only when the approval URL does not already carry it.
pub struct DeviceApproval {
    pub verification_uri: String,
    pub verification_uri_complete: Option<String>,
    pub user_code: Option<String>,
    pub expires_at: String,
    pub interval: u64,
}

/// How a caller wants `cloud_bearer` to behave when no credential is at hand.
/// `announce` is how the approval link reaches the user: each front end owns
/// its output channel (probe stdout, CLI stderr, the helper's terminal).
pub struct CloudBearerOptions<'a> {
    pub force_login: bool,
    pub interactive: bool,
    pub client_name: &'a str,
    pub announce: &'a mut dyn FnMut(&DeviceApproval),
}

/// The official Agent Relay CLI's own session file. Read only: it belongs to
/// that CLI, which owns writing and refreshing it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OfficialCliSession {
    api_url: String,
    access_token: String,
    access_token_expires_at: String,
}

/// The home folder: on Windows the profile first, where Claude Code and
/// Codex keep their files, since MSYS2 and Git Bash set `HOME` elsewhere.
fn home_dir() -> Option<PathBuf> {
    let read = |key: &str| std::env::var_os(key).filter(|value| !value.is_empty());
    if cfg!(windows) {
        read("USERPROFILE").or_else(|| read("HOME"))
    } else {
        read("HOME").or_else(|| read("USERPROFILE"))
    }
    .map(PathBuf::from)
}

/// A token for `api_url` with more than a minute left.
fn live(api_url: &str, session_api_url: &str, token: String, expires_at: &str) -> Option<String> {
    if session_api_url.trim().trim_end_matches('/') != api_url {
        return None;
    }
    let expires_at = crate::parse_iso_ms(expires_at)?;
    (expires_at > chrono::Utc::now().timestamp_millis() + 60_000).then_some(token)
}

/// The app data directory the relay core runs the probe with, so its
/// renewal reads that build's store; the default one when unset.
pub const APP_DATA_DIR_VARIABLE: &str = "AGENT_RELAY_APP_DATA_DIR";

/// The desktop app's own sign-in, kept by the relay core in the agent
/// store's `cloudSession` (`{"accessToken","accessTokenExpiresAt","siteURL"}`).
/// Read only: the core owns refreshing it, and refreshes it whenever an
/// upload waits on sign-in.
fn desktop_bearer(api_url: &str, home: &std::path::Path) -> Option<String> {
    let env = |key: &str| std::env::var(key).ok();
    let data = std::env::var_os(APP_DATA_DIR_VARIABLE)
        .map(PathBuf::from)
        .filter(|dir| dir.is_absolute())
        .unwrap_or_else(|| crate::relay::app_store::default_data_dir(&env, home));
    let path = data.join(crate::relay::app_store::STORE_FILE);
    let store: serde_json::Value = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    let session = &store["cloudSession"];
    live(
        api_url,
        &format!("{}/cloud", session["siteURL"].as_str()?),
        session["accessToken"].as_str()?.to_string(),
        session["accessTokenExpiresAt"].as_str()?,
    )
}

/// Reuse the official CLI's sign-in, then the desktop app's, only for the
/// exact same Cloud and only while it has real lifetime left; anything else
/// falls through to a fresh device login rather than forwarding a
/// credential to another host.
fn official_cli_bearer(api_url: &str) -> Option<String> {
    let home = home_dir()?;
    let cli = fs::read(home.join(".agentworkforce/relay/cloud-auth.json"))
        .ok()
        .and_then(|raw| serde_json::from_slice::<OfficialCliSession>(&raw).ok())
        .and_then(|session| {
            live(
                api_url,
                &session.api_url,
                session.access_token,
                &session.access_token_expires_at,
            )
        });
    cli.or_else(|| desktop_bearer(api_url, &home))
}

/// An Agent Relay Cloud bearer for `api_url`: the environment override, then
/// the official CLI's eligible session, then the OAuth device flow.
pub fn cloud_bearer(api_url: &str, options: CloudBearerOptions<'_>) -> Result<String> {
    if let Some(token) = env_cloud_bearer() {
        return Ok(token);
    }
    if !options.force_login {
        if let Some(token) = official_cli_bearer(api_url) {
            return Ok(token);
        }
    }
    if !options.interactive {
        return Err(auth_error(NON_INTERACTIVE_LOGIN));
    }
    device_login(api_url, options.client_name, options.announce)
}

fn env_cloud_bearer() -> Option<String> {
    std::env::var("CLOUD_API_ACCESS_TOKEN")
        .ok()
        .map(|token| token.trim().to_string())
        .filter(|token| !token.is_empty())
}

fn device_login(
    api_url: &str,
    client_name: &str,
    announce: &mut dyn FnMut(&DeviceApproval),
) -> Result<String> {
    let site = cloud_site(api_url)?;
    let (status, grant) = cloud_request(
        "POST",
        &format!("{api_url}/api/v1/auth/device/start"),
        None,
        Some(serde_json::json!({ "client_name": client_name })),
    )?;
    anyhow::ensure!(matches!(status, 200 | 201), "device start rejected");
    let device_code = grant["device_code"]
        .as_str()
        .ok_or_else(|| auth_error("Cloud did not start device sign-in."))?;
    let complete = grant["verification_uri_complete"].as_str();
    let original = grant["verification_uri"].as_str();
    let verification = Url::parse(
        complete
            .or_else(|| grant["verification_uri"].as_str())
            .context("Cloud did not return a sign-in URL.")?,
    )?;
    // Bind approval to the selected environment before anything is shown or
    // polled: a link on another origin is a phishing target, not a sign-in.
    anyhow::ensure!(
        verification.origin().ascii_serialization() == site
            && verification.username().is_empty()
            && verification.password().is_none(),
        "wrong sign-in origin"
    );
    let expires_in = grant["expires_in"].as_u64().unwrap_or(600).clamp(1, 900);
    let expires_at = chrono::Utc::now() + chrono::Duration::seconds(expires_in as i64);
    let mut interval = grant["interval"].as_u64().unwrap_or(5).clamp(1, 60);
    announce(&DeviceApproval {
        verification_uri: original.unwrap_or(verification.as_str()).to_string(),
        verification_uri_complete: complete.map(String::from),
        user_code: grant["user_code"].as_str().map(String::from),
        expires_at: expires_at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        interval,
    });
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(expires_in);
    while std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_secs(interval));
        let result = cloud_request(
            "POST",
            &format!("{api_url}/api/v1/auth/device/token"),
            None,
            Some(serde_json::json!({
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                "device_code": device_code
            })),
        );
        let (status, token) = match result {
            Ok(value) => value,
            Err(_) => continue,
        };
        if status == 200 {
            anyhow::ensure!(
                token["api_url"]
                    .as_str()
                    .is_none_or(|url| url.trim_end_matches('/') == api_url),
                "Cloud origin changed"
            );
            return token["access_token"]
                .as_str()
                .filter(|value| !value.is_empty())
                .map(String::from)
                .context("Cloud sign-in did not return credentials.");
        }
        if status == 429 || token["error"] == "slow_down" {
            interval = (interval + 5).min(60);
            continue;
        }
        if status >= 500 || token["error"] == "authorization_pending" {
            continue;
        }
        return Err(auth_error(
            "Device sign-in was declined or expired. Run setup again.",
        ));
    }
    Err(auth_error("Device sign-in expired. Run setup again."))
}

/// Who the Cloud bearer belongs to. `workspace_id` is Cloud's current
/// workspace, a default a caller may use, never an authorization.
pub struct CloudIdentity {
    pub workspace_name: Option<String>,
    pub user_id: String,
    pub email: Option<String>,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
    pub workspace_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WhoamiUser {
    id: String,
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    avatar_url: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WhoamiResponse {
    user: WhoamiUser,
    current_workspace: Option<WhoamiUser>,
}

/// `GET {api_url}/api/v1/auth/whoami` — identity only. `cloud_bearer` does not
/// call this: callers that need an identity ask for one explicitly.
pub fn whoami(api_url: &str, bearer: &str) -> Result<CloudIdentity> {
    let (status, value) = cloud_request(
        "GET",
        &format!("{api_url}/api/v1/auth/whoami"),
        Some(bearer),
        None,
    )?;
    if status != 200 {
        return Err(auth_error("Cloud authentication failed."));
    }
    let identity: WhoamiResponse = serde_json::from_value(value)?;
    Ok(CloudIdentity {
        user_id: identity.user.id,
        email: identity.user.email,
        name: identity.user.name,
        avatar_url: identity.user.avatar_url,
        workspace_name: identity
            .current_workspace
            .as_ref()
            .and_then(|workspace| workspace.name.clone()),
        workspace_id: identity.current_workspace.map(|workspace| workspace.id),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceSessionResponse {
    base_url: String,
    org_id: String,
    workspace_id: String,
    access_token: String,
    refresh_token: String,
    access_token_expires_at: String,
    #[serde(default)]
    scopes: Vec<String>,
}

/// The Cloud workspace bridge: `POST
/// {api_url}/api/v1/workspaces/{workspace}/relayhistory/session`. Cloud
/// authorizes membership and returns the RelayHistory stage together with a
/// workspace-scoped `rth_*` session for it.
pub fn workspace_session(
    api_url: &str,
    bearer: &str,
    workspace: &str,
    mode: &str,
    label: &str,
) -> Result<StoredAuth> {
    let session = match issue_workspace_session(api_url, bearer, workspace, mode, label)? {
        Issued::Session(session) => session,
        Issued::Unreachable => return Err(auth_error(CLOUD_UNREACHABLE)),
        // Keep response bodies private while giving an actionable cause.
        Issued::Status(status) => {
            return Err(auth_error(match status {
                401 => "Your sign-in expired. Sign in again.",
                403 => "Your account cannot connect this workspace to RelayHistory. Check your workspace access in the dashboard.",
                404 => "This workspace is unavailable. Open your workspace in the dashboard and connect the app again.",
                429 => "Too many connection attempts. Wait a moment, then try again.",
                500..=599 => "You are signed in, but Cloud could not start your history connection. Please try again shortly. If this continues, contact support.",
                _ => "Cloud could not connect this workspace to RelayHistory. Please try again or contact support.",
            }))
        }
    };
    anyhow::ensure!(
        session.workspace_id.as_deref() == Some(workspace),
        "invalid scoped session"
    );
    Ok(session)
}

use workspace_session::{issue_workspace_session, Issued};

mod workspace_session;

#[cfg(feature = "history")]
pub(crate) mod devin_credential;

/// The Agent Relay credential renewal uses, needing no interaction:
/// `CLOUD_API_ACCESS_TOKEN`, then the official Agent Relay CLI's live session
/// for this exact Cloud, then the desktop app's kept `cloudSession` (which the
/// relay core refreshes while an upload waits on sign-in). Each must have more
/// than a minute left. `None` when there is none, so a background process
/// never starts a device login.
pub fn renewal_bearer(api_url: &str) -> Option<String> {
    env_cloud_bearer().or_else(|| official_cli_bearer(api_url))
}

/// Why a renewal produced no session, as an allowlisted code.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RenewalFailure {
    /// No Agent Relay sign-in with time left (`renewal_bearer`).
    NoCloudSession,
    /// Cloud refused the person or workspace (401, 403, 404), or issued
    /// no usable session.
    CloudRefused,
    /// Cloud did not answer, was rate limiting (429) or was failing (5xx).
    CloudUnreachable,
    /// Cloud issued a session for another stage, organization or workspace.
    WrongDestination,
}

impl RenewalFailure {
    pub fn code(self) -> &'static str {
        match self {
            RenewalFailure::NoCloudSession => "no_cloud_session",
            RenewalFailure::CloudRefused => "cloud_refused",
            RenewalFailure::CloudUnreachable => "cloud_unreachable",
            RenewalFailure::WrongDestination => "wrong_destination",
        }
    }

    pub fn parse(code: &str) -> Option<RenewalFailure> {
        [
            RenewalFailure::NoCloudSession,
            RenewalFailure::CloudRefused,
            RenewalFailure::CloudUnreachable,
            RenewalFailure::WrongDestination,
        ]
        .into_iter()
        .find(|failure| failure.code() == code)
    }
}

/// What one renewal did.
#[derive(Debug)]
pub enum Renewal {
    /// A new session is saved.
    Renewed(StoredAuth),
    /// Another process holds this stage's rotation lock; the next pass retries.
    Busy,
    Failed(RenewalFailure),
}

/// Re-derive a connected workspace's `rth_*` session from Agent Relay's own
/// sign-in, `bearer` (`renewal_bearer`), without a person.
///
/// The stored `rth_*` pair is a cache of what `workspace_session` issued at
/// setup, not an identity of its own: when its one-time refresh token is
/// revoked, expires or is lost, the probe asks Cloud for a fresh session with
/// the same Agent Relay credential setup uses. `Err` is a local failure (the
/// rotation lock or the store); every remote outcome is a `Renewal`.
///
/// The renewed session must name the stage and tenancy the install was set up
/// with, so renewal can never divert uploads to another destination.
pub fn renew_workspace_session(
    api_url: &str,
    bearer: &str,
    workspace: &str,
    history_url: &str,
    org_id: &str,
) -> Result<Renewal> {
    // Serialize with refresh so a concurrent rotation neither overwrites nor
    // is overwritten by this session. Never wait; the next pass retries.
    let path = refresh_lock_path(history_url)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)?;
    if let Err(error) = fs2::FileExt::try_lock_exclusive(&file) {
        if crate::platform::fs::lock_held(&error) {
            return Ok(Renewal::Busy);
        }
        return Err(error.into());
    }
    let _lock = AuthRefreshLock { _file: file };
    let session = match issue_workspace_session(
        api_url,
        bearer,
        workspace,
        "sync",
        "Probe session renewal",
    ) {
        Ok(Issued::Session(session)) => session,
        // Cloud refusing this person or workspace needs them; a rate limit
        // or an outage passes by itself.
        Ok(Issued::Status(401 | 403 | 404)) => {
            return Ok(Renewal::Failed(RenewalFailure::CloudRefused))
        }
        Ok(Issued::Status(429 | 500..=599) | Issued::Unreachable) => {
            return Ok(Renewal::Failed(RenewalFailure::CloudUnreachable))
        }
        // Any other status, or an answer that is not a usable session.
        Ok(Issued::Status(_)) | Err(_) => return Ok(Renewal::Failed(RenewalFailure::CloudRefused)),
    };
    if !(same_stage(&session.base_url, history_url)
        && session.org_id.as_deref() == Some(org_id)
        && session.workspace_id.as_deref() == Some(workspace))
    {
        return Ok(Renewal::Failed(RenewalFailure::WrongDestination));
    }
    save_auth(&session)?;
    Ok(Renewal::Renewed(session))
}

fn field(v: &serde_json::Value, key: &str) -> Result<String> {
    v.get(key)
        .and_then(|x| x.as_str())
        .map(String::from)
        .with_context(|| format!("response missing `{key}`"))
}

fn map_http_err(e: ureq::Error) -> anyhow::Error {
    match e {
        ureq::Error::Status(code, r) => {
            let body = r.into_string().unwrap_or_default();
            anyhow::anyhow!("HTTP {code}: {body}")
        }
        other => other.into(),
    }
}

/// Read the sole credential store using explicit, environment, or single-stage selection.
pub fn load_selected_auth(base_url: Option<&str>) -> Result<Option<StoredAuth>> {
    let selected = resolve_stage(base_url)?;
    load_auth(selected.as_deref()).map_err(sanitize_auth_error)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    #[test]
    fn workspace_session_errors_distinguish_failures_without_exposing_response_bodies() {
        for (status, expected) in [
            (401, "sign-in expired"),
            (403, "workspace access"),
            (404, "workspace is unavailable"),
            (429, "Too many connection attempts"),
            (502, "You are signed in"),
            (400, "contact support"),
        ] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let api_url = format!("http://{}/cloud", listener.local_addr().unwrap());
            let server = std::thread::spawn(move || {
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
                let mut stream = loop {
                    match listener.accept() {
                        Ok((stream, _)) => break stream,
                        Err(error)
                            if error.kind() == std::io::ErrorKind::WouldBlock
                                && std::time::Instant::now() < deadline =>
                        {
                            std::thread::sleep(std::time::Duration::from_millis(10));
                        }
                        Err(error) => panic!("workspace request missing: {error}"),
                    }
                };
                // Accepted sockets inherit nonblocking mode on macOS.
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                    .unwrap();
                let mut request = Vec::new();
                let mut buffer = [0; 1024];
                let header_end = loop {
                    if let Some(at) = request.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                        break at + 4;
                    }
                    let count = stream.read(&mut buffer).unwrap();
                    assert!(count > 0);
                    request.extend_from_slice(&buffer[..count]);
                };
                let head = String::from_utf8_lossy(&request[..header_end]).to_string();
                assert!(head.starts_with(
                    "POST /cloud/api/v1/workspaces/workspace_1/relayhistory/session "
                ));
                // Read the whole body: closing with unread request bytes
                // resets the connection, and the client can see that reset
                // before the response.
                let length = head
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().ok())
                            .flatten()
                    })
                    .unwrap_or(0);
                while request.len() < header_end + length {
                    let count = stream.read(&mut buffer).unwrap();
                    assert!(count > 0);
                    request.extend_from_slice(&buffer[..count]);
                }
                let body = r#"{"error":"private-upstream-token","code":"private-upstream-token"}"#;
                write!(stream, "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            });
            let error =
                workspace_session(&api_url, "cld_at_private", "workspace_1", "sync", "test")
                    .unwrap_err();
            server.join().unwrap();
            assert!(error.downcast_ref::<CloudAuthError>().is_some());
            let message = error.to_string();
            assert!(message.contains(expected), "{status}: {message}");
            assert!(!message.contains("private"));
        }
    }

    // RELAYHISTORY_HOME is process-global; serialize env-home tests so cargo's parallel
    // runner can't clobber it across tests.
    pub(crate) static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    struct EnvVarGuard {
        key: &'static str,
        previous: Option<std::ffi::OsString>,
    }

    impl EnvVarGuard {
        fn set(key: &'static str, value: impl AsRef<std::ffi::OsStr>) -> Self {
            let previous = std::env::var_os(key);
            std::env::set_var(key, value);
            Self { key, previous }
        }

        fn remove(key: &'static str) -> Self {
            let previous = std::env::var_os(key);
            std::env::remove_var(key);
            Self { key, previous }
        }
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            if let Some(value) = &self.previous {
                std::env::set_var(self.key, value);
            } else {
                std::env::remove_var(self.key);
            }
        }
    }

    fn with_temp_home<T>(f: impl FnOnce() -> T) -> T {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        let _relayhistory_home = EnvVarGuard::set("RELAYHISTORY_HOME", dir.path());
        f()
    }

    fn read_http_request(
        stream: &mut std::net::TcpStream,
    ) -> (String, std::collections::HashMap<String, String>, String) {
        use std::io::{BufRead, BufReader, Read};

        // Accepted sockets inherit nonblocking mode on macOS.
        stream.set_nonblocking(false).unwrap();
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(5)))
            .unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut first_line = String::new();
        reader.read_line(&mut first_line).unwrap();
        let mut headers = std::collections::HashMap::new();
        let mut content_length = 0usize;
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            let trimmed = line.trim_end();
            if trimmed.is_empty() {
                break;
            }
            if let Some((name, value)) = trimmed.split_once(':') {
                let name = name.to_ascii_lowercase();
                let value = value.trim().to_string();
                if name == "content-length" {
                    content_length = value.parse().unwrap();
                }
                headers.insert(name, value);
            }
        }
        let mut body = vec![0; content_length];
        reader.read_exact(&mut body).unwrap();
        (first_line, headers, String::from_utf8(body).unwrap())
    }

    fn write_http_response(stream: &mut std::net::TcpStream, status: &str, body: &str) {
        use std::io::Write;

        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(response.as_bytes()).unwrap();
    }

    #[test]
    fn write_private_replaces_existing_state() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cursor.json");

        write_private(&path, r#"{"history_id":1}"#).unwrap();
        write_private(&path, r#"{"history_id":2}"#).unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), r#"{"history_id":2}"#);
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn auth_round_trips_on_disk() {
        with_temp_home(|| {
            let auth = StoredAuth {
                base_url: "http://localhost:8787".into(),
                access_token: "rth_at_x".into(),
                access_token_expires_at: None,
                refresh_token: Some("rth_rt_y".into()),
                org_id: Some("org-a".into()),
                workspace_id: None,
            };
            save_auth(&auth).unwrap();
            assert_eq!(load_auth(Some(&auth.base_url)).unwrap().unwrap(), auth);
        });
    }

    // Windows refuses to replace a file another thread holds open, which
    // this test's concurrent readers do; the probe saves auth from one
    // thread, so the race it checks is a Unix one.
    #[cfg(unix)]
    #[test]
    fn concurrent_auth_saves_never_publish_partial_json() {
        with_temp_home(|| {
            let mut writers = Vec::new();
            for writer in 0..8 {
                writers.push(std::thread::spawn(move || {
                    for revision in 0..40 {
                        save_auth(&StoredAuth {
                            base_url: "http://localhost:8787".into(),
                            access_token: format!("rth_at_{writer}_{revision}"),
                            access_token_expires_at: None,
                            refresh_token: Some(format!("rth_rt_{writer}_{revision}")),
                            ..Default::default()
                        })
                        .unwrap();
                    }
                }));
            }
            for writer in writers {
                writer.join().unwrap();
            }

            let stored = load_auth(Some("http://localhost:8787")).unwrap().unwrap();
            assert!(stored.access_token.starts_with("rth_at_"));
            assert!(stored
                .refresh_token
                .as_deref()
                .is_some_and(|token| token.starts_with("rth_rt_")));
            let leftovers: Vec<_> = fs::read_dir(stage_dir())
                .unwrap()
                .filter_map(|entry| entry.ok())
                .filter(|entry| entry.file_name().to_string_lossy().contains(".tmp."))
                .collect();
            assert!(
                leftovers.is_empty(),
                "leftover auth temp files: {leftovers:?}"
            );
        });
    }

    #[cfg(feature = "history")]
    #[test]
    fn concurrent_401s_share_one_rotated_refresh_token() {
        with_temp_home(|| {
            use std::sync::{Arc, Barrier};

            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let addr = listener.local_addr().unwrap();
            let refreshes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let server_refreshes = Arc::clone(&refreshes);
            let server = std::thread::spawn(move || {
                let started = std::time::Instant::now();
                let mut handled = 0;
                while handled < 5 && started.elapsed() < std::time::Duration::from_secs(10) {
                    let (mut stream, _) = match listener.accept() {
                        Ok(connection) => connection,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            std::thread::sleep(std::time::Duration::from_millis(5));
                            continue;
                        }
                        Err(error) => panic!("accept failed: {error}"),
                    };
                    handled += 1;
                    let (line, headers, body) = read_http_request(&mut stream);
                    if line.starts_with("POST /v1/auth/token/refresh ") {
                        assert_eq!(
                            serde_json::from_str::<serde_json::Value>(&body).unwrap()
                                ["refreshToken"],
                            "rth_rt_old"
                        );
                        let prior = server_refreshes.fetch_add(1, Ordering::SeqCst);
                        if prior == 0 {
                            write_http_response(
                                &mut stream,
                                "200 OK",
                                r#"{"accessToken":"rth_at_fresh","refreshToken":"rth_rt_fresh"}"#,
                            );
                        } else {
                            write_http_response(
                                &mut stream,
                                "401 Unauthorized",
                                r#"{"error":"refresh token already rotated"}"#,
                            );
                        }
                        continue;
                    }

                    assert!(line.starts_with("POST /v1/delivery/batches "), "{line}");
                    match headers.get("authorization").map(String::as_str) {
                        Some("Bearer rth_at_expired") => write_http_response(
                            &mut stream,
                            "401 Unauthorized",
                            r#"{"error":"invalid_token"}"#,
                        ),
                        Some("Bearer rth_at_fresh") => {
                            write_http_response(&mut stream, "200 OK", r#"{}"#)
                        }
                        other => panic!("unexpected authorization header: {other:?}"),
                    }
                }
                assert_eq!(
                    handled, 5,
                    "expected two initial calls, one refresh, two retries"
                );
            });

            let auth = StoredAuth {
                base_url: format!("http://{addr}"),
                access_token: "rth_at_expired".into(),
                access_token_expires_at: None,
                refresh_token: Some("rth_rt_old".into()),
                org_id: Some("org-a".into()),
                workspace_id: Some("ws-a".into()),
            };
            save_auth(&auth).unwrap();
            let barrier = Arc::new(Barrier::new(3));
            let mut clients = Vec::new();
            for _ in 0..2 {
                let auth = auth.clone();
                let barrier = Arc::clone(&barrier);
                clients.push(std::thread::spawn(move || {
                    barrier.wait();
                    authed_post(&auth)
                }));
            }
            barrier.wait();
            for client in clients {
                assert_eq!(client.join().unwrap().unwrap().status(), 200);
            }
            server.join().unwrap();

            assert_eq!(refreshes.load(Ordering::SeqCst), 1);
            let stored = load_auth(Some(&auth.base_url)).unwrap().unwrap();
            assert_eq!(stored.access_token, "rth_at_fresh");
            assert_eq!(stored.refresh_token.as_deref(), Some("rth_rt_fresh"));
        });
    }

    #[cfg(feature = "history")]
    /// One authenticated upload request, through the refresh path every
    /// delivery takes.
    fn authed_post(auth: &StoredAuth) -> Result<ureq::Response> {
        let url = format!("{}/v1/delivery/batches", normalized_stage(&auth.base_url)?);
        let agent = ureq::AgentBuilder::new().redirects(0).build();
        // A delivery reads the stored session before it sends.
        let auth = load_auth(Some(&auth.base_url))?.unwrap_or_else(|| auth.clone());
        send_with_auth_refresh_checked_with_budget(
            &auth,
            |current, _| {
                agent
                    .post(&url)
                    .set("Authorization", &format!("Bearer {}", current.access_token))
                    .send_string("{}")
                    .map_err(Box::new)
            },
            |error| anyhow::anyhow!("{error}"),
            |_| Ok(()),
            None,
        )
    }

    #[cfg(feature = "history")]
    /// Serve exactly one `POST /v1/auth/token/refresh` with `body`, then stop.
    fn one_refresh_response(body: &'static str) -> (String, std::thread::JoinHandle<()>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let (line, _, _) = read_http_request(&mut stream);
            assert!(line.starts_with("POST /v1/auth/token/refresh "), "{line}");
            write_http_response(&mut stream, "200 OK", body);
        });
        (format!("http://{addr}"), server)
    }

    #[cfg(feature = "history")]
    /// A session stored with no org is repaired by a refresh that reports
    /// tenancy, with no re-login.
    #[test]
    fn refresh_adopts_reported_tenancy() {
        with_temp_home(|| {
            let (base_url, server) = one_refresh_response(
                r#"{"accessToken":"rth_at_fresh","refreshToken":"rth_rt_fresh","accessTokenExpiresAt":"2999-01-01T00:00:00.000Z","orgId":"org_a","workspaceId":"ws_a"}"#,
            );
            let stored = StoredAuth {
                base_url,
                access_token: "rth_at_old".into(),
                access_token_expires_at: Some("2999-01-01T00:00:00.000Z".into()),
                refresh_token: Some("rth_rt_old".into()),
                org_id: None,
                workspace_id: None,
            };
            save_auth(&stored).unwrap();

            refresh_and_save_auth(&stored).unwrap();
            server.join().unwrap();

            let repaired = load_auth(Some(&stored.base_url)).unwrap().unwrap();
            assert_eq!(repaired.org_id.as_deref(), Some("org_a"));
            assert_eq!(repaired.workspace_id.as_deref(), Some("ws_a"));
        });
    }

    #[cfg(feature = "history")]
    /// An older service that reports no tenancy must never erase an org already stored.
    #[test]
    fn refresh_without_reported_tenancy_keeps_the_stored_org() {
        with_temp_home(|| {
            let (base_url, server) = one_refresh_response(
                r#"{"accessToken":"rth_at_fresh","refreshToken":"rth_rt_fresh","orgId":"  "}"#,
            );
            let stored = StoredAuth {
                base_url,
                access_token: "rth_at_old".into(),
                access_token_expires_at: None,
                refresh_token: Some("rth_rt_old".into()),
                org_id: Some("org_a".into()),
                workspace_id: Some("ws_a".into()),
            };
            let refreshed = refresh_auth(&stored).unwrap();
            server.join().unwrap();
            assert_eq!(refreshed.org_id.as_deref(), Some("org_a"));
            assert_eq!(refreshed.workspace_id.as_deref(), Some("ws_a"));
        });
    }

    // Windows file locks are mandatory: a reader is refused while the
    // rotation lock is held, where Unix's advisory lock lets it through.
    #[cfg(feature = "history")]
    #[cfg(unix)]
    #[test]
    fn idle_progress_refresh_is_bounded_and_respects_the_rotation_lock() {
        with_temp_home(|| {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let base_url = format!("http://{}", listener.local_addr().unwrap());
            save_auth(&StoredAuth {
                base_url: base_url.clone(),
                access_token: "rth_at_expired".into(),
                refresh_token: Some("rth_rt_old".into()),
                ..Default::default()
            })
            .unwrap();
            let lock = acquire_refresh_lock(&base_url).unwrap();
            let start = std::time::Instant::now();
            assert!(
                try_progress_access_token(&base_url, std::time::Duration::from_millis(100))
                    .unwrap()
                    .is_none()
            );
            assert!(start.elapsed() < std::time::Duration::from_millis(100));
            drop(lock);
            // The listening socket never responds: the refresh has a hard deadline.
            let start = std::time::Instant::now();
            assert!(
                try_progress_access_token(&base_url, std::time::Duration::from_millis(100))
                    .is_err()
            );
            assert!(start.elapsed() < std::time::Duration::from_secs(1));
        });
    }

    #[test]
    fn idle_progress_refresh_persists_and_reuses_the_rotated_pair() {
        with_temp_home(|| {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let base_url = format!("http://{}", listener.local_addr().unwrap());
            save_auth(&StoredAuth {
                base_url: base_url.clone(),
                access_token: "rth_at_expired".into(),
                refresh_token: Some("rth_rt_old".into()),
                ..Default::default()
            })
            .unwrap();
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let (line, _, _) = read_http_request(&mut stream);
                assert!(line.starts_with("POST /v1/auth/token/refresh "));
                write_http_response(&mut stream, "200 OK", &serde_json::json!({
                    "accessToken": "rth_at_fresh", "refreshToken": "rth_rt_fresh",
                    "accessTokenExpiresAt": (chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339()
                }).to_string());
            });
            assert_eq!(
                try_progress_access_token(&base_url, std::time::Duration::from_secs(1))
                    .unwrap()
                    .as_deref(),
                Some("rth_at_fresh")
            );
            server.join().unwrap();
            // The listener is gone; a valid cached credential needs no network call.
            assert_eq!(
                try_progress_access_token(&base_url, std::time::Duration::from_secs(1))
                    .unwrap()
                    .as_deref(),
                Some("rth_at_fresh")
            );
            assert_eq!(
                load_selected_auth(Some(&base_url))
                    .unwrap()
                    .unwrap()
                    .refresh_token
                    .as_deref(),
                Some("rth_rt_fresh")
            );
        });
    }

    #[cfg(feature = "history")]
    #[test]
    fn a_reused_auth_value_adopts_the_persisted_rotation() {
        with_temp_home(|| {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let addr = listener.local_addr().unwrap();
            let stale_requests = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let refreshes = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let server_stale_requests = std::sync::Arc::clone(&stale_requests);
            let server_refreshes = std::sync::Arc::clone(&refreshes);
            let server = std::thread::spawn(move || {
                let started = std::time::Instant::now();
                let mut handled = 0;
                while handled < 4 && started.elapsed() < std::time::Duration::from_secs(10) {
                    let (mut stream, _) = match listener.accept() {
                        Ok(connection) => connection,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            std::thread::sleep(std::time::Duration::from_millis(5));
                            continue;
                        }
                        Err(error) => panic!("accept failed: {error}"),
                    };
                    handled += 1;
                    let (line, headers, _) = read_http_request(&mut stream);
                    if line.starts_with("POST /v1/auth/token/refresh ") {
                        server_refreshes.fetch_add(1, Ordering::SeqCst);
                        write_http_response(
                            &mut stream,
                            "200 OK",
                            r#"{"accessToken":"rth_at_fresh","refreshToken":"rth_rt_fresh"}"#,
                        );
                        continue;
                    }

                    assert!(line.starts_with("POST /v1/delivery/batches "), "{line}");
                    match headers.get("authorization").map(String::as_str) {
                        Some("Bearer rth_at_expired") => {
                            server_stale_requests.fetch_add(1, Ordering::SeqCst);
                            write_http_response(
                                &mut stream,
                                "401 Unauthorized",
                                r#"{"error":"invalid_token"}"#,
                            );
                        }
                        Some("Bearer rth_at_fresh") => {
                            write_http_response(&mut stream, "200 OK", r#"{}"#)
                        }
                        other => panic!("unexpected authorization header: {other:?}"),
                    }
                }
                assert_eq!(
                    handled, 4,
                    "expected one stale call, one refresh, and two successful calls"
                );
            });

            let auth = StoredAuth {
                base_url: format!("http://{addr}"),
                access_token: "rth_at_expired".into(),
                access_token_expires_at: None,
                refresh_token: Some("rth_rt_old".into()),
                ..Default::default()
            };
            save_auth(&auth).unwrap();
            authed_post(&auth).unwrap();
            // Deliberately reuse the stale value. The persisted rotated pair must be selected
            // before sending, without another guaranteed-to-fail request or refresh.
            authed_post(&auth).unwrap();
            server.join().unwrap();

            assert_eq!(stale_requests.load(Ordering::SeqCst), 1);
            assert_eq!(refreshes.load(Ordering::SeqCst), 1);
        });
    }

    /// Existing installs' auth files are named by this key, so it never changes.
    #[test]
    fn stage_key_names_existing_auth_files() {
        assert_eq!(
            stage_key("https://history.agentrelay.com").unwrap(),
            "f482e90bb4722263"
        );
    }

    #[test]
    fn equivalent_url_forms_share_one_stage_store() {
        with_temp_home(|| {
            let auth = StoredAuth {
                base_url: "http://LocalHost:8787/".into(),
                access_token: "rth_at_equivalent".into(),
                ..Default::default()
            };
            save_auth(&auth).unwrap();

            let stored = load_auth(Some("http://localhost:8787")).unwrap().unwrap();
            assert_eq!(stored.base_url, "http://localhost:8787");
            assert_eq!(stored.access_token, auth.access_token);
            assert_eq!(
                auth_path("http://LocalHost:8787/").unwrap(),
                auth_path("http://localhost:8787").unwrap()
            );
            assert_eq!(
                auth_path("https://History.AgentRelay.com:443/").unwrap(),
                auth_path("https://history.agentrelay.com").unwrap(),
                "an explicit default HTTPS port must not create another stage"
            );
            assert_eq!(
                auth_path("http://Example.test:80/").unwrap(),
                auth_path("http://example.test").unwrap(),
                "an explicit default HTTP port must not create another stage"
            );
        });
    }

    #[test]
    fn single_file_auth_is_ignored() {
        with_temp_home(|| {
            let base_url = "https://history.agentrelay.com";
            write_private(
                &config_dir().join("auth.json"),
                "invalid obsolete credentials",
            )
            .unwrap();
            assert!(load_auth(None).unwrap().is_none());
            assert!(load_auth(Some(base_url)).unwrap().is_none());
            let auth = StoredAuth {
                base_url: base_url.into(),
                access_token: "rth_at_new".into(),
                ..Default::default()
            };
            save_auth(&auth).unwrap();
            assert_eq!(load_auth(None).unwrap(), Some(auth));
            assert_eq!(
                fs::read_to_string(config_dir().join("auth.json")).unwrap(),
                "invalid obsolete credentials"
            );
        });
    }

    /// A login to a second stage preserves the original stage's bearer session.
    #[test]
    fn auth_is_scoped_to_the_cloud_stage() {
        with_temp_home(|| {
            let prod = StoredAuth {
                base_url: "https://history.agentrelay.com".into(),
                access_token: "test-prod-access".into(),
                ..Default::default()
            };
            let dev = StoredAuth {
                base_url: "http://localhost:8787".into(),
                access_token: "test-dev-access".into(),
                ..Default::default()
            };
            save_auth(&prod).unwrap();
            save_auth(&dev).unwrap();

            assert_eq!(load_auth(Some(&prod.base_url)).unwrap(), Some(prod));
            assert_eq!(load_auth(Some(&dev.base_url)).unwrap(), Some(dev));

            let err = load_auth(None).unwrap_err().to_string();
            assert!(err.contains("pass --base-url"), "{err}");
        });
    }

    /// The desktop app's own sign-in, kept by the relay core in the agent
    /// store, renews uploads too: for the same Cloud, while it is live.
    #[test]
    fn cloud_bearer_reuses_the_desktop_app_s_kept_session() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _cloud_token = EnvVarGuard::remove("CLOUD_API_ACCESS_TOKEN");
        let _cloud_api_url = EnvVarGuard::remove("CLOUD_API_URL");
        let _data = EnvVarGuard::remove("XDG_DATA_HOME");
        let home = tempfile::tempdir().unwrap();
        let _home = EnvVarGuard::set("HOME", home.path());
        let _profile = EnvVarGuard::set("USERPROFILE", home.path());
        let env = |key: &str| std::env::var(key).ok();
        let path = crate::relay::app_store::default_data_dir(&env, home.path())
            .join(crate::relay::app_store::STORE_FILE);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let write = |site: &str, expires_at: &str| {
            fs::write(
                &path,
                serde_json::json!({"registrations": [], "cloudSession": {
                    "accessToken": "cld_at_desktop", "accessTokenExpiresAt": expires_at,
                    "refreshToken": "refresh", "siteURL": site}})
                .to_string(),
            )
            .unwrap()
        };
        let api_url = cloud_api_url(None).unwrap();
        write("https://agentrelay.com", "2999-01-01T00:00:00Z");
        assert_eq!(
            official_cli_bearer(&api_url).as_deref(),
            Some("cld_at_desktop")
        );
        assert_eq!(official_cli_bearer("http://127.0.0.1:3100/cloud"), None);
        write("https://agentrelay.com", "2000-01-01T00:00:00Z");
        assert_eq!(official_cli_bearer(&api_url), None);
        // A build with its own data directory (Agent Relay Dev) is read there.
        let dev = home.path().join("dev-data");
        fs::create_dir_all(&dev).unwrap();
        fs::write(
            dev.join(crate::relay::app_store::STORE_FILE),
            serde_json::json!({"cloudSession": {"accessToken": "cld_at_dev",
                "accessTokenExpiresAt": "2999-01-01T00:00:00Z", "siteURL": "https://agentrelay.com"}})
            .to_string(),
        )
        .unwrap();
        {
            let _dev = EnvVarGuard::set(APP_DATA_DIR_VARIABLE, &dev);
            assert_eq!(official_cli_bearer(&api_url).as_deref(), Some("cld_at_dev"));
        }
        // The official CLI's live session comes first.
        write("https://agentrelay.com", "2999-01-01T00:00:00Z");
        write_official_cli_session(home.path(), &api_url);
        assert_eq!(
            official_cli_bearer(&api_url).as_deref(),
            Some("cld_at_official")
        );
    }

    /// The official Agent Relay CLI's file is another tool's credential: it is
    /// reused only for the same Cloud, only while it is live, and never written.
    #[test]
    fn cloud_bearer_reuses_only_a_matching_unexpired_official_cli_session() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _cloud_token = EnvVarGuard::remove("CLOUD_API_ACCESS_TOKEN");
        let _cloud_api_url = EnvVarGuard::remove("CLOUD_API_URL");
        let home = tempfile::tempdir().unwrap();
        let _home = EnvVarGuard::set("HOME", home.path());
        let _profile = EnvVarGuard::set("USERPROFILE", home.path());
        let path = home.path().join(".agentworkforce/relay/cloud-auth.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let write = |expires_at: &str| {
            fs::write(
                &path,
                format!(
                    r#"{{"apiUrl":"https://agentrelay.com/cloud/","accessToken":"cld_at_official","accessTokenExpiresAt":"{expires_at}"}}"#
                ),
            )
            .unwrap()
        };
        let bearer = |api_url: &str, force_login: bool| {
            cloud_bearer(
                api_url,
                CloudBearerOptions {
                    force_login,
                    // No terminal: every fall-through below must fail here
                    // rather than reach the network.
                    interactive: false,
                    client_name: "test",
                    announce: &mut |_| {},
                },
            )
        };
        let api_url = cloud_api_url(None).unwrap();
        assert_eq!(api_url, "https://agentrelay.com/cloud");

        write("2999-01-01T00:00:00.000Z");
        // Reused without any HTTP request, and the file is left untouched.
        assert_eq!(bearer(&api_url, false).unwrap(), "cld_at_official");
        assert!(fs::read_to_string(&path)
            .unwrap()
            .contains("cld_at_official"));
        // A session for a different Cloud is never forwarded.
        assert!(bearer("http://127.0.0.1:3100/cloud", false).is_err());
        // `--force-login` ignores it entirely.
        assert!(bearer(&api_url, true).is_err());

        write("2000-01-01T00:00:00.000Z");
        assert!(bearer(&api_url, false).is_err());
    }

    #[test]
    fn origins_are_bound_to_the_selected_environment() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _allow = EnvVarGuard::remove("RELAYHISTORY_ALLOW_UNTRUSTED_CLOUD_BASE_URL");
        assert_eq!(
            site_origin("http://127.0.0.1:3100").unwrap(),
            "http://127.0.0.1:3100"
        );
        for url in [
            "https://evil.example",
            "http://agentrelay.com",
            "https://user:secret@agentrelay.com",
            "http://localhost:3100/path",
            "http://localhost:3100/?x=y",
        ] {
            assert!(site_origin(url).is_err());
        }
        // A pushed session may name production, the dev stage or loopback,
        // and the staging host stays out of the Cloud-bridged path.
        for (raw, origin) in [
            (
                "https://history.agentrelay.com",
                "https://history.agentrelay.com",
            ),
            (
                "https://dev.history.agentrelay.com/",
                "https://dev.history.agentrelay.com",
            ),
            ("http://127.0.0.1:8787", "http://127.0.0.1:8787"),
            ("http://localhost:8787/", "http://localhost:8787"),
        ] {
            assert_eq!(pushed_history_origin(raw).unwrap(), origin);
        }
        for raw in [
            "http://history.agentrelay.com",
            "http://dev.history.agentrelay.com",
            "https://history.agentrelay.com:8443",
            "https://staging.history.agentrelay.com",
            "https://dev.history.agentrelay.com.evil.example",
            "https://history.example.com",
            "https://dev.history.agentrelay.com/v1",
            "https://user:secret@dev.history.agentrelay.com",
            "http://127.0.0.1.evil.example",
        ] {
            assert!(pushed_history_origin(raw).is_err(), "{raw}");
        }
        assert!(history_origin(
            "https://dev.history.agentrelay.com",
            "https://agentrelay.com"
        )
        .is_err());
        assert!(history_origin("https://history.agentrelay.com", "http://127.0.0.1:3100").is_err());
        assert!(history_origin("http://127.0.0.1:3102", "https://agentrelay.com").is_err());
        assert_eq!(
            history_origin("http://127.0.0.1:3102", "http://127.0.0.1:3100").unwrap(),
            "http://127.0.0.1:3102"
        );
        // A trailing slash must not survive into request paths.
        assert_eq!(
            history_origin("http://127.0.0.1:3102/", "http://127.0.0.1:3100").unwrap(),
            "http://127.0.0.1:3102"
        );
        assert_eq!(
            cloud_api_url(Some("http://127.0.0.1:3100/cloud/")).unwrap(),
            "http://127.0.0.1:3100/cloud"
        );
        // The API root is an origin plus `/cloud`, never a bare origin.
        assert!(cloud_api_url(Some("http://127.0.0.1:3100")).is_err());
        assert!(cloud_api_url(Some("https://cloud.example/cloud")).is_err());
        let _allow_untrusted = EnvVarGuard::set("RELAYHISTORY_ALLOW_UNTRUSTED_CLOUD_BASE_URL", "1");
        assert_eq!(
            cloud_api_url(Some("https://cloud.example/cloud")).unwrap(),
            "https://cloud.example/cloud"
        );
    }

    /// Serves the Cloud device grant, then one token response. `wrong_origin`
    /// puts the approval link on another site: the client must stop there and
    /// never poll, so only the first request is expected.
    fn device_server(status: u16, wrong_origin: bool) -> (String, std::thread::JoinHandle<()>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let site = format!("http://{}", listener.local_addr().unwrap());
        let origin = site.clone();
        let server = std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            let count = if wrong_origin { 1 } else { 2 };
            for index in 0..count {
                let mut stream = loop {
                    match listener.accept() {
                        Ok((stream, _)) => break stream,
                        Err(error)
                            if error.kind() == std::io::ErrorKind::WouldBlock
                                && std::time::Instant::now() < deadline =>
                        {
                            std::thread::sleep(std::time::Duration::from_millis(10))
                        }
                        Err(_) => panic!("device client did not complete expected request"),
                    }
                };
                // Accepted sockets inherit nonblocking mode on macOS. The
                // request reader below intentionally uses blocking reads.
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(3)))
                    .unwrap();
                let mut request = Vec::new();
                let mut buffer = [0; 1024];
                while !request.windows(4).any(|v| v == b"\r\n\r\n") {
                    let len = stream.read(&mut buffer).unwrap();
                    assert!(len > 0);
                    request.extend_from_slice(&buffer[..len]);
                }
                let headers = String::from_utf8_lossy(&request);
                assert!(headers.starts_with(if index == 0 {
                    "POST /cloud/api/v1/auth/device/start "
                } else {
                    "POST /cloud/api/v1/auth/device/token "
                }));
                assert!(!headers.to_lowercase().contains("authorization:"));
                let body = if index == 0 {
                    serde_json::json!({"device_code":"synthetic-device-code", "verification_uri_complete":format!("{}/cloud/device?user_code=synthetic-code", if wrong_origin { "https://other.invalid" } else { &origin }), "expires_in":10, "interval":1})
                } else {
                    serde_json::json!({"access_token":"synthetic-access-token", "api_url":format!("{origin}/cloud")})
                }.to_string();
                let response_status = if index == 0 { status } else { 200 };
                write!(stream, "HTTP/1.1 {response_status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
        });
        (site, server)
    }

    fn device_bearer(site: &str, announce: &mut dyn FnMut(&DeviceApproval)) -> Result<String> {
        cloud_bearer(
            &format!("{site}/cloud"),
            CloudBearerOptions {
                force_login: true,
                interactive: true,
                client_name: "Agent Relay Probe",
                announce,
            },
        )
    }

    #[test]
    fn device_auth_accepts_cloud_created_response_and_polls_without_bearer() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _cloud_token = EnvVarGuard::remove("CLOUD_API_ACCESS_TOKEN");
        let (site, server) = device_server(201, false);
        let mut announced = Vec::new();
        assert_eq!(
            device_bearer(&site, &mut |approval| announced
                .push(approval.verification_uri.clone()))
            .unwrap(),
            "synthetic-access-token"
        );
        server.join().unwrap();
        // The user is shown the complete approval link, so no separate code.
        assert_eq!(
            announced,
            vec![format!("{site}/cloud/device?user_code=synthetic-code")]
        );
    }

    #[test]
    fn device_auth_rejects_cross_origin_approval_link_before_polling() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _cloud_token = EnvVarGuard::remove("CLOUD_API_ACCESS_TOKEN");
        let (site, server) = device_server(201, true);
        let mut announced = 0;
        assert!(device_bearer(&site, &mut |_| announced += 1).is_err());
        server.join().unwrap();
        assert_eq!(announced, 0);
    }

    fn http_auth(base_url: &str) -> StoredAuth {
        StoredAuth {
            base_url: base_url.to_string(),
            access_token: "rth_at_secret".into(),
            ..Default::default()
        }
    }

    /// The token must never leave the machine in cleartext.
    #[test]
    fn authenticated_calls_refuse_a_cleartext_base_url() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _allow = EnvVarGuard::remove("RELAYHISTORY_ALLOW_UNTRUSTED_CLOUD_BASE_URL");
        // `.invalid` is reserved and can never resolve (RFC 2606), so if this guard is ever
        // removed the test fails on the assertion rather than by putting the token on a wire.
        let auth = http_auth("http://history.relayhistory.invalid");
        let msg = require_secure_transport(&auth.base_url)
            .unwrap_err()
            .to_string();
        assert!(msg.contains("refusing to send"), "{msg}");
        // The failure must not itself disclose what it was protecting.
        assert!(!msg.contains("rth_at_secret"), "{msg}");
    }

    /// `wrangler dev` is the documented local endpoint and never puts bytes on a network,
    /// so it stays usable — no opt-in flag, which would be friction bought with no security.
    #[test]
    fn loopback_stays_usable_for_local_development() {
        for url in [
            "http://localhost:8787",
            "http://127.0.0.1:8787",
            "http://[::1]:8787",
            "http://LocalHost:8787/",
        ] {
            assert!(
                require_secure_transport(url).is_ok(),
                "loopback dev endpoint rejected: {url}"
            );
        }
        assert!(require_secure_transport("https://history.agentrelay.com").is_ok());
    }

    /// A hostname that merely reads as loopback is a remote host. Userinfo is the classic
    /// way to dress one up.
    #[test]
    fn loopback_exemption_cannot_be_spoofed_by_a_lookalike_host() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _allow = EnvVarGuard::remove("RELAYHISTORY_ALLOW_UNTRUSTED_CLOUD_BASE_URL");
        for url in [
            "http://127.0.0.1.evil.com/",
            "http://localhost.evil.com:8787",
            "http://127.0.0.1@evil.com/",
            "http://user@localhost@evil.com/",
            "http://evil.com/?h=localhost",
            "http://evil.com/#127.0.0.1",
            "http://[::1]@evil.com/",
            "ftp://localhost:8787",
            "history.agentrelay.com",
        ] {
            assert!(
                require_secure_transport(url).is_err(),
                "non-loopback endpoint accepted: {url}"
            );
        }
    }

    /// Other plaintext hosts reuse the existing development opt-in rather than a new switch.
    /// The opt-in widens the scheme only: malformed or non-http(s) URLs stay rejected.
    #[test]
    fn cleartext_remote_host_requires_the_untrusted_base_url_opt_in() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let remote = "http://history.relayhistory.invalid";
        for value in ["0", "no", ""] {
            let _allow = EnvVarGuard::set("RELAYHISTORY_ALLOW_UNTRUSTED_CLOUD_BASE_URL", value);
            assert!(
                require_secure_transport(remote).is_err(),
                "opt-in value {value:?}"
            );
        }
        for value in ["1", "true", "TRUE"] {
            let _allow = EnvVarGuard::set("RELAYHISTORY_ALLOW_UNTRUSTED_CLOUD_BASE_URL", value);
            assert!(
                require_secure_transport(remote).is_ok(),
                "opt-in value {value:?}"
            );
            assert!(require_secure_transport("ftp://history.relayhistory.invalid").is_err());
            assert!(require_secure_transport("history.relayhistory.invalid").is_err());
        }
    }

    #[cfg(feature = "history")]
    /// Delivery (and any future authenticated request) goes through the shared send path,
    /// which must refuse before the request closure — and so the bearer — is ever invoked.
    #[test]
    fn shared_send_path_refuses_cleartext_before_sending() {
        with_temp_home(|| {
            let _allow = EnvVarGuard::remove("RELAYHISTORY_ALLOW_UNTRUSTED_CLOUD_BASE_URL");
            let auth = StoredAuth {
                refresh_token: Some("rth_rt_secret".into()),
                ..http_auth("http://history.relayhistory.invalid")
            };
            save_auth(&auth).unwrap();
            let sends = std::sync::atomic::AtomicUsize::new(0);
            let error = send_with_auth_refresh_checked_with_budget(
                &auth,
                |_, _| {
                    sends.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    Err(Box::new(ureq::Error::Status(
                        401,
                        ureq::Response::new(401, "Unauthorized", "").unwrap(),
                    )))
                },
                |error| anyhow::anyhow!("{error}"),
                |_| Ok(()),
                None,
            )
            .unwrap_err()
            .to_string();
            assert!(error.contains("refusing to send"), "{error}");
            assert!(!error.contains("rth_at_secret"), "{error}");
            assert_eq!(sends.load(std::sync::atomic::Ordering::SeqCst), 0);
            // Nothing was rotated or rewritten on the way out.
            assert_eq!(load_auth(Some(&auth.base_url)).unwrap().unwrap(), auth);
        });
    }

    #[cfg(feature = "history")]
    /// The same shared path still works for loopback `wrangler dev` without any opt-in.
    #[test]
    fn shared_send_path_allows_loopback_cleartext() {
        with_temp_home(|| {
            let _allow = EnvVarGuard::remove("RELAYHISTORY_ALLOW_UNTRUSTED_CLOUD_BASE_URL");
            let auth = http_auth("http://127.0.0.1:8787");
            let sends = std::sync::atomic::AtomicUsize::new(0);
            send_with_auth_refresh_checked_with_budget(
                &auth,
                |current, _| {
                    assert_eq!(current.access_token, "rth_at_secret");
                    sends.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    Ok(ureq::Response::new(200, "OK", "{}").unwrap())
                },
                |error| anyhow::anyhow!("{error}"),
                |_| Ok(()),
                None,
            )
            .unwrap();
            assert_eq!(sends.load(std::sync::atomic::Ordering::SeqCst), 1);
        });
    }

    /// Progress heartbeats obtain their bearer here; a cleartext stage must not yield one,
    /// even when the cached token is still valid and no refresh would be needed.
    #[test]
    fn progress_token_is_withheld_from_a_cleartext_stage() {
        with_temp_home(|| {
            let _allow = EnvVarGuard::remove("RELAYHISTORY_ALLOW_UNTRUSTED_CLOUD_BASE_URL");
            let expires = (chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339();
            for (base_url, allowed) in [
                ("http://history.relayhistory.invalid", false),
                ("http://127.0.0.1:8787", true),
            ] {
                save_auth(&StoredAuth {
                    access_token_expires_at: Some(expires.clone()),
                    ..http_auth(base_url)
                })
                .unwrap();
                let token =
                    try_progress_access_token(base_url, std::time::Duration::from_millis(100));
                if allowed {
                    assert_eq!(token.unwrap().as_deref(), Some("rth_at_secret"));
                } else {
                    let error = token.unwrap_err().to_string();
                    assert!(error.contains("refusing to send"), "{error}");
                    assert!(!error.contains("rth_at_secret"), "{error}");
                }
            }
        });
    }

    /// Serves one workspace-session exchange and hands back the bearer it saw.
    fn workspace_session_server(
        org_id: &'static str,
    ) -> (String, std::thread::JoinHandle<Option<String>>) {
        workspace_session_answer("200 OK", org_id, "ws_1")
    }

    /// Answers one workspace-session exchange with `status` and, on success,
    /// a session for `org_id` and `workspace_id`.
    fn workspace_session_answer(
        status: &'static str,
        org_id: &'static str,
        workspace_id: &'static str,
    ) -> (String, std::thread::JoinHandle<Option<String>>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let site = format!("http://{}", listener.local_addr().unwrap());
        let base_url = site.clone();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let (first_line, headers, body) = read_http_request(&mut stream);
            assert!(
                first_line.starts_with("POST /cloud/api/v1/workspaces/ws_1/relayhistory/session ")
            );
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&body).unwrap()["mode"],
                "sync"
            );
            let response = serde_json::json!({
                "baseUrl": base_url,
                "orgId": org_id,
                "workspaceId": workspace_id,
                "accessToken": "rth_at_renewed",
                "refreshToken": "rth_rt_renewed",
                "accessTokenExpiresAt": "2999-01-01T00:00:00Z",
                "scopes": ["rth:sync"],
            })
            .to_string();
            write_http_response(&mut stream, status, &response);
            headers.get("authorization").cloned()
        });
        (site, server)
    }

    fn write_official_cli_session(home: &std::path::Path, api_url: &str) {
        let path = home.join(".agentworkforce/relay/cloud-auth.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            path,
            serde_json::json!({
                "apiUrl": api_url,
                "accessToken": "cld_at_official",
                "accessTokenExpiresAt": "2999-01-01T00:00:00.000Z",
            })
            .to_string(),
        )
        .unwrap();
    }

    /// A dead `rth_*` pair is replaced from Agent Relay's own sign-in, so an
    /// unattended machine recovers without anyone logging in again.
    #[test]
    fn a_dead_history_session_is_renewed_from_the_agent_relay_sign_in() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _cloud_token = EnvVarGuard::remove("CLOUD_API_ACCESS_TOKEN");
        let home = tempfile::tempdir().unwrap();
        let _home = EnvVarGuard::set("HOME", home.path());
        let _profile = EnvVarGuard::set("USERPROFILE", home.path());
        let store = tempfile::tempdir().unwrap();
        let _store = EnvVarGuard::set("RELAYHISTORY_HOME", store.path());

        let (site, server) = workspace_session_server("org_1");
        let api_url = format!("{site}/cloud");
        save_auth(&StoredAuth {
            base_url: site.clone(),
            access_token: "rth_at_dead".into(),
            refresh_token: Some("rth_rt_revoked".into()),
            org_id: Some("org_1".into()),
            workspace_id: Some("ws_1".into()),
            ..Default::default()
        })
        .unwrap();
        write_official_cli_session(home.path(), &api_url);

        let bearer = renewal_bearer(&api_url).expect("an Agent Relay sign-in is available");
        let Renewal::Renewed(renewed) =
            renew_workspace_session(&api_url, &bearer, "ws_1", &site, "org_1").unwrap()
        else {
            panic!("not renewed");
        };
        assert_eq!(
            server.join().unwrap().as_deref(),
            Some("Bearer cld_at_official")
        );
        assert_eq!(renewed.access_token, "rth_at_renewed");
        let stored = load_auth(Some(&site)).unwrap().unwrap();
        assert_eq!(stored.access_token, "rth_at_renewed");
        assert_eq!(stored.refresh_token.as_deref(), Some("rth_rt_renewed"));
    }

    #[test]
    fn renewal_never_adopts_another_destination_or_prompts() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _cloud_token = EnvVarGuard::remove("CLOUD_API_ACCESS_TOKEN");
        let home = tempfile::tempdir().unwrap();
        let _home = EnvVarGuard::set("HOME", home.path());
        let _profile = EnvVarGuard::set("USERPROFILE", home.path());
        let store = tempfile::tempdir().unwrap();
        let _store = EnvVarGuard::set("RELAYHISTORY_HOME", store.path());
        let dead = |site: &str| StoredAuth {
            base_url: site.to_string(),
            access_token: "rth_at_dead".into(),
            org_id: Some("org_1".into()),
            workspace_id: Some("ws_1".into()),
            ..Default::default()
        };

        // Without a non-interactive Agent Relay credential there is nothing to
        // renew from, and no request (let alone a device login) is made.
        let unused = "http://127.0.0.1:9";
        save_auth(&dead(unused)).unwrap();
        assert!(renewal_bearer(&format!("{unused}/cloud")).is_none());

        // Cloud that does not answer is told apart from Cloud refusing.
        assert!(matches!(
            renew_workspace_session(&format!("{unused}/cloud"), "cld", "ws_1", unused, "org_1"),
            Ok(Renewal::Failed(RenewalFailure::CloudUnreachable))
        ));

        // Cloud answering for a different organization is refused, and the
        // stored session is left for the person to resolve.
        let (site, server) = workspace_session_server("org_other");
        let api_url = format!("{site}/cloud");
        save_auth(&dead(&site)).unwrap();
        write_official_cli_session(home.path(), &api_url);
        let bearer = renewal_bearer(&api_url).unwrap();
        assert!(matches!(
            renew_workspace_session(&api_url, &bearer, "ws_1", &site, "org_1"),
            Ok(Renewal::Failed(RenewalFailure::WrongDestination))
        ));
        server.join().unwrap();
        assert_eq!(
            load_auth(Some(&site)).unwrap().unwrap().access_token,
            "rth_at_dead"
        );

        // So is a session issued for another workspace.
        let (site, server) = workspace_session_answer("200 OK", "org_1", "ws_other");
        let api_url = format!("{site}/cloud");
        save_auth(&dead(&site)).unwrap();
        write_official_cli_session(home.path(), &api_url);
        assert!(matches!(
            renew_workspace_session(&api_url, &bearer, "ws_1", &site, "org_1"),
            Ok(Renewal::Failed(RenewalFailure::WrongDestination))
        ));
        server.join().unwrap();
        assert_eq!(
            load_auth(Some(&site)).unwrap().unwrap().access_token,
            "rth_at_dead"
        );
    }

    /// Cloud refusing the person or workspace is told apart from Cloud
    /// rate limiting or failing, which passes by itself.
    #[test]
    fn renewal_tells_a_refusal_from_an_outage() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let store = tempfile::tempdir().unwrap();
        let _store = EnvVarGuard::set("RELAYHISTORY_HOME", store.path());
        for (status, expected) in [
            ("401 Unauthorized", RenewalFailure::CloudRefused),
            ("403 Forbidden", RenewalFailure::CloudRefused),
            ("404 Not Found", RenewalFailure::CloudRefused),
            ("429 Too Many Requests", RenewalFailure::CloudUnreachable),
            ("503 Service Unavailable", RenewalFailure::CloudUnreachable),
        ] {
            let (site, server) = workspace_session_answer(status, "org_1", "ws_1");
            let api_url = format!("{site}/cloud");
            let renewal = renew_workspace_session(&api_url, "cld", "ws_1", &site, "org_1");
            server.join().unwrap();
            assert!(
                matches!(renewal, Ok(Renewal::Failed(failure)) if failure == expected),
                "{status}: {renewal:?}"
            );
        }
    }

    // ----- conversation turns on the push path -----
}
