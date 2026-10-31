//! The desktop mailbox: messages people send from Agent Relay's web app to
//! a Codex thread shared from this computer.
//!
//! After sign-in, `activate` trades the person's Cloud session for this
//! device's room participant credential and the mailbox it opens
//! (`/workspaces/{id}/room/session`, then `/desktop/session` at the mailbox
//! origin). The credential is bound to its mailbox by `scope`, kept in the
//! Keychain on macOS and a 0600 file elsewhere, and never derived from an
//! incoming frame or another credential.
//!
//! `Receiver` keeps one socket (`wss`, falling back to polling) and one
//! upstream loop. A message is handed to the inbox durably before its id
//! becomes the cursor; acknowledgements go up in the order the outbox
//! recorded them, over HTTP (whose 2xx, unlike a socket write, confirms
//! Cloud took them), with an idempotency key; and the catalog of threads
//! the person shared is reported every 30 s. The outbox and the inbox are
//! `MailboxStore` and `MailboxInbox`.

use crate::relay::cloud_http::{self, RawError};
use crate::relay::workspace::Secret;
use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// The Keychain service the mailbox credential is kept under (macOS).
pub const KEYCHAIN_SERVICE: &str = "com.agentrelay.desktop.cloud-session";

pub const MESSAGES_PATH: &str = "/cloud/api/v1/desktop/messages";
pub const ACKS_PATH: &str = "/cloud/api/v1/desktop/acks";
pub const THREADS_PATH: &str = "/cloud/api/v1/desktop/threads";
pub const SESSION_PATH: &str = "/cloud/api/v1/desktop/session";

const MAX_FRAME: usize = 256 * 1024;
const MAX_POLL: usize = 1000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MailboxError {
    InvalidConfiguration,
    /// No usable credential, or Cloud refused it.
    AuthenticationRequired,
    InvalidResponse,
    OversizedMessage,
    /// Cloud retired the cursor it was asked to resume from.
    CursorNotFound,
    Unreachable,
    /// The inbox or outbox could not record it.
    Storage(String),
    /// The receiver is stopping (sign-out or an account switch): nothing
    /// was stored, and nothing was refused for good.
    Cancelled,
}

impl std::fmt::Display for MailboxError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MailboxError::InvalidConfiguration => {
                f.write_str("The mailbox is not configured for a trusted site.")
            }
            MailboxError::AuthenticationRequired => {
                f.write_str("Sign in again to receive messages.")
            }
            MailboxError::InvalidResponse => {
                f.write_str("Agent Relay sent an unreadable mailbox answer.")
            }
            MailboxError::OversizedMessage => {
                f.write_str("Agent Relay sent a mailbox answer that is too large.")
            }
            MailboxError::CursorNotFound => {
                f.write_str("Agent Relay no longer has the mailbox position.")
            }
            MailboxError::Unreachable => f.write_str("Agent Relay's mailbox could not be reached."),
            MailboxError::Storage(message) => f.write_str(message),
            MailboxError::Cancelled => f.write_str("Incoming messages are stopping."),
        }
    }
}

/// A mailbox: the origin it lives at, the identity Cloud gave it, and its
/// routes. Every request derives from this and nothing else.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MailboxConfig {
    pub site: String,
    #[serde(rename = "accountID")]
    pub account_id: String,
    #[serde(rename = "workspaceID")]
    pub workspace_id: String,
    #[serde(rename = "messagesPath")]
    pub messages_path: String,
    #[serde(rename = "acksPath")]
    pub acks_path: String,
    #[serde(rename = "threadsPath")]
    pub threads_path: String,
}

fn safe_path(path: &str) -> bool {
    path.starts_with('/') && !path.starts_with("//") && !path.contains('?') && !path.contains('#')
}

impl MailboxConfig {
    pub fn new(
        site: &str,
        account_id: &str,
        workspace_id: &str,
    ) -> Result<MailboxConfig, MailboxError> {
        MailboxConfig {
            site: site.to_string(),
            account_id: account_id.into(),
            workspace_id: workspace_id.into(),
            messages_path: MESSAGES_PATH.into(),
            acks_path: ACKS_PATH.into(),
            threads_path: THREADS_PATH.into(),
        }
        .validated()
    }

