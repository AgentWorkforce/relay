use super::*;

#[derive(Debug, Clone)]
struct AppServerAuthConfig {
    auth_type: String,
    token: Option<String>,
    username: Option<String>,
    password: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
enum OpenCodeModelOutcome {
    Applied(String),
    /// The mutation was accepted, but confirmation could not be observed.
    /// Keep the broker receipt pending until a subsequent provider response
    /// (this worker retries the confirmation read on
    /// `CONFIRMATION_RETRY_INTERVAL` and emits that subsequent response when
    /// a retry resolves it) or the broker's deadline; an unavailable GET is
    /// not proof that the provider rejected the change.
    Pending(String),
    Rejected(String),
}

const APP_SERVER_HTTP_TIMEOUT: Duration = Duration::from_secs(30);

/// How often a parked `accepted_pending` model request retries its provider
/// confirmation read while the worker waits for further frames.
const CONFIRMATION_RETRY_INTERVAL: Duration = Duration::from_secs(2);

pub(crate) async fn run_headless_app_server_worker(cmd: HeadlessAppServerCommand) -> Result<()> {
    run_app_server_worker_with_io(cmd, tokio::io::stdin(), tokio::io::stdout()).await
}

/// IO-injected core of the headless AppServer worker so the frame loop —
/// including the parked-confirmation retry — is testable against duplex
/// streams instead of the process's real stdin/stdout.
async fn run_app_server_worker_with_io<R, W>(
    cmd: HeadlessAppServerCommand,
    read: R,
    write: W,
) -> Result<()>
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
    W: tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let protocol = cmd.protocol.trim().to_ascii_lowercase();
    let endpoint = cmd.endpoint.trim().trim_end_matches('/').to_string();
    let session_id = cmd.session_id.clone();
    let host_pid = cmd.host_pid;
    let release = cmd.release.trim().to_ascii_lowercase();
    let auth = app_server_auth_from_env();
    let http = reqwest::Client::builder()
        .timeout(APP_SERVER_HTTP_TIMEOUT)
        .build()
        .context("failed to build app-server HTTP client")?;

    let (out_tx, mut out_rx) = mpsc::channel::<ProtocolEnvelope<Value>>(512);
    let writer_task = tokio::spawn(async move {
        let mut stdout = write;
        while let Some(frame) = out_rx.recv().await {
            if let Ok(mut line) = serde_json::to_string(&frame) {
                line.push('\n');
                if stdout.write_all(line.as_bytes()).await.is_err() || stdout.flush().await.is_err()
                {
                    break;
                }
            }
        }
    });

    let mut lines = BufReader::new(read).lines();
    // A start acknowledgement is an internal handshake. Frames for other
    // operations may already be queued behind set_model; retain them while
    // waiting so the handshake cannot silently lose ordered work.
    let mut deferred_frames = std::collections::VecDeque::new();
    let mut worker_name = cmd
        .agent_name
        .clone()
        .unwrap_or_else(|| format!("app-server-{protocol}"));
    let mut final_exit_code: Option<i32> = None;
    let final_exit_signal: Option<String> = None;
    // A successful provider mutation whose confirmation read was unavailable
    // stays parked here so the worker keeps retrying the confirmation read
    // while it waits for further frames. Each terminal retry outcome is
    // emitted as the documented subsequent `set_model_response`, letting the
    // broker resolve the retained `accepted_pending` receipt instead of
    // waiting for its deadline to convert uncertainty into a false rejection.
    let mut pending_confirmation: Option<(Option<RequestId>, String)> = None;
    let mut confirmation_retry = tokio::time::interval(CONFIRMATION_RETRY_INTERVAL);
    confirmation_retry.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    confirmation_retry.reset();

