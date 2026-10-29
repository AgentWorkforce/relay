//! The uploader's health, and the telemetry code for a delivery failure.

use crate::relay::contract::account::DeliveryFailureCode;
use crate::relay::telemetry::TelemetryFailure;
use serde_json::Value;

/// The telemetry code for a delivery failure's allowlisted `failure_code`.
fn delivery_failure(code: &Value) -> TelemetryFailure {
    match serde_json::from_value(code.clone()) {
        Ok(DeliveryFailureCode::Transient) => TelemetryFailure::UploadTransient,
        Ok(DeliveryFailureCode::RateLimited) => TelemetryFailure::UploadRateLimited,
        Ok(DeliveryFailureCode::AuthenticationRequired) => {
            TelemetryFailure::UploadAuthenticationRequired
        }
        Ok(DeliveryFailureCode::PermissionDenied) => TelemetryFailure::UploadPermissionDenied,
        Ok(DeliveryFailureCode::InvalidPayload) => TelemetryFailure::UploadInvalidPayload,
        Ok(DeliveryFailureCode::ReceiverRejected) => TelemetryFailure::UploadReceiverRejected,
        Ok(DeliveryFailureCode::UnsupportedEvidence) => TelemetryFailure::UploadUnsupportedEvidence,
        Ok(DeliveryFailureCode::MappingVersionMismatch) => {
            TelemetryFailure::UploadMappingVersionMismatch
        }
        Ok(DeliveryFailureCode::DeliveryConflict) => TelemetryFailure::UploadDeliveryConflict,
        Err(_) => TelemetryFailure::UploadDelivery,
    }
}

/// A running, unpaused uploader's health: `Some(Some(failure))` while
/// delivery or its last cycle fails (an upgrade in progress is not a
/// failure) or its queue is `stalled`, `Some(None)` when healthy, `None`
/// when it is not uploading.
pub fn upload_health(status: &Value) -> Option<Option<TelemetryFailure>> {
    if status["running"] != Value::Bool(true) || status["paused"] == Value::Bool(true) {
        return None;
    }
    let failure = &status["delivery"]["failure"];
    let delivery_failed = !failure.is_null() && failure.as_str() != Some("");
    let cycle_failed = status["last_cycle"]["ok"] == Value::Bool(false)
        && status["upgrading"] != Value::Bool(true);
    Some(if delivery_failed {
        Some(delivery_failure(&status["delivery"]["failure_code"]))
    } else if cycle_failed {
        Some(TelemetryFailure::UploadCycle)
    } else if status["stalled"] == Value::Bool(true) {
        Some(TelemetryFailure::UploadStalled)
    } else {
        None
    })
}
