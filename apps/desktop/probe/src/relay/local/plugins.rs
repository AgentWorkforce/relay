//! The plugins `relay serve` runs with on this computer: discovery,
//! injection, the settings extensions, the relay-send socket and the
//! spawner, assembled from the environment.

use super::*;

/// The daemon's plugins for this computer: discovery, injection, Claude
/// Code's direct-delivery setting and the relay-send socket.
pub fn plugins(config: &Config) -> Plugins {
    plugins_with(config, None)
}

/// `plugins`, launching agent CLIs with `agent_environment`.
pub fn plugins_with(
    config: &Config,
    agent_environment: Option<claude::AgentEnvironment>,
) -> Plugins {
    let env = |key: &str| config.env.get(key).cloned();
    let mut local = LocalConfig::from_env(&env, &config.home);
    let pi_setup = Arc::new(crate::relay::pi::setup::PiSetup::new(&local.pi));
    local.spawned_grok = Some(config.app_data_dir.join("spawned-agents/grok"));
    local.existing_grok = enablement::Paths::from_env(&env, &config.app_data_dir);
    crate::relay::message_pointer::configure(&config.app_data_dir);
    // The journal is the Relay-owned Muse route's dedupe record under app
    // data, created on the first delivery.
    local.muse_spawn_journal = local.muse_spawn.then(|| {
        config
            .app_data_dir
            .join("spawned-muse-sessions")
            .join("journal")
    });
    let table: Arc<dyn ProcessTable> = Arc::new(SystemProcesses::default());
    let serving = ServingPath::default();
    let routes = Arc::new(SystemCodexRoutes::new(
        local.codex.clone(),
        table.clone(),
        local.uid,
    ));
    let settings = Arc::new(ClaudeSettings::new(&local.claude));
    // Other Claude logins (`~/.claude-<name>`) follow this one's direct
    // delivery; one added since the last start is brought in line here.
    {
        let settings = settings.clone();
        let _ = std::thread::Builder::new()
            .name("claude-logins".into())
            .spawn(move || {
                let _ = settings.follow_default();
            });
    }
    let grok_settings = Arc::new(GrokSettings::new(&local.grok));
    let opencode_settings = Arc::new(OpenCodeSettings::new(&local.opencode));
    let development = config
        .app_data_dir
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.ends_with(".dev"));
    // Agent Relay Dev stages into and drains its own Devin inbox, never
    // production's queue.
    local.devin = local.devin.development(development);
    // The collectors' history catalogs are the delivery surface's only
    // listing of Devin Cloud sessions; each install keeps its own under
    // the probe root.
    local.devin_probe_root = Some(config.home.join(".agentworkforce/probe"));
    // The person's OpenClaw Gateway, reached on loopback; on unless
    // `AGENT_RELAY_ENABLE_OPENCLAW=0`, and listed only while it answers.
    local.openclaw = (env("AGENT_RELAY_ENABLE_OPENCLAW").as_deref() != Some("0")).then(|| {
        crate::relay::openclaw::OpenClawConfig::new(&config.env, &config.home, &config.app_data_dir)
    });
    // The person's Hermes, through its loopback API; on unless
    // `AGENT_RELAY_ENABLE_HERMES=0`, and listed only while the API answers.
    local.hermes = (env("AGENT_RELAY_ENABLE_HERMES").as_deref() != Some("0")).then(|| {
        crate::relay::hermes::HermesConfig::new(&config.env, &config.home, &config.app_data_dir)
    });
    // Devin's lifecycle hooks in ~/.config/devin/config.json drain the
    // inbox deliveries stage into the conversation — the managed route in.
    let devin_settings = Arc::new(devin::DevinSettings::new(
        &local.devin,
        devin::DevinSettings::command_for(
            &std::env::current_exe().unwrap_or_else(|_| PathBuf::from("agent-relay-probe")),
            development,
        ),
    ));
    // OpenCode processes started from now on load this build's plugin. A
    // copy that cannot be rewritten keeps working as the older version.
    let _ = opencode_settings.refresh_plugin();
    local.opencode_open_journal = local.opencode_open.then(|| {
        config
            .app_data_dir
            .join("existing-opencode-sessions")
            .join("journal")
    });
    let managed = Arc::new(ManagedSessions::system(
        &config.app_data_dir,
        table.clone(),
        &env,
        agent_environment.clone(),
    ));
    // Agent Relay's Codex Stop hook, which shows relayed messages in
    // Conductor's Codex chats (`codex::stop_hook`). An installed copy is
    // brought up to date and trusted again off the start path, as that asks
    // Codex's own app-server.
    let stop_hook_inbox = Arc::new(codex::stop_hook::StopHookInbox::default());
    let stop_hook_settings = Arc::new(codex::stop_hook::CodexStopHookSettings::new(
        local.codex.home.clone(),
        crate::relay::conductor::data_dir(&config.home),
        codex::stop_hook::CodexStopHookSettings::command_for(
            &std::env::current_exe().unwrap_or_else(|_| PathBuf::from("agent-relay-probe")),
            development,
        ),
        stop_hook_inbox.clone(),
    ));
    {
        let stop_hook_settings = stop_hook_settings.clone();
        let _ = std::thread::Builder::new()
            .name("codex-stop-hook".into())
            .spawn(move || stop_hook_settings.refresh());
    }
    // Optional Claude Code SessionStart hook (`claude::session_hook`). Off
    // unless the person turns it on; an installed copy is brought up to date
    // and copied to a login added since.
    let session_hook_settings = Arc::new(claude::session_hook::ClaudeSessionHookSettings::new(
        &local.claude,
        claude::session_hook::ClaudeSessionHookSettings::command_for(
            &std::env::current_exe().unwrap_or_else(|_| PathBuf::from("agent-relay-probe")),
            development,
        ),
    ));
    {
        let session_hook_settings = session_hook_settings.clone();
        let _ = std::thread::Builder::new()
            .name("claude-session-hook".into())
            .spawn(move || session_hook_settings.refresh());
    }
    // Each harness's adapter, on this computer.
    let harnesses = crate::relay::harness::HarnessContext {
        environment: agent_environment.clone(),
        ..crate::relay::harness::HarnessContext::system(
            &config.env,
            &config.home,
            &config.app_data_dir,
            table.clone(),
        )
    };
    let spawner = Arc::new(crate::relay::spawn::launch::RegistrySpawner(
        crate::relay::harness::Registry::builtin(&harnesses),
    ));
    // Agent Relay's tools for OpenClaw agents, signed in from Settings; the
    // OpenClaw setting serves them (`SettingsExtension::openclaw_tools`).
    let openclaw_tools = local.openclaw.as_ref().map(|openclaw| {
        Arc::new(crate::relay::openclaw::relay_tools::RelayTools::system(
            openclaw,
            table.clone(),
            local.uid,
            &config.home,
        ))
    });
    Plugins {
        injector: Arc::new(
            LocalInjector::new(
                local.clone(),
                table.clone(),
                CodexRouter::new(routes).with_stop_hook(stop_hook_inbox.clone()),
                serving.clone(),
            )
            .with_managed(managed.clone())
            .with_agent_environment(agent_environment),
        ),
        sessions: Arc::new(LocalSessions::new(local.clone(), table).with_managed(managed)),
        settings: {
            let mut extensions: Vec<Arc<dyn crate::relay::agents::SettingsExtension>> = vec![
                settings.clone(),
                pi_setup,
                grok_settings,
                opencode_settings,
                devin_settings,
                stop_hook_settings,
                session_hook_settings,
            ];
            if let Some(openclaw) = &local.openclaw {
                extensions.push(Arc::new(
                    crate::relay::openclaw::OpenClawSettings::new(openclaw)
                        .with_tools(openclaw_tools.clone()),
                ));
            }
            if let Some(hermes) = &local.hermes {
                extensions.push(Arc::new(crate::relay::hermes::HermesSettings::new(hermes)));
            }
            // Trusted senders apply to OpenClaw and Hermes alike; shown while
            // either is set up.
            let (openclaw, hermes) = (local.openclaw.clone(), local.hermes.clone());
            extensions.push(Arc::new(crate::relay::trusted::TrustedSettings::new(
                crate::relay::trusted::TrustedSenders::new(&config.app_data_dir),
                move || {
                    openclaw.as_ref().is_some_and(|c| c.installed())
                        || hermes.as_ref().is_some_and(|c| c.installed())
                },
            )));
            extensions
        },
        codex_stop_hook: Some(stop_hook_inbox),
        relay_send: Some(RelaySend {
            socket: outbound::default_socket(&env, &config.app_data_dir, local.uid),
            pointer: outbound::pointer_path(&config.home, &config.app_data_dir),
            direct_delivery: settings,
            serving,
            agent_led_defaults_at_start: false,
        }),
        spawner,
        ..Plugins::default()
    }
}
