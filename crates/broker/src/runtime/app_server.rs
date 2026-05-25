use super::*;

#[derive(Debug, Clone)]
struct AppServerAuthConfig {
    auth_type: String,
    token: Option<String>,
    username: Option<String>,
    password: Option<String>,
}

pub(crate) async fn run_app_server_worker(cmd: AppServerCommand) -> Result<()> {
    let protocol = cmd.protocol.trim().to_ascii_lowercase();
    let endpoint = cmd.endpoint.trim().trim_end_matches('/').to_string();
    let session_id = cmd.session_id.clone();
    let release = cmd.release.trim().to_ascii_lowercase();
    let auth = app_server_auth_from_env();
    let http = reqwest::Client::new();

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
    let mut worker_name = cmd
        .agent_name
        .clone()
        .unwrap_or_else(|| format!("app-server-{protocol}"));
    let mut final_exit_code: Option<i32> = None;
    let final_exit_signal: Option<String> = None;

    while let Ok(Some(line)) = lines.next_line().await {
        let frame: ProtocolEnvelope<Value> = match serde_json::from_str(&line) {
            Ok(frame) => frame,
            Err(error) => {
                let _ = send_frame(
                    &out_tx,
                    "worker_error",
                    None,
                    json!({
                        "code":"invalid_frame",
                        "message": error.to_string(),
                        "retryable": false,
                    }),
                )
                .await;
                continue;
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
                        "runtime": "app_server",
                        "sessionId": &session_id,
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

                let _ = send_frame(
                    &out_tx,
                    "delivery_injected",
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
                            "delivery_ack",
                            request_id.clone(),
                            json!({
                                "delivery_id": &delivery_id,
                                "event_id": &event_id,
                            }),
                        )
                        .await;
                        let _ = send_frame(
                            &out_tx,
                            "delivery_verified",
                            None,
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
                                "retryable": true,
                            }),
                        )
                        .await;
                    }
                }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opencode_session_url_escapes_session_id() {
        assert_eq!(
            opencode_session_url("http://127.0.0.1:4096/", "ses/one", "prompt_async"),
            "http://127.0.0.1:4096/session/ses%2Fone/prompt_async"
        );
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
