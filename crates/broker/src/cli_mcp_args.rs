use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use anyhow::{anyhow, bail, Context, Result};
use relay_broker::{
    relaycast_ws::{RelaycastHttpClient, RelaycastRegistrationError},
    snippets::configure_relaycast_mcp_with_token,
};
use serde::{Deserialize, Serialize};

use crate::McpArgsCommand;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct McpArgsOutput {
    args: Vec<String>,
    side_effect_files: Vec<PathBuf>,
    agent_token: Option<String>,
}

struct RegisteredMcpArgsToken {
    api_key: String,
    base_url: String,
    agent_token: String,
}

pub(crate) async fn run_mcp_args(cmd: McpArgsCommand) -> Result<()> {
    let output = compute_mcp_args_output(cmd).await?;
    println!("{}", serde_json::to_string_pretty(&output)?);
    Ok(())
}

async fn compute_mcp_args_output(cmd: McpArgsCommand) -> Result<McpArgsOutput> {
    let cli = cmd.cli.trim().to_string();
    if cli.is_empty() {
        bail!("--cli must not be empty");
    }

    let agent_name = cmd.agent_name.trim().to_string();
    if agent_name.is_empty() {
        bail!("--agent-name must not be empty");
    }

    if cmd.register && cmd.agent_token.is_some() {
        bail!("--register and --agent-token are mutually exclusive; pass one or the other");
    }

    // Validate all local inputs BEFORE touching the network. `--register`
    // rotates the agent's relaycast token (POST /v1/agents/spawn), which is
    // an observable side effect on an external system — we should not mint
    // or rotate a token if the request is going to fail locally anyway
    // (e.g. malformed --existing-args JSON or an unresolvable --cwd).
    let cwd = normalize_cwd(cmd.cwd)?;
    let existing_args = parse_existing_args(cmd.existing_args)?;

    // Match the broker's internal WorkerRegistry::build_mcp_args behavior:
    // each flag falls back to its RELAY_* env var so env-driven callers
    // (e.g. cloud's SandboxedStepExecutor, which sets these from
    // orchestrator-managed secrets) don't lose the value just because
    // they didn't repeat it on the CLI.
    let registered = if cmd.register {
        Some(
            register_agent_token_for_mcp_args(
                &cli,
                &agent_name,
                cmd.api_key.clone(),
                cmd.base_url.clone(),
            )
            .await?,
        )
    } else {
        None
    };

    let api_key = registered
        .as_ref()
        .map(|registered| registered.api_key.clone())
        .or_else(|| cmd.api_key.or_else(|| std::env::var("RELAY_API_KEY").ok()));
    let base_url = registered
        .as_ref()
        .map(|registered| registered.base_url.clone())
        .or_else(|| {
            cmd.base_url
                .or_else(|| std::env::var("RELAY_BASE_URL").ok())
        });
    let agent_token = registered
        .as_ref()
        .map(|registered| registered.agent_token.clone())
        .or_else(|| {
            if cmd.register {
                None
            } else {
                cmd.agent_token
                    .or_else(|| std::env::var("RELAY_AGENT_TOKEN").ok())
            }
        });
    let workspaces_json = cmd
        .workspaces_json
        .or_else(|| std::env::var("RELAY_WORKSPACES_JSON").ok());
    let default_workspace = cmd
        .default_workspace
        .or_else(|| std::env::var("RELAY_DEFAULT_WORKSPACE").ok());

    let args = configure_relaycast_mcp_with_token(
        &cli,
        &agent_name,
        api_key.as_deref(),
        base_url.as_deref(),
        &existing_args,
        &cwd,
        agent_token.as_deref(),
        workspaces_json.as_deref(),
        default_workspace.as_deref(),
    )
    .await?;

    let side_effect_files = side_effect_files_for(&cli, &existing_args, &cwd)?;

    Ok(McpArgsOutput {
        args,
        side_effect_files,
        agent_token: registered.map(|registered| registered.agent_token),
    })
}

