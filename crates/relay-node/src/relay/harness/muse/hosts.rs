//! Durable ownership of the detached PTY host, written before it starts Muse.
use super::*;
use crate::relay::existing_session::platform::MetadataExt;
use crate::relay::process::{ProcessTable, SystemProcesses};
use serde::{Deserialize, Serialize};
use std::io::Read;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct Record {
    pub launch_id: String,
    pub host: SpawnedProcess,
    pub executable: PathBuf,
    pub target: Option<String>,
    pub child: Option<SpawnedProcess>,
}
fn path(logs: &Path, launch_id: &str) -> Option<PathBuf> {
    is_uuid(launch_id).then(|| logs.join("muse-hosts").join(format!("{launch_id}.json")))
}
fn write(logs: &Path, record: &Record) -> std::io::Result<()> {
    let path = path(logs, &record.launch_id)
        .ok_or_else(|| std::io::Error::other("invalid Muse launch id"))?;
    crate::relay::paths::socket_directory(
        path.parent()
            .ok_or_else(|| std::io::Error::other("missing Muse host folder"))?,
    )
    .map_err(|error| std::io::Error::other(error.to_string()))?;
    let mut file = tempfile::NamedTempFile::new_in(
        path.parent()
            .ok_or_else(|| std::io::Error::other("missing Muse host folder"))?,
    )?;
    serde_json::to_writer(&mut file, record)?;
    file.as_file().sync_all()?;
    file.persist(path).map_err(|e| e.error)?;
    Ok(())
}
#[cfg_attr(windows, allow(dead_code))] // Only the Unix PTY host begins one.
pub(super) fn begin(log: &Path) -> anyhow::Result<()> {
    let Some(launch_id) = std::env::var(SPAWN_MARKER).ok().filter(|id| is_uuid(id)) else {
        return Ok(());
    };
    let host = SystemProcesses::default()
        .process(std::process::id() as i32)
        .map(SpawnedProcess::of)
        .ok_or_else(|| anyhow::anyhow!("Muse host identity unavailable"))?;
    let logs = log
        .parent()
        .ok_or_else(|| anyhow::anyhow!("Muse host log folder unavailable"))?;
    write(
        logs,
        &Record {
            launch_id,
            host,
            executable: std::env::current_exe()?,
            target: None,
            child: None,
        },
    )?;
    Ok(())
}
pub(super) fn read(logs: &Path, launch_id: &str) -> Option<Record> {
    let path = path(logs, launch_id)?;
    let metadata = std::fs::symlink_metadata(&path).ok()?;
    if !metadata.is_file()
        || metadata.uid() != crate::relay::peer::current_uid()
        || metadata.mode() & 0o077 != 0
    {
        return None;
    }
    let record: Record =
        serde_json::from_reader(std::fs::File::open(path).ok()?.take(16_385)).ok()?;
    (record.launch_id == launch_id).then_some(record)
}
pub(super) fn verified(record: &Record, table: &dyn ProcessTable) -> bool {
    record.host.is(table.process(record.host.pid))
        && table
            .process(record.host.pid)
            .is_some_and(|p| p.uid == crate::relay::peer::current_uid())
        && !table.zombie(record.host.pid)
        && table
            .environment_var(record.host.pid, SPAWN_MARKER)
            .as_deref()
            == Some(&record.launch_id)
        && std::fs::canonicalize(&record.executable)
            .ok()
            .is_some_and(|expected| {
                table
                    .executable(record.host.pid)
                    .and_then(|p| std::fs::canonicalize(p).ok())
                    == Some(expected)
            })
}
pub(super) fn bind(
    logs: &Path,
    launch_id: &str,
    target: &Target,
    child: Option<SpawnedProcess>,
    table: &dyn ProcessTable,
) -> bool {
    let Some(mut record) = read(logs, launch_id).filter(|r| verified(r, table)) else {
        return false;
    };
    let Some(child) = child.filter(|child| {
        child.is(table.process(child.pid)) && descendant(table, child.pid, record.host.pid)
    }) else {
        return false;
    };
    record.target = Some(target.id.clone());
    record.child = Some(child);
    write(logs, &record).is_ok()
}
pub(super) fn bound(
    logs: &Path,
    target: &Target,
    child: &SpawnedProcess,
    table: &dyn ProcessTable,
) -> Option<Record> {
    let marker = table.environment_var(child.pid, SPAWN_MARKER)?;
    read(logs, &marker).filter(|r| {
        r.target.as_deref() == Some(&target.id)
            && r.child == Some(*child)
            && verified(r, table)
            && descendant(table, child.pid, r.host.pid)
    })
}

/// The live host that recorded `child` as `target`'s session, found by the
/// records alone: once the child ended or its pid was taken, it no longer
/// names its host, which may still run. Only a host that proves itself
/// (`verified`) is returned.
pub(super) fn owner_of(
    logs: &Path,
    target: &Target,
    child: &SpawnedProcess,
    table: &dyn ProcessTable,
) -> Option<Record> {
    std::fs::read_dir(logs.join("muse-hosts"))
        .ok()?
        .flatten()
        .find_map(|entry| {
            let name = entry.file_name();
            let launch_id = name.to_str()?.strip_suffix(".json")?;
            read(logs, launch_id).filter(|r| {
                r.target.as_deref() == Some(&target.id)
                    && r.child == Some(*child)
                    && verified(r, table)
            })
        })
}

/// Before the host writes its own record it has not started a child. The
/// immediate started callback still lets restart wait for, or end, that host.
pub(super) fn pending(
    logs: &Path,
    intent: &Intent,
    table: &dyn ProcessTable,
) -> Option<SpawnedProcess> {
    if let Some(record) = read(logs, &intent.session_id).filter(|r| verified(r, table)) {
        return Some(record.host);
    }
    let host = intent.process?;
    let placeholder = intent.target.as_ref().is_some_and(|target| {
        target.kind == SessionKind::MuseOpen && target.id == intent.session_id
    });
    (placeholder
        && host.is(table.process(host.pid))
        && table
            .process(host.pid)
            .is_some_and(|p| p.uid == crate::relay::peer::current_uid())
        && table.environment_var(host.pid, SPAWN_MARKER).as_deref() == Some(&intent.session_id)
        && table
            .arguments(host.pid)
            .iter()
            .any(|arg| arg == "muse-spawn-host")
        && !table.zombie(host.pid))
    .then_some(host)
}

fn descendant(table: &dyn ProcessTable, pid: i32, host: i32) -> bool {
    let mut current = pid;
    for _ in 0..crate::relay::process::MAX_ANCESTRY {
        if current == host {
            return true;
        }
        let Some(process) = table.process(current) else {
            return false;
        };
        if process.uid != crate::relay::peer::current_uid()
            || process.parent <= 1
            || process.parent == current
        {
            return false;
        }
        current = process.parent;
    }
    false
}
