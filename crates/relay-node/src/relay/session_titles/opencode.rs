//! OpenCode's native session update through a proven provider endpoint.
use super::{supported, unsupported};
use crate::relay::contract::agents::SessionTitleCapability;
use crate::relay::local::LocalConfig;
use crate::relay::opencode::{self, HeldSession, OpenProcess};
use crate::relay::opencode_existing::{self, Binding, HttpTransport, SystemHttp};
use crate::relay::process::ProcessTable;
use serde_json::{json, Value};
use std::time::Duration;
const TIMEOUT: Duration = Duration::from_secs(10);

fn owner(
    config: &LocalConfig,
    table: &dyn ProcessTable,
    id: &str,
) -> Option<(OpenProcess, HeldSession)> {
    if !opencode::is_session_id(id) {
        return None;
    }
    opencode::open_processes(&config.opencode, table, config.uid)
        .into_iter()
        .find_map(|process| {
            let session = process
                .sessions
                .iter()
                .find(|session| session.session_id == id)?
                .clone();
            Some((process, session))
        })
}
pub fn capability(
    config: &LocalConfig,
    table: &dyn ProcessTable,
    id: &str,
) -> SessionTitleCapability {
    let Some((process, session)) = owner(config, table, id) else {
        return unsupported(
            "Open this session in OpenCode with the Agent Relay plugin enabled to edit its title.",
        );
    };
    let Ok(binding) = opencode::binding(table, &SystemHttp, &process, &session, "", "") else {
        return unsupported("Could not verify this OpenCode session. Reopen it and try again.");
    };
    let Ok(auth) = opencode_existing::route_authorization(table, &binding) else {
        return unsupported("Could not verify this OpenCode session. Reopen it and try again.");
    };
    // Old loaded plugins cannot update titles; don't offer a save that would
    // certainly fail. New bundled plugins advertise this narrow operation.
    let response = SystemHttp.request(
        "GET",
        &format!("{}/session/{}/title-capability", binding.endpoint, id),
        &auth,
        &binding.directory,
        None,
        TIMEOUT,
    );
    if response.is_some_and(|response| {
        response.status == 200
            && serde_json::from_slice::<Value>(&response.body)
                .ok()
                .is_some_and(|v| v["supported"] == true)
    }) {
        supported()
    } else {
        unsupported("Reload the Agent Relay plugin in OpenCode to enable title editing.")
    }
}
pub fn set(
    config: &LocalConfig,
    table: &dyn ProcessTable,
    id: &str,
    title: &str,
) -> Result<String, String> {
    let (process, session) = owner(config, table, id).ok_or(
        "Open this session in OpenCode with the Agent Relay plugin enabled to edit its title.",
    )?;
    let binding = opencode::binding(table, &SystemHttp, &process, &session, "", "")
        .map_err(|_| "Could not verify this OpenCode session.".to_string())?;
    set_binding(table, &SystemHttp, &binding, title)
}

pub fn set_binding(
    table: &dyn ProcessTable,
    http: &dyn HttpTransport,
    binding: &Binding,
    title: &str,
) -> Result<String, String> {
    let auth = opencode_existing::route_authorization(table, binding)
        .map_err(|_| "Could not verify this OpenCode session.".to_string())?;
    let (project, workspace) = opencode_existing::inspect_session(table, http, binding, TIMEOUT)
        .map_err(|_| "This OpenCode session is unavailable or archived.".to_string())?;
    if project != binding.project_id || workspace != binding.opencode_workspace_id {
        return Err("The OpenCode session identity changed. Reopen it and try again.".into());
    }
    let body = serde_json::to_vec(&json!({"title":title}))
        .map_err(|_| "Could not encode the OpenCode session title.".to_string())?;
    let response = http
        .request(
            "PATCH",
            &format!(
                "{}/session/{}",
                binding.endpoint.trim_end_matches('/'),
                binding.session_id
            ),
            &auth,
            &binding.directory,
            Some(&body),
            TIMEOUT,
        )
        .ok_or("OpenCode did not confirm the title update. Refresh the session before retrying.")?;
    if response.status != 200 {
        return Err(
            "OpenCode refused the title update. Reload the Agent Relay plugin and try again."
                .into(),
        );
    }
    let updated: Value = serde_json::from_slice(&response.body)
        .map_err(|_| "OpenCode returned an invalid title update.".to_string())?;
    if updated["id"].as_str() != Some(binding.session_id.as_str())
        || updated["title"].as_str() != Some(title)
    {
        return Err("OpenCode did not confirm the requested session title.".into());
    }
    Ok(title.to_owned())
}
