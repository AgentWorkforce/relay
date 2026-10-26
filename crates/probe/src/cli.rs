use crate::{
    config::{normalize_origin, Config, ConfigStore},
    engine,
    relaycast_client::{self, WorkspaceIdentity},
    server,
};
use anyhow::{anyhow, bail, Context, Result};
use clap::{Parser, Subcommand};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::{
    fs::OpenOptions,
    net::{Ipv4Addr, SocketAddrV4, TcpListener},
    path::PathBuf,
    process::{Command, Stdio},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[derive(Parser)]
#[command(name = "relay", version, about = "Native agent-to-agent messaging")]
struct Cli {
    #[arg(long, global = true)]
    json: bool,
    #[command(subcommand)]
    command: CommandKind,
}

#[derive(Subcommand)]
enum CommandKind {
    /// Start a local Relaycast workspace, or join an explicit hosted/self-hosted one.
    Init {
        /// Relaycast origin to join. Requires --key. Without it, starts locally.
        #[arg(long)]
        url: Option<String>,
        /// Workspace key bound to --url.
        #[arg(long, requires = "url")]
        key: Option<String>,
        /// PEM certificate bundle for a private self-hosted certificate authority.
        #[arg(long, requires = "url")]
        ca_cert: Option<PathBuf>,
        /// Workspace name for a new local workspace.
        #[arg(long)]
        name: Option<String>,
        /// Replace an existing local configuration after verifying the new destination.
        #[arg(long)]
        force: bool,
    },
    /// Start an anonymous hosted trial and print the command for another machine.
    Login {
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        force: bool,
    },
    /// Register, rotate, or list locally stored agent identities.
    Agent {
        #[command(subcommand)]
        command: AgentCommand,
    },
    /// Send a direct message as a stored agent.
    Send {
        #[arg(long = "as", value_name = "AGENT")]
        from: String,
        to: String,
        #[arg(required = true)]
        text: Vec<String>,
    },
    /// Read messages the local probe has durably picked up for an agent.
    Inbox {
        #[arg(long = "as", value_name = "AGENT")]
        agent: String,
    },
    /// Show the saved Relaycast destination and local identities, never credentials.
    Status,
    /// Print the hosted upgrade destination.
    Upgrade,
    /// Stop the local API. Configuration and messages remain on disk.
    Stop,
    /// Internal long-running loopback API.
    #[command(hide = true)]
    Serve,
}

#[derive(Subcommand)]
enum AgentCommand {
    Register { name: String },
    Rotate { name: String },
    List,
}

pub async fn run() -> Result<()> {
    let cli = Cli::parse();
    let store = ConfigStore::discover()?;
    match cli.command {
        CommandKind::Init {
            url,
            key,
            ca_cert,
            name,
            force,
        } => init(&store, url, key, ca_cert, name, force, cli.json).await,
        CommandKind::Login { name, force } => login(&store, name, force, cli.json).await,
        CommandKind::Agent { command } => agent(&store, command, cli.json).await,
        CommandKind::Send { from, to, text } => {
            let value: Value = api_call(
                &store,
                reqwest::Method::POST,
                "/v1/send",
                Some(json!({"from": from, "to": to, "text": text.join(" ")})),
            )
            .await?;
            if cli.json {
                println!("{}", serde_json::to_string(&value)?);
            } else {
                let status = value
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("accepted");
                let id = value
                    .get("message_id")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                println!("{status}: message {id} to {to}");
            }
            Ok(())
        }
        CommandKind::Inbox { agent } => {
            let value: Value = api_call(
                &store,
                reqwest::Method::GET,
                &format!("/v1/inbox/{}", urlencoding::encode(&agent)),
                None,
            )
            .await?;
            if cli.json {
                println!("{}", serde_json::to_string(&value)?);
            } else {
                let messages = value
                    .get("messages")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                if messages.is_empty() {
                    println!("No messages for {agent}.");
                }
                for message in messages {
                    println!(
                        "{}: {}",
                        message
                            .get("from")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown"),
                        message.get("text").and_then(Value::as_str).unwrap_or("")
                    );
                }
            }
            Ok(())
        }
        CommandKind::Status => {
            let value: Value = api_call(&store, reqwest::Method::GET, "/v1/status", None).await?;
            emit(cli.json, &value, || {
                format!(
                    "Relay is ready: {} · workspace {} · {} local agent(s)",
                    value
                        .get("origin")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown"),
                    value
                        .get("workspaceName")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown"),
                    value
                        .get("agents")
                        .and_then(Value::as_array)
                        .map(Vec::len)
                        .unwrap_or(0)
                )
            })
        }
        CommandKind::Upgrade => {
            let value = json!({"upgradeUrl": "https://agentrelay.com/pricing"});
            emit(cli.json, &value, || {
                "Upgrade hosted Relaycast at https://agentrelay.com/pricing".into()
            })
        }
        CommandKind::Stop => {
            let value: Value = api_call(
                &store,
                reqwest::Method::POST,
                "/v1/shutdown",
                Some(json!({})),
            )
            .await?;
            emit(cli.json, &value, || {
                "Relay stopped. Local configuration and messages remain on disk.".into()
            })
        }
        CommandKind::Serve => server::serve(store).await,
    }
}

async fn init(
    store: &ConfigStore,
    url: Option<String>,
    key: Option<String>,
    ca_cert: Option<PathBuf>,
    name: Option<String>,
    force: bool,
    json_output: bool,
) -> Result<()> {
    refuse_existing(store, force).await?;
    let workspace_name = name.unwrap_or_else(default_workspace_name);
    let api_port = available_port()?;
    let (origin, identity, local_engine) = match (url, key) {
        (None, None) => {
            let (origin, engine) = engine::initialize(store, api_port)?;
            let identity = WorkspaceIdentity {
                id: crate::config::random_secret("rw_"),
                name: workspace_name,
                key: crate::config::random_secret("rk_"),
            };
            (origin, identity, Some(engine))
        }
        (Some(url), Some(key)) => {
            let origin = normalize_origin(&url)?;
            let identity =
                relaycast_client::verify_workspace(&origin, key.trim(), ca_cert.as_deref()).await?;
            (origin, identity, None)
        }
        (Some(_), None) => {
            bail!("--url requires --key so Relay never guesses where a credential belongs.")
        }
        (None, Some(_)) => bail!("--key requires --url so Relay never sends it to a default host."),
    };
    install_config_and_server(
        store,
        origin,
        identity,
        local_engine,
        api_port,
        ca_cert,
        json_output,
    )
    .await
}

async fn login(
    store: &ConfigStore,
    name: Option<String>,
    force: bool,
    json_output: bool,
) -> Result<()> {
    refuse_existing(store, force).await?;
    let origin = relaycast_client::hosted_origin().to_string();
    let workspace_name = name.unwrap_or_else(default_workspace_name);
    let identity = relaycast_client::create_workspace(&origin, &workspace_name).await?;
    let api_port = available_port()?;
    install_config_and_server(store, origin, identity, None, api_port, None, json_output).await
}

async fn install_config_and_server(
    store: &ConfigStore,
    origin: String,
    identity: WorkspaceIdentity,
    engine: Option<crate::config::LocalEngine>,
    api_port: u16,
    ca_cert: Option<PathBuf>,
    json_output: bool,
) -> Result<()> {
    let is_local = engine.is_some();
    let mut config = Config::new(
        origin.clone(),
        identity.id.clone(),
        identity.name.clone(),
        identity.key.clone(),
        api_port,
        engine,
    );
    config.ca_cert = ca_cert
        .map(|path| path.canonicalize())
        .transpose()
        .context("Could not resolve the custom CA certificate path.")?;
    store.write(&config)?;
    start_server(store).await?;
    let mut value = json!({
        "ok": true,
        "origin": origin,
        "workspaceId": identity.id,
        "workspaceName": identity.name,
    });
    if !is_local {
        value["joinCommand"] = json!(relaycast_client::join_command(&origin, &identity.key));
    }
    emit(json_output, &value, || {
        if is_local {
            return format!(
                "Relay is ready locally at {}.",
                value["origin"].as_str().unwrap_or("")
            );
        }
        format!(
            "Relay is ready at {}.\nAnother machine joins with:\n{}",
            value["origin"].as_str().unwrap_or(""),
            value["joinCommand"].as_str().unwrap_or("")
        )
    })
}

async fn agent(store: &ConfigStore, command: AgentCommand, json_output: bool) -> Result<()> {
    let (method, path, body) = match command {
        AgentCommand::Register { name } => (
            reqwest::Method::POST,
            "/v1/agents".to_string(),
            Some(json!({"name": name})),
        ),
        AgentCommand::Rotate { name } => (
            reqwest::Method::POST,
            format!("/v1/agents/{}/rotate", urlencoding::encode(&name)),
            Some(json!({})),
        ),
        AgentCommand::List => (reqwest::Method::GET, "/v1/agents".to_string(), None),
    };
    let value: Value = api_call(store, method, &path, body).await?;
    emit(json_output, &value, || {
        if let Some(agents) = value.get("agents").and_then(Value::as_array) {
            if agents.is_empty() {
                return "No local agents are registered.".into();
            }
            return agents
                .iter()
                .filter_map(|agent| agent.get("name").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n");
        }
        let name = value.get("name").and_then(Value::as_str).unwrap_or("agent");
        if value.get("rotated").and_then(Value::as_bool) == Some(true) {
            format!("Rotated and stored {name}'s token.")
        } else {
            format!("Registered {name}; its token is stored locally.")
        }
    })
}

async fn refuse_existing(store: &ConfigStore, force: bool) -> Result<()> {
    if store.path().exists() && !force {
        bail!(
            "Relay is already initialized at {}. Use `relay status`, or pass --force to replace it.",
            store.path().display()
        );
    }
    if store.path().exists() {
        let _ = api_call::<Value>(
            store,
            reqwest::Method::POST,
            "/v1/shutdown",
            Some(json!({})),
        )
        .await;
    }
    Ok(())
}

async fn start_server(store: &ConfigStore) -> Result<()> {
    let config = store.read()?;
    let log_path = store.root().join("probe.log");
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&log_path, std::fs::Permissions::from_mode(0o600))?;
    }
    let stderr = log.try_clone()?;
    let executable = std::env::current_exe()?;
    let mut command = Command::new(&executable);
    command
        .arg("serve")
        .env("AGENT_RELAY_HOME", store.root())
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(stderr));
    detach(&mut command);
    let child = command
        .spawn()
        .context("Could not start the Relay probe API.")?;
    drop(child);
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if api_health(config.api.port).await {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    bail!(
        "Relay probe API did not become ready. See {}.",
        log_path.display()
    )
}

