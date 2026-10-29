//! Existing Pi sessions through the bundled hot-loadable extension. No terminal
//! input, Pi upgrade, second Pi process, or upstream patch is needed. A private
//! per-runtime inbox is live only while the Pi process holds its registry open.
use crate::platform::fs as private_fs;
use crate::relay::delivery::policy::MessageRef;
use crate::relay::inject::InjectOutcome;
use crate::relay::process::ProcessTable;
use crate::relay::sessions::DiscoveredSession;
use crate::relay::store::{is_uuid, SessionKind, Target};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::Read;
use std::path::{Path, PathBuf};

mod inbox;
mod native_choice;
pub(crate) mod setup;
use inbox::{atomic_write_guarded, delivery_lock};

const MAX_RECORD: u64 = 1024 * 1024;
const SOURCE: &str = include_str!("pi/agent-relay.mjs");
/// The first line of our extension, telling it from a person's file.
const EXTENSION_MARK: &str = "// AGENT_RELAY_PI_EXTENSION=";

#[derive(Clone, Debug)]
pub struct PiConfig {
    pub agent_dir: PathBuf,
    pub runtime: PathBuf,
    pub enabled: bool,
}

impl PiConfig {
    pub fn from_env(env: &dyn Fn(&str) -> Option<String>, home: &Path) -> Self {
        Self {
            agent_dir: env("PI_CODING_AGENT_DIR")
                .map(PathBuf::from)
                .filter(|path| path.is_absolute())
                .unwrap_or_else(|| home.join(".pi/agent")),
            runtime: home.join(".agentworkforce/desktop/pi"),
            // The extension checks file owners with `process.getuid`, which
            // Node does not have on Windows, so Pi sessions are off there.
            enabled: !cfg!(windows) && env("AGENT_RELAY_ENABLE_PI").as_deref() != Some("0"),
        }
    }

    pub fn extension_source(&self) -> String {
        let runtime = serde_json::Value::String(self.runtime.to_string_lossy().into_owned());
        SOURCE.replace("__RUNTIME__", &runtime.to_string())
    }

    /// Whether Pi has run here (its agent folder exists) and Pi sessions
    /// are on: where the extension can go.
    pub fn installed(&self) -> bool {
        self.enabled && self.agent_dir.is_dir()
    }

    /// Where the extension goes in Pi's global extensions.
    pub fn extension_file(&self) -> PathBuf {
        self.agent_dir.join("extensions/agent-relay.js")
    }

    /// The marker turning the extension off leaves, in the core's own data
    /// beside the Pi runtime rather than in Pi's folder.
    pub fn off_marker(&self) -> PathBuf {
        self.runtime.with_file_name("pi-extension.off")
    }

    /// Whether `pi_extension` was turned off: Pi sessions are then neither
    /// listed nor delivered to, even one that loaded the extension earlier.
    pub fn turned_off(&self) -> bool {
        self.off_marker().exists()
    }

    /// Whether our extension (not a person's file of that name) is in place.
    pub fn extension_installed(&self) -> bool {
        fs::symlink_metadata(self.extension_file()).is_ok_and(|m| m.is_file())
            && fs::read_to_string(self.extension_file())
                .is_ok_and(|text| text.starts_with(EXTENSION_MARK))
    }

    /// Removes our extension; a person's file at that name, or none, is left.
    pub fn remove(&self) -> Result<(), String> {
        if !self.extension_installed() {
            return Ok(());
        }
        fs::remove_file(self.extension_file())
            .map_err(|e| format!("Could not remove the Pi extension: {e}"))
    }

