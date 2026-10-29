//! Native delivery to an already-running authenticated OpenCode server.
//!
//! This module deliberately does not discover a TUI by title or inject
//! keystrokes. A binding names one kernel process (PID + start time + UID),
//! one loopback listener, one session, and the session's immutable workspace
//! identity. The process must still be that exact `opencode serve` process and
//! its Basic-auth password is read from that process's environment only after
//! the binding is verified.
//!
//! OpenCode's `prompt_async` response is only an acceptance response. Delivery
//! is complete when the session transcript holds the exact user message, under
//! the deterministic message ID and text sent here; the receipt is
//! `opencode:<that id>`. The turn it starts may run as long as it needs: the
//! answer is read back separately, as the assistant message whose `parentID`
//! is that ID. A durable pending/accepted record prevents a crash, timeout,
//! cancellation, or lost response from becoming a blind resend.
//!
//! The same route also reaches a plain OpenCode TUI through Agent Relay's
//! OpenCode plugin (`relay::opencode`). Such a binding's endpoint is
//! `unix:<runtime>/<pid>.sock`: the process is proven the same way, the
//! socket must sit in a private directory with the exact pinned inode, and
//! every connection checks that the kernel's peer is the bound pid and this
//! user. The plugin needs no password, since only this user can reach it.

mod answers;
mod metadata;
mod native;
pub use metadata::{inspect_session, inspect_session_metadata, SessionMetadata};

use crate::relay::existing_session;
use crate::relay::existing_session::platform::{self, DirBuilderExt, MetadataExt, OpenOptionsExt};
use crate::relay::process::ProcessTable;
use crate::relay::store::random_hex;
use crate::relay::workspace::Secret;
use base64::Engine;
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use url::Url;

const MAX_BODY: usize = 2_000_000;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Binding {
    pub relay_workspace_id: String,
    pub owner_id: String,
    pub session_id: String,
    pub endpoint: String,
    pub server_pid: i32,
    pub server_start: u64,
    pub server_uid: u32,
    pub executable: PathBuf,
    pub directory: PathBuf,
    pub project_id: String,
    pub opencode_workspace_id: Option<String>,
    /// An opaque probe-owned marker. The Basic-auth password is never stored.
    pub credential_reference: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failure {
    InvalidBinding,
    StaleServer,
    AuthenticationUnavailable,
    AuthenticationRefused,
    SessionMismatch,
    SessionBusy,
    EndpointUnavailable,
    ProviderRefused,
    TimedOut,
    CancelledBeforeSend,
    CancelledAfterAcceptance,
    PriorAttemptUncertain,
    JournalUnavailable,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    Completed { receipt_id: String },
    Waiting(Failure),
    InDoubt(Failure),
    Refused(Failure),
}

pub struct Request<'a> {
    pub binding: &'a Binding,
    pub relay_workspace_id: &'a str,
    pub delivery_id: &'a str,
    pub message_id: &'a str,
    pub text: &'a str,
    pub timeout: Duration,
    pub cancelled: &'a AtomicBool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HttpResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

pub trait HttpTransport: Send + Sync {
    /// `None` means that no complete HTTP response was observed.
    fn request(
        &self,
        method: &str,
        url: &str,
        authorization: &str,
        directory: &Path,
        body: Option<&[u8]>,
        timeout: Duration,
    ) -> Option<HttpResponse>;
}

pub struct SystemHttp;

impl HttpTransport for SystemHttp {
    fn request(
        &self,
        method: &str,
        url: &str,
        authorization: &str,
        directory: &Path,
        body: Option<&[u8]>,
        timeout: Duration,
    ) -> Option<HttpResponse> {
        if let Some(rest) = url.strip_prefix("unix:") {
            return unix_request(method, rest, body, timeout);
        }
        let agent = ureq::AgentBuilder::new()
            .redirects(0)
            .try_proxy_from_env(false)
            .timeout(timeout)
            .timeout_connect(timeout)
            .timeout_read(timeout)
            .timeout_write(timeout)
            .build();
        let request = agent
            .request(method, url)
            .set("Authorization", authorization)
            .set("Accept", "application/json")
            .set("X-OpenCode-Directory", &directory.to_string_lossy());
        let result = match body {
            Some(body) => request
                .set("Content-Type", "application/json")
                .send_bytes(body),
            None => request.call(),
        };
        let response = match result {
            Ok(response) => response,
            Err(ureq::Error::Status(_, response)) => response,
            Err(ureq::Error::Transport(_)) => return None,
        };
        let status = response.status();
        let mut bytes = Vec::new();
        response
            .into_reader()
            .take((MAX_BODY + 1) as u64)
            .read_to_end(&mut bytes)
            .ok()?;
        (bytes.len() <= MAX_BODY).then_some(HttpResponse {
            status,
            body: bytes,
        })
    }
}

pub trait Clock: Send + Sync {
    fn now(&self) -> Instant;
    fn sleep(&self, duration: Duration);
}

pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> Instant {
        Instant::now()
    }

    fn sleep(&self, duration: Duration) {
        std::thread::sleep(duration);
    }
}

#[derive(Debug)]
struct Credentials {
    username: String,
    password: Secret,
}

fn printable(value: &str, max: usize) -> bool {
    (1..=max).contains(&value.len()) && value.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
}

fn normalized(path: &Path) -> Option<PathBuf> {
    if !path.is_absolute() {
        return None;
    }
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::RootDir => result.push(Path::new("/")),
            Component::CurDir => {}
            Component::Normal(part) => result.push(part),
            Component::ParentDir | Component::Prefix(_) => return None,
        }
    }
    Some(result)
}

fn exact_process_credentials(
    table: &dyn ProcessTable,
    binding: &Binding,
) -> Result<Credentials, Failure> {
    let process = table
        .process(binding.server_pid)
        .filter(|process| {
            process.uid == binding.server_uid && process.start == binding.server_start
        })
        .ok_or(Failure::StaleServer)?;
    if process.uid != crate::relay::peer::current_uid() {
        return Err(Failure::StaleServer);
    }
    let executable = table
        .executable(binding.server_pid)
        .and_then(|path| fs::canonicalize(path).ok());
    let expected = fs::canonicalize(&binding.executable).ok();
    let trusted = expected.as_ref().is_some_and(|path| {
        fs::metadata(path).is_ok_and(|metadata| {
            (metadata.uid() == 0 || metadata.uid() == binding.server_uid)
                && metadata.mode() & 0o022 == 0
        })
    });
    if executable != expected || !trusted {
        return Err(Failure::StaleServer);
    }
    let arguments = table.arguments(binding.server_pid);
    let serves = arguments.iter().any(|value| value == "serve")
        && arguments.iter().any(|value| value.contains("opencode"));
    if !serves {
        return Err(Failure::StaleServer);
    }
    let endpoint = Url::parse(&binding.endpoint).map_err(|_| Failure::InvalidBinding)?;
    let host = endpoint.host_str().ok_or(Failure::InvalidBinding)?;
    if endpoint.scheme() != "http"
        || endpoint.username() != ""
        || endpoint.password().is_some()
        || endpoint.query().is_some()
        || endpoint.fragment().is_some()
        || endpoint.path() != "/"
        // A hostname can be rebound through local resolver configuration;
        // require a literal loopback address for this credentialed route.
        || !matches!(host, "127.0.0.1" | "::1")
    {
        return Err(Failure::InvalidBinding);
    }
    let port = endpoint.port().ok_or(Failure::InvalidBinding)?;
    let port_text = port.to_string();
    let argument_value = |name: &str| {
        arguments
            .iter()
            .position(|value| value == name)
            .and_then(|index| arguments.get(index + 1))
            .map(String::as_str)
    };
    if argument_value("--port") != Some(port_text.as_str())
        || argument_value("--hostname") != Some(host)
        || !table.owns_tcp_listener(binding.server_pid, host, port)
    {
        return Err(Failure::StaleServer);
    }
    let marker = table
        .environment_var(binding.server_pid, "AGENT_RELAY_MANAGED_SESSION_MARKER")
        .filter(|value| printable(value, 4096))
        .ok_or(Failure::AuthenticationUnavailable)?;
    if binding.credential_reference != credential_reference(binding, &marker) {
        return Err(Failure::AuthenticationUnavailable);
    }
    let password = table
        .environment_var(binding.server_pid, "OPENCODE_SERVER_PASSWORD")
        .filter(|value| printable(value, 4096))
        .ok_or(Failure::AuthenticationUnavailable)?;
    let username = table
        .environment_var(binding.server_pid, "OPENCODE_SERVER_USERNAME")
        .unwrap_or_else(|| "opencode".into());
    if !printable(&username, 256) || username.contains(':') {
        return Err(Failure::AuthenticationUnavailable);
    }
    if table.process(binding.server_pid) != Some(process) {
        return Err(Failure::StaleServer);
    }
    Ok(Credentials {
        username,
        password: Secret::new(password),
    })
}

/// The `Authorization` header for the binding's route, once the route is
/// proven: Basic auth for a probe-launched server, none for the plugin
/// socket, whose private directory and peer check stand in for it.
pub fn route_authorization(table: &dyn ProcessTable, binding: &Binding) -> Result<String, Failure> {
    if binding.endpoint.starts_with("unix:") {
        plugin_authority(table, binding)?;
        return Ok(String::new());
    }
    exact_process_credentials(table, binding).map(|credentials| authorization(&credentials))
}

