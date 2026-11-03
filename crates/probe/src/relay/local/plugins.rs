//! The plugins `relay serve` runs with on this computer: discovery,
//! injection, the settings extensions, the relay-send socket and the
//! spawner, assembled from the environment.

use super::*;
use std::collections::BTreeMap;

/// The daemon's plugins for this computer: discovery, injection, Claude
/// Code's direct-delivery setting and the relay-send socket.
pub fn plugins(config: &Config) -> Plugins {
    plugins_with(config, None)
}

/// Where this build's agent CLIs keep their settings, when not in this
/// person's own home: a development build's private profiles.
pub struct ClientProfile {
    pub home: PathBuf,
    pub env: BTreeMap<String, String>,
    pub agent_environment: claude::AgentEnvironment,
    /// Whether the profiles are private; nothing else runs when they are not.
    pub safe: bool,
}

/// `plugins`, launching agent CLIs with `agent_environment`.
pub fn plugins_with(
    config: &Config,
    agent_environment: Option<claude::AgentEnvironment>,
) -> Plugins {
    plugins_for(config, agent_environment, None)
}

/// Whether `config` is a development build's.
pub fn is_development(config: &Config) -> bool {
    config
        .app_data_dir
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.ends_with(".dev"))
}

/// This computer's agent configuration for a client home and environment.
pub fn local_config(
    config: &Config,
    client_home: &Path,
    env: &dyn Fn(&str) -> Option<String>,
) -> LocalConfig {
    let mut local = LocalConfig::from_env(env, client_home);
    if is_development(config) {
        local.claude.dirs =
            crate::relay::claude_dirs::ClaudeDirs::development(&config.app_data_dir);
    }
    local
}

/// `plugins_with`, with a build's client `profile`.
pub fn plugins_for(
    config: &Config,
    agent_environment: Option<claude::AgentEnvironment>,
    profile: Option<ClientProfile>,
) -> Plugins {
    plugins_with_options(config, agent_environment, profile, true)
}

