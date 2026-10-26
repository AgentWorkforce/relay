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
    /// when the claim holds: the already-open route is on, an ancestor of
    /// this user's is a `grok agent leader`, Grok lists the session (its TUI
    /// registry, or a Paseo `grok agent stdio` of this user), and the caller
    /// is still the same process afterwards. The walk ends at the first leader.
    pub(super) fn grok_caller(&self, pid: i32, session_id: &str) -> Option<String> {
        self.config.existing_grok.as_ref()?;
        let table = &*self.table;
        let uid = self.config.uid;
        let caller = table.process(pid)?;
        nearest_leader(table, pid, uid)?;
        let listed = crate::relay::grok::open_sessions(&self.config.grok, table, uid)
            .iter()
            .any(|session| session.session_id == session_id);
        (listed && table.process(pid) == Some(caller)).then(|| session_id.to_string())
    }
}

/// The first agent boundary must be this user's exact Grok leader. An inherited
/// session variable cannot lend a nested agent an outer leader's identity.
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
        if crate::relay::existing_session::grok::is_leader(&table.arguments(current)) {
            return Some(current);
        }
        if crate::relay::muse::is_muse_process(table, current)
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
        && nearest_leader(table, pid, uid).is_none()
        && table.environment_var(pid, "CODEX_THREAD_ID").is_some()
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
