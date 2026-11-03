//! What the SessionStart hook prints: the session's relay status read from
//! the session socket, and the context that tells Claude Code what to do
//! with it.

use crate::relay::hosted_mcp::{self, McpAccess};
use crate::relay::process::ProcessTable;
use serde_json::{json, Value};
use std::path::Path;

/// Header on the hook's status read. The core then does not apply the
/// agent-led defaults. The name is lowercase because the socket parser
/// stores header names that way.
pub const OBSERVE_HEADER: &str = "x-agent-relay-observe";

/// The only value of [`OBSERVE_HEADER`] that skips the defaults.
pub const OBSERVE_VALUE: &str = "1";

/// How `GET /setup/status`'s body is read. `Again` is only the race where
/// Claude has not written its session file yet.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StatusRead {
    /// `on_relay` is `session.registered`. `self_registration` is whether
    /// `POST /register` is allowed; a body that omits it means allowed,
    /// which is the setting's default.
    Registered {
        on_relay: bool,
        self_registration: bool,
    },
    /// Not on the relay yet, but automatic activation is on: the core puts
    /// the session on the relay by itself within seconds.
    Joining,
    /// On the relay, with the name, address and access status reported.
    OnRelay {
        name: String,
        address: String,
        /// The address join_relay links to: the registered one, which
        /// Desktop syncs to Cloud. Same as `address` unless renamed.
        link_address: String,
        mcp: McpAccess,
    },
    Again,
    Unknown,
}

/// The probe the core's rules and hints name (`probe` in its
/// `GET /setup/status` answer): the space-free link when it is in use.
/// `None` from an older core, or for anything but an absolute path.
pub fn read_probe(body: &[u8]) -> Option<std::path::PathBuf> {
    let value = serde_json::from_slice::<Value>(body).ok()?;
    let probe = std::path::PathBuf::from(value["data"]["probe"].as_str()?);
    probe.is_absolute().then_some(probe)
}

/// `session.registered` from a session-socket response, or why it is not
/// known. A failure is never treated as a reason to register.
pub fn read_status(http_status: u16, body: &[u8]) -> StatusRead {
    let Ok(value) = serde_json::from_slice::<Value>(body) else {
        return StatusRead::Unknown;
    };
    if (200..300).contains(&http_status) {
        let Some(on_relay) = value["data"]["session"]["registered"].as_bool() else {
            return StatusRead::Unknown;
        };
        let session = &value["data"]["session"];
        if let (true, Some(name), Some(address)) = (
            on_relay,
            session["name"].as_str(),
            session["address"].as_str(),
        ) {
            return StatusRead::OnRelay {
                name: name.into(),
                address: address.into(),
                // An older core sends no link_address; its address is the
                // registered one.
                link_address: session["link_address"].as_str().unwrap_or(address).into(),
                mcp: McpAccess::parse(session["mcp"].as_str()),
            };
        }
        // Only when the core says this session will join: automatic
        // activation can be on while there is no workspace yet or the
        // session's folder is excluded from it.
        if !on_relay && session["auto_activates"].as_bool() == Some(true) {
            return StatusRead::Joining;
        }
        // Registered sessions always retain their identity preamble above.
        // The optional flag also distinguishes an unknown initial policy from
        // the selected-mode display fallback used by older setup clients.
        let prompt_allowed = value["data"]["claude_prompt_to_join_allowed"]
            .as_bool()
            .unwrap_or_else(|| {
                value["data"]["sharing_mode"]
                    .as_str()
                    .map_or(true, |mode| mode == "selected")
            });
        if !on_relay && !prompt_allowed {
            return StatusRead::Unknown;
        }
        let self_registration = value["data"]["allow_self_registration"]
            .as_bool()
            .unwrap_or(true);
        return StatusRead::Registered {
            on_relay,
            self_registration,
        };
    }
    match value["error"]["code"].as_str() {
        Some("not_a_relay_session" | "session_file_unreadable") => StatusRead::Again,
        _ => StatusRead::Unknown,
    }
}

/// How many ancestors to climb from the hook looking for its Claude Code
/// process. Claude runs a hook command through a shell, so it is normally
/// the parent or grandparent.
const ANCESTOR_LIMIT: usize = 8;

