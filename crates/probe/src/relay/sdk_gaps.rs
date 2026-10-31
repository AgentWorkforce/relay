//! Relaycast surface the published `relaycast` SDK (8.0.1) does not cover
//! the way the desktop needs it. Everything else goes through the SDK; each
//! item here is listed in `docs/relay-core.md` as needing upstream support
//! and is deleted once the SDK has it. Every HTTP call here still goes
//! through the SDK's own `HttpClient`, so auth, envelopes, retries and
//! errors are the SDK's.
//!
//! - `POST /v1/agent/node-token` has no public method.
//! - `GET /v1/workspace`: `Workspace` requires `api_key_hash`, which the
//!   deployed server no longer sends, so the SDK cannot read the answer and
//!   the workspace is never verified.
//! - The direct node socket (`/v1/node/ws`): the SDK's `WsClient` acks every
//!   `deliver` frame on the socket as it arrives. `delivery.ack` there is
//!   terminal, and the desktop acknowledges a delivery over HTTP only after
//!   it is in the session, so an early ack could lose a message. The SDK
//!   also omits `machine_id` from `node.register` (the endpoint's machine
//!   address), heartbeats every 30 s where Relaycast's direct-node liveness
//!   needs 15 s, reports `Open` before the registration reply, and cannot
//!   send `origin_surface`.
//! - `POST /v1/agents`: `CreateAgentRequest` has no `direct_machine_prefix`
//!   or `auto_join_general`.
//! - `GET /v1/agents` and `GET /v1/agents/{name}`: `Agent` has no `address`.
//! - `GET /v1/deliveries`: `DeliveryMessage` has no `agent_address` or
//!   `metadata` (the relayfile path), and requires fields older servers omit.
//! - `POST /v1/agents/{name}/subscription-channel` and
//!   `POST /v1/integrations/relayfile/inbound-target` have no methods.
//! - The SDK's event-subscription filter serializes absent members as `null`,
//!   which the deployed server rejects; the compatible request omits them.
//! - `POST /v1/dm` to an exact address: `SendDmRequest` has no `address`.
//! - `GET /v1/files/{id}`: `FileInfo` has no `download_url` or `status`, and
//!   requires fields the answer omits; the upload request and completion
//!   are read leniently for the same reason.
//! - `GET /v1/dm/conversations`: participants are flattened to names, losing
//!   the immutable `agent_id` exact-address proof needs.
//! - `GET /v1/dm/{id}/messages` and `GET /v1/messages/{id}`:
//!   `MessageWithMeta` has no `agent_address` or `thread_id`.
//! - `RelayCast` and `AgentClient` cannot set the origin client and version;
//!   the clients here send `relay-desktop` and the desktop's version.

use crate::relay::diagnostic_http::HttpClient;
use crate::relay::workspace::Secret;
use futures_util::{SinkExt, StreamExt};
use relaycast::types::DirectNodeToken;
use relaycast::{AgentClient, ClientOptions, RelayError, RequestOptions};
use serde_json::{json, Map, Value};
use tokio::net::TcpStream;
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};

/// Seconds between `node.heartbeat` frames on a direct node socket.
pub const NODE_HEARTBEAT_SECONDS: u64 = 15;

/// Mints a direct node token for the agent `agent` authenticates as.
pub async fn mint_node_token(agent: &AgentClient) -> relaycast::Result<DirectNodeToken> {
    crate::relay::request_log::observe(
        "POST",
        &format!("{}/v1/agent/node-token", agent.http_client().base_url()),
        json!({}),
        "",
        agent
            .http_client()
            .post("/v1/agent/node-token", Some(json!({})), None),
    )
    .await
}

/// An SDK HTTP client for `credential` (a workspace key or an agent token)
/// at a validated origin, sending the desktop's origin metadata.
pub fn http(base_url: &str, credential: &Secret) -> relaycast::Result<HttpClient> {
    HttpClient::new(
        ClientOptions::new(credential.expose())
            .with_base_url(base_url)
            .with_origin("relay-desktop", crate::VERSION),
    )
}

