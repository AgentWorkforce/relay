use std::path::PathBuf;

use crate::{
    protocol::HeadlessProvider as ProtocolHeadlessProvider,
    telemetry::{TelemetryClient, TelemetryEvent},
};
use anyhow::Result;
use clap::{Parser, Subcommand, ValueEnum};

use crate::{cli_mcp_args, pty_worker, runtime, swarm, wrap};

pub(crate) mod command_parse;

#[derive(Debug, Parser)]
#[command(name = "agent-relay-broker")]
#[command(about = "Agent relay broker and worker runtime")]
#[command(version = crate::util::version::BROKER_VERSION)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Debug, Subcommand)]
enum Commands {
    Init(InitCommand),
    Pty(PtyCommand),
    Headless(HeadlessCommand),
    /// Internal: headless worker shim for app-server-backed harnesses.
    #[command(name = "app-server", hide = true)]
    HeadlessAppServer(HeadlessAppServerCommand),
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
            Commands::HeadlessAppServer(_) => "app_server",
            Commands::McpArgs(_) => "mcp_args",
            Commands::Swarm(_) => "swarm",
            Commands::DumpPty(_) => "dump_pty",
            Commands::Wrap { .. } => "wrap",
        }
    }

    /// Identifier used to name this process' tracing log file. For broker-style
    /// subcommands (init, pty, headless, wrap) we prefer the broker / agent
    /// name; for short-lived utility subcommands we fall back to a
    /// `{command}-{pid}` tag so concurrent invocations don't clobber each
    /// other's log file.
    fn log_identifier(&self) -> String {
        let pid = std::process::id();
        match self {
            Commands::Init(cmd) => {
                let name = cmd.resolved_instance_name(None);
                if !name.is_empty() {
                    return name;
                }
                std::env::current_dir()
                    .ok()
                    .as_ref()
                    .and_then(|p| p.file_name())
                    .and_then(|n| n.to_str())
                    .filter(|s| !s.is_empty())
                    .map(ToOwned::to_owned)
                    .unwrap_or_else(|| format!("broker-{pid}"))
            }
            Commands::Pty(cmd) => {
                non_empty_name(cmd.agent_name.as_deref()).unwrap_or_else(|| format!("pty-{pid}"))
            }
            Commands::Headless(cmd) => non_empty_name(cmd.agent_name.as_deref())
                .unwrap_or_else(|| format!("headless-{pid}")),
            Commands::HeadlessAppServer(cmd) => non_empty_name(cmd.agent_name.as_deref())
                .unwrap_or_else(|| format!("headless-app-server-{pid}")),
            Commands::Wrap { cli, .. } => format!("wrap-{cli}-{pid}"),
            Commands::McpArgs(_) => format!("mcp_args-{pid}"),
            Commands::DumpPty(cmd) => format!("dump_pty-{}-{}", cmd.name, pid),
            Commands::Swarm(_) => format!("swarm-{pid}"),
        }
    }
}

fn non_empty_name(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
}