    /// An https origin (http only on loopback, as every Cloud origin the
    /// core accepts) with no user info, query, fragment or path; an
    /// identity; and routes that are plain absolute paths.
    pub fn validated(self) -> Result<MailboxConfig, MailboxError> {
        let url = url::Url::parse(&self.site).map_err(|_| MailboxError::InvalidConfiguration)?;
        let loopback = match url.host() {
            Some(url::Host::Domain(domain)) => domain.eq_ignore_ascii_case("localhost"),
            Some(url::Host::Ipv4(address)) => address.is_loopback(),
            Some(url::Host::Ipv6(address)) => address.is_loopback(),
            None => false,
        };
        let valid = (url.scheme() == "https" || (url.scheme() == "http" && loopback))
            && url.host_str().is_some_and(|host| !host.is_empty())
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
            && url.path() == "/"
            && !self.account_id.is_empty()
            && !self.workspace_id.is_empty()
            && [&self.messages_path, &self.acks_path, &self.threads_path]
                .iter()
                .all(|path| safe_path(path));
        valid
            .then_some(self)
            .ok_or(MailboxError::InvalidConfiguration)
    }

    /// The scheme, host and port, for comparing origins.
    fn origin(&self) -> Option<(String, String, Option<u16>)> {
        let url = url::Url::parse(&self.site).ok()?;
        Some((url.scheme().into(), url.host_str()?.into(), url.port()))
    }

    /// The SHA-256 of `[site, account, workspace]` as the macOS app's
    /// `JSONEncoder` wrote it (slashes escaped), so existing bindings and
    /// Keychain items keep their names.
    pub fn scope(&self) -> String {
        let encoded = serde_json::to_string(&[&self.site, &self.account_id, &self.workspace_id])
            .unwrap_or_default()
            .replace('/', "\\/");
        format!("{:x}", Sha256::digest(encoded.as_bytes()))
    }

    /// The URL for `path`, with the mailbox's identity (and cursor) in the
    /// query; `wss` (`ws` on loopback http) for the socket.
    pub fn url(
        &self,
        path: &str,
        since: Option<&str>,
        socket: bool,
    ) -> Result<String, MailboxError> {
        let mut url =
            url::Url::parse(&self.site).map_err(|_| MailboxError::InvalidConfiguration)?;
        url.set_path(path);
        {
            let mut query = url.query_pairs_mut();
            query.append_pair("account_id", &self.account_id);
            query.append_pair("workspace_id", &self.workspace_id);
            if let Some(since) = since {
                query.append_pair("since", since);
            }
        }
        if socket {
            let scheme = if url.scheme() == "http" { "ws" } else { "wss" };
            url.set_scheme(scheme)
                .map_err(|_| MailboxError::InvalidConfiguration)?;
        }
        Ok(url.into())
    }

    /// `credential`'s bearer for this mailbox, when it is this mailbox's,
    /// unexpired, and a plain token (never a probe `rth_` credential).
    pub fn bearer(
        &self,
        credential: &MailboxCredential,
        now_ms: i64,
    ) -> Result<Secret, MailboxError> {
        let token = credential.token.expose();
        let usable = credential.scope == self.scope()
            && credential.expires_at_ms > now_ms
            && !token.is_empty()
            && !token.starts_with("rth_")
            && token.bytes().all(|byte| byte > 32 && byte < 127);
        usable
            .then(|| credential.token.clone())
            .ok_or(MailboxError::AuthenticationRequired)
    }
}

/// The macOS app stored dates as seconds since 2001-01-01.
const APPLE_EPOCH_MS: i64 = 978_307_200_000;

/// This device's mailbox credential, bound to one mailbox by `scope`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MailboxCredential {
    pub scope: String,
    pub token: Secret,
    pub expires_at_ms: i64,
}

