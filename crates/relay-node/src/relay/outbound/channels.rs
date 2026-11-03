//! Channel routes on the session socket: subscribing to a channel (joining
//! it as the calling session's agent, so its posts are delivered) and
//! replying in a channel post's thread; and the hosted-MCP word a session
//! may add when it registers itself.
//!
//! ```text
//! POST   /channels/subscribe {"channel":"swarm"}        join #swarm
//! DELETE /channels/subscribe {"channel":"swarm"}        leave it
//! POST   /send {"channel":"swarm","thread_id":"<id>","text":"…"}
//! POST   /register {"name":"api","mcp":"agent-relay-sessions"}
//! ```
//!
//! A thread reply is allowed only beneath a post this session was shown,
//! as a direct-message `reply_to` is.

use super::{
    payload, probe_socket_command, query_encode, shell_quote, Outbound, OutboundError, Purpose,
    Request,
};
use crate::relay::client;
use crate::relay::hosted_mcp::valid_declaration;
use crate::relay::session_cli::{Recipient, SessionCommand};
use crate::relay::sessions::DiscoveredSession;
use crate::relay::store::Registration;
use crate::relay::store::SessionKind;
use crate::relay::workspace::Secret;
use serde_json::{json, Map, Value};
use std::path::Path;

/// The longest channel name accepted.
const MAX_FIELD: usize = 200;

/// A channel name as a session may write it (`#swarm` or `swarm`): one
/// token without whitespace or control characters.
pub(crate) fn channel_field(value: Option<&Value>) -> Option<String> {
    let raw = value?.as_str()?.trim();
    let name = raw.strip_prefix('#').unwrap_or(raw);
    let plain = !name.is_empty()
        && name.chars().count() <= MAX_FIELD
        && !name.chars().any(|c| c.is_whitespace() || c.is_control());
    plain.then(|| name.to_string())
}

fn invalid(code: &str, message: &str) -> OutboundError {
    OutboundError::new(400, code, message)
}

/// The channel, thread and text of a channel thread reply.
fn thread_reply_fields(
    fields: &Map<String, Value>,
) -> Result<(String, String, String), OutboundError> {
    if fields.contains_key("from") {
        return Err(invalid(
            "sender_not_allowed",
            "The sender is the calling session; do not name one.",
        ));
    }
    if fields.contains_key("to") || fields.contains_key("address") {
        return Err(invalid(
            "invalid_recipient",
            "Name only the channel for a thread reply.",
        ));
    }
    if fields.contains_key("files") || fields.contains_key("reply_to") {
        return Err(invalid(
            "invalid_reply_target",
            "A channel thread reply takes \"channel\", \"thread_id\" and \"text\" only.",
        ));
    }
    let channel = channel_field(fields.get("channel"))
        .ok_or_else(|| invalid("invalid_recipient", "The channel name is invalid."))?;
    let thread = fields
        .get("thread_id")
        .and_then(Value::as_str)
        .filter(|id| crate::relay::delivery::policy::is_plain_id(id))
        .ok_or_else(|| invalid("invalid_reply_target", "The thread id is invalid."))?;
    let text = fields
        .get("text")
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
        .ok_or_else(|| invalid("invalid_text", "The message has no text."))?;
    Ok((channel, thread.to_string(), text.to_string()))
}

/// `POST /register`'s optional `mcp`: the hosted MCP's name, or `none`.
fn declared_mcp(value: Option<Value>) -> Result<Option<String>, OutboundError> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(word)) if valid_declaration(word.trim()) => Ok(Some(word.trim().into())),
        Some(_) => Err(invalid(
            "invalid_mcp",
            "mcp must be \"agent-relay-sessions\" when you have those tools, or \"none\".",
        )),
    }
}

impl Outbound {
    /// `POST /register`, keeping the session's `mcp` word on its
    /// registration, also when it was already registered.
    pub(super) async fn register_route(
        &self,
        pid: i32,
        uid: u32,
        request: &Request,
    ) -> Result<Value, OutboundError> {
        let mut fields = payload(request, Purpose::Register)?;
        let mcp = declared_mcp(fields.remove("mcp"))?;
        let mut answer = self.register(pid, uid, &fields).await?;
        let Some(mcp) = mcp else {
            return Ok(answer);
        };
        let name = answer["name"].as_str().unwrap_or_default().to_string();
        self.core
            .store
            .update(|store| {
                let found = store.registrations.iter_mut().find(|r| r.answers_to(&name));
                found.into_iter().for_each(|r| r.mcp = Some(mcp.clone()));
            })
            .map_err(|error| {
                OutboundError::new(500, "save_failed", format!("Could not save mcp. {error}"))
            })?;
        answer["mcp"] = json!(mcp);
        Ok(answer)
    }