async fn register_agent_token_for_mcp_args(
    cli: &str,
    agent_name: &str,
    api_key: Option<String>,
    base_url: Option<String>,
) -> Result<RegisteredMcpArgsToken> {
    let api_key = api_key
        .or_else(|| std::env::var("RELAY_API_KEY").ok())
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            anyhow!("--register requires an API key (pass --api-key or set RELAY_API_KEY)")
        })?;
    let base_url = base_url
        .or_else(|| std::env::var("RELAY_BASE_URL").ok())
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            anyhow!("--register requires a base URL (pass --base-url or set RELAY_BASE_URL)")
        })?;
    let cli_lower = detect_cli_name_for_mcp_args(cli).to_lowercase();
    let client = RelaycastHttpClient::new(
        base_url.clone(),
        api_key.clone(),
        agent_name.to_string(),
        cli_lower.clone(),
    );

    let agent_token = match tokio::time::timeout(
        Duration::from_secs(10),
        client.register_agent_token(agent_name, Some(&cli_lower)),
    )
    .await
    {
        Ok(Ok(token)) => token,
        Ok(Err(error)) => return Err(map_register_agent_token_error(error)),
        Err(error) => bail!("register timed out after 10s: {error}"),
    };

    Ok(RegisteredMcpArgsToken {
        api_key,
        base_url,
        agent_token,
    })
}

fn map_register_agent_token_error(error: RelaycastRegistrationError) -> anyhow::Error {
    match error {
        RelaycastRegistrationError::Transport { detail, .. } => {
            anyhow!("register transport error: {detail}")
        }
        auth @ RelaycastRegistrationError::Api {
            status: 401 | 403, ..
        } => anyhow!("register auth error: {auth}"),
        other => anyhow!("register failed: {other}"),
    }
}

fn parse_existing_args(existing_args: Option<String>) -> Result<Vec<String>> {
    match existing_args {
        Some(raw) => serde_json::from_str::<Vec<String>>(&raw)
            .with_context(|| "--existing-args must be a JSON array of strings"),
        None => Ok(Vec::new()),
    }
}

fn normalize_cwd(cwd: Option<PathBuf>) -> Result<PathBuf> {
    let cwd = match cwd {
        Some(cwd) => cwd,
        None => std::env::current_dir().context("failed to determine current directory")?,
    };

    absolutize_path(cwd)
}

fn absolutize_path(path: PathBuf) -> Result<PathBuf> {
    if let Ok(canonical) = path.canonicalize() {
        return Ok(canonical);
    }

    if path.is_absolute() {
        return Ok(path);
    }

    Ok(std::env::current_dir()
        .context("failed to determine current directory")?
        .join(path))
}

fn side_effect_files_for(cli: &str, existing_args: &[String], cwd: &Path) -> Result<Vec<PathBuf>> {
    let cli_lower = detect_cli_name_for_mcp_args(cli).to_lowercase();

    if cli_lower == "opencode" && !existing_args.iter().any(|arg| arg == "--agent") {
        return Ok(vec![cwd.join("opencode.json")]);
    }

    if cli_lower == "cursor" || cli_lower == "cursor-agent" || cli_lower == "agent" {
        return Ok(vec![cwd.join(".cursor").join("mcp.json")]);
    }

    if cli_lower == "gemini" {
        return Ok(home_dir_from_env()
            .map(|home| home.join(".gemini").join("trustedFolders.json"))
            .into_iter()
            .collect());
    }

    Ok(Vec::new())
}

fn detect_cli_name_for_mcp_args(cli: &str) -> String {
    let command = shlex::split(cli)
        .and_then(|parts| parts.first().cloned())
        .unwrap_or_else(|| cli.trim().to_string());

    Path::new(&command)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(command.as_str())
        .to_string()
}

fn home_dir_from_env() -> Option<PathBuf> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()
        .and_then(|home| absolutize_path(PathBuf::from(home)).ok())
}

#[cfg(test)]
mod tests {
    use httpmock::{Method::POST, MockServer};
    use relay_broker::snippets::configure_relaycast_mcp_with_token;
    use serde_json::{json, Value};
    use std::sync::{Mutex, MutexGuard, PoisonError};
    use tempfile::tempdir;

    use super::*;

    // Several tests mutate process-global RELAY_* env vars. `#[tokio::test]`
    // cases run in parallel by default, so without serialization those
    // tests race and intermittently break CI depending on execution order.
    // Any test that touches these env vars MUST acquire this lock for its
    // entire duration and use `EnvGuard` to restore prior values on drop.
    static RELAY_ENV_MUTEX: Mutex<()> = Mutex::new(());