impl MailboxCredential {
    /// The macOS app's format: `{"scope","token","expiresAt"}`, the date in
    /// seconds since 2001-01-01.
    pub fn encode(&self) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "scope": self.scope,
            "token": self.token.expose(),
            "expiresAt": self.expires_at_ms.saturating_sub(APPLE_EPOCH_MS) as f64 / 1000.0,
        }))
        .unwrap_or_default()
    }

    pub fn decode(bytes: &[u8]) -> Option<MailboxCredential> {
        let value: Value = serde_json::from_slice(bytes).ok()?;
        Some(MailboxCredential {
            scope: value["scope"].as_str()?.into(),
            token: Secret::new(value["token"].as_str()?),
            expires_at_ms: ((value["expiresAt"].as_f64()? * 1000.0) as i64)
                .saturating_add(APPLE_EPOCH_MS),
        })
    }
}

/// Where mailbox credentials are kept, by scope.
pub trait CredentialStore: Send + Sync + 'static {
    fn load(&self, scope: &str) -> Option<MailboxCredential>;
    fn save(&self, credential: &MailboxCredential) -> Result<(), String>;
    fn remove(&self, scope: &str);
}

/// The login Keychain, without ever prompting.
#[cfg(target_os = "macos")]
pub struct Keychain;

#[cfg(target_os = "macos")]
impl Keychain {
    fn options(scope: &str) -> security_framework::passwords::PasswordOptions {
        use core_foundation::base::TCFType;
        use core_foundation::string::CFString;
        let mut options = security_framework::passwords::PasswordOptions::new_generic_password(
            KEYCHAIN_SERVICE,
            scope,
        );
        // SAFETY: both are static Security framework constants.
        #[allow(deprecated)]
        options.query.push(unsafe {
            (
                CFString::wrap_under_get_rule(
                    security_framework_sys::item::kSecUseAuthenticationUI,
                ),
                CFString::wrap_under_get_rule(
                    security_framework_sys::item::kSecUseAuthenticationUISkip,
                )
                .into_CFType(),
            )
        });
        options
    }
}

#[cfg(target_os = "macos")]
impl CredentialStore for Keychain {
    fn load(&self, scope: &str) -> Option<MailboxCredential> {
        let bytes =
            security_framework::passwords::generic_password(Keychain::options(scope)).ok()?;
        MailboxCredential::decode(&bytes)
    }

    fn save(&self, credential: &MailboxCredential) -> Result<(), String> {
        use security_framework::access_control::{ProtectionMode, SecAccessControl};
        let mut options = Keychain::options(&credential.scope);
        let control = SecAccessControl::create_with_protection(
            Some(ProtectionMode::AccessibleAfterFirstUnlockThisDeviceOnly),
            0,
        )
        .map_err(|_| "Could not protect the mailbox credential.".to_string())?;
        options.set_access_control(control);
        security_framework::passwords::set_generic_password_options(&credential.encode(), options)
            .map_err(|_| "Could not save the mailbox credential to the Keychain.".to_string())
    }

    fn remove(&self, scope: &str) {
        let _ = security_framework::passwords::delete_generic_password_options(Keychain::options(
            scope,
        ));
    }
}

/// `<root>/<scope>/credential.json`, 0600, in the macOS format.
pub struct CredentialFiles {
    pub root: PathBuf,
}

impl CredentialFiles {
    fn path(&self, scope: &str) -> PathBuf {
        self.root.join(scope).join("credential.json")
    }
}

impl CredentialStore for CredentialFiles {
    fn load(&self, scope: &str) -> Option<MailboxCredential> {
        MailboxCredential::decode(&std::fs::read(self.path(scope)).ok()?)
            .filter(|credential| credential.scope == scope)
    }

    fn save(&self, credential: &MailboxCredential) -> Result<(), String> {
        write_private(&self.path(&credential.scope), &credential.encode())
    }

    fn remove(&self, scope: &str) {
        let _ = std::fs::remove_file(self.path(scope));
    }
}

