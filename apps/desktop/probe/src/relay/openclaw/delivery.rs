//! Delivery into OpenClaw: a session per relay sender (or the main session
//! for a trusted one), history-checked sends, and the limits on a relay
//! sender's session where the Gateway can set them.
use super::answer::{marker, run_cap_ms, running, turn_at, LastRun};
use super::*;
// ---------------------------------------------------------------------------
// Delivery

/// The agent's main session, where a trusted sender's messages go.
pub fn main_session_key(agent: &str) -> String {
    format!("agent:{agent}:main")
}

/// The session a delivery goes to on `agent`: one per channel, else one
/// per sender, stable across the sender's renames and separate per relay
/// workspace.
/// How far back a send looks for the delivery's own turn before treating it
/// as new: the most `chat.history` returns. The Gateway forgets idempotency
/// keys on restart, so this window is what keeps a retry from repeating a
/// turn.
pub(super) const HISTORY_LIMIT: u32 = 1000;

pub fn session_key(agent: &str, workspace_id: &str, route: &DeliveryRoute<'_>) -> String {
    let (kind, who) = conversation(route);
    let digest = hex(&Sha256::digest(
        format!("{workspace_id}\0{kind}\0{who}").as_bytes(),
    ));
    format!(
        "agent:{agent}:relay:{kind}:{}-{}",
        slug(who, 32),
        &digest[..12]
    )
}

/// Which conversation a delivery belongs to: a channel (`#<id>`), else its
/// sender's address (its name only when Relaycast gave no address). Never
/// the display name alone, so a rename keeps the conversation.
pub fn conversation<'a>(route: &DeliveryRoute<'a>) -> (&'static str, &'a str) {
    match route.channel_id.filter(|_| route.reason != Some("dm")) {
        Some(channel) => ("channel", channel),
        None => (
            "dm",
            route.sender_address.or(route.sender).unwrap_or("unknown"),
        ),
    }
}

pub(super) fn slug(value: &str, max: usize) -> String {
    let mut out = String::new();
    for c in value.chars() {
        let c = c.to_ascii_lowercase();
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
        if out.len() >= max {
            break;
        }
    }
    let out = out.trim_end_matches('-').to_string();
    if out.is_empty() {
        "peer".into()
    } else {
        out
    }
}

/// Which session and run a delivery went to, kept until its answer is read.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct Sent {
    pub(super) agent: String,
    pub(super) session_key: String,
    pub(super) run_id: String,
    /// The delivery's attribution line, which finds its turn on a Gateway
    /// that does not mark user turns (before 2026.5.26).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) marker: Option<String>,
    /// When it was last sent, for a Gateway that cannot say whether its run
    /// is still going (before 2026.5.2).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) sent_at_ms: Option<u64>,
}

pub(super) fn sent_path(config: &OpenClawConfig, agent: &str, message_ref: &str) -> PathBuf {
    let name = hex(&Sha256::digest(
        format!("{agent}\0{message_ref}").as_bytes(),
    ));
    config.answers_dir().join(format!("{}.json", &name[..32]))
}

pub(super) fn remember(
    config: &OpenClawConfig,
    sent: &Sent,
    message_id: &str,
) -> Result<(), String> {
    let bytes = serde_json::to_vec(sent).map_err(|e| e.to_string())?;
    crate::relay::mailbox::write_private(
        &sent_path(config, &sent.agent, &MessageRef::of(message_id)),
        &bytes,
    )
}

pub(super) fn remembered(config: &OpenClawConfig, agent: &str, message_ref: &str) -> Option<Sent> {
    let bytes = std::fs::read(sent_path(config, agent, message_ref)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// The last run this core started in a session.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct SessionRun {
    pub(super) run_id: String,
    pub(super) sent_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) marker: Option<String>,
}

fn session_run_path(config: &OpenClawConfig, key: &str) -> PathBuf {
    let name = hex(&Sha256::digest(key.as_bytes()));
    config
        .data_dir
        .join("sessions")
        .join(format!("{}.json", &name[..32]))
}

