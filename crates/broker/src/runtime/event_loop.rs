use super::*;

/// Current PTY resize owner for a worker under the single-resizer policy.
///
/// `session_id` is the client-generated id that currently owns resizing;
/// `last_seen` timestamps its most recent resize so a crashed client that
/// never releases can be superseded after [`RESIZE_OWNER_STALE`]. `rows`/`cols`
/// record the last size actually applied to the PTY so a periodic same-size
/// re-assert (the client's liveness keep-alive) can refresh `last_seen` without
/// emitting a redundant SIGWINCH/repaint to the child. Legacy unkeyed resizes
/// update these dimensions without extending the owner's lease.
pub(crate) struct ResizeOwner {
    pub(super) session_id: String,
    pub(super) last_seen: Instant,
    pub(super) rows: u16,
    pub(super) cols: u16,
}

/// How long an owning session may be idle before another session is allowed
/// to take over resizing. Only a safety net for clients that crash without
/// sending an explicit release on detach — a well-behaved client releases
/// immediately, so this window never fires in the normal path.
pub(crate) const RESIZE_OWNER_STALE: Duration = Duration::from_secs(300);

/// Decide whether a resize request from `session_id` should be applied under
/// the single-resizer policy (#1247).
///
/// - Requests without a `session_id` (legacy/one-shot callers) always apply
///   and never change ownership.
/// - The first session to resize an unowned worker, and the session that
///   already owns it, are applied.
/// - A different session is rejected while the current owner is live, so two
///   drive clients can't fight over the shared PTY — unless the owner has gone
///   `owner_stale` (crashed without releasing), in which case the newcomer may
///   take over.
pub(crate) fn resize_owner_allows(
    owner_session: Option<&str>,
    owner_stale: bool,
    session_id: Option<&str>,
) -> bool {
    match session_id {
        None => true,
        Some(sid) => match owner_session {
            None => true,
            Some(owner) => owner == sid || owner_stale,
        },
    }
}

/// The action the `ResizePty` handler must take for a resize request, decided
/// against the current ownership map. Extracted from the handler so the
/// single-resizer state transitions are unit-testable without a live worker.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ResizeAction {
    /// Requester is not the resize owner: acknowledge without resizing.
    Reject,
    /// Owner re-asserted its current size: `last_seen` was refreshed in place
    /// and no SIGWINCH/repaint is needed.
    Refresh,
    /// Apply the resize (emit SIGWINCH). After the worker send succeeds, call
    /// [`commit_resize_ownership`] to claim/record ownership.
    Apply,
}

/// Evaluate a session-keyed (or legacy) resize against `resize_owners` and,
/// for the owner-refresh case, bump `last_seen` in place. Returns the
/// [`ResizeAction`] the handler must take. `now` is injected so the staleness
/// window is testable.
pub(crate) fn plan_resize(
    resize_owners: &mut HashMap<WorkerName, ResizeOwner>,
    name: &WorkerName,
    rows: u16,
    cols: u16,
    session_id: Option<&str>,
    now: Instant,
) -> ResizeAction {
    let owner = resize_owners.get(name);
    let owner_stale =
        owner.is_some_and(|o| now.saturating_duration_since(o.last_seen) >= RESIZE_OWNER_STALE);
    if !resize_owner_allows(
        owner.map(|o| o.session_id.as_str()),
        owner_stale,
        session_id,
    ) {
        return ResizeAction::Reject;
    }
    // Same-size owner re-assert: refresh liveness without a redundant SIGWINCH.
    let owner_refresh = session_id.is_some_and(|sid| {
        resize_owners
            .get(name)
            .is_some_and(|o| o.session_id == sid && o.rows == rows && o.cols == cols)
    });
    if owner_refresh {
        if let Some(owner) = resize_owners.get_mut(name) {
            owner.last_seen = now;
        }
        return ResizeAction::Refresh;
    }
    ResizeAction::Apply
}