/// Writes `bytes` to `path` as a 0600 file in 0700 directories, swapped
/// into place.
pub fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let failed = |error: std::io::Error| format!("Could not save the mailbox ({error}).");
    let directory = path.parent().ok_or("No directory.")?;
    crate::platform::fs::create_private_dir_all(directory).map_err(failed)?;
    let temporary = directory.join(format!(".{}.tmp", crate::relay::store::random_uuid()));
    let result = (|| {
        let mut file =
            crate::platform::fs::private(std::fs::OpenOptions::new().write(true).create_new(true))
                .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        std::fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result.map_err(failed)
}

/// The Keychain on macOS; on Linux, which has no Keychain, 0600 files under
/// `<app data>/incoming`.
pub fn platform_store(app_data_dir: &Path) -> Arc<dyn CredentialStore> {
    #[cfg(target_os = "macos")]
    {
        let _ = app_data_dir;
        Arc::new(Keychain)
    }
    #[cfg(not(target_os = "macos"))]
    {
        Arc::new(CredentialFiles {
            root: app_data_dir.join("incoming"),
        })
    }
}

/// A socket to the mailbox.
pub trait MailboxSocket: Send {
    /// The next frame; ends with an error when the socket closes.
    fn receive(&mut self) -> BoxFuture<'_, Result<Vec<u8>, MailboxError>>;
    fn close(&mut self);
}

/// How the mailbox is reached. Requests never follow a redirect.
pub trait MailboxNetwork: Send + Sync + 'static {
    /// One request; the body of a 2xx answer.
    fn request(
        &self,
        method: &'static str,
        url: String,
        bearer: Secret,
        body: Option<Vec<u8>>,
        idempotency_key: Option<String>,
    ) -> BoxFuture<'_, Result<Vec<u8>, MailboxError>>;

    /// Opens the socket; resolves once the authenticated handshake is done.
    fn connect(
        &self,
        url: String,
        bearer: Secret,
    ) -> BoxFuture<'_, Result<Box<dyn MailboxSocket>, MailboxError>>;
}

/// The mailbox over HTTPS and a WebSocket.
pub struct HttpMailbox;

/// What a mailbox answer means: 401/403 refuse the credential; an explicit
/// 409 `cursor_not_found` retires the cursor; any other failure is
/// unreadable.
pub fn classify(status: u16, body: &[u8]) -> Result<(), MailboxError> {
    if status == 401 || status == 403 {
        return Err(MailboxError::AuthenticationRequired);
    }
    if status == 409
        && serde_json::from_slice::<Value>(body)
            .is_ok_and(|value| value["error"]["code"] == "cursor_not_found")
    {
        return Err(MailboxError::CursorNotFound);
    }
    if (200..300).contains(&status) {
        Ok(())
    } else {
        Err(MailboxError::InvalidResponse)
    }
}

impl MailboxNetwork for HttpMailbox {
    fn request(
        &self,
        method: &'static str,
        url: String,
        bearer: Secret,
        body: Option<Vec<u8>>,
        idempotency_key: Option<String>,
    ) -> BoxFuture<'_, Result<Vec<u8>, MailboxError>> {
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                let mut headers = Vec::new();
                if body.is_some() {
                    headers.push(("Content-Type", "application/json"));
                }
                if let Some(key) = idempotency_key.as_deref() {
                    headers.push(("Idempotency-Key", key));
                }
                let raw = cloud_http::send_raw_blocking(
                    method,
                    &url,
                    Some(bearer.expose()),
                    &headers,
                    body.as_deref(),
                    Duration::from_secs(20),
                )
                .map_err(|error| match error {
                    RawError::Oversized => MailboxError::OversizedMessage,
                    RawError::Unreachable(_) | RawError::TimedOut => MailboxError::Unreachable,
                })?;
                classify(raw.status, &raw.body)?;
                Ok(raw.body)
            })
            .await
            .unwrap_or(Err(MailboxError::Unreachable))
        })
    }

    fn connect(
        &self,
        url: String,
        bearer: Secret,
    ) -> BoxFuture<'_, Result<Box<dyn MailboxSocket>, MailboxError>> {
        Box::pin(async move {
            use tokio_tungstenite::tungstenite::client::IntoClientRequest;
            use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
            let mut request = url
                .into_client_request()
                .map_err(|_| MailboxError::InvalidConfiguration)?;
            let value = format!("Bearer {}", bearer.expose())
                .parse()
                .map_err(|_| MailboxError::AuthenticationRequired)?;
            request.headers_mut().insert("Authorization", value);
            let config = WebSocketConfig {
                max_message_size: Some(MAX_FRAME),
                max_frame_size: Some(MAX_FRAME),
                ..WebSocketConfig::default()
            };
            let connected = tokio::time::timeout(
                Duration::from_secs(20),
                tokio_tungstenite::connect_async_with_config(request, Some(config), false),
            )
            .await
            .map_err(|_| MailboxError::Unreachable)?;
            match connected {
                Ok((socket, _)) => Ok(Box::new(WebSocket(socket)) as Box<dyn MailboxSocket>),
                Err(tokio_tungstenite::tungstenite::Error::Http(response))
                    if matches!(response.status().as_u16(), 401 | 403) =>
                {
                    Err(MailboxError::AuthenticationRequired)
                }
                Err(_) => Err(MailboxError::Unreachable),
            }
        })
    }
}

