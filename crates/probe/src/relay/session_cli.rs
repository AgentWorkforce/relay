//! The probe's self-limiting session-socket commands: `relay send`,
//! `relay agents`, `relay whoami`, `relay read`, `relay fetch-attachment`
//! and `relay connect-send`.
//!
//! Codex's execpolicy rules match a command by its leading words only, so
//! a rule for `relay socket-request --socket <sock>` let anything after the
//! socket through: a relayed (untrusted) message could steer Codex into
//! `--method PATCH --path /settings` with no prompt. Each command here fixes
//! its method and route itself and takes only the arguments that route
//! needs, every one of them validated and percent-encoded into the query,
//! so a rule that allows the command's leading words reaches that one route
//! and nothing else (`codex::stop_hook::SandboxRules`). The hints Agent
//! Relay hands a session name these commands (`outbound::reply_hint` and
//! the rest), and `relay socket-request` stays, without a rule, for people
//! and debugging.

use crate::relay::daemon::SafeError;
use crate::relay::outbound::{query_encode, shell_quote};
use anyhow::Result;
use std::path::Path;

/// Who a `relay send` goes to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Recipient {
    /// An agent by name (`--to`).
    To(String),
    /// An exact `agent@machine` address (`--address`).
    Address(String),
    /// A channel (`--channel`), optionally a thread in it.
    Channel(String),
}

/// One self-limiting session-socket command, as its arguments were given.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SessionCommand {
    /// `relay send`: `POST /send` to one recipient, optionally replying
    /// beneath a message (`--reply-to`) or in a channel thread (`--thread`).
    Send {
        recipient: Recipient,
        reply_to: Option<String>,
        thread: Option<String>,
    },
    /// `relay agents`: `GET /agents`.
    Agents,
    /// `relay whoami`: `GET /whoami`.
    Whoami,
    /// `relay read <ref>`: `GET /messages?ref=<ref>`.
    Read { message_ref: String },
    /// `relay fetch-attachment <file-id>`: `POST /attachments/fetch`.
    FetchAttachment { file_id: String },
    /// `relay connect-send [--to <name>]`: `POST /connect/send`.
    ConnectSend { to: Option<String> },
}

/// The one request a [`SessionCommand`] makes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionRequest {
    pub method: &'static str,
    /// The route and its query, every value percent-encoded.
    pub path: String,
}

impl SessionRequest {
    /// The route without its query.
    pub fn route(&self) -> &str {
        self.path.split('?').next().unwrap_or(&self.path)
    }
}

/// The subcommands Codex's sandbox rules allow (`SandboxRules`), each only
/// on this core's own session socket.
pub const ALLOWED_SUBCOMMANDS: [&str; 6] = [
    "send",
    "agents",
    "whoami",
    "read",
    "fetch-attachment",
    "connect-send",
];

/// The longest name, address, channel or id accepted.
const MAX_FIELD: usize = 200;

fn refuse(message: &str) -> anyhow::Error {
    SafeError(message.to_string()).into()
}

/// A name or the machine part of an address: one word with nothing that
/// means something in a URL path or query. Every value is percent-encoded
/// anyway; this refuses early what no relay name holds.
fn plain_word(value: &str) -> bool {
    !value.is_empty()
        && value.chars().count() <= MAX_FIELD
        && !value
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || "/?#&=%\\@\"'`".contains(c))
}

/// An agent name as `--to` takes it: `alice` or `@alice`.
fn valid_name(value: &str) -> bool {
    plain_word(value.strip_prefix('@').unwrap_or(value))
}

/// `agent@machine`, as `links::Endpoint::parse` reads one: an `@` neither
/// first nor last. Relaycast addresses may hold more than one
/// (`x@ops@new-desk`); every part between them is a plain word.
fn valid_address(value: &str) -> bool {
    value.contains('@') && value.chars().count() <= MAX_FIELD && value.split('@').all(plain_word)
}

/// A channel as a session writes it: `swarm` or `#swarm`.
fn valid_channel(value: &str) -> bool {
    plain_word(value.strip_prefix('#').unwrap_or(value))
}

