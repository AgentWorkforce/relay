//! Pure Factory MCP migration planning. Ownership comes from a private app record
//! captured at installation, never from a marker or a matching command alone.
//! This module does not read/write files or authorize provider startup.
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::path::Path;

pub const SERVER_NAME: &str = "agent-relay";
const MAX_BYTES: usize = 1024 * 1024;
const RELAY_ENV: &[&str] = &[
    "RELAY_AGENT_NAME",
    "RELAY_AGENT_TOKEN",
    "RELAY_AGENT_TYPE",
    "RELAY_API_KEY",
    "RELAY_BASE_URL",
    "RELAY_DEFAULT_WORKSPACE",
    "RELAY_SKIP_BOOTSTRAP",
    "RELAY_STRICT_AGENT_NAME",
    "RELAY_WORKSPACES_JSON",
];

/// Supply only a record saved by the app when it installed this exact entry.
/// Computing a new record from an untrusted existing config does not prove ownership.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OwnedEntryRecord {
    pub source_id: String,
    pub name: String,
    pub entry_sha256: String,
}

pub enum LocalConfig<'a> {
    Missing,
    Readable(&'a Value),
    Unavailable,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Blocker {
    OrganizationSourcesUnverified,
    EffectiveReloadUnverified,
    UnprovenRelayEntry { entry_sha256: String },
    UnrecognizedOwnedEntry { entry_sha256: String },
    CanonicalNameOccupied,
    ConflictingEnabledState,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConfigError {
    UnavailableSource,
    InvalidDocument,
    InvalidHelper,
    InvalidSourceId,
    TooLarge,
}
impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::UnavailableSource => "Factory MCP configuration could not be inspected",
            Self::InvalidDocument => "Factory MCP configuration has an unsupported shape",
            Self::InvalidHelper => "Factory MCP requires an absolute app helper path",
            Self::InvalidSourceId => "Factory MCP configuration source is not identified",
            Self::TooLarge => "Factory MCP configuration exceeds the inspection limit",
        })
    }
}
impl std::error::Error for ConfigError {}

/// A prospective document and its compare-before-write fingerprints. The caller
/// owns permission checks, atomic persistence and the separate private ownership
/// record. Neither this plan nor a successful write proves effective-source safety.
pub struct MigrationPlan {
    document: Value,
    pub before_sha256: String,
    pub after_sha256: String,
    pub owned_entry: Option<OwnedEntryRecord>,
    pub migrated_entries: usize,
    pub blockers: Vec<Blocker>,
}
impl std::fmt::Debug for MigrationPlan {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MigrationPlan")
            .field("before_sha256", &self.before_sha256)
            .field("after_sha256", &self.after_sha256)
            .field("migrated_entries", &self.migrated_entries)
            .field("blockers", &self.blockers)
            .finish_non_exhaustive()
    }
}
impl MigrationPlan {
    pub fn document(&self) -> &Value {
        &self.document
    }
    pub fn changed(&self) -> bool {
        self.before_sha256 != self.after_sha256
    }
}

/// Encode a credential-free app command. The caller must select the verified
/// app binary; an absolute path alone is not executable-authenticity proof.
/// Factory config uses an object entry, unlike initialize.mcpServers' wire shape.
pub fn definition(helper: &Path, development: bool) -> Result<Value, ConfigError> {
    if !helper.is_absolute() || helper.file_name().is_none() || helper.to_str().is_none() {
        return Err(ConfigError::InvalidHelper);
    }
    let args = if development {
        vec!["droid-spawn-mcp", "--dev"]
    } else {
        vec!["droid-spawn-mcp"]
    };
    Ok(json!({"type":"stdio","command":helper,"args":args,"disabled":false}))
}

/// Plan only local convergence. Unknown organization settings and configuration
/// reload are always explicit blockers: no documented effective-source proof is
/// currently available. Unproven entries are preserved, never silently adopted.
pub fn plan(
    source_id: &str,
    config: LocalConfig<'_>,
    records: &[OwnedEntryRecord],
    helper: &Path,
    development: bool,
) -> Result<MigrationPlan, ConfigError> {
    if source_id.is_empty() || source_id.len() > 4096 || source_id.contains('\0') {
        return Err(ConfigError::InvalidSourceId);
    }
    let desired = definition(helper, development)?;
    let mut document = match config {
        LocalConfig::Missing => json!({}),
        LocalConfig::Readable(value) => {
            validate_bound(value)?;
            value.clone()
        }
        LocalConfig::Unavailable => return Err(ConfigError::UnavailableSource),
    };
    let root = document
        .as_object_mut()
        .ok_or(ConfigError::InvalidDocument)?;
    let original = root.get("mcpServers").cloned().unwrap_or_else(|| json!({}));
    let servers = original.as_object().ok_or(ConfigError::InvalidDocument)?;
    let before_sha256 = entry_digest(&document)?;
    let (owned, mut blockers) = inspect(source_id, servers, records)?;
    let collision =
        servers.contains_key(SERVER_NAME) && !owned.iter().any(|(name, _)| name == SERVER_NAME);
    if collision {
        blockers.push(Blocker::CanonicalNameOccupied);
    }
    let mixed =
        owned.iter().any(|(_, disabled)| *disabled) && owned.iter().any(|(_, disabled)| !*disabled);
    if mixed {
        blockers.push(Blocker::ConflictingEnabledState);
    }
    let mut migrated_entries = 0;
    let mut installed = None;
    if !collision && !mixed {
        let mut replacement = servers.clone();
        for (name, _) in &owned {
            replacement.remove(name);
        }
        let mut desired = desired;
        desired["disabled"] = json!(owned.first().is_some_and(|(_, disabled)| *disabled));
        replacement.insert(SERVER_NAME.into(), desired.clone());
        document["mcpServers"] = Value::Object(replacement);
        migrated_entries = owned.len();
        installed = Some(OwnedEntryRecord {
            source_id: source_id.into(),
            name: SERVER_NAME.into(),
            entry_sha256: entry_digest(&desired)?,
        });
    }
    let after_sha256 = entry_digest(&document)?;
    Ok(MigrationPlan {
        document,
        before_sha256,
        after_sha256,
        owned_entry: installed,
        migrated_entries,
        blockers,
    })
}

