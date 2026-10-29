//! Agents on this computer: its sessions, their registrations, settings and
//! delivery activity.

use crate::relay::delivery::DeliveryActivity;
use crate::relay::push::PushState;
use crate::relay::store::Target;
use schemars::JsonSchema;
use serde::{Deserialize, Deserializer, Serialize};

/// The schema of a value that must be present but may be `null`.
fn nullable<T: JsonSchema>(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
    generator.subschema_for::<Option<T>>()
}

/// An `Option` that must be present, `null` meaning `None`.
fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    Option::<T>::deserialize(deserializer)
}

/// `sessions.list`'s result.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct LocalSessions {
    pub sessions: Vec<LocalSession>,
}

/// What holds a Claude Code session's transcript now. Claude Desktop
/// resumes a session in a process of its own, so Claude Code refuses
/// `claude --desktop --resume` while anything holds it; only the holder
/// hands the session over itself. Absent for a session nothing holds, for
/// every other provider, and in older cores.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, JsonSchema, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionHolder {
    /// A session a person types in. It hands over with `/desktop`.
    Interactive,
    /// A headless process: `-p`/`--print`, a structured JSON pipe, or an
    /// SDK session. Claude Code's own advice for one is `claude agents`.
    Background,
}

/// A session on this computer, with its registration when it has one.
#[derive(Clone, Debug, PartialEq, Serialize, JsonSchema, Deserialize)]
pub struct LocalSession {
    pub target: Target,
    pub title: String,
    /// Git repository name when local metadata is available, otherwise a
    /// safe working-directory hint. Relay controller roots have no project.
    pub project: Option<String>,
    pub directory: Option<String>,
    /// Whether the session can take a message now; a registered session
    /// discovery no longer finds is listed with `false`.
    pub live: bool,
    /// Whether discovery found the session's process on this computer:
    /// `false` for a registered session that has ended. A session that runs
    /// but is not `live` cannot take a message yet (a Grok TUI without its
    /// leader, an OpenCode window opened before the plugin). Clients treat a
    /// missing value (an older core) as running.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub running: Option<bool>,
    /// What holds this session's transcript, for a session that can be
    /// held at all (see [`SessionHolder`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub holder: Option<SessionHolder>,
    pub updated_at_ms: Option<i64>,
    /// The app a person chats with the session in, when it is not the
    /// provider's own: `conductor` or `paseo`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    pub registration: Option<SessionRegistration>,
    /// The name `agents.register` uses without one.
    pub suggested_name: String,
}

/// Launches a provider endpoint owned by the probe. Endpoint, process,
/// socket and credentials are intentionally not accepted from the caller.
#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ManagedLaunchParams {
    pub kind: crate::relay::store::SessionKind,
    pub executable: String,
    pub directory: String,
    pub session_id: String,
}

/// Registers an already-open Grok session. The probe finds the leader
/// itself; a process, socket, endpoint or credential is never accepted.
#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ExistingRegisterParams {
    pub kind: crate::relay::store::SessionKind,
    pub session_id: String,
    /// The session's working directory, which `session/load` must accept.
    pub directory: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, JsonSchema, Deserialize)]
pub struct ManagedSessionStarted {
    pub target: Target,
    pub title: String,
    pub directory: Option<String>,
}

/// A session's registration, as `sessions.list` reports it.
#[derive(Clone, Debug, Default, PartialEq, Serialize, JsonSchema, Deserialize)]
pub struct SessionRegistration {
    /// The name the agent was registered with, which it keeps while on the
    /// relay.
    pub name: String,
    /// The name it was renamed to, if any: another name that reaches it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alias: Option<String>,
    pub address: String,
    pub added_by_session: bool,
    pub push: Option<PushState>,
    /// For an agent Agent Relay spawned here: what may be done with it.
    /// Absent for every other session and in older cores.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spawn: Option<super::spawned::SessionSpawn>,
    /// Relay messages waiting without session progress past the threshold.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inbox_stall: Option<crate::relay::claude::inbox::InboxStall>,
}

/// `agents.list`'s result.
#[derive(Clone, Debug, PartialEq, Serialize, JsonSchema, Deserialize)]
pub struct Agents {
    pub agents: Vec<LocalAgent>,
    /// Agents that left the relay because their session was archived,
    /// newest first.
    #[serde(default)]
    pub archived: Vec<ArchivedAgent>,
}

/// An agent that left the relay because its session was archived; its
/// name was released.
#[derive(Clone, Debug, PartialEq, Serialize, JsonSchema, Deserialize)]
pub struct ArchivedAgent {
    pub name: String,
    pub address: String,
    pub target: Target,
    pub title: String,
    /// ISO-8601, seconds precision.
    pub archived_at: String,
}

/// An agent on the relay from this computer.
#[derive(Clone, Debug, PartialEq, Serialize, JsonSchema, Deserialize)]
pub struct LocalAgent {
    /// The name the agent was registered with, which it keeps while on the
    /// relay. Agent methods take this name.
    pub name: String,
    /// The name it was renamed to, if any: another name that reaches it,
    /// shown in its place.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alias: Option<String>,
    pub address: String,
    pub target: Target,
    pub title: String,
    /// ISO-8601, seconds precision.
    pub registered_at: String,
    pub added_by_session: bool,
    /// `true` always answers, `false` never, `null` only when the session
    /// cannot answer itself.
    pub reply_with_final_answer: Option<bool>,
    pub webhook: Option<AgentWebhook>,
    pub integrations: Vec<AgentIntegration>,
    pub push: Option<PushState>,
    /// Why this agent's delivery queue could not be read.
    pub delivery_error: Option<String>,
    /// For an agent Agent Relay spawned here: its place and lifecycle.
    /// Absent for every other agent and in older cores.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spawn: Option<crate::relay::state::SpawnedAgentState>,
    /// Relay messages waiting behind a silent Codex turn or unread in a
    /// terminal Claude Code inbox past the threshold. Absent otherwise and
    /// in older cores.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inbox_stall: Option<crate::relay::claude::inbox::InboxStall>,
}

