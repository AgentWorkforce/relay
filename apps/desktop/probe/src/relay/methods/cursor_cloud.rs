//! Cursor Cloud Agent RPC handlers shared by every desktop platform.

use super::decode_cloud;
use crate::relay::cloud_session::segment;
use crate::relay::contract::cursor_cloud::*;
use crate::relay::contract::{answer, method};
use crate::relay::daemon::Core;
use crate::relay::protocol::{ErrorKind, RpcError};
use serde_json::{json, Value};
use std::sync::Arc;

fn base_path(core: &Arc<Core>) -> Result<String, RpcError> {
    let account = core.plugins.cloud.account().ok_or_else(|| {
        RpcError::new(
            ErrorKind::NotSignedIn,
            "Sign in to Agent Relay Cloud to manage Cursor Cloud Agents.",
        )
    })?;
    Ok(format!(
        "/workspaces/{}/cursor-cloud",
        segment(&account.workspace_id)
    ))
}

fn identifier(value: &str, label: &str) -> Result<String, RpcError> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(RpcError::invalid_params(format!(
            "Give the {label} returned by Cursor Cloud."
        )));
    }
    Ok(segment(value))
}

async fn request<T: serde::de::DeserializeOwned>(
    core: &Arc<Core>,
    method: &'static str,
    suffix: &str,
    body: Option<Value>,
    what: &str,
) -> Result<T, RpcError> {
    let value = core
        .plugins
        .cloud
        .request(method, format!("{}/{suffix}", base_path(core)?), body)
        .await
        .map_err(|error| RpcError::cloud(&error))?;
    decode_cloud(value, what)
}

/// The caller's idempotency key. Cloud deduplicates a retried create or
/// follow-up on it because Cursor's steer answer carries no run id, so an
/// empty or unbounded key would silently disable that protection.
fn client_request_id(value: &str) -> Result<(), RpcError> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Err(RpcError::invalid_params(
            "Give a client_request_id of at most 128 letters, digits, '-', '_', '.' or ':', and reuse it when you retry.",
        ));
    }
    Ok(())
}

fn task(value: &str) -> Result<(), RpcError> {
    if value.trim().is_empty() {
        return Err(RpcError::invalid_params(
            "Give the task for the Cursor Cloud Agent.",
        ));
    }
    Ok(())
}

fn agents_query(params: CursorCloudAgentsListParams) -> Result<String, RpcError> {
    let mut query = Vec::new();
    if let Some(limit) = params.limit {
        if !(1..=100).contains(&limit) {
            return Err(RpcError::invalid_params(
                "Cursor Cloud agent list limit must be between 1 and 100.",
            ));
        }
        query.push(format!("limit={limit}"));
    }
    if let Some(cursor) = params.cursor {
        let cursor = cursor.trim();
        if cursor.is_empty() || cursor.len() > 512 {
            return Err(RpcError::invalid_params(
                "Give a Cursor Cloud cursor of at most 512 characters.",
            ));
        }
        query.push(format!("cursor={}", segment(cursor)));
    }
    if let Some(include) = params.include_archived {
        query.push(format!("include_archived={include}"));
    }
    Ok(if query.is_empty() {
        "agents".into()
    } else {
        format!("agents?{}", query.join("&"))
    })
}

fn query_value(value: &str, label: &str, max: usize) -> Result<String, RpcError> {
    let value = value.trim();
    if value.is_empty() || value.len() > max || value.chars().any(char::is_control) {
        return Err(RpcError::invalid_params(format!(
            "Give a Cursor Cloud {label} of at most {max} characters."
        )));
    }
    Ok(segment(value))
}

