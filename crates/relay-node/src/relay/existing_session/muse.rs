//! Muse MSP delivery for sessions owned by a long-lived desktop host.
//!
//! This module deliberately does not attach to an arbitrary Muse TUI. The
//! desktop owns one `muse serve` process and exposes only a private Unix
//! control socket. The adapter binds that socket and host generation to the
//! Relay workspace, local uid, session, workspace root, model, schema and a
//! non-secret credential-principal reference.

use super::platform::{CommandExt, FileTypeExt, MetadataExt, UnixListener, UnixStream};
use super::{Adapter, Binding, Failure, Journal, Outcome, Provider, Request, Transport};
use crate::relay::peer::current_uid;
use crate::relay::process::{ProcessTable, SystemProcesses};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::ffi::OsString;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

const CONTROL_VERSION: u32 = 1;
const MAX_CONTROL_FRAME: u64 = 131_072;
const MAX_MSP_FRAME: usize = 8 * 1024 * 1024;
const MAX_BUFFERED_MSP_FRAMES: usize = 256;
const MAX_RECEIPT_ID: usize = 256;
const MUSE_RECEIPT_PREFIX: &str = "muse-msp:";

/// The kernel-reported uid and pid at the other end of a control socket.
struct Peer {
    uid: u32,
    pid: Option<i32>,
}

#[cfg(unix)]
fn peer_of(socket: &UnixStream) -> std::io::Result<Peer> {
    crate::relay::peer::peer_credentials(socket).map(|peer| Peer {
        uid: peer.uid,
        pid: peer.pid,
    })
}

/// No Unix socket ever connects on Windows (`platform::UnixStream` has no
/// value), where Muse is reported unavailable.
#[cfg(windows)]
fn peer_of(socket: &UnixStream) -> std::io::Result<Peer> {
    match *socket {}
}

pub trait Authority: Send + Sync {
    fn verify(&self, binding: &Binding) -> bool;
}

/// Kernel-backed verification of the exact app-owned host and control socket.
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
        if binding.provider != Provider::Muse
            || binding.transport != Transport::Msp
            || binding.owner_uid != current_uid()
        {
            return false;
        }
        let Some(process) = self.processes.process(binding.leader_pid) else {
            return false;
        };
        if process.uid != binding.owner_uid || process.start != binding.leader_start {
            return false;
        }
        // `leader_pid` is the app-owned control host; `executable` is the
        // exact Muse binary that host is allowed to supervise. The socket peer
        // check below binds the former, and immutable path metadata binds the
        // latter without pretending the two processes are one.
        if !fs::metadata(&binding.executable).is_ok_and(|metadata| {
            metadata.is_file()
                && (metadata.uid() == 0 || metadata.uid() == binding.owner_uid)
                && metadata.mode() & 0o022 == 0
        }) {
            return false;
        }
        let socket = fs::symlink_metadata(&binding.socket_path);
        let workspace = fs::symlink_metadata(&binding.cwd);
        socket.is_ok_and(|metadata| {
            metadata.file_type().is_socket()
                && metadata.uid() == binding.owner_uid
                && metadata.mode() & 0o077 == 0
                && metadata.dev() == binding.socket_device
                && metadata.ino() == binding.socket_inode
        }) && workspace
            .is_ok_and(|metadata| metadata.is_dir() && metadata.uid() == binding.owner_uid)
            && self.processes.process(binding.leader_pid) == Some(process)
    }
}

pub trait ControlTransport: Send + Sync {
    fn turn(
        &self,
        request: &Request<'_>,
        command_id: &str,
        request_hash: &str,
        replay: bool,
    ) -> Outcome;
}

/// Client-side adapter. It never starts a Muse process and therefore cannot
/// accidentally contend for a foreign TUI's writer lease.
pub struct MuseMspAdapter {
    workspace_id: String,
    owner_id: String,
    owner_uid: u32,
    endpoint_id: String,
    auth_id: String,
    authority: Arc<dyn Authority>,
    transport: Arc<dyn ControlTransport>,
}

impl MuseMspAdapter {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        workspace_id: String,
        owner_id: String,
        owner_uid: u32,
        endpoint_id: String,
        auth_id: String,
        authority: Arc<dyn Authority>,
        transport: Arc<dyn ControlTransport>,
    ) -> Self {
        Self {
            workspace_id,
            owner_id,
            owner_uid,
            endpoint_id,
            auth_id,
            authority,
            transport,
        }
    }

    fn send(&self, request: &Request<'_>, command_id: &str, replay: bool) -> Outcome {
        let binding = request.binding;
        if binding.provider != Provider::Muse
            || binding.transport != Transport::Msp
            || binding.workspace_id != self.workspace_id
            || binding.owner_id != self.owner_id
            || binding.owner_uid != self.owner_uid
            || binding.endpoint_id != self.endpoint_id
            || binding.auth_id != self.auth_id
            || !self.authority.verify(binding)
        {
            return Outcome::Refused(Failure::IdentityMismatch);
        }
        self.transport
            .turn(request, command_id, &Journal::request_hash(request), replay)
    }
}

impl Adapter for MuseMspAdapter {
    fn provider(&self) -> Provider {
        Provider::Muse
    }

    fn inject(&self, request: &Request<'_>, command_id: &str) -> Outcome {
        self.send(request, command_id, false)
    }