struct WebSocket(
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
);

impl MailboxSocket for WebSocket {
    fn receive(&mut self) -> BoxFuture<'_, Result<Vec<u8>, MailboxError>> {
        Box::pin(async move {
            use futures_util::StreamExt;
            use tokio_tungstenite::tungstenite::Message;
            // Also notices a half-open connection; polling covers the gap.
            let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
            loop {
                let next = tokio::time::timeout_at(deadline, self.0.next())
                    .await
                    .map_err(|_| MailboxError::Unreachable)?;
                match next {
                    Some(Ok(Message::Text(text))) => return Ok(text.into_bytes()),
                    Some(Ok(Message::Binary(bytes))) => return Ok(bytes),
                    Some(Ok(Message::Ping(_) | Message::Pong(_) | Message::Frame(_))) => continue,
                    Some(Ok(Message::Close(_))) | None => return Err(MailboxError::Unreachable),
                    Some(Err(tokio_tungstenite::tungstenite::Error::Capacity(_))) => {
                        return Err(MailboxError::OversizedMessage)
                    }
                    Some(Err(_)) => return Err(MailboxError::Unreachable),
                }
            }
        })
    }

    fn close(&mut self) {
        let _ = futures_util::FutureExt::now_or_never(self.0.close(None));
    }
}

/// The room participant credential and the mailbox it opens.
pub struct Activated {
    pub config: MailboxConfig,
    pub credential: MailboxCredential,
}

fn path_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Trades the person's Cloud session (`access_token` at `site`) for this
/// device's participant credential in `workspace_id`'s room, then
/// activates the mailbox at the room's own origin. Neither answer can move
/// an existing bearer: each origin is validated before use, and the
/// mailbox must attest its own origin, never a new one.
pub async fn activate(
    network: &dyn MailboxNetwork,
    site: &str,
    workspace_id: &str,
    access_token: &Secret,
    device_id: &str,
    now_ms: i64,
) -> Result<Activated, MailboxError> {
    let control = MailboxConfig::new(site, "login", workspace_id)?;
    if device_id.is_empty() || !path_id(workspace_id) {
        return Err(MailboxError::InvalidConfiguration);
    }
    let mut room_url =
        url::Url::parse(&control.site).map_err(|_| MailboxError::InvalidConfiguration)?;
    room_url.set_path(&format!(
        "/cloud/api/v1/workspaces/{workspace_id}/room/session"
    ));
    let room = network
        .request(
            "POST",
            room_url.into(),
            access_token.clone(),
            Some(serde_json::to_vec(&json!({"deviceId": device_id})).unwrap_or_default()),
            None,
        )
        .await?;
    let room: Value = serde_json::from_slice(&room).map_err(|_| MailboxError::InvalidResponse)?;
    let token = room["agentToken"].as_str().unwrap_or_default();
    let participant = room["role"] == "participant"
        && room["observerToken"].is_null()
        && token.starts_with("at_live_");
    if !participant {
        return Err(MailboxError::AuthenticationRequired);
    }
    let token = Secret::new(token);
    let origin = room["relaycastBaseUrl"]
        .as_str()
        .ok_or(MailboxError::AuthenticationRequired)?;
    let mailbox = MailboxConfig::new(origin, "activation", workspace_id)
        .map_err(|_| MailboxError::AuthenticationRequired)?;
    let mut session_url =
        url::Url::parse(&mailbox.site).map_err(|_| MailboxError::InvalidConfiguration)?;
    session_url.set_path(SESSION_PATH);
    let session = network
        .request("POST", session_url.into(), token.clone(), None, None)
        .await?;
    let session: Value =
        serde_json::from_slice(&session).map_err(|_| MailboxError::InvalidResponse)?;
    let field = |key: &str| {
        session[key]
            .as_str()
            .map(str::to_string)
            .ok_or(MailboxError::InvalidResponse)
    };
    let config = MailboxConfig {
        site: field("site")?,
        account_id: field("account_id")?,
        workspace_id: field("workspace_id")?,
        messages_path: field("messages_path")?,
        acks_path: field("acks_path")?,
        threads_path: field("threads_path")?,
    }
    .validated()?;
    let expires_at_ms = session["expires_at"]
        .as_str()
        .and_then(crate::parse_iso_ms)
        .ok_or(MailboxError::InvalidResponse)?;
    if config.origin() != mailbox.origin() || expires_at_ms <= now_ms {
        return Err(MailboxError::InvalidResponse);
    }
    let credential = MailboxCredential {
        scope: config.scope(),
        token,
        expires_at_ms,
    };
    config.bearer(&credential, now_ms)?;
    Ok(Activated { config, credential })
}