/// Record ownership after a resize is actually applied. Session-keyed resizes
/// claim or refresh the lease; legacy (unkeyed) resizes update the recorded
/// dimensions of an existing owner *without* renewing its lease, so the owner
/// still restores its own size on its next re-assert.
pub(crate) fn commit_resize_ownership(
    resize_owners: &mut HashMap<WorkerName, ResizeOwner>,
    name: &WorkerName,
    rows: u16,
    cols: u16,
    session_id: Option<String>,
    now: Instant,
) {
    if let Some(sid) = session_id {
        resize_owners.insert(
            name.clone(),
            ResizeOwner {
                session_id: sid,
                last_seen: now,
                rows,
                cols,
            },
        );
    } else if let Some(owner) = resize_owners.get_mut(name) {
        owner.rows = rows;
        owner.cols = cols;
    }
}

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
    pub(super) node_delivery_token_present: bool,
    pub(super) node_delivery_connected: bool,
    pub(super) fleet_event_rx: mpsc::Receiver<FleetControlEvent>,
    pub(super) fleet_control_open: bool,
    pub(super) fleet_delivery_book: FleetDeliveryBook,
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
    /// Per-worker PTY resize ownership (single-resizer policy, see #1247).
    ///
    /// A shared PTY has exactly one size, so letting every attached client
    /// (and every local SIGWINCH) resize it makes concurrent drive clients
    /// fight and can garble view clients. We therefore key resizes on an
    /// optional client-generated `session_id`: the first session to resize a
    /// worker claims it, and only that session's resizes are applied until it
    /// releases on detach (or is superseded after a long idle window when a
    /// client crashes without releasing). Resizes without a `session_id` are
    /// always applied (legacy/one-shot callers), preserving old behaviour.
    pub(super) resize_owners: HashMap<WorkerName, ResizeOwner>,
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

