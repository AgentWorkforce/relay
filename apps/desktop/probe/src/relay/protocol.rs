//! The bridge wire format: JSON-RPC 2.0, one object per line (NDJSON).
//!
//! See `docs/relay-core.md` for the method and event catalogue. Everything a
//! client can observe is here: request and response envelopes, the event
//! notification, and the error model. Error messages are fixed, user-safe
//! sentences; provider bodies, keys and tokens never reach them.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The contract version. A client sends the version it speaks in `hello`;
/// the daemon refuses any other with `bridge_version_mismatch`.
pub const BRIDGE_VERSION: u32 = 2;

/// The longest line either side may send. A longer line closes the connection.
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;

/// The notification method every event travels under.
pub const EVENT_METHOD: &str = "event";

/// One request line from a client. Its `id` is read from the raw object,
/// where `null` and absent differ: absent makes the request a notification,
/// which the daemon executes without replying.
#[derive(Debug, Deserialize)]
pub struct Request {
    pub jsonrpc: String,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

/// One response line. Exactly one of `result` and `error` is present.
#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct Response {
    pub jsonrpc: String,
    pub id: Value,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub error: Option<RpcError>,
}

impl Response {
    pub fn ok(id: Value, result: Value) -> Response {
        Response {
            jsonrpc: "2.0".into(),
            id,
            result: Some(result),
            error: None,
        }
    }

    pub fn err(id: Value, error: RpcError) -> Response {
        Response {
            jsonrpc: "2.0".into(),
            id,
            result: None,
            error: Some(error),
        }
    }
}

/// An event pushed to a subscribed client:
/// `{"jsonrpc":"2.0","method":"event","params":{"topic":…,"seq":…,"data":…}}`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Event {
    pub topic: Topic,
    /// Increases by one per event across all topics, per daemon process; a
    /// client sees gaps for topics it is not subscribed to.
    pub seq: u64,
    pub data: Value,
}

impl Event {
    pub fn notification(&self) -> Value {
        serde_json::json!({"jsonrpc": "2.0", "method": EVENT_METHOD, "params": self})
    }
}

/// Event topics a client subscribes to; `contract::EVENTS` gives each its
/// payload.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Hash, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Topic {
    /// The full status snapshot, sent on subscribe and after every change.
    Status,
    /// Append-only activity lines for the UI's log.
    Activity,
    /// The daemon is stopping; the connection closes after this event.
    Shutdown,
    /// A collection changed: `{"what": "agents"|"roster"|…}`; re-fetch it.
    Invalidated,
    /// A notification for the UI to show: `{"title","body","link"}`.
    Notify,
    /// Sign-in progress: the account state, and the link to open.
    SignIn,
}

/// A JSON-RPC error object. `data.kind` is the stable, machine-readable code
/// clients branch on; `message` is safe to show a person.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, JsonSchema)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    pub data: ErrorData,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, JsonSchema)]
pub struct ErrorData {
    pub kind: ErrorKind,
    /// Whether repeating the same request later can succeed.
    pub retryable: bool,
}

/// Every error a method can return.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-fallback" = "internal"))]
pub enum ErrorKind {
    ParseError,
    InvalidRequest,
    MethodNotFound,
    InvalidParams,
    /// A method other than `hello` arrived before the handshake.
    HandshakeRequired,
    BridgeVersionMismatch,
    /// No workspace key is known.
    NotSignedIn,
    /// A value the daemon refuses on principle (for example a non-https origin).
    Refused,
    /// Relaycast could not be reached, or failed on its side (5xx).
    RelaycastUnreachable,
    /// Relaycast refused the request as made (a 4xx other than those below);
    /// repeating it unchanged cannot succeed.
    RelaycastRefused,
    /// Relaycast rejected the credential.
    Unauthorized,
    RateLimited,
    /// Relaycast, or this computer, has no such resource.
    NotFound,
    Conflict,
    ShuttingDown,
    /// Another change to the same agent or session is still running.
    Busy,
    /// The agent store could not be saved; nothing was changed.
    StoreFailed,
    /// Agent Relay Cloud could not be reached or failed; worth retrying.
    CloudFailed,
    /// Agent Relay Cloud refused the request; repeating it will not help.
    CloudRefused,
    /// Whether this computer's relay already manages a session could not
    /// be read, so it is not given a second identity now.
    FleetUnavailable,
    /// The probe's uploader command failed; `message` is its own sentence.
    UploaderFailed,
    Internal,
}

