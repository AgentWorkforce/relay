use relay_broker::delivery::{
    DeliveryBackend, DeliveryBackendFuture, DeliveryError, DeliverySeam, HandoverState,
    ObservedAck, RouteId, SendOutcome, SendRequest, SendStatus, SettleRequest, SettleStatus,
    TransportStatus,
};

#[derive(Debug)]
struct ScriptedBackend {
    route: RouteId,
    transport_statuses: Vec<TransportStatus>,
    send_results: Vec<Result<SendStatus, DeliveryError>>,
    settle_status: SettleStatus,
    sends: usize,
    settles: Vec<SettleRequest>,
}

impl ScriptedBackend {
    fn new(route: &str, send_results: Vec<Result<SendStatus, DeliveryError>>) -> Self {
        Self {
            route: RouteId::new(route),
            transport_statuses: vec![TransportStatus::Available],
            send_results,
            settle_status: SettleStatus::HandedOver(HandoverState::HandedOver),
            sends: 0,
            settles: Vec::new(),
        }
    }

    fn unavailable(route: &str, reason: &str) -> Self {
        Self {
            route: RouteId::new(route),
            transport_statuses: vec![TransportStatus::Unavailable(reason.to_string())],
            send_results: Vec::new(),
            settle_status: SettleStatus::HandedOver(HandoverState::HandedOver),
            sends: 0,
            settles: Vec::new(),
        }
    }

    fn with_settle_status(mut self, status: SettleStatus) -> Self {
        self.settle_status = status;
        self
    }
}

impl DeliveryBackend for ScriptedBackend {
    fn route_id(&self) -> RouteId {
        self.route.clone()
    }

    fn transport_status(&mut self) -> TransportStatus {
        self.transport_statuses
            .pop()
            .unwrap_or(TransportStatus::Available)
    }

    fn send<'a>(
        &'a mut self,
        _request: &'a SendRequest,
    ) -> DeliveryBackendFuture<'a, Result<SendStatus, DeliveryError>> {
        Box::pin(async move {
            self.sends += 1;
            self.send_results
                .pop()
                .unwrap_or(Ok(SendStatus::HandedOver(HandoverState::HandedOver)))
        })
    }

    fn settle<'a>(
        &'a mut self,
        request: &'a SettleRequest,
    ) -> DeliveryBackendFuture<'a, SettleStatus> {
        Box::pin(async move {
            self.settles.push(request.clone());
            self.settle_status.clone()
        })
    }
}

#[tokio::test]
async fn falls_back_only_before_write() {
    let request = SendRequest::new("del_pre_write", "hello");
    let mut native = ScriptedBackend::new(
        "native",
        vec![Err(DeliveryError::unavailable("missing socket"))],
    );
    let mut pty = ScriptedBackend::new(
        "pty",
        vec![Ok(SendStatus::HandedOver(HandoverState::HandedOver))],
    );
    let mut seam = DeliverySeam::new();

    let receipt = seam
        .send(&mut [&mut native, &mut pty], request)
        .await
        .expect("pre-write failures may fall back to another route");

    let SendOutcome::Fresh(receipt) = receipt else {
        panic!("first successful send must be fresh");
    };
    assert_eq!(receipt.route.as_str(), "pty");
    assert_eq!(native.sends, 1);
    assert_eq!(pty.sends, 1);

    let request = SendRequest::new("del_post_write", "hello");
    let mut native = ScriptedBackend::new(
        "native",
        vec![Err(DeliveryError::committed("socket closed after write"))],
    );
    let mut pty = ScriptedBackend::new(
        "pty",
        vec![Ok(SendStatus::HandedOver(HandoverState::HandedOver))],
    );
    let mut seam = DeliverySeam::new();

    let error = seam
        .send(&mut [&mut native, &mut pty], request)
        .await
        .expect_err("post-write failures must not fall back");

    assert!(matches!(error, DeliveryError::CommittedError { .. }));
    assert_eq!(native.sends, 1);
    assert_eq!(pty.sends, 0);
    assert_eq!(
        seam.recorded_route(&relay_broker::ids::DeliveryId::new("del_post_write"))
            .map(RouteId::as_str),
        Some("native")
    );
}

#[tokio::test]
async fn never_resends_on_doubt() {
    let mut native = ScriptedBackend::new("native", vec![Ok(SendStatus::InDoubt)]);
    let mut pty = ScriptedBackend::new(
        "pty",
        vec![Ok(SendStatus::HandedOver(HandoverState::HandedOver))],
    );
    let mut seam = DeliverySeam::new();

    let receipt = seam
        .send(
            &mut [&mut native, &mut pty],
            SendRequest::new("del_doubt", "hello"),
        )
        .await
        .expect("in-doubt sends are recorded, not retried");

    let SendOutcome::Fresh(receipt) = receipt else {
        panic!("first in-doubt send must be fresh");
    };
    assert_eq!(receipt.route.as_str(), "native");
    assert_eq!(receipt.status, SendStatus::InDoubt);
    assert_eq!(native.sends, 1);
    assert_eq!(pty.sends, 0);

    let duplicate = seam
        .send(
            &mut [&mut native, &mut pty],
            SendRequest::new("del_doubt", "retry after doubt"),
        )
        .await
        .expect("duplicate delivery ids return the original receipt");

    assert_eq!(duplicate, SendOutcome::AlreadySent(receipt));
    assert_eq!(native.sends, 1);
    assert_eq!(pty.sends, 0);
}

