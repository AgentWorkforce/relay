use super::*;

pub(crate) async fn send_error(
    tx: &mpsc::Sender<ProtocolEnvelope<Value>>,
    request_id: Option<String>,
    code: &str,
    message: String,
    retryable: bool,
    data: Option<Value>,
) -> Result<()> {
    send_frame(
        tx,
        "error",
        request_id,
        json!({
            "code": code,
            "message": message,
            "retryable": retryable,
            "data": data,
        }),
    )
    .await
}

pub(crate) async fn send_event(
    tx: &mpsc::Sender<ProtocolEnvelope<Value>>,
    payload: Value,
) -> Result<()> {
    send_frame(tx, "event", None, payload).await
}

pub(crate) async fn emit_http_api_event_with_timeout(
    tx: &mpsc::Sender<ProtocolEnvelope<Value>>,
    payload: Value,
    timeout_window: Duration,
) {
    match timeout(timeout_window, send_event(tx, payload)).await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            tracing::warn!(
                target = "relay_broker::http_api",
                error = %error,
                "failed to enqueue HTTP API event"
            );
        }
        Err(_) => {
            tracing::warn!(
                target = "relay_broker::http_api",
                timeout_ms = %timeout_window.as_millis(),
                "timed out enqueuing HTTP API event"
            );
        }
    }
}

pub(crate) async fn send_frame(
    tx: &mpsc::Sender<ProtocolEnvelope<Value>>,
    msg_type: &str,
    request_id: Option<String>,
    payload: Value,
) -> Result<()> {
    tx.send(ProtocolEnvelope {
        v: PROTOCOL_VERSION,
        msg_type: msg_type.to_string(),
        request_id,
        payload,
    })
    .await
    .context("failed to enqueue outbound frame")
}
