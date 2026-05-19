pub(crate) mod auth;
pub(crate) mod bridge;
pub(crate) mod dm_participants;
pub(crate) mod workspace;
pub(crate) mod ws;

pub(crate) use crate::snippets::{configure_relaycast_mcp_with_token, ensure_relaycast_mcp_config};
pub(crate) use auth::AuthClient;
pub(crate) use bridge::{map_ws_broker_command, map_ws_event};
pub(crate) use dm_participants::{resolve_dm_participants_cached, DmParticipantsCache};
pub(crate) use relaycast::{agent_name_eq, is_self_name};
pub(crate) use workspace::{
    MultiWorkspaceSession, WorkspaceInboundMessage, WorkspaceMembershipSummary,
};
pub(crate) use ws::{
    format_worker_preregistration_error, registration_retry_after_secs, retry_agent_registration,
    RegRetryOutcome, RelaycastHttpClient, RelaycastRegistrationError, WsControl,
};
