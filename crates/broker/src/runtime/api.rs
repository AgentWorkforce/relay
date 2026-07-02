use super::*;
use relaycast::{CreateObserverTokenRequest, ObserverScope, ObserverToken, RelayError};

/// Default name recorded on observer tokens minted via `/api/observer-token`
/// when the caller doesn't supply one.
const DEFAULT_OBSERVER_TOKEN_NAME: &str = "pear-dashboard-observer";

/// Scopes granted to observer tokens minted via `/api/observer-token`: broad
/// read access to workspace activity, deliberately excluding anything
/// write/spawn-capable (unlike the raw `rk_live_...` workspace key this
/// replaces) and `search:read`/`nodes:read`/`deliveries:read`/
/// `files:read`/`reactions:read`, which aren't needed by the observer
/// dashboard use case this unblocks.
pub(crate) fn default_observer_token_scopes() -> Vec<ObserverScope> {
    vec![
        ObserverScope::StreamRead,
        ObserverScope::MessagesRead,
        ObserverScope::ThreadsRead,
        ObserverScope::DmsRead,
        ObserverScope::ChannelsRead,
        ObserverScope::ActivityRead,
        ObserverScope::AgentsRead,
    ]
}

/// Outcome of `mint_or_recover_observer_token`: distinguishes a genuinely
/// new token from one recovered by rotating a pre-existing token under the
/// same name, purely so the caller can log/report the two cases
/// differently. Both variants carry a normal, fully-usable `ObserverToken`.
#[derive(Debug)]
pub(crate) enum ObserverTokenMintOutcome {
    Created(ObserverToken),
    RecoveredViaRotate(ObserverToken),
}

impl ObserverTokenMintOutcome {
    pub(crate) fn is_recovered_via_rotate(&self) -> bool {
        matches!(self, ObserverTokenMintOutcome::RecoveredViaRotate(_))
    }

    pub(crate) fn into_token(self) -> ObserverToken {
        match self {
            ObserverTokenMintOutcome::Created(token) => token,
            ObserverTokenMintOutcome::RecoveredViaRotate(token) => token,
        }
    }
}

/// Error from `mint_or_recover_observer_token`, pre-classified so callers
/// don't need to re-derive "was this a timeout" from string content.
#[derive(Debug)]
pub(crate) enum ObserverTokenMintError {
    /// A non-timeout failure; already formatted as a user-facing message.
    Failed(String),
    /// The create call (or, if triggered, the list+rotate fallback) didn't
    /// complete within the caller-supplied timeout.
    TimedOut,
}

/// True if `error` (as returned by `RelaycastHttpClient::create_observer_token`)
/// is specifically the API's `observer_token_name_conflict` error (HTTP
/// 409) — i.e. a token with this name already exists for the workspace —
/// as opposed to a timeout, network failure, or any other API error. Only
/// this specific error should trigger the list+rotate fallback; anything
/// else must still propagate as a failure.
fn is_observer_token_name_conflict(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<RelayError>()
        .is_some_and(|relay_error| relay_error.code() == Some("observer_token_name_conflict"))
}

/// Mint an observer token named `token_name` for the workspace reachable
/// via `http_client`, falling back to recovering a pre-existing token if
/// creation fails because a token under that name already exists
/// (`observer_token_name_conflict`, HTTP 409). Callers like Pear mint a
/// token under a fixed default name once per workspace with no way to know
/// in advance whether a previous mint already claimed that name, so without
/// this fallback, repeat minting would fail outright forever.
///
/// The initial create call is bounded by `timeout_duration`. If the
/// list+rotate fallback is triggered, it gets its own fresh
/// `timeout_duration` window (rather than sharing whatever budget the
/// create call already spent), so it can't block the caller indefinitely
/// either.
pub(crate) async fn mint_or_recover_observer_token(
    http_client: &RelaycastHttpClient,
    token_name: &str,
    timeout_duration: Duration,
) -> Result<ObserverTokenMintOutcome, ObserverTokenMintError> {
    match timeout(
        timeout_duration,
        http_client.create_observer_token(CreateObserverTokenRequest {
            name: token_name.to_string(),
            scopes: default_observer_token_scopes(),
            description: None,
            filters: None,
            expires_at: None,
        }),
    )
    .await
    {
        Ok(Ok(observer_token)) => Ok(ObserverTokenMintOutcome::Created(observer_token)),
        Ok(Err(error)) if is_observer_token_name_conflict(&error) => {
            recover_observer_token_after_name_conflict(
                http_client,
                token_name,
                timeout_duration,
                error,
            )
            .await
        }
        Ok(Err(error)) => Err(ObserverTokenMintError::Failed(format!(
            "Failed to create observer token: {error}"
        ))),
        Err(_) => Err(ObserverTokenMintError::TimedOut),
    }
}

/// Fallback for `create_observer_token` failing with
/// `observer_token_name_conflict`: list existing observer tokens for the
/// workspace, find the one named `token_name`, and rotate it to obtain
/// fresh, usable raw token material.
///
/// **Behavioral note:** the raw token originally minted under this name was
/// never persisted anywhere the broker can read it back, so rotating is the
/// only way to recover a usable value — this necessarily invalidates
/// whatever raw token was previously handed out under this name. This is
/// acceptable for this endpoint's known caller (Pear's `mintObserverToken`,
/// which always treats a freshly-returned token as authoritative and
/// re-caches it), but any *other* holder of the previous raw value for this
/// name silently loses access when this path is taken.
///
/// If no existing token matches `token_name` despite the conflict error
/// (e.g. a race with a concurrent revoke), the original conflict error is
/// propagated as-is rather than panicking or synthesizing a misleading
/// response.
async fn recover_observer_token_after_name_conflict(
    http_client: &RelaycastHttpClient,
    token_name: &str,
    timeout_duration: Duration,
    conflict_error: anyhow::Error,
) -> Result<ObserverTokenMintOutcome, ObserverTokenMintError> {
    let fallback = timeout(timeout_duration, async move {
        let existing = http_client.list_observer_tokens().await?;
        let matched = existing
            .into_iter()
            .find(|candidate| candidate.name == token_name)
            .ok_or(conflict_error)?;
        http_client.rotate_observer_token(&matched.id).await
    })
    .await;

    match fallback {
        Ok(Ok(observer_token)) => Ok(ObserverTokenMintOutcome::RecoveredViaRotate(observer_token)),
        Ok(Err(error)) => Err(ObserverTokenMintError::Failed(format!(
            "Failed to create observer token: {error}"
        ))),
        Err(_) => Err(ObserverTokenMintError::TimedOut),
    }
}