    const RELAY_ENV_KEYS: &[&str] = &[
        "RELAY_API_KEY",
        "RELAY_BASE_URL",
        "RELAY_AGENT_TOKEN",
        "RELAY_WORKSPACES_JSON",
        "RELAY_DEFAULT_WORKSPACE",
    ];

    /// RAII guard that (1) holds the env mutex so parallel tests don't race,
    /// and (2) snapshots the listed RELAY_* vars on construction and restores
    /// them on drop. Panics during a test still restore state because Drop runs.
    struct EnvGuard {
        _lock: MutexGuard<'static, ()>,
        saved: Vec<(&'static str, Option<String>)>,
    }

    impl EnvGuard {
        fn new(keys: &[&'static str]) -> Self {
            let lock = RELAY_ENV_MUTEX
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            let saved = keys
                .iter()
                .map(|key| (*key, std::env::var(key).ok()))
                .collect();
            Self { _lock: lock, saved }
        }

        /// Snapshots (and locks) the full set of RELAY_* vars this module cares
        /// about. Prefer this over listing keys at every call site.
        fn all() -> Self {
            Self::new(RELAY_ENV_KEYS)
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            for (key, value) in &self.saved {
                match value {
                    Some(v) => std::env::set_var(key, v),
                    None => std::env::remove_var(key),
                }
            }
        }
    }

