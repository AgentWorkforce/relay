use super::*;

impl BrokerRuntime {
    /// Drain a workspace-firehose event for the broker runtime.
    ///
    /// Message delivery is now node-only: messages flow over /v1/node/ws and are
    /// injected by `handle_fleet_deliver`. The workspace-stream firehose no longer
    /// drives delivery, so this handler only logs and discards whatever still
    /// arrives over `ws_inbound_rx` (connection/channel-join status frames and any
    /// residual control events). Spawn/release are owned by node control via
    /// `spawn_worker_from_request` / `release_worker_locally`.
    pub(super) async fn handle_relaycast_message(&mut self, ws_msg: WorkspaceInboundMessage) {
        let workspace_id = ws_msg.workspace_id.clone();
        let ws_value = ws_msg.value;
        let ws_type = ws_value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("<unknown>");
        tracing::debug!(
            target = "agent_relay::broker",
            ws_type = %ws_type,
            workspace_id = %workspace_id,
            "ignoring workspace-stream event; delivery is node-only"
        );
    }
}

fn relaycast_harness_config(value: &Value) -> Result<Option<ResolvedHarnessConfig>, String> {
    let agent = value.get("agent");
    let harness_id = agent
        .and_then(|agent| {
            agent
                .get("harnessId")
                .or_else(|| agent.get("harness_id"))
                .and_then(Value::as_str)
        })
        .or_else(|| {
            value
                .get("harnessId")
                .or_else(|| value.get("harness_id"))
                .and_then(Value::as_str)
        })
        .map(str::trim)
        .filter(|id| !id.is_empty());
    if harness_id.is_some() {
        return Err(
            "harnessId is not supported by Relaycast spawns; send harnessConfig".to_string(),
        );
    }

    let raw = agent
        .and_then(|agent| {
            agent
                .get("harnessConfig")
                .or_else(|| agent.get("harness_config"))
        })
        .or_else(|| {
            value
                .get("harnessConfig")
                .or_else(|| value.get("harness_config"))
        });

    match raw {
        Some(config) => serde_json::from_value::<ResolvedHarnessConfig>(config.clone())
            .map(Some)
            .map_err(|error| format!("Invalid harnessConfig: {error}")),
        None => Ok(None),
    }
}

/// Release a worker that the fleet/node control plane asked the broker to drop.
///
/// Extracted verbatim from the former `WsEvent::AgentReleaseRequested` firehose
/// arm. The v5.0.1 SDK removed that event variant; node control invokes this
/// directly via `action.invoke`. `workspace_state` supplies the per-workspace
/// HTTP client, self-name set, and WS control channel the original arm captured.
#[allow(clippy::too_many_arguments)]
pub(super) async fn release_worker_locally(
    name: WorkerName,
    workspace_state: &RelayWorkspace,
    workers: &mut WorkerRegistry,
    state: &mut broker::BrokerState,
    paths: &RuntimePaths,
    telemetry: &TelemetryClient,
    sdk_out_tx: &mpsc::Sender<ProtocolEnvelope<Value>>,
    pending_deliveries: &mut HashMap<DeliveryId, PendingDelivery>,
    pending_requests: &mut HashMap<String, worker_request::PendingRequest>,
    delivery_states: &mut HashMap<WorkerName, InboundDeliveryState>,
    agent_result_tokens: &mut HashMap<String, WorkerName>,
) {
    let workspace_http = &workspace_state.http_client;
    if is_relaycast_self_control_target(
        &name,
        &workspace_state.self_name,
        &workspace_state.self_names,
    ) {
        workspace_http.forget_agent_registration(&name);
        tracing::debug!(
            worker = %name,
            "ignoring relaycast release request for broker self"
        );
        return;
    }
    workers.supervisor.unregister(&name);
    workers.metrics.on_release(&name);
    match workers.release(&name).await {
        Ok(()) => {
            workspace_http.forget_agent_registration(&name);
            let dropped = take_pending_for_worker(pending_deliveries, &name);
            if !dropped.is_empty() {
                let _ = send_event(
                                sdk_out_tx,
                                json!({"kind":"delivery_dropped","name":name,"count":dropped.len(),"reason":"agent_released"}),
                            ).await;
                let _ = emit_dropped_delivery_failures(sdk_out_tx, &dropped, "agent_released").await;
            }
            fail_pending_requests_for_worker(pending_requests, &name, "relaycast_release");
            delivery_states.remove(&name);
            agent_result_tokens.retain(|_, agent| agent != &name);
            telemetry.track(TelemetryEvent::AgentRelease {
                cli: String::new(),
                release_reason: "relaycast_release".to_string(),
                lifetime_seconds: 0,
                release_source: ActionSource::Protocol,
            });
            state.agents.remove(&name);
            if paths.persist {
                if let Err(error) = state.save(&paths.state) {
                    tracing::warn!(path = %paths.state.display(), error = %error, "failed to persist broker state");
                }
            }
            let _ = send_event(sdk_out_tx, json!({"kind":"agent_released","name":name})).await;
            publish_agent_state_transition(
                &workspace_state.ws_control_tx,
                &name,
                "exited",
                Some("relaycast_release"),
            )
            .await;
            tracing::info!(child = %name, "released worker via relaycast in broker mode");
            eprintln!("[agent-relay] released worker '{}' via relaycast", name);
        }
        Err(error) => {
            let message = error.to_string();
            if is_unknown_worker_error_message(&message) {
                workspace_http.forget_agent_registration(&name);
                state.agents.remove(&name);
                if paths.persist {
                    if let Err(save_error) = state.save(&paths.state) {
                        tracing::warn!(
                            path = %paths.state.display(),
                            error = %save_error,
                            "failed to persist broker state"
                        );
                    }
                }
                tracing::debug!(
                    child = %name,
                    "ignoring duplicate relaycast release for already exited worker"
                );
            } else {
                tracing::error!(child = %name, error = %error, "failed to release worker via relaycast");
                eprintln!("[agent-relay] failed to release '{}': {}", name, error);
            }
        }
    }
}

