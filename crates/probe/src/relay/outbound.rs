//! The relay-send socket: sessions on this computer send, list the
//! workspace, put themselves on the relay and run agent-led setup.
//!
//! A session the core registered holds no Relaycast credential; the core
//! does. So the core serves a private HTTP/1.1-over-Unix socket, and a
//! session sends through it with nothing but a recipient and text:
//!
//! ```sh
//! curl -s --unix-socket "$XDG_RUNTIME_DIR/agent-relay/relay.sock" \
//!   'http://relay/send?address=alice@laptop' --data-binary 'On it.'
//! ```
//!
//! On Windows the same HTTP/1.1 is served on the named pipe
//! `relay::transport` derives from the socket path. curl cannot reach a
//! pipe, so every command handed to a session there is the probe's own
//! client (`agent-relay-probe relay send` and the other `session_cli`
//! commands, [`probe_client`]).
//!
//! The caller is never taken at its word. The kernel reports the connecting
//! process (`SO_PEERCRED`; `LOCAL_PEERPID` and `getpeereid` on macOS;
//! `GetNamedPipeClientProcessId` on Windows, whose DACL admits only this
//! user); the
//! session directory walks up from it to the live session it runs inside,
//! and the core acts with that session's own registration. A request naming
//! a sender, a process outside every supported session and another user are
//! refused, and each session may make 30 requests a minute. No key or token
//! appears in a route's answer, except a webhook's secret, once, to the
//! session that created it. See docs/injectable-agents.md ("Sending from a
//! session") and docs/agent-driven-setup.md.

use crate::relay::activity::publication::roster_rows;
use crate::relay::client;
use crate::relay::connect::{connect_id, join_request_hash, ConnectAvailability, ConnectSession};
use crate::relay::connect_presence::RosterEntry;
use crate::relay::daemon::Core;
use crate::relay::links::Endpoint;
use crate::relay::peer::current_uid;
use crate::relay::protocol::{ErrorKind, RpcError};
use crate::relay::sdk_gaps;
use crate::relay::session_cli::{Recipient, SessionCommand};
use crate::relay::sessions::{CallerMiss, DiscoveredSession, UnreadableSessionFile};
use crate::relay::setup::{DirectDelivery, Setup};
use crate::relay::state::now_ms;
use crate::relay::store::{Registration, SessionKind};
use crate::relay::transport::{self, CoreListener, CoreStream};
use crate::relay::workspace::Secret;
use fs2::FileExt;
use futures_util::future::{BoxFuture, FutureExt, Shared};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, VecDeque};
use std::fs;
#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub mod channels;
mod codex_hook;
mod connect_send;
pub(crate) mod fetch;
mod http;
mod mobile_handoff;
mod mobile_handoff_permission;
mod mobile_handoff_result;
mod send_files;
mod settings;
use connect_send::ConnectSendKey;
use http::{connection, payload};
use send_files::{requested_files, upload_files};

pub const SOCKET_NAME: &str = "relay.sock";
/// The largest request body.
pub const MAX_BODY_BYTES: usize = 128 * 1024;
const MAX_HEADER_BYTES: usize = 64 * 1024;
/// Requests per session per window.
pub const RATE_LIMIT: usize = 30;
pub const RATE_WINDOW: Duration = Duration::from_secs(60);
/// How long a workspace roster read serves `GET /agents`.
pub const ROSTER_CACHE: Duration = Duration::from_secs(30);
/// How long `GET /agents` waits on Relaycast for a roster read. Past it the
/// last roster read answers, marked `stale`, while the read finishes in the
/// background for the next request; with none yet, the route says Relaycast
/// is slow. The SDK's own limit (30 s, with retries) is far past what a
/// session's command waits.
pub const ROSTER_WAIT: Duration = Duration::from_secs(5);
/// A connection that stalls mid-request is dropped.
const READ_TIMEOUT: Duration = Duration::from_secs(10);

/// `sockaddr_un.sun_path` capacity including the terminating NUL.
#[cfg(target_os = "macos")]
const SUN_PATH_CAPACITY: usize = 104;
#[cfg(not(target_os = "macos"))]
const SUN_PATH_CAPACITY: usize = 108;

/// Whether `path` fits a Unix socket address. Every path fits on Windows,
/// where it only names the pipe.
fn fits_unix_socket(path: &Path) -> bool {
    cfg!(windows) || path.as_os_str().len() < SUN_PATH_CAPACITY
}

/// Whether a command handed to a session must use the probe's own socket
/// client instead of curl: always on Windows, where curl cannot reach a
/// named pipe; on macOS when the caller says so (`needs_probe`), because
/// Apple's curl hides the session's environment from the core.
pub fn probe_client(needs_probe: bool) -> bool {
    cfg!(windows) || (cfg!(target_os = "macos") && needs_probe)
}

/// Whether a session of `kind` is handed the probe's own socket client on
/// every platform, falling back to curl only when the probe's path is
/// unknown: Claude Code, whose permission rules from Agent Relay
/// (`claude::session_hook::PermissionRules`) allow exactly this probe's
/// self-limiting session commands (`session_cli`) on this core's socket, so
/// it reads and answers a relayed message without an approval prompt.
pub fn prefers_probe_client(kind: SessionKind) -> bool {
    matches!(kind, SessionKind::ClaudeTerminal | SessionKind::ClaudeCloud)
}

/// Where the relay-send socket lives.
///
/// Linux: `$XDG_RUNTIME_DIR/agent-relay/relay.sock`, private to this user
/// and cleared at logout; without a runtime directory, `<app data>/run`.
/// macOS: `<app data>/run/relay.sock`, else a short per-user directory under
/// `$TMPDIR` (then `/tmp`) when that path is too long for a Unix socket.
/// Windows: `<app data>/run/relay.sock`, the key of its named pipe.
/// Agent Relay Dev (an app data directory ending `.dev`) has its own socket
/// in every location.
pub fn default_socket(
    env: &dyn Fn(&str) -> Option<String>,
    app_data_dir: &Path,
    uid: u32,
) -> PathBuf {
    socket_for(cfg!(target_os = "linux"), env, app_data_dir, uid)
}

fn socket_for(
    linux: bool,
    env: &dyn Fn(&str) -> Option<String>,
    app_data_dir: &Path,
    uid: u32,
) -> PathBuf {
    let directory = if is_development(app_data_dir) {
        "agent-relay-dev"
    } else {
        "agent-relay"
    };
    let preferred = app_data_dir.join("run").join(SOCKET_NAME);
    if linux {
        return match env("XDG_RUNTIME_DIR").filter(|value| !value.trim().is_empty()) {
            Some(runtime) => Path::new(runtime.trim()).join(directory).join(SOCKET_NAME),
            None => preferred,
        };
    }
    if fits_unix_socket(&preferred) {
        return preferred;
    }
    let short = format!("{directory}-{uid}");
    let temporary = env("TMPDIR")
        .filter(|value| !value.trim().is_empty())
        .map(|value| Path::new(value.trim()).join(&short).join(SOCKET_NAME));
    match temporary {
        Some(path) if fits_unix_socket(&path) => path,
        _ => Path::new("/tmp").join(short).join(SOCKET_NAME),
    }
}

/// `~/.agentworkforce/desktop/relay-socket`: the socket's path plus a
/// newline, for clients outside the core. Agent Relay Dev (an app data
/// directory ending `.dev`) writes `relay-socket.dev`, so the two builds
/// never point sessions at each other.
pub fn pointer_path(home: &Path, app_data_dir: &Path) -> PathBuf {
    let name = if is_development(app_data_dir) {
        "relay-socket.dev"
    } else {
        "relay-socket"
    };
    home.join(".agentworkforce/desktop").join(name)
}

fn is_development(app_data_dir: &Path) -> bool {
    app_data_dir
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.ends_with(".dev"))
}

/// How the core serves the relay-send socket.
pub struct RelaySend {
    pub socket: PathBuf,
    pub pointer: PathBuf,
    pub direct_delivery: Arc<dyn DirectDelivery>,
    /// Shared with the injector, which offers reply commands only while
    /// the socket serves.
    pub serving: ServingPath,
    /// Apply the agent-led setup defaults when the socket starts serving,
    /// not only when a setup route asks: the headless service has no UI to
    /// choose them.
    pub agent_led_defaults_at_start: bool,
}

/// The socket path a session is told to use, once the socket serves.
#[derive(Clone, Default)]
pub struct ServingPath(Arc<Mutex<Option<PathBuf>>>);

impl ServingPath {
    pub fn get(&self) -> Option<PathBuf> {
        self.0.lock().unwrap().clone()
    }

    fn set(&self, path: Option<PathBuf>) {
        *self.0.lock().unwrap() = path;
    }
}

/// The line an injected message carries so the session can answer beneath
/// it, and find other participants. The recipient comes from the sender,
/// so it is percent-encoded and every argument shell-quoted: a name cannot
/// break out of the suggested command.
pub fn reply_hint(
    socket: &Path,
    to: Option<&str>,
    address: Option<&str>,
    reply_to: &str,
    kind: SessionKind,
    needs_probe: bool,
) -> Option<String> {
    let (key, recipient) = match (to, address) {
        (Some(to), None) => ("to", to),
        (None, Some(address)) => ("address", address),
        _ => return None,
    };
    if reply_to.is_empty() {
        return None;
    }
    let path = socket.to_str()?;
    let request_path = format!(
        "/send?{key}={}&reply_to={}",
        query_encode(recipient),
        query_encode(reply_to)
    );
    if probe_client(needs_probe) || prefers_probe_client(kind) {
        let probe = (|| {
            let recipient = match key {
                "to" => Recipient::To(recipient.to_string()),
                _ => Recipient::Address(recipient.to_string()),
            };
            let reply = SessionCommand::Send {
                recipient,
                reply_to: Some(reply_to.to_string()),
                thread: None,
            };
            let send = probe_session_command(socket, &reply, Some("your reply"))?;
            let agents = probe_session_command(socket, &SessionCommand::Agents, None)?;
            Some(format!("[reply: {send}]\n[agents: {agents}]"))
        })();
        // Only where curl cannot reach the socket is there no fallback.
        if probe.is_some() || probe_client(needs_probe) {
            return probe;
        }
    }
    let url = format!("http://relay{request_path}");
    let send = [
        "curl",
        "-s",
        "--unix-socket",
        path,
        &url,
        "--data-binary",
        "your reply",
    ];
    let agents = ["curl", "-s", "--unix-socket", path, "http://relay/agents"];
    let quoted = |parts: &[&str]| {
        parts
            .iter()
            .map(|p| shell_quote(p))
            .collect::<Vec<_>>()
            .join(" ")
    };
    Some(format!(
        "[reply: {}]\n[agents: {}]",
        quoted(&send),
        quoted(&agents)
    ))
}