async fn api_health(port: u16) -> bool {
    reqwest::Client::new()
        .get(format!("http://127.0.0.1:{port}/health"))
        .timeout(Duration::from_millis(500))
        .send()
        .await
        .is_ok_and(|response| response.status().is_success())
}

async fn api_call<T: DeserializeOwned>(
    store: &ConfigStore,
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
) -> Result<T> {
    let config = store.read()?;
    if !api_health(config.api.port).await {
        start_server(store).await?;
    }
    let client = reqwest::Client::new();
    let mut request = client
        .request(
            method,
            format!("http://127.0.0.1:{}{path}", config.api.port),
        )
        .bearer_auth(&config.api.token)
        .timeout(Duration::from_secs(20));
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request
        .send()
        .await
        .context("Relay probe API could not be reached.")?;
    let status = response.status();
    let bytes = response.bytes().await?;
    let value: Value =
        serde_json::from_slice(&bytes).context("Relay probe returned unreadable JSON.")?;
    if !status.is_success() {
        let message = value
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or("Relay probe request failed.");
        bail!("{message}");
    }
    serde_json::from_value(value).map_err(Into::into)
}

fn emit(json_output: bool, value: &Value, human: impl FnOnce() -> String) -> Result<()> {
    if json_output {
        println!("{}", serde_json::to_string(value)?);
    } else {
        println!("{}", human());
    }
    Ok(())
}

fn available_port() -> Result<u16> {
    let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))?;
    let port = listener.local_addr()?.port();
    drop(listener);
    if port == 0 {
        return Err(anyhow!("Could not reserve a loopback port for Relay."));
    }
    Ok(port)
}

fn default_workspace_name() -> String {
    let base = std::env::current_dir()
        .ok()
        .and_then(|path| {
            path.file_name()
                .map(|name| name.to_string_lossy().into_owned())
        })
        .unwrap_or_else(|| "workspace".into());
    let safe = base
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '-'
            }
        })
        .collect::<String>();
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("{}-{suffix}", safe.trim_matches('-'))
}

fn detach(command: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_name_is_cli_safe() {
        let name = default_workspace_name();
        assert!(!name.is_empty());
        assert!(name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')));
    }

    #[test]
    fn api_port_is_nonzero() {
        assert_ne!(available_port().unwrap(), 0);
    }
}