/// Proves a plugin route: the same kernel process, this user's, running
/// the bound OpenCode executable, and its socket still the exact pinned
/// inode in a directory only this user can enter.
fn plugin_authority(table: &dyn ProcessTable, binding: &Binding) -> Result<(), Failure> {
    let socket = binding
        .endpoint
        .strip_prefix("unix:")
        .map(Path::new)
        .filter(|path| normalized(path).as_deref() == Some(*path))
        .ok_or(Failure::InvalidBinding)?;
    if socket.file_name().and_then(|name| name.to_str())
        != Some(format!("{}.sock", binding.server_pid).as_str())
    {
        return Err(Failure::InvalidBinding);
    }
    let process = table
        .process(binding.server_pid)
        .filter(|process| {
            process.uid == binding.server_uid
                && process.start == binding.server_start
                && process.uid == crate::relay::peer::current_uid()
        })
        .ok_or(Failure::StaleServer)?;
    let executable = table
        .executable(binding.server_pid)
        .and_then(|path| fs::canonicalize(path).ok());
    let expected = fs::canonicalize(&binding.executable).ok();
    let trusted = expected.as_ref().is_some_and(|path| {
        fs::metadata(path).is_ok_and(|metadata| {
            (metadata.uid() == 0 || metadata.uid() == binding.server_uid)
                && metadata.mode() & 0o022 == 0
        })
    });
    if executable != expected
        || !trusted
        || !crate::relay::opencode::is_opencode_process(table, binding.server_pid)
    {
        return Err(Failure::StaleServer);
    }
    let private = socket.parent().is_some_and(|directory| {
        fs::symlink_metadata(directory).is_ok_and(|metadata| {
            metadata.is_dir()
                && metadata.uid() == binding.server_uid
                && metadata.mode() & 0o077 == 0
        })
    });
    let (dev, ino) = crate::relay::opencode::socket_identity(socket, binding.server_uid)
        .filter(|_| private)
        .ok_or(Failure::StaleServer)?;
    let marker = crate::relay::opencode::plugin_marker(dev, ino);
    if binding.credential_reference != credential_reference(binding, &marker) {
        return Err(Failure::StaleServer);
    }
    if table.process(binding.server_pid) != Some(process) {
        return Err(Failure::StaleServer);
    }
    Ok(())
}

/// Connects to a Unix socket within `timeout`: a process that is alive but
/// not accepting (a full backlog) must not hold delivery forever, and the
/// standard library has no connect timeout for Unix sockets.
#[cfg(unix)]
fn connect_unix(path: &Path, timeout: Duration) -> std::io::Result<std::os::unix::net::UnixStream> {
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::io::FromRawFd;
    let bytes = path.as_os_str().as_bytes();
    let mut address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    if bytes.len() >= address.sun_path.len() || bytes.contains(&0) {
        return Err(std::io::Error::from(std::io::ErrorKind::InvalidInput));
    }
    address.sun_family = libc::AF_UNIX as libc::sa_family_t;
    for (slot, byte) in address.sun_path.iter_mut().zip(bytes) {
        *slot = *byte as libc::c_char;
    }
    let length = (std::mem::size_of::<libc::sa_family_t>() + bytes.len() + 1) as libc::socklen_t;
    let fd = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0) };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    // Owned from here, so every return closes it.
    let stream = unsafe { std::os::unix::net::UnixStream::from_raw_fd(fd) };
    stream.set_nonblocking(true)?;
    let deadline = std::time::Instant::now() + timeout;
    loop {
        let status = unsafe {
            libc::connect(
                fd,
                &address as *const libc::sockaddr_un as *const libc::sockaddr,
                length,
            )
        };
        if status == 0 {
            break;
        }
        let error = std::io::Error::last_os_error();
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            return Err(std::io::Error::from(std::io::ErrorKind::TimedOut));
        }
        match error.raw_os_error() {
            // Linux refuses at once while the backlog is full: try again.
            Some(libc::EAGAIN) => std::thread::sleep(remaining.min(Duration::from_millis(20))),
            // macOS (and Linux in some cases) connects in the background.
            Some(libc::EINPROGRESS) | Some(libc::EALREADY) => {
                // Wait for the connection, the deadline intact across a
                // signal (a child exiting is enough to interrupt `poll`).
                loop {
                    let left = deadline.saturating_duration_since(std::time::Instant::now());
                    let mut poll = libc::pollfd {
                        fd,
                        events: libc::POLLOUT,
                        revents: 0,
                    };
                    let wait = left.as_millis().min(i32::MAX as u128) as libc::c_int;
                    let ready = unsafe { libc::poll(&mut poll, 1, wait) };
                    if ready > 0 {
                        break;
                    }
                    if ready < 0
                        && std::io::Error::last_os_error().raw_os_error() == Some(libc::EINTR)
                        && !left.is_zero()
                    {
                        continue;
                    }
                    return Err(std::io::Error::from(std::io::ErrorKind::TimedOut));
                }
                let mut pending: libc::c_int = 0;
                let mut size = std::mem::size_of::<libc::c_int>() as libc::socklen_t;
                let read = unsafe {
                    libc::getsockopt(
                        fd,
                        libc::SOL_SOCKET,
                        libc::SO_ERROR,
                        &mut pending as *mut libc::c_int as *mut libc::c_void,
                        &mut size,
                    )
                };
                if read != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if pending != 0 {
                    return Err(std::io::Error::from_raw_os_error(pending));
                }
                break;
            }
            Some(libc::EISCONN) => break,
            Some(libc::EINTR) => {}
            _ => return Err(error),
        }
    }
    stream.set_nonblocking(false)?;
    Ok(stream)
}

/// One HTTP/1.1 request over a plugin socket, `rest` being
/// `<socket path><request path>`. The connection is refused unless the
/// kernel reports its peer as this user and the pid the socket is named
/// for, so a socket another process bound in its place answers nothing.
#[cfg(unix)]
fn unix_request(
    method: &str,
    rest: &str,
    body: Option<&[u8]>,
    timeout: Duration,
) -> Option<HttpResponse> {
    let split = rest.rfind(".sock/")? + ".sock".len();
    let (socket, path) = rest.split_at(split);
    let pid = Path::new(socket)
        .file_stem()?
        .to_str()?
        .parse::<i32>()
        .ok()?;
    if !path.starts_with('/') || path.bytes().any(|byte| byte <= b' ' || byte == 0x7f) {
        return None;
    }
    let mut stream = connect_unix(Path::new(socket), timeout).ok()?;
    let peer = crate::relay::peer::peer_credentials(&stream).ok()?;
    if peer.uid != crate::relay::peer::current_uid() || peer.pid != Some(pid) {
        return None;
    }
    stream.set_read_timeout(Some(timeout)).ok()?;
    stream.set_write_timeout(Some(timeout)).ok()?;
    let body = body.unwrap_or_default();
    let mut head = format!(
        "{method} {path} HTTP/1.1\r\nHost: localhost\r\nAccept: application/json\r\nConnection: close\r\nContent-Length: {}\r\n",
        body.len()
    );
    if !body.is_empty() {
        head.push_str("Content-Type: application/json\r\n");
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes()).ok()?;
    stream.write_all(body).ok()?;
    let mut raw = Vec::new();
    stream
        .take((MAX_BODY + 65_536) as u64)
        .read_to_end(&mut raw)
        .ok()?;
    parse_http_response(&raw)
}

/// No plugin socket answers on Windows, where OpenCode's plugin route is
/// not available.
#[cfg(windows)]
fn unix_request(
    _method: &str,
    _rest: &str,
    _body: Option<&[u8]>,
    _timeout: Duration,
) -> Option<HttpResponse> {
    None
}

/// A complete HTTP/1.1 response: a status line, headers, and a body framed
/// by `Content-Length`, chunked encoding, or the connection's close.
#[cfg_attr(windows, allow(dead_code))]
fn parse_http_response(raw: &[u8]) -> Option<HttpResponse> {
    let end = raw.windows(4).position(|window| window == b"\r\n\r\n")?;
    let head = std::str::from_utf8(&raw[..end]).ok()?;
    let mut lines = head.split("\r\n");
    let mut status_line = lines.next()?.splitn(3, ' ');
    if !status_line.next()?.starts_with("HTTP/1.") {
        return None;
    }
    let status = status_line.next()?.parse::<u16>().ok()?;
    let mut length = None;
    let mut chunked = false;
    for line in lines {
        let (name, value) = line.split_once(':')?;
        let value = value.trim();
        if name.eq_ignore_ascii_case("content-length") {
            length = Some(value.parse::<usize>().ok()?);
        } else if name.eq_ignore_ascii_case("transfer-encoding") {
            chunked = value.eq_ignore_ascii_case("chunked");
        }
    }
    let rest = &raw[end + 4..];
    let body = if chunked {
        let mut body = Vec::new();
        let mut rest = rest;
        loop {
            let line_end = rest.windows(2).position(|window| window == b"\r\n")?;
            let size_text = std::str::from_utf8(&rest[..line_end]).ok()?;
            let size = usize::from_str_radix(size_text.split(';').next()?.trim(), 16).ok()?;
            rest = &rest[line_end + 2..];
            if size == 0 {
                break;
            }
            if rest.len() < size + 2 || &rest[size..size + 2] != b"\r\n" {
                return None;
            }
            body.extend_from_slice(&rest[..size]);
            rest = &rest[size + 2..];
        }
        body
    } else if let Some(length) = length {
        rest.get(..length)?.to_vec()
    } else {
        rest.to_vec()
    };
    (body.len() <= MAX_BODY).then_some(HttpResponse { status, body })
}

/// A reference to the process-only marker that also authenticates every
/// caller-independent launch field. Provider project/workspace values are
/// authenticated separately by exact session readback.
pub(crate) fn credential_reference(binding: &Binding, marker: &str) -> String {
    let mut digest = Sha256::new();
    for part in [
        marker,
        &binding.relay_workspace_id,
        &binding.owner_id,
        &binding.session_id,
        &binding.endpoint,
        &binding.server_pid.to_string(),
        &binding.server_start.to_string(),
        &binding.server_uid.to_string(),
        binding.executable.to_string_lossy().as_ref(),
        binding.directory.to_string_lossy().as_ref(),
    ] {
        digest.update(part.as_bytes());
        digest.update([0]);
    }
    format!("probe:opencode:{:x}", digest.finalize())
}

