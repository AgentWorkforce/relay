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

/// Derive the initial session ref for a spawn request from its `ws_value`.
///
/// Fleet CLI/API callers send `session_ref` as a top-level action input, while
/// older firehose-style payloads may carry it under `agent` or in
/// `harnessConfig.session_id`. Prefer the explicit action field and retain the
/// harness fallback so both shapes resume the worker and register the same
/// session with the node control plane.
pub(super) fn relaycast_spawn_session_ref(ws_value: &Value) -> Option<String> {
    let explicit = ["session_ref", "sessionRef"]
        .iter()
        .find_map(|key| {
            ws_value
                .get(*key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
        })
        .or_else(|| {
            let agent = ws_value.get("agent")?;
            ["session_ref", "sessionRef"].iter().find_map(|key| {
                agent
                    .get(*key)
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
            })
        });
    if let Some(session_ref) = explicit {
        return Some(session_ref.to_string());
    }

    relaycast_harness_config(ws_value)
        .ok()
        .flatten()
        .as_ref()
        .and_then(ResolvedHarnessConfig::session_id)
        .map(ToOwned::to_owned)
}

/// Resolve the worker process directory from a Fleet spawn request.
///
/// `worker_cwd` is the public action field. `cwd` remains accepted on the
/// flattened `node.spawn` payload produced by `@agent-relay/fleet`, where it is
/// already an `AgentSpec` working directory. Automatic placement transports
/// the explicit field inside `metadata`, because the upstream workspace spawn
/// request has no first-class cwd field.
pub(super) fn relaycast_spawn_worker_cwd(ws_value: &Value) -> Result<Option<String>> {
    let candidate = [
        "/worker_cwd",
        "/workerCwd",
        "/metadata/worker_cwd",
        "/metadata/workerCwd",
        "/agent/worker_cwd",
        "/agent/workerCwd",
        "/agent/metadata/worker_cwd",
        "/agent/metadata/workerCwd",
        "/cwd",
        "/agent/cwd",
    ]
    .iter()
    .find_map(|pointer| ws_value.pointer(pointer));

    let Some(candidate) = candidate else {
        return Ok(None);
    };
    let cwd = candidate
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .context("worker_cwd must be a non-empty string")?;
    let path = Path::new(cwd);
    if !path.is_absolute() {
        anyhow::bail!("worker_cwd must be an absolute path: '{cwd}'");
    }
    let metadata = std::fs::metadata(path)
        .with_context(|| format!("worker_cwd is not resolvable: '{}'", path.display()))?;
    if !metadata.is_dir() {
        anyhow::bail!("worker_cwd is not a directory: '{}'", path.display());
    }
    Ok(Some(cwd.to_string()))
}

/// Read the dispatcher-issued commit attestation from an active node-control
/// spawn request. The legacy workspace-stream bridge deserializes the same
/// field into `SpawnParams`, but node-only `action.invoke` spawns bypass that
/// bridge and must carry it explicitly into `WorkerRegistry::spawn`.
pub(super) fn relaycast_spawn_commit_attestation(
    ws_value: &Value,
) -> Result<Option<crate::types::CommitAttestation>, serde_json::Error> {
    let raw = ws_value
        .pointer("/metadata/attestation")
        .or_else(|| ws_value.pointer("/agent/metadata/attestation"))
        .or_else(|| ws_value.get("attestation"));
    raw.cloned().map(serde_json::from_value).transpose()
}

pub(super) fn relaycast_spawn_spec_session_id(
    cli: &str,
    session_ref: Option<&str>,
    harness_session_id: Option<&str>,
) -> Option<String> {
    let normalized_cli = crate::cli::command_parse::normalize_cli_name(cli);
    let supports_resume = normalized_cli == "codex"
        || normalized_cli == "claude"
        || normalized_cli.starts_with("claude:");
    supports_resume
        .then_some(session_ref)
        .flatten()
        .and_then(|value| {
            let value = value.trim();
            (!value.is_empty()).then(|| value.to_string())
        })
        .or_else(|| {
            harness_session_id.and_then(|value| {
                let value = value.trim();
                (!value.is_empty()).then(|| value.to_string())
            })
        })
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

fn harness_metadata_flag(config: &ResolvedHarnessConfig, snake: &str, camel: &str) -> bool {
    config
        .metadata()
        .and_then(|metadata| metadata.get(snake).or_else(|| metadata.get(camel)))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

pub(super) fn relaycast_spawn_verifies_ready(value: &Value) -> bool {
    relaycast_harness_config(value)
        .ok()
        .flatten()
        .as_ref()
        .is_some_and(|config| harness_metadata_flag(config, "verify_ready", "verifyReady"))
}

/// Bind a freshly HTTP-registered agent to this broker's relaycast node so it
/// becomes `locationType='via_node'`.
///
/// In node-only delivery the engine only delivers to `via_node` agents. The HTTP
/// `register_agent_token` fallback (taken when node-control `agent.register` is
/// unavailable) registers a plain agent with NO node binding, so without this
/// bind the agent receives zero messages. Returns the warning message to surface
/// on failure (the agent is registered but undeliverable), or `None` on success.
pub(super) async fn bind_http_registered_agent_to_node(
    relaycast_http: &RelaycastHttpClient,
    node_name: &str,
    agent_name: &str,
) -> Option<String> {
    let Some(relay) = relaycast_http.relay_client() else {
        let message = format!(
            "agent '{agent_name}' was HTTP-registered but no relaycast client is available to \
             bind it to node '{node_name}'; node-only delivery will NOT reach this agent"
        );
        tracing::error!(worker = %agent_name, node = %node_name, "{message}");
        return Some(message);
    };
    let request = relaycast::BindAgentToNodeRequest {
        agent_name: agent_name.to_string(),
        session_ref: None,
        priority: None,
    };
    match relay.bind_agent_to_node(node_name, request).await {
        Ok(_) => {
            tracing::info!(
                worker = %agent_name,
                node = %node_name,
                "bound HTTP-registered agent to node (via_node) after agent.register fallback"
            );
            None
        }
        Err(error) => {
            let message = format!(
                "agent '{agent_name}' was HTTP-registered but binding it to node '{node_name}' \
                 failed ({error}); node-only delivery will NOT reach this agent until it is bound"
            );
            tracing::error!(
                worker = %agent_name,
                node = %node_name,
                error = %error,
                "failed to bind HTTP-registered agent to node; delivery will not work for this agent"
            );
            Some(message)
        }
    }
}

/// Outcome of a local release request, so callers can report a faithful
/// `action.result` to the node control plane.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ReleaseOutcome {
    /// The worker was released, or was the broker self (ignored), or was already
    /// exited — all of which the caller should report as a successful release.
    Released,
    /// The release genuinely failed for an unknown/other reason.
    Failed,
}

/// Release a worker that the fleet/node control plane asked the broker to drop.
///
/// Extracted verbatim from the former `WsEvent::AgentReleaseRequested` firehose
/// arm. The v5.0.1 SDK removed that event variant; node control invokes this
/// directly via `action.invoke`. `workspace_state` supplies the per-workspace
/// HTTP client, self-name set, and WS control channel the original arm captured.
///
/// Returns `ReleaseOutcome::Released` on success (including an already-exited
/// worker, which is a no-op success) and `ReleaseOutcome::Failed` when the
/// release genuinely failed.
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
    dead_letters: &mut DeadLetterStore,
    pending_requests: &mut HashMap<String, worker_request::PendingRequest>,
    delivery_states: &mut HashMap<WorkerName, InboundDeliveryState>,
    agent_result_tokens: &mut HashMap<String, WorkerName>,
    terminal_control_tx: &mpsc::Sender<TerminalControlCommand>,
    terminal_sessions: &mut HashMap<String, TerminalSession>,
    terminal_snapshot_requests: &mut HashMap<String, TerminalSnapshotRequest>,
    terminal_input_requests: &mut HashMap<String, TerminalInputRequest>,
) -> ReleaseOutcome {
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
        return ReleaseOutcome::Released;
    }
    workers.supervisor.unregister(&name);
    workers.metrics.on_release(&name);
    let outcome = match workers.release(&name).await {
        Ok(()) => {
            workspace_http.forget_agent_registration(&name);
            let dropped = take_pending_for_worker(pending_deliveries, &name);
            if !dropped.is_empty() {
                let _ = send_event(
                                sdk_out_tx,
                                json!({"kind":"delivery_dropped","name":name,"count":dropped.len(),"reason":"agent_released"}),
                            ).await;
                let _ = emit_dropped_delivery_failures(
                    sdk_out_tx,
                    dead_letters,
                    &dropped,
                    "agent_released",
                )
                .await;
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
            ReleaseOutcome::Released
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
                // An already-exited worker is still a successful release.
                ReleaseOutcome::Released
            } else {
                tracing::error!(child = %name, error = %error, "failed to release worker via relaycast");
                eprintln!("[agent-relay] failed to release '{}': {}", name, error);
                ReleaseOutcome::Failed
            }
        }
    };
    if outcome == ReleaseOutcome::Released {
        super::fleet::close_terminal_sessions_for_worker(
            terminal_control_tx,
            terminal_sessions,
            terminal_snapshot_requests,
            terminal_input_requests,
            &name,
            "agent_released",
            "terminal worker was released",
        );
    }
    outcome
}

