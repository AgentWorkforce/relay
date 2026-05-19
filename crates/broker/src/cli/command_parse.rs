use std::{ffi::OsStr, path::Path};

use anyhow::{anyhow, Result};

/// Parse a CLI command string into executable and embedded arguments.
///
/// Supports shell-style quoting, e.g.:
/// - `claude --model haiku`
/// - `codex --profile "my profile"`
pub(crate) fn parse_cli_command(raw: &str) -> Result<(String, Vec<String>)> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("CLI command cannot be empty"));
    }

    let parts = shlex::split(trimmed)
        .ok_or_else(|| anyhow!("invalid CLI command syntax (check quoting)"))?;
    let (command, args) = parts
        .split_first()
        .ok_or_else(|| anyhow!("CLI command cannot be empty"))?;
    let command = command.to_string();
    let mut args = args.to_vec();

    let cli_lower = normalize_cli_name(&command).to_lowercase();
    // "cursor" is an alias for the standalone cursor agent binary ("agent").
    // The cursor shim only accepts "cursor agent [...]", not "cursor --force",
    // so we resolve directly to "agent" to bypass the shim entirely.
    // Also strip the leading "agent" subcommand token if it was present (e.g.
    // "cursor agent --model opus" -> args starts with "agent" which was the
    // shim's routing token, not an argument to the real binary).
    let command = if cli_lower == "cursor" {
        if args.first().map(|s| s.as_str()) == Some("agent") {
            args.remove(0);
        }
        "agent".to_string()
    } else {
        command
    };
    let normalized = normalize_cli_name(&command).to_lowercase();
    if normalized == "agent" || normalized == "cursor-agent" {
        // --approve-mcps: skip the interactive MCP server approval dialog so
        // task injection isn't blocked waiting for user input at startup.
        if !args.iter().any(|arg| arg == "--approve-mcps") {
            args.insert(0, "--approve-mcps".to_string());
        }
        // --force: auto-approve command execution (equivalent to --yolo).
        if !args.iter().any(|arg| arg == "--force") {
            args.insert(0, "--force".to_string());
        }
    }

    Ok((command, args))
}

/// Best-effort normalized CLI name for feature detection.
/// If `cli` is a path, returns the executable file name.
pub(crate) fn normalize_cli_name(cli: &str) -> String {
    Path::new(cli)
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or(cli)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_cli_command_supports_inline_args() {
        let (cli, args) = parse_cli_command("claude --model haiku").unwrap();
        assert_eq!(cli, "claude");
        assert_eq!(args, vec!["--model".to_string(), "haiku".to_string()]);
    }

    #[test]
    fn parse_cli_command_supports_quotes() {
        let (cli, args) = parse_cli_command("codex --profile \"my profile\"").unwrap();
        assert_eq!(cli, "codex");
        assert_eq!(
            args,
            vec!["--profile".to_string(), "my profile".to_string()]
        );
    }

    #[test]
    fn parse_cli_command_rejects_empty() {
        let err = parse_cli_command("   ").unwrap_err().to_string();
        assert!(err.contains("cannot be empty"));
    }

    #[test]
    fn parse_cli_command_maps_cursor_to_agent_with_force_and_approve_mcps() {
        let (cli, args) = parse_cli_command("cursor").unwrap();
        assert_eq!(cli, "agent");
        assert_eq!(
            args,
            vec!["--force".to_string(), "--approve-mcps".to_string()]
        );
    }

    #[test]
    fn parse_cli_command_maps_cursor_agent_to_agent_with_force_and_approve_mcps() {
        let (cli, args) = parse_cli_command("cursor agent --model opus").unwrap();
        assert_eq!(cli, "agent");
        assert_eq!(
            args,
            vec![
                "--force".to_string(),
                "--approve-mcps".to_string(),
                "--model".to_string(),
                "opus".to_string()
            ]
        );
    }

    #[test]
    fn parse_cli_command_dedups_force_and_approve_mcps_for_cursor() {
        let (cli, args) = parse_cli_command("cursor --force --approve-mcps --model opus").unwrap();
        assert_eq!(cli, "agent");
        assert_eq!(
            args,
            vec![
                "--force".to_string(),
                "--approve-mcps".to_string(),
                "--model".to_string(),
                "opus".to_string()
            ]
        );
    }

    #[test]
    fn normalize_cli_name_uses_executable_for_paths() {
        assert_eq!(normalize_cli_name("/usr/local/bin/claude"), "claude");
        assert_eq!(normalize_cli_name("codex"), "codex");
    }
}
