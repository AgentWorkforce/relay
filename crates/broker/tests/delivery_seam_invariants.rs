use relay_broker::delivery::{
    AckEvidence, DeliveryBackend, DeliveryBackendFuture, DeliveryError, DeliverySeam,
    HandoverState, ObservedAck, RouteId, SendOutcome, SendRequest, SendStatus, SettleOutcome,
    SettleRequest, SettleStatus, TransportStatus,
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

/// Rule 2 at the cancellation boundary: dropping a send future after its
/// backend starts must leave enough route state to refuse a second write.
///
/// The fleet path applies a wall-clock deadline outside `DeliverySeam::send`.
/// A PTY frame can already be admitted to the sole writer queue when that
/// deadline fires, so "the future returned no receipt" is not evidence that
/// nothing was written.
#[tokio::test]
async fn a_cancelled_send_remains_in_doubt_and_is_not_retried() {
    #[derive(Debug)]
    struct PendingBackend {
        sends: usize,
    }

    impl DeliveryBackend for PendingBackend {
        fn route_id(&self) -> RouteId {
            RouteId::new("pending")
        }

        fn transport_status(&mut self) -> TransportStatus {
            TransportStatus::Available
        }

        fn send<'a>(
            &'a mut self,
            _request: &'a SendRequest,
        ) -> DeliveryBackendFuture<'a, Result<SendStatus, DeliveryError>> {
            self.sends += 1;
            Box::pin(std::future::pending())
        }

        fn settle<'a>(
            &'a mut self,
            _request: &'a SettleRequest,
        ) -> DeliveryBackendFuture<'a, SettleStatus> {
            Box::pin(async { SettleStatus::HandedOver(HandoverState::HandedOver) })
        }
    }

    let delivery_id = relay_broker::ids::DeliveryId::new("del_cancelled");
    let mut backend = PendingBackend { sends: 0 };
    let mut seam = DeliverySeam::new();

    let timed_out = tokio::time::timeout(
        std::time::Duration::from_millis(10),
        seam.send(
            &mut [&mut backend],
            SendRequest::new(delivery_id.clone(), "possibly written"),
        ),
    )
    .await;
    assert!(timed_out.is_err(), "the fixture backend must stay pending");
    assert_eq!(backend.sends, 1, "the first attempt must reach the backend");
    assert_eq!(
        seam.recorded_route(&delivery_id).map(RouteId::as_str),
        Some("pending"),
        "cancelling after backend admission must leave a route receipt"
    );

    let retry = seam
        .send(
            &mut [&mut backend],
            SendRequest::new(delivery_id, "must not be written twice"),
        )
        .await
        .expect("a cancelled delivery resolves from its provisional receipt");
    assert!(
        matches!(
            retry,
            SendOutcome::AlreadySent(ref receipt) if receipt.status == SendStatus::InDoubt
        ),
        "a cancelled send must be classified already-sent/in-doubt, got {retry:?}"
    );
    assert_eq!(backend.sends, 1, "retrying must not call the backend again");
}

