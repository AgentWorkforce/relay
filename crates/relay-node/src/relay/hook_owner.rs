//! Which build of Agent Relay a hook command in a shared settings file
//! belongs to (`outbound::Build`).
//!
//! Agent Relay, Agent Relay Dev and each profile build share the person's
//! agent settings (Claude Code's `settings.json`, Codex's `hooks.json`), so
//! each build's hook carries a marker after its subcommand and a build edits
//! only the hooks carrying its own:
//!
//! - Agent Relay: none (`<probe> <subcommand>`), as every release before
//!   profile builds wrote it.
//! - Agent Relay Dev: ` --dev`.
//! - a profile build: ` --socket <its session socket>`, which also points the
//!   hook at that build's core without reading any pointer file.
//!
//! An unmarked hook is Agent Relay's slot whatever executable it names: a
//! profile build released before the marker (an "Agent Relay Dev Helper" from
//! a coexisting site build, say) wrote its hook there in Agent Relay's place,
//! so Agent Relay treats it as a displaced copy of its own and replaces it,
//! and a profile build never touches it. A hook naming another build's socket
//! is that build's and is left alone.

use crate::relay::outbound::Build;
use std::path::Path;

/// The marker `build` appends to its hook's command; `socket` is the
/// session socket the build serves.
pub fn marker(build: &Build, socket: &Path) -> String {
    match build {
        Build::Production => String::new(),
        Build::Development => " --dev".into(),
        Build::Profile(_) => format!(" --socket {}", quoted(socket)),
    }
}

/// The hook command: `program` (already quoted) running `subcommand` with
/// `build`'s marker.
pub fn command(program: &str, subcommand: &str, build: &Build, socket: &Path) -> String {
    format!("{program} {subcommand}{}", marker(build, socket))
}

/// Who a hook command belongs to, from its marker.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Owner {
    /// No marker: Agent Relay's slot.
    Production,
    Development,
    /// The session socket the command names, as written.
    Socket(String),
}

/// `command`'s owner and the command without its marker, so the caller can
/// check the subcommand.
pub fn owner(command: &str) -> (Owner, &str) {
    let command = command.trim();
    if let Some(body) = command.strip_suffix(" --dev") {
        return (Owner::Development, body.trim_end());
    }
    if let Some((body, socket)) = command.rsplit_once(" --socket ") {
        let socket = socket.trim();
        if !socket.is_empty() {
            return (Owner::Socket(socket.to_string()), body.trim_end());
        }
    }
    (Owner::Production, command)
}

/// Whether `command` and `ours` (this build's own command) carry the same
/// build's marker, and `command` runs a subcommand `body_matches` accepts.
pub fn same_build(command: &str, ours: &str, body_matches: impl Fn(&str) -> bool) -> bool {
    let (owner, body) = owner(command);
    body_matches(body) && owner == self::owner(ours).0
}

#[cfg(not(windows))]
fn quoted(path: &Path) -> String {
    crate::relay::outbound::shell_quote(&path.to_string_lossy())
}

#[cfg(windows)]
fn quoted(path: &Path) -> String {
    format!("\"{}\"", path.to_string_lossy())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SUB: &str = "claude-session-hook";

    fn ends(body: &str) -> bool {
        body.ends_with(SUB)
    }

    #[test]
    fn each_build_owns_only_its_own_marker() {
        let a = Path::new(
            "/Users/a/Library/Application Support/com.agentrelay.desktop.a/run/relay.sock",
        );
        let b = Path::new(
            "/Users/a/Library/Application Support/com.agentrelay.desktop.b/run/relay.sock",
        );
        let builds = [
            command("/p", SUB, &Build::Production, a),
            command("/p", SUB, &Build::Development, a),
            command("/p", SUB, &Build::Profile("a".into()), a),
            command("/p", SUB, &Build::Profile("b".into()), b),
        ];
        for (i, ours) in builds.iter().enumerate() {
            for (j, other) in builds.iter().enumerate() {
                assert_eq!(same_build(other, ours, ends), i == j, "{ours} vs {other}");
            }
        }
        // Another executable of the same build is still that build's.
        assert!(same_build(
            &command(
                "/old/Agent Relay Dev Helper",
                SUB,
                &Build::Profile("a".into()),
                a
            ),
            &builds[2],
            ends
        ));
    }

    #[test]
    fn an_unmarked_hook_is_agent_relays_slot() {
        let legacy = format!(
            "'/Applications/Agent Relay Dev.app/Contents/Helpers/Agent Relay Dev Helper' {SUB}"
        );
        assert_eq!(owner(&legacy).0, Owner::Production);
        assert!(same_build(&legacy, &format!("/p {SUB}"), ends));
        let profile = command(
            "/p",
            SUB,
            &Build::Profile("a".into()),
            Path::new("/s/relay.sock"),
        );
        assert!(!same_build(&legacy, &profile, ends));
    }
}
