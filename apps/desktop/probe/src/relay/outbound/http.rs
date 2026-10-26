//! HTTP details of the session socket's answers.

/// The reason phrase for `status`.
pub(super) fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        409 => "Conflict",
        413 => "Payload Too Large",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        _ => "Error",
    }
}

use super::{
    read_request, write_error, write_response, CoreStream, Outbound, OutboundError, Purpose,
    Request, READ_TIMEOUT,
};
use serde_json::{json, Map, Value};
use std::sync::Arc;

pub(super) async fn connection(outbound: Arc<Outbound>, mut stream: CoreStream) {
    let request = match tokio::time::timeout(READ_TIMEOUT, read_request(&mut stream)).await {
        Err(_) | Ok(Ok(None)) => return,
        Ok(Err(error)) if error.code == "closed" => return,
        Ok(Err(error)) => {
            write_error(&mut stream, &error).await;
            return;
        }
        Ok(Ok(Some(request))) => request,
    };
    let peer = match stream.peer_credentials() {
        Ok(peer) => peer,
        Err(_) => {
            let error =
                OutboundError::new(403, "not_this_user", "The caller could not be identified.");
            write_error(&mut stream, &error).await;
            return;
        }
    };
    let Some(pid) = peer.pid else {
        write_error(&mut stream, &OutboundError::not_a_session()).await;
        return;
    };
    let Some(response) = outbound
        .handle_connection(pid, peer.uid, &request, &mut stream)
        .await
    else {
        return;
    };
    match response {
        Ok(data) => write_response(&mut stream, 200, &json!({"ok": true, "data": data})).await,
        Err(error) => write_error(&mut stream, &error).await,
    }
}

pub(super) fn payload(
    request: &Request,
    purpose: Purpose,
) -> Result<Map<String, Value>, OutboundError> {
    if matches!(purpose, Purpose::Send) && !request.query.is_empty() {
        let mut fields: Map<String, Value> = request
            .query
            .iter()
            .map(|(k, v)| (k.clone(), Value::String(v.clone())))
            .collect();
        fields.insert(
            "text".into(),
            Value::String(String::from_utf8_lossy(&request.body).into_owned()),
        );
        return Ok(fields);
    }
    let body: &[u8] = if request.body.iter().all(u8::is_ascii_whitespace) {
        b"{}"
    } else {
        &request.body
    };
    let value: Value = serde_json::from_slice(body).map_err(|_| {
        let message = match purpose {
            Purpose::Send => {
                "Send JSON {\"address\"|\"to\"|\"channel\", \"text\", optional \"files\"}, or a destination query with the text as the body."
            }
            Purpose::Register => "Send JSON with optional \"name\" and \"description\".",
            Purpose::Json => "Send a JSON object for this route.",
        };
        OutboundError::new(400, "invalid_json", message)
    })?;
    match value {
        Value::Object(fields) => Ok(fields),
        _ => Err(OutboundError::new(
            400,
            "invalid_json",
            "Send a JSON object.",
        )),
    }
}
