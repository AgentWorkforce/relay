use super::*;
use crate::{
    fleet_wire::{
        ActionInvoke, ActionResult, AgentDeregister, AgentRegister, BrokerToRelaycast, Deliver,
        DeliveryMode, RelaycastToBroker, FLEET_WIRE_VERSION,
    },
    node_control::{delivery_ack, HandlerDispatchDecision},
    protocol::{BrokerToSdk, SdkToBroker},
};

const FLEET_AGENT_REGISTER_TIMEOUT: Duration = Duration::from_secs(30);
#[derive(Debug, Clone, Default)]
pub(super) struct FleetSidecarRestartState {
    policy: RestartPolicy,
    total_restarts: u32,
    consecutive_failures: u32,
}

impl FleetSidecarRestartState {
    fn reset(&mut self, policy: RestartPolicy) {
        self.policy = policy;
        self.total_restarts = 0;
        self.consecutive_failures = 0;
    }

    fn clear(&mut self) {
        self.reset(RestartPolicy::default());
    }

    fn on_exit(&mut self) -> RestartDecision {
        if !self.policy.enabled {
            return RestartDecision::PermanentlyDead {
                reason: "restart policy disabled".to_string(),
            };
        }

        self.consecutive_failures += 1;
        if self.total_restarts >= self.policy.max_restarts {
            return RestartDecision::PermanentlyDead {
                reason: format!("exceeded max restarts ({})", self.policy.max_restarts),
            };
        }
        if self.consecutive_failures > self.policy.max_consecutive_failures {
            return RestartDecision::PermanentlyDead {
                reason: format!(
                    "exceeded max consecutive failures ({})",
                    self.policy.max_consecutive_failures
                ),
            };
        }

        RestartDecision::Restart {
            delay: Duration::from_millis(self.policy.cooldown_ms),
        }
    }

    fn on_restarted(&mut self) {
        self.total_restarts += 1;
        self.consecutive_failures = 0;
    }
}

impl BrokerRuntime {
    pub(super) async fn handle_fleet_sidecar_connect(
        &mut self,
        outbound: mpsc::Sender<ProtocolEnvelope<Value>>,
    ) -> Result<Value, String> {
        self.fleet_mode_enabled = true;
        self.fleet_sidecar_out_tx = Some(outbound);
        self.fleet_handlers.connect_sidecar();
        self.publish_fleet_load(true).await;
        Ok(json!({"connected": true}))
    }

    pub(super) async fn handle_fleet_sidecar_disconnect(&mut self) {
        self.fleet_sidecar_out_tx = None;
        self.fleet_handlers.disconnect_sidecar();
        for result in self.fleet_handlers.drain_in_flight_unavailable() {
            self.send_fleet_action_result(result).await;
        }
        if self.fleet_sidecar_supervision.is_some() && self.fleet_sidecar_child.is_none() {
            self.schedule_fleet_sidecar_restart("sidecar disconnected");
        }
        self.publish_fleet_load(true).await;
    }

    async fn handle_fleet_sidecar_deregister(&mut self) -> Result<(), String> {
        self.fleet_sidecar_out_tx = None;
        self.fleet_handlers.disconnect_sidecar();
        for result in self.fleet_handlers.drain_in_flight_unavailable() {
            self.send_fleet_action_result(result).await;
        }
        self.fleet_sidecar_supervision = None;
        self.fleet_sidecar_restart_at = None;
        self.fleet_sidecar_restart.clear();
        self.fleet_sidecar_child = None;
        self.fleet_control_tx
            .send(FleetControlCommand::DeregisterNode)
            .await
            .map_err(|_| "fleet_control_unavailable".to_string())?;
        self.publish_fleet_load(true).await;
        Ok(())
    }