/// The workspace a key belongs to: `GET /v1/workspace`, read leniently, as
/// the SDK's `Workspace` requires fields the server stopped sending.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkspaceIdentity {
    pub id: String,
    pub name: String,
    /// The workspace's Relaycast plan, when the server sends one.
    pub plan: Option<String>,
}

/// `GET /v1/workspace` with the workspace key. Only `id`, `name` and `plan`
/// are read; the answer must carry `id` and `name` as non-empty strings.
pub async fn workspace_identity(workspace: &HttpClient) -> relaycast::Result<WorkspaceIdentity> {
    let data: Value = workspace.get("/v1/workspace", None, None).await?;
    workspace_identity_of(&data)
}

fn workspace_identity_of(data: &Value) -> relaycast::Result<WorkspaceIdentity> {
    let field = |key: &str| {
        data.get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .ok_or_else(|| RelayError::InvalidResponse(format!("workspace without {key}")))
    };
    Ok(WorkspaceIdentity {
        id: field("id")?,
        name: field("name")?,
        plan: field("plan").ok().map(|plan| plan.to_lowercase()),
    })
}

/// A registered agent and its token.
#[derive(Clone, Debug)]
pub struct RegisteredAgent {
    pub id: String,
    pub name: String,
    pub token: Secret,
}

/// `POST /v1/agents` with the workspace key. The agent joins #general only
/// when `joining.general` (the `auto_join_general` setting): otherwise it
/// exists to be addressed, not to follow channel traffic.
pub async fn register_agent(
    workspace: &HttpClient,
    name: &str,
    joining: crate::relay::client::Joining<'_>,
    metadata: Map<String, Value>,
) -> relaycast::Result<RegisteredAgent> {
    let data: Value = workspace
        .post(
            "/v1/agents",
            Some(json!({
                "name": name,
                "type": "agent",
                "direct_machine_prefix": joining.machine_prefix,
                "auto_join_general": joining.general,
                "metadata": metadata,
            })),
            None,
        )
        .await?;
    let field = |key: &str| {
        data[key]
            .as_str()
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .ok_or_else(|| RelayError::InvalidResponse("unreadable agent registration".into()))
    };
    Ok(RegisteredAgent {
        id: field("id")?,
        name: field("name")?,
        token: Secret::new(field("token")?),
    })
}

/// `GET /v1/agents?status=` with the workspace key, as raw entries (the
/// SDK's `Agent` drops `address`).
pub async fn list_agents(workspace: &HttpClient, status: &str) -> relaycast::Result<Vec<Value>> {
    let data: Value = workspace
        .get("/v1/agents", Some(&[("status", status)]), None)
        .await?;
    array(data, "agent list")
}

/// `GET /v1/agents/{name}` with the workspace key, raw (with its
/// `pending_deliveries`); `None` when no agent has the name.
pub async fn get_agent(workspace: &HttpClient, name: &str) -> relaycast::Result<Option<Value>> {
    match workspace
        .get::<Value>(&format!("/v1/agents/{}", segment(name)), None, None)
        .await
    {
        Ok(agent) => Ok(Some(agent)),
        Err(error @ RelayError::Api { status: 404, .. }) => match error.code() {
            Some("agent_not_found") | None => Ok(None),
            Some(_) => Err(error),
        },
        Err(error) => Err(error),
    }
}

