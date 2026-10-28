//! Settings shared by every native client.

use schemars::JsonSchema;
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::BTreeMap;

/// Every setting. Those an extension owns are absent when the core runs
/// without it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SettingsValues {
    /// Sessions may put themselves on the relay.
    pub allow_self_registration: bool,
    /// Newly found live sessions are registered.
    pub auto_activate: bool,
    /// Your messages from the phone continue a Claude Code session as your
    /// own turns. On unless turned off, once this computer's ownership is
    /// verified; absent on cores without the native bridge.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mobile_claude_handoff: Option<bool>,
    /// Whether the native Claude bridge is verified on this platform. Read only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mobile_claude_handoff_supported: Option<bool>,
    /// Your messages from the phone continue other supported sessions as
    /// your own turns. On unless turned off, once ownership is verified.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mobile_native_continuation: Option<bool>,
    /// Whether this platform has verified native continuation adapters. Read only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mobile_native_continuation_supported: Option<bool>,
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
    /// Allow verified spawning agents to send native input; on by default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spawn_native_input: Option<bool>,
    /// A teammate's direct message to a Claude Code session with Agent
    /// Relay's plugin starts a user turn, labelled with the sender; on by
    /// default. Absent in older cores.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub teammate_native_input: Option<bool>,
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
    /// Whether the people in the workspace are trusted like the person too,
    /// by their person identity's Relaycast agent id (never their agents).
    /// On unless turned off. Absent where neither OpenClaw nor Hermes is set
    /// up.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trust_workspace_members: Option<bool>,
    /// The people in the workspace trusted while `trust_workspace_members`
    /// is on, as Agent Relay Cloud lists them; read-only. Empty while it is
    /// off, signed out, or Cloud's list has not been read lately.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_members: Option<Vec<TrustedWorkspaceMember>>,
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
    /// Whether Agent Relay's hooks are in Cursor CLI's `~/.cursor/hooks.json`,
    /// so a Cursor CLI session gets its messages at its next tool call or
    /// when its turn ends. Off unless turned on. Absent where Cursor CLI has
    /// never run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor_direct_delivery: Option<bool>,
    /// Whether agents registered from now on join #general, so its posts
    /// reach them as turns. Off unless turned on; agents already registered
    /// keep the channels they are in. Absent in older cores.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_join_general: Option<bool>,
    /// Days this computer keeps local session history: 7, 30 or 90, or 0
    /// to keep it forever. 30 unless changed. relayhistory removes older
    /// sessions from this computer; uploaded copies are not affected.
    /// Absent in older cores.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history_retention_days: Option<u32>,
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
    #[serde(default, deserialize_with = "given", skip_serializing_if = "Option::is_none")]
    #[schemars(with = "bool")]
    pub mobile_native_continuation: Option<bool>,
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
    pub mobile_claude_handoff: Option<bool>,
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
    #[schemars(with = "bool")]
    pub spawn_native_input: Option<bool>,
    #[serde(
        default,
        deserialize_with = "given",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "bool")]
    pub teammate_native_input: Option<bool>,
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
    /// Turns trusting the people in the workspace on or off.
    #[serde(
        default,
        deserialize_with = "given",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "bool")]
    pub trust_workspace_members: Option<bool>,
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
    /// Adds or removes Agent Relay's hooks in Cursor CLI's
    /// `~/.cursor/hooks.json`.
    #[serde(
        default,
        deserialize_with = "given",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "bool")]
    pub cursor_direct_delivery: Option<bool>,
    /// Whether agents registered from now on join #general.
    #[serde(
        default,
        deserialize_with = "given",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "bool")]
    pub auto_join_general: Option<bool>,
    /// How long this computer keeps local session history: 7, 30 or 90
    /// days, or 0 to keep it forever.
    #[serde(
        default,
        deserialize_with = "given",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "u32")]
    pub history_retention_days: Option<u32>,
}

/// A value that may be absent but is never `null`.
fn given<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(deserializer).map(Some)
}

/// A person in the workspace trusted like the person (`workspace_members`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct TrustedWorkspaceMember {
    /// Their person identity's relay name.
    pub name: String,
    /// Their name in Agent Relay, when it differs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
}