    pub(super) async fn handle_fleet_sidecar_frame(
        &mut self,
        frame: ProtocolEnvelope<Value>,
    ) -> Result<FleetSidecarFrameResponse, String> {
        let request_id = frame.request_id.clone();
        let frame_value = json!({
            "type": frame.msg_type,
            "payload": frame.payload,
        });
        let message: SdkToBroker = serde_json::from_value(frame_value)
            .map_err(|error| format!("invalid local protocol frame: {error}"))?;

        match message {
            SdkToBroker::Hello {
                client_name: _,
                client_version: _,
            } => Ok(FleetSidecarFrameResponse::frame(ok_protocol_frame(
                request_id,
                serde_json::to_value(BrokerToSdk::HelloAck {
                    broker_version: crate::util::version::broker_version().to_string(),
                    protocol_version: PROTOCOL_VERSION,
                })
                .map_err(|error| error.to_string())?
                .get("payload")
                .cloned()
                .unwrap_or_else(|| json!({})),
            ))),
            SdkToBroker::RegisterNode {
                manifest,
                supervision,
            } => {
                self.fleet_mode_enabled = true;
                self.fleet_max_agents = manifest.max_agents.unwrap_or(self.fleet_max_agents);
                self.fleet_sidecar_restart.reset(
                    supervision
                        .as_ref()
                        .and_then(|supervision| supervision.restart_policy.clone())
                        .unwrap_or_default(),
                );
                self.fleet_sidecar_supervision = supervision;
                self.fleet_control_tx
                    .send(FleetControlCommand::RegisterNode {
                        manifest,
                        resume_cursor: None,
                    })
                    .await
                    .map_err(|_| "fleet_control_unavailable".to_string())?;
                self.publish_fleet_load(true).await;
                Ok(FleetSidecarFrameResponse::frame(ok_protocol_frame(
                    request_id,
                    json!({"registered": true}),
                )))
            }
            SdkToBroker::DeregisterNode {} => {
                self.handle_fleet_sidecar_deregister().await?;
                Ok(FleetSidecarFrameResponse::close_after(ok_protocol_frame(
                    request_id,
                    json!({"deregistered": true}),
                )))
            }
            SdkToBroker::RegisterHandlers { names } => {
                self.fleet_handlers.register_handlers(names);
                self.publish_fleet_load(true).await;
                Ok(FleetSidecarFrameResponse::frame(ok_protocol_frame(
                    request_id,
                    json!({"handlers_live": self.fleet_handlers.handlers_live()}),
                )))
            }
            SdkToBroker::HandlerResult(result) => {
                let Some(action_result) = self.fleet_handlers.complete(result) else {
                    return Ok(FleetSidecarFrameResponse::frame(error_protocol_frame(
                        request_id,
                        "unknown_invocation",
                        "handler_result did not match an in-flight invocation",
                    )));
                };
                self.send_fleet_action_result(action_result).await;
                Ok(FleetSidecarFrameResponse::frame(ok_protocol_frame(
                    request_id,
                    json!({"completed": true}),
                )))
            }
            SdkToBroker::SpawnAgent {
                agent,
                invocation_id,
                initial_task,
                skip_relay_prompt,
            } => {
                if invocation_id.is_none() && self.fleet_handlers.has_in_flight() {
                    tracing::debug!(
                        target = "relay_broker::fleet",
                        agent = %agent.name,
                        "spawn_agent arrived without invocation_id while handler invocations are in flight"
                    );
                }
                let result = self
                    .handle_fleet_spawn_agent(
                        *agent,
                        invocation_id,
                        initial_task,
                        skip_relay_prompt,
                    )
                    .await?;
                Ok(FleetSidecarFrameResponse::frame(ok_protocol_frame(
                    request_id, result,
                )))
            }
            SdkToBroker::SendInput { name, data } => {
                let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
                Box::pin(self.handle_api_request(ListenApiRequest::SendInput {
                    name,
                    data,
                    reply: reply_tx,
                }))
                .await;
                Ok(FleetSidecarFrameResponse::frame(ok_protocol_frame(
                    request_id,
                    reply_rx.await.map_err(|_| "reply_dropped".to_string())??,
                )))
            }
            SdkToBroker::SendMessage {
                to,
                text,
                from,
                thread_id,
                workspace_id,
                workspace_alias,
                priority: _,
                mode,
            } => {
                let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
                Box::pin(self.handle_api_request(ListenApiRequest::Send {
                    to,
                    text,
                    from,
                    thread_id,
                    workspace_id,
                    workspace_alias,
                    mode,
                    reply: reply_tx,
                }))
                .await;
                Ok(FleetSidecarFrameResponse::frame(ok_protocol_frame(
                    request_id,
                    reply_rx.await.map_err(|_| "reply_dropped".to_string())??,
                )))
            }
            SdkToBroker::ReleaseAgent { name } => {
                let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
                Box::pin(self.handle_api_request(ListenApiRequest::Release {
                    name,
                    reason: Some("fleet_sidecar_release".to_string()),
                    reply: reply_tx,
                }))
                .await;
                Ok(FleetSidecarFrameResponse::frame(ok_protocol_frame(
                    request_id,
                    reply_rx.await.map_err(|_| "reply_dropped".to_string())??,
                )))
            }
            SdkToBroker::SubscribeChannels { name, channels } => {
                let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
                Box::pin(
                    self.handle_api_request(ListenApiRequest::SubscribeChannels {
                        name,
                        channels,
                        reply: reply_tx,
                    }),
                )
                .await;
                Ok(FleetSidecarFrameResponse::frame(ok_protocol_frame(
                    request_id,
                    reply_rx.await.map_err(|_| "reply_dropped".to_string())??,
                )))
            }
            SdkToBroker::UnsubscribeChannels { name, channels } => {
                let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
                Box::pin(
                    self.handle_api_request(ListenApiRequest::UnsubscribeChannels {
                        name,
                        channels,
                        reply: reply_tx,
                    }),
                )
                .await;
                Ok(FleetSidecarFrameResponse::frame(ok_protocol_frame(
                    request_id,
                    reply_rx.await.map_err(|_| "reply_dropped".to_string())??,
                )))
            }
            SdkToBroker::ListAgents {} => {
                let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
                Box::pin(self.handle_api_request(ListenApiRequest::List { reply: reply_tx })).await;
                Ok(FleetSidecarFrameResponse::frame(ok_protocol_frame(
                    request_id,
                    reply_rx.await.map_err(|_| "reply_dropped".to_string())??,
                )))
            }
            SdkToBroker::Shutdown {} => {
                let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
                Box::pin(self.handle_api_request(ListenApiRequest::Shutdown { reply: reply_tx }))
                    .await;
                Ok(FleetSidecarFrameResponse::frame(ok_protocol_frame(
                    request_id,
                    reply_rx.await.map_err(|_| "reply_dropped".to_string())??,
                )))
            }
        }
    }

