//! Local relay command-line entry points, shared by the desktop helper.
use crate::cli::{output, user_error};
use crate::relay;
use anyhow::Result;
use clap::Subcommand;
use relay::session_cli::{Recipient, SessionCommand};
use std::path::PathBuf;

#[derive(Subcommand)]
pub enum RelayCommands {
    /// Private terminal owner for a spawned Muse runtime.
    #[command(hide = true)]
    MuseSpawnHost {
        #[arg(long)]
        executable: PathBuf,
        #[arg(long)]
        log: PathBuf,
        #[arg(last = true)]
        arguments: Vec<String>,
    },
    /// Private bounded relay-send transport for a spawned Muse session.
    #[command(hide = true)]
    MuseSpawnMcp {
        #[arg(long)]
        dev: bool,
        /// Send through the profile build with this id instead of Agent Relay.
        #[arg(long, conflicts_with = "dev")]
        profile: Option<String>,
    },
    /// Run the core daemon, serving the bridge on a private Unix socket.
    Serve {
        /// The bridge socket; default ~/.agentworkforce/desktop/core.sock
        /// or $AGENT_RELAY_CORE_SOCKET. A relative path lives beside the default.
        #[arg(long)]
        socket: Option<PathBuf>,
        /// The desktop app's data directory (the development app's differs).
        /// A relative name lives beside the default.
        #[arg(long)]
        app_data_dir: Option<PathBuf>,
        /// Stop when stdin closes: the hosting app holds the other end.
        #[arg(long)]
        exit_on_stdin_eof: bool,
        /// Run as the Linux headless service (the systemd user unit).
        #[arg(long)]
        headless: bool,
        /// Stop this temporary core after Connect work becomes idle.
        #[arg(long, requires = "headless")]
        connect_ephemeral: bool,
        /// Run for the relay CLI (`relay init`): leave the desktop app's
        /// login entry alone and turn on no settings by default (no agent-led
        /// or integration defaults). The CLI turns on only what it was asked.
        #[arg(long, requires = "headless", conflicts_with = "connect_ephemeral")]
        cli_managed: bool,
    },
    /// Send one bridge request to the running core and print its result.
    Call {
        method: String,
        /// JSON parameters.
        #[arg(long, default_value = "{}")]
        params: String,
        #[arg(long)]
        socket: Option<PathBuf>,
    },
    /// Make a session-scoped request to the local relay socket.
    #[command(hide = true)]
    DevinSpawnHost {
        #[arg(long)]
        executable: PathBuf,
        #[arg(long)]
        directory: PathBuf,
        #[arg(long)]
        runtime: PathBuf,
        #[arg(long)]
        launch_id: String,
        #[arg(long)]
        full_access: bool,
        /// The profile build that spawned this host; its MCP server sends
        /// through that build's pointer.
        #[arg(long)]
        profile: Option<String>,
    },
    /// Make a session-scoped request to the local relay socket.
    #[command(hide = true)]
    DevinSpawnMcp {
        #[arg(long)]
        dev: bool,
        /// Send through the profile build with this id instead of Agent Relay.
        #[arg(long, conflicts_with = "dev")]
        profile: Option<String>,
    },
    /// Print the relayed message whose pointer names this `REF`.
    Read {
        #[arg(value_name = "REF")]
        message_ref: String,
        /// Ask Agent Relay Dev instead of Agent Relay.
        #[arg(long, conflicts_with = "socket")]
        dev: bool,
        /// The session socket to ask; default is the one the running app
        /// points to. The pointer a session is handed names it, which is
        /// what Codex's sandbox rules allow.
        #[arg(long)]
        socket: Option<PathBuf>,
        /// Ask the profile build with this id (the part of its bundle id
        /// after com.agentrelay.desktop.) instead of Agent Relay.
        #[arg(long, conflicts_with_all = ["socket", "dev"])]
        profile: Option<String>,
    },
    /// Send a message as the calling session: `POST /send` to one agent
    /// (`--to`), address (`--address`) or channel (`--channel`), optionally
    /// replying beneath a message (`--reply-to`) or in a channel post's
    /// thread (`--thread`). It makes no other request.
    #[command(group(
        clap::ArgGroup::new("recipient")
            .required(true)
            .args(["to", "address", "channel"])
    ))]
    Send {
        /// The session socket, as the hint names it.
        #[arg(long)]
        socket: PathBuf,
        /// An agent's name.
        #[arg(long)]
        to: Option<String>,
        /// An exact agent@machine address.
        #[arg(long)]
        address: Option<String>,
        /// A channel to post in.
        #[arg(long)]
        channel: Option<String>,
        /// The id of the message this answers.
        #[arg(long, conflicts_with = "channel")]
        reply_to: Option<String>,
        /// The channel thread this answers in.
        #[arg(long, requires = "channel")]
        thread: Option<String>,
        /// The message; read from standard input when omitted. It may start
        /// with a hyphen (`- first item`).
        #[arg(long, allow_hyphen_values = true)]
        body: Option<String>,
    },
    /// List the agents the calling session can message (`GET /agents`).
    Agents {
        /// The session socket, as the hint names it.
        #[arg(long)]
        socket: PathBuf,
    },
    /// Print the calling session's own name and address on the relay
    /// (`GET /whoami`).
    Whoami {
        /// The session socket, as the hint names it.
        #[arg(long)]
        socket: PathBuf,
    },
    /// Put only the calling native session on the relay (`POST /register`).
    /// The core identifies it from this process; its self-registration
    /// setting and ownership checks still apply.
    Register {
        /// The session socket, as the hint names it.
        #[arg(long)]
        socket: PathBuf,
        /// Optional relay name; otherwise use the session's suggested name.
        #[arg(long)]
        name: Option<String>,
        /// Optional description (at most 4096 bytes).
        #[arg(long)]
        description: Option<String>,
        /// Hosted MCP availability, without changing the session identity.
        #[arg(long, value_parser = ["agent-relay-sessions", "none"])]
        mcp: Option<String>,
    },
    /// Fetch an attachment the calling session was sent but did not get in
    /// time (`POST /attachments/fetch`).
    FetchAttachment {
        #[arg(value_name = "FILE_ID")]
        file_id: String,
        /// The session socket, as the hint names it.
        #[arg(long)]
        socket: PathBuf,
    },
    /// Send to the Relay Connect room the calling session joined
    /// (`POST /connect/send`): to one participant (`--to`), or everyone.
    ConnectSend {
        /// The session socket, as the hint names it.
        #[arg(long)]
        socket: PathBuf,
        /// One participant's name; everyone when omitted.
        #[arg(long)]
        to: Option<String>,
        /// The message; read from standard input when omitted.
        #[arg(long, allow_hyphen_values = true)]
        body: Option<String>,
    },
    /// Join one channel as the calling session, so its posts are delivered
    /// (`POST /channels/subscribe`), or leave it with `--remove`. With
    /// `--create` a channel that does not exist yet is created and joined
    /// (`POST /channels`); an existing one is joined.
    SubscribeChannel {
        #[arg(value_name = "CHANNEL")]
        channel: String,
        /// Leave the channel instead.
        #[arg(long)]
        remove: bool,
        /// Create the channel when it does not exist, then join it.
        #[arg(long, conflicts_with = "remove")]
        create: bool,
        /// The new channel's topic (with --create). It may start with a
        /// hyphen (`- weekly goals`).
        #[arg(long, requires = "create", allow_hyphen_values = true)]
        topic: Option<String>,
        /// The session socket, as the hint names it.
        #[arg(long)]
        socket: PathBuf,
    },
    /// Create the calling session's own inbound webhook (`POST /webhooks`),
    /// or delete it with `--revoke` (`DELETE /webhooks`). Anything posted to
    /// the printed URL with the printed secret is delivered to this session
    /// and wakes it when idle. The secret is shown only when the webhook is
    /// created; revoke and create again for a new one.
    Webhook {
        /// Delete the session's webhook instead.
        #[arg(long)]
        revoke: bool,
        /// The session socket, as the hint names it.
        #[arg(long)]
        socket: PathBuf,
    },
    /// Make any documented session-scoped request to the local relay
    /// socket, for people and debugging. No sandbox or permission rule
    /// allows it; sessions are handed the commands above.
    SocketRequest {
        #[arg(long)]
        socket: PathBuf,
        #[arg(long)]
        method: String,
        #[arg(long)]
        path: String,
        /// The request body; read from standard input when omitted. It may
        /// start with a hyphen (`- first item`).
        #[arg(long, allow_hyphen_values = true)]
        body: Option<String>,
    },
    /// Agent Relay's Codex hook, which Codex runs after each tool call and
    /// as a turn ends: hands the running turn the relayed messages waiting
    /// for it.
    CodexStopHook {
        /// Ask Agent Relay Dev instead of Agent Relay.
        #[arg(long, conflicts_with = "socket")]
        dev: bool,
        /// The session socket; default is the one the running app points to.
        #[arg(long)]
        socket: Option<PathBuf>,
        /// Ask the profile build with this id (the part of its bundle id
        /// after com.agentrelay.desktop.) instead of Agent Relay. A profile
        /// build's hook names both, `--profile=<id> --socket <socket>`: the
        /// id is the hook's owner (`hook_owner`) and the socket is asked.
        #[arg(long, conflicts_with = "dev")]
        profile: Option<String>,
    },
    /// Agent Relay's Devin lifecycle hook, which Devin runs at each session
    /// boundary: drains the session's relay inbox and prints the injection
    /// (`additionalContext`, or `block` when the turn stops).
    DevinHook {
        /// Read Agent Relay Dev's inbox instead of Agent Relay's.
        #[arg(long)]
        dev: bool,
    },
    /// Copilot's native lifecycle hook, installed by Agent Relay setup.
    CopilotHook {
        #[arg(long)]
        dev: bool,
        #[arg(long, value_parser = ["start", "before", "tool", "stop"])]
        event: String,
    },
    /// Agent Relay's Cursor CLI hook, which Cursor runs after each tool call,
    /// when a turn ends and before a prompt starts one: hands the session
    /// the relay messages waiting for it (`additional_context`, or
    /// `followup_message` at the end).
    CursorHook {
        /// Read Agent Relay Dev's inbox instead of Agent Relay's.
        #[arg(long)]
        dev: bool,
        /// At the end of a Cursor editor conversation's or CLI session's
        /// completed turn, wait for its next message instead of answering at
        /// once.
        #[arg(long)]
        wait: bool,
    },
    /// Agent Relay's Claude Code SessionStart hook. When this session is not
    /// on the relay, tells Claude to ask the person whether to put it on the
    /// relay and to register only if they say yes. Never registers it itself.
    ClaudeSessionHook {
        /// Ask Agent Relay Dev instead of Agent Relay.
        #[arg(long, conflicts_with = "socket")]
        dev: bool,
        /// The session socket; default is the one the running app points to.
        #[arg(long)]
        socket: Option<PathBuf>,
        /// Ask the profile build with this id (the part of its bundle id
        /// after com.agentrelay.desktop.) instead of Agent Relay. A profile
        /// build's hook names both, `--profile=<id> --socket <socket>`: the
        /// id is the hook's owner (`hook_owner`) and the socket is asked.
        #[arg(long, conflicts_with = "dev")]
        profile: Option<String>,
    },
    /// Print Agent Relay's settings, as the app's Settings shows them, or
    /// change them with KEY=VALUE pairs (`auto_join_general=true`). Every
    /// change is recorded with this session's name and listed in Settings.
    Settings {
        /// Settings to change, as KEY=VALUE; none prints them all.
        #[arg(value_name = "KEY=VALUE")]
        changes: Vec<String>,
        /// Ask Agent Relay Dev instead of Agent Relay.
        #[arg(long, conflicts_with = "socket")]
        dev: bool,
        /// The session socket; default is the one the running app points to.
        #[arg(long)]
        socket: Option<PathBuf>,
        /// Ask the profile build with this id (the part of its bundle id
        /// after com.agentrelay.desktop.) instead of Agent Relay.
        #[arg(long, conflicts_with_all = ["socket", "dev"])]
        profile: Option<String>,
    },
    /// Subscribe the calling Codex or Claude session to one GitHub pull
    /// request: its reviews, comments and checks arrive as messages.
    Subscribe {
        /// owner/repo#123 or https://github.com/owner/repo/pull/123
        pull: String,
        /// Remove the subscription instead.
        #[arg(long)]
        remove: bool,
        /// Subscribe through Agent Relay Dev instead of Agent Relay.
        #[arg(long, conflicts_with = "socket")]
        dev: bool,
        /// The session socket; default is the one the running app points to.
        #[arg(long)]
        socket: Option<PathBuf>,
        /// Ask the profile build with this id (the part of its bundle id
        /// after com.agentrelay.desktop.) instead of Agent Relay.
        #[arg(long, conflicts_with_all = ["socket", "dev"])]
        profile: Option<String>,
    },
}

