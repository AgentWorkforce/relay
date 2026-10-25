//! The daemon's Relaycast calls, all on the published `relaycast` SDK.
//! Nothing here speaks HTTP itself; the endpoints the SDK lacks are in
//! `sdk_gaps`, still over the SDK's `HttpClient`.
//!
//! Workspace-key calls register and remove agents and own webhooks and
//! subscriptions; agent-token calls read and settle an agent's delivery
//! queue, join its channels and send as it. Removing something already gone
//! counts as removed.

use crate::relay::delivery::policy::Delivery;
use crate::relay::links::Endpoint;
use crate::relay::sdk_gaps::{self, RegisteredAgent};
use crate::relay::workspace::{Secret, Workspace};
use relaycast::types::{
    CreateChannelRequest, CreateWebhookRequest, EventSubscription, FailDeliveryRequest, Webhook,
};
use relaycast::{AgentClient, DmOptions, RelayCast, RelayCastOptions, RelayError};
use serde_json::{Map, Value};

/// A workspace-key client for `base_url`.
pub fn workspace_client(base_url: &str, key: &Secret) -> relaycast::Result<RelayCast> {
    RelayCast::new(RelayCastOptions::new(key.expose()).with_base_url(base_url))
}

/// An agent-token client for `base_url`.
pub fn agent_client(base_url: &str, token: &Secret) -> relaycast::Result<AgentClient> {
    AgentClient::new(token.expose(), Some(base_url.to_string()))
}

/// The workspace a key belongs to, as Relaycast reports it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkspaceInfo {
    pub id: String,
    pub name: String,
    pub plan: Option<String>,
}

/// `GET /v1/workspace` with the workspace key. Read through `sdk_gaps`,
/// since the SDK's `Workspace` requires `api_key_hash`, which the server no
/// longer sends.
pub async fn workspace_info(workspace: &Workspace) -> relaycast::Result<WorkspaceInfo> {
    let http = sdk_gaps::http(&workspace.base_url, &workspace.key)?;
    let info = sdk_gaps::workspace_identity(&http).await?;
    Ok(WorkspaceInfo {
        id: info.id,
        name: info.name,
        plan: info.plan,
    })
}

fn gone_is_done(result: relaycast::Result<()>) -> relaycast::Result<()> {
    match result {
        Err(error) if error.is_not_found() => Ok(()),
        other => other,
    }
}

/// Where an agent is registered: under this computer's machine prefix and,
/// for a session when `auto_join_general` is on, in #general. A bare prefix
/// stays out of #general (test senders, aliases).
#[derive(Clone, Copy, Debug)]
pub struct Joining<'a> {
    pub machine_prefix: &'a str,
    pub general: bool,
}

impl<'a> From<&'a String> for Joining<'a> {
    fn from(machine_prefix: &'a String) -> Joining<'a> {
        Joining {
            machine_prefix,
            general: false,
        }
    }
}

/// Registers `name` with this computer's machine prefix.
pub async fn register_agent<'a>(
    base_url: &str,
    key: &Secret,
    name: &str,
    joining: impl Into<Joining<'a>>,
    metadata: Map<String, Value>,
) -> relaycast::Result<RegisteredAgent> {
    let http = sdk_gaps::http(base_url, key)?;
    sdk_gaps::register_agent(&http, name, joining.into(), metadata).await
}

/// Merges `metadata` into the agent's Relaycast metadata.
/// `status`, when given, is sent with the metadata: a `PATCH` that names
/// no status makes the agent active again, so an absent agent's update
/// must say `idle` to stay off the active roster.
pub async fn update_agent_metadata(
    base_url: &str,
    key: &Secret,
    name: &str,
    metadata: Map<String, Value>,
    status: Option<&str>,
) -> relaycast::Result<()> {
    crate::relay::request_log::observe(
        "SDK: update_agent_metadata",
        base_url,
        serde_json::json!({"name": name}),
        key.expose(),
        async {
            let request = relaycast::types::UpdateAgentRequest {
                metadata: Some(metadata),
                status: status.map(str::to_string),
                ..Default::default()
            };
            workspace_client(base_url, key)?
                .update_agent(name, request)
                .await
                .map(|_| ())
        },
    )
    .await
}

