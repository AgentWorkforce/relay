use std::collections::VecDeque;
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
}

impl SendOutcome {
    pub fn receipt(&self) -> &SendReceipt {
        match self {
            Self::Fresh(receipt) | Self::AlreadySent(receipt) => receipt,
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
}

impl DeliverySeam {
    const MAX_RECEIPTS: usize = 4096;

    pub fn new() -> Self {
        Self::default()
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
    pub async fn settle(
        &mut self,
        backends: &mut [&mut dyn DeliveryBackend],
        delivery_id: &DeliveryId,
    ) -> Option<SettleStatus> {
        let receipt = self
            .receipts
            .iter()
            .rev()
            .find(|receipt| &receipt.delivery_id == delivery_id)?;
        let route = receipt.route.clone();
        let request = SettleRequest {
            delivery_id: delivery_id.clone(),
            route: route.clone(),
        };
        let backend = backends
            .iter_mut()
            .find(|backend| backend.route_id() == route)?;
        Some(backend.settle(&request).await)
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
            self.receipts.pop_front();
        }
        self.receipts.push_back(receipt);
    }
}
