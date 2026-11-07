//! Probe-owned Grok and OpenCode endpoints.
//!
//! Nothing in this module adopts an existing terminal, process, endpoint or
//! credential supplied by a caller. The local bridge supplies only a trusted
//! executable, a working directory and a provider session id. The probe
//! launches the endpoint with a random marker and, only after kernel identity
//! checks plus provider readback succeed, writes an immutable binding to a
//! private registry. Picker discovery and injection both read that registry
//! and re-verify its binding; an absent, changed or stale record fails closed.

mod claims;
mod discovery;

use crate::relay::claude::AgentEnvironment;
use crate::relay::existing_session::platform::{
    self, DirBuilderExt, FileTypeExt, MetadataExt, OpenOptionsExt, UnixStream,
};
use crate::relay::existing_session::{self, grok, Provider, Transport};
use crate::relay::peer::current_uid;
use crate::relay::process::{ProcessInfo, ProcessTable};
use crate::relay::sessions::DiscoveredSession;
use crate::relay::store::{random_hex, SessionKind, Target};
use crate::relay::{opencode_existing, opencode_serve};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const ENABLE_GROK: &str = "AGENT_RELAY_ENABLE_MANAGED_GROK";
pub const ENABLE_OPENCODE: &str = "AGENT_RELAY_ENABLE_MANAGED_OPENCODE";
const REGISTRY_VERSION: u32 = 2;
// Grok records in this version carry two `provider` keys; see `ManagedBinding`.
const LEGACY_REGISTRY_VERSION: u64 = 1;
const REGISTRY_FILE: &str = "bindings.json";
// A cold OpenCode start can spend tens of seconds loading its session database
// before the authenticated endpoint answers.
const LAUNCH_TIMEOUT: Duration = Duration::from_secs(60);
// Grok 1.0.46 can take longer than the legacy five-second allowance to
// initialize its ACP client against a newly started leader.
const GROK_LAUNCH_INSPECT_TIMEOUT: Duration = Duration::from_secs(20);
const GROK_VERIFY_INSPECT_TIMEOUT: Duration = Duration::from_secs(5);
// A Grok runtime entry younger than this may belong to a launch in progress.
const GROK_RUNTIME_SWEEP_AGE: Duration = Duration::from_secs(10 * 60);

/// Starts a provider in a new process session (`detach::start`). Managed
/// providers must outlive a core restart; reparenting alone leaves the
/// provider in the core's process session, where a supervisor can still tear
/// it down with the core.
fn spawn_detached(
    executable: &Path,
    arguments: &[OsString],
    directory: &Path,
    environment: &BTreeMap<String, String>,
) -> Result<i32, ()> {
    let log = Path::new(if cfg!(windows) { "NUL" } else { "/dev/null" });
    crate::relay::detach::start(None, executable, arguments, log, directory, environment)
        .map_err(|_| ())
}

#[cfg(unix)]
fn unix_socket_path_fits(path: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    // Unix-domain socket paths must leave room for their terminating NUL.
    // Darwin's sun_path is 104 bytes; Linux's is 108.
    let capacity = unsafe { std::mem::zeroed::<libc::sockaddr_un>() }
        .sun_path
        .len();
    path.as_os_str().as_bytes().len() < capacity
}

/// No path fits a Unix socket on Windows, where managed Grok leaders are
/// not available.
#[cfg(windows)]
fn unix_socket_path_fits(_path: &Path) -> bool {
    false
}

fn short_runtime_dir() -> PathBuf {
    #[cfg(unix)]
    let base = PathBuf::from("/tmp");
    #[cfg(windows)]
    let base = std::env::temp_dir();
    base.join(format!("agent-relay-managed-{}", current_uid()))
}

/// The harness a managed launch of `kind` starts, as Settings names it.
fn managed_label(kind: SessionKind) -> &'static str {
    match kind {
        SessionKind::Grok => "Grok",
        _ => "OpenCode",
    }
}

/// Signals `pid` to end.
#[cfg(unix)]
fn terminate_pid(pid: i32) {
    // SAFETY: callers read the process's kernel identity, including uid and
    // start time, immediately before signalling.
    unsafe {
        libc::kill(pid, libc::SIGTERM);
    }
}

/// Never reached on Windows: managed providers are not available there, so
/// no managed process exists to end.
#[cfg(windows)]
fn terminate_pid(_pid: i32) {}

pub(crate) fn private_short_runtime_dir() -> Result<PathBuf, ()> {
    // Fallback socket names are random and therefore never intentionally
    // reused. A same-uid (or root) process that pre-creates this private
    // directory can only deny service, and every ownership/mode mismatch
    // fails closed.
    prepare_private_runtime_dir(short_runtime_dir())
}

fn is_private_runtime_dir(directory: &Path) -> bool {
    fs::symlink_metadata(directory).is_ok_and(|metadata| {
        metadata.is_dir() && metadata.uid() == current_uid() && metadata.mode() & 0o077 == 0
    })
}

/// The random id of a probe-created Grok socket path, `grok-<id>.sock`.
fn grok_socket_id(path: &Path) -> Option<&str> {
    grok_runtime_entry_id(path.file_name()?.to_str()?)
}

/// The id of `grok-<24 hex>.sock` or of the lock Grok keeps beside it
/// (`grok-<id>.lock` or `grok-<id>.sock.lock`). Nothing else is a Grok
/// runtime entry.
fn grok_runtime_entry_id(name: &str) -> Option<&str> {
    let rest = name.strip_prefix("grok-")?;
    let id = [".sock.lock", ".sock", ".lock"]
        .into_iter()
        .find_map(|suffix| rest.strip_suffix(suffix))?;
    (id.len() == 24
        && id
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f')))
    .then_some(id)
}

/// Removes the socket and lock files of Grok leaders that no longer listen.
/// An id in `keep` belongs to a registry record whose leader is not known to
/// be gone, and an entry modified at or after `cutoff` may belong to a launch
/// still in progress; both stay. Otherwise the id is stale only on kernel
/// evidence: its socket is absent, or a connection to it is refused because
/// nothing listens on it. Only sockets and regular files of this uid are
/// removed. Best effort: anything left waits for the next sweep.
fn sweep_grok_runtime_dir(directory: &Path, keep: &HashSet<String>, cutoff: SystemTime) {
    if !is_private_runtime_dir(directory) {
        return;
    }
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    let mut groups: BTreeMap<String, Vec<PathBuf>> = BTreeMap::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        if let Some(id) = name.to_str().and_then(grok_runtime_entry_id) {
            groups.entry(id.to_owned()).or_default().push(entry.path());
        }
    }
    for (id, paths) in groups {
        if keep.contains(&id) {
            continue;
        }
        let removable: Vec<(PathBuf, fs::Metadata)> = paths
            .into_iter()
            .filter_map(|path| {
                let metadata = fs::symlink_metadata(&path).ok()?;
                let file_type = metadata.file_type();
                (metadata.uid() == current_uid()
                    && (file_type.is_file() || FileTypeExt::is_socket(&file_type)))
                .then_some((path, metadata))
            })
            .collect();
        if removable.iter().any(|(_, metadata)| {
            metadata
                .modified()
                .map_or(true, |modified| modified >= cutoff)
        }) {
            continue;
        }
        let socket = directory.join(format!("grok-{id}.sock"));
        let stale = match fs::symlink_metadata(&socket) {
            Err(error) => error.kind() == ErrorKind::NotFound,
            Ok(metadata) if FileTypeExt::is_socket(&metadata.file_type()) => {
                matches!(
                    UnixStream::connect(&socket),
                    Err(error) if error.kind() == ErrorKind::ConnectionRefused
                )
            }
            Ok(_) => false,
        };
        if stale {
            for (path, _) in removable {
                let _ = fs::remove_file(path);
            }
        }
    }
}

fn prepare_private_runtime_dir(directory: PathBuf) -> Result<PathBuf, ()> {
    match fs::DirBuilder::new().mode(0o700).create(&directory) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
        Err(_) => return Err(()),
    }
    let metadata = fs::symlink_metadata(&directory).map_err(|_| ())?;
    if !metadata.is_dir() || metadata.uid() != current_uid() || metadata.mode() & 0o077 != 0 {
        return Err(());
    }
    Ok(directory)
}

pub(crate) fn grok_socket_path(runtime_dir: &Path) -> Result<PathBuf, ()> {
    let name = format!("grok-{}.sock", random_hex(24));
    let preferred = runtime_dir.join(&name);
    if unix_socket_path_fits(&preferred) {
        return Ok(preferred);
    }
    let fallback = private_short_runtime_dir()?.join(name);
    unix_socket_path_fits(&fallback)
        .then_some(fallback)
        .ok_or(())
}

fn grok_leader_arguments(socket_path: &Path) -> [OsString; 5] {
    [
        OsString::from("agent"),
        OsString::from("leader"),
        OsString::from("--no-exit-on-disconnect"),
        OsString::from("--leader-socket"),
        socket_path.as_os_str().to_owned(),
    ]
}

