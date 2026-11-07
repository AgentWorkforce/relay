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

pub(crate) fn verified(record: &Record, table: &dyn ProcessTable) -> bool {
    let uid = crate::relay::peer::current_uid();
    record.host.is(table.process(record.host.pid))
        && record.child.is(table.process(record.child.pid))
        && table.process(record.host.pid).is_some_and(|p| p.uid == uid)
        && table
            .process(record.child.pid)
            .is_some_and(|p| p.uid == uid && p.parent == record.host.pid)
        && table.environment_var(record.host.pid, MARKER).as_deref() == Some(&record.launch_id)
        && table.environment_var(record.child.pid, MARKER).as_deref() == Some(&record.launch_id)
        && std::fs::canonicalize(&record.executable).is_ok_and(|expected| {
            table
                .executable(record.child.pid)
                .and_then(|p| std::fs::canonicalize(p).ok())
                == Some(expected)
        })
        && !table.zombie(record.host.pid)
        && !table.zombie(record.child.pid)
}

/// One request to the host's control socket, admitted only from the host
/// the kernel reports at the other end.
#[cfg(unix)]
pub(super) fn exchange(record: &Record, table: &dyn ProcessTable, request: Value) -> Option<Value> {
    use std::io::{BufRead, BufReader, Write};
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
    let mut stream = UnixStream::connect(&record.socket).ok()?;
    let peer = crate::relay::peer::peer_credentials(&stream).ok()?;
    if peer.uid != crate::relay::peer::current_uid() || peer.pid != Some(record.host.pid) {
        return None;
    }
    stream.set_read_timeout(Some(Duration::from_secs(3))).ok()?;
    stream
        .set_write_timeout(Some(Duration::from_secs(3)))
        .ok()?;
    writeln!(stream, "{request}").ok()?;
    let mut response = String::new();
    BufReader::new(stream)
        .take(32_769)
        .read_line(&mut response)
        .ok()?;
    serde_json::from_str(&response).ok()
}

/// The initial managed host is Unix-only: no Windows route answers.
#[cfg(windows)]
pub(super) fn exchange(
    _record: &Record,
    _table: &dyn ProcessTable,
    _request: Value,
) -> Option<Value> {
    None
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
    let Some(record) = read_record(&path).filter(|r| r.session_id == session) else {
        return Some(InjectOutcome::Refused(
            "Droid spawn ownership could not be verified".into(),
        ));
    };
    Some(
        match exchange(&record, table, json!({"op":"prompt", "id":id, "text":text}))
            .and_then(|v| v["status"].as_str().map(str::to_string))
            .as_deref()
        {
            Some("delivered") => InjectOutcome::Delivered,
            Some("accepted") => {
                InjectOutcome::Accepted("Droid JSON-RPC host queued this turn".into())
            }
            Some("refused") => InjectOutcome::Refused("Droid JSON-RPC refused the turn".into()),
            Some("in_doubt") | None => InjectOutcome::InDoubt(
                "Droid JSON-RPC handoff could not be confirmed; it will not be repeated".into(),
            ),
            _ => InjectOutcome::Waiting("Droid JSON-RPC host is not ready".into()),
        },
    )
}