/// The command a session runs to fetch an attachment it could not get in
/// time, through `POST /attachments/fetch` on the session socket. Built like
/// [`reply_hint`]: the probe on macOS where Apple's curl hides the session's
/// environment, curl elsewhere; the id was checked to be a plain token.
pub fn fetch_hint(
    socket: &Path,
    file_id: &str,
    kind: SessionKind,
    needs_probe: bool,
) -> Option<String> {
    let path = socket.to_str()?;
    let request_path = format!("/attachments/fetch?file_id={}", query_encode(file_id));
    if probe_client(needs_probe) || prefers_probe_client(kind) {
        let fetch = SessionCommand::FetchAttachment {
            file_id: file_id.to_string(),
        };
        let probe = probe_session_command(socket, &fetch, None);
        if probe.is_some() || probe_client(needs_probe) {
            return probe;
        }
    }
    let url = format!("http://relay{request_path}");
    Some(
        ["curl", "-s", "-X", "POST", "--unix-socket", path, &url]
            .iter()
            .map(|p| shell_quote(p))
            .collect::<Vec<_>>()
            .join(" "),
    )
}

/// `command` through the current probe executable, as a hint names it: one
/// of the self-limiting session commands (`session_cli`) that Codex's
/// sandbox rules and Claude Code's permission rules allow.
pub(crate) fn probe_session_command(
    socket: &Path,
    command: &SessionCommand,
    body: Option<&str>,
) -> Option<String> {
    command.command_line(&fetch::probe_executable()?, socket, body)
}

/// `relay socket-request` through the current probe executable, whose
/// environment remains inspectable on macOS when Apple's system curl does
/// not expose CODEX_THREAD_ID or AGENT_RELAY_OPENCODE_SESSION. For a route
/// no session command serves (`/register`, `/whoami`, a channel
/// subscription); no rule allows it, so it asks.
pub(crate) fn probe_socket_command(socket: &Path, method: &str, path: &str) -> Option<String> {
    probe_command(socket, method, path, None)
}

/// [`probe_socket_command`] with its request body as `--body`.
pub(crate) fn probe_socket_command_with_body(
    socket: &Path,
    method: &str,
    path: &str,
    body: &str,
) -> Option<String> {
    probe_command(socket, method, path, Some(body))
}

fn probe_command(socket: &Path, method: &str, path: &str, body: Option<&str>) -> Option<String> {
    probe_command_for(&fetch::probe_executable()?, socket, method, path, body)
}

/// [`probe_command`] through `executable`.
pub(crate) fn probe_command_for(
    executable: &Path,
    socket: &Path,
    method: &str,
    path: &str,
    body: Option<&str>,
) -> Option<String> {
    let mut parts = vec![
        executable.to_str()?,
        "relay",
        "socket-request",
        "--socket",
        socket.to_str()?,
        "--method",
        method,
        "--path",
        path,
    ];
    if let Some(body) = body {
        parts.extend(["--body", body]);
    }
    Some(
        parts
            .iter()
            .map(|part| shell_quote(part))
            .collect::<Vec<_>>()
            .join(" "),
    )
}

pub(crate) fn query_encode(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~@".contains(&byte) {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

pub(crate) fn shell_quote(value: &str) -> String {
    let safe = |c: char| c.is_ascii_alphanumeric() || "%+,-./:=@_".contains(c);
    if !value.is_empty() && value.chars().all(safe) {
        value.to_string()
    } else {
        format!("'{}'", value.replace('\'', "'\\''"))
    }
}

/// A refusal, as the socket reports it:
/// `{"ok":false,"error":{"code","message"}}` with an HTTP status.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutboundError {
    pub status: u16,
    pub code: String,
    pub message: String,
}

impl OutboundError {
    pub fn new(status: u16, code: &str, message: impl Into<String>) -> OutboundError {
        OutboundError {
            status,
            code: code.into(),
            message: message.into(),
        }
    }

    fn not_this_user() -> OutboundError {
        OutboundError::new(
            403,
            "not_this_user",
            "Only this user's sessions can send through this app.",
        )
    }

    fn not_a_session() -> OutboundError {
        OutboundError::new(
            403,
            "not_a_relay_session",
            "This command is not running inside a supported live Agent Relay session.",
        )
    }

    /// The caller's nearest session is a running Claude Code session whose
    /// registry file does not parse, so it cannot be named.
    fn session_file_unreadable(file: &UnreadableSessionFile) -> OutboundError {
        OutboundError::new(
            409,
            "session_file_unreadable",
            format!(
                "This Claude Code session is running, but its session file {} cannot be read ({}). \
                 Claude Code writes that file when a session starts: exit this session and resume it \
                 with `claude --resume` so it is written again.",
                file.path.display(),
                file.error
            ),
        )
    }

    fn not_registered() -> OutboundError {
        OutboundError::new(
            403,
            "not_a_relay_session",
            "This session is not on the relay. Use POST /register or turn it on in the Agent Relay app first.",
        )
    }

    /// A Relaycast failure: its status and code, never its message, which
    /// can carry a provider body.
    pub(crate) fn relaycast(error: &relaycast::RelayError) -> OutboundError {
        let status = error
            .status()
            .filter(|status| (400..600).contains(status))
            .unwrap_or(502);
        let code = error.code().unwrap_or("relaycast_error");
        OutboundError::new(status, code, RpcError::from_relaycast(error).message)
    }

    /// A core failure, by its kind.
    pub fn from_rpc(error: &RpcError, fallback_code: &str) -> OutboundError {
        let (status, code) = match error.data.kind {
            ErrorKind::InvalidParams => (400, "invalid_request"),
            ErrorKind::NotSignedIn => (401, "not_signed_in"),
            ErrorKind::Unauthorized => (401, "unauthorized"),
            ErrorKind::NotFound => (404, "not_found"),
            ErrorKind::Conflict => (409, "conflict"),
            ErrorKind::Busy => (409, "busy"),
            ErrorKind::Refused => (409, "refused"),
            ErrorKind::RateLimited => (429, "rate_limited"),
            ErrorKind::StoreFailed => (500, "save_failed"),
            ErrorKind::ShuttingDown => (503, "shutting_down"),
            ErrorKind::MethodNotFound | ErrorKind::HistoryUnavailable => (503, "setup_unavailable"),
            ErrorKind::FleetUnavailable => (503, "fleet_unavailable"),
            _ => (502, fallback_code),
        };
        OutboundError::new(status, code, error.message.clone())
    }
}

/// A refused connection is known to have failed before Relaycast received the
/// request. Other HTTP transport errors are ambiguous and must not turn an
/// unkeyed mutation into a possible second message.
fn retry_unkeyed_after(error: &relaycast::RelayError) -> bool {
    matches!(error, relaycast::RelayError::Http(source) if source.is_connect())
}

type Clock = Arc<dyn Fn() -> Instant + Send + Sync>;

#[derive(Clone)]
struct CachedRoster {
    expires: Instant,
    fetched_at_ms: i64,
    items: Vec<Value>,
}

/// A roster read in flight, which every request for the same roster joins.
type RosterRead = Shared<BoxFuture<'static, Result<(i64, Vec<Value>), OutboundError>>>;

/// The workspace rosters `GET /agents` read: the last answer for each
/// origin, key and idle choice, kept past its cache window as the
/// last-known roster, and the reads in flight.
#[derive(Default)]
struct Rosters {
    cached: HashMap<String, CachedRoster>,
    reading: HashMap<String, RosterRead>,
}

/// A roster for `GET /agents`: its items, when they were read, and whether
/// they are the last-known roster because a fresh read did not finish.
pub(crate) struct RosterAnswer {
    fetched_at_ms: i64,
    pub(crate) items: Vec<Value>,
    stale: bool,
}

/// Whether a failed roster read may be answered with the last-known roster:
/// a timeout, a transport failure or a server error. A refusal (a revoked
/// key) is reported, never hidden behind an old answer.
fn transient(error: &OutboundError) -> bool {
    error.status >= 500
}

/// The routes' rules, apart from the socket, so they are tested without
/// one: caller identification, admission, rate limits and the roster cache.
pub struct Outbound {
    pub(crate) core: Arc<Core>,
    setup: Arc<Setup>,
    uid: u32,
    clock: Clock,
    sent: Mutex<HashMap<String, VecDeque<Instant>>>,
    rosters: Arc<Mutex<Rosters>>,
    connect_broadcasts: connect_send::Broadcasts,
    mobile_permissions: mobile_handoff_permission::Tickets,
}

/// A request: its query (for `GET /agents` and `?to=` sends) and body.
#[derive(Clone, Debug, Default)]
pub struct Request {
    pub method: String,
    pub path: String,
    pub query: Vec<(String, String)>,
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}

impl Request {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).map(String::as_str)
    }
}

enum Purpose {
    Send,
    Register,
    Json,
}

fn is_supported_kind(kind: SessionKind) -> bool {
    use SessionKind::{ClaudeTerminal, Codex, CursorCli, Devin};
    matches!(kind, Codex | ClaudeTerminal | Devin | CursorCli)
}

fn connect_gone_error(code: &str, message: String) -> OutboundError {
    OutboundError::new(
        if code == "connect_not_found" {
            404
        } else {
            410
        },
        code,
        message,
    )
}

/// Every route the session socket serves ([`Outbound::handle`] and
/// `mobile_handoff_route`), by method. A test reads the router's source and
/// fails while this list and the router differ, so a new route is never left
/// out of the sandbox-rule enumeration (`session_cli::ALLOWED_SUBCOMMANDS`
/// and the probe's `codex_rules_reach_only_their_own_routes`).
pub const SESSION_ROUTES: &[(&str, &str)] = &[
    ("POST", "/connect/join"),
    ("POST", "/connect/send"),
    ("GET", "/connect/status"),
    ("POST", "/connect/leave"),
    ("GET", "/whoami"),
    ("GET", "/agents"),
    ("POST", "/attachments/fetch"),
    ("GET", "/messages"),
    ("POST", "/send"),
    ("POST", "/register"),
    ("POST", "/channels/subscribe"),
    ("DELETE", "/channels/subscribe"),
    ("DELETE", "/register"),
    ("GET", "/settings"),
    ("PATCH", "/settings"),
    ("POST", "/codex/stop-hook"),
    ("GET", "/setup/status"),
    ("POST", "/setup/sign-in"),
    ("POST", "/setup/sharing"),
    ("POST", "/setup/auto-activate"),
    ("POST", "/setup/direct-delivery"),
    ("POST", "/webhooks"),
    ("DELETE", "/webhooks"),
    ("POST", "/integrations/subscribe"),
    ("DELETE", "/integrations/subscribe"),
    ("POST", "/claude/mobile-handoff/poll"),
    ("POST", "/claude/mobile-handoff/ack"),
    ("POST", "/claude/mobile-handoff/result"),
    ("POST", "/claude/mobile-handoff/permission"),
];

