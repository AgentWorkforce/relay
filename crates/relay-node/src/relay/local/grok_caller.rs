//! Grok caller identity: existing discovery and exact spawned-leader proof.
use super::*;

impl LocalSessions {
    pub(super) fn grok_target(&self, pid: i32, session_id: &str) -> Option<Target> {
        if spawned_caller(&self.config, &self.table, pid, session_id).is_some() {
            return Some(Target::new(SessionKind::Grok, session_id));
        }
        self.grok_caller(pid, session_id)
            .map(|id| Target::new(SessionKind::GrokOpen, id))
    }

    /// The Grok session a tool process claims through `GROK_SESSION_ID`,
    /// when the claim holds: the already-open route is on, the nearest
    /// agent above the caller is this user's verified `grok agent leader`,
    /// Grok lists the session (its TUI registry, or a Paseo `grok agent
    /// stdio` of this user) with a client attached to the socket that very
    /// leader serves, and the caller and leader are still the same processes
    /// afterwards. A session open under some other leader is never named.
    pub(super) fn grok_caller(&self, pid: i32, session_id: &str) -> Option<String> {
        self.config.existing_grok.as_ref()?;
        let table = &*self.table;
        let uid = self.config.uid;
        let caller = table.process(pid)?;
        let leader = nearest_leader(table, pid, uid)?;
        let leader_process = table.process(leader)?;
        let served = served_socket(table, leader)?;
        let belongs = crate::relay::grok::open_sessions(&self.config.grok, table, uid)
            .iter()
            .any(|session| {
                // The client is read before and after its socket, so a pid
                // replaced in between never lends its attachment.
                let client = table.process(session.pid);
                session.session_id == session_id
                    && client.is_some()
                    && crate::relay::grok::attached_leader_socket(table, session.pid).as_ref()
                        == Some(&served)
                    && table.process(session.pid) == client
            });
        (belongs
            && table.process(leader) == Some(leader_process)
            && table.process(pid) == Some(caller))
        .then(|| session_id.to_string())
    }
}

/// The socket the leader `pid` serves: the one its argv names, else
/// `leader.sock` in its own Grok home.
fn served_socket(table: &dyn ProcessTable, pid: i32) -> Option<PathBuf> {
    use crate::relay::existing_session::grok::{default_leader_socket, leader_socket};
    let default = default_leader_socket(table, pid);
    leader_socket(&table.arguments(pid), default.as_deref())
}

/// Whether `pid` is a `grok agent leader` whose kernel executable is a
/// trusted Grok CLI (`ProcessTable::is_trusted_grok`). argv alone names a
/// candidate; any program can be started with those arguments.
pub(super) fn is_verified_leader(table: &dyn ProcessTable, pid: i32) -> bool {
    crate::relay::existing_session::grok::is_leader(&table.arguments(pid))
        && table
            .executable(pid)
            .is_some_and(|executable| table.is_trusted_grok(&executable))
}

/// The first agent boundary must be this user's exact Grok leader, verified
/// by its executable (`is_verified_leader`). An inherited session variable
/// cannot lend a nested agent an outer leader's identity. A process that
/// only carries a leader's argv is no leader, and is still a boundary: the
/// walk ends there with no leader rather than passing on to an outer one.
pub(super) fn nearest_leader(table: &dyn ProcessTable, pid: i32, uid: u32) -> Option<i32> {
    let mut current = pid;
    for _ in 0..MAX_ANCESTRY {
        if current <= 1 {
            return None;
        }
        let process = table.process(current)?;
        if process.uid != uid {
            return None;
        }
        // A leader's argv ends the walk either way; only a verified
        // executable makes it a leader that can name a session. A
        // leader-shaped process that is not one is a boundary, so the walk
        // never passes it to an outer leader.
        if crate::relay::existing_session::grok::is_leader(&table.arguments(current)) {
            return is_verified_leader(table, current).then_some(current);
        }
        if crate::relay::muse::is_muse_process(table, current)
            || crate::relay::cursor_cli::is_cursor_process(table, current)
            || table
                .executable(current)
                .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
                .is_some_and(|n| {
                    ["claude", "codex", "opencode", "muse", "devin"].contains(&n.as_str())
                })
        {
            return None;
        }
        current = process.parent;
    }
    None
}