#[cfg(test)]
mod resize_owner_tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn legacy_request_without_session_always_applies() {
        // Someone else owns it, but a request with no session id still applies.
        assert!(resize_owner_allows(Some("other"), false, None));
        assert!(resize_owner_allows(None, false, None));
    }

    #[test]
    fn first_session_claims_unowned_worker() {
        assert!(resize_owner_allows(None, false, Some("s1")));
    }

    #[test]
    fn owner_session_is_accepted() {
        assert!(resize_owner_allows(Some("s1"), false, Some("s1")));
    }

    #[test]
    fn different_live_session_is_rejected() {
        assert!(!resize_owner_allows(Some("s1"), false, Some("s2")));
    }

    #[test]
    fn stale_owner_can_be_taken_over() {
        assert!(resize_owner_allows(Some("s1"), true, Some("s2")));
    }

    #[test]
    fn claim_reject_release_lifecycle() {
        // Drive the real handler transitions end-to-end.
        let name = WorkerName::new("w1".to_string());
        let mut owners: HashMap<WorkerName, ResizeOwner> = HashMap::new();
        let now = Instant::now();

        // s1 claims the (unowned) worker: Apply, then ownership is committed.
        assert_eq!(
            plan_resize(&mut owners, &name, 24, 80, Some("s1"), now),
            ResizeAction::Apply,
        );
        commit_resize_ownership(&mut owners, &name, 24, 80, Some("s1".to_string()), now);
        assert_eq!(owners.get(&name).unwrap().session_id, "s1");

        // s2 is rejected while s1 owns and is fresh.
        assert_eq!(
            plan_resize(&mut owners, &name, 30, 100, Some("s2"), now),
            ResizeAction::Reject,
        );
        // Rejected requests must not perturb the owner's recorded size.
        assert_eq!(
            (owners[&name].rows, owners[&name].cols),
            (24, 80),
            "a rejected resize must not touch the owner's dimensions"
        );

        // s1 releases on detach (handled by the separate release path).
        owners.remove(&name);

        // Now s2 can claim the freed worker.
        assert_eq!(
            plan_resize(&mut owners, &name, 30, 100, Some("s2"), now),
            ResizeAction::Apply,
        );
    }

    #[test]
    fn same_size_owner_reassert_refreshes_without_repaint() {
        // The owner re-sends its current size to stay live: `plan_resize`
        // must return Refresh (no worker send / SIGWINCH) and bump `last_seen`.
        let name = WorkerName::new("w1".to_string());
        let mut owners: HashMap<WorkerName, ResizeOwner> = HashMap::new();
        let stale_seen = Instant::now() - Duration::from_secs(120);
        owners.insert(
            name.clone(),
            ResizeOwner {
                session_id: "s1".to_string(),
                last_seen: stale_seen,
                rows: 24,
                cols: 80,
            },
        );

        // Same session, same size → owner refresh with a bumped `last_seen`.
        let now = Instant::now();
        assert_eq!(
            plan_resize(&mut owners, &name, 24, 80, Some("s1"), now),
            ResizeAction::Refresh,
        );
        assert!(
            owners.get(&name).unwrap().last_seen > stale_seen,
            "owner refresh must bump last_seen"
        );

        // A *different* size from the owner is a real resize, not a refresh.
        assert_eq!(
            plan_resize(&mut owners, &name, 30, 100, Some("s1"), now),
            ResizeAction::Apply,
            "changed size must be a real resize, not a refresh"
        );
    }

    #[test]
    fn legacy_resize_invalidates_owner_same_size_refresh() {
        // Reviewer callout (#1253): exercise the real handler transition —
        // keyed claim, legacy resize, then keyed re-assert — instead of
        // reimplementing the map mutation.
        let name = WorkerName::new("w1".to_string());
        let mut owners: HashMap<WorkerName, ResizeOwner> = HashMap::new();
        let now = Instant::now();

        // s1 claims at 24x80.
        commit_resize_ownership(&mut owners, &name, 24, 80, Some("s1".to_string()), now);
        let claimed_seen = owners.get(&name).unwrap().last_seen;

        // A legacy (unkeyed) caller applies a different size. It plans as Apply
        // and, once committed, updates the recorded dimensions *without*
        // renewing the owner's lease.
        assert_eq!(
            plan_resize(&mut owners, &name, 40, 120, None, now),
            ResizeAction::Apply,
        );
        commit_resize_ownership(&mut owners, &name, 40, 120, None, now);
        let owner = owners.get(&name).unwrap();
        assert_eq!((owner.rows, owner.cols), (40, 120));
        assert_eq!(
            owner.last_seen, claimed_seen,
            "legacy resize must not renew the lease"
        );

        // The owner re-asserting its former 24x80 size must now plan as a real
        // resize (Apply), not a refresh, so it restores the PTY after the
        // legacy caller changed the size out from under it.
        assert_eq!(
            plan_resize(&mut owners, &name, 24, 80, Some("s1"), now),
            ResizeAction::Apply,
            "owner must restore dimensions changed by a legacy resize"
        );
    }

    #[test]
    fn stale_owner_is_taken_over_via_plan_resize() {
        // A crashed owner (last_seen older than the stale window) is superseded
        // by a new session's resize through the real transition helper.
        let name = WorkerName::new("w1".to_string());
        let mut owners: HashMap<WorkerName, ResizeOwner> = HashMap::new();
        let now = Instant::now();
        owners.insert(
            name.clone(),
            ResizeOwner {
                session_id: "s1".to_string(),
                last_seen: now - RESIZE_OWNER_STALE - Duration::from_secs(1),
                rows: 24,
                cols: 80,
            },
        );

        assert_eq!(
            plan_resize(&mut owners, &name, 30, 100, Some("s2"), now),
            ResizeAction::Apply,
            "a newcomer may take over a stale (crashed) owner",
        );
        commit_resize_ownership(&mut owners, &name, 30, 100, Some("s2".to_string()), now);
        assert_eq!(owners.get(&name).unwrap().session_id, "s2");
    }

    #[test]
    fn release_outcome_reports_actual_removal() {
        let name = WorkerName::new("w1".to_string());
        let mut owners: HashMap<WorkerName, ResizeOwner> = HashMap::new();
        owners.insert(
            name.clone(),
            ResizeOwner {
                session_id: "s1".to_string(),
                last_seen: Instant::now(),
                rows: 24,
                cols: 80,
            },
        );

        // Release from the owner removes and reports true.
        let released = matches!(owners.get(&name).map(|o| o.session_id.as_str()), Some("s1"))
            && owners.remove(&name).is_some();
        assert!(released, "owner release must report released=true");

        // A second release (nothing owned) is a no-op → false.
        let released_again = owners.get(&name).is_some_and(|o| o.session_id == "s1")
            && owners.remove(&name).is_some();
        assert!(!released_again, "no-op release must report released=false");
    }

    #[test]
    fn release_from_non_owner_is_ignored() {
        let name = WorkerName::new("w1".to_string());
        let mut owners: HashMap<WorkerName, ResizeOwner> = HashMap::new();
        owners.insert(
            name.clone(),
            ResizeOwner {
                session_id: "s1".to_string(),
                last_seen: Instant::now(),
                rows: 24,
                cols: 80,
            },
        );
        // A release carrying the wrong session id must not evict the owner.
        if owners.get(&name).is_some_and(|o| o.session_id == "s2") {
            owners.remove(&name);
        }
        assert_eq!(owners.get(&name).map(|o| o.session_id.as_str()), Some("s1"));
    }
}
