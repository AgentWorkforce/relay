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
//! same answer from Relaycast is handled for a workspace key, with two
//! exceptions: a passed-through 403 never rejects the node credential (the
//! broker never passes Relaycast's 401 through, so a 403 judges the
//! workspace or the node, not the credential; [`rejects`]), and a
//! `409 node_name_conflict` is not answered with an alternate name, which
//! the credential is not bound to. The broker's two 403s are told apart from
//! Relaycast's by their code.
//!
//! [`KeyKind::NodeScoped`]: crate::relay::workspace::KeyKind::NodeScoped

use crate::relay::workspace::{KeyKind, NODE_BROKER_PREFIX, NODE_KEY_PREFIX};
use relaycast::{ClientOptions, RelayError};
use serde_json::Value;

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

/// Whether `error` is the broker's `status` answer with `code`, read from
/// the error's code alone: the envelope's `error.code`, or the flat
/// `{error,message}` a broker image older than relay-control 01614898 sends
/// (read into the code by [`broker_error`] and [`broker_data`]).
fn broker_answer(error: &RelayError, status: u16, code: &str) -> bool {
    error.status() == Some(status) && error.code() == Some(code)
}

/// `error` from an SDK call to a Control broker, with a flat
/// `{"error":"<code>","message":…}` body read into its code and message.
/// The SDK requires the envelope, so it reports such a body as
/// `invalid_response_body`, quoting it; this parses the quoted body as JSON
/// (never matches within it). Every other error is returned as it is.
///
/// For broker images older than relay-control 01614898, which send their
/// own errors flat; it goes once every deployed broker sends the envelope.
pub fn broker_error(error: RelayError) -> RelayError {
    let RelayError::Api {
        code,
        message,
        status,
        request_id,
        retry_after_ms,
        ..
    } = &error
    else {
        return error;
    };
    if code != "invalid_response_body" {
        return error;
    }
    let flat = message
        .split_once("; body: ")
        .and_then(|(_, body)| serde_json::from_str::<Value>(body).ok())
        .and_then(|json| flat_error(*status, &json, request_id.clone(), *retry_after_ms));
    flat.unwrap_or(error)
}