#[tokio::test]
async fn records_route_for_each_send() {
    let mut stale_native = ScriptedBackend::unavailable("native", "version gate failed")
        .with_settle_status(SettleStatus::Acked(ObservedAck::peer_ack("wrong route")));
    let mut pty = ScriptedBackend::new(
        "pty",
        vec![Ok(SendStatus::HandedOver(HandoverState::HandedOver))],
    )
    .with_settle_status(SettleStatus::Acked(ObservedAck::transcript("pty", 0)));
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
        .await;

    assert_eq!(
        settle,
        SettleOutcome::Settled(SettleStatus::Acked(ObservedAck::transcript("pty", 0)))
    );
    assert!(
        !settle.is_absent(),
        "a settled delivery is never evidence that nothing was sent"
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

    let settle = seam.settle(&mut [&mut pty], &delivery_id).await;

    assert_eq!(
        pty.settles.len(),
        1,
        "the seam must consult the recorded route; an empty settle implementation must fail this test"
    );
    assert!(matches!(
        settle,
        SettleOutcome::Settled(SettleStatus::HandedOver(HandoverState::HandedOver))
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

/// Rule 2's trap shape: a caller must be able to tell "never sent" from
/// "sent somewhere I cannot currently see".
///
/// `settle` used to answer `None` for both. They are opposite facts, and the
/// one that matters is the second: it looks exactly like absence, and a caller
/// that reads absence as "it never arrived" and re-sends duplicates a message
/// that may already have landed. Nothing calls `settle` in production yet,
/// which is why this distinction is cheap to hold now and expensive once a
/// phase-1 route depends on it.
#[tokio::test]
async fn settle_distinguishes_absence_from_an_unreachable_route() {
    let mut pty = ScriptedBackend::new(
        "pty",
        vec![Ok(SendStatus::HandedOver(HandoverState::HandedOver))],
    );
    let mut seam = DeliverySeam::new();

    // 1. Never sent from this seam. The only outcome that is real absence.
    let never_sent = relay_broker::ids::DeliveryId::new("del_never_sent");
    let outcome = seam.settle(&mut [&mut pty], &never_sent).await;
    assert_eq!(outcome, SettleOutcome::NoReceipt);
    assert!(
        outcome.is_absent(),
        "a delivery this seam never sent is the one safe 'absent'"
    );

    // 2. Sent over "pty", then settled against a slice that does not contain
    //    it. The message is somewhere; this call just cannot reach its route.
    let sent = relay_broker::ids::DeliveryId::new("del_sent_elsewhere");
    seam.send(
        &mut [&mut pty],
        SendRequest::new(sent.clone(), "handed to pty"),
    )
    .await
    .expect("hand-off should be recorded");

    let mut other = ScriptedBackend::new(
        "some-other-route",
        vec![Ok(SendStatus::HandedOver(HandoverState::HandedOver))],
    );
    let outcome = seam.settle(&mut [&mut other], &sent).await;
    assert_eq!(
        outcome,
        SettleOutcome::RouteUnavailable(RouteId::new("pty")),
        "the recorded route must be named, not erased into absence"
    );
    assert!(
        !outcome.is_absent(),
        "rule 2: an unreachable route is NOT evidence the message was never sent"
    );
    assert_eq!(
        other.settles.len(),
        0,
        "settlement must never be retargeted onto a route that did not accept the send"
    );
}

/// The same trap, reached through the bounded receipt memory rather than
/// through an absent backend.
#[tokio::test]
async fn settle_reports_an_evicted_receipt_as_unknown_not_absent() {
    let mut seam = DeliverySeam::new();
    let evicted = relay_broker::ids::DeliveryId::new("del_evicted");

    let mut pty = ScriptedBackend::new(
        "pty",
        vec![
            Ok(SendStatus::HandedOver(HandoverState::HandedOver));
            DeliverySeam::max_receipts() + 2
        ],
    );

    seam.send(
        &mut [&mut pty],
        SendRequest::new(evicted.clone(), "first, and soon forgotten"),
    )
    .await
    .expect("hand-off should be recorded");

    // Push the first receipt out of the bounded memory.
    for index in 0..DeliverySeam::max_receipts() {
        seam.send(
            &mut [&mut pty],
            SendRequest::new(
                relay_broker::ids::DeliveryId::new(format!("del_filler_{index}")),
                "filler",
            ),
        )
        .await
        .expect("filler hand-off");
    }

    let outcome = seam.settle(&mut [&mut pty], &evicted).await;
    assert_eq!(
        outcome,
        SettleOutcome::RouteUnknown,
        "a forgotten receipt must say it was forgotten"
    );
    assert!(
        !outcome.is_absent(),
        "forgetting where a message went is not evidence it never went"
    );
}

/// Rule 4's evidence vocabulary, made explicit rather than stringly typed.
///
/// The rule is "never claim an acknowledgement you did not observe". A free
/// string could not express it — `ObservedAck::new("ok")` would have satisfied
/// the type while observing nothing. Every constructor now demands a named
/// observation, and there is no variant meaning "nothing", so a backend cannot
/// report `Acked` without saying what it claims it saw.
///
/// This is not structural proof of observation: `peer_ack("ok")` can still be
/// constructed from arbitrary text. The shipping PTY route's behavioral test
/// is what proves that route never upgrades a hand-off into an observed ack.
#[test]
fn an_acknowledgement_must_name_the_observation_behind_it() {
    let echo = ObservedAck::echo("relay-inbound-42");
    assert_eq!(
        echo.evidence(),
        &AckEvidence::Echo {
            matched: "relay-inbound-42".to_string()
        }
    );

    let exit = ObservedAck::process_exit(0);
    assert_eq!(exit.evidence(), &AckEvidence::ProcessExit { code: 0 });

    let transcript = ObservedAck::transcript("session.jsonl", 1024);
    assert_eq!(
        transcript.evidence(),
        &AckEvidence::Transcript {
            source: "session.jsonl".to_string(),
            offset: 1024
        }
    );

    // Distinct evidence must stay distinguishable: an ack is only as good as
    // what produced it, so a consumer weighing a peer's claim against a byte
    // offset it can re-read must be able to tell them apart.
    assert_ne!(ObservedAck::peer_ack("ok"), ObservedAck::echo("ok"));
}

#[cfg(unix)]
#[tokio::test]
async fn real_pty_route_unknown_worker_is_pre_write_and_may_fall_back() {
    relay_broker::delivery::pty::real_route_probe::unknown_worker_is_pre_write_and_may_fall_back()
        .await;
}

#[cfg(unix)]
#[tokio::test]
async fn real_pty_route_write_failure_after_commit_does_not_fall_back() {
    relay_broker::delivery::pty::real_route_probe::write_failure_after_commit_does_not_fall_back()
        .await;
}

#[cfg(unix)]
#[tokio::test]
async fn real_pty_route_never_reports_an_observed_ack() {
    relay_broker::delivery::pty::real_route_probe::never_reports_an_observed_ack().await;
}
