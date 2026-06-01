pub(crate) mod auth;
pub(crate) mod bridge;
pub(crate) mod dm_participants;
pub(crate) mod workspace;
pub(crate) mod ws;

pub(crate) use crate::snippets::{
    configure_relaycast_mcp_with_result, configure_relaycast_mcp_with_token,
};
pub(crate) use auth::AuthClient;
// `is_agent_token_invalid`, `is_agent_token_invalid_anyhow`,
// `is_agent_token_invalid_code`, and `AGENT_TOKEN_INVALID_CODE` are declared
// `pub` on `auth` so future callers (bridge, ws, listen_api) can reach them
// via `crate::relaycast::auth::*` without an unused re-export here.
pub(crate) use bridge::{broker_payload_from_action, map_ws_event, parse_ws_action_invoked};
pub(crate) use dm_participants::{resolve_dm_participants_cached, DmParticipantsCache};
pub(crate) use relaycast::{
    agent_name_eq, is_self_name, CompleteInvocationRequest, RegisterActionRequest,
};
pub(crate) use workspace::{
    MultiWorkspaceSession, WorkspaceInboundMessage, WorkspaceMembershipSummary,
};
pub(crate) use ws::{
    format_worker_preregistration_error, registration_retry_after_secs, retry_agent_registration,
    RegRetryOutcome, RelaycastHttpClient, RelaycastRegistrationError, WsControl,
};