fn environments_query(params: CursorCloudEnvironmentsListParams) -> Result<String, RpcError> {
    let mut query = Vec::new();
    if let Some(value) = params.query {
        query.push(format!(
            "query={}",
            query_value(&value, "search query", 255)?
        ));
    }
    if let Some(value) = params.owner {
        query.push(format!("owner={}", query_value(&value, "owner", 64)?));
    }
    if let Some(value) = params.named {
        query.push(format!("named={value}"));
    }
    for repository in params.repo {
        query.push(format!(
            "repo={}",
            query_value(&repository, "repository URL", 4096)?
        ));
    }
    if let Some(value) = params.user_id {
        query.push(format!("userId={}", query_value(&value, "user id", 128)?));
    }
    if let Some(limit) = params.limit {
        if !(1..=100).contains(&limit) {
            return Err(RpcError::invalid_params(
                "Cursor Cloud environment list limit must be between 1 and 100.",
            ));
        }
        query.push(format!("limit={limit}"));
    }
    if let Some(value) = params.cursor {
        query.push(format!("cursor={}", query_value(&value, "cursor", 512)?));
    }
    Ok(if query.is_empty() {
        "environments".into()
    } else {
        format!("environments?{}", query.join("&"))
    })
}

fn runs_query(params: CursorCloudRunsListParams) -> Result<String, RpcError> {
    let agent = identifier(&params.agent_id, "agent id")?;
    let mut query = Vec::new();
    if let Some(limit) = params.limit {
        if !(1..=100).contains(&limit) {
            return Err(RpcError::invalid_params(
                "Cursor Cloud run list limit must be between 1 and 100.",
            ));
        }
        query.push(format!("limit={limit}"));
    }
    if let Some(value) = params.cursor {
        query.push(format!("cursor={}", query_value(&value, "cursor", 512)?));
    }
    Ok(if query.is_empty() {
        format!("agents/{agent}/runs")
    } else {
        format!("agents/{agent}/runs?{}", query.join("&"))
    })
}