fn binding_valid(binding: &Binding, relay_workspace_id: &str) -> bool {
    binding.relay_workspace_id == relay_workspace_id
        && printable(relay_workspace_id, 256)
        && printable(&binding.owner_id, 256)
        && printable(&binding.session_id, 256)
        && binding.session_id.starts_with("ses_")
        && printable(&binding.project_id, 256)
        && binding
            .opencode_workspace_id
            .as_deref()
            .is_none_or(|value| printable(value, 256))
        && binding.server_pid > 1
        && binding.server_start > 0
        && normalized(&binding.executable).as_deref() == Some(binding.executable.as_path())
        && normalized(&binding.directory).as_deref() == Some(binding.directory.as_path())
        && binding.credential_reference.starts_with("probe:opencode:")
        && binding.credential_reference.len() == "probe:opencode:".len() + 64
}

fn authorization(credentials: &Credentials) -> String {
    let raw = format!("{}:{}", credentials.username, credentials.password.expose());
    format!(
        "Basic {}",
        base64::engine::general_purpose::STANDARD.encode(raw)
    )
}

#[derive(Debug, PartialEq, Eq)]
enum Claim {
    Send,
    Completed(String),
    Reconcile,
    Mismatch,
}

struct Journal {
    directory: PathBuf,
}

impl Journal {
    fn new(directory: &Path) -> std::io::Result<Self> {
        match fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(directory)
        {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
        let metadata = fs::symlink_metadata(directory)?;
        if !metadata.is_dir()
            || metadata.uid() != platform::getuid()
            || metadata.mode() & 0o077 != 0
        {
            return Err(std::io::Error::new(
                ErrorKind::PermissionDenied,
                "OpenCode journal is not private",
            ));
        }
        if let Some(cutoff) =
            std::time::SystemTime::now().checked_sub(existing_session::STALE_JOURNAL_TEMP_AGE)
        {
            existing_session::sweep_stale_journal_temps(directory, cutoff);
        }
        Ok(Self {
            directory: directory.into(),
        })
    }

    fn digest(parts: &[&str]) -> String {
        let mut digest = Sha256::new();
        for part in parts {
            digest.update(part.as_bytes());
            digest.update([0]);
        }
        format!("{:x}", digest.finalize())
    }

    fn request_hash(request: &Request<'_>) -> String {
        let binding = request.binding;
        Self::digest(&[
            &binding.relay_workspace_id,
            &binding.owner_id,
            &binding.session_id,
            &binding.endpoint,
            &binding.server_pid.to_string(),
            &binding.server_start.to_string(),
            &binding.server_uid.to_string(),
            &binding.executable.to_string_lossy(),
            &binding.directory.to_string_lossy(),
            &binding.project_id,
            binding.opencode_workspace_id.as_deref().unwrap_or(""),
            &binding.credential_reference,
            request.message_id,
            request.text,
        ])
    }

    fn path(&self, delivery_id: &str) -> PathBuf {
        self.directory
            .join(format!("{}.receipt", Self::digest(&[delivery_id])))
    }

    fn lock_path(&self, binding: &Binding) -> PathBuf {
        self.directory.join(format!(
            "route-{}.lock",
            Self::digest(&[&binding.endpoint, &binding.session_id])
        ))
    }

    fn private_file(path: &Path, create_new: bool) -> std::io::Result<File> {
        OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(create_new)
            .custom_flags(platform::O_NOFOLLOW)
            .mode(0o600)
            .open(path)
    }

    fn sync_dir(&self) -> std::io::Result<()> {
        File::open(&self.directory)?.sync_all()
    }

    fn with_lock<T>(&self, binding: &Binding, run: impl FnOnce() -> T) -> std::io::Result<T> {
        let path = self.lock_path(binding);
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .custom_flags(platform::O_NOFOLLOW)
            .mode(0o600)
            .open(path)?;
        let metadata = file.metadata()?;
        if !metadata.is_file()
            || metadata.uid() != platform::getuid()
            || metadata.mode() & 0o077 != 0
        {
            return Err(std::io::Error::new(
                ErrorKind::PermissionDenied,
                "OpenCode route lock is not private",
            ));
        }
        file.lock_exclusive()?;
        let result = run();
        FileExt::unlock(&file)?;
        Ok(result)
    }

    fn claim(&self, request: &Request<'_>) -> std::io::Result<Claim> {
        let path = self.path(request.delivery_id);
        let hash = Self::request_hash(request);
        match Self::private_file(&path, true) {
            Ok(mut file) => {
                write!(file, "pending\n{hash}\n")?;
                file.sync_all()?;
                self.sync_dir()?;
                Ok(Claim::Send)
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                let file = Self::private_file(&path, false)?;
                let metadata = file.metadata()?;
                if !metadata.is_file()
                    || metadata.uid() != platform::getuid()
                    || metadata.mode() & 0o077 != 0
                {
                    return Err(std::io::Error::new(
                        ErrorKind::PermissionDenied,
                        "OpenCode receipt is not private",
                    ));
                }
                let mut contents = String::new();
                file.take(1024).read_to_string(&mut contents)?;
                let mut lines = contents.lines();
                let state = lines.next();
                let prior = lines.next();
                if prior != Some(hash.as_str()) {
                    return Ok(Claim::Mismatch);
                }
                Ok(match state {
                    Some("completed") => lines
                        .next()
                        .filter(|receipt| printable(receipt, 256))
                        .map_or(Claim::Reconcile, |receipt| Claim::Completed(receipt.into())),
                    Some("accepted") | Some("pending") => Claim::Reconcile,
                    _ => Claim::Reconcile,
                })
            }
            Err(error) => Err(error),
        }
    }

    fn replace(
        &self,
        request: &Request<'_>,
        state: &str,
        receipt: Option<&str>,
    ) -> std::io::Result<()> {
        let path = self.path(request.delivery_id);
        let temp = self.directory.join(format!(
            ".{}-{}.tmp",
            Self::digest(&[request.delivery_id, state, receipt.unwrap_or("")]),
            random_hex(32)
        ));
        let result = (|| {
            let mut file = Self::private_file(&temp, true)?;
            write!(file, "{state}\n{}\n", Self::request_hash(request))?;
            if let Some(receipt) = receipt {
                writeln!(file, "{receipt}")?;
            }
            file.sync_all()?;
            fs::rename(&temp, path)?;
            self.sync_dir()
        })();
        if result.is_err() {
            let _ = fs::remove_file(temp);
        }
        result
    }

    fn release(&self, request: &Request<'_>) -> std::io::Result<()> {
        fs::remove_file(self.path(request.delivery_id))?;
        self.sync_dir()
    }
}

pub struct OpenCodeInjector {
    table: Arc<dyn ProcessTable>,
    http: Arc<dyn HttpTransport>,
    clock: Arc<dyn Clock>,
    journal: Journal,
}

impl OpenCodeInjector {
    pub fn new(
        table: Arc<dyn ProcessTable>,
        http: Arc<dyn HttpTransport>,
        clock: Arc<dyn Clock>,
        journal_directory: &Path,
    ) -> std::io::Result<Self> {
        Ok(Self {
            table,
            http,
            clock,
            journal: Journal::new(journal_directory)?,
        })
    }

    /// This computer's injector. On Windows, where OpenCode's served and
    /// plugin routes are not available, an error that says so.
    pub fn system(table: Arc<dyn ProcessTable>, journal_directory: &Path) -> std::io::Result<Self> {
        if let Some(reason) = platform::unsupported("OpenCode") {
            return Err(std::io::Error::new(ErrorKind::Unsupported, reason));
        }
        Self::new(
            table,
            Arc::new(SystemHttp),
            Arc::new(SystemClock),
            journal_directory,
        )
    }

    pub fn message_id(request: &Request<'_>) -> String {
        format!(
            "msg_relay_{}",
            &Journal::digest(&[
                request.delivery_id,
                request.message_id,
                &request.binding.session_id,
                request.text,
            ])[..32]
        )
    }

    /// Read-only liveness used by the managed picker. It proves the exact
    /// process credential and exact provider session without creating a turn.
    pub fn verify_binding(&self, binding: &Binding, timeout: Duration) -> bool {
        let cancelled = AtomicBool::new(false);
        let request = Request {
            binding,
            relay_workspace_id: &binding.relay_workspace_id,
            delivery_id: "picker-readback",
            message_id: "picker-readback",
            text: "picker-readback",
            timeout,
            cancelled: &cancelled,
        };
        binding_valid(binding, &binding.relay_workspace_id) && self.session_auth(&request).is_ok()
    }

    pub fn inject(&self, request: &Request<'_>) -> Outcome {
        if !Self::valid_request(request) {
            return Outcome::Refused(Failure::InvalidBinding);
        }
        let result = self.journal.with_lock(request.binding, || {
            self.previous_native(request)
                .unwrap_or_else(|| self.inject_locked(request, None))
        });
        result.unwrap_or(Outcome::InDoubt(Failure::JournalUnavailable))
    }

    fn valid_request(request: &Request<'_>) -> bool {
        !(!binding_valid(request.binding, request.relay_workspace_id)
            || !printable(request.delivery_id, 256)
            || !printable(request.message_id, 256)
            || request.text.is_empty()
            || request.text.len() > 65_536
            || !(Duration::from_secs(1)..=Duration::from_secs(120)).contains(&request.timeout))
    }