    /// Preserve a person's extension at this name. Refresh only our own copy.
    pub fn install(&self) -> Result<(), String> {
        if !self.installed() {
            return Ok(());
        }
        let path = self.extension_file();
        if let Ok(metadata) = fs::symlink_metadata(&path) {
            if !metadata.is_file()
                || !fs::read_to_string(&path)
                    .unwrap_or_default()
                    .starts_with(EXTENSION_MARK)
            {
                return Err("A different Pi extension already uses agent-relay.js.".into());
            }
        }
        let source = self.extension_source();
        if fs::read_to_string(&path).ok().as_deref() == Some(&source) {
            return Ok(());
        }
        let parent = path
            .parent()
            .ok_or("Pi extension has no parent directory.")?;
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        atomic_write(&path, source.as_bytes()).map_err(|e| e.to_string())
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Registry {
    version: u32,
    pid: i32,
    session_id: String,
    instance: String,
    cwd: String,
    title: String,
    #[serde(default)]
    title_editing: bool,
    #[serde(default)]
    native_continuation: u32,
}

#[derive(Clone, Debug)]
pub struct Binding {
    registry: Registry,
    pub directory: PathBuf,
    pub reference: String,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn key(id: &str) -> String {
    hex(&Sha256::digest(id.as_bytes()))
}
fn nonce(text: &str) -> bool {
    text.len() == 32 && text.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Whether `uid` owns the file and no one else may read or write it.
#[cfg(unix)]
fn owner_only(m: &fs::Metadata, uid: u32) -> bool {
    use std::os::unix::fs::MetadataExt;
    m.uid() == uid && m.mode() & 0o077 == 0
}

/// Windows keeps no owner uid or mode bits; profile files are private by
/// their inherited access list (see `platform::fs`).
#[cfg(windows)]
fn owner_only(_m: &fs::Metadata, _uid: u32) -> bool {
    true
}

fn private(path: &Path, uid: u32, directory: bool) -> bool {
    fs::symlink_metadata(path).is_ok_and(|m| {
        owner_only(&m, uid)
            && if directory {
                m.is_dir()
            } else {
                m.is_file() && m.len() <= MAX_RECORD
            }
    })
}

fn read<T: serde::de::DeserializeOwned>(path: &Path, uid: u32) -> Option<T> {
    let file = private_fs::no_follow(OpenOptions::new().read(true))
        .open(path)
        .ok()?;
    let m = file.metadata().ok()?;
    if !m.is_file() || !owner_only(&m, uid) || m.len() > MAX_RECORD {
        return None;
    }
    serde_json::from_reader(file.take(MAX_RECORD + 1)).ok()
}

fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    atomic_write_guarded(path, bytes, &|| true).map(|_| ())
}

pub fn bindings(config: &PiConfig, table: &dyn ProcessTable, uid: u32) -> Vec<Binding> {
    if !config.enabled || config.turned_off() || !private(&config.runtime, uid, true) {
        return vec![];
    }
    let Ok(entries) = fs::read_dir(&config.runtime) else {
        return vec![];
    };
    let mut bindings = Vec::new();
    for entry in entries.flatten() {
        let directory = entry.path();
        let instance = entry.file_name().to_string_lossy().into_owned();
        if !nonce(&instance) || !private(&directory, uid, true) {
            continue;
        }
        let path = directory.join("session.json");
        let Some(registry) = read::<Registry>(&path, uid) else {
            continue;
        };
        if registry.version != 1 || registry.instance != instance || !is_uuid(&registry.session_id)
        {
            continue;
        }
        let Some(process) = table.process(registry.pid) else {
            continue;
        };
        // libproc reports canonical /private/var paths on macOS, even when
        // Pi opened the same file through /var (or a symlinked home directory).
        let Ok(held_path) = path.canonicalize() else {
            continue;
        };
        if process.uid != uid
            || table.zombie(process.pid)
            || !table.open_files(process.pid).iter().any(|open| {
                open == &held_path || open.canonicalize().ok().as_ref() == Some(&held_path)
            })
            || table.process(process.pid) != Some(process)
        {
            continue;
        }
        bindings.push(Binding {
            reference: format!("pi:{}:{}:{}", process.pid, process.start, instance),
            registry,
            directory,
        });
    }
    // A session open in two processes has no unique recipient.
    let ids: Vec<_> = bindings
        .iter()
        .map(|b| b.registry.session_id.clone())
        .collect();
    bindings.retain(|b| {
        ids.iter()
            .filter(|id| **id == b.registry.session_id)
            .count()
            == 1
    });
    bindings
}

pub fn binding(config: &PiConfig, table: &dyn ProcessTable, uid: u32, id: &str) -> Option<Binding> {
    bindings(config, table, uid)
        .into_iter()
        .find(|b| b.registry.session_id == id)
}

/// Transport capability only; the core must separately authorize the owner's
/// direct message and opt-in. Older loaded extensions retain peer delivery.
pub fn native_continuation(
    config: &PiConfig,
    table: &dyn ProcessTable,
    uid: u32,
    registration: &crate::relay::store::Registration,
) -> bool {
    registration.target.kind == SessionKind::Pi
        && binding(config, table, uid, &registration.target.id).is_some_and(|binding| {
            binding.registry.native_continuation == 1
                && registration.route_binding.as_deref() == Some(&binding.reference)
        })
}

/// Read-only mode evidence; loss of live capability cannot turn a reserved
/// owner delivery into a peer message. Corrupt evidence stays fail-closed.
pub fn has_native_choice(
    config: &PiConfig,
    uid: u32,
    registration: &crate::relay::store::Registration,
    message_id: &str,
) -> bool {
    native_choice::exists(config, uid, registration, message_id)
}

pub fn discover(config: &PiConfig, table: &dyn ProcessTable, uid: u32) -> Vec<DiscoveredSession> {
    bindings(config, table, uid)
        .into_iter()
        .map(|b| DiscoveredSession {
            target: Target::new(SessionKind::Pi, b.registry.session_id.clone()),
            title: read::<serde_json::Value>(&b.directory.join("title-state.json"), uid)
                .filter(|v| v["sessionId"].as_str() == Some(b.registry.session_id.as_str()))
                .and_then(|v| v["title"].as_str().map(str::to_owned))
                .unwrap_or(b.registry.title),
            directory: Some(b.registry.cwd),
            live: true,
            holder: None,
            host: None,
            updated_at_ms: None,
        })
        .collect()
}

/// Only a loaded extension that advertises the native metadata API can rename.
pub fn can_set_title(config: &PiConfig, table: &dyn ProcessTable, uid: u32, id: &str) -> bool {
    binding(config, table, uid, id).is_some_and(|b| b.registry.title_editing)
}

pub fn set_title(config: &PiConfig, table: &dyn ProcessTable, uid: u32, id: &str, title: &str) -> Result<String, String> {
    let bound = binding(config, table, uid, id).filter(|b| b.registry.title_editing)
        .ok_or("Reload the Agent Relay extension in this Pi session to edit its title.")?;
    let request_id = crate::relay::store::random_hex(16);
    let path = bound.directory.join(format!("title-{request_id}.json"));
    let expires = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "The system clock is unavailable.")?.as_millis() as u64 + 4_000;
    let record = serde_json::json!({"version":1,"sessionId":id,"requestId":request_id,
        "title":title,"state":"pending","expiresAt":expires});
    atomic_write(&path, record.to_string().as_bytes()).map_err(|_| "Could not send the title to Pi.")?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let result = loop {
        let Some(current) = binding(config, table, uid, id) else {
            break Err("The Pi session closed before confirming the title.".into());
        };
        if current.reference != bound.reference {
            break Err("The Pi session changed before confirming the title.".into());
        }
        if let Some(reply) = read::<serde_json::Value>(&path, uid) {
            if reply["sessionId"] == id && reply["requestId"] == request_id {
                if reply["state"] == "done" {
                    break reply["title"].as_str().filter(|s| !s.trim().is_empty())
                        .map(str::to_owned).ok_or_else(|| "Pi returned an empty title.".into());
                }
                if reply["state"] == "failed" { break Err("Pi could not save the title.".into()); }
            }
        }
        if std::time::Instant::now() >= deadline { break Err("Pi did not confirm the title. Reload its Agent Relay extension and try again.".into()); }
        std::thread::sleep(std::time::Duration::from_millis(50));
    };
    let _ = fs::remove_file(path);
    result
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Delivery {
    version: u32,
    session_id: String,
    message_id: String,
    text: String,
    state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sequence: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    answer: Option<String>,
}

// Version 2 is owner-native input. Version 1 stays the peer contract, so an
// older extension ignores new native records instead of misinterpreting them.
fn delivery_version(native: bool) -> u32 {
    if native {
        2
    } else {
        1
    }
}

// Reserve durably before publishing a pending record. Gaps after a failed write
// are harmless; retries of an existing message never allocate another sequence.
fn next_sequence(directory: &Path, uid: u32) -> Option<u64> {
    let path = directory.join("sequence.json");
    let previous = match fs::symlink_metadata(&path) {
        Ok(_) => read::<u64>(&path, uid)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
        Err(_) => return None,
    };
    let sequence = previous
        .checked_add(1)
        .filter(|n| *n <= 9_007_199_254_740_991)?;
    atomic_write(&path, &serde_json::to_vec(&sequence).ok()?).ok()?;
    Some(sequence)
}

fn pinned_directory(
    config: &PiConfig,
    uid: u32,
    registration: &crate::relay::store::Registration,
) -> Option<PathBuf> {
    let parts: Vec<_> = registration.route_binding.as_deref()?.split(':').collect();
    if parts.len() != 4
        || parts[0] != "pi"
        || !nonce(parts[3])
        || !parts[1].parse::<i32>().is_ok_and(|pid| pid > 0)
        || !parts[2].parse::<u64>().is_ok_and(|start| start > 0)
    {
        return None;
    }
    let directory = config.runtime.join(parts[3]);
    (config.enabled && private(&config.runtime, uid, true) && private(&directory, uid, true))
        .then_some(directory)
}

fn recorded_delivery(
    config: &PiConfig,
    uid: u32,
    registration: &crate::relay::store::Registration,
    message_id: &str,
    text: &str,
    native: bool,
) -> Option<InjectOutcome> {
    let directory = pinned_directory(config, uid, registration)?;
    let path = directory.join(format!("{}.json", key(message_id)));
    if fs::symlink_metadata(&path).is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound) {
        return None;
    }
    let valid = read::<Delivery>(&path, uid).filter(|d| {
        // An accepted handoff keeps its original text and mode across opt-in
        // or opt-out. Cross-mode retries only observe it; they never rewrite it.
        (d.version == delivery_version(native) && d.text == text
            || d.version == delivery_version(!native))
            && d.session_id == registration.target.id
            && d.message_id == message_id
    });
    match valid {
        Some(record) if record.state == "recorded" => Some(InjectOutcome::Delivered),
        Some(record)
            if (native || record.version == 2)
                && matches!(record.state.as_str(), "pending" | "claimed") =>
        {
            // The provider already owns this exact handoff. Neither loss of
            // capability nor a restarted caller may rewrite or resend it.
            Some(InjectOutcome::Accepted(
                "Waiting for Pi to record this message.".into(),
            ))
        }
        Some(record) if matches!(record.state.as_str(), "pending" | "claimed") => None,
        _ => Some(InjectOutcome::InDoubt(
            "Pi's saved delivery record could not be verified.".into(),
        )),
    }
}

/// Whether this exact message is already in the pinned session's inbox,
/// waiting for its extension (`pending` or `claimed`), in either version.
fn queued_delivery(
    config: &PiConfig,
    uid: u32,
    registration: &crate::relay::store::Registration,
    message_id: &str,
    text: &str,
) -> bool {
    let Some(directory) = pinned_directory(config, uid, registration) else {
        return false;
    };
    read::<Delivery>(&directory.join(format!("{}.json", key(message_id))), uid).is_some_and(|d| {
        d.session_id == registration.target.id
            && d.message_id == message_id
            && d.text == text
            && matches!(d.state.as_str(), "pending" | "claimed")
    })
}

pub fn send(
    config: &PiConfig,
    table: &dyn ProcessTable,
    uid: u32,
    registration: &crate::relay::store::Registration,
    message_id: &str,
    text: &str,
) -> InjectOutcome {
    send_with(config, table, uid, registration, message_id, text, None)
}

/// An authorized owner's message uses Pi's own sendUserMessage API. Its policy
/// remains unchanged. The extension adds only a neutral delivery-ID marker for
/// exact durable correlation, never peer attribution or approval instructions.
#[cfg(test)]
pub fn send_native(
    config: &PiConfig,
    table: &dyn ProcessTable,
    uid: u32,
    registration: &crate::relay::store::Registration,
    message_id: &str,
    text: &str,
) -> InjectOutcome {
    send_native_guarded(config, table, uid, registration, message_id, text, &|| true)
}

/// Recheck authority immediately before publishing new owner input. Previously
/// accepted receipts remain observable without granting a new submission.
pub fn send_native_guarded(
    config: &PiConfig,
    table: &dyn ProcessTable,
    uid: u32,
    registration: &crate::relay::store::Registration,
    message_id: &str,
    text: &str,
    admit: &(dyn Fn() -> bool + Send + Sync),
) -> InjectOutcome {
    let guard = Some(admit);
    send_with(config, table, uid, registration, message_id, text, guard)
}

fn send_with(
    config: &PiConfig,
    table: &dyn ProcessTable,
    uid: u32,
    registration: &crate::relay::store::Registration,
    message_id: &str,
    text: &str,
    admit: Option<&(dyn Fn() -> bool + Send + Sync)>,
) -> InjectOutcome {
    let native = admit.is_some();
    // Settlement must survive Pi exiting or switching runtimes after receipt.
    // Only new submissions need a live process with the exact pinned identity.
    if let Some(outcome) = recorded_delivery(config, uid, registration, message_id, text, native) {
        return outcome;
    }
    // Turned off: nothing new reaches Pi, even a session still running the
    // extension it loaded before. A recorded receipt above still settles.
    if config.turned_off() {
        // A message already queued stays the loaded extension's to deliver;
        // only a new one is refused.
        if queued_delivery(config, uid, registration, message_id, text) {
            return InjectOutcome::Accepted("Waiting for Pi to record this message.".into());
        }
        return InjectOutcome::Refused(
            "Pi sessions are off: Agent Relay's Pi extension was turned off (pi_extension).".into(),
        );
    }
    if native {
        if let Err(outcome) = native_choice::reserve(config, uid, registration, message_id, text) {
            return outcome;
        }
    }
    let Some(binding) = binding(config, table, uid, &registration.target.id) else {
        return InjectOutcome::Waiting(
            "Pi is not connected. Run /reload in the Pi session.".into(),
        );
    };
    if registration.route_binding.as_deref() != Some(&binding.reference) {
        return InjectOutcome::Refused(
            "The Pi session binding changed; turn this agent off, then add the session again."
                .into(),
        );
    }
    if native && binding.registry.native_continuation != 1 {
        return InjectOutcome::Refused(
            "Reload Pi's Agent Relay extension to enable native owner messages.".into(),
        );
    }
    let path = binding.directory.join(format!("{}.json", key(message_id)));
    let result = (|| -> Option<InjectOutcome> {
        let _lock = delivery_lock(&binding.directory).ok()?;
        if let Err(outcome) = native_choice::check(
            &binding.directory,
            uid,
            registration,
            message_id,
            text,
            native,
        ) {
            return Some(outcome);
        }
        if fs::symlink_metadata(&path).is_ok() {
            let record: Delivery = read(&path, uid)?;
            if record.version != delivery_version(native)
                || record.session_id != registration.target.id
                || record.message_id != message_id
                || record.text != text
            {
                return None;
            }
            return Some(match record.state.as_str() {
                "recorded" => InjectOutcome::Delivered,
                "pending" | "claimed" => {
                    InjectOutcome::Accepted("Waiting for Pi to record this message.".into())
                }
                _ => InjectOutcome::InDoubt("Pi's delivery record is unreadable.".into()),
            });
        }
        let record = Delivery {
            version: delivery_version(native),
            session_id: registration.target.id.clone(),
            message_id: message_id.into(),
            text: text.into(),
            state: "pending".into(),
            sequence: Some(next_sequence(&binding.directory, uid)?),
            answer: None,
        };
        let bytes = serde_json::to_vec(&record).ok()?;
        if bytes.len() as u64 > MAX_RECORD / 2 {
            return Some(InjectOutcome::Refused(
                "This message is too large for Pi's inbox.".into(),
            ));
        }
        let published =
            atomic_write_guarded(&path, &bytes, &|| admit.is_none_or(|admit| admit())).ok()?;
        if !published {
            return Some(InjectOutcome::Refused(
                "Pi owner authorization changed.".into(),
            ));
        }
        Some(InjectOutcome::Accepted("Waiting for Pi to be idle.".into()))
    })();
    result.unwrap_or_else(|| {
        InjectOutcome::InDoubt(
            "Pi's delivery inbox is unavailable; this message will not be resent.".into(),
        )
    })
}

/// Read receipts even after Pi exits, but only from this registration's pinned runtime.
pub fn final_answer(
    config: &PiConfig,
    uid: u32,
    registration: &crate::relay::store::Registration,
    reference: &str,
) -> Option<String> {
    let directory = pinned_directory(config, uid, registration)?;
    let records: Vec<Delivery> = fs::read_dir(directory)
        .ok()?
        .flatten()
        .filter(|e| {
            e.file_name().to_string_lossy().ends_with(".json") && e.file_name() != "session.json"
        })
        .filter_map(|e| read(&e.path(), uid))
        .filter(|d: &Delivery| {
            matches!(d.version, 1 | 2)
                && d.session_id == registration.target.id
                && d.state == "recorded"
                && MessageRef::of(&d.message_id) == reference
        })
        .collect();
    if records.len() != 1 {
        return None;
    }
    records.into_iter().next()?.answer
}

// The tests set Unix modes and links; Pi is off on Windows (`PiConfig`).
#[cfg(test)]
#[cfg(unix)]
mod tests {
    use super::*;
    use crate::relay::peer::current_uid;
    use crate::relay::process::SystemProcesses;
    use std::fs::File;
    use std::io::Write;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

    const ID: &str = "12345678-1234-4234-8234-123456789abc";

    fn fixture() -> (
        tempfile::TempDir,
        PiConfig,
        File,
        crate::relay::store::Registration,
    ) {
        let temp = tempfile::tempdir().unwrap();
        // As the desktop lays it out, so the off marker beside the runtime
        // stays inside this test's directory.
        let runtime = temp.path().join("desktop/pi");
        fs::create_dir_all(&runtime).unwrap();
        fs::set_permissions(&runtime, fs::Permissions::from_mode(0o700)).unwrap();
        let config = PiConfig {
            runtime,
            agent_dir: temp.path().join("agent"),
            enabled: true,
        };
        let instance = "123456789012345678901234567890ab";
        let dir = config.runtime.join(instance);
        fs::create_dir(&dir).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
        let path = dir.join("session.json");
        let mut held = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
            .unwrap();
        let value = serde_json::json!({"version":1,"pid":std::process::id(),"sessionId":ID,
            "instance":instance,"cwd":"/project","title":"Pi task"});
        held.write_all(value.to_string().as_bytes()).unwrap();
        let binding = binding(&config, &SystemProcesses::default(), current_uid(), ID).unwrap();
        let registration =
            serde_json::from_value(serde_json::json!({"name":"pi-test","agentID":"a-1",
            "target":{"kind":"pi","id":ID},"baseURL":"https://cast.agentrelay.com",
            "registeredAt":"2026-10-20T00:00:00Z","routeBinding":binding.reference}))
            .unwrap();
        (temp, config, held, registration)
    }

    #[test]
    fn a_bound_session_gets_nothing_once_the_extension_is_turned_off() {
        let (temp, config, _held, registration) = fixture();
        let table = SystemProcesses::default();
        assert_eq!(discover(&config, &table, current_uid()).len(), 1);
        fs::write(config.off_marker(), "off").unwrap();
        assert!(config.off_marker().starts_with(temp.path()));
        // Still running the extension it loaded, but no longer a target.
        assert!(bindings(&config, &table, current_uid()).is_empty());
        assert!(discover(&config, &table, current_uid()).is_empty());
        let outcome = send(
            &config,
            &table,
            current_uid(),
            &registration,
            "m-off",
            "hello",
        );
        assert!(matches!(outcome, InjectOutcome::Refused(_)), "{outcome:?}");
        let instance = config.runtime.join("123456789012345678901234567890ab");
        let written: Vec<_> = fs::read_dir(instance)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name())
            .filter(|name| name != "session.json")
            .collect();
        assert!(written.is_empty(), "{written:?}");
        // Turned on again, the same session is a target again.
        fs::remove_file(config.off_marker()).unwrap();
        assert_eq!(discover(&config, &table, current_uid()).len(), 1);
    }

    #[test]
    fn a_message_queued_before_the_extension_is_turned_off_stays_accepted() {
        let (_temp, config, _held, registration) = fixture();
        let table = SystemProcesses::default();
        let uid = current_uid();
        let queued = send(&config, &table, uid, &registration, "m-1", "hello");
        assert!(matches!(queued, InjectOutcome::Accepted(_)), "{queued:?}");
        fs::write(config.off_marker(), "off").unwrap();
        let instance = config.runtime.join("123456789012345678901234567890ab");
        let files = || {
            let mut names: Vec<_> = fs::read_dir(&instance)
                .unwrap()
                .flatten()
                .map(|entry| entry.file_name())
                .collect();
            names.sort();
            names
        };
        let before = files();
        // The loaded extension can still deliver the queued version-1 record.
        let retry = send(&config, &table, uid, &registration, "m-1", "hello");
        assert!(matches!(retry, InjectOutcome::Accepted(_)), "{retry:?}");
        let new = send(&config, &table, uid, &registration, "m-2", "hello");
        assert!(matches!(new, InjectOutcome::Refused(_)), "{new:?}");
        assert_eq!(files(), before);
    }

    #[test]
    fn discovery_requires_the_live_holder_and_private_registry() {
        let (_temp, config, held, _) = fixture();
        let table = SystemProcesses::default();
        let rows = discover(&config, &table, current_uid());
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].target, Target::new(SessionKind::Pi, ID));
        assert!(rows[0].target.is_valid());
        assert!(discover(&config, &table, current_uid().wrapping_add(1)).is_empty());
        fs::set_permissions(&config.runtime, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(discover(&config, &table, current_uid()).is_empty());
        fs::set_permissions(&config.runtime, fs::Permissions::from_mode(0o700)).unwrap();
        drop(held);
        assert!(discover(&config, &table, current_uid()).is_empty());
    }

