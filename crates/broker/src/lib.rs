pub mod protocol;
pub mod snippets;

pub(crate) mod broker;
pub(crate) mod cli;
pub(crate) mod cli_mcp_args;
pub(crate) mod codex_session;
#[allow(dead_code)]
pub(crate) mod config;
pub(crate) mod control;
#[allow(dead_code)]
pub(crate) mod conversation_log;
pub(crate) mod crash_insights;
#[allow(dead_code)]
pub(crate) mod dedup;
#[allow(dead_code)]
pub(crate) mod events;
pub(crate) mod listen_api;
#[allow(dead_code)]
pub(crate) mod metrics;
pub(crate) mod priorities;
#[allow(dead_code)]
pub(crate) mod pty;
pub(crate) mod pty_worker;
#[allow(dead_code)]
pub(crate) mod queue;
pub(crate) mod readiness;
#[allow(dead_code)]
pub(crate) mod redact;
#[allow(dead_code)]
pub(crate) mod relaycast;
pub(crate) mod replay_buffer;
pub(crate) mod routing;
pub(crate) mod runtime;
#[allow(dead_code)]
pub(crate) mod scheduler;
pub(crate) mod snapshot;
pub(crate) mod spawner;
#[allow(dead_code)]
pub(crate) mod supervisor;
pub(crate) mod swarm;
pub(crate) mod swarm_tui;
#[allow(dead_code)]
pub(crate) mod telemetry;
#[allow(dead_code)]
pub(crate) mod types;
pub(crate) mod util;
pub(crate) mod wait;
pub(crate) mod worker;
pub(crate) mod worker_request;
pub(crate) mod wrap;

pub async fn run_cli() -> anyhow::Result<()> {
    cli::run().await
}
