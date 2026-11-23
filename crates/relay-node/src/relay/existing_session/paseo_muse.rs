//! Delivery into a Muse session Paseo is driving with `muse serve`.
//!
//! That process is not in Muse's runtime registry, so a courier's
//! `send_session_message` comes back `target_not_found` and the text never
//! renders. Paseo's local daemon already holds the MSP connection. It
//! exposes `send_agent_prompt` on its loopback MCP endpoint. The receipt is
//! a `turn_queue_submit` that was not already in the serve session's log
//! when the POST started, and whose prompt equals the text that was sent.
//!
//! Paseo has no queue for a caller outside its own agents: through v0.11.4
//! the daemon replaces a running turn, and from v0.12.0 a top-level
//! `send_agent_prompt` interrupts it unless the caller asks to steer. So the
//! courier first asks `get_agent_status` on the same endpoint and posts the
//! prompt only when the agent is not in a turn (`idle`, or `error` after a
//! failed turn). Any other status, including one this build does not know,
//! waits: nothing is sent, the journal claim is deleted, and a later
//! attempt asks again. A status call that fails, times out, or cannot be
//! read sent nothing either, so it is retried and never in doubt.
//!
//! A small race remains: the agent can start a turn between the status
//! answer and the prompt, and that turn is then interrupted as before. The
//! daemon offers an outside caller no way to close it, and this route does
//! not pose as one of Paseo's agents to get a queue.
//!
//! A JSON-RPC error on the prompt call, or a failure before the connection
//! exists, deletes the journal claim so a later attempt can send. A
//! timeout, a reset, a body that cannot be read, or a tool-level error
//! (`isError`, `success: false`) may already have queued the prompt: Paseo
//! reports a run that did not start in time, or a provider that failed to
//! start it, as a tool error after dispatching the prompt. The claim stays,
//! the log can still confirm it, and the attempt is never sent again. A `401`
//! on either call means the daemon has a password and Agent Relay holds
//! none: the delivery is refused with that reason, and no credential is
//! looked for.
//!
//! One attempt blocks for at most `STATUS_TIMEOUT` plus `PROMPT_TIMEOUT`
//! (80 s), and the courier route's 120 s delivery window still bounds the
//! wait for the receipt that follows.

use super::muse_open::{Courier, Forwarded, Receipts};
use super::Failure;
use crate::relay::muse::{session_log, MuseConfig};
use crate::relay::process::{ProcessTable, MAX_ANCESTRY};
use serde_json::Value;
use std::collections::BTreeSet;
use std::io::Read;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const DEFAULT_PORT: u16 = 6767;
const MCP_PATH: &str = "/mcp/agents";
const MAX_BODY: usize = 256 * 1024;
/// `get_agent_status` reads the daemon's in-memory snapshot (or the stored
/// record) and starts nothing, so a short wait is enough.
const STATUS_TIMEOUT: Duration = Duration::from_secs(5);
/// A top-level `send_agent_prompt` returns only once the provider has
/// started the turn, and Paseo waits up to 60 s for that
/// (`AGENT_RUN_START_TIMEOUT_MS` in its `agent-prompt.ts`, v0.11.4 through
/// v0.17.3; v0.11.4 waits the same way with `background: true`). 75 s lets
/// Paseo answer before this side gives up. Its own run-start timeout comes
/// back as a tool error after the prompt was dispatched, so that answer, as
/// well as this timeout, leaves the attempt to the session log: delivered
/// if the command appears, otherwise in doubt and never sent again.
const PROMPT_TIMEOUT: Duration = Duration::from_secs(75);

/// What a person reads when the daemon answers `401`.
pub const PASSWORD_REFUSAL: &str =
    "The Paseo daemon has a password set and Agent Relay holds none, so it refused this message.";
/// What a person reads while the message waits for Muse's turn to end.
pub const WAITING_FOR_TURN: &str =
    "Muse is working in Paseo; this message waits until its turn ends.";

/// The loopback MCP URL for this Paseo daemon.
///
/// `listen_override` is `PASEO_LISTEN` from the serve process or a same-user
/// ancestor. It wins over `daemon.listen` in `paseo_home`'s `config.json`.
/// Either value is used only when it is loopback or a wildcard bind. IPv6
/// loopback and the IPv6 wildcard connect to `[::1]`; IPv4 loopback,
/// `localhost`, and `0.0.0.0` connect to `127.0.0.1`. Anything else,
/// including a missing file, uses `127.0.0.1:6767`. A prompt is never sent
/// off this machine.
pub fn agents_endpoint(paseo_home: Option<&Path>, listen_override: Option<&str>) -> String {
    listen_override
        .and_then(loopback_url)
        .or_else(|| {
            paseo_home
                .and_then(configured_listen)
                .as_deref()
                .and_then(loopback_url)
        })
        .unwrap_or_else(|| format!("http://127.0.0.1:{DEFAULT_PORT}{MCP_PATH}"))
}

/// `PASEO_LISTEN` on `pid`, or on a same-user ancestor when the serve
/// process does not have it. Paseo uses that variable to override
/// `daemon.listen`. A desktop launch strips the daemon's environment, so
/// `None` means the caller should read `config.json`. An empty value is
/// skipped.
pub fn listen_of(table: &dyn ProcessTable, pid: i32) -> Option<String> {
    let uid = table.process(pid)?.uid;
    let mut current = pid;
    for _ in 0..MAX_ANCESTRY {
        let Some(process) = table.process(current).filter(|process| process.uid == uid) else {
            return None;
        };
        if let Some(value) = table.environment_var(current, "PASEO_LISTEN") {
            let value = value.trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
        if process.parent <= 1 || process.parent == current {
            return None;
        }
        current = process.parent;
    }
    None
}

fn configured_listen(home: &Path) -> Option<String> {
    let text = std::fs::read_to_string(home.join("config.json")).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    value
        .pointer("/daemon/listen")
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn loopback_url(listen: &str) -> Option<String> {
    let listen = listen.trim();
    let (host, port) = listen.rsplit_once(':')?;
    let host = host.trim().trim_matches(['[', ']']);
    let port: u16 = port.trim().parse().ok()?;
    if port == 0 {
        return None;
    }
    let host = match host {
        "127.0.0.1" | "localhost" | "0.0.0.0" => "127.0.0.1",
        "::" | "::1" => "[::1]",
        _ => return None,
    };
    Some(format!("http://{host}:{port}{MCP_PATH}"))
}

/// Whether `endpoint` is the agents MCP route on `127.0.0.1` or `[::1]`.
/// The poster refuses every other URL, so a forged host never receives the
/// prompt. A process on this machine can still bind the loopback port
/// first: HTTP success is not delivery, and no token is invented. The
/// daemon credential would not prove which process answered, and that
/// process can already read the session log.
fn loopback_agents(endpoint: &str) -> bool {
    if endpoint.contains(['@', '?', '#', ' ']) {
        return false;
    }
    let Some(authority) = endpoint.strip_prefix("http://") else {
        return false;
    };
    let Some((host_port, path)) = authority.split_once('/') else {
        return false;
    };
    if path != "mcp/agents" {
        return false;
    }
    let port = if let Some(port) = host_port.strip_prefix("[::1]:") {
        port
    } else if let Some(port) = host_port.strip_prefix("127.0.0.1:") {
        port
    } else {
        return false;
    };
    port.parse::<u16>().ok().is_some_and(|port| port != 0)
}

/// What one POST of `send_agent_prompt` did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Posted {
    /// The daemon answered. `body` is missing when it was oversized, not
    /// UTF-8, or the read failed after the status line.
    Answered { status: u16, body: Option<String> },
    /// The prompt did not leave this process.
    Unsent,
    /// The prompt may already be queued. A second POST would be a second turn.
    Uncertain,
}

/// Which call is being made, so the client can give each its own timeout.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Call {
    /// `get_agent_status`: reads state, sends nothing.
    Status,
    /// `send_agent_prompt`: may start a turn.
    Prompt,
}

