//! Grok's ACP leader route for an already-open session.
//!
//! A binding comes from one of two registries: a leader the probe launched
//! (`managed_sessions`), or an already-open leader `enablement::Registry`
//! stored with immutable proof. Every binding is rechecked before load and
//! immediately before `session/prompt`; a failed or uncertain prompt is never
//! resent.

mod proof;
use proof::leader_proves;
pub(crate) use proof::verify_title_binding;

#[cfg(unix)]
use super::platform::UnixStream;
use super::platform::{FileTypeExt, MetadataExt};
use super::{Adapter, Binding, Failure, Outcome, Provider, Request, Transport};
use crate::relay::peer::current_uid;
use crate::relay::process::{ProcessTable, SystemProcesses};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Write};
#[cfg(unix)]
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

pub trait Authority: Send + Sync {
    fn verify(&self, binding: &Binding) -> bool;
    /// Whether the bound leader process is positively gone or replaced, as
    /// opposed to failing a check for now. Only a dead binding may be
    /// replaced; an unproved live one is hidden and kept.
    fn dead(&self, binding: &Binding) -> bool {
        !self.verify(binding)
    }
}

/// Kernel-backed verification of the exact Grok leader and Unix socket.
/// Session/cwd/model are then checked by ACP load/initialize responses.
pub struct SystemAuthority {
    processes: Arc<dyn ProcessTable>,
}

impl Default for SystemAuthority {
    fn default() -> Self {
        Self {
            processes: Arc::new(SystemProcesses::default()),
        }
    }
}

impl SystemAuthority {
    pub fn new(processes: Arc<dyn ProcessTable>) -> Self {
        Self { processes }
    }
}

impl Authority for SystemAuthority {
    fn verify(&self, binding: &Binding) -> bool {
        // Only a leader this probe launched carries the marker its binding
        // was minted from.
        leader_proves(&*self.processes, binding, false, |marker| {
            marker
                .map(|value| credential_reference(binding, &value))
                .as_deref()
                == Some(binding.credential_reference.as_str())
        })
    }
}

/// Kernel-backed verification of an already-open Grok leader the probe did
/// not launch. It proves the same process, executable, argv, socket and peer
/// identity as `SystemAuthority`, but only for a leader without the managed
/// marker, so neither route can verify the other's leader.
pub struct ExistingLeaderAuthority {
    processes: Arc<dyn ProcessTable>,
}

impl ExistingLeaderAuthority {
    pub fn new(processes: Arc<dyn ProcessTable>) -> Self {
        Self { processes }
    }
}

impl Authority for ExistingLeaderAuthority {
    fn dead(&self, binding: &Binding) -> bool {
        match self.processes.process(binding.leader_pid) {
            Some(process) => {
                process.start != binding.leader_start || process.uid != binding.owner_uid
            }
            None => self.processes.process_gone(binding.leader_pid),
        }
    }

    fn verify(&self, binding: &Binding) -> bool {
        // "No marker" must mean the kernel showed an environment without
        // one. An unreadable environment could hide a managed leader's.
        self.processes.environment_readable(binding.leader_pid)
            && leader_proves(&*self.processes, binding, true, |marker| {
                marker.is_none() && binding.credential_reference == existing_reference(binding)
            })
    }
}

/// Whether argv is a `grok agent leader` process's.
pub(crate) fn is_leader(arguments: &[String]) -> bool {
    arguments.windows(2).any(|pair| pair == ["agent", "leader"])
}

/// The socket of a `grok agent leader` process: the one its argv names, or
/// `default` when it names none, as the leader a `grok --leader` TUI spawns
/// listens on its home's `leader.sock`. Two `--leader-socket` arguments name
/// no candidate. Used only to find a candidate; the authority proves it.
pub(crate) fn leader_socket(
    arguments: &[String],
    default: Option<&Path>,
) -> Option<std::path::PathBuf> {
    if !is_leader(arguments) {
        return None;
    }
    let mut sockets = arguments
        .windows(2)
        .filter(|pair| pair[0] == "--leader-socket")
        .map(|pair| std::path::PathBuf::from(&pair[1]));
    let Some(socket) = sockets.next() else {
        return default.map(Path::to_path_buf);
    };
    sockets.next().is_none().then_some(socket)
}

/// Grok's home for `pid`: its `GROK_HOME`, else `~/.grok` of its own `HOME`.
/// Both are read from that process, so the probe's environment decides
/// nothing. A relative path, or an environment the kernel will not show,
/// names nothing.
pub(crate) fn grok_home(processes: &dyn ProcessTable, pid: i32) -> Option<PathBuf> {
    let home = match processes.environment_var(pid, "GROK_HOME") {
        Some(grok_home) if !grok_home.trim().is_empty() => PathBuf::from(grok_home.trim()),
        _ => Path::new(processes.environment_var(pid, "HOME")?.trim()).join(".grok"),
    };
    home.is_absolute().then_some(home)
}

/// Where a leader that names no `--leader-socket` listens: `leader.sock` in
/// [`grok_home`]. `None` when that home cannot be read.
pub(crate) fn default_leader_socket(
    processes: &dyn ProcessTable,
    pid: i32,
) -> Option<std::path::PathBuf> {
    grok_home(processes, pid).map(|home| home.join("leader.sock"))
}

/// The already-open leaders of `uid`: `grok agent leader` processes whose
/// environment the kernel shows without the managed marker. Found from the
/// process table alone; nothing here proves one.
pub(crate) fn open_leader_pids(processes: &dyn ProcessTable, uid: u32) -> Vec<i32> {
    // Grok's leader socket is Unix-only: Windows lists no open leader.
    if !super::platform::SUPPORTED {
        return Vec::new();
    }
    processes
        .all_pids()
        .into_iter()
        .filter(|pid| {
            processes
                .process(*pid)
                .is_some_and(|process| process.uid == uid)
                && is_leader(&processes.arguments(*pid))
                && carries_managed_marker(processes, *pid) == Some(false)
        })
        .collect()
}

/// Whether `pid` carries the managed launch marker. `None` when the kernel
/// would not show its environment, which is never read as "no marker".
pub(crate) fn carries_managed_marker(processes: &dyn ProcessTable, pid: i32) -> Option<bool> {
    processes
        .environment_readable(pid)
        .then(|| processes.environment_var(pid, MANAGED_MARKER).is_some())
}

/// Whether a leader's argv binds it to `socket_path`: it names that socket,
/// or names none while `default` is that socket.
fn leader_arguments_match(
    arguments: &[String],
    socket_path: &Path,
    default: Option<&Path>,
) -> bool {
    leader_socket(arguments, default).is_some_and(|socket| socket == socket_path)
}

pub(crate) const MANAGED_MARKER: &str = "AGENT_RELAY_MANAGED_SESSION_MARKER";
const MANAGED_REFERENCE: &str = "probe:grok:";
const EXISTING_REFERENCE: &str = "existing:grok:";

