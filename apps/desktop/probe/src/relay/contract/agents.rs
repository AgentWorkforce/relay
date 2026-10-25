//! Agents on this computer: its sessions, their registrations, settings and
//! delivery activity.

use crate::relay::delivery::DeliveryActivity;
use crate::relay::push::PushState;
use crate::relay::store::Target;
use schemars::JsonSchema;
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::BTreeMap;

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
    /// For a terminal Claude Code session: relay messages delivered to its
    /// inbox that it has held without progress past the threshold, as when
    /// its turn is stuck. Absent otherwise and in older cores.
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

/// Every setting. Those an extension owns are absent when the core runs
/// without it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SettingsValues {
    /// Sessions may put themselves on the relay.
    pub allow_self_registration: bool,
    /// Newly found live sessions are registered.
    pub auto_activate: bool,
    /// Agent Relay may start agents on this computer, headless
    /// (`relay::spawn`). On unless turned off. Absent in older cores.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accept_spawns: Option<bool>,
    /// Spawned Codex runs without its sandbox; off keeps it to its
    /// workspace. On unless turned off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spawn_full_access_codex: Option<bool>,
    /// Spawned Claude skips permission prompts; off lets it edit files and
    /// sends anything else that would ask to be answered remotely. On unless
    /// turned off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spawn_full_access_claude: Option<bool>,
    /// Workspace owners and admins may spawn here too, not only this
    /// computer's owner; advertised as `teammates` and enforced by Cloud.
    /// Off unless turned on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spawn_allow_teammates: Option<bool>,
    /// The most spawned agents this computer runs at once: 0 to 32, where 0
    /// (or no setting) means no limit. An idle agent keeps its place until
    /// it is released.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spawn_max_agents: Option<u32>,
    /// How spawned Codex is paid for, as advertised to requesters:
    /// `unspecified`, `subscription` or `api`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spawn_billing_codex: Option<String>,
    /// How spawned Claude is paid for, as `spawn_billing_codex`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spawn_billing_claude: Option<String>,
    /// Owner/name keys of the repositories this computer offers spawned
    /// agents for, advertised as the node's `repo_keys`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spawn_repositories: Option<Vec<String>>,
    /// Each known harness's spawn settings, by id: those its descriptor
    /// offers (`SpawnStatus.harness_descriptors`). Codex and Claude have
    /// the flat keys above as well. Absent in older cores.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spawn_harnesses: Option<BTreeMap<String, SpawnHarnessSettings>>,
    /// Whether Agent Relay's Claude Code SessionStart hook is installed in
    /// each known Claude login's `settings.json`. Off unless turned on.
    /// Absent when no Claude login directory exists. The hook never
    /// registers a session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude_session_hook: Option<bool>,
    /// Claude Code's `crossSessionInbound`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub direct_delivery: Option<bool>,
    /// The organization's `crossSessionInbound`, which a user setting cannot
    /// override; read-only, and absent when the organization sets none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub direct_delivery_managed: Option<String>,
    /// Every Claude Code config folder whose sessions this computer finds
    /// and uploads, the desktop's own first; read-only here, and
    /// `claude_config_dirs` in a change sets the folders added in Settings.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude_config_dirs: Option<Vec<ClaudeConfigDir>>,
    /// Whether Claude Code cloud sessions on claude.ai are listed and
    /// uploaded, read with Claude Code's own login in `~/.claude` (on macOS,
    /// its Keychain item). Off unless turned on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude_cloud_sessions: Option<bool>,
    /// Whether Agent Relay sends usage analytics (`telemetry`). On unless
    /// turned off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub analytics_enabled: Option<bool>,
    /// Contractor access: a workspace owner grants a contractor's seat
    /// scoped access to the workspace's services. Off unless turned on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contractor_access: Option<bool>,
    /// Grok's `[cli] use_leader`: whether the sessions Grok opens run on its
    /// shared leader, the only route into a running Grok session. Absent
    /// where Grok has never run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grok_leader: Option<bool>,
    /// Whether Agent Relay's OpenCode plugin is installed in OpenCode's
    /// global `plugins/`, the route into a plain OpenCode session. Absent
    /// where OpenCode has never run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opencode_plugin: Option<bool>,
    /// Whether Agent Relay lists the agents of the local OpenClaw Gateway
    /// and delivers to them, each relay sender in a session of its own.
    /// Absent where OpenClaw is not set up.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub openclaw_gateway: Option<bool>,
    /// The version of the local OpenClaw Gateway while it is on and cannot
    /// limit relay sessions (older than 2026.8.1): its relay senders then
    /// get the agent's usual tools. Read-only; absent otherwise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub openclaw_unlimited_version: Option<String>,
    /// Relay senders (names or exact addresses) trusted like the person:
    /// their messages reach the person's own OpenClaw and Hermes instead of
    /// an answer-only session. Absent where neither is set up.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trusted_relay_senders: Option<Vec<String>>,
    /// Whether Agent Relay lists the local Hermes home and delivers to it
    /// through its loopback API, each relay sender in a session of its own.
    /// Absent where Hermes has never run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hermes_agent: Option<bool>,
    /// Whether Agent Relay's Codex Stop hook is in `~/.codex/hooks.json`, so
    /// relayed messages show in Conductor's Codex chats. Absent where
    /// Conductor has never run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex_stop_hook: Option<bool>,
    /// Whether relay messages show in agent chats. Off unless turned on: the
    /// agent reads each message from hidden history and the chat shows none
    /// of it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub show_relay_messages: Option<bool>,
    /// Whether Agent Relay's lifecycle hooks are in Devin's `config.json`,
    /// so staged inbox messages reach the conversation. Absent where Devin
    /// has never run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub devin_direct_delivery: Option<bool>,
    /// Whether agents registered from now on join #general, so its posts
    /// reach them as turns. Off unless turned on; agents already registered
    /// keep the channels they are in. Absent in older cores.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_join_general: Option<bool>,
    /// The latest settings changes agents made on the session socket
    /// (`PATCH /settings`), newest first. Read-only: a record, not a
    /// setting. Absent in older cores.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_changes: Option<Vec<AgentSettingsChange>>,
}