    pub(super) async fn handle_fleet_control_event(&mut self, event: FleetControlEvent) {
        match event {
            FleetControlEvent::Connected => {
                tracing::info!(
                    target = "relay_broker::fleet",
                    "fleet node control connected"
                );
            }
            FleetControlEvent::Disconnected => {
                tracing::warn!(
                    target = "relay_broker::fleet",
                    "fleet node control disconnected"
                );
            }
            FleetControlEvent::Message(RelaycastToBroker::Deliver(deliver)) => {
                self.handle_fleet_deliver(deliver).await;
            }
            FleetControlEvent::Message(RelaycastToBroker::ActionInvoke(invoke)) => {
                self.handle_fleet_action_invoke(invoke).await;
            }
            FleetControlEvent::Message(RelaycastToBroker::Ping(_))
            | FleetControlEvent::Message(RelaycastToBroker::Reply(_))
            | FleetControlEvent::Message(RelaycastToBroker::Error(_)) => {}
        }
    }

    async fn handle_fleet_deliver(&mut self, deliver: Deliver) {
        let decision = self.fleet_delivery_book.observe(&deliver);
        let up_to_seq = match decision {
            crate::node_control::DeliveryDecision::Deliver { up_to_seq: _ } => {
                let relay_delivery = self.fleet_relay_delivery(&deliver);
                match self.workers.deliver(&deliver.agent, relay_delivery).await {
                    Ok(()) => self.fleet_delivery_book.commit_delivered(&deliver),
                    Err(error) => {
                        tracing::warn!(
                            target = "relay_broker::fleet",
                            agent = %deliver.agent,
                            msg_id = %deliver.msg_id,
                            error = %error,
                            "fleet delivery injection failed; withholding ack"
                        );
                        return;
                    }
                }
            }
            crate::node_control::DeliveryDecision::Duplicate { up_to_seq }
            | crate::node_control::DeliveryDecision::Stale { up_to_seq }
            | crate::node_control::DeliveryDecision::Gap { up_to_seq } => up_to_seq,
        };
        let _ = self
            .fleet_control_tx
            .send(FleetControlCommand::Send(delivery_ack(
                deliver.agent,
                up_to_seq,
            )))
            .await;
    }