/// Spawn a worker the fleet/node control plane requested.
///
/// Extracted verbatim from the former `WsEvent::AgentSpawnRequested` firehose
/// arm. The v5.0.1 SDK removed that event variant; node control invokes this
/// directly via `action.invoke`. The spawn fields (`cli`, `task`, `channel`,
/// `model`) previously came off the typed event payload and are now passed in;
/// `ws_value` is retained for `harnessConfig`/token extraction exactly as
/// before, as well as for the Fleet action's explicit `worker_cwd` transport.
/// `exit_after_task` carries the resolved task-exit lifecycle so an
/// engine-dispatched spawn exits after its task identically to a local HTTP
/// spawn. `control_dedup_key` carries the firehose control dedup key so the
/// local spawn-echo dedup behaves identically.
/// Returns only after `WorkerRegistry::spawn` has completed its process
/// stability probe, preserving the detailed launch error for the action result.
#[allow(clippy::too_many_arguments)]
pub(super) async fn spawn_worker_from_request(
    name: WorkerName,
    cli: String,
    task: Option<String>,
    channel: Option<String>,
    model: Option<String>,
    exit_after_task: bool,
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
    fleet_delivery_book: &mut FleetDeliveryBook,
    fleet_inventory: &mut HashMap<WorkerName, InventoryAgent>,
    node_name: &str,
    invocation_id: Option<String>,
    session_ref: Option<String>,
    hosted_agent_event_tx: &mpsc::Sender<HostedAgentEvent>,
    pty_observability: &mut HashMap<WorkerName, PtyObservabilityState>,
) -> Result<()> {
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
        anyhow::bail!("agent '{name}' is the broker self");
    }
    // Resolve and validate the directory on the selected node, before dedup or
    // registration side effects. A remote Fleet cwd cannot be validated by the
    // caller because the path belongs to this node's filesystem.
    let worker_cwd = relaycast_spawn_worker_cwd(ws_value)?;
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
        anyhow::bail!("duplicate spawn request for agent '{name}'");
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
            return Err(anyhow::anyhow!(error));
        }
    };
    let commit_attestation = match relaycast_spawn_commit_attestation(ws_value) {
        Ok(Some(attestation)) => Some(attestation),
        Ok(None) => None,
        Err(error) => {
            tracing::warn!(
                target = "broker::spawn",
                worker = %name,
                error = %error,
                "spawn request has invalid commit attestation; ledger trailers will be unavailable, but harness session attribution will still be derived"
            );
            None
        }
    };
    let require_node_registration = harness_config.as_ref().is_some_and(|config| {
        harness_metadata_flag(
            config,
            "require_node_registration",
            "requireNodeRegistration",
        )
    });
    let runtime = harness_config
        .as_ref()
        .map(ResolvedHarnessConfig::runtime)
        .unwrap_or(AgentRuntime::Pty);
    let harness_session_id = harness_config
        .as_ref()
        .and_then(ResolvedHarnessConfig::session_id)
        .map(ToOwned::to_owned);
    let session_id = relaycast_spawn_spec_session_id(
        &cli,
        session_ref.as_deref(),
        harness_session_id.as_deref(),
    );

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
        cwd: worker_cwd,
        team: None,
        shadow_of: None,
        shadow_mode: None,
        args: vec![],
        channels: channels.clone(),
        restart_policy: None,
    };
    // Mirror the local HTTP spawn path (`runtime/api.rs`): a task-exit spawn
    // appends the clean-exit contract to the initial task so the agent exits
    // once it is done instead of idling forever.
    let mut effective_task = if exit_after_task {
        Some(apply_exit_after_task_instruction(task.clone()))
    } else {
        normalize_initial_task(task.clone())
    };

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
    let mut fleet_registration = None;
    let registration_metadata =
        crate::fleet_wire::AgentRegistrationMetadata::from_spawn_input(ws_value, task.as_deref());
    let worker_relay_key = {
        if let Some(token) = relaycast_ws_spawn_token(ws_value)
            .filter(|_| !require_node_registration && !relaycast_spawn_verifies_ready(ws_value))
        {
            seed_supplied_agent_token(workspace_http, &name, &token);
            match super::fleet::resolve_fleet_agent_token_identity(
                workspace_http,
                fleet_delivery_book,
                &name,
                &token,
            )
            .await
            {
                Ok(registration) => {
                    fleet_registration =
                        Some((registration, invocation_id.clone(), session_ref.clone()));
                }
                Err(error) => {
                    tracing::warn!(
                        worker = %name,
                        error = %error,
                        "could not resolve supplied agent token for reconnect inventory"
                    );
                }
            }
            Some(token)
        } else {
            match super::fleet::register_node_agent_token(
                fleet_control_tx,
                fleet_delivery_book,
                name.as_str(),
                invocation_id.clone(),
                session_ref.clone(),
            )
            .await
            {
                Ok(token) => {
                    tracing::info!(
                        worker = %name,
                        "bound agent to node via agent.register for action.invoke spawn"
                    );
                    super::fleet::spawn_declared_metadata_publish(
                        workspace_http,
                        name.as_str(),
                        registration_metadata,
                    );
                    let relay_key = token.token.clone();
                    fleet_registration = Some((token, invocation_id.clone(), session_ref.clone()));
                    Some(relay_key)
                }
                Err(node_error) => {
                    if require_node_registration || relaycast_spawn_verifies_ready(ws_value) {
                        tracing::warn!(
                            worker = %name,
                            error = %node_error,
                            "rejecting verified spawn because node agent.register failed"
                        );
                        anyhow::bail!(
                            "node agent.register failed for agent '{name}': {node_error}"
                        );
                    }
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
                            // Declared metadata is published over the agent API
                            // exactly as on the node path; registration itself
                            // stays on the cache- and rate-limit-aware call.
                            super::fleet::spawn_declared_metadata_publish(
                                workspace_http,
                                name.as_str(),
                                registration_metadata,
                            );
                            tracing::info!(
                                worker = %name,
                                "pre-registered agent via broker for WS spawn"
                            );
                            // HTTP registration alone leaves the agent without a
                            // node binding; in node-only delivery the engine only
                            // delivers to `via_node` agents. Bind it to this node
                            // so it becomes deliverable.
                            let bind_warning = bind_http_registered_agent_to_node(
                                workspace_http,
                                node_name,
                                &name,
                            )
                            .await;
                            if bind_warning.is_none() {
                                match super::fleet::resolve_fleet_agent_token_identity(
                                    workspace_http,
                                    fleet_delivery_book,
                                    &name,
                                    &token,
                                )
                                .await
                                {
                                    Ok(registration) => {
                                        fleet_registration = Some((
                                            registration,
                                            invocation_id.clone(),
                                            session_ref.clone(),
                                        ));
                                    }
                                    Err(error) => {
                                        tracing::warn!(
                                            worker = %name,
                                            error = %error,
                                            "could not resolve HTTP-registered agent for reconnect inventory"
                                        );
                                    }
                                }
                            }
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
    let channel_membership_warning = if let Some(token) = worker_relay_key.as_deref() {
        seed_supplied_agent_token(workspace_http, &name, token);
        if let Err(error) = workspace_http
            .ensure_agent_channels(&name, Some(&cli), &channels)
            .await
        {
            tracing::error!(
                worker = %name,
                channels = ?channels,
                error = %error,
                "worker channel membership reconciliation failed for Relaycast spawn"
            );
            Some(format!(
                "worker channel membership was not fully reconciled: {error}"
            ))
        } else {
            None
        }
    } else {
        None
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
            commit_attestation,
        )
        .await
    {
        Ok(effective_spec) => {
            if let Some((token, invocation_id, session_ref)) = fleet_registration.take() {
                super::fleet::record_fleet_inventory_agent(
                    fleet_control_tx,
                    fleet_inventory,
                    &token,
                    invocation_id,
                    session_ref,
                )
                .await;
            }
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
                    "registration_warning": channel_membership_warning,
                }),
            )
            .await;
            if effective_spec.runtime == AgentRuntime::Pty {
                publish_pty_starting(
                    pty_observability,
                    hosted_agent_event_tx,
                    &name,
                    Some(workspace_id.clone()),
                );
            }
            publish_agent_state_transition(
                &workspace_state.ws_control_tx,
                &name,
                "spawned",
                Some("relaycast_spawn"),
            )
            .await;
            tracing::info!(child = %name, pid = ?pid, "spawned worker via relaycast WS");
            eprintln!("[agent-relay] spawned worker '{}' via relaycast", name);
            Ok(())
        }
        Err(e) => {
            let msg = e.to_string();
            if msg.contains("already exists") {
                tracing::debug!(child = %name, "agent already spawned via SDK, skipping duplicate relaycast WS spawn");
            } else {
                tracing::error!(child = %name, error = %e, "failed to spawn worker via relaycast WS");
                eprintln!("[agent-relay] failed to spawn '{}': {}", name, e);
            }
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal_control::TerminalToCloud;
    use ::relaycast::WsEvent;

    #[cfg(unix)]
    #[tokio::test]
    async fn released_view_target_emits_close_while_healthy_idle_view_stays_open() {
        let temp = tempfile::tempdir().expect("test tempdir");
        let (worker_event_tx, _worker_event_rx) = mpsc::channel::<WorkerEvent>(4);
        let mut workers = WorkerRegistry::new(
            worker_event_tx,
            Vec::new(),
            temp.path().join("worker-logs"),
            Instant::now(),
        );
        let released_agent = WorkerName::from("released-view-target");
        let healthy_agent = WorkerName::from("healthy-idle-view-target");
        let child = tokio::process::Command::new("sh")
            .args(["-c", "sleep 30"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("release target should spawn");
        let (command_tx, command_rx) = mpsc::channel(1);
        drop(command_rx);
        workers.workers.insert(
            released_agent.clone(),
            WorkerHandle {
                generation: Uuid::new_v4(),
                spec: AgentSpec {
                    name: released_agent.clone(),
                    runtime: AgentRuntime::Pty,
                    provider: None,
                    cli: Some("sh".to_string()),
                    session_id: None,
                    harness_config: None,
                    model: None,
                    cwd: None,
                    team: None,
                    shadow_of: None,
                    shadow_mode: None,
                    args: Vec::new(),
                    channels: Vec::new(),
                    restart_policy: None,
                },
                parent: Some("Relaycast".to_string()),
                workspace_id: None,
                child,
                command_tx,
                harness_pid: None,
                spawned_at: Instant::now(),
                ready_at: Some(Instant::now()),
                last_activity_at: Instant::now(),
                context_budget_pct: None,
                state: crate::worker::AgentWorkState::Working,
                exit_reason: None,
            },
        );

        let workspace_id = WorkspaceId::from("ws_release_view_test".to_string());
        let (ws_control_tx, _ws_control_rx) = mpsc::channel::<WsControl>(4);
        let workspace = RelayWorkspace {
            workspace_id,
            workspace_alias: None,
            relay_workspace_key: "rk_live_test".to_string(),
            self_name: "broker".to_string(),
            self_agent_id: AgentId::from("agent_broker".to_string()),
            self_names: HashSet::from(["broker".to_string()]),
            self_agent_ids: HashSet::from([AgentId::from("agent_broker".to_string())]),
            http_client: RelaycastHttpClient::new(
                Some("http://127.0.0.1:9".to_string()),
                "rk_live_test",
                "broker",
                "codex",
            ),
            ws_control_tx,
        };
        let paths = ensure_ephemeral_paths(temp.path(), "release-view-target")
            .expect("ephemeral runtime paths");
        let mut state = broker::BrokerState::default();
        let telemetry = TelemetryClient::default();
        let (sdk_out_tx, _sdk_out_rx) = mpsc::channel(8);
        let mut pending_deliveries = HashMap::new();
        let mut dead_letters = DeadLetterStore::default();
        let mut pending_requests = HashMap::new();
        let mut delivery_states = HashMap::new();
        let mut agent_result_tokens = HashMap::new();
        let released_session_id = "released-view-session".to_string();
        let healthy_session_id = "healthy-idle-view-session".to_string();
        let mut terminal_sessions = HashMap::from([
            (
                released_session_id.clone(),
                TerminalSession {
                    agent: released_agent.clone(),
                    mode: TerminalMode::View,
                    ready: true,
                    pending_output: Vec::new(),
                    pending_output_bytes: 0,
                },
            ),
            (
                healthy_session_id.clone(),
                TerminalSession {
                    agent: healthy_agent,
                    mode: TerminalMode::View,
                    ready: true,
                    pending_output: Vec::new(),
                    pending_output_bytes: 0,
                },
            ),
        ]);
        let deadline = Instant::now() + Duration::from_secs(30);
        let mut terminal_snapshot_requests = HashMap::from([
            (
                "released-snapshot".to_string(),
                TerminalSnapshotRequest {
                    session_id: released_session_id.clone(),
                    client_request_id: None,
                    deadline,
                },
            ),
            (
                "healthy-snapshot".to_string(),
                TerminalSnapshotRequest {
                    session_id: healthy_session_id.clone(),
                    client_request_id: None,
                    deadline,
                },
            ),
        ]);
        let mut terminal_input_requests = HashMap::new();
        let (terminal_control_tx, mut terminal_control_rx) = mpsc::channel(8);

        let outcome = release_worker_locally(
            released_agent,
            &workspace,
            &mut workers,
            &mut state,
            &paths,
            &telemetry,
            &sdk_out_tx,
            &mut pending_deliveries,
            &mut dead_letters,
            &mut pending_requests,
            &mut delivery_states,
            &mut agent_result_tokens,
            &terminal_control_tx,
            &mut terminal_sessions,
            &mut terminal_snapshot_requests,
            &mut terminal_input_requests,
        )
        .await;

        assert_eq!(outcome, ReleaseOutcome::Released);
        // MUST FIRE: releasing the target through the same lifecycle function
        // used by the fleet action emits a final code and reason for its view.
        let terminal_messages: Vec<TerminalControlCommand> =
            std::iter::from_fn(|| terminal_control_rx.try_recv().ok()).collect();
        assert!(terminal_messages.iter().any(|message| matches!(
            message,
            TerminalControlCommand::Send(TerminalToCloud::Closed {
                session_id,
                code: Some(code),
                message: Some(message),
            }) if session_id == &released_session_id
                && code == "agent_released"
                && message == "terminal worker was released"
        )));
        assert!(!terminal_sessions.contains_key(&released_session_id));
        assert!(!terminal_snapshot_requests.contains_key("released-snapshot"));

        // MUST NOT FIRE: an unrelated healthy view may be legitimately idle.
        assert!(terminal_sessions.contains_key(&healthy_session_id));
        assert!(terminal_snapshot_requests.contains_key("healthy-snapshot"));
        assert!(
            !terminal_messages.iter().any(|message| matches!(
                message,
                TerminalControlCommand::Send(TerminalToCloud::Closed { session_id, .. })
                    if session_id == &healthy_session_id
            )),
            "healthy idle view must not receive a close"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn spawn_request_returns_the_verified_process_failure() {
        let temp = tempfile::tempdir().expect("test tempdir");
        let (worker_event_tx, _worker_event_rx) = mpsc::channel::<WorkerEvent>(4);
        let mut workers = WorkerRegistry::new(
            worker_event_tx,
            Vec::new(),
            temp.path().join("worker-logs"),
            Instant::now(),
        );
        let workspace_id = WorkspaceId::from("ws_test_1430".to_string());
        let (ws_control_tx, _ws_control_rx) = mpsc::channel::<WsControl>(4);
        let workspace = RelayWorkspace {
            workspace_id: workspace_id.clone(),
            workspace_alias: None,
            relay_workspace_key: "rk_live_test".to_string(),
            self_name: "broker".to_string(),
            self_agent_id: AgentId::from("agent_broker".to_string()),
            self_names: HashSet::from(["broker".to_string()]),
            self_agent_ids: HashSet::from([AgentId::from("agent_broker".to_string())]),
            http_client: RelaycastHttpClient::new(
                Some("http://127.0.0.1:9".to_string()),
                "rk_live_test",
                "broker",
                "codex",
            ),
            ws_control_tx,
        };
        let paths = ensure_ephemeral_paths(temp.path(), "fleet-spawn-1430")
            .expect("ephemeral runtime paths");
        let mut state = broker::BrokerState::default();
        let telemetry = TelemetryClient::default();
        let (sdk_out_tx, _sdk_out_rx) = mpsc::channel(4);
        let mut dedup = DedupCache::new(Duration::from_secs(60), 16);
        let mut agent_spawn_count = 0;
        let (fleet_control_tx, _fleet_control_rx) = mpsc::channel(4);
        let mut fleet_delivery_book = FleetDeliveryBook::default();
        let mut fleet_inventory = HashMap::new();
        let (hosted_agent_event_tx, _hosted_agent_event_rx) = mpsc::channel(4);
        let mut pty_observability = HashMap::new();
        let name = WorkerName::from("failed-native-worker-1430");
        let ws_value = json!({
            "token": "at_live_test_worker",
            "agent": {
                "harnessConfig": {
                    "runtime": "native",
                    "command": "sh",
                    // Exit immediately rather than after a fixed sleep: the
                    // assertion only needs the child to exit somewhere inside
                    // WORKER_SPAWN_STABILITY_WINDOW, and a fixed 50ms sleep left
                    // only ~200ms of margin against that 250ms window on a
                    // loaded shared CI runner (relay#1516). An immediate exit
                    // keeps the full window as margin without touching the
                    // production constant.
                    "args": ["-c", "exit 23"],
                    "sessionId": "native-failed-1430"
                }
            }
        });
        let control_key = relaycast_spawn_control_dedup_key(&workspace_id, &name);

        let error = spawn_worker_from_request(
            name.clone(),
            "codex".to_string(),
            None,
            None,
            None,
            false,
            &ws_value,
            &workspace_id,
            Some(&control_key),
            &workspace,
            &mut workers,
            &mut state,
            &paths,
            &telemetry,
            &sdk_out_tx,
            &mut dedup,
            &mut agent_spawn_count,
            &fleet_control_tx,
            &mut fleet_delivery_book,
            &mut fleet_inventory,
            "test-node",
            Some("inv-failed-1430".to_string()),
            None,
            &hosted_agent_event_tx,
            &mut pty_observability,
        )
        .await
        .expect_err("a sidecar that exits during the stability window must fail the spawn");

        // Two rejection paths race here: the stability-window check
        // ("process exited during startup") if the child is still alive when
        // `send_to_worker("init_worker")` writes to it, or an EPIPE from that
        // write ("failed writing frame to worker") if the child has already
        // exited by then (see the comment on that error branch above, and the
        // identical pattern in tests/integration/broker/cli-spawn.test.ts).
        // Both are the correct rejection for a sidecar that dies on startup,
        // so assert on whichever wins rather than pinning to one. Exit status
        // and log-path detail are asserted deterministically at the requester
        // level in fleet-spawn-confirmation.test.ts, which uses a fixture
        // instead of a real process and cannot race.
        let message = error.to_string();
        assert!(
            message.contains("process exited during startup")
                || message.contains("failed writing frame to worker"),
            "{message}"
        );
        assert!(!workers.has_worker(&name));
        assert_eq!(agent_spawn_count, 0);
        assert!(!state.agents.contains_key(&name));
    }

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
    fn fleet_spawn_worker_cwd_accepts_existing_absolute_directory() {
        let temp = tempfile::tempdir().expect("worker cwd fixture");
        let cwd = temp.path().to_string_lossy().into_owned();

        for value in [
            json!({ "worker_cwd": cwd }),
            json!({ "metadata": { "worker_cwd": cwd } }),
            json!({ "agent": { "cwd": cwd } }),
        ] {
            assert_eq!(
                relaycast_spawn_worker_cwd(&value)
                    .expect("existing worker cwd should resolve")
                    .as_deref(),
                Some(cwd.as_str())
            );
        }
    }

    #[test]
    fn fleet_spawn_worker_cwd_rejects_unresolvable_directory() {
        let temp = tempfile::tempdir().expect("worker cwd fixture");
        let missing = temp.path().join("missing-checkout");
        let value = json!({ "worker_cwd": missing });

        let error = relaycast_spawn_worker_cwd(&value)
            .expect_err("missing worker cwd must reject the spawn")
            .to_string();

        assert!(error.contains("worker_cwd is not resolvable"), "{error}");
        assert!(error.contains("missing-checkout"), "{error}");
    }

    #[test]
    fn fleet_spawn_worker_cwd_rejects_relative_directory() {
        let error = relaycast_spawn_worker_cwd(&json!({ "worker_cwd": "../other-repo" }))
            .expect_err("relative Fleet cwd would depend on the node launch directory")
            .to_string();

        assert!(error.contains("must be an absolute path"), "{error}");
    }

    #[test]
    fn node_control_spawn_reads_nested_commit_attestation() {
        let value = json!({
            "metadata": {
                "attestation": {
                    "jti": "jti-node-control",
                    "agentId": "agent-worker",
                    "sponsorId": "user-owner"
                }
            }
        });

        let attestation = relaycast_spawn_commit_attestation(&value)
            .expect("attestation should deserialize")
            .expect("attestation should be present");

        assert_eq!(attestation.jti, "jti-node-control");
        assert_eq!(attestation.agent_id, "agent-worker");
        assert_eq!(attestation.sponsor_id, "user-owner");
        assert_eq!(attestation.session_ref, None);
    }

    #[test]
    fn node_control_spawn_reports_malformed_commit_attestation() {
        let value = json!({
            "metadata": {
                "attestation": {
                    "jti": "jti-node-control",
                    "agentId": "agent-worker"
                }
            }
        });

        assert!(relaycast_spawn_commit_attestation(&value).is_err());
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

    #[test]
    fn verified_spawn_contract_is_read_from_harness_metadata() {
        let verified = json!({
            "harness_config": {
                "runtime": "pty",
                "command": "codex",
                "args": [],
                "metadata": {
                    "verify_ready": true,
                    "require_node_registration": true
                }
            }
        });
        let ordinary = json!({
            "harness_config": {
                "runtime": "pty",
                "command": "codex",
                "args": []
            }
        });

        assert!(relaycast_spawn_verifies_ready(&verified));
        assert!(!relaycast_spawn_verifies_ready(&ordinary));
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
