mod broker;
mod cli;
mod cli_mcp_args;
mod helpers;
mod listen_api;
mod pty_worker;
mod readiness;
mod routing;
mod runtime;
mod spawner;
mod swarm;
mod swarm_tui;
mod wait;
mod worker;
mod worker_request;
mod wrap;

use anyhow::Result;

#[tokio::main]
async fn main() -> Result<()> {
    cli::run().await
}

#[cfg(test)]
mod broker_tests;
#[cfg(test)]
mod worker_tests;