impl BrokerRuntime {
    pub(super) async fn handle_api_request(&mut self, req: ListenApiRequest) {
        let req = match req {
            ListenApiRequest::FleetSidecarConnect { outbound, reply } => {
                let result = self.handle_fleet_sidecar_connect(outbound).await;
                let _ = reply.send(result);
                return;
            }
            ListenApiRequest::FleetSidecarDisconnect => {
                self.handle_fleet_sidecar_disconnect().await;
                return;
            }
            ListenApiRequest::FleetSidecarFrame { frame, reply } => {
                let result = self.handle_fleet_sidecar_frame(frame).await;
                let _ = reply.send(result);
                return;
            }
            other => other,
        };
        let paths = &self.paths;
        let state = &mut self.state;
        let workspaces = &self.workspaces;
        let workspace_lookup = &self.workspace_lookup;
        let default_workspace = &self.default_workspace;
        let default_workspace_id = &self.default_workspace_id;
        let self_names = &self.self_names;
        let relaycast_http = &self.relaycast_http;
        let ws_control_tx = &self.ws_control_tx;
        let sdk_out_tx = &self.sdk_out_tx;
        let workers = &mut self.workers;
        let fleet_control_tx = &self.fleet_control_tx;
        let fleet_node_name = self.fleet_node_name.as_str();
        let node_delivery_token_present = self.node_delivery_token_present;
        let node_delivery_connected = self.node_delivery_connected;
        let fleet_inventory = &mut self.fleet_inventory;
        let fleet_delivery_book = &mut self.fleet_delivery_book;
        let fleet_max_agents = self.fleet_max_agents;
        let fleet_handlers_live = self.fleet_handlers.handlers_live();
        let telemetry = &self.telemetry;
        let agent_spawn_count = &mut self.agent_spawn_count;
        let pending_deliveries = &mut self.pending_deliveries;
        let pending_requests = &mut self.pending_requests;
        let delivery_states = &mut self.delivery_states;
        let agent_result_tokens = &mut self.agent_result_tokens;
        let dedup = &mut self.dedup;
        let recent_thread_messages = &mut self.recent_thread_messages;
        let delivery_retry_interval = self.delivery_retry_interval;
        let last_lease_renewal = &mut self.last_lease_renewal;
        let lease_duration = self.lease_duration;
        let persist = self.persist;
        let shutdown = &mut self.shutdown;
        let crash_insights = &self.crash_insights;

        match req {
            ListenApiRequest::Spawn {
                name,
                cli,
                transport,
                model,
                args,
                task,
                channels,
                cwd,
                team,
                shadow_of,
                shadow_mode,
                continue_from,
                idle_threshold_secs,
                exit_after_task,
                skip_relay_prompt,
                restart_policy,
                harness_config,
                agent_token,
                agent_result_schema,
                reply,
            } => {
                let effective_channels = if channels.is_empty() {
                    default_spawn_channels()
                } else {
                    channels.clone()
                };
                let spec = match build_http_api_spawn_spec(
                    name.clone(),
                    cli.clone(),
                    transport,
                    model.clone(),
                    args,
                    effective_channels.clone(),
                    cwd,
                    team,
                    shadow_of,
                    shadow_mode,
                    *restart_policy,
                    harness_config,
                ) {
                    Ok(spec) => spec,
                    Err(error) => {
                        let _ = reply.send(Err(error.to_string()));
                        return;
                    }
                };
                let mut preregistration_warning: Option<String> = None;
                // Caller-supplied agent_token is authoritative. In fleet mode it
                // was minted by the node control connection, and the worker must
                // receive that exact token before its harness starts.
                //
                // Otherwise bind the agent to this node via node-control
                // `agent.register` — the same step the engine `action.invoke`
                // spawn converges on — so the agent is born `via_node`-bound and
                // delivery flows over /v1/node/ws. The minted token is injected
                // as RELAY_AGENT_TOKEN (which also sets RELAY_SKIP_BOOTSTRAP) so
                // the worker MCP never re-registers over HTTP. If node binding is
                // unavailable, fall back to HTTP pre-registration so a tokenless
                // node (e.g. mint failure) still spawns a working agent.
                let worker_relay_key = if let Some(token) = agent_token {
                    seed_supplied_agent_token(relaycast_http, &name, &token);
                    Some(token)
                } else {
                    // Derive the session ref from the resolved spec the same way
                    // the fleet/sidecar paths do, so an HTTP spawn carrying a
                    // `harnessConfig.session_id` registers as a resumable session
                    // rather than a fresh spawn. No invocation id exists on the
                    // HTTP path.
                    let session_ref = super::fleet::fleet_initial_session_ref(&spec);
                    match super::fleet::register_node_agent_token(
                        fleet_control_tx,
                        name.as_str(),
                        None,
                        session_ref,
                    )
                    .await
                    {
                        Ok(token) => {
                            tracing::info!(
                                worker = %name,
                                "bound agent to node via agent.register for HTTP spawn"
                            );
                            Some(token.token)
                        }
                        Err(node_error) => {
                            tracing::warn!(
                                worker = %name,
                                error = %node_error,
                                "node agent.register unavailable; falling back to HTTP pre-registration"
                            );
                            match retry_agent_registration(relaycast_http, &name, Some(&cli)).await
                            {
                                Ok(token) => {
                                    // HTTP registration alone leaves the agent
                                    // without a node binding; the engine only
                                    // delivers to `via_node` agents in node-only
                                    // delivery. Bind it to this node so it is
                                    // deliverable, surfacing a loud warning if the
                                    // bind fails.
                                    if let Some(warning) =
                                        super::relaycast_events::bind_http_registered_agent_to_node(
                                            relaycast_http,
                                            fleet_node_name,
                                            &name,
                                        )
                                        .await
                                    {
                                        preregistration_warning = Some(warning);
                                    }
                                    Some(token)
                                }
                                Err(RegRetryOutcome::RetryableExhausted(error)) => {
                                    let message =
                                        format_worker_preregistration_error(&name, &error);
                                    tracing::warn!(
                                        worker = %name,
                                        error = %error,
                                        "continuing spawn without pre-registration after retries exhausted"
                                    );
                                    preregistration_warning = Some(message);
                                    None
                                }
                                Err(RegRetryOutcome::Fatal(error)) => {
                                    let _ = reply.send(Err(format_worker_preregistration_error(
                                        &name, &error,
                                    )));
                                    return;
                                }
                            }
                        }
                    }
                };

                let mut effective_task = if exit_after_task {
                    Some(apply_exit_after_task_instruction(task))
                } else {
                    normalize_initial_task(task)
                };
                if let Some(ref continue_from) = continue_from {
                    let continuity_dir = continuity_dir(&paths.state);
                    let continuity_file = continuity_dir.join(format!("{}.json", continue_from));
                    if continuity_file.exists() {
                        match std::fs::read_to_string(&continuity_file) {
                            Ok(contents) => {
                                if let Ok(ctx) = serde_json::from_str::<Value>(&contents) {
                                    let prev_task = ctx
                                        .get("initial_task")
                                        .and_then(Value::as_str)
                                        .unwrap_or("unknown");
                                    let summary = ctx
                                        .get("summary")
                                        .and_then(Value::as_str)
                                        .unwrap_or("no summary available");
                                    let messages = ctx
                                        .get("message_history")
                                        .and_then(Value::as_array)
                                        .map(|msgs| {
                                            msgs.iter()
                                                .filter_map(|m| {
                                                    let from = m
                                                        .get("from")
                                                        .and_then(Value::as_str)
                                                        .unwrap_or("?");
                                                    let text = m
                                                        .get("text")
                                                        .and_then(Value::as_str)
                                                        .unwrap_or("");
                                                    if text.is_empty() {
                                                        None
                                                    } else {
                                                        Some(format!("  {}: {}", from, text))
                                                    }
                                                })
                                                .collect::<Vec<_>>()
                                                .join("\n")
                                        })
                                        .unwrap_or_default();

                                    let continuity_block = format!(
                                        "## Continuity Context (from previous session as '{}')\n\
                                                     Previous task: {}\n\
                                                     Session summary: {}\n{}",
                                        continue_from,
                                        prev_task,
                                        summary,
                                        if messages.is_empty() {
                                            String::new()
                                        } else {
                                            format!("Recent messages:\n{}\n", messages)
                                        }
                                    );

                                    effective_task = Some(match effective_task {
                                        Some(new_task) => {
                                            format!(
                                                "{}\n\n## Current Task\n{}",
                                                continuity_block, new_task
                                            )
                                        }
                                        None => continuity_block,
                                    });
                                    tracing::info!(
                                        agent = %name,
                                        continue_from = %continue_from,
                                        "injected continuity context from previous session for HTTP API spawn"
                                    );
                                }
                            }
                            Err(e) => {
                                tracing::warn!(
                                    agent = %name,
                                    continue_from = %continue_from,
                                    error = %e,
                                    "failed to read continuity file for HTTP API spawn"
                                );
                            }
                        }
                    } else {
                        tracing::warn!(
                            agent = %name,
                            continue_from = %continue_from,
                            "no continuity file found at {}",
                            continuity_file.display()
                        );
                    }
                }

                let spawn_workspace_id = default_workspace_id.clone().or_else(|| {
                    workspaces
                        .first()
                        .map(|workspace| workspace.workspace_id.clone())
                });
                let agent_result = agent_result_schema.map(|schema| AgentResultMcpConfig {
                    callback_url: workers
                        .env_value("AGENT_RELAY_RESULT_URL")
                        .unwrap_or("http://127.0.0.1:3889/api/agent-result")
                        .to_string(),
                    token: format!("arr_{}", Uuid::new_v4().simple()),
                    schema: Some(schema),
                });
                if let Some(config) = &agent_result {
                    agent_result_tokens.insert(config.token.clone(), name.clone());
                }
                match workers
                    .spawn(
                        spec,
                        Some("Dashboard".to_string()),
                        idle_threshold_secs,
                        worker_relay_key.clone(),
                        skip_relay_prompt,
                        spawn_workspace_id.clone(),
                        agent_result.clone(),
                    )
                    .await
                {
                    Ok(effective_spec) => {
                        // Prepend relay skill text for small-tier models and CLI harnesses that
                        // need explicit tool guidance to reliably call add_agent / remove_agent.
                        // Skip when relay prompt injection is opted out — relay tools are absent.
                        if !skip_relay_prompt {
                            if let Some(prefix) = relay_skill_prefix(
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
                                    "injected relay skill prefix for model or CLI harness"
                                );
                            }
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
                            // `/api/spawn` is the HTTP entry point a human drives
                            // through the CLI (the broker's only human caller).
                            spawn_source: ActionSource::HumanCli,
                            has_task: effective_task.is_some(),
                            is_shadow: effective_spec.shadow_of.is_some()
                                || effective_spec.shadow_mode.is_some(),
                        });
                        let pid = workers.harness_pid(&name);
                        state.agents.insert(
                            name.clone(),
                            broker::PersistedAgent {
                                runtime: effective_spec.runtime.clone(),
                                parent: Some("Dashboard".to_string()),
                                channels: effective_spec.channels.clone(),
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
                        note_local_spawn_control_dedup(
                            dedup,
                            spawn_workspace_id.as_deref(),
                            &name,
                            worker_relay_key.as_deref(),
                        );
                        let _ = send_event(
                            sdk_out_tx,
                            json!({
                                "kind":"agent_spawned",
                                "name":&name,
                                "runtime":runtime_label(&effective_spec.runtime),
                                "provider": effective_spec.provider.clone(),
                                "cli": effective_spec.cli.clone(),
                                "model": effective_spec.model.clone(),
                                "sessionId": effective_spec.session_id.clone(),
                                "pid":pid,
                                "source":"http_api",
                                "pre_registered": worker_relay_key.is_some(),
                                "registration_warning": preregistration_warning.clone(),
                            }),
                        )
                        .await;
                        publish_agent_state_transition(
                            ws_control_tx,
                            &name,
                            "spawned",
                            Some("http_api_spawn"),
                        )
                        .await;
                        let _ = reply.send(Ok(json!({
                            "success": true,
                            "name": name,
                            "runtime": runtime_label(&effective_spec.runtime),
                            "model": effective_spec.model.clone(),
                            "sessionId": effective_spec.session_id.clone(),
                            "pid": pid,
                            "sessionId": effective_spec.session_id.clone(),
                            "pre_registered": worker_relay_key.is_some(),
                            "warning": preregistration_warning,
                        })));
                    }
                    Err(e) => {
                        if let Some(config) = &agent_result {
                            agent_result_tokens.remove(&config.token);
                        }
                        eprintln!("[agent-relay] HTTP API: failed to spawn '{}': {}", name, e);
                        let _ = reply.send(Err(e.to_string()));
                    }
                }
            }
            ListenApiRequest::SubmitAgentResult {
                token,
                name,
                data,
                final_result,
                metadata,
                reply,
            } => {
                let Some(agent_name) = agent_result_tokens.get(&token).cloned() else {
                    let _ = reply.send(Err(listen_api::AgentResultRouteError::InvalidToken));
                    return;
                };
                if let Some(requested_name) = name.as_deref() {
                    if requested_name != agent_name {
                        let _ = reply.send(Err(listen_api::AgentResultRouteError::InvalidToken));
                        return;
                    }
                }

                let result_id = format!("ar_{}", Uuid::new_v4().simple());
                let payload = json!({
                    "kind": "agent_result",
                    "name": agent_name,
                    "result_id": result_id,
                    "data": data,
                    "final": final_result,
                    "metadata": metadata,
                });
                let _ = send_event(sdk_out_tx, payload).await;
                let _ = reply.send(Ok(json!({
                    "success": true,
                    "name": agent_name,
                    "result_id": result_id,
                })));
            }
            ListenApiRequest::SetModel {
                name,
                model,
                timeout_ms,
                reply,
            } => {
                let Some(handle) = workers.workers.get_mut(&name) else {
                    let _ = reply.send(Err(format!("unknown worker '{}'", name)));
                    return;
                };

                let model_command = format!("/model {}\n", model);
                let result = async {
                    handle
                        .stdin
                        .write_all(model_command.as_bytes())
                        .await
                        .with_context(|| {
                            format!("failed writing model command to worker '{}'", name)
                        })?;
                    handle
                        .stdin
                        .flush()
                        .await
                        .with_context(|| format!("failed flushing worker '{}' stdin", name))?;
                    if let Some(timeout_ms) = timeout_ms {
                        tracing::info!(
                            name = %name,
                            timeout_ms,
                            "HTTP API set_model timeout_ms is currently advisory only"
                        );
                    }
                    Ok::<(), anyhow::Error>(())
                }
                .await;

                match result {
                    Ok(()) => {
                        let _ = reply.send(Ok(json!({
                            "name": name,
                            "model": model,
                            "success": true,
                        })));
                    }
                    Err(error) => {
                        let _ = reply.send(Err(error.to_string()));
                    }
                }
            }
            ListenApiRequest::Release {
                name,
                reason,
                reply,
            } => {
                if let Some(ref r) = reason {
                    tracing::info!(worker = %name, reason = %r, "releasing agent via HTTP API");
                }
                // Unregister from supervisor before release to prevent
                // auto-restart of intentionally released agents.
                workers.supervisor.unregister(&name);
                workers.metrics.on_release(&name);
                match workers.release(&name).await {
                    Ok(()) => {
                        if let Err(error) = relaycast_http.mark_agent_offline(&name).await {
                            tracing::warn!(
                                worker = %name,
                                error = %error,
                                "failed to mark released worker offline in relaycast"
                            );
                        }
                        let dropped = take_pending_for_worker(pending_deliveries, &name);
                        if !dropped.is_empty() {
                            let _ = send_event(
                                            sdk_out_tx,
                                            json!({"kind":"delivery_dropped","name":&name,"count":dropped.len(),"reason":"agent_released"}),
                                        ).await;
                            let _ = emit_dropped_delivery_failures(
                                sdk_out_tx,
                                &dropped,
                                "agent_released",
                            )
                            .await;
                        }
                        fail_pending_requests_for_worker(pending_requests, &name, "agent_released");
                        delivery_states.remove(&name);
                        agent_result_tokens.retain(|_, agent| agent != &name);
                        state.agents.remove(&name);
                        if paths.persist {
                            let _ = state.save(&paths.state);
                        }
                        super::fleet::prune_fleet_agent_state(
                            fleet_control_tx,
                            fleet_inventory,
                            fleet_delivery_book,
                            &name,
                        )
                        .await;
                        super::fleet::publish_fleet_load_snapshot(
                            fleet_control_tx,
                            u32::try_from(workers.workers.len()).unwrap_or(u32::MAX),
                            fleet_max_agents,
                            fleet_handlers_live,
                            true,
                        )
                        .await;
                        let _ =
                            send_event(sdk_out_tx, json!({"kind":"agent_released","name":&name}))
                                .await;
                        publish_agent_state_transition(
                            ws_control_tx,
                            &name,
                            "exited",
                            Some("http_api_release"),
                        )
                        .await;
                        let _ = reply.send(Ok(json!({ "success": true, "name": name })));
                    }
                    Err(e) => {
                        let message = e.to_string();
                        if is_unknown_worker_error_message(&message) {
                            relaycast_http.forget_agent_registration(&name);
                            state.agents.remove(&name);
                            if paths.persist {
                                let _ = state.save(&paths.state);
                            }
                            super::fleet::prune_fleet_agent_state(
                                fleet_control_tx,
                                fleet_inventory,
                                fleet_delivery_book,
                                &name,
                            )
                            .await;
                            super::fleet::publish_fleet_load_snapshot(
                                fleet_control_tx,
                                u32::try_from(workers.workers.len()).unwrap_or(u32::MAX),
                                fleet_max_agents,
                                fleet_handlers_live,
                                true,
                            )
                            .await;
                            tracing::debug!(
                                worker = %name,
                                "ignoring duplicate HTTP API release for already exited worker"
                            );
                            let _ = reply.send(Ok(json!({ "success": true, "name": name })));
                        } else {
                            eprintln!(
                                "[agent-relay] HTTP API: failed to release '{}': {}",
                                name, e
                            );
                            let _ = reply.send(Err(message));
                        }
                    }
                }
            }
            ListenApiRequest::Send {
                to,
                text,
                from,
                thread_id,
                workspace_id,
                workspace_alias,
                mode,
                reply,
            } => {
                let normalized_to = to.trim().to_string();
                let selected_workspace = resolve_workspace(
                    workspace_id.as_deref(),
                    workspace_alias.as_deref(),
                    workspaces,
                    workspace_lookup,
                    default_workspace_id.as_deref(),
                );
                let selected_workspace = match selected_workspace {
                    Ok(workspace) => workspace,
                    Err(error) => {
                        let _ = reply.send(Err(error));
                        return;
                    }
                };
                let selected_workspace_id = selected_workspace.workspace_id.clone();
                let selected_workspace_alias = selected_workspace.workspace_alias.clone();
                let workspace_self_name = selected_workspace.self_name.clone();
                let normalized_sender = normalize_sender(from.clone());
                let from_dashboard =
                    sender_is_dashboard_label(&normalized_sender, &workspace_self_name);
                let delivery_from = if from_dashboard {
                    workspace_self_name.clone()
                } else {
                    normalized_sender.clone()
                };
                tracing::info!(
                    target = "relay_broker::http_api",

                    raw_from = ?from,
                    normalized_sender = %normalized_sender,
                    from_dashboard = %from_dashboard,
                    delivery_from = %delivery_from,
                    to = %normalized_to,
                    thread_id = ?thread_id,
                    self_name = %workspace_self_name,
                    "HTTP API send request"
                );
                let ui_from = if from_dashboard {
                    workspace_self_name.clone()
                } else {
                    normalized_sender
                };
                let event_id = format!("http_{}", Uuid::new_v4().simple());
                let request_start = Instant::now();
                let relaycast_timeout = http_api_relaycast_send_timeout();
                let event_emit_timeout = http_api_event_emit_timeout();

                // Only impersonate `from` on the Relaycast publish (see
                // send_with_mode's doc comment) when it's a name this broker
                // actually has custodial responsibility for: a worker it
                // spawned, or its own identity. `delivery_from` is otherwise
                // caller-supplied and unvalidated — impersonating an
                // arbitrary string would let any HTTP API caller silently
                // register a brand-new Relaycast agent under that name, or
                // worse, ROTATE (and thereby invalidate) the live token of
                // an unrelated, already-registered agent that happens to
                // share the name. Falling back to the broker's own identity
                // is always safe; impersonation is not. The worker must also
                // belong to the workspace we're publishing into — a worker
                // attached to another attached workspace is not ours to
                // impersonate here (it would register/rotate that name in the
                // wrong Relaycast workspace).
                let publish_from =
                    if workers.has_worker_in_workspace(&delivery_from, &selected_workspace_id) {
                        delivery_from.as_str()
                    } else {
                        workspace_self_name.as_str()
                    };

                record_thread_history_event(
                    recent_thread_messages,
                    json!({
                        "event_id": event_id.clone(),
                        "from": ui_from.clone(),
                        "target": normalized_to.clone(),
                        "to": normalized_to.clone(),
                        "text": text.clone(),
                        "thread_id": thread_id.clone(),
                        "workspace_id": selected_workspace_id.clone(),
                        "workspace_alias": selected_workspace_alias.clone(),
                        "timestamp": chrono::Utc::now().to_rfc3339(),
                    }),
                );

                // All delivery is relaycast-mediated, with no local-injection
                // shortcut and no fallback switch on whether a recipient
                // happens to be attached to this broker. Even when the
                // target is a worker running right here, we publish to
                // Relaycast (cloud-hosted or a local Relaycast host — either
                // way, wherever Relaycast is) and let it redeliver over the
                // node control plane (see `handle_fleet_deliver`), exactly
                // as it would for any other client. A broker-local shortcut
                // would let a message reach a worker's PTY without Relaycast
                // ever seeing it, so anything that only observes state
                // through Relaycast (a hosted observer, a teammate's Pear,
                // cross-device sync) would silently miss messages that the
                // sender's own terminal still showed a reply to.
                tracing::info!(
                    target = "relay_broker::http_api",

                    event_id = %event_id,
                    to = %normalized_to,
                    delivery_from = %delivery_from,
                    publish_from = %publish_from,
                    ui_from = %ui_from,
                    relaycast_timeout_ms = %relaycast_timeout.as_millis(),
                    "publishing to relaycast"
                );
                // Only forward `thread_id` to the Relaycast publish when it's a
                // real message id we can reply to. Broker-minted synthetic ids
                // (`http_*`) and channel/DM grouping keys (`#general`,
                // `direct:*`) that a client may echo back from `/api/send` or
                // `/api/threads` aren't reply targets — Relaycast would reject
                // the reply and fail the whole send. Fall back to a plain post
                // (unthreaded) for those, preserving delivery.
                let reply_thread_id = thread_id
                    .as_deref()
                    .filter(|tid| is_relaycast_reply_target(tid));
                if thread_id.is_some() && reply_thread_id.is_none() {
                    tracing::debug!(
                        target = "relay_broker::http_api",
                        event_id = %event_id,
                        thread_id = ?thread_id,
                        "thread_id is not a Relaycast message id; publishing without a thread reply"
                    );
                }
                let relaycast_start = Instant::now();
                match timeout(
                    relaycast_timeout,
                    selected_workspace.http_client.send_with_mode(
                        &normalized_to,
                        &text,
                        mode.clone(),
                        publish_from,
                        reply_thread_id,
                    ),
                )
                .await
                {
                    Ok(Ok(())) => {
                        tracing::info!(
                            target = "relay_broker::http_api",

                            event_id = %event_id,
                            to = %normalized_to,
                            relaycast_ms = %relaycast_start.elapsed().as_millis(),
                            "relaycast publish succeeded"
                        );
                        emit_http_api_event_with_timeout(
                            sdk_out_tx,
                            json!({
                                "kind": "relay_inbound",
                                "event_id": event_id,
                                "from": ui_from,
                                "target": normalized_to,
                                "body": text,
                                "thread_id": thread_id.clone(),
                                "workspace_id": selected_workspace_id.clone(),
                                "workspace_alias": selected_workspace_alias.clone(),
                            }),
                            event_emit_timeout,
                        )
                        .await;
                        if reply
                            .send(Ok(json!({
                                "success": true,
                                "event_id": event_id,
                                "relaycast_published": true,
                                "local": false,
                                "workspace_id": selected_workspace_id,
                                "workspace_alias": selected_workspace_alias,
                            })))
                            .is_err()
                        {
                            tracing::warn!(
                                target = "relay_broker::http_api",

                                event_id = %event_id,
                                "broker HTTP API reply channel closed before relaycast response"
                            );
                        }
                    }
                    Ok(Err(error)) => {
                        tracing::warn!(
                            target = "relay_broker::http_api",

                            event_id = %event_id,
                            to = %normalized_to,
                            relaycast_ms = %relaycast_start.elapsed().as_millis(),
                            error = %error,
                            "relaycast publish failed"
                        );
                        if reply
                            .send(Err(format!("Relaycast publish failed: {error}")))
                            .is_err()
                        {
                            tracing::warn!(
                                target = "relay_broker::http_api",

                                event_id = %event_id,
                                "broker HTTP API reply channel closed before relaycast failure response"
                            );
                        }
                    }
                    Err(_) => {
                        tracing::warn!(
                            target = "relay_broker::http_api",

                            event_id = %event_id,
                            to = %normalized_to,
                            relaycast_timeout_ms = %relaycast_timeout.as_millis(),
                            relaycast_ms = %relaycast_start.elapsed().as_millis(),
                            "relaycast publish timed out"
                        );
                        if reply
                            .send(Err(format!(
                                "Relaycast publish timed out after {}ms",
                                relaycast_timeout.as_millis()
                            )))
                            .is_err()
                        {
                            tracing::warn!(
                                target = "relay_broker::http_api",

                                event_id = %event_id,
                                "broker HTTP API reply channel closed before relaycast timeout response"
                            );
                        }
                    }
                }
                tracing::info!(
                    target = "relay_broker::http_api",

                    event_id = %event_id,
                    to = %normalized_to,
                    total_ms = %request_start.elapsed().as_millis(),
                    "HTTP API send request handling complete"
                );
            }
            ListenApiRequest::List { reply } => {
                let _ = reply.send(Ok(json!({ "agents": workers.list() })));
            }
            ListenApiRequest::Threads { reply } => {
                let mut messages: Vec<Value> = recent_thread_messages.iter().cloned().collect();
                match relaycast_http.get_all_dms(200).await {
                    Ok(dm_messages) => messages.extend(dm_messages),
                    Err(error) => {
                        tracing::debug!(
                            error = %error,
                            "failed to fetch relaycast dm history for /api/threads"
                        );
                    }
                }
                let threads = build_thread_infos(&messages, self_names);
                let _ = reply.send(Ok(json!({ "threads": threads })));
            }
            ListenApiRequest::CreateObserverToken {
                workspace_id,
                workspace_alias,
                name,
                reply,
            } => {
                let selected_workspace = resolve_workspace(
                    workspace_id.as_deref(),
                    workspace_alias.as_deref(),
                    workspaces,
                    workspace_lookup,
                    default_workspace_id.as_deref(),
                );
                let selected_workspace = match selected_workspace {
                    Ok(workspace) => workspace,
                    Err(error) => {
                        let _ = reply.send(Err(error));
                        return;
                    }
                };
                let selected_workspace_id = selected_workspace.workspace_id.clone();
                let selected_workspace_alias = selected_workspace.workspace_alias.clone();
                let token_name = name
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or_else(|| DEFAULT_OBSERVER_TOKEN_NAME.to_string());

                // Bounded the same way `Send`'s relaycast publish is: if the
                // SDK call hangs, this broker task must not block
                // indefinitely on it (the HTTP layer already gives up after
                // `LISTEN_API_SEND_TIMEOUT`, but that alone wouldn't free
                // this runtime task). Uses its own timeout (distinct from
                // `http_api_relaycast_send_timeout`) so tuning the `/api/send`
                // path can't unintentionally break token minting.
                let relaycast_timeout = http_api_observer_token_timeout();
                match mint_or_recover_observer_token(
                    &selected_workspace.http_client,
                    &token_name,
                    relaycast_timeout,
                )
                .await
                {
                    Ok(outcome) => {
                        let recovered_via_rotate = outcome.is_recovered_via_rotate();
                        let observer_token = outcome.into_token();
                        if recovered_via_rotate {
                            tracing::info!(
                                target = "relay_broker::http_api",
                                workspace_id = %selected_workspace_id,
                                observer_token_id = %observer_token.id,
                                token_name = %token_name,
                                "observer token name conflict on mint; recovered existing \
                                 token via list+rotate (this invalidates whatever raw token \
                                 was previously issued under this name)"
                            );
                        } else {
                            tracing::info!(
                                target = "relay_broker::http_api",
                                workspace_id = %selected_workspace_id,
                                observer_token_id = %observer_token.id,
                                "minted observer token via HTTP API"
                            );
                        }
                        let _ = reply.send(Ok(json!({
                            "success": true,
                            "id": observer_token.id,
                            "token": observer_token.token,
                            "name": observer_token.name,
                            "scopes": observer_token.scopes,
                            "workspace_id": selected_workspace_id,
                            "workspace_alias": selected_workspace_alias,
                        })));
                    }
                    Err(ObserverTokenMintError::Failed(message)) => {
                        tracing::warn!(
                            target = "relay_broker::http_api",
                            workspace_id = %selected_workspace_id,
                            error = %message,
                            "failed to mint observer token via HTTP API"
                        );
                        let _ = reply.send(Err(message));
                    }
                    Err(ObserverTokenMintError::TimedOut) => {
                        tracing::warn!(
                            target = "relay_broker::http_api",
                            workspace_id = %selected_workspace_id,
                            timeout_ms = %relaycast_timeout.as_millis(),
                            "timed out minting observer token via HTTP API"
                        );
                        let _ = reply.send(Err(format!(
                            "Failed to create observer token: timed out after {}ms",
                            relaycast_timeout.as_millis()
                        )));
                    }
                }
            }
            ListenApiRequest::SendInput { name, data, reply } => {
                match workers
                    .workers
                    .get(&name)
                    .map(|handle| handle.spec.runtime.clone())
                {
                    None => {
                        let _ =
                            reply.send(Err(format!("agent_not_found: no worker named '{name}'")));
                    }
                    Some(AgentRuntime::Headless) => {
                        let _ = reply.send(Err(format!(
                            "unsupported_runtime: worker '{name}' is headless; pty input is only supported on PTY workers"
                        )));
                    }
                    Some(AgentRuntime::Pty) => {
                        if let Err(err) = workers
                            .send_to_worker(
                                &name,
                                "write_pty",
                                Some(RequestId::new(format!("api_{}", Uuid::new_v4().simple()))),
                                json!({ "data": data }),
                            )
                            .await
                        {
                            let _ = reply.send(Err(format!("agent_not_found: {}", err)));
                        } else {
                            let _ = reply.send(Ok(json!({
                                "name": name,
                                "bytes_written": data.len(),
                            })));
                        }
                    }
                }
            }
            ListenApiRequest::CheckPtyInputTarget { name, reply } => {
                match workers
                    .workers
                    .get(&name)
                    .map(|handle| handle.spec.runtime.clone())
                {
                    None => {
                        let _ =
                            reply.send(Err(format!("agent_not_found: no worker named '{name}'")));
                    }
                    Some(AgentRuntime::Headless) => {
                        let _ = reply.send(Err(format!(
                            "unsupported_runtime: worker '{name}' is headless; pty input streams are only supported on PTY workers"
                        )));
                    }
                    Some(AgentRuntime::Pty) => {
                        let _ = reply.send(Ok(json!({
                            "name": name,
                            "runtime": "pty",
                        })));
                    }
                }
            }
            ListenApiRequest::ResizePty {
                name,
                rows,
                cols,
                reply,
            } => {
                if rows == 0 || cols == 0 {
                    let _ =
                        reply.send(Err("invalid_dimensions: rows and cols must be >= 1".into()));
                } else {
                    match workers
                        .workers
                        .get(&name)
                        .map(|handle| handle.spec.runtime.clone())
                    {
                        None => {
                            let _ = reply
                                .send(Err(format!("agent_not_found: no worker named '{name}'")));
                        }
                        Some(AgentRuntime::Headless) => {
                            let _ = reply.send(Err(format!(
                                "unsupported_runtime: worker '{name}' is headless; resize_pty is only supported on PTY workers"
                            )));
                        }
                        Some(AgentRuntime::Pty) => {
                            if let Err(err) = workers
                                .send_to_worker(
                                    &name,
                                    "resize_pty",
                                    Some(RequestId::new(format!(
                                        "api_{}",
                                        Uuid::new_v4().simple()
                                    ))),
                                    json!({ "rows": rows, "cols": cols }),
                                )
                                .await
                            {
                                let _ = reply.send(Err(format!("agent_not_found: {}", err)));
                            } else {
                                let _ = reply.send(Ok(json!({
                                    "name": name,
                                    "rows": rows,
                                    "cols": cols,
                                })));
                            }
                        }
                    }
                }
            }
            ListenApiRequest::WorkerRequest {
                name,
                kind,
                payload,
                timeout,
                reply,
            } => {
                // Generic worker request/response: validate the
                // worker exists and supports a PTY (all current
                // request/response routes target the PTY side),
                // then ship the frame and park the `reply`
                // oneshot in `pending_requests`. The response is
                // fulfilled either by the `*_response` arm below
                // or by the deadline sweep in `reap_tick`.
                //
                // Headless workers don't run a VT and don't handle
                // PTY-oriented RPCs — short-circuit with a typed
                // error rather than letting the request sit until
                // the timeout sweep returns a misleading
                // `worker_timeout`.
                let runtime = workers
                    .workers
                    .get(&name)
                    .map(|handle| handle.spec.runtime.clone());
                match runtime {
                    None => {
                        let _ =
                            reply.send(Err(worker_request::RequestWorkerError::WorkerNotFound(
                                format!("no worker named '{name}'"),
                            )));
                    }
                    Some(AgentRuntime::Headless) => {
                        let _ = reply.send(Err(
                                        worker_request::RequestWorkerError::UnsupportedRuntime(
                                            format!("worker '{name}' is headless; {kind} is only supported on PTY workers"),
                                        ),
                                    ));
                    }
                    Some(AgentRuntime::Pty) => {
                        let request_id = RequestId::new(format!("req_{}", Uuid::new_v4().simple()));
                        if let Err(err) = workers
                            .send_to_worker(&name, &kind, Some(request_id.clone()), payload)
                            .await
                        {
                            let _ = reply.send(Err(
                                worker_request::RequestWorkerError::SendFailed(err.to_string()),
                            ));
                        } else {
                            pending_requests.insert(
                                request_id.into_string(),
                                worker_request::PendingRequest {
                                    kind,
                                    worker_name: name.into_string(),
                                    reply,
                                    deadline: Instant::now() + timeout,
                                },
                            );
                        }
                    }
                }
            }
            ListenApiRequest::GetMetrics { agent, reply } => {
                if let Some(ref agent_name) = agent {
                    if let Some(handle) = workers.workers.get(agent_name) {
                        let m = build_agent_metrics(handle);
                        let _ = reply.send(Ok(json!({ "agents": [m], "broker": workers.metrics.snapshot(workers.workers.len()) })));
                    } else {
                        let _ = reply.send(Err(format!("unknown worker '{}'", agent_name)));
                    }
                } else {
                    let mut agent_metrics: Vec<AgentMetrics> =
                        workers.workers.values().map(build_agent_metrics).collect();
                    agent_metrics.sort_by(|a, b| a.name.cmp(&b.name));
                    let _ = reply.send(Ok(json!({
                        "agents": agent_metrics,
                        "broker": workers.metrics.snapshot(workers.workers.len()),
                    })));
                }
            }
            ListenApiRequest::GetStatus { reply } => {
                let pending: Vec<Value> = pending_deliveries
                    .values()
                    .map(|pd| {
                        json!({
                            "delivery_id": pd.delivery.delivery_id,
                            "worker_name": pd.worker_name,
                            "event_id": pd.delivery.event_id,
                            "from": pd.delivery.from,
                            "to": pd.delivery.target,
                            "attempts": pd.attempts,
                            "queued_at_ms": pd.queued_at_ms,
                            "age_ms": unix_timestamp_millis().saturating_sub(pd.queued_at_ms),
                            "last_error": pd.last_error,
                        })
                    })
                    .collect();
                let auth_workspaces: Vec<Value> = workspaces
                    .iter()
                    .map(|workspace| {
                        json!({
                            "workspace_id": workspace.workspace_id,
                            "workspace_alias": workspace.workspace_alias,
                            "self_name": workspace.self_name,
                            "self_agent_id": workspace.self_agent_id,
                            "authenticated": true,
                            "default": default_workspace_id
                                .as_deref()
                                .is_some_and(|id| id == workspace.workspace_id),
                        })
                    })
                    .collect();
                let _ = reply.send(Ok(json!({
                    "agent_count": workers.workers.len(),
                    "agents": workers.list(),
                    "pending_delivery_count": pending.len(),
                    "pending_deliveries": pending,
                    "node_connected": node_delivery_connected,
                    "node_delivery": {
                        "token_present": node_delivery_token_present,
                        "connected": node_delivery_connected,
                    },
                    "auth": {
                        "authenticated": !auth_workspaces.is_empty(),
                        "workspace_count": auth_workspaces.len(),
                        "default_workspace_id": default_workspace_id,
                        "workspaces": auth_workspaces,
                    },
                })));
            }
            ListenApiRequest::GetCrashInsights { reply } => {
                let _ = reply.send(Ok(crash_insights.to_json()));
            }
            ListenApiRequest::Preflight { agents, reply } => {
                let count = agents.len();
                let _ = reply.send(Ok(json!({ "queued": count })));
                // Background preflight — same as stdio handler
                for entry in agents {
                    let http = relaycast_http.clone();
                    tokio::spawn(async move {
                        let _ = tokio::time::timeout(
                            Duration::from_secs(30),
                            http.register_agent_token(&entry.name, Some(&entry.cli)),
                        )
                        .await;
                    });
                }
            }
            ListenApiRequest::SubscribeChannels {
                name,
                channels,
                reply,
            } => {
                let (workspace_id, parent, spec, pid, added, all_channels) = {
                    let Some(handle) = workers.workers.get_mut(&name) else {
                        let _ = reply.send(Err(format!("unknown worker '{}'", name)));
                        return;
                    };
                    let mut added = Vec::new();
                    for ch in &channels {
                        let exists = handle
                            .spec
                            .channels
                            .iter()
                            .any(|c| c.eq_ignore_ascii_case(ch));
                        if !exists {
                            handle.spec.channels.push(ch.clone());
                            added.push(ch.clone());
                        }
                    }
                    (
                        handle.workspace_id.clone(),
                        handle.parent.clone(),
                        handle.spec.clone(),
                        handle.child.id(),
                        added,
                        handle.spec.channels.clone(),
                    )
                };

                if !added.is_empty() {
                    let workspace = workspace_for_channel_update(
                        workspace_id.as_deref(),
                        workspace_lookup,
                        default_workspace_id.as_deref(),
                        default_workspace,
                    );
                    if let Err(error) = workspace.http_client.ensure_extra_channels(&added).await {
                        tracing::warn!(
                            worker = %name,
                            workspace_id = %workspace.workspace_id,
                            channels = ?added,
                            error = %error,
                            "failed to ensure subscribed channels"
                        );
                    }
                    if let Err(error) = workspace
                        .ws_control_tx
                        .send(WsControl::Subscribe(added.clone()))
                        .await
                    {
                        tracing::warn!(
                            worker = %name,
                            workspace_id = %workspace.workspace_id,
                            channels = ?added,
                            error = %error,
                            "failed to send ws channel subscribe control"
                        );
                    }
                }

                persist_agent_channels(state, &name, parent, spec, pid, all_channels.clone());
                if paths.persist {
                    if let Err(error) = state.save(&paths.state) {
                        tracing::warn!(
                            path = %paths.state.display(),
                            worker = %name,
                            error = %error,
                            "failed to persist channel subscriptions"
                        );
                    }
                }
                let _ = reply.send(Ok(json!({
                    "name": name,
                    "channels": all_channels,
                })));
            }
            ListenApiRequest::UnsubscribeChannels {
                name,
                channels,
                reply,
            } => {
                let (workspace_id, parent, spec, pid, removed, remaining) = {
                    let Some(handle) = workers.workers.get_mut(&name) else {
                        let _ = reply.send(Err(format!("unknown worker '{}'", name)));
                        return;
                    };
                    let before = handle.spec.channels.clone();
                    handle
                        .spec
                        .channels
                        .retain(|c| !channels.iter().any(|rem| rem.eq_ignore_ascii_case(c)));
                    let remaining = handle.spec.channels.clone();
                    let removed = before
                        .into_iter()
                        .filter(|channel| {
                            !remaining
                                .iter()
                                .any(|kept| kept.eq_ignore_ascii_case(channel))
                        })
                        .collect::<Vec<_>>();
                    (
                        handle.workspace_id.clone(),
                        handle.parent.clone(),
                        handle.spec.clone(),
                        handle.child.id(),
                        removed,
                        remaining,
                    )
                };

                if !removed.is_empty() {
                    let workspace = workspace_for_channel_update(
                        workspace_id.as_deref(),
                        workspace_lookup,
                        default_workspace_id.as_deref(),
                        default_workspace,
                    );
                    let target_workspace_id = effective_channel_workspace_id(
                        workspace_id.as_deref(),
                        default_workspace_id.as_deref(),
                    );
                    let unsubscribe = removed
                        .iter()
                        .filter(|channel| {
                            !workers.workers.values().any(|handle| {
                                effective_channel_workspace_id(
                                    handle.workspace_id.as_deref(),
                                    default_workspace_id.as_deref(),
                                ) == target_workspace_id
                                    && channel_in_list(&handle.spec.channels, channel)
                            })
                        })
                        .cloned()
                        .collect::<Vec<_>>();
                    if !unsubscribe.is_empty() {
                        if let Err(error) = workspace
                            .ws_control_tx
                            .send(WsControl::Unsubscribe(unsubscribe.clone()))
                            .await
                        {
                            tracing::warn!(
                                worker = %name,
                                workspace_id = %workspace.workspace_id,
                                channels = ?unsubscribe,
                                error = %error,
                                "failed to send ws channel unsubscribe control"
                            );
                        }
                    }
                }

                persist_agent_channels(state, &name, parent, spec, pid, remaining.clone());
                if paths.persist {
                    if let Err(error) = state.save(&paths.state) {
                        tracing::warn!(
                            path = %paths.state.display(),
                            worker = %name,
                            error = %error,
                            "failed to persist channel subscriptions"
                        );
                    }
                }
                let _ = reply.send(Ok(json!({
                    "name": name,
                    "channels": remaining,
                })));
            }
            ListenApiRequest::GetInboundDeliveryMode { name, reply } => {
                if !workers.has_worker(&name) {
                    let _ = reply.send(Err(DeliveryRouteError::WorkerNotFound(name)));
                } else {
                    let mode = delivery_states
                        .get(&name)
                        .map(|s| s.mode)
                        .unwrap_or_default();
                    let _ = reply.send(Ok(mode));
                }
            }
            ListenApiRequest::SetInboundDeliveryMode { name, mode, reply } => {
                if !workers.has_worker(&name) {
                    let _ = reply.send(Err(DeliveryRouteError::WorkerNotFound(name)));
                } else {
                    let entry = delivery_states.entry(name.clone()).or_default();
                    let previous = entry.mode;
                    entry.mode = mode;
                    let to_flush: Vec<PendingRelayMessage> = if previous
                        == InboundDeliveryMode::ManualFlush
                        && mode == InboundDeliveryMode::AutoInject
                    {
                        entry.drain_pending()
                    } else {
                        Vec::new()
                    };
                    let flushed = to_flush.len();
                    if !to_flush.is_empty() {
                        tracing::info!(
                            target = "agent_relay::broker",
                            worker = %name,
                            drained = flushed,
                            "draining pending queue on manual_flush → auto_inject transition"
                        );
                    }
                    for queued in to_flush {
                        inject_pending_relay_message(
                            workers,
                            pending_deliveries,
                            &name,
                            &queued,
                            delivery_retry_interval,
                        )
                        .await;
                    }
                    tracing::info!(
                        target = "agent_relay::broker",
                        worker = %name,
                        previous_mode = previous.as_wire_str(),
                        mode = mode.as_wire_str(),
                        flushed,
                        "inbound delivery mode updated"
                    );
                    if previous != mode {
                        let _ = send_event(
                            sdk_out_tx,
                            json!({
                                "kind":"agent_inbound_delivery_mode_changed",
                                "name":&name,
                                "previous_mode":previous.as_wire_str(),
                                "mode":mode.as_wire_str(),
                            }),
                        )
                        .await;
                    }
                    if flushed > 0 {
                        let _ = send_event(
                            sdk_out_tx,
                            json!({
                                "kind":"agent_pending_drained",
                                "name":&name,
                                "count":flushed,
                                "reason":"delivery_mode_transition",
                            }),
                        )
                        .await;
                    }
                    let _ = reply.send(Ok(SetInboundDeliveryModeOk { mode, flushed }));
                }
            }
            ListenApiRequest::GetPending { name, reply } => {
                if !workers.has_worker(&name) {
                    let _ = reply.send(Err(DeliveryRouteError::WorkerNotFound(name)));
                } else {
                    let snapshot = delivery_states
                        .get(&name)
                        .map(|s| s.pending_snapshot())
                        .unwrap_or_default();
                    let _ = reply.send(Ok(snapshot));
                }
            }
            ListenApiRequest::FlushPending { name, reply } => {
                if !workers.has_worker(&name) {
                    let _ = reply.send(Err(DeliveryRouteError::WorkerNotFound(name)));
                } else {
                    let to_flush: Vec<PendingRelayMessage> = delivery_states
                        .get_mut(&name)
                        .map(|state| state.drain_pending())
                        .unwrap_or_default();
                    let flushed = to_flush.len();
                    if flushed > 0 {
                        tracing::info!(
                            target = "agent_relay::broker",
                            worker = %name,
                            drained = flushed,
                            "flushing pending queue on explicit /flush"
                        );
                    }
                    for queued in to_flush {
                        inject_pending_relay_message(
                            workers,
                            pending_deliveries,
                            &name,
                            &queued,
                            delivery_retry_interval,
                        )
                        .await;
                    }
                    if flushed > 0 {
                        let _ = send_event(
                            sdk_out_tx,
                            json!({
                                "kind":"agent_pending_drained",
                                "name":&name,
                                "count":flushed,
                                "reason":"explicit_flush",
                            }),
                        )
                        .await;
                    }
                    let _ = reply.send(Ok(flushed));
                }
            }
            ListenApiRequest::Shutdown { reply } => {
                let _ = reply.send(Ok(json!({ "status": "shutting_down" })));
                *shutdown = true;
            }
            ListenApiRequest::RenewLease { reply } => {
                *last_lease_renewal = Instant::now();
                let expires_in = lease_duration.map(|d| d.as_secs()).unwrap_or(0);
                let _ = reply.send(Ok(json!({
                    "renewed": true,
                    "expires_in_secs": expires_in,
                    "persist": persist,
                })));
            }
            ListenApiRequest::FleetSidecarConnect { .. }
            | ListenApiRequest::FleetSidecarDisconnect
            | ListenApiRequest::FleetSidecarFrame { .. } => {
                unreachable!("fleet sidecar API requests are handled before runtime borrows")
            }
        }
    }
}

