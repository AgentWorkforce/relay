//! Sign-in, Settings and About in words: the sign-in screen's progress,
//! Claude Code direct delivery, where the workspace key came from, incoming
//! messages, and the allowlisted diagnostics report.

use super::time::dated_clock;
use crate::relay::contract::account::SignInLink;
use crate::relay::contract::agents::{ClaudeConfigDir, SettingsChange, SettingsValues};
use crate::relay::incoming::IncomingState;
use crate::relay::push::PushState;
use crate::relay::state::{AccountStatus, Status, Verification, WorkspaceState};
use chrono::TimeZone;
use std::fmt::Display;

// Claude Code direct delivery (`crossSessionInbound: "accept"`) is on by
// default; first-run setup explains it with a pre-checked box on the
// sign-in screen, offered once, and unticking it turns it off (`hold`). The
// core keeps a value the user already chose, `hold` included, and never
// edits an organization's managed settings.

pub const INBOUND_DEFAULT_LABEL: &str = "Deliver relayed messages to Claude Code directly";
pub const INBOUND_DEFAULT_DETAIL: &str = "Sets \"crossSessionInbound\": \"accept\" in ~/.claude/settings.json unless you already chose a value.";

/// Claude Code's SessionStart hook. Off unless turned on. The Mac's
/// `ClaudeSessionHookCopy` matches these word for word.
pub const CLAUDE_SESSION_HOOK_TITLE: &str = "Claude Code activation";
pub const CLAUDE_SESSION_HOOK_ON: &str = "Agent Relay's SessionStart hook is in each Claude login's settings.json. When a session is not on the relay, the hook has Claude ask you whether to put it on the relay and under what name. Nothing is registered unless you say yes.";
pub const CLAUDE_SESSION_HOOK_OFF: &str = "A Claude Code session stays off the relay until you put it on. Turn this on to add a SessionStart hook to each Claude login's settings.json. When a session is not on the relay, the hook has Claude ask you whether to put it on the relay and under what name. Nothing is registered unless you say yes.";
pub const CLAUDE_SESSION_HOOK_TURN_ON_HELP: &str =
    "Add Agent Relay's SessionStart hook to each Claude login";
pub const CLAUDE_SESSION_HOOK_TURN_OFF_HELP: &str =
    "Remove Agent Relay's SessionStart hook from each Claude login";
/// The OpenClaw Gateway route, on wherever OpenClaw is set up. The Mac's
/// `OpenClawCopy` matches these word for word.
pub const OPENCLAW_TITLE: &str = "OpenClaw agents";
pub const OPENCLAW_ON: &str = "Agent Relay reaches OpenClaw's Gateway on this computer, so its agents appear here and can be messaged. Each sender gets a chat of its own, apart from your main chat, and the agent's answer goes back to that sender only, never to your other channels.";
pub const OPENCLAW_OFF: &str = "Turn this on so the agents of the OpenClaw Gateway on this computer appear here and can be messaged. Each sender gets a chat of its own, apart from your main chat, and the agent's answer goes back to that sender only.";
pub const OPENCLAW_TURN_ON_HELP: &str = "List and message the agents of OpenClaw's Gateway";
pub const OPENCLAW_TURN_OFF_HELP: &str = "Stop listing and messaging OpenClaw's agents";
/// The notice while the connected Gateway cannot limit relay sessions
/// (`openclaw_unlimited_version`); `OpenClawCopy.unlimitedNotice` on the Mac.
pub fn openclaw_unlimited_notice(version: &str) -> String {
    format!("OpenClaw {version} can't limit relay sessions, so anyone on the relay who messages your agents gets a session with your agent's usual tools. Updating OpenClaw to 2026.8.1 or later makes them answer-only.")
}
/// The Hermes route, on wherever Hermes has run. The Mac's `HermesCopy`
/// matches these word for word.
pub const HERMES_TITLE: &str = "Hermes";
pub const HERMES_ON: &str = "Agent Relay reaches Hermes's relay profile on this computer, so it appears here and can be messaged. The relay profile has its own memory and no channels, apart from your main Hermes. Each sender gets a session of its own, and Hermes's final answer goes back to that sender only.";
pub const HERMES_OFF: &str = "Turn this on so Hermes's relay profile on this computer appears here and can be messaged. The relay profile has its own memory and no channels, apart from your main Hermes. Each sender gets a session of its own, and Hermes's final answer goes back to that sender only.";
pub const HERMES_TURN_ON_HELP: &str = "List and message Hermes on this computer";
pub const HERMES_TURN_OFF_HELP: &str = "Stop listing and messaging Hermes";
/// Trusted senders (`trusted_relay_senders`), shown while OpenClaw or Hermes
/// is on. The Mac's `TrustedSendersCopy` matches these word for word.
pub const TRUSTED_SENDERS_TITLE: &str = "Trusted senders";
pub const TRUSTED_SENDERS_DETAIL: &str = "Relay names or addresses trusted like you: their messages reach your own OpenClaw and Hermes, with their memory and tools. Everyone else gets an answer-only chat of their own. Separate them with commas.";
pub const TRUSTED_SENDERS_PLACEHOLDER: &str = "teammate, name@machine";