/// `GET /v1/nodes/{name}` with the workspace key: the id of the node
/// holding `name` in the key's workspace; `None` when no node holds it.
pub async fn node_id_named(
    workspace: &HttpClient,
    name: &str,
) -> relaycast::Result<Option<String>> {
    match workspace
        .get::<Value>(&format!("/v1/nodes/{}", segment(name)), None, None)
        .await
    {
        Ok(node) => node["id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .map(|id| Some(id.to_string()))
            .ok_or_else(|| RelayError::InvalidResponse("node without id".into())),
        Err(error @ RelayError::Api { status: 404, .. }) => match error.code() {
            Some("node_not_found") | None => Ok(None),
            Some(_) => Err(error),
        },
        Err(error) => Err(error),
    }
}

/// `GET /v1/deliveries?limit=` with an agent token, as raw queue items.
pub async fn deliveries(agent: &HttpClient, limit: u32) -> relaycast::Result<Vec<Value>> {
    let limit = limit.to_string();
    let data: Value = agent
        .get("/v1/deliveries", Some(&[("limit", limit.as_str())]), None)
        .await?;
    array(data, "delivery list")
}

/// The owner-authorized, single-member integration channel of an agent.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SubscriptionChannel {
    pub id: String,
    pub name: String,
}

/// `POST /v1/agents/{name}/subscription-channel` with the workspace key.
/// The answer must name `agent-events-<agent id>` with `name` as its only
/// member; anything else is refused.
pub async fn subscription_channel(
    workspace: &HttpClient,
    name: &str,
    agent_id: &str,
) -> relaycast::Result<SubscriptionChannel> {
    let data: Value = workspace
        .post(
            &format!("/v1/agents/{}/subscription-channel", segment(name)),
            None::<Value>,
            None,
        )
        .await?;
    verified_subscription_channel(&data, name, agent_id).ok_or_else(|| {
        RelayError::InvalidResponse("integration channel membership did not verify".into())
    })
}

pub fn verified_subscription_channel(
    data: &Value,
    name: &str,
    agent_id: &str,
) -> Option<SubscriptionChannel> {
    let id = data["id"].as_str().filter(|id| !id.is_empty())?;
    let channel = data["name"].as_str()?;
    let members = data["members"].as_array()?;
    let verified = channel == format!("agent-events-{agent_id}")
        && members.len() == 1
        && members[0]["agent_name"] == name;
    verified.then(|| SubscriptionChannel {
        id: id.into(),
        name: channel.into(),
    })
}

/// Where relayfile posts provider events for a channel, and its secret.
#[derive(Clone, Debug)]
pub struct InboundTarget {
    pub url: String,
    pub secret: Secret,
}

/// The two fields cleanup needs from Relaycast's webhook list. The published
/// SDK currently expects newer channel fields that older/deployed Relaycast
/// responses omit, so cleanup deliberately reads the compatible raw shape.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ListedWebhook {
    pub id: String,
    pub name: String,
}

pub async fn list_webhooks(workspace: &HttpClient) -> relaycast::Result<Vec<ListedWebhook>> {
    let data: Value = workspace.get("/v1/webhooks", None, None).await?;
    array(data, "webhook list")?
        .into_iter()
        .map(|row| match (row["id"].as_str(), row["name"].as_str()) {
            (Some(id), Some(name)) if !id.is_empty() => Ok(ListedWebhook {
                id: id.into(),
                name: name.into(),
            }),
            _ => Err(RelayError::InvalidResponse(
                "unreadable webhook list entry".into(),
            )),
        })
        .collect()
}

/// `POST /v1/integrations/relayfile/inbound-target` with the workspace key.
pub async fn relayfile_inbound_target(
    workspace: &HttpClient,
    channel: &str,
    provider: &str,
    path_glob: &str,
) -> relaycast::Result<InboundTarget> {
    let data: Value = workspace
        .post(
            "/v1/integrations/relayfile/inbound-target",
            Some(json!({"channel": channel, "provider": provider, "path_glob": path_glob})),
            None,
        )
        .await?;
    match (data["url"].as_str(), data["secret"].as_str()) {
        (Some(url), Some(secret)) if !url.is_empty() && !secret.is_empty() => Ok(InboundTarget {
            url: url.into(),
            secret: Secret::new(secret),
        }),
        _ => Err(RelayError::InvalidResponse(
            "unreadable inbound target".into(),
        )),
    }
}

