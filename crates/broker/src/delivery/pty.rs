use super::backend::{
    DeliveryBackend, DeliveryError, HandoverState, RouteId, SendRequest, SendStatus, SettleRequest,
    SettleStatus, TransportStatus,
};
use crate::worker::WorkerRegistry;

/// Phase-0 PTY route adapter.
///
/// The existing worker/wrap loops still own real PTY injection. This adapter
/// gives that route a stable identity and the same conservative semantics as
/// future native backends: a queued write without observed echo/activity is a
/// hand-off, not a fabricated acknowledgement.
pub(crate) struct PtyDeliveryBackend<'a> {
    route: RouteId,
    workers: &'a mut WorkerRegistry,
}

impl<'a> PtyDeliveryBackend<'a> {
    pub(crate) fn new(workers: &'a mut WorkerRegistry) -> Self {
        Self {
            route: RouteId::new(RouteId::PTY),
            workers,
        }
    }
}

impl DeliveryBackend for PtyDeliveryBackend<'_> {
    fn route_id(&self) -> RouteId {
        self.route.clone()
    }

    fn transport_status(&mut self) -> TransportStatus {
        TransportStatus::Available
    }

    fn send<'a>(
        &'a mut self,
        request: &'a SendRequest,
    ) -> super::backend::DeliveryBackendFuture<'a, Result<SendStatus, DeliveryError>> {
        Box::pin(async move {
            let worker_name = request
                .worker_name
                .as_ref()
                .ok_or_else(|| DeliveryError::unavailable("PTY route requires a worker target"))?;
            let delivery = request.relay_delivery.clone().ok_or_else(|| {
                DeliveryError::unavailable("PTY route requires a relay delivery payload")
            })?;
            self.workers
                .deliver_with_commit_boundary(worker_name.as_str(), delivery)
                .await
                .map_err(|error| match error {
                    crate::worker::WorkerDeliverError::PreWrite(reason) => {
                        DeliveryError::unavailable(reason)
                    }
                    crate::worker::WorkerDeliverError::Committed(reason) => {
                        DeliveryError::committed(reason)
                    }
                })?;
            Ok(SendStatus::HandedOver(HandoverState::HandedOver))
        })
    }

    fn settle<'a>(
        &'a mut self,
        _request: &'a SettleRequest,
    ) -> super::backend::DeliveryBackendFuture<'a, SettleStatus> {
        Box::pin(async move { SettleStatus::HandedOver(HandoverState::HandedOver) })
    }
}

#[cfg(all(unix, feature = "seam-probe"))]
#[doc(hidden)]
pub mod real_route_probe {
    use super::*;
    use crate::delivery::backend::{DeliverySeam, SendOutcome};
    use crate::ids::{DeliveryId, EventId, MessageTarget, WorkerName};
    use crate::protocol::{AgentRuntime, AgentSpec, MessageInjectionMode, RelayDelivery};
    use crate::worker::{
        spawn_worker_writer, AgentWorkState, WorkerEvent, WorkerHandle, WorkerRegistry,
        WORKER_WRITE_QUEUE_CAPACITY,
    };
    use std::process::Stdio;
    use std::time::Instant;
    use tokio::process::Command;
    use tokio::sync::mpsc;
    use uuid::Uuid;

    struct FallbackProbe {
        route: RouteId,
        sends: usize,
    }

    impl FallbackProbe {
        fn new() -> Self {
            Self {
                route: RouteId::new("fallback-probe"),
                sends: 0,
            }
        }
    }

    impl DeliveryBackend for FallbackProbe {
        fn route_id(&self) -> RouteId {
            self.route.clone()
        }

        fn transport_status(&mut self) -> TransportStatus {
            TransportStatus::Available
        }

        fn send<'a>(
            &'a mut self,
            _request: &'a SendRequest,
        ) -> crate::delivery::backend::DeliveryBackendFuture<'a, Result<SendStatus, DeliveryError>>
        {
            self.sends += 1;
            Box::pin(async move { Ok(SendStatus::HandedOver(HandoverState::HandedOver)) })
        }

