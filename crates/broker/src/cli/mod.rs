use std::path::PathBuf;

use anyhow::Result;
use clap::{Parser, Subcommand, ValueEnum};
use relay_broker::{
    protocol::HeadlessProvider as ProtocolHeadlessProvider,
    telemetry::{TelemetryClient, TelemetryEvent},
};

use crate::{cli_mcp_args, pty_worker, runtime, swarm, wrap};

#[derive(Debug, Parser)]
#[command(name = "agent-relay-broker")]
#[command(about = "Agent relay broker and worker runtime")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Debug, Subcommand)]
enum Commands {
    Init(InitCommand),
    Pty(PtyCommand),
    Headless(HeadlessCommand),
    /// Compute MCP injection args and side-effect config file paths for a CLI
    /// without spawning it. Outputs JSON to stdout.
    McpArgs(McpArgsCommand),
    /// Run ad-hoc swarm execution via the relay broker
    Swarm(swarm::SwarmArgs),
    /// Capture the current visible PTY screen of a running worker and print
    /// it. Talks to the broker over its listen API.
    DumpPty(DumpPtyCommand),
    /// Internal: wraps a CLI in a PTY with interactive passthrough.
    /// Used by the SDK — not for direct user invocation.
    /// Usage: agent-relay-broker wrap codex -- --full-auto
    #[command(hide = true)]
    Wrap {
        /// The CLI to wrap (e.g. "codex", "claude")
        cli: String,
        /// Additional arguments passed to the wrapped CLI
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<String>,
    },
}

impl Commands {
    fn telemetry_name(&self) -> &'static str {
        match self {
            Commands::Init(_) => "init",
            Commands::Pty(_) => "pty",
            Commands::Headless(_) => "headless",
            Commands::McpArgs(_) => "mcp_args",
            Commands::Swarm(_) => "swarm",
            Commands::DumpPty(_) => "dump_pty",
            Commands::Wrap { .. } => "wrap",
        }
    }
}

pub(crate) async fn run() -> Result<()> {
    runtime::init_tracing();

    let cli = Cli::parse();
    let telemetry = TelemetryClient::new();
    telemetry.track(TelemetryEvent::CliCommandRun {
        command_name: cli.command.telemetry_name().to_string(),
    });

    match cli.command {
        Commands::Init(cmd) => runtime::run_init(cmd, telemetry).await,
        Commands::Pty(cmd) => pty_worker::run_pty_worker(cmd).await,
        Commands::Headless(cmd) => runtime::run_headless_worker(cmd).await,
        Commands::McpArgs(cmd) => cli_mcp_args::run_mcp_args(cmd).await,
        Commands::Swarm(args) => swarm::run_swarm(args).await,
        Commands::DumpPty(cmd) => runtime::run_dump_pty(cmd).await,
        Commands::Wrap { cli, args } => wrap::run_wrap(cli, args, false, telemetry).await,
    }
}

#[derive(Debug, clap::Args, Clone)]
pub(crate) struct DumpPtyCommand {
    /// Worker name to snapshot.
    pub(crate) name: String,

    /// Snapshot format. `plain` is one-line-per-row UTF-8; `ansi` is the
    /// reproduction byte stream (control characters + SGR + cursor commands)
    /// suitable for piping into a terminal.
    #[arg(long, default_value = "plain")]
    pub(crate) format: DumpPtyFormat,

    /// Override the broker base URL. Falls back to RELAY_BROKER_URL, then to
    /// reading `.agent-relay/connection.json` in the current directory.
    #[arg(long)]
    pub(crate) broker_url: Option<String>,

    /// Override the broker API key. Falls back to RELAY_BROKER_API_KEY, then
    /// to reading `.agent-relay/connection.json` in the current directory.
    #[arg(long)]
    pub(crate) api_key: Option<String>,

    /// Override the directory containing `.agent-relay/connection.json` when
    /// auto-discovering the broker.
    #[arg(long)]
    pub(crate) state_dir: Option<PathBuf>,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
pub(crate) enum DumpPtyFormat {
    Plain,
    Ansi,
}

impl DumpPtyFormat {
    pub(crate) fn as_wire_str(&self) -> &'static str {
        match self {
            Self::Plain => "plain",
            Self::Ansi => "ansi",
        }
    }
}