/// The outbox the receiver reads and advances (the durable layer).
pub trait MailboxStore: Send + Sync + 'static {
    fn cursor(&self) -> Result<Option<String>, String>;
    /// Forgets the cursor when it is still `since`; a later checkpoint stays.
    fn reset_cursor_if_matching(&self, since: &str) -> Result<(), String>;
    fn checkpoint(&self, id: &str) -> Result<(), String>;
    /// The next acknowledgements to send, oldest first, at most 100.
    fn pending_acks(&self) -> Result<Vec<(i64, Value)>, String>;
    fn acknowledge_through(&self, sequence: i64) -> Result<(), String>;
}

/// Where a received message goes: durably recorded (queued, held or
/// refused) before this returns.
pub trait MailboxInbox: Send + Sync + 'static {
    fn receive_durably(&self, message: &Value) -> Result<(), MailboxError>;
}

/// One thread for the catalog Cloud shows the web app.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ThreadReport {
    pub id: String,
    /// `hold` or `auto`; absent when not shared.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    pub open: bool,
    pub project: String,
    pub shared: bool,
    pub title: String,
}

fn is_thread_id(id: &str) -> bool {
    crate::relay::cloud_session::is_workspace_uuid(id)
}

/// Only threads the person shared, by their Codex id, leave this computer.
pub fn shared_catalog(rows: Vec<ThreadReport>) -> Vec<ThreadReport> {
    rows.into_iter()
        .filter(|row| row.shared && is_thread_id(&row.id))
        .collect()
}

/// The receiver's state.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReceiverState {
    Stopped,
    Connecting,
    Connected,
    Polling,
    NeedsSignIn,
}

/// `min(30, 2^min(5, n−1)) × (0.5 + jitter/2)` seconds.
pub fn backoff(failures: u32, jitter: f64) -> Duration {
    let exponent = failures.saturating_sub(1).min(5);
    let base = (2f64.powi(exponent as i32)).min(30.0);
    Duration::from_secs_f64(base * (0.5 + jitter.clamp(0.0, 1.0) * 0.5))
}

/// What the receiver is given.
pub struct ReceiverParts {
    pub config: MailboxConfig,
    pub network: Arc<dyn MailboxNetwork>,
    pub store: Arc<dyn MailboxStore>,
    pub inbox: Arc<dyn MailboxInbox>,
    /// This mailbox's credential now, or why not.
    pub credential: Arc<dyn Fn() -> Result<MailboxCredential, MailboxError> + Send + Sync>,
    pub catalog: Arc<dyn Fn() -> BoxFuture<'static, Vec<ThreadReport>> + Send + Sync>,
    /// Told when Cloud refuses (or there is no) credential, and when it
    /// accepts one again.
    pub authenticated: Arc<dyn Fn(bool) + Send + Sync>,
    /// The pause between failed attempts and between upstream passes.
    pub pause: Arc<dyn Fn(Duration) -> BoxFuture<'static, ()> + Send + Sync>,
    pub jitter: fn() -> f64,
}

