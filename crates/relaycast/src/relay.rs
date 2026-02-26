//! Main RelayCast client for workspace-level operations.

use crate::agent::AgentClient;
use crate::client::{ClientOptions, HttpClient};
use crate::error::{RelayError, Result};
use crate::types::*;
use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;
use url::Url;

const SDK_VERSION: &str = env!("CARGO_PKG_VERSION");
const DEFAULT_BASE_URL: &str = "https://api.relaycast.dev";
const DEFAULT_ORIGIN_SURFACE: &str = "sdk";
const DEFAULT_ORIGIN_CLIENT: &str = "@relaycast/sdk-rust";
const DEFAULT_LOCAL_BASE_URL: &str = "http://127.0.0.1:7528";

#[derive(Debug)]
struct ResolvedLocalRuntime {
    api_key: String,
    base_url: String,
}

fn strip_trailing_slash(url: &str) -> String {
    url.trim_end_matches('/').to_string()
}

fn io_err(context: &str, err: impl std::fmt::Display) -> RelayError {
    RelayError::InvalidResponse(format!("{context}: {err}"))
}

fn resolve_local_binary_path() -> Result<PathBuf> {
    let env_bin = env::var("RELAYCAST_LOCAL_BIN").unwrap_or_default();
    if !env_bin.trim().is_empty() {
        let path = PathBuf::from(env_bin.trim());
        if !path.exists() {
            return Err(RelayError::InvalidResponse(format!(
                "RELAYCAST_LOCAL_BIN does not exist: {}",
                path.display()
            )));
        }
        return Ok(path);
    }

    let asset = match (env::consts::OS, env::consts::ARCH) {
        ("macos", "aarch64") => "local-darwin-arm64",
        ("macos", "x86_64") => "local-darwin-x64",
        ("linux", "x86_64") => "local-linux-x64",
        ("windows", "x86_64") => "local-windows-x64.exe",
        (os, arch) => {
            return Err(RelayError::InvalidResponse(format!(
                "Unsupported platform for local relaycast runtime: {os}/{arch}"
            )))
        }
    };

    // Allow binaries shipped with the crate package.
    let bundled = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("bin")
        .join(asset);
    if bundled.exists() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let perms = std::fs::Permissions::from_mode(0o755);
            let _ = fs::set_permissions(&bundled, perms);
        }
        return Ok(bundled);
    }

    // Fall back to PATH lookup (`local` / `local.exe`).
    if cfg!(windows) {
        Ok(PathBuf::from("local.exe"))
    } else {
        Ok(PathBuf::from("local"))
    }
}

fn is_local_healthy(base_url: &str) -> bool {
    let health_url = format!("{}/health", strip_trailing_slash(base_url));
    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(600))
        .build()
    {
        Ok(client) => client,
        Err(_) => return false,
    };

    match client.get(health_url).send() {
        Ok(resp) => resp.status().is_success(),
        Err(_) => false,
    }
}

fn wait_for_local_health(base_url: &str, attempts: usize, sleep: Duration) -> bool {
    for _ in 0..attempts {
        if is_local_healthy(base_url) {
            return true;
        }
        thread::sleep(sleep);
    }
    false
}

fn ensure_local_runtime(
    base_url_override: Option<&str>,
    api_key_override: Option<&str>,
) -> Result<ResolvedLocalRuntime> {
    let env_base_url = env::var("RELAYCAST_LOCAL_BASE_URL").ok();
    let base_url = strip_trailing_slash(
        base_url_override
            .or(env_base_url.as_deref())
            .unwrap_or(DEFAULT_LOCAL_BASE_URL),
    );
    let parsed = Url::parse(&base_url)?;
    let host = parsed.host_str().unwrap_or("127.0.0.1").to_string();
    let port = parsed.port().unwrap_or(7528);

    if !is_local_healthy(&base_url) {
        let binary = resolve_local_binary_path()?;
        Command::new(&binary)
            .arg("--host")
            .arg(&host)
            .arg("--port")
            .arg(port.to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| io_err("failed starting local relaycast daemon", e))?;

        if !wait_for_local_health(&base_url, 40, Duration::from_millis(100)) {
            return Err(RelayError::InvalidResponse(format!(
                "failed to start local relaycast daemon at {base_url}"
            )));
        }
    }

    let api_key = api_key_override
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| RelayError::InvalidResponse("RelayCast api_key is required".to_string()))?;

    Ok(ResolvedLocalRuntime { api_key, base_url })
}