impl ErrorKind {
    /// The JSON-RPC numeric code: the reserved range for protocol errors,
    /// `-32000` for everything the daemon itself decides.
    pub fn code(self) -> i64 {
        match self {
            ErrorKind::ParseError => -32700,
            ErrorKind::InvalidRequest => -32600,
            ErrorKind::MethodNotFound => -32601,
            ErrorKind::InvalidParams => -32602,
            ErrorKind::Internal => -32603,
            _ => -32000,
        }
    }

    pub fn retryable(self) -> bool {
        matches!(
            self,
            ErrorKind::RelaycastUnreachable
                | ErrorKind::RateLimited
                | ErrorKind::ShuttingDown
                | ErrorKind::Busy
                | ErrorKind::CloudFailed
                | ErrorKind::FleetUnavailable
        )
    }
}

impl RpcError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> RpcError {
        RpcError {
            code: kind.code(),
            message: message.into(),
            data: ErrorData {
                kind,
                retryable: kind.retryable(),
            },
        }
    }

    pub fn invalid_params(message: impl Into<String>) -> RpcError {
        RpcError::new(ErrorKind::InvalidParams, message)
    }

    pub fn store(error: &crate::relay::store::StoreError) -> RpcError {
        RpcError::new(ErrorKind::StoreFailed, error.to_string())
    }

    pub fn cloud(error: &crate::relay::cloud_session::CloudError) -> RpcError {
        use crate::relay::cloud_session::CloudError;
        let kind = match error {
            CloudError::SignedOut | CloudError::Rejected => ErrorKind::NotSignedIn,
            CloudError::Status { status, .. } if (400..500).contains(status) && *status != 429 => {
                ErrorKind::CloudRefused
            }
            CloudError::Status { .. } | CloudError::Unreachable => ErrorKind::CloudFailed,
        };
        RpcError::new(kind, error.to_string())
    }

    /// Maps an SDK failure to a safe error. The SDK's own message can carry a
    /// response body, so it is never forwarded.
    pub fn from_relaycast(error: &relaycast::RelayError) -> RpcError {
        match error {
            // A billing-period quota is also HTTP 429, but immediate retries
            // cannot recover it like a short-lived request-rate limit.
            relaycast::RelayError::Api { code, .. } if code == "plan_limit_exceeded" => {
                RpcError::new(
                    ErrorKind::RelaycastRefused,
                    "This Agent Relay workspace has reached its plan limit. Upgrade its plan or wait for the quota to reset, then try again.",
                )
            }
            error if error.is_auth_rejection() => RpcError::new(
                ErrorKind::Unauthorized,
                "Agent Relay rejected the workspace credential.",
            ),
            error if error.is_rate_limited() => RpcError::new(
                ErrorKind::RateLimited,
                "Agent Relay is rate limiting requests.",
            ),
            error if error.is_not_found() => {
                RpcError::new(ErrorKind::NotFound, "Agent Relay has no such resource.")
            }
            error if error.is_conflict() => RpcError::new(
                ErrorKind::Conflict,
                "Agent Relay reported a conflicting change.",
            ),
            relaycast::RelayError::Api { status, .. } if (400..500).contains(status) => {
                RpcError::new(
                    ErrorKind::RelaycastRefused,
                    "Agent Relay refused the request.",
                )
            }
            relaycast::RelayError::Api { .. } => RpcError::new(
                ErrorKind::RelaycastUnreachable,
                "Agent Relay could not complete the request.",
            ),
            relaycast::RelayError::Http(_)
            | relaycast::RelayError::WebSocket(_)
            | relaycast::RelayError::NotConnected => RpcError::new(
                ErrorKind::RelaycastUnreachable,
                "Agent Relay could not be reached.",
            ),
            // A response the SDK could not read, or an origin it could not
            // parse, does not change on retry.
            relaycast::RelayError::Json(_)
            | relaycast::RelayError::InvalidResponse(_)
            | relaycast::RelayError::Url(_) => RpcError::new(
                ErrorKind::Internal,
                "Agent Relay sent a response this core could not read.",
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn errors_carry_a_stable_kind_and_json_rpc_code() {
        let error = RpcError::new(ErrorKind::MethodNotFound, "No such method.");
        let value = serde_json::to_value(Response::err(json!(7), error)).unwrap();
        assert_eq!(
            value,
            json!({"jsonrpc":"2.0","id":7,"error":{"code":-32601,"message":"No such method.","data":{"kind":"method_not_found","retryable":false}}})
        );
    }

    #[test]
    fn events_are_json_rpc_notifications() {
        let event = Event {
            topic: Topic::Status,
            seq: 3,
            data: json!({"revision": 1}),
        };
        assert_eq!(
            event.notification(),
            json!({"jsonrpc":"2.0","method":"event","params":{"topic":"status","seq":3,"data":{"revision":1}}})
        );
    }

    #[test]
    fn only_cloud_failures_that_can_pass_are_retryable() {
        use crate::relay::cloud_session::CloudError;
        let refused = RpcError::cloud(&CloudError::Status {
            status: 403,
            message: None,
        });
        assert_eq!(refused.data.kind, ErrorKind::CloudRefused);
        assert!(!refused.data.retryable);
        let busy = RpcError::cloud(&CloudError::Status {
            status: 503,
            message: None,
        });
        assert!(busy.data.retryable);
        assert!(
            RpcError::cloud(&CloudError::Status {
                status: 429,
                message: None
            })
            .data
            .retryable
        );
        assert_eq!(
            RpcError::cloud(&CloudError::Rejected).data.kind,
            ErrorKind::NotSignedIn
        );
    }

    #[test]
    fn relaycast_failures_never_forward_the_provider_message() {
        let error = relaycast::RelayError::api("bad_key", "key rk_live_secret is revoked", 401);
        let mapped = RpcError::from_relaycast(&error);
        assert_eq!(mapped.data.kind, ErrorKind::Unauthorized);
        assert!(!mapped.message.contains("rk_live_"));
        let server = relaycast::RelayError::api("oops", "stack trace", 503);
        assert!(RpcError::from_relaycast(&server).data.retryable);
    }

    #[test]
    fn plan_quota_is_actionable_and_not_transient_throttling() {
        let error =
            relaycast::RelayError::api("plan_limit_exceeded", "private body rk_live_secret", 429);
        let mapped = RpcError::from_relaycast(&error);
        assert_eq!(mapped.data.kind, ErrorKind::RelaycastRefused);
        assert!(!mapped.data.retryable);
        assert_eq!(mapped.message, "This Agent Relay workspace has reached its plan limit. Upgrade its plan or wait for the quota to reset, then try again.");
        assert!(!mapped.message.contains("rk_live_secret"));

        let transient = RpcError::from_relaycast(&relaycast::RelayError::api(
            "rate_limit_exceeded",
            "private body",
            429,
        ));
        assert_eq!(transient.data.kind, ErrorKind::RateLimited);
        assert!(transient.data.retryable);
    }

    #[test]
    fn a_request_relaycast_refuses_is_not_retryable() {
        for status in [400, 422] {
            let error = relaycast::RelayError::api("invalid", "bad metadata", status);
            let mapped = RpcError::from_relaycast(&error);
            assert_eq!(mapped.data.kind, ErrorKind::RelaycastRefused, "{status}");
            assert!(!mapped.data.retryable, "{status}");
        }
        let unreadable = relaycast::RelayError::InvalidResponse("<html>".into());
        let mapped = RpcError::from_relaycast(&unreadable);
        assert_eq!(mapped.data.kind, ErrorKind::Internal);
        assert!(!mapped.data.retryable);
    }
}
