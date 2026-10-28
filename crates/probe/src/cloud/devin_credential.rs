//! The workspace-scoped Devin credential exchange — what an install uses to
//! send into `devin-*` Cloud sessions when it holds no local Devin sign-in.

use super::{cloud_json_response, cloud_send};
use anyhow::Result;

/// The workspace's stored Devin credential, as Cloud answered the install's
/// fetch — what `send_cloud` posts into `devin-*` sessions as. Held only in
/// memory (and the relay's per-install cache); it is never logged or
/// embedded in an error.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DevinWorkspaceCredential {
    pub api_key: String,
    pub org_id: String,
    /// A non-default Devin API origin when the workspace serves one —
    /// dev and test stages point sends at their own service.
    pub base_url: Option<String>,
}

/// What the Devin credential fetch answered.
#[derive(Debug)]
pub enum DevinCredentialAnswer {
    /// The workspace has Devin connected; this is the credential to send as.
    Connected(DevinWorkspaceCredential),
    /// The workspace answered and simply has no Devin connection
    /// (`devin_not_connected`), or the workspace itself is gone.
    NotConnected,
    /// Cloud refused the install's bearer (401/403) — sign-in needed again,
    /// or the caller is not a workspace member.
    Refused,
    /// Cloud did not answer, was rate limiting or was failing.
    Unreachable,
}

/// `GET {api_url}/api/v1/workspaces/{workspace}/devin/credential` — the
/// workspace's stored Devin credential, decrypted for this install's send
/// route. `Ok(NotConnected)` until an owner or admin connects Devin in
/// Settings → Connections. Response bodies stay private the way every other
/// exchange here keeps them.
pub fn devin_workspace_credential(
    api_url: &str,
    bearer: &str,
    workspace: &str,
) -> Result<DevinCredentialAnswer> {
    anyhow::ensure!(
        !workspace.is_empty()
            && workspace.len() <= 128
            && workspace
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_'),
        "invalid workspace identifier"
    );
    let Some(response) = cloud_send(
        "GET",
        &format!("{api_url}/api/v1/workspaces/{workspace}/devin/credential"),
        Some(bearer),
        None,
    ) else {
        return Ok(DevinCredentialAnswer::Unreachable);
    };
    match response.status() {
        200 => {
            let body = cloud_json_response(response)?;
            let api_key = body["apiKey"].as_str().unwrap_or_default().trim();
            let org_id = body["orgId"].as_str().unwrap_or_default().trim();
            anyhow::ensure!(
                !api_key.is_empty() && !org_id.is_empty(),
                "invalid Devin credential"
            );
            let base_url = body["baseUrl"]
                .as_str()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            Ok(DevinCredentialAnswer::Connected(DevinWorkspaceCredential {
                api_key: api_key.to_string(),
                org_id: org_id.to_string(),
                base_url,
            }))
        }
        401 | 403 => Ok(DevinCredentialAnswer::Refused),
        404 => Ok(DevinCredentialAnswer::NotConnected),
        _ => Ok(DevinCredentialAnswer::Unreachable),
    }
}
