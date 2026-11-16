//! Relaycast push for registered agents: each agent's own direct node socket,
//! the only realtime route to an agent.
//!
//! ```text
//! POST /v1/agent/node-token (agent token)       ─▶ node id, name, token
//! wss://…/v1/node/ws?token=…  → node.register   ─▶ reply "register-…": live
//!                             ← deliver          ─▶ wake with the frame
//!                             → node.heartbeat every 15 s
//!                             ← correlated presence reply ─▶ replace REST heartbeat
//! ```
//!
//! A channel never acknowledges on the socket: the delivery runtime acks over
//! HTTP once the message is in the session. Whenever a socket goes live or
//! ends, the channel wakes a queue read, since something may have been pushed
//! while it was down. It reconnects with jittered backoff capped at 300 s
//! until stopped, with the node token it minted first (`tokens`): a new one
//! only once Relaycast refuses it, at the upgrade (401, 403) or in a
//! `node_token_invalid` register refusal. The backoff starts over only once a
//! socket held up ([`Liveness`]), so a gateway that accepts sockets and
//! drops them again is not answered with a reconnect every second or two.
//! A gateway that refuses the upgrade with 429 or 503, or closes the socket
//! with 1013 (try again later) or 1008, pauses the whole workspace's writes
//! in the shared [`RelaycastBackoff`], every channel's reconnect included,
//! for its `Retry-After` (or the close's `retry_after`) or else the
//! transient schedule, at most 300 s, never cutting short a longer pause
//! another socket started.
//!
//! `node.register` names this install's provider instance
//! (`<machine id>-<install id>`), so installs sharing one person identity
//! are told apart. A channel is live, and wakes a queue read, only once
//! `node.register` is accepted; one with no reply in 15 s is closed and
//! retried on the normal backoff. A refused one (`ok: false`) is held open
//! by Relaycast for about 30 s and then closed: 4009 when another install's
//! instance holds the node (`provider_instance_conflict`), 4001 otherwise.
//! Neither wakes a queue read. A conflict waits 30-60 s, or the refusal's
//! `retry_after` (capped at 300 s; the reply's, else the close's), or its
//! backoff if longer, counted from the refusal; the socket is left for Relaycast to close until then. Any
//! other refusal waits up to 60 s for Relaycast's close, then takes the
//! normal backoff, as a 4000 supersede does.

mod tokens;

use crate::relay::backoff::{BackoffNotice, RelaycastBackoff, WorkspaceScope};
use crate::relay::integrations::retry_after_seconds;
use crate::relay::machine::machine_name;
use crate::relay::sdk_gaps::{self, NodeClose, NodeRead, NODE_HEARTBEAT_SECONDS};
use crate::relay::workspace::Secret;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;

/// One agent the push manager keeps a socket open for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PushTarget {
    pub agent: String,
    pub base_url: String,
    pub token: Secret,
    pub workspace: WorkspaceScope,
    /// The registration's persisted machine address (`<prefix>-<agent id>`);
    /// derived from `machine_prefix` and the node id when absent.
    pub machine_address: Option<String>,
}

impl PushTarget {
    /// Whether `other` is served by the same socket: everything but the
    /// workspace's display label, which changes as the workspace is
    /// verified and must not reconnect every channel.
    fn same_channel(&self, other: &PushTarget) -> bool {
        self.agent == other.agent
            && self.base_url == other.base_url
            && self.token == other.token
            && self.machine_address == other.machine_address
            && self.workspace.same_credentials(&other.workspace)
    }
}

/// A channel's connection state, as the status snapshot reports it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, schemars::JsonSchema, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
#[schemars(extend("x-fallback" = "connecting"))]
pub enum PushState {
    Connecting,
    Live,
    Waiting { retry_in_ms: u64 },
}

/// What a channel tells its owner.
#[derive(Clone, Debug, PartialEq)]
pub enum PushSignal {
    State {
        agent: String,
        state: PushState,
    },
    /// The channel stopped for good.
    Stopped {
        agent: String,
    },
    /// `Some(frame)`: a pushed `deliver` frame. `None`: read the queue.
    Wake {
        agent: String,
        frame: Option<Value>,
    },
    /// Server-confirmed presence, credited at send time, for this credential.
    Presence {
        target: PushTarget,
        sent_at: Instant,
    },
    /// A shared workspace gate entered a user-visible plan pause.
    Backoff {
        workspace: WorkspaceScope,
        notice: BackoffNotice,
    },
}