    fn replay(&self, request: &Request<'_>, command_id: &str) -> Outcome {
        self.send(request, command_id, true)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireBinding {
    workspace_id: String,
    session_id: String,
    owner_id: String,
    owner_uid: u32,
    endpoint_id: String,
    auth_id: String,
    protocol_id: String,
    workspace_root: String,
    model_id: String,
    agent_version: String,
    leader_pid: i32,
    leader_start: u64,
    socket_device: u64,
    socket_inode: u64,
}

impl WireBinding {
    fn of(binding: &Binding) -> Option<Self> {
        Some(Self {
            workspace_id: binding.workspace_id.clone(),
            session_id: binding.session_id.clone(),
            owner_id: binding.owner_id.clone(),
            owner_uid: binding.owner_uid,
            endpoint_id: binding.endpoint_id.clone(),
            auth_id: binding.auth_id.clone(),
            protocol_id: binding.protocol_id.clone(),
            workspace_root: binding.cwd.to_str()?.to_owned(),
            model_id: binding.model_id.clone(),
            agent_version: binding.agent_version.clone(),
            leader_pid: binding.leader_pid,
            leader_start: binding.leader_start,
            socket_device: binding.socket_device,
            socket_inode: binding.socket_inode,
        })
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ControlRequest {
    version: u32,
    binding: WireBinding,
    command_id: String,
    request_hash: String,
    message_id: String,
    text: String,
    timeout_ms: u64,
    replay: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "status")]
enum ControlResponse {
    Delivered {
        command_id: String,
        request_hash: String,
        receipt_id: String,
    },
    Retry {
        failure: WireFailure,
    },
    InDoubt {
        failure: WireFailure,
    },
    Refused {
        failure: WireFailure,
    },
}

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum WireFailure {
    IdentityMismatch,
    EndpointUnavailable,
    ProviderRefused,
    TimedOut,
    PriorAttemptUncertain,
    RequestConflict,
}

impl WireFailure {
    fn outcome(self, class: ResponseClass) -> Outcome {
        let failure = match self {
            Self::IdentityMismatch => Failure::IdentityMismatch,
            Self::EndpointUnavailable => Failure::EndpointUnavailable,
            Self::ProviderRefused => Failure::ProviderRefused,
            Self::TimedOut => Failure::TimedOut,
            Self::PriorAttemptUncertain => Failure::PriorAttemptUncertain,
            Self::RequestConflict => Failure::RequestConflict,
        };
        match class {
            ResponseClass::Retry => Outcome::Retry(failure),
            ResponseClass::InDoubt => Outcome::InDoubt(failure),
            ResponseClass::Refused => Outcome::Refused(failure),
        }
    }
}

enum ResponseClass {
    Retry,
    InDoubt,
    Refused,
}

impl From<Outcome> for ControlResponse {
    fn from(outcome: Outcome) -> Self {
        fn wire(failure: Failure) -> WireFailure {
            match failure {
                Failure::IdentityMismatch => WireFailure::IdentityMismatch,
                Failure::EndpointUnavailable => WireFailure::EndpointUnavailable,
                Failure::ProviderRefused => WireFailure::ProviderRefused,
                Failure::TimedOut => WireFailure::TimedOut,
                Failure::PriorAttemptUncertain => WireFailure::PriorAttemptUncertain,
                Failure::RequestConflict => WireFailure::RequestConflict,
                Failure::Disabled
                | Failure::UnsupportedRoute
                | Failure::AuthenticationUnavailable
                | Failure::JournalUnavailable => WireFailure::ProviderRefused,
            }
        }
        match outcome {
            Outcome::Delivered { receipt_id } => Self::Delivered {
                command_id: String::new(),
                request_hash: String::new(),
                receipt_id,
            },
            Outcome::Retry(failure) | Outcome::Waiting(failure) => Self::Retry {
                failure: wire(failure),
            },
            Outcome::InDoubt(failure) => Self::InDoubt {
                failure: wire(failure),
            },
            Outcome::Refused(failure) => Self::Refused {
                failure: wire(failure),
            },
        }
    }
}

pub struct SystemControlTransport;

impl ControlTransport for SystemControlTransport {
    fn turn(
        &self,
        request: &Request<'_>,
        command_id: &str,
        request_hash: &str,
        replay: bool,
    ) -> Outcome {
        let binding = request.binding;
        let Ok(metadata) = fs::symlink_metadata(&binding.socket_path) else {
            return Outcome::Retry(Failure::EndpointUnavailable);
        };
        if !metadata.file_type().is_socket()
            || metadata.uid() != binding.owner_uid
            || metadata.mode() & 0o077 != 0
            || metadata.dev() != binding.socket_device
            || metadata.ino() != binding.socket_inode
        {
            return Outcome::Refused(Failure::IdentityMismatch);
        }
        let Ok(mut socket) = UnixStream::connect(&binding.socket_path) else {
            return Outcome::Retry(Failure::EndpointUnavailable);
        };
        let peer = peer_of(&socket);
        if !peer
            .is_ok_and(|peer| peer.uid == binding.owner_uid && peer.pid == Some(binding.leader_pid))
        {
            return Outcome::Refused(Failure::IdentityMismatch);
        }
        let _ = socket.set_read_timeout(Some(request.timeout));
        let _ = socket.set_write_timeout(Some(request.timeout));
        let Some(wire_binding) = WireBinding::of(binding) else {
            return Outcome::Refused(Failure::IdentityMismatch);
        };
        let frame = ControlRequest {
            version: CONTROL_VERSION,
            binding: wire_binding,
            command_id: command_id.to_owned(),
            request_hash: request_hash.to_owned(),
            message_id: request.message_id.to_owned(),
            text: request.text.to_owned(),
            timeout_ms: request.timeout.as_millis().min(u128::from(u64::MAX)) as u64,
            replay,
        };
        let Ok(encoded) = serde_json::to_vec(&frame) else {
            return Outcome::Refused(Failure::ProviderRefused);
        };
        // The host reads at most MAX_CONTROL_FRAME bytes, including the line
        // delimiter. Refuse before the first side effect when JSON escaping
        // makes an otherwise-valid message too large for that wire contract.
        if encoded.len().saturating_add(1) >= MAX_CONTROL_FRAME as usize {
            return Outcome::Refused(Failure::ProviderRefused);
        }
        if socket.write_all(&encoded).is_err()
            || socket.write_all(b"\n").is_err()
            || socket.flush().is_err()
        {
            // Any write may have reached the host even when the local call
            // reports an error. Keep the journal pinned to this command ID.
            return Outcome::InDoubt(Failure::PriorAttemptUncertain);
        }
        let mut line = String::new();
        let read = BufReader::new(socket)
            .take(MAX_CONTROL_FRAME)
            .read_line(&mut line);
        if read.is_err()
            || read
                .ok()
                .is_some_and(|bytes| bytes as u64 >= MAX_CONTROL_FRAME)
        {
            return Outcome::InDoubt(Failure::PriorAttemptUncertain);
        }
        let Ok(response) = serde_json::from_str::<ControlResponse>(line.trim()) else {
            return Outcome::InDoubt(Failure::PriorAttemptUncertain);
        };
        match response {
            ControlResponse::Delivered {
                command_id: echoed_command,
                request_hash: echoed_hash,
                receipt_id,
            } if echoed_command == command_id && echoed_hash == request_hash => {
                Outcome::Delivered { receipt_id }
            }
            ControlResponse::Delivered { .. } => Outcome::Refused(Failure::IdentityMismatch),
            ControlResponse::Retry { failure } => failure.outcome(ResponseClass::Retry),
            ControlResponse::InDoubt { failure } => failure.outcome(ResponseClass::InDoubt),
            ControlResponse::Refused { failure } => failure.outcome(ResponseClass::Refused),
        }
    }
}

pub trait MspEngine: Send {
    fn submit(
        &mut self,
        session_id: &str,
        command_id: &str,
        request_hash: &str,
        text: &str,
        replay: bool,
        timeout: Duration,
    ) -> Outcome;
}

/// The app-owned Unix endpoint around one long-lived `muse serve` host.
pub struct HostManager {
    binding: Binding,
    listener: UnixListener,
    engine: Mutex<Box<dyn MspEngine>>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct SocketIdentity {
    device: u64,
    inode: u64,
}

fn socket_identity(metadata: &fs::Metadata) -> SocketIdentity {
    SocketIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
    }
}

fn remove_exact_socket(path: &Path, expected: SocketIdentity) -> std::io::Result<bool> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    if !metadata.file_type().is_socket() || socket_identity(&metadata) != expected {
        return Ok(false);
    }
    fs::remove_file(path)?;
    Ok(true)
}

fn remove_stale_socket(path: &Path, owner_uid: u32) -> std::io::Result<()> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    if !metadata.file_type().is_socket() || metadata.uid() != owner_uid {
        return Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "control socket path is not a stale owned socket",
        ));
    }
    let expected = socket_identity(&metadata);
    match UnixStream::connect(path) {
        Ok(_) => Err(std::io::Error::new(
            std::io::ErrorKind::AddrInUse,
            "control socket is active",
        )),
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::ConnectionRefused | std::io::ErrorKind::NotFound
            ) =>
        {
            if remove_exact_socket(path, expected)? {
                Ok(())
            } else {
                Err(std::io::Error::new(
                    std::io::ErrorKind::AddrInUse,
                    "control socket changed during stale cleanup",
                ))
            }
        }
        Err(error) => Err(error),
    }
}

struct BoundSocketGuard {
    path: PathBuf,
    identity: SocketIdentity,
    armed: bool,
}

impl BoundSocketGuard {
    fn disarm(mut self) {
        self.armed = false;
    }
}

impl Drop for BoundSocketGuard {
    fn drop(&mut self) {
        if self.armed {
            let _ = remove_exact_socket(&self.path, self.identity);
        }
    }
}