/// Posts one JSON-RPC body and classifies the result. `Unsent` is a URL
/// this process refused or a connection that never opened. `Uncertain` is
/// a timeout, a reset, or a body that could not be read: ureq reports the
/// first two as `Io`. An auth challenge is an answered `401`. This route
/// does not invent a token.
pub trait Mcp: Send + Sync {
    fn call(&self, endpoint: &str, body: &str, call: Call) -> Posted;
}

pub struct UreqMcp {
    status_timeout: Duration,
    prompt_timeout: Duration,
}

impl Default for UreqMcp {
    fn default() -> Self {
        Self {
            status_timeout: STATUS_TIMEOUT,
            prompt_timeout: PROMPT_TIMEOUT,
        }
    }
}

impl Mcp for UreqMcp {
    fn call(&self, endpoint: &str, body: &str, call: Call) -> Posted {
        if !loopback_agents(endpoint) {
            return Posted::Unsent;
        }
        let timeout = match call {
            Call::Status => self.status_timeout,
            Call::Prompt => self.prompt_timeout,
        };
        let agent = ureq::AgentBuilder::new()
            .redirects(0)
            .try_proxy_from_env(false)
            .timeout(timeout)
            .timeout_connect(timeout.min(STATUS_TIMEOUT))
            .timeout_read(timeout)
            .timeout_write(timeout)
            .build();
        match agent
            .post(endpoint)
            .set("Content-Type", "application/json")
            .set("Accept", "application/json, text/event-stream")
            .send_string(body)
        {
            Ok(response) => answered(response.status(), response),
            Err(ureq::Error::Status(status, response)) => answered(status, response),
            Err(ureq::Error::Transport(transport)) => transport_posted(transport.kind()),
        }
    }
}

fn answered(status: u16, response: ureq::Response) -> Posted {
    Posted::Answered {
        status,
        body: read_body(response),
    }
}

fn read_body(response: ureq::Response) -> Option<String> {
    let mut bytes = Vec::new();
    if response
        .into_reader()
        .take((MAX_BODY + 1) as u64)
        .read_to_end(&mut bytes)
        .is_err()
        || bytes.len() > MAX_BODY
    {
        return None;
    }
    String::from_utf8(bytes).ok()
}

/// A connection that never opened can be retried. `Io` covers a timeout and
/// a connection that dropped after the POST may have been written.
fn transport_posted(kind: ureq::ErrorKind) -> Posted {
    match kind {
        ureq::ErrorKind::InvalidUrl
        | ureq::ErrorKind::UnknownScheme
        | ureq::ErrorKind::Dns
        | ureq::ErrorKind::InsecureRequestHttpsOnly
        | ureq::ErrorKind::ConnectionFailed
        | ureq::ErrorKind::InvalidProxyUrl
        | ureq::ErrorKind::ProxyConnect
        | ureq::ErrorKind::ProxyUnauthorized => Posted::Unsent,
        ureq::ErrorKind::Io
        | ureq::ErrorKind::BadHeader
        | ureq::ErrorKind::BadStatus
        | ureq::ErrorKind::TooManyRedirects
        | ureq::ErrorKind::HTTP => Posted::Uncertain,
    }
}

/// Command ids of this prompt that were already in the log. `Unreadable`
/// means the snapshot failed, so a later line must not confirm the send:
/// it might be the older identical prompt.
enum Snapshot {
    Unreadable,
    Prior(BTreeSet<String>),
}

struct Attempt {
    prior: Mutex<Snapshot>,
}

impl Attempt {
    fn new() -> Self {
        Self {
            prior: Mutex::new(Snapshot::Unreadable),
        }
    }
}

/// One Paseo agent. `forward` asks the daemon for the agent's status and
/// posts the prompt only when no turn is running; the session log confirms
/// it. `release` does nothing: there is no courier process. The receipts
/// share `attempt`, so only a command id that appears after the snapshot
/// can confirm the POST.
pub struct PaseoCourier<T: Mcp> {
    agent_id: String,
    endpoint: String,
    mcp: T,
    store: MuseConfig,
    attempt: Arc<Attempt>,
}

impl PaseoCourier<UreqMcp> {
    pub fn system(agent_id: String, endpoint: String, store: MuseConfig) -> (Self, PaseoReceipts) {
        Self::new(agent_id, endpoint, UreqMcp::default(), store)
    }
}

impl<T: Mcp> PaseoCourier<T> {
    pub fn new(
        agent_id: String,
        endpoint: String,
        mcp: T,
        store: MuseConfig,
    ) -> (Self, PaseoReceipts) {
        let attempt = Arc::new(Attempt::new());
        let receipts = PaseoReceipts {
            config: store.clone(),
            attempt: Arc::clone(&attempt),
        };
        (
            Self {
                agent_id,
                endpoint,
                mcp,
                store,
                attempt,
            },
            receipts,
        )
    }
}

impl<T: Mcp> Courier for PaseoCourier<T> {
    fn forward(&self, _workspace: &Path, target_session: &str, text: &str) -> Forwarded {
        // Refuse before the snapshot. Nothing was sent, so the claim can
        // be deleted and a later attempt can try a loopback URL.
        if !loopback_agents(&self.endpoint) {
            return Forwarded::Unavailable;
        }
        let status = self.mcp.call(
            &self.endpoint,
            &status_request(&self.agent_id),
            Call::Status,
        );
        match turn_of(&status) {
            Turn::Free => {}
            // Nothing was sent: the claim is deleted and a later attempt
            // asks again.
            Turn::Busy => return Forwarded::Busy,
            Turn::Unknown => return Forwarded::Unavailable,
            Turn::Locked => return Forwarded::Refused(Failure::AuthenticationUnavailable),
        }
        self.note_prior(target_session, text);
        let body = prompt_request(&self.agent_id, text);
        match taken(&self.mcp.call(&self.endpoint, &body, Call::Prompt)) {
            Taken::Maybe => Forwarded::Sent {
                // The receipt is the session log, not a courier session.
                courier_session: self.agent_id.clone(),
            },
            Taken::No => Forwarded::Unavailable,
            Taken::Locked => Forwarded::Refused(Failure::AuthenticationUnavailable),
        }
    }
}

/// What `get_agent_status` said about the agent's turn.
#[derive(Debug, PartialEq, Eq)]
enum Turn {
    /// Not in a turn: the prompt starts one and interrupts nothing.
    Free,
    /// In a turn, starting up, closed, or a status this build does not know.
    Busy,
    /// No usable answer. Nothing was sent.
    Unknown,
    /// `401`: the daemon has a password and this route holds none.
    Locked,
}

/// Paseo's lifecycle statuses are `initializing`, `idle`, `running`,
/// `error` and `closed` (`AgentStatusEnum`, v0.11.4 through v0.17.3). Its
/// own busy set is `initializing` and `running`. `error` is set when a turn
/// ends with an error and no turn is active, so a prompt starts a new turn.
/// `closed` waits: a prompt would make Paseo load the agent again rather
/// than reach the serve process whose log is the receipt.
fn turn_of(posted: &Posted) -> Turn {
    match posted {
        Posted::Unsent | Posted::Uncertain => Turn::Unknown,
        Posted::Answered { status: 401, .. } => Turn::Locked,
        Posted::Answered {
            status: 200..=299,
            body: Some(body),
        } => match agent_status(body).as_deref() {
            Some("idle" | "error") => Turn::Free,
            Some(_) => Turn::Busy,
            None => Turn::Unknown,
        },
        Posted::Answered { .. } => Turn::Unknown,
    }
}

