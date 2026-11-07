//! Private runtime records and peer-verified control exchange.
use super::{is_session_id, DroidConfig, MARKER};
use crate::relay::existing_session::platform::MetadataExt;
use crate::relay::inject::InjectOutcome;
use crate::relay::process::ProcessTable;
use crate::relay::spawn::launch::SpawnedProcess;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::Read;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
#[cfg(unix)]
use std::time::Duration;
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Record {
    pub launch_id: String,
    pub session_id: String,
    pub host: SpawnedProcess,
    pub child: SpawnedProcess,
    pub socket: PathBuf,
    pub executable: PathBuf,
    pub directory: PathBuf,
    #[serde(default)]
    pub initial_message_id: Option<String>,
}

pub fn runtime(config: &DroidConfig) -> PathBuf {
    config.data_dir.join("relay").join(if config.development {
        "spawned-dev"
    } else {
        "spawned"
    })
}

fn private(path: &Path, directory: bool) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|m| {
        m.uid() == crate::relay::peer::current_uid()
            && m.mode() & 0o077 == 0
            && if directory { m.is_dir() } else { m.is_file() }
    })
}

pub(crate) fn read_record(path: &Path) -> Option<Record> {
    if !private(path.parent()?, true) || !private(path, false) {
        return None;
    }
    let file = crate::platform::fs::no_follow(std::fs::OpenOptions::new().read(true))
        .open(path)
        .ok()?;
    if file.metadata().ok()?.len() > 16_384 {
        return None;
    }
    serde_json::from_reader(file.take(16_385)).ok()
}

#[cfg(unix)]
pub(super) fn write_record(path: &Path, record: &Record) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&tmp)?;
    serde_json::to_writer(&mut file, record)?;
    file.sync_all()?;
    std::fs::rename(tmp, path)
}

pub(crate) fn host_owned(record: &Record, table: &dyn ProcessTable) -> bool {
    record.host.is(table.process(record.host.pid))
        && table
            .process(record.host.pid)
            .is_some_and(|p| p.uid == crate::relay::peer::current_uid())
        && table.environment_var(record.host.pid, MARKER).as_deref() == Some(&record.launch_id)
        && !table.zombie(record.host.pid)
}
pub(crate) fn child_owned(record: &Record, table: &dyn ProcessTable) -> bool {
    record.child.is(table.process(record.child.pid))
        && table
            .process(record.child.pid)
            .is_some_and(|p| p.uid == crate::relay::peer::current_uid())
        && table.environment_var(record.child.pid, MARKER).as_deref() == Some(&record.launch_id)
        && table.executable(record.child.pid).is_some_and(|actual| {
            actual == record.executable
                || std::fs::canonicalize(actual).ok().as_ref() == Some(&record.executable)
        })
        && !table.zombie(record.child.pid)
}
pub(crate) fn verified(record: &Record, table: &dyn ProcessTable) -> bool {
    host_owned(record, table)
        && child_owned(record, table)
        && table
            .process(record.child.pid)
            .is_some_and(|p| p.parent == record.host.pid)
}
#[derive(Debug, PartialEq, Eq)]
pub(super) enum ExchangeFailure {
    Unavailable,
    #[cfg(unix)]
    Uncertain,
}
/// One request to the host's control socket, admitted only from the host
/// the kernel reports at the other end.
#[cfg(unix)]
fn control_stream(
    record: &Record,
    table: &dyn ProcessTable,
) -> Option<std::os::unix::net::UnixStream> {
    use std::os::unix::fs::FileTypeExt;
    use std::os::unix::net::UnixStream;
    if !verified(record, table) {
        return None;
    }
    let metadata = std::fs::symlink_metadata(&record.socket).ok()?;
    if !metadata.file_type().is_socket()
        || metadata.uid() != crate::relay::peer::current_uid()
        || metadata.mode() & 0o077 != 0
    {
        return None;
    }
    let stream = UnixStream::connect(&record.socket).ok()?;
    let peer = crate::relay::peer::peer_credentials(&stream).ok()?;
    if peer.uid != crate::relay::peer::current_uid() || peer.pid != Some(record.host.pid) {
        return None;
    }
    stream.set_read_timeout(Some(Duration::from_secs(3))).ok()?;
    stream
        .set_write_timeout(Some(Duration::from_secs(3)))
        .ok()?;
    Some(stream)
}
#[cfg(unix)]
pub(super) fn exchange_result(
    record: &Record,
    table: &dyn ProcessTable,
    request: Value,
) -> Result<Value, ExchangeFailure> {
    use std::io::{BufRead, BufReader, Write};
    let mut stream = control_stream(record, table).ok_or(ExchangeFailure::Unavailable)?;
    let bytes = format!("{request}\n").into_bytes();
    let mut written = 0;
    while written < bytes.len() {
        match stream.write(&bytes[written..]) {
            Ok(0) => {
                return Err(if written == 0 {
                    ExchangeFailure::Unavailable
                } else {
                    ExchangeFailure::Uncertain
                })
            }
            Ok(count) => written += count,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => {
                return Err(if written == 0 {
                    ExchangeFailure::Unavailable
                } else {
                    ExchangeFailure::Uncertain
                })
            }
        }
    }
    let mut response = String::new();
    BufReader::new(stream)
        .take(32_769)
        .read_line(&mut response)
        .map_err(|_| ExchangeFailure::Uncertain)?;
    if !response.ends_with('\n') || response.len() > 32_768 {
        return Err(ExchangeFailure::Uncertain);
    }
    serde_json::from_str(&response).map_err(|_| ExchangeFailure::Uncertain)
}
#[cfg(windows)]
pub(super) fn exchange_result(
    _record: &Record,
    _table: &dyn ProcessTable,
    _request: Value,
) -> Result<Value, ExchangeFailure> {
    Err(ExchangeFailure::Unavailable)
}
pub(super) fn exchange(record: &Record, table: &dyn ProcessTable, request: Value) -> Option<Value> {
    exchange_result(record, table, request).ok()
}

