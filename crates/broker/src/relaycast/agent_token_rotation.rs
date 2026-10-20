//! Proactive rotation of short-lived Relaycast agent tokens (`at_live_`) in
//! run-token mode.
//!
//! Relaycast #550 gives every newly issued agent token a 15-minute expiry
//! (`token_expires_at` on registration and rotation responses). An expired
//! token can neither authenticate nor self-rotate, and run-token mode has no
//! workspace key to take an identity over. So the broker rotates every agent
//! token it owns (its own and each worker's) through
//! `POST /v1/agents/:name/rotate-token`, authenticated by that agent's current
//! `at_live_` token, well before expiry.
//!
//! Workers never receive a static token in this mode. Each gets
//! `RELAY_AGENT_TOKEN_FILE`, pointing at a per-worker access-only file
//! (`{"token":"at_live_...","expiresAt":"<ISO8601>"}`) in a broker-owned 0700
//! directory. The broker replaces that file atomically (0600 temp file, then
//! rename) on every rotation, and the worker's MCP server/CLI reads it per
//! request.
//!
//! Token values never appear in logs or error messages.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::time::Duration;

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use sha2::{Digest, Sha256};

/// Env var naming a worker's agent token file (replaces `RELAY_AGENT_TOKEN`
/// in run-token mode).
pub const AGENT_TOKEN_FILE_ENV: &str = "RELAY_AGENT_TOKEN_FILE";

/// Rotate no later than this long before expiry.
pub const ROTATE_BEFORE_EXPIRY: Duration = Duration::from_secs(5 * 60);

/// A token whose expiry is unknown (supplied by a caller, or issued by an
/// engine that predates #550) is rotated once after this delay so the
/// rotation response reveals its real expiry.
pub const UNKNOWN_EXPIRY_PROBE_DELAY: Duration = Duration::from_secs(60);

/// Backoff between attempts after a transient rotation failure. Relaycast
/// keeps the previous token valid for a 60-second grace window (never past its
/// own expiry), so a rotation whose response was lost can be retried with the
/// token we still hold.
pub const ROTATION_RETRY_BACKOFFS: [Duration; 5] = [
    Duration::from_secs(2),
    Duration::from_secs(5),
    Duration::from_secs(10),
    Duration::from_secs(20),
    Duration::from_secs(30),
];

/// Internal marker that lets the existing MCP-config builders, which take the
/// worker's credential as `Option<&str>`, carry a token *file* reference
/// instead of a token value. It never leaves the broker: [`agent_token_env`]
/// turns it into `RELAY_AGENT_TOKEN_FILE=<path>` at every emission point.
const AGENT_TOKEN_FILE_REF_PREFIX: &str = "relay-agent-token-file:";

/// Encode a worker token file path as a credential reference for the MCP
/// config builders.
pub fn agent_token_file_ref(path: &Path) -> String {
    format!("{AGENT_TOKEN_FILE_REF_PREFIX}{}", path.display())
}

/// The env entry a worker credential becomes: `RELAY_AGENT_TOKEN_FILE=<path>`
/// for a file reference, otherwise `RELAY_AGENT_TOKEN=<token>` (legacy).
pub fn agent_token_env(credential: &str) -> (&'static str, String) {
    match credential.strip_prefix(AGENT_TOKEN_FILE_REF_PREFIX) {
        Some(path) => (AGENT_TOKEN_FILE_ENV, path.to_string()),
        None => ("RELAY_AGENT_TOKEN", credential.to_string()),
    }
}

/// Clock seam so rotation scheduling can be tested with a fake clock.
pub trait RotationClock: Send + Sync {
    fn now(&self) -> DateTime<Utc>;
    fn sleep(&self, duration: Duration) -> Pin<Box<dyn Future<Output = ()> + Send>>;
}

/// Wall clock plus tokio timers.
pub struct SystemRotationClock;

impl RotationClock for SystemRotationClock {
    fn now(&self) -> DateTime<Utc> {
        Utc::now()
    }

    fn sleep(&self, duration: Duration) -> Pin<Box<dyn Future<Output = ()> + Send>> {
        Box::pin(tokio::time::sleep(duration))
    }
}

