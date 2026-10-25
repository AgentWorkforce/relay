//! Existing Pi sessions through the bundled hot-loadable extension. No terminal
//! input, Pi upgrade, second Pi process, or upstream patch is needed. A private
//! per-runtime inbox is live only while the Pi process holds its registry open.
use crate::platform::fs as private_fs;
use crate::relay::delivery::policy::MessageRef;
use crate::relay::inject::InjectOutcome;
use crate::relay::process::ProcessTable;
use crate::relay::sessions::DiscoveredSession;
use crate::relay::store::{is_uuid, SessionKind, Target};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

pub(crate) mod setup;

const MAX_RECORD: u64 = 1024 * 1024;
const SOURCE: &str = include_str!("pi/agent-relay.mjs");

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

    /// Preserve a person's extension at this name. Refresh only our own copy.
    pub fn install(&self) -> Result<(), String> {
        if !self.enabled || !self.agent_dir.is_dir() {
            return Ok(());
        }
        let path = self.agent_dir.join("extensions/agent-relay.js");
        if let Ok(metadata) = fs::symlink_metadata(&path) {
            if !metadata.is_file()
                || !fs::read_to_string(&path)
                    .unwrap_or_default()
                    .starts_with("// AGENT_RELAY_PI_EXTENSION=")
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
    let parent = path.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Pi record has no parent directory",
        )
    })?;
    let tmp = path.with_extension(format!("{}.tmp", crate::relay::store::random_hex(16)));
    let mut file =
        private_fs::private(OpenOptions::new().write(true).create_new(true)).open(&tmp)?;
    let result = (|| {
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&tmp, path)?;
        private_fs::sync_dir(parent)
    })();
    if result.is_err() {
        let _ = fs::remove_file(tmp);
    }
    result
}

pub fn bindings(config: &PiConfig, table: &dyn ProcessTable, uid: u32) -> Vec<Binding> {
    if !config.enabled || !private(&config.runtime, uid, true) {
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
) -> Option<InjectOutcome> {
    let directory = pinned_directory(config, uid, registration)?;
    let path = directory.join(format!("{}.json", key(message_id)));
    if fs::symlink_metadata(&path).is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound) {
        return None;
    }
    let valid = read::<Delivery>(&path, uid).filter(|d| {
        d.version == 1
            && d.session_id == registration.target.id
            && d.message_id == message_id
            && d.text == text
    });
    match valid {
        Some(record) if record.state == "recorded" => Some(InjectOutcome::Delivered),
        Some(record) if matches!(record.state.as_str(), "pending" | "claimed") => None,
        _ => Some(InjectOutcome::InDoubt(
            "Pi's saved delivery record could not be verified.".into(),
        )),
    }
}

pub fn send(
    config: &PiConfig,
    table: &dyn ProcessTable,
    uid: u32,
    registration: &crate::relay::store::Registration,
    message_id: &str,
    text: &str,
) -> InjectOutcome {
    // Settlement must survive Pi exiting or switching runtimes after receipt.
    // Only new submissions need a live process with the exact pinned identity.
    if let Some(outcome) = recorded_delivery(config, uid, registration, message_id, text) {
        return outcome;
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
    let path = binding.directory.join(format!("{}.json", key(message_id)));
    let result = (|| -> Option<InjectOutcome> {
        let mut options = OpenOptions::new();
        options.write(true).create(true).truncate(false);
        let lock = private_fs::no_follow(private_fs::private(&mut options))
            .open(binding.directory.join("delivery.lock"))
            .ok()?;
        lock.lock_exclusive().ok()?;
        if fs::symlink_metadata(&path).is_ok() {
            let record: Delivery = read(&path, uid)?;
            if record.version != 1
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
            version: 1,
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
        atomic_write(&path, &bytes).ok()?;
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
            d.version == 1
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
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

    const ID: &str = "12345678-1234-4234-8234-123456789abc";

    fn fixture() -> (
        tempfile::TempDir,
        PiConfig,
        File,
        crate::relay::store::Registration,
    ) {
        let temp = tempfile::tempdir().unwrap();
        fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let config = PiConfig {
            runtime: temp.path().to_path_buf(),
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
}