    fn command(cli: &str, cwd: &Path) -> McpArgsCommand {
        McpArgsCommand {
            cli: cli.to_string(),
            agent_name: "test-agent".to_string(),
            api_key: Some("rk_live_test".to_string()),
            base_url: Some("https://api.test.relaycast.dev".to_string()),
            agent_token: Some("at_live_test".to_string()),
            register: false,
            workspaces_json: Some(r#"{"workspaces":[]}"#.to_string()),
            default_workspace: Some("default-workspace".to_string()),
            cwd: Some(cwd.to_path_buf()),
            existing_args: None,
        }
    }

    fn output_as_json(output: &McpArgsOutput) -> Value {
        let json = serde_json::to_string_pretty(output).expect("serialize output");
        serde_json::from_str(&json).expect("parse output json")
    }

    #[tokio::test]
    async fn claude_output_contains_mcp_config_json() {
        let temp = tempdir().expect("tempdir");
        let output = compute_mcp_args_output(command("claude", temp.path()))
            .await
            .expect("compute mcp args");

        let mcp_config_index = output
            .args
            .iter()
            .position(|arg| arg == "--mcp-config")
            .expect("claude --mcp-config arg");
        let config_json = output
            .args
            .get(mcp_config_index + 1)
            .expect("claude mcp config value");
        let config: Value = serde_json::from_str(config_json).expect("valid mcp config json");

        assert!(config
            .pointer("/mcpServers/relaycast")
            .is_some_and(Value::is_object));
        assert!(output.side_effect_files.is_empty());
    }

    #[tokio::test]
    async fn codex_output_contains_relaycast_config_args() {
        let temp = tempdir().expect("tempdir");
        let output = compute_mcp_args_output(command("codex", temp.path()))
            .await
            .expect("compute mcp args");

        assert!(output.args.contains(&"--config".to_string()));
        assert!(output
            .args
            .contains(&"mcp_servers.relaycast.command=\"npx\"".to_string()));
        assert!(output
            .args
            .contains(&"mcp_servers.relaycast.args=[\"-y\", \"@relaycast/mcp\"]".to_string()));
        assert!(output.side_effect_files.is_empty());
    }

    #[tokio::test]
    async fn opencode_output_writes_config_and_returns_agent_args() {
        let temp = tempdir().expect("tempdir");
        let output = compute_mcp_args_output(command("opencode", temp.path()))
            .await
            .expect("compute mcp args");

        assert_eq!(output.args, vec!["--agent", "relaycast"]);
        assert_eq!(
            output.side_effect_files,
            vec![temp.path().canonicalize().unwrap().join("opencode.json")]
        );
        assert!(temp.path().join("opencode.json").is_file());
    }

    #[tokio::test]
    async fn cursor_output_writes_config_and_returns_no_args() {
        let temp = tempdir().expect("tempdir");
        let output = compute_mcp_args_output(command("cursor-agent", temp.path()))
            .await
            .expect("compute mcp args");

        assert!(output.args.is_empty());
        assert_eq!(
            output.side_effect_files,
            vec![temp
                .path()
                .canonicalize()
                .unwrap()
                .join(".cursor")
                .join("mcp.json")]
        );
        assert!(temp.path().join(".cursor").join("mcp.json").is_file());
    }

    #[test]
    fn opencode_existing_agent_arg_suppresses_side_effect_file() {
        let temp = tempdir().expect("tempdir");
        let files = side_effect_files_for(
            "opencode",
            &["--agent".to_string(), "custom".to_string()],
            temp.path(),
        )
        .expect("side effect files");

        assert!(files.is_empty());
    }

    #[tokio::test]
    async fn empty_cli_returns_error() {
        let temp = tempdir().expect("tempdir");
        let mut cmd = command("   ", temp.path());
        cmd.cli = "   ".to_string();

        let error = compute_mcp_args_output(cmd)
            .await
            .expect_err("empty cli error");
        assert!(error.to_string().contains("--cli must not be empty"));
    }

    #[tokio::test]
    async fn invalid_existing_args_json_returns_error() {
        let temp = tempdir().expect("tempdir");
        let mut cmd = command("claude", temp.path());
        cmd.existing_args = Some("{not-json".to_string());

        let error = compute_mcp_args_output(cmd)
            .await
            .expect_err("invalid existing args error");
        assert!(error
            .to_string()
            .contains("--existing-args must be a JSON array of strings"));
    }

    #[tokio::test]
    async fn output_serializes_camel_case_side_effect_files() {
        let temp = tempdir().expect("tempdir");
        let output = compute_mcp_args_output(command("opencode", temp.path()))
            .await
            .expect("compute mcp args");
        let json = output_as_json(&output);

        assert!(json.get("args").is_some());
        assert!(json.get("sideEffectFiles").is_some());
        assert_eq!(json.get("agentToken"), Some(&Value::Null));
        assert!(json.get("side_effect_files").is_none());
    }

    #[tokio::test]
    async fn register_and_agent_token_are_mutually_exclusive() {
        let temp = tempdir().expect("tempdir");
        let mut cmd = command("claude", temp.path());
        cmd.register = true;
        cmd.agent_token = Some("at_live_explicit".to_string());

        let error = compute_mcp_args_output(cmd)
            .await
            .expect_err("mutually exclusive flags error");
        let message = error.to_string();

        assert!(message.contains("--register"));
        assert!(message.contains("--agent-token"));
    }

    #[tokio::test]
    async fn register_without_api_key_returns_clear_error() {
        let _env = EnvGuard::all();
        std::env::remove_var("RELAY_API_KEY");

        let temp = tempdir().expect("tempdir");
        let mut cmd = command("claude", temp.path());
        cmd.register = true;
        cmd.api_key = None;
        cmd.agent_token = None;

        let error = compute_mcp_args_output(cmd)
            .await
            .expect_err("missing api key error");

        assert!(error.to_string().contains("API key"));
    }

    #[tokio::test]
    async fn register_without_base_url_returns_clear_error() {
        let _env = EnvGuard::all();
        std::env::remove_var("RELAY_BASE_URL");

        let temp = tempdir().expect("tempdir");
        let mut cmd = command("claude", temp.path());
        cmd.register = true;
        cmd.base_url = None;
        cmd.agent_token = None;

        let error = compute_mcp_args_output(cmd)
            .await
            .expect_err("missing base url error");

        assert!(error.to_string().contains("base URL"));
    }

    #[tokio::test]
    async fn register_happy_path_embeds_minted_token() {
        let _env = EnvGuard::all();
        std::env::remove_var("RELAY_API_KEY");
        std::env::remove_var("RELAY_BASE_URL");
        std::env::remove_var("RELAY_AGENT_TOKEN");

        let server = MockServer::start();
        let register_mock = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/agents/spawn")
                .body_contains("\"name\":\"test-agent\"")
                .body_contains("\"cli\":\"claude\"");
            then.status(200).json_body(json!({
                "ok": true,
                "data": {
                    "id": "agent_register_test",
                    "name": "test-agent",
                    "token": "at_live_register_test_token",
                    "cli": "claude",
                    "task": "relay worker session for test-agent",
                    "channel": null,
                    "status": "online",
                    "created_at": "2026-01-01T00:00:00.000Z",
                    "already_existed": false
                }
            }));
        });