/// The comma-separated field as the list `trusted_relay_senders` takes:
/// trimmed, empty entries dropped.
pub fn trusted_senders(text: &str) -> Vec<String> {
    text.split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(str::to_string)
        .collect()
}
/// The preference set once the sign-in screen has offered the default.
pub const INBOUND_DEFAULT_PREF: &str = "claude_inbound_default_offered";

/// `show_relay_messages`: off unless turned on, so relay messages are hidden
/// from the person (the agent still gets them in full). The Mac's `ShowRelayMessages` matches these word for
/// word.
pub const SHOW_RELAY_MESSAGES_TITLE: &str = "Show me relay messages in full";
pub const SHOW_RELAY_MESSAGES_DETAIL: &str = "Relay messages are hidden from you, or shown as a short pointer in a terminal. The agent still gets each one in full and can reply.";
pub const SHOW_RELAY_MESSAGES_SHOWN_DETAIL: &str =
    "You see each relay message in full in the agent's chat. The agent gets them either way.";
pub const SHOW_RELAY_MESSAGES_TURN_OFF_HELP: &str =
    "Hide relay messages from you; the agent still gets them in full";
pub const SHOW_RELAY_MESSAGES_TURN_ON_HELP: &str =
    "Show me each relay message in full in agent chats";

/// What the sign-in screen shows for Claude Code direct delivery.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum InboundOffer {
    /// The pre-checked box.
    Offer,
    /// The organization's managed value, which wins.
    Managed(String),
}

/// The box while direct delivery is on (usually by the core's own default)
/// or the settings are not read yet (`None`), so a sign-in clicked early
/// still applies the choice; the managed value when the organization pins
/// one; nothing once offered, when the core has no Claude settings, or when
/// it is off, which is the user's own `hold` or `refuse` (kept) or a
/// computer where Claude Code has not run.
pub fn inbound_default_offer(
    settings: Option<&SettingsValues>,
    already_offered: bool,
) -> Option<InboundOffer> {
    if already_offered {
        return None;
    }
    let Some(settings) = settings else {
        return Some(InboundOffer::Offer);
    };
    let direct = settings.direct_delivery?;
    if let Some(managed) = settings
        .direct_delivery_managed
        .as_deref()
        .filter(|managed| *managed != "accept")
    {
        return Some(InboundOffer::Managed(managed.to_string()));
    }
    direct.then_some(InboundOffer::Offer)
}

/// Why direct delivery is the organization's choice.
pub fn managed_inbound_detail(managed: &str) -> String {
    if managed == "refuse" {
        return "Your organization's managed settings set crossSessionInbound to refuse, so Claude Code drops relayed messages. Ask your admin to change it.".to_string();
    }
    format!("Your organization's managed settings set crossSessionInbound to {managed}, so Claude Code asks before showing each message. Ask your admin to change it.")
}

/// The sign-in screen's heading for the attempt's phase.
pub fn sign_in_heading(account: &AccountStatus) -> &'static str {
    match account.phase.as_deref() {
        Some("checking_existing_login") => "Checking for an existing sign-in…",
        Some("reusing_existing_login") => "Using your existing sign-in…",
        Some("waiting_for_browser" | "waiting_for_device_approval") => {
            "Finish signing in in your browser"
        }
        Some("connecting_workspace") => "Connecting your workspace…",
        Some("preparing_local_sessions") => "Preparing your sessions…",
        _ => "Starting secure sign-in…",
    }
}

/// The sign-in screen's line beneath the heading.
pub fn sign_in_detail(account: &AccountStatus, link: &SignInLink) -> String {
    if let Some(progress) = &account.progress {
        let source = if progress.source.is_empty() {
            "sessions"
        } else {
            &progress.source
        };
        return format!(
            "Scanning {source}: {} sessions found",
            progress.sessions_captured
        );
    }
    if link.verification_url.is_some() {
        return "Approve this computer on Agent Relay, then return here.".to_string();
    }
    if account.phase.as_deref() == Some("preparing_local_sessions") {
        return "Connected. Agent Relay is setting up local history.".to_string();
    }
    "Your browser will open to Agent Relay.".to_string()
}

