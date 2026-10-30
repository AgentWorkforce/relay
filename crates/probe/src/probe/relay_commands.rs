//! Local relay command-line entry points, shared by the desktop helper.
use crate::{output, user_error};
use agent_relay_probe::relay;
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
        /// The Agent Relay site this build signs in to.
        #[arg(long)]
        site_url: Option<String>,
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
    },
    /// Make a session-scoped request to the local relay socket.
    #[command(hide = true)]
    DevinSpawnMcp {
        #[arg(long)]
        dev: bool,
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
    },
    /// Agent Relay's Devin lifecycle hook, which Devin runs at each session
    /// boundary: drains the session's relay inbox and prints the injection
    /// (`additionalContext`, or `block` when the turn stops).
    DevinHook {
        /// Read Agent Relay Dev's inbox instead of Agent Relay's.
        #[arg(long)]
        dev: bool,
    },
    /// Agent Relay's Cursor CLI hook, which Cursor runs after each tool call
    /// and when a turn ends: hands the session the relay messages waiting
    /// for it (`additional_context`, or `followup_message` at the end).
    CursorHook {
        /// Read Agent Relay Dev's inbox instead of Agent Relay's.
        #[arg(long)]
        dev: bool,
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
    },
}

/// The self-limiting session command `command` is, with the socket it
/// names and its `--body`: what `run` sends for `relay send`, `agents`,
/// `whoami`, `read --socket`, `fetch-attachment` and `connect-send`. `None` for every
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
    // `relay read` prints the message and its note itself.
    if !matches!(command, RelayCommands::Read { .. }) {
        if let Some((socket, session, body)) = session_command(&command) {
            return relay::session_cli::run(socket, &session, body);
        }
    }
    match command {
        RelayCommands::Send { .. }
        | RelayCommands::Agents { .. }
        | RelayCommands::Whoami { .. }
        | RelayCommands::FetchAttachment { .. }
        | RelayCommands::ConnectSend { .. } => Err(user_error(
            "Name exactly one of --to, --address or --channel.",
        )),
        RelayCommands::Serve {
            socket,
            app_data_dir,
            exit_on_stdin_eof,
            site_url,
            headless,
            connect_ephemeral,
            cli_managed,
        } => relay::daemon::serve(relay::daemon::ServeOptions {
            socket,
            app_data_dir,
            exit_on_stdin_eof,
            site_url,
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
        } => relay::harness::devin::host::run(
            &executable,
            &directory,
            &runtime,
            &launch_id,
            full_access,
        ),
        RelayCommands::DevinSpawnMcp { dev } => relay::harness::devin::mcp::run(dev),
        RelayCommands::MuseSpawnMcp { dev } => relay::harness::relay_mcp::run(dev),
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
        } => relay::cli::read_message(socket.as_deref(), dev, &message_ref),
        RelayCommands::CodexStopHook { dev, socket } => {
            relay::cli::codex_stop_hook(socket.as_deref(), dev)
        }
        RelayCommands::DevinHook { dev } => relay::cli::devin_hook(dev),
        RelayCommands::CursorHook { dev } => relay::cli::cursor_hook(dev),
        RelayCommands::ClaudeSessionHook { dev, socket } => {
            relay::cli::claude_session_hook(socket.as_deref(), dev)
        }
        RelayCommands::Settings {
            changes,
            dev,
            socket,
        } => relay::settings_cli::settings(socket.as_deref(), dev, &changes),
        RelayCommands::Subscribe {
            pull,
            remove,
            dev,
            socket,
        } => relay::cli::subscribe(socket.as_deref(), dev, &pull, remove),
        RelayCommands::MuseSpawnHost {
            executable,
            log,
            arguments,
        } => relay::harness::muse::host::run(&executable, &log, &arguments),
    }
}
