pub mod auth;
pub mod bridge;
pub mod dm_participants;
pub mod identity;
pub mod workspace;
pub mod ws;

pub use crate::snippets::{
    configure_relaycast_mcp, configure_relaycast_mcp_with_token, ensure_relaycast_mcp_config,
    relaycast_mcp_config_json, relaycast_mcp_config_json_with_token,
};
pub use auth::{AuthClient, AuthSession, AuthSessionSet, CredentialCache, CredentialSet};
pub use bridge::{map_ws_broker_command, map_ws_event, to_inject_request};
pub use dm_participants::{resolve_dm_participants_cached, DmParticipantsCache};
pub use identity::{agent_name_eq, is_self_name};
pub use workspace::{
    MultiWorkspaceSession, WorkspaceInboundMessage, WorkspaceMembershipSummary,
    WorkspaceSessionHandle,
};
pub use ws::{
    format_worker_preregistration_error, registration_is_retryable, registration_retry_after_secs,
    retry_agent_registration, RegRetryOutcome, RelaycastHttpClient, RelaycastRegistrationError,
    RelaycastWsClient, WsControl,
};