pub(super) async fn call(
    core: &Arc<Core>,
    method: &str,
    raw: &Value,
) -> Option<Result<Value, RpcError>> {
    Some(match method {
        method::CursorCloudModelsList::NAME => {
            answer::<method::CursorCloudModelsList, _>(raw.clone(), |_| async move {
                request::<CursorCloudModels>(core, "GET", "models", None, "Cursor Cloud models")
                    .await
            })
            .await
        }
        method::CursorCloudRepositoriesList::NAME => {
            answer::<method::CursorCloudRepositoriesList, _>(raw.clone(), |_| async move {
                request::<CursorCloudRepositories>(
                    core,
                    "GET",
                    "repositories",
                    None,
                    "Cursor Cloud repositories",
                )
                .await
            })
            .await
        }
        method::CursorCloudEnvironmentsList::NAME => {
            answer::<method::CursorCloudEnvironmentsList, _>(raw.clone(), |params| async move {
                request::<CursorCloudEnvironments>(
                    core,
                    "GET",
                    &environments_query(params)?,
                    None,
                    "Cursor Cloud environments",
                )
                .await
            })
            .await
        }
        method::CursorCloudAgentsList::NAME => {
            answer::<method::CursorCloudAgentsList, _>(raw.clone(), |params| async move {
                request::<CursorCloudAgents>(
                    core,
                    "GET",
                    &agents_query(params)?,
                    None,
                    "Cursor Cloud agents",
                )
                .await
            })
            .await
        }
        method::CursorCloudAgentsSpawn::NAME => {
            answer::<method::CursorCloudAgentsSpawn, _>(raw.clone(), |params| async move {
                client_request_id(&params.client_request_id)?;
                task(&params.task)?;
                request::<CursorCloudAgent>(
                    core,
                    "POST",
                    "agents",
                    Some(json!(params)),
                    "Cursor Cloud agent",
                )
                .await
            })
            .await
        }
        method::CursorCloudAgentsGet::NAME => {
            answer::<method::CursorCloudAgentsGet, _>(raw.clone(), |params| async move {
                request::<CursorCloudAgent>(
                    core,
                    "GET",
                    &format!("agents/{}", identifier(&params.agent_id, "agent id")?),
                    None,
                    "Cursor Cloud agent",
                )
                .await
            })
            .await
        }
        method::CursorCloudRunsCreate::NAME => {
            answer::<method::CursorCloudRunsCreate, _>(raw.clone(), |params| async move {
                let agent = identifier(&params.agent_id, "agent id")?;
                client_request_id(&params.client_request_id)?;
                task(&params.task)?;
                request::<CursorCloudRun>(
                    core,
                    "POST",
                    &format!("agents/{agent}/runs"),
                    Some(json!(params)),
                    "Cursor Cloud run",
                )
                .await
            })
            .await
        }
        method::CursorCloudRunsGet::NAME => {
            answer::<method::CursorCloudRunsGet, _>(raw.clone(), |params| async move {
                let agent = identifier(&params.agent_id, "agent id")?;
                let run = identifier(&params.run_id, "run id")?;
                request::<CursorCloudRun>(
                    core,
                    "GET",
                    &format!("agents/{agent}/runs/{run}"),
                    None,
                    "Cursor Cloud run",
                )
                .await
            })
            .await
        }
        method::CursorCloudRunsList::NAME => {
            answer::<method::CursorCloudRunsList, _>(raw.clone(), |params| async move {
                request::<CursorCloudRuns>(
                    core,
                    "GET",
                    &runs_query(params)?,
                    None,
                    "Cursor Cloud runs",
                )
                .await
            })
            .await
        }
        method::CursorCloudRunsCancel::NAME => {
            answer::<method::CursorCloudRunsCancel, _>(raw.clone(), |params| async move {
                let agent = identifier(&params.agent_id, "agent id")?;
                let run = identifier(&params.run_id, "run id")?;
                request::<CursorCloudRun>(
                    core,
                    "POST",
                    &format!("agents/{agent}/runs/{run}/cancel"),
                    None,
                    "Cursor Cloud cancelled run",
                )
                .await
            })
            .await
        }
        method::CursorCloudAgentsArchive::NAME => {
            answer::<method::CursorCloudAgentsArchive, _>(raw.clone(), |params| async move {
                let agent = identifier(&params.agent_id, "agent id")?;
                request::<CursorCloudLifecycle>(
                    core,
                    "POST",
                    &format!("agents/{agent}/archive"),
                    None,
                    "Cursor Cloud archive status",
                )
                .await
            })
            .await
        }
        method::CursorCloudAgentsUnarchive::NAME => {
            answer::<method::CursorCloudAgentsUnarchive, _>(raw.clone(), |params| async move {
                let agent = identifier(&params.agent_id, "agent id")?;
                request::<CursorCloudLifecycle>(
                    core,
                    "POST",
                    &format!("agents/{agent}/unarchive"),
                    None,
                    "Cursor Cloud unarchive status",
                )
                .await
            })
            .await
        }
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_query_is_bounded_and_encoded() {
        assert_eq!(
            agents_query(CursorCloudAgentsListParams {
                cursor: Some("next/page".into()),
                limit: Some(50),
                include_archived: Some(false),
            })
            .unwrap(),
            "agents?limit=50&cursor=next%2Fpage&include_archived=false"
        );
        assert!(agents_query(CursorCloudAgentsListParams {
            limit: Some(101),
            ..Default::default()
        })
        .is_err());
    }

    #[test]
    fn provider_ids_never_add_a_path_segment() {
        assert!(identifier("bc-good_1", "agent id").is_ok());
        assert!(identifier("../other", "agent id").is_err());
        assert!(identifier("", "agent id").is_err());
    }

    #[test]
    fn discovery_and_run_queries_are_bounded_and_encoded() {
        assert_eq!(
            environments_query(CursorCloudEnvironmentsListParams {
                query: Some("review app".into()),
                owner: Some("team".into()),
                named: Some(true),
                repo: vec!["https://github.com/acme/app".into()],
                user_id: Some("user/one".into()),
                cursor: Some("next/page".into()),
                limit: Some(25),
            })
            .unwrap(),
            "environments?query=review%20app&owner=team&named=true&repo=https%3A%2F%2Fgithub.com%2Facme%2Fapp&userId=user%2Fone&limit=25&cursor=next%2Fpage"
        );
        assert_eq!(
            runs_query(CursorCloudRunsListParams {
                agent_id: "bc-agent".into(),
                cursor: Some("next/run".into()),
                limit: Some(10),
            })
            .unwrap(),
            "agents/bc-agent/runs?limit=10&cursor=next%2Frun"
        );
        assert!(runs_query(CursorCloudRunsListParams {
            agent_id: "bc-agent".into(),
            cursor: None,
            limit: Some(0),
        })
        .is_err());
    }

    use crate::relay::cloud_session::{CloudAccess, CloudAccount, CloudError};
    use crate::relay::daemon::{Config, Plugins};
    use crate::relay::delivery::DeliveryTiming;
    use crate::relay::paths::CorePaths;
    use crate::relay::push::PushTiming;
    use futures_util::future::BoxFuture;
    use std::collections::{BTreeMap, VecDeque};
    use std::sync::Mutex;
    use std::time::Duration;

    const WORKSPACE: &str = "ws-cursor";

    /// Records each Cloud request and answers from a queue, so a test can
    /// see exactly which hosted route a contract method reaches.
    struct FakeCloud {
        signed_in: bool,
        calls: Mutex<Vec<(String, String, Option<Value>)>>,
        answers: Mutex<VecDeque<Result<Value, CloudError>>>,
    }

    impl FakeCloud {
        fn new(signed_in: bool, answers: Vec<Result<Value, CloudError>>) -> Arc<FakeCloud> {
            Arc::new(FakeCloud {
                signed_in,
                calls: Mutex::new(Vec::new()),
                answers: Mutex::new(answers.into()),
            })
        }

        fn calls(&self) -> Vec<(String, String, Option<Value>)> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl CloudAccess for FakeCloud {
        fn account(&self) -> Option<CloudAccount> {
            self.signed_in.then(|| CloudAccount {
                site_url: "https://agentrelay.com".into(),
                workspace_id: WORKSPACE.into(),
                user_id: Some("user-1".into()),
            })
        }

        fn agent_owner(&self) -> Option<crate::relay::cloud_session::AgentOwner> {
            None
        }

        fn request(
            &self,
            method: &'static str,
            path: String,
            body: Option<Value>,
        ) -> BoxFuture<'_, Result<Value, CloudError>> {
            self.calls.lock().unwrap().push((method.into(), path, body));
            let answer = self
                .answers
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or(Err(CloudError::Unreachable));
            Box::pin(async move { answer })
        }
    }

    fn core(cloud: Arc<FakeCloud>) -> (tempfile::TempDir, Arc<Core>) {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().to_path_buf();
        let config = Config {
            paths: CorePaths::for_socket(home.join("core.sock")).unwrap(),
            home: home.clone(),
            app_data_dir: home.join("app-data"),
            env: BTreeMap::new(),
            version: "test".into(),
            host_name: "Test Desk.local".into(),
            rediscover_every: Duration::from_secs(3600),
            push_timing: PushTiming::default(),
            delivery_timing: DeliveryTiming::default(),
        };
        let plugins = Plugins {
            cloud,
            ..Plugins::default()
        };
        let (core, _) = Core::with_plugins(config, plugins);
        (temp, core)
    }

    async fn invoke(core: &Arc<Core>, method: &str, params: Value) -> Result<Value, RpcError> {
        call(core, method, &params)
            .await
            .expect("cursor_cloud handles its own methods")
    }

    fn agent(id: &str, status: &str) -> Value {
        json!({
            "id": id,
            "name": "Fix the failing test",
            "status": status,
            "url": format!("https://cursor.com/agents/{id}"),
            "created_at": "2026-10-24T00:00:00Z",
            "updated_at": "2026-10-24T00:00:00Z",
            "latest_run_id": "run-1",
            "repositories": [],
            "binding": {"state": "bound", "agent": "cursor-cloud-agent"}
        })
    }

    #[tokio::test]
    async fn signed_out_calls_never_reach_cloud() {
        let cloud = FakeCloud::new(false, vec![]);
        let (_temp, core) = core(cloud.clone());
        let error = invoke(&core, "cursor_cloud.agents.list", json!({}))
            .await
            .unwrap_err();
        assert_eq!(error.data.kind, ErrorKind::NotSignedIn);
        assert!(cloud.calls().is_empty());
    }

    #[tokio::test]
    async fn cloud_refusals_map_to_typed_errors() {
        let cloud = FakeCloud::new(
            true,
            vec![
                Err(CloudError::Rejected),
                Err(CloudError::Status {
                    status: 409,
                    message: Some("The Cursor Cloud Agent is archived.".into()),
                }),
                Err(CloudError::Status {
                    status: 429,
                    message: None,
                }),
            ],
        );
        let (_temp, core) = core(cloud.clone());
        let rejected = invoke(&core, "cursor_cloud.models.list", json!({}))
            .await
            .unwrap_err();
        assert_eq!(rejected.data.kind, ErrorKind::NotSignedIn);
        let archived = invoke(
            &core,
            "cursor_cloud.runs.create",
            json!({"agent_id": "bc-agent", "client_request_id": "message-1", "task": "Continue"}),
        )
        .await
        .unwrap_err();
        assert_eq!(archived.data.kind, ErrorKind::CloudRefused);
        assert_eq!(archived.message, "The Cursor Cloud Agent is archived.");
        let limited = invoke(&core, "cursor_cloud.models.list", json!({}))
            .await
            .unwrap_err();
        assert_eq!(limited.data.kind, ErrorKind::CloudFailed);
    }

    #[tokio::test]
    async fn spawn_routes_to_the_workspace_and_replays_the_same_request_id() {
        let cloud = FakeCloud::new(
            true,
            vec![
                Ok(agent("bc-agent", "ACTIVE")),
                Ok(agent("bc-agent", "ACTIVE")),
            ],
        );
        let (_temp, core) = core(cloud.clone());
        let params = json!({
            "client_request_id": "spawn-1",
            "task": "Fix the failing test",
            "repositories": [{"url": "https://github.com/example/repo", "starting_ref": "main"}],
            "auto_create_pull_request": true
        });
        let first = invoke(&core, "cursor_cloud.agents.spawn", params.clone())
            .await
            .unwrap();
        let retry = invoke(&core, "cursor_cloud.agents.spawn", params)
            .await
            .unwrap();
        assert_eq!(first, retry);
        let calls = cloud.calls();
        assert_eq!(calls.len(), 2);
        for (method, path, body) in &calls {
            assert_eq!(method, "POST");
            assert_eq!(path, "/workspaces/ws-cursor/cursor-cloud/agents");
            let body = body.as_ref().unwrap();
            assert_eq!(body["client_request_id"], "spawn-1");
            assert!(body.get("api_key").is_none());
        }
    }

    #[tokio::test]
    async fn spawn_and_follow_up_need_a_request_id_and_a_task() {
        let cloud = FakeCloud::new(true, vec![]);
        let (_temp, core) = core(cloud.clone());
        for (method, params) in [
            (
                "cursor_cloud.agents.spawn",
                json!({"client_request_id": " ", "task": "Fix it"}),
            ),
            (
                "cursor_cloud.agents.spawn",
                json!({"client_request_id": "spawn-1", "task": "  "}),
            ),
            (
                "cursor_cloud.runs.create",
                json!({"agent_id": "bc-agent", "client_request_id": "a/b", "task": "Go"}),
            ),
            (
                "cursor_cloud.runs.create",
                json!({"agent_id": "bc-agent", "client_request_id": "m-1", "task": ""}),
            ),
        ] {
            let error = invoke(&core, method, params).await.unwrap_err();
            assert_eq!(error.data.kind, ErrorKind::InvalidParams, "{method}");
        }
        assert!(cloud.calls().is_empty());
    }

    #[tokio::test]
    async fn steered_follow_up_without_a_run_id_is_accepted() {
        let cloud = FakeCloud::new(
            true,
            vec![Ok(json!({
                "id": null, "agent_id": "bc-agent", "status": "STEERED",
                "created_at": null, "updated_at": null, "duration_ms": null,
                "result": null, "branches": []
            }))],
        );
        let (_temp, core) = core(cloud.clone());
        let run = invoke(
            &core,
            "cursor_cloud.runs.create",
            json!({"agent_id": "bc-agent", "client_request_id": "message-1", "task": "Also add tests"}),
        )
        .await
        .unwrap();
        assert_eq!(run["id"], Value::Null);
        assert_eq!(run["status"], "STEERED");
        let (method, path, body) = &cloud.calls()[0];
        assert_eq!(method, "POST");
        assert_eq!(
            path,
            "/workspaces/ws-cursor/cursor-cloud/agents/bc-agent/runs"
        );
        assert!(body.as_ref().unwrap().get("delivery").is_none());
    }

    #[tokio::test]
    async fn pages_follow_the_cursor_cloud_returns() {
        let cloud = FakeCloud::new(
            true,
            vec![
                Ok(json!({"agents": [agent("bc-one", "ACTIVE")], "next_cursor": "page/2"})),
                Ok(json!({"agents": [agent("bc-two", "ARCHIVED")], "next_cursor": null})),
            ],
        );
        let (_temp, core) = core(cloud.clone());
        let first = invoke(&core, "cursor_cloud.agents.list", json!({"limit": 1}))
            .await
            .unwrap();
        let next = first["next_cursor"].as_str().unwrap().to_owned();
        let second = invoke(
            &core,
            "cursor_cloud.agents.list",
            json!({"limit": 1, "cursor": next, "include_archived": true}),
        )
        .await
        .unwrap();
        assert_eq!(second["next_cursor"], Value::Null);
        let paths: Vec<String> = cloud.calls().into_iter().map(|call| call.1).collect();
        assert_eq!(
            paths,
            [
                "/workspaces/ws-cursor/cursor-cloud/agents?limit=1",
                "/workspaces/ws-cursor/cursor-cloud/agents?limit=1&cursor=page%2F2&include_archived=true",
            ]
        );
    }

    #[tokio::test]
    async fn release_is_archive_and_never_delete() {
        let lifecycle = |status: &str, state: &str| {
            Ok(json!({
                "agent_id": "bc-agent",
                "status": status,
                "binding": {"state": state, "agent": null}
            }))
        };
        let cloud = FakeCloud::new(
            true,
            vec![
                Ok(json!({
                    "id": "run-1", "agent_id": "bc-agent", "status": "CANCELLED",
                    "created_at": null, "updated_at": null, "duration_ms": 10,
                    "result": null, "branches": []
                })),
                lifecycle("ARCHIVED", "unbound"),
                lifecycle("ACTIVE", "bound"),
            ],
        );
        let (_temp, core) = core(cloud.clone());
        let ids = json!({"agent_id": "bc-agent", "run_id": "run-1"});
        let cancelled = invoke(&core, "cursor_cloud.runs.cancel", ids)
            .await
            .unwrap();
        assert_eq!(cancelled["status"], "CANCELLED");
        let archived = invoke(
            &core,
            "cursor_cloud.agents.archive",
            json!({"agent_id": "bc-agent"}),
        )
        .await
        .unwrap();
        assert_eq!(archived["status"], "ARCHIVED");
        let restored = invoke(
            &core,
            "cursor_cloud.agents.unarchive",
            json!({"agent_id": "bc-agent"}),
        )
        .await
        .unwrap();
        assert_eq!(restored["binding"]["state"], "bound");
        let calls = cloud.calls();
        assert!(calls.iter().all(|(method, ..)| method == "POST"));
        assert_eq!(
            calls.iter().map(|call| call.1.as_str()).collect::<Vec<_>>(),
            [
                "/workspaces/ws-cursor/cursor-cloud/agents/bc-agent/runs/run-1/cancel",
                "/workspaces/ws-cursor/cursor-cloud/agents/bc-agent/archive",
                "/workspaces/ws-cursor/cursor-cloud/agents/bc-agent/unarchive",
            ]
        );
    }

    #[tokio::test]
    async fn malformed_cloud_answers_are_reported_not_passed_through() {
        let cloud = FakeCloud::new(true, vec![Ok(json!({"agents": "nope"}))]);
        let (_temp, core) = core(cloud);
        let error = invoke(&core, "cursor_cloud.agents.list", json!({}))
            .await
            .unwrap_err();
        assert_eq!(error.data.kind, ErrorKind::Internal);
        assert_eq!(error.message, "Cloud returned invalid Cursor Cloud agents.");
    }
}