fn inspect(
    source_id: &str,
    servers: &Map<String, Value>,
    records: &[OwnedEntryRecord],
) -> Result<(Vec<(String, bool)>, Vec<Blocker>), ConfigError> {
    let mut owned = Vec::new();
    let mut blockers = vec![
        Blocker::OrganizationSourcesUnverified,
        Blocker::EffectiveReloadUnverified,
    ];
    for (name, entry) in servers {
        let digest = entry_digest(entry)?;
        let proven = records.iter().any(|record| {
            record.source_id == source_id && record.name == *name && record.entry_sha256 == digest
        });
        if proven && recognized(entry) {
            owned.push((name.clone(), entry["disabled"].as_bool().unwrap_or(false)));
        } else if proven {
            blockers.push(Blocker::UnrecognizedOwnedEntry {
                entry_sha256: digest,
            });
        } else if relay_candidate(name, entry) {
            blockers.push(Blocker::UnprovenRelayEntry {
                entry_sha256: digest,
            });
        }
    }
    Ok((owned, blockers))
}

fn recognized(entry: &Value) -> bool {
    let Some(object) = entry.as_object() else {
        return false;
    };
    if object.keys().any(|key| {
        !matches!(
            key.as_str(),
            "type" | "command" | "args" | "env" | "disabled"
        )
    }) || object.get("type").is_some_and(|kind| kind != "stdio")
        || object
            .get("disabled")
            .is_some_and(|value| !value.is_boolean())
    {
        return false;
    }
    let Some(command) = entry["command"].as_str() else {
        return false;
    };
    let Some(args) = entry["args"]
        .as_array()
        .and_then(|a| a.iter().map(Value::as_str).collect::<Option<Vec<_>>>())
    else {
        return false;
    };
    let empty = Map::new();
    let Some(env) = object
        .get("env")
        .map(Value::as_object)
        .unwrap_or(Some(&empty))
    else {
        return false;
    };
    if env
        .iter()
        .any(|(key, value)| !RELAY_ENV.contains(&key.as_str()) || !value.is_string())
    {
        return false;
    }
    let binary = command.rsplit(['/', '\\']).next().unwrap_or("");
    let legacy = (matches!(binary, "npx" | "npx.cmd")
        && matches!(
            args.as_slice(),
            ["-y", "agent-relay", "mcp"] | ["--yes", "agent-relay", "mcp"] | ["agent-relay", "mcp"]
        ))
        || (matches!(binary, "agent-relay" | "agent-relay.cmd") && args == ["mcp"]);
    let managed = Path::new(command).is_absolute()
        && env.is_empty()
        && matches!(
            args.as_slice(),
            ["droid-spawn-mcp"] | ["droid-spawn-mcp", "--dev"]
        );
    legacy || managed
}

fn relay_candidate(name: &str, entry: &Value) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "agent-relay" | "agentrelay" | "relayhistory"
    ) || entry.get("agentRelayManagedBy").is_some()
        || entry["command"]
            .as_str()
            .is_some_and(|s| s.contains("agent-relay"))
        || entry["args"].as_array().is_some_and(|args| {
            args.iter().any(|a| {
                a.as_str()
                    .is_some_and(|s| s.contains("agent-relay") || s == "droid-spawn-mcp")
            })
        })
        || entry["env"]
            .as_object()
            .is_some_and(|env| env.keys().any(|key| RELAY_ENV.contains(&key.as_str())))
}

/// Canonical value digest for a trusted install record or a compare-before-write
/// snapshot. Bounded parsing/persistence of the file remains the caller's job.
pub fn entry_digest(value: &Value) -> Result<String, ConfigError> {
    validate_bound(value)?;
    let bytes = serde_json::to_vec(&canonical(value)).map_err(|_| ConfigError::InvalidDocument)?;
    if bytes.len() > MAX_BYTES {
        return Err(ConfigError::TooLarge);
    }
    Ok(format!("{:x}", Sha256::digest(bytes)))
}
fn canonical(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<_> = map.keys().collect();
            keys.sort();
            Value::Object(
                keys.into_iter()
                    .map(|key| (key.clone(), canonical(&map[key])))
                    .collect(),
            )
        }
        Value::Array(rows) => Value::Array(rows.iter().map(canonical).collect()),
        _ => value.clone(),
    }
}
fn validate_bound(value: &Value) -> Result<(), ConfigError> {
    let mut pending = vec![(value, 0)];
    let (mut nodes, mut bytes) = (0, 0);
    while let Some((value, depth)) = pending.pop() {
        nodes += 1;
        if depth > 32 || nodes > 16384 {
            return Err(ConfigError::TooLarge);
        }
        match value {
            Value::Object(map) => {
                bytes += map.keys().map(String::len).sum::<usize>();
                pending.extend(map.values().map(|v| (v, depth + 1)));
            }
            Value::Array(rows) => pending.extend(rows.iter().map(|v| (v, depth + 1))),
            Value::String(text) => bytes += text.len(),
            _ => bytes += 8,
        }
        if bytes > MAX_BYTES {
            return Err(ConfigError::TooLarge);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