impl Outbound {
    pub fn new(core: Arc<Core>, direct_delivery: Arc<dyn DirectDelivery>) -> Outbound {
        Outbound::with_clock(core, direct_delivery, Arc::new(Instant::now))
    }

    pub fn with_clock(
        core: Arc<Core>,
        direct_delivery: Arc<dyn DirectDelivery>,
        clock: Clock,
    ) -> Outbound {
        Outbound {
            setup: Arc::new(Setup::new(core.clone(), direct_delivery)),
            core,
            uid: current_uid(),
            clock,
            sent: Mutex::default(),
            rosters: Arc::default(),
            connect_broadcasts: connect_send::Broadcasts::default(),
            mobile_permissions: mobile_handoff_permission::Tickets::default(),
        }
    }

    pub fn setup(&self) -> &Arc<Setup> {
        &self.setup
    }

    /// Answers one request from the process `pid` of user `uid`.
    pub async fn handle(
        &self,
        pid: i32,
        uid: u32,
        request: &Request,
    ) -> Result<Value, OutboundError> {
        let _activity = self.core.connect_lifetime.enter().ok_or_else(|| {
            OutboundError::new(
                503,
                "relay_stopping",
                "The temporary relay is stopping; retry the command.",
            )
        })?;
        match (request.method.as_str(), request.path.as_str()) {
            ("POST", "/connect/join") => {
                let fields = payload(request, Purpose::Json)?;
                self.connect_join(pid, uid, &fields).await
            }
            ("POST", "/connect/send") => self.connect_send(pid, uid, request).await,
            ("GET", "/connect/status") => self.connect_status(pid, uid).await,
            ("POST", "/connect/leave") => self.connect_leave(pid, uid).await,
            ("GET", "/whoami") => self.whoami(pid, uid).await,
            ("GET", "/agents") => self.agents(pid, uid, &request.query).await,
            ("POST", "/attachments/fetch") => self.fetch_attachment(pid, uid, &request.query).await,
            ("GET", "/messages") => self.read_message(pid, uid, &request.query).await,
            ("POST", "/send") => self.send_route(pid, uid, request).await,
            ("POST", "/register") => self.register_route(pid, uid, request).await,
            ("POST" | "DELETE", "/channels/subscribe") => {
                self.channel_subscription(pid, uid, request).await
            }
            ("DELETE", "/register") => self.unregister(pid, uid).await,
            ("GET" | "PATCH", "/settings") => self.settings_route(pid, uid, request).await,
            ("POST", "/codex/stop-hook") => {
                let fields = payload(request, Purpose::Json)?;
                self.codex_stop_hook(pid, uid, &fields).await
            }
            ("GET", "/setup/status") => {
                // The SessionStart hook only reads. Applying the agent-led
                // defaults here would turn automatic activation on, which is
                // the choice that hook exists so a person can avoid.
                if request.header(crate::relay::claude::session_hook::OBSERVE_HEADER)
                    == Some(crate::relay::claude::session_hook::OBSERVE_VALUE)
                {
                    self.observe_setup_status(pid, uid).await
                } else {
                    self.setup_route(pid, uid, "GET /setup/status", Map::new())
                        .await
                }
            }
            ("POST", "/setup/sign-in")
            | ("POST", "/setup/sharing")
            | ("POST", "/setup/auto-activate")
            | ("POST", "/setup/direct-delivery")
            | ("POST", "/webhooks")
            | ("DELETE", "/webhooks")
            | ("POST", "/integrations/subscribe")
            | ("DELETE", "/integrations/subscribe") => {
                let fields = payload(request, Purpose::Json)?;
                let route = format!("{} {}", request.method, request.path);
                self.setup_route(pid, uid, &route, fields).await
            }
            _ => self.mobile_handoff_route(pid, uid, request).await,
        }
    }

    /// The supported live session the caller runs inside, registered or
    /// not, fleet-owned or not.
    async fn identify(&self, pid: i32, uid: u32) -> Result<DiscoveredSession, OutboundError> {
        if uid != self.uid {
            return Err(OutboundError::not_this_user());
        }
        let directory = self.core.plugins.sessions.clone();
        match tokio::task::spawn_blocking(move || directory.caller(pid)).await {
            Ok(Ok(session)) => Ok(session),
            Ok(Err(CallerMiss::Unreadable(file))) => {
                Err(OutboundError::session_file_unreadable(&file))
            }
            Ok(Err(CallerMiss::NotASession)) | Err(_) => Err(OutboundError::not_a_session()),
        }
    }

