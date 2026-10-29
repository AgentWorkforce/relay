//! Local relay command-line entry points, shared by the desktop helper.
use crate::{output, user_error};
use agent_relay_probe::relay;
use anyhow::Result;
use clap::Subcommand;
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
        #[arg(long)]
        dev: bool,
    },
    /// Make a session-scoped request to the local relay socket.
    SocketRequest {
        #[arg(long)]
        socket: PathBuf,
        #[arg(long)]
        method: String,
        #[arg(long)]
        path: String,
        /// The request body; read from standard input when omitted. One
        /// command, with no pipe, is what Codex's sandbox rules allow.
        #[arg(long)]
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

pub fn run(command: RelayCommands) -> Result<()> {
    match command {
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
        RelayCommands::Read { message_ref, dev } => relay::cli::read_message(dev, &message_ref),
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
