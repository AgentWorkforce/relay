//! The bridge methods for agents, messaging, people, links and settings:
//! parameters in, results out. Every type is the registry's
//! (`relay::contract`); see `docs/relay-core.md` for the contract.

mod usage;

use crate::relay::cloud_session::{segment, CloudError};
use crate::relay::contract::agents::{
    ActivityLog, CreatedWebhook, IntegrationChange, IntegrationParams, RevokedWebhook,
    SettingsValues, TestMessageSent,
};
use crate::relay::contract::capy::{
    CapyProjects, CapyProjectsParams, CapyThreadSpawn, CapyThreadSpawnGetParams,
    CapyThreadSpawnParams,
};
use crate::relay::contract::claude_delivery::ClaudeDeliveryChanged;
use crate::relay::contract::directory::{People, SessionOverviewParams};
mod cursor_cloud;
mod replicas;
use crate::relay::contract::{answer, method, Done};
use crate::relay::daemon::Core;
use crate::relay::links::{self, Endpoint, DEFAULT_SITE_URL};
use crate::relay::people::RosterQuery;
use crate::relay::protocol::{ErrorKind, RpcError};
use crate::relay::telemetry::{
    self, TelemetryEvent, TelemetryOperation as Op, TelemetryOutcome as Outcome,
};
use serde_json::{json, Map, Value};
use std::sync::Arc;

fn endpoint(raw: &str) -> Result<Endpoint, RpcError> {
    Endpoint::parse(raw).map_err(|error| RpcError::invalid_params(error.to_string()))
}

/// A `to` name or an exact `address`: exactly one.
fn recipient_endpoint(to: Option<&str>, address: Option<&str>) -> Result<Endpoint, RpcError> {
    match (to, address) {
        (Some(to), None) => endpoint(to),
        (None, Some(address)) => match endpoint(address)? {
            Endpoint::Address(value) => Ok(Endpoint::Address(value)),
            _ => Err(RpcError::invalid_params(
                "An address must be of the form \"agent@machine\".",
            )),
        },
        _ => Err(RpcError::invalid_params(
            "Give exactly one of to and address.",
        )),
    }
}

fn session_path_for(workspace_id: &str, session_id: &str) -> Result<String, RpcError> {
    let session_id = session_id.trim();
    if session_id.is_empty() || session_id.len() > 512 {
        return Err(RpcError::invalid_params(
            "Give a session id of at most 512 characters.",
        ));
    }
    Ok(format!(
        "/workspaces/{}/reflex/sessions/{}",
        segment(workspace_id),
        segment(session_id)
    ))
}

fn session_path(core: &Arc<Core>, request: &SessionOverviewParams) -> Result<String, RpcError> {
    let account = core.plugins.cloud.account().ok_or_else(|| {
        RpcError::new(
            ErrorKind::NotSignedIn,
            "Sign in to Agent Relay Cloud to view session summaries.",
        )
    })?;
    session_path_for(&account.workspace_id, &request.session_id)
}

/// Past `session_path` the account is connected, so a refusal means the
/// session the core calls Cloud with expired, not that nobody signed in.
fn overview_error(error: CloudError) -> RpcError {
    match error {
        CloudError::SignedOut | CloudError::Rejected => RpcError::new(
            ErrorKind::NotSignedIn,
            "Your Agent Relay sign-in expired. Sign in again to view session summaries.",
        ),
        other => RpcError::cloud(&other),
    }
}

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