impl HostManager {
    pub fn bind(mut binding: Binding, engine: Box<dyn MspEngine>) -> std::io::Result<Self> {
        if binding.provider != Provider::Muse
            || binding.transport != Transport::Msp
            || binding.owner_uid != current_uid()
            || binding.leader_pid != std::process::id() as i32
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "host identity mismatch",
            ));
        }
        let parent = binding.socket_path.parent().ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::InvalidInput, "missing socket parent")
        })?;
        let parent_metadata = fs::symlink_metadata(parent)?;
        if !parent_metadata.is_dir()
            || parent_metadata.uid() != binding.owner_uid
            || parent_metadata.mode() & 0o077 != 0
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "control directory is not private",
            ));
        }
        remove_stale_socket(&binding.socket_path, binding.owner_uid)?;
        let listener = UnixListener::bind(&binding.socket_path)?;
        let metadata = match fs::symlink_metadata(&binding.socket_path) {
            Ok(metadata) => metadata,
            Err(error) => {
                let _ = fs::remove_file(&binding.socket_path);
                return Err(error);
            }
        };
        if !metadata.file_type().is_socket() || metadata.uid() != binding.owner_uid {
            let _ = fs::remove_file(&binding.socket_path);
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "control socket identity mismatch",
            ));
        }
        let identity = socket_identity(&metadata);
        let guard = BoundSocketGuard {
            path: binding.socket_path.clone(),
            identity,
            armed: true,
        };
        super::platform::set_mode(&binding.socket_path, 0o600)?;
        let metadata = fs::symlink_metadata(&binding.socket_path)?;
        if !metadata.file_type().is_socket()
            || metadata.uid() != binding.owner_uid
            || metadata.mode() & 0o077 != 0
            || socket_identity(&metadata) != identity
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "control socket changed during bind",
            ));
        }
        binding.socket_device = identity.device;
        binding.socket_inode = identity.inode;
        let manager = Self {
            binding,
            listener,
            engine: Mutex::new(engine),
        };
        guard.disarm();
        Ok(manager)
    }

    pub fn binding(&self) -> &Binding {
        &self.binding
    }

    /// Serve one request. The hosting app calls this for its process lifetime.
    pub fn serve_one(&self) -> std::io::Result<()> {
        let (socket, _) = self.listener.accept()?;
        // A client may time out and close while Muse is still settling its
        // turn. That connection is expendable; only an accept failure ends the
        // long-lived host.
        let _ = self.serve_connection(socket);
        Ok(())
    }

    fn serve_connection(&self, mut socket: UnixStream) -> std::io::Result<()> {
        let peer = peer_of(&socket)?;
        if peer.uid != self.binding.owner_uid {
            return Ok(());
        }
        let _ = socket.set_read_timeout(Some(Duration::from_secs(35)));
        let _ = socket.set_write_timeout(Some(Duration::from_secs(5)));
        let mut line = String::new();
        let read = BufReader::new(socket.try_clone()?)
            .take(MAX_CONTROL_FRAME)
            .read_line(&mut line)?;
        if read == 0 || read as u64 >= MAX_CONTROL_FRAME {
            return Ok(());
        }
        let response = self.handle(line.trim());
        serde_json::to_writer(&mut socket, &response)?;
        socket.write_all(b"\n")?;
        socket.flush()
    }

    /// Serve until the app drops or terminates the manager process.
    pub fn serve(&self) -> std::io::Result<()> {
        loop {
            self.serve_one()?;
        }
    }

    fn handle(&self, line: &str) -> ControlResponse {
        let Ok(frame) = serde_json::from_str::<ControlRequest>(line) else {
            return ControlResponse::Refused {
                failure: WireFailure::ProviderRefused,
            };
        };
        let expected = WireBinding::of(&self.binding);
        if frame.version != CONTROL_VERSION
            || expected.as_ref() != Some(&frame.binding)
            || !super::is_uuid_v7(&frame.command_id)
            || !(1_000..=30_000).contains(&frame.timeout_ms)
        {
            return ControlResponse::Refused {
                failure: WireFailure::IdentityMismatch,
            };
        }
        let request = Request {
            binding: &self.binding,
            delivery_id: "control",
            message_id: &frame.message_id,
            text: &frame.text,
            timeout: Duration::from_millis(frame.timeout_ms),
        };
        if Journal::request_hash(&request) != frame.request_hash {
            return ControlResponse::Refused {
                failure: WireFailure::RequestConflict,
            };
        }
        let outcome = self.engine.lock().unwrap().submit(
            &self.binding.session_id,
            &frame.command_id,
            &frame.request_hash,
            &frame.text,
            frame.replay,
            request.timeout,
        );
        match outcome {
            Outcome::Delivered { receipt_id } => ControlResponse::Delivered {
                command_id: frame.command_id,
                request_hash: frame.request_hash,
                receipt_id,
            },
            other => other.into(),
        }
    }
}

impl Drop for HostManager {
    fn drop(&mut self) {
        let _ = remove_exact_socket(
            &self.binding.socket_path,
            SocketIdentity {
                device: self.binding.socket_device,
                inode: self.binding.socket_inode,
            },
        );
    }
}

struct ChildGuard {
    child: Child,
    #[cfg_attr(windows, allow(dead_code))]
    process_group: i32,
}