        let temp = tempdir().expect("tempdir");
        let mut cmd = command("claude", temp.path());
        cmd.register = true;
        cmd.base_url = Some(server.base_url());
        cmd.api_key = Some("rk_live_test".to_string());
        cmd.agent_token = None;

        let output = compute_mcp_args_output(cmd)
            .await
            .expect("register and compute mcp args");

        assert_eq!(
            output.agent_token,
            Some("at_live_register_test_token".to_string())
        );

        let mcp_config_index = output
            .args
            .iter()
            .position(|arg| arg == "--mcp-config")
            .expect("claude --mcp-config arg");
        let config_json = output
            .args
            .get(mcp_config_index + 1)
            .expect("claude mcp config value");

        assert!(config_json.contains("at_live_register_test_token"));
        register_mock.assert();
    }

    #[tokio::test]
    async fn register_does_not_hit_network_when_local_validation_fails() {
        // Locally-invalid input (malformed --existing-args JSON) must fail
        // BEFORE the spawn endpoint is called. A POST /v1/agents/spawn
        // rotates the agent's token, so firing it for a request that was
        // going to fail locally anyway is an unintended external side
        // effect.
        let _env = EnvGuard::all();
        std::env::remove_var("RELAY_API_KEY");
        std::env::remove_var("RELAY_BASE_URL");
        std::env::remove_var("RELAY_AGENT_TOKEN");

        let server = MockServer::start();
        let spawn_mock = server.mock(|when, then| {
            when.method(POST).path("/v1/agents/spawn");
            then.status(200).json_body(json!({
                "ok": true,
                "data": {
                    "id": "agent_should_not_be_called",
                    "name": "test-agent",
                    "token": "at_live_should_not_mint",
                    "cli": "claude",
                    "task": "relay worker session for test-agent",
                    "channel": null,
                    "status": "online",
                    "created_at": "2026-01-01T00:00:00.000Z",
                    "already_existed": false
                }
            }));
        });

        let temp = tempdir().expect("tempdir");
        let mut cmd = command("claude", temp.path());
        cmd.register = true;
        cmd.agent_token = None;
        cmd.api_key = Some("rk_live_test".to_string());
        cmd.base_url = Some(server.base_url());
        cmd.existing_args = Some("{not-json".to_string());

        let error = compute_mcp_args_output(cmd)
            .await
            .expect_err("invalid existing args should abort before register");

        assert!(error
            .to_string()
            .contains("--existing-args must be a JSON array of strings"));
        // The spawn endpoint must NOT have been hit — token rotation is a
        // real side effect on the relaycast backend.
        assert_eq!(spawn_mock.hits(), 0);
    }

    #[tokio::test]
    async fn output_camel_case_includes_agent_token_field() {
        let temp = tempdir().expect("tempdir");
        let output = compute_mcp_args_output(command("claude", temp.path()))
            .await
            .expect("compute mcp args");
        let json = output_as_json(&output);

        assert!(json.get("agentToken").is_some());
        assert_eq!(json.get("agentToken"), Some(&Value::Null));
        assert!(json.get("agent_token").is_none());
    }