    loop {
        let frame: ProtocolEnvelope<Value> = if let Some(frame) = deferred_frames.pop_front() {
            frame
        } else {
            let line = if pending_confirmation.is_some() {
                tokio::select! {
                    line = lines.next_line() => match line {
                        Ok(Some(line)) => line,
                        Ok(None) | Err(_) => break,
                    },
                    _ = confirmation_retry.tick() => {
                        if let Some((request_id, requested_model)) = pending_confirmation.take() {
                            let outcome = confirm_opencode_model(
                                &http,
                                &endpoint,
                                &session_id,
                                &requested_model,
                                auth.as_ref(),
                            )
                            .await;
                            let resolved = match outcome {
                                Ok(OpenCodeModelOutcome::Applied(effective_model)) => {
                                    let _ = send_frame(
                                        &out_tx,
                                        "set_model_response",
                                        request_id.clone(),
                                        json!({
                                            "status": "applied",
                                            "applied": true,
                                            "effective_model": effective_model,
                                        }),
                                    )
                                    .await;
                                    true
                                }
                                Ok(OpenCodeModelOutcome::Rejected(error)) => {
                                    let _ = send_frame(
                                        &out_tx,
                                        "set_model_response",
                                        request_id.clone(),
                                        json!({
                                            "status": "rejected",
                                            "applied": false,
                                            "effective_model": null,
                                            "error": error,
                                        }),
                                    )
                                    .await;
                                    true
                                }
                                // Confirmation is still unavailable; keep the
                                // request parked for the next retry tick.
                                Ok(OpenCodeModelOutcome::Pending(_)) | Err(_) => false,
                            };
                            if !resolved {
                                pending_confirmation = Some((request_id, requested_model));
                            }
                        }
                        continue;
                    }
                }
            } else {
                match lines.next_line().await {
                    Ok(Some(line)) => line,
                    Ok(None) | Err(_) => break,
                }
            };
            match serde_json::from_str(&line) {
                Ok(frame) => frame,
                Err(error) => {
                    let _ =
                        send_frame(&out_tx, "worker_error", None, invalid_frame_payload(&error))
                            .await;
                    continue;
                }
            }
        };

        match frame.msg_type.as_str() {
            "init_worker" => {
                worker_name = cmd
                    .agent_name
                    .clone()
                    .or_else(|| {
                        frame
                            .payload
                            .get("agent")
                            .and_then(|a| a.get("name"))
                            .and_then(Value::as_str)
                            .map(ToOwned::to_owned)
                    })
                    .unwrap_or_else(|| format!("app-server-{protocol}"));

                let _ = send_frame(
                    &out_tx,
                    "worker_ready",
                    frame.request_id,
                    json!({
                        "name": &worker_name,
                        "runtime": "headless",
                        "driver": "app_server",
                        "sessionId": &session_id,
                        "pid": host_pid,
                    }),
                )
                .await;
            }
            "deliver_relay" => {
                let request_id = frame.request_id.clone();
                let delivery: RelayDelivery = match serde_json::from_value(frame.payload) {
                    Ok(d) => d,
                    Err(error) => {
                        let _ = send_frame(
                            &out_tx,
                            "worker_error",
                            request_id,
                            json!({
                                "code":"invalid_delivery",
                                "message": error.to_string(),
                                "retryable": false,
                            }),
                        )
                        .await;
                        continue;
                    }
                };

                let timestamp = chrono::Utc::now().timestamp_millis();
                let delivery_id = delivery.delivery_id.clone();
                let event_id = delivery.event_id.clone();
                let text = format_app_server_delivery(&delivery);

                let _ = send_frame(
                    &out_tx,
                    "delivery_queued",
                    None,
                    json!({
                        "delivery_id": &delivery_id,
                        "event_id": &event_id,
                        "agent": &worker_name,
                        "timestamp": timestamp,
                    }),
                )
                .await;

                let result = match protocol.as_str() {
                    "opencode" => {
                        send_opencode_prompt(&http, &endpoint, &session_id, &text, auth.as_ref())
                            .await
                    }
                    other => Err(anyhow::anyhow!(
                        "unsupported app_server protocol '{other}' (supported: opencode)"
                    )),
                };

                match result {
                    Ok(()) => {
                        let _ = send_frame(
                            &out_tx,
                            "delivery_injected",
                            None,
                            json!({
                                "delivery_id": &delivery_id,
                                "event_id": &event_id,
                                "agent": &worker_name,
                                "timestamp": chrono::Utc::now().timestamp_millis(),
                            }),
                        )
                        .await;
                        let _ = send_frame(
                            &out_tx,
                            "delivery_ack",
                            request_id.clone(),
                            json!({
                                "delivery_id": &delivery_id,
                                "event_id": &event_id,
                            }),
                        )
                        .await;
                    }
                    Err(error) => {
                        let reason = error.to_string();
                        let _ = send_frame(
                            &out_tx,
                            "delivery_failed",
                            None,
                            json!({
                                "delivery_id": &delivery_id,
                                "event_id": &event_id,
                                "reason": reason,
                            }),
                        )
                        .await;
                        let _ = send_frame(
                            &out_tx,
                            "worker_error",
                            request_id,
                            json!({
                                "code":"app_server_delivery_failed",
                                "message": error.to_string(),
                                "retryable": false,
                            }),
                        )
                        .await;
                    }
                }
            }
            "set_model" => {
                let requested_model = frame
                    .payload
                    .get("model")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let queue_expired = frame
                    .payload
                    .get("queue_deadline_ms")
                    .and_then(Value::as_u64)
                    .is_some_and(|deadline| {
                        std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis()
                            >= u128::from(deadline)
                    });
                if queue_expired {
                    let _ = send_frame(
                        &out_tx,
                        "set_model_response",
                        frame.request_id,
                        json!({
                            "status": "rejected",
                            "applied": false,
                            "effective_model": null,
                            "error": "model request expired before provider execution",
                        }),
                    )
                    .await;
                    continue;
                }
                // Tell the broker when this frame leaves the worker queue so
                // the provider deadline does not consume time spent behind a
                // long-running delivery.
                let _ = send_frame(
                    &out_tx,
                    "set_model_started",
                    frame.request_id.clone(),
                    json!({}),
                )
                .await;
                let ack_timeout = model_start_ack_timeout(&frame.payload);
                let start_acknowledged = tokio::time::timeout(ack_timeout, async {
                    loop {
                        let Some(line) = lines.next_line().await? else {
                            return Ok::<bool, std::io::Error>(false);
                        };
                        let ack = match serde_json::from_str::<ProtocolEnvelope<Value>>(&line) {
                            Ok(ack) => ack,
                            Err(error) => {
                                let _ = send_frame(
                                    &out_tx,
                                    "worker_error",
                                    None,
                                    invalid_frame_payload(&error),
                                )
                                .await;
                                continue;
                            }
                        };
                        if model_start_acknowledged(ack, &frame.request_id, &mut deferred_frames) {
                            return Ok(true);
                        }
                    }
                })
                .await
                .ok()
                .and_then(Result::ok)
                .unwrap_or(false);
                if !start_acknowledged {
                    let _ = send_frame(
                        &out_tx,
                        "set_model_response",
                        frame.request_id,
                        json!({
                            "status": "rejected",
                            "applied": false,
                            "effective_model": null,
                            "error": "broker did not acknowledge model start",
                        }),
                    )
                    .await;
                    continue;
                }
                // A new model request supersedes any parked confirmation
                // retry; the broker admits one mutation per worker, but a
                // defensive clear keeps the retry from resolving a stale
                // request.
                pending_confirmation = None;
                let result = match protocol.as_str() {
                    "opencode" => {
                        set_opencode_model(
                            &http,
                            &endpoint,
                            &session_id,
                            requested_model,
                            auth.as_ref(),
                        )
                        .await
                    }
                    other => Err(anyhow::anyhow!(
                        "app-server protocol '{other}' does not expose typed model mutation"
                    )),
                };
                // Park the confirmation retry before the response is emitted:
                // `accepted_pending` from an OpenCode mutation means the
                // provider accepted the request but its confirmation read was
                // unavailable, so the worker owes the broker a subsequent
                // response once a retry read resolves it.
                if matches!(result, Ok(OpenCodeModelOutcome::Pending(_)))
                    && protocol.as_str() == "opencode"
                {
                    pending_confirmation =
                        Some((frame.request_id.clone(), requested_model.to_string()));
                }
                let response = match result {
                    Ok(OpenCodeModelOutcome::Applied(effective_model)) => json!({
                        "status": "applied",
                        "applied": true,
                        "effective_model": effective_model,
                    }),
                    Ok(OpenCodeModelOutcome::Pending(error)) => json!({
                        "status": "accepted_pending",
                        "applied": false,
                        "effective_model": null,
                        "error": error,
                    }),
                    Ok(OpenCodeModelOutcome::Rejected(error)) => json!({
                        "status": "rejected",
                        "applied": false,
                        "effective_model": null,
                        "error": error,
                    }),
                    Err(error) => json!({
                        "status": "rejected",
                        "applied": false,
                        "effective_model": null,
                        "error": error.to_string(),
                    }),
                };
                let _ = send_frame(&out_tx, "set_model_response", frame.request_id, response).await;
            }
            "ping" => {
                let ts = frame
                    .payload
                    .get("ts_ms")
                    .and_then(Value::as_u64)
                    .unwrap_or_default();
                let _ = send_frame(&out_tx, "pong", frame.request_id, json!({"ts_ms": ts})).await;
            }
            "shutdown_worker" => {
                if let Err(error) = release_app_server(
                    &http,
                    &protocol,
                    &endpoint,
                    &session_id,
                    &release,
                    auth.as_ref(),
                )
                .await
                {
                    final_exit_code = Some(1);
                    let _ = send_frame(
                        &out_tx,
                        "worker_error",
                        frame.request_id,
                        json!({
                            "code":"app_server_release_failed",
                            "message": error.to_string(),
                            "retryable": false,
                        }),
                    )
                    .await;
                }
                break;
            }
            other => {
                let _ = send_frame(
                    &out_tx,
                    "worker_error",
                    frame.request_id,
                    json!({
                        "code":"unknown_type",
                        "message": format!("unsupported message type '{}'", other),
                        "retryable": false,
                    }),
                )
                .await;
            }
        }
    }