    fn fleet_relay_delivery(&self, deliver: &Deliver) -> RelayDelivery {
        let body = first_string(
            &deliver.payload,
            &["/text", "/body", "/content", "/message", "/payload/text"],
        )
        .unwrap_or_else(|| deliver.payload.to_string());
        let from = first_string(
            &deliver.payload,
            &[
                "/from",
                "/sender",
                "/author",
                "/message/from",
                "/payload/from",
            ],
        )
        .unwrap_or_else(|| "relaycast".to_string());
        let target = first_string(
            &deliver.payload,
            &["/target", "/to", "/recipient", "/message/target"],
        )
        .or_else(|| {
            first_string(&deliver.payload, &["/channel", "/message/channel"]).map(|channel| {
                if channel.starts_with('#') {
                    channel
                } else {
                    format!("#{channel}")
                }
            })
        })
        .unwrap_or_else(|| deliver.agent.clone());
        let thread_id =
            first_string(&deliver.payload, &["/thread_id", "/threadId"]).map(ThreadId::new);
        let priority = deliver
            .payload
            .pointer("/priority")
            .and_then(Value::as_u64)
            .and_then(|value| u8::try_from(value).ok())
            .or_else(|| {
                deliver
                    .payload
                    .pointer("/metadata/priority")
                    .and_then(Value::as_str)
                    .and_then(priority_from_label)
            });
        RelayDelivery {
            delivery_id: DeliveryId::new(deliver.msg_id.clone()),
            event_id: EventId::new(deliver.msg_id.clone()),
            workspace_id: self.default_workspace_id.clone(),
            workspace_alias: self.default_workspace.workspace_alias.clone(),
            from,
            target: MessageTarget::new(target),
            body,
            thread_id,
            priority,
            injection_mode: match deliver.mode {
                DeliveryMode::Wait => MessageInjectionMode::Wait,
                DeliveryMode::Steer => MessageInjectionMode::Steer,
            },
        }
    }

    async fn handle_fleet_action_invoke(&mut self, invoke: ActionInvoke) {
        match self.fleet_handlers.handle_invoke(&invoke) {
            HandlerDispatchDecision::Dispatch {
                invocation_id,
                name,
                input,
            } => {
                let frame = ProtocolEnvelope {
                    v: PROTOCOL_VERSION,
                    msg_type: "invoke_handler".to_string(),
                    request_id: None,
                    payload: json!({
                        "invocation_id": invocation_id,
                        "name": name,
                        "input": input,
                    }),
                };
                let sent = match &self.fleet_sidecar_out_tx {
                    Some(tx) => tx.send(frame).await.is_ok(),
                    None => false,
                };
                if !sent {
                    self.fleet_sidecar_out_tx = None;
                    self.fleet_handlers.disconnect_sidecar();
                    let result = self.fleet_handlers.fail_unavailable(&invoke.invocation_id);
                    self.send_fleet_action_result(result).await;
                    self.publish_fleet_load(true).await;
                }
            }
            HandlerDispatchDecision::AlreadyInFlight => {}
            HandlerDispatchDecision::Completed(result)
            | HandlerDispatchDecision::Unavailable(result) => {
                self.send_fleet_action_result(result).await;
            }
        }
    }

    async fn handle_fleet_spawn_agent(
        &mut self,
        spec: AgentSpec,
        invocation_id: Option<String>,
        initial_task: Option<String>,
        skip_relay_prompt: bool,
    ) -> Result<Value, String> {
        self.fleet_mode_enabled = true;
        let initial_session_ref = fleet_initial_session_ref(&spec);
        let token = self
            .register_fleet_agent_token(&spec, invocation_id.clone(), initial_session_ref.clone())
            .await?;
        let name = spec.name.clone();
        let agent_id = token.agent_id.clone();
        let result = match self
            .spawn_from_agent_spec(spec, initial_task, skip_relay_prompt, Some(token.token))
            .await
        {
            Ok(result) => result,
            Err(error) => {
                cleanup_failed_fleet_spawn(
                    &self.fleet_control_tx,
                    &mut self.fleet_inventory,
                    &mut self.fleet_delivery_book,
                    &name,
                    &agent_id,
                )
                .await;
                return Err(error);
            }
        };
        let discovered_session_ref = fleet_discovered_session_ref(
            self.workers.workers.get(&name).map(|handle| &handle.spec),
            &result,
        )
        .or(initial_session_ref);
        self.fleet_inventory.insert(
            name.clone(),
            InventoryAgent {
                agent_id,
                name: name.as_str().to_string(),
                invocation_id,
                session_ref: discovered_session_ref,
            },
        );
        self.publish_fleet_inventory().await;
        self.publish_fleet_load(true).await;
        Ok(result)
    }

