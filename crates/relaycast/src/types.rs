//! Type definitions for the RelayCast SDK.

use serde::{Deserialize, Serialize};

// === API Response Envelope ===

#[derive(Debug, Deserialize)]
pub struct ApiResponse<T> {
    pub ok: bool,
    pub data: Option<T>,
    pub error: Option<ApiErrorInfo>,
    pub cursor: Option<Cursor>,
}

#[derive(Debug, Deserialize)]
pub struct ApiErrorInfo {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Deserialize)]
pub struct Cursor {
    pub next: Option<String>,
    pub has_more: bool,
}

// === Workspace ===

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub api_key_hash: String,
    pub system_prompt: Option<String>,
    pub plan: String,
    pub created_at: String,
    pub metadata: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateWorkspaceResponse {
    pub workspace_id: String,
    pub api_key: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct UpdateWorkspaceRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemPrompt {
    pub prompt: String,
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct SetSystemPromptRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reset: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceStreamConfig {
    pub enabled: bool,
    pub default_enabled: bool,
    #[serde(rename = "override")]
    pub override_value: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceStats {
    pub agents: AgentStats,
    pub messages: MessageStats,
    pub channels: ChannelStats,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentStats {
    pub total: i64,
    pub online: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageStats {
    pub total: i64,
    pub today: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelStats {
    pub total: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActivityItem {
    #[serde(rename = "type")]
    pub item_type: String,
    pub id: String,
    pub channel_name: Option<String>,
    pub conversation_id: Option<String>,
    pub agent_name: String,
    pub text: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceDmLastMessage {
    pub text: String,
    pub agent_name: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceDmConversation {
    pub id: String,
    #[serde(rename = "type")]
    pub dm_type: String,
    pub participants: Vec<String>,
    pub last_message: Option<WorkspaceDmLastMessage>,
    pub message_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceDmMessage {
    pub id: String,
    pub agent_id: String,
    pub agent_name: String,
    pub text: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenRotateResponse {
    pub name: String,
    pub token: String,
}

// === Agents ===

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Agent {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub agent_type: String,
    pub token_hash: String,
    pub status: String,
    pub persona: Option<String>,
    pub metadata: serde_json::Map<String, serde_json::Value>,
    pub created_at: String,
    pub last_seen: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CreateAgentRequest {
    pub name: String,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub agent_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub persona: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Map<String, serde_json::Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateAgentResponse {
    pub id: String,
    pub name: String,
    pub token: String,
    pub status: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct UpdateAgentRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub persona: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Map<String, serde_json::Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentPresenceInfo {
    pub agent_id: String,
    pub agent_name: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SpawnAgentRequest {
    pub name: String,
    pub cli: String,
    pub task: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub persona: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpawnAgentResponse {
    pub id: String,
    pub name: String,
    pub token: String,
    pub cli: String,
    pub task: String,
    pub channel: Option<String>,
    pub status: String,
    pub created_at: String,
    pub already_existed: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReleaseAgentRequest {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delete_agent: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReleaseAgentResponse {
    pub name: String,
    pub released: bool,
    pub deleted: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct AgentListQuery {
    pub status: Option<String>,
}

// === Channels ===

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Channel {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub channel_type: i64,
    pub topic: Option<String>,
    #[serde(default)]
    pub metadata: serde_json::Map<String, serde_json::Value>,
    pub created_by: Option<String>,
    pub created_at: String,
    pub is_archived: bool,
    pub member_count: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CreateChannelRequest {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub topic: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Map<String, serde_json::Value>>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct UpdateChannelRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub topic: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Map<String, serde_json::Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelMemberInfo {
    pub agent_id: String,
    pub agent_name: String,
    pub role: String,
    pub joined_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelWithMembers {
    #[serde(flatten)]
    pub channel: Channel,
    pub members: Vec<ChannelMemberInfo>,
}

// === Messages ===

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileAttachment {
    pub file_id: String,
    pub filename: String,
    pub url: String,
    pub size: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageBlock {
    #[serde(rename = "type")]
    pub block_type: String,
    #[serde(flatten)]
    pub data: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReactionGroup {
    pub emoji: String,
    pub count: i64,
    pub agents: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageWithMeta {
    pub id: String,
    pub agent_name: String,
    pub agent_id: String,
    pub text: String,
    pub blocks: Option<Vec<MessageBlock>>,
    #[serde(default)]
    pub metadata: serde_json::Map<String, serde_json::Value>,
    #[serde(default)]
    pub attachments: Vec<FileAttachment>,
    pub created_at: String,
    #[serde(default)]
    pub reply_count: i64,
    #[serde(default)]
    pub reactions: Vec<ReactionGroup>,
    #[serde(default)]
    pub read_by_count: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct PostMessageRequest {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocks: Option<Vec<MessageBlock>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Map<String, serde_json::Value>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ThreadReplyRequest {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocks: Option<Vec<MessageBlock>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Map<String, serde_json::Value>>,
}

#[derive(Debug, Clone, Default)]
pub struct MessageListQuery {
    pub limit: Option<i32>,
    pub before: Option<String>,
    pub after: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThreadResponse {
    pub parent: MessageWithMeta,
    pub replies: Vec<MessageWithMeta>,
}

// === DMs ===

#[derive(Debug, Clone, Serialize)]
pub struct SendDmRequest {
    pub to: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CreateGroupDmRequest {
    pub participants: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DmConversationSummary {
    pub id: String,
    #[serde(rename = "type")]
    pub dm_type: String,
    pub name: Option<String>,
    #[serde(default, deserialize_with = "deserialize_dm_participants")]
    pub participants: Vec<String>,
    #[serde(default, deserialize_with = "deserialize_dm_last_message")]
    pub last_message: Option<String>,
    pub unread_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DmSendResponse {
    pub id: String,
    pub conversation_id: String,
    pub from_agent_id: String,
    pub to: String,
    pub text: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupDmParticipantRef {
    pub agent_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupDmConversationResponse {
    pub id: String,
    pub channel_id: String,
    pub dm_type: String,
    pub name: Option<String>,
    pub participants: Vec<GroupDmParticipantRef>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupDmMessageResponse {
    pub id: String,
    pub conversation_id: String,
    pub agent_id: String,
    pub text: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupDmParticipantResponse {
    pub conversation_id: String,
    pub agent: String,
    pub already_member: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
enum DmParticipantValue {
    Name(String),
    Object {
        agent_name: Option<String>,
        agent_id: Option<String>,
    },
}

fn deserialize_dm_participants<'de, D>(
    deserializer: D,
) -> std::result::Result<Vec<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = Vec::<DmParticipantValue>::deserialize(deserializer)?;
    Ok(raw
        .into_iter()
        .filter_map(|item| match item {
            DmParticipantValue::Name(name) if !name.is_empty() => Some(name),
            DmParticipantValue::Object {
                agent_name: Some(name),
                ..
            } if !name.is_empty() => Some(name),
            DmParticipantValue::Object {
                agent_id: Some(id), ..
            } if !id.is_empty() => Some(id),
            _ => None,
        })
        .collect())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
enum DmLastMessageValue {
    Text(String),
    Object {
        text: Option<String>,
        body: Option<String>,
    },
}

fn deserialize_dm_last_message<'de, D>(
    deserializer: D,
) -> std::result::Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = Option::<DmLastMessageValue>::deserialize(deserializer)?;
    Ok(match raw {
        Some(DmLastMessageValue::Text(text)) if !text.is_empty() => Some(text),
        Some(DmLastMessageValue::Object {
            text: Some(text), ..
        }) if !text.is_empty() => Some(text),
        Some(DmLastMessageValue::Object {
            body: Some(body), ..
        }) if !body.is_empty() => Some(body),
        _ => None,
    })
}

// === Search ===

#[derive(Debug, Clone, Default)]
pub struct SearchOptions {
    pub channel: Option<String>,
    pub from: Option<String>,
    pub limit: Option<i32>,
    pub before: Option<String>,
    pub after: Option<String>,
}

// === Inbox ===

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnreadChannel {
    pub channel_name: String,
    pub unread_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InboxMention {
    pub id: String,
    pub channel_name: String,
    pub agent_name: String,
    pub text: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnreadDm {
    pub conversation_id: String,
    pub from: String,
    pub unread_count: i64,
    pub last_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InboxResponse {
    pub unread_channels: Vec<UnreadChannel>,
    pub mentions: Vec<InboxMention>,
    pub unread_dms: Vec<UnreadDm>,
}

// === Read Receipts ===

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReaderInfo {
    pub agent_name: String,
    pub agent_id: String,
    pub read_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelReadStatus {
    pub agent_name: String,
    pub last_read_id: Option<String>,
    pub last_read_at: Option<String>,
}

// === Files ===

#[derive(Debug, Clone, Serialize)]
pub struct UploadRequest {
    pub filename: String,
    pub content_type: String,
    pub size_bytes: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UploadResponse {
    pub file_id: String,
    pub upload_url: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileInfo {
    pub file_id: String,
    pub filename: String,
    pub content_type: String,
    pub size: i64,
    pub url: String,
    pub uploaded_by: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Default)]
pub struct FileListOptions {
    pub uploaded_by: Option<String>,
    pub limit: Option<i32>,
}

// === Webhooks ===

#[derive(Debug, Clone, Serialize)]
pub struct CreateWebhookRequest {
    pub name: String,
    pub channel: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateWebhookResponse {
    pub webhook_id: String,
    pub name: String,
    pub channel: String,
    pub url: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Webhook {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub channel_id: String,
    pub channel_name: String,
    pub url: String,
    pub created_by: Option<String>,
    pub created_at: String,
    pub is_active: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct WebhookTriggerRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocks: Option<Vec<serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<serde_json::Map<String, serde_json::Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebhookTriggerResponse {
    pub message_id: String,
    pub channel: String,
    pub text: String,
    pub created_at: String,
}

// === Subscriptions ===

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubscriptionFilter {
    pub channel: Option<String>,
    pub mentions: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventSubscription {
    pub id: String,
    pub workspace_id: String,
    pub events: Vec<String>,
    pub filter: Option<SubscriptionFilter>,
    pub url: String,
    pub secret: Option<String>,
    pub is_active: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CreateSubscriptionRequest {
    pub events: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filter: Option<SubscriptionFilter>,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secret: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateSubscriptionResponse {
    pub id: String,
    pub events: Vec<String>,
    pub filter: Option<SubscriptionFilter>,
    pub url: String,
    pub is_active: bool,
    pub created_at: String,
}

// === Commands ===

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandParameter {
    pub name: String,
    pub description: Option<String>,
    #[serde(rename = "type")]
    pub parameter_type: String,
    pub required: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CreateCommandRequest {
    pub command: String,
    pub description: String,
    pub handler_agent: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parameters: Option<Vec<CommandParameter>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateCommandResponse {
    pub id: String,
    pub command: String,
    pub description: String,
    pub handler_agent: String,
    pub parameters: Vec<CommandParameter>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentCommand {
    pub id: String,
    pub workspace_id: String,
    pub command: String,
    pub description: String,
    pub handler_agent_id: String,
    pub handler_agent_name: String,
    pub parameters: Vec<CommandParameter>,
    pub created_at: String,
    pub is_active: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct InvokeCommandRequest {
    pub channel: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parameters: Option<serde_json::Map<String, serde_json::Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandInvocation {
    pub id: String,
    pub command: String,
    pub channel: String,
    pub invoked_by: String,
    pub args: Option<String>,
    pub parameters: Option<serde_json::Map<String, serde_json::Value>>,
    pub response_message_id: Option<String>,
    pub created_at: String,
}

// === WebSocket Events ===

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageEventPayload {
    pub id: String,
    #[serde(default)]
    pub agent_id: Option<String>,
    pub agent_name: String,
    pub text: String,
    pub attachments: Vec<FileAttachment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageUpdatedPayload {
    pub id: String,
    #[serde(default)]
    pub agent_id: Option<String>,
    pub agent_name: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThreadReplyPayload {
    pub id: String,
    #[serde(default)]
    pub agent_id: Option<String>,
    pub agent_name: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DmEventPayload {
    pub id: String,
    #[serde(default)]
    pub agent_id: Option<String>,
    pub agent_name: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentEventPayload {
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelEventPayload {
    pub name: String,
    pub topic: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelArchivedPayload {
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEventPayload {
    pub file_id: String,
    pub filename: String,
    pub uploaded_by: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebhookMessagePayload {
    pub id: String,
    pub text: String,
    pub source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum WsEvent {
    #[serde(rename = "message.created")]
    MessageCreated(MessageCreatedEvent),
    #[serde(rename = "message.updated")]
    MessageUpdated(MessageUpdatedEvent),
    #[serde(rename = "thread.reply")]
    ThreadReply(ThreadReplyEvent),
    #[serde(rename = "reaction.added")]
    ReactionAdded(ReactionAddedEvent),
    #[serde(rename = "reaction.removed")]
    ReactionRemoved(ReactionRemovedEvent),
    #[serde(rename = "dm.received")]
    DmReceived(DmReceivedEvent),
    #[serde(rename = "group_dm.received")]
    GroupDmReceived(GroupDmReceivedEvent),
    #[serde(rename = "agent.online")]
    AgentOnline(AgentOnlineEvent),
    #[serde(rename = "agent.offline")]
    AgentOffline(AgentOfflineEvent),
    #[serde(rename = "agent.spawn_requested")]
    AgentSpawnRequested(AgentSpawnRequestedEvent),
    #[serde(rename = "agent.release_requested")]
    AgentReleaseRequested(AgentReleaseRequestedEvent),
    #[serde(rename = "channel.created")]
    ChannelCreated(ChannelCreatedEvent),
    #[serde(rename = "channel.updated")]
    ChannelUpdated(ChannelUpdatedEvent),
    #[serde(rename = "channel.archived")]
    ChannelArchived(ChannelArchivedEvent),
    #[serde(rename = "member.joined")]
    MemberJoined(MemberJoinedEvent),
    #[serde(rename = "member.left")]
    MemberLeft(MemberLeftEvent),
    #[serde(rename = "message.read")]
    MessageRead(MessageReadEvent),
    #[serde(rename = "file.uploaded")]
    FileUploaded(FileUploadedEvent),
    #[serde(rename = "webhook.received")]
    WebhookReceived(WebhookReceivedEvent),
    #[serde(rename = "command.invoked")]
    CommandInvoked(CommandInvokedEvent),
    #[serde(rename = "pong")]
    Pong,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageCreatedEvent {
    pub channel: String,
    pub message: MessageEventPayload,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageUpdatedEvent {
    pub channel: String,
    pub message: MessageUpdatedPayload,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThreadReplyEvent {
    #[serde(default)]
    pub channel: Option<String>,
    pub parent_id: String,
    pub message: ThreadReplyPayload,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReactionAddedEvent {
    pub message_id: String,
    pub emoji: String,
    pub agent_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReactionRemovedEvent {
    pub message_id: String,
    pub emoji: String,
    pub agent_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DmReceivedEvent {
    pub conversation_id: String,
    pub message: DmEventPayload,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupDmReceivedEvent {
    pub conversation_id: String,
    pub message: DmEventPayload,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentOnlineEvent {
    pub agent: AgentEventPayload,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentOfflineEvent {
    pub agent: AgentEventPayload,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSpawnRequestedEvent {
    pub agent: AgentSpawnRequestedPayload,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSpawnRequestedPayload {
    pub name: String,
    pub cli: String,
    pub task: String,
    pub channel: Option<String>,
    pub already_existed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentReleaseRequestedEvent {
    pub agent: AgentEventPayload,
    pub reason: Option<String>,
    pub deleted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelCreatedEvent {
    pub channel: ChannelEventPayload,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelUpdatedEvent {
    pub channel: ChannelEventPayload,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelArchivedEvent {
    pub channel: ChannelArchivedPayload,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemberJoinedEvent {
    pub channel: String,
    pub agent_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemberLeftEvent {
    pub channel: String,
    pub agent_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageReadEvent {
    pub message_id: String,
    pub agent_name: String,
    pub read_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileUploadedEvent {
    pub file: FileEventPayload,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebhookReceivedEvent {
    pub webhook_id: String,
    pub channel: String,
    pub message: WebhookMessagePayload,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandInvokedEvent {
    pub command: String,
    pub channel: String,
    pub invoked_by: String,
    pub handler_agent_id: String,
    pub args: Option<String>,
    pub parameters: Option<serde_json::Map<String, serde_json::Value>>,
}