/// Whether `value` names one of the two Grok routes: a probe-managed leader
/// or an already-open one. Each authority accepts only its own namespace.
pub(crate) fn is_credential_reference(value: &str) -> bool {
    [MANAGED_REFERENCE, EXISTING_REFERENCE]
        .iter()
        .any(|prefix| {
            value.strip_prefix(prefix).is_some_and(|digest| {
                digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit())
            })
        })
}

/// The process-only marker authenticates the complete kernel/socket launch
/// identity. Model and version are pinned by provider initialize readback.
pub(crate) fn credential_reference(binding: &Binding, marker: &str) -> String {
    identity_reference(MANAGED_REFERENCE, binding, marker)
}

/// The reference of an already-open leader. It has no marker, so it pins
/// only the kernel/socket identity that `ExistingLeaderAuthority` rechecks.
pub fn existing_reference(binding: &Binding) -> String {
    identity_reference(EXISTING_REFERENCE, binding, "")
}

fn identity_reference(prefix: &str, binding: &Binding, marker: &str) -> String {
    let mut digest = Sha256::new();
    for part in [
        marker,
        &binding.workspace_id,
        &binding.owner_id,
        &binding.session_id,
        &binding.owner_uid.to_string(),
        binding.cwd.to_string_lossy().as_ref(),
        binding.executable.to_string_lossy().as_ref(),
        &binding.leader_pid.to_string(),
        &binding.leader_start.to_string(),
        binding.socket_path.to_string_lossy().as_ref(),
        &binding.socket_device.to_string(),
        &binding.socket_inode.to_string(),
    ] {
        digest.update(part.as_bytes());
        digest.update([0]);
    }
    format!("{prefix}{:x}", digest.finalize())
}

/// Verify the connected socket peer, not only the pathname's metadata. A
/// replacement listener must not inherit an otherwise valid leader binding.
#[cfg(unix)]
fn socket_peer_matches(binding: &Binding) -> bool {
    let Ok(peer) = UnixStream::connect(&binding.socket_path) else {
        return false;
    };
    let fd = peer.as_raw_fd();
    #[cfg(target_os = "linux")]
    {
        let mut credentials = libc::ucred {
            pid: 0,
            uid: 0,
            gid: 0,
        };
        let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
        let status = unsafe {
            libc::getsockopt(
                fd,
                libc::SOL_SOCKET,
                libc::SO_PEERCRED,
                &mut credentials as *mut _ as *mut libc::c_void,
                &mut length,
            )
        };
        status == 0
            && length as usize == std::mem::size_of::<libc::ucred>()
            && credentials.uid == binding.owner_uid
            && credentials.pid == binding.leader_pid
    }
    #[cfg(target_os = "macos")]
    {
        let mut uid = 0;
        let mut gid = 0;
        let status = unsafe { libc::getpeereid(fd, &mut uid, &mut gid) };
        // The pid that holds the listening end. Several leaders of one Grok
        // home can share a socket path, as an old leader keeps running after
        // a new one replaced its socket file; only this pid answers on it.
        let mut pid: libc::pid_t = 0;
        let mut length = std::mem::size_of::<libc::pid_t>() as libc::socklen_t;
        let pid_status = unsafe {
            libc::getsockopt(
                fd,
                libc::SOL_LOCAL,
                libc::LOCAL_PEERPID,
                &mut pid as *mut _ as *mut libc::c_void,
                &mut length,
            )
        };
        status == 0
            && uid == binding.owner_uid
            && pid_status == 0
            && length as usize == std::mem::size_of::<libc::pid_t>()
            && pid == binding.leader_pid
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = (fd, binding);
        false
    }
}

/// Grok's leader listens on a Unix socket, which Windows has none of: no
/// binding is ever proved here, and the route is reported unavailable.
#[cfg(windows)]
fn socket_peer_matches(_binding: &Binding) -> bool {
    false
}

pub trait AcpTransport: Send + Sync {
    fn prompt(&self, binding: &Binding, text: &str, timeout: Duration) -> Outcome;
}

pub struct GrokAdapter {
    workspace_id: String,
    owner_id: String,
    owner_uid: u32,
    authority: Arc<dyn Authority>,
    transport: Arc<dyn AcpTransport>,
}

impl GrokAdapter {
    pub fn new(
        workspace_id: String,
        owner_id: String,
        owner_uid: u32,
        authority: Arc<dyn Authority>,
        transport: Arc<dyn AcpTransport>,
    ) -> Self {
        Self {
            workspace_id,
            owner_id,
            owner_uid,
            authority,
            transport,
        }
    }
}

impl Adapter for GrokAdapter {
    fn provider(&self) -> Provider {
        Provider::Grok
    }

    fn inject(&self, request: &Request<'_>, _command_id: &str) -> Outcome {
        if request.binding.provider != Provider::Grok
            || request.binding.transport != Transport::Acp
            || request.binding.workspace_id != self.workspace_id
            || request.binding.owner_id != self.owner_id
            || request.binding.owner_uid != self.owner_uid
            || !self.authority.verify(request.binding)
        {
            return Outcome::Refused(Failure::IdentityMismatch);
        }
        self.transport
            .prompt(request.binding, request.text, request.timeout)
    }
}

/// The real ACP stdio client. It inherits no credential environment and never
/// surfaces provider frames or stderr. In particular,
/// `_x.ai/mcp/servers_updated` is discarded before diagnostics can observe it.
pub struct SystemAcpTransport {
    authority: Arc<dyn Authority>,
}

impl SystemAcpTransport {
    pub fn new(authority: Arc<dyn Authority>) -> Self {
        Self { authority }
    }
}

/// Read the provider-minted model/version and prove that the requested
/// resident session can be loaded through the exact probe-owned leader. No
/// prompt is sent, so this is safe for picker registration and restart checks.
pub fn inspect_session(
    binding: &Binding,
    authority: Arc<dyn Authority>,
    timeout: Duration,
) -> Result<(String, String), Failure> {
    if !authority.verify(binding) {
        return Err(Failure::IdentityMismatch);
    }
    let mut client = LeaderClient::start(&binding.executable, &binding.socket_path, &binding.cwd)
        .ok_or(Failure::EndpointUnavailable)?;
    let deadline = Instant::now() + timeout;
    let initialized = match client.initialize(deadline) {
        Some(Ok(initialized)) => initialized,
        Some(Err(())) => return Err(Failure::EndpointUnavailable),
        None => return Err(Failure::TimedOut),
    };
    let (model, version) = leader_identity(&initialized).ok_or(Failure::IdentityMismatch)?;
    ensure_budget(deadline).map_err(|_| Failure::TimedOut)?;
    let loaded = client.load(&binding.session_id, &binding.cwd, deadline);
    validate_loaded_response(loaded, &binding.session_id).map_err(|outcome| match outcome {
        Outcome::Refused(failure)
        | Outcome::Retry(failure)
        | Outcome::Waiting(failure)
        | Outcome::InDoubt(failure) => failure,
        Outcome::Delivered { .. } => Failure::ProviderRefused,
    })?;
    if !authority.verify(binding) {
        return Err(Failure::IdentityMismatch);
    }
    Ok((model, version))
}

