//! Run-scoped Relaycast credential (`rt_live_…`, "run token").
//!
//! A system-held flow sandbox gets no static workspace key (`rk_live_…`).
//! Instead the launcher (Cloud) points `RELAY_RUN_TOKEN_FILE` at an
//! access-only JSON file `{"token":"rt_live_…","expiresAt":"<ISO8601>"}` and
//! atomically replaces it before the token expires.
//!
//! Contract for this module (relay-briefs/run-token-contract.md §2, §4):
//!
//! - The file is read on **every** request. The token value is never cached
//!   beyond one request and never copied into env, argv, or other files.
//! - A 401 re-reads the file and retries exactly once (the launcher may have
//!   rotated the token between our read and the server's check).
//! - Relaycast accepts a run token only on `POST /v1/agents`,
//!   `DELETE /v1/agents/:name`, and `POST /v1/nodes` (relaycast #559). Every
//!   other route, including `GET /v1/agents/:name` and the WebSocket
//!   upgrades, rejects it with `401 run_token_forbidden`.
//! - Run-token mode never creates a workspace; there is no `rk_` key to fall
//!   back to and minting one would escape the run's authority.
//!
//! The token value never appears in `Debug` output or error messages.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde::Deserialize;

/// Env var naming the run token access file.
pub const RUN_TOKEN_FILE_ENV: &str = "RELAY_RUN_TOKEN_FILE";

/// Every Relaycast run token kind starts with this prefix (`rt_live_`,
/// `rt_test_`).
pub const RUN_TOKEN_PREFIX: &str = "rt_";

/// Static workspace credentials whose presence (with an `rk_` value) keeps the
/// broker in legacy workspace-key mode, and which must never be handed to
/// workers in run-token mode.
pub const WORKSPACE_KEY_ENV_VARS: [&str; 4] = [
    "AGENT_RELAY_WORKSPACE_KEY",
    "RELAY_WORKSPACE_KEY",
    "RELAY_API_KEY",
    "RELAY_WORKSPACES_JSON",
];

/// Non-secret bearer the broker's workspace-scoped SDK client is built with in
/// run-token mode. The SDK requires a non-empty key; run-token mode routes the
/// run-token-capable endpoints explicitly through [`RunTokenSource`] and the
/// rest through agent tokens, so any workspace-scoped call that still reaches
/// the server with this placeholder fails as a plain 401 without disclosing a
/// credential.
pub const RUN_TOKEN_MODE_PLACEHOLDER_BEARER: &str = "relay-run-token-mode-no-workspace-key";

/// Error text returned whenever run-token mode would otherwise mint a
/// workspace.
pub const RUN_TOKEN_NO_WORKSPACE_CREATION: &str =
    "refusing to create a Relaycast workspace: RELAY_RUN_TOKEN_FILE is set (run-token mode). \
     Run-token mode joins the run's existing workspace only; check that the launcher wrote a \
     valid run token file";

/// Location of the run token access file. Holds only the path, never the
/// token value, so it is safe to clone, store, and debug-print.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunTokenSource {
    path: PathBuf,
}

/// One read of the run token file. Lives for a single request.
pub struct RunToken {
    token: String,
    expires_at: Option<DateTime<Utc>>,
}

impl std::fmt::Debug for RunToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RunToken")
            .field("token", &"rt_[REDACTED]")
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

impl RunToken {
    /// The bearer value. Use it for exactly one request and drop it.
    pub fn secret(&self) -> &str {
        &self.token
    }

    pub fn expires_at(&self) -> Option<DateTime<Utc>> {
        self.expires_at
    }
}

#[derive(Deserialize)]
struct RunTokenFile {
    token: Option<String>,
    #[serde(default, alias = "expires_at")]
    #[serde(rename = "expiresAt")]
    expires_at: Option<String>,
}

/// True when `raw` holds a static Relaycast workspace key.
fn holds_workspace_key(raw: &str) -> bool {
    let trimmed = raw.trim();
    if trimmed.starts_with("rk_") {
        return true;
    }
    // RELAY_WORKSPACES_JSON embeds keys inside JSON.
    trimmed.contains("\"rk_")
}

impl RunTokenSource {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The configured run token file path, if any, regardless of whether a
    /// workspace key is also present. Used by the fail-closed workspace
    /// creation guard: when a launcher configured a run token, the broker must
    /// never mint a workspace, even if it ends up in legacy mode.
    pub fn configured_path_from_env() -> Option<PathBuf> {
        std::env::var(RUN_TOKEN_FILE_ENV)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
    }