/// Marks the agent `active` or `idle` on the workspace roster.
pub async fn update_agent_status(
    base_url: &str,
    key: &Secret,
    name: &str,
    status: &str,
) -> relaycast::Result<()> {
    crate::relay::request_log::observe(
        "SDK: update_agent_status",
        base_url,
        serde_json::json!({"name": name, "status": status}),
        key.expose(),
        async {
            let request = relaycast::types::UpdateAgentRequest {
                status: Some(status.to_string()),
                ..Default::default()
            };
            workspace_client(base_url, key)?
                .update_agent(name, request)
                .await
                .map(|_| ())
        },
    )
    .await
}

/// Removes the agent, freeing its name.
pub async fn delete_agent(base_url: &str, key: &Secret, name: &str) -> relaycast::Result<()> {
    crate::relay::request_log::observe(
        "SDK: delete_agent",
        base_url,
        serde_json::json!({"name": name}),
        key.expose(),
        async { gone_is_done(workspace_client(base_url, key)?.delete_agent(name).await) },
    )
    .await
}

/// Keeps the agent shown as online.
pub async fn heartbeat(base_url: &str, token: &Secret) -> relaycast::Result<()> {
    crate::relay::request_log::observe(
        "SDK: heartbeat",
        base_url,
        serde_json::json!({}),
        token.expose(),
        async { agent_client(base_url, token)?.heartbeat().await },
    )
    .await
}

/// The agent's delivery queue, oldest first.
pub async fn deliveries(base_url: &str, token: &Secret) -> relaycast::Result<Vec<Delivery>> {
    let http = sdk_gaps::http(base_url, token)?;
    let items = sdk_gaps::deliveries(&http, 50).await?;
    Ok(Delivery::list(&Value::Array(items)))
}

pub async fn ack(base_url: &str, token: &Secret, delivery_id: &str) -> relaycast::Result<()> {
    crate::relay::request_log::observe(
        "SDK: ack",
        base_url,
        serde_json::json!({"delivery_id": delivery_id}),
        token.expose(),
        async {
            agent_client(base_url, token)?
                .ack_delivery(delivery_id)
                .await
                .map(drop)
        },
    )
    .await
}

/// Tells Relaycast the message could not be put into the session.
pub async fn fail(
    base_url: &str,
    token: &Secret,
    delivery_id: &str,
    error: &str,
    retryable: bool,
) -> relaycast::Result<()> {
    crate::relay::request_log::observe(
        "SDK: fail",
        base_url,
        serde_json::json!({"delivery_id": delivery_id}),
        token.expose(),
        async {
            let error: String = error.chars().take(500).collect();
            agent_client(base_url, token)?
                .fail_delivery(
                    delivery_id,
                    Some(FailDeliveryRequest {
                        error: Some(error),
                        retryable: Some(retryable),
                    }),
                )
                .await
                .map(drop)
        },
    )
    .await
}

/// Creates the channel as the agent holding `token`, which joins it (an
/// existing channel of that name is joined instead), and returns its id.
pub async fn ensure_channel(
    base_url: &str,
    token: &Secret,
    name: &str,
    topic: &str,
) -> relaycast::Result<String> {
    crate::relay::request_log::observe(
        "SDK: ensure_channel",
        base_url,
        serde_json::json!({"name": name}),
        token.expose(),
        async {
            let agent = agent_client(base_url, token)?;
            agent
                .ensure_joined_channel(CreateChannelRequest {
                    name: name.into(),
                    topic: Some(topic.into()),
                    metadata: None,
                })
                .await?;
            Ok(agent.get_channel(name).await?.channel.id)
        },
    )
    .await
}

/// Joins the channel as the agent holding `token`; returns its id.
pub async fn join_channel(base_url: &str, token: &Secret, name: &str) -> relaycast::Result<String> {
    crate::relay::request_log::observe(
        "SDK: join_channel",
        base_url,
        serde_json::json!({"name": name}),
        token.expose(),
        async {
            let agent = agent_client(base_url, token)?;
            match agent.join_channel(name).await {
                Ok(_) | Err(RelayError::Api { status: 409, .. }) => {}
                Err(error) => return Err(error),
            }
            Ok(agent.get_channel(name).await?.channel.id)
        },
    )
    .await
}