pub(super) fn bound(
    config: &LocalConfig,
    table: &Arc<dyn ProcessTable>,
    session: &str,
) -> Option<crate::relay::harness::grok::SpawnedGrok> {
    use crate::relay::existing_session::grok::{Authority, SystemAuthority};
    let record =
        crate::relay::harness::grok::read_spawned_record(config.spawned_grok.as_ref()?, session)?;
    if record.binding.owner_uid != config.uid
        || table.zombie(record.binding.leader_pid)
        || !SystemAuthority::new(table.clone()).verify(&record.binding)
    {
        return None;
    }
    Some(record)
}

pub(super) fn spawned_caller(
    config: &LocalConfig,
    table: &Arc<dyn ProcessTable>,
    pid: i32,
    session: &str,
) -> Option<crate::relay::harness::grok::SpawnedGrok> {
    let caller = table.process(pid)?;
    let record = bound(config, table, session)?;
    if nearest_leader(&**table, pid, config.uid) != Some(record.binding.leader_pid)
        || table.process(pid) != Some(caller)
    {
        return None;
    }
    Some(record)
}

pub(super) fn session(
    config: &LocalConfig,
    table: &Arc<dyn ProcessTable>,
    target: &Target,
) -> Option<DiscoveredSession> {
    let record = bound(config, table, &target.id)?;
    Some(DiscoveredSession {
        target: target.clone(),
        title: crate::relay::grok::native_title(
            &crate::relay::grok::GrokConfig {
                home: record.grok_home.clone(),
            },
            record.binding.cwd.to_str()?,
            &record.binding.session_id,
        )
        .unwrap_or_else(|| "Spawned Grok".into()),
        directory: Some(record.binding.cwd.to_string_lossy().into_owned()),
        updated_at_ms: None,
        host: None,
        live: true,
        holder: None,
    })
}

pub(super) fn codex_tag_names_caller(
    table: &dyn ProcessTable,
    pid: i32,
    uid: u32,
    opencode_nearest: bool,
    devin_nearest: bool,
) -> bool {
    !opencode_nearest
        && !devin_nearest
        && !muse_precedes_codex(table, pid, uid)
        && !leader_argv_precedes_codex(table, pid, uid)
        && table.environment_var(pid, "CODEX_THREAD_ID").is_some()
}

/// Whether a process of this user's with a `grok agent leader` argv is
/// nearer the caller than any trusted Codex. That is an agent boundary for
/// an inherited `CODEX_THREAD_ID` whether or not its executable is a trusted
/// Grok: verification (`is_verified_leader`) decides only whether a Grok
/// session can be named, never whether an outer Codex's tag passes through.
fn leader_argv_precedes_codex(table: &dyn ProcessTable, pid: i32, uid: u32) -> bool {
    let mut current = pid;
    for _ in 0..MAX_ANCESTRY {
        if current <= 1 {
            return false;
        }
        let Some(process) = table.process(current).filter(|p| p.uid == uid) else {
            return false;
        };
        if crate::relay::existing_session::grok::is_leader(&table.arguments(current)) {
            return true;
        }
        if table
            .executable(current)
            .is_some_and(|exe| table.is_trusted_codex(&exe))
        {
            return false;
        }
        current = process.parent;
    }
    false
}

/// Muse's versioned launcher executable is an agent boundary too. A native
/// helper can read its inherited Codex tag, but that tag never lends a Muse
/// tool the outer Codex session's identity. An actual inner Codex still wins.
fn muse_precedes_codex(table: &dyn ProcessTable, pid: i32, uid: u32) -> bool {
    let mut current = pid;
    for _ in 0..MAX_ANCESTRY {
        let Some(process) = table.process(current).filter(|p| p.uid == uid) else {
            return false;
        };
        if crate::relay::muse::is_muse_process(table, current) {
            return true;
        }
        if table
            .executable(current)
            .is_some_and(|exe| table.is_trusted_codex(&exe))
        {
            return false;
        }
        if current <= 1 || process.parent == current {
            return false;
        }
        current = process.parent;
    }
    false
}

#[cfg(test)]
mod tests;
