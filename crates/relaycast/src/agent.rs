//! Agent client for message and channel operations.

use crate::client::{ClientOptions, HttpClient, RequestOptions};
use crate::error::Result;
use crate::types::*;
use crate::ws::{EventReceiver, LifecycleReceiver, WsClient, WsClientOptions};

/// Strip leading '#' from channel names.
fn strip_hash(channel: &str) -> &str {
    channel.strip_prefix('#').unwrap_or(channel)
}

/// Client for agent-level operations.
pub struct AgentClient {
    client: HttpClient,
    ws: Option<WsClient>,
}

impl AgentClient {
    /// Create a new agent client with the given token.
    pub fn new(token: impl Into<String>, base_url: Option<String>) -> Result<Self> {
        let mut options = ClientOptions::new(token);
        if let Some(url) = base_url {
            options = options.with_base_url(url);
        }
        let client = HttpClient::new(options)?;
        Ok(Self { client, ws: None })
    }

    /// Create a new agent client from an existing HTTP client.
    pub(crate) fn from_client(client: HttpClient) -> Self {
        Self { client, ws: None }
    }

    /// Get a reference to the underlying HTTP client.
    pub fn http_client(&self) -> &HttpClient {
        &self.client
    }

    /// Replace the agent token for HTTP and WebSocket operations.
    pub async fn set_token(&mut self, token: impl Into<String>) -> Result<()> {
        let token = token.into();
        self.client = self.client.with_api_key(token.clone())?;
        if let Some(ws) = self.ws.as_ref() {
            ws.set_token(token).await;
        }
        Ok(())
    }

    // === WebSocket ===

    /// Connect to the WebSocket server for real-time events.
    pub async fn connect(&mut self) -> Result<()> {
        if self.ws.is_some() {
            return Ok(());
        }

        let options = WsClientOptions::new(self.client.api_key())
            .with_base_url(self.client.base_url())
            .with_origin(
                self.client.origin_surface(),
                self.client.origin_client(),
                self.client.origin_version(),
            );
        let mut ws = WsClient::new(options);
        ws.connect().await?;
        self.ws = Some(ws);
        Ok(())
    }

    /// Send a REST heartbeat to keep this agent online without a WebSocket ping.
    pub async fn heartbeat(&self) -> Result<()> {
        self.client
            .post::<serde_json::Value>("/v1/agents/heartbeat", Some(serde_json::json!({})), None)
            .await?;
        Ok(())
    }

    /// Disconnect from the WebSocket server.
    pub async fn disconnect(&mut self) {
        if self.ws.is_some() {
            // Keep parity with TypeScript SDK: best-effort REST disconnect before socket close.
            let _ = self
                .client
                .post::<serde_json::Value>(
                    "/v1/agents/disconnect",
                    Some(serde_json::json!({})),
                    None,
                )
                .await;
        }

        if let Some(ref mut ws) = self.ws {
            ws.disconnect().await;
        }
        self.ws = None;
    }

    /// Subscribe to receive WebSocket events.
    pub fn subscribe_events(&self) -> Result<EventReceiver> {
        self.ws
            .as_ref()
            .map(|ws| ws.subscribe_events())
            .ok_or(crate::error::RelayError::NotConnected)
    }

    /// Subscribe to lifecycle events such as connect/reconnect/close.
    pub fn subscribe_lifecycle(&self) -> Result<LifecycleReceiver> {
        self.ws
            .as_ref()
            .map(|ws| ws.subscribe_lifecycle())
            .ok_or(crate::error::RelayError::NotConnected)
    }

    /// Subscribe to channels for real-time updates.
    pub async fn subscribe_channels(&self, channels: Vec<String>) -> Result<()> {
        if let Some(ref ws) = self.ws {
            ws.subscribe(channels).await
        } else {
            Err(crate::error::RelayError::NotConnected)
        }
    }

    /// Unsubscribe from channels.
    pub async fn unsubscribe_channels(&self, channels: Vec<String>) -> Result<()> {
        if let Some(ref ws) = self.ws {
            ws.unsubscribe(channels).await
        } else {
            Err(crate::error::RelayError::NotConnected)
        }
    }

    // === Messages ===

