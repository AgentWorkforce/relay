use std::collections::{HashSet, VecDeque};
use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::time::{Duration, Instant};

use crate::ids::{DeliveryId, WorkerName};
use crate::protocol::RelayDelivery;

pub type DeliveryBackendFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Stable identifier for the transport route that accepted a send.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct RouteId(String);

impl RouteId {
    /// The broker-owned PTY route. Named so the one place that has to reason
    /// about "does this transport outlive the broker" cannot drift from the
    /// string the PTY backend reports.
    pub const PTY: &'static str = "pty";

    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Whether a message this route accepted can still reach the recipient
    /// after the broker process that wrote it is gone.
    ///
    /// The PTY route writes into a child the broker owns: the child dies with
    /// the broker, so an un-acknowledged write provably never arrived and
    /// redelivering it after a restart is correct. Every native route hands the
    /// message to a durable store owned by the vendor's own session — Codex's
    /// `queued_items` table, for instance — which outlives both the worker and
    /// the broker. Redelivering there is a double delivery, so a restart must
    /// remember it (seam rule 2).
    pub fn survives_broker_restart(&self) -> bool {
        self.0 != Self::PTY
    }
}

impl fmt::Display for RouteId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

impl From<&str> for RouteId {
    fn from(value: &str) -> Self {
        Self::new(value)
    }
}

impl From<String> for RouteId {
    fn from(value: String) -> Self {
        Self::new(value)
    }
}

/// Message hand-off request passed to one backend.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SendRequest {
    pub delivery_id: DeliveryId,
    pub body: String,
    pub worker_name: Option<WorkerName>,
    pub relay_delivery: Option<RelayDelivery>,
}

impl SendRequest {
    pub fn new(delivery_id: impl Into<DeliveryId>, body: impl Into<String>) -> Self {
        Self {
            delivery_id: delivery_id.into(),
            body: body.into(),
            worker_name: None,
            relay_delivery: None,
        }
    }

    pub(crate) fn relay(worker_name: WorkerName, delivery: RelayDelivery) -> Self {
        Self {
            delivery_id: delivery.delivery_id.clone(),
            body: delivery.body.clone(),
            worker_name: Some(worker_name),
            relay_delivery: Some(delivery),
        }
    }
}

/// What a settlement attempt could establish.
///
/// Deliberately not an `Option<SettleStatus>`: "we never sent this" and "we
/// sent it over a route we cannot currently reach" are opposite facts that an
/// `Option` renders identically, and acting on the wrong one re-sends a
/// delivered message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SettleOutcome {
    /// The recorded route answered.
    Settled(SettleStatus),
    /// This seam has no record of the delivery: it was never sent from here.
    /// Safe to treat as absence.
    NoReceipt,
    /// The delivery WAS sent, over a route that is not among the backends
    /// offered. Not absence — the message is somewhere this call cannot see.
    RouteUnavailable(RouteId),
    /// The delivery was sent and its receipt has since been evicted from the
    /// bounded memory, so the route is unknown. Not absence.
    RouteUnknown,
}

impl SettleOutcome {
    /// True only when this outcome is positive evidence that nothing was sent.
    ///
    /// The one question a caller deciding whether to re-send may ask.
    pub fn is_absent(&self) -> bool {
        matches!(self, SettleOutcome::NoReceipt)
    }
}

/// Settlement request. The route is recorded from the accepted send and must
/// not be recomputed from current discovery state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettleRequest {
    pub delivery_id: DeliveryId,
    pub route: RouteId,
}

/// Explicit hand-over state for writes that did not produce an observed ack.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HandoverState {
    /// Backend accepted responsibility for the message, but delivery was not
    /// observed. This is intentionally weaker than an acknowledgement.
    HandedOver,
}