#[derive(Clone, Debug, PartialEq, Serialize, JsonSchema, Deserialize)]
pub struct AgentWebhook {
    pub id: String,
    pub url: String,
}

/// The webhook as listed: never its bearer token.
impl From<&crate::relay::store::Webhook> for AgentWebhook {
    fn from(webhook: &crate::relay::store::Webhook) -> AgentWebhook {
        AgentWebhook {
            id: webhook.id.clone(),
            url: webhook.url.clone(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, JsonSchema, Deserialize)]
pub struct AgentIntegration {
    pub provider: String,
    pub resource: String,
    pub ready: bool,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize)]
pub struct RegisterParams {
    pub target: Target,
    /// Without one, the session's suggested name.
    pub name: Option<String>,
    pub description: Option<String>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize)]
pub struct NameParams {
    pub name: String,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize)]
pub struct RenameParams {
    pub name: String,
    pub new_name: String,
}

#[derive(Clone, Debug, Serialize, JsonSchema, Deserialize)]
pub struct Renamed {
    /// The name asked for: the alias, or the agent's own name when the
    /// alias was removed.
    pub name: String,
    pub address: String,
    /// The alias this rename replaced, if it had one. It keeps forwarding
    /// what is sent to it for 24 hours, then is released.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub released: Option<String>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize)]
pub struct TestMessageParams {
    pub name: String,
    pub text: Option<String>,
}

#[derive(Clone, Debug, Serialize, JsonSchema, Deserialize)]
pub struct TestMessageSent {
    pub message_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize)]
pub struct ReplySettingParams {
    pub name: String,
    /// `true` always answers, `false` never, `null` only when the session
    /// cannot answer itself. Required.
    #[serde(deserialize_with = "present")]
    #[schemars(schema_with = "nullable::<bool>", required)]
    pub enabled: Option<bool>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct CreatedWebhook {
    pub id: String,
    pub url: String,
    /// Only to the call that created the webhook.
    pub secret: Option<String>,
    /// Whether this call created it.
    pub created: bool,
}

#[derive(Clone, Debug, Serialize, JsonSchema, Deserialize)]
pub struct RevokedWebhook {
    pub already_deleted: bool,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize)]
pub struct IntegrationParams {
    pub name: String,
    pub provider: String,
    pub resource: String,
}

/// A subscription made or undone.
#[derive(Clone, Debug, PartialEq, Serialize, JsonSchema, Deserialize)]
pub struct IntegrationChange {
    pub subscribed: bool,
    pub provider: String,
    pub resource: String,
    /// The relayfile paths a subscription delivers.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path_glob: Option<String>,
    /// Nothing was left to undo.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub already_unsubscribed: bool,
}

mod settings;
pub use settings::{
    AgentSettingsChange, ClaudeConfigDir, ClaudeConfigDirChange, SettingsChange, SettingsValues,
    SpawnHarnessSettings, TrustedWorkspaceMember,
};

#[derive(Clone, Debug, Default, Deserialize, JsonSchema, Serialize)]
pub struct LimitParams {
    pub limit: Option<usize>,
}

/// `activity.list`'s result, newest first.
#[derive(Clone, Debug, Serialize, JsonSchema, Deserialize)]
pub struct ActivityLog {
    pub activity: Vec<DeliveryActivity>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn existing_registration_accepts_no_process_socket_or_binding() {
        let base = serde_json::json!({
            "kind": "grok-open",
            "session_id": "01a0fe0c-8b26-7ec2-ad2f-bab882c091f4",
            "directory": "/workspace"
        });
        assert!(serde_json::from_value::<ExistingRegisterParams>(base.clone()).is_ok());
        for forbidden in [
            "pid",
            "leader_pid",
            "socket",
            "socket_path",
            "executable",
            "credential_reference",
            "binding",
            "workspace_id",
            "owner_id",
        ] {
            let mut value = base.clone();
            value[forbidden] = serde_json::json!("attacker-controlled");
            assert!(
                serde_json::from_value::<ExistingRegisterParams>(value).is_err(),
                "{forbidden}"
            );
        }
    }

    #[test]
    fn managed_launch_accepts_no_endpoint_process_or_credentials() {
        let base = serde_json::json!({
            "kind": "opencode",
            "executable": "/usr/local/bin/opencode",
            "directory": "/workspace",
            "session_id": "ses_exact"
        });
        assert!(serde_json::from_value::<ManagedLaunchParams>(base.clone()).is_ok());
        for forbidden in [
            "endpoint",
            "pid",
            "socket",
            "password",
            "credential_reference",
        ] {
            let mut value = base.clone();
            value[forbidden] = serde_json::json!("attacker-controlled");
            assert!(
                serde_json::from_value::<ManagedLaunchParams>(value).is_err(),
                "{forbidden}"
            );
        }
    }
}

mod session_titles;
pub use session_titles::{
    SessionTitleCapability, SessionTitleIdentity, SessionTitleSetParams, SessionTitleUpdated,
};