    #[tokio::test]
    async fn claude_output_matches_authority_function() {
        let temp = tempdir().expect("tempdir");
        let cmd = command("claude", temp.path());
        let output = compute_mcp_args_output(cmd.clone())
            .await
            .expect("compute mcp args");

        let expected = configure_relaycast_mcp_with_token(
            "claude",
            "test-agent",
            Some("rk_live_test"),
            Some("https://api.test.relaycast.dev"),
            &[],
            &temp.path().canonicalize().unwrap(),
            Some("at_live_test"),
            Some(r#"{"workspaces":[]}"#),
            Some("default-workspace"),
        )
        .await
        .expect("authority mcp args");

        assert_eq!(output.args, expected);
    }

    #[tokio::test]
    async fn codex_output_matches_authority_function() {
        let temp = tempdir().expect("tempdir");
        let cmd = command("codex", temp.path());
        let output = compute_mcp_args_output(cmd.clone())
            .await
            .expect("compute mcp args");

        let expected = configure_relaycast_mcp_with_token(
            "codex",
            "test-agent",
            Some("rk_live_test"),
            Some("https://api.test.relaycast.dev"),
            &[],
            &temp.path().canonicalize().unwrap(),
            Some("at_live_test"),
            Some(r#"{"workspaces":[]}"#),
            Some("default-workspace"),
        )
        .await
        .expect("authority mcp args");

        assert_eq!(output.args, expected);
    }

    #[tokio::test]
    async fn env_vars_fill_in_when_cli_flags_omitted() {
        // When callers set RELAY_* env vars but don't repeat them on the CLI
        // (e.g. cloud's SandboxedStepExecutor, which exports these from
        // orchestrator-managed secrets), compute_mcp_args_output must fall
        // back to the env rather than dropping the value. Mirrors
        // WorkerRegistry::build_mcp_args in the broker.
        //
        // Uses distinctive sentinel values so we can grep them out of the
        // generated config. EnvGuard serializes this test against other
        // RELAY_*-touching tests and restores prior values on drop, so
        // there's no risk of state leaking even on panic.
        let _env = EnvGuard::all();
        std::env::set_var("RELAY_API_KEY", "rk_live_from_env");
        std::env::set_var("RELAY_BASE_URL", "https://api.env.relaycast.dev");
        std::env::set_var("RELAY_AGENT_TOKEN", "at_live_from_env");
        std::env::set_var("RELAY_WORKSPACES_JSON", r#"{"workspaces":["env-ws"]}"#);
        std::env::set_var("RELAY_DEFAULT_WORKSPACE", "env-default-workspace");

        let temp = tempdir().expect("tempdir");
        let cmd = McpArgsCommand {
            cli: "claude".to_string(),
            agent_name: "test-agent".to_string(),
            api_key: None,
            base_url: None,
            agent_token: None,
            register: false,
            workspaces_json: None,
            default_workspace: None,
            cwd: Some(temp.path().to_path_buf()),
            existing_args: None,
        };

        let output = compute_mcp_args_output(cmd)
            .await
            .expect("compute mcp args with env fallback");

        let mcp_config_index = output
            .args
            .iter()
            .position(|arg| arg == "--mcp-config")
            .expect("claude --mcp-config arg");
        let config_json = output
            .args
            .get(mcp_config_index + 1)
            .expect("claude mcp config value");

        // The config is built from the values the compute function resolved,
        // so if env fallback works the sentinel values show up in the env
        // block or the RELAY_API_KEY that claude's injection path writes.
        assert!(
            config_json.contains("https://api.env.relaycast.dev"),
            "base url from env missing in claude config: {config_json}"
        );
        assert!(
            config_json.contains("at_live_from_env"),
            "agent token from env missing in claude config: {config_json}"
        );
        assert!(
            config_json.contains("env-default-workspace"),
            "default workspace from env missing in claude config: {config_json}"
        );
        assert!(
            config_json.contains("env-ws"),
            "workspaces json from env missing in claude config: {config_json}"
        );
    }

    #[tokio::test]
    #[ignore = "requires a gemini executable because the authority shells out to `gemini mcp add`"]
    async fn gemini_output_returns_no_args_and_tracks_trusted_folders_file() {
        let temp = tempdir().expect("tempdir");
        let output = compute_mcp_args_output(command("gemini", temp.path()))
            .await
            .expect("compute mcp args");

        assert!(output.args.is_empty());
        assert!(output
            .side_effect_files
            .iter()
            .any(|path| path.ends_with(".gemini/trustedFolders.json")));
    }

    #[tokio::test]
    #[ignore = "requires a droid executable because the authority shells out to `droid mcp add`"]
    async fn droid_output_returns_no_args_and_no_known_side_effect_files() {
        let temp = tempdir().expect("tempdir");
        let output = compute_mcp_args_output(command("droid", temp.path()))
            .await
            .expect("compute mcp args");

        assert!(output.args.is_empty());
        assert!(output.side_effect_files.is_empty());
    }
}