/// The Claude Code process a hook started at `start` runs in: the nearest
/// ancestor (inclusive) that is Claude Code, unless another agent comes
/// first. Cursor CLI runs the hooks in `~/.claude/settings.json` too, and a
/// Cursor started from a Claude Code terminal inherits that session's
/// environment, so neither `CLAUDECODE` nor a Claude ancestor further up
/// says the hook is Claude's: the nearest agent does.
pub fn claude_ancestor(table: &dyn ProcessTable, start: i32) -> Option<i32> {
    let mut pid = start;
    for _ in 0..ANCESTOR_LIMIT {
        if pid <= 1 {
            return None;
        }
        if crate::relay::hook_agents::is_claude_process(table, pid) {
            return Some(pid);
        }
        if crate::relay::hook_agents::is_other_agent(table, pid) {
            return None;
        }
        pid = table.process(pid)?.parent;
    }
    None
}

/// Whether the session running this hook has a person to answer. A
/// `claude -p`, Agent SDK or structured pipe run (a flows step, cron, CI)
/// would spend its one reply on the relay question instead of its task, so
/// it is told nothing. A run whose Claude process cannot be found is treated
/// the same way.
pub fn has_person(table: &dyn ProcessTable, start: i32) -> bool {
    claude_ancestor(table, start)
        .is_some_and(|pid| crate::relay::claude::is_interactive_process(table, pid))
}

/// What the hook prints. A session on the relay gets the preamble alone.
/// An unregistered session is told how it could join only when a person
/// is there to ask (`interactive`), and only when self-registration is on
/// does that include the `POST /register` example. The text does not
/// register anything. `probe` is the one Claude's permission rules name
/// (the core reports it: [`read_probe`]), which the commands use.
pub fn hook_output(
    status: Option<StatusRead>,
    socket: &Path,
    interactive: bool,
    probe: Option<&Path>,
) -> Value {
    if let Some(StatusRead::OnRelay {
        name,
        address,
        link_address,
        mcp,
    }) = &status
    {
        let context = hosted_mcp::preamble(name, address, link_address, *mcp, socket, probe);
        return json!({
            "hookSpecificOutput": {
                "hookEventName": "SessionStart",
                "additionalContext": context
            }
        });
    }
    if !interactive {
        return json!({});
    }
    let (person, agent) = match status {
        Some(StatusRead::Joining) => (JOINING_FOR_PERSON.to_string(), joining(socket, probe)),
        Some(StatusRead::Registered {
            on_relay: false,
            self_registration: true,
        }) => (NUDGE_FOR_PERSON.to_string(), nudge(socket, probe)),
        Some(StatusRead::Registered {
            on_relay: false,
            self_registration: false,
        }) => {
            let text = registration_off(socket);
            // The person reads `text`; only Claude needs the re-check.
            let agent = format!(
                "{text} {DO_NOT_REGISTER_UNASKED} {}",
                recheck(socket, probe)
            );
            (text, agent)
        }
        _ => return json!({}),
    };
    json!({
        "systemMessage": person,
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": agent
        }
    })
}

/// What the person sees when automatic activation will put the session on
/// the relay.
pub const JOINING_FOR_PERSON: &str =
    "This Claude Code session joins Agent Relay by itself in a few seconds (automatic activation is on).";

/// What Claude reads when automatic activation will put the session on the
/// relay: nothing to ask or register, and how to reach peers once it is on.
pub fn joining(socket: &Path, probe: Option<&Path>) -> String {
    let shown = socket.display().to_string();
    let quoted = crate::relay::outbound::shell_quote(&shown);
    let body = "'{\"to\":\"<name>\",\"text\":\"…\"}'";
    // The probe's self-limiting commands, which Claude's permission rules
    // allow (`hosted_mcp::SocketCommands`); curl only when it is unknown.
    let (agents, whoami, send) =
        match probe.and_then(|probe| hosted_mcp::SocketCommands::through(probe, socket)) {
            Some(commands) => (commands.agents, commands.whoami, commands.send),
            None => (
                format!("curl -s --unix-socket {quoted} http://relay/agents"),
                format!("curl -s --unix-socket {quoted} http://relay/whoami"),
                format!("curl -s --unix-socket {quoted} http://relay/send --data-binary {body}"),
            ),
        };
    format!(
        "This Claude Code session joins Agent Relay by itself within a few seconds: automatic \
         activation is on. Do not register it and do not ask the person about it. Relayed \
         messages arrive in this session as messages from another session; each names the \
         command that reads it and the one that replies. Once on the relay, through the Agent \
         Relay session socket at {shown}: {whoami} shows this session's name, {agents} lists \
         the agents it can message, and {send} sends one a message (\"address\" instead of \
         \"to\" names an exact address)."
    )
}