impl ChildGuard {
    fn new(child: Child) -> Self {
        Self {
            process_group: child.id() as i32,
            child,
        }
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        // `muse serve` may own helper processes. It is launched as a fresh
        // process group so host teardown cannot strand descendants that retain
        // stdio or continue using the managed session.
        #[cfg(unix)]
        // SAFETY: kill has no memory preconditions; a gone group is ignored.
        let _ = unsafe { libc::kill(-self.process_group, libc::SIGKILL) };
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// One supervised `muse serve` process. Construction performs the MSP
/// handshake and resumes the exact owned session before the socket is exposed.
pub struct SystemMspHost {
    binding: Binding,
    child: ChildGuard,
    stdin: ChildStdin,
    events: MspFrameReader,
    next_rpc_id: u64,
}

impl SystemMspHost {
    pub fn launch(
        binding: Binding,
        environment: &[(OsString, OsString)],
        timeout: Duration,
    ) -> Result<Self, Failure> {
        let mut command = Command::new(&binding.executable);
        command
            .arg("serve")
            .current_dir(&binding.cwd)
            .env_clear()
            .envs(environment.iter().cloned())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .process_group(0);
        let child = command.spawn().map_err(|_| Failure::EndpointUnavailable)?;
        let mut child = ChildGuard::new(child);
        let stdin = child
            .child
            .stdin
            .take()
            .ok_or(Failure::EndpointUnavailable)?;
        let stdout = child
            .child
            .stdout
            .take()
            .ok_or(Failure::EndpointUnavailable)?;
        let (sender, events) = msp_frame_channel(MAX_BUFFERED_MSP_FRAMES);
        std::thread::spawn(move || read_msp_frames(BufReader::new(stdout), sender));
        let mut host = Self {
            binding,
            child,
            stdin,
            events,
            next_rpc_id: 1,
        };
        host.initialize(timeout)?;
        Ok(host)
    }

    fn request(&mut self, method: &str, params: Value) -> Result<u64, Failure> {
        let id = self.next_rpc_id;
        self.next_rpc_id = self.next_rpc_id.saturating_add(1);
        let frame = json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
        serde_json::to_writer(&mut self.stdin, &frame).map_err(|_| Failure::EndpointUnavailable)?;
        self.stdin
            .write_all(b"\n")
            .and_then(|_| self.stdin.flush())
            .map_err(|_| Failure::EndpointUnavailable)?;
        Ok(id)
    }

    fn notify(&mut self, method: &str) -> Result<(), Failure> {
        serde_json::to_writer(&mut self.stdin, &json!({"jsonrpc":"2.0","method":method}))
            .map_err(|_| Failure::EndpointUnavailable)?;
        self.stdin
            .write_all(b"\n")
            .and_then(|_| self.stdin.flush())
            .map_err(|_| Failure::EndpointUnavailable)
    }

    fn response(&self, id: u64, deadline: Instant) -> Result<Value, Failure> {
        loop {
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .ok_or(Failure::TimedOut)?;
            let frame = self
                .events
                .recv_timeout(remaining)
                .map_err(|_| Failure::EndpointUnavailable)?;
            if frame.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            if frame.get("error").is_some() {
                return Err(classify_msp_error(&frame));
            }
            return frame.get("result").cloned().ok_or(Failure::ProviderRefused);
        }
    }

    fn initialize(&mut self, timeout: Duration) -> Result<(), Failure> {
        let deadline = Instant::now() + timeout;
        let initialize = self.request(
            "initialize",
            json!({"clientInfo":{"name":"agent-relay-desktop","version":env!("CARGO_PKG_VERSION")}}),
        )?;
        let initialized = self.response(initialize, deadline)?;
        if text(&initialized, &["schema", "fingerprint"]) != Some(self.binding.protocol_id.as_str())
            || text(&initialized, &["serverInfo", "version"])
                != Some(self.binding.agent_version.as_str())
        {
            return Err(Failure::IdentityMismatch);
        }
        self.notify("initialized")?;
        let resume = self.request(
            "session/resume",
            json!({
                "commandId": super::uuid_v7().ok_or(Failure::EndpointUnavailable)?,
                "sessionId": self.binding.session_id,
                "history": "inline"
            }),
        )?;
        let resumed = self.response(resume, deadline)?;
        if text(&resumed, &["session", "sessionId"]) != Some(self.binding.session_id.as_str())
            || text(&resumed, &["session", "workspaceRoot"]) != self.binding.cwd.to_str()
            || text(&resumed, &["session", "modelId"]) != Some(self.binding.model_id.as_str())
        {
            return Err(Failure::IdentityMismatch);
        }
        Ok(())
    }

    fn page_evidence(&mut self, proof: &mut TurnProof, deadline: Instant) -> Result<(), Failure> {
        let mut cursor: Option<String> = None;
        loop {
            let mut params = json!({
                "sessionId": self.binding.session_id,
                "direction": "backward",
                "limit": 1000
            });
            if let Some(cursor) = &cursor {
                params["cursor"] = Value::String(cursor.clone());
            }
            let page = self.request("view/page", params)?;
            let result = loop {
                let remaining = deadline
                    .checked_duration_since(Instant::now())
                    .ok_or(Failure::TimedOut)?;
                let frame = match self.events.recv_timeout(remaining) {
                    Ok(frame) => frame,
                    Err(_) if proof.receipt().is_some() || proof.terminal_failure() => {
                        return Ok(())
                    }
                    Err(_) => return Err(Failure::EndpointUnavailable),
                };
                if frame.get("id").and_then(Value::as_u64) != Some(page) {
                    // A live event may race with the durable page response. It
                    // is evidence too and must not be discarded.
                    proof.record(&frame, &self.binding.session_id);
                    if proof.receipt().is_some() || proof.terminal_failure() {
                        return Ok(());
                    }
                    continue;
                }
                if frame.get("error").is_some() {
                    if proof.receipt().is_some() || proof.terminal_failure() {
                        return Ok(());
                    }
                    return Err(classify_msp_error(&frame));
                }
                break frame
                    .get("result")
                    .cloned()
                    .ok_or(Failure::ProviderRefused)?;
            };
            let Some(events) = result.get("events").and_then(Value::as_array) else {
                return Err(Failure::ProviderRefused);
            };
            for event in events {
                proof.record(event, &self.binding.session_id);
            }
            if proof.receipt().is_some() || proof.terminal_failure() {
                return Ok(());
            }
            cursor = result
                .get("nextCursor")
                .and_then(Value::as_str)
                .map(str::to_owned);
            if cursor.is_none() {
                return Ok(());
            }
        }
    }
}

struct MspFrameQueue {
    capacity: usize,
    state: Mutex<MspFrameState>,
    ready: Condvar,
}

struct MspFrameState {
    frames: VecDeque<Value>,
    reader_open: bool,
}

struct MspFrameWriter(Arc<MspFrameQueue>);
struct MspFrameReader(Arc<MspFrameQueue>);

#[derive(Debug)]
enum MspRecvError {
    Timeout,
    Disconnected,
}

fn msp_frame_channel(capacity: usize) -> (MspFrameWriter, MspFrameReader) {
    let queue = Arc::new(MspFrameQueue {
        capacity: capacity.max(1),
        state: Mutex::new(MspFrameState {
            frames: VecDeque::new(),
            reader_open: true,
        }),
        ready: Condvar::new(),
    });
    (MspFrameWriter(queue.clone()), MspFrameReader(queue))
}

impl MspFrameWriter {
    fn send(&self, value: Value) {
        let mut state = self
            .0
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if state.frames.len() == self.0.capacity {
            let notification = state
                .frames
                .iter()
                .position(|frame| frame.get("id").is_none());
            if value.get("id").is_some() {
                // Keep RPC progress ahead of live notifications. With only
                // responses buffered, retain the newest one.
                let _ = state.frames.remove(notification.unwrap_or(0));
            } else if let Some(index) = notification {
                let _ = state.frames.remove(index);
            } else {
                // Never evict a response merely for a notification.
                return;
            }
        }
        state.frames.push_back(value);
        self.0.ready.notify_one();
    }
}

impl Drop for MspFrameWriter {
    fn drop(&mut self) {
        let mut state = self
            .0
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        state.reader_open = false;
        self.0.ready.notify_all();
    }
}

impl MspFrameReader {
    fn recv_timeout(&self, timeout: Duration) -> Result<Value, MspRecvError> {
        let deadline = Instant::now() + timeout;
        let mut state = self
            .0
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        loop {
            if let Some(frame) = state.frames.pop_front() {
                return Ok(frame);
            }
            if !state.reader_open {
                return Err(MspRecvError::Disconnected);
            }
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                return Err(MspRecvError::Timeout);
            };
            let waited = self
                .0
                .ready
                .wait_timeout(state, remaining)
                .unwrap_or_else(|error| error.into_inner());
            state = waited.0;
            if waited.1.timed_out() && state.frames.is_empty() {
                return Err(MspRecvError::Timeout);
            }
        }
    }

    #[cfg(test)]
    fn try_recv(&self) -> Option<Value> {
        self.0
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .frames
            .pop_front()
    }
}

fn read_msp_frames<R: BufRead>(reader: R, sender: MspFrameWriter) {
    read_msp_frames_with_limit(reader, sender, MAX_MSP_FRAME);
}

fn read_msp_frames_with_limit<R: BufRead>(mut reader: R, sender: MspFrameWriter, limit: usize) {
    loop {
        let mut bytes = Vec::new();
        let read = match (&mut reader)
            .take(limit.saturating_add(2) as u64)
            .read_until(b'\n', &mut bytes)
        {
            Ok(0) | Err(_) => break,
            Ok(read) => read,
        };
        if bytes.last() == Some(&b'\n') {
            bytes.pop();
            if bytes.last() == Some(&b'\r') {
                bytes.pop();
            }
        }
        // `Take` bounds allocation even when a compromised child never emits
        // a delimiter. Reject the whole reader after an oversized frame so a
        // suffix cannot be mistaken for a new JSON message.
        if bytes.len() > limit || read > limit.saturating_add(1) {
            break;
        }
        if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
            if !msp_frame_is_relevant(&value) {
                continue;
            }
            // Keep the reader and Muse's stdout live without unbounded memory
            // or stdio backpressure. Overflow evicts the oldest notification;
            // losing evidence can only leave the exact correlated receipt
            // incomplete, while a later same-generation replay can page
            // Muse's durable view for the exact command.
            sender.send(value);
        }
    }
}

fn msp_frame_is_relevant(frame: &Value) -> bool {
    frame.get("id").is_some()
        || matches!(
            text(frame, &["method"]),
            Some("item/completed" | "turn/completed" | "turn/unqueued")
        )
}