/// Creates the outbound `thread.reply` subscription used for provider
/// writeback. The SDK serializes `mentions: None` as `"mentions": null`, while
/// Relaycast accepts only a string or an omitted member, so write the minimal
/// compatible filter and read only the id cleanup needs.
pub async fn create_reply_subscription(
    workspace: &HttpClient,
    channel: &str,
    url: &str,
    secret: &Secret,
) -> relaycast::Result<String> {
    let data: Value = workspace
        .post(
            "/v1/subscriptions",
            Some(json!({
                "events": ["thread.reply"],
                "filter": {"channel": channel},
                "url": url,
                "secret": secret.expose(),
            })),
            None,
        )
        .await?;
    data["id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .ok_or_else(|| RelayError::InvalidResponse("unreadable event subscription".into()))
}

/// `POST /v1/dm` to an exact `agent@machine` address with an agent token.
pub async fn dm_address(
    agent: &HttpClient,
    address: &str,
    text: &str,
    idempotency_key: Option<String>,
) -> relaycast::Result<Value> {
    agent
        .post(
            "/v1/dm",
            Some(json!({"address": address, "text": text})),
            idempotency_key.map(RequestOptions::with_idempotency_key),
        )
        .await
}

/// `POST /v1/dm` by name or exact address, carrying uploaded files.
pub async fn dm_with_attachments(
    agent: &HttpClient,
    recipient: (&str, &str),
    text: &str,
    attachments: &[String],
    idempotency_key: Option<String>,
) -> relaycast::Result<Value> {
    let (field, value) = recipient;
    agent
        .post(
            "/v1/dm",
            Some(json!({(field): value, "text": text, "attachments": attachments})),
            idempotency_key.map(RequestOptions::with_idempotency_key),
        )
        .await
}

/// `GET /v1/files/{id}`, raw: the SDK's `FileInfo` has no `download_url`
/// or `status`.
pub async fn file_info(agent: &HttpClient, file_id: &str) -> relaycast::Result<Value> {
    agent
        .get(&format!("/v1/files/{}", segment(file_id)), None, None)
        .await
}

/// `POST /v1/files/upload`: `{file_id, upload_url, …}`.
pub async fn request_upload(
    agent: &HttpClient,
    filename: &str,
    content_type: &str,
    size_bytes: u64,
) -> relaycast::Result<Value> {
    agent
        .post(
            "/v1/files/upload",
            Some(json!({"filename": filename, "content_type": content_type,
                "size_bytes": size_bytes})),
            None,
        )
        .await
}

/// `POST /v1/files/{id}/complete`, read leniently.
pub async fn complete_upload(agent: &HttpClient, file_id: &str) -> relaycast::Result<Value> {
    agent
        .post(
            &format!("/v1/files/{}/complete", segment(file_id)),
            Some(json!({})),
            None,
        )
        .await
}

/// `GET /v1/dm/conversations` with an agent token, unflattened. No limit:
/// Relaycast then answers with every agent-visible conversation, and the
/// endpoint has no cursor, so a bounded first page would hide older ones.
pub async fn dm_conversations(agent: &HttpClient) -> relaycast::Result<Vec<Value>> {
    let data: Value = agent.get("/v1/dm/conversations", None, None).await?;
    array(data, "conversation list")
}

/// `GET /v1/dm/{id}/messages?limit=&before=` with an agent token, newest
/// first, as raw messages.
pub async fn dm_messages(
    agent: &HttpClient,
    conversation_id: &str,
    limit: u32,
    before: Option<&str>,
) -> relaycast::Result<Vec<Value>> {
    let limit = limit.to_string();
    let mut query = vec![("limit", limit.as_str())];
    if let Some(before) = before {
        query.push(("before", before));
    }
    let data: Value = agent
        .get(
            &format!("/v1/dm/{}/messages", segment(conversation_id)),
            Some(&query),
            None,
        )
        .await?;
    array(data, "message list")
}

/// `GET /v1/messages/{id}` with an agent token, raw: the single-message
/// endpoint keeps `thread_id`, which DM history omits.
pub async fn message(agent: &HttpClient, id: &str) -> relaycast::Result<Value> {
    agent
        .get(&format!("/v1/messages/{}", segment(id)), None, None)
        .await
}

fn array(data: Value, what: &str) -> relaycast::Result<Vec<Value>> {
    match data {
        Value::Array(items) => Ok(items),
        _ => Err(RelayError::InvalidResponse(format!("unreadable {what}"))),
    }
}

/// `value` as one path segment.
pub fn segment(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes())
        .collect::<String>()
        .replace('+', "%20")
}