/// The `status` of a `get_agent_status` result, from `structuredContent`
/// or from a JSON text item. `None` for an error, `isError`, or a body
/// without one.
fn agent_status(body: &str) -> Option<String> {
    let mut found = None;
    for message in mcp_messages(body) {
        if message.get("error").is_some() {
            return None;
        }
        let Some(result) = message.get("result") else {
            continue;
        };
        if result.get("isError").and_then(Value::as_bool) == Some(true) {
            return None;
        }
        if let Some(status) = result
            .pointer("/structuredContent/status")
            .and_then(Value::as_str)
        {
            found = Some(status.to_string());
            continue;
        }
        let texts = result
            .get("content")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|item| item.get("text").and_then(Value::as_str))
            .filter_map(|text| serde_json::from_str::<Value>(text).ok());
        for parsed in texts {
            if let Some(status) = parsed.get("status").and_then(Value::as_str) {
                found = Some(status.to_string());
            }
        }
    }
    found
}

/// The `get_agent_status` call.
pub fn status_request(agent_id: &str) -> String {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": "get_agent_status",
            "arguments": {"agentId": agent_id}
        }
    })
    .to_string()
}

/// Whether the prompt POST may have queued the prompt.
#[derive(Debug, PartialEq, Eq)]
enum Taken {
    Maybe,
    No,
    Locked,
}

fn taken(posted: &Posted) -> Taken {
    match posted {
        Posted::Unsent => Taken::No,
        // The request may have been written. Keep the claim and let the log
        // confirm it, or leave the attempt in doubt.
        Posted::Uncertain => Taken::Maybe,
        // 401 is the daemon asking for a password. The prompt was not taken.
        Posted::Answered { status: 401, .. } => Taken::Locked,
        Posted::Answered { body, .. } => {
            if body.as_deref().is_some_and(handler_never_ran) {
                Taken::No
            } else {
                Taken::Maybe
            }
        }
    }
}

/// Whether a `send_agent_prompt` answer proves the tool handler never ran:
/// a JSON-RPC `error` member. A tool-level failure (`isError: true`, or
/// `success: false`) does not. The MCP SDK Paseo uses turns every throw
/// inside `tools/call` into an `isError` result, and Paseo's handler
/// throws after it has dispatched the prompt when the run does not start
/// within its 60 s (`waitForAgentRunStartWithTimeout`), or when the
/// provider fails to start it. Only the error text tells those apart from
/// a refusal before dispatch, so every tool-level failure may have queued
/// the prompt and is left to the session log.
fn handler_never_ran(body: &str) -> bool {
    mcp_messages(body)
        .iter()
        .any(|message| message.get("error").is_some())
}

/// The `send_agent_prompt` call. Paseo through v0.11.4 reads `background`:
/// true returns once the turn has started instead of when it ends. From
/// v0.12.0 the field is gone from the tool's input schema, and unknown
/// keys are not refused there, so it is ignored. `activeTurnBehavior` is
/// left out: the status check above is what keeps a running turn whole.
pub fn prompt_request(agent_id: &str, prompt: &str) -> String {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": "send_agent_prompt",
            "arguments": {
                "agentId": agent_id,
                "prompt": prompt,
                "background": true
            }
        }
    })
    .to_string()
}

/// Whether `body` is an MCP result that reports the prompt was queued.
/// A JSON-RPC error, `isError`, or `success: false` does not report it. A
/// result without a success flag may have. This reads the answer only: the
/// resend decision is `handler_never_ran`, and the session log confirms.
pub fn prompt_accepted(body: &str) -> bool {
    matches!(verdict(body), Verdict::Accepted)
}

enum Verdict {
    Accepted,
    Rejected,
    /// Empty, unparseable, or an answer that neither accepts nor refuses.
    /// The POST already happened, so this must not be sent again.
    Unclear,
}

fn verdict(body: &str) -> Verdict {
    let messages = mcp_messages(body);
    if messages.is_empty() {
        return Verdict::Unclear;
    }
    let mut accepted = false;
    for message in &messages {
        if message.get("error").is_some() {
            return Verdict::Rejected;
        }
        let Some(result) = message.get("result") else {
            continue;
        };
        if result.get("isError").and_then(Value::as_bool) == Some(true) {
            return Verdict::Rejected;
        }
        match success_of(result) {
            Some(false) => return Verdict::Rejected,
            Some(true) | None => accepted = true,
        }
    }
    if accepted {
        Verdict::Accepted
    } else {
        Verdict::Unclear
    }
}

fn mcp_messages(body: &str) -> Vec<Value> {
    let data_lines: Vec<&str> = body
        .lines()
        .filter_map(|line| line.strip_prefix("data:"))
        .map(str::trim)
        .filter(|data| !data.is_empty() && *data != "[DONE]")
        .collect();
    if !data_lines.is_empty() {
        return data_lines
            .into_iter()
            .filter_map(|data| serde_json::from_str(data).ok())
            .collect();
    }
    serde_json::from_str(body.trim()).into_iter().collect()
}

fn success_of(result: &Value) -> Option<bool> {
    let structured = result
        .pointer("/structuredContent/success")
        .and_then(Value::as_bool);
    let mut from_text = None;
    if let Some(content) = result.get("content").and_then(Value::as_array) {
        for item in content {
            let Some(text) = item.get("text").and_then(Value::as_str) else {
                continue;
            };
            let Ok(parsed) = serde_json::from_str::<Value>(text) else {
                continue;
            };
            if let Some(flag) = parsed.get("success").and_then(Value::as_bool) {
                from_text = Some(flag);
            }
        }
    }
    match (structured, from_text) {
        (Some(false), _) | (_, Some(false)) => Some(false),
        (Some(true), _) | (_, Some(true)) => Some(true),
        _ => None,
    }
}

impl<T: Mcp> PaseoCourier<T> {
    fn note_prior(&self, session: &str, text: &str) {
        let snapshot = prior_ids(&self.store, session, text);
        if let Ok(mut prior) = self.attempt.prior.lock() {
            *prior = snapshot;
        }
    }
}

fn prior_ids(config: &MuseConfig, session: &str, text: &str) -> Snapshot {
    let Some(path) = session_log(config, session) else {
        return Snapshot::Prior(BTreeSet::new());
    };
    match std::fs::read_to_string(path) {
        Ok(data) => Snapshot::Prior(matching_commands(&data, text).into_iter().collect()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Snapshot::Prior(BTreeSet::new())
        }
        Err(_) => Snapshot::Unreadable,
    }
}

/// Reads `turn_queue_submit` receipts from the serve session's own log.
pub struct PaseoReceipts {
    config: MuseConfig,
    attempt: Arc<Attempt>,
}

impl Receipts for PaseoReceipts {
    fn admitted(
        &self,
        target_session: &str,
        _courier_session: &str,
        text: &str,
        _since: Instant,
    ) -> Option<String> {
        // A snapshot that was not taken, or could not be read, must not
        // fall back to the whole log. An older identical prompt would
        // confirm a POST that may not have landed.
        let Ok(prior) = self.attempt.prior.lock() else {
            return None;
        };
        let Snapshot::Prior(ids) = &*prior else {
            return None;
        };
        let path = session_log(&self.config, target_session)?;
        let data = std::fs::read_to_string(path).ok()?;
        matching_commands(&data, text)
            .into_iter()
            .filter(|id| !ids.contains(id))
            .last()
    }
}