/// Resolve which attached workspace an HTTP API request targets. Shared by
/// every route that accepts optional `workspaceId`/`workspaceAlias` fields
/// (`/api/send`, `/api/observer-token`, ...): explicit id, explicit alias,
/// the sole attached workspace, the configured default, or — with more than
/// one workspace attached and no default — an `ambiguous_workspace:` error
/// the caller must resolve by supplying one of the two fields. A
/// `workspace_not_found:` error is returned when an explicit id/alias/default
/// doesn't match any attached workspace.
pub(crate) fn resolve_workspace(
    workspace_id: Option<&str>,
    workspace_alias: Option<&str>,
    workspaces: &[RelayWorkspace],
    workspace_lookup: &HashMap<WorkspaceId, RelayWorkspace>,
    default_workspace_id: Option<&str>,
) -> Result<RelayWorkspace, String> {
    if let Some(workspace_id) = workspace_id {
        workspace_lookup.get(workspace_id).cloned().ok_or_else(|| {
            format!(
                "workspace_not_found:workspace '{}' is not attached",
                workspace_id
            )
        })
    } else if let Some(workspace_alias) = workspace_alias {
        workspaces
            .iter()
            .find(|workspace| {
                workspace
                    .workspace_alias
                    .as_deref()
                    .is_some_and(|alias| alias.eq_ignore_ascii_case(workspace_alias))
            })
            .cloned()
            .ok_or_else(|| {
                format!(
                    "workspace_not_found:workspace alias '{}' is not attached",
                    workspace_alias
                )
            })
    } else if workspaces.len() == 1 {
        Ok(workspaces[0].clone())
    } else if let Some(default_workspace_id) = default_workspace_id {
        workspace_lookup
            .get(default_workspace_id)
            .cloned()
            .ok_or_else(|| {
                format!(
                    "workspace_not_found: default workspace '{}' not found",
                    default_workspace_id
                )
            })
    } else {
        Err("ambiguous_workspace:workspaceId or workspaceAlias is required when multiple workspaces are attached".to_string())
    }
}