/// Timing, fixed in production and shortened in tests.
#[derive(Clone, Copy, Debug)]
pub struct PushTiming {
    pub heartbeat: Duration,
    /// Backoff unit: reconnect `n` waits `min(300, 2^min(n, 8))` units,
    /// jittered.
    pub backoff_unit: Duration,
    pub jitter: fn() -> f64,
    /// The least time between two node-token mints.
    pub mint_gap: Duration,
}

impl Default for PushTiming {
    fn default() -> PushTiming {
        PushTiming {
            heartbeat: Duration::from_secs(NODE_HEARTBEAT_SECONDS),
            backoff_unit: Duration::from_secs(1),
            jitter: random_jitter,
            mint_gap: Duration::from_millis(250),
        }
    }
}

/// Uniform in `[0.5, 1.0]`.
pub fn random_jitter() -> f64 {
    let mut bytes = [0u8; 4];
    if getrandom::getrandom(&mut bytes).is_err() {
        return 1.0;
    }
    0.5 + 0.5 * (u32::from_le_bytes(bytes) as f64 / u32::MAX as f64)
}

/// The wait before reconnect attempt `attempt` (1-based), in backoff units.
pub fn backoff(attempt: u32, jitter: f64) -> f64 {
    let exponent = attempt.min(5) as i32;
    30f64.min(2f64.powi(exponent)) * jitter
}

/// The wait before a node socket's reconnect `attempt` (1-based), in
/// backoff units: 1-2 s at first, up to 300 s while sockets keep failing.
pub fn reconnect_backoff(attempt: u32, jitter: f64) -> f64 {
    let exponent = attempt.min(8) as i32;
    300f64.min(2f64.powi(exponent)) * jitter
}

/// How long a socket must stay live, in heartbeat periods (60 s), before a
/// reconnect starts the backoff over.
const STABLE_HEARTBEATS: u32 = 4;
/// Confirmed heartbeats that also prove a socket held up.
const STABLE_CONFIRMATIONS: u32 = 2;
/// The wait after another install's provider instance won the node, in
/// backoff units before jitter: 30-60 s.
const CONFLICT_UNITS: f64 = 60.0;
/// The most a refusal's `retry_after` may make a channel wait, in backoff
/// units (one per second).
const RETRY_AFTER_CAP_UNITS: f64 = 300.0;
/// How long a socket refused for another reason than a conflict waits for
/// Relaycast's close before closing itself, in backoff units (60 s).
const REFUSED_CLOSE_UNITS: f64 = 60.0;
/// How long `node.register` may go unanswered, in backoff units (15 s).
const REGISTER_REPLY_UNITS: f64 = 15.0;
/// The register refusal code for a node token Relaycast no longer takes.
const NODE_TOKEN_INVALID: &str = "node_token_invalid";
/// How long the upgrade and `node.register` send may take.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

/// A shared write-gate wait, stretched to between one and two times its
/// length by `jitter` (uniform in `[0.5, 1.0]`).
pub fn busy_spread(delay: Duration, jitter: f64) -> Duration {
    delay.mul_f64(3.0 - 2.0 * jitter.clamp(0.5, 1.0))
}

/// Everything a channel needs besides its target.
#[derive(Clone)]
pub struct PushContext {
    pub version: String,
    pub machine_prefix: String,
    pub timing: PushTiming,
    pub signals: mpsc::UnboundedSender<PushSignal>,
    pub backoff: Arc<RelaycastBackoff>,
    /// Node tokens held across reconnects.
    pub tokens: Arc<tokens::NodeTokens>,
    /// This install's id, persisted by the core; with the machine id it
    /// names the node's provider instance.
    pub install_id: String,
}

