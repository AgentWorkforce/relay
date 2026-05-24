use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, OnceLock},
    time::{Duration, Instant},
};

use crate::listen_api::{
    broadcast_if_relevant, listen_api_router, DeliveryRouteError, ListenApiConfig,
    ListenApiRequest, SetInboundDeliveryModeOk,
};
use crate::routing::display_target_for_dashboard;
use crate::util::ansi::floor_char_boundary;

use ::relaycast::WsEvent;
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
    protocol::{
        AgentRuntime, AgentSpec, BrokerEvent, HeadlessProvider as ProtocolHeadlessProvider,
        MessageInjectionMode, ProtocolEnvelope, RelayDelivery, PROTOCOL_VERSION,
    },
    relaycast::{
        agent_name_eq, format_worker_preregistration_error, is_self_name, map_ws_event,
        registration_retry_after_secs, resolve_dm_participants_cached, retry_agent_registration,
        AuthClient, DmParticipantsCache, MultiWorkspaceSession, RegRetryOutcome,
        RelaycastHttpClient, WorkspaceInboundMessage, WorkspaceMembershipSummary, WsControl,
    },
    replay_buffer::{ReplayBuffer, DEFAULT_REPLAY_CAPACITY},
    telemetry::{ActionSource, TelemetryClient, TelemetryEvent},
    types::{
        AgentResultMcpConfig, BrokerCommandEvent, InboundDeliveryDispatch, InboundDeliveryMode,
        InboundDeliveryState, InboundKind, PendingRelayMessage,
    },
};

use crate::cli::{DumpPtyCommand, DumpPtyFormat, HeadlessCommand, InitCommand};
use crate::worker::{WorkerEvent, WorkerHandle, WorkerRegistry};
use crate::{broker, listen_api, routing, worker_request};

const DEFAULT_DELIVERY_RETRY_MS: u64 = 1_000;
const MAX_DELIVERY_RETRIES: u32 = 10;
const DEFAULT_RELAYCAST_BASE_URL: &str = "https://api.relaycast.dev";
const THREAD_HISTORY_LIMIT: usize = 1_000;
const DEFAULT_HTTP_API_LOCAL_DELIVERY_TIMEOUT_MS: u64 = 3_000;
const DEFAULT_HTTP_API_RELAYCAST_SEND_TIMEOUT_MS: u64 = 20_000;
const DEFAULT_HTTP_API_EVENT_EMIT_TIMEOUT_MS: u64 = 200;
static TRACING_GUARD: OnceLock<tracing_appender::non_blocking::WorkerGuard> = OnceLock::new();

mod api;
mod connection;
mod delivery;
mod event_loop;
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