/// The local identity authorized to own a managed provider route.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManagedAuthority {
    pub workspace_id: String,
    pub owner_id: String,
    pub owner_uid: u32,
}

/// The deliberately narrow bridge input. Endpoint, pid, socket, process
/// start, provider workspace, marker and Basic credentials are never inputs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ManagedLaunch {
    pub kind: SessionKind,
    pub executable: PathBuf,
    pub directory: PathBuf,
    pub session_id: String,
    pub authority: ManagedAuthority,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
// The tag must not collide with `existing_session::Binding::provider`.
// Serde permits that collision while serializing but cannot deserialize the
// resulting duplicate JSON object key, so a Grok binding disappeared on the
// first picker refresh or core restart.
#[serde(tag = "managed_provider", rename_all = "snake_case")]
pub enum ManagedBinding {
    Grok(existing_session::Binding),
    OpenCode(opencode_existing::Binding),
}

impl ManagedBinding {
    pub fn target(&self) -> Target {
        match self {
            Self::Grok(binding) => Target::new(SessionKind::Grok, binding.session_id.clone()),
            Self::OpenCode(binding) => {
                Target::new(SessionKind::OpenCode, binding.session_id.clone())
            }
        }
    }

    pub fn authority(&self) -> ManagedAuthority {
        match self {
            Self::Grok(binding) => ManagedAuthority {
                workspace_id: binding.workspace_id.clone(),
                owner_id: binding.owner_id.clone(),
                owner_uid: binding.owner_uid,
            },
            Self::OpenCode(binding) => ManagedAuthority {
                workspace_id: binding.relay_workspace_id.clone(),
                owner_id: binding.owner_id.clone(),
                owner_uid: binding.server_uid,
            },
        }
    }

    fn kind(&self) -> SessionKind {
        self.target().kind
    }

    fn directory(&self) -> &Path {
        match self {
            Self::Grok(binding) => &binding.cwd,
            Self::OpenCode(binding) => &binding.directory,
        }
    }

