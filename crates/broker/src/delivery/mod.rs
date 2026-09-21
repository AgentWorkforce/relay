//! Delivery-backend seam for native transport migration.
//!
//! The broker still delivers through the PTY path in phase 0. This module
//! isolates the transport policy that future native backends must share:
//! fallback is only safe before a write commits, uncertain sends are never
//! retried, settlement stays bound to the route that accepted the send, and
//! acknowledgements are only reported after direct observation.

pub mod backend;
pub mod pty;

pub use backend::{
    DeliveryBackend, DeliveryBackendFuture, DeliveryError, DeliverySeam, HandoverState,
    ObservedAck, RouteId, SendOutcome, SendReceipt, SendRequest, SendStatus, SettleOutcome,
    SettleRequest, SettleStatus, TransportStatus,
};