    /// Run-token mode is active when `RELAY_RUN_TOKEN_FILE` is set and no
    /// static `rk_` workspace key is configured. A configured `rk_` key keeps
    /// the legacy path unchanged.
    pub fn from_env() -> Option<Self> {
        let path = Self::configured_path_from_env()?;
        let has_workspace_key = WORKSPACE_KEY_ENV_VARS.iter().any(|name| {
            std::env::var(name)
                .ok()
                .is_some_and(|value| holds_workspace_key(&value))
        });
        if has_workspace_key {
            tracing::warn!(
                target = "relay_broker::auth",
                "RELAY_RUN_TOKEN_FILE is set but a static workspace key is also configured; \
                 staying in legacy workspace-key mode"
            );
            return None;
        }
        Some(Self::new(path))
    }

    /// Read and validate the file. Called once per request; the returned value
    /// must not outlive that request.
    pub fn read(&self) -> Result<RunToken> {
        let raw = std::fs::read_to_string(&self.path)
            .with_context(|| format!("failed to read run token file {}", self.path.display()))?;
        // Deliberately discard serde's detail: its messages can quote input.
        let parsed: RunTokenFile = serde_json::from_str(&raw).map_err(|_| {
            anyhow::anyhow!(
                "run token file {} is not valid JSON of the form {{\"token\":\"rt_live_...\",\"expiresAt\":\"<ISO8601>\"}}",
                self.path.display()
            )
        })?;
        let token = parsed
            .token
            .map(|token| token.trim().to_string())
            .filter(|token| !token.is_empty())
            .with_context(|| format!("run token file {} has no token", self.path.display()))?;
        anyhow::ensure!(
            token.starts_with(RUN_TOKEN_PREFIX),
            "run token file {} does not hold a Relaycast run token (expected an rt_ prefix)",
            self.path.display()
        );
        let expires_at = match parsed
            .expires_at
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
        {
            Some(value) => Some(
                DateTime::parse_from_rfc3339(&value)
                    .with_context(|| {
                        format!(
                            "run token file {} has an invalid expiresAt (expected ISO8601)",
                            self.path.display()
                        )
                    })?
                    .with_timezone(&Utc),
            ),
            None => None,
        };
        Ok(RunToken { token, expires_at })
    }

    /// [`Self::read`], refusing a token the file itself reports as expired:
    /// sending it would only earn a 401, and the clear error tells an operator
    /// the launcher stopped refreshing.
    pub fn read_fresh(&self) -> Result<RunToken> {
        let token = self.read()?;
        if let Some(expires_at) = token.expires_at {
            anyhow::ensure!(
                expires_at > Utc::now(),
                "run token in {} expired at {}; the launcher has not refreshed it",
                self.path.display(),
                expires_at.to_rfc3339()
            );
        }
        Ok(token)
    }
}

/// Failure of a run-token-authenticated call: either the file could not be
/// read, or the request itself failed (after the single 401 retry).
#[derive(Debug)]
pub enum RunTokenCallError<E> {
    Read(anyhow::Error),
    Call(E),
}

impl<E: std::fmt::Display> std::fmt::Display for RunTokenCallError<E> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Read(error) => write!(f, "{error:#}"),
            Self::Call(error) => write!(f, "{error}"),
        }
    }
}

/// Run `op` with a freshly read run token. When `is_unauthorized` classifies
/// the failure as a 401, re-read the file and retry exactly once.
pub async fn call_with_run_token<T, E, F, Fut>(
    source: &RunTokenSource,
    is_unauthorized: impl Fn(&E) -> bool,
    mut op: F,
) -> std::result::Result<T, RunTokenCallError<E>>
where
    F: FnMut(String) -> Fut,
    Fut: std::future::Future<Output = std::result::Result<T, E>>,
{
    let token = source.read_fresh().map_err(RunTokenCallError::Read)?;
    match op(token.secret().to_string()).await {
        Err(error) if is_unauthorized(&error) => {
            drop(token);
            tracing::info!(
                target = "relay_broker::auth",
                path = %source.path().display(),
                "run token rejected with 401; re-reading the run token file and retrying once"
            );
            let token = source.read_fresh().map_err(RunTokenCallError::Read)?;
            op(token.secret().to_string())
                .await
                .map_err(RunTokenCallError::Call)
        }
        other => other.map_err(RunTokenCallError::Call),
    }
}