/// The relay workspace row's detail, found or not.
pub const WORKSPACE_FOUND_DETAIL: &str =
    "Uploads and messages use this workspace. Switch workspaces from the account menu.";
pub const WORKSPACE_MISSING_DETAIL: &str = "Connect uses your Agent Relay sign-in.";

/// Incoming messages' state, as Settings says it.
pub fn incoming_state_label(state: IncomingState) -> &'static str {
    match state {
        IncomingState::Connected => "Receiving messages.",
        IncomingState::Connecting => "Connecting…",
        IncomingState::Polling => "Checking for messages.",
        IncomingState::Paused => "Paused with uploads.",
        IncomingState::NeedsSignIn => "Sign in again to receive messages.",
        IncomingState::Unavailable => "Incoming messages are not available for this account.",
        IncomingState::Stopped => "Not receiving messages.",
    }
}

/// `scheme://host[:port]` of an http(s) URL, and its path; never its
/// credentials, query or fragment.
fn parts(value: &str) -> Option<(String, String)> {
    let url = url::Url::parse(value).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    let host = url.host_str()?;
    let port = url
        .port()
        .map(|port| format!(":{port}"))
        .unwrap_or_default();
    let path = match url.path() {
        "/" => "",
        path => path,
    };
    Some((format!("{}://{host}{port}", url.scheme()), path.to_string()))
}

/// `scheme://host[:port]` of an http(s) URL.
pub(super) fn origin(value: &str) -> Option<String> {
    parts(value).map(|(origin, _)| origin)
}

/// An endpoint as diagnostics show it: scheme, host, port and path, never
/// credentials, query or fragment.
pub fn diagnostics_endpoint(value: Option<&str>) -> Option<String> {
    parts(value?).map(|(origin, path)| origin + &path)
}

/// Relaycast's connection, in one phrase.
pub fn relaycast_state(snapshot: Option<&Status>, connected: bool) -> String {
    let Some(snapshot) = snapshot.filter(|_| connected) else {
        return "Unavailable · service disconnected".to_string();
    };
    if snapshot.workspace.state != WorkspaceState::Found {
        return "Not configured".to_string();
    }
    match snapshot.workspace.verification {
        Verification::Rejected => "Credentials rejected".to_string(),
        Verification::Unreachable => "Unreachable".to_string(),
        Verification::Pending => "Checking connection".to_string(),
        Verification::Verified => {
            let channels = snapshot.push.len();
            let live = snapshot
                .push
                .values()
                .filter(|state| **state == PushState::Live)
                .count();
            if channels == 0 {
                "Ready · no active channels".to_string()
            } else if live == channels {
                format!("Connected · {live} live channels")
            } else if live > 0 {
                format!("Partially connected · {live}/{channels} live channels")
            } else {
                "Reconnecting · no live channels".to_string()
            }
        }
    }
}

/// One titled group of the diagnostics report.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiagnosticsSection {
    pub title: &'static str,
    /// `(label, value)`; a missing value reads "Unavailable".
    pub rows: Vec<(&'static str, String)>,
}