/// The model and version an `initialize` answer of protocol version 1
/// reports; `None` for any other answer.
pub(crate) fn leader_identity(initialized: &Value) -> Option<(String, String)> {
    if initialized.get("protocolVersion").and_then(Value::as_u64) != Some(1) {
        return None;
    }
    let model = text_at(
        initialized,
        &[
            &["_meta", "modelState", "currentModelId"],
            &["modelState", "currentModelId"],
        ],
    )
    .filter(|value| super::printable(value, 256))?;
    let version = text_at(initialized, &[&["_meta", "agentVersion"]])
        .filter(|value| super::printable(value, 256))?;
    Some((model, version))
}

/// An ACP stdio client of one Grok leader: `grok agent --always-approve
/// --leader --leader-socket <socket> stdio`. It inherits no credential
/// environment, never surfaces stderr, and is killed when dropped.
pub(crate) struct LeaderClient {
    stdin: ChildStdin,
    receiver: mpsc::Receiver<Event>,
    _child: ChildGuard,
}

impl LeaderClient {
    pub(crate) fn start(executable: &Path, socket: &Path, cwd: &Path) -> Option<LeaderClient> {
        let mut command = Command::new(executable);
        command
            .args(["agent", "--always-approve", "--leader", "--leader-socket"])
            .arg(socket)
            .arg("stdio")
            .current_dir(cwd)
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        for key in ["HOME", "PATH"] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        let mut child = ChildGuard(command.spawn().ok()?);
        let (Some(stdin), Some(stdout)) = (child.0.stdin.take(), child.0.stdout.take()) else {
            return None;
        };
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if sender.send(decode_event(&line)).is_err() {
                    break;
                }
            }
        });
        Some(LeaderClient {
            stdin,
            receiver,
            _child: child,
        })
    }

    /// One request's answer: `Some(Err)` when it was an error or could not
    /// be sent, `None` when none came by `deadline`.
    pub(crate) fn request(
        &mut self,
        method: &str,
        params: Value,
        deadline: Instant,
    ) -> Option<Result<Value, ()>> {
        if Instant::now() >= deadline {
            return None;
        }
        let Some(id) = request_id() else {
            return Some(Err(()));
        };
        if !write_request(&mut self.stdin, &id, method, params) {
            return Some(Err(()));
        }
        response(&self.receiver, deadline, &id)
    }

    pub(crate) fn initialize(&mut self, deadline: Instant) -> Option<Result<Value, ()>> {
        let client = json!({"name":"agent-relay-desktop","version":env!("CARGO_PKG_VERSION")});
        let params = json!({"protocolVersion": 1, "clientCapabilities": {}, "clientInfo": client});
        self.request("initialize", params, deadline)
    }

    fn load(&mut self, session: &str, cwd: &Path, deadline: Instant) -> Option<Result<Value, ()>> {
        let params = json!({"sessionId": session, "cwd": cwd, "mcpServers": []});
        self.request("session/load", params, deadline)
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Event {
    Ignored,
    Response {
        id: String,
        result: Option<Value>,
        error: bool,
    },
    Consumed {
        prompt_id: String,
    },
    Completed {
        prompt_id: String,
        stop_reason: String,
        model_id: Option<String>,
    },
    /// `_x.ai/queue/changed`: the prompts the leader holds for `session_id`,
    /// queued or running, as (server prompt id, text).
    Queued {
        session_id: Option<String>,
        prompts: Vec<(String, String)>,
    },
    /// `user_message_chunk`: `session_id` recorded a prompt with this text.
    Echoed {
        session_id: Option<String>,
        text: String,
    },
    Other,
}

pub(crate) fn text_at(value: &Value, paths: &[&[&str]]) -> Option<String> {
    paths.iter().find_map(|path| {
        let mut value = value;
        for component in *path {
            value = value.get(*component)?;
        }
        value.as_str().map(str::to_owned)
    })
}

fn u64_at(value: &Value, paths: &[&[&str]]) -> Option<u64> {
    paths.iter().find_map(|path| {
        let mut value = value;
        for component in *path {
            value = value.get(*component)?;
        }
        value.as_u64()
    })
}

pub(crate) fn loaded_session_id(value: &Value) -> Option<String> {
    text_at(value, &[&["sessionId"], &["_meta", "sessionId"]])
}

fn validate_loaded_response(
    response: Option<Result<Value, ()>>,
    expected_session_id: &str,
) -> Result<(), Outcome> {
    match response {
        None => Err(Outcome::Retry(Failure::TimedOut)),
        Some(Err(())) => Err(Outcome::Retry(Failure::EndpointUnavailable)),
        Some(Ok(loaded)) if loaded_session_id(&loaded).as_deref() == Some(expected_session_id) => {
            Ok(())
        }
        Some(Ok(_)) => Err(Outcome::Refused(Failure::IdentityMismatch)),
    }
}

fn ensure_budget(deadline: Instant) -> Result<(), Outcome> {
    (Instant::now() < deadline)
        .then_some(())
        .ok_or(Outcome::Retry(Failure::TimedOut))
}

fn decode_event(line: &str) -> Event {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return Event::Other;
    };
    let method = value.get("method").and_then(Value::as_str);
    if method == Some("_x.ai/mcp/servers_updated") {
        return Event::Ignored;
    }
    if let Some(id) = value.get("id").and_then(Value::as_str) {
        return Event::Response {
            id: id.to_owned(),
            result: value.get("result").cloned(),
            error: value.get("error").is_some(),
        };
    }
    let update_kind = text_at(
        &value,
        &[
            &["params", "update", "sessionUpdate"],
            &["params", "update", "type"],
        ],
    );
    if method == Some("session/update") && update_kind.as_deref() == Some("user_message_chunk") {
        return text_at(&value, &[&["params", "update", "content", "text"]]).map_or(
            Event::Other,
            |text| Event::Echoed {
                session_id: text_at(&value, &[&["params", "sessionId"]]),
                text,
            },
        );
    }
    if method == Some("session/update") && update_kind.as_deref() == Some("agent_message_chunk") {
        return text_at(
            &value,
            &[
                &["params", "promptId"],
                &["params", "_meta", "promptId"],
                &["params", "update", "promptId"],
                &["params", "update", "_meta", "promptId"],
            ],
        )
        .map_or(Event::Other, |prompt_id| Event::Consumed { prompt_id });
    }
    if method == Some("_x.ai/queue/changed") {
        let params = value.get("params").cloned().unwrap_or(Value::Null);
        let mut prompts = Vec::new();
        if let (Some(id), Some(text)) = (
            text_at(&params, &[&["runningPromptId"]]),
            text_at(&params, &[&["runningText"]]),
        ) {
            prompts.push((id, text));
        }
        for entry in params["entries"].as_array().into_iter().flatten() {
            if let (Some(id), Some(text)) =
                (text_at(entry, &[&["id"]]), text_at(entry, &[&["text"]]))
            {
                prompts.push((id, text));
            }
        }
        return Event::Queued {
            session_id: text_at(&params, &[&["sessionId"]]),
            prompts,
        };
    }
    if method == Some("_x.ai/session/prompt_complete") {
        let prompt_id = text_at(
            &value,
            &[&["params", "promptId"], &["params", "_meta", "promptId"]],
        );
        let stop_reason = text_at(
            &value,
            &[
                &["params", "stopReason"],
                &["params", "result", "stopReason"],
            ],
        );
        if let (Some(prompt_id), Some(stop_reason)) = (prompt_id, stop_reason) {
            return Event::Completed {
                prompt_id,
                stop_reason,
                model_id: text_at(
                    &value,
                    &[
                        &["params", "modelId"],
                        &["params", "result", "modelId"],
                        &["params", "_meta", "modelId"],
                    ],
                ),
            };
        }
    }
    Event::Other
}