impl PushContext {
    /// A context holding no node token yet.
    pub fn new(
        version: String,
        machine_prefix: String,
        timing: PushTiming,
        signals: mpsc::UnboundedSender<PushSignal>,
        backoff: Arc<RelaycastBackoff>,
    ) -> PushContext {
        PushContext {
            version,
            machine_prefix,
            timing,
            signals,
            backoff,
            tokens: Arc::default(),
            install_id: crate::relay::store::random_uuid(),
        }
    }

    /// The context with the install id the core persisted.
    pub fn with_install_id(self, install_id: String) -> PushContext {
        PushContext { install_id, ..self }
    }
}

/// One agent's socket loop.
pub struct PushChannel {
    target: PushTarget,
    stop: watch::Sender<bool>,
    task: JoinHandle<()>,
}

impl PushChannel {
    pub fn spawn(target: PushTarget, context: PushContext) -> PushChannel {
        let (stop, stopped) = watch::channel(false);
        let task = tokio::spawn(run(target.clone(), context, stopped));
        PushChannel { target, stop, task }
    }

    pub fn target(&self) -> &PushTarget {
        &self.target
    }

    /// Closes the socket (going away) and waits for the loop to end; a
    /// wedged peer delays this by at most the close grace.
    pub async fn stop(self) {
        let _ = self.stop.send(true);
        let _ = self.task.await;
    }
}

enum Ended {
    Stopped,
    /// `stable`: the socket held up long enough to start the backoff over.
    Closed {
        stable: bool,
    },
    /// No reply to `node.register` in time: closed, never live.
    Unregistered,
    /// Relaycast refused `node.register` (an `ok: false` reply, or its 4009
    /// or 4001 close) `at`: the socket never went live. After a reply the
    /// socket is still open, for Relaycast to close.
    Refused {
        refusal: Refusal,
        at: Instant,
        socket: Option<sdk_gaps::NodeSocket>,
    },
}

/// What a refused `node.register` said, by reply and close together.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct Refusal {
    /// Another install's provider instance holds the node (409
    /// `provider_instance_conflict`, close 4009).
    conflict: bool,
    /// The least wait the refusal asked for.
    retry_after: Option<Duration>,
}

impl Refusal {
    fn of_reply(frame: &Value) -> Refusal {
        Refusal {
            conflict: sdk_gaps::is_instance_conflict(frame),
            retry_after: sdk_gaps::refusal_retry_after(frame),
        }
    }

    /// With what the close adds: a 4009, or a `retry_after` the reply left
    /// out.
    fn closed(self, close: &NodeClose) -> Refusal {
        Refusal {
            conflict: self.conflict || close.is_instance_conflict(),
            retry_after: self.retry_after.or_else(|| close.retry_after()),
        }
    }

    /// The reconnect wait, in backoff units, given the reconnect `backoff`:
    /// at least the `retry_after` asked for (capped at 300 s), else 30-60 s
    /// for a conflict.
    fn units(self, backoff: f64, jitter: f64) -> f64 {
        let asked = self
            .retry_after
            .map(|wait| wait.as_secs_f64().min(RETRY_AFTER_CAP_UNITS));
        let floor = match (asked, self.conflict) {
            (Some(asked), _) => asked,
            (None, true) => CONFLICT_UNITS * jitter,
            (None, false) => 0.0,
        };
        backoff.max(floor)
    }
}

const FAILED: Ended = Ended::Closed { stable: false };

/// How long one socket held up.
#[derive(Default)]
struct Liveness {
    opened_at: Option<Instant>,
    live_since: Option<Instant>,
    confirmed: u32,
}

impl Liveness {
    fn opened(&mut self, at: Instant) {
        self.opened_at = Some(at);
    }

    fn live(&mut self, at: Instant) {
        self.live_since.get_or_insert(at);
    }

    fn confirmed(&mut self) {
        self.confirmed += 1;
    }

    /// Live for [`STABLE_HEARTBEATS`] heartbeat periods, or
    /// [`STABLE_CONFIRMATIONS`] heartbeats confirmed.
    fn stable(&self, now: Instant, heartbeat: Duration) -> bool {
        self.live_since.is_some_and(|since| {
            self.confirmed >= STABLE_CONFIRMATIONS
                || now.saturating_duration_since(since) >= heartbeat * STABLE_HEARTBEATS
        })
    }

