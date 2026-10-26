use crate::config::{AgentCredential, Config, HOSTED_ORIGIN};
use anyhow::{anyhow, bail, Context, Result};
use relaycast::{
    AgentClient, ClientOptions, CreateAgentRequest, DmOptions, HttpClient, RelayCast,
    RelayCastOptions, RelayError, WorkspaceProvenance,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    path::Path,
    time::{Duration, Instant},
};

const DELIVERY_WAIT: Duration = Duration::from_secs(10);

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WorkspaceIdentity {
    pub id: String,
    pub name: String,
    pub key: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SendReceipt {
    pub message_id: String,
    pub conversation_id: String,
    pub to: String,
    pub status: DeliveryStatus,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryStatus {
    Delivered,
    Accepted,
    NoSuchAgent,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct InboxMessage {
    pub delivery_id: String,
    pub message_id: String,
    pub from: String,
    pub text: String,
    pub created_at: String,
}

pub async fn create_workspace(origin: &str, name: &str) -> Result<WorkspaceIdentity> {
    let created = RelayCast::create_workspace(name, Some(origin), WorkspaceProvenance::sdk())
        .await
        .map_err(public_error)?;
    Ok(WorkspaceIdentity {
        id: created.workspace_id,
        name: name.to_string(),
        key: created.api_key,
    })
}

pub async fn verify_workspace(
    origin: &str,
    key: &str,
    ca_cert: Option<&Path>,
) -> Result<WorkspaceIdentity> {
    if let Some(ca_cert) = ca_cert {
        let workspace = custom_ca_request(
            origin,
            key,
            ca_cert,
            reqwest::Method::GET,
            "/v1/workspace",
            None,
        )
        .await?;
        return Ok(WorkspaceIdentity {
            id: required_string(&workspace, "id")?,
            name: required_string(&workspace, "name")?,
            key: key.to_string(),
        });
    }
    let relay = workspace_client(origin, key)?;
    let workspace = relay.workspace_info().await.map_err(public_error)?;
    Ok(WorkspaceIdentity {
        id: workspace.id,
        name: workspace.name,
        key: key.to_string(),
    })
}

pub async fn register(config: &Config, name: &str) -> Result<AgentCredential> {
    let name = valid_name(name)?;
    if let Some(ca_cert) = config.ca_cert.as_deref() {
        if let Some(existing) = config.agents.get(name) {
            let rotated = custom_ca_request(
                &config.origin,
                &existing.token,
                ca_cert,
                reqwest::Method::POST,
                &format!("/v1/agents/{}/rotate-token", urlencoding::encode(name)),
                Some(serde_json::json!({})),
            )
            .await?;
            return Ok(AgentCredential {
                id: existing.id.clone(),
                token: required_string(&rotated, "token")?,
            });
        }
        let registered = custom_ca_request(
            &config.origin,
            &config.workspace_key,
            ca_cert,
            reqwest::Method::POST,
            "/v1/agents",
            Some(serde_json::json!({
                "name": name,
                "type": "agent",
                "metadata": {"source": "relay-probe"}
            })),
        )
        .await?;
        return Ok(AgentCredential {
            id: required_string(&registered, "id")?,
            token: required_string(&registered, "token")?,
        });
    }
    let relay = workspace_client(&config.origin, &config.workspace_key)?;
    if let Some(existing) = config.agents.get(name) {
        let rotated = relay
            .rotate_agent_token(name, existing.token.clone())
            .await
            .map_err(public_error)?;
        return Ok(AgentCredential {
            id: existing.id.clone(),
            token: rotated.token,
        });
    }
    let registered = relay
        .register_agent(CreateAgentRequest {
            name: name.to_string(),
            agent_type: Some("agent".into()),
            persona: None,
            metadata: Some(
                [("source".into(), Value::String("relay-probe".into()))]
                    .into_iter()
                    .collect(),
            ),
        })
        .await
        .map_err(public_error)?;
    Ok(AgentCredential {
        id: registered.id,
        token: registered.token,
    })
}

pub async fn rotate(config: &Config, name: &str) -> Result<AgentCredential> {
    let name = valid_name(name)?;
    let existing = config
        .agents
        .get(name)
        .ok_or_else(|| anyhow!("Agent `{name}` is not stored on this machine. Run `relay agent register {name}` first."))?;
    if let Some(ca_cert) = config.ca_cert.as_deref() {
        let rotated = custom_ca_request(
            &config.origin,
            &existing.token,
            ca_cert,
            reqwest::Method::POST,
            &format!("/v1/agents/{}/rotate-token", urlencoding::encode(name)),
            Some(serde_json::json!({})),
        )
        .await?;
        return Ok(AgentCredential {
            id: existing.id.clone(),
            token: required_string(&rotated, "token")?,
        });
    }
    let relay = workspace_client(&config.origin, &config.workspace_key)?;
    let rotated = relay
        .rotate_agent_token(name, existing.token.clone())
        .await
        .map_err(public_error)?;
    Ok(AgentCredential {
        id: existing.id.clone(),
        token: rotated.token,
    })
}

pub async fn send(config: &Config, from: &str, to: &str, text: &str) -> Result<SendReceipt> {
    let from = valid_name(from)?;
    let to = valid_name(to)?;
    let text = text.trim();
    if text.is_empty() {
        bail!("Message text cannot be empty.");
    }
    let credential = config.agents.get(from).ok_or_else(|| {
        anyhow!("Agent `{from}` is not stored on this machine. Run `relay agent register {from}` first.")
    })?;
    let (message_id, conversation_id) = if let Some(ca_cert) = config.ca_cert.as_deref() {
        let sent = custom_ca_request(
            &config.origin,
            &credential.token,
            ca_cert,
            reqwest::Method::POST,
            "/v1/dm",
            Some(serde_json::json!({"to": to, "text": text, "mode": "wait"})),
        )
        .await?;
        (
            required_string(
                sent.get("message")
                    .ok_or_else(|| anyhow!("Relaycast response is missing message."))?,
                "id",
            )?,
            required_string(&sent, "conversation_id")?,
        )
    } else {
        let agent = AgentClient::new(credential.token.clone(), Some(config.origin.clone()))?;
        let sent = agent
            .dm_typed(to, text, Some(DmOptions::default()))
            .await
            .map_err(public_error)?;
        (sent.message.id, sent.conversation_id)
    };
    let status = wait_for_delivery(config, to, &message_id).await?;
    Ok(SendReceipt {
        message_id,
        conversation_id,
        to: to.to_string(),
        status,
    })
}

pub async fn take_deliveries(config: &Config, name: &str) -> Result<Vec<InboxMessage>> {
    let name = valid_name(name)?;
    let credential = config.agents.get(name).ok_or_else(|| {
        anyhow!("Agent `{name}` is not stored on this machine. Run `relay agent register {name}` first.")
    })?;
    if let Some(ca_cert) = config.ca_cert.as_deref() {
        let deliveries = custom_ca_request(
            &config.origin,
            &credential.token,
            ca_cert,
            reqwest::Method::GET,
            "/v1/deliveries",
            None,
        )
        .await?;
        let rows = deliveries
            .as_array()
            .ok_or_else(|| anyhow!("Relaycast deliveries response is unreadable."))?;
        let mut messages = Vec::new();
        for row in rows {
            let Some(message) = row.get("message").filter(|value| !value.is_null()) else {
                continue;
            };
            let delivery_id = required_string(row, "id")?;
            messages.push(InboxMessage {
                delivery_id: delivery_id.clone(),
                message_id: required_string(message, "id")?,
                from: message
                    .get("agent_name")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_string(),
                text: required_string(message, "text")?,
                created_at: required_string(message, "created_at")?,
            });
            custom_ca_request(
                &config.origin,
                &credential.token,
                ca_cert,
                reqwest::Method::POST,
                &format!("/v1/deliveries/{}/ack", urlencoding::encode(&delivery_id)),
                None,
            )
            .await?;
        }
        return Ok(messages);
    }
    let agent = AgentClient::new(credential.token.clone(), Some(config.origin.clone()))?;
    let deliveries = agent.deliveries(None).await.map_err(public_error)?;
    let mut messages = Vec::new();
    for item in deliveries {
        let Some(message) = item.message else {
            continue;
        };
        let inbox = InboxMessage {
            delivery_id: item.delivery.id.clone(),
            message_id: message.id,
            from: message.agent_name.unwrap_or_else(|| "unknown".into()),
            text: message.text,
            created_at: message.created_at,
        };
        agent
            .ack_delivery(&item.delivery.id)
            .await
            .map_err(public_error)?;
        messages.push(inbox);
    }
    Ok(messages)
}

fn workspace_client(origin: &str, key: &str) -> Result<RelayCast> {
    let mut options = RelayCastOptions::new(key.to_string()).with_base_url(origin.to_string());
    options.origin_client = Some("relay-probe".into());
    options.origin_version = Some(env!("CARGO_PKG_VERSION").into());
    RelayCast::new(options).map_err(Into::into)
}

fn raw_workspace_client(config: &Config) -> Result<HttpClient> {
    HttpClient::new(
        ClientOptions::new(config.workspace_key.clone())
            .with_base_url(config.origin.clone())
            .with_origin("relay-probe", env!("CARGO_PKG_VERSION")),
    )
    .map_err(Into::into)
}

async fn wait_for_delivery(
    config: &Config,
    recipient: &str,
    message_id: &str,
) -> Result<DeliveryStatus> {
    let client = if config.ca_cert.is_none() {
        Some(raw_workspace_client(config)?)
    } else {
        None
    };
    let deadline = Instant::now() + DELIVERY_WAIT;
    // Give Relaycast time to create the durable row before interpreting an
    // absent row as an already-picked-up delivery.
    tokio::time::sleep(Duration::from_millis(150)).await;
    loop {
        let path = format!("/v1/agents/{}", urlencoding::encode(recipient));
        let record: Value = if let Some(client) = &client {
            match client.get(&path, None, None).await {
                Ok(record) => record,
                Err(error) if error.is_not_found() => return Ok(DeliveryStatus::NoSuchAgent),
                Err(error) => return Err(public_error(error)),
            }
        } else {
            match custom_ca_request(
                &config.origin,
                &config.workspace_key,
                config.ca_cert.as_deref().expect("checked above"),
                reqwest::Method::GET,
                &path,
                None,
            )
            .await
            {
                Ok(record) => record,
                Err(error) if error.to_string().contains("not_found") => {
                    return Ok(DeliveryStatus::NoSuchAgent)
                }
                Err(error) => return Err(error),
            }
        };
        let pending = record.get("pending_deliveries").and_then(Value::as_array);
        if let Some(pending) = pending {
            match pending
                .iter()
                .find(|row| row.get("message_id").and_then(Value::as_str) == Some(message_id))
            {
                None if pending.len() < 50 => return Ok(DeliveryStatus::Delivered),
                Some(row) if row.get("status").and_then(Value::as_str) == Some("acked") => {
                    return Ok(DeliveryStatus::Delivered)
                }
                _ => {}
            }
        }
        if Instant::now() >= deadline {
            return Ok(DeliveryStatus::Accepted);
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

async fn custom_ca_request(
    origin: &str,
    key: &str,
    ca_cert: &Path,
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
) -> Result<Value> {
    let pem = std::fs::read(ca_cert).map_err(|error| {
        anyhow!(
            "Could not read custom CA certificate at {}: {error}",
            ca_cert.display()
        )
    })?;
    let certificate =
        reqwest::Certificate::from_pem(&pem).context("Custom CA certificate is not valid PEM.")?;
    let client = reqwest::Client::builder()
        .add_root_certificate(certificate)
        .timeout(Duration::from_secs(30))
        .build()?;
    let mut request = client
        .request(method, format!("{origin}{path}"))
        .bearer_auth(key)
        .header("X-Relaycast-Origin-Client", "relay-probe")
        .header("X-Relaycast-Origin-Version", env!("CARGO_PKG_VERSION"));
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().await.map_err(|error| {
        anyhow!("Relaycast could not be reached. Check the saved URL and TLS trust: {error:?}")
    })?;
    let status = response.status();
    let envelope: Value = response
        .json()
        .await
        .context("Relaycast returned an unreadable response.")?;
    if !status.is_success() || envelope.get("ok").and_then(Value::as_bool) != Some(true) {
        let code = envelope
            .pointer("/error/code")
            .and_then(Value::as_str)
            .unwrap_or("request_failed");
        let message = envelope
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or("Relaycast rejected the request.");
        if code == "plan_limit_exceeded" {
            let upgrade = envelope
                .pointer("/error/upgrade_url")
                .or_else(|| envelope.pointer("/upgrade_url"))
                .and_then(Value::as_str)
                .unwrap_or("https://agentrelay.com/pricing");
            bail!("Hosted Relaycast trial limit reached. Upgrade at {upgrade}.");
        }
        bail!("Relaycast rejected the request ({code}): {message}");
    }
    envelope
        .get("data")
        .cloned()
        .ok_or_else(|| anyhow!("Relaycast response is missing data."))
}

fn required_string(value: &Value, field: &str) -> Result<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| anyhow!("Relaycast response is missing `{field}`."))
}

pub(crate) fn valid_name(value: &str) -> Result<&str> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.len() > 128
        || !trimmed
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        bail!("Agent names use 1-128 letters, numbers, dots, dashes, or underscores.");
    }
    Ok(trimmed)
}

pub fn public_error(error: RelayError) -> anyhow::Error {
    match error {
        RelayError::Api {
            code,
            message: _,
            details,
            ..
        } if code == "plan_limit_exceeded" => {
            let upgrade = details
                .as_ref()
                .and_then(|value| value.get("upgrade_url"))
                .and_then(Value::as_str)
                .unwrap_or("https://agentrelay.com/pricing");
            anyhow!("Hosted Relaycast trial limit reached. Upgrade at {upgrade}.")
        }
        RelayError::Api { code, message, .. } => {
            anyhow!("Relaycast rejected the request ({code}): {message}")
        }
        RelayError::Http(error) if error.is_timeout() => {
            anyhow!("Relaycast did not answer in time.")
        }
        RelayError::Http(_) => {
            anyhow!("Relaycast could not be reached. Check the saved URL and TLS trust.")
        }
        RelayError::InvalidResponse(message) => {
            anyhow!("Relaycast returned an unreadable response: {message}")
        }
        _ => anyhow!("Relaycast request failed."),
    }
}

pub fn join_command(origin: &str, key: &str) -> String {
    format!(
        "relay init --url {} --key {}",
        shell_quote(origin),
        shell_quote(key)
    )
}

fn shell_quote(value: &str) -> String {
    if value.bytes().all(|byte| {
        byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'/' | b':' | b'_' | b'-')
    }) {
        return value.to_string();
    }
    format!("'{}'", value.replace('\'', "'\\''"))
}

pub fn hosted_origin() -> &'static str {
    HOSTED_ORIGIN
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use httpmock::prelude::*;

    #[test]
    fn join_command_keeps_url_and_key_together() {
        assert_eq!(
            join_command("https://relay.corp.test:8443", "rk_live_example"),
            "relay init --url https://relay.corp.test:8443 --key rk_live_example"
        );
    }

    #[test]
    fn agent_names_are_bounded() {
        assert_eq!(valid_name(" agent-a ").unwrap(), "agent-a");
        assert!(valid_name("agent a").is_err());
        assert!(valid_name("").is_err());
    }

    #[test]
    fn a_configured_client_never_uses_the_hosted_default() {
        let config = Config::new(
            "https://relay.corp.test:8443".into(),
            "rw_test".into(),
            "corp".into(),
            "rk_live_private".into(),
            32123,
            None,
        );
        let client = raw_workspace_client(&config).unwrap();
        assert_eq!(client.base_url(), "https://relay.corp.test:8443");
        assert_ne!(client.base_url(), HOSTED_ORIGIN);
    }

    #[tokio::test]
    async fn self_hosted_verification_uses_only_the_explicit_network_origin() {
        let server = MockServer::start_async().await;
        let request = server
            .mock_async(|when, then| {
                when.method(GET).path("/v1/workspace");
                then.status(200).json_body(serde_json::json!({
                    "ok": true,
                    "data": {
                        "id": "rw_private",
                        "name": "private",
                        "plan": "self_hosted",
                        "system_prompt": null,
                        "created_at": "2026-10-25T00:00:00Z"
                    }
                }));
            })
            .await;

        let workspace = verify_workspace(&server.base_url(), "rk_live_private", None)
            .await
            .unwrap();
        assert_eq!(workspace.id, "rw_private");
        request.assert_async().await;
    }
}