pub async fn leave_channel(base_url: &str, token: &Secret, name: &str) -> relaycast::Result<()> {
    crate::relay::request_log::observe(
        "SDK: leave_channel",
        base_url,
        serde_json::json!({"name": name}),
        token.expose(),
        async { gone_is_done(agent_client(base_url, token)?.leave_channel(name).await) },
    )
    .await
}

/// `DELETE /v1/channels/{name}` with the workspace key, through the SDK's
/// archive (which takes any bearer).
pub async fn delete_channel(base_url: &str, key: &Secret, name: &str) -> relaycast::Result<()> {
    crate::relay::request_log::observe(
        "SDK: delete_channel",
        base_url,
        serde_json::json!({"name": name}),
        key.expose(),
        async { gone_is_done(agent_client(base_url, key)?.archive_channel(name).await) },
    )
    .await
}

/// An inbound webhook, with the bearer Relaycast shows only now.
#[derive(Clone, Debug, serde::Serialize)]
pub struct CreatedWebhook {
    pub id: String,
    pub url: String,
    #[serde(skip)]
    pub token: Secret,
}

pub async fn create_webhook(
    base_url: &str,
    key: &Secret,
    name: &str,
    channel: &str,
) -> relaycast::Result<CreatedWebhook> {
    crate::relay::request_log::observe(
        "SDK: create_webhook",
        base_url,
        serde_json::json!({"name": name, "channel": channel}),
        key.expose(),
        async {
            let created = workspace_client(base_url, key)?
                .create_webhook(CreateWebhookRequest {
                    name: Some(name.into()),
                    channel: channel.into(),
                })
                .await?;
            Ok(CreatedWebhook {
                id: created.webhook_id,
                url: created.url,
                token: Secret::new(created.token),
            })
        },
    )
    .await
}

pub async fn delete_webhook(base_url: &str, key: &Secret, id: &str) -> relaycast::Result<()> {
    crate::relay::request_log::observe(
        "SDK: delete_webhook",
        base_url,
        serde_json::json!({}),
        key.expose(),
        async { gone_is_done(workspace_client(base_url, key)?.delete_webhook(id).await) },
    )
    .await
}

pub async fn list_webhooks(base_url: &str, key: &Secret) -> relaycast::Result<Vec<Webhook>> {
    crate::relay::request_log::observe(
        "SDK: list_webhooks",
        base_url,
        serde_json::json!({}),
        key.expose(),
        async { workspace_client(base_url, key)?.list_webhooks().await },
    )
    .await
}

/// A `thread.reply` subscription on `channel`, posting to `url`; its id.
pub async fn create_reply_subscription(
    base_url: &str,
    key: &Secret,
    channel: &str,
    url: &str,
    secret: &Secret,
) -> relaycast::Result<String> {
    let http = sdk_gaps::http(base_url, key)?;
    sdk_gaps::create_reply_subscription(&http, channel, url, secret).await
}

pub async fn list_subscriptions(
    base_url: &str,
    key: &Secret,
) -> relaycast::Result<Vec<EventSubscription>> {
    crate::relay::request_log::observe(
        "SDK: list_subscriptions",
        base_url,
        serde_json::json!({}),
        key.expose(),
        async { workspace_client(base_url, key)?.list_subscriptions().await },
    )
    .await
}

pub async fn delete_subscription(base_url: &str, key: &Secret, id: &str) -> relaycast::Result<()> {
    crate::relay::request_log::observe(
        "SDK: delete_subscription",
        base_url,
        serde_json::json!({}),
        key.expose(),
        async {
            gone_is_done(
                workspace_client(base_url, key)?
                    .delete_subscription(id)
                    .await,
            )
        },
    )
    .await
}

/// What Relaycast reported for a sent message.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize)]
pub struct Sent {
    pub message_id: Option<String>,
    pub conversation_id: Option<String>,
    /// The name an endpoint resolved to.
    pub to: Option<String>,
}

impl Sent {
    fn from_value(value: &Value) -> Sent {
        let string = |v: &Value| v.as_str().filter(|s| !s.is_empty()).map(str::to_string);
        Sent {
            message_id: string(&value["message"]["id"]).or_else(|| string(&value["id"])),
            conversation_id: string(&value["conversation_id"]),
            to: string(&value["to"]),
        }
    }
}

