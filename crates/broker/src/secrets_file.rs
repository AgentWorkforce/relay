//! Out-of-argv transport for spawn credentials (relay#1570).
//!
//! Agent CLIs are configured through their own command lines — `codex --config
//! mcp_servers.agent-relay.env.X="…"`, `claude --mcp-config '<json>'` — so any
//! credential embedded in that configuration is visible in `ps -eo args` to
//! every other process on the host, including sibling agents.
//!
//! This module moves the credential *values* into a 0600 file and leaves only
//! its *path* on the command line. A path is not a secret. The Agent Relay MCP
//! server (`agent-relay mcp`) is our own binary, so it can read the values back
//! from [`RELAY_SECRETS_FILE_ENV`] at startup — which is why this indirection
//! works uniformly for every CLI we configure, instead of depending on each
//! one's (unreliable) parent-env passthrough.

use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

use anyhow::{Context, Result};
use sha2::{Digest, Sha256};
use uuid::Uuid;

/// Env var naming the file that carries this spawn's secret env pairs.
pub const RELAY_SECRETS_FILE_ENV: &str = "RELAY_SECRETS_FILE";

/// Env vars whose *values* are credentials and must never reach argv.
///
/// `RELAY_WORKSPACES_JSON` is on this list because the blob embeds one
/// `api_key` per workspace entry — it leaks the same `rk_live_` material as
/// `RELAY_API_KEY`, just one JSON level down.
pub const SECRET_ENV_KEYS: &[&str] = &[
    "RELAY_API_KEY",
    "RELAY_AGENT_TOKEN",
    "RELAY_WORKSPACES_JSON",
    // Per-spawn result callback bearer token. Not part of the `rk_live_` /
    // `at_live_` families the issue was filed against, but it reaches argv by
    // exactly the same route and is exactly as usable by a reader of `ps`.
    "AGENT_RELAY_RESULT_TOKEN",
];

/// Secrets files older than this are pruned on the next write. They are only
/// needed for as long as the CLI may (re-)spawn its MCP server, so a week is
/// generous; pruning keeps a long-lived host from accumulating them forever.
const STALE_AFTER: Duration = Duration::from_secs(7 * 24 * 60 * 60);

#[cfg(unix)]
const DIR_MODE: u32 = 0o700;
#[cfg(unix)]
const FILE_MODE: u32 = 0o600;

pub fn is_secret_env_key(key: &str) -> bool {
    SECRET_ENV_KEYS.contains(&key)
}

/// Split `pairs` into the non-secret pairs plus a single `RELAY_SECRETS_FILE`
/// entry pointing at a 0600 file that holds the secret ones.
///
/// Relative order of the non-secret pairs is preserved, and the file reference
/// is appended last, so callers that emit args in list order stay stable.
pub fn externalize_secret_env(
    agent_name: &str,
    pairs: Vec<(String, String)>,
) -> Result<Vec<(String, String)>> {
    let dir = secrets_dir().context("cannot resolve a directory for the secrets file")?;
    externalize_secret_env_in(&dir, agent_name, pairs)
}

/// [`externalize_secret_env`] against an explicit directory. Keeping the
/// directory a parameter lets tests exercise the real write path in a tempdir
/// instead of mutating process-global env, which would race other tests.
pub fn externalize_secret_env_in(
    dir: &Path,
    agent_name: &str,
    pairs: Vec<(String, String)>,
) -> Result<Vec<(String, String)>> {
    let (secret, mut public): (Vec<_>, Vec<_>) = pairs
        .into_iter()
        .partition(|(key, value)| is_secret_env_key(key) && !value.trim().is_empty());

    if secret.is_empty() {
        return Ok(public);
    }

    let path = write_secrets_file_in(dir, agent_name, &secret)?;
    public.push((
        RELAY_SECRETS_FILE_ENV.to_string(),
        path.to_string_lossy().into_owned(),
    ));
    Ok(public)
}