/// One setting an agent changed on the session socket, as Settings shows it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct AgentSettingsChange {
    /// When, as RFC 3339.
    pub at: String,
    /// The agent's name on the relay, or its session when it is not on it.
    pub by: String,
    /// The setting, as `settings.get` names it.
    pub key: String,
    /// The value before, as JSON text; absent when it had none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    /// The value set, as JSON text.
    pub to: String,
}

/// One harness's spawn settings. In `settings.get`, each one the harness
/// offers; in a change, each one to change.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SpawnHarnessSettings {
    /// Runs without the harness's own confinement (its sandbox or
    /// permission prompts).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub full_access: Option<bool>,
    /// How it is paid for, as advertised to requesters: `unspecified`,
    /// `subscription` or `api`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub billing: Option<String>,
}

/// One watched Claude Code config folder.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ClaudeConfigDir {
    pub path: String,
    /// Why it is watched: `default` (the desktop's own), `sibling` (a
    /// `.claude-<name>` folder beside it), `environment`
    /// (`AGENT_RELAY_CLAUDE_CONFIG_DIRS`), `added` (in Settings) or
    /// `running` (a running Claude Code session's `CLAUDE_CONFIG_DIR`).
    pub origin: String,
    /// Its sessions may be put on the relay and uploaded. An unshared
    /// folder's sessions are not listed and never uploaded.
    pub shared: bool,
}

/// A change to one watched Claude Code config folder. Each choice is
/// optional; one left out is unchanged.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ClaudeConfigDirChange {
    /// The folder, as `claude_config_dirs` lists it.
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shared: Option<bool>,
}

