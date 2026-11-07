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
//! while it was down. It reconnects with jittered backoff capped at 30 s
//! until stopped, with the node token it minted first (`tokens`): a new one
//! only once Relaycast refuses it.

mod tokens;

use crate::relay::backoff::{BackoffNotice, RelaycastBackoff, WorkspaceScope};
use crate::relay::machine::machine_name;
use crate::relay::sdk_gaps::{self, NODE_HEARTBEAT_SECONDS};
use crate::relay::workspace::Secret;
use relaycast::AgentClient;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
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
    /// Backoff unit: attempt `n` waits `min(30, 2^min(n, 5))` units, jittered.
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
        }
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
    Closed,
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
        let ended = connect_once(&target, &context, &mut stopped, &mut attempt).await;
        if matches!(ended, Ended::Stopped) || *stopped.borrow() {
            break;
        }
        // Whatever ended the socket, deliveries may be waiting.
        signal(PushSignal::Wake {
            agent: target.agent.clone(),
            frame: None,
        });
        attempt += 1;
        let delay = context
            .timing
            .backoff_unit
            .mul_f64(backoff(attempt, (context.timing.jitter)()));
        state(PushState::Waiting {
            retry_in_ms: delay.as_millis() as u64,
        });
        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
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
    attempt: &mut u32,
) -> Ended {
    let Ok(agent) = AgentClient::new(target.token.expose(), Some(target.base_url.clone())) else {
        return Ended::Closed;
    };
    let node = tokio::select! {
        node = context.tokens.get(target, context, &agent) => match node {
            Some(node) => node,
            None => return Ended::Closed,
        },
        _ = stopped.changed() => return Ended::Stopped,
    };
    let machine_id = target.machine_address.clone().unwrap_or_else(|| {
        machine_name(
            &context.machine_prefix,
            sdk_gaps::agent_id_of_node(&node.node_id),
        )
    });
    let mut socket = tokio::select! {
        socket = sdk_gaps::open_node_socket(&target.base_url, &node, &context.version, &machine_id) => match socket {
            Ok(socket) => socket,
            Err(error) => {
                if tokens::refused(&error) {
                    context.tokens.forget(target);
                }
                return Ended::Closed;
            }
        },
        _ = stopped.changed() => return Ended::Stopped,
    };
    let mut heartbeat = sdk_gaps::heartbeat_frame(&node, &context.version);
    let mut presence = PresenceAcks::default();
    let mut beats = tokio::time::interval(context.timing.heartbeat);
    beats.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = stopped.changed() => {
                go_away(&mut socket).await;
                return Ended::Stopped;
            }
            _ = beats.tick() => {
                heartbeat["id"] = presence.sent(Instant::now()).into();
                // A peer that stopped reading wedges the write; a stop still
                // wins.
                tokio::select! {
                    sent = sdk_gaps::send_frame(&mut socket, &heartbeat) => {
                        if sent.is_err() {
                            return Ended::Closed;
                        }
                    }
                    _ = stopped.changed() => {
                        go_away(&mut socket).await;
                        return Ended::Stopped;
                    }
                }
            }
            frame = sdk_gaps::next_frame(&mut socket) => match frame {
                Some(Ok(frame)) if sdk_gaps::is_register_reply(&frame) => {
                    *attempt = 0;
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
                Some(Ok(frame)) if frame["type"] == "deliver" => {
                    let _ = context.signals.send(PushSignal::Wake {
                        agent: target.agent.clone(),
                        frame: Some(frame),
                    });
                }
                Some(Ok(frame)) => {
                    if let Some(sent_at) = presence.confirm(
                        &frame, sdk_gaps::agent_id_of_node(&node.node_id),
                        Instant::now(), context.timing.heartbeat,
                    ) {
                        let _ = context.signals.send(PushSignal::Presence {
                            target: target.clone(), sent_at,
                        });
                    }
                }
                Some(Err(_)) | None => return Ended::Closed,
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
    fn jitter_stays_in_range() {
        for _ in 0..100 {
            let jitter = random_jitter();
            assert!((0.5..=1.0).contains(&jitter), "{jitter}");
        }
    }
}
