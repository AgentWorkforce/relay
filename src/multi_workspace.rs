use std::{
    collections::{HashMap, HashSet},
    time::Duration,
};

use relaycast::{WorkspaceDmConversation, WorkspaceDmMessage};
use serde_json::{json, Value};
use tokio::{sync::mpsc, time::MissedTickBehavior};

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

const DM_POLL_INTERVAL: Duration = Duration::from_secs(1);
const DM_POLL_BATCH_LIMIT: usize = 50;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct DmConversationCursor {
    last_message_id: Option<String>,
    last_message_at: Option<String>,
    message_count: i64,
}

fn is_group_dm_type(dm_type: &str) -> bool {
    matches!(
        dm_type.trim().to_ascii_lowercase().as_str(),
        "group" | "group_dm"
    )
}

fn direct_dm_target_for_sender(
    conversation: &WorkspaceDmConversation,
    sender_name: &str,
) -> Option<String> {
    if is_group_dm_type(&conversation.dm_type) {
        return None;
    }

    let mut other_participants = conversation
        .participants
        .iter()
        .filter(|participant| !participant.eq_ignore_ascii_case(sender_name))
        .cloned();
    let target = other_participants.next()?;
    if other_participants.next().is_some() {
        return None;
    }
    Some(target)
}

fn sort_workspace_dm_messages(messages: &mut [WorkspaceDmMessage]) {
    messages.sort_by(|left, right| {
        left.created_at
            .cmp(&right.created_at)
            .then_with(|| left.id.cmp(&right.id))
    });
}

fn trim_messages_after_cursor(
    mut messages: Vec<WorkspaceDmMessage>,
    cursor_id: Option<&str>,
) -> Vec<WorkspaceDmMessage> {
    sort_workspace_dm_messages(&mut messages);

    let Some(cursor_id) = cursor_id else {
        return messages;
    };

    match messages.iter().position(|message| message.id == cursor_id) {
        Some(index) => messages.into_iter().skip(index + 1).collect(),
        None => messages,
    }
}

fn build_workspace_dm_event(
    conversation: &WorkspaceDmConversation,
    message: &WorkspaceDmMessage,
) -> Value {
    let mut event = json!({
        "type": if is_group_dm_type(&conversation.dm_type) {
            "group_dm.received"
        } else {
            "dm.received"
        },
        "conversation_id": conversation.id.clone(),
        "message": {
            "id": message.id.clone(),
            "agent_id": message.agent_id.clone(),
            "agent_name": message.agent_name.clone(),
            "text": message.text.clone(),
            "created_at": message.created_at.clone(),
        }
    });

    if let Some(target) = direct_dm_target_for_sender(conversation, &message.agent_name) {
        if let Some(object) = event.as_object_mut() {
            object.insert("target".to_string(), Value::String(target));
        }
    }

    event
}

async fn load_workspace_dm_updates(
    http_client: &RelaycastHttpClient,
    conversation_id: &str,
    cursor_id: Option<&str>,
    limit: usize,
) -> Vec<WorkspaceDmMessage> {
    let messages = http_client
        .get_workspace_dm_messages(conversation_id, cursor_id, limit)
        .await
        .unwrap_or_default();
    let filtered = trim_messages_after_cursor(messages, cursor_id);
    if filtered.is_empty() && cursor_id.is_some() {
        let fallback = http_client
            .get_workspace_dm_messages(conversation_id, None, limit)
            .await
            .unwrap_or_default();
        return trim_messages_after_cursor(fallback, cursor_id);
    }
    filtered
}

async fn poll_workspace_dms(http_client: RelaycastHttpClient, inbound_tx: mpsc::Sender<Value>) {
    let mut interval = tokio::time::interval(DM_POLL_INTERVAL);
    interval.set_missed_tick_behavior(MissedTickBehavior::Skip);

    let mut primed = false;
    let mut cursors: HashMap<String, DmConversationCursor> = HashMap::new();

    loop {
        interval.tick().await;

        let conversations = match http_client.get_all_dm_conversations().await {
            Ok(conversations) => conversations,
            Err(error) => {
                tracing::debug!(error = %error, "failed to fetch workspace DM conversations");
                continue;
            }
        };

        let active_ids: HashSet<String> = conversations
            .iter()
            .map(|conversation| conversation.id.clone())
            .collect();
        cursors.retain(|conversation_id, _| active_ids.contains(conversation_id));

        for conversation in conversations {
            let last_message_at = conversation
                .last_message
                .as_ref()
                .map(|message| message.created_at.clone());
            let previous = cursors.get(&conversation.id).cloned();
            let changed = previous.as_ref().is_none_or(|cursor| {
                cursor.message_count != conversation.message_count
                    || cursor.last_message_at != last_message_at
            });
            if !changed {
                continue;
            }

            let cursor_id = if primed {
                previous
                    .as_ref()
                    .and_then(|cursor| cursor.last_message_id.as_deref())
            } else {
                None
            };
            let fetch_limit = if primed { DM_POLL_BATCH_LIMIT } else { 1 };
            let new_messages =
                load_workspace_dm_updates(&http_client, &conversation.id, cursor_id, fetch_limit)
                    .await;
            let newest_message_id = new_messages
                .last()
                .map(|message| message.id.clone())
                .or_else(|| {
                    previous
                        .as_ref()
                        .and_then(|cursor| cursor.last_message_id.clone())
                });

            if primed {
                for message in &new_messages {
                    if inbound_tx
                        .send(build_workspace_dm_event(&conversation, message))
                        .await
                        .is_err()
                    {
                        return;
                    }
                }
            }

            cursors.insert(
                conversation.id.clone(),
                DmConversationCursor {
                    last_message_id: newest_message_id,
                    last_message_at,
                    message_count: conversation.message_count,
                },
            );
        }

        primed = true;
    }
}