/// What a route actually saw, when it claims to have seen a delivery land.
///
/// Seam rule 4 is "never claim an acknowledgement you did not observe". A free
/// string cannot express that rule: a backend could write
/// `ObservedAck::new("ok")` without observing anything, and the type would
/// agree. Naming the admissible kinds of evidence makes unsupported claims
/// visible and reviewable — a route has to say WHAT it claims it saw, and
/// there is no variant meaning "nothing". It does not prove the claim:
/// `PeerAck { detail }` still accepts backend-supplied text, so real-route
/// behavioral tests remain the enforcement for rule 4.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AckEvidence {
    /// The route matched the injected text echoed back by the recipient.
    Echo { matched: String },
    /// A headless child consumed the message and exited cleanly. The exit IS
    /// the observation; see `PROCESS_EXIT_VERIFICATION`.
    ProcessExit { code: i32 },
    /// The message was found in the recipient's own transcript or session
    /// file, at a byte offset that can be re-read.
    Transcript { source: String, offset: u64 },
    /// The transport itself confirmed the peer received the frame — an ack
    /// from the far side, not from the act of writing.
    PeerAck { detail: String },
}

/// Acknowledgement evidence observed by the route that accepted the send.
///
/// Constructible only from an [`AckEvidence`], so "acknowledged" cannot be
/// asserted without naming the claimed observation behind it. The type does
/// not independently verify that a backend actually observed that evidence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObservedAck {
    evidence: AckEvidence,
}

impl ObservedAck {
    pub fn echo(matched: impl Into<String>) -> Self {
        Self {
            evidence: AckEvidence::Echo {
                matched: matched.into(),
            },
        }
    }

    pub fn process_exit(code: i32) -> Self {
        Self {
            evidence: AckEvidence::ProcessExit { code },
        }
    }

    pub fn transcript(source: impl Into<String>, offset: u64) -> Self {
        Self {
            evidence: AckEvidence::Transcript {
                source: source.into(),
                offset,
            },
        }
    }

    pub fn peer_ack(detail: impl Into<String>) -> Self {
        Self {
            evidence: AckEvidence::PeerAck {
                detail: detail.into(),
            },
        }
    }

    pub fn evidence(&self) -> &AckEvidence {
        &self.evidence
    }
}

/// Outcome of one backend's send attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SendStatus {
    /// The route accepted the message and observed an acknowledgement.
    Acked(ObservedAck),
    /// The route accepted responsibility but did not observe delivery.
    HandedOver(HandoverState),
    /// The route refused before any write. Another route may be tried.
    Refused,
    /// The route is uncertain after commit. The seam must never retry this.
    InDoubt,
}

/// Result recorded for a send that was accepted by a specific route.
#[derive(Debug, Clone)]
pub struct SendReceipt {
    pub delivery_id: DeliveryId,
    pub route: RouteId,
    pub status: SendStatus,
    recorded_at: Instant,
}

// `recorded_at` is internal settlement bookkeeping, not part of a receipt's
// externally observable identity. Keep equality stable for callers and tests
// that construct equivalent receipts at different instants.
impl PartialEq for SendReceipt {
    fn eq(&self, other: &Self) -> bool {
        self.delivery_id == other.delivery_id
            && self.route == other.route
            && self.status == other.status
    }
}

impl Eq for SendReceipt {}

impl SendReceipt {
    pub fn new(delivery_id: DeliveryId, route: RouteId, status: SendStatus) -> Self {
        Self {
            delivery_id,
            route,
            status,
            recorded_at: Instant::now(),
        }
    }

    pub fn age(&self) -> Duration {
        self.recorded_at.elapsed()
    }
}

/// Result of asking the seam to send one delivery.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SendOutcome {
    /// A backend was consulted during this call and accepted responsibility.
    Fresh(SendReceipt),
    /// This delivery id already has a recorded route. Returning it must not be
    /// counted as another transport attempt by callers.
    AlreadySent(SendReceipt),
    /// This delivery was sent before, but its receipt has since been evicted by
    /// the seam's bound, so the route it took is no longer known.
    ///
    /// Seam rule 2 governs: not knowing where a message went is not evidence it
    /// did not go. A caller must NOT re-send — it must settle the delivery as
    /// in doubt.
    Forgotten { delivery_id: DeliveryId },
}

