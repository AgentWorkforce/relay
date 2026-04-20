use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use relay_broker::snippets::configure_relaycast_mcp_with_token;
use serde::{Deserialize, Serialize};

use crate::McpArgsCommand;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct McpArgsOutput {
    args: Vec<String>,
    side_effect_files: Vec<PathBuf>,
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

    let api_key = cmd.api_key.or_else(|| std::env::var("RELAY_API_KEY").ok());
    let base_url = cmd
        .base_url
        .or_else(|| std::env::var("RELAY_BASE_URL").ok());
    let cwd = normalize_cwd(cmd.cwd)?;
    let existing_args = parse_existing_args(cmd.existing_args)?;

    let args = configure_relaycast_mcp_with_token(
        &cli,
        &agent_name,
        api_key.as_deref(),
        base_url.as_deref(),
        &existing_args,
        &cwd,
        cmd.agent_token.as_deref(),
        cmd.workspaces_json.as_deref(),
        cmd.default_workspace.as_deref(),
    )
    .await?;

    let side_effect_files = side_effect_files_for(&cli, &existing_args, &cwd)?;

    Ok(McpArgsOutput {
        args,
        side_effect_files,
    })
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
    use relay_broker::snippets::configure_relaycast_mcp_with_token;
    use serde_json::Value;
    use tempfile::tempdir;

    use super::*;

    fn command(cli: &str, cwd: &Path) -> McpArgsCommand {
        McpArgsCommand {
            cli: cli.to_string(),
            agent_name: "test-agent".to_string(),
            api_key: Some("rk_live_test".to_string()),
            base_url: Some("https://api.test.relaycast.dev".to_string()),
            agent_token: Some("at_live_test".to_string()),
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
        assert!(json.get("side_effect_files").is_none());
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