    /// Whether the socket ended within a heartbeat period of registering.
    fn just_opened(&self, now: Instant, heartbeat: Duration) -> bool {
        self.opened_at
            .is_some_and(|at| now.saturating_duration_since(at) < heartbeat)
    }

    fn ended(&self, heartbeat: Duration) -> Ended {
        Ended::Closed {
            stable: self.stable(Instant::now(), heartbeat),
        }
    }
}

/// Whether a socket closed with `code` was shed by an overloaded gateway:
/// 1013 (try again later), 1008 (policy), or no code within a heartbeat
/// period of registering.
fn shed(close: Option<&NodeClose>, liveness: &Liveness, heartbeat: Duration) -> bool {
    match close.map(|close| close.code) {
        Some(1013 | 1008) => true,
        None => liveness.just_opened(Instant::now(), heartbeat),
        Some(_) => false,
    }
}

/// An upgrade refused with 429 or 503 pauses the workspace's writes for its
/// `Retry-After` (delay-seconds or an HTTP-date), else the transient
/// schedule.
fn record_overload(context: &PushContext, target: &PushTarget, error: &tungstenite::Error) {
    let tungstenite::Error::Http(response) = error else {
        return;
    };
    if !matches!(response.status().as_u16(), 429 | 503) {
        return;
    }
    let retry_after = response
        .headers()
        .get("retry-after")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| retry_after_seconds(value, chrono::Utc::now()))
        .map(Duration::from_secs);
    context
        .backoff
        .record_write_pause(&target.workspace, retry_after);
}

async fn run(target: PushTarget, context: PushContext, mut stopped: watch::Receiver<bool>) {
    let signal = |signal: PushSignal| {
        let _ = context.signals.send(signal);
    };
    let state = |state: PushState| {
        signal(PushSignal::State {
            agent: target.agent.clone(),
            state,
        })
    };
    let mut attempt = 0u32;
    loop {
        if *stopped.borrow() {
            break;
        }
        if let Some(delay) = context.backoff.remaining_write(&target.workspace) {
            // Every channel in the workspace shares this gate's retry time;
            // spread their wake-ups so they do not mint node tokens together
            // and fill the write lane again.
            let delay = busy_spread(delay, (context.timing.jitter)());
            state(PushState::Waiting {
                retry_in_ms: delay.as_millis() as u64,
            });
            tokio::select! {
                _ = tokio::time::sleep(delay) => continue,
                _ = stopped.changed() => break,
            }
        }
        state(PushState::Connecting);
        let ended = connect_once(&target, &context, &mut stopped).await;
        if matches!(ended, Ended::Stopped) || *stopped.borrow() {
            break;
        }
        // Only a socket that held up starts the backoff over: one the
        // gateway drops soon after registering keeps it growing.
        if matches!(ended, Ended::Closed { stable: true }) {
            attempt = 0;
        }
        attempt = attempt.saturating_add(1);
        let jitter = (context.timing.jitter)();
        let backoff = reconnect_backoff(attempt, jitter);
        let unit = context.timing.backoff_unit;
        let until = match ended {
            Ended::Refused {
                refusal,
                at,
                mut socket,
            } => {
                // The socket never went live: no history to read.
                let (refusal, from) = if refusal.conflict {
                    (refusal, Some(at))
                } else {
                    // Relaycast closes it; that close may still say conflict.
                    let patience = at + unit.mul_f64(REFUSED_CLOSE_UNITS);
                    let Some(refusal) =
                        hold_refused(&mut socket, refusal, patience, &mut stopped).await
                    else {
                        break;
                    };
                    let from = if refusal.conflict { Some(at) } else { None };
                    (refusal, from)
                };
                // A conflict's wait counts from the refusal, any other from
                // the close.
                let now = Instant::now();
                let until = from.unwrap_or(now) + unit.mul_f64(refusal.units(backoff, jitter));
                state(PushState::Waiting {
                    retry_in_ms: until.saturating_duration_since(now).as_millis() as u64,
                });
                // Left for Relaycast to close, or closed once the wait is over.
                let Some(closed) = hold_refused(&mut socket, refusal, until, &mut stopped).await
                else {
                    break;
                };
                // The close may ask for a longer wait than the reply did.
                let asked = from.unwrap_or(now) + unit.mul_f64(closed.units(backoff, jitter));
                if asked > until {
                    let now = Instant::now();
                    state(PushState::Waiting {
                        retry_in_ms: asked.saturating_duration_since(now).as_millis() as u64,
                    });
                }
                until.max(asked)
            }
            ended => {
                if !matches!(ended, Ended::Unregistered) {
                    // Whatever ended the socket, deliveries may be waiting.
                    signal(PushSignal::Wake {
                        agent: target.agent.clone(),
                        frame: None,
                    });
                }
                let delay = unit.mul_f64(backoff);
                state(PushState::Waiting {
                    retry_in_ms: delay.as_millis() as u64,
                });
                Instant::now() + delay
            }
        };
        tokio::select! {
            _ = tokio::time::sleep_until(until.into()) => {}
            _ = stopped.changed() => break,
        }
    }
    signal(PushSignal::Stopped {
        agent: target.agent.clone(),
    });
}

