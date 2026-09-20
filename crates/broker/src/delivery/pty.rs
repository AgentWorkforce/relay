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
            route: RouteId::new("pty"),
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
