//! Drives Agent Relay tools (`openclaw.relay_tools.*`) against a real local
//! OpenClaw: the status the Settings row shows, then Connect, which adds or
//! turns on the hosted Agent Relay MCP and starts `openclaw mcp login`.
//!
//! ```text
//! cargo run --example openclaw_tools_live -- <openclaw launcher> [connect]
//! ```
//!
//! It reads OpenClaw's config from `OPENCLAW_STATE_DIR` /
//! `OPENCLAW_CONFIG_PATH` like OpenClaw's CLI, uses the given launcher as
//! the CLI, and keeps its device key under a scratch app-data directory
//! (`OPENCLAW_LIVE_DATA`, default `./openclaw-live-data`). `connect` prints
//! the consent URL and then stops the login without completing it. The
//! site is `OPENCLAW_LIVE_SITE` (default `https://agentrelay.com`). No
//! token is read or printed.

use agent_relay_probe::relay::openclaw::relay_tools::{Cli, RelayTools};
use agent_relay_probe::relay::openclaw::OpenClawConfig;
use std::collections::BTreeMap;
use std::path::PathBuf;

fn main() {
    let mut args = std::env::args().skip(1);
    let Some(launcher) = args.next().map(PathBuf::from) else {
        eprintln!("usage: openclaw_tools_live <openclaw launcher> [connect]");
        std::process::exit(2);
    };
    let connect = args.next().as_deref() == Some("connect");
    let env: BTreeMap<String, String> = std::env::vars().collect();
    let home = PathBuf::from(env.get("HOME").cloned().unwrap_or_default());
    let data = PathBuf::from(
        env.get("OPENCLAW_LIVE_DATA")
            .cloned()
            .unwrap_or_else(|| "openclaw-live-data".into()),
    );
    let site = env
        .get("OPENCLAW_LIVE_SITE")
        .cloned()
        .unwrap_or_else(|| "https://agentrelay.com".into());
    let config = OpenClawConfig::new(&env, &home, &data);
    println!("config: {}", config.config_path.display());
    let tools = RelayTools::new(&config, move || {
        Some(Cli::new(launcher.clone(), Vec::new()))
    });
    println!("status: {:?}", tools.status(&site));
    if connect {
        println!("connect: {:?}", tools.connect(&site));
        println!("status after connect: {:?}", tools.status(&site));
        tools.stop();
        println!("login stopped");
    }
}