/// The self-limiting session command `command` is, with the socket it
/// names and its `--body`: what `run` sends for `send`, `agents`,
/// `whoami`, `register`, `read --socket`, `fetch-attachment`, `connect-send` and
/// `subscribe-channel`. `None` for every
/// other command.
pub fn session_command(
    command: &RelayCommands,
) -> Option<(&std::path::Path, SessionCommand, Option<&str>)> {
    Some(match command {
        RelayCommands::Send {
            socket,
            to,
            address,
            channel,
            reply_to,
            thread,
            body,
        } => {
            let recipient = match (to, address, channel) {
                (Some(to), None, None) => Recipient::To(to.clone()),
                (None, Some(address), None) => Recipient::Address(address.clone()),
                (None, None, Some(channel)) => Recipient::Channel(channel.clone()),
                _ => return None,
            };
            (
                socket.as_path(),
                SessionCommand::Send {
                    recipient,
                    reply_to: reply_to.clone(),
                    thread: thread.clone(),
                },
                body.as_deref(),
            )
        }
        RelayCommands::Agents { socket } => (socket.as_path(), SessionCommand::Agents, None),
        RelayCommands::Whoami { socket } => (socket.as_path(), SessionCommand::Whoami, None),
        RelayCommands::Webhook { socket, revoke } => (
            socket.as_path(),
            SessionCommand::Webhook { revoke: *revoke },
            None,
        ),
        RelayCommands::Register {
            socket,
            name,
            description,
            mcp,
        } => (
            socket.as_path(),
            SessionCommand::Register {
                name: name.clone(),
                description: description.clone(),
                mcp: mcp.clone(),
            },
            None,
        ),
        RelayCommands::SubscribeChannel {
            socket,
            channel,
            remove,
            create,
            topic,
        } => (
            socket.as_path(),
            if *create {
                SessionCommand::CreateChannel {
                    channel: channel.clone(),
                    topic: topic.clone(),
                }
            } else {
                SessionCommand::SubscribeChannel {
                    channel: channel.clone(),
                    remove: *remove,
                }
            },
            None,
        ),
        RelayCommands::FetchAttachment { socket, file_id } => (
            socket.as_path(),
            SessionCommand::FetchAttachment {
                file_id: file_id.clone(),
            },
            None,
        ),
        RelayCommands::ConnectSend { socket, to, body } => (
            socket.as_path(),
            SessionCommand::ConnectSend { to: to.clone() },
            body.as_deref(),
        ),
        RelayCommands::Read {
            socket: Some(socket),
            message_ref,
            ..
        } => (
            socket.as_path(),
            SessionCommand::Read {
                message_ref: message_ref.clone(),
            },
            None,
        ),
        _ => return None,
    })
}

