//! `POST {api_url}/api/v1/workspaces/{workspace}/relay-key/rotate` — the
//! hosted key rotation. Cloud mints, persists and pushes the replacement
//! under its generation fence; the answer carries only the new generation
//! and the grace window — the key itself is never in the response.

use anyhow::Result;
use serde_json::Value;

use super::{auth_error, cloud_request};

/// `{workspace}` path parameters carry the Cloud workspace id only.
pub(super) fn ensure_workspace_id(workspace: &str) -> Result<()> {
    anyhow::ensure!(
        !workspace.is_empty()
            && workspace.len() <= 128
            && workspace
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_'),
        "invalid workspace identifier"
    );
    Ok(())
}

pub fn rotate_relay_workspace_key(
    api_url: &str,
    bearer: &str,
    workspace: &str,
    grace_ms: u64,
) -> Result<Value> {
    ensure_workspace_id(workspace)?;
    let (status, value) = cloud_request(
        "POST",
        &format!("{api_url}/api/v1/workspaces/{workspace}/relay-key/rotate"),
        Some(bearer),
        Some(serde_json::json!({ "graceMs": grace_ms })),
    )?;
    if !(200..300).contains(&status) {
        // Keep response bodies private while giving an actionable cause. A
        // 502 covers both stages the route distinguishes: capability-refused
        // (nothing changed) and persisted-but-unpropagated (a repair push
        // completes it) — retrying is correct in both, since rotation is
        // generation-idempotent.
        return Err(auth_error(match status {
            400 => "Cloud refused the rotation request as malformed.",
            401 => "Your sign-in expired. Sign in again.",
            403 => "Your account cannot rotate this workspace's key. Rotation needs owner or admin access.",
            404 => "This workspace is unavailable or has no relay workspace. Open it in the dashboard first.",
            429 => "Too many attempts. Wait a moment, then try again.",
            502 => "Cloud could not finish the rotation at the relay. Check the workspace in the dashboard, then retry.",
            _ => "Cloud could not rotate the workspace key. Please try again or contact support.",
        }));
    }
    Ok(value.get("data").cloned().unwrap_or(value))
}