    #[test]
    fn two_live_runtimes_cannot_claim_the_same_session() {
        let (_temp, config, _held, _) = fixture();
        let table = SystemProcesses::default();
        let first = binding(&config, &table, current_uid(), ID).unwrap();
        let instance = "abcdef12345678901234567890123456";
        let directory = config.runtime.join(instance);
        fs::create_dir(&directory).unwrap();
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
        let mut registry: serde_json::Value =
            read(&first.directory.join("session.json"), current_uid()).unwrap();
        registry["instance"] = instance.into();
        let path = directory.join("session.json");
        atomic_write(&path, &serde_json::to_vec(&registry).unwrap()).unwrap();
        let held = File::open(&path).unwrap();
        assert!(discover(&config, &table, current_uid()).is_empty());
        drop(held);
        assert_eq!(discover(&config, &table, current_uid()).len(), 1);
    }

    #[test]
    fn delivery_is_durable_deduplicated_and_acknowledged_only_after_history() {
        let (_temp, config, held, registration) = fixture();
        let table = SystemProcesses::default();
        let deliver = || {
            send(
                &config,
                &table,
                current_uid(),
                &registration,
                "m-1",
                "Hello",
            )
        };
        assert!(matches!(deliver(), InjectOutcome::Accepted(_)));
        let binding = binding(&config, &table, current_uid(), ID).unwrap();
        let path = binding.directory.join(format!("{}.json", key("m-1")));
        let mut record: Delivery = read(&path, current_uid()).unwrap();
        record.state = "claimed".into();
        atomic_write(&path, &serde_json::to_vec(&record).unwrap()).unwrap();
        assert!(matches!(deliver(), InjectOutcome::Accepted(_)));
        assert_eq!(
            read::<Delivery>(&path, current_uid()).unwrap().state,
            "claimed"
        );
        record.state = "recorded".into();
        record.answer = Some("Done.".into());
        atomic_write(&path, &serde_json::to_vec(&record).unwrap()).unwrap();
        assert_eq!(deliver(), InjectOutcome::Delivered);
        drop(held);
        assert_eq!(
            deliver(),
            InjectOutcome::Delivered,
            "a recorded receipt settles after the holder exits"
        );
        assert_eq!(
            final_answer(
                &config,
                current_uid(),
                &registration,
                &MessageRef::of("m-1")
            ),
            Some("Done.".into())
        );
        assert!(matches!(
            send(
                &config,
                &table,
                current_uid(),
                &registration,
                "m-1",
                "Changed"
            ),
            InjectOutcome::InDoubt(_)
        ));
    }

