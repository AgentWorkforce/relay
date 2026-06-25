use super::*;

pub(crate) struct BrokerRuntime {
    pub(super) persist: bool,
    pub(super) broker_start: Instant,
    pub(super) agent_spawn_count: u32,
    pub(super) paths: RuntimePaths,
    pub(super) state: broker::BrokerState,
    pub(super) workspaces: Vec<RelayWorkspace>,
    pub(super) workspace_lookup: HashMap<WorkspaceId, RelayWorkspace>,
    pub(super) default_workspace: RelayWorkspace,
    pub(super) default_workspace_id: Option<WorkspaceId>,
    pub(super) self_names: HashSet<String>,
    pub(super) ws_control_tx: mpsc::Sender<WsControl>,
    pub(super) relaycast_http: RelaycastHttpClient,
    pub(super) api_rx: mpsc::Receiver<ListenApiRequest>,
    pub(super) api_open: bool,
    pub(super) ws_inbound_rx: mpsc::Receiver<WorkspaceInboundMessage>,
    pub(super) relaycast_open: bool,
    pub(super) fleet_control_tx: mpsc::Sender<FleetControlCommand>,
    /// This broker's relaycast node name, used to bind agents to the node over
    /// HTTP when the node-control `agent.register` path is unavailable.
    pub(super) fleet_node_name: String,
    pub(super) fleet_event_rx: mpsc::Receiver<FleetControlEvent>,
    pub(super) fleet_control_open: bool,
    pub(super) fleet_delivery_book: FleetDeliveryBook,
    pub(super) fleet_handlers: HandlerDispatchState,
    pub(super) fleet_sidecar_out_tx: Option<mpsc::Sender<ProtocolEnvelope<Value>>>,
    pub(super) fleet_sidecar_supervision: Option<NodeSupervision>,
    pub(super) fleet_sidecar_child: Option<tokio::process::Child>,
    pub(super) fleet_sidecar_restart_at: Option<Instant>,
    pub(super) fleet_sidecar_restart: fleet::FleetSidecarRestartState,
    pub(super) fleet_max_agents: u32,
    pub(super) fleet_inventory: HashMap<WorkerName, InventoryAgent>,
    pub(super) sdk_out_tx: mpsc::Sender<ProtocolEnvelope<Value>>,
    pub(super) worker_event_rx: mpsc::Receiver<WorkerEvent>,
    pub(super) worker_events_open: bool,
    pub(super) workers: WorkerRegistry,
    pub(super) crash_insights: crate::crash_insights::CrashInsights,
    pub(super) crash_insights_path: PathBuf,
    pub(super) sdk_lines: tokio::io::Lines<BufReader<tokio::io::Stdin>>,
    pub(super) stdin_open: bool,
    pub(super) reap_tick: tokio::time::Interval,
    pub(super) dedup: DedupCache,
    pub(super) delivery_retry_interval: Duration,
    pub(super) pending_deliveries: PendingDeliveryStore,
    pub(super) terminal_failed_deliveries: HashSet<DeliveryId>,
    pub(super) pending_requests: HashMap<String, worker_request::PendingRequest>,
    pub(super) delivery_states: HashMap<WorkerName, InboundDeliveryState>,
    pub(super) agent_result_tokens: HashMap<String, WorkerName>,
    pub(super) recent_thread_messages: VecDeque<Value>,
    pub(super) shutdown: bool,
    pub(super) lease_duration: Option<Duration>,
    pub(super) last_lease_renewal: Instant,
    pub(super) lease_check: tokio::time::Interval,
    #[cfg(unix)]
    pub(super) sigterm: tokio::signal::unix::Signal,
    #[cfg(windows)]
    pub(super) sigterm: tokio::signal::windows::CtrlShutdown,
    pub(super) telemetry: TelemetryClient,
}

enum RuntimeEvent {
    CtrlC,
    LeaseTick,
    Sigterm,
    Api(Box<ListenApiRequest>),
    ApiClosed,
    Stdin(std::io::Result<Option<String>>),
    Relaycast(Option<WorkspaceInboundMessage>),
    Fleet(Option<FleetControlEvent>),
    Worker(Option<WorkerEvent>),
    MaintenanceTick,
}