    let _ = send_frame(
        &out_tx,
        "worker_exited",
        None,
        json!({"code": final_exit_code, "signal": final_exit_signal}),
    )
    .await;
    drop(out_tx);
    let _ = writer_task.await;

    Ok(())
}

fn model_start_acknowledged(
    frame: ProtocolEnvelope<Value>,
    request_id: &Option<RequestId>,
    deferred_frames: &mut std::collections::VecDeque<ProtocolEnvelope<Value>>,
) -> bool {
    if frame.msg_type == "set_model_started_ack" && frame.request_id.as_ref() == request_id.as_ref()
    {
        true
    } else {
        deferred_frames.push_back(frame);
        false
    }
}

fn model_start_ack_timeout(payload: &Value) -> Duration {
    payload
        .get("provider_timeout_ms")
        .and_then(Value::as_u64)
        .map(Duration::from_millis)
        .filter(|timeout| !timeout.is_zero())
        .unwrap_or_else(|| Duration::from_secs(5))
}

fn invalid_frame_payload(error: &serde_json::Error) -> Value {
    json!({
        "code":"invalid_frame",
        "message": error.to_string(),
        "retryable": false,
    })
}

fn app_server_auth_from_env() -> Option<AppServerAuthConfig> {
    let auth_type = std::env::var("AGENT_RELAY_APP_SERVER_AUTH_TYPE").ok()?;
    let normalized = auth_type.trim().to_ascii_lowercase();
    if normalized.is_empty() || normalized == "none" {
        return None;
    }

    Some(AppServerAuthConfig {
        auth_type: normalized,
        token: std::env::var("AGENT_RELAY_APP_SERVER_AUTH_TOKEN").ok(),
        username: std::env::var("AGENT_RELAY_APP_SERVER_AUTH_USERNAME").ok(),
        password: std::env::var("AGENT_RELAY_APP_SERVER_AUTH_PASSWORD").ok(),
    })
}

