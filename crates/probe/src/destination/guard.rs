//! The destination guard every History upload passes before a bearer is
//! sent, and how delivery treats what it refuses.

use super::fail;
use crate::cloud;
use crate::delivery::DeliveryFailure;
use anyhow::Result;

/// [`cloud::require_history_destination`] for an upload. A name that did not
/// resolve is retried, since DNS recovers by itself; cleartext or a
/// non-public address blocks the job until a person acts.
pub(super) fn require_destination(base_url: &str) -> Result<()> {
    cloud::require_history_destination(base_url).map_err(|error| fail(refusal(&error)))
}

/// The same check inside the authenticated send: a name that stopped
/// resolving is a transient failure, not a missing sign-in.
pub(super) fn retry_unresolved(error: anyhow::Error) -> anyhow::Error {
    if is_unresolved(&error) {
        fail(DeliveryFailure::Transient)
    } else {
        error
    }
}

fn is_unresolved(error: &anyhow::Error) -> bool {
    error.is::<cloud::HistoryUnresolved>()
}

fn refusal(error: &anyhow::Error) -> DeliveryFailure {
    if is_unresolved(error) {
        DeliveryFailure::Transient
    } else {
        DeliveryFailure::PermissionDenied
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A History name that does not resolve leaves the batch retryable; only
    /// a refused destination blocks the job.
    #[test]
    fn an_unresolved_history_name_is_retried_and_a_refused_one_blocks() {
        assert_eq!(
            refusal(&cloud::HistoryUnresolved.into()),
            DeliveryFailure::Transient
        );
        assert_eq!(
            refusal(&anyhow::anyhow!("resolves to a private address")),
            DeliveryFailure::PermissionDenied
        );
        assert!(retry_unresolved(cloud::HistoryUnresolved.into())
            .downcast_ref::<super::super::TransportFailure>()
            .is_some_and(|failure| failure.0 == DeliveryFailure::Transient));
    }
}
