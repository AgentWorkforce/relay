//! Reconcile approved disk state with the existing daemon, never a fresh server.

use crate::relay::codex::{
    app_server, processes,
    runner::{CodexRunner, SystemRunner},
};
use crate::relay::process::{ProcessInfo, ProcessTable, SystemProcesses};
use std::path::{Path, PathBuf};

struct Owner {
    process: ProcessInfo,
    executable: PathBuf,
    home: PathBuf,
    sqlite_home: PathBuf,
}

/// Run only a connect-only proxy of the trusted, existing owner for this home.
/// A standalone CLI with no matching shared daemon needs no runtime refresh.
pub(in crate::relay::codex::stop_hook) fn refresh(
    home: &Path,
    command: &str,
) -> Result<(), String> {
    refresh_with(
        home,
        command,
        &SystemProcesses::default(),
        &SystemRunner,
        crate::relay::peer::current_uid(),
        crate::platform::home_dir().as_deref(),
    )
}

/// Reconcile with explicit process/proxy providers, preserving owner checks.
pub(in crate::relay::codex::stop_hook) fn refresh_with(
    home: &Path,
    command: &str,
    table: &dyn ProcessTable,
    runner: &dyn CodexRunner,
    uid: u32,
    default_user_home: Option<&Path>,
) -> Result<(), String> {
    let Some(owner) = owner(home, table, uid, default_user_home)? else {
        return Ok(());
    };
    if !owner.current(table) {
        return Err("Codex's hook owner changed before refresh".into());
    }
    // `app-server proxy` connects to the current socket; it does not bootstrap a daemon.
    let mut stream = runner
        .proxy_in_home(&owner.executable, &owner.home, &owner.sqlite_home)
        .map_err(|_| "Could not connect to the existing Codex hook owner".to_string())?;
    if !owner.current(table) {
        return Err("Codex's hook owner changed while connecting".into());
    }
    app_server::refresh_hook_trust(
        stream.as_mut(),
        &owner.home,
        command,
        &super::EVENTS,
        &super::OPTIONAL_EVENTS,
        super::APP_SERVER_TIMEOUT,
    )
    .map_err(|error| format!("Codex's running hook state is not ready: {error}"))?;
    if !owner.current(table) {
        return Err("Codex's hook owner changed during refresh".into());
    }
    Ok(())
}

impl Owner {
    /// A recycled pid or replaced executable is no longer the selected owner.
    fn current(&self, table: &dyn ProcessTable) -> bool {
        !table.zombie(self.process.pid)
            && table.process(self.process.pid) == Some(self.process)
            && table.executable(self.process.pid).as_deref() == Some(&self.executable)
            && table.is_trusted_codex(&self.executable)
            && processes::is_proxied_app_server(table, self.process.pid)
    }
}

/// Relative or unresolved home values provide no ownership proof.
fn absolute(value: String) -> Result<PathBuf, String> {
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err("A running Codex has an unverifiable home".into());
    }
    path.canonicalize()
        .map_err(|_| "A running Codex home cannot be resolved".into())
}

/// Use the inspectable kernel environment, retaining Codex's home defaults.
fn process_home(
    table: &dyn ProcessTable,
    pid: i32,
    default_user_home: Option<&Path>,
) -> Result<PathBuf, String> {
    if !table.environment_readable(pid) {
        return Err("The running Codex's home cannot be inspected".into());
    }
    let home = match table
        .environment_var(pid, "CODEX_HOME")
        .filter(|v| !v.trim().is_empty())
    {
        Some(home) => absolute(home)?,
        None => {
            let user_home = table
                .environment_var(pid, "HOME")
                .map(PathBuf::from)
                .or_else(|| default_user_home.map(Path::to_path_buf))
                .ok_or("The running Codex's default home is unknown")?;
            absolute(user_home.join(".codex").to_string_lossy().into_owned())?
        }
    };
    Ok(home)
}

/// Resolve SQLite state only for the matching owner, never an unrelated home.
fn sqlite_home(table: &dyn ProcessTable, pid: i32, home: &Path) -> Result<PathBuf, String> {
    match table
        .environment_var(pid, "CODEX_SQLITE_HOME")
        .filter(|v| !v.trim().is_empty())
    {
        Some(sqlite) => absolute(sqlite),
        None => Ok(home.to_path_buf()),
    }
}

/// Select one trusted owner for this home; uncertainty is not absence.
fn owner(
    home: &Path,
    table: &dyn ProcessTable,
    uid: u32,
    default_user_home: Option<&Path>,
) -> Result<Option<Owner>, String> {
    let wanted = home
        .canonicalize()
        .map_err(|_| "Codex's hook home cannot be resolved")?;
    let mut found = None;
    for pid in table.all_pids() {
        let Some(process) = table.process(pid).filter(|p| p.uid == uid) else {
            continue;
        };
        if table.zombie(pid) || !processes::is_proxied_app_server(table, pid) {
            continue;
        }
        let Some(executable) = table.executable(pid).filter(|p| table.is_trusted_codex(p)) else {
            continue;
        };
        let home = process_home(table, pid, default_user_home)?;
        if home != wanted {
            continue;
        }
        let candidate = Owner {
            process,
            executable,
            sqlite_home: sqlite_home(table, pid, &home)?,
            home,
        };
        if !candidate.current(table) {
            return Err("Codex's hook owner changed during discovery".into());
        }
        if found.is_some() {
            return Err("Multiple live Codex owners claim this hook home".into());
        }
        found = Some(candidate);
    }
    Ok(found)
}

#[cfg(test)]
#[path = "live/cleanup.rs"]
mod cleanup;
