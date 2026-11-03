//! Starting Capy threads through Agent Relay Cloud, which holds the
//! workspace's Capy key; see `docs/capy-thread-spawn.md`.

use super::decode_cloud;
use crate::relay::cloud_session::{segment, CloudError};
use crate::relay::contract::capy::{
    CapyProjects, CapyProjectsParams, CapyThreadSpawn, CapyThreadSpawnGetParams,
    CapyThreadSpawnParams,
};
use crate::relay::contract::{answer, method};
use crate::relay::daemon::Core;
use crate::relay::protocol::{ErrorKind, RpcError};
use serde_json::{json, Map, Value};
use std::sync::Arc;

fn capy_path(core: &Arc<Core>, suffix: &str) -> Result<String, RpcError> {
    let account = core.plugins.cloud.account().ok_or_else(|| {
        RpcError::new(
            ErrorKind::NotSignedIn,
            "Sign in to Agent Relay Cloud to start a Capy thread.",
        )
    })?;
    Ok(format!(
        "/workspaces/{}/capy/{suffix}",
        segment(&account.workspace_id)
    ))
}

fn capy_error(error: CloudError) -> RpcError {
    match error {
        CloudError::SignedOut | CloudError::Rejected => RpcError::new(
            ErrorKind::NotSignedIn,
            "Your Agent Relay sign-in expired. Sign in again to start a Capy thread.",
        ),
        other => RpcError::cloud(&other),
    }
}

async fn capy_projects(
    core: &Arc<Core>,
    request: CapyProjectsParams,
) -> Result<CapyProjects, RpcError> {
    let mut path = capy_path(core, "projects")?;
    if let Some(cursor) = request.cursor.map(|value| value.trim().to_owned()) {
        if cursor.is_empty() || cursor.len() > 512 {
            return Err(RpcError::invalid_params(
                "Give a Capy project cursor of at most 512 characters.",
            ));
        }
        path.push_str("?cursor=");
        path.push_str(&segment(&cursor));
    }
    let value = core
        .plugins
        .cloud
        .request("GET", path, None)
        .await
        .map_err(capy_error)?;
    decode_cloud(value, "Capy projects")
}

/// The refusal for a spawn without a model. Capy has no default, so Cloud
/// would accept the spawn and the thread would fail later inside Capy.
pub const CAPY_MODEL_REQUIRED: &str =
    "Give a Capy model in \"model\", for example \"anthropic/claude-sonnet-5-5\".";

/// Refuses a missing or blank `model` before anything calls Cloud, naming
/// the field; the typed parameters alone would only say they do not match.
fn require_capy_model(raw: &Value) -> Result<(), RpcError> {
    match raw.get("model").and_then(Value::as_str).map(str::trim) {
        Some(model) if !model.is_empty() => Ok(()),
        _ => Err(RpcError::invalid_params(CAPY_MODEL_REQUIRED)),
    }
}

async fn answer_capy_spawn(core: &Arc<Core>, raw: &Value) -> Result<Value, RpcError> {
    require_capy_model(raw)?;
    answer::<method::CapyThreadsSpawn, _>(raw.clone(), |request| capy_spawn(core, request)).await
}

async fn capy_spawn(
    core: &Arc<Core>,
    request: CapyThreadSpawnParams,
) -> Result<CapyThreadSpawn, RpcError> {
    let body = capy_spawn_body(request);
    let value = core
        .plugins
        .cloud
        .request("POST", capy_path(core, "thread-spawns")?, Some(body))
        .await
        .map_err(capy_error)?;
    decode_cloud(value, "Capy thread status")
}

fn capy_spawn_body(request: CapyThreadSpawnParams) -> Value {
    let mut fields = Map::new();
    fields.insert("clientRequestId".into(), json!(request.client_request_id));
    fields.insert("projectId".into(), json!(request.project_id));
    fields.insert("task".into(), json!(request.task));
    fields.insert("model".into(), json!(request.model.trim()));
    if let Some(author) = request.pull_request_author {
        fields.insert("pullRequestAuthor".into(), json!(author));
    }
    if let Some(report_to) = request.report_to {
        fields.insert("reportTo".into(), json!(report_to));
    }
    Value::Object(fields)
}