/// What the person sees when the session may register itself. The person
/// decides; Claude only asks.
pub const NUDGE_FOR_PERSON: &str = "This Claude Code session is not on Agent Relay. \
    Claude will ask whether to put it on the relay and under what name. Nothing is \
    registered unless you say yes.";

/// Added for Claude when the session may not register itself.
const DO_NOT_REGISTER_UNASKED: &str =
    "Do not try to put this session on the relay unless the person asks you to.";

/// What to say when the session may not register itself.
pub fn registration_off(socket: &Path) -> String {
    let shown = socket.display().to_string();
    format!(
        "This Claude Code session is not on Agent Relay. It cannot put itself on the relay \
         while \"Let sessions put themselves on the relay\" is off. Turn that on in Agent \
         Relay Settings, then POST /register on the session socket at {shown}. Agent Relay \
         does not register this session for you."
    )
}

/// The nudge Claude reads. Claude must ask first: whether this session goes
/// on the relay, and the `NAME`, are the person's to choose. The example
/// uses curl, or the probe's own socket client where curl cannot reach the
/// socket (`outbound::probe_client`: always on Windows, a named pipe).
pub fn nudge(socket: &Path, rules_probe: Option<&Path>) -> String {
    let shown = socket.display().to_string();
    let quoted = crate::relay::outbound::shell_quote(&shown);
    let server = hosted_mcp::SERVER_NAME;
    let body = format!("'{{\"name\":\"NAME\",\"mcp\":\"{server}\"}}'");
    let probe = crate::relay::outbound::probe_client(false)
        .then(|| crate::relay::outbound::probe_socket_command(socket, "POST", "/register"))
        .flatten();
    let example = match probe {
        Some(command) => format!("printf '%s' {body} | {command}"),
        None => format!(
            "curl -sS --unix-socket {quoted} -X POST http://relay/register -H \
             'Content-Type: application/json' --data-binary {body}"
        ),
    };
    let recheck = recheck(socket, rules_probe);
    format!(
        "This Claude Code session is not on Agent Relay. Do not put it on the relay on \
         your own. In your first reply, before any other work, ask the person whether to \
         put this session on Agent Relay and what name to use. Suggest claude-<repo>-<task>, \
         where repo is the repository name and task is a one- or two-word summary of your \
         current work, for example claude-cloud-plan-support. Use lowercase letters, \
         digits and single dashes, at most 48 characters. Only if they say yes, \
         POST /register on the Agent Relay session socket at {shown} with the name they \
         chose; include \"mcp\":\"{server}\" if you have the {server} MCP tools, or \
         \"mcp\":\"none\" if you do not. For example: {example}. If they say no, leave it \
         off the relay. Agent Relay does not register this session for you. {recheck}"
    )
}

/// The start text is read once; another agent, Agent Relay or the person can
/// register the session afterwards. `relay whoami` with the probe Claude's
/// rules name runs without an approval prompt; curl, or `socket-request`,
/// would ask the person first.
fn recheck(socket: &Path, rules_probe: Option<&Path>) -> String {
    let shown = socket.display().to_string();
    let whoami = rules_probe
        .and_then(|probe| {
            crate::relay::session_cli::SessionCommand::Whoami.command_line(probe, socket, None)
        })
        .or_else(|| {
            crate::relay::outbound::probe_client(false)
                .then(|| crate::relay::outbound::probe_socket_command(socket, "GET", "/whoami"))
                .flatten()
        })
        // No command the rules allow is known: name the request rather than
        // hand Claude a curl line that asks the person.
        .unwrap_or_else(|| format!("GET /whoami on the session socket at {shown}"));
    format!(
        "This was read when the session started, and another agent, Agent Relay or the \
         person can register it afterwards. If a relay message addressed to this session \
         arrives, run {whoami} first: when it answers \"registered\":true, the session is \
         already on the relay under that name, so do not ask and do not register it again."
    )
}
