use std::collections::{HashSet, VecDeque};
use std::fmt;
use std::future::Future;
use std::pin::Pin;

use crate::ids::{DeliveryId, WorkerName};
use crate::protocol::RelayDelivery;

pub type DeliveryBackendFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Stable identifier for the transport route that accepted a send.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct RouteId(String);

impl RouteId {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
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

/// Acknowledgement evidence observed by the route that accepted the send.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObservedAck {
    pub detail: String,
}

impl ObservedAck {
    pub fn new(detail: impl Into<String>) -> Self {
        Self {
            detail: detail.into(),
        }
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
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SendReceipt {
    pub delivery_id: DeliveryId,
    pub route: RouteId,
    pub status: SendStatus,
}

impl SendReceipt {
    pub fn new(delivery_id: DeliveryId, route: RouteId, status: SendStatus) -> Self {
        Self {
            delivery_id,
            route,
            status,
        }
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

    /// Cancellation safety: this coordinator records a receipt only after a
    /// backend returns. If a caller cancels while `backend.send` is pending,
    /// the caller must conservatively treat the delivery as unresolved by that
    /// route and must not retry unless the backend reported a pre-write error.
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
            match backend.send(&request).await {
                Ok(SendStatus::Refused) => {
                    last_pre_write_error = Some(DeliveryError::unavailable(format!(
                        "route {route} refused before write"
                    )));
                }
                Ok(status) => {
                    let receipt = SendReceipt::new(request.delivery_id.clone(), route, status);
                    self.record_receipt(receipt.clone());
                    return Ok(SendOutcome::Fresh(receipt));
                }
                Err(error) if error.is_pre_write() => {
                    last_pre_write_error = Some(error);
                }
                Err(error) => {
                    let receipt =
                        SendReceipt::new(request.delivery_id.clone(), route, SendStatus::InDoubt);
                    self.record_receipt(receipt);
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
                // Sent, then forgotten by the bounded receipt memory. Not
                // absence.
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

    pub fn recorded_route(&self, delivery_id: &DeliveryId) -> Option<&RouteId> {
        self.receipts
            .iter()
            .rev()
            .find(|receipt| &receipt.delivery_id == delivery_id)
            .map(|receipt| &receipt.route)
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
}