impl MspEngine for SystemMspHost {
    fn submit(
        &mut self,
        session_id: &str,
        command_id: &str,
        _request_hash: &str,
        text_value: &str,
        replay: bool,
        timeout: Duration,
    ) -> Outcome {
        if session_id != self.binding.session_id {
            return Outcome::Refused(Failure::IdentityMismatch);
        }
        let deadline = Instant::now() + timeout;
        let rpc_id = match self.request(
            "turn/start",
            json!({
                "sessionId": session_id,
                "commandId": command_id,
                "input": [{"type":"text","text":text_value}],
                "ifBusy": "queue"
            }),
        ) {
            Ok(id) => id,
            // `request` writes directly to MSP stdio. A write error cannot
            // prove that Muse did not durably accept the command.
            Err(_) => return Outcome::InDoubt(Failure::PriorAttemptUncertain),
        };
        let mut proof = TurnProof::new(command_id, text_value);
        let mut paged = false;
        while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
            let frame = match self.events.recv_timeout(remaining) {
                Ok(frame) => frame,
                Err(_) => return Outcome::InDoubt(Failure::TimedOut),
            };
            if frame.get("id").and_then(Value::as_u64) == Some(rpc_id) {
                if frame.get("error").is_some() {
                    let failure = classify_msp_error(&frame);
                    return match failure {
                        Failure::RequestConflict | Failure::IdentityMismatch => {
                            Outcome::Refused(failure)
                        }
                        _ => Outcome::InDoubt(failure),
                    };
                }
                let Some(result) = frame.get("result") else {
                    return Outcome::InDoubt(Failure::ProviderRefused);
                };
                if !proof.ack(result) {
                    return Outcome::InDoubt(Failure::ProviderRefused);
                }
                if replay && !paged {
                    paged = true;
                    if self.page_evidence(&mut proof, deadline).is_err() {
                        if let Some(outcome) = proof.outcome() {
                            return outcome;
                        }
                        return Outcome::InDoubt(Failure::PriorAttemptUncertain);
                    }
                }
            } else {
                proof.record(&frame, session_id);
            }
            if let Some(outcome) = proof.outcome() {
                return outcome;
            }
        }
        Outcome::InDoubt(Failure::TimedOut)
    }
}

impl Drop for SystemMspHost {
    fn drop(&mut self) {
        let _ = self.stdin.flush();
        let _ = &self.child;
    }
}

fn classify_msp_error(frame: &Value) -> Failure {
    let kind = text(frame, &["error", "data", "kind"]);
    let reason = text(frame, &["error", "data", "reason"]);
    match (kind, reason) {
        (Some("commandRejected"), Some("command_id_conflict" | "commandIdConflict"))
        | (Some("command_id_conflict" | "commandIdConflict"), _) => Failure::RequestConflict,
        (
            Some(
                "sessionInUse"
                | "sessionNotFound"
                | "sessionAmbiguous"
                | "sessionNotLoaded"
                | "sessionStreamMismatch"
                | "wrong_session",
            ),
            _,
        ) => Failure::IdentityMismatch,
        _ => Failure::ProviderRefused,
    }
}

fn text<'a>(value: &'a Value, path: &[&str]) -> Option<&'a str> {
    let mut value = value;
    for component in path {
        value = value.get(*component)?;
    }
    value.as_str()
}

#[derive(Default)]
struct Evidence {
    user: bool,
    terminal: Option<String>,
}

struct TurnProof {
    command_id: String,
    prompt: String,
    turn_id: Option<String>,
    turns: HashMap<String, Evidence>,
    rejected_turns: HashSet<String>,
}

impl TurnProof {
    fn new(command_id: &str, prompt: &str) -> Self {
        Self {
            command_id: command_id.to_owned(),
            prompt: prompt.to_owned(),
            turn_id: None,
            turns: HashMap::new(),
            rejected_turns: HashSet::new(),
        }
    }

    fn ack(&mut self, result: &Value) -> bool {
        let valid = text(result, &["commandId"]) == Some(self.command_id.as_str())
            && text(result, &["status"]) == Some("accepted");
        let max_turn_id =
            MAX_RECEIPT_ID.saturating_sub(MUSE_RECEIPT_PREFIX.len() + self.command_id.len() + 1);
        let Some(turn_id) =
            text(result, &["turnId"]).filter(|value| super::printable(value, max_turn_id))
        else {
            return false;
        };
        if !valid || self.turn_id.as_deref().is_some_and(|old| old != turn_id) {
            return false;
        }
        self.turn_id = Some(turn_id.to_owned());
        true
    }

    fn record(&mut self, frame: &Value, session_id: &str) {
        let method = text(frame, &["method"]);
        let params = frame.get("params").unwrap_or(&Value::Null);
        if text(params, &["sessionId"]) != Some(session_id) {
            return;
        }
        match method {
            Some("item/completed") => {
                let Some(turn_id) = text(params, &["item", "turnId"]) else {
                    return;
                };
                let evidence = self.turns.entry(turn_id.into()).or_default();
                match text(params, &["item", "kind"]) {
                    Some("userMessage")
                        if text(params, &["item", "commandId"])
                            == Some(self.command_id.as_str())
                            && text(params, &["item", "status"]) == Some("completed")
                            && text(params, &["item", "text"]) == Some(self.prompt.as_str()) =>
                    {
                        evidence.user = true;
                    }
                    _ => {}
                }
            }
            Some("turn/completed") => {
                if let (Some(turn_id), Some(terminal)) =
                    (text(params, &["turnId"]), text(params, &["terminal"]))
                {
                    self.turns.entry(turn_id.into()).or_default().terminal = Some(terminal.into());
                }
            }
            Some("turn/unqueued")
                if text(params, &["commandId"]) == Some(self.command_id.as_str()) =>
            {
                if let Some(turn_id) = text(params, &["turnId"]) {
                    self.rejected_turns.insert(turn_id.into());
                }
            }
            _ => {}
        }
    }

    fn receipt(&self) -> Option<String> {
        let turn_id = self.turn_id.as_deref()?;
        let evidence = self.turns.get(turn_id)?;
        evidence
            .user
            .then(|| format!("{MUSE_RECEIPT_PREFIX}{}:{turn_id}", self.command_id))
    }

    fn terminal_failure(&self) -> bool {
        let Some(turn_id) = self.turn_id.as_deref() else {
            return false;
        };
        self.rejected_turns.contains(turn_id)
            || self
                .turns
                .get(turn_id)
                .and_then(|evidence| evidence.terminal.as_deref())
                .is_some_and(|terminal| terminal != "completed")
    }

    fn was_unqueued(&self) -> bool {
        self.turn_id
            .as_deref()
            .is_some_and(|turn_id| self.rejected_turns.contains(turn_id))
    }

    fn outcome(&self) -> Option<Outcome> {
        // Muse may fail or cancel model generation after it has durably
        // accepted and recorded the exact user message. That is still a
        // successful Relay delivery. An authoritative unqueue is different:
        // it retracts the accepted handoff and must win over stale evidence.
        if self.was_unqueued() {
            return Some(Outcome::InDoubt(Failure::ProviderRefused));
        }
        if let Some(receipt_id) = self.receipt() {
            return Some(Outcome::Delivered { receipt_id });
        }
        self.terminal_failure()
            .then_some(Outcome::InDoubt(Failure::ProviderRefused))
    }
}

#[cfg(test)]
#[cfg(unix)]
mod tests {
    use super::super::platform::PermissionsExt;
    use super::*;
    use crate::relay::process::ProcessInfo;
    use std::collections::VecDeque;
    use std::path::Path;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct FixedAuthority(bool);
    impl Authority for FixedAuthority {
        fn verify(&self, _: &Binding) -> bool {
            self.0
        }
    }

    struct RecordingTransport {
        calls: Mutex<Vec<(String, String, bool)>>,
    }

    impl ControlTransport for RecordingTransport {
        fn turn(
            &self,
            _: &Request<'_>,
            command_id: &str,
            request_hash: &str,
            replay: bool,
        ) -> Outcome {
            self.calls
                .lock()
                .unwrap()
                .push((command_id.into(), request_hash.into(), replay));
            Outcome::Delivered {
                receipt_id: format!("muse-msp:{command_id}:turn"),
            }
        }
    }

