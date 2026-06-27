use std::collections::{HashMap, HashSet};

use serde_json::Value;
use tokio::sync::mpsc;

use crate::events::EventEmitter;
use crate::ids::{AgentId, WorkspaceAlias, WorkspaceId};

use super::{
    auth::{AuthClient, AuthSessionSet},
    ws::{RelaycastHttpClient, WsControl},
};

#[derive(Debug, Clone)]
pub struct WorkspaceInboundMessage {
    pub workspace_id: WorkspaceId,
    pub workspace_alias: Option<WorkspaceAlias>,
    pub value: Value,
}

#[derive(Clone)]
pub struct WorkspaceSessionHandle {
    pub workspace_id: WorkspaceId,
    pub workspace_alias: Option<WorkspaceAlias>,
    pub relay_workspace_key: String,
    pub self_name: String,
    pub self_agent_id: AgentId,
    pub self_names: HashSet<String>,
    pub self_agent_ids: HashSet<AgentId>,
    pub http_client: RelaycastHttpClient,
    pub ws_control_tx: mpsc::Sender<WsControl>,
}

pub struct MultiWorkspaceSession {
    pub default_workspace_id: Option<WorkspaceId>,
    pub handles: Vec<WorkspaceSessionHandle>,
    pub inbound_rx: mpsc::Receiver<WorkspaceInboundMessage>,
}

impl MultiWorkspaceSession {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        http_base: Option<String>,
        _ws_base: Option<String>,
        _auth: AuthClient,
        sessions: AuthSessionSet,
        _channels: Vec<String>,
        read_mcp_identity: bool,
        runtime_cwd: &std::path::Path,
        _events: EventEmitter,
    ) -> Self {
        let (merged_tx, inbound_rx) = mpsc::channel(1024);
        let mut handles = Vec::with_capacity(sessions.memberships.len());

        for session in sessions.memberships {
            let workspace_id = WorkspaceId::new(session.credentials.workspace_id.clone());
            let workspace_alias = session
                .credentials
                .workspace_alias
                .clone()
                .map(WorkspaceAlias::from);
            let relay_workspace_key = session.credentials.api_key.clone();
            let self_agent_id = AgentId::new(session.credentials.agent_id.clone());
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
                        for server_name in ["agent-relay", "relaycast"] {
                            let pointer = format!("/mcpServers/{server_name}/env/RELAY_AGENT_NAME");
                            if let Some(mcp_name) = parsed.pointer(&pointer).and_then(Value::as_str)
                            {
                                if !mcp_name.is_empty() {
                                    self_names.insert(mcp_name.to_string());
                                    break;
                                }
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

            // Node-only delivery (v5.0.1): messages flow over /v1/node/ws and are
            // injected by the fleet handlers. The legacy `/v1/ws` workspace-stream
            // WebSocket is observer-only and rejects the broker's workspace key
            // (HTTP 401), so it is no longer opened. The inbound channel is kept as
            // an inert empty source — nothing produces `WorkspaceInboundMessage`
            // frames now — and the control channel is drained so `WsControl` sends
            // from the runtime/wrap paths never block or error.
            let (ws_control_tx, mut ws_control_rx) = mpsc::channel(8);
            // Hold a sender clone for the lifetime of the drain task so the merged
            // inbound channel stays open (its receiver never observes a spurious
            // close), while the control channel is drained to a no-op.
            let inbound_keepalive = merged_tx.clone();
            tokio::spawn(async move {
                let _inbound_keepalive = inbound_keepalive;
                while ws_control_rx.recv().await.is_some() {}
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
            default_workspace_id: sessions.default_workspace_id.map(WorkspaceId::from),
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

    pub fn http_clients_by_workspace_id(&self) -> HashMap<WorkspaceId, RelaycastHttpClient> {
        self.handles
            .iter()
            .map(|handle| (handle.workspace_id.clone(), handle.http_client.clone()))
            .collect()
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct WorkspaceMembershipSummary {
    pub workspace_id: WorkspaceId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_alias: Option<WorkspaceAlias>,
    pub is_default: bool,
}
