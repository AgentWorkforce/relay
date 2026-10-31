//! Predicting whether Claude Code holds a relayed message for approval.
//!
//! Claude Code's `crossSessionInbound` policy decides what a session does
//! with a message from outside it. A setting of `hold` holds every one;
//! with no setting, a session that skips permission prompts holds a
//! message whose sender does not attest its permission mode, which the
//! relay never does. The message is still handed over (Claude Code has
//! it, and shows it to the person to approve); the prediction only lets
//! the activity log and the sender say so instead of "delivered".

use super::{inbox, terminal_session, transcript, ClaudeConfig, TerminalSession};
use crate::relay::process::ProcessTable;
use serde_json::Value;
use std::path::Path;

/// Why Claude Code will hold a relayed message for the person's approval
/// rather than show it to the session (its `crossSessionInbound` policy).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Hold {
    /// A settings file says `hold`, or names a value Claude Code does not
    /// know, which it treats as `hold`.
    Setting,
    /// No setting decides, and the session skips permission prompts: Claude
    /// Code holds a message from a sender that does not attest its
    /// permission mode, which the relay never does.
    BypassesPrompts,
}

impl Hold {
    /// The activity log's note for a message Claude Code holds.
    pub fn detail(self) -> &'static str {
        match self {
            Hold::Setting => "Held for approval in Claude Code: its crossSessionInbound setting is hold.",
            Hold::BypassesPrompts => "Held for approval in Claude Code: this session skips permission prompts, and crossSessionInbound is not accept.",
        }
    }
}

/// `crossSessionInbound` ranks: a repository's settings may only tighten.
fn inbound_rank(value: &str) -> u8 {
    match value {
        "accept" => 0,
        "hold" => 1,
        _ => 2,
    }
}

/// The `crossSessionInbound` value `settings` names, or for a value of the
/// wrong type or an unknown string, `hold`, as Claude Code reads it.
fn named_inbound(settings: &Path) -> Option<String> {
    let value: Value = serde_json::from_slice(&std::fs::read(settings).ok()?).ok()?;
    let named = value.get(crate::relay::claude_settings::INBOUND_KEY)?;
    Some(match named.as_str() {
        Some(known @ ("accept" | "hold" | "refuse")) => known.to_string(),
        _ => "hold".to_string(),
    })
}

/// The `crossSessionInbound` that decides for `session`, as Claude Code
/// resolves it: managed settings, else the session's own login's; then the
/// repository's `.claude/settings.json` and `settings.local.json` in its
/// working directory, which may only make it stricter.
fn effective_inbound(config: &ClaudeConfig, session: &TerminalSession) -> Option<String> {
    let login = session
        .registry
        .as_deref()
        .and_then(Path::parent)
        .unwrap_or(&config.home);
    let mut value = named_inbound(Path::new(crate::relay::claude_settings::MANAGED_SETTINGS))
        .or_else(|| named_inbound(&login.join("settings.json")));
    if let Some(cwd) = session.cwd.as_deref() {
        for repo in ["settings.local.json", "settings.json"] {
            let Some(named) = named_inbound(&Path::new(cwd).join(".claude").join(repo)) else {
                continue;
            };
            if inbound_rank(&named) > inbound_rank(value.as_deref().unwrap_or("accept")) {
                value = Some(named);
            }
        }
    }
    value
}

/// The permission mode the command line starts the session in.
fn argument_mode(arguments: &[String]) -> Option<String> {
    arguments.iter().enumerate().find_map(|(index, argument)| {
        if argument == "--dangerously-skip-permissions" {
            return Some("bypassPermissions".to_string());
        }
        argument
            .strip_prefix("--permission-mode=")
            .map(str::to_string)
            .or_else(|| {
                (argument == "--permission-mode")
                    .then(|| arguments.get(index + 1).cloned())
                    .flatten()
            })
    })
}

/// Whether the session's permission mode skips prompts, as Claude Code
/// classes it: `bypassPermissions`, or plan mode in a session that may
/// bypass them. The mode comes from the transcript's tail, where Claude
/// Code records each change and each prompt's mode, else the command line.
fn bypasses_prompts(
    config: &ClaudeConfig,
    table: &dyn ProcessTable,
    session: &TerminalSession,
) -> bool {
    let arguments = table.arguments(session.pid);
    let recorded = transcript::path(config, table, &session.session_id)
        .and_then(|(path, _)| inbox::read_tail(&path, inbox::TAIL_BYTES).ok())
        .and_then(|(tail, truncated)| inbox::permission_mode(&tail, truncated));
    let started = argument_mode(&arguments);
    match recorded.or_else(|| started.clone()).as_deref() {
        Some("bypassPermissions") => true,
        Some("plan") => {
            started.as_deref() == Some("bypassPermissions")
                || arguments
                    .iter()
                    .any(|a| a == "--allow-dangerously-skip-permissions")
        }
        _ => false,
    }
}

/// Whether Claude Code will hold a relayed message to the running session
/// `session_id` for approval, from its effective `crossSessionInbound` and
/// its permission mode. `None` when it delivers it, refuses it, or the
/// session is not running.
pub fn predicted_hold(
    config: &ClaudeConfig,
    table: &dyn ProcessTable,
    session_id: &str,
) -> Option<Hold> {
    let session = terminal_session(config, table, session_id)?;
    match effective_inbound(config, &session).as_deref() {
        Some("hold") => Some(Hold::Setting),
        Some(_) => None,
        None => bypasses_prompts(config, table, &session).then_some(Hold::BypassesPrompts),
    }
}