    /// `POST /send`: a channel thread reply when both `channel` and
    /// `thread_id` are named, otherwise [`Outbound::send`].
    pub(super) async fn send_route(
        &self,
        pid: i32,
        uid: u32,
        request: &Request,
    ) -> Result<Value, OutboundError> {
        let fields = payload(request, Purpose::Send)?;
        let key = request.header("idempotency-key").map(str::to_string);
        if fields.contains_key("channel") && fields.contains_key("thread_id") {
            return self.send_thread_reply(pid, uid, &fields, key).await;
        }
        self.send(pid, uid, &fields, key).await
    }

    async fn send_thread_reply(
        &self,
        pid: i32,
        uid: u32,
        fields: &Map<String, Value>,
        key: Option<String>,
    ) -> Result<Value, OutboundError> {
        let (channel, thread, text) = thread_reply_fields(fields)?;
        let (session, registration, token) = self.authorize_sender(pid, uid).await?;
        let route = thread_route(&channel, &thread);
        if !self.core.reply_parents(&registration.name).contains(&route) {
            return Err(OutboundError::new(
                403,
                "reply_target_not_allowed",
                "No post in this thread of this channel was delivered to the calling session.",
            ));
        }
        self.admit(&session.target.key())?;
        let sent = client::reply(&registration.base_url, &token, &thread, &text, key)
            .await
            .map_err(|error| OutboundError::relaycast(&error))?;
        Ok(json!({
            "from": registration.name,
            "channel": channel,
            "thread_id": thread,
            "message_id": sent.message_id,
        }))
    }

    /// `POST /channels/subscribe` joins the channel as the calling session's
    /// agent; `DELETE` leaves it. The channel is named in the query or a
    /// JSON body.
    pub(super) async fn channel_subscription(
        &self,
        pid: i32,
        uid: u32,
        request: &Request,
    ) -> Result<Value, OutboundError> {
        let from_query = request
            .query
            .iter()
            .rev()
            .find(|(key, _)| key == "channel")
            .map(|(_, value)| Value::String(value.clone()));
        let fields = match from_query {
            Some(_) => Map::new(),
            None => payload(request, Purpose::Json)?,
        };
        let channel =
            channel_field(from_query.as_ref().or(fields.get("channel"))).ok_or_else(|| {
                invalid(
                    "invalid_channel",
                    "Name the channel: {\"channel\":\"name\"}.",
                )
            })?;
        let (session, registration, token) = self.authorize_sender(pid, uid).await?;
        self.admit(&session.target.key())?;
        let base = &registration.base_url;
        let subscribe = request.method != "DELETE";
        let result = if subscribe {
            client::join_channel(base, &token, &channel).await.map(drop)
        } else {
            client::leave_channel(base, &token, &channel).await
        };
        // The name it had before leaves once the current one is in (or on
        // leaving), never before: a failed join keeps it subscribed.
        if !subscribe || result.is_ok() {
            self.leave_as_forwarder(&registration, &channel).await;
        }
        result.map_err(|error| OutboundError::relaycast(&error))?;
        Ok(json!({"from": registration.name, "channel": channel, "subscribed": subscribe}))
    }
}

// One name per session: once renamed, everything a session sends goes out
// under its current name (the alias); the name it had before only forwards
// what was sent to it, and is never the sender.
impl Outbound {
    /// `GET /whoami`: the calling session under its one current name.
    pub async fn whoami(&self, pid: i32, uid: u32) -> Result<Value, OutboundError> {
        let session = self.identify(pid, uid).await?;
        let registration = self
            .core
            .store
            .read(|store| store.registration_for(&session.target).cloned());
        Ok(json!({
            "name": registration.as_ref().map(|r| r.display_name()),
            "address": registration.as_ref().map(|r| r.current_address(&self.core.machine_prefix)),
            "session_id": session.target.id,
            "registered": registration.is_some(),
            "mcp": registration.as_ref().and_then(|r| r.mcp.clone()),
        }))
    }

    /// The caller as it sends: its current name and that name's token.
    pub(super) async fn authorize_sender(
        &self,
        pid: i32,
        uid: u32,
    ) -> Result<(DiscoveredSession, Registration, Secret), OutboundError> {
        let (session, registration, token) = self.authorize(pid, uid).await?;
        Ok(match registration.alias_credential() {
            Some((current, alias_token)) => (session, current, alias_token),
            None => (session, registration, token),
        })
    }