fn strip_hash(channel: &str) -> &str {
    channel.strip_prefix('#').unwrap_or(channel)
}

/// Options for creating a RelayCast client.
#[derive(Debug, Clone)]
pub struct RelayCastOptions {
    /// The API key for authentication.
    pub api_key: String,
    /// The base URL for the API (defaults to https://api.relaycast.dev).
    pub base_url: Option<String>,
    /// Enable local mode (`local` daemon) auto-bootstrap.
    pub local: bool,
}

impl RelayCastOptions {
    /// Create new options with the given API key.
    pub fn new(api_key: impl Into<String>) -> Self {
        Self {
            api_key: api_key.into(),
            base_url: None,
            local: false,
        }
    }

    /// Create options for local mode.
    pub fn local(api_key: impl Into<String>) -> Self {
        Self {
            api_key: api_key.into(),
            base_url: Some(DEFAULT_LOCAL_BASE_URL.to_string()),
            local: true,
        }
    }

    /// Set a custom base URL.
    pub fn with_base_url(mut self, base_url: impl Into<String>) -> Self {
        self.base_url = Some(base_url.into());
        self
    }

    /// Enable or disable local mode.
    pub fn with_local(mut self, local: bool) -> Self {
        self.local = local;
        self
    }
}

/// Main client for RelayCast workspace operations.
pub struct RelayCast {
    client: HttpClient,
}

impl RelayCast {
    /// Create a new RelayCast client with the given options.
    pub fn new(options: RelayCastOptions) -> Result<Self> {
        let resolved = if options.local {
            ensure_local_runtime(
                options.base_url.as_deref(),
                if options.api_key.trim().is_empty() {
                    None
                } else {
                    Some(options.api_key.as_str())
                },
            )?
        } else {
            if options.api_key.trim().is_empty() {
                return Err(RelayError::InvalidResponse(
                    "RelayCast api_key is required".to_string(),
                ));
            }
            ResolvedLocalRuntime {
                api_key: options.api_key,
                base_url: options
                    .base_url
                    .unwrap_or_else(|| DEFAULT_BASE_URL.to_string()),
            }
        };

        let mut client_options = ClientOptions::new(resolved.api_key);
        client_options = client_options.with_base_url(resolved.base_url);
        let client = HttpClient::new(client_options)?;
        Ok(Self { client })
    }

    /// Create a new workspace.
    pub async fn create_workspace(
        name: &str,
        base_url: Option<&str>,
    ) -> Result<CreateWorkspaceResponse> {
        let url = format!("{}/v1/workspaces", base_url.unwrap_or(DEFAULT_BASE_URL));

        let client = reqwest::Client::new();
        let response = client
            .post(&url)
            .header("Content-Type", "application/json")
            .header("X-SDK-Version", SDK_VERSION)
            .header("X-Relaycast-Origin-Surface", DEFAULT_ORIGIN_SURFACE)
            .header("X-Relaycast-Origin-Client", DEFAULT_ORIGIN_CLIENT)
            .header("X-Relaycast-Origin-Version", SDK_VERSION)
            .json(&serde_json::json!({ "name": name }))
            .send()
            .await?;

        let status = response.status().as_u16();
        let json: ApiResponse<CreateWorkspaceResponse> = response.json().await?;

        if !json.ok {
            let error = json.error.unwrap_or_else(|| ApiErrorInfo {
                code: "unknown_error".to_string(),
                message: "Unknown error".to_string(),
            });
            return Err(RelayError::api(error.code, error.message, status));
        }

        json.data
            .ok_or_else(|| RelayError::InvalidResponse("Response missing data field".to_string()))
    }

    /// Create an agent client for the given agent token.
    pub fn as_agent(&self, agent_token: impl Into<String>) -> Result<AgentClient> {
        let client = self.client.with_api_key(agent_token)?;
        Ok(AgentClient::from_client(client))
    }

    // === Workspace ===

    /// Get workspace information.
    pub async fn workspace_info(&self) -> Result<Workspace> {
        self.client.get("/v1/workspace", None, None).await
    }