    async fn connect_join(
        &self,
        pid: i32,
        uid: u32,
        fields: &Map<String, Value>,
    ) -> Result<Value, OutboundError> {
        if fields
            .keys()
            .any(|key| !matches!(key.as_str(), "link" | "name" | "host_claim"))
        {
            return Err(OutboundError::new(
                400,
                "invalid_request",
                "Use link, optional name and optional host_claim.",
            ));
        }
        let link = fields
            .get("link")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| {
                OutboundError::new(400, "invalid_link", "link must be a Connect link or id.")
            })?;
        let requested_id = connect_id(link).ok_or_else(|| {
            OutboundError::new(400, "invalid_link", "link must be a Connect link or id.")
        })?;
        let name = match fields.get("name") {
            None | Some(Value::Null) => None,
            Some(Value::String(value)) => {
                Some(crate::relay::agents::normalize_name(value).ok_or_else(|| {
                    OutboundError::new(
                        400,
                        "invalid_name",
                        "Use 2–48 lowercase letters, digits and single dashes.",
                    )
                })?)
            }
            _ => {
                return Err(OutboundError::new(
                    400,
                    "invalid_name",
                    "name must be a string.",
                ))
            }
        };
        let claim = match fields.get("host_claim") {
            None | Some(Value::Null) => None,
            Some(Value::String(value)) if !value.is_empty() => Some(value.clone()),
            _ => {
                return Err(OutboundError::new(
                    400,
                    "invalid_host_claim",
                    "host_claim must be a non-empty string.",
                ))
            }
        };
        let session = self.identify(pid, uid).await?;
        if !is_supported_kind(session.target.kind) || !session.live {
            return Err(OutboundError::new(
                403,
                "not_a_relay_session",
                "This session is not running or cannot receive injected messages.",
            ));
        }
        self.admit(&session.target.key())?;
        let lock = self.core.target_locks.get(&session.target.key());
        let _changing = lock.lock().await;
        if let Some(current) = self.core.connect_for(&session.target) {
            if current.expired() {
                let delivery = self
                    .core
                    .agent_locks
                    .get(&format!("connect:{}", current.agent_id));
                let _delivery = delivery.lock().await;
                self.core.close_connect(&current, "connect_expired");
            } else if current.connect_id == requested_id {
                return Ok(current.join_public());
            } else {
                return Err(OutboundError::new(
                    409,
                    "connect_already_joined",
                    "Leave the current Connect before joining another.",
                ));
            }
        }
        let joiner = self.core.plugins.connect_cloud.clone();
        let request_hash = join_request_hash(&requested_id, name.as_deref(), claim.as_deref());
        let idempotency_key = self
            .core
            .connect
            .lock()
            .unwrap()
            .begin_join_attempt(&session.target, &request_hash)
            .map_err(|_| {
                OutboundError::new(
                    500,
                    "connect_save_failed",
                    "This Connect join attempt could not be saved locally.",
                )
            })?
            .ok_or_else(|| {
                OutboundError::new(
                    409,
                    "connect_join_pending",
                    "A previous join has an unknown outcome. Retry with the same link, name, and host claim.",
                )
            })?;
        let link = link.to_string();
        let request_idempotency_key = idempotency_key.clone();
        let joined = tokio::task::spawn_blocking(move || {
            joiner.join(
                &link,
                name.as_deref(),
                claim.as_deref(),
                &request_idempotency_key,
            )
        })
        .await
        .map_err(|_| crate::relay::connect::connect_internal_error("join", &requested_id))?;
        let joined = match joined {
            Ok(joined) => joined,
            Err(error) => {
                if error.status >= 500
                    && !matches!(
                        error.code.as_str(),
                        "connect_unreachable" | "connect_join_timeout"
                    )
                {
                    // Transport failures were logged with their cause.
                    crate::relay::connect::log_connect_failure(
                        "join",
                        &requested_id,
                        &error.code,
                        &if error.code == "invalid_join_response" {
                            // Cloud answered; the body failed local validation.
                            "malformed_response".to_owned()
                        } else {
                            format!("http_{}", error.status)
                        },
                    );
                }
                if error.status < 500 && error.status != 429 {
                    self.core
                        .connect
                        .lock()
                        .unwrap()
                        .clear_join_attempt(&session.target, &idempotency_key);
                }
                return Err(error);
            }
        };
        if joined.connect_id != requested_id {
            return Err(OutboundError::new(
                502,
                "invalid_join_response",
                "Relay Connect returned a different Connect.",
            ));
        }
        let adopted = ConnectSession::from_join(session.target.clone(), joined)?;
        if adopted.expired() {
            return Err(OutboundError::new(
                410,
                "connect_expired",
                "This Connect has expired.",
            ));
        }
        let result = adopted.join_public();
        self.core
            .connect
            .lock()
            .unwrap()
            .insert(adopted)
            .map_err(|_| {
                OutboundError::new(
                    500,
                    "connect_save_failed",
                    "This Connect could not be saved locally.",
                )
            })?;
        if let Some(core) = self.core.arc() {
            tokio::spawn(async move {
                core.poll_connects().await;
            });
        }
        Ok(result)
    }

    async fn connect_session(
        &self,
        pid: i32,
        uid: u32,
    ) -> Result<(DiscoveredSession, ConnectSession), OutboundError> {
        let session = self.identify(pid, uid).await?;
        let joined = self.core.connect_for(&session.target).ok_or_else(|| {
            OutboundError::new(
                404,
                "connect_not_joined",
                "This session has not joined a Connect.",
            )
        })?;
        if joined.expired() {
            self.close_connect_serialized(&joined, "connect_expired")
                .await;
            return Err(OutboundError::new(
                410,
                "connect_expired",
                "This Connect has expired.",
            ));
        }
        Ok((session, joined))
    }

    async fn connect_send(
        &self,
        pid: i32,
        uid: u32,
        request: &Request,
    ) -> Result<Value, OutboundError> {
        let (to, text) = connect_send::parse_request(request)?;
        let (session, joined) = self.connect_session(pid, uid).await?;
        self.admit(&session.target.key())?;
        let roster = self.connect_roster(&session, &joined).await?;
        let participant_names = joined.participant_names(roster.as_deref());
        let key = ConnectSendKey::from_header(request.header("idempotency-key"));
        let recipients = self.connect_broadcasts.recipients(
            &joined,
            &key,
            to,
            (self.clock)(),
            connect_send::recipients(to, &joined.agent_name, &participant_names)?,
        );
        let mut sent: Vec<Value> = Vec::new();
        for name in recipients {
            let idempotency_key = key.for_recipient(&name);
            let outcome: Result<_, OutboundError> = async {
                Ok(match client::send_dm(
                &joined.base_url,
                &joined.token,
                &Endpoint::Name(name.clone()),
                text,
                Some(idempotency_key),
            )
            .await
            {
                Ok(sent) => sent,
                Err(error) if connect_send::retry_history_is_ambiguous(&error) => {
                    // A final rejection describes only the last SDK attempt.
                    // An earlier retryable 5xx may have followed a persisted
                    // message, so auth/not-found/admission final states cannot
                    // erase that ambiguous history.
                    crate::relay::connect::log_connect_failure(
                        "send",
                        &joined.connect_id,
                        "connect_upstream_error",
                        &relaycast_failure_cause(&error),
                    );
                    return Err(key.exhausted_retry_error(&error, &name));
                }
                Err(error @ relaycast::RelayError::Api { status: 404, .. })
                    if matches!(error.code(), Some("agent_not_found" | "address_not_found")) =>
                {
                    return Err(OutboundError::relaycast(&error));
                }
                Err(relaycast::RelayError::Api {
                    status: 404 | 410, ..
                }) => {
                    self.close_connect_serialized(&joined, "connect_ended")
                        .await;
                    return Err(OutboundError::new(
                        410,
                        "connect_ended",
                        "This Connect expired or ended.",
                    ));
                }
                Err(error) if error.is_auth_rejection() => {
                    match self.core.connect_availability(&joined).await {
                        Ok(ConnectAvailability::Gone { code, message }) => {
                            self.close_connect_serialized(&joined, &code).await;
                            return Err(connect_gone_error(&code, message));
                        }
                        Ok(ConnectAvailability::Active) => {
                            crate::relay::connect::log_connect_failure(
                                "send",
                                &joined.connect_id,
                                "connect_auth_rejected",
                                &relaycast_failure_cause(&error),
                            );
                            return Err(OutboundError::new(
                                503,
                                "connect_auth_rejected",
                                "Relay Connect refused this session's credential although the Connect is still open. This can happen briefly after the host changes; retry once.",
                            ));
                        }
                        Err(error) => return Err(error),
                    }
                }
                Err(error) if error.status().is_none() => {
                    crate::relay::connect::log_connect_failure(
                        "send",
                        &joined.connect_id,
                        "connect_unreachable",
                        &relaycast_failure_cause(&error),
                    );
                    return Err(OutboundError::new(
                        503,
                        "connect_unreachable",
                        format!(
                            "Relay Connect could not be reached; the delivery outcome for the message to {name} is unknown. {}",
                            key.retry_instruction()
                        ),
                    ));
                }
                Err(error) if error.status().is_some_and(|status| status >= 500) => {
                    crate::relay::connect::log_connect_failure(
                        "send",
                        &joined.connect_id,
                        "connect_upstream_error",
                        &relaycast_failure_cause(&error),
                    );
                    let retry = key.retry_instruction();
                    return Err(OutboundError::new(
                        502,
                        "connect_upstream_error",
                        format!(
                            "Relay Connect's server failed (HTTP {}, {}); the delivery outcome for the message to {name} is unknown. {retry}",
                            error.status().unwrap_or_default(),
                            error.code().unwrap_or("unknown_error")
                        ),
                    ));
                }
                Err(error) => return Err(OutboundError::relaycast(&error)),
                })
            }
            .await;
            let message = match outcome {
                Ok(message) => message,
                Err(error) => return Err(key.after_partial_delivery(error, &sent)),
            };
            let online = crate::relay::connect_presence::recipient_online(roster.as_deref(), &name);
            sent.push(crate::relay::connect_presence::send_receipt(
                &name,
                message.message_id.as_deref(),
                online,
            ));
        }
        let offline: Vec<&str> = sent
            .iter()
            .filter(|receipt| receipt["recipient_online"] == false)
            .filter_map(|receipt| receipt["to"].as_str())
            .collect();
        let mut result = json!({"sent": sent});
        if let Some(warning) = crate::relay::connect_presence::offline_warning(&offline) {
            result["warning"] = json!(warning);
        }
        Ok(result)
    }

    async fn connect_status(&self, pid: i32, uid: u32) -> Result<Value, OutboundError> {
        let (session, joined) = self.connect_session(pid, uid).await?;
        let roster = self.connect_roster(&session, &joined).await?;
        let mut status = joined.status_public(roster.as_deref());
        if let Some(delivery) = self.core.connect_delivery_public(&joined) {
            status["delivery"] = delivery;
        }
        Ok(status)
    }

    async fn connect_leave(&self, pid: i32, uid: u32) -> Result<Value, OutboundError> {
        let (session, joined) = self.connect_session(pid, uid).await?;
        self.admit(&session.target.key())?;
        let lock = self.core.target_locks.get(&session.target.key());
        let _changing = lock.lock().await;
        let delivery = self
            .core
            .agent_locks
            .get(&format!("connect:{}", joined.agent_id));
        let _delivery = delivery.lock().await;
        self.core
            .leave_connect(&session.target, &joined.agent_id)
            .map_err(|_| {
                OutboundError::new(
                    500,
                    "connect_save_failed",
                    "This Connect could not be removed locally.",
                )
            })?
            .ok_or_else(|| {
                OutboundError::new(
                    404,
                    "connect_not_joined",
                    "This session has not joined a Connect.",
                )
            })?;
        Ok(json!({"left": true, "connect_id": joined.connect_id}))
    }

    /// Reads Cloud's roster of this Connect with the participant token.
    /// A refused or unreachable roster makes presence unknown; a gone
    /// Connect removes the local credential, as delivery and send do.
    async fn connect_roster(
        &self,
        _session: &DiscoveredSession,
        joined: &ConnectSession,
    ) -> Result<Option<Vec<RosterEntry>>, OutboundError> {
        let error = match self.core.connect_cloud_roster(joined).await {
            Ok(roster) => return Ok(Some(roster)),
            Err(error) => error,
        };
        let gone = matches!(error.status, 404 | 410)
            && matches!(
                error.code.as_str(),
                "connect_not_found" | "connect_ended" | "connect_expired"
            );
        if gone {
            self.close_connect_serialized(joined, &error.code).await;
            return Err(connect_gone_error(&error.code, error.message));
        }
        if matches!(error.status, 401 | 403) {
            if let Ok(ConnectAvailability::Gone { code, message }) =
                self.core.connect_availability(joined).await
            {
                self.close_connect_serialized(joined, &code).await;
                return Err(connect_gone_error(&code, message));
            }
        }
        Ok(None)
    }

    async fn close_connect_serialized(&self, joined: &ConnectSession, code: &str) {
        let lock = self
            .core
            .agent_locks
            .get(&format!("connect:{}", joined.agent_id));
        let _delivery = lock.lock().await;
        self.core.close_connect(joined, code);
    }

    /// The caller's session, its registration and the token it acts with.
    async fn authorize(
        &self,
        pid: i32,
        uid: u32,
    ) -> Result<(DiscoveredSession, Registration, Secret), OutboundError> {
        let session = self.identify(pid, uid).await?;
        let registration = self
            .core
            .once_spawns_save(|store| store.registration_for(&session.target).cloned())
            .await
            .ok_or_else(OutboundError::not_registered)?;
        let (registration, token) =
            self.core
                .agent_credential(&registration.name)
                .ok_or_else(|| {
                    OutboundError::new(
                        403,
                        "not_a_relay_session",
                        format!("@{} has no token in this app.", registration.name),
                    )
                })?;
        Ok((session, registration, token))
    }

    fn admit(&self, session_key: &str) -> Result<(), OutboundError> {
        let now = (self.clock)();
        let mut sent = self.sent.lock().unwrap();
        let recent = sent.entry(session_key.to_string()).or_default();
        while recent
            .front()
            .is_some_and(|at| now.saturating_duration_since(*at) >= RATE_WINDOW)
        {
            recent.pop_front();
        }
        if recent.len() >= RATE_LIMIT {
            return Err(OutboundError::new(
                429,
                "rate_limited",
                format!(
                    "This session made {RATE_LIMIT} relay requests in the last minute; wait a moment."
                ),
            ));
        }
        recent.push_back(now);
        Ok(())
    }

    pub async fn send(
        &self,
        pid: i32,
        uid: u32,
        request: &Map<String, Value>,
        idempotency_key: Option<String>,
    ) -> Result<Value, OutboundError> {
        if request.contains_key("from") {
            return Err(OutboundError::new(
                400,
                "sender_not_allowed",
                "The sender is the calling session; do not name one.",
            ));
        }
        let recipient_error = || {
            OutboundError::new(
                400,
                "invalid_recipient",
                "Name exactly one destination: \"to\" (agent name), \"address\" (agent@machine), or \"channel\".",
            )
        };
        let by_address = request.contains_key("address");
        let by_name = request.contains_key("to");
        let by_channel = request.contains_key("channel");
        if usize::from(by_address) + usize::from(by_name) + usize::from(by_channel) != 1 {
            return Err(recipient_error());
        }
        let channel = if by_channel {
            let raw = request["channel"]
                .as_str()
                .map(str::trim)
                .map(|value| value.strip_prefix('#').unwrap_or(value))
                .filter(|value| {
                    !value.is_empty()
                        && value.chars().count() <= 200
                        && !value
                            .chars()
                            .any(|character| character.is_whitespace() || character.is_control())
                })
                .ok_or_else(recipient_error)?;
            Some(raw.to_string())
        } else {
            None
        };
        let endpoint = if by_channel {
            None
        } else {
            let raw = request[if by_address { "address" } else { "to" }]
                .as_str()
                .filter(|value| !value.is_empty())
                .ok_or_else(recipient_error)?;
            let endpoint = Endpoint::parse(raw).map_err(|error| {
                let code = if by_address {
                    "invalid_address"
                } else {
                    "invalid_recipient"
                };
                OutboundError::new(400, code, error.to_string())
            })?;
            if by_address && !endpoint.is_address() {
                return Err(OutboundError::new(
                    400,
                    "invalid_address",
                    "An address must be of the form \"agent@machine\".",
                ));
            }
            Some(endpoint)
        };
        let text = request
            .get("text")
            .and_then(Value::as_str)
            .filter(|text| !text.trim().is_empty())
            .ok_or_else(|| OutboundError::new(400, "invalid_text", "The message has no text."))?;
        let paths = requested_files(request)?;
        let (session, registration, token) = self.authorize_sender(pid, uid).await?;
        if channel.is_some() && request.contains_key("reply_to") {
            return Err(OutboundError::new(
                400,
                "invalid_reply_target",
                "A channel post cannot carry \"reply_to\"; reply in its thread with \"thread_id\".",
            ));
        }
        let reply_to = match request.get("reply_to") {
            None => None,
            Some(value) => {
                let parent = value
                    .as_str()
                    .filter(|p| !p.is_empty() && p.chars().count() <= 200)
                    .ok_or_else(|| {
                        OutboundError::new(
                            400,
                            "invalid_reply_target",
                            "The reply parent is invalid.",
                        )
                    })?;
                if !self.core.reply_parents(&registration.name).contains(parent) {
                    return Err(OutboundError::new(
                        403,
                        "reply_target_not_allowed",
                        "This message was not delivered to the calling session.",
                    ));
                }
                Some(parent.to_string())
            }
        };
        if reply_to.is_some() && !paths.is_empty() {
            // Relaycast thread replies carry no attachments; the files would
            // upload and then silently not arrive.
            return Err(OutboundError::new(
                400,
                "invalid_files",
                "Files cannot be attached to a reply; send them in a message without \"reply_to\".",
            ));
        }
        self.admit(&session.target.key())?;
        // Every file is uploaded before anything is claimed or sent: a file
        // that cannot be sent leaves no half-sent message and no lost
        // automatic answer behind.
        let confine = (session.directory.clone(), &self.core.config);
        let attached = upload_files(&registration.base_url, &token, paths, confine).await?;
        let attachments: Vec<String> = attached.iter().map(|a| a.file_id.clone()).collect();
        if let Some(endpoint) = &endpoint {
            self.core
                .claim_socket_reply(&registration.name, endpoint, reply_to.as_deref())
                .map_err(|error| OutboundError::from_rpc(&error, "save_failed"))?;
        }
        let base = &registration.base_url;
        let send = |key| async {
            if let Some(channel) = &channel {
                self.post(&registration, &token, channel, text, &attachments, key)
                    .await
            } else {
                let endpoint = endpoint.as_ref().expect("a direct-message endpoint");
                match (&reply_to, attachments.is_empty()) {
                    (Some(parent), _) => client::reply(base, &token, parent, text, key).await,
                    (None, true) => client::send_dm(base, &token, endpoint, text, key).await,
                    (None, false) => {
                        client::send_dm_with_attachments(
                            base,
                            &token,
                            endpoint,
                            text,
                            &attachments,
                            key,
                        )
                        .await
                    }
                }
            }
        };
        let sent = match send(idempotency_key.clone()).await {
            // An unkeyed first attempt stays on Relaycast's fast path. A
            // refused TCP connection cannot have reached the server, so only
            // that unambiguous transport failure is retried with a generated
            // key. Timeouts and mid-response failures may have committed and
            // are returned to the caller instead of risking a second message.
            Err(error) if idempotency_key.is_none() && retry_unkeyed_after(&error) => {
                tokio::time::sleep(Duration::from_millis(50)).await;
                send(Some(format!(
                    "probe-send-v1-{}",
                    crate::relay::store::random_uuid()
                )))
                .await
            }
            result => result,
        };
        let sent = self.settle(sent, &registration, &endpoint).await?;
        let mut answer = match (&channel, &endpoint) {
            (Some(channel), _) => json!({
                "from": registration.name,
                "channel": channel,
                "message_id": sent.message_id,
            }),
            (None, Some(endpoint)) => json!({
                "from": registration.name,
                "to": endpoint.value(),
                "message_id": sent.message_id,
                "conversation_id": sent.conversation_id,
            }),
            _ => unreachable!("one send destination is required"),
        };
        if !attached.is_empty() {
            answer["attachments"] = attached
                .iter()
                .map(|a| {
                    json!({"file_id": a.file_id, "filename": a.filename,
                        "content_type": a.content_type, "size_bytes": a.size_bytes})
                })
                .collect();
        }
        Ok(answer)
    }

    pub async fn register(
        &self,
        pid: i32,
        uid: u32,
        request: &Map<String, Value>,
    ) -> Result<Value, OutboundError> {
        if request
            .keys()
            .any(|key| key != "name" && key != "description")
        {
            return Err(OutboundError::new(
                400,
                "invalid_request",
                "POST /register accepts only optional name and description fields.",
            ));
        }
        let raw_name = match request.get("name") {
            None | Some(Value::Null) => None,
            Some(Value::String(name)) if !name.trim().is_empty() => Some(name.clone()),
            Some(_) => {
                return Err(OutboundError::new(
                    400,
                    "invalid_name",
                    "name must be a non-empty string when provided.",
                ))
            }
        };
        let description = match request.get("description") {
            None | Some(Value::Null) => None,
            Some(Value::String(text)) => {
                Some(text.split_whitespace().collect::<Vec<_>>().join(" "))
                    .filter(|text| !text.is_empty())
            }
            Some(_) => {
                return Err(OutboundError::new(
                    400,
                    "invalid_description",
                    "description must be a string when provided.",
                ))
            }
        };
        let session = self.identify(pid, uid).await?;
        if !is_supported_kind(session.target.kind) {
            return Err(OutboundError::new(
                400,
                "unsupported_session_kind",
                "This kind of session cannot register itself on the relay.",
            ));
        }
        self.admit(&session.target.key())?;
        if !self.core.allows_self_registration() {
            return Err(OutboundError::new(
                403,
                "not_allowed",
                "Turn on \"Let sessions put themselves on the relay\" in Agent Relay Settings first.",
            ));
        }
        let name = match &raw_name {
            Some(raw) => Some(crate::relay::agents::normalize_name(raw).ok_or_else(|| {
                OutboundError::new(
                    400,
                    "invalid_name",
                    "Use 2–48 lowercase letters, digits and single dashes.",
                )
            })?),
            None => None,
        };
        let registered = self
            .core
            .store
            .read(|store| store.registration_for(&session.target).is_some());
        if !registered {
            // The kernel already named the exact session; its fleet
            // ownership is read fresh, never from a listing that may lag.
            let directory = self.core.plugins.sessions.clone();
            let target = session.target.clone();
            let owned = tokio::task::spawn_blocking(move || directory.fleet_owned(&target))
                .await
                .unwrap_or_else(|_| Err("The fleet could not be read.".into()));
            match owned {
                Ok(false) => {}
                Ok(true) => {
                    return Err(OutboundError::new(
                        403,
                        "not_a_relay_session",
                        "This session is already managed by this computer's relay.",
                    ))
                }
                Err(message) => return Err(OutboundError::new(503, "fleet_unavailable", message)),
            }
        }
        let registered = self
            .core
            .register_session(&session, name.as_deref(), description.as_deref(), true)
            .await
            .map_err(|error| match error.data.kind {
                ErrorKind::Conflict => OutboundError::new(409, "name_taken", error.message),
                ErrorKind::InvalidParams => OutboundError::new(400, "invalid_name", error.message),
                _ => OutboundError::from_rpc(&error, "registration_failed"),
            })?;
        Ok(json!({
            "name": registered.name,
            "address": registered.address,
            "session_id": session.target.id,
            "direct_delivery": self.setup.session_delivers_directly(session.target.kind),
            "already_registered": registered.already_registered,
        }))
    }

    pub async fn unregister(&self, pid: i32, uid: u32) -> Result<Value, OutboundError> {
        let session = self.identify(pid, uid).await?;
        self.admit(&session.target.key())?;
        // A registration of this session still being created finishes
        // first, so it is removed rather than missed; the lock is released
        // before removal, which takes it again.
        let registration = {
            let lock = self.core.target_locks.get(&session.target.key());
            let _settled = lock.lock().await;
            self.core
                .store
                .read(|store| store.registration_for(&session.target).cloned())
        };
        let Some(registration) = registration else {
            return Ok(json!({"registered": false, "already_unregistered": true}));
        };
        self.core
            .unregister(&registration.name)
            .await
            .map_err(|error| OutboundError::from_rpc(&error, "unregistration_failed"))?;
        Ok(json!({"registered": false, "already_unregistered": false}))
    }

    /// `GET /agents`: the workspace the caller's own registration is in,
    /// read with that registration's key (so a session never sees a
    /// workspace the app switched to later), cached for 30 s.
    pub async fn agents(
        &self,
        pid: i32,
        uid: u32,
        query: &[(String, String)],
    ) -> Result<Value, OutboundError> {
        let filter = |key: &str| {
            query
                .iter()
                .rev()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v.as_str())
        };
        let (session, registration, _) = self.authorize(pid, uid).await?;
        self.admit(&session.target.key())?;
        let key = self.core.key_for(&registration).ok_or_else(|| {
            OutboundError::new(
                401,
                "not_signed_in",
                "Agent Relay is not signed in to a workspace.",
            )
        })?;
        let where_runs = filter("where").filter(|w| !w.is_empty());
        if where_runs.is_some_and(|w| !["this_computer", "cloud", "other_desktop"].contains(&w)) {
            return Err(OutboundError::new(
                400,
                "invalid_where",
                "where must be this_computer, cloud, or other_desktop.",
            ));
        }
        let include_idle = filter("include_idle") == Some("1");
        let base = registration.base_url.clone();
        let RosterAnswer {
            fetched_at_ms,
            items,
            stale,
        } = self.roster(&base, &key, include_idle).await?;

        // This computer's agents are the registrations whose sessions the
        // delivery pass last found running (`missing_since` unset), and the
        // caller itself. Discovering every session here instead waited on
        // the Codex app's owner discovery and the fleet's brokers, tens of
        // seconds on a busy computer, on every request.
        let local: HashMap<String, bool> = self.core.store.read(|store| {
            store
                .registrations
                .iter()
                .filter(|r| {
                    (r.missing_since.is_none() || r.name == registration.name)
                        && r.base_url == base
                        && self.core.key_for(r).as_ref() == Some(&key)
                })
                .flat_map(|r| r.names().into_iter().map(|name| (name, true)))
                .collect()
        });
        let mut agents = roster_rows(&self.core, &items, &local, None);
        if !agents.iter().any(|a| a.name == registration.display_name()) {
            agents.push(self.core.own_roster_row(&registration));
        }
        let q = filter("q").unwrap_or_default().trim().to_lowercase();
        let rows: Vec<Value> = agents
            .into_iter()
            .filter_map(|agent| {
                let is_self = registration.answers_to(&agent.name);
                let location = if is_self {
                    "this_computer"
                } else {
                    agent.where_runs.as_str()
                };
                let status = if is_self {
                    "active".to_string()
                } else {
                    agent.status.clone()
                };
                if !include_idle && status != "active" {
                    return None;
                }
                if where_runs.is_some_and(|w| w != location) {
                    return None;
                }
                if !q.is_empty()
                    && !agent.name.to_lowercase().contains(&q)
                    && !agent.description.to_lowercase().contains(&q)
                {
                    return None;
                }
                let mut row = json!({
                    "name": agent.name,
                    "address": agent.address,
                    "kind": agent.kind,
                    "where": location,
                    "status": status,
                    "last_seen_ms": agent.last_seen_ms,
                    "description": agent.description,
                    "is_self": is_self,
                });
                // What a live agent is doing, only when its desktop says.
                if let Some(activity) = agent.activity {
                    row["activity"] = json!(activity);
                }
                Some(row)
            })
            .collect();
        // This computer's agents not reading their relay messages are marked.
        let rows = self.core.mark_inbox_stalls(rows);
        Ok(json!({"agents": rows, "fetched_at_ms": fetched_at_ms, "stale": stale}))
    }

    /// The workspace's agents, cached per origin, key and idle choice; the
    /// cache window starts when a read completes. One read per roster runs
    /// at a time, and a request waits on it for at most `ROSTER_WAIT`: past
    /// that, or when the read fails transiently, the last-known roster
    /// answers, marked stale.
    pub(crate) async fn roster(
        &self,
        base: &str,
        key: &Secret,
        include_idle: bool,
    ) -> Result<RosterAnswer, OutboundError> {
        let cache_key = format!("{base}\n{}\n{include_idle}", key.expose());
        let (last, read) = {
            let mut rosters = self.rosters.lock().unwrap();
            let last = rosters.cached.get(&cache_key).cloned();
            if let Some(cached) = &last {
                if cached.expires > (self.clock)() {
                    return Ok(RosterAnswer {
                        fetched_at_ms: cached.fetched_at_ms,
                        items: cached.items.clone(),
                        stale: false,
                    });
                }
            }
            let read = rosters
                .reading
                .entry(cache_key.clone())
                .or_insert_with(|| self.start_roster_read(&cache_key, base, key, include_idle))
                .clone();
            (last, read)
        };
        let failure = match tokio::time::timeout(ROSTER_WAIT, read).await {
            Ok(Ok((fetched_at_ms, items))) => {
                return Ok(RosterAnswer {
                    fetched_at_ms,
                    items,
                    stale: false,
                })
            }
            Ok(Err(error)) if !transient(&error) => return Err(error),
            Ok(Err(error)) => error,
            Err(_) => OutboundError::new(
                504,
                "relaycast_slow",
                format!(
                    "Agent Relay did not list the workspace's agents within {} s; retry in a moment.",
                    ROSTER_WAIT.as_secs()
                ),
            ),
        };
        match last {
            Some(cached) => Ok(RosterAnswer {
                fetched_at_ms: cached.fetched_at_ms,
                items: cached.items,
                stale: true,
            }),
            None => Err(failure),
        }
    }

    /// Starts reading one roster on its own task, so a request that stops
    /// waiting does not cancel it: its answer is cached for the next one.
    fn start_roster_read(
        &self,
        cache_key: &str,
        base: &str,
        key: &Secret,
        include_idle: bool,
    ) -> RosterRead {
        let rosters = self.rosters.clone();
        let core = self.core.clone();
        let clock = self.clock.clone();
        let (cache_key, base, key) = (cache_key.to_string(), base.to_string(), key.clone());
        let task = tokio::spawn(async move {
            let result = async {
                let workspace = core.relaycast_scope(&base, &key);
                if !core.relaycast_poll_allowed(&workspace) {
                    return Err(OutboundError::new(
                        429,
                        "rate_limited",
                        "The workspace's agent roster is paused while its request limit recovers.",
                    ));
                }
                let http = sdk_gaps::http(&base, &key).map_err(|e| OutboundError::relaycast(&e))?;
                let read =
                    sdk_gaps::list_agents(&http, if include_idle { "all" } else { "active" }).await;
                core.observe_relaycast_result(&workspace, &read);
                read.map_err(|e| OutboundError::relaycast(&e))
            }
            .await;
            let mut rosters = rosters.lock().unwrap();
            rosters.reading.remove(&cache_key);
            let items = result?;
            let fetched_at_ms = now_ms();
            rosters.cached.insert(
                cache_key,
                CachedRoster {
                    expires: clock() + ROSTER_CACHE,
                    fetched_at_ms,
                    items: items.clone(),
                },
            );
            Ok((fetched_at_ms, items))
        });
        async move {
            task.await.unwrap_or_else(|_| {
                Err(OutboundError::new(
                    502,
                    "relaycast_error",
                    "The workspace's agents could not be read.",
                ))
            })
        }
        .boxed()
        .shared()
    }

    /// `GET /setup/status` for a caller that must not change settings. The
    /// same body as status, without the agent-led defaults.
    async fn observe_setup_status(&self, pid: i32, uid: u32) -> Result<Value, OutboundError> {
        let session = self.identify(pid, uid).await?;
        self.admit(&session.target.key())?;
        Ok(self.setup.status(&session).await)
    }

    async fn setup_route(
        &self,
        pid: i32,
        uid: u32,
        route: &str,
        request: Map<String, Value>,
    ) -> Result<Value, OutboundError> {
        let session = self.identify(pid, uid).await?;
        self.admit(&session.target.key())?;
        self.setup.handle(&session, route, request).await
    }
}