    fn binding(socket: &Path) -> Binding {
        let executable = std::env::current_exe().unwrap();
        let process = SystemProcesses::default()
            .process(std::process::id() as i32)
            .unwrap_or(ProcessInfo {
                pid: std::process::id() as i32,
                parent: 1,
                uid: current_uid(),
                start: 1,
            });
        Binding {
            provider: Provider::Muse,
            transport: Transport::Msp,
            workspace_id: "rw_expected".into(),
            session_id: "0198f0aa-1111-7000-8000-0000000000aa".into(),
            owner_id: "owner-1".into(),
            credential_reference: String::new(),
            owner_uid: current_uid(),
            endpoint_id: "muse-host-generation-1".into(),
            auth_id: "account:principal-1".into(),
            protocol_id: "sha256:c8d1a2a1866814e220fd396d382a9a75861412feee884b5021b2ee359bd3dc59"
                .into(),
            cwd: socket.parent().unwrap().into(),
            model_id: "muse-large-2".into(),
            agent_version: "1.4.0".into(),
            executable,
            leader_pid: process.pid,
            leader_start: process.start,
            socket_path: socket.into(),
            socket_device: 0,
            socket_inode: 0,
        }
    }

    fn request<'a>(binding: &'a Binding, text: &'a str) -> Request<'a> {
        Request {
            binding,
            delivery_id: "delivery-1",
            message_id: "message-1",
            text,
            timeout: Duration::from_secs(5),
        }
    }

    #[test]
    fn adapter_refuses_wrong_host_workspace_or_auth_before_transport() {
        let transport = Arc::new(RecordingTransport {
            calls: Mutex::new(vec![]),
        });
        let adapter = MuseMspAdapter::new(
            "rw_expected".into(),
            "owner-1".into(),
            current_uid(),
            "muse-host-generation-1".into(),
            "account:principal-1".into(),
            Arc::new(FixedAuthority(true)),
            transport.clone(),
        );
        let directory = tempfile::tempdir().unwrap();
        let mut bound = binding(&directory.path().join("control.sock"));
        bound.endpoint_id = "stale-host".into();
        assert_eq!(
            adapter.inject(
                &request(&bound, "hello"),
                "0198f0ab-9999-7000-8000-000000000001"
            ),
            Outcome::Refused(Failure::IdentityMismatch)
        );
        bound.endpoint_id = "muse-host-generation-1".into();
        bound.auth_id = "other-principal".into();
        assert_eq!(
            adapter.inject(
                &request(&bound, "hello"),
                "0198f0ab-9999-7000-8000-000000000002"
            ),
            Outcome::Refused(Failure::IdentityMismatch)
        );
        assert!(transport.calls.lock().unwrap().is_empty());
    }

    type EngineCall = (String, String, String, bool);

    #[derive(Default)]
    struct FakeEngine {
        calls: Arc<Mutex<Vec<EngineCall>>>,
    }

    impl MspEngine for FakeEngine {
        fn submit(
            &mut self,
            session_id: &str,
            command_id: &str,
            request_hash: &str,
            _text: &str,
            replay: bool,
            _: Duration,
        ) -> Outcome {
            self.calls.lock().unwrap().push((
                session_id.into(),
                command_id.into(),
                request_hash.into(),
                replay,
            ));
            Outcome::Delivered {
                receipt_id: format!("muse-msp:{command_id}:turn"),
            }
        }
    }

    #[test]
    fn private_socket_round_trip_binds_session_and_echoes_receipt() {
        let directory = tempfile::tempdir().unwrap();
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let calls = Arc::new(Mutex::new(vec![]));
        let engine = FakeEngine {
            calls: calls.clone(),
        };
        let manager = Arc::new(
            HostManager::bind(
                binding(&directory.path().join("control.sock")),
                Box::new(engine),
            )
            .unwrap(),
        );
        let bound = manager.binding().clone();
        let abandoned_request = request(&bound, "abandoned");
        let mut abandoned = UnixStream::connect(&bound.socket_path).unwrap();
        serde_json::to_writer(
            &mut abandoned,
            &ControlRequest {
                version: CONTROL_VERSION,
                binding: WireBinding::of(&bound).unwrap(),
                command_id: "0198f0ab-9999-7000-8000-000000000002".into(),
                request_hash: Journal::request_hash(&abandoned_request),
                message_id: abandoned_request.message_id.into(),
                text: abandoned_request.text.into(),
                timeout_ms: 5_000,
                replay: false,
            },
        )
        .unwrap();
        abandoned.write_all(b"\n").unwrap();
        abandoned.flush().unwrap();
        abandoned.shutdown(std::net::Shutdown::Both).unwrap();
        manager
            .serve_one()
            .expect("a disconnected client does not terminate the host");

        let server = manager.clone();
        let thread = std::thread::spawn(move || server.serve_one().unwrap());
        let outcome = SystemControlTransport.turn(
            &request(&bound, "hello"),
            "0198f0ab-9999-7000-8000-000000000003",
            &Journal::request_hash(&request(&bound, "hello")),
            false,
        );
        thread.join().unwrap();
        assert_eq!(
            outcome,
            Outcome::Delivered {
                receipt_id: "muse-msp:0198f0ab-9999-7000-8000-000000000003:turn".into()
            }
        );
        assert_eq!(calls.lock().unwrap().len(), 2);
        assert_eq!(
            fs::metadata(&bound.socket_path).unwrap().mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn host_bind_reclaims_only_an_inactive_owned_socket() {
        let directory = tempfile::tempdir().unwrap();
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let path = directory.path().join("control.sock");

        let stale = UnixListener::bind(&path).unwrap();
        drop(stale);
        assert!(path.exists());
        // Other tests spawn helper children in parallel. On platforms where
        // CLOEXEC is installed just after socket creation, let any transient
        // inherited descriptor close before proving stale-path recovery.
        std::thread::sleep(Duration::from_millis(50));
        let manager = HostManager::bind(binding(&path), Box::new(FakeEngine::default())).unwrap();
        assert!(fs::symlink_metadata(&path).unwrap().file_type().is_socket());
        drop(manager);
        assert!(!path.exists());

        let live = UnixListener::bind(&path).unwrap();
        let error = HostManager::bind(binding(&path), Box::new(FakeEngine::default()))
            .err()
            .unwrap();
        assert_eq!(error.kind(), std::io::ErrorKind::AddrInUse);
        assert!(UnixStream::connect(&path).is_ok());
        drop(live);
        fs::remove_file(&path).unwrap();

        fs::write(&path, b"do not replace").unwrap();
        let error = HostManager::bind(binding(&path), Box::new(FakeEngine::default()))
            .err()
            .unwrap();
        assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read(&path).unwrap(), b"do not replace");
    }

    #[test]
    fn a_failed_post_bind_construction_removes_the_exact_socket() {
        let directory = tempfile::tempdir().unwrap();
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let path = directory.path().join("control.sock");
        let listener = UnixListener::bind(&path).unwrap();
        let metadata = fs::symlink_metadata(&path).unwrap();
        let guard = BoundSocketGuard {
            path: path.clone(),
            identity: socket_identity(&metadata),
            armed: true,
        };
        drop(guard);
        assert!(!path.exists());
        drop(listener);
    }

    #[test]
    fn control_host_refuses_changed_payload_hash_without_calling_msp() {
        let directory = tempfile::tempdir().unwrap();
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let calls = Arc::new(Mutex::new(vec![]));
        let manager = Arc::new(
            HostManager::bind(
                binding(&directory.path().join("control.sock")),
                Box::new(FakeEngine {
                    calls: calls.clone(),
                }),
            )
            .unwrap(),
        );
        let bound = manager.binding().clone();
        let server = manager.clone();
        let thread = std::thread::spawn(move || server.serve_one().unwrap());
        let outcome = SystemControlTransport.turn(
            &request(&bound, "changed"),
            "0198f0ab-9999-7000-8000-000000000004",
            &Journal::request_hash(&request(&bound, "original")),
            true,
        );
        thread.join().unwrap();
        assert_eq!(outcome, Outcome::Refused(Failure::RequestConflict));
        assert!(calls.lock().unwrap().is_empty());
    }

    #[test]
    fn client_refuses_a_control_frame_that_json_escaping_pushes_over_the_wire_limit() {
        let directory = tempfile::tempdir().unwrap();
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let calls = Arc::new(Mutex::new(vec![]));
        let manager = Arc::new(
            HostManager::bind(
                binding(&directory.path().join("control.sock")),
                Box::new(FakeEngine {
                    calls: calls.clone(),
                }),
            )
            .unwrap(),
        );
        let bound = manager.binding().clone();
        let text = "\0".repeat(64 * 1024);
        let request = request(&bound, &text);
        let server = manager.clone();
        let thread = std::thread::spawn(move || server.serve_one().unwrap());
        assert_eq!(
            SystemControlTransport.turn(
                &request,
                "0198f0ab-9999-7000-8000-00000000000a",
                &Journal::request_hash(&request),
                false,
            ),
            Outcome::Refused(Failure::ProviderRefused)
        );
        thread.join().unwrap();
        assert!(calls.lock().unwrap().is_empty());
    }

    #[test]
    fn control_host_drops_an_oversized_frame_without_calling_msp() {
        let directory = tempfile::tempdir().unwrap();
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let calls = Arc::new(Mutex::new(vec![]));
        let manager = Arc::new(
            HostManager::bind(
                binding(&directory.path().join("control.sock")),
                Box::new(FakeEngine {
                    calls: calls.clone(),
                }),
            )
            .unwrap(),
        );
        let bound = manager.binding().clone();
        let server = manager.clone();
        let thread = std::thread::spawn(move || server.serve_one().unwrap());
        let mut socket = UnixStream::connect(&bound.socket_path).unwrap();
        socket
            .write_all(&vec![b'x'; MAX_CONTROL_FRAME as usize])
            .unwrap();
        socket.shutdown(std::net::Shutdown::Write).unwrap();
        thread.join().unwrap();
        assert!(calls.lock().unwrap().is_empty());
    }

    #[test]
    fn control_client_refuses_a_same_owner_listener_with_the_wrong_peer_pid() {
        let directory = tempfile::tempdir().unwrap();
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let path = directory.path().join("control.sock");
        let listener = UnixListener::bind(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let metadata = fs::symlink_metadata(&path).unwrap();
        let mut bound = binding(&path);
        bound.socket_device = metadata.dev();
        bound.socket_inode = metadata.ino();
        bound.leader_pid = bound.leader_pid.saturating_add(1);
        let request = request(&bound, "hello");
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut bytes = Vec::new();
            socket.read_to_end(&mut bytes).unwrap();
            bytes
        });
        assert_eq!(
            SystemControlTransport.turn(
                &request,
                "0198f0ab-9999-7000-8000-00000000000b",
                &Journal::request_hash(&request),
                false,
            ),
            Outcome::Refused(Failure::IdentityMismatch)
        );
        assert!(server.join().unwrap().is_empty());
    }