/// Sends a direct message as the agent holding `token`.
pub async fn send_dm(
    base_url: &str,
    token: &Secret,
    endpoint: &Endpoint,
    text: &str,
    idempotency_key: Option<String>,
) -> relaycast::Result<Sent> {
    crate::relay::request_log::observe(
        "SDK: send_dm",
        base_url,
        serde_json::json!({}),
        token.expose(),
        async {
            let value = match endpoint {
                Endpoint::Name(name) => {
                    agent_client(base_url, token)?
                        .dm(
                            name,
                            text,
                            Some(DmOptions {
                                idempotency_key,
                                ..DmOptions::default()
                            }),
                        )
                        .await?
                }
                Endpoint::Address(address) => {
                    let http = sdk_gaps::http(base_url, token)?;
                    sdk_gaps::dm_address(&http, address, text, idempotency_key).await?
                }
            };
            Ok(Sent::from_value(&value))
        },
    )
    .await
}

/// Answers beneath `parent` as the agent holding `token`.
pub async fn reply(
    base_url: &str,
    token: &Secret,
    parent: &str,
    text: &str,
    idempotency_key: Option<String>,
) -> relaycast::Result<Sent> {
    crate::relay::request_log::observe(
        "SDK: reply",
        base_url,
        serde_json::json!({"parent": parent}),
        token.expose(),
        async {
            let message = agent_client(base_url, token)?
                .reply(parent, text, None, idempotency_key)
                .await?;
            Ok(Sent {
                message_id: Some(message.id),
                conversation_id: None,
                to: None,
            })
        },
    )
    .await
}

/// Sends a direct message carrying uploaded files (their Relaycast ids).
pub async fn send_dm_with_attachments(
    base_url: &str,
    token: &Secret,
    endpoint: &Endpoint,
    text: &str,
    attachments: &[String],
    idempotency_key: Option<String>,
) -> relaycast::Result<Sent> {
    let recipient = match endpoint {
        Endpoint::Name(name) => ("to", name.as_str()),
        Endpoint::Address(address) => ("address", address.as_str()),
    };
    let http = sdk_gaps::http(base_url, token)?;
    let value =
        sdk_gaps::dm_with_attachments(&http, recipient, text, attachments, idempotency_key).await?;
    Ok(Sent::from_value(&value))
}

/// Posts to a channel as the agent holding `token`, optionally carrying
/// uploaded files (their Relaycast ids).
pub async fn send_channel(
    base_url: &str,
    token: &Secret,
    channel: &str,
    text: &str,
    attachments: &[String],
    idempotency_key: Option<String>,
) -> relaycast::Result<Sent> {
    crate::relay::request_log::observe(
        "SDK: send_channel",
        base_url,
        serde_json::json!({"channel": channel}),
        token.expose(),
        async {
            let message = agent_client(base_url, token)?
                .send(
                    channel,
                    text,
                    (!attachments.is_empty()).then(|| attachments.to_vec()),
                    None,
                    idempotency_key,
                )
                .await?;
            Ok(Sent {
                message_id: Some(message.id),
                conversation_id: None,
                to: None,
            })
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    /// Answers one request with `body` and status 200.
    fn relaycast_answering(body: &'static str) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut buffer = [0_u8; 4096];
            while !String::from_utf8_lossy(&request).contains("\r\n\r\n{}") {
                let read = stream.read(&mut buffer).unwrap();
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..read]);
            }
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
        });
        base_url
    }

    #[tokio::test]
    async fn a_heartbeat_relaycast_took_without_data_succeeded() {
        let base_url = relaycast_answering(r#"{"ok":true,"data":null}"#);
        let token = Secret::new("at_live_x".to_string());
        assert!(heartbeat(&base_url, &token).await.is_ok());
        let base_url =
            relaycast_answering(r#"{"ok":false,"error":{"code":"invalid","message":"refused"}}"#);
        assert!(heartbeat(&base_url, &token).await.is_err());
        let base_url = relaycast_answering(r#"{"ok":true}"#);
        assert!(heartbeat(&base_url, &token).await.is_err());
    }
}