impl BrokerRuntime {
    pub(super) async fn run(mut self) -> Result<()> {
        while !self.shutdown {
            let event = tokio::select! {
                _ = tokio::signal::ctrl_c() => RuntimeEvent::CtrlC,
                _ = self.lease_check.tick() => RuntimeEvent::LeaseTick,
                _ = self.sigterm.recv() => RuntimeEvent::Sigterm,
                request = self.api_rx.recv(), if self.api_open => match request {
                    Some(request) => RuntimeEvent::Api(Box::new(request)),
                    None => RuntimeEvent::ApiClosed,
                },
                result = self.sdk_lines.next_line(), if self.stdin_open => RuntimeEvent::Stdin(result),
                message = self.ws_inbound_rx.recv(), if self.relaycast_open => RuntimeEvent::Relaycast(message),
                event = self.fleet_event_rx.recv(), if self.fleet_control_open => RuntimeEvent::Fleet(event),
                event = self.worker_event_rx.recv(), if self.worker_events_open => RuntimeEvent::Worker(event),
                _ = self.reap_tick.tick() => RuntimeEvent::MaintenanceTick,
            };

            match event {
                RuntimeEvent::CtrlC => {
                    self.shutdown = true;
                }
                RuntimeEvent::LeaseTick => {
                    self.handle_lease_tick();
                }
                RuntimeEvent::Sigterm => {
                    tracing::info!("received SIGTERM, shutting down");
                    self.shutdown = true;
                }
                RuntimeEvent::Api(request) => {
                    self.handle_api_request(*request).await;
                }
                RuntimeEvent::ApiClosed => {
                    self.api_open = false;
                }
                RuntimeEvent::Stdin(result) => {
                    if matches!(result, Ok(None) | Err(_)) {
                        self.stdin_open = false;
                    }
                }
                RuntimeEvent::Relaycast(Some(message)) => {
                    self.handle_relaycast_message(message).await;
                }
                RuntimeEvent::Relaycast(None) => {
                    self.relaycast_open = false;
                }
                RuntimeEvent::Fleet(Some(event)) => {
                    self.handle_fleet_control_event(event).await;
                }
                RuntimeEvent::Fleet(None) => {
                    self.fleet_control_open = false;
                }
                RuntimeEvent::Worker(Some(event)) => {
                    self.handle_worker_event(event).await;
                }
                RuntimeEvent::Worker(None) => {
                    self.worker_events_open = false;
                }
                RuntimeEvent::MaintenanceTick => {
                    self.handle_maintenance_tick().await;
                }
            }

            self.flush_pending_deliveries();
        }

        self.shutdown_runtime().await
    }

    /// Persist pending deliveries whenever the map was mutated by the event
    /// just handled. Keeps the on-disk snapshot in lockstep with the
    /// in-memory map so a crash between maintenance ticks cannot lose
    /// queued deliveries.
    fn flush_pending_deliveries(&mut self) {
        if !self.pending_deliveries.take_dirty() || !self.paths.persist {
            return;
        }
        if let Err(error) = save_pending_deliveries(&self.paths.pending, &self.pending_deliveries) {
            tracing::warn!(
                path = %self.paths.pending.display(),
                error = %error,
                "failed to persist pending deliveries"
            );
        }
    }

    fn handle_lease_tick(&mut self) {
        if let Some(duration) = self.lease_duration {
            if self.last_lease_renewal.elapsed() > duration {
                tracing::info!(
                    elapsed_secs = self.last_lease_renewal.elapsed().as_secs(),
                    lease_secs = duration.as_secs(),
                    "owner lease expired — shutting down"
                );
                self.shutdown = true;
            }
        }
    }

    async fn shutdown_runtime(mut self) -> Result<()> {
        // Save crash insights before shutdown (only in persist mode)
        if self.paths.persist {
            if let Err(error) = self.crash_insights.save(&self.crash_insights_path) {
                tracing::warn!(error = %error, "failed to save crash insights");
            }
        }

        self.telemetry.track(TelemetryEvent::BrokerStop {
            uptime_seconds: self.broker_start.elapsed().as_secs(),
            agent_spawn_count: self.agent_spawn_count,
        });
        self.telemetry.shutdown();

        let active_workers: Vec<WorkerName> = self.workers.workers.keys().cloned().collect();
        for worker_name in active_workers {
            if let Err(error) = self.relaycast_http.mark_agent_offline(&worker_name).await {
                tracing::warn!(
                    worker = %worker_name,
                    error = %error,
                    "failed to mark worker offline during shutdown"
                );
            }
        }

        // Mark broker agent offline in Relaycast before shutting down WS
        if let Err(error) = self.relaycast_http.mark_offline().await {
            tracing::warn!(error = %error, "failed to mark broker offline during shutdown");
        }

        if let Err(error) = self.ws_control_tx.send(WsControl::Shutdown).await {
            tracing::warn!(error = %error, "failed to send ws shutdown signal");
        }
        if let Err(error) = self
            .fleet_control_tx
            .send(FleetControlCommand::Shutdown)
            .await
        {
            tracing::debug!(error = %error, "failed to send fleet control shutdown signal");
        }
        if let Some(mut child) = self.fleet_sidecar_child.take() {
            let _ = crate::spawner::terminate_child(&mut child, Duration::from_secs(3)).await;
        }
        // Persist any still-pending deliveries so the next start can
        // redeliver them; only remove the file when nothing is pending.
        persist_pending_on_shutdown(
            &self.paths.pending,
            self.paths.persist,
            &self.pending_deliveries,
        );
        self.workers.shutdown_all().await?;

        // Clean up state and connection files on graceful shutdown
        if self.paths.persist {
            let _ = std::fs::remove_file(&self.paths.state);
        }
        let connection_path = self.paths.state.parent().unwrap().join("connection.json");
        let _ = std::fs::remove_file(&connection_path);

        Ok(())
    }
}