impl SessionCommand {
    /// The subcommand's name.
    pub fn name(&self) -> &'static str {
        match self {
            SessionCommand::Send { .. } => "send",
            SessionCommand::Agents => "agents",
            SessionCommand::Whoami => "whoami",
            SessionCommand::Read { .. } => "read",
            SessionCommand::FetchAttachment { .. } => "fetch-attachment",
            SessionCommand::ConnectSend { .. } => "connect-send",
        }
    }

    /// Whether the command sends a body (`--body`, else standard input).
    pub fn sends_body(&self) -> bool {
        matches!(
            self,
            SessionCommand::Send { .. } | SessionCommand::ConnectSend { .. }
        )
    }

    /// The request this command makes, once its arguments are checked. The
    /// method and route are fixed by the command; only checked values reach
    /// the query.
    pub fn request(&self) -> Result<SessionRequest> {
        match self {
            SessionCommand::Send {
                recipient,
                reply_to,
                thread,
            } => {
                let mut query = match recipient {
                    Recipient::To(name) if valid_name(name) => format!("to={}", query_encode(name)),
                    Recipient::To(_) => {
                        return Err(refuse(
                            "--to takes one agent name, with no spaces or URL characters.",
                        ))
                    }
                    Recipient::Address(address) if valid_address(address) => {
                        format!("address={}", query_encode(address))
                    }
                    Recipient::Address(_) => {
                        return Err(refuse("--address takes one agent@machine address."))
                    }
                    Recipient::Channel(channel) if valid_channel(channel) => {
                        format!("channel={}", query_encode(channel))
                    }
                    Recipient::Channel(_) => {
                        return Err(refuse("--channel takes one channel name, with no spaces."))
                    }
                };
                let channel = matches!(recipient, Recipient::Channel(_));
                if let Some(parent) = reply_to {
                    if channel {
                        return Err(refuse("A channel post takes --thread, not --reply-to."));
                    }
                    if !crate::relay::delivery::policy::is_plain_id(parent) {
                        return Err(refuse("--reply-to takes the id of the message to answer."));
                    }
                    query.push_str(&format!("&reply_to={}", query_encode(parent)));
                }
                if let Some(thread) = thread {
                    if !channel {
                        return Err(refuse("--thread needs --channel."));
                    }
                    if !crate::relay::delivery::policy::is_plain_id(thread) {
                        return Err(refuse("--thread takes the id of the thread to answer in."));
                    }
                    query.push_str(&format!("&thread_id={}", query_encode(thread)));
                }
                Ok(SessionRequest {
                    method: "POST",
                    path: format!("/send?{query}"),
                })
            }
            SessionCommand::Agents => Ok(SessionRequest {
                method: "GET",
                path: "/agents".into(),
            }),
            SessionCommand::Whoami => Ok(SessionRequest {
                method: "GET",
                path: "/whoami".into(),
            }),
            SessionCommand::Read { message_ref } => {
                if message_ref.len() != 12 || !message_ref.bytes().all(|b| b.is_ascii_hexdigit()) {
                    return Err(refuse(
                        "Name the message by the 12-character ref on its first line.",
                    ));
                }
                Ok(SessionRequest {
                    method: "GET",
                    path: format!("/messages?ref={message_ref}"),
                })
            }
            SessionCommand::FetchAttachment { file_id } => {
                if !crate::relay::delivery::policy::is_plain_id(file_id) {
                    return Err(refuse("Name the file by the id its message gave."));
                }
                Ok(SessionRequest {
                    method: "POST",
                    path: format!("/attachments/fetch?file_id={}", query_encode(file_id)),
                })
            }
            SessionCommand::ConnectSend { to } => match to {
                None => Ok(SessionRequest {
                    method: "POST",
                    path: "/connect/send".into(),
                }),
                Some(name) if valid_name(name) => Ok(SessionRequest {
                    method: "POST",
                    path: format!("/connect/send?to={}", query_encode(name)),
                }),
                Some(_) => Err(refuse(
                    "--to takes one participant name, with no spaces or URL characters.",
                )),
            },
        }
    }

    /// The arguments after `--socket <socket>`, as this command is typed.
    fn arguments(&self) -> Vec<&str> {
        match self {
            SessionCommand::Send {
                recipient,
                reply_to,
                thread,
            } => {
                let mut parts = match recipient {
                    Recipient::To(name) => vec!["--to", name.as_str()],
                    Recipient::Address(address) => vec!["--address", address.as_str()],
                    Recipient::Channel(channel) => vec!["--channel", channel.as_str()],
                };
                if let Some(parent) = reply_to {
                    parts.extend(["--reply-to", parent.as_str()]);
                }
                if let Some(thread) = thread {
                    parts.extend(["--thread", thread.as_str()]);
                }
                parts
            }
            SessionCommand::Agents | SessionCommand::Whoami => Vec::new(),
            SessionCommand::Read { message_ref } => vec![message_ref.as_str()],
            SessionCommand::FetchAttachment { file_id } => vec![file_id.as_str()],
            SessionCommand::ConnectSend { to } => match to {
                Some(name) => vec!["--to", name.as_str()],
                None => Vec::new(),
            },
        }
    }

    /// The shell command a hint hands a session: `executable relay <name>
    /// --socket <socket> …`, every word shell-quoted, with `--body` last
    /// when there is one. `None` when an argument would be refused (a name
    /// from a peer with a newline in it never reaches the hint).
    pub fn command_line(
        &self,
        executable: &Path,
        socket: &Path,
        body: Option<&str>,
    ) -> Option<String> {
        self.request().ok()?;
        let mut parts = vec![
            executable.to_str()?,
            "relay",
            self.name(),
            "--socket",
            socket.to_str()?,
        ];
        parts.extend(self.arguments());
        if let Some(body) = body.filter(|_| self.sends_body()) {
            parts.extend(["--body", body]);
        }
        Some(
            parts
                .iter()
                .map(|part| shell_quote(part))
                .collect::<Vec<_>>()
                .join(" "),
        )
    }
}