    fn title(&self) -> String {
        match self {
            Self::Grok(binding) => format!("Grok {}", binding.model_id),
            Self::OpenCode(binding) => format!("OpenCode {}", binding.session_id),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Record {
    binding: ManagedBinding,
    /// Sealed for a spawned agent (`adopt`): routable whatever the managed
    /// launch flags say, never a picker row, removed when the spawn ends it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    spawned: bool,
}

impl Record {
    fn session(&self, live: bool) -> DiscoveredSession {
        DiscoveredSession {
            target: self.binding.target(),
            title: self.binding.title(),
            directory: self.binding.directory().to_str().map(ToString::to_string),
            updated_at_ms: None,
            host: None,
            live,
            holder: None,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct SealedRecord {
    record: Record,
    digest: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct Registry {
    version: u32,
    records: Vec<SealedRecord>,
}

/// Launch and liveness seam. Production is kernel/provider backed; tests do
/// not need to start real CLIs.
pub trait ManagedRuntime: Send + Sync {
    fn launch(&self, request: &ManagedLaunch, runtime_dir: &Path) -> Result<ManagedBinding, ()>;
    fn verify(&self, binding: &ManagedBinding) -> bool;
    /// Verify the binding and return native title metadata when available.
    /// Providers can reuse their verification read rather than make a second
    /// request per discovery. This metadata is never persisted as a Relay alias.
    fn verified_title(&self, binding: &ManagedBinding) -> Result<Option<String>, ()> {
        self.verify(binding).then_some(None).ok_or(())
    }
    /// Whether the exact recorded provider process is gone. A temporarily
    /// unavailable endpoint is not dead and must keep its immutable binding.
    fn dead(&self, binding: &ManagedBinding) -> bool {
        !self.verify(binding)
    }
    fn terminate(&self, _binding: &ManagedBinding) {}
}

pub struct ManagedSessions {
    root: PathBuf,
    enabled: HashSet<SessionKind>,
    runtime: Arc<dyn ManagedRuntime>,
}

impl ManagedSessions {
    pub fn system(
        app_data_dir: &Path,
        table: Arc<dyn ProcessTable>,
        env: &dyn Fn(&str) -> Option<String>,
        agent_environment: Option<AgentEnvironment>,
    ) -> Self {
        // Neither managed route exists on Windows, whatever the flags say:
        // with none enabled, the picker lists nothing.
        let enabled = [
            (SessionKind::Grok, ENABLE_GROK),
            (SessionKind::OpenCode, ENABLE_OPENCODE),
        ]
        .into_iter()
        .filter(|_| platform::SUPPORTED)
        .filter_map(|(kind, key)| (env(key).as_deref() == Some("1")).then_some(kind))
        .collect();
        Self::new(
            app_data_dir.join("managed-existing-sessions"),
            enabled,
            Arc::new(SystemManagedRuntime::new(table, agent_environment)),
        )
    }

    pub fn new(
        root: PathBuf,
        enabled: HashSet<SessionKind>,
        runtime: Arc<dyn ManagedRuntime>,
    ) -> Self {
        Self {
            root,
            enabled,
            runtime,
        }
    }

    pub fn launch(&self, request: ManagedLaunch) -> Result<DiscoveredSession, String> {
        if let Some(reason) = platform::unsupported(managed_label(request.kind)) {
            return Err(reason);
        }
        if !matches!(request.kind, SessionKind::Grok | SessionKind::OpenCode)
            || !self.enabled.contains(&request.kind)
        {
            return Err("Managed provider launch is disabled.".into());
        }
        let target = Target::new(request.kind, request.session_id.clone());
        if !target.is_valid()
            || request.authority.owner_uid != current_uid()
            || !printable(&request.authority.workspace_id, 256)
            || !printable(&request.authority.owner_id, 256)
        {
            return Err("Managed provider launch was refused.".into());
        }
        self.prepare_root()
            .map_err(|_| "Managed session registry is unavailable.".to_string())?;
        let records = self
            .read_records()
            .map_err(|_| "Managed session registry is unavailable.".to_string())?;
        if request.kind == SessionKind::Grok {
            self.sweep_grok_runtime(&records);
        }
        if let Some(existing) = records
            .into_iter()
            .find(|record| record.binding.target() == target)
        {
            if existing.binding.authority() != request.authority {
                return Err(
                    "This provider session belongs to a different managed authority.".into(),
                );
            }
            if !self.runtime.dead(&existing.binding) {
                return Err(
                    "This provider session already has an immutable managed binding.".into(),
                );
            }
            let removed = self
                .with_registry_lock(|records| {
                    let Some(index) = records.iter().position(|sealed| sealed.record == existing)
                    else {
                        return Ok(false);
                    };
                    records.remove(index);
                    self.write_registry(records)?;
                    Ok(true)
                })
                .map_err(|_| "Managed session registry is unavailable.".to_string())?;
            if !removed {
                return Err("This provider session binding changed during relaunch.".into());
            }
        }
        let binding = self
            .runtime
            .launch(&request, &self.root.join("run"))
            .map_err(|_| "The provider endpoint could not be verified.".to_string())?;
        if binding.target() != target
            || binding.authority() != request.authority
            || !self.runtime.verify(&binding)
        {
            self.runtime.terminate(&binding);
            return Err("The provider endpoint could not be verified.".into());
        }
        let record = Record {
            binding,
            spawned: false,
        };
        let result = self.with_registry_lock(|records| {
            if let Some(existing) = records
                .iter()
                .find(|existing| existing.record.binding.target() == target)
            {
                return if existing.record == record {
                    Ok(existing.record.session(true))
                } else {
                    Err(std::io::Error::new(
                        ErrorKind::AlreadyExists,
                        "managed session binding conflict",
                    ))
                };
            }
            records.push(seal(record.clone())?);
            self.write_registry(records)?;
            Ok(record.session(true))
        });
        match result {
            Ok(session) => Ok(session),
            Err(_) => {
                self.runtime.terminate(&record.binding);
                Err("Managed session registry is unavailable.".into())
            }
        }
    }

    /// The exact live binding injection may use. No registry record means no
    /// route, even if an otherwise compatible TUI/server happens to exist.
    /// A spawned agent's binding is its spawn's, so no flag gates it.
    pub fn binding(&self, target: &Target) -> Option<ManagedBinding> {
        let record = self
            .read_records()
            .ok()?
            .into_iter()
            .find(|record| record.binding.target() == *target)?;
        if !record.spawned && !self.enabled.contains(&target.kind) {
            return None;
        }
        self.runtime
            .verify(&record.binding)
            .then_some(record.binding)
    }

    /// Seals the binding of a session a spawn started and proved itself
    /// (`harness::opencode`), verified again as `launch` verifies its own.
    /// A target that already has a binding is refused, never rebound.
    pub fn adopt(&self, binding: ManagedBinding) -> Result<(), String> {
        let target = binding.target();
        if !target.is_valid() || !self.runtime.verify(&binding) {
            return Err("The provider endpoint could not be verified.".into());
        }
        let record = Record {
            binding,
            spawned: true,
        };
        self.with_registry_lock(|records| {
            if records
                .iter()
                .any(|sealed| sealed.record.binding.target() == target)
            {
                return Err(ErrorKind::AlreadyExists.into());
            }
            records.push(seal(record)?);
            self.write_registry(records)
        })
        .map_err(|_| "Managed session registry is unavailable.".to_string())
    }

    /// Removes a spawned session's binding once its spawn ended it. A
    /// binding a managed launch made is never removed here.
    pub fn forget(&self, target: &Target) {
        let _ = self.with_registry_lock(|records| {
            let before = records.len();
            records.retain(|sealed| {
                !sealed.record.spawned || sealed.record.binding.target() != *target
            });
            if records.len() == before {
                return Ok(());
            }
            self.write_registry(records)
        });
    }

    /// Sweeps both directories a Grok leader socket can live in. A record's
    /// socket is kept until the kernel positively reports its leader gone.
    fn sweep_grok_runtime(&self, records: &[Record]) {
        let keep: HashSet<String> = records
            .iter()
            .filter_map(|record| match &record.binding {
                ManagedBinding::Grok(binding) if !self.runtime.dead(&record.binding) => {
                    grok_socket_id(&binding.socket_path).map(ToOwned::to_owned)
                }
                _ => None,
            })
            .collect();
        let Some(cutoff) = SystemTime::now().checked_sub(GROK_RUNTIME_SWEEP_AGE) else {
            return;
        };
        for directory in [self.root.join("run"), short_runtime_dir()] {
            sweep_grok_runtime_dir(&directory, &keep, cutoff);
        }
    }

    pub fn authority(&self, target: &Target) -> Option<ManagedAuthority> {
        self.binding(target).map(|binding| binding.authority())
    }

    pub fn journal(&self, provider: &str) -> PathBuf {
        self.root.join("journal").join(provider)
    }

    pub fn enabled(&self, kind: SessionKind) -> bool {
        self.enabled.contains(&kind)
    }

    fn prepare_root(&self) -> std::io::Result<()> {
        for directory in [
            self.root.clone(),
            self.root.join("run"),
            self.root.join("journal"),
        ] {
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
            if !metadata.is_dir() || metadata.uid() != current_uid() || metadata.mode() & 0o077 != 0
            {
                return Err(std::io::Error::new(
                    ErrorKind::PermissionDenied,
                    "managed session directory is not private",
                ));
            }
        }
        Ok(())
    }

    fn with_registry_lock<T>(
        &self,
        body: impl FnOnce(&mut Vec<SealedRecord>) -> std::io::Result<T>,
    ) -> std::io::Result<T> {
        self.prepare_root()?;
        let lock = private_open(&self.root.join("bindings.lock"), false)?;
        lock.lock_exclusive()?;
        let mut records = self.read_sealed_or_quarantine()?;
        let result = body(&mut records);
        FileExt::unlock(&lock)?;
        result
    }

    fn read_records(&self) -> std::io::Result<Vec<Record>> {
        self.prepare_root()?;
        let lock = private_open(&self.root.join("bindings.lock"), false)?;
        lock.lock_exclusive()?;
        let records = self.read_sealed_or_quarantine();
        FileExt::unlock(&lock)?;
        records?
            .into_iter()
            .map(|sealed| {
                if digest(&sealed.record)? == sealed.digest {
                    Ok(sealed.record)
                } else {
                    Err(std::io::Error::new(
                        ErrorKind::InvalidData,
                        "managed session binding digest mismatch",
                    ))
                }
            })
            .collect()
    }

    /// A v1 registry cannot be decoded: its Grok records carry two
    /// `provider` keys. It is preserved as a private sibling for recovery,
    /// and reading continues from an empty v2 registry. Every other invalid
    /// registry (a digest mismatch, truncation, an unknown version) fails
    /// closed and stays in place.
    fn read_sealed_or_quarantine(&self) -> std::io::Result<Vec<SealedRecord>> {
        let Some(bytes) = self.read_registry_bytes()? else {
            return Ok(Vec::new());
        };
        if registry_version(&bytes) == Some(LEGACY_REGISTRY_VERSION) {
            self.quarantine_legacy(&bytes)?;
            return Ok(Vec::new());
        }
        decode_registry(&bytes)
    }

    /// A v1 provider has no v2 record, so nothing can reach, verify or
    /// relaunch it. Each v1 provider is sent `SIGTERM` first, through the
    /// same exact pid/start/uid check as any managed shutdown; the provider
    /// keeps its session, which a launch then loads again. The signal is
    /// best effort and its exit is not awaited: a launch of the same session
    /// right after this read can briefly overlap the exiting provider, and
    /// one that ignores `SIGTERM` keeps running with no record (#283).
    /// Signalling before the rename means a crash in between repeats both.
    fn quarantine_legacy(&self, bytes: &[u8]) -> std::io::Result<()> {
        for binding in legacy_bindings(bytes) {
            self.runtime.terminate(&binding);
        }
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let backup = self.root.join(format!(
            "{REGISTRY_FILE}.bak-{timestamp}-{}",
            random_hex(12)
        ));
        fs::rename(self.root.join(REGISTRY_FILE), backup)?;
        File::open(&self.root)?.sync_all()
    }

    fn read_registry_bytes(&self) -> std::io::Result<Option<Vec<u8>>> {
        let file = match private_open(&self.root.join(REGISTRY_FILE), true) {
            Ok(file) => file,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        let mut bytes = Vec::new();
        file.take(2_000_001).read_to_end(&mut bytes)?;
        if bytes.len() > 2_000_000 {
            return Err(std::io::Error::new(
                ErrorKind::InvalidData,
                "managed session registry is too large",
            ));
        }
        Ok(Some(bytes))
    }

    fn write_registry(&self, records: &[SealedRecord]) -> std::io::Result<()> {
        let bytes = serde_json::to_vec_pretty(&Registry {
            version: REGISTRY_VERSION,
            records: records.to_vec(),
        })
        .map_err(std::io::Error::other)?;
        let temp = self.root.join(format!(".bindings-{}.tmp", random_hex(24)));
        let mut file = private_create(&temp)?;
        file.write_all(&bytes)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        fs::rename(&temp, self.root.join(REGISTRY_FILE))?;
        File::open(&self.root)?.sync_all()
    }
}

/// The registry's `version`, read without decoding its records. A JSON
/// value keeps the last of duplicate keys, so a v1 Grok record still parses.
fn registry_version(bytes: &[u8]) -> Option<u64> {
    serde_json::from_slice::<serde_json::Value>(bytes)
        .ok()?
        .get("version")?
        .as_u64()
}

fn decode_registry(bytes: &[u8]) -> std::io::Result<Vec<SealedRecord>> {
    let registry: Registry = serde_json::from_slice(bytes)
        .map_err(|error| std::io::Error::new(ErrorKind::InvalidData, error))?;
    if registry.version != REGISTRY_VERSION {
        return Err(std::io::Error::new(
            ErrorKind::InvalidData,
            "managed session registry version mismatch",
        ));
    }
    for sealed in &registry.records {
        if digest(&sealed.record)? != sealed.digest {
            return Err(std::io::Error::new(
                ErrorKind::InvalidData,
                "managed session binding digest mismatch",
            ));
        }
    }
    Ok(registry.records)
}

/// The provider bindings a v1 registry names, tagged by v1 `provider`. A
/// record that does not decode is skipped.
fn legacy_bindings(bytes: &[u8]) -> Vec<ManagedBinding> {
    let Ok(registry) = serde_json::from_slice::<serde_json::Value>(bytes) else {
        return Vec::new();
    };
    registry
        .get("records")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|sealed| {
            let binding = sealed.get("record")?.get("binding")?;
            match binding.get("provider")?.as_str()? {
                "grok" => serde_json::from_value(binding.clone())
                    .ok()
                    .map(ManagedBinding::Grok),
                "open_code" => serde_json::from_value(binding.clone())
                    .ok()
                    .map(ManagedBinding::OpenCode),
                _ => None,
            }
        })
        .collect()
}

fn seal(record: Record) -> std::io::Result<SealedRecord> {
    Ok(SealedRecord {
        digest: digest(&record)?,
        record,
    })
}

fn digest(record: &Record) -> std::io::Result<String> {
    let bytes = serde_json::to_vec(record).map_err(std::io::Error::other)?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn private_open(path: &Path, read_only: bool) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).custom_flags(platform::O_NOFOLLOW);
    if !read_only {
        options.write(true).create(true).mode(0o600);
    }
    let file = options.open(path)?;
    private_file(&file)?;
    Ok(file)
}

fn private_create(path: &Path) -> std::io::Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .custom_flags(platform::O_NOFOLLOW)
        .mode(0o600)
        .open(path)?;
    private_file(&file)?;
    Ok(file)
}

fn private_file(file: &File) -> std::io::Result<()> {
    let metadata = file.metadata()?;
    if metadata.is_file() && metadata.uid() == current_uid() && metadata.mode() & 0o077 == 0 {
        Ok(())
    } else {
        Err(std::io::Error::new(
            ErrorKind::PermissionDenied,
            "managed session registry is not private",
        ))
    }
}

fn printable(value: &str, max: usize) -> bool {
    (1..=max).contains(&value.len()) && value.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
}

struct SystemManagedRuntime {
    table: Arc<dyn ProcessTable>,
    agent_environment: Option<AgentEnvironment>,
    http: opencode_existing::SystemHttp,
    grok_inspector: Arc<dyn GrokInspector>,
    grok_launch_inspect_timeout: Duration,
    grok_verify_inspect_timeout: Duration,
}

trait GrokInspector: Send + Sync {
    fn inspect(
        &self,
        binding: &existing_session::Binding,
        authority: Arc<dyn grok::Authority>,
        timeout: Duration,
    ) -> Result<(String, String), existing_session::Failure>;
}

struct SystemGrokInspector;

impl GrokInspector for SystemGrokInspector {
    fn inspect(
        &self,
        binding: &existing_session::Binding,
        authority: Arc<dyn grok::Authority>,
        timeout: Duration,
    ) -> Result<(String, String), existing_session::Failure> {
        grok::inspect_session(binding, authority, timeout)
    }
}

impl SystemManagedRuntime {
    fn new(table: Arc<dyn ProcessTable>, agent_environment: Option<AgentEnvironment>) -> Self {
        Self {
            table,
            agent_environment,
            http: opencode_existing::SystemHttp,
            grok_inspector: Arc::new(SystemGrokInspector),
            grok_launch_inspect_timeout: GROK_LAUNCH_INSPECT_TIMEOUT,
            grok_verify_inspect_timeout: GROK_VERIFY_INSPECT_TIMEOUT,
        }
    }

    fn checked_paths(&self, request: &ManagedLaunch) -> Result<(PathBuf, PathBuf), ()> {
        let executable = fs::canonicalize(&request.executable).map_err(|_| ())?;
        let directory = fs::canonicalize(&request.directory).map_err(|_| ())?;
        let executable_metadata = fs::metadata(&executable).map_err(|_| ())?;
        let directory_metadata = fs::metadata(&directory).map_err(|_| ())?;
        let expected_executable = match request.kind {
            SessionKind::Grok => "grok",
            SessionKind::OpenCode => "opencode",
            _ => return Err(()),
        };
        if request
            .executable
            .file_name()
            .and_then(|name| name.to_str())
            != Some(expected_executable)
            || !executable_metadata.is_file()
            || executable_metadata.mode() & 0o111 == 0
            || executable_metadata.mode() & 0o022 != 0
            || (executable_metadata.uid() != 0 && executable_metadata.uid() != current_uid())
            || !directory_metadata.is_dir()
            || directory_metadata.uid() != current_uid()
        {
            return Err(());
        }
        Ok((executable, directory))
    }

    fn environment(&self, executable: &Path) -> BTreeMap<String, String> {
        let base: BTreeMap<String, String> = std::env::vars().collect();
        match &self.agent_environment {
            Some(environment) => environment(
                &executable
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                base,
            ),
            None => base,
        }
    }

    fn process(&self, pid: i32, expected_uid: u32) -> Option<ProcessInfo> {
        self.table.process(pid).filter(|process| {
            process.uid == expected_uid && self.table.process(pid) == Some(*process)
        })
    }

    fn terminate_process(&self, process: ProcessInfo) {
        if self.table.process(process.pid) == Some(process) {
            // The kernel identity was read twice at launch and again
            // immediately before signalling, including uid and start time.
            terminate_pid(process.pid);
        }
    }

    fn launch_opencode(
        &self,
        request: &ManagedLaunch,
        executable: &Path,
        directory: &Path,
    ) -> Result<ManagedBinding, ()> {
        let start = |arguments: &[OsString], environment: &BTreeMap<String, String>| {
            spawn_detached(executable, arguments, directory, environment)
        };
        let terminate = |process| self.terminate_process(process);
        let serve = opencode_serve::Serve {
            table: &*self.table,
            owner_uid: request.authority.owner_uid,
            environment: self.environment(executable),
            timeout: LAUNCH_TIMEOUT,
            start: &start,
            terminate: &terminate,
        };
        let authority = (
            request.authority.workspace_id.as_str(),
            request.authority.owner_id.as_str(),
        );
        opencode_serve::serve(&serve, &mut |served| {
            let candidate = served.binding(authority, &request.session_id, executable, directory);
            let (project_id, opencode_workspace_id) = opencode_existing::inspect_session(
                &*self.table,
                &self.http,
                &candidate,
                Duration::from_secs(3),
            )
            .ok()?;
            Some(ManagedBinding::OpenCode(opencode_existing::Binding {
                project_id,
                opencode_workspace_id,
                ..candidate
            }))
        })
        .map_err(|_| ())
    }

    fn launch_grok(
        &self,
        request: &ManagedLaunch,
        executable: &Path,
        directory: &Path,
        runtime_dir: &Path,
    ) -> Result<ManagedBinding, ()> {
        let socket_path = grok_socket_path(runtime_dir)?;
        let marker = random_hex(64);
        let mut environment = self.environment(executable);
        environment.insert("AGENT_RELAY_MANAGED_SESSION_MARKER".into(), marker.clone());
        let arguments = grok_leader_arguments(&socket_path);
        let pid = spawn_detached(executable, &arguments, directory, &environment)?;
        let deadline = Instant::now() + LAUNCH_TIMEOUT;
        let mut launched_process = None;
        while Instant::now() < deadline {
            if let Some(process) = self.process(pid, request.authority.owner_uid) {
                launched_process.get_or_insert(process);
                if let Ok(socket) = fs::symlink_metadata(&socket_path) {
                    if !FileTypeExt::is_socket(&socket.file_type())
                        || socket.uid() != request.authority.owner_uid
                    {
                        std::thread::sleep(Duration::from_millis(100));
                        continue;
                    }
                    let mut candidate = existing_session::Binding {
                        provider: Provider::Grok,
                        transport: Transport::Acp,
                        workspace_id: request.authority.workspace_id.clone(),
                        session_id: request.session_id.clone(),
                        endpoint_id: String::new(),
                        owner_id: request.authority.owner_id.clone(),
                        credential_reference: String::new(),
                        owner_uid: process.uid,
                        auth_id: String::new(),
                        protocol_id: String::new(),
                        cwd: directory.to_path_buf(),
                        model_id: "pending-readback".into(),
                        agent_version: "pending-readback".into(),
                        executable: executable.to_path_buf(),
                        leader_pid: process.pid,
                        leader_start: process.start,
                        socket_path: socket_path.clone(),
                        socket_device: socket.dev(),
                        socket_inode: socket.ino(),
                    };
                    candidate.credential_reference =
                        grok::credential_reference(&candidate, &marker);
                    let authority: Arc<dyn grok::Authority> =
                        Arc::new(grok::SystemAuthority::new(self.table.clone()));
                    let inspect_timeout = deadline
                        .saturating_duration_since(Instant::now())
                        .min(self.grok_launch_inspect_timeout);
                    if inspect_timeout.is_zero() {
                        break;
                    }
                    if let Ok((model_id, agent_version)) =
                        self.grok_inspector
                            .inspect(&candidate, authority, inspect_timeout)
                    {
                        return Ok(ManagedBinding::Grok(existing_session::Binding {
                            model_id,
                            agent_version,
                            ..candidate
                        }));
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        if let Some(process) = launched_process {
            self.terminate_process(process);
        }
        let _ = fs::remove_file(socket_path);
        Err(())
    }
}

impl ManagedRuntime for SystemManagedRuntime {
    fn launch(&self, request: &ManagedLaunch, runtime_dir: &Path) -> Result<ManagedBinding, ()> {
        let (executable, directory) = self.checked_paths(request)?;
        match request.kind {
            SessionKind::Grok => self.launch_grok(request, &executable, &directory, runtime_dir),
            SessionKind::OpenCode => self.launch_opencode(request, &executable, &directory),
            _ => Err(()),
        }
    }

    fn verify(&self, binding: &ManagedBinding) -> bool {
        match binding {
            ManagedBinding::Grok(binding) => {
                let authority: Arc<dyn grok::Authority> =
                    Arc::new(grok::SystemAuthority::new(self.table.clone()));
                self.grok_inspector
                    .inspect(binding, authority, self.grok_verify_inspect_timeout)
                    .is_ok_and(|identity| {
                        identity == (binding.model_id.clone(), binding.agent_version.clone())
                    })
            }
            ManagedBinding::OpenCode(binding) => opencode_existing::inspect_session(
                &*self.table,
                &self.http,
                binding,
                Duration::from_secs(5),
            )
            .is_ok_and(|identity| {
                identity
                    == (
                        binding.project_id.clone(),
                        binding.opencode_workspace_id.clone(),
                    )
            }),
        }
    }

    fn verified_title(&self, binding: &ManagedBinding) -> Result<Option<String>, ()> {
        discovery::verified_title(self, binding)
    }

    fn dead(&self, binding: &ManagedBinding) -> bool {
        let (pid, start, uid) = match binding {
            ManagedBinding::Grok(binding) => {
                (binding.leader_pid, binding.leader_start, binding.owner_uid)
            }
            ManagedBinding::OpenCode(binding) => {
                (binding.server_pid, binding.server_start, binding.server_uid)
            }
        };
        match self.table.process(pid) {
            Some(process) => process.start != start || process.uid != uid,
            None => self.table.process_gone(pid),
        }
    }

    fn terminate(&self, binding: &ManagedBinding) {
        let (pid, start) = match binding {
            ManagedBinding::Grok(binding) => (binding.leader_pid, binding.leader_start),
            ManagedBinding::OpenCode(binding) => (binding.server_pid, binding.server_start),
        };
        if self
            .table
            .process(pid)
            .is_some_and(|process| process.start == start && process.uid == current_uid())
        {
            terminate_pid(pid);
        }
    }
}

// Unix sockets, signals and file modes throughout; managed providers are not
// available on Windows.
#[cfg(test)]
#[cfg(unix)]
mod tests {
    use super::*;
    use crate::relay::process::{FakeProcess, FakeProcesses, SystemProcesses};
    use std::collections::VecDeque;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::Mutex;

    struct NeverAnsweringInspector {
        observed: Mutex<Vec<Duration>>,
    }

    impl GrokInspector for NeverAnsweringInspector {
        fn inspect(
            &self,
            _: &existing_session::Binding,
            _: Arc<dyn grok::Authority>,
            timeout: Duration,
        ) -> Result<(String, String), existing_session::Failure> {
            self.observed.lock().unwrap().push(timeout);
            std::thread::sleep(timeout);
            Err(existing_session::Failure::TimedOut)
        }
    }

    struct FakeRuntime {
        binding: ManagedBinding,
        live: Mutex<bool>,
        terminated: Mutex<Vec<ManagedBinding>>,
    }

    impl FakeRuntime {
        fn live(binding: ManagedBinding) -> Arc<Self> {
            Arc::new(Self {
                binding,
                live: Mutex::new(true),
                terminated: Mutex::new(Vec::new()),
            })
        }
    }

    impl ManagedRuntime for FakeRuntime {
        fn launch(&self, _: &ManagedLaunch, _: &Path) -> Result<ManagedBinding, ()> {
            Ok(self.binding.clone())
        }

        fn verify(&self, binding: &ManagedBinding) -> bool {
            *self.live.lock().unwrap() && binding == &self.binding
        }

        fn terminate(&self, binding: &ManagedBinding) {
            self.terminated.lock().unwrap().push(binding.clone());
        }
    }

    struct RelaunchRuntime {
        launches: Mutex<VecDeque<ManagedBinding>>,
        live: Mutex<Option<ManagedBinding>>,
    }

    impl ManagedRuntime for RelaunchRuntime {
        fn launch(&self, _: &ManagedLaunch, _: &Path) -> Result<ManagedBinding, ()> {
            let binding = self.launches.lock().unwrap().pop_front().ok_or(())?;
            *self.live.lock().unwrap() = Some(binding.clone());
            Ok(binding)
        }

        fn verify(&self, binding: &ManagedBinding) -> bool {
            self.live.lock().unwrap().as_ref() == Some(binding)
        }
    }

    fn binding(root: &Path) -> ManagedBinding {
        ManagedBinding::OpenCode(opencode_existing::Binding {
            relay_workspace_id: "rw_exact".into(),
            owner_id: "user_exact".into(),
            session_id: "ses_exact".into(),
            endpoint: "http://127.0.0.1:4040".into(),
            server_pid: 42,
            server_start: 99,
            server_uid: current_uid(),
            executable: root.join("opencode"),
            directory: root.join("project"),
            project_id: "project_exact".into(),
            opencode_workspace_id: Some("workspace_exact".into()),
            credential_reference: format!("probe:opencode:{}", "a".repeat(64)),
        })
    }

    fn grok_binding(root: &Path) -> ManagedBinding {
        ManagedBinding::Grok(existing_session::Binding {
            provider: Provider::Grok,
            transport: Transport::Acp,
            workspace_id: "rw_exact".into(),
            session_id: "01a106e9-5e95-7993-a026-59215a8975cf".into(),
            endpoint_id: String::new(),
            owner_id: "user_exact".into(),
            credential_reference: format!("probe:grok:{}", "b".repeat(64)),
            owner_uid: current_uid(),
            auth_id: String::new(),
            protocol_id: String::new(),
            cwd: root.join("project"),
            model_id: "grok-4.7".into(),
            agent_version: "1.0.46".into(),
            executable: root.join("grok"),
            leader_pid: 43,
            leader_start: 100,
            socket_path: root.join("grok.sock"),
            socket_device: 7,
            socket_inode: 11,
        })
    }

    fn launch(root: &Path) -> ManagedLaunch {
        ManagedLaunch {
            kind: SessionKind::OpenCode,
            executable: root.join("opencode"),
            directory: root.join("project"),
            session_id: "ses_exact".into(),
            authority: ManagedAuthority {
                workspace_id: "rw_exact".into(),
                owner_id: "user_exact".into(),
                owner_uid: current_uid(),
            },
        }
    }

    fn grok_launch(root: &Path) -> ManagedLaunch {
        ManagedLaunch {
            kind: SessionKind::Grok,
            executable: root.join("grok"),
            directory: root.join("project"),
            session_id: "01a106e9-5e95-7993-a026-59215a8975cf".into(),
            authority: ManagedAuthority {
                workspace_id: "rw_exact".into(),
                owner_id: "user_exact".into(),
                owner_uid: current_uid(),
            },
        }
    }

    fn write_v1_registry(manager: &ManagedSessions, record: Record, provider: &str) -> Vec<u8> {
        manager.prepare_root().unwrap();
        let current = serde_json::to_string_pretty(&Registry {
            version: REGISTRY_VERSION,
            records: vec![seal(record).unwrap()],
        })
        .unwrap();
        let legacy = current
            .replacen(
                &format!("\"version\": {REGISTRY_VERSION}"),
                "\"version\": 1",
                1,
            )
            .replacen(
                &format!("\"managed_provider\": \"{provider}\""),
                &format!("\"provider\": \"{provider}\""),
                1,
            )
            .into_bytes();
        let path = manager.root.join(REGISTRY_FILE);
        fs::write(&path, &legacy).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        legacy
    }

    #[test]
    fn detached_provider_survives_its_launcher() {
        let temp = tempfile::tempdir().unwrap();
        let pid = spawn_detached(
            Path::new("/bin/sleep"),
            &[OsString::from("30")],
            temp.path(),
            &BTreeMap::new(),
        )
        .unwrap();
        let table = SystemProcesses::default();
        let deadline = Instant::now() + Duration::from_secs(2);
        let process = loop {
            if let Some(process) = table.process(pid) {
                break process;
            }
            assert!(Instant::now() < deadline, "detached provider did not start");
            std::thread::sleep(Duration::from_millis(10));
        };
        assert_eq!(process.uid, current_uid());
        assert_ne!(process.parent, std::process::id() as i32);
        // SAFETY: `getsid` is a read-only query for live process ids.
        let provider_session = unsafe { libc::getsid(pid) };
        let test_session = unsafe { libc::getsid(0) };
        assert!(provider_session > 0);
        assert_ne!(provider_session, test_session);
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(table.process(pid), Some(process));

        if table.process(pid) == Some(process) {
            // SAFETY: this test just launched and re-verified this exact pid,
            // uid and kernel start time.
            unsafe {
                libc::kill(pid, libc::SIGTERM);
            }
        }
    }

    #[test]
    fn default_off_launch_and_picker_fail_closed() {
        let temp = tempfile::tempdir().unwrap();
        let runtime = FakeRuntime::live(binding(temp.path()));
        let manager = ManagedSessions::new(temp.path().join("registry"), HashSet::new(), runtime);
        assert_eq!(
            manager.launch(launch(temp.path())).unwrap_err(),
            "Managed provider launch is disabled."
        );
        assert!(manager.sessions().is_empty());
        assert!(!temp.path().join("registry").exists());
    }

    #[test]
    fn system_launch_only_accepts_the_provider_executable_basename() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        fs::create_dir(&project).unwrap();
        let wrong = temp.path().join("not-opencode");
        fs::write(&wrong, b"#!/bin/sh\n").unwrap();
        fs::set_permissions(&wrong, fs::Permissions::from_mode(0o700)).unwrap();
        let runtime = SystemManagedRuntime::new(Arc::new(SystemProcesses::default()), None);
        let mut request = launch(temp.path());
        request.directory = project;
        request.executable = wrong.clone();
        assert!(runtime.checked_paths(&request).is_err());

        let expected = temp.path().join("opencode");
        fs::rename(wrong, &expected).unwrap();
        request.executable = expected.clone();
        assert_eq!(
            runtime.checked_paths(&request).unwrap().0,
            fs::canonicalize(expected).unwrap()
        );
    }

    #[test]
    fn grok_1_0_46_launch_uses_a_bindable_private_socket_path() {
        // This is the real runtime-directory shape from the Grok 1.0.46
        // refusal on macOS. Adding the old random socket name produced a
        // 104-byte path, exactly filling Darwin's sun_path and leaving no
        // room for its required terminating NUL.
        #[cfg(target_os = "macos")]
        assert!(!unix_socket_path_fits(Path::new(
            "/Users/exampleusr/relay-167-e2e/app.dev/managed-existing-sessions/run/\
             grok-e033dd4aa6c04eba89e95595.sock"
        )));

        // Exercise the same boundary on platforms such as Linux whose
        // sun_path is a few bytes larger than Darwin's.
        let capacity = unsafe { std::mem::zeroed::<libc::sockaddr_un>() }
            .sun_path
            .len();
        let socket_name = format!("grok-{}.sock", "a".repeat(24));
        let runtime_length = capacity - 1 - socket_name.len();
        let runtime = PathBuf::from(format!("/{}", "r".repeat(runtime_length - 1)));
        let representative = runtime.join(socket_name);
        assert_eq!(representative.as_os_str().as_bytes().len(), capacity);
        assert!(!unix_socket_path_fits(&representative));

        let selected = grok_socket_path(&runtime).unwrap();
        assert!(unix_socket_path_fits(&selected));
        assert!(selected.starts_with(format!("/tmp/agent-relay-managed-{}", current_uid())));
    }

    #[test]
    fn grok_1_0_13_short_runtime_shape_remains_preferred() {
        let runtime = Path::new("/tmp/grok-1.0.13");
        let selected = grok_socket_path(runtime).unwrap();
        assert!(unix_socket_path_fits(&selected));
        assert!(selected.starts_with(runtime));
    }

    #[test]
    fn grok_1_0_46_cold_start_exceeds_the_legacy_inspection_budget() {
        assert!(GROK_LAUNCH_INSPECT_TIMEOUT > GROK_VERIFY_INSPECT_TIMEOUT);
        assert!(GROK_LAUNCH_INSPECT_TIMEOUT <= LAUNCH_TIMEOUT);
        let socket = Path::new("/tmp/managed-grok.sock");
        assert_eq!(
            grok_leader_arguments(socket),
            [
                OsString::from("agent"),
                OsString::from("leader"),
                OsString::from("--no-exit-on-disconnect"),
                OsString::from("--leader-socket"),
                socket.as_os_str().to_owned(),
            ]
        );
    }

    #[test]
    fn grok_picker_passes_the_short_budget_while_launch_keeps_the_long_budget() {
        let temp = tempfile::tempdir().unwrap();
        let inspector = Arc::new(NeverAnsweringInspector {
            observed: Mutex::new(Vec::new()),
        });
        let runtime = Arc::new(SystemManagedRuntime {
            table: Arc::new(FakeProcesses::default()),
            agent_environment: None,
            http: opencode_existing::SystemHttp,
            grok_inspector: inspector.clone(),
            grok_launch_inspect_timeout: Duration::from_millis(300),
            grok_verify_inspect_timeout: Duration::from_millis(30),
        });
        let manager = ManagedSessions::new(
            temp.path().join("registry"),
            HashSet::from([SessionKind::Grok]),
            runtime.clone(),
        );
        manager
            .with_registry_lock(|records| {
                records.push(seal(Record {
                    binding: grok_binding(temp.path()),
                    spawned: false,
                })?);
                manager.write_registry(records)
            })
            .unwrap();

        assert!(manager.sessions().is_empty());
        assert_eq!(
            inspector.observed.lock().unwrap().as_slice(),
            &[Duration::from_millis(30)]
        );
        assert_eq!(
            runtime.grok_launch_inspect_timeout,
            Duration::from_millis(300)
        );
    }

    #[test]
    fn grok_short_socket_fallback_refuses_a_lookalike_directory() {
        let temp = tempfile::tempdir().unwrap();
        let real = temp.path().join("real");
        fs::create_dir(&real).unwrap();
        let lookalike = temp.path().join("agent-relay-managed");
        std::os::unix::fs::symlink(real, &lookalike).unwrap();
        assert!(prepare_private_runtime_dir(lookalike).is_err());
    }

    #[test]
    fn system_runtime_dead_requires_positive_process_identity_evidence() {
        let temp = tempfile::tempdir().unwrap();
        let binding = binding(temp.path());
        let table = Arc::new(FakeProcesses::default());
        let runtime = SystemManagedRuntime::new(table.clone(), None);

        assert!(
            !runtime.dead(&binding),
            "an unreadable lookup must fail closed"
        );
        table.insert(
            42,
            FakeProcess {
                uid: current_uid(),
                start: 99,
                executable: None,
                ..FakeProcess::default()
            },
        );
        assert!(
            !runtime.dead(&binding),
            "an executable lookup failure must not retire a live pid/start"
        );
        table.insert(
            42,
            FakeProcess {
                uid: current_uid(),
                start: 100,
                ..FakeProcess::default()
            },
        );
        assert!(
            runtime.dead(&binding),
            "a start-time mismatch proves replacement"
        );

        let mut definitely_gone = binding;
        let ManagedBinding::OpenCode(gone_binding) = &mut definitely_gone else {
            unreachable!()
        };
        gone_binding.server_pid = i32::MAX;
        let system = SystemManagedRuntime::new(Arc::new(SystemProcesses::default()), None);
        assert!(system.dead(&definitely_gone));
    }

    #[test]
    fn managed_opencode_discovery_reads_native_title_after_rename() {
        use crate::relay::process::{FakeProcess, FakeProcesses};
        use std::io::{Read, Write};
        use std::net::TcpListener;
        let temp = tempfile::tempdir().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let ManagedBinding::OpenCode(mut native) = binding(temp.path()) else {
            unreachable!()
        };
        native.executable = std::env::current_exe().unwrap();
        native.endpoint = format!("http://127.0.0.1:{port}");
        native.credential_reference =
            opencode_existing::credential_reference(&native, "test-marker");
        let table = Arc::new(FakeProcesses::default());
        table.insert(
            native.server_pid,
            FakeProcess {
                uid: native.server_uid,
                start: native.server_start,
                executable: Some(native.executable.clone()),
                arguments: vec![
                    "opencode".into(),
                    "serve".into(),
                    "--hostname".into(),
                    "127.0.0.1".into(),
                    "--port".into(),
                    port.to_string(),
                ],
                environment: [
                    ("OPENCODE_SERVER_USERNAME".into(), "relay".into()),
                    ("OPENCODE_SERVER_PASSWORD".into(), "test-secret".into()),
                    (
                        "AGENT_RELAY_MANAGED_SESSION_MARKER".into(),
                        "test-marker".into(),
                    ),
                ]
                .into(),
                tcp_listeners: vec![("127.0.0.1".into(), port)],
                ..Default::default()
            },
        );
        let metadata = Arc::new(Mutex::new(serde_json::json!({
            "id": native.session_id,
            "projectID": native.project_id,
            "workspaceID": native.opencode_workspace_id,
            "directory": native.directory,
            "title": "Original native title",
            "time": {"created": 1, "updated": 2}
        })));
        let state = metadata.clone();
        listener.set_nonblocking(true).unwrap();
        let server = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(15);
            let mut methods = Vec::new();
            while methods.len() < 6 && Instant::now() < deadline {
                let (mut stream, _) = match listener.accept() {
                    Ok(stream) => stream,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    Err(error) => panic!("{error}"),
                };
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut buffer = [0; 4096];
                let (headers, body) = loop {
                    let n = stream.read(&mut buffer).unwrap();
                    assert_ne!(n, 0);
                    bytes.extend_from_slice(&buffer[..n]);
                    let Some(end) = bytes.windows(4).position(|window| window == b"\r\n\r\n")
                    else {
                        continue;
                    };
                    let headers = String::from_utf8(bytes[..end].to_vec()).unwrap();
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            let (key, value) = line.split_once(':')?;
                            key.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    if bytes.len() >= end + 4 + length {
                        break (headers, bytes[end + 4..end + 4 + length].to_vec());
                    }
                };
                let method = headers.split_whitespace().next().unwrap().to_owned();
                assert!(headers
                    .lines()
                    .next()
                    .unwrap()
                    .contains("/session/ses_exact "));
                assert!(matches!(method.as_str(), "GET" | "PATCH"));
                let mut metadata = state.lock().unwrap();
                if method == "PATCH" {
                    let update: serde_json::Value = serde_json::from_slice(&body).unwrap();
                    metadata["title"] = update["title"].clone();
                }
                let body = serde_json::to_vec(&*metadata).unwrap();
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
                .unwrap();
                stream.write_all(&body).unwrap();
                methods.push(method);
            }
            methods
        });
        let binding = ManagedBinding::OpenCode(native.clone());
        let root = temp.path().join("registry");
        let enabled = HashSet::from([SessionKind::OpenCode]);
        let seed = ManagedSessions::new(root.clone(), enabled.clone(), FakeRuntime::live(binding));
        seed.launch(launch(temp.path())).unwrap();
        let manager = ManagedSessions::new(
            root,
            enabled,
            Arc::new(SystemManagedRuntime::new(table.clone(), None)),
        );
        assert_eq!(manager.sessions()[0].title, "Original native title");
        assert_eq!(
            crate::relay::session_titles::opencode::set_binding(
                &*table,
                &opencode_existing::SystemHttp,
                &native,
                "Renamed natively"
            )
            .unwrap(),
            "Renamed natively"
        );
        assert_eq!(manager.sessions()[0].title, "Renamed natively");
        metadata.lock().unwrap()["title"] = serde_json::json!("Changed in OpenCode");
        assert_eq!(manager.sessions()[0].title, "Changed in OpenCode");
        metadata.lock().unwrap()["projectID"] = serde_json::json!("different-project");
        assert!(
            manager.sessions().is_empty(),
            "title metadata must not bypass identity verification"
        );
        assert_eq!(
            server.join().unwrap(),
            ["GET", "GET", "PATCH", "GET", "GET", "GET"],
            "one bounded read per discovery, no prompt or additional verification request"
        );
    }

    #[test]
    fn verified_launch_survives_restart_without_storing_raw_credentials() {
        let temp = tempfile::tempdir().unwrap();
        let runtime = FakeRuntime::live(binding(temp.path()));
        let enabled = HashSet::from([SessionKind::OpenCode]);
        let root = temp.path().join("registry");
        let manager = ManagedSessions::new(root.clone(), enabled.clone(), runtime.clone());
        let session = manager.launch(launch(temp.path())).unwrap();
        assert_eq!(session.target.id, "ses_exact");
        let bytes = fs::read(root.join(REGISTRY_FILE)).unwrap();
        let text = String::from_utf8(bytes).unwrap();
        assert!(!text.contains("password"));
        assert!(!text.contains("Basic "));

        let restarted = ManagedSessions::new(root, enabled, runtime);
        assert_eq!(restarted.sessions(), vec![session]);
    }

    #[test]
    fn a_spawned_binding_routes_without_the_flag_and_is_forgotten_when_its_spawn_ends() {
        let temp = tempfile::tempdir().unwrap();
        let spawned = binding(temp.path());
        let target = spawned.target();
        let runtime = FakeRuntime::live(spawned.clone());
        let root = temp.path().join("registry");
        let manager = ManagedSessions::new(root.clone(), HashSet::new(), runtime.clone());
        assert_eq!(manager.binding(&target), None);
        manager.adopt(spawned.clone()).unwrap();
        assert_eq!(manager.binding(&target), Some(spawned.clone()));
        // Never a picker row, flag on or off; never rebound.
        assert!(manager.sessions().is_empty());
        let enabled = HashSet::from([SessionKind::OpenCode]);
        let flagged = ManagedSessions::new(root.clone(), enabled, runtime.clone());
        assert!(flagged.sessions().is_empty());
        assert!(manager.adopt(spawned.clone()).is_err());
        let refused = flagged.launch(launch(temp.path()));
        assert!(refused.is_err(), "a managed launch cannot take it over");
        // A managed binding is never forgotten by a spawn.
        manager.forget(&target);
        assert_eq!(manager.binding(&target), None);
        assert_eq!(flagged.launch(launch(temp.path())).unwrap().target, target);
        manager.forget(&target);
        assert_eq!(flagged.binding(&target), Some(spawned.clone()));
        // A binding that does not verify is not adopted.
        *runtime.live.lock().unwrap() = false;
        let other = ManagedSessions::new(temp.path().join("other"), HashSet::new(), runtime);
        assert!(other.adopt(spawned).is_err());
        assert_eq!(other.read_records().unwrap(), vec![]);
    }

    #[test]
    fn grok_registry_round_trips_without_a_duplicate_provider_tag() {
        let temp = tempfile::tempdir().unwrap();
        let runtime = FakeRuntime::live(grok_binding(temp.path()));
        let enabled = HashSet::from([SessionKind::Grok]);
        let root = temp.path().join("registry");
        let manager = ManagedSessions::new(root.clone(), enabled.clone(), runtime.clone());
        let session = manager.launch(grok_launch(temp.path())).unwrap();

        let text = String::from_utf8(fs::read(root.join(REGISTRY_FILE)).unwrap()).unwrap();
        assert_eq!(text.matches("\"managed_provider\": \"grok\"").count(), 1);
        assert_eq!(text.matches("\"provider\": \"grok\"").count(), 1);

        let restarted = ManagedSessions::new(root, enabled, runtime);
        assert_eq!(restarted.sessions(), vec![session]);
    }

    #[test]
    fn v1_opencode_and_duplicate_tag_grok_registries_are_quarantined_then_replaced() {
        for (kind, provider, bound, request) in [
            (
                SessionKind::OpenCode,
                "open_code",
                binding as fn(&Path) -> ManagedBinding,
                launch as fn(&Path) -> ManagedLaunch,
            ),
            (
                SessionKind::Grok,
                "grok",
                grok_binding as fn(&Path) -> ManagedBinding,
                grok_launch as fn(&Path) -> ManagedLaunch,
            ),
        ] {
            let temp = tempfile::tempdir().unwrap();
            let expected = bound(temp.path());
            let runtime = FakeRuntime::live(expected.clone());
            let root = temp.path().join("registry");
            let manager =
                ManagedSessions::new(root.clone(), HashSet::from([kind]), runtime.clone());
            let legacy = write_v1_registry(
                &manager,
                Record {
                    binding: expected.clone(),
                    spawned: false,
                },
                provider,
            );
            if kind == SessionKind::Grok {
                assert_eq!(
                    String::from_utf8_lossy(&legacy)
                        .matches("\"provider\": \"grok\"")
                        .count(),
                    2,
                    "the fixture must retain the real v1 duplicate tag"
                );
            }

            assert!(manager.sessions().is_empty());
            assert_eq!(
                runtime.terminated.lock().unwrap().as_slice(),
                &[expected],
                "a v1 provider has no v2 record and must not outlive the quarantine"
            );
            let backups = fs::read_dir(&root)
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| {
                    entry
                        .file_name()
                        .to_string_lossy()
                        .starts_with("bindings.json.bak-")
                })
                .collect::<Vec<_>>();
            assert_eq!(backups.len(), 1);
            assert_eq!(fs::read(backups[0].path()).unwrap(), legacy);
            assert_eq!(
                backups[0].metadata().unwrap().permissions().mode() & 0o077,
                0
            );
            assert!(!root.join(REGISTRY_FILE).exists());

            let launched = manager.launch(request(temp.path())).unwrap();
            assert_eq!(launched.target.kind, kind);
            let registry: Registry =
                serde_json::from_slice(&fs::read(root.join(REGISTRY_FILE)).unwrap()).unwrap();
            assert_eq!(registry.version, REGISTRY_VERSION);
            assert_eq!(registry.records.len(), 1);
            assert_eq!(fs::read(backups[0].path()).unwrap(), legacy);
        }
    }

    #[test]
    fn invalid_v2_registry_fails_closed_without_quarantine() {
        let temp = tempfile::tempdir().unwrap();
        let runtime = FakeRuntime::live(binding(temp.path()));
        let root = temp.path().join("registry");
        let manager = ManagedSessions::new(
            root.clone(),
            HashSet::from([SessionKind::OpenCode]),
            runtime.clone(),
        );
        manager.launch(launch(temp.path())).unwrap();
        let path = root.join(REGISTRY_FILE);
        let healthy = fs::read(&path).unwrap();
        let tampered = String::from_utf8(healthy.clone())
            .unwrap()
            .replacen("project_exact", "project_other", 1)
            .into_bytes();
        let truncated = healthy[..healthy.len() / 2].to_vec();
        let unknown_version = String::from_utf8(healthy.clone())
            .unwrap()
            .replacen(
                &format!("\"version\": {REGISTRY_VERSION}"),
                "\"version\": 3",
                1,
            )
            .into_bytes();

        for invalid in [tampered, truncated, unknown_version] {
            fs::write(&path, &invalid).unwrap();
            assert!(manager.sessions().is_empty());
            assert_eq!(
                manager.launch(launch(temp.path())),
                Err("Managed session registry is unavailable.".into())
            );
            assert_eq!(
                fs::read(&path).unwrap(),
                invalid,
                "the registry stays in place"
            );
            assert!(fs::read_dir(&root)
                .unwrap()
                .filter_map(Result::ok)
                .all(|entry| {
                    !entry
                        .file_name()
                        .to_string_lossy()
                        .starts_with("bindings.json.bak-")
                }));
        }
        assert!(runtime.terminated.lock().unwrap().is_empty());
    }

    #[test]
    fn grok_runtime_sweep_removes_only_unreferenced_entries_nothing_listens_on() {
        use std::os::unix::net::UnixListener;
        let temp = tempfile::tempdir().unwrap();
        let run = temp.path().join("run");
        fs::DirBuilder::new().mode(0o700).create(&run).unwrap();
        let id = |seed: char| seed.to_string().repeat(24);
        let path = |name: String| run.join(name);

        // Stale: the leader is gone and its socket refuses connections.
        let stale_socket = path(format!("grok-{}.sock", id('a')));
        drop(UnixListener::bind(&stale_socket).unwrap());
        let stale_locks = [
            path(format!("grok-{}.lock", id('a'))),
            path(format!("grok-{}.sock.lock", id('a'))),
        ];
        // Stale: only the lock is left.
        let orphan_lock = path(format!("grok-{}.lock", id('b')));
        // Live: something still listens on the socket.
        let live_socket = path(format!("grok-{}.sock", id('c')));
        let _listener = UnixListener::bind(&live_socket).unwrap();
        let live_lock = path(format!("grok-{}.lock", id('c')));
        // Kept by a record whose leader is not known to be gone.
        let recorded_lock = path(format!("grok-{}.lock", id('d')));
        // Not a probe-created Grok runtime entry.
        let unrelated = [
            path("grok-short.lock".into()),
            path(format!("grok-{}.lock", "E".repeat(24))),
            path("bindings.lock".into()),
        ];
        for file in stale_locks
            .iter()
            .chain([&orphan_lock, &live_lock, &recorded_lock])
            .chain(&unrelated)
        {
            fs::write(file, b"").unwrap();
        }
        let keep = HashSet::from([id('d')]);

        // Everything is younger than the cutoff: a launch may be in progress.
        sweep_grok_runtime_dir(&run, &keep, SystemTime::now() - Duration::from_secs(3600));
        assert!(stale_socket.exists() && orphan_lock.exists());

        sweep_grok_runtime_dir(&run, &keep, SystemTime::now() + Duration::from_secs(1));
        for gone in stale_locks.iter().chain([&stale_socket, &orphan_lock]) {
            assert!(fs::symlink_metadata(gone).is_err(), "{}", gone.display());
        }
        for kept in [&live_socket, &live_lock, &recorded_lock]
            .into_iter()
            .chain(&unrelated)
        {
            assert!(fs::symlink_metadata(kept).is_ok(), "{}", kept.display());
        }
    }

    #[test]
    fn grok_relaunch_sweeps_the_socket_of_the_leader_that_is_gone() {
        use std::os::unix::net::UnixListener;
        // A short root keeps the socket path within `sun_path`.
        let temp = tempfile::tempdir_in("/tmp").unwrap();
        let root = temp.path().join("registry");
        let run = root.join("run");
        let leader = |seed: char, pid: i32| {
            let mut bound = grok_binding(temp.path());
            let ManagedBinding::Grok(binding) = &mut bound else {
                unreachable!()
            };
            binding.socket_path = run.join(format!("grok-{}.sock", seed.to_string().repeat(24)));
            binding.leader_pid = pid;
            bound
        };
        let (first, second) = (leader('e', 43), leader('f', 44));
        let runtime = Arc::new(RelaunchRuntime {
            launches: Mutex::new(VecDeque::from([first, second.clone()])),
            live: Mutex::new(None),
        });
        let manager = ManagedSessions::new(
            root.clone(),
            HashSet::from([SessionKind::Grok]),
            runtime.clone(),
        );
        manager.launch(grok_launch(temp.path())).unwrap();
        let socket = run.join(format!("grok-{}.sock", "e".repeat(24)));
        drop(UnixListener::bind(&socket).unwrap());
        let lock = run.join(format!("grok-{}.lock", "e".repeat(24)));
        fs::write(&lock, b"").unwrap();
        // Age both entries past the in-progress bound.
        let old = libc::timeval {
            tv_sec: 1,
            tv_usec: 0,
        };
        for entry in [&socket, &lock] {
            let path = std::ffi::CString::new(entry.as_os_str().as_bytes()).unwrap();
            assert_eq!(
                unsafe { libc::utimes(path.as_ptr(), [old, old].as_ptr()) },
                0
            );
        }

        // While the recorded leader may be alive, its entries stay.
        manager.sweep_grok_runtime(&manager.read_records().unwrap());
        assert!(socket.exists() && lock.exists());

        *runtime.live.lock().unwrap() = None;
        let relaunched = manager.launch(grok_launch(temp.path())).unwrap();
        assert_eq!(manager.binding(&relaunched.target), Some(second));
        assert!(fs::symlink_metadata(&socket).is_err());
        assert!(fs::symlink_metadata(&lock).is_err());
    }

    #[test]
    fn dead_provider_record_is_replaced_by_a_verified_relaunch() {
        let temp = tempfile::tempdir().unwrap();
        let first = binding(temp.path());
        let mut second = first.clone();
        let ManagedBinding::OpenCode(second_binding) = &mut second else {
            unreachable!()
        };
        second_binding.server_pid = 43;
        second_binding.server_start = 100;
        second_binding.endpoint = "http://127.0.0.1:4041".into();
        let runtime = Arc::new(RelaunchRuntime {
            launches: Mutex::new(VecDeque::from([first.clone(), second.clone()])),
            live: Mutex::new(None),
        });
        let manager = ManagedSessions::new(
            temp.path().join("registry"),
            HashSet::from([SessionKind::OpenCode]),
            runtime.clone(),
        );
        let request = launch(temp.path());
        manager.launch(request.clone()).unwrap();
        assert_eq!(
            manager.launch(request.clone()).unwrap_err(),
            "This provider session already has an immutable managed binding."
        );

        *runtime.live.lock().unwrap() = None;
        assert!(manager.sessions().is_empty());
        let mut changed_authority = request.clone();
        changed_authority.authority.workspace_id = "rw_other".into();
        changed_authority.authority.owner_id = "other-user".into();
        assert_eq!(
            manager.launch(changed_authority).unwrap_err(),
            "This provider session belongs to a different managed authority."
        );
        let relaunched = manager.launch(request).unwrap();
        assert_eq!(relaunched.target.id, "ses_exact");
        assert_eq!(manager.binding(&relaunched.target), Some(second));
        assert_eq!(manager.sessions(), vec![relaunched]);
    }

    #[test]
    fn binding_tamper_and_owner_mismatch_never_reach_picker_or_injector() {
        let temp = tempfile::tempdir().unwrap();
        let runtime = FakeRuntime::live(binding(temp.path()));
        let root = temp.path().join("registry");
        let manager = ManagedSessions::new(
            root.clone(),
            HashSet::from([SessionKind::OpenCode]),
            runtime,
        );
        manager.launch(launch(temp.path())).unwrap();
        let path = root.join(REGISTRY_FILE);
        let mut registry: Registry = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        let ManagedBinding::OpenCode(binding) = &mut registry.records[0].record.binding else {
            panic!("expected OpenCode binding")
        };
        binding.owner_id = "attacker".into();
        // Even recomputing the unkeyed disk checksum cannot forge the live
        // process-marker reference or provider readback.
        registry.records[0].digest = digest(&registry.records[0].record).unwrap();
        fs::write(&path, serde_json::to_vec(&registry).unwrap()).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let target = Target::new(SessionKind::OpenCode, "ses_exact");
        assert!(manager.sessions().is_empty());
        assert!(manager.binding(&target).is_none());
        assert!(manager.authority(&target).is_none());
    }

    #[test]
    fn launched_binding_must_match_requested_workspace_owner_and_uid() {
        let temp = tempfile::tempdir().unwrap();
        let runtime = FakeRuntime::live(binding(temp.path()));
        let manager = ManagedSessions::new(
            temp.path().join("registry"),
            HashSet::from([SessionKind::OpenCode]),
            runtime,
        );
        let mut request = launch(temp.path());
        request.authority.owner_id = "different-owner".into();
        assert_eq!(
            manager.launch(request).unwrap_err(),
            "The provider endpoint could not be verified."
        );
        assert!(manager.sessions().is_empty());
    }
}