    fn inject_locked(&self, request: &Request<'_>, admit: Option<&dyn Fn() -> bool>) -> Outcome {
        match self.journal.claim(request) {
            Ok(Claim::Completed(receipt_id)) => return Outcome::Completed { receipt_id },
            Ok(Claim::Reconcile) => return self.reconcile(request),
            Ok(Claim::Mismatch) => return Outcome::Refused(Failure::SessionMismatch),
            Ok(Claim::Send) => {}
            Err(_) => return Outcome::InDoubt(Failure::JournalUnavailable),
        }

        let before_send = self.preflight(request);
        let (authorization, base) = match before_send {
            Ok(value) => value,
            Err(outcome) => {
                return if self.journal.release(request).is_ok() {
                    outcome
                } else {
                    Outcome::InDoubt(Failure::JournalUnavailable)
                }
            }
        };
        let user_message_id = Self::message_id(request);
        let body = serde_json::to_vec(&json!({
            "messageID": user_message_id,
            "parts": [{"type": "text", "text": request.text}],
        }))
        .unwrap();
        let prompt = format!("{base}/session/{}/prompt_async", request.binding.session_id);
        // All provider reads are complete. Recheck the core's current owner,
        // scope and opt-in at the last boundary before mutating this session.
        if !native::may_submit(request, admit) {
            let outcome = Outcome::Refused(Failure::CancelledBeforeSend);
            return if self.journal.release(request).is_ok() {
                outcome
            } else {
                Outcome::InDoubt(Failure::JournalUnavailable)
            };
        }

        let response = self.http.request(
            "POST",
            &prompt,
            &authorization,
            &request.binding.directory,
            Some(&body),
            request.timeout.min(Duration::from_secs(30)),
        );
        let Some(response) = response else {
            return Outcome::InDoubt(Failure::TimedOut);
        };
        if response.status != 204 {
            // A transient refusal after a non-idempotent POST cannot prove
            // that OpenCode did not enqueue the message before failing. Keep
            // the durable claim and never turn it into a resend.
            if response.status == 429 || (500..=599).contains(&response.status) {
                return Outcome::InDoubt(Failure::EndpointUnavailable);
            }
            let failure = match response.status {
                401 | 403 => Failure::AuthenticationRefused,
                404 => Failure::SessionMismatch,
                _ => Failure::ProviderRefused,
            };
            let outcome = if matches!(failure, Failure::EndpointUnavailable) {
                Outcome::Waiting(failure)
            } else {
                Outcome::Refused(failure)
            };
            return if self.journal.release(request).is_ok() {
                outcome
            } else {
                Outcome::InDoubt(Failure::JournalUnavailable)
            };
        }
        if self.journal.replace(request, "accepted", None).is_err() {
            return Outcome::InDoubt(Failure::JournalUnavailable);
        }
        self.wait_for_acceptance(request, &authorization, &base, &user_message_id)
    }

    /// A prior pending/accepted record is never sent again. When OpenCode can
    /// prove the deterministic user message, continue readback to a terminal
    /// receipt; otherwise leave the record quarantined for operator action.
    fn reconcile(&self, request: &Request<'_>) -> Outcome {
        let (authorization, base) = match self.session_auth(request) {
            Ok(value) => value,
            Err(_) => return Outcome::InDoubt(Failure::PriorAttemptUncertain),
        };
        let user_message_id = Self::message_id(request);
        let user_url = format!(
            "{base}/session/{}/message/{user_message_id}",
            request.binding.session_id
        );
        let Some(user) = self.http.request(
            "GET",
            &user_url,
            &authorization,
            &request.binding.directory,
            None,
            request.timeout.min(Duration::from_secs(10)),
        ) else {
            return Outcome::InDoubt(Failure::PriorAttemptUncertain);
        };
        if user.status != 200
            || user_message_state(&user.body, request, &user_message_id)
                != UserMessageState::Matched
        {
            return Outcome::InDoubt(Failure::PriorAttemptUncertain);
        }
        self.complete(request, &user_message_id)
    }

    fn session_auth(&self, request: &Request<'_>) -> Result<(String, String), Outcome> {
        let auth = route_authorization(&*self.table, request.binding).map_err(Outcome::Refused)?;
        let base = request.binding.endpoint.trim_end_matches('/').to_string();
        let session_url = format!("{base}/session/{}", request.binding.session_id);
        let response = self
            .http
            .request(
                "GET",
                &session_url,
                &auth,
                &request.binding.directory,
                None,
                request.timeout.min(Duration::from_secs(10)),
            )
            .ok_or(Outcome::Waiting(Failure::EndpointUnavailable))?;
        if response.status == 401 || response.status == 403 {
            return Err(Outcome::Refused(Failure::AuthenticationRefused));
        }
        if response.status != 200 || !session_matches(&response.body, request.binding) {
            return Err(Outcome::Refused(Failure::SessionMismatch));
        }
        Ok((auth, base))
    }

    /// Reads the completed answer for the exact Relay message reference.
    /// Native turns use the private index; peer turns use their text marker.
    /// The managed-session registry has already re-verified `binding`; this
    /// method repeats the process, listener and provider checks before using
    /// credentials or transcript data.
    pub fn final_answer(&self, binding: &Binding, message_ref: &str) -> Option<String> {
        if !native::valid_reference(message_ref) {
            return None;
        }
        // A known native reference never falls through to marker matching,
        // including while its receipt is pending or unreadable.
        if self.has_native_reference(binding, message_ref) {
            return self.native_final_answer(binding, message_ref);
        }
        let messages = self.answer_messages(binding)?;
        let user_id = messages.iter().find_map(|message| {
            let info = message.get("info")?;
            if info.get("role")?.as_str()? != "user"
                || info.get("sessionID")?.as_str()? != binding.session_id
            {
                return None;
            }
            let carries_ref = message.get("parts")?.as_array()?.iter().any(|part| {
                part.get("type").and_then(Value::as_str) == Some("text")
                    && part
                        .get("text")
                        .and_then(Value::as_str)
                        .and_then(crate::relay::delivery::policy::MessageRef::in_text)
                        .as_deref()
                        == Some(message_ref)
            });
            carries_ref
                .then(|| info.get("id").and_then(Value::as_str).map(str::to_owned))
                .flatten()
        })?;
        Self::answer_for_user(&messages, &binding.session_id, &user_id)
    }

    fn preflight(&self, request: &Request<'_>) -> Result<(String, String), Outcome> {
        let (auth, base) = self.session_auth(request)?;
        let status = self
            .http
            .request(
                "GET",
                &format!("{base}/session/status"),
                &auth,
                &request.binding.directory,
                None,
                request.timeout.min(Duration::from_secs(10)),
            )
            .ok_or(Outcome::Waiting(Failure::EndpointUnavailable))?;
        if status.status == 401 || status.status == 403 {
            return Err(Outcome::Refused(Failure::AuthenticationRefused));
        }
        if status.status != 200 {
            return Err(Outcome::Waiting(Failure::EndpointUnavailable));
        }
        let value: Value = serde_json::from_slice(&status.body)
            .map_err(|_| Outcome::Waiting(Failure::EndpointUnavailable))?;
        if value
            .get(&request.binding.session_id)
            .and_then(|status| status.get("type"))
            .and_then(Value::as_str)
            .is_some_and(|status| status != "idle")
        {
            return Err(Outcome::Waiting(Failure::SessionBusy));
        }
        Ok((auth, base))
    }

    /// The message is delivered once OpenCode's transcript holds the exact
    /// user message under our deterministic id and text: the turn it starts
    /// can run for as long as it needs, and its answer is read back later
    /// (`final_answer`). A transient read failure keeps polling; only a
    /// message that never appears by the deadline, or appears different,
    /// leaves the delivery in doubt.
    fn wait_for_acceptance(
        &self,
        request: &Request<'_>,
        authorization: &str,
        base: &str,
        user_message_id: &str,
    ) -> Outcome {
        let deadline = self.clock.now() + request.timeout;
        let user_url = format!(
            "{base}/session/{}/message/{user_message_id}",
            request.binding.session_id
        );
        loop {
            if request.cancelled.load(Ordering::SeqCst) {
                return Outcome::InDoubt(Failure::CancelledAfterAcceptance);
            }
            if self.clock.now() >= deadline {
                return Outcome::InDoubt(Failure::TimedOut);
            }
            let user = self.http.request(
                "GET",
                &user_url,
                authorization,
                &request.binding.directory,
                None,
                Duration::from_secs(10),
            );
            match user.as_ref().map(|user| user.status) {
                Some(401 | 403) => return Outcome::InDoubt(Failure::AuthenticationRefused),
                Some(200) => {
                    match user_message_state(&user.as_ref().unwrap().body, request, user_message_id)
                    {
                        UserMessageState::Matched => {
                            return self.complete(request, user_message_id)
                        }
                        // OpenCode can publish the message envelope before its
                        // parts are materialized. Keep polling the exact
                        // deterministic id; a temporary empty envelope is neither
                        // acceptance nor a mismatch.
                        UserMessageState::Pending => {}
                        UserMessageState::Mismatch => {
                            return Outcome::InDoubt(Failure::SessionMismatch)
                        }
                    }
                }
                // Not there yet, or a transient failure: keep reading until
                // the deadline, never sending again.
                Some(404) | Some(429) | Some(500..=599) | None => {}
                Some(_) => return Outcome::InDoubt(Failure::ProviderRefused),
            }
            self.clock.sleep(Duration::from_millis(250));
        }
    }