/// 401 classifier for SDK errors.
pub fn relay_error_is_unauthorized(error: &relaycast::RelayError) -> bool {
    matches!(error, relaycast::RelayError::Api { status: 401, .. })
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::path::Path;

    /// Atomically replace a run token file the way the launcher does
    /// (write a temp file, then rename).
    pub(crate) fn write_run_token_file(path: &Path, token: &str, expires_at: &str) {
        let tmp = path.with_extension("tmp");
        std::fs::write(
            &tmp,
            serde_json::json!({ "token": token, "expiresAt": expires_at }).to_string(),
        )
        .expect("write run token temp file");
        std::fs::rename(&tmp, path).expect("rename run token file");
    }

    pub(crate) fn future_expiry() -> String {
        (chrono::Utc::now() + chrono::Duration::minutes(15)).to_rfc3339()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use super::test_support::{future_expiry, write_run_token_file};
    use super::*;

    #[test]
    fn read_returns_the_current_file_contents_every_time() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("relaycast-run.json");
        let source = RunTokenSource::new(&path);

        write_run_token_file(&path, "rt_live_first", &future_expiry());
        assert_eq!(source.read_fresh().unwrap().secret(), "rt_live_first");

        write_run_token_file(&path, "rt_live_second", &future_expiry());
        assert_eq!(source.read_fresh().unwrap().secret(), "rt_live_second");
    }

    #[test]
    fn read_rejects_non_run_tokens_without_echoing_them() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("relaycast-run.json");
        write_run_token_file(&path, "rk_live_should_never_be_here", &future_expiry());
        let error = RunTokenSource::new(&path).read().unwrap_err().to_string();
        assert!(error.contains("rt_ prefix"), "{error}");
        assert!(!error.contains("rk_live_should_never_be_here"), "{error}");
    }

    #[test]
    fn read_rejects_malformed_json_without_echoing_input() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("relaycast-run.json");
        std::fs::write(&path, "{\"token\": rt_live_secret_value}").unwrap();
        let error = RunTokenSource::new(&path).read().unwrap_err().to_string();
        assert!(!error.contains("rt_live_secret_value"), "{error}");
    }

    #[test]
    fn read_fresh_refuses_an_expired_token() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("relaycast-run.json");
        write_run_token_file(&path, "rt_live_old", "2020-01-01T00:00:00Z");
        let error = RunTokenSource::new(&path)
            .read_fresh()
            .unwrap_err()
            .to_string();
        assert!(error.contains("expired"), "{error}");
        assert!(!error.contains("rt_live_old"), "{error}");
    }

    #[test]
    fn debug_output_never_contains_the_token() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("relaycast-run.json");
        write_run_token_file(&path, "rt_live_debug_secret", &future_expiry());
        let token = RunTokenSource::new(&path).read().unwrap();
        assert!(!format!("{token:?}").contains("rt_live_debug_secret"));
    }

    #[tokio::test]
    async fn a_401_rereads_the_file_and_retries_exactly_once() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("relaycast-run.json");
        write_run_token_file(&path, "rt_live_stale", &future_expiry());
        let source = RunTokenSource::new(&path);
        let seen = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let calls = Arc::new(AtomicUsize::new(0));

        let result = call_with_run_token(
            &source,
            |status: &u16| *status == 401,
            |token| {
                let seen = Arc::clone(&seen);
                let calls = Arc::clone(&calls);
                let path = path.clone();
                async move {
                    seen.lock().unwrap().push(token.clone());
                    if calls.fetch_add(1, Ordering::SeqCst) == 0 {
                        // The launcher rotates the file while the first
                        // request is in flight.
                        write_run_token_file(&path, "rt_live_rotated", &future_expiry());
                        Err(401u16)
                    } else {
                        Ok("done")
                    }
                }
            },
        )
        .await;

        assert_eq!(result.unwrap(), "done");
        assert_eq!(
            *seen.lock().unwrap(),
            vec!["rt_live_stale".to_string(), "rt_live_rotated".to_string()]
        );
    }

    #[tokio::test]
    async fn a_second_401_is_returned_without_another_retry() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("relaycast-run.json");
        write_run_token_file(&path, "rt_live_dead", &future_expiry());
        let calls = Arc::new(AtomicUsize::new(0));
        let result: std::result::Result<(), _> = call_with_run_token(
            &RunTokenSource::new(&path),
            |status: &u16| *status == 401,
            |_token| {
                let calls = Arc::clone(&calls);
                async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Err(401u16)
                }
            },
        )
        .await;
        assert!(matches!(result, Err(RunTokenCallError::Call(401))));
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn workspace_key_detection_covers_bare_and_json_keys() {
        assert!(holds_workspace_key("rk_live_abc"));
        assert!(holds_workspace_key(" rk_test_abc "));
        assert!(holds_workspace_key(r#"[{"api_key":"rk_live_abc"}]"#));
        assert!(!holds_workspace_key(""));
        assert!(!holds_workspace_key("rt_live_abc"));
        assert!(!holds_workspace_key(r#"[{"api_key":""}]"#));
    }
}
