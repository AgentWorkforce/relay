//! Outbound identity for probe-owned OpenCode servers. A shell's session
//! tag is only a selector: the private sealed binding, kernel process,
//! server listener/authentication and provider session readback prove it.
//! A plugin attestation proves this exact server loaded the tagging hook.
pub mod spawned;

use super::OpenCodeConfig;
use crate::relay::existing_session::platform::MetadataExt;
use crate::relay::managed_sessions::{ManagedBinding, ManagedSessions};
use crate::relay::opencode_existing::{self, Binding};
use crate::relay::process::ProcessTable;
use crate::relay::store::{SessionKind, Target};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::Read;

pub fn is_session_id(id: &str) -> bool {
    id.strip_prefix("ses_").is_some_and(|rest| {
        (4..=128).contains(&rest.len()) && rest.bytes().all(|b| b.is_ascii_alphanumeric())
    })
}

fn tagging_ready(config: &OpenCodeConfig, table: &dyn ProcessTable, binding: &Binding) -> bool {
    let Some(process) = table.process(binding.server_pid) else {
        return false;
    };
    if process.start != binding.server_start
        || process.uid != binding.server_uid
        || table.zombie(binding.server_pid)
    {
        return false;
    }
    let Some(marker) =
        table.environment_var(binding.server_pid, crate::relay::opencode_serve::MARKER)
    else {
        return false;
    };
    if opencode_existing::credential_reference(binding, &marker) != binding.credential_reference {
        return false;
    }
    if !std::fs::canonicalize(&binding.executable).is_ok_and(|expected| {
        table
            .executable(binding.server_pid)
            .and_then(|p| std::fs::canonicalize(p).ok())
            == Some(expected)
    }) {
        return false;
    }
    let private = |m: &std::fs::Metadata| m.uid() == binding.server_uid && m.mode() & 0o077 == 0;
    if !std::fs::symlink_metadata(&config.runtime).is_ok_and(|m| m.is_dir() && private(&m)) {
        return false;
    }
    let file = config
        .runtime
        .join(format!("{}.managed.json", binding.server_pid));
    if !std::fs::symlink_metadata(&file).is_ok_and(|m| m.is_file() && private(&m)) {
        return false;
    }
    let Some(value) = std::fs::File::open(file)
        .ok()
        .and_then(|f| serde_json::from_reader::<_, Value>(f.take(4097)).ok())
    else {
        return false;
    };
    value["version"] == super::PLUGIN_VERSION
        && value["pid"] == binding.server_pid
        && value["marker_sha256"].as_str()
            == Some(format!("{:x}", Sha256::digest(marker.as_bytes())).as_str())
        && table.process(binding.server_pid) == Some(process)
}

pub fn can_reply(
    managed: &ManagedSessions,
    config: &OpenCodeConfig,
    table: &dyn ProcessTable,
    target: &Target,
) -> bool {
    if target.kind != SessionKind::OpenCode {
        return false;
    }
    match managed.binding(target) {
        Some(ManagedBinding::OpenCode(binding)) => tagging_ready(config, table, &binding),
        _ => false,
    }
}

pub fn caller(
    managed: &ManagedSessions,
    config: &OpenCodeConfig,
    table: &dyn ProcessTable,
    server_pid: i32,
    claim: Option<&str>,
) -> Option<Target> {
    // The server can host several sessions or subagents. Its PID alone must
    // never lend a shell the identity of the one registration we know.
    let claim = claim.filter(|id| is_session_id(id))?;
    let matches: Vec<_> = managed
        .opencode_claims()
        .ok()?
        .into_iter()
        .filter(|b| b.server_pid == server_pid && b.session_id == claim)
        .collect();
    let [binding] = matches.as_slice() else {
        return None;
    };
    let target = Target::new(SessionKind::OpenCode, claim);
    if !tagging_ready(config, table, binding) {
        return None;
    }
    match managed.binding(&target) {
        Some(ManagedBinding::OpenCode(verified)) if verified == *binding => Some(target),
        _ => None,
    }
}

// Unix file modes; managed OpenCode is not available on Windows.
#[cfg(test)]
#[cfg(unix)]
mod tests;