    /// The tokens of every name a renamed session had before, which only
    /// forward: the registered one and each replaced alias still held.
    fn forwarder_tokens(&self, current: &Registration) -> Vec<Secret> {
        self.core.store.read(|s| {
            let Some(registered) = s.registration_answering(&current.name) else {
                return Vec::new();
            };
            let own = s
                .tokens
                .get(&registered.name)
                .filter(|_| registered.name != current.name);
            let retired = registered
                .retired_credentials()
                .filter(|(r, _)| r.name != current.name);
            own.cloned()
                .into_iter()
                .chain(retired.map(|(_, token)| token))
                .collect()
        })
    }

    /// Takes every forwarding name out of `channel` once the current one is
    /// in it (or on leaving), so each post reaches the session once.
    async fn leave_as_forwarder(&self, current: &Registration, channel: &str) {
        for token in self.forwarder_tokens(current) {
            let _ = client::leave_channel(&current.base_url, &token, channel).await;
        }
    }

    /// Posts to `channel` as `current`. A renamed session's current name may
    /// not be in a channel its earlier name joined: it joins (and the earlier
    /// name leaves), then posts once more.
    pub(super) async fn post(
        &self,
        current: &Registration,
        token: &Secret,
        channel: &str,
        text: &str,
        attachments: &[String],
        key: Option<String>,
    ) -> relaycast::Result<client::Sent> {
        let base = &current.base_url;
        match client::send_channel(base, token, channel, text, attachments, key.clone()).await {
            Err(error) if not_a_member(&error) => {
                client::join_channel(base, token, channel).await?;
                self.leave_as_forwarder(current, channel).await;
                client::send_channel(base, token, channel, text, attachments, key).await
            }
            result => result,
        }
    }
}

fn not_a_member(error: &relaycast::RelayError) -> bool {
    matches!(error, relaycast::RelayError::Api { status: 403, code, .. } if code == "not_channel_member")
}

/// One socket request as a command the session can run: the probe on macOS
/// where Apple's curl hides the session's environment and on Windows (see
/// [`super::reply_hint`]), curl elsewhere. `body` is sent as the request body.
///
/// The probe form is `session` (`session_cli`) when one serves the route,
/// which the sandbox and permission rules allow, else `relay socket-request`,
/// which asks.
pub fn socket_command(
    socket: &Path,
    method: &str,
    request_path: &str,
    body: Option<&str>,
    kind: SessionKind,
    needs_probe: bool,
    session: Option<&SessionCommand>,
) -> Option<String> {
    let path = socket.to_str()?;
    // Windows: curl cannot reach the named pipe, so every kind uses the probe.
    let required = cfg!(windows)
        || (cfg!(target_os = "macos")
            && matches!(
                kind,
                SessionKind::Codex | SessionKind::OpenCodeOpen | SessionKind::GrokOpen
            )
            && needs_probe);
    // Claude Code's permission rules from Agent Relay allow the probe's
    // client (`super::prefers_probe_client`); curl only when it is unknown.
    if required || super::prefers_probe_client(kind) {
        let probe = match (session, body) {
            (Some(session), body) => super::probe_session_command(socket, session, body),
            (None, Some(body)) => {
                super::probe_socket_command_with_body(socket, method, request_path, body)
            }
            (None, None) => probe_socket_command(socket, method, request_path),
        };
        if probe.is_some() || required {
            return probe;
        }
    }
    let url = format!("http://relay{request_path}");
    let mut parts = vec!["curl", "-s", "-X", method, "--unix-socket", path, &url];
    if let Some(body) = body {
        parts.extend(["--data-binary", body]);
    }
    Some(
        parts
            .iter()
            .map(|part| shell_quote(part))
            .collect::<Vec<_>>()
            .join(" "),
    )
}

/// The reply route a channel post opens: its thread, in its channel. A
/// direct message's route is its bare message id; this form cannot be one,
/// so a parent shown in a DM or another channel never authorises a reply
/// here. A thread id is a plain token, so the form is unambiguous.
pub fn thread_route(channel: &str, thread_id: &str) -> String {
    format!("channel/{channel}/{thread_id}")
}

/// The command that replies beneath `thread_id` in `channel`.
pub fn channel_reply_command(
    socket: &Path,
    channel: &str,
    thread_id: &str,
    kind: SessionKind,
    needs_probe: bool,
) -> Option<String> {
    let request_path = format!(
        "/send?channel={}&thread_id={}",
        query_encode(channel),
        query_encode(thread_id)
    );
    let reply = SessionCommand::Send {
        recipient: Recipient::Channel(channel.to_string()),
        reply_to: None,
        thread: Some(thread_id.to_string()),
    };
    socket_command(
        socket,
        "POST",
        &request_path,
        Some("your reply"),
        kind,
        needs_probe,
        Some(&reply),
    )
}