    #[test]
    fn arrival_sequences_are_durable_and_retries_do_not_move_a_message() {
        let (_temp, config, _held, registration) = fixture();
        let table = SystemProcesses::default();
        let directory = binding(&config, &table, current_uid(), ID)
            .unwrap()
            .directory;
        for id in ["m-1", "m-2", "m-1"] {
            assert!(matches!(
                send(&config, &table, current_uid(), &registration, id, "Hi"),
                InjectOutcome::Accepted(_)
            ));
        }
        for (id, sequence) in [("m-1", 1), ("m-2", 2)] {
            let record: Delivery =
                read(&directory.join(format!("{}.json", key(id))), current_uid()).unwrap();
            assert_eq!(record.sequence, Some(sequence));
        }
        assert_eq!(
            read::<u64>(&directory.join("sequence.json"), current_uid()),
            Some(2)
        );
        atomic_write(&directory.join("sequence.json"), b"broken").unwrap();
        assert!(matches!(
            send(&config, &table, current_uid(), &registration, "m-3", "Hi"),
            InjectOutcome::InDoubt(_)
        ));
        assert!(!directory.join(format!("{}.json", key("m-3"))).exists());
        // Counter corruption never prevents settlement of an existing record.
        assert!(matches!(
            send(&config, &table, current_uid(), &registration, "m-1", "Hi"),
            InjectOutcome::Accepted(_)
        ));
    }

