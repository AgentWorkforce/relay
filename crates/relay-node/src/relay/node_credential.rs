//! A node-scoped workspace credential (`sh_wk_…`, [`KeyKind::NodeScoped`])
//! is bound to one node name and never goes to Relaycast. Control brokers the
//! few workspace-key calls a node needs at `<control_url>/relay-node/v1/…`
//! (workspace identity, node lookup and enrolment, agent lookup); every
//! other workspace-key call is unavailable with it.
//!
//! The broker's answers that are not Relaycast's own, matched by status
//! first and code second:
//! - `401 token_invalid`: the credential is revoked or expired, so the
//!   workspace is rejected like a refused workspace key.
//! - `403 scope_denied`: the call is not brokered. Unavailable, and the
//!   credential is not rejected.
//! - `403 node_mismatch`: the credential belongs to another node name; the
//!   node does not start.
//! - `502 relaycast_unavailable`: Relaycast could not be reached, or answered
//!   401 to the workspace key Control stores; retried like a Relaycast outage.
//!
//! Every other answer is Relaycast's, passed through with its status and
//! body (404, 409, 429 with its `Retry-After`, 5xx, and a 403 such as a
//! suspended workspace or a node another owner holds), and is handled as the
//! same answer from Relaycast is handled for a workspace key. The broker's
//! two 403s are told apart from Relaycast's by their code.
//!
//! [`KeyKind::NodeScoped`]: crate::relay::workspace::KeyKind::NodeScoped

use crate::relay::workspace::{NODE_BROKER_PREFIX, NODE_KEY_PREFIX};
use relaycast::{ClientOptions, RelayError};

/// Why a workspace-key call is not made with a node-scoped credential.
pub const UNAVAILABLE: &str = "Not available with a node credential.";
/// The broker's code for a call it does not broker.
pub const SCOPE_DENIED: &str = "scope_denied";
/// The broker's code for a credential bound to another node name.
pub const NODE_MISMATCH: &str = "node_mismatch";
/// The broker's code for a revoked or expired credential.
pub const TOKEN_INVALID: &str = "token_invalid";
/// The broker's code when Relaycast could not be reached or refused it.
pub const RELAYCAST_UNAVAILABLE: &str = "relaycast_unavailable";

/// The error a workspace-key call answers with when it is not available with
/// a node-scoped credential: the broker's own `403 scope_denied`.
pub fn unavailable() -> RelayError {
    RelayError::api(SCOPE_DENIED, UNAVAILABLE, 403)
}

/// Whether `error` is the broker's `status` answer with `code`. The code is
/// read from the Relaycast error envelope or, when the body was not one,
/// from the body the SDK quoted.
fn broker_answer(error: &RelayError, status: u16, code: &str) -> bool {
    match error {
        RelayError::Api {
            status: actual,
            code: actual_code,
            message,
            ..
        } if *actual == status => {
            actual_code == code
                || (actual_code == "invalid_response_body"
                    && message.contains(&format!("\"{code}\"")))
        }
        _ => false,
    }
}

/// `403 scope_denied`: the call is not available with a node credential.
pub fn is_scope_denied(error: &RelayError) -> bool {
    broker_answer(error, 403, SCOPE_DENIED)
}

/// `403 node_mismatch`: the node credential belongs to another node name.
pub fn is_node_mismatch(error: &RelayError) -> bool {
    broker_answer(error, 403, NODE_MISMATCH)
}

/// Whether `error` rejects the credential itself (a refused workspace key, a
/// revoked or expired node credential): an auth rejection that is neither a
/// call outside the node credential's scope nor a node-name mismatch. Use it
/// wherever [`RelayError::is_auth_rejection`] would mark the workspace
/// rejected or start a key recovery.
pub fn rejects_credential(error: &RelayError) -> bool {
    error.is_auth_rejection() && !is_scope_denied(error) && !is_node_mismatch(error)
}

/// Refuses to build a client that would send a node-scoped credential
/// anywhere but a Control broker (`…/relay-node`): such a call is not
/// available, and the credential never reaches Relaycast.
#[allow(clippy::result_large_err)] // the SDK's own error type
pub fn check_destination(options: &ClientOptions) -> relaycast::Result<()> {
    if !options.api_key.trim_start().starts_with(NODE_KEY_PREFIX) {
        return Ok(());
    }
    let brokered = options
        .base_url
        .as_deref()
        .is_some_and(|base| base.trim_end_matches('/').ends_with(NODE_BROKER_PREFIX));
    if brokered {
        Ok(())
    } else {
        Err(unavailable())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn api(status: u16, code: &str) -> RelayError {
        RelayError::api(code, "synthetic", status)
    }

    #[test]
    fn broker_answers_are_matched_by_status_then_code() {
        assert!(is_scope_denied(&api(403, SCOPE_DENIED)));
        assert!(!is_scope_denied(&api(401, SCOPE_DENIED)));
        assert!(is_node_mismatch(&api(403, NODE_MISMATCH)));
        assert!(!is_node_mismatch(&api(409, NODE_MISMATCH)));
        let quoted = RelayError::api(
            "invalid_response_body",
            "Server returned a non-JSON 403 response: x; body: {\"code\":\"scope_denied\"}",
            403,
        );
        assert!(is_scope_denied(&quoted));
    }

    #[test]
    fn only_a_credential_rejection_rejects_the_credential() {
        assert!(rejects_credential(&api(401, TOKEN_INVALID)));
        assert!(rejects_credential(&api(403, "forbidden")));
        assert!(!rejects_credential(&api(403, SCOPE_DENIED)));
        assert!(!rejects_credential(&api(403, NODE_MISMATCH)));
        assert!(!rejects_credential(&api(502, RELAYCAST_UNAVAILABLE)));
        assert!(api(502, RELAYCAST_UNAVAILABLE).is_retryable());
        assert!(!rejects_credential(&unavailable()));
        // A Relaycast 403 the broker passes through is handled as Relaycast's.
        assert!(rejects_credential(&api(403, "workspace_suspended")));
        assert!(!rejects_credential(&api(429, "rate_limited")));
        assert!(!rejects_credential(&api(409, "node_name_conflict")));
    }

    #[test]
    fn a_node_credential_goes_only_to_a_broker() {
        let node = format!("{NODE_KEY_PREFIX}synthetic0001");
        let to = |base: &str| ClientOptions::new(node.clone()).with_base_url(base);
        assert!(check_destination(&to("https://control.test/relay-node")).is_ok());
        assert!(check_destination(&to("https://control.test/relay-node/")).is_ok());
        assert!(is_scope_denied(
            &check_destination(&to("https://cast.test")).unwrap_err()
        ));
        assert!(check_destination(&ClientOptions::new(node)).is_err());
        let workspace = ClientOptions::new("rk_live_synthetic").with_base_url("https://cast.test");
        assert!(check_destination(&workspace).is_ok());
    }
}