fn format_app_server_delivery(delivery: &RelayDelivery) -> String {
    let target = if delivery.target.trim().is_empty() {
        "agent"
    } else {
        delivery.target.as_str()
    };
    format!(
        "Relay message from {} to {}:\n\n{}",
        delivery.from, target, delivery.body
    )
}

async fn send_opencode_prompt(
    http: &reqwest::Client,
    endpoint: &str,
    session_id: &str,
    text: &str,
    auth: Option<&AppServerAuthConfig>,
) -> Result<()> {
    let url = opencode_session_url(endpoint, session_id, "prompt_async");
    let request = http.post(&url).json(&json!({
        "parts": [
            {
                "type": "text",
                "text": text,
            }
        ]
    }));
    send_app_server_request(apply_app_server_auth(request, auth)).await
}

/// OpenCode's V2 server API is the one built-in provider contract that can
/// actually switch a live session's model. The 204 mutation is followed by a
/// session read; returning `applied` is only valid when that read reports the
/// exact requested provider/model reference. Any outcome that does not prove
/// the provider rejected or applied the request is uncertainty and returns
/// `Pending` so the broker retains it until its deadline.
async fn set_opencode_model(
    http: &reqwest::Client,
    endpoint: &str,
    session_id: &str,
    requested_model: &str,
    auth: Option<&AppServerAuthConfig>,
) -> Result<OpenCodeModelOutcome> {
    let (provider_id, model_id) = requested_model
        .split_once('/')
        .filter(|(provider, model)| !provider.is_empty() && !model.is_empty())
        .ok_or_else(|| anyhow::anyhow!("OpenCode models must use provider/model syntax"))?;
    let model_url = opencode_v2_session_url(endpoint, session_id, "model");
    let request = http.post(model_url).json(&json!({
        "model": {
            "providerID": provider_id,
            "id": model_id,
        }
    }));
    // A transport failure on the mutation POST is uncertainty, not proof of
    // rejection: the provider may have applied the model even though the
    // response was lost. Only an explicit non-2xx status returned by the
    // provider is treated as a refusal.
    let response = match apply_app_server_auth(request, auth).send().await {
        Ok(response) => response,
        Err(error) => {
            return Ok(OpenCodeModelOutcome::Pending(format!(
                "OpenCode model mutation request failed: {error}"
            )))
        }
    };
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Ok(OpenCodeModelOutcome::Rejected(format!(
            "OpenCode model mutation failed with status {status}: {body}"
        )));
    }
    confirm_opencode_model(http, endpoint, session_id, requested_model, auth).await
}