/// When to rotate a token that expires at `expires_at`: at two thirds of the
/// remaining lifetime or [`ROTATE_BEFORE_EXPIRY`] before expiry, whichever is
/// earlier. A token already inside that window rotates immediately.
pub fn rotation_delay(now: DateTime<Utc>, expires_at: DateTime<Utc>) -> Duration {
    let Ok(lifetime) = (expires_at - now).to_std() else {
        return Duration::ZERO;
    };
    let two_thirds = lifetime.mul_f64(2.0 / 3.0);
    let before_expiry = lifetime.saturating_sub(ROTATE_BEFORE_EXPIRY);
    two_thirds.min(before_expiry)
}

/// `POST /v1/agents/:name/rotate-token` response, including the #550 expiry
/// the SDK type does not yet carry.
#[derive(Debug, Deserialize)]
pub struct RotateTokenResponse {
    pub token: String,
    #[serde(default)]
    pub token_expires_at: Option<String>,
}

/// Parse a Relaycast `token_expires_at` value. Malformed values are treated as
/// unknown (and therefore rotated soon), never as "no expiry".
pub fn parse_token_expiry(raw: Option<&str>) -> Option<DateTime<Utc>> {
    raw.map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.with_timezone(&Utc))
}

/// Deterministic per-worker file path inside the broker-owned token
/// directory. The name is sanitized for the filesystem and suffixed with a
/// hash so distinct agent names never collide.
pub fn worker_agent_token_file(dir: &Path, agent_name: &str) -> PathBuf {
    let sanitized: String = agent_name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .take(64)
        .collect();
    let digest = format!("{:x}", Sha256::digest(agent_name.as_bytes()));
    dir.join(format!("{sanitized}-{}.json", &digest[..12]))
}

/// Create (or tighten) the broker-owned token directory to mode 0700.
pub fn ensure_agent_token_dir(dir: &Path) -> Result<()> {
    std::fs::create_dir_all(dir)
        .with_context(|| format!("failed to create agent token directory {}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).with_context(
            || {
                format!(
                    "failed to set mode 0700 on agent token directory {}",
                    dir.display()
                )
            },
        )?;
    }
    Ok(())
}