    async fn register_fleet_agent_token(
        &mut self,
        spec: &AgentSpec,
        invocation_id: Option<String>,
        session_ref: Option<String>,
    ) -> Result<crate::node_control::AgentRegistrationToken, String> {
        let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
        self.fleet_control_tx
            .send(FleetControlCommand::RegisterAgent {
                request: AgentRegister {
                    v: FLEET_WIRE_VERSION,
                    id: None,
                    name: spec.name.as_str().to_string(),
                    invocation_id,
                    session_ref: session_ref.clone(),
                    resumable: session_ref.as_ref().map(|_| true),
                },
                reply: reply_tx,
            })
            .await
            .map_err(|_| "fleet_control_unavailable".to_string())?;
        tokio::time::timeout(FLEET_AGENT_REGISTER_TIMEOUT, reply_rx)
            .await
            .map_err(|_| "agent_register_timeout".to_string())?
            .map_err(|_| "agent_register_reply_dropped".to_string())?
    }

    async fn spawn_from_agent_spec(
        &mut self,
        spec: AgentSpec,
        initial_task: Option<String>,
        skip_relay_prompt: bool,
        agent_token: Option<String>,
    ) -> Result<Value, String> {
        let cli = cli_for_agent_spec(&spec)?;
        let transport = Some(runtime_label(&spec.runtime).to_string());
        let restart_policy = spec
            .restart_policy
            .as_ref()
            .map(serde_json::to_value)
            .transpose()
            .map_err(|error| error.to_string())?;
        let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
        Box::pin(self.handle_api_request(ListenApiRequest::Spawn {
            name: spec.name,
            cli,
            transport,
            model: spec.model,
            args: spec.args,
            task: initial_task,
            channels: spec.channels,
            cwd: spec.cwd,
            team: spec.team,
            shadow_of: spec.shadow_of,
            shadow_mode: spec.shadow_mode,
            continue_from: None,
            idle_threshold_secs: None,
            skip_relay_prompt,
            restart_policy: Box::new(restart_policy),
            harness_config: spec.harness_config,
            agent_token,
            agent_result_schema: None,
            exit_after_task: false,
            reply: reply_tx,
        }))
        .await;
        reply_rx.await.map_err(|_| "reply_dropped".to_string())?
    }

    async fn send_fleet_action_result(&self, result: ActionResult) {
        let _ = self
            .fleet_control_tx
            .send(FleetControlCommand::Send(BrokerToRelaycast::ActionResult(
                result,
            )))
            .await;
    }

    async fn publish_fleet_load(&self, heartbeat_now: bool) {
        let active_agents = u32::try_from(self.workers.workers.len()).unwrap_or(u32::MAX);
        let _ = self
            .fleet_control_tx
            .send(FleetControlCommand::UpdateLoad(FleetLoadSnapshot {
                active_agents,
                max_agents: self.fleet_max_agents,
                handlers_live: self.fleet_handlers.handlers_live(),
            }))
            .await;
        if heartbeat_now {
            let _ = self
                .fleet_control_tx
                .send(FleetControlCommand::HeartbeatNow)
                .await;
        }
    }

    async fn publish_fleet_inventory(&self) {
        publish_fleet_inventory_snapshot(&self.fleet_control_tx, &self.fleet_inventory).await;
    }

    fn schedule_fleet_sidecar_restart(&mut self, trigger: &str) {
        if self.fleet_sidecar_supervision.is_none() {
            self.fleet_sidecar_restart_at = None;
            return;
        }
        match self.fleet_sidecar_restart.on_exit() {
            RestartDecision::Restart { delay } => {
                self.fleet_sidecar_restart_at = Some(Instant::now() + delay);
                tracing::warn!(
                    target = "relay_broker::fleet",
                    trigger,
                    delay_ms = delay.as_millis() as u64,
                    "fleet sidecar supervision scheduled restart"
                );
            }
            RestartDecision::PermanentlyDead { reason } => {
                self.fleet_sidecar_restart_at = None;
                self.fleet_sidecar_supervision = None;
                tracing::warn!(
                    target = "relay_broker::fleet",
                    trigger,
                    reason = %reason,
                    "fleet sidecar supervision exhausted; not restarting"
                );
            }
        }
    }