/// One socket's life: a node token (held or minted), register, heartbeat,
/// and wake on every `deliver`.
async fn connect_once(
    target: &PushTarget,
    context: &PushContext,
    stopped: &mut watch::Receiver<bool>,
) -> Ended {
    let Ok(agent) = super::client::agent_client(&target.base_url, &target.token) else {
        return FAILED;
    };
    let node = tokio::select! {
        node = context.tokens.get(target, context, &agent) => match node {
            Some(node) => node,
            None => return FAILED,
        },
        _ = stopped.changed() => return Ended::Stopped,
    };
    let machine_id = target.machine_address.clone().unwrap_or_else(|| {
        machine_name(
            &context.machine_prefix,
            sdk_gaps::agent_id_of_node(&node.node_id),
        )
    });
    let instance_id = format!("{machine_id}-{}", context.install_id);
    let open = sdk_gaps::open_node_socket(
        &target.base_url,
        &node,
        &context.version,
        &machine_id,
        &instance_id,
    );
    let mut socket = tokio::select! {
        socket = tokio::time::timeout(CONNECT_TIMEOUT, open) => match socket {
            Ok(Ok(socket)) => socket,
            Ok(Err(error)) => {
                if tokens::refused(&error) {
                    context.tokens.forget(target);
                }
                record_overload(context, target, &error);
                return FAILED;
            }
            // No answer in time.
            Err(_) => return FAILED,
        },
        _ = stopped.changed() => return Ended::Stopped,
    };
    let heartbeat_period = context.timing.heartbeat;
    let mut liveness = Liveness::default();
    liveness.opened(Instant::now());
    let mut heartbeat = sdk_gaps::heartbeat_frame(&node, &context.version);
    let mut presence = PresenceAcks::default();
    let register_deadline =
        tokio::time::sleep(context.timing.backoff_unit.mul_f64(REGISTER_REPLY_UNITS));
    tokio::pin!(register_deadline);
    let mut beats = tokio::time::interval(context.timing.heartbeat);
    beats.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = stopped.changed() => {
                go_away(&mut socket).await;
                return Ended::Stopped;
            }
            _ = &mut register_deadline, if liveness.live_since.is_none() => {
                go_away(&mut socket).await;
                return Ended::Unregistered;
            }
            _ = beats.tick() => {
                heartbeat["id"] = presence.sent(Instant::now()).into();
                // A peer that stopped reading wedges the write; a stop still
                // wins.
                tokio::select! {
                    sent = sdk_gaps::send_frame(&mut socket, &heartbeat) => {
                        if sent.is_err() {
                            return liveness.ended(heartbeat_period);
                        }
                    }
                    _ = stopped.changed() => {
                        go_away(&mut socket).await;
                        return Ended::Stopped;
                    }
                }
            }
            read = sdk_gaps::next_read(&mut socket) => match read {
                NodeRead::Frame(frame) if sdk_gaps::is_register_refusal(&frame) => {
                    // A token Relaycast no longer takes is minted again on
                    // the next connection, as one the upgrade refused is.
                    if sdk_gaps::refusal_code(&frame) == Some(NODE_TOKEN_INVALID) {
                        context.tokens.forget(target);
                    }
                    return Ended::Refused {
                        refusal: Refusal::of_reply(&frame),
                        at: Instant::now(),
                        socket: Some(socket),
                    };
                }
                NodeRead::Frame(frame) if sdk_gaps::is_register_reply(&frame) => {
                    liveness.live(Instant::now());
                    // The gateway took the socket: a recheck after a
                    // workspace pause succeeded.
                    context.backoff.record_write_success(&target.workspace);
                    let _ = context.signals.send(PushSignal::State {
                        agent: target.agent.clone(),
                        state: PushState::Live,
                    });
                    // Anything queued while the socket was down.
                    let _ = context.signals.send(PushSignal::Wake {
                        agent: target.agent.clone(),
                        frame: None,
                    });
                }
                NodeRead::Frame(frame) if frame["type"] == "deliver" => {
                    let _ = context.signals.send(PushSignal::Wake {
                        agent: target.agent.clone(),
                        frame: Some(frame),
                    });
                }
                NodeRead::Frame(frame) => {
                    if let Some(sent_at) = presence.confirm(
                        &frame, sdk_gaps::agent_id_of_node(&node.node_id),
                        Instant::now(), context.timing.heartbeat,
                    ) {
                        liveness.confirmed();
                        let _ = context.signals.send(PushSignal::Presence {
                            target: target.clone(), sent_at,
                        });
                    }
                }
                NodeRead::Closed(close) => {
                    if let Some(close) = close.as_ref().filter(|close| close.is_register_refusal()) {
                        return Ended::Refused {
                            refusal: Refusal::default().closed(close),
                            at: Instant::now(),
                            socket: None,
                        };
                    }
                    if shed(close.as_ref(), &liveness, heartbeat_period) {
                        let retry_after = close.as_ref().and_then(NodeClose::retry_after);
                        context.backoff.record_write_pause(&target.workspace, retry_after);
                    }
                    return liveness.ended(heartbeat_period);
                }
                NodeRead::Failed(_) => return liveness.ended(heartbeat_period),
            },
        }
    }
}