/// Runs `command` against `socket`: its one request, with `body` (or, for
/// a command that sends one, standard input) as the request body, printing
/// the socket's answer.
pub fn run(socket: &Path, command: &SessionCommand, body: Option<&str>) -> Result<()> {
    let request = command.request()?;
    let body = match body {
        Some(_) if !command.sends_body() => {
            return Err(refuse("This command takes no --body."));
        }
        Some(body) => body.as_bytes().to_vec(),
        None if command.sends_body() => {
            use std::io::Read;
            let mut body = Vec::new();
            std::io::stdin().read_to_end(&mut body)?;
            body
        }
        None => Vec::new(),
    };
    let timeout = match command {
        SessionCommand::FetchAttachment { .. } => {
            crate::relay::files::FETCH_TIMEOUT.saturating_add(std::time::Duration::from_secs(10))
        }
        _ => crate::relay::cli::SOCKET_TIMEOUT,
    };
    crate::relay::cli::socket_exchange(socket, request.method, &request.path, &body, timeout)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn send(recipient: Recipient) -> SessionCommand {
        SessionCommand::Send {
            recipient,
            reply_to: None,
            thread: None,
        }
    }

    #[test]
    fn each_command_makes_only_its_own_route() {
        let cases = [
            (
                send(Recipient::To("alice".into())),
                "POST",
                "/send?to=alice",
            ),
            (
                send(Recipient::To("@alice".into())),
                "POST",
                "/send?to=@alice",
            ),
            (
                send(Recipient::Address("alice@mac-1".into())),
                "POST",
                "/send?address=alice@mac-1",
            ),
            // Review on #2031: Relaycast addresses may hold more than one `@`.
            (
                send(Recipient::Address("x@ops@new-desk".into())),
                "POST",
                "/send?address=x@ops@new-desk",
            ),
            (
                SessionCommand::Send {
                    recipient: Recipient::To("alice".into()),
                    reply_to: Some("m1".into()),
                    thread: None,
                },
                "POST",
                "/send?to=alice&reply_to=m1",
            ),
            (
                SessionCommand::Send {
                    recipient: Recipient::Channel("#swarm".into()),
                    reply_to: None,
                    thread: Some("123".into()),
                },
                "POST",
                "/send?channel=%23swarm&thread_id=123",
            ),
            (SessionCommand::Agents, "GET", "/agents"),
            (SessionCommand::Whoami, "GET", "/whoami"),
            (
                SessionCommand::Read {
                    message_ref: "0123456789ab".into(),
                },
                "GET",
                "/messages?ref=0123456789ab",
            ),
            (
                SessionCommand::FetchAttachment {
                    file_id: "file_1".into(),
                },
                "POST",
                "/attachments/fetch?file_id=file_1",
            ),
            (
                SessionCommand::ConnectSend { to: None },
                "POST",
                "/connect/send",
            ),
            (
                SessionCommand::ConnectSend {
                    to: Some("host".into()),
                },
                "POST",
                "/connect/send?to=host",
            ),
        ];
        for (command, method, path) in cases {
            let request = command.request().unwrap();
            assert_eq!((request.method, request.path.as_str()), (method, path));
        }
    }

    // No value can add a query parameter, change the route or reach
    // another one.
    #[test]
    fn values_cannot_inject_a_path_or_query() {
        for bad in [
            "",
            "a b",
            "a\nb",
            "a?x=1",
            "a&reply_to=m",
            "a#b",
            "a=b",
            "../register",
            "/settings",
            "a%26b",
            "a\\b",
            "a@b",
            "a\"b",
        ] {
            assert!(
                send(Recipient::To(bad.into())).request().is_err(),
                "to {bad:?}"
            );
            assert!(
                SessionCommand::ConnectSend {
                    to: Some(bad.into())
                }
                .request()
                .is_err(),
                "connect {bad:?}"
            );
        }
        for bad in [
            "alice", "@m", "a@", "a@@b", "a@b?x=1", "a@b&to=c", "a b@m", "a@m/x",
        ] {
            assert!(
                send(Recipient::Address(bad.into())).request().is_err(),
                "address {bad:?}"
            );
        }
        for bad in ["", "a b", "a?b", "a&b", "a/b"] {
            assert!(
                send(Recipient::Channel(bad.into())).request().is_err(),
                "channel {bad:?}"
            );
        }
        for bad in ["", "m 1", "m&x=1", "../m", "m/1", "m?1"] {
            let reply = SessionCommand::Send {
                recipient: Recipient::To("alice".into()),
                reply_to: Some(bad.into()),
                thread: None,
            };
            assert!(reply.request().is_err(), "reply_to {bad:?}");
            let thread = SessionCommand::Send {
                recipient: Recipient::Channel("swarm".into()),
                reply_to: None,
                thread: Some(bad.into()),
            };
            assert!(thread.request().is_err(), "thread {bad:?}");
            let fetch = SessionCommand::FetchAttachment {
                file_id: bad.into(),
            };
            assert!(fetch.request().is_err(), "file_id {bad:?}");
        }
        // A reply beneath a channel post goes in its thread; a thread needs
        // a channel.
        let channel_reply = SessionCommand::Send {
            recipient: Recipient::Channel("swarm".into()),
            reply_to: Some("m1".into()),
            thread: None,
        };
        assert!(channel_reply.request().is_err());
        let dm_thread = SessionCommand::Send {
            recipient: Recipient::To("alice".into()),
            reply_to: None,
            thread: Some("1".into()),
        };
        assert!(dm_thread.request().is_err());
        for bad in [
            "../etc/passwd",
            "0123456789a",
            "0123456789abc",
            "0123456789az",
        ] {
            assert!(SessionCommand::Read {
                message_ref: bad.into()
            }
            .request()
            .is_err());
        }
    }

    #[test]
    fn a_command_line_names_its_subcommand_on_the_socket_then_its_body() {
        let line = SessionCommand::Send {
            recipient: Recipient::To("alice".into()),
            reply_to: Some("m1".into()),
            thread: None,
        }
        .command_line(
            Path::new("/opt/relay/probe"),
            Path::new("/Users/me/Library/Application Support/x/relay.sock"),
            Some("your reply"),
        )
        .unwrap();
        assert_eq!(
            line,
            "/opt/relay/probe relay send --socket '/Users/me/Library/Application Support/x/relay.sock' \
             --to alice --reply-to m1 --body 'your reply'"
        );
        let agents = SessionCommand::Agents
            .command_line(Path::new("/p"), Path::new("/s.sock"), Some("ignored"))
            .unwrap();
        assert_eq!(agents, "/p relay agents --socket /s.sock");
    }

    #[test]
    fn a_command_that_takes_no_body_refuses_one() {
        let error = run(Path::new("/unused"), &SessionCommand::Agents, Some("x")).unwrap_err();
        assert!(error.to_string().contains("takes no --body"));
        let error = run(
            Path::new("/unused"),
            &send(Recipient::To("a b".into())),
            Some("x"),
        )
        .unwrap_err();
        assert!(error.to_string().contains("--to takes"));
    }
}
