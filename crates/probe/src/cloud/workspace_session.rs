//! The workspace-scoped RelayHistory session exchange — issuing the
//! short-lived tokens an install syncs history with.

use super::{
    cloud_json_response, cloud_send, cloud_site, history_origin, rotate_key, StoredAuth,
    WorkspaceSessionResponse,
};
use anyhow::Result;

/// What Cloud answered a workspace-session request.
pub(crate) enum Issued {
    /// A well-formed session for the scope asked for, for whichever
    /// workspace Cloud named; the caller checks that it is the one asked.
    Session(StoredAuth),
    /// Cloud answered with this non-success status.
    Status(u16),
    /// Cloud did not answer.
    Unreachable,
}

/// [`workspace_session`]'s exchange, without its errors or workspace check.
pub(crate) fn issue_workspace_session(
    api_url: &str,
    bearer: &str,
    workspace: &str,
    mode: &str,
    label: &str,
) -> Result<Issued> {
    let required_scope = match mode {
        "sync" => "rth:sync",
        "read" => "rth:read",
        other => anyhow::bail!("invalid mode '{other}' (expected `read` or `sync`)"),
    };
    rotate_key::ensure_workspace_id(workspace)?;
    let site = cloud_site(api_url)?;
    let Some(response) = cloud_send(
        "POST",
        &format!("{api_url}/api/v1/workspaces/{workspace}/relayhistory/session"),
        Some(bearer),
        Some(serde_json::json!({ "mode": mode, "label": label })),
    ) else {
        return Ok(Issued::Unreachable);
    };
    let status = response.status();
    if status != 200 {
        return Ok(Issued::Status(status));
    }
    let session: WorkspaceSessionResponse = serde_json::from_value(cloud_json_response(response)?)?;
    let base_url = history_origin(&session.base_url, &site)?;
    anyhow::ensure!(
        !session.org_id.is_empty()
            && (session.scopes.is_empty()
                || session.scopes.iter().any(|scope| scope == required_scope)),
        "invalid scoped session"
    );
    Ok(Issued::Session(StoredAuth {
        base_url,
        access_token: session.access_token,
        access_token_expires_at: Some(session.access_token_expires_at),
        refresh_token: Some(session.refresh_token),
        org_id: Some(session.org_id),
        workspace_id: Some(session.workspace_id),
    }))
}