impl MultiWorkspaceSession {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        http_base: impl Into<String>,
        ws_base: impl Into<String>,
        auth: AuthClient,
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
            let ws_client = RelaycastWsClient::new(
                ws_base.clone(),
                auth.clone(),
                self_token.clone(),
                session.credentials,
                channels.clone(),
            );
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
            let dm_poll_tx = workspace_tx.clone();
            let dm_poll_http = http_client.clone();
            tokio::spawn(async move {
                ws_client
                    .run(workspace_tx, ws_control_rx, workspace_events)
                    .await;
            });
            tokio::spawn(async move {
                poll_workspace_dms(dm_poll_http, dm_poll_tx).await;
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

#[cfg(test)]
mod tests {
    use relaycast::{types::WorkspaceDmLastMessage, WorkspaceDmConversation, WorkspaceDmMessage};
    use serde_json::json;

    use super::{
        build_workspace_dm_event, direct_dm_target_for_sender, is_group_dm_type,
        trim_messages_after_cursor,
    };

    fn dm_conversation(dm_type: &str, participants: &[&str]) -> WorkspaceDmConversation {
        WorkspaceDmConversation {
            id: "dm_123".to_string(),
            dm_type: dm_type.to_string(),
            participants: participants
                .iter()
                .map(|participant| participant.to_string())
                .collect(),
            last_message: Some(WorkspaceDmLastMessage {
                text: "latest".to_string(),
                agent_name: "alice".to_string(),
                created_at: "2026-03-12T10:00:00.000Z".to_string(),
            }),
            message_count: 2,
        }
    }

    fn dm_message(id: &str, agent_name: &str, created_at: &str) -> WorkspaceDmMessage {
        WorkspaceDmMessage {
            id: id.to_string(),
            agent_id: format!("agent_{agent_name}"),
            agent_name: agent_name.to_string(),
            text: format!("message from {agent_name}"),
            created_at: created_at.to_string(),
        }
    }

    #[test]
    fn group_dm_types_are_recognized() {
        assert!(is_group_dm_type("group"));
        assert!(is_group_dm_type("group_dm"));
        assert!(!is_group_dm_type("dm"));
    }

    #[test]
    fn direct_dm_target_uses_other_participant() {
        let conversation = dm_conversation("dm", &["alice", "bob"]);
        assert_eq!(
            direct_dm_target_for_sender(&conversation, "alice").as_deref(),
            Some("bob")
        );
    }

    #[test]
    fn build_workspace_dm_event_includes_direct_target_for_one_to_one_dm() {
        let conversation = dm_conversation("dm", &["alice", "bob"]);
        let message = dm_message("147310274064424960", "alice", "2026-03-12T10:00:00.000Z");

        let event = build_workspace_dm_event(&conversation, &message);

        assert_eq!(
            event,
            json!({
                "type": "dm.received",
                "conversation_id": "dm_123",
                "target": "bob",
                "message": {
                    "id": "147310274064424960",
                    "agent_id": "agent_alice",
                    "agent_name": "alice",
                    "text": "message from alice",
                    "created_at": "2026-03-12T10:00:00.000Z"
                }
            })
        );
    }

    #[test]
    fn build_workspace_dm_event_omits_target_for_group_dm() {
        let conversation = dm_conversation("group", &["alice", "bob", "carol"]);
        let message = dm_message("147310274064424961", "alice", "2026-03-12T10:00:01.000Z");

        let event = build_workspace_dm_event(&conversation, &message);

        assert_eq!(
            event,
            json!({
                "type": "group_dm.received",
                "conversation_id": "dm_123",
                "message": {
                    "id": "147310274064424961",
                    "agent_id": "agent_alice",
                    "agent_name": "alice",
                    "text": "message from alice",
                    "created_at": "2026-03-12T10:00:01.000Z"
                }
            })
        );
    }

    #[test]
    fn trim_messages_after_cursor_sorts_and_keeps_only_newer_messages() {
        let messages = vec![
            dm_message("3", "alice", "2026-03-12T10:00:03.000Z"),
            dm_message("1", "alice", "2026-03-12T10:00:01.000Z"),
            dm_message("2", "bob", "2026-03-12T10:00:02.000Z"),
        ];

        let filtered = trim_messages_after_cursor(messages, Some("1"));
        let ids: Vec<String> = filtered.into_iter().map(|message| message.id).collect();

        assert_eq!(ids, vec!["2".to_string(), "3".to_string()]);
    }
}
