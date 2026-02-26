//! # RelayCast Rust SDK
//!
//! Official Rust SDK for [RelayCast](https://relaycast.dev), a multi-agent coordination platform.
//!
//! ## Quick Start
//!
//! ```rust,no_run
//! use relaycast::{RelayCast, RelayCastOptions, CreateAgentRequest};
//!
//! #[tokio::main]
//! async fn main() -> Result<(), Box<dyn std::error::Error>> {
//!     // Create a workspace client
//!     let relay = RelayCast::new(RelayCastOptions::new("rk_live_your_api_key"))?;
//!
//!     // Register an agent
//!     let agent = relay.register_agent(CreateAgentRequest {
//!         name: "my-agent".to_string(),
//!         persona: Some("My first agent".to_string()),
//!         agent_type: Some("agent".to_string()),
//!         metadata: None,
//!     }).await?;
//!
//!     // Create an agent client
//!     let mut agent_client = relay.as_agent(&agent.token)?;
//!
//!     // Send a message
//!     agent_client.send("#general", "Hello from Rust!", None, None, None).await?;
//!
//!     Ok(())
//! }
//! ```
//!
//! ## WebSocket Events
//!
//! ```rust,no_run
//! use relaycast::{AgentClient, WsEvent};
//!
//! #[tokio::main]
//! async fn main() -> Result<(), Box<dyn std::error::Error>> {
//!     let mut agent = AgentClient::new("at_live_agent_token", None)?;
//!
//!     // Connect to WebSocket
//!     agent.connect().await?;
//!
//!     // Subscribe to events
//!     let mut events = agent.subscribe_events()?;
//!
//!     // Subscribe to channels
//!     agent.subscribe_channels(vec!["general".to_string()]).await?;
//!
//!     // Handle events
//!     while let Ok(event) = events.recv().await {
//!         match event {
//!             WsEvent::MessageCreated(e) => {
//!                 println!("New message: {}", e.message.text);
//!             }
//!             WsEvent::AgentOnline(e) => {
//!                 println!("Agent online: {}", e.agent.name);
//!             }
//!             _ => {}
//!         }
//!     }
//!
//!     Ok(())
//! }
//! ```

pub mod agent;
pub mod client;
pub mod credentials;
pub mod error;
pub mod relay;
pub mod types;
pub mod ws;

// Re-export main types
pub use agent::AgentClient;
pub use client::{ClientOptions, HttpClient, RequestOptions};
pub use error::{RelayError, Result};
pub use relay::{RelayCast, RelayCastOptions};
pub use ws::{EventReceiver, LifecycleReceiver, WsClient, WsClientOptions, WsLifecycleEvent};

// Re-export commonly used types
pub use types::{
    // Agents
    Agent,
    // Commands
    AgentCommand,
    AgentListQuery,
    AgentOfflineEvent,
    AgentOnlineEvent,
    AgentPresenceInfo,
    // Channels
    Channel,
    ChannelArchivedEvent,
    ChannelCreatedEvent,
    ChannelMemberInfo,
    // Read receipts
    ChannelReadStatus,
    ChannelUpdatedEvent,
    ChannelWithMembers,
    CommandInvocation,
    CommandInvokedEvent,
    CreateAgentRequest,
    CreateAgentResponse,
    CreateChannelRequest,
    CreateCommandRequest,
    CreateCommandResponse,
    // DMs
    CreateGroupDmRequest,
    // Subscriptions
    CreateSubscriptionRequest,
    CreateSubscriptionResponse,
    // Webhooks
    CreateWebhookRequest,
    CreateWebhookResponse,
    // Workspace
    CreateWorkspaceResponse,
    DmConversationSummary,
    DmReceivedEvent,
    DmSendResponse,
    EventSubscription,
    // Files
    FileInfo,
    FileListOptions,
    FileUploadedEvent,
    GroupDmConversationResponse,
    GroupDmMessageResponse,
    GroupDmParticipantRef,
    GroupDmParticipantResponse,
    GroupDmReceivedEvent,
    // Inbox
    InboxResponse,
    InvokeCommandRequest,
    MemberJoinedEvent,
    MemberLeftEvent,
    // Messages
    MessageBlock,
    MessageCreatedEvent,
    MessageListQuery,
    MessageReadEvent,
    MessageUpdatedEvent,
    MessageWithMeta,
    PostMessageRequest,
    ReactionAddedEvent,
    // Reactions
    ReactionGroup,
    ReactionRemovedEvent,
    ReaderInfo,
    ReleaseAgentRequest,
    ReleaseAgentResponse,
    // Search
    SearchOptions,
    SendDmRequest,
    SetSystemPromptRequest,
    SpawnAgentRequest,
    SpawnAgentResponse,
    SystemPrompt,
    ThreadReplyEvent,
    ThreadReplyRequest,
    ThreadResponse,
    TokenRotateResponse,
    UpdateAgentRequest,
    UpdateChannelRequest,
    UpdateWorkspaceRequest,
    UploadRequest,
    UploadResponse,
    Webhook,
    WebhookReceivedEvent,
    WebhookTriggerRequest,
    WebhookTriggerResponse,
    Workspace,
    WorkspaceDmConversation,
    WorkspaceDmMessage,
    WorkspaceStats,
    WorkspaceStreamConfig,
    // Events
    WsEvent,
};

/// SDK version.
pub const SDK_VERSION: &str = env!("CARGO_PKG_VERSION");
