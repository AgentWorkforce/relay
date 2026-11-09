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
//! - a profile build: ` --profile=<its id> --socket <its session socket>`.
//!   The id is the build's identity, which stays the same when its socket
//!   moves (another `XDG_RUNTIME_DIR` or `TMPDIR`, or a path too long for a
//!   Unix socket), so refresh rewrites the socket in place and Off takes the
//!   hook out wherever it pointed. The socket points the hook at that
//!   build's core without reading any pointer file. A hook written before
//!   the id was added (` --socket <socket>` alone) is still the profile's
//!   while it names the socket the profile serves.
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
        // One word, so an id starting with `-` is never read as an option.
        Build::Profile(id) => format!(" --profile={id} --socket {}", quoted(socket)),
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
    /// The profile build with this id (`--profile=<id>`).
    Profile(String),
    /// A profile build's hook from before the id was added: only the
    /// session socket it names, as written.
    Socket(String),
}

/// `command`'s owner, the socket it names (as written) and the command
/// without its marker.
fn parse(command: &str) -> (Owner, Option<&str>, &str) {
    let command = command.trim();
    if let Some(body) = command.strip_suffix(" --dev") {
        return (Owner::Development, None, body.trim_end());
    }
    if let Some((body, socket)) = command.rsplit_once(" --socket ") {
        let socket = socket.trim();
        if !socket.is_empty() {
            let body = body.trim_end();
            if let Some((rest, id)) = body.rsplit_once(" --profile=") {
                if !id.is_empty() && !id.contains(char::is_whitespace) {
                    return (
                        Owner::Profile(id.to_string()),
                        Some(socket),
                        rest.trim_end(),
                    );
                }
            }
            return (Owner::Socket(socket.to_string()), Some(socket), body);
        }
    }
    (Owner::Production, None, command)
}

/// `command`'s owner and the command without its marker, so the caller can
/// check the subcommand.
pub fn owner(command: &str) -> (Owner, &str) {
    let (owner, _, body) = parse(command);
    (owner, body)
}

/// Whether `command` and `ours` (this build's own command) carry the same
/// build's marker, and `command` runs a subcommand `body_matches` accepts.
/// A profile build's hooks are matched by its id whatever socket they name
/// now; one from before the id was added is the profile's when it names
/// the socket `ours` does.
pub fn same_build(command: &str, ours: &str, body_matches: impl Fn(&str) -> bool) -> bool {
    let (theirs, their_socket, body) = parse(command);
    let (mine, my_socket, _) = parse(ours);
    body_matches(body)
        && match (&theirs, &mine) {
            (Owner::Socket(_), Owner::Profile(_)) => their_socket == my_socket,
            _ => theirs == mine,
        }
}

/// This build's own On/Off choice for one of its hooks, kept in its data
/// folder apart from the shared settings file. The hook's entries can be
/// taken out by another process (another setup tool rewriting the file), so
/// their absence alone cannot tell that from the person turning the hook
/// off: with the choice kept, a hook that is on and lost its entries is put
/// back, and one turned off stays off.
pub struct Desired(Option<std::path::PathBuf>);

impl Desired {
    /// The choice for `setting` of the build whose hook runs `command`,
    /// kept in `state_dir` under a name of that build's own; none is kept
    /// without one.
    pub fn new(state_dir: Option<&Path>, setting: &str, command: &str) -> Desired {
        let build = match owner(command).0 {
            Owner::Development => ".dev".to_string(),
            Owner::Profile(id) => format!(".{id}"),
            _ => String::new(),
        };
        Desired(state_dir.map(|dir| dir.join(format!("{setting}{build}.desired"))))
    }

    /// The choice last made: `None` before one was recorded.
    pub fn load(&self) -> Option<bool> {
        match std::fs::read_to_string(self.0.as_ref()?).ok()?.trim() {
            "on" => Some(true),
            "off" => Some(false),
            _ => None,
        }
    }

    /// Records `on`. A failure to record keeps the earlier choice, which a
    /// later change records again.
    pub fn save(&self, on: bool) {
        let Some(path) = &self.0 else {
            return;
        };
        if let Some(folder) = path.parent() {
            let _ = crate::platform::fs::create_private_dir_all(folder);
        }
        let _ = std::fs::write(path, if on { "on\n" } else { "off\n" });
    }

    /// The choice, or, before one was recorded, `present` (whether the
    /// hook's entries are there now), recorded when it is on so a hook
    /// installed before choices were kept is put back once it is lost.
    pub fn or_present(&self, present: impl FnOnce() -> bool) -> bool {
        if let Some(on) = self.load() {
            return on;
        }
        let on = present();
        if on {
            self.save(true);
        }
        on
    }
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

    // Review on #2132: a profile restarted with another socket path (no
    // `XDG_RUNTIME_DIR` this time) still owns the hook it wrote, so refresh
    // replaces it and Off takes it out; another profile's never matches.
    #[test]
    fn a_profile_owns_its_hook_after_its_socket_moves() {
        let acme = Build::Profile("acme".into());
        let before = command(
            "/p",
            SUB,
            &acme,
            Path::new("/run/user/1000/agent-relay-acme/relay.sock"),
        );
        let now = command(
            "/p",
            SUB,
            &acme,
            Path::new("/tmp/agent-relay-acme-1000/relay.sock"),
        );
        assert_ne!(before, now);
        assert_eq!(owner(&before).0, Owner::Profile("acme".into()));
        assert!(same_build(&before, &now, ends));
        let other = command(
            "/p",
            SUB,
            &Build::Profile("other".into()),
            Path::new("/tmp/agent-relay-acme-1000/relay.sock"),
        );
        assert!(!same_build(&other, &now, ends));
        // A hyphen-leading id is kept as one word.
        let hyphen = command("/p", SUB, &Build::Profile("-acme".into()), Path::new("/s"));
        assert_eq!(owner(&hyphen).0, Owner::Profile("-acme".into()));
        assert!(!same_build(&hyphen, &now, ends));
    }

    // A profile hook written before the id marker (`--socket` alone) is
    // still the profile's while it names the socket the profile serves,
    // and is brought up to the marked form; one naming another socket is
    // left to whichever build serves that.
    #[test]
    fn a_socket_only_profile_hook_is_still_recognised() {
        let socket = Path::new("/run/user/1000/agent-relay-acme/relay.sock");
        let legacy = format!("/p {SUB} --socket {}", quoted(socket));
        assert_eq!(owner(&legacy).0, Owner::Socket(quoted(socket).to_string()));
        let ours = command("/p", SUB, &Build::Profile("acme".into()), socket);
        assert!(same_build(&legacy, &ours, ends));
        let elsewhere = command(
            "/p",
            SUB,
            &Build::Profile("acme".into()),
            Path::new("/tmp/agent-relay-acme-1000/relay.sock"),
        );
        assert!(!same_build(&legacy, &elsewhere, ends));
        assert!(!same_build(&legacy, &format!("/p {SUB}"), ends));
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