    #[test]
    fn changed_bindings_corrupt_records_and_symlinks_fail_closed() {
        let (_temp, config, _held, mut registration) = fixture();
        let table = SystemProcesses::default();
        let original = registration.route_binding.take();
        assert!(matches!(
            send(&config, &table, current_uid(), &registration, "m", "Hi"),
            InjectOutcome::Refused(_)
        ));
        registration.route_binding = original;
        let binding = binding(&config, &table, current_uid(), ID).unwrap();
        let path = binding.directory.join(format!("{}.json", key("m")));
        atomic_write(&path, b"broken").unwrap();
        assert!(matches!(
            send(&config, &table, current_uid(), &registration, "m", "Hi"),
            InjectOutcome::InDoubt(_)
        ));
        fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(binding.directory.join("session.json"), &path).unwrap();
        assert!(matches!(
            send(&config, &table, current_uid(), &registration, "m", "Hi"),
            InjectOutcome::InDoubt(_)
        ));
    }

    #[test]
    fn installing_preserves_unrelated_extensions_and_respects_opt_out() {
        let temp = tempfile::tempdir().unwrap();
        let mut config = PiConfig::from_env(&|_| None, temp.path());
        fs::create_dir_all(config.agent_dir.join("extensions")).unwrap();
        let path = config.agent_dir.join("extensions/agent-relay.js");
        fs::write(&path, "// personal extension").unwrap();
        assert!(config.install().is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "// personal extension");
        fs::remove_file(&path).unwrap();
        config.install().unwrap();
        assert!(!fs::read_to_string(&path).unwrap().contains("__RUNTIME__"));
        config.enabled = false;
        fs::remove_file(&path).unwrap();
        config.install().unwrap();
        assert!(!path.exists());
    }

