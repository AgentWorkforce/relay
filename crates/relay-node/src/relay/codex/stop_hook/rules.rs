//! The Codex rules file that lets Agent Relay's own client reach this
//! core's session socket from Codex's sandbox (`super::CodexStopHookSettings`
//! writes and removes it with the hook).

use serde_json::Value;
use std::path::PathBuf;

/// The first line of the Codex rules file Agent Relay writes; a file there
/// without it is not Agent Relay's and is never rewritten or removed.
pub(super) const RULES_HEADER: &str =
    "# Agent Relay: written and removed by Agent Relay (codex_stop_hook).";

/// How many names the sandbox rules may try (`SandboxRules`).
pub(super) const RULES_NAMES: usize = 9;

/// What lets a session reach its session socket from inside Codex's
/// sandbox, as a Codex rules file (`~/.codex/rules/agent-relay.rules`).
///
/// Codex's default sandbox (`workspace-write` or `read-only`, network off)
/// denies every Unix socket connect on macOS, so the probe's own socket
/// client failed there, and Codex asked to run it outside the sandbox or
/// reached for another Agent Relay connector. Codex runs a command outside
/// its sandbox without asking when every part of it matches an `allow`
/// prefix rule (`exec_policy` in Codex, verified with Codex 0.163).
///
/// A prefix rule constrains only a command's leading words: whatever follows
/// them is allowed too. So the rules name only the probe's self-limiting
/// session commands (`session_cli::ALLOWED_SUBCOMMANDS`: `relay send`,
/// `agents`, `whoami`, `read`, `fetch-attachment`, `connect-send` and
/// `subscribe-channel`), each only with
/// `--socket` naming this core's own session socket. Each of those fixes its
/// own method and route and checks every other argument, so nothing after
/// the prefix reaches another route; `relay socket-request`, which takes any
/// method and path (`PATCH /settings`, `/register`), has no rule and still
/// asks. Nothing else is widened: no network, no other program, no other
/// socket.
///
/// Codex matches a command only when its program is a plain, unquoted word,
/// so a probe whose path needs quoting (the macOS app's helper) is named by
/// the core's space-free link to it (`probe_alias`). A quoted argument is
/// matched as written, so the socket keeps its own path.
#[derive(Clone, Debug)]
pub struct SandboxRules {
    /// The probe executable the reply hints name.
    pub probe: PathBuf,
    /// The relay-send (session) socket this core serves.
    pub socket: PathBuf,
}

impl SandboxRules {
    /// Each rule's pattern: the probe, `relay`, the subcommand, `--socket`
    /// and the socket.
    pub fn patterns(&self) -> Vec<Vec<String>> {
        let probe = self.probe.to_string_lossy().into_owned();
        let socket = self.socket.to_string_lossy().into_owned();
        crate::relay::session_cli::ALLOWED_SUBCOMMANDS
            .iter()
            .map(|subcommand| {
                vec![
                    probe.clone(),
                    "relay".to_string(),
                    subcommand.to_string(),
                    "--socket".to_string(),
                    socket.clone(),
                ]
            })
            .collect()
    }

    /// The rules file's text (Starlark; a JSON string is a Starlark string).
    pub fn text(&self) -> String {
        let mut text = format!(
            "{RULES_HEADER}\n\
             # Lets Agent Relay's own client reach this computer's Agent Relay session socket\n\
             # from Codex's sandbox, so a session can read and answer relayed messages. Each\n\
             # command fixes its own route; no other session route is allowed.\n"
        );
        for pattern in self.patterns() {
            let justification = match pattern[2].as_str() {
                "send" => "Sends a message as this session through Agent Relay",
                "agents" => "Lists the agents this session can message",
                "whoami" => "Shows this session's own name on Agent Relay",
                "read" => "Reads a message Agent Relay relayed to this session",
                "fetch-attachment" => "Fetches an attachment sent to this session",
                "subscribe-channel" => "Joins or leaves one channel as this session",
                "connect-send" => "Answers in the Relay Connect room this session joined",
                other => panic!("no sandbox rule justification for `{other}`"),
            };
            let words = pattern
                .iter()
                .map(|word| Value::from(word.as_str()).to_string())
                .collect::<Vec<_>>()
                .join(", ");
            text.push_str(&format!(
                "prefix_rule(\n    \
                 pattern = [{words}],\n    \
                 decision = \"allow\",\n    \
                 justification = \"{justification}\",\n\
                 )\n"
            ));
        }
        text
    }
}