impl SendOutcome {
    /// The receipt, when one is still known. `Forgotten` has none by
    /// definition — that is the whole point of it being a distinct case rather
    /// than a missing entry.
    pub fn receipt(&self) -> Option<&SendReceipt> {
        match self {
            Self::Fresh(receipt) | Self::AlreadySent(receipt) => Some(receipt),
            Self::Forgotten { .. } => None,
        }
    }
}

/// Backend failure with an explicit commit boundary.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DeliveryError {
    /// Strictly pre-write: safe to try another route.
    #[error("delivery backend unavailable before write: {reason}")]
    Unavailable { reason: String },
    /// A write may have happened: never safe to try another route.
    #[error("delivery backend error after possible write: {reason}")]
    CommittedError { reason: String },
}

impl DeliveryError {
    pub fn unavailable(reason: impl Into<String>) -> Self {
        Self::Unavailable {
            reason: reason.into(),
        }
    }

    pub fn committed(reason: impl Into<String>) -> Self {
        Self::CommittedError {
            reason: reason.into(),
        }
    }

    pub fn is_pre_write(&self) -> bool {
        matches!(self, Self::Unavailable { .. })
    }

    pub fn is_committed(&self) -> bool {
        matches!(self, Self::CommittedError { .. })
    }
}

/// Settlement result from the route that accepted the send.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SettleStatus {
    Acked(ObservedAck),
    HandedOver(HandoverState),
    Failed(String),
}

/// Backend health/capability checked at send time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransportStatus {
    Available,
    Unavailable(String),
}

/// Trait implemented by PTY and future native delivery routes.
pub trait DeliveryBackend {
    fn route_id(&self) -> RouteId;

    /// Check dynamic capabilities immediately before sending. Vendor CLIs can
    /// auto-update underneath a running broker, so this cannot be install-time
    /// state.
    fn transport_status(&mut self) -> TransportStatus;

    /// Cancellation safety: once a backend has begun a write, callers must not
    /// assume a dropped future means no delivery happened. Implementations
    /// must return `DeliveryError::CommittedError` only when their route can
    /// distinguish that boundary; otherwise use `Unavailable` and let the
    /// route's legacy retry policy stand.
    fn send<'a>(
        &'a mut self,
        request: &'a SendRequest,
    ) -> DeliveryBackendFuture<'a, Result<SendStatus, DeliveryError>>;

    fn settle<'a>(
        &'a mut self,
        request: &'a SettleRequest,
    ) -> DeliveryBackendFuture<'a, SettleStatus>;
}

/// Route-aware transport coordinator enforcing the phase-0 seam invariants.
#[derive(Debug, Default)]
pub struct DeliverySeam {
    receipts: VecDeque<SendReceipt>,
    /// Delivery ids whose receipt was evicted by the bound.
    ///
    /// An id the seam once knew and has since forgotten is NOT the same as one
    /// it has never seen. Without this, eviction reclassified a retried
    /// delivery as `Fresh` and the seam handed an already-sent message to a
    /// backend a second time — the duplicate the guard exists to prevent,
    /// produced by the guard's own bound.
    evicted: HashSet<DeliveryId>,
}

impl DeliverySeam {
    const MAX_RECEIPTS: usize = 4096;

    pub fn new() -> Self {
        Self::default()
    }

    /// The receipt-memory bound, exposed so a test can exercise eviction
    /// without hardcoding a number that would silently stop testing eviction
    /// the day the bound changes.
    pub fn max_receipts() -> usize {
        Self::MAX_RECEIPTS
    }