/// `{ws|wss}://host/v1/node/ws?token=…&origin_surface=desktop&…` for an
/// already validated origin.
pub fn node_socket_url(base_url: &str, node_token: &str, version: &str) -> String {
    node_socket(base_url, Some(node_token), version)
}

/// `{ws|wss}://host/v1/node/ws?origin_surface=desktop&…`: the spawn node's
/// socket, whose token goes in the `Authorization` header instead.
pub fn broker_node_socket_url(base_url: &str, version: &str) -> String {
    node_socket(base_url, None, version)
}

fn node_socket(base_url: &str, node_token: Option<&str>, version: &str) -> String {
    let (scheme, host) = match base_url.split_once("://") {
        Some(("http", host)) => ("ws", host),
        Some((_, host)) => ("wss", host),
        None => ("wss", base_url),
    };
    let socket = format!("{scheme}://{}/v1/node/ws", host.trim_end_matches('/'));
    // A validated origin always forms a URL; anything else is returned as
    // it is, for the connection to refuse, rather than stopping the core.
    let Ok(mut url) = url::Url::parse(&socket) else {
        return socket;
    };
    {
        let mut query = url.query_pairs_mut();
        if let Some(token) = node_token {
            query.append_pair("token", token);
        }
        query
            .append_pair("origin_surface", "desktop")
            .append_pair("origin_client", "relay-desktop")
            .append_pair("origin_version", version);
    }
    url.into()
}

/// The first frame on a direct node socket.
pub fn register_frame(node: &DirectNodeToken, version: &str, machine_id: &str) -> Value {
    json!({
        "v": 1,
        "id": format!("register-{}", node.node_id),
        "type": "node.register",
        "node_id": node.node_id,
        "name": node.node_name,
        "machine_id": machine_id,
        "capabilities": [],
        "max_agents": 1,
        "tags": ["implicit", "direct", "sdk"],
        "version": format!("relay-desktop/{version}"),
        "resume_cursor": null,
    })
}

/// The application-level keepalive; there is no WebSocket ping.
pub fn heartbeat_frame(node: &DirectNodeToken, version: &str) -> Value {
    json!({
        "v": 1,
        "type": "node.heartbeat",
        "load": null,
        "active_agents": 1,
        "handlers_live": false,
        "node_id": node.node_id,
        "name": node.node_name,
        "capabilities": [],
        "max_agents": 1,
        "version": format!("relay-desktop/{version}"),
    })
}

/// The agent id a direct node id carries (`node_direct_<agent id>`).
pub fn agent_id_of_node(node_id: &str) -> &str {
    node_id.strip_prefix("node_direct_").unwrap_or(node_id)
}

/// Whether a frame is Relaycast's accepting reply to this socket's
/// `node.register` (a reply echoes the request `id`).
pub fn is_register_reply(frame: &Value) -> bool {
    frame["type"] == "reply"
        && frame["ok"] != false
        && frame["id"]
            .as_str()
            .is_some_and(|id| id.starts_with("register-"))
}

pub type NodeSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Opens the socket and sends `node.register`. The caller drives the rest.
pub async fn open_node_socket(
    base_url: &str,
    node: &DirectNodeToken,
    version: &str,
    machine_id: &str,
) -> Result<NodeSocket, tokio_tungstenite::tungstenite::Error> {
    let (mut socket, _) = connect_async(node_socket_url(base_url, &node.token, version)).await?;
    send_frame(&mut socket, &register_frame(node, version, machine_id)).await?;
    Ok(socket)
}