/// One mailbox's receive and upstream loops.
pub struct Receiver {
    parts: ReceiverParts,
    state: Mutex<ReceiverState>,
}

fn storage(error: String) -> MailboxError {
    MailboxError::Storage(error)
}

impl Receiver {
    pub fn new(parts: ReceiverParts) -> Arc<Receiver> {
        Arc::new(Receiver {
            parts,
            state: Mutex::new(ReceiverState::Stopped),
        })
    }

    pub fn state(&self) -> ReceiverState {
        *self.state.lock().unwrap()
    }

    fn set(&self, state: ReceiverState) {
        *self.state.lock().unwrap() = state;
    }

    fn authorized(
        &self,
        path: &str,
        since: Option<&str>,
        socket: bool,
    ) -> Result<(String, Secret), MailboxError> {
        let credential = (self.parts.credential)()?;
        let bearer = self
            .parts
            .config
            .bearer(&credential, crate::relay::state::now_ms())?;
        Ok((self.parts.config.url(path, since, socket)?, bearer))
    }

    fn refused(&self) {
        (self.parts.authenticated)(false);
        self.set(ReceiverState::NeedsSignIn);
    }

    /// Runs both loops until the returned task is aborted; aborting drops
    /// every request in flight, so a late answer is never accepted.
    pub fn start(self: &Arc<Self>) -> tokio::task::JoinHandle<()> {
        let receiver = self.clone();
        tokio::spawn(async move {
            let upstream = tokio::spawn({
                let receiver = receiver.clone();
                async move { receiver.upstream().await }
            });
            struct Abort(tokio::task::JoinHandle<()>);
            impl Drop for Abort {
                fn drop(&mut self) {
                    self.0.abort();
                }
            }
            let _upstream = Abort(upstream);
            receiver.downstream().await;
        })
    }

    async fn downstream(&self) {
        let mut failures = 0u32;
        loop {
            match self.connected().await {
                Ok(()) => {}
                Err(error) => {
                    failures += 1;
                    if error == MailboxError::AuthenticationRequired {
                        self.refused();
                    } else {
                        self.set(ReceiverState::Polling);
                        if let Err(MailboxError::AuthenticationRequired) = self.poll().await {
                            self.refused();
                        }
                    }
                    (self.parts.pause)(backoff(failures, (self.parts.jitter)())).await;
                    continue;
                }
            }
            failures = 0;
        }
    }