/// Write `pairs` as a JSON object to a 0600 file and return its path.
///
/// The filename is content-addressed: the same credentials for the same agent
/// always resolve to the same file. That keeps the generated argv deterministic
/// (two identical spawn computations produce byte-identical args), makes repeat
/// calls idempotent instead of littering the directory, and lets concurrent
/// writers race harmlessly — they are writing identical bytes.
pub fn write_secrets_file_in(
    dir: &Path,
    agent_name: &str,
    pairs: &[(String, String)],
) -> Result<PathBuf> {
    fs::create_dir_all(dir)
        .with_context(|| format!("cannot create secrets directory {}", dir.display()))?;
    harden_dir(dir);
    prune_stale(dir);

    let map: BTreeMap<&str, &str> = pairs
        .iter()
        .map(|(key, value)| (key.as_str(), value.as_str()))
        .collect();
    let body = serde_json::to_string(&map).context("cannot serialize secrets file")?;

    let mut hasher = Sha256::new();
    hasher.update(agent_name.as_bytes());
    hasher.update([0u8]);
    hasher.update(body.as_bytes());
    let digest = format!("{:x}", hasher.finalize());

    let path = dir.join(format!("{}-{}.json", sanitize(agent_name), &digest[..16]));
    write_private(&path, &body)
        .with_context(|| format!("cannot write secrets file {}", path.display()))?;
    Ok(path)
}

/// `AGENT_RELAY_SECRETS_DIR` lets an operator place these on a tmpfs (or a
/// CI job point them at a scratch dir) instead of the user's home.
fn secrets_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("AGENT_RELAY_SECRETS_DIR") {
        let dir = PathBuf::from(dir);
        if !dir.as_os_str().is_empty() {
            return Some(dir);
        }
    }
    dirs::home_dir().map(|home| home.join(".agent-relay").join("secrets"))
}

/// Write via a private temp file and rename into place.
///
/// The mode is set *at creation*, never by a later `chmod`: writing first and
/// tightening after would leave a window where the credentials are readable by
/// anyone — precisely the exposure this module exists to close. The rename is
/// atomic, so a concurrent reader never observes a partial file, and it
/// refreshes the mtime that [`prune_stale`] keys off when a content-addressed
/// path is reused by a later spawn.
fn write_private(path: &Path, body: &str) -> std::io::Result<()> {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    let temp = dir.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("secrets"),
        Uuid::new_v4()
    ));

    let result = (|| -> std::io::Result<()> {
        #[cfg(unix)]
        {
            use std::io::Write as _;
            use std::os::unix::fs::OpenOptionsExt as _;

            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(FILE_MODE)
                .open(&temp)?;
            file.write_all(body.as_bytes())?;
            file.sync_all()?;
        }
        #[cfg(not(unix))]
        {
            // Windows has no mode bits here; the parent directory sits under
            // the user profile, which is already ACL-scoped to the user.
            fs::write(&temp, body)?;
        }
        fs::rename(&temp, path)
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn harden_dir(dir: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let _ = fs::set_permissions(dir, fs::Permissions::from_mode(DIR_MODE));
    }
    #[cfg(not(unix))]
    let _ = dir;
}

/// Best-effort removal of expired secrets files. Never fails a spawn.
fn prune_stale(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        // Never prune a rename-in-progress temp file out from under a writer.
        if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with('.'))
        {
            continue;
        }
        let expired = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age > STALE_AFTER);
        if expired {
            let _ = fs::remove_file(&path);
        }
    }
}

