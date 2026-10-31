//! Strict provider and origin checks for rotated account workspace keys.

use super::*;

/// Recovery requires an explicit, unchanged destination; missing or invalid
/// fields never receive the defaults used during first-time workspace adoption.
pub async fn resolve_workspace_for_recovery(
    site_url: &str,
    bearer: &Secret,
    workspace_id: &str,
    refused: &crate::relay::workspace::Workspace,
    relaycast_workspace_id: &str,
) -> Result<CloudWorkspace, ResolveError> {
    if !is_workspace_uuid(workspace_id) {
        return Err(ResolveError::InvalidWorkspace);
    }
    let id = workspace_id.to_ascii_lowercase();
    let answer = cloud_http::send(
        "GET",
        format!("{}/workspaces/{id}/resolve", api_base(site_url)),
        Some(bearer.expose().to_string()),
        None,
        REQUEST_TIMEOUT,
    )
    .await
    .map_err(|_| ResolveError::Cloud(CloudError::Unreachable))?;
    if matches!(answer.status, 401 | 403) {
        return Err(ResolveError::Cloud(CloudError::Rejected));
    }
    if answer.status != 200 {
        return Err(ResolveError::Cloud(status_error(&answer)));
    }
    let value = answer.inner();
    let key = value["relaycastApiKey"]
        .as_str()
        .ok_or(ResolveError::NoKey)?;
    // Cloud mints base64url live keys; older Relaycast keys use hex. Accept
    // both encodings, then require Relaycast itself to authenticate the candidate.
    let valid_key = valid_live_key(key);
    let base = value["urls"]["relaycastUrl"]
        .as_str()
        .and_then(validated_base_url)
        .ok_or(ResolveError::NoKey)?;
    let known_id = !relaycast_workspace_id.is_empty()
        && relaycast_workspace_id != id
        && relaycast_workspace_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    // Provider ids can be numeric on older workspaces. The subsequent safe
    // Relaycast GET must confirm the previously known identity before any save.
    let same_workspace = value["relaycastWorkspaceId"].as_str() == Some(relaycast_workspace_id)
        || value["workspaceId"].as_str() == Some(relaycast_workspace_id);
    // Legacy resolutions explicitly return null when no app-workspace mapping
    // exists. The requested UUID, unchanged Relaycast id and authenticated GET
    // still fence that route; a supplied, different UUID is always refused.
    let same_cloud_workspace = match value.get("cloudWorkspaceId") {
        Some(Value::Null) => true,
        Some(Value::String(found)) => found == &id,
        _ => false,
    };
    if !valid_key
        || key == refused.key.expose()
        || !known_id
        || base != refused.base_url
        || !same_workspace
        || !same_cloud_workspace
    {
        return Err(ResolveError::NoKey);
    }
    decode_resolution(value, &id)
}

fn valid_live_key(key: &str) -> bool {
    key.strip_prefix("rk_live_").is_some_and(|suffix| {
        suffix.len() >= 16
            && suffix.len() <= 128
            && suffix
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    })
}
