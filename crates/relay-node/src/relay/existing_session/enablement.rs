//! Discovery, immutable registration, and delivery for an already-open Grok
//! session. A binding is stored only after the kernel authority proves it.
//! A binding that no longer proves is kept but never sent to. Only once its
//! leader is dead may a binding with the same workspace, owner and uid
//! replace it, and an agent registered against the old one stays refused.
//!
//! This route is separate from the probe-managed one in `managed_sessions`:
//! its own default-off flag, registry, journal and credential namespace. Its
//! authority refuses a leader carrying the managed marker, and the desktop
//! refuses a session that both routes claim.

use super::grok::{self, AcpTransport, Authority, GrokAdapter};
use super::platform::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use super::{
    Binding, Coordinator, Eligibility, Failure, Gate, Journal, Outcome, Provider, Request,
    Transport,
};
use crate::relay::process::ProcessTable;
use crate::relay::sessions::DiscoveredSession;
use crate::relay::store::random_hex;
use crate::relay::store::{SessionKind, Target};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

/// The already-open route's switch. The route is on unless this is exactly
/// `0`; it is independent of the managed route's
/// `AGENT_RELAY_ENABLE_MANAGED_GROK`, which stays off by default.
pub const ENABLE: &str = "AGENT_RELAY_ENABLE_EXISTING_GROK";

/// Where the already-open route keeps its bindings and its receipts, in the
/// app's own data directory beside the managed registry. Neither is shared
/// with the managed route.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Paths {
    pub bindings: PathBuf,
    pub journal: PathBuf,
}