#[tokio::test]
async fn records_route_for_each_send() {
    let mut stale_native = ScriptedBackend::unavailable("native", "version gate failed")
        .with_settle_status(SettleStatus::Acked(ObservedAck::new("wrong route")));
    let mut pty = ScriptedBackend::new(
        "pty",
        vec![Ok(SendStatus::HandedOver(HandoverState::HandedOver))],
    )
    .with_settle_status(SettleStatus::Acked(ObservedAck::new("pty transcript")));
    let mut seam = DeliverySeam::new();
    let delivery_id = relay_broker::ids::DeliveryId::new("del_route");

    let receipt = seam
        .send(
            &mut [&mut stale_native, &mut pty],
            SendRequest::new(delivery_id.clone(), "hello"),
        )
        .await
        .expect("PTY fallback should accept the send");

    let SendOutcome::Fresh(receipt) = receipt else {
        panic!("accepted route must be fresh");
    };
    assert_eq!(receipt.route.as_str(), "pty");
    assert_eq!(
        seam.recorded_route(&delivery_id).map(RouteId::as_str),
        Some("pty")
    );

    let settle = seam
        .settle(&mut [&mut stale_native, &mut pty], &delivery_id)
        .await
        .expect("recorded route should be settled");

    assert_eq!(
        settle,
        SettleStatus::Acked(ObservedAck::new("pty transcript"))
    );
    assert!(stale_native.settles.is_empty());
    assert_eq!(pty.settles.len(), 1);
    assert_eq!(pty.settles[0].route.as_str(), "pty");
}

#[tokio::test]
async fn never_acks_without_observation() {
    let mut pty = ScriptedBackend::new(
        "pty",
        vec![Ok(SendStatus::HandedOver(HandoverState::HandedOver))],
    )
    .with_settle_status(SettleStatus::HandedOver(HandoverState::HandedOver));
    let mut seam = DeliverySeam::new();
    let delivery_id = relay_broker::ids::DeliveryId::new("del_no_ack");

    let receipt = seam
        .send(
            &mut [&mut pty],
            SendRequest::new(delivery_id.clone(), "socket write only"),
        )
        .await
        .expect("write hand-off without observation should be tracked");

    let SendOutcome::Fresh(receipt) = receipt else {
        panic!("first hand-off must be fresh");
    };
    assert_eq!(
        receipt.status,
        SendStatus::HandedOver(HandoverState::HandedOver)
    );

    let settle = seam
        .settle(&mut [&mut pty], &delivery_id)
        .await
        .expect("recorded route should settle as hand-off");

    assert!(matches!(
        settle,
        SettleStatus::HandedOver(HandoverState::HandedOver)
    ));
}

/// relay: F6 — the duplicate guard must not resurrect a duplicate at its bound.
///
/// `DeliverySeam` remembers a receipt per delivery so a second send for the
/// same id returns `AlreadySent` instead of handing the message to a transport
/// twice. That memory is bounded, and the bound was a FIFO of receipts: at
/// capacity the oldest is dropped. A delivery whose receipt is evicted and
/// which is then retried classifies as `Fresh` again — the guard hands the
/// message to a backend a second time, which is precisely the double delivery
/// it exists to prevent.
///
/// Forgetting must therefore be explicit: an id the seam once knew and has
/// since evicted is not the same as an id it has never seen.
#[tokio::test]
async fn an_evicted_receipt_does_not_become_a_fresh_send() {
    let mut seam = DeliverySeam::new();
    let mut backend = ScriptedBackend::new(
        "pty",
        (0..DeliverySeam::max_receipts() + 2)
            .map(|_| Ok(SendStatus::HandedOver(HandoverState::HandedOver)))
            .collect(),
    );

    // The delivery whose receipt will be evicted.
    let first = SendRequest::new("del_evicted", "hello");
    let outcome = seam
        .send(&mut [&mut backend], first)
        .await
        .expect("first send is accepted");
    assert!(matches!(outcome, SendOutcome::Fresh(_)));

    // Fill past the bound so `del_evicted` is pushed out.
    for index in 0..DeliverySeam::max_receipts() + 1 {
        let filler = SendRequest::new(format!("del_filler_{index}"), "x");
        seam.send(&mut [&mut backend], filler)
            .await
            .expect("filler send is accepted");
    }

    // The original delivery is retried after its receipt was forgotten.
    let retried = SendRequest::new("del_evicted", "hello");
    let outcome = seam
        .send(&mut [&mut backend], retried)
        .await
        .expect("retry is resolved");

    assert!(
        !matches!(outcome, SendOutcome::Fresh(_)),
        "an evicted receipt was classified Fresh, so the seam handed an already-sent \
         message to a backend a second time"
    );
}