pub fn deliver(
    config: &DroidConfig,
    table: &dyn ProcessTable,
    session: &str,
    id: &str,
    text: &str,
) -> Option<InjectOutcome> {
    if !is_session_id(session) {
        return None;
    }
    let path = runtime(config).join(format!("{session}.json"));
    if !path.exists() {
        return None;
    }
    let Some(record) = read_record(&path) else {
        return Some(InjectOutcome::Waiting(
            "Droid ownership record is unavailable".into(),
        ));
    };
    if record.session_id != session {
        return Some(InjectOutcome::Refused(
            "Droid ownership record names a different session".into(),
        ));
    }
    Some(
        match exchange_result(&record, table, json!({"op":"prompt", "id":id, "text":text})) {
            Err(ExchangeFailure::Unavailable) => {
                InjectOutcome::Waiting("Droid host is unavailable; nothing was submitted".into())
            }
            #[cfg(unix)]
            Err(ExchangeFailure::Uncertain) => InjectOutcome::InDoubt(
                "Droid handoff could not be confirmed; it will not be repeated".into(),
            ),
            Ok(response) => match response["status"].as_str() {
                Some("delivered") => InjectOutcome::Delivered,
                Some("accepted") => {
                    InjectOutcome::Accepted("Droid native host queued this turn".into())
                }
                Some("refused") => {
                    InjectOutcome::Refused("Droid native host refused the turn".into())
                }
                _ => InjectOutcome::InDoubt(
                    "Droid did not confirm its submission outcome; it will not be repeated".into(),
                ),
            },
        },
    )
}

#[cfg(unix)]
#[derive(Serialize, Deserialize)]
pub(super) struct InitialTask {
    pub id: String,
    pub text: String,
}
#[cfg(unix)]
pub(super) fn write_initial(
    runtime: &Path,
    launch: &str,
    id: &str,
    text: &str,
) -> std::io::Result<()> {
    if !is_session_id(launch)
        || id.is_empty()
        || id.len() > 256
        || text.is_empty()
        || text.len() > 65_536
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Invalid Droid initial task",
        ));
    }
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(runtime.join(format!("{launch}.task.json")))?;
    serde_json::to_writer(
        &mut file,
        &InitialTask {
            id: id.into(),
            text: text.into(),
        },
    )?;
    file.sync_all()
}
#[cfg(unix)]
pub(super) fn initial(runtime: &Path, launch: &str) -> anyhow::Result<Option<InitialTask>> {
    let path = runtime.join(format!("{launch}.task.json"));
    if !path.exists() {
        return Ok(None);
    }
    anyhow::ensure!(
        private(runtime, true) && private(&path, false),
        "Droid initial task is not private"
    );
    let file = crate::platform::fs::no_follow(std::fs::OpenOptions::new().read(true)).open(path)?;
    anyhow::ensure!(
        file.metadata()?.len() <= 1024 * 1024,
        "Droid initial task exceeds limit"
    );
    Ok(Some(serde_json::from_reader(file.take(1024 * 1024 + 1))?))
}