    /// Update workspace settings.
    pub async fn update_workspace(&self, request: UpdateWorkspaceRequest) -> Result<Workspace> {
        self.client
            .patch("/v1/workspace", Some(request), None)
            .await
    }

    /// Delete the workspace.
    pub async fn delete_workspace(&self) -> Result<()> {
        self.client.delete("/v1/workspace", None).await
    }

    /// Get effective workspace stream configuration.
    pub async fn workspace_stream_get(&self) -> Result<WorkspaceStreamConfig> {
        self.client.get("/v1/workspace/stream", None, None).await
    }

    /// Set workspace stream override.
    pub async fn workspace_stream_set(&self, enabled: bool) -> Result<WorkspaceStreamConfig> {
        self.client
            .put(
                "/v1/workspace/stream",
                Some(serde_json::json!({ "enabled": enabled })),
                None,
            )
            .await
    }

    /// Clear workspace stream override and inherit default behavior.
    pub async fn workspace_stream_inherit(&self) -> Result<WorkspaceStreamConfig> {
        self.client
            .put(
                "/v1/workspace/stream",
                Some(serde_json::json!({ "mode": "inherit" })),
                None,
            )
            .await
    }

    // === System Prompt ===

    /// Get the workspace system prompt.
    pub async fn get_system_prompt(&self) -> Result<SystemPrompt> {
        self.client
            .get("/v1/workspace/system-prompt", None, None)
            .await
    }

    /// Set the workspace system prompt.
    pub async fn set_system_prompt(&self, request: SetSystemPromptRequest) -> Result<SystemPrompt> {
        self.client
            .put("/v1/workspace/system-prompt", Some(request), None)
            .await
    }

    // === Channels ===

    /// List channels in the workspace.
    pub async fn list_channels(&self, include_archived: bool) -> Result<Vec<Channel>> {
        let query = if include_archived {
            Some([("include_archived", "true")].as_slice())
        } else {
            None
        };
        self.client.get("/v1/channels", query, None).await
    }

    /// Get a channel and its members by name.
    pub async fn get_channel(&self, name: &str) -> Result<ChannelWithMembers> {
        self.client
            .get(
                &format!("/v1/channels/{}", urlencoding::encode(name)),
                None,
                None,
            )
            .await
    }

    // === Messages ===

    /// List messages in a channel.
    pub async fn list_messages(
        &self,
        channel: &str,
        opts: Option<MessageListQuery>,
    ) -> Result<Vec<MessageWithMeta>> {
        let name = strip_hash(channel);
        let opts = opts.unwrap_or_default();
        let mut query_params: Vec<(String, String)> = Vec::new();
        if let Some(limit) = opts.limit {
            query_params.push(("limit".to_string(), limit.to_string()));
        }
        if let Some(before) = opts.before {
            query_params.push(("before".to_string(), before));
        }
        if let Some(after) = opts.after {
            query_params.push(("after".to_string(), after));
        }

        let query: Vec<(&str, &str)> = query_params
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect();

        let query_ref = if query.is_empty() {
            None
        } else {
            Some(query.as_slice())
        };

        self.client
            .get(
                &format!("/v1/channels/{}/messages", urlencoding::encode(name)),
                query_ref,
                None,
            )
            .await
    }

    /// Get a single message by ID.
    pub async fn get_message(&self, id: &str) -> Result<MessageWithMeta> {
        self.client
            .get(
                &format!("/v1/messages/{}", urlencoding::encode(id)),
                None,
                None,
            )
            .await
    }

    /// Get a message thread (parent and replies).
    pub async fn get_thread(
        &self,
        message_id: &str,
        opts: Option<MessageListQuery>,
    ) -> Result<ThreadResponse> {
        let opts = opts.unwrap_or_default();
        let mut query_params: Vec<(String, String)> = Vec::new();
        if let Some(limit) = opts.limit {
            query_params.push(("limit".to_string(), limit.to_string()));
        }
        if let Some(before) = opts.before {
            query_params.push(("before".to_string(), before));
        }
        if let Some(after) = opts.after {
            query_params.push(("after".to_string(), after));
        }

        let query: Vec<(&str, &str)> = query_params
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect();

        let query_ref = if query.is_empty() {
            None
        } else {
            Some(query.as_slice())
        };

        self.client
            .get(
                &format!("/v1/messages/{}/replies", urlencoding::encode(message_id)),
                query_ref,
                None,
            )
            .await
    }

