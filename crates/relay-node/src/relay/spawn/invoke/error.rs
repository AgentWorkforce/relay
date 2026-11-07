//! Persistent and wire representations of a terminal spawn failure.

use super::{lifecycle, wire, HarnessId, NodeLink, SpawnFailure, Value};
use chrono::Utc;

/// Why a spawn did not happen: a plain `error` string, or one of the agreed
/// codes with `error_details`.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub(in crate::relay::spawn) enum SpawnError {
    Plain(String),
    Failure(Box<SpawnFailure>),
}

impl From<String> for SpawnError {
    fn from(error: String) -> SpawnError {
        SpawnError::Plain(error)
    }
}

impl From<&str> for SpawnError {
    fn from(error: &str) -> SpawnError {
        SpawnError::Plain(error.to_string())
    }
}

impl SpawnError {
    /// The `action.result`, with details only where `link`'s Relaycast
    /// accepted them.
    pub(in crate::relay::spawn) fn result(&self, invocation_id: &str, link: &NodeLink) -> Value {
        match self {
            SpawnError::Plain(error) => wire::action_error(invocation_id, error),
            SpawnError::Failure(failure) => {
                wire::action_failure(invocation_id, failure, link.error_details)
            }
        }
    }

    pub(in crate::relay::spawn) fn redacted(self) -> Self {
        let redact = crate::relay::harness::diagnostics::redact;
        match self {
            Self::Plain(error) => Self::Plain(redact(&error)),
            Self::Failure(mut failure) => {
                failure.message = redact(&failure.message);
                Self::Failure(failure)
            }
        }
    }

    pub(in crate::relay::spawn) fn text(&self) -> String {
        match self {
            SpawnError::Plain(error) => error.clone(),
            SpawnError::Failure(failure) => format!("{}: {}", failure.code, failure.message),
        }
    }
}

/// A spawn refused for good with `code`: trying again here would fail too.
pub(super) fn refusal(
    link: &NodeLink,
    harness: HarnessId,
    code: &'static str,
    message: String,
) -> SpawnError {
    SpawnError::Failure(Box::new(SpawnFailure {
        code,
        message,
        node: link.node.node_name.clone(),
        harness: Some(harness),
        active: None,
        reserved: None,
        max: None,
        observed_at: lifecycle::iso(Utc::now()),
        retryable: false,
    }))
}