    pub(super) async fn handle_fleet_sidecar_supervision_tick(&mut self) {
        if let Some(child) = self.fleet_sidecar_child.as_mut() {
            match child.try_wait() {
                Ok(Some(status)) => {
                    tracing::warn!(
                        target = "relay_broker::fleet",
                        status = %status,
                        "fleet sidecar supervised child exited"
                    );
                    self.fleet_sidecar_child = None;
                    self.schedule_fleet_sidecar_restart("supervised child exited");
                }
                Ok(None) => {}
                Err(error) => {
                    tracing::warn!(target = "relay_broker::fleet", error = %error, "failed to poll fleet sidecar child");
                    self.fleet_sidecar_child = None;
                    self.schedule_fleet_sidecar_restart("supervised child poll failed");
                }
            }
        }

        let Some(restart_at) = self.fleet_sidecar_restart_at else {
            return;
        };
        if restart_at > Instant::now() || self.fleet_sidecar_out_tx.is_some() {
            return;
        }
        let Some(supervision) = self.fleet_sidecar_supervision.clone() else {
            self.fleet_sidecar_restart_at = None;
            return;
        };
        if supervision.argv.is_empty() {
            self.fleet_sidecar_restart_at = None;
            return;
        }

        let mut command = tokio::process::Command::new(&supervision.argv[0]);
        command.args(&supervision.argv[1..]);
        command.current_dir(&supervision.cwd);
        if let Some(env) = supervision.env {
            command.envs(env);
        }
        command
            .stdin(Stdio::null())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit());
        match command.spawn() {
            Ok(child) => {
                tracing::info!(target = "relay_broker::fleet", "restarted fleet sidecar");
                self.fleet_sidecar_child = Some(child);
                self.fleet_sidecar_restart_at = None;
                self.fleet_sidecar_restart.on_restarted();
            }
            Err(error) => {
                tracing::warn!(target = "relay_broker::fleet", error = %error, "failed to restart fleet sidecar");
                self.schedule_fleet_sidecar_restart("sidecar restart spawn failed");
            }
        }
    }
}

pub(super) async fn publish_fleet_inventory_snapshot(
    fleet_control_tx: &mpsc::Sender<FleetControlCommand>,
    fleet_inventory: &HashMap<WorkerName, InventoryAgent>,
) {
    let _ = fleet_control_tx
        .send(FleetControlCommand::UpdateInventory(
            fleet_inventory.values().cloned().collect(),
        ))
        .await;
}

pub(super) async fn refresh_fleet_inventory_session_ref(
    fleet_control_tx: &mpsc::Sender<FleetControlCommand>,
    fleet_inventory: &mut HashMap<WorkerName, InventoryAgent>,
    name: &WorkerName,
    session_ref: &str,
) -> bool {
    let session_ref = session_ref.trim();
    if session_ref.is_empty() {
        return false;
    }
    let Some(agent) = fleet_inventory.get_mut(name) else {
        return false;
    };
    if agent.session_ref.as_deref() == Some(session_ref) {
        return false;
    }

    agent.session_ref = Some(session_ref.to_string());
    publish_fleet_inventory_snapshot(fleet_control_tx, fleet_inventory).await;
    true
}

pub(super) async fn prune_fleet_inventory_entry(
    fleet_control_tx: &mpsc::Sender<FleetControlCommand>,
    fleet_inventory: &mut HashMap<WorkerName, InventoryAgent>,
    name: &WorkerName,
) {
    if fleet_inventory.remove(name).is_some() {
        publish_fleet_inventory_snapshot(fleet_control_tx, fleet_inventory).await;
    }
}

pub(super) async fn prune_fleet_agent_state(
    fleet_control_tx: &mpsc::Sender<FleetControlCommand>,
    fleet_inventory: &mut HashMap<WorkerName, InventoryAgent>,
    fleet_delivery_book: &mut FleetDeliveryBook,
    name: &WorkerName,
) {
    fleet_delivery_book.remove_agent(name.as_str());
    prune_fleet_inventory_entry(fleet_control_tx, fleet_inventory, name).await;
}

async fn cleanup_failed_fleet_spawn(
    fleet_control_tx: &mpsc::Sender<FleetControlCommand>,
    fleet_inventory: &mut HashMap<WorkerName, InventoryAgent>,
    fleet_delivery_book: &mut FleetDeliveryBook,
    name: &WorkerName,
    agent_id: &str,
) {
    let _ = fleet_control_tx
        .send(FleetControlCommand::Send(
            BrokerToRelaycast::AgentDeregister(AgentDeregister {
                v: FLEET_WIRE_VERSION,
                id: None,
                agent_id: agent_id.to_string(),
                name: None,
            }),
        ))
        .await;
    prune_fleet_agent_state(fleet_control_tx, fleet_inventory, fleet_delivery_book, name).await;
}