    /// Records the receipt: the exact user message OpenCode holds.
    fn complete(&self, request: &Request<'_>, user_message_id: &str) -> Outcome {
        let receipt_id = format!("opencode:{user_message_id}");
        if self
            .journal
            .replace(request, "completed", Some(&receipt_id))
            .is_ok()
        {
            Outcome::Completed { receipt_id }
        } else {
            Outcome::InDoubt(Failure::JournalUnavailable)
        }
    }
}

fn session_matches(body: &[u8], binding: &Binding) -> bool {
    let Ok(value) = serde_json::from_slice::<Value>(body) else {
        return false;
    };
    value["id"].as_str() == Some(binding.session_id.as_str())
        && value["projectID"].as_str() == Some(binding.project_id.as_str())
        && value["directory"].as_str() == binding.directory.to_str()
        && value.get("workspaceID").and_then(Value::as_str)
            == binding.opencode_workspace_id.as_deref()
        && value["time"].get("archived").is_none()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum UserMessageState {
    Pending,
    Matched,
    Mismatch,
}

fn user_message_state(body: &[u8], request: &Request<'_>, expected_id: &str) -> UserMessageState {
    let Ok(value) = serde_json::from_slice::<Value>(body) else {
        return UserMessageState::Mismatch;
    };
    if value["info"]["id"].as_str() != Some(expected_id)
        || value["info"]["sessionID"].as_str() != Some(request.binding.session_id.as_str())
        || value["info"]["role"].as_str() != Some("user")
    {
        return UserMessageState::Mismatch;
    }
    let Some(parts) = value["parts"].as_array() else {
        return UserMessageState::Pending;
    };
    if parts.iter().any(|part| {
        part["type"].as_str() == Some("text") && part["text"].as_str() == Some(request.text)
    }) {
        UserMessageState::Matched
    } else if parts
        .iter()
        .any(|part| part["type"].as_str() == Some("text"))
    {
        UserMessageState::Mismatch
    } else {
        UserMessageState::Pending
    }
}

fn completion(
    body: &[u8],
    session_id: &str,
    user_message_id: &str,
) -> Option<Result<String, Failure>> {
    let values = serde_json::from_slice::<Vec<Value>>(body).ok()?;
    values.into_iter().find_map(|value| {
        let info = &value["info"];
        if info["role"].as_str() != Some("assistant")
            || info["sessionID"].as_str() != Some(session_id)
            || info["parentID"].as_str() != Some(user_message_id)
        {
            return None;
        }
        if !info["error"].is_null() {
            return Some(Err(Failure::ProviderRefused));
        }
        let receipt = info["id"].as_str()?;
        let finish = info["finish"].as_str()?;
        let completed = info["time"]["completed"].as_u64().is_some();
        let terminal_part = value["parts"].as_array().is_some_and(|parts| {
            parts.iter().any(|part| {
                part["type"].as_str() == Some("step-finish")
                    && part["sessionID"].as_str() == Some(session_id)
                    && part["messageID"].as_str() == Some(receipt)
                    && part["reason"].as_str() == Some(finish)
            })
        });
        // OpenCode's run loop deliberately continues when an assistant has
        // an executable tool part, even when a provider labels that step
        // `finish=stop`. Match its hasToolCalls rule so a completed tool step
        // cannot become a delivery receipt before the final assistant turn.
        let has_tool_calls = value["parts"].as_array().is_some_and(|parts| {
            parts.iter().any(|part| {
                let provider_executed =
                    part["metadata"]["providerExecuted"].as_bool() == Some(true);
                let orphaned_interrupted = part["state"]["status"].as_str() == Some("error")
                    && part["state"]["metadata"]["interrupted"].as_bool() == Some(true);
                part["type"].as_str() == Some("tool") && !provider_executed && !orphaned_interrupted
            })
        });
        if finish == "stop"
            && completed
            && terminal_part
            && !has_tool_calls
            && printable(receipt, 256)
            && printable(finish, 128)
        {
            Some(Ok(format!("opencode:{receipt}")))
        } else {
            None
        }
    })
}

// Unix sockets, `pre_exec` and file modes throughout; the OpenCode routes
// are not available on Windows.
#[cfg(test)]
#[cfg(unix)]
mod tests {

    #[test]
    fn a_unix_connect_gives_up_at_its_deadline_and_connects_to_a_listener() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("p.sock");
        // Nothing listening: refused at once, not after the timeout.
        let started = std::time::Instant::now();
        assert!(connect_unix(&path, Duration::from_secs(5)).is_err());
        assert!(started.elapsed() < Duration::from_secs(1));
        let _listener = std::os::unix::net::UnixListener::bind(&path).unwrap();
        let stream = connect_unix(&path, Duration::from_secs(1)).unwrap();
        // Blocking again for the request that follows.
        assert!(stream
            .set_read_timeout(Some(Duration::from_millis(10)))
            .is_ok());
    }

    use super::*;
    use crate::relay::process::{FakeProcess, FakeProcesses, SystemProcesses};
    use std::collections::VecDeque;
    use std::sync::Mutex;

    #[derive(Default)]
    struct FakeHttp {
        responses: Mutex<VecDeque<Option<HttpResponse>>>,
        calls: Mutex<Vec<(String, String, String, Vec<u8>)>>,
        cancel_after_prompt_acceptance: Mutex<Option<Arc<AtomicBool>>>,
    }

    impl FakeHttp {
        fn push(&self, status: u16, body: impl Into<Vec<u8>>) {
            self.responses.lock().unwrap().push_back(Some(HttpResponse {
                status,
                body: body.into(),
            }));
        }
    }

    impl HttpTransport for FakeHttp {
        fn request(
            &self,
            method: &str,
            url: &str,
            authorization: &str,
            _: &Path,
            body: Option<&[u8]>,
            _: Duration,
        ) -> Option<HttpResponse> {
            self.calls.lock().unwrap().push((
                method.into(),
                url.into(),
                authorization.into(),
                body.unwrap_or_default().to_vec(),
            ));
            let response = self.responses.lock().unwrap().pop_front().flatten();
            if method == "POST"
                && response
                    .as_ref()
                    .is_some_and(|response| response.status == 204)
            {
                if let Some(cancelled) = self.cancel_after_prompt_acceptance.lock().unwrap().take()
                {
                    cancelled.store(true, Ordering::SeqCst);
                }
            }
            response
        }
    }

    include!("opencode_existing/native_tests.rs");

    struct FakeClock(Mutex<Instant>);

    impl FakeClock {
        fn new() -> Self {
            Self(Mutex::new(Instant::now()))
        }
    }

    impl Clock for FakeClock {
        fn now(&self) -> Instant {
            *self.0.lock().unwrap()
        }

        fn sleep(&self, duration: Duration) {
            *self.0.lock().unwrap() += duration;
        }
    }

    fn table() -> Arc<FakeProcesses> {
        let table = Arc::new(FakeProcesses::default());
        let executable = std::env::current_exe().unwrap();
        table.insert(
            42,
            FakeProcess {
                parent: 1,
                uid: crate::relay::peer::current_uid(),
                start: 777,
                executable: Some(executable),
                arguments: vec![
                    "opencode".into(),
                    "serve".into(),
                    "--hostname".into(),
                    "127.0.0.1".into(),
                    "--port".into(),
                    "4096".into(),
                ],
                environment: [
                    ("OPENCODE_SERVER_USERNAME".into(), "relay".into()),
                    ("OPENCODE_SERVER_PASSWORD".into(), "super-secret".into()),
                    (
                        "AGENT_RELAY_MANAGED_SESSION_MARKER".into(),
                        "probe-marker".into(),
                    ),
                ]
                .into(),
                tcp_listeners: vec![("127.0.0.1".into(), 4096)],
                ..FakeProcess::default()
            },
        );
        table
    }

    fn binding() -> Binding {
        let mut binding = Binding {
            relay_workspace_id: "rw_exact".into(),
            owner_id: "owner-exact".into(),
            session_id: "ses_exact".into(),
            endpoint: "http://127.0.0.1:4096/".into(),
            server_pid: 42,
            server_start: 777,
            server_uid: crate::relay::peer::current_uid(),
            executable: std::env::current_exe().unwrap(),
            directory: PathBuf::from("/work/project"),
            project_id: "prj_exact".into(),
            opencode_workspace_id: Some("wrk_exact".into()),
            credential_reference: String::new(),
        };
        binding.credential_reference = credential_reference(&binding, "probe-marker");
        binding
    }

    fn request<'a>(binding: &'a Binding, cancelled: &'a AtomicBool) -> Request<'a> {
        Request {
            binding,
            relay_workspace_id: "rw_exact",
            delivery_id: "delivery-1",
            message_id: "relay-message-1",
            text: "please inspect this",
            timeout: Duration::from_secs(2),
            cancelled,
        }
    }

    fn session() -> Vec<u8> {
        serde_json::to_vec(&json!({
            "id": "ses_exact",
            "projectID": "prj_exact",
            "workspaceID": "wrk_exact",
            "directory": "/work/project",
            "time": {"created": 1, "updated": 2}
        }))
        .unwrap()
    }

    fn injector(
        directory: &Path,
        table: Arc<FakeProcesses>,
        http: Arc<FakeHttp>,
    ) -> OpenCodeInjector {
        OpenCodeInjector::new(table, http, Arc::new(FakeClock::new()), directory).unwrap()
    }

    #[test]
    fn exact_prompt_and_parent_receipt_complete_once_without_leaking_basic_secret() {
        let temp = tempfile::tempdir().unwrap();
        let http = Arc::new(FakeHttp::default());
        http.push(200, session());
        http.push(200, br#"{}"#.to_vec());
        http.push(204, Vec::new());
        let cancelled = AtomicBool::new(false);
        let binding = binding();
        let request = request(&binding, &cancelled);
        let user_id = OpenCodeInjector::message_id(&request);
        http.push(
            200,
            serde_json::to_vec(&json!({
                "info": {"id": user_id, "sessionID": "ses_exact", "role": "user"},
                "parts": []
            }))
            .unwrap(),
        );
        http.push(
            200,
            serde_json::to_vec(&json!({
                "info": {"id": user_id, "sessionID": "ses_exact", "role": "user"},
                "parts": [{"type": "text", "text": "please inspect this"}]
            }))
            .unwrap(),
        );
        // Delivered once OpenCode holds the exact message; the turn it starts
        // is not waited for.
        let receipt = Outcome::Completed {
            receipt_id: format!("opencode:{user_id}"),
        };
        let injector = injector(&temp.path().join("journal"), table(), http.clone());
        assert_eq!(injector.inject(&request), receipt);
        assert_eq!(injector.inject(&request), receipt);
        let calls = http.calls.lock().unwrap();
        assert_eq!(calls.len(), 5, "restart/replay must not contact OpenCode");
        let prompt = &calls[2];
        assert_eq!(prompt.0, "POST");
        assert!(prompt.1.ends_with("/session/ses_exact/prompt_async"));
        assert!(!String::from_utf8_lossy(&prompt.3).contains("super-secret"));
        assert!(prompt.2.starts_with("Basic "));
    }

    #[test]
    fn stale_deterministic_temp_file_cannot_wedge_journal_replacement() {
        let temp = tempfile::tempdir().unwrap();
        let journal = Journal::new(&temp.path().join("journal")).unwrap();
        let cancelled = AtomicBool::new(false);
        let binding = binding();
        let request = request(&binding, &cancelled);
        assert_eq!(journal.claim(&request).unwrap(), Claim::Send);
        let stale = journal.directory.join(format!(
            ".{}.tmp",
            Journal::digest(&[request.delivery_id, "completed", "opencode:assistant"])
        ));
        fs::write(stale, b"stale").unwrap();

        journal
            .replace(&request, "completed", Some("opencode:assistant"))
            .unwrap();
        assert_eq!(
            journal.claim(&request).unwrap(),
            Claim::Completed("opencode:assistant".into())
        );
    }

    #[test]
    fn stale_wrong_workspace_busy_and_wrong_auth_fail_before_prompt() {
        let cases = ["workspace", "stale", "busy", "auth"];
        for case in cases {
            let temp = tempfile::tempdir().unwrap();
            let http = Arc::new(FakeHttp::default());
            let table = table();
            let cancelled = AtomicBool::new(false);
            let mut binding = binding();
            let mut attempt = request(&binding, &cancelled);
            let expected = match case {
                "workspace" => {
                    attempt.relay_workspace_id = "rw_other";
                    Outcome::Refused(Failure::InvalidBinding)
                }
                "stale" => {
                    binding.server_start = 778;
                    attempt = request(&binding, &cancelled);
                    Outcome::Refused(Failure::StaleServer)
                }
                "busy" => {
                    http.push(200, session());
                    http.push(200, br#"{"ses_exact":{"type":"busy"}}"#.to_vec());
                    Outcome::Waiting(Failure::SessionBusy)
                }
                "auth" => {
                    http.push(401, Vec::new());
                    Outcome::Refused(Failure::AuthenticationRefused)
                }
                _ => unreachable!(),
            };
            let injector = injector(&temp.path().join("journal"), table, http.clone());
            assert_eq!(injector.inject(&attempt), expected, "{case}");
            assert!(
                http.calls
                    .lock()
                    .unwrap()
                    .iter()
                    .all(|call| call.0 != "POST"),
                "{case} must not prompt"
            );
        }
    }

    #[test]
    fn timeout_disconnect_and_post_acceptance_cancel_are_in_doubt_and_never_resent() {
        for mode in [
            "timeout",
            "disconnect",
            "rate-limit",
            "server-error",
            "cancel",
        ] {
            let temp = tempfile::tempdir().unwrap();
            let http = Arc::new(FakeHttp::default());
            http.push(200, session());
            http.push(200, br#"{}"#.to_vec());
            let cancelled = Arc::new(AtomicBool::new(false));
            if mode == "disconnect" {
                http.responses.lock().unwrap().push_back(None);
            } else if mode == "rate-limit" {
                http.push(429, Vec::new());
            } else if mode == "server-error" {
                http.push(500, Vec::new());
            } else {
                http.push(204, Vec::new());
                if mode == "cancel" {
                    *http.cancel_after_prompt_acceptance.lock().unwrap() = Some(cancelled.clone());
                } else {
                    for _ in 0..25 {
                        http.push(404, Vec::new());
                    }
                }
            }
            let binding = binding();
            let request = request(&binding, cancelled.as_ref());
            let injector = injector(&temp.path().join("journal"), table(), http.clone());
            let outcome = injector.inject(&request);
            if mode == "cancel" {
                assert_eq!(outcome, Outcome::InDoubt(Failure::CancelledAfterAcceptance));
                let count = http.calls.lock().unwrap().len();
                let posts = http
                    .calls
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|call| call.0 == "POST")
                    .count();
                assert_eq!(
                    injector.inject(&request),
                    Outcome::InDoubt(Failure::PriorAttemptUncertain)
                );
                assert!(http.calls.lock().unwrap().len() >= count);
                assert_eq!(
                    http.calls
                        .lock()
                        .unwrap()
                        .iter()
                        .filter(|call| call.0 == "POST")
                        .count(),
                    posts
                );
            } else {
                assert!(
                    matches!(outcome, Outcome::InDoubt(_)),
                    "{mode}: {outcome:?}"
                );
                let count = http.calls.lock().unwrap().len();
                let posts = http
                    .calls
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|call| call.0 == "POST")
                    .count();
                assert_eq!(
                    injector.inject(&request),
                    Outcome::InDoubt(Failure::PriorAttemptUncertain)
                );
                assert!(http.calls.lock().unwrap().len() >= count, "{mode}");
                assert_eq!(
                    http.calls
                        .lock()
                        .unwrap()
                        .iter()
                        .filter(|call| call.0 == "POST")
                        .count(),
                    posts,
                    "{mode}"
                );
            }
        }
    }

    #[test]
    fn accepted_turn_reconciles_by_readback_after_restart_without_resending() {
        let temp = tempfile::tempdir().unwrap();
        let first_http = Arc::new(FakeHttp::default());
        first_http.push(200, session());
        first_http.push(200, br#"{}"#.to_vec());
        first_http.push(204, Vec::new());
        for _ in 0..25 {
            first_http.push(404, Vec::new());
        }
        let cancelled = AtomicBool::new(false);
        let binding = binding();
        let attempt = request(&binding, &cancelled);
        let journal = temp.path().join("journal");
        let first = injector(&journal, table(), first_http.clone());
        assert_eq!(first.inject(&attempt), Outcome::InDoubt(Failure::TimedOut));
        assert_eq!(
            first_http
                .calls
                .lock()
                .unwrap()
                .iter()
                .filter(|call| call.0 == "POST")
                .count(),
            1
        );

        let second_http = Arc::new(FakeHttp::default());
        second_http.push(200, session());
        let user_id = OpenCodeInjector::message_id(&attempt);
        second_http.push(
            200,
            serde_json::to_vec(&json!({
                "info": {"id": user_id, "sessionID": "ses_exact", "role": "user"},
                "parts": [{"type": "text", "text": "please inspect this"}]
            }))
            .unwrap(),
        );
        let restarted = injector(&journal, table(), second_http.clone());
        assert_eq!(
            restarted.inject(&attempt),
            Outcome::Completed {
                receipt_id: format!("opencode:{user_id}")
            }
        );
        assert!(second_http
            .calls
            .lock()
            .unwrap()
            .iter()
            .all(|call| call.0 == "GET"));
    }

    #[test]
    fn an_existing_pending_record_or_changed_identity_never_resends() {
        let temp = tempfile::tempdir().unwrap();
        let http = Arc::new(FakeHttp::default());
        http.push(200, session());
        http.push(200, br#"{}"#.to_vec());
        http.responses.lock().unwrap().push_back(None);
        let cancelled = AtomicBool::new(false);
        let binding = binding();
        let request = request(&binding, &cancelled);
        let injector = injector(&temp.path().join("journal"), table(), http.clone());
        assert!(matches!(injector.inject(&request), Outcome::InDoubt(_)));
        let mut changed_binding = binding.clone();
        changed_binding.directory = "/work/other".into();
        let changed = Request {
            binding: &changed_binding,
            ..request
        };
        assert_eq!(
            injector.inject(&changed),
            Outcome::Refused(Failure::SessionMismatch)
        );
        assert!(
            http.calls
                .lock()
                .unwrap()
                .iter()
                .filter(|call| call.0 == "POST")
                .count()
                <= 1
        );
    }

    #[test]
    fn user_or_assistant_identity_mismatch_cannot_fabricate_completion() {
        let temp = tempfile::tempdir().unwrap();
        let http = Arc::new(FakeHttp::default());
        http.push(200, session());
        http.push(200, br#"{}"#.to_vec());
        http.push(204, Vec::new());
        http.push(
            200,
            serde_json::to_vec(&json!({
                "info": {"id": "msg_wrong", "sessionID": "ses_exact", "role": "user"},
                "parts": [{"type": "text", "text": "please inspect this"}]
            }))
            .unwrap(),
        );
        let cancelled = AtomicBool::new(false);
        let binding = binding();
        let injector = injector(&temp.path().join("journal"), table(), http);
        assert_eq!(
            injector.inject(&request(&binding, &cancelled)),
            Outcome::InDoubt(Failure::SessionMismatch)
        );

        let unrelated = serde_json::to_vec(&json!([{
            "info": {"id": "msg_assistant", "role": "assistant", "parentID": "msg_other", "finish": "stop"}
        }]))
        .unwrap();
        assert_eq!(completion(&unrelated, "ses_exact", "msg_expected"), None);
    }

    #[test]
    fn finish_string_without_provider_terminal_evidence_is_not_completion() {
        let only_finish = serde_json::to_vec(&json!([{
            "info": {
                "id": "msg_assistant",
                "sessionID": "ses_exact",
                "role": "assistant",
                "parentID": "msg_relay",
                "finish": "stop"
            },
            "parts": []
        }]))
        .unwrap();
        assert_eq!(completion(&only_finish, "ses_exact", "msg_relay"), None);

        let wrong_session = serde_json::to_vec(&json!([{
            "info": {
                "id": "msg_assistant",
                "sessionID": "ses_other",
                "role": "assistant",
                "parentID": "msg_relay",
                "finish": "stop",
                "time": {"created": 1, "completed": 2}
            },
            "parts": [{
                "id": "prt_finish",
                "sessionID": "ses_other",
                "messageID": "msg_assistant",
                "type": "step-finish",
                "reason": "stop"
            }]
        }]))
        .unwrap();
        assert_eq!(completion(&wrong_session, "ses_exact", "msg_relay"), None);

        let tool_then_final = serde_json::to_vec(&json!([
            {
                "info": {
                    "id": "msg_assistant_tool",
                    "sessionID": "ses_exact",
                    "role": "assistant",
                    "parentID": "msg_relay",
                    "finish": "tool-calls",
                    "time": {"created": 1, "completed": 2}
                },
                "parts": [{
                    "id": "prt_finish_tool",
                    "sessionID": "ses_exact",
                    "messageID": "msg_assistant_tool",
                    "type": "step-finish",
                    "reason": "tool-calls"
                }]
            },
            {
                "info": {
                    "id": "msg_assistant_stop_tool",
                    "sessionID": "ses_exact",
                    "role": "assistant",
                    "parentID": "msg_relay",
                    "finish": "stop",
                    "time": {"created": 3, "completed": 4}
                },
                "parts": [
                    {
                        "id": "prt_tool_stop",
                        "sessionID": "ses_exact",
                        "messageID": "msg_assistant_stop_tool",
                        "type": "tool",
                        "tool": "read",
                        "state": {"status": "completed"}
                    },
                    {
                        "id": "prt_finish_stop_tool",
                        "sessionID": "ses_exact",
                        "messageID": "msg_assistant_stop_tool",
                        "type": "step-finish",
                        "reason": "stop"
                    }
                ]
            },
            {
                "info": {
                    "id": "msg_assistant_final",
                    "sessionID": "ses_exact",
                    "role": "assistant",
                    "parentID": "msg_relay",
                    "finish": "stop",
                    "time": {"created": 5, "completed": 6}
                },
                "parts": [{
                    "id": "prt_finish_final",
                    "sessionID": "ses_exact",
                    "messageID": "msg_assistant_final",
                    "type": "step-finish",
                    "reason": "stop"
                }]
            }
        ]))
        .unwrap();
        assert_eq!(
            completion(&tool_then_final, "ses_exact", "msg_relay"),
            Some(Ok("opencode:msg_assistant_final".into()))
        );
    }

    #[test]
    fn endpoint_must_be_exact_loopback_and_match_serve_arguments() {
        let table = table();
        for endpoint in [
            "http://example.com:4096/",
            "http://localhost:4096/",
            "https://127.0.0.1:4096/",
            "http://user:secret@127.0.0.1:4096/",
            "http://127.0.0.1:4097/",
            "http://127.0.0.1:4096/path",
        ] {
            let mut binding = binding();
            binding.endpoint = endpoint.into();
            assert!(
                exact_process_credentials(&*table, &binding).is_err(),
                "{endpoint}"
            );
        }
    }

    #[test]
    fn exact_process_must_own_the_listener_before_authorization_is_sent() {
        let temp = tempfile::tempdir().unwrap();
        let table = table();
        table
            .processes
            .lock()
            .unwrap()
            .get_mut(&42)
            .unwrap()
            .tcp_listeners
            .clear();
        let http = Arc::new(FakeHttp::default());
        let cancelled = AtomicBool::new(false);
        let binding = binding();
        let injector = injector(&temp.path().join("journal"), table, http.clone());

        assert_eq!(
            injector.inject(&request(&binding, &cancelled)),
            Outcome::Refused(Failure::StaleServer)
        );
        assert!(
            http.calls.lock().unwrap().is_empty(),
            "a listener squatter must never receive the Authorization header"
        );
    }

    const CLAIMED_SERVER: &str = "AGENT_RELAY_TEST_CLAIMED_SERVER";

    /// The body of the claimed server below: this test binary, run as its
    /// own child, waits on stdin. Run normally, it returns at once.
    #[test]
    fn claimed_server_process() {
        if std::env::var_os(CLAIMED_SERVER).is_some() {
            let _ = std::io::Read::read_to_end(&mut std::io::stdin(), &mut Vec::new());
        }
    }

    /// A real process that claims to be `opencode serve` on `listener`'s
    /// port. It owns the listener only when `owns` is set. The process is
    /// this test binary rather than a shell: macOS withholds a platform
    /// binary's environment, and a shell may exec its command, so neither
    /// keeps the exact executable, argv and environment a provider has.
    fn claimed_server(
        listener: std::net::TcpListener,
        owns: bool,
    ) -> (std::process::Child, Binding, SystemProcesses) {
        use std::os::fd::AsRawFd;
        use std::os::unix::process::CommandExt;
        let port = listener.local_addr().unwrap().port();
        let port_text = port.to_string();
        let marker = "real-listener-marker";
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "relay::opencode_existing::tests::claimed_server_process",
                "--",
                "opencode",
                "serve",
                "--hostname",
                "127.0.0.1",
                "--port",
                &port_text,
            ])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .env(CLAIMED_SERVER, "1")
            .env("AGENT_RELAY_MANAGED_SESSION_MARKER", marker)
            .env("OPENCODE_SERVER_USERNAME", "relay")
            .env("OPENCODE_SERVER_PASSWORD", "secret");
        if owns {
            let descriptor = listener.as_raw_fd();
            // SAFETY: runs after fork and before exec, and calls only the
            // async-signal-safe `fcntl(2)` so the child inherits the listener.
            unsafe {
                command.pre_exec(move || {
                    if libc::fcntl(descriptor, libc::F_SETFD, 0) == -1 {
                        Err(std::io::Error::last_os_error())
                    } else {
                        Ok(())
                    }
                });
            }
        }
        let child = command.spawn().unwrap();
        // Only the child can still own the listener from here on.
        drop(listener);
        let table = SystemProcesses::default();
        let deadline = Instant::now() + Duration::from_secs(2);
        let process = loop {
            if let Some(process) = table.process(child.id() as i32) {
                if table
                    .environment_var(process.pid, "OPENCODE_SERVER_PASSWORD")
                    .is_some()
                {
                    break process;
                }
            }
            assert!(Instant::now() < deadline, "claimed server did not start");
            std::thread::sleep(Duration::from_millis(10));
        };
        let mut binding = Binding {
            relay_workspace_id: "rw_exact".into(),
            owner_id: "owner-exact".into(),
            session_id: "ses_exact".into(),
            endpoint: format!("http://127.0.0.1:{port}/"),
            server_pid: process.pid,
            server_start: process.start,
            server_uid: process.uid,
            executable: table.executable(process.pid).unwrap(),
            directory: std::env::current_dir().unwrap(),
            project_id: "prj_exact".into(),
            opencode_workspace_id: None,
            credential_reference: String::new(),
        };
        binding.credential_reference = credential_reference(&binding, marker);
        (child, binding, table)
    }

    #[test]
    fn real_listener_owned_by_another_pid_is_not_a_credential_route() {
        // The test process keeps the listener; the claimed provider does not.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let held = listener.try_clone().unwrap();
        let (mut child, binding, table) = claimed_server(listener, false);
        let squatted = exact_process_credentials(&table, &binding);
        let _ = child.kill();
        let _ = child.wait();
        drop(held);
        assert!(
            matches!(squatted, Err(Failure::StaleServer)),
            "the endpoint listener belongs to the test process, not the claimed provider pid"
        );
    }

    #[test]
    fn real_listener_owned_by_the_claimed_pid_is_a_credential_route() {
        // The positive control for the squatter test: the same claimed
        // provider passes every check once it owns the listener itself.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let (mut child, binding, table) = claimed_server(listener, true);
        let owned = exact_process_credentials(&table, &binding);
        let _ = child.kill();
        let _ = child.wait();
        let credentials = owned.unwrap_or_else(|failure| panic!("{failure:?}"));
        assert_eq!(credentials.username, "relay");
        assert_eq!(credentials.password.expose(), "secret");
    }

    /// A plugin socket served by this test process, so the kernel's peer is
    /// this pid, answering each request from `answer` and counting POSTs.
    struct PluginServer {
        _temp: tempfile::TempDir,
        runtime: PathBuf,
        socket: PathBuf,
        posts: Arc<std::sync::atomic::AtomicUsize>,
    }

    fn plugin_server(
        answer: impl Fn(&str, &str, &[u8]) -> (u16, Vec<u8>) + Send + Sync + 'static,
    ) -> PluginServer {
        use std::os::unix::fs::PermissionsExt;
        // A Unix socket path is limited to 104 bytes on macOS.
        let temp = tempfile::tempdir_in("/tmp").unwrap();
        let runtime = temp.path().join("rt");
        fs::create_dir(&runtime).unwrap();
        fs::set_permissions(&runtime, fs::Permissions::from_mode(0o700)).unwrap();
        let socket = runtime.join(format!("{}.sock", std::process::id()));
        let listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
        let posts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counted = posts.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                let mut raw = Vec::new();
                let mut buffer = [0u8; 4096];
                let (head_end, length) = loop {
                    let read = stream.read(&mut buffer).unwrap_or(0);
                    if read == 0 {
                        break (None, 0);
                    }
                    raw.extend_from_slice(&buffer[..read]);
                    if let Some(end) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&raw[..end]).to_string();
                        let length = head
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|value| value.trim().parse::<usize>().unwrap())
                            })
                            .unwrap_or(0);
                        break (Some(end), length);
                    }
                };
                let Some(end) = head_end else { continue };
                while raw.len() < end + 4 + length {
                    let read = stream.read(&mut buffer).unwrap_or(0);
                    if read == 0 {
                        break;
                    }
                    raw.extend_from_slice(&buffer[..read]);
                }
                let head = String::from_utf8_lossy(&raw[..end]).to_string();
                let mut line = head.lines().next().unwrap().split(' ');
                let method = line.next().unwrap().to_string();
                let path = line.next().unwrap().to_string();
                if method == "POST" {
                    counted.fetch_add(1, Ordering::SeqCst);
                }
                let (status, body) = answer(&method, &path, &raw[end + 4..]);
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status} X\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(&body);
            }
        });
        PluginServer {
            _temp: temp,
            runtime,
            socket,
            posts,
        }
    }

    /// The test process as the OpenCode holding the socket: its executable
    /// reached through a link named `opencode`.
    fn plugin_table(server: &PluginServer) -> (Arc<FakeProcesses>, PathBuf) {
        let link = server.runtime.parent().unwrap().join("opencode");
        std::os::unix::fs::symlink(std::env::current_exe().unwrap(), &link).unwrap();
        let table = Arc::new(FakeProcesses::default());
        table.insert(
            std::process::id() as i32,
            FakeProcess {
                parent: 1,
                uid: crate::relay::peer::current_uid(),
                start: 555,
                executable: Some(link.clone()),
                arguments: vec!["opencode".into()],
                ..FakeProcess::default()
            },
        );
        (table, link)
    }

    fn plugin_process(
        server: &PluginServer,
        executable: &Path,
    ) -> crate::relay::opencode::OpenProcess {
        crate::relay::opencode::OpenProcess {
            pid: std::process::id() as i32,
            start: 555,
            uid: crate::relay::peer::current_uid(),
            executable: executable.to_path_buf(),
            socket: server.socket.clone(),
            sessions: Vec::new(),
        }
    }

    fn held() -> crate::relay::opencode::HeldSession {
        crate::relay::opencode::HeldSession {
            session_id: "ses_exact".into(),
            title: None,
            directory: PathBuf::from("/work/project"),
            updated_at_ms: None,
        }
    }

    #[test]
    fn http_responses_are_framed_by_length_chunks_or_close() {
        assert_eq!(
            parse_http_response(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}junk"),
            Some(HttpResponse {
                status: 200,
                body: b"{}".to_vec()
            })
        );
        assert_eq!(
            parse_http_response(
                b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n2;x=y\r\nde\r\n0\r\n\r\n"
            ),
            Some(HttpResponse { status: 200, body: b"abcde".to_vec() })
        );
        assert_eq!(
            parse_http_response(b"HTTP/1.1 204 No Content\r\n\r\n"),
            Some(HttpResponse {
                status: 204,
                body: Vec::new()
            })
        );
        assert_eq!(
            parse_http_response(b"HTTP/1.1 200 OK\r\nContent-Length: 9\r\n\r\n{}"),
            None
        );
        assert_eq!(parse_http_response(b"SSH-2.0\r\n\r\n"), None);
        assert_eq!(
            parse_http_response(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n9\r\nabc"),
            None
        );
    }

    #[test]
    fn a_plugin_socket_answers_only_when_its_peer_is_the_named_pid() {
        let server = plugin_server(|_, path, _| (200, path.as_bytes().to_vec()));
        let url = format!("unix:{}/session/status", server.socket.display());
        assert_eq!(
            SystemHttp.request(
                "GET",
                &url,
                "",
                Path::new("/w"),
                None,
                Duration::from_secs(5)
            ),
            Some(HttpResponse {
                status: 200,
                body: b"/session/status".to_vec()
            })
        );
        // The same listener under another pid's name is refused.
        let other = server.runtime.join("1.sock");
        std::os::unix::fs::symlink(&server.socket, &other).unwrap();
        let url = format!("unix:{}/session/status", other.display());
        assert_eq!(
            SystemHttp.request(
                "GET",
                &url,
                "",
                Path::new("/w"),
                None,
                Duration::from_secs(5)
            ),
            None
        );
        // A request path is never smuggled with whitespace.
        let url = format!("unix:{}/session/status HTTP/1.1", server.socket.display());
        assert_eq!(
            SystemHttp.request(
                "GET",
                &url,
                "",
                Path::new("/w"),
                None,
                Duration::from_secs(5)
            ),
            None
        );
    }

    #[test]
    fn a_plugin_route_is_pinned_to_its_process_directory_and_socket() {
        use std::os::unix::fs::PermissionsExt;
        let server = plugin_server(|_, _, _| (200, session()));
        let (table, executable) = plugin_table(&server);
        let process = plugin_process(&server, &executable);
        let binding = crate::relay::opencode::binding(
            &*table,
            &SystemHttp,
            &process,
            &held(),
            "rw_exact",
            "owner-exact",
        )
        .unwrap();
        assert_eq!(
            binding.endpoint,
            format!("unix:{}", server.socket.display())
        );
        assert_eq!(binding.project_id, "prj_exact");
        assert_eq!(binding.opencode_workspace_id.as_deref(), Some("wrk_exact"));
        assert!(binding_valid(&binding, "rw_exact"));
        assert_eq!(route_authorization(&*table, &binding), Ok(String::new()));

        // Another start of the same pid is another process.
        let mut restarted = binding.clone();
        restarted.server_start = 556;
        assert_eq!(
            route_authorization(&*table, &restarted),
            Err(Failure::StaleServer)
        );
        // A socket not named for the pid is not a plugin route.
        let mut renamed = binding.clone();
        renamed.endpoint = format!("unix:{}", server.runtime.join("1.sock").display());
        assert_eq!(
            route_authorization(&*table, &renamed),
            Err(Failure::InvalidBinding)
        );
        // A directory others can enter is not private.
        fs::set_permissions(&server.runtime, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(
            route_authorization(&*table, &binding),
            Err(Failure::StaleServer)
        );
        fs::set_permissions(&server.runtime, fs::Permissions::from_mode(0o700)).unwrap();
        // A socket bound again has a new inode: the old binding is stale.
        fs::remove_file(&server.socket).unwrap();
        let _again = std::os::unix::net::UnixListener::bind(&server.socket).unwrap();
        assert_eq!(
            route_authorization(&*table, &binding),
            Err(Failure::StaleServer)
        );
    }

    #[test]
    fn a_plugin_delivery_completes_once_and_is_never_resent() {
        let temp = tempfile::tempdir().unwrap();
        let prompted = Arc::new(Mutex::new(None::<Value>));
        let seen = prompted.clone();
        let server = plugin_server(move |method, path, body| {
            let prompt = seen.lock().unwrap().clone();
            let user_id = prompt
                .as_ref()
                .and_then(|value| value["messageID"].as_str().map(str::to_string));
            match (method, path) {
                ("GET", "/session/ses_exact") => (200, session()),
                ("GET", "/session/status") => (200, br#"{}"#.to_vec()),
                ("POST", "/session/ses_exact/prompt_async") => {
                    *seen.lock().unwrap() = serde_json::from_slice(body).ok();
                    (204, Vec::new())
                }
                ("GET", "/session/ses_exact/message") => (
                    200,
                    serde_json::to_vec(&json!([{
                        "info": {"id": "msg_assistant", "sessionID": "ses_exact", "role": "assistant", "parentID": user_id, "finish": "stop", "time": {"created": 1, "completed": 2}},
                        "parts": [
                            {"type": "text", "text": "done"},
                            {"sessionID": "ses_exact", "messageID": "msg_assistant", "type": "step-finish", "reason": "stop"}
                        ]
                    }]))
                    .unwrap(),
                ),
                ("GET", other) if user_id.as_deref().is_some_and(|id| other.ends_with(id)) => (
                    200,
                    serde_json::to_vec(&json!({
                        "info": {"id": user_id, "sessionID": "ses_exact", "role": "user"},
                        "parts": [{"type": "text", "text": "please inspect this"}]
                    }))
                    .unwrap(),
                ),
                _ => (404, Vec::new()),
            }
        });
        let (table, executable) = plugin_table(&server);
        let binding = crate::relay::opencode::binding(
            &*table,
            &SystemHttp,
            &plugin_process(&server, &executable),
            &held(),
            "rw_exact",
            "owner-exact",
        )
        .unwrap();
        let injector = OpenCodeInjector::new(
            table,
            Arc::new(SystemHttp),
            Arc::new(SystemClock),
            &temp.path().join("journal"),
        )
        .unwrap();
        let cancelled = AtomicBool::new(false);
        let request = request(&binding, &cancelled);
        let completed = Outcome::Completed {
            receipt_id: format!("opencode:{}", OpenCodeInjector::message_id(&request)),
        };
        assert_eq!(injector.inject(&request), completed);
        let prompt = prompted.lock().unwrap().clone().unwrap();
        assert_eq!(
            prompt["messageID"],
            json!(OpenCodeInjector::message_id(&request))
        );
        assert_eq!(
            prompt["parts"],
            json!([{"type": "text", "text": "please inspect this"}])
        );
        // The receipt is replayed from the journal; OpenCode is not asked again.
        assert_eq!(injector.inject(&request), completed);
        assert_eq!(server.posts.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_turn_longer_than_the_receipt_window_is_delivered_once_the_message_lands() {
        let temp = tempfile::tempdir().unwrap();
        let http = Arc::new(FakeHttp::default());
        http.push(200, session());
        http.push(200, br#"{}"#.to_vec());
        http.push(204, Vec::new());
        let cancelled = AtomicBool::new(false);
        let binding = binding();
        let request = request(&binding, &cancelled);
        let user_id = OpenCodeInjector::message_id(&request);
        // Not there yet, a dropped read and a busy server are read past...
        http.push(404, Vec::new());
        http.responses.lock().unwrap().push_back(None);
        http.push(503, Vec::new());
        // ...and the exact message lands while its turn has not finished:
        // no assistant message exists, and none is ever asked for.
        http.push(
            200,
            serde_json::to_vec(&json!({
                "info": {"id": user_id, "sessionID": "ses_exact", "role": "user"},
                "parts": [{"type": "text", "text": "please inspect this"}]
            }))
            .unwrap(),
        );
        let injector = injector(&temp.path().join("journal"), table(), http.clone());
        let delivered = Outcome::Completed {
            receipt_id: format!("opencode:{user_id}"),
        };
        assert_eq!(injector.inject(&request), delivered);
        assert_eq!(injector.inject(&request), delivered);
        let calls = http.calls.lock().unwrap();
        assert_eq!(calls.iter().filter(|call| call.0 == "POST").count(), 1);
        assert!(calls.iter().all(|call| !call.1.ends_with("/message")));
        assert!(http.responses.lock().unwrap().is_empty());
    }

    #[test]
    fn a_message_that_never_lands_stays_in_doubt_and_is_not_resent() {
        let temp = tempfile::tempdir().unwrap();
        let http = Arc::new(FakeHttp::default());
        http.push(200, session());
        http.push(200, br#"{}"#.to_vec());
        http.push(204, Vec::new());
        for _ in 0..20 {
            http.push(404, Vec::new());
        }
        let cancelled = AtomicBool::new(false);
        let binding = binding();
        let request = request(&binding, &cancelled);
        let injector = injector(&temp.path().join("journal"), table(), http.clone());
        assert_eq!(
            injector.inject(&request),
            Outcome::InDoubt(Failure::TimedOut)
        );
        // A later attempt reads, finds nothing proven, and never posts again.
        http.push(200, session());
        http.push(404, Vec::new());
        assert_eq!(
            injector.inject(&request),
            Outcome::InDoubt(Failure::PriorAttemptUncertain)
        );
        let posts = http
            .calls
            .lock()
            .unwrap()
            .iter()
            .filter(|call| call.0 == "POST")
            .count();
        assert_eq!(posts, 1);
    }
}