fn request_id() -> Option<String> {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).ok()?;
    Some(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn write_request(stdin: &mut impl Write, id: &str, method: &str, params: Value) -> bool {
    let request = json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
    serde_json::to_writer(&mut *stdin, &request).is_ok()
        && stdin.write_all(b"\n").is_ok()
        && stdin.flush().is_ok()
}

fn recv_event(receiver: &mpsc::Receiver<Event>, deadline: Instant) -> Option<Event> {
    loop {
        let left = deadline.checked_duration_since(Instant::now())?;
        match receiver.recv_timeout(left).ok()? {
            Event::Ignored | Event::Other => continue,
            event => return Some(event),
        }
    }
}

fn response(
    receiver: &mpsc::Receiver<Event>,
    deadline: Instant,
    expected: &str,
) -> Option<Result<Value, ()>> {
    loop {
        match recv_event(receiver, deadline)? {
            Event::Response { id, result, error } if id == expected => {
                return Some(if error { Err(()) } else { result.ok_or(()) });
            }
            _ => continue,
        }
    }
}

const MAX_PROMPT_EVIDENCE: usize = 64;

#[derive(Default)]
struct PromptEvidence {
    server_prompt_id: Option<String>,
    consumed: HashSet<String>,
    completed: HashMap<String, Vec<(String, Option<String>)>>,
    /// The server prompt id under which the leader holds exactly our text,
    /// from its queue notifications: the message is in the session even
    /// when the turn outlives the receipt window.
    accepted: Option<String>,
    /// The session recorded our exact text as a user message.
    echoed: bool,
    /// Prompt ids the leader held before our `session/prompt` was written:
    /// an earlier prompt with the same text is never our receipt.
    known_before_send: HashSet<String>,
}

impl PromptEvidence {
    /// Notes the leader queuing or running our exact prompt text in our
    /// session, and that session recording it. A leader holds several
    /// sessions, so a notification for another session, or one naming no
    /// session, is never our receipt.
    fn note_accepted(&mut self, event: &Event, text: &str, session: &str) {
        match event {
            Event::Queued {
                session_id,
                prompts,
            } if session_id.as_deref() == Some(session) => {
                if let Some((id, _)) = prompts
                    .iter()
                    .find(|(id, queued)| queued == text && !self.known_before_send.contains(id))
                {
                    if self
                        .accepted
                        .as_deref()
                        .is_none_or(|existing| existing == id)
                    {
                        self.accepted = Some(id.clone());
                    }
                }
            }
            Event::Echoed {
                session_id,
                text: echoed,
            } if session_id.as_deref() == Some(session) && echoed == text => self.echoed = true,
            _ => {}
        }
    }

    /// The receipt once the session has recorded our prompt under a known
    /// server prompt id: it is in the conversation, and the turn runs on
    /// whether or not this client stays.
    fn recorded(&self) -> Option<String> {
        self.echoed.then(|| self.accepted.clone()).flatten()
    }

    fn record(
        &mut self,
        event: Event,
        rpc_id: &str,
        expected_model: &str,
    ) -> Result<Option<String>, Failure> {
        match event {
            Event::Consumed { prompt_id } => {
                if self.consumed.len() >= MAX_PROMPT_EVIDENCE && !self.consumed.contains(&prompt_id)
                {
                    return Err(Failure::ProviderRefused);
                }
                self.consumed.insert(prompt_id);
            }
            Event::Completed {
                prompt_id,
                stop_reason,
                model_id,
            } => {
                if self.completed.values().map(Vec::len).sum::<usize>() >= MAX_PROMPT_EVIDENCE {
                    return Err(Failure::ProviderRefused);
                }
                self.completed
                    .entry(prompt_id)
                    .or_default()
                    .push((stop_reason, model_id));
            }
            Event::Response { id, result, error } if id == rpc_id => {
                let Some(result) = result.filter(|_| !error) else {
                    return Err(Failure::ProviderRefused);
                };
                let prompt_id = text_at(
                    &result,
                    &[
                        &["promptId"],
                        &["_meta", "promptId"],
                        &["result", "promptId"],
                        &["result", "_meta", "promptId"],
                    ],
                )
                .filter(|value| super::printable(value, 256))
                .ok_or(Failure::ProviderRefused)?;
                let model = text_at(
                    &result,
                    &[&["modelId"], &["_meta", "modelId"], &["usage", "modelId"]],
                );
                let stop = text_at(&result, &[&["stopReason"], &["_meta", "stopReason"]]);
                let output_tokens = u64_at(
                    &result,
                    &[
                        &["outputTokens"],
                        &["_meta", "outputTokens"],
                        &["usage", "outputTokens"],
                    ],
                );
                if stop.as_deref() != Some("end_turn")
                    || model.as_deref() != Some(expected_model)
                    || output_tokens.is_none()
                    || self
                        .server_prompt_id
                        .as_deref()
                        .is_some_and(|existing| existing != prompt_id)
                {
                    return Err(Failure::ProviderRefused);
                }
                self.server_prompt_id = Some(prompt_id);
            }
            _ => {}
        }

        let Some(prompt_id) = self.server_prompt_id.as_deref() else {
            return Ok(None);
        };
        if !self.consumed.contains(prompt_id) {
            return Ok(None);
        }
        let Some(completions) = self.completed.get(prompt_id) else {
            return Ok(None);
        };
        if completions.iter().any(|(stop, model)| {
            stop != "end_turn"
                || model
                    .as_deref()
                    .is_some_and(|model| model != expected_model)
        }) {
            return Err(Failure::ProviderRefused);
        }
        Ok(completions
            .iter()
            .any(|(stop, _)| stop == "end_turn")
            .then(|| prompt_id.to_owned()))
    }
}

struct ChildGuard(Child);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

impl AcpTransport for SystemAcpTransport {
    fn prompt(&self, binding: &Binding, text: &str, timeout: Duration) -> Outcome {
        if !self.authority.verify(binding) {
            return Outcome::Refused(Failure::IdentityMismatch);
        }
        let Some(mut client) =
            LeaderClient::start(&binding.executable, &binding.socket_path, &binding.cwd)
        else {
            return Outcome::Retry(Failure::EndpointUnavailable);
        };
        let deadline = Instant::now() + timeout;
        let Some(Ok(initialized)) = client.initialize(deadline) else {
            return Outcome::Retry(Failure::EndpointUnavailable);
        };
        let pinned = (binding.model_id.clone(), binding.agent_version.clone());
        if leader_identity(&initialized) != Some(pinned) {
            return Outcome::Refused(Failure::IdentityMismatch);
        }
        let loaded = client.load(&binding.session_id, &binding.cwd, deadline);
        if let Err(outcome) = validate_loaded_response(loaded, &binding.session_id) {
            return outcome;
        }
        if !self.authority.verify(binding) {
            return Outcome::Refused(Failure::IdentityMismatch);
        }
        client.prompt(&binding.session_id, &binding.model_id, text, deadline)
    }
}

impl LeaderClient {
    /// Sends `text` to `session` as one `session/prompt` and waits, until
    /// `deadline`, for the leader's receipt for it. Never sent twice.
    pub(crate) fn prompt(
        &mut self,
        session: &str,
        model: &str,
        text: &str,
        deadline: Instant,
    ) -> Outcome {
        // Prompts the leader already holds for this session cannot be ours.
        let mut known_before_send = HashSet::new();
        while let Ok(event) = self.receiver.try_recv() {
            if let Event::Queued { prompts, .. } = &event {
                known_before_send.extend(prompts.iter().map(|(id, _)| id.clone()));
            }
        }
        if let Err(outcome) = ensure_budget(deadline) {
            return outcome;
        }
        let Some(prompt_rpc_id) = request_id() else {
            return Outcome::Retry(Failure::EndpointUnavailable);
        };
        let params = json!({"sessionId": session, "prompt": [{"type":"text","text":text}]});
        if !write_request(&mut self.stdin, &prompt_rpc_id, "session/prompt", params) {
            return Outcome::InDoubt(Failure::PriorAttemptUncertain);
        }
        let mut evidence = PromptEvidence {
            known_before_send,
            ..PromptEvidence::default()
        };
        while Instant::now() < deadline {
            let Some(event) = recv_event(&self.receiver, deadline) else {
                break;
            };
            evidence.note_accepted(&event, text, session);
            // The session has our prompt under the leader's own id: that is
            // the receipt. A session can answer on the relay-send socket
            // within seconds, and the reply is allowed only once this
            // delivery is settled, so the turn is not waited for.
            if let Some(prompt_id) = evidence.recorded() {
                return Outcome::Delivered {
                    receipt_id: format!("grok-acp:{prompt_id}"),
                };
            }
            let receipt = match evidence.record(event, &prompt_rpc_id, model) {
                Ok(receipt) => receipt,
                Err(failure) => return Outcome::InDoubt(failure),
            };
            if let Some(server_prompt_id) = receipt {
                return Outcome::Delivered {
                    receipt_id: format!("grok-acp:{server_prompt_id}"),
                };
            }
        }
        // The turn outlived the window, as a working Grok turn does. The
        // leader's queue named our exact text under a prompt id, so the
        // message is in the session and the turn runs on without us: that
        // is delivery, not doubt. Only a prompt the queue never showed stays
        // in doubt.
        match evidence.accepted {
            Some(prompt_id) => Outcome::Delivered {
                receipt_id: format!("grok-acp:{prompt_id}"),
            },
            None => Outcome::InDoubt(Failure::TimedOut),
        }
    }
}

#[cfg(test)]
#[cfg(unix)]
mod tests {
    use super::*;
    use crate::relay::process::{FakeProcess, FakeProcesses};
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct FixedAuthority(bool);

    impl Authority for FixedAuthority {
        fn verify(&self, _: &Binding) -> bool {
            self.0
        }
    }

    struct CountingTransport(AtomicUsize);

    impl AcpTransport for CountingTransport {
        fn prompt(&self, _: &Binding, _: &str, _: Duration) -> Outcome {
            self.0.fetch_add(1, Ordering::SeqCst);
            Outcome::Delivered {
                receipt_id: "grok-acp:receipt".into(),
            }
        }
    }

    fn binding() -> Binding {
        Binding {
            provider: Provider::Grok,
            transport: Transport::Acp,
            workspace_id: "rw_expected".into(),
            session_id: "01a0fd4c-3771-7a20-9f41-6f86d56624f9".into(),
            endpoint_id: String::new(),
            owner_id: "owner-1".into(),
            credential_reference: format!("probe:grok:{}", "0".repeat(64)),
            owner_uid: 501,
            auth_id: String::new(),
            protocol_id: String::new(),
            cwd: "/tmp/project".into(),
            model_id: "grok-4.7".into(),
            agent_version: "1.0.46".into(),
            executable: "/usr/local/bin/grok".into(),
            leader_pid: 123,
            leader_start: 456,
            socket_path: "/tmp/leader.sock".into(),
            socket_device: 12,
            socket_inode: 34,
        }
    }

    fn fake_grok(temp: &Path, initialize_delay: u64, protocol_version: u64) -> Binding {
        let executable = temp.join("grok");
        let script = format!(
            r#"#!/bin/sh
read -r initialize
initialize_id=$(printf '%s' "$initialize" | sed -E 's/.*"id":"([^"]+)".*/\1/')
sleep {initialize_delay}
printf '{{"jsonrpc":"2.0","id":"%s","result":{{"protocolVersion":{protocol_version},"_meta":{{"modelState":{{"currentModelId":"grok-4.7"}},"agentVersion":"1.0.46"}}}}}}\n' "$initialize_id"
read -r load
load_id=$(printf '%s' "$load" | sed -E 's/.*"id":"([^"]+)".*/\1/')
printf '{{"jsonrpc":"2.0","id":"%s","result":{{"_meta":{{"sessionId":"01a0fd4c-3771-7a20-9f41-6f86d56624f9"}}}}}}\n' "$load_id"
"#
        );
        fs::write(&executable, script).unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        let mut bound = binding();
        bound.executable = executable;
        bound.cwd = temp.to_path_buf();
        bound
    }

    #[test]
    fn grok_1_0_46_cold_initialize_uses_launch_budget_and_fails_closed() {
        let temp = tempfile::tempdir().unwrap();
        let delayed = fake_grok(temp.path(), 6, 1);
        assert_eq!(
            inspect_session(
                &delayed,
                Arc::new(FixedAuthority(true)),
                Duration::from_secs(10)
            ),
            Ok(("grok-4.7".into(), "1.0.46".into()))
        );

        let too_slow = fake_grok(temp.path(), 1, 1);
        assert_eq!(
            inspect_session(
                &too_slow,
                Arc::new(FixedAuthority(true)),
                Duration::from_millis(100)
            ),
            Err(Failure::TimedOut)
        );

        let wrong_protocol = fake_grok(temp.path(), 0, 2);
        assert_eq!(
            inspect_session(
                &wrong_protocol,
                Arc::new(FixedAuthority(true)),
                Duration::from_secs(2)
            ),
            Err(Failure::IdentityMismatch)
        );
    }

    /// A leader-shaped process with a real listening socket, so both
    /// authorities run their complete kernel/socket checks.
    fn real_leader(
        marker: Option<&str>,
    ) -> (
        tempfile::TempDir,
        std::os::unix::net::UnixListener,
        Arc<crate::relay::process::FakeProcesses>,
        Binding,
    ) {
        let directory = tempfile::tempdir().unwrap();
        let socket_path = directory.path().join("leader.sock");
        let listener = std::os::unix::net::UnixListener::bind(&socket_path).unwrap();
        let socket = fs::symlink_metadata(&socket_path).unwrap();
        let executable = std::env::current_exe().unwrap();
        let pid = std::process::id() as i32;
        let table = Arc::new(FakeProcesses::default());
        table.insert(
            pid,
            FakeProcess {
                parent: 1,
                uid: current_uid(),
                start: 900,
                executable: Some(executable.clone()),
                arguments: vec![
                    "grok".into(),
                    "agent".into(),
                    "leader".into(),
                    "--leader-socket".into(),
                    socket_path.to_string_lossy().into_owned(),
                ],
                environment: marker
                    .map(|value| (MANAGED_MARKER.to_string(), value.to_string()))
                    .into_iter()
                    .collect(),
                ..FakeProcess::default()
            },
        );
        let bound = Binding {
            owner_uid: current_uid(),
            cwd: directory.path().to_path_buf(),
            executable,
            leader_pid: pid,
            leader_start: 900,
            socket_device: socket.dev(),
            socket_inode: socket.ino(),
            socket_path,
            ..binding()
        };
        (directory, listener, table, bound)
    }

    #[test]
    fn neither_grok_authority_verifies_the_other_routes_leader() {
        // An already-open leader: no managed marker.
        let (_directory, _listener, table, mut open) = real_leader(None);
        let existing = ExistingLeaderAuthority::new(table.clone());
        let managed = SystemAuthority::new(table);
        open.credential_reference = existing_reference(&open);
        assert!(is_credential_reference(&open.credential_reference));
        assert!(existing.verify(&open));
        assert!(!managed.verify(&open));
        // A managed reference for the same leader cannot be minted without
        // the marker, so the managed authority still refuses it.
        open.credential_reference = credential_reference(&open, "");
        assert!(!managed.verify(&open));
        assert!(!existing.verify(&open));

        // A probe-launched leader: the marker is present.
        let (_directory, _listener, table, mut launched) = real_leader(Some("probe-marker"));
        let existing = ExistingLeaderAuthority::new(table.clone());
        let managed = SystemAuthority::new(table);
        launched.credential_reference = credential_reference(&launched, "probe-marker");
        assert!(managed.verify(&launched));
        assert!(!existing.verify(&launched));
        launched.credential_reference = existing_reference(&launched);
        assert!(!existing.verify(&launched));
        assert!(!managed.verify(&launched));
    }

    #[test]
    fn an_unreadable_environment_is_never_read_as_no_marker() {
        let (_directory, _listener, table, mut open) = real_leader(None);
        open.credential_reference = existing_reference(&open);
        let existing = ExistingLeaderAuthority::new(table.clone());
        assert!(existing.verify(&open));
        table
            .unreadable_environment
            .lock()
            .unwrap()
            .insert(open.leader_pid);
        assert!(!existing.verify(&open));
        assert_eq!(carries_managed_marker(&*table, open.leader_pid), None);
        // Neither is a probe-launched leader whose environment is hidden.
        let (_directory, _listener, table, mut launched) = real_leader(Some("probe-marker"));
        launched.credential_reference = existing_reference(&launched);
        table
            .unreadable_environment
            .lock()
            .unwrap()
            .insert(launched.leader_pid);
        assert!(!ExistingLeaderAuthority::new(table).verify(&launched));
    }

    #[test]
    fn only_one_leader_socket_names_a_candidate() {
        let leader = |extra: &[&str]| {
            let mut arguments: Vec<String> = ["grok", "agent", "leader", "--leader-socket", "/s"]
                .iter()
                .map(ToString::to_string)
                .collect();
            arguments.extend(extra.iter().map(ToString::to_string));
            arguments
        };
        let default = Path::new("/home/me/.grok/leader.sock");
        assert_eq!(leader_socket(&leader(&[]), None), Some("/s".into()));
        assert_eq!(
            leader_socket(&leader(&[]), Some(default)),
            Some("/s".into())
        );
        assert_eq!(
            leader_socket(&leader(&["--leader-socket", "/t"]), None),
            None
        );
        assert_eq!(
            leader_socket(&leader(&["--leader-socket", "/t"]), Some(default)),
            None
        );
        assert_eq!(
            leader_socket(
                &[
                    "grok".into(),
                    "agent".into(),
                    "--leader-socket".into(),
                    "/s".into()
                ],
                Some(default)
            ),
            None
        );
        // The leader a `grok --leader` TUI spawns names no socket: it is a
        // candidate only for its home's default socket.
        let spawned: Vec<String> = [
            "/home/me/.grok/bin/grok",
            "agent",
            "leader",
            "--no-exit-on-disconnect",
            "--relay-on-demand",
        ]
        .iter()
        .map(ToString::to_string)
        .collect();
        assert_eq!(leader_socket(&spawned, None), None);
        assert_eq!(
            leader_socket(&spawned, Some(default)),
            Some(default.to_path_buf())
        );
    }

    #[test]
    fn the_default_socket_comes_from_the_leaders_own_environment() {
        let table = FakeProcesses::default();
        let leader = |environment: &[(&str, &str)]| FakeProcess {
            uid: 501,
            environment: environment
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            ..FakeProcess::default()
        };
        table.insert(1, leader(&[("HOME", "/home/me")]));
        table.insert(
            2,
            leader(&[("HOME", "/home/me"), ("GROK_HOME", "/srv/grok")]),
        );
        table.insert(3, leader(&[("GROK_HOME", "relative")]));
        table.insert(4, leader(&[]));
        table.insert(5, leader(&[("HOME", "/home/me")]));
        table.unreadable_environment.lock().unwrap().insert(5);
        assert_eq!(
            default_leader_socket(&table, 1),
            Some(PathBuf::from("/home/me/.grok/leader.sock"))
        );
        assert_eq!(
            default_leader_socket(&table, 2),
            Some(PathBuf::from("/srv/grok/leader.sock"))
        );
        assert_eq!(default_leader_socket(&table, 3), None);
        assert_eq!(default_leader_socket(&table, 4), None);
        assert_eq!(default_leader_socket(&table, 5), None);
        assert_eq!(default_leader_socket(&table, 6), None);
    }

    #[test]
    fn an_existing_reference_pins_the_kernel_identity_it_was_minted_from() {
        let (_directory, _listener, table, mut open) = real_leader(None);
        let existing = ExistingLeaderAuthority::new(table);
        open.credential_reference = existing_reference(&open);
        assert!(existing.verify(&open));
        let mut moved = open.clone();
        moved.session_id = "01a0fd4c-3771-7a20-9f41-6f86d56624fa".into();
        assert!(!existing.verify(&moved));
        let mut restarted = open.clone();
        restarted.leader_start += 1;
        restarted.credential_reference = existing_reference(&restarted);
        assert!(!existing.verify(&restarted));
        for malformed in [
            String::new(),
            "existing:grok:".into(),
            format!("existing:grok:{}", "g".repeat(64)),
            format!("existing:codex:{}", "0".repeat(64)),
            format!("existing:grok:{}", "0".repeat(63)),
        ] {
            assert!(!is_credential_reference(&malformed), "{malformed}");
        }
    }

    #[test]
    fn connected_socket_peer_must_match_the_bound_owner() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("leader.sock");
        let _listener = std::os::unix::net::UnixListener::bind(&path).unwrap();
        let mut bound = binding();
        bound.socket_path = path;
        bound.owner_uid = current_uid();
        bound.leader_pid = std::process::id() as i32;
        assert!(socket_peer_matches(&bound));
        bound.owner_uid = bound.owner_uid.saturating_add(1);
        assert!(!socket_peer_matches(&bound));
        #[cfg(target_os = "linux")]
        {
            bound.owner_uid = current_uid();
            bound.leader_pid += 1;
            assert!(!socket_peer_matches(&bound));
        }
    }

    #[test]
    fn legacy_and_grok_1_0_46_leader_arguments_keep_exact_socket_identity() {
        let socket = Path::new("/tmp/managed-grok.sock");
        let legacy = vec![
            "/opt/grok-1.0.13/grok".into(),
            "agent".into(),
            "leader".into(),
            "--leader-socket".into(),
            socket.to_string_lossy().into_owned(),
        ];
        let current = vec![
            "/opt/grok-1.0.46/grok".into(),
            "agent".into(),
            "leader".into(),
            "--no-exit-on-disconnect".into(),
            "--relay-on-demand".into(),
            "--leader-socket".into(),
            socket.to_string_lossy().into_owned(),
        ];
        let default = Path::new("/home/me/.grok/leader.sock");
        assert!(leader_arguments_match(&legacy, socket, None));
        assert!(leader_arguments_match(&current, socket, None));
        // An explicit socket is never overridden by the default.
        assert!(leader_arguments_match(&current, socket, Some(default)));
        assert!(!leader_arguments_match(&current, default, Some(default)));

        let mut lookalike = current.clone();
        *lookalike.last_mut().unwrap() = "/tmp/lookalike.sock".into();
        assert!(!leader_arguments_match(&lookalike, socket, None));

        // A spawned leader without `--leader-socket` matches only the default
        // socket, and only when the route allows a default.
        let spawned: Vec<String> = current[..5].to_vec();
        assert!(!leader_arguments_match(&spawned, socket, None));
        assert!(!leader_arguments_match(&spawned, default, None));
        assert!(leader_arguments_match(&spawned, default, Some(default)));
        assert!(!leader_arguments_match(&spawned, socket, Some(default)));
    }

    #[test]
    fn workspace_owner_and_kernel_authority_are_checked_before_transport() {
        let transport = Arc::new(CountingTransport(AtomicUsize::new(0)));
        let adapter = GrokAdapter::new(
            "rw_expected".into(),
            "owner-1".into(),
            501,
            Arc::new(FixedAuthority(true)),
            transport.clone(),
        );
        let mut bound = binding();
        bound.workspace_id = "rw_other".into();
        let request = Request {
            binding: &bound,
            delivery_id: "delivery-1",
            message_id: "message-1",
            text: "hello",
            timeout: Duration::from_secs(10),
        };
        assert_eq!(
            adapter.inject(&request, "0198f0ab-9999-7000-8000-000000000001"),
            Outcome::Refused(Failure::IdentityMismatch)
        );
        assert_eq!(transport.0.load(Ordering::SeqCst), 0);

        let bound = binding();
        let rejected = GrokAdapter::new(
            "rw_expected".into(),
            "owner-1".into(),
            501,
            Arc::new(FixedAuthority(false)),
            transport.clone(),
        );
        let request = Request {
            binding: &bound,
            delivery_id: "delivery-2",
            message_id: "message-2",
            text: "hello",
            timeout: Duration::from_secs(10),
        };
        assert_eq!(
            rejected.inject(&request, "0198f0ab-9999-7000-8000-000000000002"),
            Outcome::Refused(Failure::IdentityMismatch)
        );
        assert_eq!(transport.0.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn credential_bearing_mcp_notification_is_dropped_wholesale() {
        let line = r#"{"jsonrpc":"2.0","method":"_x.ai/mcp/servers_updated","params":{"env":{"RELAY_WORKSPACE_KEY":"credential-fixture","XAI_API_KEY":"credential-fixture"}}}"#;
        let event = decode_event(line);
        assert_eq!(event, Event::Ignored);
        assert!(!format!("{event:?}").contains("secret"));
    }

    #[test]
    fn a_prompt_the_leader_queues_under_our_text_in_our_session_is_accepted() {
        let queued = r#"{"jsonrpc":"2.0","method":"_x.ai/queue/changed","params":{"sessionId":"s","entries":[{"id":"q-1","version":0,"kind":"prompt","text":"hello there"}]}}"#;
        assert_eq!(
            decode_event(queued),
            Event::Queued {
                session_id: Some("s".into()),
                prompts: vec![("q-1".into(), "hello there".into())]
            }
        );
        let running = r#"{"jsonrpc":"2.0","method":"_x.ai/queue/changed","params":{"sessionId":"s","entries":[],"runningPromptId":"q-1","runningText":"hello there"}}"#;
        let mut evidence = PromptEvidence::default();
        evidence.note_accepted(&decode_event(running), "other text", "s");
        assert_eq!(evidence.accepted, None);
        // The same text running in another session of the leader is not ours.
        evidence.note_accepted(&decode_event(running), "hello there", "other-session");
        assert_eq!(evidence.accepted, None);
        evidence.note_accepted(&decode_event(running), "hello there", "s");
        assert_eq!(evidence.accepted.as_deref(), Some("q-1"));
        // Another prompt with the same text later does not move the receipt.
        let later = r#"{"jsonrpc":"2.0","method":"_x.ai/queue/changed","params":{"sessionId":"s","entries":[{"id":"q-2","kind":"prompt","text":"hello there"}]}}"#;
        evidence.note_accepted(&decode_event(later), "hello there", "s");
        assert_eq!(evidence.accepted.as_deref(), Some("q-1"));
        // A prompt the leader held before our send is never ours, even
        // with our exact text.
        let mut earlier = PromptEvidence {
            known_before_send: ["q-1".to_string()].into_iter().collect(),
            ..PromptEvidence::default()
        };
        earlier.note_accepted(&decode_event(running), "hello there", "s");
        assert_eq!(earlier.accepted, None);
        earlier.note_accepted(&decode_event(later), "hello there", "s");
        assert_eq!(earlier.accepted.as_deref(), Some("q-2"));
        // A notification naming no session is never a receipt.
        let unnamed = r#"{"jsonrpc":"2.0","method":"_x.ai/queue/changed","params":{"entries":[{"id":"q-3","kind":"prompt","text":"hello there"}]}}"#;
        let mut fresh = PromptEvidence::default();
        fresh.note_accepted(&decode_event(unnamed), "hello there", "s");
        assert_eq!(fresh.accepted, None);
        // The session recording our text under that id is the receipt.
        assert_eq!(evidence.recorded(), None);
        let echo = r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"hello there"}}}}"#;
        assert_eq!(
            decode_event(echo),
            Event::Echoed {
                session_id: Some("s".into()),
                text: "hello there".into()
            }
        );
        evidence.note_accepted(&decode_event(echo), "other text", "s");
        assert_eq!(evidence.recorded(), None);
        evidence.note_accepted(&decode_event(echo), "hello there", "other-session");
        assert_eq!(evidence.recorded(), None);
        evidence.note_accepted(&decode_event(echo), "hello there", "s");
        assert_eq!(evidence.recorded().as_deref(), Some("q-1"));
        // An echo with no queue id yet is not a receipt on its own.
        let mut fresh = PromptEvidence::default();
        fresh.note_accepted(&decode_event(echo), "hello there", "s");
        assert_eq!(fresh.recorded(), None);
    }

    #[test]
    fn only_prompt_scoped_consumption_and_completion_are_recognized() {
        let working = r#"{"jsonrpc":"2.0","method":"_x.ai/sessions/changed","params":{"activity":"working"}}"#;
        assert_eq!(decode_event(working), Event::Other);
        let chunk = r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","_meta":{"promptId":"prompt-1"}}}}"#;
        assert_eq!(
            decode_event(chunk),
            Event::Consumed {
                prompt_id: "prompt-1".into()
            }
        );
        let done = r#"{"jsonrpc":"2.0","method":"_x.ai/session/prompt_complete","params":{"promptId":"prompt-1","stopReason":"end_turn","modelId":"grok-4.7"}}"#;
        assert_eq!(
            decode_event(done),
            Event::Completed {
                prompt_id: "prompt-1".into(),
                stop_reason: "end_turn".into(),
                model_id: Some("grok-4.7".into())
            }
        );
    }

    #[test]
    fn load_response_accepts_live_meta_session_id_and_legacy_top_level_shape() {
        assert_eq!(
            loaded_session_id(&json!({"_meta":{"sessionId":"session-live"}})).as_deref(),
            Some("session-live")
        );
        assert_eq!(
            loaded_session_id(&json!({"sessionId":"session-top"})).as_deref(),
            Some("session-top")
        );
        assert_eq!(loaded_session_id(&json!({"_meta":{}})), None);
    }

    #[test]
    fn load_timeout_or_error_is_retryable_but_wrong_session_is_refused() {
        assert_eq!(
            validate_loaded_response(None, "session-1"),
            Err(Outcome::Retry(Failure::TimedOut))
        );
        assert_eq!(
            validate_loaded_response(Some(Err(())), "session-1"),
            Err(Outcome::Retry(Failure::EndpointUnavailable))
        );
        assert_eq!(
            validate_loaded_response(
                Some(Ok(json!({"_meta":{"sessionId":"session-other"}}))),
                "session-1",
            ),
            Err(Outcome::Refused(Failure::IdentityMismatch))
        );
        assert_eq!(
            validate_loaded_response(
                Some(Ok(json!({"_meta":{"sessionId":"session-1"}}))),
                "session-1",
            ),
            Ok(())
        );
    }

    #[test]
    fn an_expired_deadline_is_rejected_before_prompt_send() {
        assert_eq!(
            ensure_budget(Instant::now() - Duration::from_millis(1)),
            Err(Outcome::Retry(Failure::TimedOut))
        );
        assert_eq!(
            ensure_budget(Instant::now() + Duration::from_secs(1)),
            Ok(())
        );
    }

    #[test]
    fn caller_rpc_id_and_server_prompt_id_are_correlated_separately() {
        let mut missing_tokens = PromptEvidence::default();
        assert_eq!(
            missing_tokens.record(
                Event::Response {
                    id: "rpc-missing-tokens".into(),
                    result: Some(json!({
                        "stopReason": "end_turn",
                        "_meta": {
                            "promptId": "server-missing-tokens",
                            "modelId": "grok-4.7"
                        }
                    })),
                    error: false,
                },
                "rpc-missing-tokens",
                "grok-4.7",
            ),
            Err(Failure::ProviderRefused)
        );

        let mut evidence = PromptEvidence::default();
        assert_eq!(
            evidence.record(
                decode_event(
                    r#"{"jsonrpc":"2.0","method":"session/update","params":{"_meta":{"promptId":"server-prompt-1"},"update":{"sessionUpdate":"agent_message_chunk"}}}"#,
                ),
                "rpc-request-1",
                "grok-4.7",
            ),
            Ok(None)
        );
        assert_eq!(
            evidence.record(
                decode_event(
                    r#"{"jsonrpc":"2.0","method":"_x.ai/session/prompt_complete","params":{"promptId":"server-prompt-1","stopReason":"end_turn","modelId":"grok-4.7"}}"#,
                ),
                "rpc-request-1",
                "grok-4.7",
            ),
            Ok(None)
        );
        assert_eq!(
            evidence.record(
                decode_event(
                    r#"{"jsonrpc":"2.0","id":"rpc-request-1","result":{"stopReason":"end_turn","outputTokens":51,"modelId":"grok-4.7","_meta":{"promptId":"server-prompt-1"}}}"#,
                ),
                "rpc-request-1",
                "grok-4.7",
            ),
            Ok(Some("server-prompt-1".into()))
        );

        let mut response_first = PromptEvidence::default();
        assert_eq!(
            response_first.record(
                Event::Response {
                    id: "rpc-request-2".into(),
                    result: Some(json!({
                        "stopReason": "end_turn",
                        "outputTokens": 34,
                        "_meta": {
                            "promptId": "server-prompt-2",
                            "modelId": "grok-4.7"
                        }
                    })),
                    error: false,
                },
                "rpc-request-2",
                "grok-4.7",
            ),
            Ok(None)
        );
        assert_eq!(
            response_first.record(
                Event::Consumed {
                    prompt_id: "server-prompt-2".into(),
                },
                "rpc-request-2",
                "grok-4.7",
            ),
            Ok(None)
        );
        assert_eq!(
            response_first.record(
                Event::Completed {
                    prompt_id: "server-prompt-2".into(),
                    stop_reason: "end_turn".into(),
                    model_id: None,
                },
                "rpc-request-2",
                "grok-4.7",
            ),
            Ok(Some("server-prompt-2".into()))
        );
    }
}