/// Only the latest outstanding heartbeat can establish presence. Request IDs
/// correlate replies on this connection; an old/replayed/error reply or a node
/// liveness acknowledgement without agent presence must never extend the lease.
#[derive(Default)]
struct PresenceAcks {
    sequence: u64,
    pending: Option<(String, Instant)>,
}

impl PresenceAcks {
    fn sent(&mut self, at: Instant) -> String {
        self.sequence += 1;
        let id = format!("presence-{}", self.sequence);
        self.pending = Some((id.clone(), at));
        id
    }

    fn confirm(
        &mut self,
        frame: &Value,
        agent_id: &str,
        now: Instant,
        max_age: Duration,
    ) -> Option<Instant> {
        let (id, _) = self.pending.as_ref()?;
        if frame["id"].as_str() != Some(id.as_str()) {
            return None;
        }
        let (_, sent_at) = self.pending.take()?;
        (frame["v"] == 1
            && frame["type"] == "reply"
            && frame["ok"] == true
            && frame["data"]["agent_presence"] == true
            && frame["data"]["agent_id"].as_str() == Some(agent_id)
            && now.saturating_duration_since(sent_at) < max_age)
            .then_some(sent_at)
    }
}

/// How long a stopping channel waits to send its close frame.
const CLOSE_GRACE: Duration = Duration::from_secs(1);

/// Sends a going-away close, giving up after [`CLOSE_GRACE`] so a peer that
/// stopped reading cannot hold up a stop.
/// Holds a socket whose `node.register` was refused, sending nothing, until
/// Relaycast closes it or `until`, when it closes it itself. Its close may
/// add a conflict or a `retry_after` the reply left out. `None`: stopped.
async fn hold_refused(
    socket: &mut Option<sdk_gaps::NodeSocket>,
    refusal: Refusal,
    until: Instant,
    stopped: &mut watch::Receiver<bool>,
) -> Option<Refusal> {
    let Some(mut held) = socket.take() else {
        return Some(refusal);
    };
    let deadline = tokio::time::sleep_until(until.into());
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            _ = stopped.changed() => {
                go_away(&mut held).await;
                return None;
            }
            _ = &mut deadline => {
                go_away(&mut held).await;
                return Some(refusal);
            }
            read = sdk_gaps::next_read(&mut held) => match read {
                NodeRead::Frame(_) => {}
                NodeRead::Closed(Some(close)) => return Some(refusal.closed(&close)),
                NodeRead::Closed(None) | NodeRead::Failed(_) => return Some(refusal),
            },
        }
    }
}