    /// Cancellation safety: record the selected route as in doubt before
    /// awaiting `backend.send`. If the caller cancels after that await begins,
    /// the provisional receipt survives and a later attempt returns
    /// [`SendOutcome::AlreadySent`] instead of writing again.
    ///
    /// An explicit pre-write refusal removes the provisional receipt and may
    /// fall back. Cancellation cannot prove that boundary, so it deliberately
    /// fails closed: a delivery that might not have been written can become
    /// non-redeliverable, but a delivery that might have been written is never
    /// duplicated.
    pub async fn send(
        &mut self,
        backends: &mut [&mut dyn DeliveryBackend],
        request: SendRequest,
    ) -> Result<SendOutcome, DeliveryError> {
        if let Some(receipt) = self
            .receipts
            .iter()
            .find(|receipt| receipt.delivery_id == request.delivery_id)
            .cloned()
        {
            return Ok(SendOutcome::AlreadySent(receipt));
        }

        // Known-but-forgotten is not the same as never-seen. Re-sending here
        // would be a re-send on doubt (rule 2) and could double-deliver.
        if self.evicted.contains(&request.delivery_id) {
            return Ok(SendOutcome::Forgotten {
                delivery_id: request.delivery_id,
            });
        }

        let mut last_pre_write_error = None;

        for backend in backends.iter_mut() {
            match backend.transport_status() {
                TransportStatus::Available => {}
                TransportStatus::Unavailable(reason) => {
                    last_pre_write_error = Some(DeliveryError::unavailable(reason));
                    continue;
                }
            }

            let route = backend.route_id();
            // This write-ahead receipt is the cancellation boundary. It must
            // precede the first await that can admit bytes to a transport.
            // Successful outcomes replace its status; strictly pre-write
            // outcomes remove it before considering another backend.
            self.record_receipt(SendReceipt::new(
                request.delivery_id.clone(),
                route.clone(),
                SendStatus::InDoubt,
            ));
            match backend.send(&request).await {
                Ok(SendStatus::Refused) => {
                    self.remove_receipt(&request.delivery_id, &route);
                    last_pre_write_error = Some(DeliveryError::unavailable(format!(
                        "route {route} refused before write"
                    )));
                }
                Ok(status) => {
                    let receipt = SendReceipt::new(request.delivery_id.clone(), route, status);
                    self.replace_receipt(receipt.clone());
                    return Ok(SendOutcome::Fresh(receipt));
                }
                Err(error) if error.is_pre_write() => {
                    self.remove_receipt(&request.delivery_id, &route);
                    last_pre_write_error = Some(error);
                }
                Err(error) => {
                    // The provisional receipt already records this route as in
                    // doubt. Keep it: a committed error and a cancelled future
                    // have the same retry rule.
                    return Err(error);
                }
            }
        }

        Err(last_pre_write_error
            .unwrap_or_else(|| DeliveryError::unavailable("no delivery backend available")))
    }

    /// Cancellation safety: settlement never writes to an agent; canceling this
    /// future only loses the settlement observation for this poll.
    ///
    /// Returns a three-way answer rather than an `Option`. `None` used to mean
    /// two different things — "this seam never sent it" and "it was sent, over
    /// a route that is not in this slice" — and those must not be collapsed.
    /// The second is the contract's own trap shape: it looks exactly like
    /// absence, and a caller that reads absence as "never arrived" and re-sends
    /// duplicates a message that may already have landed (rule 2). No caller
    /// exists yet, which is precisely why the distinction is cheap to make now.
    pub async fn settle(
        &mut self,
        backends: &mut [&mut dyn DeliveryBackend],
        delivery_id: &DeliveryId,
    ) -> SettleOutcome {
        let Some(receipt) = self
            .receipts
            .iter()
            .rev()
            .find(|receipt| &receipt.delivery_id == delivery_id)
        else {
            return if self.evicted.contains(delivery_id) {
                SettleOutcome::RouteUnknown
            } else {
                SettleOutcome::NoReceipt
            };
        };
        let route = receipt.route.clone();
        let request = SettleRequest {
            delivery_id: delivery_id.clone(),
            route: route.clone(),
        };
        let Some(backend) = backends
            .iter_mut()
            .find(|backend| backend.route_id() == route)
        else {
            return SettleOutcome::RouteUnavailable(route);
        };
        SettleOutcome::Settled(backend.settle(&request).await)
    }

    /// Whether this seam ever handed the delivery to a transport.
    ///
    /// [`Self::recorded_route`] answers `None` for two OPPOSITE facts: the
    /// delivery was never sent, and it was sent over a route whose receipt has
    /// since aged out of the bounded memory. A caller deciding whether a
    /// message may be re-sent must not collapse them — the second is a possible
    /// write, and re-sending a possible write double-delivers (rule 2).
    ///
    /// The eviction tombstones already carry exactly this fact; this is the
    /// question they exist to answer.
    pub fn was_sent(&self, delivery_id: &DeliveryId) -> bool {
        self.recorded_route(delivery_id).is_some() || self.evicted.contains(delivery_id)
    }