fn ok_protocol_frame(request_id: Option<RequestId>, result: Value) -> ProtocolEnvelope<Value> {
    ProtocolEnvelope {
        v: PROTOCOL_VERSION,
        msg_type: "ok".to_string(),
        request_id,
        payload: json!({ "result": result }),
    }
}

fn error_protocol_frame(
    request_id: Option<RequestId>,
    code: &str,
    message: &str,
) -> ProtocolEnvelope<Value> {
    ProtocolEnvelope {
        v: PROTOCOL_VERSION,
        msg_type: "error".to_string(),
        request_id,
        payload: json!({
            "code": code,
            "message": message,
            "retryable": false,
        }),
    }
}

fn cli_for_agent_spec(spec: &AgentSpec) -> Result<String, String> {
    if let Some(cli) = spec.cli.as_deref().and_then(non_empty) {
        return Ok(cli.to_string());
    }
    match spec.provider {
        Some(ProtocolHeadlessProvider::Claude) => Ok("claude".to_string()),
        Some(ProtocolHeadlessProvider::Opencode) => Ok("opencode".to_string()),
        None => Err("agent spec requires cli or provider".to_string()),
    }
}

fn non_empty(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then_some(trimmed)
}

fn priority_from_label(label: &str) -> Option<u8> {
    match label.trim().to_ascii_lowercase().as_str() {
        "low" => Some(1),
        "normal" => Some(2),
        "high" => Some(3),
        "urgent" => Some(4),
        _ => None,
    }
}

fn fleet_initial_session_ref(spec: &AgentSpec) -> Option<String> {
    spec.session_id.clone().or_else(|| {
        spec.harness_config
            .as_ref()
            .and_then(ResolvedHarnessConfig::session_id)
            .map(ToOwned::to_owned)
    })
}