    fn advertise_native(config: &PiConfig, version: u32) -> PathBuf {
        let binding = binding(config, &SystemProcesses::default(), current_uid(), ID).unwrap();
        let path = binding.directory.join("session.json");
        let mut registry: serde_json::Value = read(&path, current_uid()).unwrap();
        registry["nativeContinuation"] = version.into();
        // Keep the fixture's open inode, as a loaded extension publishes it.
        fs::write(path, registry.to_string()).unwrap();
        binding.directory
    }

    #[test]
    fn native_requires_current_capability_and_exact_pinned_runtime() {
        let (_temp, config, _held, mut registration) = fixture();
        let table = SystemProcesses::default();
        for version in [0, 2] {
            let directory = advertise_native(&config, version);
            assert!(!native_continuation(
                &config,
                &table,
                current_uid(),
                &registration
            ));
            assert!(matches!(
                send_native(
                    &config,
                    &table,
                    current_uid(),
                    &registration,
                    "native",
                    "Hello"
                ),
                InjectOutcome::Refused(_)
            ));
            assert!(!directory.join(format!("{}.json", key("native"))).exists());
        }
        advertise_native(&config, 1);
        assert!(native_continuation(
            &config,
            &table,
            current_uid(),
            &registration
        ));
        registration.route_binding = Some("pi:1:1:ffffffffffffffffffffffffffffffff".into());
        assert!(!native_continuation(
            &config,
            &table,
            current_uid(),
            &registration
        ));
        assert!(matches!(
            send_native(
                &config,
                &table,
                current_uid(),
                &registration,
                "native",
                "Hello"
            ),
            InjectOutcome::Refused(_)
        ));
    }

    #[test]
    fn native_admission_is_rechecked_after_staging_before_publication() {
        let (_temp, config, _held, registration) = fixture();
        let table = SystemProcesses::default();
        let directory = advertise_native(&config, 1);
        let path = directory.join(format!("{}.json", key("native")));
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let admit = || {
            calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            assert!(!path.exists(), "the provider must not see unapproved input");
            assert_eq!(
                read::<u64>(&directory.join("sequence.json"), current_uid()),
                Some(1)
            );
            assert!(
                fs::read_dir(&directory)
                    .unwrap()
                    .flatten()
                    .any(|entry| { entry.path().extension().is_some_and(|ext| ext == "tmp") }),
                "authority is checked after preparing the durable temporary file"
            );
            false
        };
        assert!(matches!(
            send_native_guarded(
                &config,
                &table,
                current_uid(),
                &registration,
                "native",
                "Hello",
                &admit
            ),
            InjectOutcome::Refused(_)
        ));
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert!(!path.exists());
        // After a crash before Core settles the refusal, an opted-out retry
        // cannot reinterpret this native choice as an executable peer turn.
        let choice = directory.join(format!("{}.native-choice", key("native")));
        let saved = fs::read(&choice).unwrap();
        assert!(matches!(
            send(
                &config,
                &table,
                current_uid(),
                &registration,
                "native",
                "Hello"
            ),
            InjectOutcome::InDoubt(_)
        ));
        assert_eq!(fs::read(&choice).unwrap(), saved);
        assert!(!path.exists());
        assert!(
            !fs::read_dir(&directory)
                .unwrap()
                .flatten()
                .any(|entry| { entry.path().extension().is_some_and(|ext| ext == "tmp") }),
            "refused input leaves no unpublished payload behind"
        );
    }

    #[test]
    fn reserved_native_choice_remains_visible_without_a_live_runtime() {
        let (_temp, config, held, registration) = fixture();
        let table = SystemProcesses::default();
        let directory = advertise_native(&config, 1);
        assert!(!has_native_choice(
            &config,
            current_uid(),
            &registration,
            "missing"
        ));
        assert!(matches!(
            send(&config, &table, current_uid(), &registration, "peer", "Hi"),
            InjectOutcome::Accepted(_)
        ));
        assert!(!has_native_choice(
            &config,
            current_uid(),
            &registration,
            "peer"
        ));
        assert!(matches!(
            send_native(
                &config,
                &table,
                current_uid(),
                &registration,
                "native",
                "Hi"
            ),
            InjectOutcome::Accepted(_)
        ));
        let choice = directory.join(format!("{}.native-choice", key("native")));
        let receipt = directory.join(format!("{}.json", key("native")));
        advertise_native(&config, 0);
        drop(held);
        let bytes = fs::read(&receipt).unwrap();
        assert!(has_native_choice(
            &config,
            current_uid(),
            &registration,
            "native"
        ));
        assert_eq!(fs::read(&receipt).unwrap(), bytes);
        atomic_write(&choice, b"corrupt").unwrap();
        assert!(has_native_choice(
            &config,
            current_uid(),
            &registration,
            "native"
        ));
        fs::remove_file(&choice).unwrap();
        fs::create_dir(&choice).unwrap();
        assert!(has_native_choice(
            &config,
            current_uid(),
            &registration,
            "native"
        ));
        fs::remove_dir(&choice).unwrap();
        assert!(
            has_native_choice(&config, current_uid(), &registration, "native"),
            "legacy v2 receipt without sidecar remains native"
        );
        atomic_write(&receipt, b"unreadable receipt").unwrap();
        assert!(has_native_choice(
            &config,
            current_uid(),
            &registration,
            "native"
        ));
        let mut unknown = registration.clone();
        unknown.route_binding = None;
        assert!(!has_native_choice(
            &config,
            current_uid(),
            &unknown,
            "native"
        ));
    }

    #[test]
    fn native_choice_survives_unavailable_capability_or_runtime_before_admission() {
        for live in [false, true] {
            let (_temp, config, held, registration) = fixture();
            let table = SystemProcesses::default();
            let directory = advertise_native(&config, if live { 0 } else { 1 });
            let held = if live {
                Some(held)
            } else {
                drop(held);
                None
            };
            let result = send_native(
                &config,
                &table,
                current_uid(),
                &registration,
                "native",
                "Hello",
            );
            assert!(matches!(
                result,
                InjectOutcome::Waiting(_) | InjectOutcome::Refused(_)
            ));
            let choice = directory.join(format!("{}.native-choice", key("native")));
            let saved = fs::read(&choice).unwrap();
            assert!(!directory.join(format!("{}.json", key("native"))).exists());
            // Restore the runtime so an ordinary peer retry would otherwise
            // be eligible; the durable native choice must still prevent it.
            let _reopened = File::open(directory.join("session.json")).unwrap();
            assert!(matches!(
                send(
                    &config,
                    &table,
                    current_uid(),
                    &registration,
                    "native",
                    "Hello"
                ),
                InjectOutcome::InDoubt(_)
            ));
            assert!(matches!(
                send_native(
                    &config,
                    &table,
                    current_uid(),
                    &registration,
                    "native",
                    "Changed"
                ),
                InjectOutcome::InDoubt(_)
            ));
            assert_eq!(fs::read(&choice).unwrap(), saved);
            assert!(!directory.join(format!("{}.json", key("native"))).exists());
            drop(held);
        }
    }