pub async fn send_frame(
    socket: &mut NodeSocket,
    frame: &Value,
) -> Result<(), tokio_tungstenite::tungstenite::Error> {
    socket.send(Message::Text(frame.to_string())).await
}

/// The next JSON text frame, `None` when the socket ended. Pings are
/// answered by the transport; binary and malformed frames are skipped.
pub async fn next_frame(
    socket: &mut NodeSocket,
) -> Option<Result<Value, tokio_tungstenite::tungstenite::Error>> {
    loop {
        match socket.next().await? {
            Ok(Message::Text(text)) => {
                if let Ok(value) = serde_json::from_str::<Value>(&text) {
                    return Some(Ok(value));
                }
            }
            Ok(Message::Close(_)) => return None,
            Ok(_) => {}
            Err(error) => return Some(Err(error)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_workspace_is_read_without_the_fields_the_server_dropped() {
        let answer = json!({
            "id": "rw_7ccfea89", "name": "rw_7ccfea89", "plan": "enterprise", "system_prompt": null,
            "created_at": "2026-06-27T12:15:16.000Z", "metadata": {"cloud_workspace_id": "x"},
            "effective_retention": {}, "usage_classification": "unknown"
        });
        assert_eq!(
            workspace_identity_of(&answer).unwrap(),
            WorkspaceIdentity {
                id: "rw_7ccfea89".into(),
                name: "rw_7ccfea89".into(),
                plan: Some("enterprise".into()),
            }
        );
        for broken in [
            json!({"name": "n"}),
            json!({"id": "", "name": "n"}),
            json!({"id": "rw_1", "name": 4}),
            json!([]),
        ] {
            assert!(matches!(
                workspace_identity_of(&broken),
                Err(RelayError::InvalidResponse(_))
            ));
        }
    }

    fn node() -> DirectNodeToken {
        DirectNodeToken {
            node_id: "node_direct_agent-1".into(),
            node_name: "desk".into(),
            token: "nt_live_x".into(),
        }
    }

    #[test]
    fn socket_url_and_frames() {
        assert_eq!(
            node_socket_url("https://cast.agentrelay.com", "nt_live_a b", "1.2"),
            "wss://cast.agentrelay.com/v1/node/ws?token=nt_live_a+b&origin_surface=desktop&origin_client=relay-desktop&origin_version=1.2"
        );
        assert!(node_socket_url("http://localhost:8787", "t", "1")
            .starts_with("ws://localhost:8787/v1/node/ws?"));
        let origin = crate::relay::workspace::validated_base_url("https://[2001:db8::1]").unwrap();
        assert!(node_socket_url(&origin, "t", "1").starts_with("wss://[2001:db8::1]/v1/node/ws?"));

        let register = register_frame(&node(), "1", "desk-agent-1");
        assert_eq!(register["type"], "node.register");
        assert_eq!(register["id"], "register-node_direct_agent-1");
        assert_eq!(register["machine_id"], "desk-agent-1");
        assert_eq!(register["version"], "relay-desktop/1");
        assert_eq!(register["resume_cursor"], Value::Null);

        let heartbeat = heartbeat_frame(&node(), "1");
        assert_eq!(heartbeat["type"], "node.heartbeat");
        assert_eq!(heartbeat["handlers_live"], false);
        assert_eq!(heartbeat["node_id"], "node_direct_agent-1");
        assert_eq!(agent_id_of_node("node_direct_agent-1"), "agent-1");
    }

    #[test]
    fn only_the_registration_reply_marks_a_socket_live() {
        assert!(is_register_reply(
            &json!({"type":"reply","id":"register-node_direct_a","ok":true})
        ));
        assert!(!is_register_reply(
            &json!({"type":"reply","id":"register-node_direct_a","ok":false})
        ));
        assert!(!is_register_reply(&json!({"type":"reply","id":"other"})));
        assert!(!is_register_reply(
            &json!({"type":"deliver","id":"register-x"})
        ));
    }
}