async fn capy_spawn_get(
    core: &Arc<Core>,
    request: CapyThreadSpawnGetParams,
) -> Result<CapyThreadSpawn, RpcError> {
    let thread_id = request.thread_id.trim();
    if thread_id.is_empty() || thread_id.len() > 128 {
        return Err(RpcError::invalid_params(
            "Give a Capy thread id of at most 128 characters.",
        ));
    }
    let path = format!(
        "{}/{}",
        capy_path(core, "thread-spawns")?,
        segment(thread_id)
    );
    let value = core
        .plugins
        .cloud
        .request("GET", path, None)
        .await
        .map_err(capy_error)?;
    decode_cloud(value, "Capy thread status")
}

pub(super) async fn call(
    core: &Arc<Core>,
    method: &str,
    raw: &Value,
) -> Option<Result<Value, RpcError>> {
    Some(match method {
        method::CapyProjectsList::NAME => {
            answer::<method::CapyProjectsList, _>(raw.clone(), |request| {
                capy_projects(core, request)
            })
            .await
        }
        method::CapyThreadsSpawn::NAME => answer_capy_spawn(core, raw).await,
        method::CapyThreadsGet::NAME => {
            answer::<method::CapyThreadsGet, _>(raw.clone(), |request| {
                capy_spawn_get(core, request)
            })
            .await
        }
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay::contract::capy::CapyPullRequestAuthor;

    #[test]
    fn capy_projects_accept_clouds_camel_case_cursor() {
        let projects: CapyProjects = serde_json::from_value(json!({
            "projects": [{"id": "project_1", "name": "Relay"}],
            "truncated": true,
            "nextCursor": "cursor_2"
        }))
        .unwrap();
        assert_eq!(projects.next_cursor.as_deref(), Some("cursor_2"));
    }

    #[test]
    fn capy_spawn_requires_a_model() {
        let base = json!({"client_request_id": "operation", "project_id": "project", "task": "Do"});
        for model in [
            None,
            Some(json!(null)),
            Some(json!("")),
            Some(json!(" \n")),
            Some(json!(7)),
        ] {
            let mut params = base.clone();
            if let Some(model) = model {
                params["model"] = model;
            }
            let error = require_capy_model(&params).unwrap_err();
            assert_eq!(error.data.kind, ErrorKind::InvalidParams);
            assert_eq!(error.message, CAPY_MODEL_REQUIRED);
        }
        let mut params = base;
        params["model"] = json!("anthropic/claude-sonnet-5-5");
        assert!(require_capy_model(&params).is_ok());
        let request: CapyThreadSpawnParams = serde_json::from_value(params).unwrap();
        assert_eq!(request.model, "anthropic/claude-sonnet-5-5");
    }

    #[test]
    fn capy_spawn_body_uses_cloud_names_and_omits_unselected_options() {
        let minimal = capy_spawn_body(CapyThreadSpawnParams {
            client_request_id: "operation".into(),
            project_id: "project".into(),
            task: "Do the work".into(),
            model: " anthropic/claude-sonnet-5-5 ".into(),
            pull_request_author: None,
            report_to: None,
        });
        assert_eq!(
            minimal,
            json!({"clientRequestId":"operation", "projectId":"project", "task":"Do the work",
                   "model":"anthropic/claude-sonnet-5-5"})
        );
        let full = capy_spawn_body(CapyThreadSpawnParams {
            client_request_id: "operation".into(),
            project_id: "project".into(),
            task: "Do the work".into(),
            model: "model".into(),
            pull_request_author: Some(CapyPullRequestAuthor::Capy),
            report_to: Some("lead".into()),
        });
        assert_eq!(full["model"], "model");
        assert_eq!(full["pullRequestAuthor"], "capy");
        assert_eq!(full["reportTo"], "lead");
    }
}