/// Read the OpenCode session document and report whether the requested model
/// is the session's effective model. An unavailable, unreadable, or incomplete
/// session document is uncertainty (`Pending`): it does not prove the provider
/// rejected the mutation. Only a readable document that names a different
/// effective model rejects the request.
async fn confirm_opencode_model(
    http: &reqwest::Client,
    endpoint: &str,
    session_id: &str,
    requested_model: &str,
    auth: Option<&AppServerAuthConfig>,
) -> Result<OpenCodeModelOutcome> {
    let session_url = opencode_v2_session_url(endpoint, session_id, "");
    let session = match apply_app_server_auth(http.get(session_url), auth)
        .send()
        .await
    {
        Ok(session) => session,
        Err(error) => {
            return Ok(OpenCodeModelOutcome::Pending(format!(
                "OpenCode model confirmation request failed: {error}"
            )))
        }
    };
    if !session.status().is_success() {
        let status = session.status();
        let body = session.text().await.unwrap_or_default();
        return Ok(OpenCodeModelOutcome::Pending(format!(
            "OpenCode model confirmation failed with status {status}: {body}"
        )));
    }
    let body: Value = match session.json().await {
        Ok(body) => body,
        Err(error) => {
            return Ok(OpenCodeModelOutcome::Pending(format!(
                "OpenCode model confirmation was not valid JSON: {error}"
            )))
        }
    };
    let data = body.get("data").unwrap_or(&body);
    let confirmed_provider = data
        .get("model")
        .and_then(|model| model.get("providerID"))
        .and_then(Value::as_str);
    let confirmed_id = data
        .get("model")
        .and_then(|model| model.get("id").or_else(|| model.get("modelID")))
        .and_then(Value::as_str);
    // A successful-but-incomplete session document does not name the effective
    // model; treating the missing fields as an empty model would fabricate a
    // rejection out of missing evidence.
    let (Some(confirmed_provider), Some(confirmed_id)) = (confirmed_provider, confirmed_id) else {
        return Ok(OpenCodeModelOutcome::Pending(
            "OpenCode session confirmation did not report an effective model".into(),
        ));
    };
    let effective_model = format!("{confirmed_provider}/{confirmed_id}");
    if effective_model != requested_model {
        return Ok(OpenCodeModelOutcome::Rejected(format!(
            "OpenCode confirmed effective model '{effective_model}', not requested '{requested_model}'"
        )));
    }
    Ok(OpenCodeModelOutcome::Applied(effective_model))
}

async fn release_app_server(
    http: &reqwest::Client,
    protocol: &str,
    endpoint: &str,
    session_id: &str,
    release: &str,
    auth: Option<&AppServerAuthConfig>,
) -> Result<()> {
    if release == "detach" || release.is_empty() {
        return Ok(());
    }
    if protocol != "opencode" {
        anyhow::bail!("release is unsupported for app_server protocol '{protocol}'");
    }

    match release {
        "abort" => {
            let url = opencode_session_url(endpoint, session_id, "abort");
            send_app_server_request(apply_app_server_auth(http.post(url), auth)).await
        }
        "delete" => {
            let url = opencode_session_url(endpoint, session_id, "");
            send_app_server_request(apply_app_server_auth(http.delete(url), auth)).await
        }
        other => anyhow::bail!(
            "unsupported app_server release policy '{other}' (expected abort, detach, or delete)"
        ),
    }
}