async fn go_away(socket: &mut sdk_gaps::NodeSocket) {
    let close = socket.close(Some(CloseFrame {
        code: CloseCode::Away,
        reason: "".into(),
    }));
    let _ = tokio::time::timeout(CLOSE_GRACE, close).await;
}

/// Keeps exactly one channel per target agent.
pub struct PushManager {
    context: PushContext,
    channels: BTreeMap<String, PushChannel>,
}

impl PushManager {
    pub fn new(context: PushContext) -> PushManager {
        PushManager {
            context,
            channels: BTreeMap::new(),
        }
    }

    /// Stops channels whose agent left or whose target changed, and starts
    /// one for every new target. A new label alone keeps the channel.
    pub async fn sync(&mut self, targets: Vec<PushTarget>) {
        let wanted: BTreeMap<String, PushTarget> = targets
            .into_iter()
            .map(|target| (target.agent.clone(), target))
            .collect();
        self.context
            .tokens
            .retain(&wanted.values().collect::<Vec<_>>());
        let stale: Vec<String> = self
            .channels
            .iter()
            .filter(|(agent, channel)| {
                !wanted
                    .get(*agent)
                    .is_some_and(|target| target.same_channel(channel.target()))
            })
            .map(|(agent, _)| agent.clone())
            .collect();
        for agent in stale {
            if let Some(channel) = self.channels.remove(&agent) {
                channel.stop().await;
            }
        }
        for (agent, target) in wanted {
            if !self.channels.contains_key(&agent) {
                let channel = PushChannel::spawn(target, self.context.clone());
                self.channels.insert(agent, channel);
            }
        }
    }