    fn frame(raw: &str) -> Value {
        serde_json::from_str(raw).unwrap()
    }

    #[test]
    fn structured_msp_errors_refuse_conflicts_and_wrong_sessions() {
        assert_eq!(
            classify_msp_error(&json!({
                "error": {
                    "code": -32030,
                    "message": "command rejected",
                    "data": {
                        "kind": "commandRejected",
                        "reason": "command_id_conflict"
                    }
                }
            })),
            Failure::RequestConflict
        );
        assert_eq!(
            classify_msp_error(&json!({
                "error": {
                    "code": -32021,
                    "message": "session in use",
                    "data": {"kind": "sessionInUse"}
                }
            })),
            Failure::IdentityMismatch
        );
    }

    #[test]
    fn idle_notifications_are_discarded_and_overflow_keeps_the_reader_live() {
        let input = format!(
            "{}\n{}\n{}\n",
            json!({"jsonrpc":"2.0","method":"session/tokenUsage","params":{"tokens":1}}),
            json!({"jsonrpc":"2.0","id":1,"result":{}}),
            json!({"jsonrpc":"2.0","id":2,"result":{}})
        );
        let (sender, events) = msp_frame_channel(1);
        read_msp_frames(std::io::Cursor::new(input), sender);
        assert_eq!(events.try_recv().unwrap()["id"], 2);
        assert!(events.try_recv().is_none());
    }

    #[test]
    fn an_unterminated_oversized_msp_frame_is_bounded_and_not_resynchronized() {
        let valid = serde_json::to_vec(&json!({"id":7,"result":{}})).unwrap();
        let mut input = vec![b'x'; 33];
        input.push(b'\n');
        input.extend(valid);
        input.push(b'\n');
        let (sender, events) = msp_frame_channel(2);
        read_msp_frames_with_limit(std::io::Cursor::new(input), sender, 32);
        assert!(events.try_recv().is_none());
    }

    #[test]
    fn notification_overflow_never_evicts_an_rpc_response() {
        let (sender, events) = msp_frame_channel(2);
        sender.send(json!({"id":7,"result":{}}));
        sender.send(json!({"method":"turn/started"}));
        sender.send(json!({"method":"turn/completed"}));
        assert_eq!(events.try_recv().unwrap()["id"], 7);
        assert_eq!(events.try_recv().unwrap()["method"], "turn/completed");
    }

    #[test]
    fn child_guard_terminates_the_managed_process_group() {
        let mut command = Command::new("/bin/sh");
        command
            .arg("-c")
            .arg("sleep 30 & echo $!; wait")
            .stdout(Stdio::piped())
            .process_group(0);
        let mut child = command.spawn().unwrap();
        let mut stdout = BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        stdout.read_line(&mut line).unwrap();
        let descendant: i32 = line.trim().parse().unwrap();
        drop(ChildGuard::new(child));

        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let alive = unsafe { libc::kill(descendant, 0) } == 0;
            if !alive && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "managed descendant {descendant} survived process-group teardown"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn msp_write_failure_after_dispatch_begins_is_in_doubt() {
        let directory = tempfile::tempdir().unwrap();
        let mut child = Command::new("/bin/sh")
            .arg("-c")
            .arg("exec 0<&-; echo ready; sleep 30")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .process_group(0)
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let mut ready = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut ready)
            .unwrap();
        assert_eq!(ready.trim(), "ready");
        let (_sender, events) = msp_frame_channel(MAX_BUFFERED_MSP_FRAMES);
        let mut host = SystemMspHost {
            binding: binding(&directory.path().join("control.sock")),
            child: ChildGuard::new(child),
            stdin,
            events,
            next_rpc_id: 1,
        };
        assert_eq!(
            host.submit(
                "0198f0aa-1111-7000-8000-0000000000aa",
                "0198f0ab-9999-7000-8000-000000000005",
                "request-hash",
                "hello",
                false,
                Duration::from_secs(1),
            ),
            Outcome::InDoubt(Failure::PriorAttemptUncertain)
        );
    }