/// Spawn a worker the fleet/node control plane requested.
///
/// Extracted verbatim from the former `WsEvent::AgentSpawnRequested` firehose
/// arm. The v5.0.1 SDK removed that event variant; node control invokes this
/// directly via `action.invoke`. The spawn fields (`cli`, `task`, `channel`,
/// `model`) previously came off the typed event payload and are now passed in;
/// `ws_value` is retained for `harnessConfig`/token extraction exactly as
/// before. `control_dedup_key` carries the firehose control dedup key so the
/// local spawn-echo dedup behaves identically.
#[allow(clippy::too_many_arguments)]
pub(super) async fn spawn_worker_from_request(
    name: WorkerName,
    cli: String,
    task: Option<String>,
    channel: Option<String>,
    model: Option<String>,
    ws_value: &Value,
    workspace_id: &WorkspaceId,
    control_dedup_key: Option<&str>,
    workspace_state: &RelayWorkspace,
    workers: &mut WorkerRegistry,
    state: &mut broker::BrokerState,
    paths: &RuntimePaths,
    telemetry: &TelemetryClient,
    sdk_out_tx: &mpsc::Sender<ProtocolEnvelope<Value>>,
    dedup: &mut DedupCache,
    agent_spawn_count: &mut u32,
    fleet_control_tx: &mpsc::Sender<FleetControlCommand>,
) {
    let workspace_http = &workspace_state.http_client;
    eprintln!(
        "[agent-relay] received spawn request for '{}' (cli: {})",
        name, cli
    );
    if is_relaycast_self_control_target(
        &name,
        &workspace_state.self_name,
        &workspace_state.self_names,
    ) {
        tracing::debug!(
            worker = %name,
            "ignoring relaycast spawn request for broker self"
        );
        eprintln!(
            "[agent-relay] ignoring spawn request for '{}' (broker self)",
            name
        );
        return;
    }
    let local_spawn_echo_key = relaycast_spawn_control_dedup_key(workspace_id, &name);
    if relaycast_ws_should_apply_local_spawn_echo_dedup(control_dedup_key, &local_spawn_echo_key)
        && !dedup.insert_if_new(&local_spawn_echo_key, Instant::now())
    {
        tracing::info!(
            worker = %name,
            workspace_id = %workspace_id,
            "dropping duplicate/local relaycast spawn request"
        );
        eprintln!(
            "[agent-relay] dropping duplicate spawn request for '{}'",
            name
        );
        return;
    }
    let task = task.filter(|value| !value.trim().is_empty());
    // Carry the requested model through so the launched CLI is
    // started with `--model` (see worker.rs). An empty/blank
    // model is treated as unset.
    let model = model.filter(|value| !value.trim().is_empty());
    let harness_config = match relaycast_harness_config(ws_value) {
        Ok(config) => config,
        Err(error) => {
            tracing::warn!(
                worker = %name,
                error = %error,
                "rejecting relaycast spawn with invalid harness config"
            );
            eprintln!(
                "[agent-relay] rejecting spawn request for '{}': {}",
                name, error
            );
            return;
        }
    };
    let runtime = harness_config
        .as_ref()
        .map(ResolvedHarnessConfig::runtime)
        .unwrap_or(AgentRuntime::Pty);
    let session_id = harness_config
        .as_ref()
        .and_then(ResolvedHarnessConfig::session_id)
        .map(ToOwned::to_owned);

    tracing::info!(name = %name, cli = %cli, task = ?task, channel = ?channel, "handling spawn request from relaycast WS");
    let channels = channel
        .as_deref()
        .map(|ch| {
            let mut chs = default_spawn_channels();
            let candidate = ChannelName::from(ch);
            if !chs.contains(&candidate) {
                chs.push(candidate);
            }
            chs
        })
        .unwrap_or_else(default_spawn_channels);
    let spec = AgentSpec {
        name: name.clone(),
        runtime: runtime.clone(),
        provider: None,
        cli: Some(cli.clone()),
        session_id,
        harness_config,
        model,
        cwd: None,
        team: None,
        shadow_of: None,
        shadow_mode: None,
        args: vec![],
        channels: channels.clone(),
        restart_policy: None,
    };
    let mut effective_task = normalize_initial_task(task.clone());

    // Pre-register an agent token for every spawned worker.
    // The Agent Relay MCP server needs RELAY_AGENT_TOKEN +
    // RELAY_SKIP_BOOTSTRAP=1 in its environment to expose
    // tools immediately; otherwise it runs network
    // registration before responding to the MCP initialize
    // handshake, the client drops the pending server, and
    // no relaycast tool names land in deferred_tools. The
    // short timeout keeps spawn latency bounded while still
    // giving the registration call a real chance.
    // Bind the agent to this node via node-control `agent.register` — the same
    // step the HTTP `/api/spawn` path converges on — so the agent is born
    // `via_node`-bound and delivery flows over /v1/node/ws. The minted token is
    // injected as RELAY_AGENT_TOKEN (which also sets RELAY_SKIP_BOOTSTRAP), so
    // the worker MCP never re-registers over HTTP. Falls back to HTTP
    // pre-registration when node binding is unavailable.
    let worker_relay_key = {
        if let Some(token) = relaycast_ws_spawn_token(ws_value) {
            seed_supplied_agent_token(workspace_http, &name, &token);
            Some(token)
        } else {
            match super::fleet::register_node_agent_token(
                fleet_control_tx,
                name.as_str(),
                None,
                None,
            )
            .await
            {
                Ok(token) => {
                    tracing::info!(
                        worker = %name,
                        "bound agent to node via agent.register for action.invoke spawn"
                    );
                    Some(token.token)
                }
                Err(node_error) => {
                    tracing::warn!(
                        worker = %name,
                        error = %node_error,
                        "node agent.register unavailable; falling back to HTTP pre-registration"
                    );
                    const REG_TIMEOUT: Duration = Duration::from_secs(3);
                    match tokio::time::timeout(
                        REG_TIMEOUT,
                        workspace_http.register_agent_token(&name, Some(cli.as_str())),
                    )
                    .await
                    {
                        Ok(Ok(token)) => {
                            tracing::info!(
                                worker = %name,
                                "pre-registered agent via broker for WS spawn"
                            );
                            Some(token)
                        }
                        Ok(Err(error)) => {
                            tracing::warn!(
                                worker = %name,
                                error = %error,
                                "WS spawn pre-registration failed; agent will self-register"
                            );
                            None
                        }
                        Err(_) => {
                            tracing::warn!(
                                worker = %name,
                                "WS spawn pre-registration timed out (3s); agent will self-register"
                            );
                            None
                        }
                    }
                }
            }
        }
    };

    match workers
        .spawn(
            spec,
            Some("Relaycast".to_string()),
            None,
            worker_relay_key.clone(),
            false,
            Some(workspace_id.clone()),
            None,
        )
        .await
    {
        Ok(effective_spec) => {
            if let Some(prefix) = super::api::relay_skill_prefix(
                effective_spec.cli.as_deref().unwrap_or(&cli),
                effective_spec.model.as_deref(),
            ) {
                effective_task = Some(match effective_task {
                    Some(task) => format!("{prefix}\n\n{task}"),
                    None => prefix,
                });
                tracing::debug!(
                    agent = %name,
                    cli = %effective_spec.cli.as_deref().unwrap_or(&cli),
                    model = ?effective_spec.model,
                    "injected relay skill prefix for Relaycast spawn"
                );
            }
            if let Some(ref task_text) = effective_task {
                workers
                    .initial_tasks
                    .insert(name.clone(), task_text.clone());
            }
            *agent_spawn_count += 1;
            telemetry.track(TelemetryEvent::AgentSpawn {
                cli: cli.clone(),
                runtime: runtime_label(&effective_spec.runtime).to_string(),
                spawn_source: ActionSource::Protocol,
                has_task: effective_task.is_some(),
                is_shadow: false,
            });
            let pid = workers.harness_pid(&name);
            state.agents.insert(
                name.clone(),
                broker::PersistedAgent {
                    runtime: effective_spec.runtime.clone(),
                    parent: Some("Relaycast".to_string()),
                    channels,
                    pid: workers.worker_pid(&name),
                    started_at: Some(
                        std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_secs(),
                    ),
                    spec: Some(effective_spec.clone()),
                    restart_policy: None,
                    initial_task: effective_task,
                },
            );
            if paths.persist {
                let _ = state.save(&paths.state);
            }
            let _ = send_event(
                sdk_out_tx,
                json!({
                    "kind": "agent_spawned",
                    "name": name,
                    "runtime": runtime_label(&effective_spec.runtime),
                    "cli": cli,
                    "model": effective_spec.model.clone(),
                    "sessionId": effective_spec.session_id.clone(),
                    "pid": pid,
                    "source": "relaycast_ws",
                    "pre_registered": worker_relay_key.is_some(),
                }),
            )
            .await;
            publish_agent_state_transition(
                &workspace_state.ws_control_tx,
                &name,
                "spawned",
                Some("relaycast_spawn"),
            )
            .await;
            tracing::info!(child = %name, pid = ?pid, "spawned worker via relaycast WS");
            eprintln!("[agent-relay] spawned worker '{}' via relaycast", name);
        }
        Err(e) => {
            let msg = e.to_string();
            if msg.contains("already exists") {
                tracing::debug!(child = %name, "agent already spawned via SDK, skipping duplicate relaycast WS spawn");
            } else {
                tracing::error!(child = %name, error = %e, "failed to spawn worker via relaycast WS");
                eprintln!("[agent-relay] failed to spawn '{}': {}", name, e);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ::relaycast::WsEvent;

    #[test]
    fn relaycast_harness_config_accepts_inline_config() {
        let value = json!({
            "type": "agent.spawn_requested",
            "agent": {
                "name": "ClaudeReviewer",
                "cli": "company-claude",
                "harnessConfig": {
                    "runtime": "pty",
                    "command": "claude",
                    "args": []
                }
            }
        });

        let config = relaycast_harness_config(&value)
            .expect("inline config should parse")
            .expect("inline config should return config");

        assert_eq!(config.runtime(), AgentRuntime::Pty);
    }

    #[test]
    fn relaycast_harness_config_rejects_harness_id() {
        let value = json!({
            "type": "agent.spawn_requested",
            "agent": {
                "name": "ClaudeReviewer",
                "cli": "company-claude",
                "harnessId": "company-claude"
            }
        });

        let error = relaycast_harness_config(&value).expect_err("harnessId should fail");

        assert!(error.contains("harnessId is not supported"));
    }

    /// Regression guard for the v5.0.1 firehose control path.
    ///
    /// In relaycast v5 `WsEvent` ends in `#[serde(other)] Unknown`, so an
    /// `agent.spawn_requested` frame deserializes to `Ok(WsEvent::Unknown)`
    /// rather than `Err`. The former firehose handler gated its raw-JSON spawn
    /// fallback on `from_value::<WsEvent>(..).is_ok()`, which is now always true
    /// — making that fallback dead code. This test pins the deserialization
    /// behavior so the dispatch in `handle_relaycast_message` must classify
    /// these control events by `ws_type`, not by `WsEvent` decode success.
    #[test]
    fn spawn_requested_frame_deserializes_to_unknown_not_err() {
        let value = json!({
            "type": "agent.spawn_requested",
            "agent": { "name": "ClaudeReviewer", "cli": "claude" }
        });

        let decoded: Result<WsEvent, _> = serde_json::from_value(value);
        assert!(
            matches!(decoded, Ok(WsEvent::Unknown)),
            "v5 must decode agent.spawn_requested as Unknown; got {decoded:?}"
        );
    }

    /// The release control event likewise falls into the catch-all variant in
    /// v5, confirming both control types are owned by node control (via
    /// `action.invoke`) and intentionally ignored on the workspace firehose.
    #[test]
    fn release_requested_frame_deserializes_to_unknown_not_err() {
        let value = json!({
            "type": "agent.release_requested",
            "agent": { "name": "ClaudeReviewer" }
        });

        let decoded: Result<WsEvent, _> = serde_json::from_value(value);
        assert!(
            matches!(decoded, Ok(WsEvent::Unknown)),
            "v5 must decode agent.release_requested as Unknown; got {decoded:?}"
        );
    }
}