fn fleet_discovered_session_ref(
    effective_spec: Option<&AgentSpec>,
    spawn_result: &Value,
) -> Option<String> {
    effective_spec
        .and_then(fleet_initial_session_ref)
        .or_else(|| {
            spawn_result
                .get("sessionId")
                .and_then(Value::as_str)
                .and_then(non_empty)
                .map(ToOwned::to_owned)
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::PtyHarnessConfig;

    fn test_agent_spec(session_id: Option<&str>, harness_session_id: Option<&str>) -> AgentSpec {
        AgentSpec {
            name: WorkerName::from("agent-a"),
            runtime: AgentRuntime::Pty,
            provider: None,
            cli: Some("codex".to_string()),
            session_id: session_id.map(ToOwned::to_owned),
            harness_config: harness_session_id.map(|session_id| {
                ResolvedHarnessConfig::Pty(PtyHarnessConfig {
                    command: "codex".to_string(),
                    args: Vec::new(),
                    cwd: None,
                    env: None,
                    session_id: Some(session_id.to_string()),
                    delivery: None,
                    metadata: None,
                })
            }),
            model: None,
            cwd: None,
            team: None,
            shadow_of: None,
            shadow_mode: None,
            args: Vec::new(),
            channels: Vec::new(),
            restart_policy: None,
        }
    }

    #[test]
    fn fleet_initial_session_ref_prefers_explicit_spec_session() {
        let spec = test_agent_spec(Some("session-spec"), Some("session-harness"));
        assert_eq!(
            fleet_initial_session_ref(&spec).as_deref(),
            Some("session-spec")
        );

        let spec = test_agent_spec(None, Some("session-harness"));
        assert_eq!(
            fleet_initial_session_ref(&spec).as_deref(),
            Some("session-harness")
        );
    }

    #[test]
    fn fleet_discovered_session_ref_prefers_effective_worker_spec() {
        let effective = test_agent_spec(Some("session-discovered"), None);
        assert_eq!(
            fleet_discovered_session_ref(Some(&effective), &json!({"sessionId": "session-result"}))
                .as_deref(),
            Some("session-discovered")
        );

        assert_eq!(
            fleet_discovered_session_ref(None, &json!({"sessionId": "session-result"})).as_deref(),
            Some("session-result")
        );
    }

    #[tokio::test]
    async fn prune_fleet_inventory_entry_publishes_without_removed_agent() {
        let (tx, mut rx) = mpsc::channel(4);
        let mut inventory = HashMap::from([
            (
                WorkerName::from("agent-a"),
                InventoryAgent {
                    agent_id: "agt-a".to_string(),
                    name: "agent-a".to_string(),
                    invocation_id: Some("inv-a".to_string()),
                    session_ref: Some("session-a".to_string()),
                },
            ),
            (
                WorkerName::from("agent-b"),
                InventoryAgent {
                    agent_id: "agt-b".to_string(),
                    name: "agent-b".to_string(),
                    invocation_id: Some("inv-b".to_string()),
                    session_ref: Some("session-b".to_string()),
                },
            ),
        ]);

        prune_fleet_inventory_entry(&tx, &mut inventory, &WorkerName::from("agent-a")).await;

        match rx.recv().await {
            Some(FleetControlCommand::UpdateInventory(agents)) => {
                assert_eq!(agents.len(), 1);
                assert_eq!(agents[0].name, "agent-b");
            }
            other => panic!("expected inventory update, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn refresh_fleet_inventory_session_ref_publishes_immediate_sync() {
        let (tx, mut rx) = mpsc::channel(4);
        let name = WorkerName::from("agent-a");
        let mut inventory = HashMap::from([(
            name.clone(),
            InventoryAgent {
                agent_id: "agt-a".to_string(),
                name: "agent-a".to_string(),
                invocation_id: Some("inv-a".to_string()),
                session_ref: None,
            },
        )]);

        assert!(
            refresh_fleet_inventory_session_ref(&tx, &mut inventory, &name, " session-discovered ")
                .await
        );

        match rx.recv().await {
            Some(FleetControlCommand::UpdateInventory(agents)) => {
                assert_eq!(agents.len(), 1);
                assert_eq!(agents[0].name, "agent-a");
                assert_eq!(agents[0].session_ref.as_deref(), Some("session-discovered"));
            }
            other => panic!("expected inventory update, got {other:?}"),
        }
        assert_eq!(
            inventory
                .get(&name)
                .and_then(|agent| agent.session_ref.as_deref()),
            Some("session-discovered")
        );
        assert!(
            !refresh_fleet_inventory_session_ref(&tx, &mut inventory, &name, "session-discovered")
                .await
        );
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn sidecar_restart_state_obeys_restart_policy_bounds() {
        let mut state = FleetSidecarRestartState::default();
        state.reset(RestartPolicy {
            max_restarts: 1,
            cooldown_ms: 7,
            max_consecutive_failures: 2,
            ..Default::default()
        });

        assert_eq!(
            state.on_exit(),
            RestartDecision::Restart {
                delay: Duration::from_millis(7)
            }
        );
        state.on_restarted();
        assert!(matches!(
            state.on_exit(),
            RestartDecision::PermanentlyDead { .. }
        ));
    }

    #[tokio::test]
    async fn failed_spawn_cleanup_deregisters_agent_and_prunes_state() {
        let (tx, mut rx) = mpsc::channel(4);
        let name = WorkerName::from("agent-a");
        let mut inventory = HashMap::from([(
            name.clone(),
            InventoryAgent {
                agent_id: "agt-a".to_string(),
                name: "agent-a".to_string(),
                invocation_id: Some("inv-a".to_string()),
                session_ref: Some("session-a".to_string()),
            },
        )]);
        let mut delivery_book = FleetDeliveryBook::default();
        let deliver = Deliver {
            v: FLEET_WIRE_VERSION,
            agent: "agent-a".to_string(),
            msg_id: "msg-a".to_string(),
            seq: 1,
            mode: DeliveryMode::Wait,
            payload: json!({"text": "hello"}),
        };
        assert_eq!(delivery_book.commit_delivered(&deliver), 1);

        cleanup_failed_fleet_spawn(&tx, &mut inventory, &mut delivery_book, &name, "agt-a").await;

        match rx.recv().await {
            Some(FleetControlCommand::Send(BrokerToRelaycast::AgentDeregister(
                AgentDeregister { agent_id, .. },
            ))) => assert_eq!(agent_id, "agt-a"),
            other => panic!("expected agent.deregister, got {other:?}"),
        }
        match rx.recv().await {
            Some(FleetControlCommand::UpdateInventory(agents)) => {
                assert!(agents.is_empty());
            }
            other => panic!("expected inventory update, got {other:?}"),
        }
        assert!(inventory.is_empty());
        assert_eq!(
            delivery_book.observe(&deliver),
            crate::node_control::DeliveryDecision::Deliver { up_to_seq: 1 }
        );
    }
}