impl Paths {
    /// `None` when `ENABLE` is exactly `0`, and on Windows, where Grok's
    /// leader socket does not exist and the route is reported unavailable.
    pub fn from_env(env: &dyn Fn(&str) -> Option<String>, app_data_dir: &Path) -> Option<Self> {
        let root = app_data_dir.join("existing-grok-sessions");
        if !super::platform::SUPPORTED {
            return None;
        }
        (env(ENABLE).as_deref() != Some("0")).then(|| Self {
            bindings: root.join("bindings"),
            journal: root.join("journal"),
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct StoredBinding {
    workspace_id: String,
    session_id: String,
    owner_id: String,
    owner_uid: u32,
    cwd: PathBuf,
    model_id: String,
    agent_version: String,
    executable: PathBuf,
    leader_pid: i32,
    leader_start: u64,
    socket_path: PathBuf,
    socket_device: u64,
    socket_inode: u64,
    /// The references of the bindings this one replaced, newest first: each
    /// was rebound only after its leader was proven gone, under the same
    /// workspace, owner and uid. An agent pinned to any of them is still
    /// pinned to this session.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    lineage: Vec<String>,
}

/// How many replaced references a binding remembers.
const LINEAGE_LIMIT: usize = 16;

impl StoredBinding {
    /// The same binding, regardless of what it replaced.
    fn same_identity(&self, other: &StoredBinding) -> bool {
        let strip = |stored: &StoredBinding| StoredBinding {
            lineage: Vec::new(),
            ..stored.clone()
        };
        strip(self) == strip(other)
    }

    fn from_binding(binding: &Binding) -> Option<Self> {
        if binding.provider != Provider::Grok
            || binding.transport != Transport::Acp
            || !binding.endpoint_id.is_empty()
            || !binding.auth_id.is_empty()
            || !binding.protocol_id.is_empty()
            || binding.credential_reference != grok::existing_reference(binding)
        {
            return None;
        }
        Some(Self {
            workspace_id: binding.workspace_id.clone(),
            session_id: binding.session_id.clone(),
            owner_id: binding.owner_id.clone(),
            owner_uid: binding.owner_uid,
            cwd: binding.cwd.clone(),
            model_id: binding.model_id.clone(),
            agent_version: binding.agent_version.clone(),
            executable: binding.executable.clone(),
            leader_pid: binding.leader_pid,
            leader_start: binding.leader_start,
            socket_path: binding.socket_path.clone(),
            socket_device: binding.socket_device,
            socket_inode: binding.socket_inode,
            lineage: Vec::new(),
        })
    }

    fn binding(&self) -> Binding {
        let mut binding = Binding {
            provider: Provider::Grok,
            transport: Transport::Acp,
            workspace_id: self.workspace_id.clone(),
            session_id: self.session_id.clone(),
            endpoint_id: String::new(),
            owner_id: self.owner_id.clone(),
            credential_reference: String::new(),
            owner_uid: self.owner_uid,
            auth_id: String::new(),
            protocol_id: String::new(),
            cwd: self.cwd.clone(),
            model_id: self.model_id.clone(),
            agent_version: self.agent_version.clone(),
            executable: self.executable.clone(),
            leader_pid: self.leader_pid,
            leader_start: self.leader_start,
            socket_path: self.socket_path.clone(),
            socket_device: self.socket_device,
            socket_inode: self.socket_inode,
        };
        // Derived from the stored identity, so it cannot drift from it.
        binding.credential_reference = grok::existing_reference(&binding);
        binding
    }
}

pub struct Registry {
    directory: PathBuf,
}

impl Registry {
    pub fn open(directory: impl AsRef<Path>) -> std::io::Result<Self> {
        let directory = directory.as_ref().to_path_buf();
        match fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&directory)
        {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
        let metadata = fs::symlink_metadata(&directory)?;
        // Owner read as well as write and search: a directory that cannot be
        // enumerated would hide rows that delivery could still reach.
        if !metadata.is_dir()
            || metadata.uid() != super::platform::getuid()
            || metadata.mode() & 0o777 != 0o700
        {
            return Err(std::io::Error::new(
                ErrorKind::PermissionDenied,
                "binding directory is not private",
            ));
        }
        Ok(Self { directory })
    }

    fn lock(&self) -> std::io::Result<File> {
        let path = self.directory.join(".lock");
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .custom_flags(super::platform::O_NOFOLLOW)
            .mode(0o600)
            .open(path)?;
        let metadata = file.metadata()?;
        if !metadata.is_file()
            || metadata.uid() != super::platform::getuid()
            || metadata.mode() & 0o077 != 0
        {
            return Err(std::io::Error::new(
                ErrorKind::PermissionDenied,
                "binding lock is not private",
            ));
        }
        file.lock_exclusive()?;
        Ok(file)
    }

    pub(crate) fn path_for(&self, session_id: &str) -> PathBuf {
        let mut hasher = Sha256::new();
        hasher.update(session_id.as_bytes());
        self.directory
            .join(format!("{:x}.binding", hasher.finalize()))
    }

    fn read_file(&self, path: &Path) -> std::io::Result<StoredBinding> {
        let metadata = fs::symlink_metadata(path)?;
        if !metadata.is_file()
            || metadata.uid() != super::platform::getuid()
            || metadata.mode() & 0o077 != 0
        {
            return Err(std::io::Error::new(
                ErrorKind::PermissionDenied,
                "binding file is not private",
            ));
        }
        let text = fs::read_to_string(path)?;
        serde_json::from_str(&text)
            .map_err(|error| std::io::Error::new(ErrorKind::InvalidData, error))
    }

    fn write_new(&self, path: &Path, stored: &StoredBinding) -> std::io::Result<()> {
        // A unique name, so a crash between create and rename cannot leave a
        // file that blocks every later registration of this session.
        let temp = path.with_extension(format!("binding.{}.tmp", random_hex(16)));
        let result = (|| {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .custom_flags(super::platform::O_NOFOLLOW)
                .mode(0o600)
                .open(&temp)?;
            let body = serde_json::to_vec(stored)
                .map_err(|error| std::io::Error::new(ErrorKind::InvalidData, error))?;
            file.write_all(&body)?;
            file.sync_all()?;
            fs::rename(&temp, path)?;
            File::open(&self.directory)?.sync_all()
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temp);
        }
        result
    }

    /// Stores `binding` when the authority proves it. The same binding may be
    /// repeated. A different binding for that session is refused and the
    /// stored bytes stay as they were, unless the stored leader is dead and
    /// the new binding has the same workspace, owner and uid: like a managed
    /// relaunch, a session is rebound only under the authority it had.
    pub fn register(&self, binding: &Binding, authority: &dyn Authority) -> Result<(), Failure> {
        if binding.provider != Provider::Grok || binding.transport != Transport::Acp {
            return Err(Failure::UnsupportedRoute);
        }
        if !Target::new(SessionKind::GrokOpen, binding.session_id.as_str()).is_valid() {
            return Err(Failure::IdentityMismatch);
        }
        if Gate::enabled([Provider::Grok]).eligibility(binding) != Eligibility::Eligible
            || !authority.verify(binding)
        {
            return Err(Failure::IdentityMismatch);
        }
        let mut stored = StoredBinding::from_binding(binding).ok_or(Failure::UnsupportedRoute)?;
        let file = self.lock().map_err(|_| Failure::JournalUnavailable)?;
        let path = self.path_for(&binding.session_id);
        let result = if path.exists() {
            match self.read_file(&path) {
                Ok(existing) if existing.same_identity(&stored) => Ok(()),
                Ok(existing)
                    if (
                        &existing.workspace_id,
                        &existing.owner_id,
                        existing.owner_uid,
                    ) == (&stored.workspace_id, &stored.owner_id, stored.owner_uid)
                        && authority.dead(&existing.binding()) =>
                {
                    // The replaced binding's reference, and what it replaced,
                    // stay with the session so a pinned agent follows it.
                    stored.lineage = std::iter::once(existing.binding().credential_reference)
                        .chain(existing.lineage.iter().cloned())
                        .take(LINEAGE_LIMIT)
                        .collect();
                    self.write_new(&path, &stored)
                        .map_err(|_| Failure::JournalUnavailable)
                }
                Ok(_) => Err(Failure::IdentityMismatch),
                Err(_) => Err(Failure::JournalUnavailable),
            }
        } else {
            self.write_new(&path, &stored)
                .map_err(|_| Failure::JournalUnavailable)
        };
        FileExt::unlock(&file).ok();
        result
    }

    /// The stored binding of `session_id` whether or not it still proves:
    /// what a rebinding keeps (workspace, owner, uid, directory). `None` when
    /// nothing is stored under that session's own name.
    pub fn stored(&self, session_id: &str) -> Result<Option<Binding>, Failure> {
        let file = self.lock().map_err(|_| Failure::JournalUnavailable)?;
        let path = self.path_for(session_id);
        let result = if !path.exists() {
            Ok(None)
        } else {
            match self.read_file(&path) {
                Ok(stored) if stored.session_id == session_id => Ok(Some(stored.binding())),
                Ok(_) => Ok(None),
                Err(_) => Err(Failure::JournalUnavailable),
            }
        };
        FileExt::unlock(&file).ok();
        result
    }

    /// Whether an agent pinned to `pinned` may be delivered through
    /// `binding`: it is that binding, or one the binding replaced after its
    /// leader was proven gone under the same workspace, owner and uid.
    pub fn pin_accepts(&self, binding: &Binding, pinned: &str) -> Result<bool, Failure> {
        if pinned == binding.credential_reference {
            return Ok(true);
        }
        let file = self.lock().map_err(|_| Failure::JournalUnavailable)?;
        let result = match self.read_file(&self.path_for(&binding.session_id)) {
            Ok(stored) if stored.binding() == *binding => {
                Ok(stored.lineage.iter().any(|replaced| replaced == pinned))
            }
            Ok(_) => Ok(false),
            Err(_) => Err(Failure::JournalUnavailable),
        };
        FileExt::unlock(&file).ok();
        result
    }

    /// The stored binding when it still proves. One that does not, even with
    /// its leader dead, is kept but not returned: it pins the session's
    /// workspace and owner for any later rebinding. `Ok(None)` means there is
    /// nothing that may be sent.
    pub fn proved_binding(
        &self,
        session_id: &str,
        authority: &dyn Authority,
    ) -> Result<Option<Binding>, Failure> {
        let file = self.lock().map_err(|_| Failure::JournalUnavailable)?;
        // Delivery fails exactly when listing does: a registry `proved`
        // cannot enumerate is unavailable here too. One transient gap is
        // left: an I/O error partway through `proved`'s enumeration empties
        // the listing while this open-only check still succeeds. That never
        // hides one session while serving it, and clears on the next read.
        if fs::read_dir(&self.directory).is_err() {
            FileExt::unlock(&file).ok();
            return Err(Failure::JournalUnavailable);
        }
        let path = self.path_for(session_id);
        let result = if !path.exists() {
            Ok(None)
        } else {
            match self.read_file(&path) {
                Ok(stored) => {
                    let binding = stored.binding();
                    if authority.verify(&binding) && binding.session_id == session_id {
                        Ok(Some(binding))
                    } else {
                        if binding.session_id != session_id {
                            fs::remove_file(&path).map_err(|_| Failure::JournalUnavailable)?;
                        }
                        Ok(None)
                    }
                }
                Err(_) => Err(Failure::JournalUnavailable),
            }
        };
        FileExt::unlock(&file).ok();
        result
    }

    /// Every stored binding that still proves. A binding file that cannot be
    /// read is skipped rather than failing the whole listing: its own session
    /// is not listed, and `proved_binding` refuses it with an error, so its
    /// deliveries retry while every other session is unaffected.
    pub fn proved(&self, authority: &dyn Authority) -> Result<Vec<Binding>, Failure> {
        let file = self.lock().map_err(|_| Failure::JournalUnavailable)?;
        let mut proved = Vec::new();
        let entries = fs::read_dir(&self.directory).map_err(|_| Failure::JournalUnavailable)?;
        for entry in entries {
            let entry = entry.map_err(|_| Failure::JournalUnavailable)?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !name.ends_with(".binding") || name.ends_with(".tmp") {
                continue;
            }
            let Ok(stored) = self.read_file(&entry.path()) else {
                continue;
            };
            let binding = stored.binding();
            // A record not stored under its own session's name is one
            // `proved_binding` refuses, so it is not listed either.
            if entry.path() != self.path_for(&binding.session_id) {
                continue;
            }
            if authority.verify(&binding) {
                proved.push(binding);
            }
        }
        FileExt::unlock(&file).ok();
        Ok(proved)
    }
}

pub fn session(binding: &Binding) -> DiscoveredSession {
    DiscoveredSession {
        title: format!("Grok {}", binding.model_id),
        target: Target::new(SessionKind::GrokOpen, binding.session_id.clone()),
        directory: Some(binding.cwd.display().to_string()),
        updated_at_ms: None,
        host: None,
        live: true,
        holder: None,
    }
}

pub fn discover(registry: &Registry, authority: &dyn Authority) -> Vec<DiscoveredSession> {
    registry
        .proved(authority)
        .unwrap_or_default()
        .iter()
        .map(session)
        .collect()
}

/// Rebinds `session_id` to the already-open leader of this user after the
/// leader its stored binding names was proven gone or replaced, as Grok does
/// to its own leader on update. Only the stored workspace, owner, uid and
/// directory are used, and only while `still_open` says Grok still runs the
/// session there. `Ok(None)` when there is nothing to rebind: no stored
/// binding, a leader not proven dead, or a session Grok no longer lists.
pub fn rebind_replaced_leader(
    registry: &Registry,
    processes: Arc<dyn ProcessTable>,
    session_id: &str,
    still_open: &dyn Fn(&Binding) -> bool,
    excluded: &HashSet<(i32, u64)>,
    inspect: &dyn Fn(&Binding, Arc<dyn Authority>) -> Result<(String, String), Failure>,
    preferred_socket: Option<&Path>,
) -> Result<Option<Binding>, String> {
    let stored = match registry.stored(session_id) {
        Ok(Some(stored)) => stored,
        Ok(None) => return Ok(None),
        Err(_) => return Err("The registered Grok binding store is unavailable.".into()),
    };
    let authority = grok::ExistingLeaderAuthority::new(processes.clone());
    if !authority.dead(&stored) || !still_open(&stored) {
        return Ok(None);
    }
    let request = OpenLeaderRequest {
        session_id: stored.session_id.clone(),
        directory: stored.cwd.clone(),
        workspace_id: stored.workspace_id.clone(),
        owner_id: stored.owner_id.clone(),
        owner_uid: stored.owner_uid,
    };
    register_open_leader_preferring(
        registry,
        processes,
        &request,
        excluded,
        inspect,
        preferred_socket,
    )
    .map(Some)
}

/// Sends one already-registered session through the proved adapter. A missing
/// or stale binding, or one other than `expected_reference` when given, is
/// refused before the transport is asked to prompt.
pub fn deliver(
    registry: &Registry,
    journal_dir: &Path,
    authority: Arc<dyn Authority>,
    transport: Arc<dyn AcpTransport>,
    session_id: &str,
    delivery_id: &str,
    message_id: &str,
    text: &str,
    timeout: Duration,
    expected_reference: Option<&str>,
) -> Outcome {
    let binding = match registry.proved_binding(session_id, authority.as_ref()) {
        Ok(Some(binding)) => match expected_reference {
            Some(expected) => match registry.pin_accepts(&binding, expected) {
                Ok(true) => binding,
                Ok(false) => return Outcome::Refused(Failure::IdentityMismatch),
                Err(_) => return Outcome::Retry(Failure::JournalUnavailable),
            },
            None => binding,
        },
        Ok(None) => return Outcome::Refused(Failure::IdentityMismatch),
        // Nothing was sent, so this is never in doubt.
        Err(Failure::JournalUnavailable) => return Outcome::Retry(Failure::JournalUnavailable),
        Err(other) => return Outcome::Refused(other),
    };
    let adapter = Arc::new(GrokAdapter::new(
        binding.workspace_id.clone(),
        binding.owner_id.clone(),
        binding.owner_uid,
        authority,
        transport,
    ));
    let journal = match Journal::new(journal_dir) {
        Ok(journal) => journal,
        // Nothing was sent yet.
        Err(_) => return Outcome::Retry(Failure::JournalUnavailable),
    };
    let Some(coordinator) =
        Coordinator::new(Gate::enabled([Provider::Grok]), journal, vec![adapter])
    else {
        return Outcome::Refused(Failure::UnsupportedRoute);
    };
    coordinator.inject(&Request {
        binding: &binding,
        delivery_id,
        message_id,
        text,
        timeout,
    })
}

/// The one leader of `candidates` to bind: the only one, or among several
/// the one on `preferred_socket`, the socket the session's TUI is attached
/// to. Anything else is refused rather than guessed.
fn choose_leader(
    candidates: Vec<Binding>,
    preferred_socket: Option<&Path>,
) -> Result<Binding, String> {
    let mut candidates = candidates;
    if candidates.len() > 1 {
        if let Some(preferred) = preferred_socket {
            candidates.retain(|candidate| candidate.socket_path == preferred);
        }
    }
    match candidates.len() {
        1 => Ok(candidates.remove(0)),
        0 => Err(
            "No Grok leader is running for this session. Turn on Grok leader mode in Settings, then restart Grok."
                .into(),
        ),
        _ => Err("More than one Grok leader is open; this session cannot be bound to one.".into()),
    }
}

/// What `sessions.existing.register` supplies. It names no process, socket,
/// endpoint or credential: the probe finds the leader itself.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpenLeaderRequest {
    pub session_id: String,
    pub directory: PathBuf,
    pub workspace_id: String,
    pub owner_id: String,
    pub owner_uid: u32,
}

/// Registers `request.session_id` against the one already-open Grok leader
/// of this user. Candidates are found from the kernel: an `agent leader`
/// process of `owner_uid` whose environment is readable and has no managed
/// marker, and that is not in `excluded`. More than one candidate is refused
/// rather than guessed. The binding is stored only after the authority proves
/// it and `inspect` reads back the model and version from a `session/load`
/// of that exact session.
pub fn register_open_leader(
    registry: &Registry,
    processes: Arc<dyn ProcessTable>,
    request: &OpenLeaderRequest,
    excluded: &HashSet<(i32, u64)>,
    inspect: &dyn Fn(&Binding, Arc<dyn Authority>) -> Result<(String, String), Failure>,
) -> Result<Binding, String> {
    register_open_leader_preferring(registry, processes, request, excluded, inspect, None)
}

/// `register_open_leader` with the socket the session's own TUI is attached
/// to, when known. Leaders outlive their TUIs, so several can be open at
/// once; the one the TUI talks to is the session's, and the others are
/// ignored rather than refused.
pub fn register_open_leader_preferring(
    registry: &Registry,
    processes: Arc<dyn ProcessTable>,
    request: &OpenLeaderRequest,
    excluded: &HashSet<(i32, u64)>,
    inspect: &dyn Fn(&Binding, Arc<dyn Authority>) -> Result<(String, String), Failure>,
    preferred_socket: Option<&Path>,
) -> Result<Binding, String> {
    if let Some(unavailable) = super::platform::unsupported("Grok") {
        return Err(unavailable);
    }
    let refused = || "This Grok session could not be registered.".to_string();
    if !Target::new(SessionKind::GrokOpen, request.session_id.as_str()).is_valid()
        || request.owner_uid != crate::relay::peer::current_uid()
    {
        return Err(refused());
    }
    let directory = fs::canonicalize(&request.directory).map_err(|_| refused())?;
    if !fs::metadata(&directory)
        .is_ok_and(|metadata| metadata.is_dir() && metadata.uid() == request.owner_uid)
    {
        return Err(refused());
    }
    let authority: Arc<dyn Authority> =
        Arc::new(grok::ExistingLeaderAuthority::new(processes.clone()));
    let mut candidates = Vec::new();
    for pid in processes.all_pids() {
        let Some(process) = processes.process(pid) else {
            continue;
        };
        if process.uid != request.owner_uid
            || excluded.contains(&(process.pid, process.start))
            || grok::carries_managed_marker(&*processes, pid) != Some(false)
        {
            continue;
        }
        // A leader spawned by `grok --leader` names no socket in argv; it
        // listens on its own home's `leader.sock`, read from its environment.
        let default_socket = grok::default_leader_socket(&*processes, pid);
        let Some(socket_path) =
            grok::leader_socket(&processes.arguments(pid), default_socket.as_deref())
        else {
            continue;
        };
        let (Some(executable), Ok(socket)) = (
            processes.executable(pid),
            fs::symlink_metadata(&socket_path),
        ) else {
            continue;
        };
        let mut candidate = Binding {
            provider: Provider::Grok,
            transport: Transport::Acp,
            workspace_id: request.workspace_id.clone(),
            session_id: request.session_id.clone(),
            endpoint_id: String::new(),
            owner_id: request.owner_id.clone(),
            credential_reference: String::new(),
            owner_uid: request.owner_uid,
            auth_id: String::new(),
            protocol_id: String::new(),
            cwd: directory.clone(),
            model_id: "pending-readback".into(),
            agent_version: "pending-readback".into(),
            executable,
            leader_pid: process.pid,
            leader_start: process.start,
            socket_path,
            socket_device: socket.dev(),
            socket_inode: socket.ino(),
        };
        candidate.credential_reference = grok::existing_reference(&candidate);
        if authority.verify(&candidate) {
            candidates.push(candidate);
        }
    }
    let candidate = choose_leader(candidates, preferred_socket)?;
    let (model_id, agent_version) =
        inspect(&candidate, authority.clone()).map_err(|_| refused())?;
    let binding = Binding {
        model_id,
        agent_version,
        ..candidate
    };
    registry
        .register(&binding, authority.as_ref())
        .map_err(|failure| match failure {
            Failure::IdentityMismatch => {
                "This Grok session already has a different registered binding.".to_string()
            }
            _ => "The registered Grok binding store is unavailable.".to_string(),
        })?;
    Ok(binding)
}

#[cfg(test)]
#[cfg(unix)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    const SESSION: &str = "01a0fe0c-8b26-7ec2-ad2f-bab882c091f4";

    struct Flag(AtomicBool);

    impl Authority for Flag {
        fn verify(&self, _: &Binding) -> bool {
            self.0.load(Ordering::SeqCst)
        }
    }

    struct CountingTransport {
        calls: AtomicUsize,
    }

    impl AcpTransport for CountingTransport {
        fn prompt(&self, _: &Binding, text: &str, _: Duration) -> Outcome {
            assert!(!text.contains("_x.ai/mcp/servers_updated"));
            self.calls.fetch_add(1, Ordering::SeqCst);
            Outcome::Delivered {
                receipt_id: "grok-acp:test-receipt".into(),
            }
        }
    }

    fn binding(inode: u64) -> Binding {
        let mut binding = Binding {
            provider: Provider::Grok,
            transport: Transport::Acp,
            workspace_id: "workspace-1".into(),
            session_id: SESSION.into(),
            endpoint_id: String::new(),
            owner_id: "owner-1".into(),
            credential_reference: String::new(),
            owner_uid: 501,
            auth_id: String::new(),
            protocol_id: String::new(),
            cwd: PathBuf::from("/tmp/grok-enable/workdir"),
            model_id: "grok-4.7".into(),
            agent_version: "1.0.46".into(),
            executable: PathBuf::from("/tmp/grok-enable/grok"),
            leader_pid: 4242,
            leader_start: 100,
            socket_path: PathBuf::from("/tmp/grok-enable/leader.sock"),
            socket_device: 1,
            socket_inode: inode,
        };
        binding.credential_reference = grok::existing_reference(&binding);
        binding
    }

    #[test]
    fn a_proved_binding_is_immutable_and_a_stale_one_is_not_sent() {
        let root =
            std::env::temp_dir().join(format!("grok-enable-{}-{}", std::process::id(), SESSION));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let registry = Registry::open(root.join("bindings")).unwrap();
        let journal = root.join("journal");
        let authority = Arc::new(Flag(AtomicBool::new(true)));
        let transport = Arc::new(CountingTransport {
            calls: AtomicUsize::new(0),
        });
        registry.register(&binding(7), authority.as_ref()).unwrap();
        assert_eq!(
            registry.register(&binding(8), authority.as_ref()),
            Err(Failure::IdentityMismatch)
        );
        assert_eq!(
            registry
                .proved_binding(SESSION, authority.as_ref())
                .unwrap()
                .unwrap()
                .socket_inode,
            7
        );
        let mut legacy = binding(7);
        legacy.transport = Transport::LegacyTui;
        assert_eq!(
            registry.register(&legacy, authority.as_ref()),
            Err(Failure::UnsupportedRoute)
        );
        // A managed-namespace reference is never stored by this route, even
        // when an authority would accept it.
        let mut managed = binding(9);
        managed.session_id = "01a0fe0c-8b26-7ec2-ad2f-bab882c091f5".into();
        managed.credential_reference = format!("probe:grok:{}", "0".repeat(64));
        assert_eq!(
            registry.register(&managed, authority.as_ref()),
            Err(Failure::UnsupportedRoute)
        );
        let mut untitled = binding(7);
        untitled.session_id = "Grok session".into();
        untitled.credential_reference = grok::existing_reference(&untitled);
        assert_eq!(
            registry.register(&untitled, authority.as_ref()),
            Err(Failure::IdentityMismatch)
        );
        assert_eq!(discover(&registry, authority.as_ref()).len(), 1);

        let prompt = "relay message do-not-log";
        let first = deliver(
            &registry,
            &journal,
            authority.clone(),
            transport.clone(),
            SESSION,
            "delivery-1",
            "message-1",
            prompt,
            Duration::from_secs(5),
            None,
        );
        assert_eq!(
            first,
            Outcome::Delivered {
                receipt_id: "grok-acp:test-receipt".into()
            }
        );
        assert!(!format!("{first:?}").contains(prompt));
        assert!(!format!("{first:?}").contains("_x.ai/mcp/servers_updated"));
        let replay = deliver(
            &registry,
            &journal,
            authority.clone(),
            transport.clone(),
            SESSION,
            "delivery-1",
            "message-1",
            prompt,
            Duration::from_secs(5),
            None,
        );
        assert_eq!(replay, first);
        assert_eq!(transport.calls.load(Ordering::SeqCst), 1);

        authority.0.store(false, Ordering::SeqCst);
        assert!(discover(&registry, authority.as_ref()).is_empty());
        assert!(registry.path_for(SESSION).exists(), "kept, never rewritten");
        let stale = deliver(
            &registry,
            &journal,
            authority.clone(),
            transport.clone(),
            SESSION,
            "delivery-2",
            "message-2",
            prompt,
            Duration::from_secs(5),
            None,
        );
        assert_eq!(stale, Outcome::Refused(Failure::IdentityMismatch));
        assert_eq!(transport.calls.load(Ordering::SeqCst), 1);
        let _ = fs::remove_dir_all(&root);
    }

    /// Verifies as told, and reports the leader dead only when told.
    struct Leader {
        proves: AtomicBool,
        dead: AtomicBool,
    }

    impl Authority for Leader {
        fn verify(&self, _: &Binding) -> bool {
            self.proves.load(Ordering::SeqCst)
        }
        fn dead(&self, _: &Binding) -> bool {
            self.dead.load(Ordering::SeqCst)
        }
    }

    #[test]
    fn an_unproved_binding_is_hidden_and_only_its_own_authority_may_rebind_a_dead_one() {
        let root = tempfile::tempdir().unwrap();
        let registry = Registry::open(root.path().join("nested/bindings")).unwrap();
        let leader = Leader {
            proves: AtomicBool::new(true),
            dead: AtomicBool::new(false),
        };
        registry.register(&binding(7), &leader).unwrap();
        leader.proves.store(false, Ordering::SeqCst);
        assert!(discover(&registry, &leader).is_empty());
        assert_eq!(registry.proved_binding(SESSION, &leader).unwrap(), None);
        leader.proves.store(true, Ordering::SeqCst);
        assert_eq!(discover(&registry, &leader).len(), 1);
        // While the stored leader may live, no other binding replaces it.
        assert_eq!(
            registry.register(&binding(8), &leader),
            Err(Failure::IdentityMismatch)
        );

        // Its leader dies: the binding stays, pinning its authority.
        leader.dead.store(true, Ordering::SeqCst);
        let mut elsewhere = binding(9);
        elsewhere.workspace_id = "workspace-2".into();
        elsewhere.credential_reference = grok::existing_reference(&elsewhere);
        assert_eq!(
            registry.register(&elsewhere, &leader),
            Err(Failure::IdentityMismatch)
        );
        let mut other_owner = binding(9);
        other_owner.owner_id = "owner-2".into();
        other_owner.credential_reference = grok::existing_reference(&other_owner);
        assert_eq!(
            registry.register(&other_owner, &leader),
            Err(Failure::IdentityMismatch)
        );
        // The same workspace and owner may rebind it to a new leader. The
        // replaced reference stays with the session, so an agent pinned to
        // it is still delivered; a stranger's reference is not.
        registry.register(&binding(8), &leader).unwrap();
        leader.dead.store(false, Ordering::SeqCst);
        let old = binding(7).credential_reference;
        let new = binding(8).credential_reference;
        assert_ne!(old, new);
        assert_eq!(registry.pin_accepts(&binding(8), &new), Ok(true));
        assert_eq!(registry.pin_accepts(&binding(8), &old), Ok(true));
        assert_eq!(
            registry.pin_accepts(&binding(8), &binding(9).credential_reference),
            Ok(false)
        );
        // Registering the same bytes again keeps the lineage.
        registry.register(&binding(8), &leader).unwrap();
        assert_eq!(registry.pin_accepts(&binding(8), &old), Ok(true));
        assert_eq!(registry.stored(SESSION).unwrap(), Some(binding(8)));
        assert_eq!(
            registry
                .proved_binding(SESSION, &leader)
                .unwrap()
                .map(|bound| bound.socket_inode),
            Some(8)
        );
    }

    #[test]
    fn among_several_leaders_the_sessions_own_socket_decides() {
        let on = |socket: &str| {
            let mut candidate = binding(7);
            candidate.socket_path = PathBuf::from(socket);
            candidate
        };
        let one = vec![on("/home/me/.grok/leader.sock")];
        assert!(choose_leader(one.clone(), None).is_ok());
        assert!(choose_leader(one, Some(Path::new("/elsewhere.sock"))).is_ok());
        let two = vec![
            on("/home/me/.grok/leader.sock"),
            on("/home/me/.grok/leader-old.sock"),
        ];
        assert!(choose_leader(two.clone(), None)
            .unwrap_err()
            .contains("More than one Grok leader"));
        let chosen =
            choose_leader(two.clone(), Some(Path::new("/home/me/.grok/leader.sock"))).unwrap();
        assert_eq!(
            chosen.socket_path,
            PathBuf::from("/home/me/.grok/leader.sock")
        );
        // A preferred socket none of them listens on leaves nothing to bind.
        assert!(choose_leader(two, Some(Path::new("/nope.sock")))
            .unwrap_err()
            .contains("No Grok leader is running"));
    }

    #[test]
    fn rebinding_happens_only_for_a_dead_leader_of_a_session_grok_still_runs() {
        use crate::relay::process::{FakeProcess, FakeProcesses};
        let root = tempfile::tempdir().unwrap();
        let registry = Registry::open(root.path().join("bindings")).unwrap();
        let table = Arc::new(FakeProcesses::default());
        let inspect = |_: &Binding, _: Arc<dyn Authority>| Ok(("grok-4.7".into(), "1.0.46".into()));
        let open = |_: &Binding| true;
        let rebind = |still_open: &dyn Fn(&Binding) -> bool| {
            rebind_replaced_leader(
                &registry,
                table.clone(),
                SESSION,
                still_open,
                &HashSet::new(),
                &inspect,
                None,
            )
        };
        // Nothing stored: nothing to rebind.
        assert_eq!(rebind(&open), Ok(None));
        registry
            .register(&binding(7), &Flag(AtomicBool::new(true)))
            .unwrap();
        // The stored leader still runs: nothing to rebind.
        table.insert(
            4242,
            FakeProcess {
                uid: 501,
                start: 100,
                ..FakeProcess::default()
            },
        );
        assert_eq!(rebind(&open), Ok(None));
        // Replaced, but Grok no longer runs the session there.
        table.insert(
            4242,
            FakeProcess {
                uid: 501,
                start: 101,
                ..FakeProcess::default()
            },
        );
        assert_eq!(rebind(&|_| false), Ok(None));
        // Replaced and still open, with no leader that could be bound (the
        // stored uid is not this test's): refused with a reason, and the
        // stored binding is kept for the next attempt.
        assert!(rebind(&open).is_err());
        assert_eq!(registry.stored(SESSION).unwrap(), Some(binding(7)));
    }

    #[test]
    fn a_registry_that_cannot_be_enumerated_is_unavailable_to_listing_and_delivery() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("bindings");
        let registry = Registry::open(&path).unwrap();
        let authority = Arc::new(Flag(AtomicBool::new(true)));
        registry.register(&binding(7), authority.as_ref()).unwrap();
        // Write and search, but no read: the hashed file could be opened
        // while the directory cannot be listed.
        fs::set_permissions(&path, fs::Permissions::from_mode(0o300)).unwrap();
        let reopened = Registry::open(&path).map(|_| ());
        let listed = registry.proved(authority.as_ref());
        let proved = registry.proved_binding(SESSION, authority.as_ref());
        let transport = Arc::new(CountingTransport {
            calls: AtomicUsize::new(0),
        });
        let sent = deliver(
            &registry,
            &root.path().join("journal"),
            authority,
            transport.clone(),
            SESSION,
            "delivery-1",
            "message-1",
            "relay message",
            Duration::from_secs(5),
            None,
        );
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(reopened.is_err());
        assert_eq!(listed, Err(Failure::JournalUnavailable));
        assert_eq!(proved, Err(Failure::JournalUnavailable));
        assert_eq!(sent, Outcome::Retry(Failure::JournalUnavailable));
        assert_eq!(transport.calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn a_record_under_another_sessions_name_is_neither_listed_nor_sent() {
        let root = tempfile::tempdir().unwrap();
        let registry = Registry::open(root.path().join("bindings")).unwrap();
        let authority = Flag(AtomicBool::new(true));
        registry.register(&binding(7), &authority).unwrap();
        let other = "01a0fe0c-8b26-7ec2-ad2f-bab882c091f5";
        fs::rename(registry.path_for(SESSION), registry.path_for(other)).unwrap();
        assert!(discover(&registry, &authority).is_empty());
        assert_eq!(registry.proved_binding(other, &authority).unwrap(), None);
        assert_eq!(registry.proved_binding(SESSION, &authority).unwrap(), None);
    }

    #[test]
    fn an_unreadable_registry_is_retried_and_a_crash_leftover_does_not_block() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let registry = Registry::open(root.path().join("bindings")).unwrap();
        let authority = Arc::new(Flag(AtomicBool::new(true)));
        // A temp file a crash left behind under the old fixed name.
        fs::write(
            registry.path_for(SESSION).with_extension("binding.tmp"),
            b"partial",
        )
        .unwrap();
        registry.register(&binding(7), authority.as_ref()).unwrap();

        let lock = root.path().join("bindings/.lock");
        fs::set_permissions(&lock, fs::Permissions::from_mode(0o644)).unwrap();
        let transport = Arc::new(CountingTransport {
            calls: AtomicUsize::new(0),
        });
        assert_eq!(
            deliver(
                &registry,
                &root.path().join("journal"),
                authority,
                transport.clone(),
                SESSION,
                "delivery-1",
                "message-1",
                "relay message",
                Duration::from_secs(5),
                None,
            ),
            Outcome::Retry(Failure::JournalUnavailable)
        );
        assert_eq!(transport.calls.load(Ordering::SeqCst), 0);
        assert!(!root.path().join("journal").exists());
    }

    /// Live macOS/Linux proof: an already-open Grok leader, creator gone,
    /// then one Agent Relay message through registration and `deliver`.
    /// Not part of CI. Run with `--ignored` where `grok` 1.0.46 is installed.
    #[test]
    #[ignore]
    fn an_already_open_grok_session_receives_one_agent_relay_message() {
        use crate::relay::existing_session::grok::{ExistingLeaderAuthority, SystemAcpTransport};
        use crate::relay::process::SystemProcesses;
        use std::io::{BufRead, BufReader};
        use std::process::{Command, Stdio};
        use std::thread;
        use std::time::Instant;

        let home = PathBuf::from(std::env::var_os("HOME").expect("HOME"));
        let grok = [home.join(".local/bin/grok"), home.join(".grok/bin/grok")]
            .into_iter()
            .find(|path| path.is_file())
            .expect("grok binary");
        let root = std::env::temp_dir().join(format!("grok-enable-e2e-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("workdir")).unwrap();
        let workdir = root.join("workdir");
        let sock = home.join(format!(
            ".grok/leader-enable-e2e-{}.sock",
            std::process::id()
        ));
        let _ = fs::remove_file(&sock);
        let path = std::env::var_os("PATH").unwrap_or_default();
        let mut leader = Command::new(&grok);
        leader
            .args([
                "agent",
                "leader",
                "--no-exit-on-disconnect",
                "--leader-socket",
            ])
            .arg(&sock)
            .current_dir(&workdir)
            .env_clear()
            .env("HOME", &home)
            .env("PATH", &path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let leader = leader.spawn().expect("leader");
        let leader_pid = leader.id() as i32;
        struct KillChild(Option<std::process::Child>);
        impl Drop for KillChild {
            fn drop(&mut self) {
                if let Some(child) = self.0.as_mut() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        }
        let mut leader = KillChild(Some(leader));
        let leader = leader.0.as_mut().unwrap();
        let ready = Instant::now() + Duration::from_secs(20);
        while Instant::now() < ready && !sock.exists() {
            if leader.try_wait().ok().flatten().is_some() {
                break;
            }
            thread::sleep(Duration::from_millis(100));
        }
        assert!(sock.exists(), "leader socket did not appear");

        let mut client = Command::new(&grok);
        client
            .args(["agent", "--always-approve", "--leader", "--leader-socket"])
            .arg(&sock)
            .arg("stdio")
            .current_dir(&workdir)
            .env_clear()
            .env("HOME", &home)
            .env("PATH", &path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut client = client.spawn().expect("creator");
        let mut stdin = client.stdin.take().unwrap();
        let stdout = client.stdout.take().unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if line.contains("_x.ai/mcp/servers_updated") {
                    continue;
                }
                let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
                    continue;
                };
                if sender.send(value).is_err() {
                    break;
                }
            }
        });
        let call = |stdin: &mut std::process::ChildStdin,
                    id: &str,
                    method: &str,
                    params: serde_json::Value| {
            let request =
                serde_json::json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
            use std::io::Write;
            serde_json::to_writer(&mut *stdin, &request).unwrap();
            stdin.write_all(b"\n").unwrap();
            stdin.flush().unwrap();
            let deadline = Instant::now() + Duration::from_secs(20);
            loop {
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    panic!("{method} timed out");
                }
                let value = receiver
                    .recv_timeout(left)
                    .unwrap_or_else(|_| panic!("{method} ended"));
                if value.get("id").and_then(|item| item.as_str()) == Some(id) {
                    assert!(value.get("error").is_none(), "{method} refused");
                    return value
                        .get("result")
                        .cloned()
                        .unwrap_or(serde_json::Value::Null);
                }
            }
        };
        let initialized = call(
            &mut stdin,
            "1",
            "initialize",
            serde_json::json!({
                "protocolVersion": 1,
                "clientCapabilities": {},
                "clientInfo": {"name":"agent-relay-desktop","version":"0.0.0"}
            }),
        );
        let model_id = initialized
            .pointer("/_meta/modelState/currentModelId")
            .and_then(|value| value.as_str())
            .unwrap_or("grok-4.7")
            .to_string();
        let agent_version = initialized
            .pointer("/_meta/agentVersion")
            .and_then(|value| value.as_str())
            .unwrap_or("1.0.46")
            .to_string();
        let created = call(
            &mut stdin,
            "2",
            "session/new",
            serde_json::json!({"cwd": workdir, "mcpServers": []}),
        );
        let session_id = created
            .get("sessionId")
            .or_else(|| created.pointer("/_meta/sessionId"))
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string();
        assert_eq!(session_id.len(), 36, "session/new did not name a session");
        drop(stdin);
        let _ = client.wait();

        // Registered through the production producer: the leader is found
        // from the kernel and the session is read back over ACP.
        let table: Arc<dyn ProcessTable> = Arc::new(SystemProcesses::default());
        let registry = Registry::open(root.join("bindings")).unwrap();
        let binding = register_open_leader(
            &registry,
            table.clone(),
            &OpenLeaderRequest {
                session_id: session_id.clone(),
                directory: workdir.clone(),
                workspace_id: "workspace-enable".into(),
                owner_id: "owner-enable".into(),
                owner_uid: crate::relay::existing_session::platform::getuid(),
            },
            &HashSet::new(),
            &|binding, authority| {
                grok::inspect_session(binding, authority, Duration::from_secs(20))
            },
        )
        .expect("register the open leader");
        assert_eq!(binding.leader_pid, leader_pid);
        assert_eq!(
            (binding.model_id.as_str(), binding.agent_version.as_str()),
            (model_id.as_str(), agent_version.as_str())
        );
        let authority = Arc::new(ExistingLeaderAuthority::new(table));
        assert_eq!(discover(&registry, authority.as_ref()).len(), 1);
        let transport = Arc::new(SystemAcpTransport::new(authority.clone()));
        let text = "[via Agent Relay — from @owner to @grok-session · message m-enable-e2e · ref e2e00001]\n\nReply with the single word ack.";
        let outcome = deliver(
            &registry,
            &root.join("journal"),
            authority,
            transport,
            &session_id,
            "m-enable-e2e",
            "m-enable-e2e",
            text,
            Duration::from_secs(30),
            None,
        );
        let rendered = format!("{outcome:?}");
        assert!(!rendered.contains("Reply with the single word ack"));
        assert!(!rendered.contains("_x.ai/mcp/servers_updated"));
        match &outcome {
            Outcome::Delivered { receipt_id } => {
                assert!(receipt_id.starts_with("grok-acp:"), "{receipt_id}");
            }
            other => panic!("enablement delivery was {other:?}"),
        }
        let _ = leader.kill();
        let _ = leader.wait();
        let _ = fs::remove_file(&sock);
        let _ = fs::remove_dir_all(&root);
    }
}