    /// Send a message to a channel.
    pub async fn send(
        &self,
        channel: &str,
        text: &str,
        attachments: Option<Vec<String>>,
        blocks: Option<Vec<MessageBlock>>,
        idempotency_key: Option<String>,
    ) -> Result<MessageWithMeta> {
        let name = strip_hash(channel);
        let body = PostMessageRequest {
            text: text.to_string(),
            attachments,
            blocks,
            data: None,
        };
        let options = idempotency_key.map(RequestOptions::with_idempotency_key);
        self.client
            .post(
                &format!("/v1/channels/{}/messages", urlencoding::encode(name)),
                Some(body),
                options,
            )
            .await
    }

    /// Get messages from a channel.
    pub async fn messages(
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
    pub async fn message(&self, id: &str) -> Result<MessageWithMeta> {
        self.client
            .get(
                &format!("/v1/messages/{}", urlencoding::encode(id)),
                None,
                None,
            )
            .await
    }

    /// Reply to a message thread.
    pub async fn reply(
        &self,
        message_id: &str,
        text: &str,
        blocks: Option<Vec<MessageBlock>>,
        idempotency_key: Option<String>,
    ) -> Result<MessageWithMeta> {
        let body = ThreadReplyRequest {
            text: text.to_string(),
            blocks,
            data: None,
        };
        let options = idempotency_key.map(RequestOptions::with_idempotency_key);
        self.client
            .post(
                &format!("/v1/messages/{}/replies", urlencoding::encode(message_id)),
                Some(body),
                options,
            )
            .await
    }

    /// Get a thread (parent message and replies).
    pub async fn thread(
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

    // === DMs ===

    /// Send a direct message to another agent.
    pub async fn dm(
        &self,
        agent: &str,
        text: &str,
        idempotency_key: Option<String>,
    ) -> Result<serde_json::Value> {
        let body = SendDmRequest {
            to: agent.to_string(),
            text: text.to_string(),
        };
        let options = idempotency_key.map(RequestOptions::with_idempotency_key);
        self.client.post("/v1/dm", Some(body), options).await
    }

    /// Send a direct message to another agent (typed response).
    pub async fn dm_typed(
        &self,
        agent: &str,
        text: &str,
        idempotency_key: Option<String>,
    ) -> Result<DmSendResponse> {
        let body = SendDmRequest {
            to: agent.to_string(),
            text: text.to_string(),
        };
        let options = idempotency_key.map(RequestOptions::with_idempotency_key);
        self.client.post("/v1/dm", Some(body), options).await
    }

    /// Get DM conversations.
    pub async fn dm_conversations(&self) -> Result<Vec<DmConversationSummary>> {
        self.client.get("/v1/dm/conversations", None, None).await
    }

    /// Get messages from a DM conversation.
    pub async fn dm_messages(
        &self,
        conversation_id: &str,
        opts: Option<MessageListQuery>,
    ) -> Result<Vec<MessageWithMeta>> {
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
                &format!("/v1/dm/{}/messages", urlencoding::encode(conversation_id)),
                query_ref,
                None,
            )
            .await
    }

    /// Create a group DM.
    pub async fn create_group_dm(
        &self,
        request: CreateGroupDmRequest,
    ) -> Result<serde_json::Value> {
        self.client.post("/v1/dm/group", Some(request), None).await
    }

    /// Create a group DM (typed response).
    pub async fn create_group_dm_typed(
        &self,
        request: CreateGroupDmRequest,
    ) -> Result<GroupDmConversationResponse> {
        self.client.post("/v1/dm/group", Some(request), None).await
    }

    /// Send a message to a DM conversation.
    pub async fn send_dm_message(
        &self,
        conversation_id: &str,
        text: &str,
        idempotency_key: Option<String>,
    ) -> Result<serde_json::Value> {
        let body = serde_json::json!({ "text": text });
        let options = idempotency_key.map(RequestOptions::with_idempotency_key);
        self.client
            .post(
                &format!("/v1/dm/{}/messages", urlencoding::encode(conversation_id)),
                Some(body),
                options,
            )
            .await
    }

    /// Send a message to a DM conversation (typed response).
    pub async fn send_dm_message_typed(
        &self,
        conversation_id: &str,
        text: &str,
        idempotency_key: Option<String>,
    ) -> Result<GroupDmMessageResponse> {
        let body = serde_json::json!({ "text": text });
        let options = idempotency_key.map(RequestOptions::with_idempotency_key);
        self.client
            .post(
                &format!("/v1/dm/{}/messages", urlencoding::encode(conversation_id)),
                Some(body),
                options,
            )
            .await
    }

    /// Add a participant to a group DM.
    pub async fn add_dm_participant(
        &self,
        conversation_id: &str,
        agent: &str,
    ) -> Result<serde_json::Value> {
        let body = serde_json::json!({ "agent_name": agent });
        self.client
            .post(
                &format!(
                    "/v1/dm/{}/participants",
                    urlencoding::encode(conversation_id)
                ),
                Some(body),
                None,
            )
            .await
    }

    /// Add a participant to a group DM (typed response).
    pub async fn add_dm_participant_typed(
        &self,
        conversation_id: &str,
        agent: &str,
    ) -> Result<GroupDmParticipantResponse> {
        let body = serde_json::json!({ "agent_name": agent });
        self.client
            .post(
                &format!(
                    "/v1/dm/{}/participants",
                    urlencoding::encode(conversation_id)
                ),
                Some(body),
                None,
            )
            .await
    }

    /// Remove a participant from a group DM.
    pub async fn remove_dm_participant(&self, conversation_id: &str, agent: &str) -> Result<()> {
        self.client
            .delete(
                &format!(
                    "/v1/dm/{}/participants/{}",
                    urlencoding::encode(conversation_id),
                    urlencoding::encode(agent)
                ),
                None,
            )
            .await
    }

    // === Channels ===

    /// Create a new channel.
    pub async fn create_channel(&self, request: CreateChannelRequest) -> Result<Channel> {
        self.client.post("/v1/channels", Some(request), None).await
    }

    /// List channels.
    pub async fn list_channels(&self, include_archived: bool) -> Result<Vec<Channel>> {
        let query = if include_archived {
            Some([("include_archived", "true")].as_slice())
        } else {
            None
        };
        self.client.get("/v1/channels", query, None).await
    }

    /// Get a channel by name.
    pub async fn get_channel(&self, name: &str) -> Result<ChannelWithMembers> {
        self.client
            .get(
                &format!("/v1/channels/{}", urlencoding::encode(name)),
                None,
                None,
            )
            .await
    }

    /// Join a channel.
    pub async fn join_channel(&self, name: &str) -> Result<serde_json::Value> {
        self.client
            .post(
                &format!("/v1/channels/{}/join", urlencoding::encode(name)),
                None::<()>,
                None,
            )
            .await
    }

    /// Leave a channel.
    pub async fn leave_channel(&self, name: &str) -> Result<()> {
        self.client
            .post::<()>(
                &format!("/v1/channels/{}/leave", urlencoding::encode(name)),
                None::<()>,
                None,
            )
            .await?;
        Ok(())
    }

    /// Set a channel's topic.
    pub async fn set_channel_topic(&self, name: &str, topic: &str) -> Result<Channel> {
        let body = serde_json::json!({ "topic": topic });
        self.client
            .patch(
                &format!("/v1/channels/{}/topic", urlencoding::encode(name)),
                Some(body),
                None,
            )
            .await
    }

    /// Archive a channel.
    pub async fn archive_channel(&self, name: &str) -> Result<()> {
        self.client
            .delete(&format!("/v1/channels/{}", urlencoding::encode(name)), None)
            .await
    }

    /// Invite an agent to a channel.
    pub async fn invite_to_channel(&self, channel: &str, agent: &str) -> Result<serde_json::Value> {
        let body = serde_json::json!({ "agent": agent });
        self.client
            .post(
                &format!("/v1/channels/{}/invite", urlencoding::encode(channel)),
                Some(body),
                None,
            )
            .await
    }

    /// Get channel members.
    pub async fn channel_members(&self, name: &str) -> Result<Vec<ChannelMemberInfo>> {
        self.client
            .get(
                &format!("/v1/channels/{}/members", urlencoding::encode(name)),
                None,
                None,
            )
            .await
    }

    /// Update a channel.
    pub async fn update_channel(
        &self,
        name: &str,
        request: UpdateChannelRequest,
    ) -> Result<Channel> {
        self.client
            .patch(
                &format!("/v1/channels/{}", urlencoding::encode(name)),
                Some(request),
                None,
            )
            .await
    }

    // === Reactions ===

    /// Add a reaction to a message.
    pub async fn react(&self, message_id: &str, emoji: &str) -> Result<serde_json::Value> {
        let body = serde_json::json!({ "emoji": emoji });
        self.client
            .post(
                &format!("/v1/messages/{}/reactions", urlencoding::encode(message_id)),
                Some(body),
                None,
            )
            .await
    }

    /// Remove a reaction from a message.
    pub async fn unreact(&self, message_id: &str, emoji: &str) -> Result<()> {
        self.client
            .delete(
                &format!(
                    "/v1/messages/{}/reactions/{}",
                    urlencoding::encode(message_id),
                    urlencoding::encode(emoji)
                ),
                None,
            )
            .await
    }

    /// Get reactions on a message.
    pub async fn reactions(&self, message_id: &str) -> Result<Vec<ReactionGroup>> {
        self.client
            .get(
                &format!("/v1/messages/{}/reactions", urlencoding::encode(message_id)),
                None,
                None,
            )
            .await
    }

    // === Search ===

    /// Search for messages.
    pub async fn search(
        &self,
        query: &str,
        opts: Option<SearchOptions>,
    ) -> Result<Vec<serde_json::Value>> {
        let opts = opts.unwrap_or_default();

        let mut query_params: Vec<(String, String)> = vec![("q".to_string(), query.to_string())];
        if let Some(channel) = opts.channel {
            query_params.push(("channel".to_string(), channel));
        }
        if let Some(from) = opts.from {
            query_params.push(("from".to_string(), from));
        }
        if let Some(limit) = opts.limit {
            query_params.push(("limit".to_string(), limit.to_string()));
        }
        if let Some(before) = opts.before {
            query_params.push(("before".to_string(), before));
        }
        if let Some(after) = opts.after {
            query_params.push(("after".to_string(), after));
        }

        let query_slice: Vec<(&str, &str)> = query_params
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect();

        self.client
            .get("/v1/search", Some(query_slice.as_slice()), None)
            .await
    }

    // === Inbox ===

    /// Get the agent's inbox.
    pub async fn inbox(&self) -> Result<InboxResponse> {
        self.client.get("/v1/inbox", None, None).await
    }

    // === Read Receipts ===

    /// Mark a message as read.
    pub async fn mark_read(&self, message_id: &str) -> Result<serde_json::Value> {
        self.client
            .post(
                &format!("/v1/messages/{}/read", urlencoding::encode(message_id)),
                None::<()>,
                None,
            )
            .await
    }

    /// Get readers of a message.
    pub async fn readers(&self, message_id: &str) -> Result<Vec<ReaderInfo>> {
        self.client
            .get(
                &format!("/v1/messages/{}/readers", urlencoding::encode(message_id)),
                None,
                None,
            )
            .await
    }

    /// Get read status for a channel.
    pub async fn read_status(&self, channel: &str) -> Result<Vec<ChannelReadStatus>> {
        let name = strip_hash(channel);
        self.client
            .get(
                &format!("/v1/channels/{}/read-status", urlencoding::encode(name)),
                None,
                None,
            )
            .await
    }

    // === Commands ===

    /// Invoke a command.
    pub async fn invoke_command(
        &self,
        command: &str,
        request: InvokeCommandRequest,
    ) -> Result<CommandInvocation> {
        self.client
            .post(
                &format!("/v1/commands/{}/invoke", urlencoding::encode(command)),
                Some(request),
                None,
            )
            .await
    }

    // === Files ===

    /// Request a file upload.
    pub async fn upload_file(&self, request: UploadRequest) -> Result<UploadResponse> {
        self.client
            .post("/v1/files/upload", Some(request), None)
            .await
    }

    /// Complete a file upload.
    pub async fn complete_upload(&self, file_id: &str) -> Result<FileInfo> {
        self.client
            .post(
                &format!("/v1/files/{}/complete", urlencoding::encode(file_id)),
                None::<()>,
                None,
            )
            .await
    }

    /// Get file info.
    pub async fn get_file(&self, file_id: &str) -> Result<FileInfo> {
        self.client
            .get(
                &format!("/v1/files/{}", urlencoding::encode(file_id)),
                None,
                None,
            )
            .await
    }

    /// Delete a file.
    pub async fn delete_file(&self, file_id: &str) -> Result<()> {
        self.client
            .delete(&format!("/v1/files/{}", urlencoding::encode(file_id)), None)
            .await
    }

    /// List files.
    pub async fn list_files(&self, opts: Option<FileListOptions>) -> Result<Vec<FileInfo>> {
        let opts = opts.unwrap_or_default();

        let mut query_params: Vec<(String, String)> = Vec::new();
        if let Some(uploaded_by) = opts.uploaded_by {
            query_params.push(("uploaded_by".to_string(), uploaded_by));
        }
        if let Some(limit) = opts.limit {
            query_params.push(("limit".to_string(), limit.to_string()));
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

        self.client.get("/v1/files", query_ref, None).await
    }
}