/// The command that subscribes to `channel`, or with `subscribe` false
/// unsubscribes from it.
pub fn channel_subscription_command(
    socket: &Path,
    channel: &str,
    subscribe: bool,
    kind: SessionKind,
    needs_probe: bool,
) -> Option<String> {
    let method = if subscribe { "POST" } else { "DELETE" };
    let request_path = format!("/channels/subscribe?channel={}", query_encode(channel));
    let session = SessionCommand::SubscribeChannel {
        channel: channel.to_string(),
        remove: !subscribe,
    };
    socket_command(
        socket,
        method,
        &request_path,
        None,
        kind,
        needs_probe,
        Some(&session),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn the_mcp_word_is_the_hosted_server_or_none() {
        assert_eq!(declared_mcp(None).unwrap(), None);
        assert_eq!(declared_mcp(Some(Value::Null)).unwrap(), None);
        assert_eq!(
            declared_mcp(Some(json!(" agent-relay-sessions ")))
                .unwrap()
                .as_deref(),
            Some("agent-relay-sessions")
        );
        assert_eq!(
            declared_mcp(Some(json!("none"))).unwrap().as_deref(),
            Some("none")
        );
        assert_eq!(
            declared_mcp(Some(json!("relay"))).unwrap_err().code,
            "invalid_mcp"
        );
        assert_eq!(
            declared_mcp(Some(json!(true))).unwrap_err().code,
            "invalid_mcp"
        );
    }

    #[test]
    fn channel_names_drop_the_hash_and_refuse_whitespace() {
        assert_eq!(channel_field(Some(&json!("#swarm"))), Some("swarm".into()));
        assert_eq!(channel_field(Some(&json!(" swarm "))), Some("swarm".into()));
        assert_eq!(channel_field(Some(&json!("two words"))), None);
        assert_eq!(channel_field(Some(&json!("#"))), None);
        assert_eq!(channel_field(Some(&json!(7))), None);
        assert_eq!(channel_field(None), None);
    }

    #[test]
    fn a_thread_reply_names_only_channel_thread_and_text() {
        let fields = |value: Value| value.as_object().unwrap().clone();
        let ok = thread_reply_fields(&fields(
            json!({"channel": "#swarm", "thread_id": "123", "text": "on it"}),
        ))
        .unwrap();
        assert_eq!(ok, ("swarm".into(), "123".into(), "on it".into()));
        for (body, code) in [
            (
                json!({"channel": "s", "thread_id": "1", "text": "x", "to": "a"}),
                "invalid_recipient",
            ),
            (
                json!({"channel": "s", "thread_id": "1", "text": "x", "files": []}),
                "invalid_reply_target",
            ),
            (
                json!({"channel": "s", "thread_id": "", "text": "x"}),
                "invalid_reply_target",
            ),
            (
                json!({"channel": "s", "thread_id": " 12", "text": "x"}),
                "invalid_reply_target",
            ),
            (
                json!({"channel": "s", "thread_id": "1 2", "text": "x"}),
                "invalid_reply_target",
            ),
            (
                json!({"channel": "s", "thread_id": "12\n", "text": "x"}),
                "invalid_reply_target",
            ),
            (
                json!({"channel": "s", "thread_id": "../x", "text": "x"}),
                "invalid_reply_target",
            ),
            (
                json!({"channel": "s", "thread_id": "1", "text": " "}),
                "invalid_text",
            ),
            (
                json!({"channel": "s", "thread_id": "1", "text": "x", "from": "me"}),
                "sender_not_allowed",
            ),
        ] {
            assert_eq!(thread_reply_fields(&fields(body)).unwrap_err().code, code);
        }
    }

    // The curl form; Windows hands sessions the probe client instead.
    #[cfg(not(windows))]
    #[test]
    fn commands_quote_and_encode_the_channel_and_thread() {
        let socket = PathBuf::from("/run/user/1000/agent-relay/relay.sock");
        let reply =
            channel_reply_command(&socket, "swarm", "123", SessionKind::Codex, false).unwrap();
        assert_eq!(
            reply,
            "curl -s -X POST --unix-socket /run/user/1000/agent-relay/relay.sock \
             'http://relay/send?channel=swarm&thread_id=123' --data-binary 'your reply'"
        );
        let leave =
            channel_subscription_command(&socket, "a b", false, SessionKind::Codex, false).unwrap();
        assert_eq!(
            leave,
            "curl -s -X DELETE --unix-socket /run/user/1000/agent-relay/relay.sock \
             'http://relay/channels/subscribe?channel=a%20b'"
        );
    }
}