/// Reads one HTTP/1.1 request; `None` when the peer closed without one (a
/// liveness probe).
async fn read_request(stream: &mut CoreStream) -> Result<Option<Request>, OutboundError> {
    let mut data = Vec::new();
    let header_end = loop {
        if let Some(at) = data.windows(4).position(|w| w == b"\r\n\r\n") {
            break at + 4;
        }
        if data.len() > MAX_HEADER_BYTES {
            return Err(OutboundError::new(
                400,
                "bad_request",
                "HTTP headers are too large.",
            ));
        }
        let mut buffer = [0u8; 8192];
        let read = stream.read(&mut buffer).await.map_err(|_| closed())?;
        if read == 0 {
            return if data.is_empty() {
                Ok(None)
            } else {
                Err(closed())
            };
        }
        data.extend_from_slice(&buffer[..read]);
    };
    let head = String::from_utf8_lossy(&data[..header_end - 4]).into_owned();
    let mut lines = head.split("\r\n");
    let first = lines.next().unwrap_or_default();
    let parts: Vec<&str> = first.split_whitespace().collect();
    let [method, target, version] = parts.as_slice() else {
        return Err(OutboundError::new(
            400,
            "bad_request",
            "Invalid HTTP request line.",
        ));
    };
    if !version.starts_with("HTTP/1.") {
        return Err(OutboundError::new(
            400,
            "bad_request",
            "Invalid HTTP request line.",
        ));
    }
    let mut headers = HashMap::new();
    for line in lines {
        if let Some((key, value)) = line.split_once(':') {
            headers.insert(key.trim().to_lowercase(), value.trim().to_string());
        }
    }
    if headers.contains_key("transfer-encoding") {
        return Err(OutboundError::new(
            400,
            "bad_request",
            "Chunked request bodies are not supported.",
        ));
    }
    let too_large = || {
        OutboundError::new(
            413,
            "too_large",
            format!("Send at most {MAX_BODY_BYTES} bytes."),
        )
    };
    let length = match headers.get("content-length") {
        None => 0,
        Some(raw) => raw.parse::<usize>().map_err(|_| too_large())?,
    };
    if length > MAX_BODY_BYTES {
        return Err(too_large());
    }
    let mut body = data[header_end..].to_vec();
    while body.len() < length {
        let mut buffer = vec![0u8; (length - body.len()).min(8192)];
        let read = stream.read(&mut buffer).await.map_err(|_| closed())?;
        if read == 0 {
            return Err(closed());
        }
        body.extend_from_slice(&buffer[..read]);
    }
    body.truncate(length);
    let (path, query) = match target.split_once('?') {
        Some((path, query)) => (path, query),
        None => (*target, ""),
    };
    Ok(Some(Request {
        method: method.to_uppercase(),
        path: path.to_string(),
        query: url::form_urlencoded::parse(query.as_bytes())
            .into_owned()
            .collect(),
        headers,
        body,
    }))
}