fn decode_cloud<T: serde::de::DeserializeOwned>(value: Value, what: &str) -> Result<T, RpcError> {
    serde_json::from_value(value).map_err(|_| {
        RpcError::new(
            ErrorKind::Internal,
            format!("Cloud returned invalid {what}."),
        )
    })
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
    if let Some(model) = request.model {
        fields.insert("model".into(), json!(model));
    }
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

/// The bridge accepts 1 MiB frames. Cloud events can include large tool
/// payloads, while the shared goal parser needs only these three fields.
fn project_goal_events(response: Value) -> Result<Value, RpcError> {
    let session_id = response["sessionId"].as_str().ok_or_else(|| {
        RpcError::new(
            ErrorKind::Internal,
            "Cloud returned invalid session events.",
        )
    })?;
    let events = response["events"].as_array().ok_or_else(|| {
        RpcError::new(
            ErrorKind::Internal,
            "Cloud returned invalid session events.",
        )
    })?;
    let events: Vec<Value> = events
        .iter()
        .take(50)
        .map(|event| {
            let content = event["content"]
                .as_str()
                .map(|text| text.chars().take(1_000).collect::<String>());
            json!({"kind": event["kind"], "actorRole": event["actorRole"], "content": content})
        })
        .collect();
    Ok(json!({"sessionId": session_id, "events": events}))
}

#[cfg(test)]
mod overview_tests {
    use super::{capy_spawn_body, project_goal_events, session_path_for};
    use crate::relay::contract::capy::{
        CapyProjects, CapyPullRequestAuthor, CapyThreadSpawnParams,
    };
    use serde_json::{json, Value};

    #[test]
    fn session_id_stays_in_one_path_segment() {
        assert_eq!(
            session_path_for("workspace", "session/other").unwrap(),
            "/workspaces/workspace/reflex/sessions/session%2Fother"
        );
        assert!(session_path_for("workspace", " ").is_err());
        assert!(session_path_for("workspace", &"a".repeat(513)).is_err());
    }

    #[test]
    fn history_projection_bounds_the_bridge_response() {
        let events: Vec<Value> = (0..60)
            .map(|_| json!({"kind":"history", "actorRole":"user", "content":"x".repeat(10_000), "private":"unused"}))
            .collect();
        let value = project_goal_events(json!({"sessionId":"session", "events":events})).unwrap();
        assert_eq!(value["events"].as_array().unwrap().len(), 50);
        assert_eq!(value["events"][0]["content"].as_str().unwrap().len(), 1_000);
        assert!(value["events"][0].get("private").is_none());
    }

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
    fn capy_spawn_body_uses_cloud_names_and_omits_unselected_options() {
        let minimal = capy_spawn_body(CapyThreadSpawnParams {
            client_request_id: "operation".into(),
            project_id: "project".into(),
            task: "Do the work".into(),
            model: None,
            pull_request_author: None,
            report_to: None,
        });
        assert_eq!(
            minimal,
            json!({"clientRequestId":"operation", "projectId":"project", "task":"Do the work"})
        );
        let full = capy_spawn_body(CapyThreadSpawnParams {
            client_request_id: "operation".into(),
            project_id: "project".into(),
            task: "Do the work".into(),
            model: Some("model".into()),
            pull_request_author: Some(CapyPullRequestAuthor::Capy),
            report_to: Some("lead".into()),
        });
        assert_eq!(full["model"], "model");
        assert_eq!(full["pullRequestAuthor"], "capy");
        assert_eq!(full["reportTo"], "lead");
    }
}

/// `settings.get`'s shape, read from the store's and the extensions'
/// settings; a key the contract does not name is a defect here.
/// The app's own `settings.set`: the person's change. Turning Claude Code
/// cloud sessions on here, beside the text that explains macOS's prompt, is
/// the one moment the app asks for Keychain access. Agents' changes and
/// their rollbacks go through `set_settings` alone and never ask.
fn app_set_settings(
    core: &Core,
    changes: &Map<String, Value>,
) -> Result<Map<String, Value>, RpcError> {
    let settings = core.set_settings(changes)?;
    if changes.get(crate::relay::claude_dirs::CLOUD_SETTING) == Some(&Value::Bool(true)) {
        crate::relay::claude_keychain::ask_access(
            crate::relay::claude_dirs::cloud_sessions_on_here,
        );
    }
    Ok(settings)
}

fn settings_values(settings: Map<String, Value>) -> Result<SettingsValues, RpcError> {
    serde_json::from_value(Value::Object(settings)).map_err(|_| {
        RpcError::new(
            ErrorKind::Internal,
            "A setting this core holds is not in the bridge contract.",
        )
    })
}

async fn unsubscribe(
    core: &Arc<Core>,
    request: IntegrationParams,
) -> Result<IntegrationChange, RpcError> {
    core.unsubscribe_integration(&request.name, &request.provider, &request.resource)
        .await
}

async fn cloud_call(
    core: &Arc<Core>,
    method: &str,
    raw: &Value,
) -> Option<Result<Value, RpcError>> {
    if let Some(result) = cursor_cloud::call(core, method, raw).await {
        return Some(result);
    }
    if let Some(result) = replicas::call(core, method, raw).await {
        return Some(result);
    }
    Some(match method {
        method::CapyProjectsList::NAME => {
            answer::<method::CapyProjectsList, _>(raw.clone(), |request| {
                capy_projects(core, request)
            })
            .await
        }
        method::CapyThreadsSpawn::NAME => {
            answer::<method::CapyThreadsSpawn, _>(raw.clone(), |request| capy_spawn(core, request))
                .await
        }
        method::CapyThreadsGet::NAME => {
            answer::<method::CapyThreadsGet, _>(raw.clone(), |request| {
                capy_spawn_get(core, request)
            })
            .await
        }
        method::SessionsOverviewGet::NAME => {
            answer::<method::SessionsOverviewGet, _>(raw.clone(), |request| async move {
                let path = format!("{}/analysis", session_path(core, &request)?);
                core.plugins
                    .cloud
                    .request("GET", path, None)
                    .await
                    .map_err(overview_error)
            })
            .await
        }
        method::SessionsOverviewRequest::NAME => {
            answer::<method::SessionsOverviewRequest, _>(raw.clone(), |request| async move {
                let path = format!("{}/analysis", session_path(core, &request)?);
                core.plugins
                    .cloud
                    .request("POST", path, None)
                    .await
                    .map_err(overview_error)
            })
            .await
        }
        method::SessionsOverviewEvents::NAME => {
            answer::<method::SessionsOverviewEvents, _>(raw.clone(), |request| async move {
                let path = format!("{}/events", session_path(core, &request)?);
                let response = core
                    .plugins
                    .cloud
                    .request("GET", path, None)
                    .await
                    .map_err(overview_error)?;
                project_goal_events(response)
            })
            .await
        }
        _ => return None,
    })
}

/// Answers `method`, or `None` when this module has no such method.
pub async fn call(core: &Arc<Core>, method: &str, raw: Value) -> Option<Result<Value, RpcError>> {
    if let Some(result) = cloud_call(core, method, &raw).await {
        return Some(result);
    }
    Some(match method {
        method::AgentsList::NAME => {
            answer::<method::AgentsList, _>(raw, |_| async { Ok(core.agents_list()) }).await
        }
        method::AgentsRegister::NAME => {
            answer::<method::AgentsRegister, _>(raw, |request| async move {
                usage::register(core, request).await
            })
            .await
        }
        method::AgentsUnregister::NAME => {
            answer::<method::AgentsUnregister, _>(raw, |request| async move {
                usage::unregister(core, &request.name).await
            })
            .await
        }
        method::AgentsRename::NAME => {
            answer::<method::AgentsRename, _>(raw, |request| async move {
                core.rename(&request.name, &request.new_name).await
            })
            .await
        }
        method::AgentsTestMessage::NAME => {
            answer::<method::AgentsTestMessage, _>(raw, |request| async move {
                telemetry::action(
                    core,
                    TelemetryEvent::new(Op::MessageTest, Outcome::Started),
                    async {
                        core.test_message(&request.name, request.text.as_deref())
                            .await
                            .map(|message_id| TestMessageSent { message_id })
                    },
                )
                .await
            })
            .await
        }
        method::AgentsReplySetting::NAME => {
            answer::<method::AgentsReplySetting, _>(raw, |request| async move {
                core.set_reply_setting(&request.name, request.enabled)
                    .await
                    .map(|_| Done {})
            })
            .await
        }
        method::AgentsWebhookCreate::NAME => {
            answer::<method::AgentsWebhookCreate, _>(raw, |request| async move {
                core.create_webhook(&request.name)
                    .await
                    .map(|hook| CreatedWebhook {
                        id: hook.id,
                        url: hook.url,
                        secret: hook.secret.as_ref().map(|s| s.expose().to_string()),
                        created: hook.created,
                    })
            })
            .await
        }
        method::AgentsWebhookRevoke::NAME => {
            answer::<method::AgentsWebhookRevoke, _>(raw, |request| async move {
                core.revoke_webhook(&request.name)
                    .await
                    .map(|already_deleted| RevokedWebhook { already_deleted })
            })
            .await
        }
        method::AgentsIntegrationsSubscribe::NAME => {
            answer::<method::AgentsIntegrationsSubscribe, _>(raw, |r| async move {
                core.subscribe_integration(&r.name, &r.provider, &r.resource)
                    .await
            })
            .await
        }
        method::AgentsIntegrationsUnsubscribe::NAME => {
            answer::<method::AgentsIntegrationsUnsubscribe, _>(raw, |r| unsubscribe(core, r)).await
        }
        method::AgentsIntegrationsCleanUp::NAME => {
            answer::<method::AgentsIntegrationsCleanUp, _>(raw, |r| unsubscribe(core, r)).await
        }
        method::SettingsGet::NAME => {
            answer::<method::SettingsGet, _>(raw, |_| async { settings_values(core.settings()) })
                .await
        }
        method::SettingsSet::NAME => {
            answer::<method::SettingsSet, _>(raw, |changes| async move {
                let _writing = crate::relay::settings_registry::writing();
                let changes = match serde_json::to_value(changes) {
                    Ok(Value::Object(changes)) => changes,
                    _ => Map::new(),
                };
                settings_values(app_set_settings(core, &changes)?)
            })
            .await
        }
        method::ActivityList::NAME => {
            answer::<method::ActivityList, _>(raw, |request| async move {
                Ok(ActivityLog {
                    activity: core.activity_list(request.limit),
                })
            })
            .await
        }
        method::ClaudeDeliveryStatus::NAME => {
            answer::<method::ClaudeDeliveryStatus, _>(raw, |_| async {
                Ok(core.claude_delivery_status())
            })
            .await
        }
        method::ClaudeDeliveryRestrict::NAME => {
            answer::<method::ClaudeDeliveryRestrict, _>(raw, |request| async move {
                core.set_claude_delivery_restricted(request.restricted)?;
                Ok(Done {})
            })
            .await
        }
        method::ClaudeDeliverySession::NAME => {
            answer::<method::ClaudeDeliverySession, _>(raw, |request| async move {
                core.set_claude_session_delivery(&request.session_id, request.direct)?;
                Ok(Done {})
            })
            .await
        }
        method::ClaudeDeliverySender::NAME => {
            answer::<method::ClaudeDeliverySender, _>(raw, |request| async move {
                core.set_claude_sender_delivery(&request.sender, &request.name, request.allowed)?;
                Ok(Done {})
            })
            .await
        }
        method::ClaudeDeliveryApprove::NAME => {
            answer::<method::ClaudeDeliveryApprove, _>(raw, |request| async move {
                Ok(ClaudeDeliveryChanged {
                    changed: core.approve_claude_delivery(&request.id)?,
                })
            })
            .await
        }
        method::ClaudeDeliveryDismiss::NAME => {
            answer::<method::ClaudeDeliveryDismiss, _>(raw, |request| async move {
                Ok(ClaudeDeliveryChanged {
                    changed: core.dismiss_claude_delivery(&request.id)?,
                })
            })
            .await
        }
        method::RosterList::NAME => {
            answer::<method::RosterList, _>(raw, |request| async move {
                core.roster_list(&RosterQuery {
                    where_runs: request.where_runs,
                    include_idle: request.include_idle,
                    q: request.q,
                })
                .await
            })
            .await
        }
        method::RosterGet::NAME => {
            answer::<method::RosterGet, _>(raw, |request| async move {
                let target = recipient_endpoint(request.to.as_deref(), request.address.as_deref())?;
                core.recipient(&target, request.message_id.as_deref()).await
            })
            .await
        }
        method::MessagesConversations::NAME => {
            answer::<method::MessagesConversations, _>(raw, |_| core.conversations()).await
        }
        method::MessagesHistory::NAME => {
            answer::<method::MessagesHistory, _>(raw, |request| async move {
                let peer = endpoint(&request.endpoint)?;
                core.history(&peer, request.before.as_deref()).await
            })
            .await
        }
        method::MessagesSend::NAME => {
            answer::<method::MessagesSend, _>(raw, |request| async move {
                usage::send(core, request).await
            })
            .await
        }
        method::PeopleList::NAME => {
            answer::<method::PeopleList, _>(raw, |_| async {
                core.people().await.map(|people| People { people })
            })
            .await
        }
        method::LinksParse::NAME => {
            answer::<method::LinksParse, _>(raw, |request| async move {
                let site = request
                    .site_url
                    .or_else(|| core.plugins.cloud.account().map(|a| a.site_url))
                    .unwrap_or_else(|| DEFAULT_SITE_URL.into());
                links::parse_link(&request.url, &site).ok_or_else(|| {
                    RpcError::new(
                        ErrorKind::InvalidParams,
                        "That is not an Agent Relay link this app opens.",
                    )
                })
            })
            .await
        }
        _ => return None,
    })
}