    #[test]
    fn replay_accepts_a_durable_user_event_before_a_later_model_failure() {
        let directory = tempfile::tempdir().unwrap();
        let command = "0198f0ab-9999-7000-8000-000000000006";
        let session = "0198f0aa-1111-7000-8000-0000000000aa";
        let mut child = Command::new("/bin/cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .process_group(0)
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let (sender, events) = msp_frame_channel(MAX_BUFFERED_MSP_FRAMES);
        sender.send(json!({"id":1,"result":{
            "commandId":command,"status":"accepted","turnId":command
        }}));
        // Muse's ViewPageResult contains unframed notifications: each event
        // is the nested {method, params} pair used by live delivery, with its
        // durable sourceRange retained in params.
        sender.send(json!({"id":2,"result":{
            "events":[{"method":"item/completed","params":{
                "sessionId":session,
                "viewCursor":"v:fixture:4",
                "item":{"itemId":"user","kind":"userMessage","turnId":command,
                    "revision":1,"status":"completed","commandId":command,"text":"hello"},
                "sourceRange":{
                    "stream":{"kind":"run","id":command},
                    "first":{"eventId":"0198f0ab-9999-7000-8000-000000000007","sequence":4},
                    "last":{"eventId":"0198f0ab-9999-7000-8000-000000000007","sequence":4}
                }
            }},{"method":"turn/completed","params":{
                "sessionId":session,
                "viewCursor":"v:fixture:5",
                "turnId":command,
                "terminal":"failed",
                "sourceRange":{
                    "stream":{"kind":"run","id":command},
                    "first":{"eventId":"0198f0ab-9999-7000-8000-000000000008","sequence":5},
                    "last":{"eventId":"0198f0ab-9999-7000-8000-000000000008","sequence":5}
                }
            }}],
            "nextCursor":null,
            "resolvedAnchor":null
        }}));
        drop(sender);
        let mut host = SystemMspHost {
            binding: binding(&directory.path().join("control.sock")),
            child: ChildGuard::new(child),
            stdin,
            events,
            next_rpc_id: 1,
        };
        assert_eq!(
            host.submit(
                session,
                command,
                "request-hash",
                "hello",
                true,
                Duration::from_secs(1),
            ),
            Outcome::Delivered {
                receipt_id: format!("muse-msp:{command}:{command}")
            }
        );
    }

    #[test]
    fn receipt_requires_matching_acceptance_and_completed_user_item_only() {
        let session = "0198f0aa-1111-7000-8000-0000000000aa";
        let command = "018f6a1e-9b3c-7c21-a54a-2f30bd3c9f10";
        let mut proof = TurnProof::new(command, "hello");
        assert!(proof.ack(&json!({
            "commandId":command,"status":"accepted","turnId":command,
            "startedNewTurn":true,"disposition":"started"
        })));
        assert_eq!(proof.receipt(), None, "the ack alone is insufficient");
        proof.record(&frame(&format!(r#"{{"method":"item/completed","params":{{"sessionId":"{session}","item":{{"itemId":"u","kind":"userMessage","turnId":"{command}","revision":1,"status":"completed","commandId":"{command}","text":"hello"}}}}}}"#)), session);
        assert_eq!(
            proof.receipt(),
            Some(format!("muse-msp:{command}:{command}"))
        );
    }

    #[test]
    fn a_durable_unqueue_takes_precedence_over_surviving_user_item_evidence() {
        let session = "0198f0aa-1111-7000-8000-0000000000aa";
        let command = "018f6a1e-9b3c-7c21-a54a-2f30bd3c9f10";
        let mut proof = TurnProof::new(command, "hello");
        assert!(proof.ack(&json!({
            "commandId":command,"status":"accepted","turnId":command
        })));
        proof.record(&frame(&format!(r#"{{"method":"item/completed","params":{{"sessionId":"{session}","item":{{"itemId":"u","kind":"userMessage","turnId":"{command}","revision":1,"status":"completed","commandId":"{command}","text":"hello"}}}}}}"#)), session);
        proof.record(&frame(&format!(r#"{{"method":"turn/unqueued","params":{{"sessionId":"{session}","turnId":"{command}","commandId":"{command}"}}}}"#)), session);
        assert_eq!(
            proof.outcome(),
            Some(Outcome::InDoubt(Failure::ProviderRefused))
        );
    }

    #[test]
    fn a_later_model_failure_does_not_retract_a_recorded_user_message() {
        let session = "0198f0aa-1111-7000-8000-0000000000aa";
        let command = "018f6a1e-9b3c-7c21-a54a-2f30bd3c9f10";
        let mut proof = TurnProof::new(command, "hello");
        assert!(proof.ack(&json!({
            "commandId":command,"status":"accepted","turnId":command
        })));
        proof.record(&frame(&format!(r#"{{"method":"item/completed","params":{{"sessionId":"{session}","item":{{"itemId":"u","kind":"userMessage","turnId":"{command}","revision":1,"status":"completed","commandId":"{command}","text":"hello"}}}}}}"#)), session);
        proof.record(&frame(&format!(r#"{{"method":"turn/completed","params":{{"sessionId":"{session}","turnId":"{command}","terminal":"failed"}}}}"#)), session);
        assert_eq!(
            proof.outcome(),
            Some(Outcome::Delivered {
                receipt_id: format!("muse-msp:{command}:{command}")
            })
        );
    }

    #[test]
    fn receipt_rejects_a_turn_id_that_would_exceed_the_journal_limit() {
        let command = "018f6a1e-9b3c-7c21-a54a-2f30bd3c9f10";
        let max_turn_id = MAX_RECEIPT_ID - MUSE_RECEIPT_PREFIX.len() - command.len() - 1;
        let mut accepted = TurnProof::new(command, "hello");
        assert!(accepted.ack(&json!({
            "commandId":command,
            "status":"accepted",
            "turnId":"t".repeat(max_turn_id)
        })));
        assert_eq!(
            format!("{MUSE_RECEIPT_PREFIX}{command}:{}", "t".repeat(max_turn_id)).len(),
            MAX_RECEIPT_ID
        );

        let mut rejected = TurnProof::new(command, "hello");
        assert!(!rejected.ack(&json!({
            "commandId":command,
            "status":"accepted",
            "turnId":"t".repeat(max_turn_id + 1)
        })));
    }

    struct ReplayEngine {
        outcomes: VecDeque<Outcome>,
        commands: Arc<Mutex<Vec<String>>>,
        calls: Arc<AtomicUsize>,
    }

    impl MspEngine for ReplayEngine {
        fn submit(
            &mut self,
            _: &str,
            command_id: &str,
            _: &str,
            _: &str,
            _: bool,
            _: Duration,
        ) -> Outcome {
            self.commands.lock().unwrap().push(command_id.into());
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.outcomes.pop_front().unwrap()
        }
    }

    #[test]
    fn coordinator_replays_same_uuidv7_only_within_immutable_host_generation() {
        let directory = tempfile::tempdir().unwrap();
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let commands = Arc::new(Mutex::new(vec![]));
        let calls = Arc::new(AtomicUsize::new(0));
        let manager = Arc::new(
            HostManager::bind(
                binding(&directory.path().join("control.sock")),
                Box::new(ReplayEngine {
                    outcomes: vec![
                        Outcome::InDoubt(Failure::TimedOut),
                        Outcome::Retry(Failure::EndpointUnavailable),
                        Outcome::Delivered {
                            receipt_id: "muse-msp:receipt".into(),
                        },
                    ]
                    .into(),
                    commands: commands.clone(),
                    calls: calls.clone(),
                }),
            )
            .unwrap(),
        );
        let bound = manager.binding().clone();
        let adapter = Arc::new(MuseMspAdapter::new(
            bound.workspace_id.clone(),
            bound.owner_id.clone(),
            bound.owner_uid,
            bound.endpoint_id.clone(),
            bound.auth_id.clone(),
            Arc::new(FixedAuthority(true)),
            Arc::new(SystemControlTransport),
        ));
        let coordinator = super::super::Coordinator::new(
            super::super::Gate::enabled([Provider::Muse]),
            Journal::new(directory.path().join("journal")).unwrap(),
            vec![adapter],
        )
        .unwrap();
        for attempt in 0..3 {
            let server = manager.clone();
            std::thread::scope(|scope| {
                scope.spawn(move || server.serve_one().unwrap());
                let outcome = coordinator.inject(&request(&bound, "hello"));
                if attempt == 0 {
                    assert_eq!(outcome, Outcome::InDoubt(Failure::TimedOut));
                } else if attempt == 1 {
                    assert_eq!(outcome, Outcome::Retry(Failure::EndpointUnavailable));
                } else {
                    assert_eq!(
                        outcome,
                        Outcome::Delivered {
                            receipt_id: "muse-msp:receipt".into()
                        }
                    );
                }
            });
            if attempt == 0 {
                let mut replacement = bound.clone();
                replacement.endpoint_id = "muse-host-generation-2".into();
                assert_eq!(
                    coordinator.inject(&request(&replacement, "hello")),
                    Outcome::Refused(Failure::RequestConflict),
                    "a replacement host generation cannot inherit an in-doubt command"
                );
                assert_eq!(calls.load(Ordering::SeqCst), 1);
            }
        }
        let commands = commands.lock().unwrap().clone();
        assert_eq!(commands.len(), 3);
        assert!(commands.iter().all(|command| command == &commands[0]));
        assert!(super::super::is_uuid_v7(&commands[0]));
    }
}