pub fn run(command: RelayCommands) -> Result<()> {
    // `read` prints the message and its note itself.
    if !matches!(command, RelayCommands::Read { .. }) {
        if let Some((socket, session, body)) = session_command(&command) {
            return relay::session_cli::run(socket, &session, body);
        }
    }
    match command {
        RelayCommands::Send { .. }
        | RelayCommands::Agents { .. }
        | RelayCommands::Whoami { .. }
        | RelayCommands::Webhook { .. }
        | RelayCommands::Register { .. }
        | RelayCommands::SubscribeChannel { .. }
        | RelayCommands::FetchAttachment { .. }
        | RelayCommands::ConnectSend { .. } => Err(user_error(
            "Name exactly one of --to, --address or --channel.",
        )),
        RelayCommands::Serve {
            socket,
            app_data_dir,
            exit_on_stdin_eof,
            headless,
            connect_ephemeral,
            cli_managed,
        } => relay::daemon::serve(relay::daemon::ServeOptions {
            socket,
            app_data_dir,
            exit_on_stdin_eof,
            headless,
            connect_ephemeral,
            cli_managed,
        }),
        RelayCommands::Call {
            method,
            params,
            socket,
        } => {
            let params: serde_json::Value =
                serde_json::from_str(&params).map_err(|_| user_error("--params must be JSON."))?;
            let result = relay::cli::call(
                socket.as_deref(),
                &method,
                params,
                std::time::Duration::from_secs(60),
            )?;
            output::emit(serde_json::json!({ "result": result }));
            Ok(())
        }
        RelayCommands::DevinSpawnHost {
            executable,
            directory,
            runtime,
            launch_id,
            full_access,
            profile,
        } => {
            // Which build spawned this host: its `--profile`, else Dev's
            // runtime folder, else Agent Relay.
            let development = profile.is_none() && runtime.ends_with("spawned-dev");
            relay::harness::devin::host::run(
                &executable,
                &directory,
                &runtime,
                &launch_id,
                full_access,
                &build(development, profile)?,
            )
        }
        RelayCommands::DevinSpawnMcp { dev, profile } => {
            relay::harness::devin::mcp::run(&build(dev, profile)?)
        }
        RelayCommands::MuseSpawnMcp { dev, profile } => {
            relay::harness::relay_mcp::run(&build(dev, profile)?)
        }
        RelayCommands::SocketRequest {
            socket,
            method,
            path,
            body,
        } => relay::cli::socket_request(&socket, &method, &path, body.as_deref()),
        RelayCommands::Read {
            message_ref,
            dev,
            socket,
            profile,
        } => relay::cli::read_message(socket.as_deref(), &build(dev, profile)?, &message_ref),
        RelayCommands::CodexStopHook {
            dev,
            socket,
            profile,
        } => relay::cli::codex_stop_hook(socket.as_deref(), &build(dev, profile)?),
        RelayCommands::DevinHook { dev } => relay::cli::devin_hook(dev),
        RelayCommands::CopilotHook { dev, event } => relay::cli::copilot_hook(dev, &event),
        RelayCommands::CursorHook { dev, wait } => relay::cli::cursor_hook(dev, wait),
        RelayCommands::ClaudeSessionHook {
            dev,
            socket,
            profile,
        } => relay::cli::claude_session_hook(socket.as_deref(), &build(dev, profile)?),
        RelayCommands::Settings {
            changes,
            dev,
            socket,
            profile,
        } => relay::settings_cli::settings(socket.as_deref(), &build(dev, profile)?, &changes),
        RelayCommands::Subscribe {
            pull,
            remove,
            dev,
            socket,
            profile,
        } => relay::cli::subscribe(socket.as_deref(), &build(dev, profile)?, &pull, remove),
        RelayCommands::MuseSpawnHost {
            executable,
            log,
            arguments,
        } => relay::harness::muse::host::run(&executable, &log, &arguments),
    }
}

/// The build a command's `--dev` and `--profile` name.
fn build(development: bool, profile: Option<String>) -> Result<relay::outbound::Build> {
    relay::outbound::Build::named(development, profile.as_deref()).map_err(user_error)
}

#[cfg(test)]
mod tests {
    use super::RelayCommands;
    use clap::Parser;

    #[derive(Parser)]
    struct Cli {
        #[command(subcommand)]
        command: RelayCommands,
    }

    #[test]
    fn a_topic_starting_with_a_hyphen_is_a_value_not_a_flag() {
        let cli = Cli::try_parse_from([
            "relay",
            "subscribe-channel",
            "planning",
            "--create",
            "--topic",
            "- weekly goals",
            "--socket",
            "/tmp/session.sock",
        ])
        .expect("a topic may start with a hyphen");
        match cli.command {
            RelayCommands::SubscribeChannel { topic, create, .. } => {
                assert!(create);
                assert_eq!(topic.as_deref(), Some("- weekly goals"));
            }
            _ => panic!("subscribe-channel"),
        }
    }
}