fn workspace_for_channel_update<'a>(
    workspace_id: Option<&str>,
    workspace_lookup: &'a HashMap<WorkspaceId, RelayWorkspace>,
    default_workspace_id: Option<&str>,
    default_workspace: &'a RelayWorkspace,
) -> &'a RelayWorkspace {
    workspace_id
        .and_then(|id| workspace_lookup.get(id))
        .or_else(|| default_workspace_id.and_then(|id| workspace_lookup.get(id)))
        .unwrap_or(default_workspace)
}

fn effective_channel_workspace_id<'a>(
    workspace_id: Option<&'a str>,
    default_workspace_id: Option<&'a str>,
) -> Option<&'a str> {
    workspace_id.or(default_workspace_id)
}

fn channel_in_list(channels: &[ChannelName], channel: &str) -> bool {
    channels
        .iter()
        .any(|existing| existing.as_str().eq_ignore_ascii_case(channel))
}

/// One-line skill text prepended for CLI harnesses that need a minimal relay lifecycle hint.
const RELAY_WORKER_ONE_LINER: &str = "\
Call mcp__agent-relay__add_agent(name, cli, task) to spawn a relay worker \
(cli: \"claude\", \"codex\", \"gemini\", or \"opencode\"; add model for Claude tier, \
e.g. model: \"claude-opus-4-8\"), and mcp__agent-relay__remove_agent(name) to release when done.";