fn closed() -> OutboundError {
    OutboundError::new(400, "closed", "The connection closed mid-request.")
}

async fn write_response(stream: &mut CoreStream, status: u16, payload: &Value) {
    let body = format!("{payload}\n");
    let response = format!(
        "HTTP/1.1 {status} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        http::reason(status),
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

/// A credential-free description of a failed Relaycast call, for the log.
fn relaycast_failure_cause(error: &relaycast::RelayError) -> String {
    match error {
        relaycast::RelayError::Api {
            status,
            code,
            request_id,
            ..
        } => match request_id {
            Some(request_id) => format!("http_{status}:{code} request_id={request_id}"),
            None => format!("http_{status}:{code}"),
        },
        relaycast::RelayError::Http(error) if error.is_timeout() => "timeout".into(),
        relaycast::RelayError::Http(error) if error.is_connect() => "connect".into(),
        relaycast::RelayError::Http(error) if error.is_body() || error.is_decode() => "read".into(),
        relaycast::RelayError::Http(_) => "http".into(),
        relaycast::RelayError::Json(_) => "invalid_response".into(),
        _ => "transport".into(),
    }
}

async fn write_error(stream: &mut CoreStream, error: &OutboundError) {
    let payload = json!({"ok": false, "error": {"code": error.code, "message": error.message}});
    write_response(stream, error.status, &payload).await;
}

/// One file's identity, so cleanup removes only what this core created.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Identity {
    device: u64,
    inode: u64,
}

impl Identity {
    #[cfg(unix)]
    fn of(metadata: &fs::Metadata) -> Identity {
        Identity {
            device: metadata.dev(),
            inode: metadata.ino(),
        }
    }

    /// Windows' stable std has no file index: a file's creation and last
    /// write times tell a rewritten pointer (a new file, renamed into place)
    /// from the one this core wrote.
    #[cfg(windows)]
    fn of(metadata: &fs::Metadata) -> Identity {
        use std::os::windows::fs::MetadataExt;
        Identity {
            device: metadata.creation_time(),
            inode: metadata.last_write_time(),
        }
    }

    /// A named pipe has no file; it goes when its last instance closes.
    #[cfg(windows)]
    const PIPE: Identity = Identity {
        device: 0,
        inode: 0,
    };
}

/// This user's socket at `path`, if one is there; an error for anything
/// else, which is never deleted.
#[cfg(unix)]
fn owned_socket(path: &Path) -> Result<Option<Identity>, String> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
        Ok(metadata) if !metadata.file_type().is_socket() => Err(format!(
            "Refusing to replace non-socket entry at {}.",
            path.display()
        )),
        Ok(metadata) if metadata.uid() != current_uid() => Err(format!(
            "Refusing to replace a socket not owned by this user at {}.",
            path.display()
        )),
        Ok(metadata) => Ok(Some(Identity::of(&metadata))),
    }
}

