//! Existing Pi and omp sessions through the bundled extension. No terminal
//! input, harness upgrade, second process, or upstream patch is needed. A private
//! per-runtime inbox is live only while the harness process holds its registry
//! open. omp (oh-my-pi) is a Pi fork with the same extension API; it loads
//! extensions only when a session starts and has its own agent directory.
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

mod config;
mod inbox;
mod native_choice;
pub(crate) mod setup;
pub use config::{Flavor, PiConfig};
use inbox::{atomic_write_guarded, delivery_lock};

const MAX_RECORD: u64 = 1024 * 1024;

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
            reference: format!(
                "{}:{}:{}:{}",
                config.flavor.kind().as_str(),
                process.pid,
                process.start,
                instance
            ),
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
            target: Target::new(config.flavor.kind(), b.registry.session_id.clone()),
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

pub fn set_title(
    config: &PiConfig,
    table: &dyn ProcessTable,
    uid: u32,
    id: &str,
    title: &str,
) -> Result<String, String> {
    let name = config.name();
    let bound = binding(config, table, uid, id)
        .filter(|b| b.registry.title_editing)
        .ok_or_else(|| {
            format!("Reload the Agent Relay extension in this {name} session to edit its title.")
        })?;
    // The extension reads only `title-<32 hex>.json`; any other name is ignored.
    let request_id = crate::relay::store::random_hex(32);
    let path = bound.directory.join(format!("title-{request_id}.json"));
    let expires = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "The system clock is unavailable.")?
        .as_millis() as u64
        + 4_000;
    let record = serde_json::json!({"version":1,"sessionId":id,"requestId":request_id,
        "title":title,"state":"pending","expiresAt":expires});
    atomic_write(&path, record.to_string().as_bytes())
        .map_err(|_| format!("Could not send the title to {name}."))?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let result = loop {
        let Some(current) = binding(config, table, uid, id) else {
            break Err(format!(
                "The {name} session closed before confirming the title."
            ));
        };
        if current.reference != bound.reference {
            break Err(format!(
                "The {name} session changed before confirming the title."
            ));
        }
        if let Some(reply) = read::<serde_json::Value>(&path, uid) {
            if reply["sessionId"] == id && reply["requestId"] == request_id {
                if reply["state"] == "done" {
                    break reply["title"]
                        .as_str()
                        .filter(|s| !s.trim().is_empty())
                        .map(str::to_owned)
                        .ok_or_else(|| format!("{name} returned an empty title."));
                }
                if reply["state"] == "failed" {
                    break Err(format!("{name} could not save the title."));
                }
            }
        }
        if std::time::Instant::now() >= deadline {
            break Err(format!(
                "{name} did not confirm the title. Reload its Agent Relay extension and try again."
            ));
        }
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
        || parts[0] != config.flavor.kind().as_str()
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
            Some(InjectOutcome::Accepted(format!(
                "Waiting for {} to record this message.",
                config.name()
            )))
        }
        Some(record) if matches!(record.state.as_str(), "pending" | "claimed") => None,
        _ => Some(InjectOutcome::InDoubt(format!(
            "{}'s saved delivery record could not be verified.",
            config.name()
        ))),
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
    let name = config.name();
    // Settlement must survive the harness exiting or switching runtimes after receipt.
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
        return InjectOutcome::Waiting(format!(
            "{name} is not connected. {}",
            config.flavor.reconnect()
        ));
    };
    if registration.route_binding.as_deref() != Some(&binding.reference) {
        return InjectOutcome::Refused(format!(
            "The {name} session binding changed; turn this agent off, then add the session again."
        ));
    }
    if native && binding.registry.native_continuation != 1 {
        return InjectOutcome::Refused(format!(
            "Reload {name}'s Agent Relay extension to enable native owner messages."
        ));
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
                    InjectOutcome::Accepted(format!("Waiting for {name} to record this message."))
                }
                _ => InjectOutcome::InDoubt(format!("{name}'s delivery record is unreadable.")),
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
            return Some(InjectOutcome::Refused(format!(
                "This message is too large for {name}'s inbox."
            )));
        }
        let published =
            atomic_write_guarded(&path, &bytes, &|| admit.is_none_or(|admit| admit())).ok()?;
        if !published {
            return Some(InjectOutcome::Refused(format!(
                "{name} owner authorization changed."
            )));
        }
        Some(InjectOutcome::Accepted(format!(
            "Waiting for {name} to be idle."
        )))
    })();
    result.unwrap_or_else(|| {
        InjectOutcome::InDoubt(format!(
            "{name}'s delivery inbox is unavailable; this message will not be resent."
        ))
    })
}