pub(crate) async fn run() -> Result<()> {
    let cli = Cli::parse();
    runtime::init_tracing(&cli.command.log_identifier());

    let telemetry = TelemetryClient::new();
    telemetry.track(TelemetryEvent::CliCommandRun {
        command_name: cli.command.telemetry_name().to_string(),
    });

    match cli.command {
        Commands::Init(cmd) => runtime::run_init(cmd, telemetry).await,
        Commands::Pty(cmd) => pty_worker::run_pty_worker(cmd).await,
        Commands::Headless(cmd) => runtime::run_headless_worker(cmd).await,
        Commands::HeadlessAppServer(cmd) => runtime::run_headless_app_server_worker(cmd).await,
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
    /// reading `.agentworkforce/relay/connection.json` in the current directory.
    #[arg(long)]
    pub(crate) broker_url: Option<String>,

    /// Override the broker API key. Falls back to RELAY_BROKER_API_KEY, then
    /// to reading `.agentworkforce/relay/connection.json` in the current directory.
    #[arg(long)]
    pub(crate) api_key: Option<String>,

    /// Override the directory containing `.agentworkforce/relay/connection.json` when
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
    /// Legacy broker instance name flag. Prefer --instance-name.
    #[arg(long, default_value = "", alias = "broker-name")]
    pub(crate) name: String,

    /// Stable broker instance name within the Relay workspace.
    #[arg(long = "instance-name")]
    pub(crate) instance_name: Option<String>,

    /// Join an existing Relay workspace instead of creating a fresh one.
    #[arg(long = "workspace-key")]
    pub(crate) workspace_key: Option<String>,

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

    /// Enable persistence: write state, pending-deliveries, lock, and PID files
    /// to `.agentworkforce/relay/` in the working directory. MCP configuration is injected
    /// into spawned agents at launch time instead of being written to project
    /// config files. When omitted (the default), runtime files are written to a
    /// deterministic temp directory and cleaned up opportunistically; identity
    /// registration is non-strict to avoid stale-name collisions across
    /// short-lived sessions.
    #[arg(long, default_value_t = false)]
    pub(crate) persist: bool,

    /// Override the directory used for broker state files (connection.json,
    /// locks, state, pending-deliveries). Defaults to `.agentworkforce/relay/` in the
    /// working directory when `--persist` is set, or a temp directory otherwise.
    #[arg(long)]
    pub(crate) state_dir: Option<String>,
}

impl InitCommand {
    pub(crate) fn resolved_instance_name(&self, fallback: Option<&str>) -> String {
        fn non_empty_trimmed(value: &str) -> Option<String> {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }

        self.instance_name
            .as_deref()
            .and_then(non_empty_trimmed)
            .or_else(|| non_empty_trimmed(&self.name))
            .or_else(|| {
                std::env::var("AGENT_RELAY_BROKER_NAME")
                    .ok()
                    .and_then(|name| non_empty_trimmed(&name))
            })
            .or_else(|| fallback.and_then(non_empty_trimmed))
            .unwrap_or_default()
    }

    pub(crate) fn resolved_workspace_key(&self) -> Option<String> {
        fn non_empty_trimmed(value: &str) -> Option<String> {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }

        self.workspace_key
            .as_deref()
            .and_then(non_empty_trimmed)
            .or_else(|| {
                std::env::var("AGENT_RELAY_WORKSPACE_KEY")
                    .ok()
                    .and_then(|key| non_empty_trimmed(&key))
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static BROKER_NAME_ENV_MUTEX: Mutex<()> = Mutex::new(());
    static WORKSPACE_KEY_ENV_MUTEX: Mutex<()> = Mutex::new(());

    struct BrokerNameEnvGuard {
        _guard: std::sync::MutexGuard<'static, ()>,
    }

    impl Drop for BrokerNameEnvGuard {
        fn drop(&mut self) {
            std::env::remove_var("AGENT_RELAY_BROKER_NAME");
        }
    }

    fn broker_name_env_guard() -> BrokerNameEnvGuard {
        let guard = BROKER_NAME_ENV_MUTEX.lock().unwrap();
        std::env::remove_var("AGENT_RELAY_BROKER_NAME");
        BrokerNameEnvGuard { _guard: guard }
    }

    struct WorkspaceKeyEnvGuard {
        _guard: std::sync::MutexGuard<'static, ()>,
    }

    impl Drop for WorkspaceKeyEnvGuard {
        fn drop(&mut self) {
            std::env::remove_var("AGENT_RELAY_WORKSPACE_KEY");
        }
    }

    fn workspace_key_env_guard() -> WorkspaceKeyEnvGuard {
        let guard = WORKSPACE_KEY_ENV_MUTEX.lock().unwrap();
        std::env::remove_var("AGENT_RELAY_WORKSPACE_KEY");
        WorkspaceKeyEnvGuard { _guard: guard }
    }

    fn init_command(name: &str, instance_name: Option<&str>) -> InitCommand {
        InitCommand {
            name: name.to_string(),
            instance_name: instance_name.map(ToOwned::to_owned),
            workspace_key: None,
            channels: "general".to_string(),
            api_port: 0,
            api_bind: "127.0.0.1".to_string(),
            persist: false,
            state_dir: None,
        }
    }

    #[test]
    fn instance_name_flag_overrides_legacy_name_and_env() {
        let _guard = broker_name_env_guard();
        std::env::set_var("AGENT_RELAY_BROKER_NAME", "env-name");

        let command = init_command("legacy-name", Some("instance-name"));

        assert_eq!(
            command.resolved_instance_name(Some("fallback")),
            "instance-name"
        );
    }

    #[test]
    fn legacy_name_flag_overrides_env_default() {
        let _guard = broker_name_env_guard();
        std::env::set_var("AGENT_RELAY_BROKER_NAME", "env-name");

        let command = init_command("legacy-name", None);

        assert_eq!(
            command.resolved_instance_name(Some("fallback")),
            "legacy-name"
        );
    }

    #[test]
    fn env_broker_name_overrides_fallback_only() {
        let _guard = broker_name_env_guard();
        std::env::set_var("AGENT_RELAY_BROKER_NAME", "env-name");

        let command = init_command("", None);

        assert_eq!(command.resolved_instance_name(Some("fallback")), "env-name");
    }

    #[test]
    fn blank_instance_name_falls_through_to_legacy_name() {
        let _guard = broker_name_env_guard();
        std::env::set_var("AGENT_RELAY_BROKER_NAME", "env-name");

        let command = init_command("legacy-name", Some("   "));

        assert_eq!(
            command.resolved_instance_name(Some("fallback")),
            "legacy-name"
        );
    }

    #[test]
    fn empty_instance_name_and_blank_env_fall_through_to_fallback() {
        let _guard = broker_name_env_guard();
        std::env::set_var("AGENT_RELAY_BROKER_NAME", "   ");

        let command = init_command("", Some(""));

        assert_eq!(command.resolved_instance_name(Some("fallback")), "fallback");
    }

    #[test]
    fn blank_workspace_key_falls_through_to_env() {
        let _guard = workspace_key_env_guard();
        std::env::set_var("AGENT_RELAY_WORKSPACE_KEY", " rk_live_env ");
        let mut command = init_command("", None);
        command.workspace_key = Some("   ".to_string());

        assert_eq!(
            command.resolved_workspace_key().as_deref(),
            Some("rk_live_env")
        );
    }

    #[test]
    fn workspace_key_flag_overrides_env() {
        let _guard = workspace_key_env_guard();
        std::env::set_var("AGENT_RELAY_WORKSPACE_KEY", "rk_live_env");
        let mut command = init_command("", None);
        command.workspace_key = Some(" rk_live_flag ".to_string());

        assert_eq!(
            command.resolved_workspace_key().as_deref(),
            Some("rk_live_flag")
        );
    }
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

#[derive(Debug, clap::Args, Clone)]
pub(crate) struct HeadlessAppServerCommand {
    #[arg(long)]
    pub(crate) protocol: String,

    #[arg(long)]
    pub(crate) endpoint: String,

    #[arg(long = "session-id")]
    pub(crate) session_id: String,

    #[arg(long = "host-pid")]
    pub(crate) host_pid: Option<u32>,

    #[arg(long, default_value = "detach")]
    pub(crate) release: String,

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