/// The command id of a received `turn_queue_submit` whose `prompt` or
/// `display_prompt` equals `text` once both are trimmed. The last match
/// wins. An id the journal cannot store is ignored.
pub fn queued_command(log: &str, text: &str) -> Option<String> {
    matching_commands(log, text).pop()
}

fn matching_commands(log: &str, text: &str) -> Vec<String> {
    let want = text.trim();
    if want.is_empty() {
        return Vec::new();
    }
    let mut found = Vec::new();
    for line in log.lines() {
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let payload = &record["payload"];
        if payload["kind"] != "command_intake" {
            continue;
        }
        let record = &payload["record"];
        if record["kind"] != "received" || record["command"]["kind"] != "turn_queue_submit" {
            continue;
        }
        let body = &record["command"]["payload"];
        let matches = |value: &Value| value.as_str().is_some_and(|prompt| prompt.trim() == want);
        if !matches(&body["prompt"]) && !matches(&body["display_prompt"]) {
            continue;
        }
        if let Some(id) = record["command_id"].as_str().filter(|id| receipt_id(id)) {
            found.push(id.to_string());
        }
    }
    found
}

fn receipt_id(value: &str) -> bool {
    (1..=256).contains(&value.len()) && value.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
}

#[cfg(test)]
#[cfg(unix)]
mod test_http;

#[cfg(test)]
#[cfg(unix)]
mod tests {
    use super::test_http::read_request;
    use super::*;
    use crate::relay::existing_session::muse_open::{deliver, Target};
    use crate::relay::existing_session::Outcome;
    use crate::relay::process::{FakeProcess, FakeProcesses};
    use std::io::Write;
    use std::path::PathBuf;

    const AGENT: &str = "985e1c26-4093-4f09-bf5c-55dff601bffc";
    const SESSION: &str = "01a12ccd-3805-74f1-baee-2ddf6648fc23";
    const COMMAND: &str = "01a12ccd-3904-7936-91c0-285d6f3cbf18";
    const OLDER: &str = "01a12ccd-0000-7000-8000-000000000001";