/// Read receipts even after the harness exits, but only from this registration's pinned runtime.
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
    #[test]
    fn turning_pi_off_leaves_oh_my_pis_extension_in_a_shared_folder() {
        let home = tempfile::tempdir().unwrap();
        let home = home.path();
        let omp = PiConfig::omp_from_env(&|_| None, home);
        std::fs::create_dir_all(&omp.agent_dir).unwrap();
        omp.install().unwrap();
        let pi = PiConfig {
            agent_dir: omp.agent_dir.clone(),
            ..PiConfig::from_env(&|_| None, home)
        };
        assert!(!pi.extension_installed(), "the copy there is Oh My Pi's");
        pi.remove().unwrap();
        assert!(omp.extension_installed(), "Oh My Pi's copy is kept");
    }

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
            flavor: Flavor::Pi,
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
    fn omp_sessions_are_their_own_kind_and_never_accept_a_pi_binding() {
        let (_temp, mut config, _held, mut registration) = fixture();
        let table = SystemProcesses::default();
        let pi_reference = registration.route_binding.clone().unwrap();
        config.flavor = Flavor::Omp;
        let rows = discover(&config, &table, current_uid());
        assert_eq!(rows[0].target, Target::new(SessionKind::Omp, ID));
        let binding = binding(&config, &table, current_uid(), ID).unwrap();
        assert!(binding.reference.starts_with("omp:"));
        registration.target = Target::new(SessionKind::Omp, ID);
        // A Pi registration's binding never routes into Oh My Pi.
        assert_eq!(
            send(&config, &table, current_uid(), &registration, "m", "Hi"),
            InjectOutcome::Refused(
                "The Oh My Pi session binding changed; turn this agent off, then add the session again."
                    .into()
            )
        );
        assert!(pinned_directory(&config, current_uid(), &registration).is_none());
        registration.route_binding = Some(binding.reference);
        assert!(matches!(
            send(&config, &table, current_uid(), &registration, "m", "Hi"),
            InjectOutcome::Accepted(_)
        ));
        assert!(pi_reference.starts_with("pi:"));
    }

    #[test]
    fn omp_installs_into_its_own_agent_directory_with_its_harness_named() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let config = PiConfig::omp_from_env(&|_| None, home);
        assert_eq!(config.agent_dir, home.join(".omp/agent"));
        assert_eq!(config.runtime, home.join(".agentworkforce/desktop/omp"));
        // PI_CODING_AGENT_DIR is Pi's too; only omp's config root moves it.
        let env = |key: &str| match key {
            "PI_CODING_AGENT_DIR" => Some("/elsewhere".to_string()),
            "PI_CONFIG_DIR" => Some(".omp-work".to_string()),
            _ => None,
        };
        assert_eq!(
            PiConfig::omp_from_env(&env, home).agent_dir,
            home.join(".omp-work/agent")
        );
        assert!(
            !PiConfig::omp_from_env(
                &|k| (k == "AGENT_RELAY_ENABLE_OMP").then(|| "0".into()),
                home
            )
            .enabled
        );
        assert!(config.install().is_ok());
        assert!(
            !config.agent_dir.exists(),
            "no agent directory means omp is not installed"
        );
        fs::create_dir_all(&config.agent_dir).unwrap();
        config.install().unwrap();
        let source =
            fs::read_to_string(config.agent_dir.join("extensions/agent-relay.js")).unwrap();
        assert!(source.contains("const harness = \"omp\";"));
        assert!(source.contains(".agentworkforce/desktop/omp"));
        assert!(!source.contains("__HARNESS__"));
        let pi = PiConfig::from_env(&|_| None, home).extension_source();
        assert!(pi.contains("const harness = \"pi\";"));
    }

    #[test]
    fn pi_and_omp_sharing_an_agent_directory_never_overwrite_each_other() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let pi = PiConfig::from_env(&|_| None, home);
        // PI_CONFIG_DIR=.pi points omp at Pi's own agent directory.
        let env = |key: &str| (key == "PI_CONFIG_DIR").then(|| "./.pi/".to_string());
        let omp = PiConfig::omp_from_env(&env, home);
        fs::create_dir_all(&pi.agent_dir).unwrap();
        let path = pi.agent_dir.join("extensions/agent-relay.js");
        pi.install().unwrap();
        let installed = fs::read_to_string(&path).unwrap();
        let error = omp.install().unwrap_err();
        assert!(
            error.contains("Oh My Pi shares its agent directory with Pi"),
            "{error}"
        );
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            installed,
            "Pi keeps its extension"
        );
        // Through a symlink too, and the other way round.
        fs::remove_file(&path).unwrap();
        let linked = home.join(".omp-link");
        std::os::unix::fs::symlink(home.join(".pi"), &linked).unwrap();
        let omp = PiConfig::omp_from_env(
            &|k| (k == "PI_CONFIG_DIR").then(|| ".omp-link".into()),
            home,
        );
        omp.install().unwrap();
        let installed = fs::read_to_string(&path).unwrap();
        assert!(installed.contains("const harness = \"omp\";"));
        assert!(pi
            .install()
            .unwrap_err()
            .contains("Pi shares its agent directory with Oh My Pi"));
        assert_eq!(fs::read_to_string(&path).unwrap(), installed);
        // Each harness still refreshes its own copy.
        omp.install().unwrap();
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

    /// The core's title request, as it writes it, against the bundled
    /// extension running in Node with a stand-in Pi or omp session API.
    #[test]
    fn a_title_request_from_the_core_is_applied_by_the_bundled_extension() {
        if std::process::Command::new("node")
            .arg("--version")
            .output()
            .is_err()
        {
            eprintln!("skipped: node is not installed");
            return;
        }
        for flavor in [Flavor::Pi, Flavor::Omp] {
            let temp = tempfile::tempdir().unwrap();
            fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o700)).unwrap();
            let config = PiConfig {
                flavor,
                runtime: temp.path().join("runtime"),
                agent_dir: temp.path().join("agent"),
                enabled: true,
            };
            let extension = temp.path().join("extension.mjs");
            fs::write(&extension, config.extension_source()).unwrap();
            // omp's setSessionName saves asynchronously; Pi's returns at once.
            let host = temp.path().join("host.mjs");
            fs::write(&host, format!(r#"
const [extension, cwd, harness] = process.argv.slice(2);
let title = 'Old title';
const handlers = new Map();
const pi = {{ getSessionName: () => title, on: (name, fn) => handlers.set(name, fn), sendUserMessage() {{}},
  setSessionName: value => harness === 'omp'
    ? new Promise(resolve => setTimeout(() => {{ title = value; resolve(); }}, 20))
    : void (title = value) }};
(await import(extension)).default(pi);
handlers.get('session_start')({{}}, {{ hasUI: true, cwd, ui: {{}}, isIdle: () => true,
  sessionManager: {{ getSessionFile: () => cwd + '/session.jsonl', getSessionId: () => '{ID}', getBranch: () => [] }} }});
setInterval(() => {{}}, 1000);
"#)).unwrap();
            let harness = match flavor {
                Flavor::Pi => "pi",
                Flavor::Omp => "omp",
            };
            let mut node = std::process::Command::new("node")
                .arg(&host)
                .arg(&extension)
                .arg(temp.path())
                .arg(harness)
                .spawn()
                .unwrap();
            let table = SystemProcesses::default();
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            while !can_set_title(&config, &table, current_uid(), ID) {
                assert!(
                    std::time::Instant::now() < deadline,
                    "{harness}: the extension never registered"
                );
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            let result = set_title(&config, &table, current_uid(), ID, "Renamed from Relay");
            let _ = node.kill();
            let _ = node.wait();
            assert_eq!(result, Ok("Renamed from Relay".into()), "{harness}");
        }
    }

    #[test]
    fn the_auto_join_marker_follows_the_setting_only_where_pi_has_run() {
        let temp = tempfile::tempdir().unwrap();
        let config = PiConfig::from_env(&|_| None, temp.path());
        let marker = config.auto_join_marker();
        assert_eq!(
            marker,
            temp.path().join(".agentworkforce/desktop/pi-auto-join")
        );
        config.sync_auto_join(true);
        assert!(!marker.exists(), "Pi has not run here");
        assert!(!temp.path().join(".agentworkforce").exists());
        fs::create_dir_all(&config.agent_dir).unwrap();
        config.sync_auto_join(true);
        assert!(marker.is_file());
        config.sync_auto_join(true);
        assert!(marker.is_file());
        config.sync_auto_join(false);
        assert!(!marker.exists());
        config.sync_auto_join(false);
        assert!(!marker.exists());
        // Pi sessions turned off: the banner never says they join.
        config.sync_auto_join(true);
        assert!(marker.is_file());
        fs::write(config.off_marker(), "off").unwrap();
        config.sync_auto_join(true);
        assert!(!marker.exists());
        fs::remove_file(config.off_marker()).unwrap();
        config.sync_auto_join(true);
        assert!(marker.is_file());
        let disabled = PiConfig {
            enabled: false,
            ..config.clone()
        };
        disabled.sync_auto_join(true);
        assert!(!marker.exists(), "AGENT_RELAY_ENABLE_PI=0 clears it");
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