/// Skill text prepended to the task for small/fast models (haiku, mini, flash) that need
/// explicit tool guidance to reliably call mcp__agent-relay__add_agent.
/// Eval data: haiku achieves 0/5 spawn reliability without guidance, 5/5 with this text.
/// Sonnet/Opus pass bare (0-shot), so they receive no prefix.
const SMALL_MODEL_RELAY_SKILL: &str = "\
## Agent Relay — Worker Management

### Spawn a relay worker
To delegate a task to a dedicated relay worker agent, call:
  mcp__agent-relay__add_agent(name: \"WorkerName\", cli: \"claude\", task: \"full task instructions\")
Required: name (unique string), cli (\"claude\", \"codex\", \"gemini\", or \"opencode\"), task (complete instructions).
To pin a Claude model: add model: \"claude-opus-4-8\" (Opus), \"claude-sonnet-4-6\" (Sonnet), or \"claude-haiku-4-5-20251001\" (Haiku).
The relay worker will DM you \"ACK: <understanding>\" when it starts and \"DONE: <result>\" when complete.

### Release a relay worker
When a relay worker reports DONE, immediately release them:
  mcp__agent-relay__remove_agent(name: \"WorkerName\")
Always release relay workers — unreleased agents waste resources.

### When to spawn
Spawn when: the task asks you to delegate or assign work, is large, needs specialised focus, or would block your own progress.";

/// Returns true for small/fast model tiers that need explicit relay skill injection.
/// Matches haiku (Claude), mini (GPT), flash (Gemini), and generic small-tier names.
fn is_small_model_tier(model: &str) -> bool {
    let m = model.to_lowercase();
    m.contains("haiku") || m.contains("-mini") || m.contains("-flash") || m.contains("small")
}

/// Returns the skill prefix to prepend to the initial task, if any.
/// Only small-tier models receive the prefix; larger models are self-sufficient.
fn model_skill_prefix(model: Option<&str>) -> Option<&'static str> {
    model
        .filter(|m| is_small_model_tier(m))
        .map(|_| SMALL_MODEL_RELAY_SKILL)
}

/// Returns the CLI-specific relay skill prefix, if that harness needs one.
fn cli_skill_prefix(cli: &str) -> Option<&'static str> {
    let command = shlex::split(cli)
        .and_then(|parts| parts.into_iter().next())
        .or_else(|| cli.split_whitespace().next().map(ToOwned::to_owned))
        .unwrap_or_else(|| cli.to_string());
    let cli = Path::new(&command)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(command.as_str())
        .to_lowercase();
    if cli == "gemini" {
        Some(RELAY_WORKER_ONE_LINER)
    } else {
        None
    }
}

/// Returns the combined relay skill prefix for a spawned agent.
pub(super) fn relay_skill_prefix(cli: &str, model: Option<&str>) -> Option<String> {
    let mut parts = Vec::new();
    if let Some(prefix) = model_skill_prefix(model) {
        parts.push(prefix);
    }
    if let Some(prefix) = cli_skill_prefix(cli) {
        parts.push(prefix);
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n\n"))
    }
}

#[cfg(test)]
mod skill_injection_tests {
    use super::{
        cli_skill_prefix, is_small_model_tier, model_skill_prefix, relay_skill_prefix,
        RELAY_WORKER_ONE_LINER, SMALL_MODEL_RELAY_SKILL,
    };

    #[test]
    fn small_tier_models_receive_prefix() {
        assert!(is_small_model_tier("claude-haiku-4-5-20251001"));
        assert!(is_small_model_tier("claude-haiku-4-5"));
        assert!(is_small_model_tier("gpt-4o-mini"));
        assert!(is_small_model_tier("gemini-2.0-flash"));
        assert!(is_small_model_tier("gemini-1.5-flash-latest"));
    }

    #[test]
    fn large_tier_models_receive_no_prefix() {
        assert!(!is_small_model_tier("claude-sonnet-4-6"));
        assert!(!is_small_model_tier("claude-opus-4-8"));
        assert!(!is_small_model_tier("gpt-4o"));
        assert!(!is_small_model_tier("gemini-1.5-pro"));
    }

    #[test]
    fn none_model_receives_no_prefix() {
        assert!(model_skill_prefix(None).is_none());
    }

    #[test]
    fn haiku_model_receives_skill_prefix() {
        let prefix = model_skill_prefix(Some("claude-haiku-4-5-20251001"));
        assert_eq!(prefix, Some(SMALL_MODEL_RELAY_SKILL));
        let text = prefix.unwrap();
        assert!(text.contains("mcp__agent-relay__add_agent"));
        assert!(text.contains("mcp__agent-relay__remove_agent"));
        assert!(text.contains("relay worker"));
        assert!(!text.contains("Do it yourself"));
    }

    #[test]
    fn cli_specific_harnesses_receive_prefixes() {
        assert_eq!(cli_skill_prefix("gemini"), Some(RELAY_WORKER_ONE_LINER));
        assert_eq!(
            cli_skill_prefix("gemini --model pro"),
            Some(RELAY_WORKER_ONE_LINER)
        );
        assert_eq!(
            cli_skill_prefix("/usr/local/bin/gemini --model pro"),
            Some(RELAY_WORKER_ONE_LINER)
        );
        // droid: no injection — broker injection kills s03 bare (0/5 vs 5/5 baseline without it)
        assert_eq!(cli_skill_prefix("droid"), None);
        assert_eq!(cli_skill_prefix("/opt/homebrew/bin/droid --foo"), None);
        assert_eq!(cli_skill_prefix("codex"), None);
        assert_eq!(cli_skill_prefix("claude"), None);
    }

    #[test]
    fn relay_skill_prefix_combines_model_and_cli_guidance() {
        let prefix = relay_skill_prefix("gemini", Some("gemini-2.0-flash")).unwrap();
        assert!(prefix.contains("## Agent Relay"));
        assert!(prefix.contains(RELAY_WORKER_ONE_LINER));

        // droid gets no injection — broker-injected skill text suppresses relay tool use entirely
        assert!(relay_skill_prefix("droid", None).is_none());

        assert!(relay_skill_prefix("codex", Some("gpt-5.5")).is_none());
    }
}

fn persist_agent_channels(
    state: &mut broker::BrokerState,
    name: &str,
    parent: Option<String>,
    mut spec: AgentSpec,
    pid: Option<u32>,
    channels: Vec<ChannelName>,
) {
    spec.channels = channels.clone();
    let runtime = spec.runtime.clone();
    let agent = state
        .agents
        .entry(WorkerName::from(name))
        .or_insert_with(|| broker::PersistedAgent {
            runtime: runtime.clone(),
            parent: parent.clone(),
            channels: channels.clone(),
            pid,
            started_at: Some(unix_timestamp_secs()),
            spec: Some(spec.clone()),
            restart_policy: None,
            initial_task: None,
        });
    agent.runtime = runtime;
    agent.parent = parent;
    agent.channels = channels;
    agent.pid = pid;
    agent.spec = Some(spec);
}