    /// Re-seed a receipt for a delivery a PREVIOUS broker lifetime handed to a
    /// route that outlives the broker.
    ///
    /// The seam's memory is process-local and starts empty, but "already handed
    /// to a transport" is not a process-local fact for a native route: the
    /// message sits in the vendor's own durable queue whether this broker is
    /// running or not. Without this, a reloaded pending snapshot classifies
    /// `Fresh` and the backend queues the same body a second time — rule 2,
    /// broken by a restart rather than by a transport fault.
    ///
    /// Deliberately restores the receipt as `HandedOver` and not as an
    /// acknowledgement: nothing was observed, and the settlement poll must
    /// still run. `recorded_at` necessarily restarts from now — an `Instant`
    /// has no meaning across processes — so the settlement window is measured
    /// from the reload, not from the original write.
    ///
    /// Callers must only pass a route for which
    /// [`RouteId::survives_broker_restart`] is true; a PTY receipt restored
    /// here would strand a message the dead child never received.
    pub fn restore_handed_over(&mut self, delivery_id: DeliveryId, route: RouteId) {
        debug_assert!(
            route.survives_broker_restart(),
            "restoring a receipt for a route that died with the broker would strand the message"
        );
        if self.was_sent(&delivery_id) {
            return;
        }
        self.record_receipt(SendReceipt::new(
            delivery_id,
            route,
            SendStatus::HandedOver(HandoverState::HandedOver),
        ));
    }

    /// Re-seed the tombstone for a delivery a previous broker lifetime handed
    /// to a transport whose route is no longer known.
    ///
    /// Same fact as [`Self::restore_handed_over`] with the route missing, which
    /// is the shape an eviction leaves behind. [`Self::was_sent`] answers true
    /// and [`Self::send`] answers [`SendOutcome::Forgotten`], so the caller
    /// settles in doubt instead of writing again.
    pub fn restore_forgotten(&mut self, delivery_id: DeliveryId) {
        if self.was_sent(&delivery_id) {
            return;
        }
        self.evicted.insert(delivery_id);
    }

    pub fn recorded_route(&self, delivery_id: &DeliveryId) -> Option<&RouteId> {
        self.receipts
            .iter()
            .rev()
            .find(|receipt| &receipt.delivery_id == delivery_id)
            .map(|receipt| &receipt.route)
    }

    pub fn recorded_age(&self, delivery_id: &DeliveryId) -> Option<Duration> {
        self.receipts
            .iter()
            .rev()
            .find(|receipt| &receipt.delivery_id == delivery_id)
            .map(SendReceipt::age)
    }

    fn record_receipt(&mut self, receipt: SendReceipt) {
        while self.receipts.len() >= Self::MAX_RECEIPTS {
            if let Some(dropped) = self.receipts.pop_front() {
                // Remember that we forgot. A later send for this id must not be
                // treated as never-seen.
                self.evicted.insert(dropped.delivery_id);
            }
        }
        self.evicted.remove(&receipt.delivery_id);
        self.receipts.push_back(receipt);
    }

    fn replace_receipt(&mut self, mut receipt: SendReceipt) {
        if let Some(recorded) = self
            .receipts
            .iter_mut()
            .rev()
            .find(|recorded| recorded.delivery_id == receipt.delivery_id)
        {
            receipt.recorded_at = recorded.recorded_at;
            *recorded = receipt;
        } else {
            // Defensive fallback: the seam is exclusively borrowed while a
            // send is in flight, so the provisional receipt cannot normally
            // disappear before the backend returns.
            self.record_receipt(receipt);
        }
    }

    fn remove_receipt(&mut self, delivery_id: &DeliveryId, route: &RouteId) {
        if let Some(index) = self
            .receipts
            .iter()
            .rposition(|receipt| &receipt.delivery_id == delivery_id && &receipt.route == route)
        {
            self.receipts.remove(index);
        }
    }
}