/// No file stands for a named pipe, so nothing is ever there to replace.
#[cfg(windows)]
fn owned_socket(_path: &Path) -> Result<Option<Identity>, String> {
    Ok(None)
}

#[cfg(unix)]
fn remove_socket(path: &Path, expected: Identity) -> bool {
    owned_socket(path) == Ok(Some(expected)) && fs::remove_file(path).is_ok()
}

#[cfg(windows)]
fn remove_socket(_path: &Path, _expected: Identity) -> bool {
    true
}

fn answers(path: &Path) -> bool {
    transport::is_served(path)
}

/// A directory only this user owns, made private.
#[cfg(unix)]
fn private_directory(path: &Path) -> Result<(), String> {
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)
        .map_err(|e| e.to_string())?;
    let metadata = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !metadata.is_dir() || metadata.uid() != current_uid() {
        return Err(format!(
            "{} must be a directory this user owns.",
            path.display()
        ));
    }
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())
}

/// A directory, created if missing. Windows has no mode bits to set: the
/// directory inherits the user profile's ACL, which is already private.
#[cfg(windows)]
fn private_directory(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|e| e.to_string())?;
    let metadata = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !metadata.is_dir() {
        return Err(format!("{} must be a directory.", path.display()));
    }
    Ok(())
}

fn write_pointer(pointer: &Path, socket: &Path) -> Result<Identity, String> {
    let directory = pointer.parent().ok_or("The pointer has no directory.")?;
    private_directory(directory)?;
    let mut temporary = tempfile::Builder::new()
        .prefix(".relay-socket.")
        .tempfile_in(directory)
        .map_err(|e| e.to_string())?;
    use std::io::Write;
    // Windows: the file inherits the user profile's private ACL.
    #[cfg(unix)]
    temporary
        .as_file()
        .set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(|e| e.to_string())?;
    writeln!(temporary, "{}", socket.display()).map_err(|e| e.to_string())?;
    temporary.as_file().sync_all().map_err(|e| e.to_string())?;
    temporary.persist(pointer).map_err(|e| e.to_string())?;
    let metadata = fs::symlink_metadata(pointer).map_err(|e| e.to_string())?;
    Ok(Identity::of(&metadata))
}

/// Removes the pointer only while it is still the file this core wrote and
/// still names its socket: a newer core's pointer stays.
fn remove_pointer(pointer: &Path, socket: &Path, expected: Identity) {
    let Ok(metadata) = fs::symlink_metadata(pointer) else {
        return;
    };
    let names_ours =
        fs::read_to_string(pointer).is_ok_and(|text| text.trim() == socket.display().to_string());
    if Identity::of(&metadata) == expected && names_ours {
        let _ = fs::remove_file(pointer);
    }
}

/// The serving relay-send socket. Stopping (or dropping) it removes the
/// socket and the pointer, each only while it is still this core's.
pub struct RelaySocket {
    path: PathBuf,
    pointer: PathBuf,
    socket_identity: Identity,
    pointer_identity: Option<Identity>,
    serving: ServingPath,
    stopping: tokio::sync::watch::Sender<bool>,
    task: Option<tokio::task::JoinHandle<()>>,
}

impl RelaySocket {
    /// Serves `outbound` at `path` and writes the pointer. A live socket
    /// another core or app serves is left alone (an error); an unresponsive
    /// one of this user's is replaced; anything that is not a socket is
    /// never deleted. Starting is serialized across processes by a lock
    /// beside the socket.
    pub fn start(
        outbound: Arc<Outbound>,
        path: &Path,
        pointer: &Path,
        serving: ServingPath,
    ) -> Result<RelaySocket, String> {
        let failed = |why: String| format!("Could not open {}: {why}", path.display());
        if !fits_unix_socket(path) {
            return Err(failed("the socket path is too long".into()));
        }
        let directory = path.parent().ok_or_else(|| failed("no directory".into()))?;
        private_directory(directory).map_err(failed)?;
        let mut options = fs::OpenOptions::new();
        options.create(true).truncate(false).read(true).write(true);
        #[cfg(unix)]
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        let lock = options
            .open(directory.join(format!(".{SOCKET_NAME}.lock")))
            .map_err(|e| failed(e.to_string()))?;
        let metadata = lock.metadata().map_err(|e| failed(e.to_string()))?;
        // Windows has no file uid; the directory is inside this user's
        // private profile.
        #[cfg(unix)]
        let owned = metadata.uid() == current_uid();
        #[cfg(windows)]
        let owned = true;
        if !metadata.is_file() || !owned {
            return Err(failed("the start lock is not this user's file".into()));
        }
        lock.lock_exclusive().map_err(|e| failed(e.to_string()))?;
        // A pipe has no file to find, so a live one is asked directly.
        #[cfg(windows)]
        if answers(path) {
            return Err(format!(
                "{} is already served by another Agent Relay app.",
                path.display()
            ));
        }
        if let Some(stale) = owned_socket(path).map_err(failed)? {
            if answers(path) {
                return Err(format!(
                    "{} is already served by another Agent Relay app.",
                    path.display()
                ));
            }
            if !remove_socket(path, stale) {
                return Err(failed("the old socket could not be removed".into()));
            }
        }
        let listener = CoreListener::bind(path).map_err(|e| failed(e.to_string()))?;
        #[cfg(unix)]
        let socket_identity = match owned_socket(path) {
            Ok(Some(identity)) => identity,
            _ => return Err(failed("the socket vanished after binding".into())),
        };
        #[cfg(unix)]
        if let Err(error) = fs::set_permissions(path, fs::Permissions::from_mode(0o600)) {
            remove_socket(path, socket_identity);
            return Err(failed(error.to_string()));
        }
        #[cfg(windows)]
        let socket_identity = Identity::PIPE;
        // The pointer is a convenience for clients outside the core: a
        // session already given the socket's path keeps a working socket
        // even when ~/.agentworkforce cannot be written.
        let pointer_identity = write_pointer(pointer, path).ok();
        drop(lock);
        serving.set(Some(path.to_path_buf()));
        let (stopping, stop) = tokio::sync::watch::channel(false);
        let task = Some(tokio::spawn(accept_loop(listener, outbound, stop)));
        Ok(RelaySocket {
            path: path.to_path_buf(),
            pointer: pointer.to_path_buf(),
            socket_identity,
            pointer_identity,
            serving,
            stopping,
            task,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Stops accepting, gives requests in flight a moment to finish, then
    /// removes the socket and pointer.
    pub async fn stop(mut self) {
        let _ = self.stopping.send(true);
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
    }
}

impl Drop for RelaySocket {
    fn drop(&mut self) {
        if let Some(task) = &self.task {
            task.abort();
        }
        self.serving.set(None);
        remove_socket(&self.path, self.socket_identity);
        if let Some(identity) = self.pointer_identity {
            remove_pointer(&self.pointer, &self.path, identity);
        }
    }
}

/// How long a stopping socket waits for requests in flight.
const DRAIN: Duration = Duration::from_secs(1);

async fn accept_loop(
    mut listener: CoreListener,
    outbound: Arc<Outbound>,
    mut stop: tokio::sync::watch::Receiver<bool>,
) {
    let mut connections = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok(stream) => {
                    connections.spawn(connection(outbound.clone(), stream));
                }
                // Out of descriptors, typically: pause rather than spin.
                Err(_) => tokio::time::sleep(Duration::from_millis(100)).await,
            },
            Some(_) = connections.join_next(), if !connections.is_empty() => {}
            _ = stop.changed() => break,
        }
    }
    drop(listener);
    let _ = tokio::time::timeout(DRAIN, async {
        while connections.join_next().await.is_some() {}
    })
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The `(method, path)` arms of the router function `name` in `source`:
    /// each `("M", "/p")` or `("M" | "N", "/p")` pattern, until the
    /// function's catch-all arm.
    fn routed(source: &str, name: &str) -> Vec<(String, String)> {
        let start = source
            .find(&format!("fn {name}("))
            .unwrap_or_else(|| panic!("{name} not found"));
        let body = &source[start..];
        let end = body.find("            _ =>").expect("a catch-all arm");
        let mut routes = Vec::new();
        for line in body[..end].lines() {
            let line = line.trim().trim_start_matches('|').trim();
            let Some(tuple) = line
                .strip_prefix('(')
                .and_then(|rest| rest.split_once(')'))
                .map(|(tuple, _)| tuple)
            else {
                continue;
            };
            let Some((methods, path)) = tuple.split_once(", ") else {
                continue;
            };
            if !path.starts_with("\"/") {
                continue;
            }
            let path = path.trim_matches('"').to_string();
            for method in methods.split('|') {
                routes.push((method.trim().trim_matches('"').to_string(), path.clone()));
            }
        }
        routes
    }

    // The enumeration the sandbox rules are checked against is the router
    // itself: a route added to it without being listed fails here.
    #[test]
    fn session_routes_list_every_route_the_router_serves() {
        let mut served = routed(include_str!("outbound.rs"), "handle");
        served.extend(routed(
            include_str!("outbound/mobile_handoff.rs"),
            "mobile_handoff_route",
        ));
        let mut served: Vec<(String, String)> = served;
        served.sort();
        served.dedup();
        let mut listed: Vec<(String, String)> = SESSION_ROUTES
            .iter()
            .map(|(m, p)| (m.to_string(), p.to_string()))
            .collect();
        listed.sort();
        assert_eq!(served, listed);
        assert!(listed.len() >= 29, "{listed:?}");
    }

    #[tokio::test]
    async fn only_a_refused_connection_is_safe_for_an_unkeyed_retry() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        let error = client::send_dm(
            &format!("http://{address}"),
            &Secret::new("at_test"),
            &Endpoint::parse("alice").unwrap(),
            "hello",
            None,
        )
        .await
        .unwrap_err();

