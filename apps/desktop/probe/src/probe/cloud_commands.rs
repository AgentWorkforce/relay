//! The `agent-relay cloud …` subcommand surface: argument shapes and
//! dispatch. `install`'s body stays in `main` with the collector plumbing it
//! drives; `rotate-key` runs entirely here.

use agent_relay_probe::cloud;
use anyhow::Result;
use clap::{Args, Subcommand};

use crate::{bridge, user_error, validate_id};

#[derive(Subcommand)]
pub enum CloudCommands {
    Install(Install),
    /// Rotate the signed-in workspace's hosted Agent Relay key: Cloud mints
    /// the replacement, fences the superseded one, and the new key reaches
    /// connected machines through the ordinary workspace refresh. The key
    /// itself is never printed.
    RotateKey(RotateKey),
}

#[derive(Args)]
pub struct Install {
    #[arg(long, default_value = "https://agentrelay.com")]
    pub site_url: String,
    #[arg(long)]
    pub account: Option<String>,
    #[arg(long)]
    pub workspace: Option<String>,
    #[arg(long, conflicts_with_all = ["new_sessions_only", "selected_sessions_only"])]
    pub include_existing: bool,
    #[arg(long)]
    pub new_sessions_only: bool,
    #[arg(long, conflicts_with = "new_sessions_only")]
    pub selected_sessions_only: bool,
    /// The sharing choice applies to a new install only: an install already
    /// set up for this workspace keeps its saved choice instead of refusing
    /// a different one. The desktop apps' sign-in passes it with their
    /// default, so signing in again reconnects a `new` or `all` install.
    #[arg(long)]
    pub keep_saved_sharing: bool,
    #[arg(long)]
    pub force_login: bool,
    #[arg(long)]
    pub foreground: bool,
    #[arg(long)]
    pub once: bool,
    #[arg(long)]
    pub acknowledge_uninspected_schedules: bool,
}

#[derive(Args)]
pub struct RotateKey {
    #[arg(long, default_value = "https://agentrelay.com")]
    pub site_url: String,
    /// Milliseconds the superseded key keeps authenticating, up to Cloud's
    /// one-hour bound; 0 revokes it at once — the compromise path.
    #[arg(long, default_value_t = 60_000)]
    pub grace_ms: u64,
    /// The Cloud workspace to rotate; default the account's current one.
    #[arg(long)]
    pub workspace: Option<String>,
    #[arg(long)]
    pub force_login: bool,
}

pub fn run(command: CloudCommands) -> Result<()> {
    match command {
        CloudCommands::Install(options) => crate::install(options),
        CloudCommands::RotateKey(options) => rotate_key(options),
    }
}

/// `agent-relay cloud rotate-key`: the hosted rotation command. Cloud's
/// canonical route mints and fences the key; this authenticates, names the
/// workspace, and reports the outcome — the replacement key is never in the
/// response, so nothing here can print it.
fn rotate_key(options: RotateKey) -> Result<()> {
    let site = cloud::site_origin(&options.site_url)?;
    let api_url = cloud::cloud_api_url(Some(&format!("{site}/cloud")))?;
    let authenticated = cloud::cloud_bearer(
        &api_url,
        cloud::CloudBearerOptions {
            force_login: options.force_login,
            interactive: true,
            client_name: "Agent Relay",
            announce: &mut |approval: &cloud::DeviceApproval| {
                humanln!(
                    "Open this URL to authorize your computer:\n{}",
                    approval
                        .verification_uri_complete
                        .as_ref()
                        .unwrap_or(&approval.verification_uri)
                );
                if let Some(code) = &approval.user_code {
                    humanln!("Code: {code}");
                }
            },
        },
    )?;
    let who = cloud::whoami(&api_url, &authenticated)?;
    let workspace = options
        .workspace
        .clone()
        .or(who.workspace_id.clone())
        .ok_or_else(|| {
            user_error(
                "This account has no workspace. Open the dashboard first or pass --workspace.",
            )
        })?;
    validate_id(&workspace)?;
    let rotated =
        cloud::rotate_relay_workspace_key(&api_url, &authenticated, &workspace, options.grace_ms)?;
    if bridge::json_mode() {
        bridge::emit(serde_json::json!({
            "rotated": true,
            "workspace_id": workspace,
            "key_generation": rotated.get("key_generation"),
            "grace_ms": rotated.get("grace_ms"),
        }));
    } else {
        let expiry = match rotated.get("grace_ms").and_then(|v| v.as_u64()) {
            Some(0) => "the previous key is revoked now".to_string(),
            Some(ms) => format!("the previous key keeps working for {}s", ms / 1000),
            None => "the previous key's grace is bounded".to_string(),
        };
        humanln!(
            "Workspace key rotated: {expiry}. Connected machines pick up the new key on their next workspace refresh."
        );
    }
    Ok(())
}
