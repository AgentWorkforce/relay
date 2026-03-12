use std::collections::{HashMap, HashSet};

use serde_json::Value;
use tokio::sync::mpsc;

use crate::{
    auth::{AuthClient, AuthSessionSet},
    events::EventEmitter,
    relaycast_ws::{RelaycastHttpClient, RelaycastWsClient, WsControl},
};

#[derive(Debug, Clone)]
pub struct WorkspaceInboundMessage {
    pub workspace_id: String,
    pub workspace_alias: Option<String>,
    pub value: Value,
}

#[derive(Clone)]
pub struct WorkspaceSessionHandle {
    pub workspace_id: String,
    pub workspace_alias: Option<String>,
    pub relay_workspace_key: String,
    pub self_name: String,
    pub self_agent_id: String,
    pub self_names: HashSet<String>,
    pub self_agent_ids: HashSet<String>,
    pub http_client: RelaycastHttpClient,
    pub ws_control_tx: mpsc::Sender<WsControl>,
}

pub struct MultiWorkspaceSession {
    pub default_workspace_id: Option<String>,
    pub handles: Vec<WorkspaceSessionHandle>,
    pub inbound_rx: mpsc::Receiver<WorkspaceInboundMessage>,
}

impl MultiWorkspaceSession {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        http_base: impl Into<String>,
        ws_base: impl Into<String>,
        _auth: AuthClient,
        sessions: AuthSessionSet,
        channels: Vec<String>,
        read_mcp_identity: bool,
        runtime_cwd: &std::path::Path,
        events: EventEmitter,
    ) -> Self {
        let http_base = http_base.into();
        let ws_base = ws_base.into();
        let (merged_tx, inbound_rx) = mpsc::channel(1024);
        let mut handles = Vec::with_capacity(sessions.memberships.len());

        for session in sessions.memberships {
            let workspace_id = session.credentials.workspace_id.clone();
            let workspace_alias = session.credentials.workspace_alias.clone();
            let relay_workspace_key = session.credentials.api_key.clone();
            let self_agent_id = session.credentials.agent_id.clone();
            let self_token = session.token.clone();
            let self_name = session
                .credentials
                .agent_name
                .clone()
                .unwrap_or_else(|| "broker".to_string());

            let mut self_names = HashSet::new();
            self_names.insert(self_name.clone());
            if read_mcp_identity {
                if let Ok(mcp_json) = std::fs::read_to_string(runtime_cwd.join(".mcp.json")) {
                    if let Ok(parsed) = serde_json::from_str::<Value>(&mcp_json) {
                        if let Some(mcp_name) = parsed
                            .pointer("/mcpServers/relaycast/env/RELAY_AGENT_NAME")
                            .and_then(Value::as_str)
                        {
                            if !mcp_name.is_empty() {
                                self_names.insert(mcp_name.to_string());
                            }
                        }
                    }
                }
            }

            let mut self_agent_ids = HashSet::new();
            self_agent_ids.insert(self_agent_id.clone());

            let http_client = RelaycastHttpClient::new(
                http_base.clone(),
                relay_workspace_key.clone(),
                self_name.clone(),
                "claude",
            );
            http_client.seed_agent_token(&self_name, &self_token);

            let (workspace_tx, mut workspace_rx) = mpsc::channel(512);
            let (ws_control_tx, ws_control_rx) = mpsc::channel(8);
            let ws_client =
                RelaycastWsClient::new(ws_base.clone(), http_client.clone(), channels.clone());
            let merged_tx_clone = merged_tx.clone();
            let workspace_id_clone = workspace_id.clone();
            let workspace_alias_clone = workspace_alias.clone();
            tokio::spawn(async move {
                while let Some(value) = workspace_rx.recv().await {
                    if merged_tx_clone
                        .send(WorkspaceInboundMessage {
                            workspace_id: workspace_id_clone.clone(),
                            workspace_alias: workspace_alias_clone.clone(),
                            value,
                        })
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            });

            let workspace_events = events.clone();
            tokio::spawn(async move {
                ws_client
                    .run(workspace_tx, ws_control_rx, workspace_events)
                    .await;
            });

            handles.push(WorkspaceSessionHandle {
                workspace_id,
                workspace_alias,
                relay_workspace_key,
                self_name,
                self_agent_id,
                self_names,
                self_agent_ids,
                http_client,
                ws_control_tx,
            });
        }

        Self {
            default_workspace_id: sessions.default_workspace_id,
            handles,
            inbound_rx,
        }
    }

    pub fn is_multi_workspace(&self) -> bool {
        self.handles.len() > 1
    }

    pub fn membership_summaries(&self) -> Vec<WorkspaceMembershipSummary> {
        self.handles
            .iter()
            .map(|handle| WorkspaceMembershipSummary {
                workspace_id: handle.workspace_id.clone(),
                workspace_alias: handle.workspace_alias.clone(),
                is_default: self
                    .default_workspace_id
                    .as_deref()
                    .is_some_and(|workspace_id| workspace_id == handle.workspace_id),
            })
            .collect()
    }

    pub fn handle_by_selector(&self, selector: &str) -> Option<&WorkspaceSessionHandle> {
        let trimmed = selector.trim();
        self.handles.iter().find(|handle| {
            handle.workspace_id == trimmed
                || handle
                    .workspace_alias
                    .as_deref()
                    .is_some_and(|alias| alias.eq_ignore_ascii_case(trimmed))
        })
    }

    pub fn default_handle(&self) -> Option<&WorkspaceSessionHandle> {
        if let Some(default_workspace_id) = self.default_workspace_id.as_deref() {
            self.handle_by_selector(default_workspace_id)
        } else if self.handles.len() == 1 {
            self.handles.first()
        } else {
            None
        }
    }

    pub fn http_clients_by_workspace_id(&self) -> HashMap<String, RelaycastHttpClient> {
        self.handles
            .iter()
            .map(|handle| (handle.workspace_id.clone(), handle.http_client.clone()))
            .collect()
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct WorkspaceMembershipSummary {
    pub workspace_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_alias: Option<String>,
    pub is_default: bool,
}
