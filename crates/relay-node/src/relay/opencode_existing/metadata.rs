//! Authenticated native session identity and title readback.
use super::{printable, route_authorization, Binding, Failure, HttpTransport};
use crate::relay::process::ProcessTable;
use serde_json::Value;
use std::time::Duration;

/// Obtain immutable OpenCode session identity from an authenticated endpoint
/// launched by the probe. The candidate already binds the kernel process and
/// credential reference; project/workspace values are returned by OpenCode,
/// never accepted from the caller.
pub fn inspect_session(
    table: &dyn ProcessTable,
    http: &dyn HttpTransport,
    candidate: &Binding,
    timeout: Duration,
) -> Result<(String, Option<String>), Failure> {
    let session = inspect_session_metadata(table, http, candidate, timeout)?;
    Ok((session.project_id, session.workspace_id))
}

/// Native metadata returned by the same authenticated read that verifies a
/// session. Discovery must use this title, not a label derived from its id.
pub struct SessionMetadata {
    pub project_id: String,
    pub workspace_id: Option<String>,
    pub title: Option<String>,
}

pub fn inspect_session_metadata(
    table: &dyn ProcessTable,
    http: &dyn HttpTransport,
    candidate: &Binding,
    timeout: Duration,
) -> Result<SessionMetadata, Failure> {
    let authorization = route_authorization(table, candidate)?;
    let base = candidate.endpoint.trim_end_matches('/');
    let response = http
        .request(
            "GET",
            &format!("{base}/session/{}", candidate.session_id),
            &authorization,
            &candidate.directory,
            None,
            timeout.min(Duration::from_secs(10)),
        )
        .ok_or(Failure::EndpointUnavailable)?;
    if matches!(response.status, 401 | 403) {
        return Err(Failure::AuthenticationRefused);
    }
    if response.status != 200 {
        return Err(Failure::SessionMismatch);
    }
    let value: Value =
        serde_json::from_slice(&response.body).map_err(|_| Failure::SessionMismatch)?;
    if value["id"].as_str() != Some(candidate.session_id.as_str())
        || value["directory"].as_str() != candidate.directory.to_str()
        || value["time"].get("archived").is_some()
    {
        return Err(Failure::SessionMismatch);
    }
    let project_id = value["projectID"]
        .as_str()
        .filter(|value| printable(value, 256))
        .ok_or(Failure::SessionMismatch)?
        .to_string();
    let workspace_id = match value.get("workspaceID") {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) if printable(value, 256) => Some(value.clone()),
        _ => return Err(Failure::SessionMismatch),
    };
    let title = value["title"]
        .as_str()
        .filter(|title| !title.trim().is_empty())
        .map(str::to_owned);
    Ok(SessionMetadata {
        project_id,
        workspace_id,
        title,
    })
}