/// About's diagnostics: an allowlisted report, never the account or
/// settings wholesale, since future fields may hold credentials or private
/// content. `service` is the systemd user service's state, `platform` the
/// system's name and `upload_headline` the uploader's status headline.
pub fn diagnostics_sections<Tz: TimeZone>(
    snapshot: Option<&Status>,
    connected: bool,
    app_version: &str,
    platform: &str,
    service: &str,
    upload_headline: Option<&str>,
    zone: &Tz,
) -> Vec<DiagnosticsSection>
where
    Tz::Offset: Display,
{
    fn row(label: &'static str, value: Option<String>) -> (&'static str, String) {
        (
            label,
            value
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "Unavailable".to_string()),
        )
    }
    let daemon = snapshot.map(|snapshot| &snapshot.daemon);
    let workspace = snapshot.map(|snapshot| &snapshot.workspace);
    let account = snapshot.map(|snapshot| &snapshot.account);
    let sign_in = if connected {
        account.and_then(|account| match serde_json::to_value(account.state) {
            Ok(serde_json::Value::String(state)) => Some(state),
            _ => None,
        })
    } else {
        Some("Unavailable · service disconnected".to_string())
    };
    vec![
        DiagnosticsSection {
            title: "Build",
            rows: vec![
                row("Desktop", Some(app_version.to_string())),
                row(
                    "Running service",
                    daemon.map(|daemon| daemon.version.clone()),
                ),
                row(
                    "Service Git revision",
                    daemon.and_then(|daemon| daemon.build_revision.clone()),
                ),
                row(
                    "RelayHistory (ai-hist)",
                    daemon.and_then(|daemon| daemon.history_version.clone()),
                ),
                row(
                    "Bridge protocol",
                    daemon.map(|daemon| daemon.bridge_version.to_string()),
                ),
                row("Platform", Some(platform.to_string())),
            ],
        },
        DiagnosticsSection {
            title: "Connections",
            rows: vec![
                row(
                    "Background service",
                    Some(
                        if connected {
                            "Connected"
                        } else {
                            "Disconnected"
                        }
                        .to_string(),
                    ),
                ),
                row(
                    if cfg!(windows) {
                        "Logon task"
                    } else {
                        "systemd user service"
                    },
                    Some(service.to_string()),
                ),
                row(
                    "Service process ID",
                    daemon.map(|daemon| daemon.pid.to_string()),
                ),
                row(
                    "Service started",
                    daemon.and_then(|daemon| dated_clock(Some(daemon.started_at_ms), zone)),
                ),
                row("Agent Relay", Some(relaycast_state(snapshot, connected))),
                row(
                    "Agent Relay endpoint",
                    diagnostics_endpoint(
                        workspace.and_then(|workspace| workspace.base_url.as_deref()),
                    ),
                ),
                row(
                    "Agent Relay last checked",
                    workspace.and_then(|workspace| dated_clock(workspace.checked_at_ms, zone)),
                ),
                row(
                    "Cloud site",
                    diagnostics_endpoint(account.and_then(|account| account.site_url.as_deref())),
                ),
                row("Sign-in", sign_in),
            ],
        },
        DiagnosticsSection {
            title: "Workspace",
            rows: vec![
                row(
                    "Account ID",
                    account
                        .and_then(|account| account.person.as_ref())
                        .and_then(|person| person.id.clone()),
                ),
                row(
                    "Cloud workspace ID",
                    account.and_then(|account| account.workspace_id.clone()),
                ),
                row(
                    "Agent Relay workspace ID",
                    workspace.and_then(|workspace| workspace.workspace_id.clone()),
                ),
                row(
                    "Agent Relay workspace name",
                    workspace.and_then(|workspace| workspace.workspace_name.clone()),
                ),
                row("Upload state", upload_headline.map(str::to_string)),
            ],
        },
    ]
}

