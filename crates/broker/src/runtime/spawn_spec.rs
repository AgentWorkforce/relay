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
    harness_plan: Option<ResolvedHarnessPlan>,
) -> Result<AgentSpec> {
    let requested_runtime = match transport
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
    let harness_runtime = harness_plan.as_ref().map(ResolvedHarnessPlan::runtime);
    let runtime = match (
        transport
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty()),
        harness_runtime,
    ) {
        (None, Some(harness_runtime)) => harness_runtime,
        (_, Some(harness_runtime)) if harness_runtime == requested_runtime => requested_runtime,
        (_, Some(harness_runtime)) => {
            anyhow::bail!(
                "harnessPlan runtime '{}' does not match requested transport '{}'",
                runtime_label(&harness_runtime),
                runtime_label(&requested_runtime)
            )
        }
        (_, None) => requested_runtime,
    };
    let parsed_restart_policy = match restart_policy {
        Some(v) => Some(serde_json::from_value(v).context("invalid restart_policy")?),
        None => None,
    };

    let (provider, cli_command, model) = match runtime {
        AgentRuntime::Pty => (None, Some(cli), model),
        AgentRuntime::Headless => match harness_plan.as_ref() {
            Some(ResolvedHarnessPlan::Headless(_)) => (None, Some(cli), model),
            _ => {
                let provider = headless_provider_from_cli(&cli).with_context(|| {
                    format!(
                        "provider '{cli}' does not support headless transport (supported: claude, opencode)"
                    )
                })?;
                (Some(provider), None, model)
            }
        },
    };
    let session_id = harness_plan
        .as_ref()
        .and_then(ResolvedHarnessPlan::session_id)
        .map(ToOwned::to_owned);

    Ok(AgentSpec {
        name,
        runtime,
        provider,
        cli: cli_command,
        session_id,
        harness_plan,
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