    pub async fn stop(&mut self) {
        for (_, channel) in std::mem::take(&mut self.channels) {
            channel.stop().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn presence_reply(id: &str) -> Value {
        serde_json::json!({"v": 1, "id": id, "type": "reply", "ok": true,
            "data": {"agent_presence": true, "agent_id": "agent-1"}})
    }

    #[test]
    fn presence_ack_credits_send_time_once_and_requires_the_latest_request() {
        let mut acks = PresenceAcks::default();
        let sent = Instant::now();
        let first = acks.sent(sent);
        let second = acks.sent(sent + Duration::from_secs(15));
        let now = sent + Duration::from_secs(16);
        let limit = Duration::from_secs(15);
        assert_eq!(
            acks.confirm(&presence_reply(&first), "agent-1", now, limit),
            None
        );
        assert_eq!(
            acks.confirm(&presence_reply(&second), "agent-1", now, limit),
            Some(sent + Duration::from_secs(15))
        );
        assert_eq!(
            acks.confirm(&presence_reply(&second), "agent-1", now, limit),
            None
        );
    }

    #[test]
    fn stale_or_unconfirmed_agent_presence_cannot_suppress_rest() {
        let limit = Duration::from_secs(15);
        for invalid in [
            "stale",
            "error",
            "wrong-agent",
            "node-only",
            "wrong-version",
        ] {
            let mut acks = PresenceAcks::default();
            let sent = Instant::now();
            let id = acks.sent(sent);
            let mut reply = presence_reply(&id);
            let mut now = sent + Duration::from_secs(1);
            match invalid {
                "stale" => now = sent + limit,
                "error" => reply["ok"] = false.into(),
                "wrong-agent" => reply["data"]["agent_id"] = "agent-2".into(),
                "node-only" => reply["data"] = serde_json::json!({"online": true}),
                "wrong-version" => reply["v"] = 2.into(),
                _ => unreachable!(),
            }
            assert_eq!(
                acks.confirm(&reply, "agent-1", now, limit),
                None,
                "{invalid}"
            );
            assert_eq!(
                acks.confirm(&presence_reply(&id), "agent-1", now, limit),
                None
            );
        }
    }

    #[test]
    fn busy_waits_spread_between_one_and_two_gate_delays() {
        let gate = Duration::from_secs(2);
        assert_eq!(busy_spread(gate, 1.0), gate);
        assert_eq!(busy_spread(gate, 0.5), gate * 2);
        assert_eq!(busy_spread(gate, 0.75), Duration::from_secs(3));
    }

    #[test]
    fn backoff_grows_to_thirty_seconds() {
        let delays: Vec<f64> = [1, 2, 5, 9].iter().map(|n| backoff(*n, 1.0)).collect();
        assert_eq!(delays, vec![2.0, 4.0, 30.0, 30.0]);
        assert_eq!(backoff(3, 0.5), 4.0);
    }

    #[test]
    fn reconnects_back_off_from_a_second_or_two_up_to_five_minutes() {
        let delays: Vec<f64> = (1..=10).map(|n| reconnect_backoff(n, 1.0)).collect();
        assert_eq!(
            delays,
            vec![2.0, 4.0, 8.0, 16.0, 32.0, 64.0, 128.0, 256.0, 256.0, 256.0]
        );
        assert_eq!(reconnect_backoff(1, 0.5), 1.0, "the first retry stays fast");
        assert_eq!(reconnect_backoff(u32::MAX, 0.5), 128.0);
        assert!(delays.windows(2).all(|pair| pair[0] <= pair[1]));
        assert!(delays.iter().all(|delay| *delay <= 300.0));
    }

    #[test]
    fn a_refused_register_waits_for_its_conflict_or_retry_after() {
        let conflict = Refusal {
            conflict: true,
            retry_after: None,
        };
        assert_eq!(conflict.units(2.0, 0.5), 30.0);
        assert_eq!(conflict.units(2.0, 1.0), 60.0);
        assert_eq!(conflict.units(256.0, 1.0), 256.0);
        let asked = Refusal {
            conflict: true,
            retry_after: Some(Duration::from_secs(45)),
        };
        assert_eq!(asked.units(2.0, 0.5), 45.0);
        let too_long = Refusal {
            retry_after: Some(Duration::from_secs(3600)),
            ..asked
        };
        assert_eq!(too_long.units(2.0, 1.0), 300.0);
        let rejected = Refusal::default();
        assert_eq!(rejected.units(4.0, 1.0), 4.0);
        // The 4009 close turns a plain refusal into a conflict and may add
        // the wait.
        let close = NodeClose {
            code: 4009,
            reason: r#"{"retry_after_ms":40000}"#.into(),
        };
        assert_eq!(
            rejected.closed(&close),
            Refusal {
                conflict: true,
                retry_after: Some(Duration::from_secs(40)),
            }
        );
        assert_eq!(asked.closed(&close), asked);
    }

    #[test]
    fn a_socket_is_stable_only_after_a_minute_live_or_two_confirmed_heartbeats() {
        let heartbeat = Duration::from_secs(NODE_HEARTBEAT_SECONDS);
        let opened = Instant::now();
        let mut liveness = Liveness::default();
        liveness.opened(opened);
        assert!(!liveness.stable(opened + Duration::from_secs(3600), heartbeat));
        assert!(liveness.just_opened(opened + Duration::from_secs(1), heartbeat));
        liveness.live(opened);
        for elapsed in [0, 1, 15, 30, 59] {
            assert!(
                !liveness.stable(opened + Duration::from_secs(elapsed), heartbeat),
                "{elapsed} s"
            );
        }
        assert!(liveness.stable(opened + Duration::from_secs(60), heartbeat));
        liveness.confirmed();
        assert!(!liveness.stable(opened + Duration::from_secs(20), heartbeat));
        liveness.confirmed();
        assert!(liveness.stable(opened + Duration::from_secs(20), heartbeat));
        assert!(!liveness.just_opened(opened + heartbeat, heartbeat));
    }

    #[test]
    fn jitter_stays_in_range() {
        for _ in 0..100 {
            let jitter = random_jitter();
            assert!((0.5..=1.0).contains(&jitter), "{jitter}");
        }
    }
}
