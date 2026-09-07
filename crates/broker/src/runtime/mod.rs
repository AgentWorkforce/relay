use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, OnceLock},
    time::{Duration, Instant},
};

use crate::listen_api::{
    broadcast_if_relevant, listen_api_router, DeliveryRouteError, FlushPendingOk, ListenApiConfig,
    ListenApiRequest, SetInboundDeliveryModeOk,
};
use crate::util::ansi::floor_char_boundary;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    sync::{broadcast, mpsc, Notify, RwLock},
    time::{timeout, MissedTickBehavior},
};
use uuid::Uuid;

use crate::{
    dedup::DedupCache,
    fleet_wire::InventoryAgent,
    ids::{
        AgentId, ChannelName, DeliveryId, EventId, MessageTarget, MessageTargetKind, RequestId,
        ThreadId, WorkerName, WorkspaceAlias, WorkspaceId,
    },
    node_control::{FleetControlCommand, FleetControlEvent, FleetDeliveryBook, FleetLoadSnapshot},
    protocol::{
        AgentRuntime, AgentSpec, BrokerEvent, DeliveryReadAckStatus,
        HeadlessProvider as ProtocolHeadlessProvider, MessageInjectionMode, NodeManifest,
        ProtocolEnvelope, RelayDelivery, ResolvedHarnessConfig, PROTOCOL_VERSION,
    },
    relaycast::{
        agent_identity_key, format_worker_preregistration_error, identity_key_fingerprint,
        reclaim_legacy_identity, registration_retry_after_secs, stable_node_identity_key,
        AuthClient, MultiWorkspaceSession, RegRetryOutcome, RelaycastHttpClient,
        WorkspaceInboundMessage, WorkspaceMembershipSummary, WsControl,
    },
    replay_buffer::{ReplayBuffer, DEFAULT_REPLAY_CAPACITY},
    telemetry::{ActionSource, TelemetryClient, TelemetryEvent},
    terminal_control::{TerminalControlCommand, TerminalControlEvent, TerminalMode},
    types::{
        AgentResultMcpConfig, InboundDeliveryDispatch, InboundDeliveryMode, InboundDeliveryState,
        PendingRelayMessage, RelaycastDeliveryReceipt,
    },
};

use crate::cli::{
    DumpPtyCommand, DumpPtyFormat, HeadlessAppServerCommand, HeadlessCommand, InitCommand,
    ReclaimLegacyIdentityCommand,
};
use crate::worker::{WorkerEvent, WorkerHandle, WorkerRegistry};
use crate::{broker, listen_api, worker_request};

const DEFAULT_DELIVERY_RETRY_MS: u64 = 1_000;
/// Cap on *consecutive* broker-to-worker handoff failures. A successful write
/// resets the counter it reads, so this bounds "the worker keeps refusing the
/// frame" and nothing else. See [`MAX_DELIVERY_AGE`] for the case where every
/// write succeeds and the acknowledgement never comes.
const MAX_DELIVERY_RETRIES: u32 = 10;
const WAIT_DELIVERY_ACK_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// Wall-clock budget for one delivery: how long a message may sit
/// unacknowledged before the broker declares it terminally failed, even though
/// every handoff write kept succeeding.
///
/// `MAX_DELIVERY_RETRIES` cannot bound this case — it gates on
/// `failed_attempts`, which a successful write resets to zero — so a delivery
/// to a recipient that accepts the write and never acknowledges it retried
/// forever and never reported anything (relay#1686).
///
/// 30 minutes is chosen against the broker's own idea of a reasonable ack:
/// `WAIT_DELIVERY_ACK_TIMEOUT` is 5 minutes and the steer-mode verification
/// window is 5 seconds. A legitimate slow ACK is an agent mid-turn — the write
/// landed in its PTY queue and is consumed when the turn ends — so the budget
/// has to clear the longest plausible turn, not the ack timeout. 30 minutes is
/// 6x the wait-mode ack timeout and 360x the steer window: a recipient that has
/// swallowed a message for half an hour without a single acknowledgement is
/// indistinguishable from a deaf one, and dead-lettering is recoverable
/// (`node deadletters` can requeue) where retrying forever in silence is not.
///
/// Overridable per-deployment with `AGENT_RELAY_DELIVERY_MAX_AGE_MS`; see
/// [`delivery_max_age`].
const MAX_DELIVERY_AGE: Duration = Duration::from_secs(30 * 60);
/// Absolute ceiling on *cumulative* attempts, as a backstop for
/// [`MAX_DELIVERY_AGE`]: the deadline is wall-clock, so a frozen or
/// backwards-stepping system clock could otherwise keep a delivery permanently
/// young. Unlike `failed_attempts`, `attempts` is never reset by a successful
/// write, so this can always be reached.
///
/// Sized so it never fires first under a working clock: the fastest retry
/// cadence is the 5s steer verification window, and 1000 x 5s = ~83 minutes,
/// comfortably past the 30-minute deadline. In wait mode (5 minute cadence) it
/// is days away. If this is what trips, the clock is broken, not the recipient.
const MAX_DELIVERY_ATTEMPTS: u32 = 1_000;
const THREAD_HISTORY_LIMIT: usize = 1_000;
#[allow(dead_code)] // only http_api_local_delivery_timeout's default; see its own allow
const DEFAULT_HTTP_API_LOCAL_DELIVERY_TIMEOUT_MS: u64 = 3_000;
const DEFAULT_HTTP_API_RELAYCAST_SEND_TIMEOUT_MS: u64 = 20_000;
const DEFAULT_HTTP_API_OBSERVER_TOKEN_TIMEOUT_MS: u64 = 20_000;
const DEFAULT_HTTP_API_EVENT_EMIT_TIMEOUT_MS: u64 = 200;
static TRACING_GUARD: OnceLock<tracing_appender::non_blocking::WorkerGuard> = OnceLock::new();

mod api;
mod app_server;
mod connection;
mod dead_letter;
mod delivery;
mod event_loop;
mod fleet;
mod headless;
mod identity_recovery;
mod init;
mod io;
mod maintenance;
mod messages;
mod paths;
mod relaycast_events;
mod session;
mod spawn_spec;
mod system;
#[cfg(test)]
mod tests;
mod util;
mod worker_events;
use worker_events::{publish_pty_error, publish_pty_starting};

#[cfg(test)]
pub(crate) use api::{
    default_observer_token_scopes, mint_or_recover_observer_token, resolve_workspace,
    ObserverTokenMintError, ObserverTokenMintOutcome,
};
pub(crate) use app_server::*;
pub(crate) use connection::*;
pub(crate) use dead_letter::*;
pub(crate) use delivery::*;
pub(crate) use event_loop::*;
pub(crate) use headless::*;
pub(crate) use identity_recovery::*;
pub(crate) use init::*;
pub(crate) use io::*;
pub(crate) use messages::*;
pub(crate) use paths::*;
pub(crate) use session::*;
pub(crate) use spawn_spec::*;
pub(crate) use system::*;
pub(crate) use util::*;
