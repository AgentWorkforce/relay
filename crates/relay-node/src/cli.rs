//! `agent-relay-node`'s command line: the node's own commands (`serve`,
//! `call`, the session-socket commands and the hooks) and Relay Connect rooms
//! (`connect …`).
mod connect;
mod output;
mod relay_commands;
use relay_commands::RelayCommands;

use crate::relay;
use anyhow::Result;
use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(
    name = "agent-relay-node",
    version = crate::VERSION,
    propagate_version = true,
    about = "Connect coding sessions to Agent Relay"
)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
    #[arg(long, global = true)]
    json: bool,
}
#[derive(Subcommand)]
enum Commands {
    /// Temporary agent-to-agent rooms, without npm or a desktop GUI.
    Connect {
        #[command(subcommand)]
        command: connect::Command,
    },
    #[command(flatten)]
    Node(RelayCommands),
}
#[derive(Debug)]
struct UserError(&'static str);
impl std::fmt::Display for UserError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for UserError {}
fn user_error(message: &'static str) -> anyhow::Error {
    UserError(message).into()
}
/// Dispatch the core's commands and report only explicitly safe user-facing errors.
pub fn main() {
    crate::platform::adopt_profile_home();
    let cli = Cli::parse();
    output::set_json(cli.json);
    if let Err(error) = run(cli) {
        // Provider errors can contain bodies or credentials; never print them.
        if let Some(safe) = error.downcast_ref::<UserError>() {
            eprintln!("{safe}");
        } else if let Some(safe) = error.downcast_ref::<relay::daemon::SafeError>() {
            eprintln!("{safe}");
        } else {
            eprintln!("Agent Relay could not finish. Check your connection and try again. Credentials and message content were not logged.");
        }
        std::process::exit(1);
    }
}

fn run(cli: Cli) -> Result<()> {
    match cli.command {
        Commands::Connect { command } => connect::run(command),
        Commands::Node(command) => relay_commands::run(command),
    }
}

#[cfg(test)]
mod socket_request_tests {
    use super::*;

    // Review on #2019: a reply that starts with a hyphen is still the body.
    #[test]
    fn a_socket_request_body_may_start_with_a_hyphen() {
        for body in ["- first item", "--help", "-"] {
            let cli = Cli::try_parse_from([
                "probe",
                "socket-request",
                "--socket",
                "/s/relay.sock",
                "--method",
                "POST",
                "--path",
                "/send?to=a",
                "--body",
                body,
            ])
            .unwrap();
            let Commands::Node(relay_commands::RelayCommands::SocketRequest {
                body: parsed, ..
            }) = cli.command
            else {
                panic!("socket-request expected")
            };
            assert_eq!(parsed.as_deref(), Some(body));
        }
    }

    // Review on #2019: the read Codex's sandbox rules allow names the
    // socket, and `--dev` cannot point it at another one.
    #[test]
    fn a_read_bound_to_a_socket_refuses_dev() {
        let read = |extra: &[&str]| {
            let mut args = vec!["probe", "read", "--socket", "/s/relay.sock"];
            args.extend_from_slice(extra);
            Cli::try_parse_from(args)
        };
        assert!(read(&["0123456789ab"]).is_ok());
        assert!(read(&["0123456789ab", "--dev"]).is_err());
        assert!(read(&["--dev", "0123456789ab"]).is_err());
    }
}

#[cfg(test)]
mod sandbox_rule_reach_tests {
    use super::*;
    use crate::relay::codex::stop_hook::SandboxRules;
    use crate::relay::outbound::SESSION_ROUTES;
    use clap::{CommandFactory, FromArgMatches};
    use std::path::Path;

    /// The routes each subcommand a Codex rule allows is meant to reach,
    /// and the query keys it may carry.
    fn intended(
        subcommand: &str,
    ) -> (
        &'static [(&'static str, &'static str)],
        &'static [&'static str],
    ) {
        match subcommand {
            "send" => (
                &[("POST", "/send")],
                &["to", "address", "channel", "reply_to", "thread_id"],
            ),
            "agents" => (&[("GET", "/agents")], &[]),
            "whoami" => (&[("GET", "/whoami")], &[]),
            "register" => (&[("POST", "/register")], &[]),
            "read" => (&[("GET", "/messages")], &["ref"]),
            "fetch-attachment" => (&[("POST", "/attachments/fetch")], &["file_id"]),
            "connect-send" => (&[("POST", "/connect/send")], &["to"]),
            "subscribe-channel" => (
                &[
                    ("POST", "/channels/subscribe"),
                    ("DELETE", "/channels/subscribe"),
                ],
                &["channel"],
            ),
            other => panic!("{other} has a Codex rule but no intended route"),
        }
    }

    /// Words a relayed message could get appended after an allowed prefix.
    const WORDS: &[&str] = &[
        "--method",
        "PATCH",
        "POST",
        "DELETE",
        "--path",
        "/settings",
        "/register",
        "/send?to=a&files=x",
        "--body",
        "{\"auto_join_general\":true}",
        "--socket",
        "/tmp/other.sock",
        "--dev",
        "--to",
        "alice",
        "a?x=1",
        "../register",
        "--address",
        "a@m",
        "--channel",
        "c",
        "--thread",
        "1",
        "--reply-to",
        "m1",
        "--",
        "--help",
        "0123456789ab",
        "f1",
        "socket-request",
        "settings",
        "--json",
        "--remove",
        "swarm",
    ];

    #[test]
    fn typed_registration_allows_no_identity_or_raw_request_overrides() {
        let mut command = Cli::command();
        let prefix = ["probe", "register", "--socket", "/s/relay.sock"];
        let args: Vec<String> = prefix
            .into_iter()
            .chain(["--name", "review-bot", "--description", "Reviews releases"])
            .map(str::to_string)
            .collect();
        assert_eq!(
            reach(&mut command, &args),
            Some(("/s/relay.sock".into(), "POST", "/register".into()))
        );
        for mcp in ["none", "agent-relay-sessions"] {
            let args: Vec<String> = prefix
                .into_iter()
                .chain(["--mcp", mcp])
                .map(str::to_string)
                .collect();
            assert_eq!(
                reach(&mut command, &args),
                Some(("/s/relay.sock".into(), "POST", "/register".into()))
            );
        }
        for flag in [
            "--target",
            "--pid",
            "--uid",
            "--session-id",
            "--native-thread-id",
            "--method",
            "--path",
            "--body",
            "--socket",
            "--mcp", // an unknown declaration is refused
        ] {
            let args: Vec<String> = prefix
                .into_iter()
                .chain([flag, "other"])
                .map(str::to_string)
                .collect();
            assert!(reach(&mut command, &args).is_none(), "{flag}");
        }
        let rules = SandboxRules {
            probe: "probe".into(),
            socket: "/s/relay.sock".into(),
        };
        assert!(rules
            .patterns()
            .iter()
            .any(|p| p == &prefix.map(str::to_string)));
        assert!(!rules
            .patterns()
            .iter()
            .any(|p| p.iter().any(|word| word == "socket-request")));
    }

    /// What `argv` would send if it ran: `None` when the probe refuses it
    /// before opening the socket, else the socket, method and path.
    fn reach(
        command: &mut clap::Command,
        argv: &[String],
    ) -> Option<(std::path::PathBuf, &'static str, String)> {
        let matches = command.try_get_matches_from_mut(argv).ok()?;
        let cli = Cli::from_arg_matches(&matches).ok()?;
        let Commands::Node(command) = cli.command else {
            panic!("{argv:?} parsed as another top-level command");
        };
        let (socket, session, body) = relay_commands::session_command(&command)
            .unwrap_or_else(|| panic!("{argv:?} is not a self-limiting session command"));
        if body.is_some() && !session.sends_body() {
            return None;
        }
        let request = session.request().ok()?;
        Some((socket.to_path_buf(), request.method, request.path))
    }

    // The review-proof enumeration: for every route the session socket
    // serves, no argument list after any allowed rule prefix reaches it
    // unless it is that rule's own route, on this core's own socket.
    #[test]
    fn codex_rules_reach_only_their_own_routes() {
        let rules = SandboxRules {
            probe: "/p/agent-relay-node".into(),
            socket: "/s/relay.sock".into(),
        };
        let mut command = Cli::command();
        let mut reached = std::collections::BTreeSet::new();
        let patterns = rules.patterns();
        assert_eq!(
            patterns.len(),
            crate::relay::session_cli::ALLOWED_SUBCOMMANDS.len()
        );
        for pattern in &patterns {
            assert_ne!(pattern[1], "socket-request");
            let (routes, keys) = intended(&pattern[1]);
            let mut suffixes: Vec<Vec<&str>> = vec![vec![]];
            for _ in 0..3 {
                let longer: Vec<Vec<&str>> = suffixes
                    .iter()
                    .filter(|suffix| suffix.len() == suffixes.last().unwrap().len())
                    .flat_map(|suffix| {
                        WORDS.iter().map(move |word| {
                            let mut next = suffix.clone();
                            next.push(word);
                            next
                        })
                    })
                    .collect();
                suffixes.extend(longer);
            }
            // Longer, purposeful attempts at every other route.
            for (other_method, other_route) in SESSION_ROUTES {
                suffixes.push(vec!["--method", other_method, "--path", other_route]);
                suffixes.push(vec![
                    "--to",
                    "a",
                    "--body",
                    "x",
                    "--method",
                    other_method,
                    "--path",
                    other_route,
                ]);
                suffixes.push(vec!["0123456789ab", "--path", other_route]);
                suffixes.push(vec!["--to", other_route, "--body", "x"]);
            }
            let mut ran = 0;
            for suffix in &suffixes {
                let argv: Vec<String> = std::iter::once("agent-relay-node")
                    .chain(pattern[1..].iter().map(String::as_str))
                    .chain(suffix.iter().copied())
                    .map(str::to_string)
                    .collect();
                let Some((socket, sent_method, path)) = reach(&mut command, &argv) else {
                    continue;
                };
                ran += 1;
                assert_eq!(socket, Path::new("/s/relay.sock"), "{argv:?}");
                let sent_route = path.split('?').next().unwrap();
                assert!(
                    routes.contains(&(sent_method, sent_route)),
                    "{argv:?} reached {sent_method} {sent_route}"
                );
                if let Some((_, query)) = path.split_once('?') {
                    for pair in query.split('&') {
                        let key = pair.split('=').next().unwrap();
                        assert!(keys.contains(&key), "{argv:?} sent {path}");
                    }
                }
                reached.insert((sent_method, sent_route.to_string()));
            }
            assert!(ran > 0, "{} never ran", pattern[1]);
        }
        // The desktop core's setup, settings, webhook and attestation routes
        // are listed, and no allowed command reaches them.
        for (method, route) in [
            ("PATCH", "/settings"),
            ("GET", "/settings"),
            ("POST", "/setup/sign-in"),
            ("POST", "/setup/sharing"),
            ("POST", "/setup/auto-activate"),
            ("POST", "/setup/direct-delivery"),
            ("GET", "/setup/status"),
            ("POST", "/webhooks"),
            ("DELETE", "/webhooks"),
            ("POST", "/claude/attestation"),
            ("POST", "/copilot/mcp"),
            ("DELETE", "/register"),
        ] {
            assert!(
                SESSION_ROUTES.contains(&(method, route)),
                "{method} {route}"
            );
            assert!(
                !reached.contains(&(method, route.to_string())),
                "{method} {route}"
            );
        }
        // Each route either is one a rule intends or is never reached.
        for (method, route) in SESSION_ROUTES {
            let allowed = patterns
                .iter()
                .any(|p| intended(&p[1]).0.contains(&(*method, *route)));
            assert_eq!(
                reached.contains(&(*method, route.to_string())),
                allowed,
                "{method} {route}"
            );
        }
    }

    // A repeated `--socket` cannot point an allowed command at another
    // socket, and `read --socket` takes no `--dev`.
    #[test]
    fn an_allowed_command_keeps_the_socket_its_rule_names() {
        for subcommand in crate::relay::session_cli::ALLOWED_SUBCOMMANDS {
            let argv = [
                "agent-relay-node",
                subcommand,
                "--socket",
                "/s/relay.sock",
                "--socket",
                "/tmp/other.sock",
            ];
            assert!(Cli::try_parse_from(argv).is_err(), "{subcommand}");
        }
        assert!(Cli::try_parse_from([
            "agent-relay-node",
            "read",
            "--socket",
            "/s/relay.sock",
            "--dev",
            "0123456789ab"
        ])
        .is_err());
    }
}
