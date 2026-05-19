use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, OnceLock},
    time::{Duration, Instant},
};

use crate::helpers::{
    agent_name_eq, floor_char_boundary, is_self_name, normalize_cli_name, parse_cli_command,
    resolve_dm_participants_cached,
};
use crate::listen_api::{
    broadcast_if_relevant, listen_api_router, DeliveryRouteError, ListenApiConfig,
    ListenApiRequest, SetInboundDeliveryModeOk,
};
use crate::routing::display_target_for_dashboard;

use anyhow::{Context, Result};
use relaycast::WsEvent;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    sync::{broadcast, mpsc, Notify, RwLock},
    time::{timeout, MissedTickBehavior},
};
use uuid::Uuid;

use relay_broker::{
    auth::AuthClient,
    dedup::DedupCache,
    message_bridge::map_ws_event,
    multi_workspace::{MultiWorkspaceSession, WorkspaceInboundMessage, WorkspaceMembershipSummary},
    protocol::{
        AgentRuntime, AgentSpec, HeadlessProvider as ProtocolHeadlessProvider,
        MessageInjectionMode, ProtocolEnvelope, RelayDelivery, PROTOCOL_VERSION,
    },
    relaycast_ws::{
        format_worker_preregistration_error, registration_retry_after_secs,
        retry_agent_registration, RegRetryOutcome, RelaycastHttpClient, WsControl,
    },
    replay_buffer::{ReplayBuffer, DEFAULT_REPLAY_CAPACITY},
    snippets::ensure_relaycast_mcp_config,
    telemetry::{ActionSource, TelemetryClient, TelemetryEvent},
    types::{
        BrokerCommandEvent, InboundDeliveryDispatch, InboundDeliveryMode, InboundDeliveryState,
        InboundKind, PendingRelayMessage,
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

mod connection;
mod delivery;
mod headless;
mod init;
mod io;
mod messages;
mod paths;
mod session;
mod spawn_spec;
mod system;
#[cfg(test)]
mod tests;
mod util;

pub(crate) use connection::*;
pub(crate) use delivery::*;
pub(crate) use headless::*;
pub(crate) use init::*;
pub(crate) use io::*;
pub(crate) use messages::*;
pub(crate) use paths::*;
pub(crate) use session::*;
pub(crate) use spawn_spec::*;
pub(crate) use system::*;
pub(crate) use util::*;
