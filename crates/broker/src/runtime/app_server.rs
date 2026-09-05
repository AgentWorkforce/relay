use super::*;

#[derive(Debug, Clone)]
struct AppServerAuthConfig {
    auth_type: String,
    token: Option<String>,
    username: Option<String>,
    password: Option<String>,
}

const APP_SERVER_HTTP_TIMEOUT: Duration = Duration::from_secs(30);

pub(crate) async fn run_headless_app_server_worker(cmd: HeadlessAppServerCommand) -> Result<()> {
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
        let mut stdout = tokio::io::stdout();
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

    let mut lines = BufReader::new(tokio::io::stdin()).lines();
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

    loop {
        let frame: ProtocolEnvelope<Value> = if let Some(frame) = deferred_frames.pop_front() {
            frame
        } else {
            let line = match lines.next_line().await {
                Ok(Some(line)) => line,
                Ok(None) | Err(_) => break,
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
                let response = match result {
                    Ok(effective_model) => json!({
                        "status": "applied",
                        "applied": true,
                        "effective_model": effective_model,
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
/// exact requested provider/model reference.
async fn set_opencode_model(
    http: &reqwest::Client,
    endpoint: &str,
    session_id: &str,
    requested_model: &str,
    auth: Option<&AppServerAuthConfig>,
) -> Result<String> {
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
    send_app_server_request(apply_app_server_auth(request, auth)).await?;

    let session_url = opencode_v2_session_url(endpoint, session_id, "");
    let session = apply_app_server_auth(http.get(session_url), auth)
        .send()
        .await
        .context("OpenCode model confirmation request failed")?;
    if !session.status().is_success() {
        let status = session.status();
        let body = session.text().await.unwrap_or_default();
        anyhow::bail!("OpenCode model confirmation failed with status {status}: {body}");
    }
    let body: Value = session
        .json()
        .await
        .context("OpenCode model confirmation was not valid JSON")?;
    let data = body.get("data").unwrap_or(&body);
    let confirmed_provider = data
        .get("model")
        .and_then(|model| model.get("providerID"))
        .and_then(Value::as_str);
    let confirmed_id = data
        .get("model")
        .and_then(|model| model.get("id").or_else(|| model.get("modelID")))
        .and_then(Value::as_str);
    let effective_model = format!(
        "{}/{}",
        confirmed_provider.unwrap_or_default(),
        confirmed_id.unwrap_or_default()
    );
    if effective_model != requested_model {
        anyhow::bail!(
            "OpenCode confirmed effective model '{effective_model}', not requested '{requested_model}'"
        );
    }
    Ok(effective_model)
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
        assert_eq!(effective, "openai/gpt-5.4");
        switch.assert();
        confirm.assert();
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