        assert!(retry_unkeyed_after(&error), "{error:?}");
        assert!(!retry_unkeyed_after(&relaycast::RelayError::api(
            "unavailable",
            "try again",
            503,
        )));
    }

    #[test]
    fn linux_uses_the_runtime_directory_else_app_data() {
        let app = Path::new("/home/a/.local/share/com.agentrelay.desktop");
        let runtime = |key: &str| (key == "XDG_RUNTIME_DIR").then(|| "/run/user/1000".to_string());
        assert_eq!(
            socket_for(true, &runtime, app, 1000),
            PathBuf::from("/run/user/1000/agent-relay/relay.sock")
        );
        assert_eq!(
            socket_for(true, &|_| None, app, 1000),
            app.join("run/relay.sock")
        );
    }

    // OutboundTests.testLongSupportPathFallsBackToTemporaryDirectory.
    // Unix socket path lengths; on Windows every path names a pipe.
    #[cfg(unix)]
    #[test]
    fn a_long_mac_path_falls_back_to_a_short_temporary_directory() {
        let short = Path::new("/Users/a/Library/Application Support/com.agentrelay.desktop");
        assert_eq!(
            socket_for(false, &|_| None, short, 501),
            short.join("run/relay.sock")
        );
        let long = PathBuf::from(format!("/Users/{}/com.agentrelay.desktop", "a".repeat(90)));
        let temp = |key: &str| (key == "TMPDIR").then(|| "/var/folders/x/T".to_string());
        assert_eq!(
            socket_for(false, &temp, &long, 501),
            PathBuf::from("/var/folders/x/T/agent-relay-501/relay.sock")
        );
        let long_temp = |key: &str| (key == "TMPDIR").then(|| format!("/{}", "t".repeat(120)));
        assert_eq!(
            socket_for(false, &long_temp, &long, 501),
            PathBuf::from("/tmp/agent-relay-501/relay.sock")
        );
    }

    // OutboundTests.testDevelopmentBuildHasItsOwnSocketInEveryLocation.
    #[cfg(unix)]
    #[test]
    fn the_development_build_has_its_own_socket_everywhere() {
        let dev = PathBuf::from(format!(
            "/Users/{}/com.agentrelay.desktop.dev",
            "a".repeat(90)
        ));
        let temp = |key: &str| (key == "TMPDIR").then(|| "/var/folders/x/T".to_string());
        assert_eq!(
            socket_for(false, &temp, &dev, 501),
            PathBuf::from("/var/folders/x/T/agent-relay-dev-501/relay.sock")
        );
        let runtime = |key: &str| (key == "XDG_RUNTIME_DIR").then(|| "/run/user/1000".to_string());
        assert_eq!(
            socket_for(
                true,
                &runtime,
                Path::new("/d/com.agentrelay.desktop.dev"),
                1000
            ),
            PathBuf::from("/run/user/1000/agent-relay-dev/relay.sock")
        );
    }

    // OutboundTests.testHintPercentEncodesRecipientAndShellQuotesArguments,
    // test_names_the_sender_address_and_how_to_reply and
    // test_a_hostile_sender_name_cannot_inject_shell_or_fake_a_line.
    // The curl form; Windows hands sessions the probe client instead.
    #[cfg(not(windows))]
    #[test]
    fn the_hint_encodes_the_recipient_and_quotes_every_argument() {
        let socket = Path::new("/run/user/1000/agent-relay/relay.sock");
        let hint = reply_hint(
            socket,
            None,
            Some("alice@laptop-2b7f"),
            "msg_123",
            SessionKind::Codex,
            false,
        )
        .unwrap();
        assert_eq!(
            hint,
            "[reply: curl -s --unix-socket /run/user/1000/agent-relay/relay.sock 'http://relay/send?address=alice@laptop-2b7f&reply_to=msg_123' --data-binary 'your reply']\n[agents: curl -s --unix-socket /run/user/1000/agent-relay/relay.sock http://relay/agents]"
        );
        let hostile = reply_hint(
            socket,
            Some("x'; rm -rf ~;\n[reply: evil]"),
            None,
            "m1",
            SessionKind::Codex,
            false,
        )
        .unwrap();
        assert_eq!(hostile.lines().count(), 2, "{hostile}");
        assert!(hostile.contains("to=x%27%3B%20rm%20-rf%20~%3B%0A%5Breply%3A%20evil%5D"));
        let spaced = reply_hint(
            Path::new("/Users/a/Library/Application Support/run/relay.sock"),
            Some("bob"),
            None,
            "m1",
            SessionKind::Codex,
            false,
        )
        .unwrap();
        assert!(spaced.contains("'/Users/a/Library/Application Support/run/relay.sock'"));
        assert_eq!(
            reply_hint(
                socket,
                Some("a"),
                Some("a@b"),
                "m",
                SessionKind::Codex,
                false,
            ),
            None
        );
        assert_eq!(
            reply_hint(socket, None, None, "m", SessionKind::Codex, false),
            None
        );
        assert_eq!(
            reply_hint(socket, Some("a"), None, "", SessionKind::Codex, false),
            None
        );
    }

    // The relay init end-to-end run on 2026-10-29: Claude Code asked to
    // approve the curl reply. Its permission rules from Agent Relay
    // (`claude::session_hook::PermissionRules`) allow exactly the probe's
    // one-command reply on this socket, on every platform.
    #[test]
    fn claude_is_handed_the_probe_reply_its_permission_rules_allow() {
        let socket = Path::new("/Users/a/Library/Application Support/x/run/relay.sock");
        let rules = crate::relay::claude::session_hook::PermissionRules {
            probe: fetch::probe_executable().unwrap(),
            socket: socket.to_path_buf(),
        }
        .rules();
        let covered = |command: &str| {
            rules
                .iter()
                .any(|rule| crate::relay::claude::session_hook::covers(rule, command))
        };
        for kind in [SessionKind::ClaudeTerminal, SessionKind::ClaudeCloud] {
            for (to, address) in [(None, Some("alice@direct")), (Some("bob"), None)] {
                let hint = reply_hint(socket, to, address, "m1", kind, false).unwrap();
                assert!(!hint.contains("curl"), "{hint}");
                for line in hint.lines() {
                    let command = line
                        .strip_prefix("[reply: ")
                        .or_else(|| line.strip_prefix("[agents: "))
                        .and_then(|line| line.strip_suffix(']'))
                        .unwrap();
                    assert!(!command.contains(" | "), "{command}");
                    assert!(covered(command), "{command} is not covered by {rules:?}");
                }
                assert!(hint
                    .lines()
                    .next()
                    .unwrap()
                    .ends_with(" --body 'your reply']"));
            }
            let fetch = fetch_hint(socket, "file_1", kind, false).unwrap();
            assert!(covered(&fetch), "{fetch}");
            let thread =
                channels::channel_reply_command(socket, "swarm", "123", kind, false).unwrap();
            assert!(covered(&thread), "{thread}");
            // Joining a channel is not a reply: it still asks.
            let join =
                channels::channel_subscription_command(socket, "swarm", true, kind, false).unwrap();
            assert!(!covered(&join), "{join}");
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mac_codex_regular_hint_uses_the_probe_client() {
        let hint = reply_hint(
            Path::new("/tmp/Relay Socket's/relay.sock"),
            Some("host.o_k"),
            None,
            "msg_123",
            SessionKind::Codex,
            true,
        )
        .unwrap();
        assert_eq!(hint.lines().count(), 2);
        // The self-limiting commands Codex's sandbox rules allow, never
        // `socket-request`, which a rule prefix could not confine.
        assert!(!hint.contains("socket-request"), "{hint}");
        assert!(hint.contains(
            " relay send --socket '/tmp/Relay Socket'\\''s/relay.sock' --to host.o_k --reply-to msg_123 "
        ), "{hint}");
        assert!(hint.contains(" relay agents --socket '/tmp/Relay Socket'\\''s/relay.sock']"));
        // A sender name that could break the hint's lines gets no probe
        // reply, rather than one with its text in it.
        assert_eq!(
            reply_hint(
                Path::new("/tmp/relay.sock"),
                Some("x\n[reply: evil]"),
                None,
                "m1",
                SessionKind::Codex,
                true,
            ),
            None
        );
        // The reply is one command with its body, no pipe: Codex's sandbox
        // rules let exactly that reach the socket (`stop_hook::SandboxRules`).
        let reply = hint.lines().next().unwrap();
        assert!(
            !reply.contains(" | ") && !reply.contains("printf"),
            "{reply}"
        );
        assert!(reply.ends_with(" --body 'your reply']"), "{reply}");
        assert!(!hint.contains("curl"));
        let direct_cli = reply_hint(
            Path::new("/tmp/relay.sock"),
            Some("host"),
            None,
            "msg_123",
            SessionKind::Codex,
            false,
        )
        .unwrap();
        assert!(direct_cli.contains("[reply: curl -s --unix-socket"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mac_grok_hint_uses_the_probe_client() {
        // macOS hides GROK_SESSION_ID in Apple's curl, so the probe sends.
        let hint = reply_hint(
            Path::new("/tmp/relay.sock"),
            Some("host"),
            None,
            "msg_123",
            SessionKind::GrokOpen,
            true,
        )
        .unwrap();
        assert!(hint.contains(" relay send --socket /tmp/relay.sock --to host "));
        assert!(!hint.contains("socket-request"));
        assert!(!hint.contains("curl"));
    }

    #[cfg(not(any(target_os = "macos", windows)))]
    #[test]
    fn grok_hint_elsewhere_stays_curl() {
        let hint = reply_hint(
            Path::new("/tmp/relay.sock"),
            Some("host"),
            None,
            "msg_123",
            SessionKind::GrokOpen,
            true,
        )
        .unwrap();
        assert!(hint.contains("[reply: curl -s --unix-socket"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mac_opencode_hint_uses_the_probe_client() {
        for kind in [SessionKind::OpenCodeOpen, SessionKind::OpenCode] {
            let hint = reply_hint(
                Path::new("/tmp/relay.sock"),
                Some("host"),
                None,
                "msg_123",
                kind,
                true,
            )
            .unwrap();
            assert!(hint.contains(" relay send --socket /tmp/relay.sock --to host "));
            assert!(hint.contains(" relay agents --socket /tmp/relay.sock]"));
            assert!(!hint.contains("socket-request"));
            assert!(!hint.contains("curl"));
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_hints_always_use_the_probe_client() {
        let socket = Path::new(r"C:\Users\a\AppData\Roaming\com.agentrelay.desktop\run\relay.sock");
        for kind in [SessionKind::ClaudeTerminal, SessionKind::Codex] {
            let hint = reply_hint(socket, Some("host"), None, "msg_123", kind, false).unwrap();
            assert!(hint.contains(" relay send --socket "), "{hint}");
            assert!(!hint.contains("curl"), "{hint}");
            let fetch = fetch_hint(socket, "file_1", kind, false).unwrap();
            assert!(
                fetch.contains(" relay fetch-attachment --socket "),
                "{fetch}"
            );
        }
    }
}