fn apply_app_server_auth(
    request: reqwest::RequestBuilder,
    auth: Option<&AppServerAuthConfig>,
) -> reqwest::RequestBuilder {
    let Some(auth) = auth else {
        return request;
    };

    match auth.auth_type.as_str() {
        "bearer" => match auth.token.as_deref() {
            Some(token) if !token.trim().is_empty() => request.bearer_auth(token),
            _ => request,
        },
        "basic" => match (auth.username.as_deref(), auth.password.as_deref()) {
            (Some(username), Some(password)) => request.basic_auth(username, Some(password)),
            _ => request,
        },
        _ => request,
    }
}

async fn send_app_server_request(request: reqwest::RequestBuilder) -> Result<()> {
    let response = request.send().await.context("app-server request failed")?;
    if response.status().is_success() {
        return Ok(());
    }

    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    anyhow::bail!("app-server request failed with status {status}: {body}");
}

fn opencode_session_url(endpoint: &str, session_id: &str, action: &str) -> String {
    let base = endpoint.trim_end_matches('/');
    let session = urlencoding::encode(session_id);
    if action.is_empty() {
        format!("{base}/session/{session}")
    } else {
        format!("{base}/session/{session}/{action}")
    }
}

fn opencode_v2_session_url(endpoint: &str, session_id: &str, action: &str) -> String {
    let base = endpoint.trim_end_matches('/');
    let session = urlencoding::encode(session_id);
    if action.is_empty() {
        format!("{base}/api/session/{session}")
    } else {
        format!("{base}/api/session/{session}/{action}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use httpmock::{Method::GET, Method::POST, MockServer};

    #[test]
    fn opencode_session_url_escapes_session_id() {
        assert_eq!(
            opencode_session_url("http://127.0.0.1:4096/", "ses/one", "prompt_async"),
            "http://127.0.0.1:4096/session/ses%2Fone/prompt_async"
        );
    }

    #[test]
    fn opencode_v2_session_url_uses_model_api() {
        assert_eq!(
            opencode_v2_session_url("http://127.0.0.1:4096/", "ses/one", "model"),
            "http://127.0.0.1:4096/api/session/ses%2Fone/model"
        );
    }

    #[tokio::test]
    async fn opencode_model_mutation_requires_exact_session_confirmation() {
        let server = MockServer::start();
        let switch = server.mock(|when, then| {
            when.method(POST)
                .path("/api/session/ses-1/model")
                .json_body(json!({
                    "model": { "providerID": "openai", "id": "gpt-5.4" }
                }));
            then.status(204);
        });
        let confirm = server.mock(|when, then| {
            when.method(GET).path("/api/session/ses-1");
            then.status(200).json_body(json!({
                "data": { "model": { "providerID": "openai", "id": "gpt-5.4" } }
            }));
        });
        let http = reqwest::Client::new();
        let effective =
            set_opencode_model(&http, &server.base_url(), "ses-1", "openai/gpt-5.4", None)
                .await
                .unwrap();
        assert_eq!(
            effective,
            OpenCodeModelOutcome::Applied("openai/gpt-5.4".into())
        );
        switch.assert();
        confirm.assert();
    }

    #[tokio::test]
    async fn opencode_model_mutation_keeps_pending_when_confirmation_is_unavailable() {
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(POST).path("/api/session/ses-1/model");
            then.status(204);
        });
        server.mock(|when, then| {
            when.method(GET).path("/api/session/ses-1");
            then.status(503).body("provider warming up");
        });
        let http = reqwest::Client::new();
        let outcome =
            set_opencode_model(&http, &server.base_url(), "ses-1", "openai/gpt-5.4", None)
                .await
                .unwrap();
        assert!(matches!(outcome, OpenCodeModelOutcome::Pending(error) if error.contains("503")));
    }

    #[tokio::test]
    async fn opencode_model_mutation_post_transport_failure_is_pending() {
        // Port 9 (discard) has no listener: the POST cannot reach a provider,
        // which is uncertainty — the provider may have applied the model even
        // though the response was lost — never a terminal rejection.
        let http = reqwest::Client::new();
        let outcome =
            set_opencode_model(&http, "http://127.0.0.1:9", "ses-1", "openai/gpt-5.4", None)
                .await
                .unwrap();
        assert!(matches!(
            outcome,
            OpenCodeModelOutcome::Pending(error) if error.contains("mutation request failed")
        ));
    }

    #[tokio::test]
    async fn opencode_model_mutation_post_refusal_is_rejected() {
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(POST).path("/api/session/ses-1/model");
            then.status(422).body("unknown model");
        });
        let http = reqwest::Client::new();
        let outcome =
            set_opencode_model(&http, &server.base_url(), "ses-1", "openai/gpt-5.4", None)
                .await
                .unwrap();
        assert!(matches!(
            outcome,
            OpenCodeModelOutcome::Rejected(error) if error.contains("422")
        ));
    }

    #[tokio::test]
    async fn opencode_confirmation_without_model_fields_is_pending() {
        // A successful-but-incomplete session document does not prove the
        // provider rejected the mutation; missing model fields must stay
        // pending instead of fabricating a "/" effective model rejection.
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(GET).path("/api/session/ses-1");
            then.status(200).json_body(json!({
                "data": { "title": "session without a model yet" }
            }));
        });
        let http = reqwest::Client::new();
        let outcome =
            confirm_opencode_model(&http, &server.base_url(), "ses-1", "openai/gpt-5.4", None)
                .await
                .unwrap();
        assert!(matches!(
            outcome,
            OpenCodeModelOutcome::Pending(error) if error.contains("did not report an effective model")
        ));
    }

    #[tokio::test]
    async fn app_server_worker_retries_parked_confirmation_until_it_resolves() {
        use tokio::io::{duplex, AsyncWriteExt};

        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(POST).path("/api/session/ses-1/model");
            then.status(204);
        });
        // The confirmation read is initially unavailable (503); once the
        // pending response is observed, the mock is replaced with a readable
        // session document so the parked retry can resolve the receipt.
        let mut confirm_unavailable = server.mock(|when, then| {
            when.method(GET).path("/api/session/ses-1");
            then.status(503).body("provider warming up");
        });
        let (mut stdin_tx, stdin_rx) = duplex(64);
        let (stdout_tx, stdout_rx) = duplex(4096);
        let cmd = HeadlessAppServerCommand {
            protocol: "opencode".into(),
            endpoint: server.base_url(),
            session_id: "ses-1".into(),
            host_pid: None,
            release: "detach".into(),
            agent_name: Some("proof-worker".into()),
        };
        let worker = tokio::spawn(run_app_server_worker_with_io(cmd, stdin_rx, stdout_tx));

        let set_model = json!({
            "v": 1,
            "type": "set_model",
            "request_id": "model-1",
            "payload": { "model": "openai/gpt-5.4", "provider_timeout_ms": 10_000 },
        });
        stdin_tx
            .write_all(format!("{}\n", serde_json::to_string(&set_model).unwrap()).as_bytes())
            .await
            .unwrap();

        let mut stdout = tokio::io::BufReader::new(stdout_rx);
        let mut line = String::new();
        // 1. The worker announces the model start and waits for the ack.
        tokio::time::timeout(Duration::from_secs(5), stdout.read_line(&mut line))
            .await
            .expect("started frame")
            .unwrap();
        let started: ProtocolEnvelope<Value> = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(started.msg_type, "set_model_started");
        line.clear();
        let ack = json!({
            "v": 1,
            "type": "set_model_started_ack",
            "request_id": "model-1",
            "payload": {},
        });
        stdin_tx
            .write_all(format!("{}\n", serde_json::to_string(&ack).unwrap()).as_bytes())
            .await
            .unwrap();
        // 2. The mutation succeeds but the confirmation read is unavailable:
        //    one accepted_pending response, and the request stays parked.
        tokio::time::timeout(Duration::from_secs(5), stdout.read_line(&mut line))
            .await
            .expect("pending frame")
            .unwrap();
        let pending: ProtocolEnvelope<Value> = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(pending.msg_type, "set_model_response");
        assert_eq!(pending.payload["status"], "accepted_pending");
        line.clear();
        // 3. The provider recovers; the parked retry resolves the receipt with
        //    the documented subsequent provider response.
        confirm_unavailable.delete();
        server.mock(|when, then| {
            when.method(GET).path("/api/session/ses-1");
            then.status(200).json_body(json!({
                "data": { "model": { "providerID": "openai", "id": "gpt-5.4" } }
            }));
        });
        let mut resolved = false;
        for _ in 0..30 {
            match tokio::time::timeout(Duration::from_secs(2), stdout.read_line(&mut line)).await {
                Ok(Ok(0)) => break,
                Ok(Ok(_)) => {
                    let frame: ProtocolEnvelope<Value> = match serde_json::from_str(line.trim()) {
                        Ok(frame) => frame,
                        Err(_) => {
                            line.clear();
                            continue;
                        }
                    };
                    line.clear();
                    if frame.msg_type == "set_model_response"
                        && frame.payload["status"] == "applied"
                        && frame.payload["effective_model"] == "openai/gpt-5.4"
                    {
                        resolved = true;
                        break;
                    }
                }
                Ok(Err(_)) | Err(_) => continue,
            }
        }
        assert!(
            resolved,
            "parked confirmation retry never emitted the subsequent applied response"
        );

        // Shutdown cleanly so the spawned worker task can finish.
        let shutdown = json!({
            "v": 1,
            "type": "shutdown_worker",
            "payload": {},
        });
        stdin_tx
            .write_all(format!("{}\n", serde_json::to_string(&shutdown).unwrap()).as_bytes())
            .await
            .unwrap();
        drop(stdin_tx);
        tokio::time::timeout(Duration::from_secs(5), worker)
            .await
            .expect("worker exits after shutdown")
            .unwrap()
            .unwrap();
    }

    #[test]
    fn format_app_server_delivery_includes_relay_context() {
        let delivery = RelayDelivery {
            delivery_id: "del_1".into(),
            event_id: "evt_1".into(),
            workspace_id: None,
            workspace_alias: None,
            from: "Lead".into(),
            target: "Worker".into(),
            body: "Do the thing".into(),
            thread_id: None,
            priority: None,
            injection_mode: MessageInjectionMode::Wait,
        };

        assert_eq!(
            format_app_server_delivery(&delivery),
            "Relay message from Lead to Worker:\n\nDo the thing"
        );
    }
}