/// Keep the agent name recognizable in the filename without letting it escape
/// the directory or inject separators.
fn sanitize(agent_name: &str) -> String {
    let cleaned: String = agent_name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .take(64)
        .collect();
    let trimmed = cleaned.trim_matches('-');
    if trimmed.is_empty() {
        "agent".to_string()
    } else {
        trimmed.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn pairs(items: &[(&str, &str)]) -> Vec<(String, String)> {
        items
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect()
    }

    fn read_back(path: &str) -> BTreeMap<String, String> {
        serde_json::from_str(&fs::read_to_string(path).expect("read secrets file"))
            .expect("parse secrets file")
    }

    #[test]
    fn credentials_leave_argv_and_non_secrets_stay() {
        let dir = tempdir().expect("tempdir");
        let result = externalize_secret_env_in(
            dir.path(),
            "worker",
            pairs(&[
                ("RELAY_AGENT_NAME", "worker"),
                ("RELAY_API_KEY", "rk_live_abc"),
                ("RELAY_BASE_URL", "https://cast.agentrelay.com"),
                ("RELAY_AGENT_TOKEN", "at_live_def"),
                ("RELAY_WORKSPACES_JSON", r#"[{"api_key":"rk_live_ghi"}]"#),
                ("AGENT_RELAY_RESULT_TOKEN", "arr_jkl"),
                ("RELAY_SKIP_BOOTSTRAP", "1"),
            ]),
        )
        .expect("externalize");

        let inline = result
            .iter()
            .map(|(key, value)| format!("{key}={value}"))
            .collect::<Vec<_>>()
            .join(" ");

        // Nothing credential-shaped may survive into the arg list.
        for secret in ["rk_live_abc", "at_live_def", "rk_live_ghi", "arr_jkl"] {
            assert!(
                !inline.contains(secret),
                "credential leaked into argv: {secret} in {inline}"
            );
        }

        // Non-secret configuration must stay inline so a spawn is debuggable.
        assert!(inline.contains("RELAY_AGENT_NAME=worker"));
        assert!(inline.contains("RELAY_BASE_URL=https://cast.agentrelay.com"));
        assert!(inline.contains("RELAY_SKIP_BOOTSTRAP=1"));

        // ...and every credential must still be delivered, via the file.
        let path = result
            .iter()
            .find(|(key, _)| key == RELAY_SECRETS_FILE_ENV)
            .map(|(_, value)| value.clone())
            .expect("RELAY_SECRETS_FILE reference");
        let secrets = read_back(&path);
        assert_eq!(secrets["RELAY_API_KEY"], "rk_live_abc");
        assert_eq!(secrets["RELAY_AGENT_TOKEN"], "at_live_def");
        assert_eq!(
            secrets["RELAY_WORKSPACES_JSON"],
            r#"[{"api_key":"rk_live_ghi"}]"#
        );
        assert_eq!(secrets["AGENT_RELAY_RESULT_TOKEN"], "arr_jkl");
        assert_eq!(secrets.len(), 4, "only credentials belong in the file");
    }

    #[cfg(unix)]
    #[test]
    fn secrets_file_is_not_readable_by_other_users() {
        use std::os::unix::fs::PermissionsExt as _;

        let dir = tempdir().expect("tempdir");
        let path = write_secrets_file_in(
            dir.path(),
            "worker",
            &pairs(&[("RELAY_API_KEY", "rk_live_abc")]),
        )
        .expect("write secrets file");

        let mode = fs::metadata(&path).expect("metadata").permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "secrets file must be owner-read/write only");

        let dir_mode = fs::metadata(dir.path())
            .expect("dir metadata")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(dir_mode, 0o700, "secrets directory must be owner-only");
    }

    #[test]
    fn identical_inputs_produce_identical_args() {
        // The generated argv must stay deterministic: callers (and tests)
        // compare two independent computations of the same spawn for equality.
        let dir = tempdir().expect("tempdir");
        let input = pairs(&[("RELAY_API_KEY", "rk_live_abc")]);

        let first = externalize_secret_env_in(dir.path(), "worker", input.clone()).expect("first");
        let second = externalize_secret_env_in(dir.path(), "worker", input).expect("second");

        assert_eq!(first, second);
        let files: Vec<_> = fs::read_dir(dir.path())
            .expect("read dir")
            .flatten()
            .map(|entry| entry.file_name())
            .collect();
        assert_eq!(files.len(), 1, "repeat calls must not litter: {files:?}");
    }

    #[test]
    fn different_credentials_produce_different_files() {
        let dir = tempdir().expect("tempdir");
        let first = externalize_secret_env_in(
            dir.path(),
            "worker",
            pairs(&[("RELAY_API_KEY", "rk_live_one")]),
        )
        .expect("first");
        let second = externalize_secret_env_in(
            dir.path(),
            "worker",
            pairs(&[("RELAY_API_KEY", "rk_live_two")]),
        )
        .expect("second");
        assert_ne!(first, second, "a rotated key must not reuse the old file");
    }

    #[test]
    fn no_secrets_means_no_file() {
        let dir = tempdir().expect("tempdir");
        let result = externalize_secret_env_in(
            dir.path(),
            "worker",
            pairs(&[("RELAY_AGENT_NAME", "worker"), ("RELAY_API_KEY", "")]),
        )
        .expect("externalize");

        assert!(
            !result.iter().any(|(key, _)| key == RELAY_SECRETS_FILE_ENV),
            "an empty credential must not mint a file"
        );
        assert_eq!(result.len(), 2, "the empty pair is left as-is, not dropped");
    }

    #[test]
    fn agent_name_cannot_escape_the_secrets_directory() {
        let dir = tempdir().expect("tempdir");
        let path = write_secrets_file_in(
            dir.path(),
            "../../etc/evil",
            &pairs(&[("RELAY_API_KEY", "rk_live_abc")]),
        )
        .expect("write secrets file");

        assert_eq!(
            path.parent(),
            Some(dir.path()),
            "a hostile agent name must not redirect the write: {}",
            path.display()
        );
    }
}