    /// Get grouped reactions for a message.
    pub async fn get_message_reactions(&self, id: &str) -> Result<Vec<ReactionGroup>> {
        self.client
            .get(
                &format!("/v1/messages/{}/reactions", urlencoding::encode(id)),
                None,
                None,
            )
            .await
    }

    // === Agents ===

    /// Register a new agent.
    pub async fn register_agent(&self, request: CreateAgentRequest) -> Result<CreateAgentResponse> {
        self.client.post("/v1/agents", Some(request), None).await
    }

    /// List agents.
    pub async fn list_agents(&self, query: Option<AgentListQuery>) -> Result<Vec<Agent>> {
        let query = query.unwrap_or_default();
        let params: Vec<(String, String)> = query
            .status
            .map(|s| vec![("status".to_string(), s)])
            .unwrap_or_default();

        let query_slice: Vec<(&str, &str)> = params
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect();

        let query_ref = if query_slice.is_empty() {
            None
        } else {
            Some(query_slice.as_slice())
        };

        self.client.get("/v1/agents", query_ref, None).await
    }

    /// Get an agent by name.
    pub async fn get_agent(&self, name: &str) -> Result<Agent> {
        self.client
            .get(
                &format!("/v1/agents/{}", urlencoding::encode(name)),
                None,
                None,
            )
            .await
    }

    /// Rotate an agent's token.
    pub async fn rotate_agent_token(&self, name: &str) -> Result<TokenRotateResponse> {
        self.client
            .post(
                &format!("/v1/agents/{}/rotate-token", urlencoding::encode(name)),
                Some(serde_json::json!({})),
                None,
            )
            .await
    }

    /// Update an agent.
    pub async fn update_agent(&self, name: &str, request: UpdateAgentRequest) -> Result<Agent> {
        self.client
            .patch(
                &format!("/v1/agents/{}", urlencoding::encode(name)),
                Some(request),
                None,
            )
            .await
    }

    /// Delete an agent.
    pub async fn delete_agent(&self, name: &str) -> Result<()> {
        self.client
            .delete(&format!("/v1/agents/{}", urlencoding::encode(name)), None)
            .await
    }

    /// Get agent presence information.
    pub async fn agent_presence(&self) -> Result<Vec<AgentPresenceInfo>> {
        self.client.get("/v1/agents/presence", None, None).await
    }

    /// Register an agent or get existing one (with token rotation).
    pub async fn register_or_get_agent(
        &self,
        request: CreateAgentRequest,
    ) -> Result<CreateAgentResponse> {
        match self.register_agent(request.clone()).await {
            Ok(response) => Ok(response),
            Err(RelayError::Api { code, .. }) if code == "agent_already_exists" => {
                let agent = self.get_agent(&request.name).await?;
                let token_response = self.rotate_agent_token(&agent.name).await?;
                Ok(CreateAgentResponse {
                    id: agent.id,
                    name: agent.name,
                    token: token_response.token,
                    status: agent.status,
                    created_at: agent.created_at,
                })
            }
            Err(e) => Err(e),
        }
    }

    /// Spawn an agent process (registering if needed).
    pub async fn spawn_agent(&self, request: SpawnAgentRequest) -> Result<SpawnAgentResponse> {
        self.client
            .post("/v1/agents/spawn", Some(request), None)
            .await
    }

    /// Release an agent process (optionally deleting the agent).
    pub async fn release_agent(
        &self,
        request: ReleaseAgentRequest,
    ) -> Result<ReleaseAgentResponse> {
        self.client
            .post("/v1/agents/release", Some(request), None)
            .await
    }

    // === Webhooks ===

    /// Create a webhook.
    pub async fn create_webhook(
        &self,
        request: CreateWebhookRequest,
    ) -> Result<CreateWebhookResponse> {
        self.client.post("/v1/webhooks", Some(request), None).await
    }

    /// List webhooks.
    pub async fn list_webhooks(&self) -> Result<Vec<Webhook>> {
        self.client.get("/v1/webhooks", None, None).await
    }

