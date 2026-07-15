//! Broker-side supervision types.
//!
//! The restart-policy state machine lives in [`relay_pty::supervisor`],
//! generic over an opaque respawn payload. This module pins that payload to
//! [`SupervisedAgent`] — everything the broker needs to respawn a crashed
//! worker — and re-exports the policy/decision types under their familiar
//! `crate::supervisor` paths.

pub(crate) use relay_pty::supervisor::{RestartDecision, RestartPolicy};

use crate::protocol::AgentSpec;
use crate::types::AgentResultMcpConfig;

/// Respawn context registered with the supervisor at spawn time and handed
/// back via [`PendingRestart`] when a restart is due.
#[derive(Debug, Clone)]
pub(crate) struct SupervisedAgent {
    pub spec: AgentSpec,
    pub parent: Option<String>,
    pub initial_task: Option<String>,
    pub skip_relay_prompt: bool,
    pub agent_result: Option<AgentResultMcpConfig>,
}

/// Supervisor tracking every spawned worker's restart state.
pub(crate) type Supervisor = relay_pty::supervisor::Supervisor<SupervisedAgent>;

/// A worker whose cooldown elapsed and is ready to respawn.
pub(crate) type PendingRestart = relay_pty::supervisor::PendingRestart<SupervisedAgent>;