#[cfg(test)]
mod model_start_ack_tests {
    use super::*;

    #[test]
    fn start_ack_wait_preserves_nonmatching_queued_frames_in_order() {
        let request_id = Some(RequestId::new("model-1"));
        let mut deferred = std::collections::VecDeque::new();
        let delivery = ProtocolEnvelope {
            v: PROTOCOL_VERSION,
            msg_type: "deliver_relay".to_string(),
            request_id: Some(RequestId::new("delivery-1")),
            payload: json!({"delivery_id": "delivery-1"}),
        };
        let ping = ProtocolEnvelope {
            v: PROTOCOL_VERSION,
            msg_type: "ping".to_string(),
            request_id: None,
            payload: json!({"ts_ms": 1}),
        };
        assert!(!model_start_acknowledged(
            delivery.clone(),
            &request_id,
            &mut deferred
        ));
        assert!(!model_start_acknowledged(
            ping.clone(),
            &request_id,
            &mut deferred
        ));
        assert_eq!(deferred.pop_front().unwrap().msg_type, delivery.msg_type);
        assert_eq!(deferred.pop_front().unwrap().msg_type, ping.msg_type);
        assert!(model_start_acknowledged(
            ProtocolEnvelope {
                v: PROTOCOL_VERSION,
                msg_type: "set_model_started_ack".to_string(),
                request_id: Some(RequestId::new("model-1")),
                payload: json!({}),
            },
            &request_id,
            &mut deferred
        ));
        assert!(deferred.is_empty());
    }

    #[test]
    fn start_ack_wait_uses_provider_timeout_when_supplied() {
        assert_eq!(
            model_start_ack_timeout(&json!({"provider_timeout_ms": 65_000})),
            Duration::from_secs(65)
        );
        assert_eq!(
            model_start_ack_timeout(&json!({"provider_timeout_ms": 0})),
            Duration::from_secs(5)
        );
        assert_eq!(model_start_ack_timeout(&json!({})), Duration::from_secs(5));
    }

    #[test]
    fn invalid_frame_diagnostic_is_non_retryable() {
        let error = serde_json::from_str::<Value>("{").expect_err("malformed JSON");
        assert_eq!(
            invalid_frame_payload(&error),
            json!({
                "code": "invalid_frame",
                "message": error.to_string(),
                "retryable": false,
            })
        );
    }
}