    fn accepted_sse() -> String {
        format!(
            "event: message\ndata: {}\n\n",
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": 1,
                "result": {
                    "content": [{"type": "text", "text": "{\"success\":true,\"status\":\"idle\"}"}],
                    "structuredContent": {"success": true, "status": "idle"},
                    "isError": false
                }
            })
        )
    }

    fn accepted() -> Posted {
        Posted::Answered {
            status: 200,
            body: Some(accepted_sse()),
        }
    }

    #[test]
    fn an_sse_success_is_accepted_and_a_failure_is_not() {
        assert!(prompt_accepted(&accepted_sse()));
        assert!(prompt_accepted(
            &serde_json::json!({"jsonrpc":"2.0","id":1,"result":{"content":[]}}).to_string()
        ));
        assert!(!prompt_accepted(
            &serde_json::json!({"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"no"}})
                .to_string()
        ));
        assert!(!prompt_accepted(
            &serde_json::json!({"jsonrpc":"2.0","id":1,"result":{"isError":true,"content":[{"type":"text","text":"no"}]}}).to_string()
        ));
        let denied = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "result": {"structuredContent": {"success": false, "status": "error"}}
        });
        assert!(!prompt_accepted(&format!("data: {denied}\n")));
        assert!(!prompt_accepted("not json"));
        assert!(!prompt_accepted(""));
        assert!(matches!(verdict("not json"), Verdict::Unclear));
        assert!(matches!(verdict(""), Verdict::Unclear));
    }

    #[test]
    fn the_prompt_body_names_the_agent_and_returns_immediately() {
        let body: Value = serde_json::from_str(&prompt_request(AGENT, "please ack")).unwrap();
        assert_eq!(body["method"], "tools/call");
        assert_eq!(body["params"]["name"], "send_agent_prompt");
        assert_eq!(body["params"]["arguments"]["agentId"], AGENT);
        assert_eq!(body["params"]["arguments"]["prompt"], "please ack");
        assert_eq!(body["params"]["arguments"]["background"], true);
    }

    #[test]
    fn a_timeout_is_uncertain_and_a_refused_connection_is_unsent() {
        assert_eq!(transport_posted(ureq::ErrorKind::Io), Posted::Uncertain);
        assert_eq!(
            transport_posted(ureq::ErrorKind::ConnectionFailed),
            Posted::Unsent
        );
        assert_eq!(transport_posted(ureq::ErrorKind::Dns), Posted::Unsent);
        assert_eq!(
            transport_posted(ureq::ErrorKind::InvalidUrl),
            Posted::Unsent
        );
        assert_eq!(
            transport_posted(ureq::ErrorKind::BadHeader),
            Posted::Uncertain
        );
    }

    #[test]
    fn the_daemon_port_comes_from_a_loopback_listen_address() {
        let temp = tempfile::tempdir().unwrap();
        assert_eq!(
            agents_endpoint(Some(temp.path()), None),
            "http://127.0.0.1:6767/mcp/agents"
        );
        std::fs::write(
            temp.path().join("config.json"),
            r#"{"daemon":{"listen":"127.0.0.1:6799"}}"#,
        )
        .unwrap();
        assert_eq!(
            agents_endpoint(Some(temp.path()), None),
            "http://127.0.0.1:6799/mcp/agents"
        );
        std::fs::write(
            temp.path().join("config.json"),
            r#"{"daemon":{"listen":"0.0.0.0:6801"}}"#,
        )
        .unwrap();
        assert_eq!(
            agents_endpoint(Some(temp.path()), None),
            "http://127.0.0.1:6801/mcp/agents"
        );
        std::fs::write(
            temp.path().join("config.json"),
            r#"{"daemon":{"listen":"[::1]:6799"}}"#,
        )
        .unwrap();
        assert_eq!(
            agents_endpoint(Some(temp.path()), None),
            "http://[::1]:6799/mcp/agents"
        );
        std::fs::write(
            temp.path().join("config.json"),
            r#"{"daemon":{"listen":"[::]:6802"}}"#,
        )
        .unwrap();
        assert_eq!(
            agents_endpoint(Some(temp.path()), None),
            "http://[::1]:6802/mcp/agents"
        );
        std::fs::write(
            temp.path().join("config.json"),
            r#"{"daemon":{"listen":"192.0.2.10:6799"}}"#,
        )
        .unwrap();
        assert_eq!(
            agents_endpoint(Some(temp.path()), None),
            "http://127.0.0.1:6767/mcp/agents"
        );
        assert_eq!(
            agents_endpoint(None, None),
            "http://127.0.0.1:6767/mcp/agents"
        );
        // `PASEO_LISTEN` wins. An override that is not loopback falls back
        // to the file, which is currently a non-loopback address, then 6767.
        std::fs::write(
            temp.path().join("config.json"),
            r#"{"daemon":{"listen":"127.0.0.1:6799"}}"#,
        )
        .unwrap();
        assert_eq!(
            agents_endpoint(Some(temp.path()), Some("[::1]:6810")),
            "http://[::1]:6810/mcp/agents"
        );
        assert_eq!(
            agents_endpoint(Some(temp.path()), Some("::")),
            "http://127.0.0.1:6799/mcp/agents"
        );
        assert_eq!(
            agents_endpoint(Some(temp.path()), Some("192.0.2.10:6811")),
            "http://127.0.0.1:6799/mcp/agents"
        );
        assert_eq!(
            agents_endpoint(None, Some("localhost:6812")),
            "http://127.0.0.1:6812/mcp/agents"
        );
    }

    #[test]
    fn paseo_listen_comes_from_the_serve_process_or_its_daemon_parent() {
        let table = FakeProcesses::default();
        table.insert(10, process(1, Some("127.0.0.1:7000")));
        assert_eq!(listen_of(&table, 10).as_deref(), Some("127.0.0.1:7000"));
        table.insert(11, process(10, None));
        assert_eq!(listen_of(&table, 11).as_deref(), Some("127.0.0.1:7000"));
        table.insert(12, process(10, Some("  ")));
        assert_eq!(listen_of(&table, 12).as_deref(), Some("127.0.0.1:7000"));
        table.insert(13, process(10, Some("[::1]:7001")));
        assert_eq!(listen_of(&table, 13).as_deref(), Some("[::1]:7001"));
        table.insert(14, process(1, None));
        assert_eq!(listen_of(&table, 14), None);
        let mut other = process(1, Some("127.0.0.1:7002"));
        other.uid = 0;
        table.insert(15, other);
        table.insert(16, process(15, None));
        assert_eq!(listen_of(&table, 16), None);
    }

    fn process(parent: i32, listen: Option<&str>) -> FakeProcess {
        let mut environment = std::collections::HashMap::new();
        if let Some(listen) = listen {
            environment.insert("PASEO_LISTEN".to_string(), listen.to_string());
        }
        FakeProcess {
            parent,
            uid: 501,
            environment,
            ..FakeProcess::default()
        }
    }

    fn intake(prompt: &str, display: &str, command_id: &str) -> String {
        serde_json::json!({
            "payload": {
                "kind": "command_intake",
                "record": {
                    "kind": "received",
                    "command_id": command_id,
                    "command": {
                        "kind": "turn_queue_submit",
                        "payload": {"prompt": prompt, "display_prompt": display}
                    }
                }
            }
        })
        .to_string()
    }

    #[test]
    fn a_queued_prompt_is_the_receipt_and_a_different_prompt_is_not() {
        let log = format!(
            "{}\n{}\n",
            intake("other", "other", OLDER),
            intake("  please ack  ", "short", COMMAND),
        );
        assert_eq!(queued_command(&log, "please ack").as_deref(), Some(COMMAND));
        assert_eq!(queued_command(&log, "short").as_deref(), Some(COMMAND));
        assert_eq!(queued_command(&log, "missing"), None);
        let unstorable = intake("please ack", "please ack", "has a space");
        assert_eq!(queued_command(&unstorable, "please ack"), None);
        let mut prior = BTreeSet::new();
        prior.insert(OLDER.to_string());
        let both = format!(
            "{}\n{}\n",
            intake("please ack", "please ack", OLDER),
            intake("please ack", "please ack", COMMAND)
        );
        assert_eq!(
            matching_commands(&both, "please ack")
                .into_iter()
                .filter(|id| !prior.contains(id))
                .last()
                .as_deref(),
            Some(COMMAND)
        );
        prior.insert(COMMAND.to_string());
        assert_eq!(
            matching_commands(&both, "please ack")
                .into_iter()
                .filter(|id| !prior.contains(id))
                .last(),
            None
        );
    }

    fn status_sse(status: &str) -> String {
        format!(
            "event: message\ndata: {}\n\n",
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": 1,
                "result": {
                    "content": [],
                    "structuredContent": {"status": status, "snapshot": {"id": AGENT}}
                }
            })
        )
    }

    fn status(status: &str) -> Posted {
        Posted::Answered {
            status: 200,
            body: Some(status_sse(status)),
        }
    }

    fn idle() -> Posted {
        status("idle")
    }

    struct Script {
        /// The answer to `get_agent_status`.
        status: Mutex<Posted>,
        /// The answer to `send_agent_prompt`.
        response: Mutex<Posted>,
        calls: Arc<Mutex<Vec<String>>>,
        /// Written into the session log when the prompt POST is attempted,
        /// after the courier has snapshotted the ids already there.
        append: Mutex<Option<(PathBuf, String)>>,
    }

    impl Mcp for Script {
        fn call(&self, endpoint: &str, body: &str, call: Call) -> Posted {
            self.calls
                .lock()
                .unwrap()
                .push(format!("{endpoint}\n{body}"));
            if call == Call::Status {
                assert!(body.contains("\"get_agent_status\""));
                return self.status.lock().unwrap().clone();
            }
            assert!(body.contains("\"send_agent_prompt\""));
            if let Some((path, line)) = self.append.lock().unwrap().clone() {
                if let Some(parent) = path.parent() {
                    std::fs::create_dir_all(parent).unwrap();
                }
                let mut file = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(path)
                    .unwrap();
                writeln!(file, "{line}").unwrap();
            }
            self.response.lock().unwrap().clone()
        }
    }

    /// How many `send_agent_prompt` POSTs were made.
    fn prompts(calls: &Arc<Mutex<Vec<String>>>) -> usize {
        calls
            .lock()
            .unwrap()
            .iter()
            .filter(|call| call.contains("\"send_agent_prompt\""))
            .count()
    }

    fn target(root: &Path) -> Target {
        Target {
            session_id: SESSION.into(),
            workspace_root: root.to_path_buf(),
            workspace_id: "agent".into(),
            owner_id: "owner".into(),
            owner_uid: 501,
        }
    }

    fn log_path(root: &Path) -> PathBuf {
        root.join("sessions/2026/10/11")
            .join(SESSION)
            .join("session.jsonl")
    }

    fn write_log(root: &Path, body: &str) {
        let path = log_path(root);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut text = body.to_string();
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        std::fs::write(path, text).unwrap();
    }

    fn store_of(root: &Path) -> MuseConfig {
        MuseConfig {
            data_dir: root.to_path_buf(),
        }
    }

    fn script(response: Posted, calls: Arc<Mutex<Vec<String>>>) -> Script {
        scripted(idle(), response, calls)
    }

    fn scripted(status: Posted, response: Posted, calls: Arc<Mutex<Vec<String>>>) -> Script {
        Script {
            status: Mutex::new(status),
            response: Mutex::new(response),
            calls,
            append: Mutex::new(None),
        }
    }

    fn deliver_with(
        root: &Path,
        response: Posted,
        calls: Arc<Mutex<Vec<String>>>,
        append: Option<String>,
        delivery_id: &str,
        timeout: Duration,
    ) -> Outcome {
        deliver_after(root, idle(), response, calls, append, delivery_id, timeout)
    }

    #[allow(clippy::too_many_arguments)]
    fn deliver_after(
        root: &Path,
        status: Posted,
        response: Posted,
        calls: Arc<Mutex<Vec<String>>>,
        append: Option<String>,
        delivery_id: &str,
        timeout: Duration,
    ) -> Outcome {
        let mcp = scripted(status, response, calls);
        if let Some(line) = append {
            *mcp.append.lock().unwrap() = Some((log_path(root), line));
        }
        let (courier, receipts) = PaseoCourier::new(
            AGENT.into(),
            "http://127.0.0.1:6767/mcp/agents".into(),
            mcp,
            store_of(root),
        );
        deliver(
            &root.join("journal"),
            Arc::new(courier),
            Arc::new(receipts),
            &target(root),
            delivery_id,
            delivery_id,
            "please ack",
            timeout,
        )
    }

    #[test]
    fn a_new_command_id_is_delivered_and_an_unsent_call_can_be_retried() {
        let tmp = tempfile::tempdir().unwrap();
        write_log(tmp.path(), &intake("please ack", "please ack", OLDER));
        let calls = Arc::new(Mutex::new(Vec::new()));
        let outcome = deliver_with(
            tmp.path(),
            accepted(),
            calls.clone(),
            Some(intake("please ack", "please ack", COMMAND)),
            "relay-1",
            Duration::from_secs(2),
        );
        assert_eq!(
            outcome,
            Outcome::Delivered {
                receipt_id: COMMAND.into()
            }
        );
        assert_eq!(prompts(&calls), 1);

        let tmp = tempfile::tempdir().unwrap();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let failed = deliver_with(
            tmp.path(),
            Posted::Unsent,
            calls.clone(),
            None,
            "relay-2",
            Duration::from_secs(1),
        );
        assert!(matches!(failed, Outcome::Retry(_)));
        let retried = deliver_with(
            tmp.path(),
            accepted(),
            calls.clone(),
            Some(intake("please ack", "please ack", COMMAND)),
            "relay-2",
            Duration::from_secs(2),
        );
        assert!(matches!(retried, Outcome::Delivered { .. }));
        assert_eq!(prompts(&calls), 2);
    }

    #[test]
    fn an_uncertain_send_and_an_older_prompt_are_not_sent_again() {
        let tmp = tempfile::tempdir().unwrap();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let send = |response: Posted| {
            deliver_with(
                tmp.path(),
                response,
                calls.clone(),
                None,
                "relay-3",
                Duration::from_secs(1),
            )
        };
        assert!(matches!(send(Posted::Uncertain), Outcome::InDoubt(_)));
        assert!(matches!(send(accepted()), Outcome::InDoubt(_)));
        assert_eq!(prompts(&calls), 1);

        let tmp = tempfile::tempdir().unwrap();
        write_log(tmp.path(), &intake("please ack", "please ack", OLDER));
        let calls = Arc::new(Mutex::new(Vec::new()));
        let send = || {
            deliver_with(
                tmp.path(),
                accepted(),
                calls.clone(),
                None,
                "relay-4",
                Duration::from_secs(1),
            )
        };
        assert!(matches!(send(), Outcome::InDoubt(_)));
        assert!(matches!(send(), Outcome::InDoubt(_)));
        assert_eq!(prompts(&calls), 1);
    }

    #[test]
    fn a_log_that_cannot_be_snapshotted_does_not_confirm() {
        let tmp = tempfile::tempdir().unwrap();
        write_log(tmp.path(), &intake("please ack", "please ack", OLDER));
        let path = log_path(tmp.path());
        let mut perms = std::fs::metadata(&path).unwrap().permissions();
        use std::os::unix::fs::PermissionsExt;
        perms.set_mode(0o000);
        std::fs::set_permissions(&path, perms.clone()).unwrap();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let (courier, receipts) = PaseoCourier::new(
            AGENT.into(),
            "http://127.0.0.1:6767/mcp/agents".into(),
            script(accepted(), calls.clone()),
            store_of(tmp.path()),
        );
        let forwarded = courier.forward(tmp.path(), SESSION, "please ack");
        perms.set_mode(0o644);
        std::fs::set_permissions(&path, perms).unwrap();
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        writeln!(file, "{}", intake("please ack", "please ack", COMMAND)).unwrap();
        assert_eq!(
            forwarded,
            Forwarded::Sent {
                courier_session: AGENT.into()
            }
        );
        assert_eq!(prompts(&calls), 1);
        assert_eq!(
            receipts.admitted(SESSION, AGENT, "please ack", Instant::now()),
            None
        );
    }

    #[test]
    fn a_refusal_is_unsent_and_an_unclear_answer_stays_sent() {
        let tmp = tempfile::tempdir().unwrap();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let (courier, _) = PaseoCourier::new(
            AGENT.into(),
            "http://127.0.0.1:6767/mcp/agents".into(),
            script(
                Posted::Answered {
                    status: 200,
                    body: Some(
                        serde_json::json!({"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"no"}})
                            .to_string(),
                    ),
                },
                calls.clone(),
            ),
            store_of(tmp.path()),
        );
        assert_eq!(
            courier.forward(tmp.path(), SESSION, "please ack"),
            Forwarded::Unavailable
        );

        let (courier, _) = PaseoCourier::new(
            AGENT.into(),
            "http://192.0.2.1:6767/mcp/agents".into(),
            script(accepted(), calls.clone()),
            store_of(tmp.path()),
        );
        assert_eq!(
            courier.forward(tmp.path(), SESSION, "please ack"),
            Forwarded::Unavailable
        );
        assert_eq!(prompts(&calls), 1);

        let (courier, _) = PaseoCourier::new(
            AGENT.into(),
            "http://127.0.0.1:6767/mcp/agents".into(),
            script(
                Posted::Answered {
                    status: 200,
                    body: Some("not json".into()),
                },
                calls,
            ),
            store_of(tmp.path()),
        );
        assert_eq!(
            courier.forward(tmp.path(), SESSION, "please ack"),
            Forwarded::Sent {
                courier_session: AGENT.into()
            }
        );
    }

    fn http(status: &str, body: &str) -> Vec<u8> {
        let mut response = format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        response.extend(body.as_bytes());
        response
    }

    /// One connection per entry, answered in order. `None` reads the
    /// request and never answers. List only the calls the client makes:
    /// the server waits for each. Returns the port and the requests read.
    fn serve(responses: Vec<Option<Vec<u8>>>) -> (u16, std::thread::JoinHandle<Vec<String>>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            let mut requests = Vec::new();
            let mut held = Vec::new();
            for response in responses {
                let Ok((mut stream, _)) = listener.accept() else {
                    break;
                };
                let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                let Ok(buf) = read_request(&mut stream) else {
                    break;
                };
                requests.push(String::from_utf8_lossy(&buf).into_owned());
                match response {
                    Some(response) => {
                        let _ = std::io::Write::write_all(&mut stream, &response);
                    }
                    None => held.push(stream),
                }
            }
            // Keep unanswered connections open until the client gives up.
            std::thread::sleep(Duration::from_millis(1500));
            drop(held);
            requests
        });
        (port, handle)
    }

    fn sse(body: &str) -> Vec<u8> {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .into_bytes()
    }

    fn quick() -> UreqMcp {
        UreqMcp {
            status_timeout: Duration::from_millis(500),
            prompt_timeout: Duration::from_millis(500),
        }
    }

    fn forward_with(endpoint: String, mcp: UreqMcp) -> Forwarded {
        let tmp = tempfile::tempdir().unwrap();
        let (courier, _) = PaseoCourier::new(AGENT.into(), endpoint, mcp, store_of(tmp.path()));
        let forwarded = courier.forward(tmp.path(), SESSION, "please ack");
        // Keep the temp dir until the POST has returned.
        drop(tmp);
        forwarded
    }

    fn forward_to(endpoint: String) -> Forwarded {
        forward_with(endpoint, UreqMcp::default())
    }

    fn json_body(request: &str) -> Value {
        serde_json::from_str(
            request
                .split_once("\r\n\r\n")
                .map(|(_, body)| body)
                .unwrap(),
        )
        .unwrap()
    }

    #[test]
    fn the_system_client_asks_the_status_then_posts_the_prompt() {
        let (port, received) = serve(vec![
            Some(sse(&status_sse("idle"))),
            Some(sse(&accepted_sse())),
        ]);
        assert_eq!(
            forward_to(format!("http://127.0.0.1:{port}/mcp/agents")),
            Forwarded::Sent {
                courier_session: AGENT.into()
            }
        );
        let requests = received.join().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(requests[0].contains("POST /mcp/agents "));
        let status = json_body(&requests[0]);
        assert_eq!(status["params"]["name"], "get_agent_status");
        assert_eq!(
            status["params"]["arguments"],
            serde_json::json!({"agentId": AGENT})
        );
        assert!(requests[1].contains("POST /mcp/agents "));
        let prompt = json_body(&requests[1]);
        assert_eq!(prompt["params"]["name"], "send_agent_prompt");
        assert_eq!(prompt["params"]["arguments"]["agentId"], AGENT);
        assert_eq!(prompt["params"]["arguments"]["prompt"], "please ack");
        assert_eq!(prompt["params"]["arguments"]["background"], true);
        assert!(prompt["params"]["arguments"]
            .get("activeTurnBehavior")
            .is_none());
        // No credential is sent on either call.
        assert!(requests
            .iter()
            .all(|request| !request.to_ascii_lowercase().contains("authorization:")));
    }

    #[test]
    fn the_system_client_waits_while_the_agent_runs() {
        let (port, received) = serve(vec![Some(sse(&status_sse("running")))]);
        assert_eq!(
            forward_to(format!("http://127.0.0.1:{port}/mcp/agents")),
            Forwarded::Busy
        );
        assert_eq!(received.join().unwrap().len(), 1);
    }

    #[test]
    fn the_system_client_keeps_an_ambiguous_prompt_answer() {
        for prompt in [
            http("200 OK", "not json"),
            http("200 OK", &"x".repeat(MAX_BODY + 1)),
        ] {
            let (port, _) = serve(vec![Some(sse(&status_sse("idle"))), Some(prompt)]);
            assert_eq!(
                forward_to(format!("http://127.0.0.1:{port}/mcp/agents")),
                Forwarded::Sent {
                    courier_session: AGENT.into()
                }
            );
        }

        // The status answered idle and the prompt never did: in doubt.
        let (port, received) = serve(vec![Some(sse(&status_sse("idle"))), None]);
        assert_eq!(
            forward_with(format!("http://127.0.0.1:{port}/mcp/agents"), quick()),
            Forwarded::Sent {
                courier_session: AGENT.into()
            }
        );
        assert_eq!(received.join().unwrap().len(), 2);
    }

    #[test]
    fn the_system_client_sends_nothing_when_the_status_is_unusable() {
        // Refused connection.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        assert_eq!(
            forward_to(format!("http://127.0.0.1:{port}/mcp/agents")),
            Forwarded::Unavailable
        );

        // A status call that never answers, then one that cannot be read.
        for status in [None, Some(http("200 OK", "not json"))] {
            let (port, received) = serve(vec![status]);
            assert_eq!(
                forward_with(format!("http://127.0.0.1:{port}/mcp/agents"), quick()),
                Forwarded::Unavailable
            );
            let requests = received.join().unwrap();
            assert_eq!(requests.len(), 1);
            assert_eq!(
                json_body(&requests[0])["params"]["name"],
                "get_agent_status"
            );
        }

        let (port, received) = serve(vec![Some(http("401 Unauthorized", ""))]);
        assert_eq!(
            forward_to(format!("http://127.0.0.1:{port}/mcp/agents")),
            Forwarded::Refused(Failure::AuthenticationUnavailable)
        );
        assert_eq!(received.join().unwrap().len(), 1);

        let (port, _) = serve(vec![
            Some(sse(&status_sse("idle"))),
            Some(http("401 Unauthorized", r#"{"error":"Unauthorized"}"#)),
        ]);
        assert_eq!(
            forward_to(format!("http://127.0.0.1:{port}/mcp/agents")),
            Forwarded::Refused(Failure::AuthenticationUnavailable)
        );

        assert_eq!(
            forward_to("http://192.0.2.1:6767/mcp/agents".into()),
            Forwarded::Unavailable
        );
        assert!(!loopback_agents("http://localhost:6767/mcp/agents"));
        assert!(loopback_agents("http://[::1]:6767/mcp/agents"));
    }

    #[test]
    fn only_a_session_out_of_its_turn_takes_the_prompt() {
        assert_eq!(turn_of(&status("idle")), Turn::Free);
        assert_eq!(turn_of(&status("error")), Turn::Free);
        for busy in ["running", "initializing", "closed", "thinking", ""] {
            assert_eq!(turn_of(&status(busy)), Turn::Busy, "{busy}");
        }
        let text = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "result": {"content": [{"type": "text", "text": "{\"status\":\"running\"}"}]}
        })
        .to_string();
        assert_eq!(
            turn_of(&Posted::Answered {
                status: 200,
                body: Some(text)
            }),
            Turn::Busy
        );
        let unknown = [
            Posted::Unsent,
            Posted::Uncertain,
            Posted::Answered {
                status: 200,
                body: None,
            },
            Posted::Answered {
                status: 200,
                body: Some("not json".into()),
            },
            Posted::Answered {
                status: 200,
                body: Some(
                    serde_json::json!({"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"no"}})
                        .to_string(),
                ),
            },
            Posted::Answered {
                status: 200,
                body: Some(
                    serde_json::json!({"jsonrpc":"2.0","id":1,"result":{"isError":true,"structuredContent":{"status":"idle"}}})
                        .to_string(),
                ),
            },
            Posted::Answered {
                status: 200,
                body: Some(
                    serde_json::json!({"jsonrpc":"2.0","id":1,"result":{"structuredContent":{"status":7}}})
                        .to_string(),
                ),
            },
            Posted::Answered {
                status: 500,
                body: Some(status_sse("idle")),
            },
        ];
        for posted in unknown {
            assert_eq!(turn_of(&posted), Turn::Unknown, "{posted:?}");
        }
        assert_eq!(
            turn_of(&Posted::Answered {
                status: 401,
                body: None
            }),
            Turn::Locked
        );
    }

    #[test]
    fn a_running_session_waits_and_a_later_idle_attempt_sends() {
        let tmp = tempfile::tempdir().unwrap();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let waited = deliver_after(
            tmp.path(),
            status("running"),
            accepted(),
            calls.clone(),
            Some(intake("please ack", "please ack", COMMAND)),
            "relay-5",
            Duration::from_secs(1),
        );
        assert!(matches!(waited, Outcome::Waiting(_)), "{waited:?}");
        assert_eq!(calls.lock().unwrap().len(), 1);
        assert_eq!(prompts(&calls), 0);

        // An unknown status waits too.
        let waited = deliver_after(
            tmp.path(),
            status("compacting"),
            accepted(),
            calls.clone(),
            None,
            "relay-5",
            Duration::from_secs(1),
        );
        assert!(matches!(waited, Outcome::Waiting(_)), "{waited:?}");
        assert_eq!(prompts(&calls), 0);

        // The claim was released: the same delivery sends once idle.
        let sent = deliver_after(
            tmp.path(),
            idle(),
            accepted(),
            calls.clone(),
            Some(intake("please ack", "please ack", COMMAND)),
            "relay-5",
            Duration::from_secs(2),
        );
        assert_eq!(
            sent,
            Outcome::Delivered {
                receipt_id: COMMAND.into()
            }
        );
        assert_eq!(prompts(&calls), 1);
        let prompt = calls
            .lock()
            .unwrap()
            .iter()
            .find(|call| call.contains("send_agent_prompt"))
            .cloned()
            .unwrap();
        let body: Value = serde_json::from_str(prompt.split_once('\n').unwrap().1).unwrap();
        assert_eq!(body["params"]["arguments"]["agentId"], AGENT);
        assert_eq!(body["params"]["arguments"]["prompt"], "please ack");
        assert_eq!(body["params"]["arguments"]["background"], true);
        assert!(body["params"]["arguments"]
            .get("activeTurnBehavior")
            .is_none());
    }

    #[test]
    fn a_status_call_that_fails_sends_nothing_and_can_be_retried() {
        let unusable = [
            // Timeout or reset: the status call sends nothing either way.
            Posted::Uncertain,
            // Connection refused.
            Posted::Unsent,
            Posted::Answered {
                status: 200,
                body: Some("not json".into()),
            },
        ];
        for (index, failed) in unusable.into_iter().enumerate() {
            let tmp = tempfile::tempdir().unwrap();
            let calls = Arc::new(Mutex::new(Vec::new()));
            let delivery = format!("relay-6-{index}");
            let outcome = deliver_after(
                tmp.path(),
                failed,
                accepted(),
                calls.clone(),
                None,
                &delivery,
                Duration::from_secs(1),
            );
            assert!(matches!(outcome, Outcome::Retry(_)), "{outcome:?}");
            assert_eq!(prompts(&calls), 0);
            let retried = deliver_after(
                tmp.path(),
                idle(),
                accepted(),
                calls.clone(),
                Some(intake("please ack", "please ack", COMMAND)),
                &delivery,
                Duration::from_secs(2),
            );
            assert!(matches!(retried, Outcome::Delivered { .. }), "{retried:?}");
            assert_eq!(prompts(&calls), 1);
        }
    }

    #[test]
    fn a_password_on_the_daemon_is_a_readable_refusal_and_releases_the_claim() {
        let locked = || Posted::Answered {
            status: 401,
            body: Some(r#"{"error":"Unauthorized"}"#.into()),
        };
        let tmp = tempfile::tempdir().unwrap();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let refused = deliver_after(
            tmp.path(),
            locked(),
            accepted(),
            calls.clone(),
            None,
            "relay-7",
            Duration::from_secs(1),
        );
        assert_eq!(
            refused,
            Outcome::Refused(Failure::AuthenticationUnavailable)
        );
        assert_eq!(prompts(&calls), 0);
        let refused = deliver_after(
            tmp.path(),
            idle(),
            locked(),
            calls.clone(),
            None,
            "relay-7",
            Duration::from_secs(1),
        );
        assert_eq!(
            refused,
            Outcome::Refused(Failure::AuthenticationUnavailable)
        );
        assert_eq!(prompts(&calls), 1);
        // Neither refusal kept the claim.
        let sent = deliver_after(
            tmp.path(),
            idle(),
            accepted(),
            calls.clone(),
            Some(intake("please ack", "please ack", COMMAND)),
            "relay-7",
            Duration::from_secs(2),
        );
        assert!(matches!(sent, Outcome::Delivered { .. }), "{sent:?}");
        assert!(PASSWORD_REFUSAL.contains("password"));
        assert!(PASSWORD_REFUSAL.contains("Agent Relay holds none"));
    }

    #[test]
    fn a_prompt_timeout_after_an_idle_status_stays_in_doubt() {
        let tmp = tempfile::tempdir().unwrap();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let first = deliver_after(
            tmp.path(),
            idle(),
            Posted::Uncertain,
            calls.clone(),
            None,
            "relay-8",
            Duration::from_secs(1),
        );
        assert!(matches!(first, Outcome::InDoubt(_)), "{first:?}");
        let calls_after_first = calls.lock().unwrap().len();
        let second = deliver_after(
            tmp.path(),
            idle(),
            accepted(),
            calls.clone(),
            None,
            "relay-8",
            Duration::from_secs(1),
        );
        assert!(matches!(second, Outcome::InDoubt(_)), "{second:?}");
        // The second attempt posts nothing at all, not even the status.
        assert_eq!(calls.lock().unwrap().len(), calls_after_first);
        assert_eq!(prompts(&calls), 1);
    }

    /// Paseo's answer when the run did not start within its 60 s: the MCP
    /// SDK wraps the handler's throw, after the prompt was dispatched.
    fn tool_error() -> Posted {
        Posted::Answered {
            status: 200,
            body: Some(format!(
                "event: message\ndata: {}\n\n",
                serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": 1,
                    "result": {
                        "content": [{"type": "text", "text": "run did not start in time"}],
                        "isError": true
                    }
                })
            )),
        }
    }

    fn unsuccessful() -> Posted {
        Posted::Answered {
            status: 200,
            body: Some(
                serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": 1,
                    "result": {"structuredContent": {"success": false, "status": "error"}}
                })
                .to_string(),
            ),
        }
    }

    fn rpc_error() -> Posted {
        Posted::Answered {
            status: 200,
            body: Some(
                serde_json::json!({"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"no"}})
                    .to_string(),
            ),
        }
    }

    #[test]
    fn a_tool_error_after_an_idle_status_may_have_queued_the_prompt() {
        for (index, failed) in [tool_error(), unsuccessful()].into_iter().enumerate() {
            // The forward reports it sent, so the log decides.
            let tmp = tempfile::tempdir().unwrap();
            let calls = Arc::new(Mutex::new(Vec::new()));
            let (courier, _) = PaseoCourier::new(
                AGENT.into(),
                "http://127.0.0.1:6767/mcp/agents".into(),
                script(failed.clone(), calls.clone()),
                store_of(tmp.path()),
            );
            assert_eq!(
                courier.forward(tmp.path(), SESSION, "please ack"),
                Forwarded::Sent {
                    courier_session: AGENT.into()
                }
            );

            // Paseo queued it anyway: the new command id delivers it.
            let tmp = tempfile::tempdir().unwrap();
            let calls = Arc::new(Mutex::new(Vec::new()));
            let delivered = deliver_after(
                tmp.path(),
                idle(),
                failed.clone(),
                calls.clone(),
                Some(intake("please ack", "please ack", COMMAND)),
                &format!("relay-9-{index}"),
                Duration::from_secs(2),
            );
            assert_eq!(
                delivered,
                Outcome::Delivered {
                    receipt_id: COMMAND.into()
                }
            );
            assert_eq!(prompts(&calls), 1);

            // No command id: in doubt, and never posted again.
            let tmp = tempfile::tempdir().unwrap();
            let calls = Arc::new(Mutex::new(Vec::new()));
            let delivery = format!("relay-10-{index}");
            let first = deliver_after(
                tmp.path(),
                idle(),
                failed,
                calls.clone(),
                None,
                &delivery,
                Duration::from_secs(1),
            );
            assert!(matches!(first, Outcome::InDoubt(_)), "{first:?}");
            let second = deliver_after(
                tmp.path(),
                status("error"),
                accepted(),
                calls.clone(),
                None,
                &delivery,
                Duration::from_secs(1),
            );
            assert!(matches!(second, Outcome::InDoubt(_)), "{second:?}");
            assert_eq!(prompts(&calls), 1);
        }
    }

    #[test]
    fn a_json_rpc_error_on_the_prompt_was_not_taken_and_can_be_retried() {
        let tmp = tempfile::tempdir().unwrap();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let failed = deliver_after(
            tmp.path(),
            idle(),
            rpc_error(),
            calls.clone(),
            None,
            "relay-11",
            Duration::from_secs(1),
        );
        assert!(matches!(failed, Outcome::Retry(_)), "{failed:?}");
        let retried = deliver_after(
            tmp.path(),
            idle(),
            accepted(),
            calls.clone(),
            Some(intake("please ack", "please ack", COMMAND)),
            "relay-11",
            Duration::from_secs(2),
        );
        assert!(matches!(retried, Outcome::Delivered { .. }), "{retried:?}");
        assert_eq!(prompts(&calls), 2);
    }
}
