use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, OnceLock},
    time::{Duration, Instant},
};

use crate::listen_api::{
    broadcast_if_relevant, listen_api_router, DeliveryRouteError, FleetSidecarFrameResponse,
    ListenApiConfig, ListenApiRequest, SetInboundDeliveryModeOk,
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
        AgentId, ChannelName, DeliveryId, EventId, MessageTarget, RequestId, ThreadId, WorkerName,
        WorkspaceAlias, WorkspaceId,
    },
    node_control::{
        FleetControlCommand, FleetControlEvent, FleetDeliveryBook, FleetLoadSnapshot,
        HandlerDispatchState,
    },
    protocol::{
        AgentRuntime, AgentSpec, BrokerEvent, DeliveryReadAckStatus,
        HeadlessProvider as ProtocolHeadlessProvider, MessageInjectionMode, NodeManifest,
        NodeSupervision, ProtocolEnvelope, RelayDelivery, ResolvedHarnessConfig, PROTOCOL_VERSION,
    },
    relaycast::{
        format_worker_preregistration_error, registration_retry_after_secs,
        retry_agent_registration, AuthClient, MultiWorkspaceSession, RegRetryOutcome,
        RelaycastHttpClient, WorkspaceInboundMessage, WorkspaceMembershipSummary, WsControl,
    },
    replay_buffer::{ReplayBuffer, DEFAULT_REPLAY_CAPACITY},
    supervisor::{RestartDecision, RestartPolicy},
    telemetry::{ActionSource, TelemetryClient, TelemetryEvent},
    types::{
        AgentResultMcpConfig, InboundDeliveryDispatch, InboundDeliveryMode, InboundDeliveryState,
        PendingRelayMessage,
    },
};

use crate::cli::{
    DumpPtyCommand, DumpPtyFormat, HeadlessAppServerCommand, HeadlessCommand, InitCommand,
};
use crate::worker::{WorkerEvent, WorkerHandle, WorkerRegistry};
use crate::{broker, listen_api, worker_request};

const DEFAULT_DELIVERY_RETRY_MS: u64 = 1_000;
const MAX_DELIVERY_RETRIES: u32 = 10;
const THREAD_HISTORY_LIMIT: usize = 1_000;
#[allow(dead_code)] // only http_api_local_delivery_timeout's default; see its own allow
const DEFAULT_HTTP_API_LOCAL_DELIVERY_TIMEOUT_MS: u64 = 3_000;
const DEFAULT_HTTP_API_RELAYCAST_SEND_TIMEOUT_MS: u64 = 20_000;
const DEFAULT_HTTP_API_EVENT_EMIT_TIMEOUT_MS: u64 = 200;
static TRACING_GUARD: OnceLock<tracing_appender::non_blocking::WorkerGuard> = OnceLock::new();

mod api;
mod app_server;
mod connection;
mod delivery;
mod event_loop;
mod fleet;
mod headless;
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

#[cfg(test)]
pub(crate) use api::{default_observer_token_scopes, resolve_workspace};
pub(crate) use app_server::*;
pub(crate) use connection::*;
pub(crate) use delivery::*;
pub(crate) use event_loop::*;
pub(crate) use headless::*;
pub(crate) use init::*;
pub(crate) use io::*;
pub(crate) use messages::*;
pub(crate) use paths::*;
pub(crate) use session::*;
pub(crate) use spawn_spec::*;
pub(crate) use system::*;
pub(crate) use util::*;