/// Atomically replace a worker's access-only token file: write a 0600 temp
/// file in the same directory, fsync it, then rename it over the target. A
/// reader sees either the previous complete file or the new one, never a
/// partial write.
pub fn write_agent_token_file(
    path: &Path,
    token: &str,
    expires_at: Option<DateTime<Utc>>,
) -> Result<()> {
    use std::io::Write;

    let dir = path
        .parent()
        .context("agent token file path has no parent directory")?;
    ensure_agent_token_dir(dir)?;
    let mut body = serde_json::Map::new();
    body.insert("token".into(), serde_json::Value::String(token.to_string()));
    if let Some(expires_at) = expires_at {
        body.insert(
            "expiresAt".into(),
            serde_json::Value::String(expires_at.to_rfc3339()),
        );
    }
    let tmp = dir.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("agent-token"),
        uuid::Uuid::new_v4().simple()
    ));
    let write = || -> Result<()> {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&tmp)
            .with_context(|| format!("failed to create {}", tmp.display()))?;
        file.write_all(serde_json::Value::Object(body).to_string().as_bytes())
            .context("failed to write agent token file")?;
        file.sync_all().context("failed to sync agent token file")?;
        std::fs::rename(&tmp, path).with_context(|| {
            format!(
                "failed to move agent token file into place at {}",
                path.display()
            )
        })?;
        Ok(())
    };
    let result = write();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    use super::*;

    /// Fake clock: `sleep` advances virtual time instantly for the first
    /// `allowed` sleeps, records every requested duration, and parks forever
    /// afterwards so a rotation loop cannot spin.
    pub(crate) struct FakeRotationClock {
        now: Mutex<DateTime<Utc>>,
        pub(crate) sleeps: Mutex<Vec<Duration>>,
        allowed: AtomicUsize,
    }

    impl FakeRotationClock {
        pub(crate) fn new(start: DateTime<Utc>, allowed: usize) -> Self {
            Self {
                now: Mutex::new(start),
                sleeps: Mutex::new(Vec::new()),
                allowed: AtomicUsize::new(allowed),
            }
        }
    }

    impl RotationClock for FakeRotationClock {
        fn now(&self) -> DateTime<Utc> {
            *self.now.lock().unwrap()
        }

        fn sleep(&self, duration: Duration) -> Pin<Box<dyn Future<Output = ()> + Send>> {
            self.sleeps.lock().unwrap().push(duration);
            let permitted = self
                .allowed
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |left| {
                    left.checked_sub(1)
                })
                .is_ok();
            if permitted {
                let mut now = self.now.lock().unwrap();
                *now += chrono::Duration::from_std(duration).unwrap();
                Box::pin(std::future::ready(()))
            } else {
                Box::pin(std::future::pending())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(minutes: i64) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-10-17T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
            + chrono::Duration::minutes(minutes)
    }

    #[test]
    fn rotation_happens_at_the_earlier_of_two_thirds_or_five_minutes_before_expiry() {
        // 15 minutes: both rules give 10 minutes.
        assert_eq!(rotation_delay(at(0), at(15)), Duration::from_secs(600));
        // 60 minutes (policy cap): two thirds (40m) is earlier than 55m.
        assert_eq!(rotation_delay(at(0), at(60)), Duration::from_secs(2400));
        // 6 minutes: five minutes before expiry (1m) is earlier than 4m.
        assert_eq!(rotation_delay(at(0), at(6)), Duration::from_secs(60));
        // Inside the window or already expired: rotate now.
        assert_eq!(rotation_delay(at(0), at(3)), Duration::ZERO);
        assert_eq!(rotation_delay(at(10), at(5)), Duration::ZERO);
    }

    #[test]
    fn file_refs_become_token_file_env_and_tokens_stay_legacy() {
        let path = Path::new("/run/agent-tokens/w-abc.json");
        assert_eq!(
            agent_token_env(&agent_token_file_ref(path)),
            (
                AGENT_TOKEN_FILE_ENV,
                "/run/agent-tokens/w-abc.json".to_string()
            )
        );
        assert_eq!(
            agent_token_env("at_live_x"),
            ("RELAY_AGENT_TOKEN", "at_live_x".to_string())
        );
    }

    #[test]
    fn worker_file_names_are_sanitized_and_distinct() {
        let dir = Path::new("/tmp/tokens");
        let a = worker_agent_token_file(dir, "../evil name");
        let b = worker_agent_token_file(dir, "../evil_name");
        assert_eq!(a.parent(), Some(dir));
        assert!(!a.file_name().unwrap().to_str().unwrap().contains('/'));
        assert_ne!(a, b);
    }

    #[cfg(unix)]
    #[test]
    fn token_file_is_replaced_atomically_with_mode_0600_in_a_0700_dir() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};

        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("agent-tokens");
        let path = worker_agent_token_file(&dir, "worker-1");

        write_agent_token_file(&path, "at_live_first", Some(at(15))).unwrap();
        let first_inode = std::fs::metadata(&path).unwrap().ino();
        write_agent_token_file(&path, "at_live_second", Some(at(30))).unwrap();
        let meta = std::fs::metadata(&path).unwrap();

        assert_eq!(meta.permissions().mode() & 0o777, 0o600);
        assert_eq!(
            std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
        // Rename, not in-place rewrite: a reader never sees a torn file.
        assert_ne!(meta.ino(), first_inode);
        let body: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(body["token"], "at_live_second");
        assert_eq!(body["expiresAt"], at(30).to_rfc3339());
        assert!(body.get("refreshToken").is_none());
        // No temp files left behind.
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn malformed_expiry_is_unknown() {
        assert_eq!(parse_token_expiry(Some("not a date")), None);
        assert_eq!(parse_token_expiry(None), None);
        assert_eq!(
            parse_token_expiry(Some("2026-10-17T12:15:00.000Z")),
            Some(at(15))
        );
    }
}