/// `plugins_for`; `install_pi_at_start` false (a core `relay init`
/// manages) leaves Pi's folder alone until `pi_extension` is turned on.
pub fn plugins_with_options(
    config: &Config,
    agent_environment: Option<claude::AgentEnvironment>,
    profile: Option<ClientProfile>,
    install_pi_at_start: bool,
) -> Plugins {
    let development = is_development(config);
    let clients = profile;
    let client_home = clients
        .as_ref()
        .map(|clients| &clients.home)
        .unwrap_or(&config.home);
    let client_env = clients
        .as_ref()
        .map(|clients| &clients.env)
        .unwrap_or(&config.env);
    let agent_environment = clients
        .as_ref()
        .map(|clients| clients.agent_environment.clone())
        .or(agent_environment);
    let env = |key: &str| client_env.get(key).cloned();
    let mut local = local_config(config, client_home, &env);
    if clients.as_ref().is_some_and(|clients| !clients.safe) {
        return Plugins::default();
    }
    let pi_setup = Arc::new(crate::relay::pi::setup::PiSetup::new(
        &local.pi,
        install_pi_at_start,
    ));
    let omp_setup = Arc::new(crate::relay::pi::setup::PiSetup::new(
        &local.omp,
        install_pi_at_start,
    ));
    local.spawned_grok = Some(config.app_data_dir.join("spawned-agents/grok"));
    local.existing_grok = enablement::Paths::from_env(&env, &config.app_data_dir);
    // The relay-send (session) socket this core serves: reads, reply hints
    // and Codex's sandbox rules (`stop_hook::SandboxRules`) all name it.
    let relay_send_socket = outbound::default_socket(&env, &config.app_data_dir, local.uid);
    crate::relay::message_pointer::configure(&config.app_data_dir, &relay_send_socket);
    // The journal is this route's dedupe record under app data, created on
    // the first delivery. It is not gated on the probe's Muse directory: a
    // Paseo `muse serve` can be the only Muse store on the machine, and a
    // path here does not create that directory until a message is sent.
    local.existing_muse_journal = local.muse_open.then(|| {
        config
            .app_data_dir
            .join("existing-muse-sessions")
            .join("journal")
    });
    // Actions (injection, launches, stops) read the kernel directly; scans
    // share one time-bounded snapshot over the same table.
    let table: Arc<dyn ProcessTable> = Arc::new(SystemProcesses::default());
    let scans: Arc<dyn ProcessTable> = Arc::new(ProcessSnapshot::new(table.clone()));
    let serving = ServingPath::default();
    let routes = Arc::new(SystemCodexRoutes::new(
        local.codex.clone(),
        table.clone(),
        local.uid,
    ));
    let settings = Arc::new(ClaudeSettings::new(&local.claude));
    // Other Claude logins (`~/.claude-<name>`) follow this one's direct
    // delivery; one added since the last start is brought in line here.
    if !development {
        let settings = settings.clone();
        let _ = std::thread::Builder::new()
            .name("claude-logins".into())
            .spawn(move || {
                let _ = settings.follow_default();
            });
    }
    let grok_settings = Arc::new(GrokSettings::new(&local.grok));
    let opencode_settings = Arc::new(OpenCodeSettings::new(&local.opencode));
    // Agent Relay Dev stages into and drains its own Devin inbox, never
    // production's queue.
    local.devin = local.devin.development(development);
    // The collectors' history catalogs are the delivery surface's only
    // listing of Devin Cloud and Claude Code on the web sessions; each
    // install keeps its own under the probe root. The uploader writes them
    // under the real home, so Dev's private provider profiles never move it.
    local.probe_root = Some(config.home.join(".agentworkforce/probe"));
    // The person's OpenClaw Gateway, reached on loopback; on unless
    // `AGENT_RELAY_ENABLE_OPENCLAW=0`, and listed only while it answers.
    local.openclaw = (!development && env("AGENT_RELAY_ENABLE_OPENCLAW").as_deref() != Some("0"))
        .then(|| {
            crate::relay::openclaw::OpenClawConfig::new(
                client_env,
                client_home,
                &config.app_data_dir,
            )
        });
    // The person's Hermes, through its loopback API; on unless
    // `AGENT_RELAY_ENABLE_HERMES=0`, and listed only while the API answers.
    local.hermes =
        (!development && env("AGENT_RELAY_ENABLE_HERMES").as_deref() != Some("0")).then(|| {
            crate::relay::hermes::HermesConfig::new(client_env, client_home, &config.app_data_dir)
        });
    let trusted_senders = crate::relay::trusted::TrustedSenders::new(&config.app_data_dir);
    if let Some(openclaw) = &mut local.openclaw {
        openclaw.trusted = trusted_senders.clone();
    }
    if let Some(hermes) = &mut local.hermes {
        hermes.trusted = trusted_senders.clone();
    }
    // Devin's lifecycle hooks in ~/.config/devin/config.json drain the
    // inbox deliveries stage into the conversation — the managed route in.
    let devin_settings = Arc::new(devin::DevinSettings::new(
        &local.devin,
        devin::DevinSettings::command_for(
            &std::env::current_exe().unwrap_or_else(|_| PathBuf::from("agent-relay-probe")),
            development,
        ),
    ));
    // Agent Relay Dev stages into and drains its own Cursor inbox too.
    local.cursor = local.cursor.development(development);
    // Agent Relay's Cursor CLI hooks in ~/.cursor/hooks.json hand staged
    // messages to the session at its next tool call or turn end. An
    // installed copy is brought up to date off the start path.
    let cursor_settings = Arc::new(crate::relay::cursor_cli::CursorSettings::new(
        &local.cursor,
        crate::relay::cursor_cli::CursorSettings::command_for(
            &std::env::current_exe().unwrap_or_else(|_| PathBuf::from("agent-relay-probe")),
            development,
        ),
    ));
    {
        let cursor_settings = cursor_settings.clone();
        let _ = std::thread::Builder::new()
            .name("cursor-hooks".into())
            .spawn(move || {
                if let Err(error) = cursor_settings.refresh() {
                    crate::relay::diagnostics::write(format_args!(
                        "cursor: hooks refresh failed: {error}"
                    ));
                }
            });
    }
    // OpenCode processes started from now on load this build's plugin. A
    // copy that cannot be rewritten keeps working as the older version.
    if !development {
        let _ = opencode_settings.refresh_plugin();
    }
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
    // Agent Relay's Codex hook, which hands relayed messages into a running
    // turn (`codex::turn_hook`, its route claims kept beside the store) and
    // shows them in Conductor's Codex chats (`codex::stop_hook`). An
    // installed copy is brought up to date and trusted again off the start
    // path, as that asks Codex's own app-server.
    let stop_hook_inbox = Arc::new(codex::stop_hook::StopHookInbox::with_turns(
        codex::turn_hook::TurnInbox::open(config.app_data_dir.join(codex::turn_hook::RECORD)),
    ));
    // With the hook, Codex rules that let the probe's own client reach this
    // core's session socket from Codex's sandbox (`stop_hook::SandboxRules`).
    let probe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("agent-relay-probe"));
    // Codex matches its rules only against an unquoted program, so while
    // either hook's rules are in place a probe whose path needs quoting is
    // named by a space-free link to it, in the rules and the hints alike.
    let probe_alias = crate::relay::probe_alias::ProbeAlias::system(
        probe.clone(),
        &config.home,
        &config.app_data_dir,
        development,
    );
    let stop_hook_settings = Arc::new(
        codex::stop_hook::CodexStopHookSettings::new(
            local.codex.home.clone(),
            codex::stop_hook::CodexStopHookSettings::command_for(&probe, development),
            local.codex.executable.clone(),
            stop_hook_inbox.clone(),
        )
        .with_sandbox_rules(codex::stop_hook::SandboxRules {
            probe: probe.clone(),
            socket: relay_send_socket.clone(),
        })
        .with_state_dir(config.app_data_dir.clone())
        .with_probe_alias(probe_alias.clone()),
    );
    if !development {
        let stop_hook_settings = stop_hook_settings.clone();
        let _ = std::thread::Builder::new()
            .name("codex-stop-hook".into())
            .spawn(move || stop_hook_settings.refresh());
    } else {
        stop_hook_settings.reconcile_probe_alias();
    }
    // Claude Code SessionStart hook (`claude::session_hook`), on by default
    // after sign-in unless the person chose Off. Its join prompt is shown only
    // for selected-session sharing; an installed copy is brought up to date
    // and copied to a login added since. With the hook, Claude Code rules
    // that let the session run this probe's read and reply commands on this
    // core's session socket without a prompt (`session_hook::PermissionRules`).
    let session_hook_settings = Arc::new(
        claude::session_hook::ClaudeSessionHookSettings::new(
            &local.claude,
            claude::session_hook::ClaudeSessionHookSettings::command_for(&probe, development),
        )
        .with_permission_rules(
            claude::session_hook::PermissionRules {
                probe: probe.clone(),
                socket: relay_send_socket.clone(),
            },
            config.app_data_dir.clone(),
        )
        .with_probe_alias(probe_alias),
    );
    if !development {
        let session_hook_settings = session_hook_settings.clone();
        let _ = std::thread::Builder::new()
            .name("claude-session-hook".into())
            .spawn(move || session_hook_settings.refresh());
    } else {
        session_hook_settings.reconcile_probe_alias();
    }
    // Each harness's adapter, on this computer.
    let harnesses = crate::relay::harness::HarnessContext {
        environment: agent_environment.clone(),
        ..crate::relay::harness::HarnessContext::system(
            client_env,
            client_home,
            &config.app_data_dir,
            table.clone(),
        )
    };
    let spawner = Arc::new(crate::relay::spawn::launch::RegistrySpawner(
        crate::relay::harness::Registry::builtin(&harnesses),
    ));
    // Trusted senders apply to OpenClaw and Hermes alike; shown while
    // either is set up.
    let trusted = {
        let (openclaw, hermes) = (local.openclaw.clone(), local.hermes.clone());
        Arc::new(crate::relay::trusted::TrustedSettings::new(
            trusted_senders,
            move || {
                openclaw.as_ref().is_some_and(|c| c.installed())
                    || hermes.as_ref().is_some_and(|c| c.installed())
            },
        ))
    };

    // Agent Relay's tools for OpenClaw agents, signed in from Settings; the
    // OpenClaw setting serves them (`SettingsExtension::openclaw_tools`).
    let openclaw_tools = local.openclaw.as_ref().map(|openclaw| {
        Arc::new(crate::relay::openclaw::relay_tools::RelayTools::system(
            openclaw,
            table.clone(),
            local.uid,
            client_home,
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
        sessions: Arc::new(
            LocalSessions::new(local.clone(), table.clone())
                .with_scans(scans.clone())
                .with_managed(managed),
        ),
        settings: {
            let mut extensions: Vec<Arc<dyn crate::relay::agents::SettingsExtension>> =
                if development {
                    vec![settings.clone()]
                } else {
                    vec![
                        settings.clone(),
                        pi_setup,
                        omp_setup,
                        grok_settings,
                        opencode_settings,
                        devin_settings,
                        cursor_settings,
                        stop_hook_settings,
                        session_hook_settings,
                    ]
                };
            if let Some(openclaw) = &local.openclaw {
                extensions.push(Arc::new(
                    crate::relay::openclaw::OpenClawSettings::new(openclaw)
                        .with_tools(openclaw_tools.clone()),
                ));
            }
            if let Some(hermes) = &local.hermes {
                extensions.push(Arc::new(crate::relay::hermes::HermesSettings::new(hermes)));
            }
            extensions.push(trusted.clone());
            extensions
        },
        trusted: Some(trusted),
        codex_stop_hook: Some(stop_hook_inbox),
        relay_send: Some(RelaySend {
            socket: relay_send_socket,
            pointer: outbound::pointer_path(&config.home, &config.app_data_dir),
            direct_delivery: settings,
            serving,
            agent_led_defaults_at_start: false,
        }),
        spawner,
        processes: scans,
        ..Plugins::default()
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::relay::paths::CorePaths;
    use std::time::Duration;

    fn config(home: &Path) -> Config {
        Config {
            paths: CorePaths::for_socket(home.join("core.sock")).unwrap(),
            home: home.to_path_buf(),
            app_data_dir: home.join("app-data"),
            env: [
                ("AGENT_RELAY_ENABLE_OPENCLAW", "0"),
                ("AGENT_RELAY_ENABLE_HERMES", "0"),
            ]
            .into_iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect(),
            version: "0.0.0-test".into(),
            host_name: "Test Desk.local".into(),
            rediscover_every: Duration::from_secs(3600),
            push_timing: Default::default(),
            delivery_timing: Default::default(),
        }
    }

    #[test]
    fn a_cli_managed_start_leaves_pis_folder_alone_and_the_desktop_installs() {
        let home = tempfile::tempdir().unwrap();
        let agent_dir = home.path().join(".pi/agent");
        std::fs::create_dir_all(&agent_dir).unwrap();

        let managed = plugins_with_options(&config(home.path()), None, None, false);
        assert!(!agent_dir.join("extensions").exists());
        let pi_extension = managed
            .settings
            .iter()
            .find_map(|s| s.get().get("pi_extension").cloned());
        assert_eq!(pi_extension, Some(serde_json::Value::Bool(false)));

        plugins_with(&config(home.path()), None);
        assert!(agent_dir.join("extensions/agent-relay.js").is_file());
    }
}