/// Records `run` as the session's last, or forgets it with `None`.
pub(super) fn record_session_run(
    config: &OpenClawConfig,
    key: &str,
    run: Option<&SessionRun>,
) -> Result<(), String> {
    let path = session_run_path(config, key);
    match run {
        Some(run) => {
            let bytes = serde_json::to_vec(run).map_err(|e| e.to_string())?;
            crate::relay::mailbox::write_private(&path, &bytes)
        }
        None => match std::fs::remove_file(&path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        },
    }
}

pub(super) fn session_run(config: &OpenClawConfig, key: &str) -> Option<SessionRun> {
    let bytes = std::fs::read(session_run_path(config, key)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Delivers `text` to `agent`, in the session `route` selects.
///
/// The delivery id is the idempotency key. A resend after a lost response
/// is the same run while the Gateway runs; across a Gateway restart the
/// session's history shows the turn already arrived, so it is not sent
/// twice.
pub fn send(
    config: &OpenClawConfig,
    agent: &str,
    workspace_id: &str,
    route: &DeliveryRoute<'_>,
    text: &str,
) -> InjectOutcome {
    if let Some(reason) = platform::unsupported("OpenClaw") {
        return InjectOutcome::Refused(reason);
    }
    if !is_agent_id(agent) {
        return InjectOutcome::Refused("This is not an OpenClaw agent id.".into());
    }
    let gateway = match gateway(config) {
        Ok(gateway) => gateway,
        Err(reason) => return InjectOutcome::Waiting(reason.reason()),
    };
    let mut connection = match Connection::open(config, &gateway) {
        Ok(connection) => connection,
        Err(error) => return waiting(error),
    };
    let sent = match destination(config, agent, workspace_id, route, text) {
        Ok(sent) => sent,
        Err(error) => return InjectOutcome::Retry(error),
    };
    if let Some(outcome) = before(&mut connection, config, agent, &sent, text) {
        return outcome;
    }
    // The main session keeps the person's own settings: never limited here.
    if sent.session_key != main_session_key(agent) {
        if let Some(refused) = limit(&mut connection, config, agent, &sent.session_key, route) {
            return refused;
        }
    }
    deliver(&mut connection, config, sent, route, text)
}

/// The session the delivery goes to. A trusted sender is the person: their
/// message goes to the agent's main session, with its own context, memory
/// and tools. Decided once and recorded before the first send (so the
/// answer can be found even when the response is lost); a retry goes to the
/// recorded session even if the trusted senders changed meanwhile.
fn destination(
    config: &OpenClawConfig,
    agent: &str,
    workspace_id: &str,
    route: &DeliveryRoute<'_>,
    text: &str,
) -> Result<Sent, String> {
    let pinned = remembered(config, agent, &MessageRef::of(route.message_id))
        .filter(|sent| sent.run_id == route.delivery_id);
    if let Some(sent) = pinned {
        return Ok(sent);
    }
    let session_key = if config.trusts(route) {
        main_session_key(agent)
    } else {
        session_key(agent, workspace_id, route)
    };
    let sent = Sent {
        agent: agent.to_string(),
        session_key,
        run_id: route.delivery_id.to_string(),
        marker: marker(text),
        sent_at_ms: Some(features::now_ms()),
    };
    remember(config, &sent, route.message_id)?;
    Ok(sent)
}

/// What the session's history says before the delivery is sent: `None`
/// when it should be sent now.
///
/// The delivery's turn already in the session is never sent again: the
/// Gateway keeps its idempotency only in memory, so after a restart the
/// history is the only record. A session still running an earlier turn
/// waits until that turn ends, since a message sent now would be merged
/// into it or answered under another run.
fn before(
    connection: &mut Connection,
    config: &OpenClawConfig,
    agent: &str,
    sent: &Sent,
    text: &str,
) -> Option<InjectOutcome> {
    // A session that does not exist yet has no history to read. Only fields
    // every supported Gateway knows: `chat.history` is a closed schema, and
    // one unknown field would fail it and skip both checks below.
    let history = match connection.call(
        "chat.history",
        json!({ "sessionKey": sent.session_key, "limit": HISTORY_LIMIT }),
    ) {
        Ok(history) => history,
        Err(GatewayError::Rejected { .. }) => return None,
        Err(error) => return Some(waiting(error)),
    };
    let features = connection.features.clone();
    let marker = marker(text);
    if turn_at(&history, &sent.run_id, marker.as_deref(), &features).is_some() {
        return Some(InjectOutcome::Delivered);
    }
    let last = session_run(config, &sent.session_key);
    // The session's last run is this very delivery, its response lost: sent
    // again under the same key, a Gateway still running it says so instead
    // of starting it twice, and one that restarted runs it once.
    if last.as_ref().is_some_and(|last| last.run_id == sent.run_id) {
        return None;
    }
    let last = last.as_ref().map(|last| LastRun {
        run_id: &last.run_id,
        sent_at_ms: last.sent_at_ms,
        marker: last.marker.as_deref(),
    });
    let cap_ms = run_cap_ms(config, &connection.features);
    match running(
        connection,
        (agent, &sent.session_key),
        &history,
        last,
        cap_ms,
    ) {
        Ok(false) => None,
        Ok(true) => Some(InjectOutcome::Waiting(
            "OpenClaw is still answering this sender's previous message.".into(),
        )),
        Err(error) => Some(waiting(error)),
    }
}

/// The relay's limits on the sender's session, restated on every send:
/// `sessions.create` makes the session or adopts it, applying the
/// permission mode either way, and `sessions.patch` sets the tool limits,
/// which `sessions.create` takes only for a new session.
///
/// A Gateway older than 2026.8.1 has neither, so the sender's session has
/// the agent's usual tools (Settings says so), and `chat.send` makes it.
fn limit(
    connection: &mut Connection,
    config: &OpenClawConfig,
    agent: &str,
    key: &str,
    route: &DeliveryRoute<'_>,
) -> Option<InjectOutcome> {
    if !connection.features.session_limits {
        return None;
    }
    let params = session_params(config, key, agent, route);
    let mut create = json!({
        "key": key,
        "agentId": agent,
        "permissionMode": params["permissionMode"],
    });
    if connection.features.display_name {
        create["displayName"] = params["displayName"].clone();
    }
    let patch = json!({ "key": key, "toolOverrides": params["toolOverrides"] });
    for (method, request) in [("sessions.create", create), ("sessions.patch", patch)] {
        match connection.call(method, request) {
            Ok(_) => {}
            Err(GatewayError::Rejected { code, message }) => {
                return Some(InjectOutcome::Refused(format!(
                    "OpenClaw would not limit this sender's session ({code}): {message}"
                )))
            }
            Err(error) => return Some(waiting(error)),
        }
    }
    None
}

/// `chat.send`, recording when, for a Gateway that can only be asked about
/// a run by its id.
fn deliver(
    connection: &mut Connection,
    config: &OpenClawConfig,
    sent: Sent,
    route: &DeliveryRoute<'_>,
    text: &str,
) -> InjectOutcome {
    let now = features::now_ms();
    let sent = Sent {
        sent_at_ms: Some(now),
        ..sent
    };
    let run = SessionRun {
        run_id: sent.run_id.clone(),
        sent_at_ms: now,
        marker: sent.marker.clone(),
    };
    let previous = session_run(config, &sent.session_key);
    let recorded = remember(config, &sent, route.message_id)
        .and_then(|()| record_session_run(config, &sent.session_key, Some(&run)));
    if let Err(error) = recorded {
        return InjectOutcome::Retry(error);
    }
    let mut params = json!({
        "sessionKey": sent.session_key,
        "message": text,
        "idempotencyKey": route.delivery_id,
        "deliver": false,
    });
    // A peer's `/status` or `/model` is text, not a command, on any line
    // (from 2026.6.5; before, the attribution line keeps it off the first).
    if connection.features.suppress_commands {
        params["suppressCommandInterpretation"] = Value::Bool(true);
    }
    let outcome = connection.call("chat.send", params);
    // A send that certainly started no run must not leave the session
    // looking busy to a Gateway that can only be asked by run id; one that
    // may have started it keeps the record.
    if matches!(
        outcome,
        Err(GatewayError::Unreachable | GatewayError::Busy | GatewayError::Rejected { .. })
    ) {
        let _ = record_session_run(config, &sent.session_key, previous.as_ref());
    }
    match outcome {
        Ok(_) => InjectOutcome::Delivered,
        Err(GatewayError::Unreachable) => {
            InjectOutcome::Retry("OpenClaw's Gateway closed the connection.".into())
        }
        Err(GatewayError::Busy) => InjectOutcome::Retry("OpenClaw's Gateway is busy.".into()),
        // The next attempt reads the history first, so it never runs twice.
        Err(GatewayError::NoResponse) => {
            InjectOutcome::Accepted("OpenClaw has not confirmed the message yet.".into())
        }
        Err(GatewayError::Rejected { code, message }) => {
            InjectOutcome::Refused(format!("OpenClaw refused the message ({code}): {message}"))
        }
    }
}

/// The MCP servers in `openclaw.json` an answer-only relay session must not
/// reach: every GBrain but the relay's reader (the bundle plugin's
/// `gbrain`, an HTTP `gbrain serve` named `gbrain_rw`, …), and Agent
/// Relay's own MCP, which could spawn agents or message others as the
/// person: by its name, or by its address whatever it is called.
pub(super) fn owner_servers(config: &OpenClawConfig) -> Vec<String> {
    let mut servers = vec![GBRAIN_SERVER.to_string()];
    let file = std::fs::read_to_string(&config.config_path)
        .ok()
        .and_then(|text| json5::from_str::<Value>(&text).ok());
    if let Some(listed) = file
        .as_ref()
        .and_then(|file| file["mcp"]["servers"].as_object())
    {
        for (name, server) in listed {
            let lower = name.to_ascii_lowercase().replace('-', "_");
            let owner = (lower.contains("gbrain") && name != RELAY_BRAIN_SERVER)
                || lower.contains("agent_relay")
                || lower.contains("agentrelay")
                || server["url"]
                    .as_str()
                    .is_some_and(super::relay_tools::is_relay_mcp_url);
            if owner && !servers.contains(name) {
                servers.push(name.clone());
            }
        }
    }
    servers
}

/// A relay sender's session: answer-only on this computer (OpenClaw's
/// `read-only` mode: no command execution, no writes), with the person's own
/// GBrain servers and Agent Relay's MCP off, so only the scoped GBrain
/// reader can be used.
pub(super) fn session_params(
    config: &OpenClawConfig,
    key: &str,
    agent: &str,
    route: &DeliveryRoute<'_>,
) -> Value {
    let servers: serde_json::Map<String, Value> = owner_servers(config)
        .into_iter()
        .map(|server| (server, Value::Bool(false)))
        .collect();
    json!({
        "key": key,
        "agentId": agent,
        "displayName": display_name(route),
        "permissionMode": RELAY_PERMISSION_MODE,
        "toolOverrides": { "mcpServers": servers },
    })
}

pub(super) fn display_name(route: &DeliveryRoute<'_>) -> String {
    match (route.channel_id, route.sender) {
        (Some(channel), _) if route.reason != Some("dm") => format!("Agent Relay · #{channel}"),
        (_, Some(sender)) => format!("Agent Relay · {sender}"),
        _ => "Agent Relay".into(),
    }
}

pub(super) fn waiting(error: GatewayError) -> InjectOutcome {
    InjectOutcome::Waiting(match error {
        GatewayError::Unreachable | GatewayError::NoResponse => Unavailable::NotRunning.reason(),
        GatewayError::Busy => "OpenClaw's Gateway is starting.".into(),
        GatewayError::Rejected { code, message } => {
            Unavailable::Refused(format!("{code}: {message}")).reason()
        }
    })
}
