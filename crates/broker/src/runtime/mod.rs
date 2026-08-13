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
    node_control::{FleetControlCommand, FleetControlEvent, FleetDeliveryBook, FleetLoadSnapshot},
    protocol::{
        AgentRuntime, AgentSpec, BrokerEvent, DeliveryReadAckStatus,
        HeadlessProvider as ProtocolHeadlessProvider, MessageInjectionMode, NodeManifest,
        ProtocolEnvelope, RelayDelivery, ResolvedHarnessConfig, PROTOCOL_VERSION,
    },
    relaycast::{
        agent_identity_key, format_worker_preregistration_error, registration_authority_from_env,
        registration_retry_after_secs, retry_agent_registration, stable_node_identity_key,
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
};
use crate::worker::{WorkerEvent, WorkerHandle, WorkerRegistry};
use crate::{broker, listen_api, worker_request};

const DEFAULT_DELIVERY_RETRY_MS: u64 = 1_000;
const MAX_DELIVERY_RETRIES: u32 = 10;
const WAIT_DELIVERY_ACK_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const THREAD_HISTORY_LIMIT: usize = 1_000;
#[allow(dead_code)] // only http_api_local_delivery_timeout's default; see its own allow
const DEFAULT_HTTP_API_LOCAL_DELIVERY_TIMEOUT_MS: u64 = 3_000;
const DEFAULT_HTTP_API_RELAYCAST_SEND_TIMEOUT_MS: u64 = 20_000;
const DEFAULT_HTTP_API_OBSERVER_TOKEN_TIMEOUT_MS: u64 = 20_000;
const DEFAULT_HTTP_API_EVENT_EMIT_TIMEOUT_MS: u64 = 200;
static TRACING_GUARD: OnceLock<tracing_appender::non_blocking::WorkerGuard> = OnceLock::new();

fn derive_worker_work_unit_key(root: &str, name: &WorkerName) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(root.as_bytes());
    hasher.update([0]);
    hasher.update(name.as_str().as_bytes());
    format!("{:x}", hasher.finalize())
}

mod api;
mod app_server;
mod connection;
mod dead_letter;
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
pub(crate) use init::*;
pub(crate) use io::*;
pub(crate) use messages::*;
pub(crate) use paths::*;
pub(crate) use session::*;
pub(crate) use spawn_spec::*;
pub(crate) use system::*;
pub(crate) use util::*;