/// A flat `{"error":"<code>","message":…}` broker error, or `None` when
/// `json` is not one.
fn flat_error(
    status: u16,
    json: &Value,
    request_id: Option<String>,
    retry_after_ms: Option<u64>,
) -> Option<RelayError> {
    let code = json.get("error").and_then(Value::as_str)?;
    let message = json
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("Unknown error");
    Some(RelayError::Api {
        code: code.to_string(),
        message: message.to_string(),
        status,
        request_id,
        attempts: 1,
        retry_after_ms,
        details: Some(json.clone()),
    })
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

/// Whether `error` rejects a workspace credential of `kind`. A workspace
/// key: [`rejects_credential`]. A node-scoped credential: only a 401, the
/// broker's `token_invalid` (revoked or expired). The broker never passes
/// Relaycast's 401 through (it answers `502 relaycast_unavailable`), so any
/// 403 that reaches the node is Relaycast's judgement of the workspace (a
/// suspended one) or of node ownership, or the broker's own `scope_denied`
/// or `node_mismatch`: none says the node credential should be replaced.
pub fn rejects(kind: KeyKind, error: &RelayError) -> bool {
    match kind {
        KeyKind::Workspace => rejects_credential(error),
        KeyKind::NodeScoped => error.status() == Some(401),
    }
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

/// The data of the broker's answer to `GET /relay-node/v1/workspace`, read
/// from its `status` and raw `body`. The envelope comes first:
/// `{"ok":true,"data":…}` is the data, `{"ok":false,"error":{code,message}}`
/// the error, as the SDK reads them.
///
/// Broker images older than relay-control 01614898 answer this call with a
/// bare `{"id","name"}` and their own errors with a flat
/// `{"error":"<code>","message":…}`, neither of which the SDK can read (it
/// requires `ok`): a bare 2xx body is the data, and a flat error is the
/// error with that code. Both forms go once every deployed broker image
/// carries relay-control 01614898, which serves envelopes.
/// A body that is not JSON is the SDK's `invalid_response_body`, quoting it,
/// for an error status.
#[allow(clippy::result_large_err)] // the SDK's own error type
pub fn broker_data(
    status: u16,
    body: &[u8],
    request_id: Option<String>,
    retry_after_ms: Option<u64>,
) -> relaycast::Result<Value> {
    let failed = (400..=599).contains(&status);
    let api = |code: String, message: String, details: Option<Value>| RelayError::Api {
        code,
        message,
        status,
        request_id: request_id.clone(),
        attempts: 1,
        retry_after_ms,
        details,
    };
    if status == 204 {
        return Ok(Value::Null);
    }
    let json: Value = match serde_json::from_slice(body) {
        Ok(json) => json,
        Err(error) if failed => {
            return Err(api(
                "invalid_response_body".into(),
                format!(
                    "Server returned a non-JSON {status} response: {error}; body: {}",
                    body_summary(body)
                ),
                None,
            ))
        }
        Err(error) => return Err(error.into()),
    };
    let text = |value: Option<&Value>| value.and_then(Value::as_str).map(str::to_string);
    match json.get("ok").and_then(Value::as_bool) {
        // The envelope.
        Some(true) if !failed => json
            .get("data")
            .cloned()
            .ok_or_else(|| RelayError::InvalidResponse("Response missing data field".into())),
        Some(_) => {
            let error = json.get("error");
            Err(api(
                text(error.and_then(|error| error.get("code")))
                    .unwrap_or_else(|| "unknown_error".into()),
                text(error.and_then(|error| error.get("message")))
                    .unwrap_or_else(|| "Unknown error".into()),
                Some(json.clone()),
            ))
        }
        // Today's broker: a bare body, or a flat error.
        None if !failed => Ok(json),
        None => match flat_error(status, &json, request_id.clone(), retry_after_ms) {
            Some(error) => Err(error),
            None => Err(api(
                "invalid_response_body".into(),
                format!(
                    "Server returned an unreadable {status} response; body: {}",
                    body_summary(body)
                ),
                None,
            )),
        },
    }
}

/// `body` as the SDK quotes it in an error: control characters blanked,
/// at most 512 characters.
fn body_summary(body: &[u8]) -> String {
    let decoded = String::from_utf8_lossy(body);
    let mut characters = decoded.chars().map(|character| {
        if character.is_control() {
            ' '
        } else {
            character
        }
    });
    let summary: String = characters.by_ref().take(512).collect();
    let truncated = characters.next().is_some();
    match summary.trim() {
        "" => "<empty>".into(),
        summary if truncated => format!("{summary}…"),
        summary => summary.into(),
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
        // A quoted body is never searched for a code.
        let quoted = RelayError::api(
            "invalid_response_body",
            "Server returned a non-JSON 403 response: x; body: <p>\"scope_denied\"</p>",
            403,
        );
        assert!(!is_scope_denied(&quoted));
        assert!(!is_scope_denied(&broker_error(quoted)));
    }

    /// The SDK's report of a flat broker error, as a broker image older
    /// than relay-control 01614898 sends it.
    fn sdk_flat(status: u16, body: &str) -> RelayError {
        let parse = serde_json::from_str::<serde::de::IgnoredAny>("{").unwrap_err();
        RelayError::api(
            "invalid_response_body",
            format!("Server returned a non-JSON {status} response: {parse}; body: {body}"),
            status,
        )
    }

    /// A broker 403 is classified by its code, from the envelope or from a
    /// flat body, on the SDK path and on the workspace read alike.
    #[test]
    fn flat_and_envelope_broker_403s_classify_by_code() {
        for (code, is) in [
            (NODE_MISMATCH, is_node_mismatch as fn(&RelayError) -> bool),
            (SCOPE_DENIED, is_scope_denied),
        ] {
            let flat = format!(r#"{{"error":"{code}","message":"refused"}}"#);
            let envelope =
                format!(r#"{{"ok":false,"error":{{"code":"{code}","message":"refused"}}}}"#);
            let read = [
                broker_error(sdk_flat(403, &flat)),
                broker_data(403, flat.as_bytes(), None, None).unwrap_err(),
                broker_data(403, envelope.as_bytes(), None, None).unwrap_err(),
            ];
            for error in read {
                assert_eq!(error.code(), Some(code), "{error}");
                assert_eq!(error.status(), Some(403));
                assert!(is(&error), "{error}");
                assert!(!rejects(KeyKind::NodeScoped, &error));
                assert!(!rejects_credential(&error));
            }
        }
        // An SDK error that is not a flat body is kept as it is.
        let other = broker_error(api(409, "node_name_conflict"));
        assert_eq!(other.code(), Some("node_name_conflict"));
        let html = broker_error(sdk_flat(502, "<html>Bad Gateway</html>"));
        assert_eq!(html.code(), Some("invalid_response_body"));
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
        assert!(rejects_credential(&api(403, "workspace_suspended")));
        assert!(!rejects_credential(&api(429, "rate_limited")));
        assert!(!rejects_credential(&api(409, "node_name_conflict")));
    }

    /// A workspace key is rejected on Relaycast's 401 and 403, as today.
    #[test]
    fn a_workspace_key_is_rejected_by_a_suspended_workspace() {
        let kind = KeyKind::Workspace;
        assert!(rejects(kind, &api(401, "unauthorized")));
        assert!(rejects(kind, &api(403, "workspace_suspended")));
        assert!(rejects(kind, &api(403, "forbidden")));
        assert!(!rejects(kind, &api(403, SCOPE_DENIED)));
        assert!(!rejects(kind, &api(502, RELAYCAST_UNAVAILABLE)));
    }

    /// A node credential is rejected only by the broker's 401: a 403 the
    /// broker passes through judges the workspace or the node, not it.
    #[test]
    fn a_node_credential_is_rejected_only_by_token_invalid() {
        let kind = KeyKind::NodeScoped;
        assert!(rejects(kind, &api(401, TOKEN_INVALID)));
        assert!(!rejects(kind, &api(403, "workspace_suspended")));
        assert!(!rejects(kind, &api(403, "forbidden")));
        assert!(!rejects(kind, &api(403, SCOPE_DENIED)));
        assert!(!rejects(kind, &api(403, NODE_MISMATCH)));
        assert!(!rejects(kind, &api(502, RELAYCAST_UNAVAILABLE)));
        assert!(!rejects(kind, &api(409, "node_name_conflict")));
    }

    #[test]
    fn the_brokers_workspace_envelope_is_read() {
        let data = broker_data(
            200,
            br#"{"ok":true,"data":{"id":"rw_1","name":"One"}}"#,
            None,
            None,
        )
        .unwrap();
        assert_eq!(data, serde_json::json!({"id": "rw_1", "name": "One"}));
        let error = broker_data(
            403,
            br#"{"ok":false,"error":{"code":"node_mismatch","message":"name differs"}}"#,
            Some("req_1".into()),
            None,
        )
        .unwrap_err();
        assert!(is_node_mismatch(&error));
        assert_eq!(error.request_id(), Some("req_1"));
        let suspended = broker_data(
            403,
            br#"{"ok":false,"error":{"code":"workspace_suspended","message":"Suspended"}}"#,
            None,
            None,
        )
        .unwrap_err();
        assert_eq!(suspended.code(), Some("workspace_suspended"));
        assert_eq!(suspended.status(), Some(403));
    }

    /// Today's relay-control answers with a bare `{id,name}`.
    #[test]
    fn todays_bare_workspace_body_is_read() {
        let data = broker_data(200, br#"{"id":"rw_1","name":"One"}"#, None, None).unwrap();
        assert_eq!(data, serde_json::json!({"id": "rw_1", "name": "One"}));
    }

    /// Today's relay-control answers its own errors as a flat
    /// `{error,message}`.
    #[test]
    fn todays_flat_broker_error_is_read() {
        let error = broker_data(
            401,
            br#"{"error":"token_invalid","message":"Node credential revoked"}"#,
            None,
            Some(1_000),
        )
        .unwrap_err();
        assert_eq!(error.code(), Some(TOKEN_INVALID));
        assert_eq!(error.status(), Some(401));
        assert_eq!(error.retry_after_ms(), Some(1_000));
        assert!(rejects(KeyKind::NodeScoped, &error));
        let error = broker_data(
            502,
            br#"{"error":"relaycast_unavailable","message":"Relaycast unavailable"}"#,
            None,
            None,
        )
        .unwrap_err();
        assert_eq!(error.code(), Some(RELAYCAST_UNAVAILABLE));
        assert!(error.is_retryable());
        let error = broker_data(502, b"Bad Gateway", None, None).unwrap_err();
        assert_eq!(error.code(), Some("invalid_response_body"));
        assert_eq!(error.status(), Some(502));
        assert!(broker_data(200, b"not json", None, None).is_err());
        assert!(broker_data(200, br#"{"ok":true}"#, None, None).is_err());
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