    /// One socket, read until it fails.
    async fn connected(&self) -> Result<(), MailboxError> {
        self.set(ReceiverState::Connecting);
        let since = self.parts.store.cursor().map_err(storage)?;
        let (url, bearer) =
            self.authorized(&self.parts.config.messages_path, since.as_deref(), true)?;
        let mut socket = self.parts.network.connect(url, bearer).await?;
        struct Close<'a>(&'a mut Box<dyn MailboxSocket>);
        impl Drop for Close<'_> {
            fn drop(&mut self) {
                self.0.close();
            }
        }
        let socket = Close(&mut socket);
        (self.parts.authenticated)(true);
        self.set(ReceiverState::Connected);
        loop {
            let frame = socket.0.receive().await?;
            if frame.len() > MAX_FRAME {
                return Err(MailboxError::OversizedMessage);
            }
            let message: Value =
                serde_json::from_slice(&frame).map_err(|_| MailboxError::InvalidResponse)?;
            self.accept(&message)?;
        }
    }

    /// One poll from the cursor. A retired cursor is forgotten and the poll
    /// retried once without it; a second refusal is an error, not a loop.
    pub async fn poll(&self) -> Result<(), MailboxError> {
        let since = self.parts.store.cursor().map_err(storage)?;
        let (url, bearer) =
            self.authorized(&self.parts.config.messages_path, since.as_deref(), false)?;
        let data = match self
            .parts
            .network
            .request("GET", url, bearer, None, None)
            .await
        {
            Err(MailboxError::CursorNotFound) => {
                let since = since.ok_or(MailboxError::CursorNotFound)?;
                self.parts
                    .store
                    .reset_cursor_if_matching(&since)
                    .map_err(storage)?;
                let cursor = self.parts.store.cursor().map_err(storage)?;
                let (url, bearer) =
                    self.authorized(&self.parts.config.messages_path, cursor.as_deref(), false)?;
                self.parts
                    .network
                    .request("GET", url, bearer, None, None)
                    .await?
            }
            other => other?,
        };
        let messages: Vec<Value> =
            serde_json::from_slice(&data).map_err(|_| MailboxError::InvalidResponse)?;
        if messages.len() > MAX_POLL {
            return Err(MailboxError::OversizedMessage);
        }
        (self.parts.authenticated)(true);
        for message in &messages {
            self.accept(message)?;
        }
        Ok(())
    }

    /// A malformed envelope stops the stream without skipping its cursor,
    /// until Cloud repairs it: nothing is dropped silently.
    fn accept(&self, message: &Value) -> Result<(), MailboxError> {
        let text = |value: &Value| value.as_str().map(str::len);
        let id = message["id"].as_str().unwrap_or_default();
        let valid = !id.is_empty()
            && id.len() <= 256
            && text(&message["sender"]["id"]).is_some_and(|n| n > 0 && n <= 256)
            && text(&message["sender"]["display_name"]).is_some_and(|n| n <= 512)
            && text(&message["text"]).is_some_and(|n| n <= 128 * 1024);
        if !valid {
            return Err(MailboxError::InvalidResponse);
        }
        self.parts.inbox.receive_durably(message)?;
        self.parts.store.checkpoint(id).map_err(storage)
    }

    async fn upstream(&self) {
        let mut passes = 0u64;
        loop {
            let pass = async {
                self.flush_acks().await?;
                if passes.is_multiple_of(15) {
                    self.report_catalog().await?;
                }
                Ok::<(), MailboxError>(())
            };
            if let Err(MailboxError::AuthenticationRequired) = pass.await {
                self.refused();
            }
            passes += 1;
            (self.parts.pause)(Duration::from_secs(2)).await;
        }
    }

    /// Sends the next batch of acknowledgements. A lost answer resends the
    /// same batch under the same idempotency key.
    pub async fn flush_acks(&self) -> Result<(), MailboxError> {
        let batch = self.parts.store.pending_acks().map_err(storage)?;
        let Some((last, _)) = batch.last() else {
            return Ok(());
        };
        let last = *last;
        let body = serde_json::to_vec(&batch.iter().map(|(_, ack)| ack).collect::<Vec<_>>())
            .map_err(|_| MailboxError::InvalidResponse)?;
        let key = format!("{}-{:x}", self.parts.config.scope(), Sha256::digest(&body));
        let (url, bearer) = self.authorized(&self.parts.config.acks_path, None, false)?;
        self.parts
            .network
            .request("POST", url, bearer, Some(body), Some(key))
            .await?;
        self.parts.store.acknowledge_through(last).map_err(storage)
    }

    /// Reports the threads the person shared.
    pub async fn report_catalog(&self) -> Result<(), MailboxError> {
        let rows = shared_catalog((self.parts.catalog)().await);
        let body = serde_json::to_vec(&rows).map_err(|_| MailboxError::InvalidResponse)?;
        let (url, bearer) = self.authorized(&self.parts.config.threads_path, None, false)?;
        self.parts
            .network
            .request("POST", url, bearer, Some(body), None)
            .await
            .map(|_| ())
    }

    /// Ends this mailbox's device session at Cloud. Best effort.
    pub async fn deactivate(
        network: &dyn MailboxNetwork,
        config: &MailboxConfig,
        credential: &MailboxCredential,
    ) {
        let Ok(bearer) = config.bearer(credential, crate::relay::state::now_ms()) else {
            return;
        };
        let Ok(url) = config.url(SESSION_PATH, None, false) else {
            return;
        };
        let _ = network.request("DELETE", url, bearer, None, None).await;
    }
}

#[cfg(test)]
mod tests;
