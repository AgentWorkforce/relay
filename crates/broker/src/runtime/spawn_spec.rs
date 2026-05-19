use super::*;

pub(crate) fn runtime_label(runtime: &AgentRuntime) -> &'static str {
    match runtime {
        AgentRuntime::Pty => "pty",
        AgentRuntime::Headless => "headless",
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn build_http_api_spawn_spec(
    name: String,
    cli: String,
    transport: Option<String>,
    model: Option<String>,
    args: Vec<String>,
    channels: Vec<String>,
    cwd: Option<String>,
    team: Option<String>,
    shadow_of: Option<String>,
    shadow_mode: Option<String>,
    restart_policy: Option<Value>,
) -> Result<AgentSpec> {
    let runtime = match transport
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_ascii_lowercase())
    {
        None => AgentRuntime::Pty,
        Some(value) if value == "pty" => AgentRuntime::Pty,
        Some(value) if value == "headless" => AgentRuntime::Headless,
        Some(other) => {
            anyhow::bail!("unsupported transport '{other}' (expected 'pty' or 'headless')")
        }
    };
    let parsed_restart_policy = match restart_policy {
        Some(v) => Some(serde_json::from_value(v).context("invalid restart_policy")?),
        None => None,
    };

    let (provider, cli_command, model) = match runtime {
        AgentRuntime::Pty => (None, Some(cli), model),
        AgentRuntime::Headless => {
            let provider = headless_provider_from_cli(&cli).with_context(|| {
                format!(
                    "provider '{cli}' does not support headless transport (supported: claude, opencode)"
                )
            })?;
            (Some(provider), None, model)
        }
    };

    Ok(AgentSpec {
        name,
        runtime,
        provider,
        cli: cli_command,
        model,
        cwd,
        team,
        shadow_of,
        shadow_mode,
        args,
        channels,
        restart_policy: parsed_restart_policy,
    })
}