/// The settings to change; each is optional and never `null`.
#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SettingsChange {
    #[serde(
        default,
        deserialize_with = "given",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "bool")]
    pub allow_self_registration: Option<bool>,
    #[serde(
        default,
        deserialize_with = "given",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "bool")]
    pub auto_activate: Option<bool>,
    #[serde(
        default,
        deserialize_with = "given",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "bool")]
    pub accept_spawns: Option<bool>,
    #[serde(
        default,
        deserialize_with = "given",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "bool")]
    pub spawn_full_access_codex: Option<bool>,
    #[serde(
        default,
        deserialize_with = "given",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "bool")]
    pub spawn_full_access_claude: Option<bool>,
    #[serde(
        default,
        deserialize_with = "given",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "bool")]
    pub spawn_allow_teammates: Option<bool>,
    #[serde(
        default,
        deserialize_with = "given",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "u32")]
    pub spawn_max_agents: Option<u32>,
    #[serde(
        default,
        deserialize_with = "given",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "String")]
    pub spawn_billing_codex: Option<String>,
    #[serde(
        default,
        deserialize_with = "given",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "String")]
    pub spawn_billing_claude: Option<String>,
    #[serde(
        default,
        deserialize_with = "given",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "Vec<String>")]
    pub spawn_repositories: Option<Vec<String>>,
    /// Changes the spawn settings of the harnesses named, each by id; a
    /// value left out is unchanged.
    #[serde(
        default,
        deserialize_with = "given",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "BTreeMap<String, SpawnHarnessSettings>")]
    pub spawn_harnesses: Option<BTreeMap<String, SpawnHarnessSettings>>,
    #[serde(
        default,
        deserialize_with = "given",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "bool")]
    pub direct_delivery: Option<bool>,
    /// First-run default: `true` turns direct delivery on unless the user's
    /// own Claude settings already name `crossSessionInbound` (`hold`
    /// included); `false` changes nothing. Write-only.
    #[serde(
        default,
        deserialize_with = "given",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "bool")]
    pub direct_delivery_default: Option<bool>,
    /// The Claude Code config folders added in Settings, replacing the
    /// last list. Each must be an existing folder.
    #[serde(
        default,
        deserialize_with = "given",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "Vec<String>")]
    pub claude_config_dirs: Option<Vec<String>>,
    /// Changes one watched folder, such as whether it is shared.
    #[serde(
        default,
        deserialize_with = "given",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "ClaudeConfigDirChange")]
    pub claude_config_dir: Option<ClaudeConfigDirChange>,
    #[serde(
        default,
        deserialize_with = "given",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "bool")]
    pub claude_cloud_sessions: Option<bool>,
    #[serde(
        default,
        deserialize_with = "given",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "bool")]
    pub analytics_enabled: Option<bool>,
    #[serde(
        default,
        deserialize_with = "given",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "bool")]
    pub contractor_access: Option<bool>,
    #[serde(
        default,
        deserialize_with = "given",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "bool")]
    pub grok_leader: Option<bool>,
    #[serde(
        default,
        deserialize_with = "given",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "bool")]
    pub opencode_plugin: Option<bool>,
    /// Turns the OpenClaw Gateway route on or off.
    #[serde(
        default,
        deserialize_with = "given",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "bool")]
    pub openclaw_gateway: Option<bool>,
    /// Replaces the relay senders trusted like the person.
    #[serde(
        default,
        deserialize_with = "given",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "Vec<String>")]
    pub trusted_relay_senders: Option<Vec<String>>,
    /// Turns the Hermes route on or off.
    #[serde(
        default,
        deserialize_with = "given",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "bool")]
    pub hermes_agent: Option<bool>,
    /// Adds or removes Agent Relay's Claude Code SessionStart hook. The hook
    /// never registers a session.
    #[serde(
        default,
        deserialize_with = "given",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "bool")]
    pub claude_session_hook: Option<bool>,
    /// Adds or removes Agent Relay's Codex Stop hook.
    #[serde(
        default,
        deserialize_with = "given",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "bool")]
    pub codex_stop_hook: Option<bool>,
    /// Shows each relay message whole in agent chats (`true`), or hides it
    /// (`false`, the default): the agent still reads it from hidden history.
    #[serde(
        default,
        deserialize_with = "given",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "bool")]
    pub show_relay_messages: Option<bool>,
    /// Adds or removes Agent Relay's lifecycle hooks in Devin's
    /// `config.json`.
    #[serde(
        default,
        deserialize_with = "given",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "bool")]
    pub devin_direct_delivery: Option<bool>,
    /// Whether agents registered from now on join #general.
    #[serde(
        default,
        deserialize_with = "given",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "bool")]
    pub auto_join_general: Option<bool>,
}

/// A value that may be absent but is never `null`.
fn given<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(deserializer).map(Some)
}

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