        fn settle<'a>(
            &'a mut self,
            _request: &'a SettleRequest,
        ) -> crate::delivery::backend::DeliveryBackendFuture<'a, SettleStatus> {
            Box::pin(async move { SettleStatus::HandedOver(HandoverState::HandedOver) })
        }
    }

    fn registry() -> (
        WorkerRegistry,
        mpsc::Sender<WorkerEvent>,
        mpsc::Receiver<WorkerEvent>,
    ) {
        let (event_tx, event_rx) = mpsc::channel(256);
        let reg = WorkerRegistry::new(
            event_tx.clone(),
            Vec::new(),
            std::env::temp_dir().join(format!("relay-seam-test-{}", Uuid::new_v4())),
            Instant::now(),
        );
        (reg, event_tx, event_rx)
    }

    fn spec(name: &str) -> AgentSpec {
        AgentSpec {
            name: WorkerName::from(name),
            runtime: AgentRuntime::Headless,
            provider: None,
            cli: None,
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
        }
    }

    fn delivery(id: &str, target: &str) -> RelayDelivery {
        RelayDelivery {
            delivery_id: DeliveryId::new(id),
            event_id: EventId::new(format!("evt_{id}")),
            workspace_id: None,
            workspace_alias: None,
            from: "sender".to_string(),
            target: MessageTarget::new(target),
            body: "hello".to_string(),
            thread_id: None,
            priority: None,
            injection_mode: MessageInjectionMode::default(),
        }
    }

    async fn register_dead_child(
        reg: &mut WorkerRegistry,
        event_tx: &mpsc::Sender<WorkerEvent>,
        name: &str,
    ) {
        let mut child = Command::new("true")
            .stdin(Stdio::piped())
            .spawn()
            .expect("spawn true");
        let stdin = child.stdin.take().expect("piped stdin");
        child.wait().await.expect("child exits immediately");
        let generation = Uuid::new_v4();
        let (command_tx, command_rx) = mpsc::channel(WORKER_WRITE_QUEUE_CAPACITY);
        spawn_worker_writer(
            event_tx.clone(),
            WorkerName::from(name),
            generation,
            stdin,
            command_rx,
        );
        reg.workers.insert(
            WorkerName::from(name),
            WorkerHandle {
                generation,
                spec: spec(name),
                parent: None,
                workspace_id: None,
                child,
                command_tx,
                harness_pid: None,
                spawned_at: Instant::now(),
                ready_at: None,
                last_activity_at: Instant::now(),
                context_budget_pct: None,
                state: AgentWorkState::Working,
                exit_reason: None,
            },
        );
    }

    pub async fn unknown_worker_is_pre_write_and_may_fall_back() {
        let (mut reg, _event_tx, _event_rx) = registry();
        let mut pty = PtyDeliveryBackend::new(&mut reg);
        let mut fallback = FallbackProbe::new();
        let mut seam = DeliverySeam::new();
        let request = SendRequest::relay(
            WorkerName::from("no-such-worker"),
            delivery("del_unknown", "no-such-worker"),
        );

        let outcome = seam
            .send(&mut [&mut pty, &mut fallback], request)
            .await
            .expect("an unknown worker is a pre-write refusal, so the seam may fall back");

        let SendOutcome::Fresh(receipt) = outcome else {
            panic!("a first successful send must be fresh");
        };
        assert_eq!(receipt.route.as_str(), "fallback-probe");
        assert_eq!(fallback.sends, 1);
    }

    pub async fn write_failure_after_commit_does_not_fall_back() {
        let (mut reg, event_tx, _event_rx) = registry();
        register_dead_child(&mut reg, &event_tx, "dead-child").await;
        let mut pty = PtyDeliveryBackend::new(&mut reg);
        let mut fallback = FallbackProbe::new();
        let mut seam = DeliverySeam::new();
        let request = SendRequest::relay(
            WorkerName::from("dead-child"),
            delivery("del_committed", "dead-child"),
        );

        let error = seam
            .send(&mut [&mut pty, &mut fallback], request)
            .await
            .expect_err("a write that may have partially landed must not fall back");

        assert!(
            matches!(error, DeliveryError::CommittedError { .. }),
            "a real EPIPE after the commit boundary must classify as committed, got {error:?}"
        );
        assert_eq!(fallback.sends, 0);
        assert_eq!(
            seam.recorded_route(&DeliveryId::new("del_committed"))
                .map(RouteId::as_str),
            Some("pty")
        );
    }

    pub async fn never_reports_an_observed_ack() {
        let (mut reg, _event_tx, _event_rx) = registry();
        let mut pty = PtyDeliveryBackend::new(&mut reg);
        let settled = pty
            .settle(&SettleRequest {
                delivery_id: DeliveryId::new("del_settle"),
                route: RouteId::new(RouteId::PTY),
            })
            .await;

        assert!(matches!(
            settled,
            SettleStatus::HandedOver(HandoverState::HandedOver)
        ));
        assert!(!matches!(settled, SettleStatus::Acked(_)));
    }
}