    /// Delete a webhook.
    pub async fn delete_webhook(&self, id: &str) -> Result<()> {
        self.client
            .delete(&format!("/v1/webhooks/{}", urlencoding::encode(id)), None)
            .await
    }

    /// Trigger a webhook.
    pub async fn trigger_webhook(
        &self,
        webhook_id: &str,
        request: WebhookTriggerRequest,
    ) -> Result<WebhookTriggerResponse> {
        self.client
            .post(
                &format!("/v1/hooks/{}", urlencoding::encode(webhook_id)),
                Some(request),
                None,
            )
            .await
    }

    // === Subscriptions ===

    /// Create an event subscription.
    pub async fn create_subscription(
        &self,
        request: CreateSubscriptionRequest,
    ) -> Result<CreateSubscriptionResponse> {
        self.client
            .post("/v1/subscriptions", Some(request), None)
            .await
    }

    /// List event subscriptions.
    pub async fn list_subscriptions(&self) -> Result<Vec<EventSubscription>> {
        self.client.get("/v1/subscriptions", None, None).await
    }

    /// Get an event subscription.
    pub async fn get_subscription(&self, id: &str) -> Result<EventSubscription> {
        self.client
            .get(
                &format!("/v1/subscriptions/{}", urlencoding::encode(id)),
                None,
                None,
            )
            .await
    }

    /// Delete an event subscription.
    pub async fn delete_subscription(&self, id: &str) -> Result<()> {
        self.client
            .delete(
                &format!("/v1/subscriptions/{}", urlencoding::encode(id)),
                None,
            )
            .await
    }

    // === Commands ===

    /// Register a command.
    pub async fn register_command(
        &self,
        request: CreateCommandRequest,
    ) -> Result<CreateCommandResponse> {
        self.client.post("/v1/commands", Some(request), None).await
    }

    /// List commands.
    pub async fn list_commands(&self) -> Result<Vec<AgentCommand>> {
        self.client.get("/v1/commands", None, None).await
    }

    /// Delete a command.
    pub async fn delete_command(&self, command: &str) -> Result<()> {
        self.client
            .delete(
                &format!("/v1/commands/{}", urlencoding::encode(command)),
                None,
            )
            .await
    }

    // === Stats & Activity ===

    /// Get workspace statistics.
    pub async fn stats(&self) -> Result<WorkspaceStats> {
        self.client.get("/v1/workspace/stats", None, None).await
    }

    /// Get recent activity.
    pub async fn activity(&self, limit: Option<i32>) -> Result<Vec<ActivityItem>> {
        let limit_str = limit.map(|l| l.to_string());
        let query: Vec<(&str, &str)> = limit_str
            .as_ref()
            .map(|l| vec![("limit", l.as_str())])
            .unwrap_or_default();

        let query_ref = if query.is_empty() {
            None
        } else {
            Some(query.as_slice())
        };

        self.client.get("/v1/activity", query_ref, None).await
    }

    /// Get all DM conversations in the workspace.
    pub async fn all_dm_conversations(&self) -> Result<Vec<WorkspaceDmConversation>> {
        self.client
            .get("/v1/dm/conversations/all", None, None)
            .await
    }

    /// Get DM messages for a workspace conversation.
    pub async fn dm_messages(
        &self,
        conversation_id: &str,
        opts: Option<MessageListQuery>,
    ) -> Result<Vec<WorkspaceDmMessage>> {
        let opts = opts.unwrap_or_default();
        let mut query_params: Vec<(String, String)> = Vec::new();
        if let Some(limit) = opts.limit {
            query_params.push(("limit".to_string(), limit.to_string()));
        }
        if let Some(before) = opts.before {
            query_params.push(("before".to_string(), before));
        }
        if let Some(after) = opts.after {
            query_params.push(("after".to_string(), after));
        }

        let query: Vec<(&str, &str)> = query_params
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect();

        let query_ref = if query.is_empty() {
            None
        } else {
            Some(query.as_slice())
        };

        self.client
            .get(
                &format!(
                    "/v1/dm/conversations/{}/messages",
                    urlencoding::encode(conversation_id)
                ),
                query_ref,
                None,
            )
            .await
    }
}