    #[test]
    fn revoked_native_admission_still_observes_existing_receipts_without_replay() {
        let (_temp, config, held, registration) = fixture();
        let table = SystemProcesses::default();
        let directory = advertise_native(&config, 1);
        let path = directory.join(format!("{}.json", key("native")));
        assert!(matches!(
            send_native(
                &config,
                &table,
                current_uid(),
                &registration,
                "native",
                "Hello"
            ),
            InjectOutcome::Accepted(_)
        ));
        let mut record: Delivery = read(&path, current_uid()).unwrap();
        advertise_native(&config, 0);
        drop(held);
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let revoked = || {
            calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            false
        };
        for state in ["pending", "claimed", "recorded"] {
            record.state = state.into();
            atomic_write(&path, &serde_json::to_vec(&record).unwrap()).unwrap();
            let bytes = fs::read(&path).unwrap();
            let outcome = send_native_guarded(
                &config,
                &table,
                current_uid(),
                &registration,
                "native",
                "Hello",
                &revoked,
            );
            if state == "recorded" {
                assert_eq!(outcome, InjectOutcome::Delivered);
            } else {
                assert!(matches!(outcome, InjectOutcome::Accepted(_)));
            }
            assert_eq!(fs::read(&path).unwrap(), bytes);
        }
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 0);
        assert_eq!(
            read::<u64>(&directory.join("sequence.json"), current_uid()),
            Some(1)
        );
    }

    #[test]
    fn native_receipts_survive_capability_loss_and_never_change_mode_or_payload() {
        let (_temp, config, held, registration) = fixture();
        let table = SystemProcesses::default();
        let directory = advertise_native(&config, 1);
        let path = directory.join(format!("{}.json", key("native")));
        let deliver = || {
            send_native(
                &config,
                &table,
                current_uid(),
                &registration,
                "native",
                "Hello",
            )
        };
        assert!(matches!(deliver(), InjectOutcome::Accepted(_)));
        let mut record: Delivery = read(&path, current_uid()).unwrap();
        assert_eq!(record.version, 2);
        assert_eq!(record.text, "Hello");
        assert_eq!(record.sequence, Some(1));
        for state in ["pending", "claimed"] {
            record.state = state.into();
            atomic_write(&path, &serde_json::to_vec(&record).unwrap()).unwrap();
            let bytes = fs::read(&path).unwrap();
            assert!(matches!(deliver(), InjectOutcome::Accepted(_)));
            // A peer retry observes the original native receipt. A changed
            // native payload still cannot replace this exact delivery.
            assert!(matches!(
                send(
                    &config,
                    &table,
                    current_uid(),
                    &registration,
                    "native",
                    "Hello"
                ),
                InjectOutcome::Accepted(_)
            ));
            assert!(matches!(
                send_native(
                    &config,
                    &table,
                    current_uid(),
                    &registration,
                    "native",
                    "Different"
                ),
                InjectOutcome::InDoubt(_)
            ));
            assert_eq!(fs::read(&path).unwrap(), bytes);
        }
        advertise_native(&config, 0);
        assert!(matches!(deliver(), InjectOutcome::Accepted(_)));
        drop(held);
        assert!(
            matches!(deliver(), InjectOutcome::Accepted(_)),
            "a lost live binding cannot cause uncertain input to be resent"
        );
        record.state = "recorded".into();
        record.answer = Some("Native answer".into());
        atomic_write(&path, &serde_json::to_vec(&record).unwrap()).unwrap();
        assert_eq!(deliver(), InjectOutcome::Delivered);
        assert_eq!(
            final_answer(
                &config,
                current_uid(),
                &registration,
                &MessageRef::of("native")
            ),
            Some("Native answer".into())
        );
        assert_eq!(
            read::<u64>(&directory.join("sequence.json"), current_uid()),
            Some(1)
        );
    }

    #[test]
    fn native_opt_out_observes_original_receipt_without_downgrade_or_resubmission() {
        let (_temp, config, held, registration) = fixture();
        let table = SystemProcesses::default();
        let directory = advertise_native(&config, 1);
        let message_id = "native-before-opt-out";
        let raw = "Continue the authorized work";
        let framed = format!(
            "[via Agent Relay — from @owner · ref {}]\n\n{raw}",
            MessageRef::of(message_id)
        );
        assert!(matches!(
            send_native(
                &config,
                &table,
                current_uid(),
                &registration,
                message_id,
                raw
            ),
            InjectOutcome::Accepted(_)
        ));
        let path = directory.join(format!("{}.json", key(message_id)));
        let choice = directory.join(format!("{}.native-choice", key(message_id)));
        let saved_choice = fs::read(&choice).unwrap();
        let mut record: Delivery = read(&path, current_uid()).unwrap();
        assert_eq!((record.version, record.sequence), (2, Some(1)));
        advertise_native(&config, 0);
        drop(held);
        for state in ["pending", "claimed", "recorded"] {
            record.state = state.into();
            record.answer = (state == "recorded").then(|| "Original native answer".into());
            atomic_write(&path, &serde_json::to_vec(&record).unwrap()).unwrap();
            let bytes = fs::read(&path).unwrap();
            let outcome = send(
                &config,
                &table,
                current_uid(),
                &registration,
                message_id,
                &framed,
            );
            if state == "recorded" {
                assert_eq!(outcome, InjectOutcome::Delivered);
            } else {
                assert!(
                    matches!(outcome, InjectOutcome::Accepted(_)),
                    "{state}: {outcome:?}"
                );
            }
            assert_eq!(fs::read(&path).unwrap(), bytes);
            assert_eq!(fs::read(&choice).unwrap(), saved_choice);
            assert_eq!(
                read::<u64>(&directory.join("sequence.json"), current_uid()),
                Some(1)
            );
        }
        assert_eq!(
            final_answer(
                &config,
                current_uid(),
                &registration,
                &MessageRef::of(message_id)
            ),
            Some("Original native answer".into())
        );
    }

    #[test]
    fn native_opt_in_observes_existing_peer_receipt_without_promoting_or_resending() {
        let (_temp, config, held, registration) = fixture();
        let table = SystemProcesses::default();
        let directory = advertise_native(&config, 1);
        let message_id = "peer-before-opt-in";
        let raw = "Please continue the original work";
        let framed = format!(
            "[via Agent Relay — from @owner · ref {}]\n\n{raw}\n\nReply to the original sender.",
            MessageRef::of(message_id)
        );
        assert!(matches!(
            send(
                &config,
                &table,
                current_uid(),
                &registration,
                message_id,
                &framed
            ),
            InjectOutcome::Accepted(_)
        ));
        let path = directory.join(format!("{}.json", key(message_id)));
        let sequence = fs::read(directory.join("sequence.json")).unwrap();
        let mut record: Delivery = read(&path, current_uid()).unwrap();
        // Neither a new runtime lookup nor an owner submission is needed to
        // observe a handoff already accepted by the original Pi extension.
        drop(held);
        for state in ["pending", "claimed", "recorded"] {
            record.state = state.into();
            if state == "recorded" {
                record.answer = Some("Original peer answer".into());
            }
            atomic_write(&path, &serde_json::to_vec(&record).unwrap()).unwrap();
            let before = fs::read(&path).unwrap();
            let result = send_native_guarded(
                &config,
                &table,
                current_uid(),
                &registration,
                message_id,
                raw,
                &|| panic!("observing a peer receipt must not admit a native turn"),
            );
            if state == "recorded" {
                assert_eq!(result, InjectOutcome::Delivered);
            } else {
                assert!(
                    matches!(result, InjectOutcome::Accepted(_)),
                    "{state}: {result:?}"
                );
            }
            assert_eq!(fs::read(&path).unwrap(), before);
            assert_eq!(read::<Delivery>(&path, current_uid()).unwrap().version, 1);
            assert_eq!(read::<Delivery>(&path, current_uid()).unwrap().text, framed);
            assert_eq!(fs::read(directory.join("sequence.json")).unwrap(), sequence);
            assert!(!directory
                .join(format!("{}.native-choice", key(message_id)))
                .exists());
        }
        assert_eq!(
            final_answer(
                &config,
                current_uid(),
                &registration,
                &MessageRef::of(message_id)
            ),
            Some("Original peer answer".into())
        );
    }
    #[test]
    fn native_peer_observation_rejects_wrong_scope_and_unverifiable_records() {
        let (_temp, config, _held, registration) = fixture();
        let table = SystemProcesses::default();
        let directory = advertise_native(&config, 1);
        let message_id = "original-peer";
        let framed = "[via Agent Relay] Original peer message";
        assert!(matches!(
            send(
                &config,
                &table,
                current_uid(),
                &registration,
                message_id,
                framed
            ),
            InjectOutcome::Accepted(_)
        ));
        let path = directory.join(format!("{}.json", key(message_id)));
        let original: serde_json::Value = read(&path, current_uid()).unwrap();
        assert!(matches!(
            send(
                &config,
                &table,
                current_uid(),
                &registration,
                message_id,
                "changed peer payload"
            ),
            InjectOutcome::InDoubt(_)
        ));
        for (field, value) in [
            ("sessionId", serde_json::json!("another-session")),
            ("messageId", serde_json::json!("another-message")),
            ("version", serde_json::json!(0)),
            ("version", serde_json::json!(3)),
            ("state", serde_json::json!("unknown")),
        ] {
            let mut record = original.clone();
            record[field] = value;
            let bytes = serde_json::to_vec(&record).unwrap();
            atomic_write(&path, &bytes).unwrap();
            assert!(
                matches!(
                    send_native_guarded(
                        &config,
                        &table,
                        current_uid(),
                        &registration,
                        message_id,
                        "raw owner text",
                        &|| panic!("invalid receipt must never admit input")
                    ),
                    InjectOutcome::InDoubt(_)
                ),
                "{field}"
            );
            assert_eq!(fs::read(&path).unwrap(), bytes);
        }
        atomic_write(&path, b"{").unwrap();
        assert!(matches!(
            send_native_guarded(
                &config,
                &table,
                current_uid(),
                &registration,
                message_id,
                "raw owner text",
                &|| panic!("corrupt receipt must never admit input")
            ),
            InjectOutcome::InDoubt(_)
        ));
        assert_eq!(fs::read(&path).unwrap(), b"{");
        assert!(!directory
            .join(format!("{}.native-choice", key(message_id)))
            .exists());
    }
    #[test]
    fn opt_out_cannot_observe_a_native_receipt_with_wrong_scope_or_unknown_state() {
        let (_temp, config, _held, registration) = fixture();
        let table = SystemProcesses::default();
        let directory = advertise_native(&config, 1);
        let id = "native-invalid";
        assert!(matches!(
            send_native(&config, &table, current_uid(), &registration, id, "Hello"),
            InjectOutcome::Accepted(_)
        ));
        let path = directory.join(format!("{}.json", key(id)));
        let choice = directory.join(format!("{}.native-choice", key(id)));
        let saved_choice = fs::read(&choice).unwrap();
        let original: serde_json::Value = read(&path, current_uid()).unwrap();
        for (field, value) in [
            ("sessionId", serde_json::json!("another-session")),
            ("messageId", serde_json::json!("another-message")),
            ("version", serde_json::json!(0)),
            ("version", serde_json::json!(3)),
            ("state", serde_json::json!("unknown")),
        ] {
            let mut record = original.clone();
            record[field] = value;
            let bytes = serde_json::to_vec(&record).unwrap();
            atomic_write(&path, &bytes).unwrap();
            assert!(
                matches!(
                    send(
                        &config,
                        &table,
                        current_uid(),
                        &registration,
                        id,
                        "peer framing"
                    ),
                    InjectOutcome::InDoubt(_)
                ),
                "{field}"
            );
            assert_eq!(fs::read(&path).unwrap(), bytes);
        }
        atomic_write(&path, b"{").unwrap();
        assert!(matches!(
            send(
                &config,
                &table,
                current_uid(),
                &registration,
                id,
                "peer framing"
            ),
            InjectOutcome::InDoubt(_)
        ));
        assert_eq!(fs::read(&path).unwrap(), b"{");
        assert_eq!(fs::read(&choice).unwrap(), saved_choice);
        assert_eq!(
            read::<u64>(&directory.join("sequence.json"), current_uid()),
            Some(1)
        );
    }
}