#[derive(Debug, clap::Args, Clone)]
pub(crate) struct McpArgsCommand {
    /// CLI name or command to compute MCP args for.
    #[arg(long)]
    pub(crate) cli: String,

    /// Relaycast agent name to inject into the MCP configuration.
    #[arg(long)]
    pub(crate) agent_name: String,

    /// Relaycast API key. Falls back to RELAY_API_KEY when omitted.
    #[arg(long)]
    pub(crate) api_key: Option<String>,

    /// Relaycast base URL. Falls back to RELAY_BASE_URL when omitted.
    #[arg(long)]
    pub(crate) base_url: Option<String>,

    /// Pre-registered agent token to pass to the child MCP server.
    #[arg(long)]
    pub(crate) agent_token: Option<String>,

    /// Register a fresh Relaycast agent token and inject it into the child MCP server.
    #[arg(long)]
    pub(crate) register: bool,

    /// Multi-workspace context JSON to pass to the child MCP server.
    #[arg(long)]
    pub(crate) workspaces_json: Option<String>,

    /// Default workspace ID/name to pass to the child MCP server.
    #[arg(long)]
    pub(crate) default_workspace: Option<String>,

    /// Working directory used by CLIs that need local MCP config files.
    #[arg(long)]
    pub(crate) cwd: Option<PathBuf>,

    /// Existing CLI args as a JSON string array, e.g. '["--foo","--bar"]'.
    #[arg(long)]
    pub(crate) existing_args: Option<String>,
}

#[derive(Debug, clap::Args)]
pub(crate) struct InitCommand {
    #[arg(long, default_value = "")]
    pub(crate) name: String,

    #[arg(long, default_value = "general")]
    pub(crate) channels: String,

    /// Optional HTTP API port for dashboard proxy (0 = disabled)
    #[arg(long, default_value = "0")]
    pub(crate) api_port: u16,

    /// Bind address for the HTTP API (default: 127.0.0.1).
    /// Use 0.0.0.0 to accept connections from outside the host (e.g. in
    /// Daytona sandboxes where a remote client connects via preview URL).
    #[arg(long, default_value = "127.0.0.1")]
    pub(crate) api_bind: String,

    /// Enable persistence: write state, pending-deliveries, lock, PID, and MCP
    /// config to `.agent-relay/` in the working directory. When omitted (the
    /// default), runtime files are written to a deterministic temp directory and
    /// cleaned up opportunistically; identity registration is non-strict to avoid
    /// stale-name collisions across short-lived sessions.
    #[arg(long, default_value_t = false)]
    pub(crate) persist: bool,

    /// Override the directory used for broker state files (connection.json,
    /// locks, state, pending-deliveries). Defaults to `.agent-relay/` in the
    /// working directory when `--persist` is set, or a temp directory otherwise.
    #[arg(long)]
    pub(crate) state_dir: Option<String>,
}

#[derive(Debug, clap::Args, Clone)]
pub(crate) struct PtyCommand {
    pub(crate) cli: String,

    #[arg(last = true)]
    pub(crate) args: Vec<String>,

    #[arg(long)]
    pub(crate) agent_name: Option<String>,

    /// Emit delivery_active events when output matches progress patterns.
    #[arg(long)]
    pub(crate) progress: bool,

    /// Silence duration in seconds before emitting agent_idle (0 = disabled).
    #[arg(long, default_value = "30")]
    pub(crate) idle_threshold_secs: u64,
}

#[derive(Debug, clap::Args, Clone)]
pub(crate) struct HeadlessCommand {
    pub(crate) provider: HeadlessCliProvider,

    #[arg(last = true)]
    pub(crate) args: Vec<String>,

    #[arg(long)]
    pub(crate) agent_name: Option<String>,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
pub(crate) enum HeadlessCliProvider {
    Claude,
    Opencode,
}

impl From<HeadlessCliProvider> for ProtocolHeadlessProvider {
    fn from(value: HeadlessCliProvider) -> Self {
        match value {
            HeadlessCliProvider::Claude => Self::Claude,
            HeadlessCliProvider::Opencode => Self::Opencode,
        }
    }
}