/// The report Copy diagnostics puts on the clipboard.
pub fn diagnostics_report(sections: &[DiagnosticsSection]) -> String {
    sections
        .iter()
        .map(|section| {
            let rows: Vec<String> = section
                .rows
                .iter()
                .map(|(label, value)| format!("{label}: {value}"))
                .collect();
            format!("{}\n{}", section.title, rows.join("\n"))
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

// The Claude Code config folders whose sessions this computer finds and
// uploads (`claude_config_dirs`), in Settings › Relay. The Mac's
// `ClaudeFolders` matches this word for word.

pub const CLAUDE_FOLDERS_TITLE: &str = "Claude Code folders";
pub const CLAUDE_FOLDERS_DETAIL: &str = "Agent Relay finds Claude Code sessions and uploads their transcripts from each shared folder. A folder a running session uses through CLAUDE_CONFIG_DIR is added when it is seen. Turn a folder off to keep its sessions off the relay and out of uploads.";
pub const CLAUDE_FOLDERS_ADD: &str = "Add Folder…";
pub const CLAUDE_FOLDERS_ADD_HELP: &str =
    "Watch another Claude Code config folder, such as one you set as CLAUDE_CONFIG_DIR";
pub const CLAUDE_FOLDERS_REMOVE: &str = "Remove";
pub const CLAUDE_FOLDERS_SHARE_HELP: &str =
    "Share this folder's sessions: put them on the relay and upload them";
pub const CLAUDE_FOLDERS_NOT_SHARED: &str = "Not shared";
/// The opt-in for claude.ai cloud sessions (`claude_cloud_sessions`).
pub const CLAUDE_CLOUD_SESSIONS_TITLE: &str = "Claude Code cloud sessions";
/// The Mac's line goes on to explain its Keychain prompt; Claude Code keeps
/// its login in a file here, with no Keychain to ask.
pub const CLAUDE_CLOUD_SESSIONS_DETAIL: &str = "Also upload your claude.ai cloud sessions, read with the Claude Code login in ~/.claude while that folder is shared.";

/// The line under a folder: why it is watched, and whether it is shared.
pub fn claude_folder_detail(folder: &ClaudeConfigDir) -> String {
    let origin = claude_folder_origin_label(&folder.origin);
    if folder.shared {
        origin.to_string()
    } else {
        format!("{origin} · {CLAUDE_FOLDERS_NOT_SHARED}")
    }
}

/// Why a folder is watched, as the core reports it.
pub fn claude_folder_origin_label(origin: &str) -> &str {
    match origin {
        "default" => "Default",
        "sibling" => "Another Claude login",
        "environment" => "Set by AGENT_RELAY_CLAUDE_CONFIG_DIRS",
        "added" => "Added here",
        "running" => "Seen on a running session",
        other => other,
    }
}

/// Only a folder added here can be removed here.
pub fn claude_folder_removable(folder: &ClaudeConfigDir) -> bool {
    folder.origin == "added"
}

/// `path` with the home folder written `~`.
pub fn claude_folder_display_path(path: &str, home: &str) -> String {
    if home.is_empty() {
        return path.to_string();
    }
    if path == home {
        return "~".into();
    }
    let prefix = if home.ends_with('/') {
        home.to_string()
    } else {
        format!("{home}/")
    };
    match path.strip_prefix(&prefix) {
        Some(rest) => format!("~/{rest}"),
        None => path.to_string(),
    }
}

/// The added folders with `path` added at the end.
pub fn claude_folders_adding(path: &str, folders: &[ClaudeConfigDir]) -> Vec<String> {
    let mut added: Vec<String> = folders
        .iter()
        .filter(|f| claude_folder_removable(f))
        .map(|f| f.path.clone())
        .collect();
    if !added.iter().any(|known| known == path) {
        added.push(path.to_string());
    }
    added
}

/// The added folders without `path`.
pub fn claude_folders_removing(path: &str, folders: &[ClaudeConfigDir]) -> Vec<String> {
    folders
        .iter()
        .filter(|f| claude_folder_removable(f) && f.path != path)
        .map(|f| f.path.clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::super::time::tests::zone;
    use super::*;
    use serde_json::{json, Value};

    fn settings(value: Value) -> SettingsValues {
        let mut base = json!({"allow_self_registration": true, "auto_activate": true});
        super::super::uploads::tests::merge(&mut base, value);
        serde_json::from_value(base).unwrap()
    }

    #[test]
    fn offered_once_where_direct_delivery_is_on_and_unmanaged() {
        let on = settings(json!({"direct_delivery": true}));
        assert_eq!(
            inbound_default_offer(Some(&on), false),
            Some(InboundOffer::Offer)
        );
        assert_eq!(inbound_default_offer(Some(&on), true), None);
        // An explicit hold is kept.
        let held = settings(json!({"direct_delivery": false}));
        assert_eq!(inbound_default_offer(Some(&held), false), None);
        // Settings not read yet.
        assert_eq!(
            inbound_default_offer(None, false),
            Some(InboundOffer::Offer)
        );
        // A core without Claude settings.
        let without = settings(json!({"auto_activate": false}));
        assert_eq!(inbound_default_offer(Some(&without), false), None);
        let managed =
            settings(json!({"direct_delivery": false, "direct_delivery_managed": "hold"}));
        assert_eq!(
            inbound_default_offer(Some(&managed), false),
            Some(InboundOffer::Managed("hold".to_string()))
        );
        let accepted =
            settings(json!({"direct_delivery": true, "direct_delivery_managed": "accept"}));
        assert_eq!(
            inbound_default_offer(Some(&accepted), false),
            Some(InboundOffer::Offer)
        );
        assert!(managed_inbound_detail("refuse").contains("drops relayed messages"));
        assert!(managed_inbound_detail("hold").contains("to hold, so Claude Code asks"));
    }

    #[test]
    fn hermes_wording_matches_the_mac() {
        assert_eq!(HERMES_TITLE, "Hermes");
        assert_eq!(HERMES_ON, "Agent Relay reaches Hermes's relay profile on this computer, so it appears here and can be messaged. The relay profile has its own memory and no channels, apart from your main Hermes. Each sender gets a session of its own, and Hermes's final answer goes back to that sender only.");
        assert_eq!(HERMES_OFF, "Turn this on so Hermes's relay profile on this computer appears here and can be messaged. The relay profile has its own memory and no channels, apart from your main Hermes. Each sender gets a session of its own, and Hermes's final answer goes back to that sender only.");
        assert_eq!(
            HERMES_TURN_ON_HELP,
            "List and message Hermes on this computer"
        );
        assert_eq!(HERMES_TURN_OFF_HELP, "Stop listing and messaging Hermes");
    }

    #[test]
    fn trusted_senders_match_the_mac() {
        assert_eq!(TRUSTED_SENDERS_TITLE, "Trusted senders");
        assert_eq!(TRUSTED_SENDERS_DETAIL, "Relay names or addresses trusted like you: their messages reach your own OpenClaw and Hermes, with their memory and tools. Everyone else gets an answer-only chat of their own. Separate them with commas.");
        assert_eq!(TRUSTED_SENDERS_PLACEHOLDER, "teammate, name@machine");
        assert_eq!(
            trusted_senders(" ada-lovelace, ,bot@node-9 "),
            ["ada-lovelace", "bot@node-9"]
        );
        assert!(trusted_senders("").is_empty());
    }

    #[test]
    fn openclaw_wording_matches_the_mac() {
        assert_eq!(OPENCLAW_TITLE, "OpenClaw agents");
        assert_eq!(OPENCLAW_ON, "Agent Relay reaches OpenClaw's Gateway on this computer, so its agents appear here and can be messaged. Each sender gets a chat of its own, apart from your main chat, and the agent's answer goes back to that sender only, never to your other channels.");
        assert_eq!(OPENCLAW_OFF, "Turn this on so the agents of the OpenClaw Gateway on this computer appear here and can be messaged. Each sender gets a chat of its own, apart from your main chat, and the agent's answer goes back to that sender only.");
        assert_eq!(
            OPENCLAW_TURN_ON_HELP,
            "List and message the agents of OpenClaw's Gateway"
        );
        assert_eq!(
            OPENCLAW_TURN_OFF_HELP,
            "Stop listing and messaging OpenClaw's agents"
        );
        assert_eq!(openclaw_unlimited_notice("2026.3.13"), "OpenClaw 2026.3.13 can't limit relay sessions, so anyone on the relay who messages your agents gets a session with your agent's usual tools. Updating OpenClaw to 2026.8.1 or later makes them answer-only.");
    }

    #[test]
    fn claude_session_hook_wording_matches_the_mac() {
        assert_eq!(CLAUDE_SESSION_HOOK_TITLE, "Claude Code activation");
        assert_eq!(
            CLAUDE_SESSION_HOOK_OFF,
            "A Claude Code session stays off the relay until you put it on. Turn this on to add a SessionStart hook to each Claude login's settings.json. When a session is not on the relay, the hook has Claude ask you whether to put it on the relay and under what name. Nothing is registered unless you say yes."
        );
        assert_eq!(
            CLAUDE_SESSION_HOOK_ON,
            "Agent Relay's SessionStart hook is in each Claude login's settings.json. When a session is not on the relay, the hook has Claude ask you whether to put it on the relay and under what name. Nothing is registered unless you say yes."
        );
        assert_eq!(
            CLAUDE_SESSION_HOOK_TURN_ON_HELP,
            "Add Agent Relay's SessionStart hook to each Claude login"
        );
        assert_eq!(
            CLAUDE_SESSION_HOOK_TURN_OFF_HELP,
            "Remove Agent Relay's SessionStart hook from each Claude login"
        );
        assert!(!CLAUDE_SESSION_HOOK_ON.contains("auto_activate"));
        assert!(CLAUDE_SESSION_HOOK_OFF.contains("unless you say yes"));
    }

    #[test]
    fn sign_in_wording() {
        let account = |value: Value| -> AccountStatus {
            let mut base = json!({"state": "pending_approval"});
            super::super::uploads::tests::merge(&mut base, value);
            serde_json::from_value(base).unwrap()
        };
        let none = SignInLink::default();
        assert_eq!(
            sign_in_heading(&account(json!({"phase": "waiting_for_device_approval"}))),
            "Finish signing in in your browser"
        );
        assert_eq!(
            sign_in_heading(&account(json!({}))),
            "Starting secure sign-in…"
        );
        let scanning = account(json!({"progress": {"phase": "scanning", "source": "codex",
                                                     "processed_files": 0, "sessions_captured": 4}}));
        assert_eq!(
            sign_in_detail(&scanning, &none),
            "Scanning codex: 4 sessions found"
        );
        let link = SignInLink {
            verification_url: Some("https://x".to_string()),
            ..SignInLink::default()
        };
        assert!(sign_in_detail(&account(json!({})), &link).contains("Approve"));
        assert_eq!(
            sign_in_detail(&account(json!({})), &none),
            "Your browser will open to Agent Relay."
        );
    }

    #[test]
    fn labels_for_incoming_messages() {
        assert_eq!(
            incoming_state_label(IncomingState::NeedsSignIn),
            "Sign in again to receive messages."
        );
    }

    #[test]
    fn diagnostics_never_include_secrets() {
        let snapshot: Status = serde_json::from_value(json!({
            "revision": 1,
            "daemon": {"version": "1", "pid": 3, "bridge_version": 2, "started_at_ms": 0, "socket": "/s"},
            "machine": {"host_name": "desk", "machine_prefix": "desk"},
            "workspace": {"state": "found", "verification": "verified",
                          "base_url": "https://user:pw@api.relaycast.dev/v1?key=secret"},
            "push": {"a": {"state": "live"}},
            "agents": {},
            "account": {"state": "signed_in", "site_url": "https://agentrelay.com"},
        }))
        .unwrap();
        let report = diagnostics_report(&diagnostics_sections(
            Some(&snapshot),
            true,
            "2026.10.9",
            "Linux",
            "Off",
            None,
            &zone(),
        ));
        assert!(report.contains("Agent Relay endpoint: https://api.relaycast.dev/v1\n"));
        assert!(report.contains("Agent Relay: Connected · 1 live channels"));
        assert!(report.contains("Cloud site: https://agentrelay.com\n"));
        assert!(report.contains("Sign-in: signed_in"));
        assert!(report.contains("Service started: Unavailable"));
        assert!(report.contains("Upload state: Unavailable"));
        assert!(!report.contains("secret"));
        assert!(!report.contains("pw"));
        let offline = diagnostics_report(&diagnostics_sections(
            None,
            false,
            "2026.10.9",
            "Linux",
            "Off",
            None,
            &zone(),
        ));
        assert!(offline.contains("Agent Relay: Unavailable · service disconnected"));
        assert!(offline.contains("Sign-in: Unavailable · service disconnected"));
    }

    #[test]
    fn the_watched_claude_folders_say_why_each_is_watched() {
        let values = settings(json!({"claude_config_dirs": [
            {"path": "/home/m/.claude", "origin": "default", "shared": false},
            {"path": "/home/m/.seclaude", "origin": "running", "shared": true},
            {"path": "/opt/claude", "origin": "added", "shared": true}
        ]}));
        let folders = values.claude_config_dirs.unwrap();
        assert_eq!(
            folders
                .iter()
                .map(|f| claude_folder_origin_label(&f.origin))
                .collect::<Vec<_>>(),
            ["Default", "Seen on a running session", "Added here"]
        );
        assert_eq!(
            folders
                .iter()
                .filter(|f| claude_folder_removable(f))
                .map(|f| f.path.as_str())
                .collect::<Vec<_>>(),
            ["/opt/claude"]
        );
        assert_eq!(
            folders.iter().map(claude_folder_detail).collect::<Vec<_>>(),
            [
                "Default · Not shared",
                "Seen on a running session",
                "Added here"
            ]
        );
        assert_eq!(
            claude_folders_adding("/home/m/.work", &folders),
            ["/opt/claude", "/home/m/.work"]
        );
        assert_eq!(
            claude_folders_adding("/opt/claude", &folders),
            ["/opt/claude"]
        );
        assert!(claude_folders_removing("/opt/claude", &folders).is_empty());
        assert!(settings(json!({})).claude_config_dirs.is_none());
    }

    #[test]
    fn claude_folder_paths_under_home_are_shortened() {
        assert_eq!(
            claude_folder_display_path("/home/m/.seclaude", "/home/m"),
            "~/.seclaude"
        );
        assert_eq!(claude_folder_display_path("/home/m", "/home/m"), "~");
        assert_eq!(
            claude_folder_display_path("/home/mo/.claude", "/home/m"),
            "/home/mo/.claude"
        );
        assert_eq!(claude_folder_display_path("/opt/claude", ""), "/opt/claude");
    }

    #[test]
    fn claude_folder_wording_matches_the_mac() {
        assert_eq!(CLAUDE_FOLDERS_TITLE, "Claude Code folders");
        assert_eq!(
            CLAUDE_FOLDERS_DETAIL,
            "Agent Relay finds Claude Code sessions and uploads their transcripts from each shared folder. A folder a running session uses through CLAUDE_CONFIG_DIR is added when it is seen. Turn a folder off to keep its sessions off the relay and out of uploads."
        );
        assert_eq!(CLAUDE_CLOUD_SESSIONS_TITLE, "Claude Code cloud sessions");
        assert_eq!(
            CLAUDE_CLOUD_SESSIONS_DETAIL,
            "Also upload your claude.ai cloud sessions, read with the Claude Code login in ~/.claude while that folder is shared."
        );
        assert_eq!(
            claude_folder_origin_label("sibling"),
            "Another Claude login"
        );
        assert_eq!(
            claude_folder_origin_label("environment"),
            "Set by AGENT_RELAY_CLAUDE_CONFIG_DIRS"
        );
    }
}

// The settings as shown while changes are on their way to the core: the
// confirmed values with each pending change applied in order. The Mac's
// `SettingsValues.applying` in `RelayDesktopCore` does the same merge.

/// Keys a `settings.set` carries that `SettingsValues` does not hold (or
/// holds in another shape), so they cannot be shown before the answer.
const SETTINGS_WRITE_ONLY: [&str; 3] = [
    "claude_config_dir",
    "claude_config_dirs",
    "direct_delivery_default",
];

/// The snake_case keys `change` sets, as the contract names them.
pub fn settings_change_fields(change: &SettingsChange) -> Vec<String> {
    match serde_json::to_value(change) {
        Ok(serde_json::Value::Object(fields)) => fields.into_iter().map(|(key, _)| key).collect(),
        _ => Vec::new(),
    }
}

/// `values` with `change` applied: each key the change sets replaces the
/// value's, except the per-harness spawn settings, which merge harness by
/// harness. Keys the values cannot show are left as they are.
pub fn apply_settings_change(values: &SettingsValues, change: &SettingsChange) -> SettingsValues {
    let (Ok(serde_json::Value::Object(mut base)), Ok(serde_json::Value::Object(changed))) =
        (serde_json::to_value(values), serde_json::to_value(change))
    else {
        return values.clone();
    };
    for (key, value) in changed {
        if SETTINGS_WRITE_ONLY.contains(&key.as_str()) {
            continue;
        }
        if key == "spawn_harnesses" && merge_harnesses(base.get_mut(&key), &value) {
            continue;
        }
        base.insert(key, value);
    }
    serde_json::from_value(serde_json::Value::Object(base)).unwrap_or_else(|_| values.clone())
}

/// Writes each harness's changed settings over the ones known; returns
/// whether the change merged (else it replaces the whole map).
fn merge_harnesses(known: Option<&mut serde_json::Value>, changed: &serde_json::Value) -> bool {
    let (Some(serde_json::Value::Object(current)), serde_json::Value::Object(harnesses)) =
        (known, changed)
    else {
        return false;
    };
    for (harness, settings) in harnesses {
        match (current.get_mut(harness), settings) {
            (Some(serde_json::Value::Object(known)), serde_json::Value::Object(settings)) => {
                for (field, value) in settings {
                    known.insert(field.clone(), value.clone());
                }
            }
            _ => {
                current.insert(harness.clone(), settings.clone());
            }
        }
    }
    true
}

#[cfg(test)]
mod overlay_tests {
    use super::*;
    use crate::relay::contract::agents::SpawnHarnessSettings;
    use serde_json::json;

    fn values(value: serde_json::Value) -> SettingsValues {
        let mut base = json!({"allow_self_registration": true, "auto_activate": true});
        super::super::uploads::tests::merge(&mut base, value);
        serde_json::from_value(base).unwrap()
    }

    #[test]
    fn a_change_shows_over_the_confirmed_values() {
        let confirmed = values(json!({
            "accept_spawns": true, "spawn_max_agents": 4,
            "spawn_harnesses": {"codex": {"full_access": true, "billing": "api"}}
        }));
        let change = SettingsChange {
            allow_self_registration: Some(false),
            accept_spawns: Some(false),
            spawn_max_agents: Some(9),
            spawn_harnesses: Some(
                [(
                    "codex".to_string(),
                    SpawnHarnessSettings {
                        full_access: Some(false),
                        billing: None,
                    },
                )]
                .into_iter()
                .collect(),
            ),
            direct_delivery_default: Some(true),
            claude_config_dirs: Some(vec!["/tmp/x".into()]),
            ..Default::default()
        };
        assert_eq!(
            settings_change_fields(&change),
            [
                "accept_spawns",
                "allow_self_registration",
                "claude_config_dirs",
                "direct_delivery_default",
                "spawn_harnesses",
                "spawn_max_agents",
            ]
            .map(String::from)
        );
        let shown = apply_settings_change(&confirmed, &change);
        assert!(!shown.allow_self_registration);
        assert_eq!(shown.accept_spawns, Some(false));
        assert_eq!(shown.spawn_max_agents, Some(9));
        let codex = &shown.spawn_harnesses.as_ref().unwrap()["codex"];
        // The harness's other setting is kept.
        assert_eq!(codex.full_access, Some(false));
        assert_eq!(codex.billing.as_deref(), Some("api"));
        // Write-only keys and the folder list change nothing before the answer.
        assert_eq!(shown.claude_config_dirs, confirmed.claude_config_dirs);
        assert_eq!(shown.direct_delivery, confirmed.direct_delivery);
        // An untouched value stays.
        assert!(shown.auto_activate);
    }
}
